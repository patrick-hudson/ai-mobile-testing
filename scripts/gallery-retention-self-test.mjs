import assert from 'node:assert/strict';
import {
  GALLERY_RETENTION_LIMITS,
  galleryRevisionCacheStats,
  galleryRevisionEntryBytes,
  pruneGalleryRevisionCache,
} from '../portal/gallery-retention.mjs';

function retainedEntry(run, revision, blobCount = 2) {
  const blobs = Array.from({ length: blobCount }, (_, index) => ({
    id: `blob-${run}-${revision}-${index}`,
    href: `raw/${run}/${revision}/${index}.png`,
    storageLocations: [`copy-a/${index}.png`, `copy-b/${index}.png`],
  }));
  return {
    snapshot: {
      kind: 'live',
      head: { contentRevision: `content-${run}-${revision}`, flagRevision: 'flags-empty', orderRevision: `order-${run}-${revision}` },
      rows: blobs.map((blob, index) => ({ id: `item-${index}`, title: `Evidence ${index}`, blobId: blob.id })),
      catalog: { items: blobs.map((blob, index) => ({ id: `item-${index}`, members: [{ blobId: blob.id }] })), blobs },
      blobOrigins: new Map(blobs.map((blob) => [blob.id, [{ sourceBase: `/runs/${run}`, file: `/runs/${run}/${blob.href}`, href: blob.href }]])),
    },
    fingerprints: new Map(blobs.map((_, index) => [`item-${index}`, `fingerprint-${run}-${revision}-${index}`])),
    estimatedBytes: 1,
  };
}

const cache = new Map();
for (let run = 0; run < 9; run += 1) {
  const revisions = new Map();
  for (let revision = 0; revision < 5; revision += 1) revisions.set(`revision-${revision}`, retainedEntry(run, revision));
  cache.set(`run-${run}`, revisions);
}
const cardinality = pruneGalleryRevisionCache(cache);
assert.equal(cardinality.runs, GALLERY_RETENTION_LIMITS.runs);
assert.equal(cardinality.revisions, GALLERY_RETENTION_LIMITS.runs * GALLERY_RETENTION_LIMITS.revisionsPerRun);
assert.equal(cache.has('run-0'), false, 'The least-recent run is evicted first.');
assert.deepEqual([...cache.get('run-1').keys()], ['revision-1', 'revision-2', 'revision-3', 'revision-4']);

const lean = retainedEntry('lean', 1, 1);
const heavyweight = retainedEntry('heavy', 1, 2_000);
const leanBytes = galleryRevisionEntryBytes(lean);
const heavyweightBytes = galleryRevisionEntryBytes(heavyweight);
assert(heavyweightBytes > leanBytes * 100, 'Full catalog and blobOrigins maps must materially affect retained size.');
assert(leanBytes > lean.estimatedBytes, 'Caller-supplied estimatedBytes must not control cache accounting.');

const entryLimitCache = new Map([['oversized', new Map([['lean', lean], ['heavy', heavyweight]])]]);
pruneGalleryRevisionCache(entryLimitCache, {
  ...GALLERY_RETENTION_LIMITS,
  maximumEntryBytes: Math.floor((leanBytes + heavyweightBytes) / 2),
});
assert.deepEqual([...entryLimitCache.get('oversized').keys()], ['lean']);

const unit = galleryRevisionEntryBytes(retainedEntry('unit', 1, 100));
const byteCache = new Map(Array.from({ length: 6 }, (_, run) => [`large-${run}`, new Map([
  ['old', retainedEntry(`large-${run}`, 1, 100)],
  ['new', retainedEntry(`large-${run}`, 2, 100)],
]) ]));
const byteLimits = {
  ...GALLERY_RETENTION_LIMITS,
  maximumEntryBytes: unit * 2,
  maximumRunBytes: unit * 2 + 1_024,
  maximumTotalBytes: unit * 6 + 1_024,
};
const bounded = pruneGalleryRevisionCache(byteCache, byteLimits);
assert(bounded.bytes <= byteLimits.maximumTotalBytes);
assert([...byteCache.values()].every((revisions) => [...revisions.values()]
  .reduce((sum, value) => sum + galleryRevisionEntryBytes(value), 0) <= byteLimits.maximumRunBytes));
assert.equal(byteCache.has('large-0'), false, 'True snapshot byte pressure evicts the least-recent run/revision deterministically.');
assert.deepEqual(bounded, galleryRevisionCacheStats(byteCache));

console.log(`Gallery retention self-test passed: ${JSON.stringify({
  cardinality, bounded, leanBytes, heavyweightBytes, limits: GALLERY_RETENTION_LIMITS,
})}`);
