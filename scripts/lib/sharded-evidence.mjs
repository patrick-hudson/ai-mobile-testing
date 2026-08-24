import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

export const PERFORMANCE_BLOB_FILENAME = 'performance-isolated.zip';
export const SHARDED_RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,79}$/;

export function validatedShardedRunId(value) {
  if (typeof value !== 'string' || !SHARDED_RUN_ID_PATTERN.test(value)) {
    throw new Error('AUDIT_SHARDED_RUN_ID must be 8–80 lowercase letters, numbers, and hyphens, beginning with a letter or number.');
  }
  return value;
}

export async function createFreshShardedRunDirectory(shardedRootValue, runIdValue) {
  const shardedRoot = resolve(shardedRootValue);
  const runId = validatedShardedRunId(runIdValue);
  await fs.mkdir(shardedRoot, { recursive: true });
  const runDirectory = join(shardedRoot, runId);
  try {
    await fs.mkdir(runDirectory, { mode: 0o750 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    throw Object.assign(new Error(
      `Sharded run ${runId} already exists. Choose a new AUDIT_SHARDED_RUN_ID, or archive/purge the prior run before reusing this name. Existing evidence was not modified.`,
    ), { code: 'AUDIT_SHARDED_RUN_EXISTS' });
  }
  return runDirectory;
}

export function expectedShardedBlobs(blobDirectory, shardTotal) {
  if (!Number.isInteger(shardTotal) || shardTotal < 1) {
    throw new Error('shardTotal must be a positive integer.');
  }
  return [
    ...Array.from({ length: shardTotal }, (_, offset) => ({
      kind: 'functional-shard',
      index: offset + 1,
      path: join(blobDirectory, `report-${offset + 1}-of-${shardTotal}.zip`),
    })),
    {
      kind: 'isolated-performance',
      index: null,
      path: join(blobDirectory, PERFORMANCE_BLOB_FILENAME),
    },
  ];
}

export async function inspectShardedBlobs(expected, runStartedAt) {
  const threshold = Date.parse(runStartedAt);
  if (!Number.isFinite(threshold)) throw new Error('The sharded run start time must be a valid ISO timestamp.');

  const present = [];
  const missing = [];
  const stale = [];
  for (const blob of expected) {
    const stat = await fs.stat(blob.path).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) {
      missing.push(blob);
    } else if (stat.mtimeMs < threshold - 1_000) {
      stale.push({ ...blob, modifiedAt: stat.mtime.toISOString(), bytes: stat.size });
    } else {
      present.push({ ...blob, modifiedAt: stat.mtime.toISOString(), bytes: stat.size });
    }
  }
  return { present, missing, stale };
}
