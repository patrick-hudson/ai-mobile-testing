import { constants as fsConstants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, relative, resolve, sep } from 'node:path';

const VIDEO_PROCESSING_STATUSES = new Set(['created', 'already-existed', 'ffmpeg-unavailable', 'failed']);
const EVIDENCE_ROLES = new Set(['usable-interaction', 'diagnostic']);

export async function validatePreferredMediaManifest(runDirectoryValue, options = {}) {
  const runDirectory = resolve(runDirectoryValue);
  const maximumBytes = options.maximumBytes ?? 8 * 1024 * 1024;
  const maximumArtifacts = options.maximumArtifacts ?? 120;
  const verifyDigests = options.verifyDigests !== false;
  const manifestPath = join(runDirectory, 'video-manifest.json');
  const manifestStat = await fs.stat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile()) return { schemaVersion: null, paths: [], records: new Map(), errors: [] };
  if (manifestStat.size <= 0 || manifestStat.size > maximumBytes) {
    return {
      schemaVersion: 0,
      paths: [],
      records: new Map(),
      errors: [`video-manifest.json must be non-empty and no larger than ${maximumBytes} bytes.`],
    };
  }

  let document;
  try {
    document = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    return { schemaVersion: 0, paths: [], records: new Map(), errors: ['video-manifest.json is not valid JSON.'] };
  }
  if (document?.schemaVersion !== 2 || !Array.isArray(document?.videos)) {
    return {
      schemaVersion: Number.isInteger(document?.schemaVersion) ? document.schemaVersion : 0,
      paths: [],
      records: new Map(),
      errors: ['video-manifest.json must use schemaVersion 2 and contain a videos array.'],
    };
  }

  const paths = [];
  const records = new Map();
  const seenPaths = new Set();
  const errors = [];
  if (!Array.isArray(document.retention?.integrityErrors)
    || document.retention.integrityErrors.length > 0) {
    errors.push('retention.integrityErrors must be an empty array for completed evidence.');
  }
  for (const [index, entry] of document.videos.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`videos[${index}] is not an object.`);
      continue;
    }
    if (!VIDEO_PROCESSING_STATUSES.has(entry.processingStatus)) {
      errors.push(`videos[${index}].processingStatus is invalid.`);
      continue;
    }
    const evidenceRole = entry.evidenceRole;
    if (!EVIDENCE_ROLES.has(evidenceRole)) {
      errors.push(`videos[${index}].evidenceRole is invalid.`);
      continue;
    }
    if (['failed', 'ffmpeg-unavailable'].includes(entry.processingStatus)) {
      errors.push(`videos[${index}].processingStatus ${JSON.stringify(entry.processingStatus)} is not completed media evidence.`);
      continue;
    }
    if (['created', 'already-existed'].includes(entry.processingStatus)
      && (typeof entry.poster !== 'string' || entry.poster.length === 0)) {
      errors.push(`videos[${index}].poster is required for completed media processing.`);
      continue;
    }
    const video = await validateVideoEntry(runDirectory, entry, index, verifyDigests);
    if (!video.record) {
      errors.push(video.error);
      continue;
    }
    if (seenPaths.has(video.record.path)) {
      errors.push(`videos[${index}].video duplicates ${JSON.stringify(video.record.path)}.`);
      continue;
    }
    seenPaths.add(video.record.path);
    if (paths.length < maximumArtifacts) {
      records.set(video.record.path, { ...video.record, evidenceRole, kind: 'video' });
      paths.push(video.record.path);
    }

    if (entry.poster !== null && entry.poster !== undefined) {
      if (!['created', 'already-existed'].includes(entry.processingStatus)) {
        errors.push(`videos[${index}].poster is present for processingStatus ${JSON.stringify(entry.processingStatus)}.`);
        continue;
      }
      if (typeof entry.poster !== 'string'
        || !['.jpg', '.jpeg', '.png', '.webp'].includes(extname(entry.poster).toLowerCase())) {
        errors.push(`videos[${index}].poster must name a supported image file.`);
        continue;
      }
      const poster = await validateContainedFile(runDirectory, entry.poster, entry.posterBytes);
      if (!poster.record) {
        errors.push(`videos[${index}].poster ${poster.error}`);
        continue;
      }
      if (seenPaths.has(poster.record.path)) {
        errors.push(`videos[${index}].poster duplicates ${JSON.stringify(poster.record.path)}.`);
        continue;
      }
      seenPaths.add(poster.record.path);
      if (paths.length < maximumArtifacts) {
        records.set(poster.record.path, { ...poster.record, evidenceRole, kind: 'poster' });
        paths.push(poster.record.path);
      }
    }
  }
  requireExactCount(document, 'videoCount', document.videos.length, errors);
  const processedCount = document.videos
    .filter(({ processingStatus }) => ['created', 'already-existed'].includes(processingStatus)).length;
  const failedCount = document.videos
    .filter(({ processingStatus }) => processingStatus === 'failed').length;
  const unavailableCount = document.videos
    .filter(({ processingStatus }) => processingStatus === 'ffmpeg-unavailable').length;
  const usableInteractionVideoCount = document.videos
    .filter(({ evidenceRole }) => evidenceRole === 'usable-interaction').length;
  const diagnosticVideoCount = document.videos
    .filter(({ evidenceRole }) => evidenceRole === 'diagnostic').length;
  requireExactCount(document, 'processedCount', processedCount, errors);
  requireExactCount(document, 'failedCount', failedCount, errors);
  requireExactCount(document, 'unavailableCount', unavailableCount, errors);
  requireExactCount(document, 'usableInteractionVideoCount', usableInteractionVideoCount, errors);
  requireExactCount(document, 'diagnosticVideoCount', diagnosticVideoCount, errors);
  if (failedCount > 0) errors.push('failedCount must be zero for completed evidence.');
  if (unavailableCount > 0) errors.push('unavailableCount must be zero for completed evidence.');
  return { schemaVersion: 2, paths, records, errors };
}

