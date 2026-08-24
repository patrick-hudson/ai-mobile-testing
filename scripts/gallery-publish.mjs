#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  GALLERY_FLAG_HISTORY_MAX_BYTES,
  GALLERY_QUERY_CHUNK_MAX_BYTES,
  applyGalleryFlagTransition,
  assertGalleryArchiveDescriptor,
  emptyGalleryFlagHistory,
  galleryFlagSnapshot,
  queryGalleryArchiveRows,
  stableGalleryKey,
} from '../shared/gallery-contract.mjs';

const scriptPath = fileURLToPath(import.meta.url);

function contained(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}${path.sep}`);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function digest(file) {
  const bytes = await fs.readFile(file);
  return {
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function validateRequest(request) {
  if (!request || request.schemaVersion !== 1) {
    throw new Error('Invalid gallery publication request.');
  }
  if (request.operation === 'flag-transition') return validateFlagRequest(request);
  if (!request.descriptor || request.descriptor.schemaVersion !== 1) {
    throw new Error('Invalid gallery publication request.');
  }
  const galleryRoot = path.resolve(request.galleryRoot);
  if (!contained(galleryRoot, request.stagingDir) || !contained(galleryRoot, request.finalDir)) {
    throw new Error('Gallery publication paths must remain inside the run gallery root.');
  }
  if (path.basename(path.resolve(request.finalDir)) !== request.descriptor.exportRevision) {
    throw new Error('Gallery final revision path does not match the descriptor.');
  }
  const runRoot = path.dirname(path.dirname(galleryRoot));
  const flagHistoryPath = path.resolve(request.flagHistoryPath ?? path.join(runRoot, 'visual-flags.json'));
  if (!contained(runRoot, flagHistoryPath) || flagHistoryPath !== path.join(runRoot, 'visual-flags.json')) {
    throw new Error('Gallery flag history path must remain inside the run directory.');
  }
  const surfacePagePath = path.resolve(request.surfacePagePath ?? '');
  if (
    !contained(galleryRoot, surfacePagePath)
    || path.dirname(surfacePagePath) !== galleryRoot
    || !path.basename(surfacePagePath).startsWith('.surface-')
    || path.extname(surfacePagePath) !== '.html'
  ) throw new Error('Gallery archive surface staging path is invalid.');
  return { ...request, galleryRoot, flagHistoryPath, surfacePagePath };
}

function validateFlagRequest(request) {
  const runRoot = path.resolve(request.runRoot);
  const galleryRoot = path.resolve(request.galleryRoot);
  const sidecarPath = path.resolve(request.sidecarPath);
  const responsePath = path.resolve(request.responsePath);
  if (!contained(runRoot, galleryRoot) || !contained(runRoot, sidecarPath) || !contained(galleryRoot, responsePath)) {
    throw new Error('Reviewer flag publication paths must remain inside the run directory.');
  }
  if (sidecarPath !== path.join(runRoot, 'visual-flags.json')) {
    throw new Error('Reviewer flag history must use the contained run sidecar.');
  }
  if (!request.transition || typeof request.transition !== 'object') {
    throw new Error('Reviewer flag transition request is invalid.');
  }
  return { ...request, runRoot, galleryRoot, sidecarPath, responsePath };
}

async function validateStaging(request) {
  const integrity = await readJson(path.join(request.stagingDir, 'integrity.json'));
  if (integrity.schemaVersion !== 1 || integrity.exportRevision !== request.descriptor.exportRevision || !Array.isArray(integrity.files)) {
    throw new Error('Gallery staging integrity document is invalid.');
  }
  if (integrity.files.length !== request.descriptor.integrity.documentCount) {
    throw new Error('Gallery staging integrity document count does not match the descriptor.');
  }
  const revisionHref = `gallery/revisions/${request.descriptor.exportRevision}/`;
  const integrityPaths = new Set(integrity.files.map((record) => record?.path));
  const requiredHref = (href, kind) => {
    if (typeof href !== 'string' || !href.startsWith(revisionHref)) {
      throw new Error(`Gallery ${kind} href does not belong to its immutable revision.`);
    }
    const relative = href.slice(revisionHref.length);
    if (!integrityPaths.has(relative)) throw new Error(`Gallery descriptor references missing ${kind} ${relative}.`);
  };
  for (const chunk of request.descriptor.query.chunks ?? []) requiredHref(chunk?.href, 'query chunk');
  for (const chunk of request.descriptor.raw.chunks ?? []) requiredHref(chunk?.href, 'raw chunk');
  requiredHref(request.descriptor.flags?.href, 'flag snapshot');
  if (request.descriptor.integrity?.href !== `${revisionHref}integrity.json`) {
    throw new Error('Gallery descriptor integrity href does not belong to its immutable revision.');
  }
  if (
    request.descriptor.itemDetails?.hrefPrefix !== `${revisionHref}items/`
    || request.descriptor.itemDetails?.hrefSuffix !== '.html'
  ) {
    throw new Error('Gallery item detail template does not belong to its immutable revision.');
  }
  if (!integrityPaths.has('descriptor.json')) throw new Error('Gallery staging omits its immutable descriptor.');
  const itemDocuments = [...integrityPaths].filter((value) => typeof value === 'string' && value.startsWith('items/') && value.endsWith('.html'));
  if (itemDocuments.length !== request.descriptor.itemDetails?.count) {
    throw new Error('Gallery staging item detail count does not match the descriptor.');
  }
  if ((request.descriptor.query.chunks ?? []).reduce((total, chunk) => total + chunk.rows, 0) !== request.descriptor.query.rows) {
    throw new Error('Gallery staging query row count does not match the descriptor.');
  }
  if ((request.descriptor.raw.chunks ?? []).reduce((total, chunk) => total + chunk.rows, 0) !== request.descriptor.raw.rows) {
    throw new Error('Gallery staging raw row count does not match the descriptor.');
  }
  for (const record of integrity.files) {
    if (!record || typeof record.path !== 'string' || path.isAbsolute(record.path)) {
      throw new Error('Gallery staging integrity path is invalid.');
    }
    const file = path.resolve(request.stagingDir, record.path);
    if (!contained(request.stagingDir, file)) throw new Error('Gallery staging integrity path escaped the revision.');
    let actual;
    try {
      actual = await digest(file);
    } catch (error) {
      throw new Error(`Gallery staging is missing ${record.path}; publication aborted.`, { cause: error });
    }
    if (actual.sizeBytes !== record.sizeBytes || actual.sha256 !== record.sha256) {
      throw new Error(`Gallery staging integrity mismatch for ${record.path}; publication aborted.`);
    }
  }
  const stagedDescriptor = await readJson(path.join(request.stagingDir, 'descriptor.json'));
  if (JSON.stringify(stagedDescriptor) !== JSON.stringify(request.descriptor)) {
    throw new Error('Gallery staged descriptor does not match the requested head.');
  }
}

async function installRevision(request) {
  try {
    await fs.access(request.finalDir, constants.F_OK);
    const installed = await readJson(path.join(request.finalDir, 'descriptor.json'));
    if (JSON.stringify(installed) !== JSON.stringify(request.descriptor)) {
      throw new Error(`Immutable gallery revision ${request.descriptor.exportRevision} already exists with different content.`);
    }
    await fs.rm(request.stagingDir, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.rename(request.stagingDir, request.finalDir);
  }
}

function archiveWrapper(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `<!doctype html><meta charset="utf-8"><body data-gallery-payload="${encoded}"><script>(()=>{const token=decodeURIComponent(location.hash.slice(1));if(!token)return;const e=document.body.dataset.galleryPayload;const b=Uint8Array.from(atob(e),c=>c.charCodeAt(0));const payload=JSON.parse(new TextDecoder().decode(b));parent.postMessage({channel:"quitting7oh-gallery-archive-v1",token,meta:payload.archiveDocument,payload},'*')})()</script></body>`;
}

function archiveDocument(kind, contentRevision, exportRevision, flagRevision) {
  return {
    schemaVersion: 1,
    kind,
    contentRevision,
    exportRevision,
    ...(flagRevision ? { flagRevision } : {}),
  };
}

function archivePayload(source) {
  const encoded = source.match(/data-gallery-payload="([A-Za-z0-9+/=]+)"/)?.[1];
  if (!encoded) throw new Error('Gallery archive wrapper is malformed.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function itemFlagStates(flags) {
  const states = new Map();
  const priority = { open: 0, resolved: 1, dismissed: 2, unflagged: 3 };
  for (const flag of flags) {
    const current = states.get(flag.itemId) ?? 'unflagged';
    if (priority[flag.state] < priority[current]) states.set(flag.itemId, flag.state);
  }
  return states;
}

function partitionRows(rows, maxRows, maxBytes, contentRevision, exportRevision) {
  const chunks = [];
  let pending = [];
  const sourceFor = (values, ordinal) => archiveWrapper({
    schemaVersion: 1,
    contentRevision,
    ordinal,
    rows: values,
    archiveDocument: archiveDocument('query', contentRevision, exportRevision),
  });
  const flush = () => {
    if (pending.length === 0) return;
    const source = sourceFor(pending, chunks.length + 1);
    if (Buffer.byteLength(source) > maxBytes) throw new Error('Reviewer flag projection query chunk exceeds its byte cap.');
    chunks.push({ source, rows: pending.length });
    pending = [];
  };
  for (const row of rows) {
    const candidate = [...pending, row];
    const source = sourceFor(candidate, chunks.length + 1);
    if (candidate.length > maxRows || Buffer.byteLength(source) > maxBytes) {
      if (pending.length === 0) throw new Error('Reviewer flag projection contains an oversized query row.');
      flush();
      pending = [row];
    } else pending = candidate;
  }
  flush();
  return chunks;
}

async function filesBelow(root, current = root) {
  const output = [];
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(root, file));
    else if (entry.isFile()) output.push(path.relative(root, file).split(path.sep).join('/'));
  }
  return output;
}

function inlineArchiveJson(value) {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

async function updateArchiveSurfaceDescriptor(galleryRoot, descriptor) {
  const page = path.join(path.dirname(galleryRoot), 'gallery.html');
  let source;
  try {
    source = await fs.readFile(page, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const marker = /(<script id="gallery-archive-head" type="application\/json">)[\s\S]*?(<\/script>)/;
  if (!marker.test(source)) throw new Error('The archive gallery page does not contain its pinned descriptor marker.');
  const updated = source.replace(marker, `$1${inlineArchiveJson(descriptor)}$2`);
  const temporary = `${page}.${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(temporary, updated, { encoding: 'utf8', mode: 0o644 });
  await fs.rename(temporary, page);
}

