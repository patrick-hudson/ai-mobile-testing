import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdtempSync,
  openSync,
  promises as fs,
  readSync,
  rmSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256 } from './job-queue.mjs';
import { createProcessTerminationController, spawnProcessGroupOptions } from './subprocess-lifecycle.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROCESSOR = path.resolve(MODULE_DIRECTORY, '..', 'process-videos.ts');
const PROCESSOR_SOURCES = [
  DEFAULT_PROCESSOR,
  path.resolve(MODULE_DIRECTORY, 'video-retention.ts'),
  path.resolve(MODULE_DIRECTORY, 'video-manifest-history.ts'),
  path.resolve(MODULE_DIRECTORY, '..', '..', 'audit', 'evidence-policy.ts'),
];
const MAX_RESULTS_BYTES = 64 * 1_048_576;
const MAX_ATTACHMENT_COUNT = 20_000;
const MAX_ATTACHMENT_BYTES = 512 * 1_048_576;
const MAX_TOTAL_ATTACHMENT_BYTES = 8 * 1_073_741_824;
const MAX_MANIFEST_BYTES = 32 * 1_048_576;
const MAX_LOG_BYTES = 8 * 1_048_576;
const RETRYABLE_MEDIA_CODES = new Set(['EAGAIN', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'ETIMEDOUT']);

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) {
    fail('SINGLE_SITE_MEDIA_INVALID', 'generatedAt must be a canonical ISO timestamp.');
  }
  return value;
}

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) {
    fail('SINGLE_SITE_MEDIA_INVALID', `${label} is invalid.`);
  }
  return value;
}

function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function processorRevisionDigest() {
  const sources = [];
  for (const file of PROCESSOR_SOURCES) {
    const bytes = await fs.readFile(file);
    sources.push({ file: path.relative(path.resolve(MODULE_DIRECTORY, '..', '..'), file).split(path.sep).join('/'), digest: digestBytes(bytes) });
  }
  return sha256({ schemaVersion: 1, sources });
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeDurable(file, bytes, flags = 'wx') {
  const handle = await fs.open(file, flags, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(file, maximumBytes, code = 'SINGLE_SITE_MEDIA_INVALID') {
  const stat = await fs.lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') fail(code, `Required media-stage file is missing: ${file}`);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximumBytes) {
    fail(code, `Media-stage file is empty, unsafe, or oversized: ${file}`);
  }
  const bytes = await fs.readFile(file);
  try {
    return { document: JSON.parse(bytes.toString('utf8')), bytes };
  } catch {
    fail(code, `Media-stage file is invalid JSON: ${file}`);
  }
}

function attachmentRecords(document) {
  if (!isRecord(document) || !Array.isArray(document.suites)) {
    fail('SINGLE_SITE_MEDIA_RESULTS_INVALID', 'Playwright results must contain a suites array.');
  }
  const output = [];
  let nodes = 0;
  const visit = (suites, depth = 0) => {
    if (!Array.isArray(suites) || depth > 32) fail('SINGLE_SITE_MEDIA_RESULTS_INVALID', 'Playwright suite nesting is invalid.');
    for (const suite of suites) {
      if (!isRecord(suite) || ++nodes > 50_000) fail('SINGLE_SITE_MEDIA_RESULTS_INVALID', 'Playwright suites exceed their structural bound.');
      for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
        if (!isRecord(spec) || !Array.isArray(spec.tests)) fail('SINGLE_SITE_MEDIA_RESULTS_INVALID', 'Playwright specs are malformed.');
        for (const test of spec.tests) {
          if (!isRecord(test) || ++nodes > 50_000) fail('SINGLE_SITE_MEDIA_RESULTS_INVALID', 'Playwright tests exceed their structural bound.');
          for (const result of Array.isArray(test.results) ? test.results : []) {
            if (!isRecord(result)) fail('SINGLE_SITE_MEDIA_RESULTS_INVALID', 'Playwright attempt result is malformed.');
            for (const attachment of Array.isArray(result.attachments) ? result.attachments : []) {
              if (!isRecord(attachment)) fail('SINGLE_SITE_MEDIA_RESULTS_INVALID', 'Playwright attachment is malformed.');
              if (typeof attachment.path === 'string' && attachment.path) output.push(attachment);
              if (output.length > MAX_ATTACHMENT_COUNT) fail('SINGLE_SITE_MEDIA_LIMIT', 'Attachment count exceeds the media-stage bound.');
            }
          }
        }
      }
      visit(Array.isArray(suite.suites) ? suite.suites : [], depth + 1);
    }
  };
  visit(document.suites);
  return output;
}

async function verifiedSourceRoot(artifactRoot) {
  const absolute = path.resolve(artifactRoot);
  const [stat, real] = await Promise.all([fs.lstat(absolute), fs.realpath(absolute)]);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SINGLE_SITE_MEDIA_SOURCE_UNSAFE', 'Sealed artifact root must be a real directory.');
  return { absolute, real };
}

async function assertNoSymlinkSegments(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    fail('SINGLE_SITE_MEDIA_ATTACHMENT_ESCAPE', 'Attachment path is outside the sealed source root.');
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) fail('SINGLE_SITE_MEDIA_ATTACHMENT_UNSAFE', `Attachment path traverses a symlink: ${relative}`);
  }
}

