import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from './job-queue.mjs';

export const PLAYWRIGHT_RESULTS_COMPACTION_LIMITS = Object.freeze({
  // The legacy inline report is depth-scanned before this single bounded read.
  // This is the hard input allocation ceiling; larger reports fail closed.
  maxSourceBytes: 256 * 1_048_576,
  maxCompactBytes: 64 * 1_048_576,
  maxDecodedAttachmentBytes: 32 * 1_048_576,
  maxStructuredSidecarBytes: 32 * 1_048_576,
  maxStructuredSidecarTotalBytes: 512 * 1_048_576,
  maxInlineAttachmentBytes: 64 * 1_024,
  maxTests: 10_000,
  maxAttachments: 50_000,
  maxNodes: 500_000,
  maxJsonDepth: 64,
});

const STRUCTURED_DIRECTORY = 'structured-evidence';
const MANIFEST_NAME = 'structured-evidence-manifest.json';
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class PlaywrightResultsCompactionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlaywrightResultsCompactionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PlaywrightResultsCompactionError(code, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedLimits(overrides) {
  const limits = { ...PLAYWRIGHT_RESULTS_COMPACTION_LIMITS, ...(isRecord(overrides) ? overrides : {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) fail('RESULTS_COMPACTION_LIMIT_INVALID', `${name} must be a positive safe integer.`);
  }
  if (limits.maxCompactBytes > limits.maxSourceBytes) {
    fail('RESULTS_COMPACTION_LIMIT_INVALID', 'Compact results bound cannot exceed the source bound.');
  }
  return limits;
}

async function scanJsonDepth(file, limits) {
  let depth = 0;
  let maximum = 0;
  let inString = false;
  let escaped = false;
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > limits.maxSourceBytes) fail('RESULTS_SOURCE_OVERSIZED', 'Playwright results exceed the bounded compaction input limit.');
    for (const byte of chunk) {
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inString = false;
        continue;
      }
      if (byte === 0x22) inString = true;
      else if (byte === 0x7b || byte === 0x5b) {
        depth += 1;
        maximum = Math.max(maximum, depth);
        if (maximum > limits.maxJsonDepth) fail('RESULTS_JSON_DEPTH_EXCEEDED', 'Playwright results exceed the JSON nesting bound.');
      } else if (byte === 0x7d || byte === 0x5d) {
        depth -= 1;
        if (depth < 0) fail('RESULTS_JSON_MALFORMED', 'Playwright results contain unbalanced JSON delimiters.');
      }
    }
  }
  if (inString || escaped || depth !== 0) fail('RESULTS_JSON_MALFORMED', 'Playwright results contain unterminated JSON structure.');
  return bytes;
}

function auditSummary(record) {
  if (!isRecord(record) || record.schemaVersion !== 1 || typeof record.auditId !== 'string') {
    fail('RESULTS_AUDIT_ATTACHMENT_INVALID', 'audit-result attachment is not a schemaVersion 1 audit record.');
  }
  const allowed = [
    'schemaVersion', 'caseId', 'auditId', 'mode', 'deploymentRole', 'evidenceAuthority',
    'environment', 'coveredEnvironments', 'baseURL', 'project', 'findings', 'steps',
  ];
  const summary = Object.fromEntries(allowed.flatMap((key) => Object.hasOwn(record, key) ? [[key, record[key]]] : []));
  if (!Array.isArray(summary.findings) || !Array.isArray(summary.steps)) {
    fail('RESULTS_AUDIT_ATTACHMENT_INVALID', 'audit-result attachment lacks bounded Findings or steps.');
  }
  return summary;
}

function decodedInlineAttachment(attachment, limits) {
  if (typeof attachment.body !== 'string' || attachment.body.length === 0 || !BASE64.test(attachment.body)) {
    fail('RESULTS_ATTACHMENT_BODY_INVALID', 'Inline attachment body is not canonical base64.');
  }
  const bytes = Buffer.from(attachment.body, 'base64');
  if (bytes.length === 0 || bytes.length > limits.maxDecodedAttachmentBytes
    || bytes.toString('base64') !== attachment.body) {
    fail('RESULTS_ATTACHMENT_BODY_INVALID', 'Inline attachment body is empty, non-canonical, or exceeds its decoded bound.');
  }
  return bytes;
}