async function refreshSealedFlagProjection(request, snapshot) {
  const headPath = path.join(request.galleryRoot, 'current.json');
  const currentValue = await readOptionalJson(headPath);
  if (!currentValue) return null;
  const current = assertGalleryArchiveDescriptor(currentValue);
  if (current.flagRevision === snapshot.flagRevision) return current;
  const sourceDir = path.join(request.galleryRoot, 'revisions', current.exportRevision);
  if (!contained(request.galleryRoot, sourceDir)) throw new Error('Current gallery revision escaped its run directory.');
  const rows = [];
  for (const chunk of current.query.chunks) {
    const relative = chunk.href.slice(`gallery/revisions/${current.exportRevision}/`.length);
    const source = await fs.readFile(path.join(sourceDir, relative), 'utf8');
    const payload = archivePayload(source);
    if (payload.contentRevision !== current.contentRevision || !Array.isArray(payload.rows)) {
      throw new Error('Current gallery query projection is inconsistent.');
    }
    rows.push(...payload.rows);
  }
  const states = itemFlagStates(snapshot.flags);
  const orderedRows = queryGalleryArchiveRows(rows.map((row) => ({
    ...row,
    flagState: states.get(row.id) ?? 'unflagged',
  })), { sort: 'attention' });
  const exportedAt = snapshot.events.at(-1)?.timestamp ?? new Date().toISOString();
  const orderRevision = `order_${stableGalleryKey({
    contentRevision: current.contentRevision,
    flagRevision: snapshot.flagRevision,
    schemaVersion: 1,
  })}`;
  const exportRevision = `export_${stableGalleryKey({
    contentRevision: current.contentRevision,
    flagRevision: snapshot.flagRevision,
    orderRevision,
    exportedAt,
  })}`;
  const revisionHref = `gallery/revisions/${exportRevision}`;
  const stagingDir = await fs.mkdtemp(path.join(request.galleryRoot, `.staging-${exportRevision}-`));
  const finalDir = path.join(request.galleryRoot, 'revisions', exportRevision);
  try {
    await fs.cp(sourceDir, stagingDir, { recursive: true, force: false });
    await fs.rm(path.join(stagingDir, 'query'), { recursive: true, force: true });
    await fs.mkdir(path.join(stagingDir, 'query'), { recursive: true });
    await Promise.all([
      fs.rm(path.join(stagingDir, 'flags.html'), { force: true }),
      fs.rm(path.join(stagingDir, 'descriptor.json'), { force: true }),
      fs.rm(path.join(stagingDir, 'integrity.json'), { force: true }),
    ]);
    const chunks = partitionRows(
      orderedRows,
      current.query.maxRowsPerChunk,
      Math.min(current.query.maxBytesPerChunk, GALLERY_QUERY_CHUNK_MAX_BYTES),
      current.contentRevision,
      exportRevision,
    );
    const queryReferences = [];
    for (const [index, chunk] of chunks.entries()) {
      const filename = `chunk-${String(index + 1).padStart(4, '0')}.html`;
      await fs.writeFile(path.join(stagingDir, 'query', filename), chunk.source, 'utf8');
      queryReferences.push({
        href: `${revisionHref}/query/${filename}`,
        rows: chunk.rows,
        bytes: Buffer.byteLength(chunk.source),
      });
    }
    await fs.writeFile(path.join(stagingDir, 'flags.html'), archiveWrapper({
      ...snapshot,
      mutable: false,
      archiveDocument: archiveDocument('flags', current.contentRevision, exportRevision, snapshot.flagRevision),
    }), 'utf8');
    for (const directory of ['items', 'raw']) {
      const kind = directory === 'items' ? 'detail' : 'raw';
      const root = path.join(stagingDir, directory);
      for (const relative of await filesBelow(root)) {
        if (!relative.endsWith('.html')) continue;
        const file = path.join(root, relative);
        const payload = archivePayload(await fs.readFile(file, 'utf8'));
        await fs.writeFile(file, archiveWrapper({
          ...payload,
          archiveDocument: archiveDocument(kind, current.contentRevision, exportRevision),
        }), 'utf8');
      }
    }
    const rewriteHref = (href) => href.replace(
      `gallery/revisions/${current.exportRevision}/`,
      `${revisionHref}/`,
    );
    const descriptor = {
      ...current,
      flagRevision: snapshot.flagRevision,
      orderRevision,
      exportRevision,
      exportedAt,
      facets: {
        ...current.facets,
        flagStates: [...new Set(orderedRows.map(({ flagState }) => flagState))].sort(),
      },
      query: { ...current.query, rows: orderedRows.length, chunks: queryReferences },
      itemDetails: { ...current.itemDetails, hrefPrefix: `${revisionHref}/items/` },
      raw: {
        ...current.raw,
        chunks: current.raw.chunks.map((chunk) => ({ ...chunk, href: rewriteHref(chunk.href) })),
      },
      flags: { href: `${revisionHref}/flags.html`, throughEvent: snapshot.throughEvent },
      integrity: { href: `${revisionHref}/integrity.json`, documentCount: 0 },
    };
    const filesBeforeDescriptor = await filesBelow(stagingDir);
    descriptor.integrity.documentCount = filesBeforeDescriptor.length + 1;
    assertGalleryArchiveDescriptor(descriptor);
    await fs.writeFile(path.join(stagingDir, 'descriptor.json'), `${JSON.stringify(descriptor)}\n`, 'utf8');
    const integrityFiles = [];
    for (const relative of (await filesBelow(stagingDir)).sort()) {
      integrityFiles.push({ path: relative, ...await digest(path.join(stagingDir, relative)) });
    }
    await fs.writeFile(path.join(stagingDir, 'integrity.json'), `${JSON.stringify({
      schemaVersion: 1,
      exportRevision,
      files: integrityFiles,
    })}\n`, 'utf8');
    await validateStaging({
      galleryRoot: request.galleryRoot,
      stagingDir,
      finalDir,
      descriptor,
    });
    await installRevision({ stagingDir, finalDir, descriptor });
    const temporaryHead = path.join(request.galleryRoot, `.current-${process.pid}-${Date.now()}.json`);
    await fs.writeFile(temporaryHead, `${JSON.stringify(descriptor)}\n`, { encoding: 'utf8', mode: 0o644 });
    await fs.rename(temporaryHead, headPath);
    await updateArchiveSurfaceDescriptor(request.galleryRoot, descriptor);
    return descriptor;
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function readFlagHistory(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > GALLERY_FLAG_HISTORY_MAX_BYTES) {
      const error = new Error('Reviewer flag history exceeds its bounded storage quota.');
      error.code = 'GALLERY_FLAG_HISTORY_TOO_LARGE';
      error.statusCode = 413;
      throw error;
    }
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyGalleryFlagHistory();
    throw error;
  }
}

