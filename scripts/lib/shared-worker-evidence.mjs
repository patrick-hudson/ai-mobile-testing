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

export async function collectSharedWorkerEvidence(evidenceRoot, { code, signal = null }) {
  const manifestPath = path.join(evidenceRoot, 'result.json');
  let manifest = null;
  let manifestHandle;
  try {
    manifestHandle = await fs.open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await manifestHandle.stat();
    if (!stat.isFile() || stat.size > 65_536) throw new Error('Executor result manifest is not a bounded regular file.');
    manifest = JSON.parse(await manifestHandle.readFile('utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    await manifestHandle?.close();
  }
  if (manifest !== null && (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).some((key) => !['outcome', 'reason', 'artifacts'].includes(key))
    || !['completed_pass', 'completed_product_failure'].includes(manifest.outcome)
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length > MAX_WORKER_ARTIFACTS)) {
    throw new Error('Executor result manifest has an invalid schema.');
  }
  const declarations = manifest?.artifacts ?? [];
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
  const failed = code !== 0;
  return {
    outcome: failed ? 'completed_product_failure' : (manifest?.outcome ?? 'completed_pass'),
    reason: failed ? (signal ? `executor-signal-${signal}` : `executor-exit-${code}`) : (manifest?.reason ?? null),
    artifacts: uploads,
  };
}
