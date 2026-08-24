export const GALLERY_RETENTION_LIMITS = Object.freeze({
  revisionsPerRun: 4,
  runs: 8,
  maximumEntryBytes: 16 * 1024 * 1024,
  maximumRunBytes: 32 * 1024 * 1024,
  maximumTotalBytes: 96 * 1024 * 1024,
});

const measuredEntries = new WeakMap();

export function galleryRevisionEntryBytes(entry) {
  if (!entry || typeof entry !== 'object') return Number.POSITIVE_INFINITY;
  const cached = measuredEntries.get(entry);
  if (cached !== undefined) return cached;
  const bytes = retainedValueBytes(entry, new Set());
  measuredEntries.set(entry, bytes);
  return bytes;
}

export function pruneGalleryRevisionCache(cache, limits = GALLERY_RETENTION_LIMITS) {
  for (const [runId, revisions] of cache) {
    for (const [revision, value] of revisions) {
      if (galleryRevisionEntryBytes(value) > limits.maximumEntryBytes) revisions.delete(revision);
    }
    while (revisions.size > limits.revisionsPerRun) revisions.delete(revisions.keys().next().value);
    let runBytes = [...revisions.values()].reduce((total, value) => total + galleryRevisionEntryBytes(value), 0);
    while (runBytes > limits.maximumRunBytes && revisions.size > 0) {
      const oldest = revisions.keys().next().value;
      runBytes -= galleryRevisionEntryBytes(revisions.get(oldest));
      revisions.delete(oldest);
    }
    if (revisions.size === 0) cache.delete(runId);
  }
  while (cache.size > limits.runs) cache.delete(cache.keys().next().value);
  let totalBytes = galleryRevisionCacheStats(cache).bytes;
  while (totalBytes > limits.maximumTotalBytes && cache.size > 0) {
    const oldestRunId = cache.keys().next().value;
    const revisions = cache.get(oldestRunId);
    const oldestRevision = revisions.keys().next().value;
    totalBytes -= galleryRevisionEntryBytes(revisions.get(oldestRevision));
    revisions.delete(oldestRevision);
    if (revisions.size === 0) cache.delete(oldestRunId);
  }
  return galleryRevisionCacheStats(cache);
}

export function galleryRevisionCacheStats(cache) {
  const values = [...cache.values()].flatMap((revisions) => [...revisions.values()]);
  return {
    runs: cache.size,
    revisions: values.length,
    bytes: values.reduce((total, value) => total + galleryRevisionEntryBytes(value), 0),
  };
}

function retainedValueBytes(value, seen) {
  if (value === null || value === undefined) return 8;
  if (typeof value === 'string') return 16 + Buffer.byteLength(value, 'utf8') * 2;
  if (typeof value === 'number' || typeof value === 'bigint') return 16;
  if (typeof value === 'boolean') return 8;
  if (typeof value === 'function' || typeof value === 'symbol') return 0;
  if (seen.has(value)) return 8;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return 64 + value.byteLength;
  if (value instanceof ArrayBuffer) return 64 + value.byteLength;
  if (value instanceof Date) return 64;
  if (value instanceof Map) {
    let bytes = 96;
    for (const [key, entry] of value) bytes += 32 + retainedValueBytes(key, seen) + retainedValueBytes(entry, seen);
    return bytes;
  }
  if (value instanceof Set) {
    let bytes = 96;
    for (const entry of value) bytes += 24 + retainedValueBytes(entry, seen);
    return bytes;
  }
  if (Array.isArray(value)) return 40 + value.reduce((bytes, entry) => bytes + 8 + retainedValueBytes(entry, seen), 0);
  let bytes = 64;
  for (const [key, entry] of Object.entries(value)) {
    bytes += 16 + Buffer.byteLength(key, 'utf8') * 2 + retainedValueBytes(entry, seen);
  }
  return bytes;
}
