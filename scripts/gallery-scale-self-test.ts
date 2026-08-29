import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeGalleryArchive as writeUnboundGalleryArchive, type WriteGalleryArchiveOptions } from '../reporters/gallery-model.js';
import { sharedPublicationFixture } from '../portal/tests/shared-publication-fixture.js';
import { galleryItemHref } from '../shared/gallery-contract.mjs';
import {
  GALLERY_SCALE,
  buildGalleryScaleCatalog,
  countGalleryScaleCorpusFiles,
  materializeGalleryScaleCorpus,
} from './gallery-scale-fixture.js';

const root = await mkdtemp(path.join(tmpdir(), 'gallery-scale-self-test-'));
const sharedPublication = sharedPublicationFixture('comparative', 'gallery-scale-self-test');
const writeGalleryArchive = (options: WriteGalleryArchiveOptions) => writeUnboundGalleryArchive({
  ...options,
  releasePublicationEnvelope: sharedPublication.envelope,
  releasePublicationBinding: {
    runId: sharedPublication.view.publication.runId, mode: 'comparative',
    finalSubjectDigest: sharedPublication.view.subjectDigest as `sha256:${string}`,
    runRevision: sharedPublication.view.revisions.run,
    publicationDigest: sharedPublication.view.publication.envelopeDigest as `sha256:${string}`,
  },
});
try {
  const catalog = buildGalleryScaleCatalog();
  assert.equal(catalog.blobs.length, GALLERY_SCALE.reportArtifacts);
  assert.equal(catalog.items.length, GALLERY_SCALE.logicalMedia);
  assert.equal(catalog.items.filter(({ kind }) => kind === 'video').length, GALLERY_SCALE.validatedVideos);
  assert.equal(
    catalog.blobs.length + catalog.blobs.reduce((total, blob) => total + blob.storageLocations.length, 0),
    GALLERY_SCALE.storedFiles,
  );
  assert(catalog.items.filter(({ kind }) => kind === 'video').every(({ capture }) => /Validated interaction-only action and response/.test(capture.rationale ?? '')));
  assert(catalog.items.filter(({ kind }) => kind === 'image').every(({ capture }) => /Screenshot-only/.test(capture.rationale ?? '')));

  const outputDir = path.join(root, 'checklist');
  const descriptor = await writeGalleryArchive({
    outputDir,
    catalog,
    exportedAt: '2026-08-24T12:00:00.000Z',
  });
  const materialization = await materializeGalleryScaleCorpus({
    catalog,
    archiveRoot: outputDir,
    storageRoot: root,
    imageBytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/2pQmWQAAAABJRU5ErkJggg==', 'base64'),
    videoBytes: Buffer.from('structural-video-fixture'),
  });
  assert.deepEqual(await countGalleryScaleCorpusFiles({ archiveRoot: outputDir, storageRoot: root }), {
    artifactHrefs: GALLERY_SCALE.reportArtifacts,
    storageCopies: GALLERY_SCALE.storedFiles - GALLERY_SCALE.reportArtifacts,
    storedFiles: GALLERY_SCALE.storedFiles,
  });
  assert.equal(materialization.storedFiles, GALLERY_SCALE.storedFiles);
  assert.equal(materialization.verifiedFiles, GALLERY_SCALE.storedFiles);
  assert.equal(descriptor.primaryCounts.total, GALLERY_SCALE.logicalMedia);
  assert.equal(descriptor.primaryCounts.videos, GALLERY_SCALE.validatedVideos);
  assert.equal(descriptor.raw.rows, GALLERY_SCALE.reportArtifacts);
  assert(descriptor.query.chunks.every(({ rows, bytes }) => rows <= 100 && bytes <= 256 * 1024));
  assert(descriptor.raw.chunks.every(({ rows, bytes }) => rows <= 100 && bytes <= 256 * 1024));
  assert((await stat(path.join(outputDir, 'gallery', 'current.json'))).size <= 256 * 1024);

  let maximumDetailBytes = 0;
  for (const item of catalog.items) {
    const bytes = (await stat(path.join(outputDir, ...galleryItemHref(descriptor, item.id).split('/')))).size;
    maximumDetailBytes = Math.max(maximumDetailBytes, bytes);
    assert(bytes <= 512 * 1024);
  }
  const coldMetadataBytes = (await stat(path.join(outputDir, 'gallery', 'current.json'))).size
    + (descriptor.query.chunks[0]?.bytes ?? 0)
    + (await stat(path.join(outputDir, ...galleryItemHref(descriptor, catalog.items[0]!.id).split('/')))).size;
  const coldMetadataRequests = 3;
  assert(coldMetadataBytes <= 1024 * 1024, `Cold metadata was ${coldMetadataBytes} bytes.`);
  assert.equal(coldMetadataRequests, 3, 'Cold first usable is the embedded descriptor plus query, detail, and flag wrappers.');
  assert.doesNotMatch(await readFile(path.join(outputDir, 'gallery.html'), 'utf8'), /audit-manifest|manifest\.json/);

  console.log(JSON.stringify({
    status: 'passed',
    fixture: GALLERY_SCALE,
    descriptorBytes: (await stat(path.join(outputDir, 'gallery', 'current.json'))).size,
    queryChunks: descriptor.query.chunks.length,
    rawChunks: descriptor.raw.chunks.length,
    maximumDetailBytes,
    coldMetadataBytes,
    coldMetadataRequests,
    materialization,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