function strictRelativePath(relativePath, code = 'RESULTS_ATTACHMENT_PATH_ESCAPE') {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)
    || relativePath.includes('\\') || relativePath.includes('\0')) {
    fail(code, 'Structured attachment path must be a non-empty relative POSIX path.');
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || path.posix.normalize(relativePath) !== relativePath) {
    fail(code, 'Structured attachment path contains a forbidden or non-canonical segment.');
  }
  return segments;
}

function structuredPath(relativePath) {
  try {
    const segments = strictRelativePath(relativePath);
    return segments.length > 1 && segments[0] === STRUCTURED_DIRECTORY;
  } catch (error) {
    if (error instanceof PlaywrightResultsCompactionError) return false;
    throw error;
  }
}

function claimsStructuredPath(value) {
  return typeof value === 'string' && value.split(/[\\/]/).includes(STRUCTURED_DIRECTORY);
}

async function boundedStructuredFile(artifactRoot, relativePath, limits) {
  const segments = strictRelativePath(relativePath);
  if (segments.length < 2 || segments[0] !== STRUCTURED_DIRECTORY) {
    fail('RESULTS_ATTACHMENT_PATH_ESCAPE', 'Structured attachment path escaped its contained evidence directory.');
  }
  const structuredDirectory = path.join(artifactRoot, STRUCTURED_DIRECTORY);
  const absolute = path.resolve(structuredDirectory, ...segments.slice(1));
  if (!contained(structuredDirectory, absolute)) {
    fail('RESULTS_ATTACHMENT_PATH_ESCAPE', 'Structured attachment path escaped its contained evidence directory.');
  }
  const stat = await fs.lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') fail('RESULTS_ATTACHMENT_MISSING', `Structured attachment is missing: ${relativePath}`);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limits.maxStructuredSidecarBytes) {
    fail('RESULTS_ATTACHMENT_UNSAFE', `Structured attachment is unsafe or exceeds its bound: ${relativePath}`);
  }
  const [rootStat, realRoot, realStructuredDirectory, realFile] = await Promise.all([
    fs.lstat(structuredDirectory),
    fs.realpath(artifactRoot),
    fs.realpath(structuredDirectory),
    fs.realpath(absolute),
  ]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || realStructuredDirectory !== path.join(realRoot, STRUCTURED_DIRECTORY)
    || !contained(realStructuredDirectory, realFile)) {
    fail('RESULTS_ATTACHMENT_PATH_ESCAPE', 'Structured attachment resolves outside its real evidence directory.');
  }
  const bytes = await fs.readFile(absolute);
  return { absolute, bytes };
}

async function boundedReporterAttachment(artifactRoot, attachmentPath, limits) {
  if (typeof attachmentPath !== 'string' || attachmentPath.length === 0 || attachmentPath.includes('\0')) {
    fail('RESULTS_ATTACHMENT_PATH_ESCAPE', 'Reporter attachment path is empty or invalid.');
  }
  let absolute;
  if (path.isAbsolute(attachmentPath)) {
    absolute = path.resolve(attachmentPath);
  } else {
    const portable = attachmentPath.split(path.sep).join('/');
    const segments = strictRelativePath(portable);
    absolute = path.resolve(artifactRoot, ...segments);
  }
  if (!contained(artifactRoot, absolute)) {
    fail('RESULTS_ATTACHMENT_PATH_ESCAPE', 'Reporter attachment path escaped the artifact root.');
  }
  const stat = await fs.lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') fail('RESULTS_ATTACHMENT_MISSING', `Reporter attachment is missing: ${attachmentPath}`);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limits.maxStructuredSidecarBytes) {
    fail('RESULTS_ATTACHMENT_UNSAFE', `Reporter attachment is unsafe or exceeds its bound: ${attachmentPath}`);
  }
  const [realRoot, realFile] = await Promise.all([fs.realpath(artifactRoot), fs.realpath(absolute)]);
  if (!contained(realRoot, realFile)) fail('RESULTS_ATTACHMENT_PATH_ESCAPE', 'Reporter attachment resolves outside the artifact root.');
  return { absolute, bytes: await fs.readFile(absolute) };
}