async function prepareMediaRoot(outputDir) {
  const absolute = path.resolve(outputDir);
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const [stat, real] = await Promise.all([fs.lstat(absolute), fs.realpath(absolute)]);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SINGLE_SITE_MEDIA_OUTPUT_UNSAFE', 'Media output root must be a real directory.');
  const revisions = path.join(absolute, 'revisions');
  await fs.mkdir(revisions, { mode: 0o700 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  const [revisionStat, revisionReal] = await Promise.all([fs.lstat(revisions), fs.realpath(revisions)]);
  if (!revisionStat.isDirectory() || revisionStat.isSymbolicLink() || !contained(real, revisionReal)) {
    fail('SINGLE_SITE_MEDIA_OUTPUT_UNSAFE', 'Media revision root is unsafe or escapes its output root.');
  }
  return { absolute, real, revisions, revisionReal };
}

async function copyReferencedAttachments(document, sourceRoot, temporaryRoot) {
  const attachments = attachmentRecords(document);
  const copied = new Map();
  let totalBytes = 0;
  for (const attachment of attachments) {
    const source = path.resolve(path.isAbsolute(attachment.path)
      ? attachment.path
      : path.join(sourceRoot.absolute, attachment.path));
    if (!contained(sourceRoot.absolute, source)) {
      fail('SINGLE_SITE_MEDIA_ATTACHMENT_ESCAPE', `Attachment path escapes the sealed attempt: ${attachment.path}`);
    }
    await assertNoSymlinkSegments(sourceRoot.absolute, source);
    let metadata = copied.get(source);
    if (!metadata) {
      const relativePath = path.relative(sourceRoot.absolute, source);
      if (!relativePath || path.isAbsolute(relativePath) || relativePath.startsWith(`..${path.sep}`)) {
        fail('SINGLE_SITE_MEDIA_ATTACHMENT_ESCAPE', `Attachment path cannot be copied safely: ${attachment.path}`);
      }
      const [stat, real] = await Promise.all([fs.lstat(source), fs.realpath(source)]).catch((error) => {
        if (error?.code === 'ENOENT') fail('SINGLE_SITE_MEDIA_ATTACHMENT_MISSING', `Referenced attachment is missing: ${attachment.path}`);
        throw error;
      });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ATTACHMENT_BYTES
        || !contained(sourceRoot.real, real)) {
        fail('SINGLE_SITE_MEDIA_ATTACHMENT_UNSAFE', `Referenced attachment is unsafe or oversized: ${attachment.path}`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) fail('SINGLE_SITE_MEDIA_LIMIT', 'Referenced attachment bytes exceed the media-stage bound.');
      const destination = path.join(temporaryRoot, relativePath);
      if (!contained(temporaryRoot, destination)) fail('SINGLE_SITE_MEDIA_ATTACHMENT_ESCAPE', 'Copied attachment escaped the media-stage root.');
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const sourceHandle = await fs.open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let bytes;
      try {
        const opened = await sourceHandle.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== BigInt(stat.dev) || opened.ino !== BigInt(stat.ino)
          || opened.size !== BigInt(stat.size)) {
          fail('SINGLE_SITE_MEDIA_SOURCE_CHANGED', `Attachment changed while being opened: ${attachment.path}`);
        }
        bytes = await sourceHandle.readFile();
      } finally { await sourceHandle.close(); }
      if (bytes.length !== stat.size) fail('SINGLE_SITE_MEDIA_SOURCE_CHANGED', `Attachment changed while being sealed: ${attachment.path}`);
      await writeDurable(destination, bytes);
      metadata = { relativePath, bytes: bytes.length, digest: digestBytes(bytes) };
      copied.set(source, metadata);
    }
    attachment.path = metadata.relativePath;
  }
  return {
    referencedAttachmentCount: attachments.length,
    copiedAttachmentCount: copied.size,
    copiedAttachmentBytes: totalBytes,
    copied: [...copied.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  };
}

async function inventoryProcessedAttachments(document, temporaryRoot, revisionDirectory) {
  const attachments = attachmentRecords(document);
  const inventory = new Map();
  let totalBytes = 0;
  for (const attachment of attachments) {
    const candidate = path.resolve(temporaryRoot, attachment.path);
    if (!contained(temporaryRoot, candidate)) fail('SINGLE_SITE_MEDIA_ATTACHMENT_ESCAPE', 'Processor emitted an attachment outside its working copy.');
    const relativePath = path.relative(temporaryRoot, candidate);
    let entry = inventory.get(relativePath);
    if (!entry) {
      const [stat, real] = await Promise.all([fs.lstat(candidate), fs.realpath(candidate)]).catch((error) => {
        if (error?.code === 'ENOENT') fail('SINGLE_SITE_MEDIA_ATTACHMENT_MISSING', `Processed attachment is missing: ${attachment.path}`);
        throw error;
      });
      const realRoot = await fs.realpath(temporaryRoot);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ATTACHMENT_BYTES
        || !contained(realRoot, real)) {
        fail('SINGLE_SITE_MEDIA_ATTACHMENT_UNSAFE', `Processed attachment is unsafe or oversized: ${attachment.path}`);
      }
      totalBytes += stat.size;
      if (inventory.size + 1 > MAX_ATTACHMENT_COUNT || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        fail('SINGLE_SITE_MEDIA_LIMIT', 'Processed attachments exceed the media-stage count or byte bound.');
      }
      const bytes = await fs.readFile(candidate);
      entry = { relativePath, bytes: bytes.length, digest: digestBytes(bytes), disposition: 'retained' };
      inventory.set(relativePath, entry);
    }
    attachment.path = path.join(revisionDirectory, relativePath);
  }
  return { attachments: [...inventory.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)), bytes: totalBytes };
}