function requireExactCount(document, name, expected, errors) {
  if (!Number.isSafeInteger(document[name]) || document[name] < 0) {
    errors.push(`${name} must be a non-negative safe integer.`);
  } else if (document[name] !== expected) {
    errors.push(`${name} does not match the videos array.`);
  }
}

async function validateVideoEntry(runDirectory, entry, index, verifyDigest) {
  if (typeof entry.video !== 'string' || !['.webm', '.mp4'].includes(extname(entry.video).toLowerCase())) {
    return { error: `videos[${index}].video must name a WebM or MP4 file.` };
  }
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) {
    return { error: `videos[${index}].sha256 is invalid.` };
  }
  const validated = await validateContainedFile(
    runDirectory,
    entry.video,
    entry.bytes,
    verifyDigest ? entry.sha256 : null,
  );
  if (!validated.record) return { error: `videos[${index}].video ${validated.error}` };
  return validated;
}

async function validateContainedFile(runDirectory, value, expectedBytes, expectedSha256 = null) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return { error: 'path is invalid.' };
  }
  const absolutePath = resolve(runDirectory, value);
  if (!inside(runDirectory, absolutePath) || absolutePath === runDirectory) {
    return { error: 'resolves outside the run directory.' };
  }
  const linkStat = await fs.lstat(absolutePath).catch(() => null);
  if (!linkStat?.isFile() || linkStat.isSymbolicLink()) {
    return { error: 'is not a regular non-symbolic-link file.' };
  }
  let realRunDirectory;
  let realPath;
  try {
    [realRunDirectory, realPath] = await Promise.all([fs.realpath(runDirectory), fs.realpath(absolutePath)]);
  } catch {
    return { error: 'is missing.' };
  }
  if (!inside(realRunDirectory, realPath)) return { error: 'resolves outside the run directory.' };
  let measured;
  try {
    measured = await measureFile(realPath, expectedSha256 !== null);
  } catch {
    return { error: 'is not a readable regular file.' };
  }
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || measured.bytes !== expectedBytes) {
    return { error: `byte count does not match the manifest (${measured.bytes} actual, ${expectedBytes ?? 'invalid'} recorded).` };
  }
  if (expectedSha256 !== null && measured.sha256 !== expectedSha256) {
    return { error: 'SHA-256 does not match the retained bytes.' };
  }
  return {
    record: {
      path: relative(runDirectory, absolutePath).split(sep).join('/'),
      bytes: measured.bytes,
      mtimeMs: measured.mtimeMs,
      sha256: expectedSha256,
    },
  };
}

async function measureFile(path, includeDigest) {
  const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) throw new Error('not a regular file');
    if (!includeDigest) return { bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: null };
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return { bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