function isStructuredMetadataAttachment(attachment) {
  return attachment.contentType === 'application/json' || attachment.contentType.endsWith('+json');
}

async function atomicWrite(file, bytes) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
}

async function writeGeneratedSidecar(file, bytes) {
  const existing = await fs.lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing === null) return atomicWrite(file, bytes);
  if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.length
    || digestBytes(await fs.readFile(file)) !== digestBytes(bytes)) {
    fail('RESULTS_ATTACHMENT_COLLISION', 'Generated structured evidence path already contains different or unsafe bytes.');
  }
}

/**
 * Rewrites only attachment storage, never test outcomes. Large inline bodies
 * become contained files; audit-result gets a small decision summary while
 * its original bytes remain attached under the original name and type.
 */
export async function compactPlaywrightResults({ artifactRoot: inputRoot, resultsPath: inputPath, limits: overrides = {} }) {
  const limits = normalizedLimits(overrides);
  const artifactRoot = path.resolve(inputRoot);
  const resultsPath = path.resolve(inputPath);
  if (!contained(artifactRoot, resultsPath)) fail('RESULTS_PATH_ESCAPE', 'Playwright results escaped the artifact root.');
  const stat = await fs.lstat(resultsPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2) fail('RESULTS_FILE_UNSAFE', 'Playwright results are empty or unsafe.');
  await scanJsonDepth(resultsPath, limits);
  const sourceBytes = await fs.readFile(resultsPath);
  let document;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes));
  } catch {
    fail('RESULTS_JSON_MALFORMED', 'Playwright results are malformed JSON or invalid UTF-8.');
  }
  if (!isRecord(document) || !Array.isArray(document.suites) || !Array.isArray(document.errors)) {
    fail('RESULTS_STRUCTURE_INVALID', 'Playwright results lack suites and errors arrays.');
  }

  const structuredDirectory = path.join(artifactRoot, STRUCTURED_DIRECTORY);
  await fs.mkdir(structuredDirectory, { recursive: true, mode: 0o700 });
  const [artifactRealPath, structuredStat, structuredRealPath] = await Promise.all([
    fs.realpath(artifactRoot),
    fs.lstat(structuredDirectory),
    fs.realpath(structuredDirectory),
  ]);
  if (!structuredStat.isDirectory() || structuredStat.isSymbolicLink()
    || structuredRealPath !== path.join(artifactRealPath, STRUCTURED_DIRECTORY)) {
    fail('RESULTS_ATTACHMENT_PATH_ESCAPE', 'Structured evidence directory is not a real contained directory.');
  }
  const manifestItems = new Map();
  let attachmentCount = 0;
  let testCount = 0;
  let nodeCount = 0;
  let sidecarBytes = 0;
  let generatedSidecars = 0;
  const suites = document.suites.map((suite) => ({ suite, depth: 1 }));
  while (suites.length) {
    const { suite, depth } = suites.pop();
    nodeCount += 1;
    if (nodeCount > limits.maxNodes || depth > 32 || !isRecord(suite)) fail('RESULTS_STRUCTURE_BOMB', 'Playwright suite structure exceeds its bound.');
    if (!Array.isArray(suite.suites ?? []) || !Array.isArray(suite.specs ?? [])) fail('RESULTS_STRUCTURE_INVALID', 'Playwright suite arrays are malformed.');
    for (const child of suite.suites ?? []) suites.push({ suite: child, depth: depth + 1 });
    for (const spec of suite.specs ?? []) {
      nodeCount += 1;
      if (nodeCount > limits.maxNodes || !isRecord(spec) || !Array.isArray(spec.tests)) fail('RESULTS_STRUCTURE_BOMB', 'Playwright spec structure exceeds its bound.');
      for (const test of spec.tests) {
        testCount += 1;
        nodeCount += 1;
        if (testCount > limits.maxTests || nodeCount > limits.maxNodes || !isRecord(test) || !Array.isArray(test.results)) {
          fail('RESULTS_STRUCTURE_BOMB', 'Playwright test structure exceeds its bound.');
        }
        if (test.results.length > 20) fail('RESULTS_STRUCTURE_BOMB', 'Playwright retry attempts exceed their bound.');
        for (const result of test.results) {
          if (!isRecord(result) || !Array.isArray(result.attachments ?? [])) fail('RESULTS_STRUCTURE_INVALID', 'Playwright result attachments are malformed.');
          const additions = [];
          const hasInlineSummary = result.attachments.some((attachment) => (
            isRecord(attachment) && attachment.name === 'audit-result-summary' && typeof attachment.body === 'string'
          ));
          for (const attachment of result.attachments) {
            attachmentCount += 1;
            nodeCount += 1;
            if (attachmentCount > limits.maxAttachments || nodeCount > limits.maxNodes || !isRecord(attachment)
              || typeof attachment.name !== 'string' || typeof attachment.contentType !== 'string') {
              fail('RESULTS_STRUCTURE_BOMB', 'Playwright attachments exceed their count or shape bound.');
            }
            if (typeof attachment.body === 'string' && typeof attachment.path === 'string') {
              fail('RESULTS_STRUCTURE_INVALID', 'Playwright attachment cannot contain both inline bytes and a file path.');
            }
            if (typeof attachment.body === 'string') {
              const bytes = decodedInlineAttachment(attachment, limits);
              if (attachment.name === 'audit-result-summary') {
                let parsed;
                try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('RESULTS_AUDIT_ATTACHMENT_INVALID', 'audit-result-summary attachment is malformed JSON.'); }
                const normalizedSummary = Buffer.from(JSON.stringify(auditSummary(parsed)));
                if (normalizedSummary.length > limits.maxInlineAttachmentBytes) {
                  fail('RESULTS_AUDIT_SUMMARY_OVERSIZED', 'Compact audit-result summary exceeds its inline bound.');
                }
                attachment.body = normalizedSummary.toString('base64');
                continue;
              }
              const mustExternalize = attachment.name === 'audit-result' || bytes.length > limits.maxInlineAttachmentBytes;
              if (!mustExternalize) continue;
              const digest = digestBytes(bytes);
              const relativePath = `${STRUCTURED_DIRECTORY}/inline-${String(generatedSidecars).padStart(6, '0')}-${digest.slice(0, 16)}.bin`;
              const absolute = path.join(artifactRoot, ...relativePath.split('/'));
              await writeGeneratedSidecar(absolute, bytes);
              generatedSidecars += 1;
              delete attachment.body;
              attachment.path = relativePath;
              if (attachment.name === 'audit-result' && !hasInlineSummary) {
                let parsed;
                try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('RESULTS_AUDIT_ATTACHMENT_INVALID', 'audit-result attachment is malformed JSON.'); }
                const summary = Buffer.from(JSON.stringify(auditSummary(parsed)));
                if (summary.length > limits.maxInlineAttachmentBytes) fail('RESULTS_AUDIT_SUMMARY_OVERSIZED', 'Compact audit-result summary exceeds its inline bound.');
                additions.push({ name: 'audit-result-summary', contentType: 'application/json', body: summary.toString('base64') });
              }
            }
            if (typeof attachment.path === 'string') {
              if (path.isAbsolute(attachment.path) && claimsStructuredPath(attachment.path)) {
                fail('RESULTS_ATTACHMENT_PATH_ESCAPE', 'Structured attachment paths must be relative to the artifact root.');
              }
              let relativePath = path.isAbsolute(attachment.path)
                ? path.relative(artifactRoot, path.resolve(attachment.path)).split(path.sep).join('/')
                : attachment.path.split(path.sep).join('/');
              if (!structuredPath(relativePath)) {
                if (claimsStructuredPath(attachment.path)) {
                  fail('RESULTS_ATTACHMENT_PATH_ESCAPE', 'Structured attachment path is not canonical or escaped its dedicated directory.');
                }
                if (!isStructuredMetadataAttachment(attachment)) continue;
                const source = await boundedReporterAttachment(artifactRoot, attachment.path, limits);
                const digest = digestBytes(source.bytes);
                relativePath = `${STRUCTURED_DIRECTORY}/reporter-${String(generatedSidecars).padStart(6, '0')}-${digest.slice(0, 16)}.bin`;
                await writeGeneratedSidecar(path.join(artifactRoot, ...relativePath.split('/')), source.bytes);
                generatedSidecars += 1;
                attachment.path = relativePath;
                if (attachment.name === 'audit-result' && !hasInlineSummary) {
                  let parsed;
                  try { parsed = JSON.parse(source.bytes.toString('utf8')); } catch { fail('RESULTS_AUDIT_ATTACHMENT_INVALID', 'audit-result attachment is malformed JSON.'); }
                  const summary = Buffer.from(JSON.stringify(auditSummary(parsed)));
                  if (summary.length > limits.maxInlineAttachmentBytes) fail('RESULTS_AUDIT_SUMMARY_OVERSIZED', 'Compact audit-result summary exceeds its inline bound.');
                  additions.push({ name: 'audit-result-summary', contentType: 'application/json', body: summary.toString('base64') });
                }
              }
              const item = await boundedStructuredFile(artifactRoot, relativePath, limits);
              const digest = digestBytes(item.bytes);
              const key = `${relativePath}\0${digest}`;
              if (!manifestItems.has(key)) {
                sidecarBytes += item.bytes.length;
                if (sidecarBytes > limits.maxStructuredSidecarTotalBytes) fail('RESULTS_ATTACHMENT_TOTAL_OVERSIZED', 'Structured sidecars exceed their aggregate bound.');
                manifestItems.set(key, {
                  relativePath,
                  bytes: item.bytes.length,
                  digest,
                  name: attachment.name,
                  contentType: attachment.contentType,
                });
              }
              attachment.path = relativePath;
            }
          }
          result.attachments.push(...additions);
          attachmentCount += additions.length;
          if (attachmentCount > limits.maxAttachments) fail('RESULTS_STRUCTURE_BOMB', 'Generated audit summaries exceed the attachment count bound.');
        }
      }
    }
  }

  const compactBytes = Buffer.from(`${JSON.stringify(document)}\n`);
  if (compactBytes.length > limits.maxCompactBytes) fail('RESULTS_COMPACT_OVERSIZED', 'Compacted Playwright results still exceed the downstream parser bound.');
  const sourceDigest = digestBytes(sourceBytes);
  const compactDigest = digestBytes(compactBytes);
  const body = {
    schemaVersion: 1,
    kind: 'playwright-structured-evidence-manifest',
    sourceResultsBytes: sourceBytes.length,
    sourceResultsDigest: sourceDigest,
    compactResultsBytes: compactBytes.length,
    compactResultsDigest: compactDigest,
    testCount,
    attachmentCount,
    generatedSidecars,
    structuredSidecarBytes: sidecarBytes,
    items: [...manifestItems.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  };
  const manifest = { ...body, manifestDigest: sha256(body) };
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`);
  await atomicWrite(resultsPath, compactBytes);
  await atomicWrite(path.join(artifactRoot, MANIFEST_NAME), manifestBytes);
  return {
    document,
    resultsBytes: compactBytes,
    resultsDigest: compactDigest,
    sourceResultsBytes: sourceBytes.length,
    sourceResultsDigest: sourceDigest,
    compacted: sourceBytes.length !== compactBytes.length || generatedSidecars > 0,
    manifest,
    manifestBytes,
    manifestRelativePath: MANIFEST_NAME,
  };
}

export function verifyStructuredEvidenceManifest(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'playwright-structured-evidence-manifest'
    || !Array.isArray(value.items) || typeof value.manifestDigest !== 'string') return false;
  const { manifestDigest, ...body } = value;
  return sha256(body) === manifestDigest;
}

export async function verifyStructuredEvidencePublication({ artifactRoot: inputRoot, resultsBytes, binding, limits: overrides = {} }) {
  const limits = normalizedLimits(overrides);
  const artifactRoot = path.resolve(inputRoot);
  if (!isRecord(binding) || binding.relativePath !== MANIFEST_NAME
    || !Number.isSafeInteger(binding.bytes) || binding.bytes < 2
    || typeof binding.digest !== 'string' || typeof binding.manifestDigest !== 'string'
    || !Number.isSafeInteger(binding.itemCount) || !Number.isSafeInteger(binding.totalBytes)) {
    fail('RESULTS_MANIFEST_BINDING_INVALID', 'Structured evidence binding is malformed.');
  }
  const manifestFile = path.join(artifactRoot, MANIFEST_NAME);
  const stat = await fs.lstat(manifestFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== binding.bytes) {
    fail('RESULTS_MANIFEST_UNSAFE', 'Structured evidence manifest is missing, unsafe, or changed size.');
  }
  const manifestBytes = await fs.readFile(manifestFile);
  if (sha256(manifestBytes) !== binding.digest) fail('RESULTS_MANIFEST_DIGEST_CHANGED', 'Structured evidence manifest bytes changed.');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { fail('RESULTS_MANIFEST_INVALID', 'Structured evidence manifest is malformed JSON.'); }
  if (!verifyStructuredEvidenceManifest(manifest) || manifest.manifestDigest !== binding.manifestDigest
    || manifest.items.length !== binding.itemCount
    || manifest.structuredSidecarBytes !== binding.totalBytes) {
    fail('RESULTS_MANIFEST_INVALID', 'Structured evidence manifest disagrees with its worker binding.');
  }
  const compactBytes = Buffer.from(resultsBytes);
  if (compactBytes.length !== manifest.compactResultsBytes || digestBytes(compactBytes) !== manifest.compactResultsDigest) {
    fail('RESULTS_MANIFEST_RESULTS_MISMATCH', 'Structured evidence manifest does not bind the compact Playwright results.');
  }
  let totalBytes = 0;
  const paths = new Set();
  for (const item of manifest.items) {
    if (!isRecord(item) || typeof item.relativePath !== 'string' || paths.has(item.relativePath)
      || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || typeof item.digest !== 'string'
      || typeof item.name !== 'string' || typeof item.contentType !== 'string') {
      fail('RESULTS_MANIFEST_ITEM_INVALID', 'Structured evidence manifest contains a malformed or duplicate item.');
    }
    paths.add(item.relativePath);
    const file = await boundedStructuredFile(artifactRoot, item.relativePath, limits);
    if (file.bytes.length !== item.bytes || digestBytes(file.bytes) !== item.digest) {
      fail('RESULTS_MANIFEST_ITEM_CHANGED', `Structured evidence sidecar changed: ${item.relativePath}`);
    }
    totalBytes += file.bytes.length;
    if (totalBytes > limits.maxStructuredSidecarTotalBytes) fail('RESULTS_ATTACHMENT_TOTAL_OVERSIZED', 'Structured evidence manifest exceeds its aggregate byte bound.');
  }
  if (totalBytes !== manifest.structuredSidecarBytes) fail('RESULTS_MANIFEST_TOTAL_MISMATCH', 'Structured evidence sidecar byte total disagrees with its manifest.');
  return { manifest, manifestBytes };
}