async function inventoryMediaFiles(root) {
  const output = [];
  let totalBytes = 0;
  const visit = async (directory, depth = 0) => {
    if (depth > 64) fail('SINGLE_SITE_MEDIA_LIMIT', 'Media working-copy directory depth exceeds its bound.');
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('SINGLE_SITE_MEDIA_ATTACHMENT_UNSAFE', `Media processor emitted a symlink: ${path.relative(root, candidate)}`);
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile()) fail('SINGLE_SITE_MEDIA_ATTACHMENT_UNSAFE', `Media processor emitted a non-regular file: ${path.relative(root, candidate)}`);
      const relativePath = path.relative(root, candidate);
      if (['results.json', 'video-manifest.json', 'media-stage.json'].includes(relativePath)) continue;
      const stat = await fs.lstat(candidate);
      if (stat.size < 1 || stat.size > MAX_ATTACHMENT_BYTES) fail('SINGLE_SITE_MEDIA_LIMIT', `Media file is empty or oversized: ${relativePath}`);
      totalBytes += stat.size;
      if (output.length + 1 > MAX_ATTACHMENT_COUNT || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        fail('SINGLE_SITE_MEDIA_LIMIT', 'Published media files exceed their count or byte bound.');
      }
      const handle = await fs.open(candidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      let bytes;
      try { bytes = await handle.readFile(); } finally { await handle.close(); }
      output.push({ relativePath, bytes: bytes.length, digest: digestBytes(bytes) });
    }
  };
  await visit(root);
  return { files: output, bytes: totalBytes };
}

function emit(logger, event, detail = {}) {
  logger?.emit?.(event, detail);
}

function createCommandCapture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'single-site-command-'));
  const streams = {};
  try {
    for (const name of ['stdout', 'stderr']) {
      streams[name] = {
        fd: openSync(path.join(root, name), fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, 0o600),
        position: 0,
      };
    }
  } catch (error) {
    for (const stream of Object.values(streams)) closeSync(stream.fd);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { root, streams };
}

function drainCommandCapture(capture, forward) {
  for (const name of ['stdout', 'stderr']) {
    const stream = capture.streams[name];
    const size = fstatSync(stream.fd).size;
    while (stream.position < size) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, size - stream.position));
      const bytes = readSync(stream.fd, buffer, 0, buffer.length, stream.position);
      if (bytes < 1) break;
      stream.position += bytes;
      forward(name, buffer.subarray(0, bytes));
    }
  }
}

function closeCommandCapture(capture) {
  for (const stream of Object.values(capture.streams)) closeSync(stream.fd);
  rmSync(capture.root, { recursive: true, force: true });
}

