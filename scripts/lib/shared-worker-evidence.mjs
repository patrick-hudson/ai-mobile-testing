import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_WORKER_ARTIFACTS = 64;
export const MAX_WORKER_ARTIFACT_BYTES = 8 * 1_048_576;
export const MAX_WORKER_EVIDENCE_BYTES = 16 * 1_048_576;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i;

function artifactPath(root, value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value.includes('\\') || value.includes('\0')) {
    throw new Error('Executor artifact path is invalid.');
  }
  const segments = value.split('/');
  if (value.startsWith('/') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Executor artifact path must be normalized and relative.');
  }
  const candidate = path.resolve(root, ...segments);
  if (!candidate.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Executor artifact path escaped its evidence directory.');
  return candidate;
}

export async function collectSharedWorkerEvidence(evidenceRoot, { code, signal = null }, lease) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)
    || typeof lease.runId !== 'string' || !lease.runId
    || typeof lease.workItemId !== 'string' || !lease.workItemId
    || !Number.isSafeInteger(lease.attempt) || lease.attempt < 1
    || typeof lease.subjectCoreDigest !== 'string' || !lease.subjectCoreDigest
    || typeof lease.runnerRevision !== 'string' || !lease.runnerRevision) {
    throw new Error('A valid active work lease is required to collect executor evidence.');
  }
  const manifestPath = path.join(evidenceRoot, 'result.json');
  let manifest;
  let manifestHandle;
  try {
    manifestHandle = await fs.open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await manifestHandle.stat();
    if (!stat.isFile() || stat.size > 65_536) throw new Error('Executor result manifest is not a bounded regular file.');
    manifest = JSON.parse(await manifestHandle.readFile('utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Executor result manifest is required.');
    throw error;
  } finally {
    await manifestHandle?.close();
  }
  const resultKeys = [
    'schemaVersion', 'kind', 'runId', 'workItemId', 'attempt', 'subjectCoreDigest', 'runnerRevision',
    'outcome', 'reason', 'artifacts',
  ];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).length !== resultKeys.length || resultKeys.some((key) => !(key in manifest))
    || manifest.schemaVersion !== 1 || manifest.kind !== 'shared-worker-result'
    || !['completed_pass', 'completed_product_failure'].includes(manifest.outcome)
    || (manifest.reason !== null && (typeof manifest.reason !== 'string' || !manifest.reason || manifest.reason.length > 256))
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > MAX_WORKER_ARTIFACTS) {
    throw new Error('Executor result manifest has an invalid schema.');
  }
  if (manifest.runId !== lease.runId || manifest.workItemId !== lease.workItemId || manifest.attempt !== lease.attempt
    || manifest.subjectCoreDigest !== lease.subjectCoreDigest || manifest.runnerRevision !== lease.runnerRevision) {
    throw new Error('Executor result identity does not match the active work lease.');
  }
  if (signal !== null || !Number.isSafeInteger(code) || code < 0 || code > 1) {
    throw new Error('Executor terminated abnormally; the lease must expire for operational recovery.');
  }
  if (code === 1 && manifest.outcome !== 'completed_product_failure') {
    throw new Error('Executor exit 1 requires a completed product failure result.');
  }
  const declarations = manifest.artifacts;
  const uploads = [];
  const names = new Set();
  const digests = new Set();
  let totalBytes = 0;
  const realRoot = await fs.realpath(evidenceRoot);
  for (const declaration of declarations) {
    if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)
      || Object.keys(declaration).length !== 2 || !('path' in declaration) || !('mediaType' in declaration)
      || typeof declaration.mediaType !== 'string' || !MEDIA_TYPE.test(declaration.mediaType)) {
      throw new Error('Executor artifact declaration has an invalid schema.');
    }
    const name = declaration.path;
    if (names.has(name)) throw new Error(`Executor declared duplicate artifact ${name}.`);
    const candidate = artifactPath(evidenceRoot, name);
    const declaredStat = await fs.lstat(candidate);
    if (!declaredStat.isFile() || declaredStat.isSymbolicLink()) {
      throw new Error(`Executor artifact ${name} must be a regular non-symbolic file.`);
    }
    const realCandidate = await fs.realpath(candidate);
    if (!realCandidate.startsWith(`${realRoot}${path.sep}`)) throw new Error(`Executor artifact ${name} escaped its evidence directory.`);
    let handle;
    let bytes;
    try {
      handle = await fs.open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_WORKER_ARTIFACT_BYTES) {
        throw new Error(`Executor artifact ${name} exceeds its file bound.`);
      }
      bytes = await handle.readFile();
    } finally {
      await handle?.close();
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_WORKER_EVIDENCE_BYTES) throw new Error('Executor artifacts exceed the attempt evidence byte bound.');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digests.has(digest)) throw new Error(`Executor declared duplicate artifact content for ${name}.`);
    names.add(name);
    digests.add(digest);
    uploads.push({
      name, mediaType: declaration.mediaType.toLowerCase(), sizeBytes: bytes.length,
      digest, contentBase64: bytes.toString('base64'),
    });
  }
  return {
    outcome: manifest.outcome,
    reason: manifest.reason,
    artifacts: uploads,
  };
}
