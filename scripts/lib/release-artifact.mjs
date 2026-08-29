import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../../shared/canonical-contract.mjs';
import { parseReleaseArtifactManifest, sealReleaseArtifactManifest } from '../../shared/release-artifact-contract.mjs';

const DEFAULT_LIMITS = Object.freeze({
  maximumFiles: 100_000,
  maximumBytes: 2 * 1_024 * 1_024 * 1_024,
  maximumFileBytes: 512 * 1_024 * 1_024,
  maximumDepth: 64,
});

export class ReleaseArtifactError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ReleaseArtifactError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new ReleaseArtifactError(code, message, cause);
}

function limits(options) {
  const result = { ...DEFAULT_LIMITS, ...options };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive safe integer.`);
  }
  return result;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function hashFile(file, relativePath, maximumFileBytes) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) fail('RELEASE_ARTIFACT_UNSAFE', `Release artifact entry ${relativePath} is not a regular file.`);
    if (before.size > maximumFileBytes) fail('RELEASE_ARTIFACT_LIMIT', `Release artifact entry ${relativePath} exceeds the per-file byte limit.`);
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > maximumFileBytes) fail('RELEASE_ARTIFACT_LIMIT', `Release artifact entry ${relativePath} exceeded its byte bound while hashing.`);
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (bytes !== before.size || !sameFile(before, after)) {
      fail('RELEASE_ARTIFACT_CHANGED', `Release artifact entry ${relativePath} changed while it was being hashed.`);
    }
    return { relativePath, size: bytes, digest: `sha256:${hash.digest('hex')}` };
  } catch (error) {
    if (error instanceof ReleaseArtifactError) throw error;
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail('RELEASE_ARTIFACT_UNSAFE', `Release artifact entry ${relativePath} is a symbolic link.`, error);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function buildReleaseArtifactManifest(root, options = {}) {
  const bound = limits(options);
  const resolved = path.resolve(root);
  let rootMetadata;
  try { rootMetadata = await lstat(resolved); } catch (error) { fail('RELEASE_ARTIFACT_UNAVAILABLE', 'Release artifact root is unavailable.', error); }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail('RELEASE_ARTIFACT_UNSAFE', 'Release artifact root must be a real directory.');
  }
  const canonicalRoot = await realpath(resolved);
  if (canonicalRoot !== resolved) fail('RELEASE_ARTIFACT_UNSAFE', 'Release artifact root must not traverse a symbolic link.');
  const files = [];
  let totalBytes = 0;

  async function visit(directory, relativeDirectory, depth) {
    if (depth > bound.maximumDepth) fail('RELEASE_ARTIFACT_LIMIT', 'Release artifact directory depth exceeds the configured limit.');
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.includes('/') || entry.name.includes('\\') || entry.name === '.' || entry.name === '..') {
        fail('RELEASE_ARTIFACT_UNSAFE', 'Release artifact contains an unsafe directory entry.');
      }
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) fail('RELEASE_ARTIFACT_UNSAFE', `Release artifact entry ${relative} is a symbolic link.`);
      if (metadata.isDirectory()) {
        await visit(absolute, relative, depth + 1);
        continue;
      }
      if (!metadata.isFile()) fail('RELEASE_ARTIFACT_UNSAFE', `Release artifact entry ${relative} is not a regular file.`);
      if (files.length >= bound.maximumFiles) fail('RELEASE_ARTIFACT_LIMIT', 'Release artifact file count exceeds the configured limit.');
      const hashed = await hashFile(absolute, relative, bound.maximumFileBytes);
      totalBytes += hashed.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > bound.maximumBytes) {
        fail('RELEASE_ARTIFACT_LIMIT', 'Release artifact byte total exceeds the configured limit.');
      }
      files.push(hashed);
    }
  }

  await visit(resolved, '', 0);
  if (files.length === 0) fail('RELEASE_ARTIFACT_EMPTY', 'Release artifact must contain at least one file.');
  return sealReleaseArtifactManifest({ schemaVersion: 1, files });
}

export async function verifyReleaseArtifactManifest(root, expected, options = {}) {
  const parsed = parseReleaseArtifactManifest(expected);
  const observed = await buildReleaseArtifactManifest(root, options);
  if (canonicalJson(observed) !== canonicalJson(parsed)) {
    fail('RELEASE_ARTIFACT_CHANGED', 'Release artifact bytes or membership changed after the audited candidate was bound.');
  }
  return parsed;
}