export async function runLoggedCommand({
  command,
  args,
  cwd,
  environment,
  logger,
  label,
  maximumLogBytes = MAX_LOG_BYTES,
  signal,
  deadlineAt,
  terminationGraceMs = 3_000,
  killSettleMs = 1_000,
}) {
  emit(logger, `${label}-command-started`, { command: [command, ...args], cwd });
  return await new Promise((resolveCommand) => {
    const capture = createCommandCapture();
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ['ignore', capture.streams.stdout.fd, capture.streams.stderr.fd],
      ...spawnProcessGroupOptions(),
    });
    let stdout = '';
    let stderr = '';
    let stdoutCarry = '';
    let stderrCarry = '';
    let capturedBytes = 0;
    let settled = false;
    let spawnError = null;
    let deadlineTimer = null;
    let termination;
    const forward = (stream, chunk) => {
      const text = chunk.toString('utf8');
      capturedBytes += Buffer.byteLength(text);
      if (capturedBytes <= maximumLogBytes) {
        if (stream === 'stdout') stdout += text;
        else stderr += text;
      }
      let carry = stream === 'stdout' ? stdoutCarry : stderrCarry;
      carry += text;
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) emit(logger, `${label}-${stream}`, { line: line.slice(0, 4_000) });
      if (stream === 'stdout') stdoutCarry = carry;
      else stderrCarry = carry;
    };
    const captureTimer = setInterval(() => drainCommandCapture(capture, forward), 50);
    captureTimer.unref?.();
    const finish = (exitCode, closeSignal, unresponsive = false) => {
      if (settled) return;
      settled = true;
      clearInterval(captureTimer);
      drainCommandCapture(capture, forward);
      closeCommandCapture(capture);
      signal?.removeEventListener('abort', abort);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      termination?.clear();
      if (stdoutCarry.trim()) emit(logger, `${label}-stdout`, { line: stdoutCarry.slice(0, 4_000) });
      if (stderrCarry.trim()) emit(logger, `${label}-stderr`, { line: stderrCarry.slice(0, 4_000) });
      const result = {
        exitCode,
        signal: closeSignal,
        stdout,
        stderr,
        truncated: capturedBytes > maximumLogBytes,
        spawnError,
        aborted: termination?.requested === true,
        forceKilled: termination?.forceKilled === true,
        terminationReason: termination?.reason ?? null,
        unresponsive,
      };
      emit(logger, `${label}-command-finished`, {
        ...result,
        stdout: undefined,
        stderr: undefined,
        capturedBytes: Math.min(capturedBytes, maximumLogBytes),
      });
      resolveCommand(result);
    };
    termination = createProcessTerminationController(child, {
      terminationGraceMs,
      killSettleMs,
      onTerminate: (detail) => emit(logger, `${label}-termination-requested`, detail),
      onForceKill: (detail) => emit(logger, `${label}-force-kill-requested`, detail),
      onUnresponsive: () => finish(null, 'SIGKILL', true),
    });
    const abort = () => termination.terminate(
      signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason ?? 'aborted'),
    );
    child.once('error', (error) => {
      spawnError = String(error?.message ?? error).slice(0, 1_000);
      emit(logger, `${label}-spawn-failed`, { code: error?.code ?? null, message: spawnError });
    });
    child.once('close', (exitCode, closeSignal) => {
      finish(exitCode, closeSignal);
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (deadlineAt !== undefined && deadlineAt !== null) {
      const deadline = deadlineAt instanceof Date ? deadlineAt.getTime() : Number(deadlineAt);
      if (!Number.isFinite(deadline)) {
        termination.terminate('invalid subprocess deadline');
      } else {
        const remaining = deadline - Date.now();
        if (remaining <= 0) termination.terminate('subprocess deadline exceeded');
        else {
          deadlineTimer = setTimeout(() => termination.terminate('subprocess deadline exceeded'), Math.min(remaining, 2_147_483_647));
          deadlineTimer.unref?.();
        }
      }
    }
  });
}

async function defaultRunProcessor({ artifactRoot, logger, environment = process.env, signal, deadlineAt }) {
  return await runLoggedCommand({
    command: process.execPath,
    args: ['--import', 'tsx', DEFAULT_PROCESSOR, '--run-dir', artifactRoot],
    cwd: path.resolve(MODULE_DIRECTORY, '..', '..'),
    environment: { ...environment, AUDIT_ARTIFACT_DIR: artifactRoot },
    logger,
    label: 'media-processor',
    signal,
    deadlineAt,
  });
}

function qualitySummary(manifest, processorResult) {
  const retention = isRecord(manifest.retention) ? manifest.retention : {};
  const integrityErrors = Array.isArray(retention.integrityErrors)
    ? retention.integrityErrors.filter((item) => typeof item === 'string').slice(0, 10_000)
    : ['video-manifest retention.integrityErrors is missing or malformed'];
  const failedCount = Number.isSafeInteger(manifest.failedCount) ? manifest.failedCount : 0;
  const unavailableCount = Number.isSafeInteger(manifest.unavailableCount) ? manifest.unavailableCount : 0;
  const processorFailed = processorResult.exitCode !== 0 || processorResult.signal !== null;
  const qualityState = processorFailed || failedCount > 0 || unavailableCount > 0 || integrityErrors.length > 0
    ? 'incomplete'
    : 'complete';
  return {
    qualityState,
    processor: { exitCode: processorResult.exitCode, signal: processorResult.signal },
    retainedFiles: Number.isSafeInteger(retention.retainedFiles) ? retention.retainedFiles : 0,
    prunedFiles: Number.isSafeInteger(retention.prunedFiles) ? retention.prunedFiles : 0,
    prunedBytes: Number.isSafeInteger(retention.prunedBytes) ? retention.prunedBytes : 0,
    qualityRejectedClips: Number.isSafeInteger(retention.qualityRejectedClips) ? retention.qualityRejectedClips : 0,
    usableInteractionVideoCount: Number.isSafeInteger(manifest.usableInteractionVideoCount) ? manifest.usableInteractionVideoCount : 0,
    diagnosticVideoCount: Number.isSafeInteger(manifest.diagnosticVideoCount) ? manifest.diagnosticVideoCount : 0,
    failedCount,
    unavailableCount,
    integrityErrors,
  };
}

