import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALL_AUDIT_CATALOG } from '../audit/definitions.js';
import { buildGalleryCatalog, writeGalleryArchive as writeUnboundGalleryArchive, type WriteGalleryArchiveOptions } from '../reporters/gallery-model.js';
import { sharedPublicationFixture } from '../portal/tests/shared-publication-fixture.js';
import {
  GALLERY_FLAG_MAX_EVENTS,
  applyGalleryFlagTransition,
  galleryFlagRevision,
  type GalleryFlagEvent,
  type GalleryFlagHistory,
} from '../shared/gallery-contract.mjs';
import {
  mutateGalleryFlag,
  readGalleryFlagSnapshot,
} from './gallery-flags.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'gallery-flags-self-test-'));
const sharedPublication = sharedPublicationFixture('comparative', 'gallery-flags-self-test');
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
  const checklist = path.join(root, 'checklist');
  const releasePath = path.join(root, 'sharded-run.json');
  const releaseTruth = `${JSON.stringify({
    schemaVersion: 2,
    runId: 'gallery-flags-self-test',
    status: 'not-ready',
    release: { decision: 'NOT_READY', ready: false, blockingFailures: 1 },
  })}\n`;
  await writeFile(releasePath, releaseTruth, 'utf8');
  const catalog = await buildGalleryCatalog({
    outputDir: checklist,
    definitionCatalog: ALL_AUDIT_CATALOG,
    tests: [{
      id: 'gallery-flag-source-test',
      title: 'Gallery flag evidence remains review-only',
      titlePath: ['gallery flags', 'Gallery flag evidence remains review-only'],
      file: 'scripts/gallery-flags-self-test.ts',
      projectName: 'candidate-mobile-chromium',
      projectMetadata: {
        environment: 'candidate',
        browserLabel: 'Chromium / Pixel 5',
        deviceClass: 'mobile',
        fullSweep: true,
        visual: true,
        tlsPolicy: 'strict',
      },
      annotations: [{ type: 'audit-id', description: 'NAV-001' }],
      tags: [],
      results: [{
        status: 'failed',
        expectedStatus: 'passed',
        duration: 10,
        retry: 0,
        startedAt: '2026-08-24T12:00:00.000Z',
        errors: [],
        stdout: [],
        stderr: [],
        attachments: [{ name: 'candidate.png', contentType: 'image/png', body: Buffer.from('flag-image') }],
      }],
    }],
  });
  const initialDescriptor = await writeGalleryArchive({
    outputDir: checklist,
    catalog,
    exportedAt: '2026-08-24T12:00:00.000Z',
  });
  const initialArchivePage = await readFile(path.join(checklist, 'gallery.html'), 'utf8');
  const item = catalog.items[0];
  assert.ok(item);
  const initialFlags = await readGalleryFlagSnapshot(root);
  const opened = await mutateGalleryFlag(root, {
    action: 'open',
    itemId: item.id,
    identity: {
      testId: item.test.id,
      title: item.test.title,
      project: item.project.name,
      attempt: item.attempt.ordinal,
      auditIds: item.auditAssociations.map(({ id }) => id),
    },
    reviewer: 'Concurrency reviewer',
    note: 'This issue must survive a simultaneous report rebuild.',
    idempotencyKey: 'gallery-flags-self-test-open',
    expectedFlagRevision: initialFlags.flagRevision,
    timestamp: '2026-08-24T12:01:00.000Z',
    eventId: 'gfevent_1111111111111111',
    flagId: 'gflag_1111111111111111',
  });
  const [rebuild, resolution] = await Promise.all([
    writeGalleryArchive({
      outputDir: checklist,
      catalog,
      exportedAt: '2026-08-24T12:02:00.000Z',
    }),
    mutateGalleryFlag(root, {
      action: 'resolve',
      flagId: opened.event.flagId,
      reviewer: 'Concurrency reviewer',
      justification: 'The race completed and the issue was verified.',
      idempotencyKey: 'gallery-flags-self-test-resolve',
      expectedFlagRevision: opened.flagRevision,
      timestamp: '2026-08-24T12:03:00.000Z',
      eventId: 'gfevent_2222222222222222',
    }),
  ]);
  assert.ok(rebuild.exportRevision);
  const finalFlags = await readGalleryFlagSnapshot(root);
  assert.equal(finalFlags.throughEvent, 2);
  assert.equal(finalFlags.flags[0]?.state, 'resolved');
  assert.equal(finalFlags.flagRevision, resolution.flagRevision);
  const finalDescriptor = JSON.parse(await readFile(path.join(checklist, 'gallery', 'current.json'), 'utf8'));
  assert.equal(finalDescriptor.flagRevision, finalFlags.flagRevision);
  assert.match(await readFile(path.join(checklist, 'gallery.html'), 'utf8'), new RegExp(finalDescriptor.exportRevision));
  assert.match(initialArchivePage, new RegExp(initialDescriptor.exportRevision));
  const finalItemWrapper = await readFile(path.join(
    checklist,
    ...`${finalDescriptor.itemDetails.hrefPrefix}${encodeURIComponent(item.id)}${finalDescriptor.itemDetails.hrefSuffix}`.split('/'),
  ), 'utf8');
  const finalItemEncoded = finalItemWrapper.match(/data-gallery-payload="([A-Za-z0-9+/=]+)"/)?.[1];
  assert(finalItemEncoded);
  const finalItemPayload = JSON.parse(Buffer.from(finalItemEncoded, 'base64').toString('utf8'));
  assert.deepEqual(finalItemPayload.archiveDocument, {
    schemaVersion: 1,
    kind: 'detail',
    contentRevision: finalDescriptor.contentRevision,
    exportRevision: finalDescriptor.exportRevision,
  });
  assert.equal(await readFile(releasePath, 'utf8'), releaseTruth);
  await access(path.join(checklist, 'gallery', 'revisions', initialDescriptor.exportRevision));

  const events: GalleryFlagEvent[] = Array.from({ length: GALLERY_FLAG_MAX_EVENTS }, (_, index) => {
    const key = index.toString(16).padStart(16, '0');
    return {
      schemaVersion: 1,
      sequence: index + 1,
      eventId: `gfevent_${key}`,
      flagId: `gflag_${key}`,
      previousEventId: null,
      action: 'opened',
      itemId: 'gitem_0123456789abcdef',
      identity: { testId: 'quota-test' },
      reviewer: 'Quota reviewer',
      note: 'Bounded event',
      justification: null,
      timestamp: '2026-08-24T12:00:00.000Z',
      idempotencyKey: `quota-${key}`,
      requestFingerprint: key,
      expectedFlagRevision: 'flags_0000000000000000',
    };
  });
  const fullHistory: GalleryFlagHistory = { schemaVersion: 1, throughEvent: events.length, events };
  assert.throws(() => applyGalleryFlagTransition(fullHistory, {
    action: 'open',
    itemId: 'gitem_0123456789abcdef',
    identity: { testId: 'quota-test' },
    reviewer: 'Quota reviewer',
    note: 'This event is over quota.',
    idempotencyKey: 'quota-overflow',
    expectedFlagRevision: galleryFlagRevision(fullHistory),
    timestamp: '2026-08-24T12:05:00.000Z',
    eventId: 'gfevent_ffffffffffffffff',
    flagId: 'gflag_ffffffffffffffff',
  }), (error: unknown) => (
    error instanceof Error
    && 'statusCode' in error
    && error.statusCode === 413
  ));

  console.log('Gallery flag self-test passed: history, quotas, release invariance, and rebuild races are bounded.');
} finally {
  await rm(root, { recursive: true, force: true });
}