async function writeFlagResponse(request, value) {
  const temporary = `${request.responsePath}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, request.responsePath);
}

async function assertRealPublicationPaths(request) {
  const runRoot = request.runRoot ?? path.dirname(path.dirname(request.galleryRoot));
  const [runStat, galleryStat] = await Promise.all([
    fs.lstat(runRoot),
    fs.lstat(request.galleryRoot),
  ]);
  if (!runStat.isDirectory() || runStat.isSymbolicLink() || !galleryStat.isDirectory() || galleryStat.isSymbolicLink()) {
    throw new Error('Gallery publication requires real contained directories.');
  }
  const [realRun, realGallery] = await Promise.all([fs.realpath(runRoot), fs.realpath(request.galleryRoot)]);
  if (!contained(realRun, realGallery)) throw new Error('Gallery publication directory escaped its run directory.');
  try {
    const sidecar = await fs.lstat(request.flagHistoryPath ?? request.sidecarPath);
    if (!sidecar.isFile() || sidecar.isSymbolicLink()) throw new Error('Reviewer flag history must be a real file.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function commitFlag(request) {
  try {
    await assertRealPublicationPaths(request);
    const current = await readFlagHistory(request.sidecarPath);
    const result = applyGalleryFlagTransition(current, request.transition);
    const encoded = `${JSON.stringify(result.history)}\n`;
    if (Buffer.byteLength(encoded) > GALLERY_FLAG_HISTORY_MAX_BYTES) {
      const error = new Error('Reviewer flag history reached its storage quota.');
      error.code = 'GALLERY_FLAG_HISTORY_TOO_LARGE';
      error.statusCode = 413;
      throw error;
    }
    if (!result.idempotent) {
      const temporary = `${request.sidecarPath}.${randomBytes(6).toString('hex')}.tmp`;
      await fs.writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o640, flag: 'wx' });
      await fs.rename(temporary, request.sidecarPath);
    }
    const snapshot = galleryFlagSnapshot(result.history);
    const descriptor = await refreshSealedFlagProjection(request, snapshot);
    await writeFlagResponse(request, {
      schemaVersion: 1,
      accepted: true,
      idempotent: result.idempotent,
      event: result.event,
      throughEvent: result.history.throughEvent,
      flagRevision: result.flagRevision,
      orderRevision: descriptor?.orderRevision ?? null,
      exportRevision: descriptor?.exportRevision ?? null,
      historyBytes: Buffer.byteLength(encoded),
    });
  } catch (error) {
    await writeFlagResponse(request, {
      schemaVersion: 1,
      accepted: false,
      code: error?.code ?? 'GALLERY_FLAG_WRITE_FAILED',
      statusCode: Number.isInteger(error?.statusCode) ? error.statusCode : 500,
      message: Number.isInteger(error?.statusCode) ? error.message : 'Reviewer flag mutation failed.',
    }).catch(() => {});
    throw error;
  }
}

async function commitArchive(request) {
  await assertRealPublicationPaths(request);
  const headPath = path.join(request.galleryRoot, 'current.json');
  const current = await readOptionalJson(headPath);
  const actualExportRevision = current?.exportRevision ?? null;
  if (actualExportRevision !== request.expectedExportRevision) {
    throw new Error(`GALLERY_HEAD_CONFLICT: expected ${request.expectedExportRevision ?? 'no head'}, found ${actualExportRevision ?? 'no head'}.`);
  }
  const persistedFlagHistory = await readOptionalJson(request.flagHistoryPath);
  const actualFlagRevision = persistedFlagHistory
    ? galleryFlagSnapshot(persistedFlagHistory).flagRevision
    : request.expectedFlagRevision;
  if (actualFlagRevision !== request.expectedFlagRevision || request.descriptor.flagRevision !== actualFlagRevision) {
    throw new Error(`GALLERY_FLAG_CONFLICT: expected ${request.expectedFlagRevision}, found ${actualFlagRevision}.`);
  }
  await validateStaging(request);
  await fs.mkdir(path.dirname(request.finalDir), { recursive: true });
  await installRevision(request);
  const temporaryHead = path.join(request.galleryRoot, `.current-${process.pid}-${Date.now()}.json`);
  await fs.writeFile(temporaryHead, `${JSON.stringify(request.descriptor)}\n`, { encoding: 'utf8', mode: 0o644 });
  await fs.rename(temporaryHead, headPath);
  await fs.rename(request.surfacePagePath, path.join(path.dirname(request.galleryRoot), 'gallery.html'));
}

async function commit(requestValue) {
  const request = validateRequest(requestValue);
  if (request.operation === 'flag-transition') return await commitFlag(request);
  return await commitArchive(request);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function acquirePortableLock(lockDirectory) {
  for (;;) {
    try {
      await fs.mkdir(lockDirectory);
      await fs.writeFile(path.join(lockDirectory, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');
      return async () => {
        await fs.rm(lockDirectory, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new Error(`Gallery publication lock is unsupported at ${lockDirectory}.`, { cause: error });
      }
      const owner = await readOptionalJson(path.join(lockDirectory, 'owner.json')).catch(() => null);
      if (Number.isInteger(owner?.pid) && !processExists(owner.pid)) {
        await fs.rm(lockDirectory, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function runWithPortableLock(requestPath) {
  const request = validateRequest(await readJson(requestPath));
  const release = await acquirePortableLock(path.join(request.galleryRoot, '.publish.portable-lock'));
  try {
    await commit(request);
  } finally {
    await release();
  }
}

async function runWithLinuxFlock(requestPath) {
  const request = validateRequest(await readJson(requestPath));
  const lockPath = path.join(request.galleryRoot, '.publish.lock');
  const child = spawn('flock', [
    '--exclusive',
    lockPath,
    process.execPath,
    scriptPath,
    '--locked',
    requestPath,
  ], { stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => signal ? reject(new Error(`flock helper exited via ${signal}.`)) : resolve(status ?? 1));
  });
  if (code !== 0) throw new Error(`flock helper exited with status ${code}.`);
}

async function main() {
  const [mode, requestPathValue] = process.argv.slice(2);
  if (!['--request', '--locked'].includes(mode) || !requestPathValue) {
    throw new Error('Usage: gallery-publish.mjs --request <request.json>');
  }
  const requestPath = path.resolve(requestPathValue);
  try {
    if (mode === '--locked') await commit(await readJson(requestPath));
    else if (process.platform === 'linux') await runWithLinuxFlock(requestPath);
    else await runWithPortableLock(requestPath);
  } finally {
    await fs.rm(requestPath, { force: true });
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