function validateStageManifest(document, expected = {}) {
  if (!isRecord(document) || document.schemaVersion !== 1 || document.kind !== 'single-site-media-stage'
    || document.mode !== 'single-site' || !/^[a-f0-9]{64}$/.test(document.mediaStageDigest ?? '')) {
    fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Media-stage manifest is malformed.');
  }
  const { mediaStageDigest, ...body } = document;
  if (sha256(body) !== mediaStageDigest) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Media-stage manifest digest is invalid.');
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && document[key] !== value) fail('SINGLE_SITE_MEDIA_PUBLICATION_CONFLICT', `Media-stage ${key} does not match the sealed job.`);
  }
  return document;
}

async function validateRevision(revisionDirectory, expected) {
  const rootStat = await fs.lstat(revisionDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Media revision is not a real directory.');
  const realRevisionDirectory = await fs.realpath(revisionDirectory);
  const manifest = validateStageManifest((await readBoundedJson(path.join(revisionDirectory, 'media-stage.json'), MAX_MANIFEST_BYTES)).document, expected);
  const results = await readBoundedJson(path.join(revisionDirectory, 'results.json'), MAX_RESULTS_BYTES);
  if (digestBytes(results.bytes) !== manifest.processedResultsDigest || results.bytes.length !== manifest.processedResultsBytes) {
    fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Processed results do not match the immutable media-stage manifest.');
  }
  const video = await readBoundedJson(path.join(revisionDirectory, 'video-manifest.json'), MAX_MANIFEST_BYTES);
  if (digestBytes(video.bytes) !== manifest.videoManifestDigest) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Video manifest does not match the immutable media-stage manifest.');
  if (!Array.isArray(manifest.processedAttachments) || manifest.processedAttachments.length > MAX_ATTACHMENT_COUNT
    || manifest.processedAttachmentCount !== manifest.processedAttachments.length) {
    fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Processed attachment inventory exceeds its bound or count binding.');
  }
  let totalAttachmentBytes = 0;
  const uniqueAttachmentPaths = new Set();
  for (const copied of manifest.processedAttachments) {
    if (!isRecord(copied) || typeof copied.relativePath !== 'string' || !contained(revisionDirectory, path.join(revisionDirectory, copied.relativePath))) {
      fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Copied attachment inventory is malformed.');
    }
    if (uniqueAttachmentPaths.has(copied.relativePath)) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Processed attachment inventory contains duplicates.');
    uniqueAttachmentPaths.add(copied.relativePath);
    const candidate = path.join(revisionDirectory, copied.relativePath);
    let stat;
    try { stat = await fs.lstat(candidate); } catch (error) {
      throw error;
    }
    const realCandidate = await fs.realpath(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== copied.bytes || !contained(realRevisionDirectory, realCandidate)) {
      fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Copied attachment changed or escaped after publication.');
    }
    totalAttachmentBytes += stat.size;
    if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Processed attachment bytes exceed their bound.');
    const handle = await fs.open(candidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    if (digestBytes(bytes) !== copied.digest) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Copied attachment digest changed after publication.');
  }
  if (manifest.processedAttachmentBytes !== totalAttachmentBytes) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Processed attachment byte total does not match its manifest.');
  if (!Array.isArray(manifest.mediaFiles) || manifest.mediaFiles.length > MAX_ATTACHMENT_COUNT
    || manifest.mediaFileCount !== manifest.mediaFiles.length) {
    fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Published media-file inventory exceeds its bound or count binding.');
  }
  let totalMediaBytes = 0;
  const mediaPaths = new Set();
  for (const item of manifest.mediaFiles) {
    if (!isRecord(item) || typeof item.relativePath !== 'string' || mediaPaths.has(item.relativePath)) {
      fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Published media-file inventory is malformed or duplicated.');
    }
    mediaPaths.add(item.relativePath);
    const candidate = path.join(revisionDirectory, item.relativePath);
    if (!contained(revisionDirectory, candidate)) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Published media file escaped its revision.');
    const stat = await fs.lstat(candidate);
    const realCandidate = await fs.realpath(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes || !contained(realRevisionDirectory, realCandidate)) {
      fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Published media file changed or escaped after publication.');
    }
    totalMediaBytes += stat.size;
    if (totalMediaBytes > MAX_TOTAL_ATTACHMENT_BYTES) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Published media bytes exceed their bound.');
    const handle = await fs.open(candidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    if (digestBytes(bytes) !== item.digest) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Published media file digest changed after publication.');
  }
  if (manifest.mediaFileBytes !== totalMediaBytes) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Published media byte total does not match its manifest.');
  return { manifest, results: results.document, resultsBytes: results.bytes, artifactRoot: revisionDirectory, videoManifest: video.document };
}

async function publishPointer(mediaRoot, manifest) {
  const pointerFile = path.join(mediaRoot, 'current.json');
  const body = {
    schemaVersion: 1,
    kind: 'single-site-media-stage-pointer',
    revision: manifest.revision,
    mediaStageDigest: manifest.mediaStageDigest,
    sourceResultsDigest: manifest.sourceResultsDigest,
    processedResultsDigest: manifest.processedResultsDigest,
    qualityState: manifest.qualityState,
  };
  const pointer = { ...body, pointerDigest: sha256(body) };
  const temporary = path.join(mediaRoot, `.current.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  await writeDurable(temporary, `${canonicalJson(pointer)}\n`);
  await fs.rename(temporary, pointerFile);
  await fsyncDirectory(mediaRoot);
  return pointer;
}

export async function publishSingleSiteMediaStage({
  artifactRoot,
  sourceResults,
  sourceResultsBytes,
  sourceResultsDigest,
  outputDir,
  jobId,
  attemptId,
  finalizationDigest,
  generatedAt,
  logger,
  signal,
  deadlineAt,
  dependencies = {},
}) {
  safeIdentifier(jobId, 'jobId');
  safeIdentifier(attemptId, 'attemptId');
  canonicalTimestamp(generatedAt);
  if (!(sourceResultsBytes instanceof Uint8Array) || sourceResultsBytes.length < 2 || sourceResultsBytes.length > MAX_RESULTS_BYTES
    || digestBytes(sourceResultsBytes) !== sourceResultsDigest || !/^[a-f0-9]{64}$/.test(finalizationDigest ?? '')) {
    fail('SINGLE_SITE_MEDIA_SOURCE_INVALID', 'Media stage source results or finalization binding is invalid.');
  }
  if (canonicalJson(JSON.parse(Buffer.from(sourceResultsBytes).toString('utf8'))) !== canonicalJson(sourceResults)) {
    fail('SINGLE_SITE_MEDIA_SOURCE_INVALID', 'Parsed source results differ from their sealed bytes.');
  }
  const sourceRoot = await verifiedSourceRoot(artifactRoot);
  const processorDigest = await processorRevisionDigest();
  const revision = sha256({ schemaVersion: 1, sourceResultsDigest, processorDigest, finalizationDigest });
  const preparedMediaRoot = await prepareMediaRoot(outputDir);
  const mediaRoot = preparedMediaRoot.absolute;
  const revisionDirectory = path.join(preparedMediaRoot.revisions, revision);
  const expected = { jobId, attemptId, finalizationDigest, sourceResultsDigest, revision };
  try {
    const existing = await validateRevision(revisionDirectory, expected);
    const pointer = await publishPointer(mediaRoot, existing.manifest);
    emit(logger, 'media-stage-verified', { jobId, revision, mediaStageDigest: existing.manifest.mediaStageDigest, qualityState: existing.manifest.qualityState });
    return { ...existing, pointer, created: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporary = path.join(mediaRoot, `.revision.${revision}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    const workingResults = structuredClone(sourceResults);
    const copied = await copyReferencedAttachments(workingResults, sourceRoot, temporary);
    await writeDurable(path.join(temporary, 'results.json'), `${JSON.stringify(workingResults, null, 2)}\n`);
    let processorResult;
    try {
      processorResult = await (dependencies.runProcessor ?? defaultRunProcessor)({
        artifactRoot: temporary,
        logger,
        environment: dependencies.environment,
        signal,
        deadlineAt,
      });
    } catch (error) {
      emit(logger, 'media-processor-command-failed', { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 1_000) });
      processorResult = { exitCode: null, signal: null, stdout: '', stderr: String(error?.message ?? error), spawnError: true };
    }
    let video;
    try {
      video = await readBoundedJson(path.join(temporary, 'video-manifest.json'), MAX_MANIFEST_BYTES);
    } catch (error) {
      if (RETRYABLE_MEDIA_CODES.has(error?.code)) throw error;
      const fallback = {
        schemaVersion: 2,
        generatedAt,
        artifactRoot: '.',
        videoCount: 0,
        usableInteractionVideoCount: 0,
        diagnosticVideoCount: 0,
        processedCount: 0,
        failedCount: 1,
        unavailableCount: 1,
        retention: {
          retainedFiles: 0,
          prunedFiles: 0,
          prunedBytes: 0,
          qualityRejectedClips: 0,
          integrityErrors: [`Video processor did not publish a valid manifest: ${String(error.message).slice(0, 800)}`],
        },
        videos: [],
      };
      await fs.writeFile(path.join(temporary, 'video-manifest.json'), `${JSON.stringify(fallback, null, 2)}\n`);
      video = await readBoundedJson(path.join(temporary, 'video-manifest.json'), MAX_MANIFEST_BYTES);
    }
    video.document.generatedAt = generatedAt;
    video.document.artifactRoot = '.';
    await fs.writeFile(path.join(temporary, 'video-manifest.json'), `${JSON.stringify(video.document, null, 2)}\n`);
    const processed = await readBoundedJson(path.join(temporary, 'results.json'), MAX_RESULTS_BYTES);
    const processedDocument = processed.document;
    const processedInventory = await inventoryProcessedAttachments(processedDocument, temporary, revisionDirectory);
    await fs.writeFile(path.join(temporary, 'results.json'), `${JSON.stringify(processedDocument, null, 2)}\n`);
    const finalResults = await readBoundedJson(path.join(temporary, 'results.json'), MAX_RESULTS_BYTES);
    const finalVideo = await readBoundedJson(path.join(temporary, 'video-manifest.json'), MAX_MANIFEST_BYTES);
    const mediaInventory = await inventoryMediaFiles(temporary);
    const quality = qualitySummary(finalVideo.document, processorResult);
    const body = {
      schemaVersion: 1,
      kind: 'single-site-media-stage',
      mode: 'single-site',
      jobId,
      attemptId,
      finalizationDigest,
      generatedAt,
      revision,
      processorDigest,
      sourceResultsDigest,
      sourceResultsBytes: sourceResultsBytes.length,
      processedResultsDigest: digestBytes(finalResults.bytes),
      processedResultsBytes: finalResults.bytes.length,
      videoManifestDigest: digestBytes(finalVideo.bytes),
      referencedAttachmentCount: copied.referencedAttachmentCount,
      copiedAttachmentCount: copied.copiedAttachmentCount,
      copiedAttachmentBytes: copied.copiedAttachmentBytes,
      processedAttachmentCount: processedInventory.attachments.length,
      processedAttachmentBytes: processedInventory.bytes,
      processedAttachments: processedInventory.attachments,
      mediaFileCount: mediaInventory.files.length,
      mediaFileBytes: mediaInventory.bytes,
      mediaFiles: mediaInventory.files,
      ...quality,
    };
    const manifest = { ...body, mediaStageDigest: sha256(body) };
    await writeDurable(path.join(temporary, 'media-stage.json'), `${canonicalJson(manifest)}\n`);
    await fsyncDirectory(temporary);
    try {
      await fs.rename(temporary, revisionDirectory);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      const raced = await validateRevision(revisionDirectory, expected);
      if (raced.manifest.mediaStageDigest !== manifest.mediaStageDigest) fail('SINGLE_SITE_MEDIA_PUBLICATION_CONFLICT', 'Concurrent media revision differs.');
    }
    await fsyncDirectory(path.dirname(revisionDirectory));
    await dependencies.afterRevisionCommit?.({ revisionDirectory, manifest });
    const published = await validateRevision(revisionDirectory, expected);
    const pointer = await publishPointer(mediaRoot, published.manifest);
    emit(logger, 'media-stage-published', {
      jobId,
      revision,
      mediaStageDigest: published.manifest.mediaStageDigest,
      qualityState: published.manifest.qualityState,
      retainedFiles: published.manifest.retainedFiles,
      prunedFiles: published.manifest.prunedFiles,
      qualityRejectedClips: published.manifest.qualityRejectedClips,
    });
    return { ...published, pointer, created: true };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function publishUnavailableSingleSiteMediaStage({ outputDir, jobId, attemptId, finalizationDigest, generatedAt, reason, logger }) {
  safeIdentifier(jobId, 'jobId');
  safeIdentifier(attemptId, 'attemptId');
  canonicalTimestamp(generatedAt);
  const mediaRoot = (await prepareMediaRoot(outputDir)).absolute;
  const body = {
    schemaVersion: 1,
    kind: 'single-site-media-stage',
    mode: 'single-site',
    jobId,
    attemptId,
    finalizationDigest,
    generatedAt,
    revision: sha256({ finalizationDigest, jobId, attemptId, unavailable: true }),
    processorDigest: null,
    sourceResultsDigest: null,
    sourceResultsBytes: 0,
    processedResultsDigest: null,
    processedResultsBytes: 0,
    videoManifestDigest: null,
    referencedAttachmentCount: 0,
    copiedAttachmentCount: 0,
    copiedAttachmentBytes: 0,
    processedAttachmentCount: 0,
    processedAttachmentBytes: 0,
    processedAttachments: [],
    mediaFileCount: 0,
    mediaFileBytes: 0,
    mediaFiles: [],
    qualityState: 'incomplete',
    processor: { exitCode: null, signal: null },
    retainedFiles: 0,
    prunedFiles: 0,
    prunedBytes: 0,
    qualityRejectedClips: 0,
    usableInteractionVideoCount: 0,
    diagnosticVideoCount: 0,
    failedCount: 0,
    unavailableCount: 1,
    integrityErrors: [String(reason).slice(0, 1_000)],
  };
  const manifest = { ...body, mediaStageDigest: sha256(body) };
  const publication = await (async () => {
    const file = path.join(mediaRoot, `unavailable-${manifest.revision}.json`);
    try {
      await writeDurable(file, `${canonicalJson(manifest)}\n`);
      await fsyncDirectory(mediaRoot);
      return { created: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = validateStageManifest((await readBoundedJson(file, MAX_MANIFEST_BYTES)).document, {
        jobId, attemptId, finalizationDigest,
      });
      if (existing.mediaStageDigest !== manifest.mediaStageDigest) fail('SINGLE_SITE_MEDIA_PUBLICATION_CONFLICT', 'Unavailable media-stage publication differs.');
      return { created: false };
    }
  })();
  const pointer = await publishPointer(mediaRoot, manifest);
  emit(logger, publication.created ? 'media-stage-incomplete' : 'media-stage-incomplete-verified', {
    jobId, mediaStageDigest: manifest.mediaStageDigest, reason: body.integrityErrors[0],
  });
  return { manifest, results: null, resultsBytes: null, artifactRoot: null, videoManifest: null, pointer, created: publication.created };
}

export async function readSingleSiteMediaStagePublication({
  outputDir,
  jobId,
  attemptId,
  finalizationDigest,
  mediaStageDigest,
}) {
  safeIdentifier(jobId, 'jobId');
  safeIdentifier(attemptId, 'attemptId');
  if (!/^[a-f0-9]{64}$/.test(finalizationDigest ?? '') || !/^[a-f0-9]{64}$/.test(mediaStageDigest ?? '')) {
    fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Media-stage durable binding is invalid.');
  }
  const root = path.resolve(outputDir);
  const [rootStat, realRoot] = await Promise.all([fs.lstat(root), fs.realpath(root)]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Media-stage output root is unsafe.');
  }
  const pointerRead = await readBoundedJson(path.join(root, 'current.json'), MAX_MANIFEST_BYTES, 'SINGLE_SITE_MEDIA_PUBLICATION_INVALID');
  const pointer = pointerRead.document;
  if (!isRecord(pointer) || pointer.schemaVersion !== 1 || pointer.kind !== 'single-site-media-stage-pointer'
    || !/^[a-f0-9]{64}$/.test(pointer.revision ?? '')
    || pointer.mediaStageDigest !== mediaStageDigest
    || !['complete', 'incomplete'].includes(pointer.qualityState)) {
    fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Media-stage pointer is malformed or names a different publication.');
  }
  const { pointerDigest, ...pointerBody } = pointer;
  if (!/^[a-f0-9]{64}$/.test(pointerDigest ?? '') || sha256(pointerBody) !== pointerDigest) {
    fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Media-stage pointer digest is invalid.');
  }
  const expected = { jobId, attemptId, finalizationDigest, revision: pointer.revision };
  let published;
  if (pointer.sourceResultsDigest === null && pointer.processedResultsDigest === null) {
    const file = path.join(root, `unavailable-${pointer.revision}.json`);
    const realFile = await fs.realpath(file).catch((error) => {
      if (error?.code === 'ENOENT') fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Unavailable media-stage publication is missing.');
      throw error;
    });
    if (!contained(realRoot, realFile)) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Unavailable media-stage publication escaped its root.');
    const manifest = validateStageManifest((await readBoundedJson(file, MAX_MANIFEST_BYTES, 'SINGLE_SITE_MEDIA_PUBLICATION_INVALID')).document, expected);
    published = { manifest, results: null, resultsBytes: null, artifactRoot: null, videoManifest: null };
  } else {
    const revisionDirectory = path.join(root, 'revisions', pointer.revision);
    if (!contained(root, revisionDirectory)) fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Media-stage revision escaped its root.');
    published = await validateRevision(revisionDirectory, expected);
  }
  if (published.manifest.mediaStageDigest !== mediaStageDigest
    || published.manifest.qualityState !== pointer.qualityState
    || published.manifest.sourceResultsDigest !== pointer.sourceResultsDigest
    || published.manifest.processedResultsDigest !== pointer.processedResultsDigest) {
    fail('SINGLE_SITE_MEDIA_PUBLICATION_INVALID', 'Media-stage pointer disagrees with its immutable publication.');
  }
  return Object.freeze({ ...published, pointer: Object.freeze(pointer) });
}

export { validateStageManifest };
