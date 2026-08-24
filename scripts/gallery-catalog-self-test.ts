import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AuditDefinition } from '../audit/types.js';
import {
  buildGalleryCatalog,
  prepareGalleryArchive,
  publishPreparedGalleryArchive,
  writeGalleryArchive,
} from '../reporters/gallery-model.js';
import type {
  GalleryArchiveDescriptor,
  GalleryCaptureMetadata,
  GalleryCatalog,
  GalleryItem,
  GalleryQueryIndexRow,
} from '../shared/gallery-contract.mjs';
import {
  assertGalleryArchiveDescriptor,
  assertGalleryItemDetail,
  assertGalleryQueryRow,
  galleryItemHref,
  queryGalleryArchiveRows,
} from '../shared/gallery-contract.mjs';
import {
  buildAuditModels,
  type ReportAttachmentInput,
  type ReportResultInput,
  type ReportTestInput,
} from '../reporters/report-model.js';

const CAPTURE_METADATA_TYPE = 'application/vnd.quitting7oh.gallery-capture+json';
const timestamp = '2026-08-24T12:34:56.000Z';

const definitions: AuditDefinition[] = [
  definition('NAV-001', 'navigation', 'Navigation response', 'Navigation retains the expected focus and route.'),
  definition('VISUAL-001', 'content', 'Visual comparison', 'The redesign matches its accepted visual intent.'),
];

function definition(
  id: string,
  area: AuditDefinition['area'],
  title: string,
  expected: string,
): AuditDefinition {
  return {
    id,
    area,
    title,
    userPromise: expected,
    severity: 'P1',
    releaseBlocking: true,
    expected,
    evidence: ['screenshot'],
    evidencePolicy: {
      mode: 'static-screenshot',
      rationale: `Capture evidence for ${title}.`,
    },
  };
}

function captureMetadata(
  attachmentName: string,
  attachmentOccurrence: number,
  metadata: Omit<GalleryCaptureMetadata, 'schemaVersion' | 'attachmentName' | 'attachmentOccurrence'>,
): ReportAttachmentInput {
  return {
    name: `gallery-capture-metadata-${attachmentName}-${attachmentOccurrence}`,
    contentType: CAPTURE_METADATA_TYPE,
    body: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      attachmentName,
      attachmentOccurrence,
      ...metadata,
    } satisfies GalleryCaptureMetadata)),
  };
}

function result(
  attachments: ReportAttachmentInput[],
  overrides: Partial<Omit<ReportResultInput, 'attachments'>> = {},
): ReportResultInput {
  return {
    status: 'passed',
    expectedStatus: 'passed',
    duration: 10,
    retry: 0,
    startedAt: timestamp,
    errors: [],
    attachments,
    stdout: [],
    stderr: [],
    ...overrides,
  };
}

function reportTest(
  id: string,
  title: string,
  results: ReportResultInput[],
  options: {
    auditIds?: string[];
    projectName?: string;
    shardOrdinal?: number;
    file?: string;
  } = {},
): ReportTestInput {
  const auditIds = options.auditIds ?? ['VISUAL-001'];
  return {
    id,
    title,
    titlePath: ['gallery catalog self-test', title],
    file: options.file ?? 'scripts/gallery-catalog-self-test.ts',
    line: 1,
    column: 1,
    projectName: options.projectName ?? 'candidate-mobile-chromium',
    projectMetadata: {
      environment: 'candidate',
      browserLabel: 'Chromium / Pixel 5',
      deviceClass: 'mobile',
      fullSweep: true,
      visual: true,
      tlsPolicy: 'strict',
    },
    ...(options.shardOrdinal == null ? {} : { sourceShard: { ordinal: options.shardOrdinal, total: 8 } }),
    annotations: auditIds.map((auditId) => ({ type: 'audit-id', description: auditId })),
    results,
  };
}

function image(name: string, filePath: string): ReportAttachmentInput {
  return { name, contentType: 'image/png', path: filePath };
}

function video(
  name: string,
  filePath: string,
  validationStatus?: 'accepted' | 'rejected' | 'pending',
): ReportAttachmentInput {
  return {
    name,
    contentType: 'video/webm',
    path: filePath,
    ...(validationStatus ? { mediaValidation: validationStatus } : {}),
  };
}

function itemByTitle(catalog: GalleryCatalog, title: string): GalleryItem {
  const item = catalog.items.find((candidate) => candidate.test.title === title);
  assert(item, `Expected a gallery item for ${title}.`);
  return item;
}

function archivePath(outputDir: string, href: string): string {
  return path.join(outputDir, ...href.split('/'));
}

function decodeArchiveWrapper<T>(source: string): T {
  const encoded = source.match(/data-gallery-payload="([A-Za-z0-9+/=]+)"/)?.[1];
  assert(encoded, 'Expected an iframe-loadable base64 gallery payload.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as T;
}

async function readWrapper<T>(outputDir: string, href: string): Promise<T> {
  return decodeArchiveWrapper<T>(await readFile(archivePath(outputDir, href), 'utf8'));
}

async function assertDescriptorReferencesExist(outputDir: string, descriptor: GalleryArchiveDescriptor): Promise<void> {
  await Promise.all([
    descriptor.flags.href,
    descriptor.integrity.href,
    ...descriptor.query.chunks.map(({ href }) => href),
    ...descriptor.raw.chunks.map(({ href }) => href),
  ].map((href) => access(archivePath(outputDir, href))));
}

const root = await mkdtemp(path.join(tmpdir(), 'gallery-catalog-self-test-'));
try {
  const mediaDir = path.join(root, 'media');
  await mkdir(mediaDir, { recursive: true });
  const files = {
    sharedA: path.join(mediaDir, 'shared-a.png'),
    sharedB: path.join(mediaDir, 'shared-b.png'),
    sharedC: path.join(mediaDir, 'shared-c.png'),
    sameBytes: path.join(mediaDir, 'same-bytes.png'),
    repeatA: path.join(mediaDir, 'repeat-a.png'),
    repeatB: path.join(mediaDir, 'repeat-b.png'),
    baseline: path.join(mediaDir, 'baseline.png'),
    actual: path.join(mediaDir, 'actual.png'),
    diff: path.join(mediaDir, 'diff.png'),
    ambiguousA: path.join(mediaDir, 'ambiguous-a.png'),
    ambiguousB: path.join(mediaDir, 'ambiguous-b.png'),
    acceptedVideo: path.join(mediaDir, 'interaction.webm'),
    rejectedVideo: path.join(mediaDir, 'helper.webm'),
    pendingVideo: path.join(mediaDir, 'pending.webm'),
  };
  await Promise.all([
    writeFile(files.sharedA, 'one logical screenshot'),
    writeFile(files.sharedB, 'one logical screenshot'),
    writeFile(files.sharedC, 'one logical screenshot'),
    writeFile(files.sameBytes, 'identical bytes across tests'),
    writeFile(files.repeatA, 'first repeated name'),
    writeFile(files.repeatB, 'second repeated name'),
    writeFile(files.baseline, 'baseline'),
    writeFile(files.actual, 'actual'),
    writeFile(files.diff, 'diff'),
    writeFile(files.ambiguousA, 'ambiguous one'),
    writeFile(files.ambiguousB, 'ambiguous two'),
    writeFile(files.acceptedVideo, 'accepted interaction video'),
    writeFile(files.rejectedVideo, 'rejected helper video'),
    writeFile(files.pendingVideo, 'pending interaction video'),
  ]);
  await writeFile(path.join(mediaDir, 'interaction-poster.jpg'), 'video poster');

  const sharedMetadata = {
    attachmentKey: 'home-light',
    capturedAt: timestamp,
    route: 'https://user:password@beta.example.test/path/to/page?token=secret&lang=en#private-fragment',
    observedState: 'The candidate home page is visible in the light theme.',
    rationale: 'Verify the redesigned home page layout in the light theme.',
  } as const;
  const tests: ReportTestInput[] = [
    reportTest('storage-copies', 'storage copies collapse', [result([
      image('home-light', files.sharedA),
      captureMetadata('home-light', 0, sharedMetadata),
      image('home-light', files.sharedB),
      captureMetadata('home-light', 1, sharedMetadata),
      image('home-light', files.sharedC),
      captureMetadata('home-light', 2, sharedMetadata),
    ])], { auditIds: ['VISUAL-001', 'NAV-001'], file: path.join(root, 'private-source', 'catalog.spec.ts') }),
    reportTest('same-bytes-a', 'same bytes first test', [result([image('same', files.sameBytes)])]),
    reportTest('same-bytes-b', 'same bytes second test', [result([image('same', files.sameBytes)])]),
    reportTest('repeated-names', 'repeated names remain distinct', [result([
      image('repeated', files.repeatA),
      image('repeated', files.repeatB),
    ])]),
    reportTest('conflicting-keys', 'conflicting producer keys remain distinct', [result([
      image('collision', files.repeatA),
      captureMetadata('collision', 0, { attachmentKey: 'producer-collision' }),
      image('collision', files.repeatB),
      captureMetadata('collision', 1, { attachmentKey: 'producer-collision' }),
    ])]),
    reportTest('retry-test', 'retries remain distinct', [
      result([image('retry', files.repeatA)], { status: 'failed', retry: 0 }),
      result([image('retry', files.repeatA)], { retry: 1 }),
    ]),
    reportTest('comparison', 'complete comparison', [result([
      image('baseline', files.baseline),
      captureMetadata('baseline', 0, { attachmentKey: 'baseline', comparisonGroup: 'home', memberRole: 'baseline' }),
      image('actual', files.actual),
      captureMetadata('actual', 0, { attachmentKey: 'actual', comparisonGroup: 'home', memberRole: 'actual' }),
      image('diff', files.diff),
      captureMetadata('diff', 0, { attachmentKey: 'diff', comparisonGroup: 'home', memberRole: 'diff' }),
    ])]),
    reportTest('ambiguous-comparison', 'ambiguous comparison stays navigable', [result([
      image('actual-copy', files.ambiguousA),
      captureMetadata('actual-copy', 0, { attachmentKey: 'actual-1', comparisonGroup: 'ambiguous', memberRole: 'actual' }),
      image('actual-copy', files.ambiguousB),
      captureMetadata('actual-copy', 1, { attachmentKey: 'actual-2', comparisonGroup: 'ambiguous', memberRole: 'actual' }),
    ])]),
    reportTest('videos', 'posters and rejected videos stay out of counts', [result([
      video('interaction', files.acceptedVideo, 'accepted'),
      image('interaction poster', path.join(mediaDir, 'interaction-poster.jpg')),
      video('helper', files.rejectedVideo, 'rejected'),
      video('pending', files.pendingVideo, 'pending'),
    ])]),
    reportTest('missing-context', 'missing capture context remains null', [result([
      image('no-context', files.repeatA),
    ])]),
    reportTest('missing-media', 'unavailable media remains navigable', [result([
      image('unavailable', path.join(mediaDir, 'does-not-exist.png')),
    ])]),
  ];

  const catalog = await buildGalleryCatalog({
    outputDir: path.join(root, 'checklist'),
    tests,
    definitionCatalog: definitions,
  });

  const copies = itemByTitle(catalog, 'storage copies collapse');
  assert.equal(catalog.items.filter((item) => item.test.title === 'storage copies collapse').length, 1);
  assert.equal(copies.members.length, 1);
  assert.equal(catalog.blobs.filter((blob) => blob.id === copies.members[0]?.blobId).length, 1);
  assert.equal(catalog.blobs.find((blob) => blob.id === copies.members[0]?.blobId)?.storageLocations.length, 4);
  assert.deepEqual(copies.auditAssociations.map(({ id }) => id).sort(), ['NAV-001', 'VISUAL-001']);
  assert.equal(copies.capture.route, '/path/to/page?lang&token');
  assert.doesNotMatch(JSON.stringify(copies), /user|password|secret|private-fragment/);

  const sameBytesItems = catalog.items.filter((item) => item.test.title.startsWith('same bytes'));
  assert.equal(sameBytesItems.length, 2);
  assert.notEqual(sameBytesItems[0]?.id, sameBytesItems[1]?.id);
  assert.equal(sameBytesItems[0]?.members[0]?.blobId, sameBytesItems[1]?.members[0]?.blobId);

  const repeated = catalog.items.filter((item) => item.test.title === 'repeated names remain distinct');
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0]?.id, repeated[1]?.id);

  const conflicting = catalog.items.filter((item) => item.test.title === 'conflicting producer keys remain distinct');
  assert.equal(conflicting.length, 2);
  assert.notEqual(conflicting[0]?.id, conflicting[1]?.id);

  const retries = catalog.items.filter((item) => item.test.title === 'retries remain distinct');
  assert.equal(retries.length, 2);
  assert.notEqual(retries[0]?.id, retries[1]?.id);
  assert.deepEqual(retries.map((item) => item.attempt.retry).sort(), [0, 1]);

  const comparison = itemByTitle(catalog, 'complete comparison');
  assert.equal(comparison.comparison?.complete, true);
  assert.deepEqual(comparison.members.map(({ role }) => role).sort(), ['actual', 'baseline', 'diff']);

  const ambiguous = catalog.items.filter((item) => item.test.title === 'ambiguous comparison stays navigable');
  assert.equal(ambiguous.length, 2);
  assert(ambiguous.every((item) => item.comparison === null));
  assert(ambiguous.every((item) => item.members[0]?.role === 'actual'));

  const videos = catalog.items.filter((item) => item.kind === 'video');
  assert.equal(videos.length, 1);
  assert.equal(catalog.items.some((item) => item.kind === 'image' && /poster/i.test(item.members[0]?.name ?? '')), false);
  assert(videos[0]?.members[0]?.poster);

  const missing = itemByTitle(catalog, 'missing capture context remains null');
  assert.equal(missing.capture.route, null);
  assert.equal(missing.capture.viewport, null);
  assert.equal(missing.capture.capturedAt, null);
  assert.equal(missing.capture.provenance, 'missing');

  const unavailable = itemByTitle(catalog, 'unavailable media remains navigable');
  assert.equal(unavailable.members[0]?.available, false);
  assert.equal(unavailable.members[0]?.blobId, null);
  assert.match(unavailable.members[0]?.error ?? '', /ENOENT/);

  const shardOne = await buildGalleryCatalog({
    outputDir: path.join(root, 'shard-one'),
    tests: [reportTest('shard-stable', 'shard-stable item', [result([image('stable', files.repeatA)])], { shardOrdinal: 1 })],
    definitionCatalog: definitions,
  });
  const shardSeven = await buildGalleryCatalog({
    outputDir: path.join(root, 'shard-seven'),
    tests: [reportTest('shard-stable', 'shard-stable item', [result([image('stable', files.repeatA)])], { shardOrdinal: 7 })],
    definitionCatalog: definitions,
  });
  assert.equal(shardOne.items[0]?.id, shardSeven.items[0]?.id);
  assert.notDeepEqual(shardOne.items[0]?.provenance.sourceShard, shardSeven.items[0]?.provenance.sourceShard);

  assert.equal(catalog.primaryCounts.images, catalog.items.filter(({ kind }) => kind === 'image').length);
  assert.equal(catalog.primaryCounts.videos, 1);
  assert.equal(catalog.primaryCounts.total, catalog.items.length);

  const reportModels = await buildAuditModels({
    outputDir: path.join(root, 'report-integration'),
    tests: [tests[0]!],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: definitions,
  });
  assert.equal(reportModels.galleryCatalog.items.length, 1);
  const visualHref = reportModels.manifest.audits.find(({ id }) => id === 'VISUAL-001')?.executions[0]?.artifacts[0]?.href;
  const navigationHref = reportModels.manifest.audits.find(({ id }) => id === 'NAV-001')?.executions[0]?.artifacts[0]?.href;
  assert.equal(visualHref, navigationHref);
  assert.match(visualHref ?? '', /^evidence\/source\//);

  const archiveOutput = path.join(root, 'archive-contract');
  const firstDescriptor = await writeGalleryArchive({
    outputDir: archiveOutput,
    catalog,
    exportedAt: timestamp,
    maxRowsPerChunk: 2,
    flagSnapshot: {
      schemaVersion: 1,
      throughEvent: 1,
      flags: [{ itemId: unavailable.id, state: 'open' }],
    },
  });
  assert.equal(firstDescriptor.schemaVersion, 1);
  assert.equal(assertGalleryArchiveDescriptor(firstDescriptor), firstDescriptor);
  assert.equal(firstDescriptor.phase, 'sealed');
  assert.equal(firstDescriptor.primaryCounts.total, catalog.primaryCounts.total);
  assert.equal((await stat(path.join(archiveOutput, 'gallery', 'current.json'))).size <= 256 * 1024, true);
  await assertDescriptorReferencesExist(archiveOutput, firstDescriptor);
  const archivePageAtFirstExport = await readFile(path.join(archiveOutput, 'gallery.html'), 'utf8');
  assert.match(archivePageAtFirstExport, /Visual Evidence Gallery/);
  assert.match(archivePageAtFirstExport, /Read-only snapshot/);
  assert.match(archivePageAtFirstExport, new RegExp(firstDescriptor.exportRevision));
  assert.doesNotMatch(archivePageAtFirstExport, /audit-manifest|manifest\.json/);
  assert.equal(
    await readFile(path.join(archiveOutput, 'assets', 'gallery-core.js'), 'utf8'),
    await readFile(path.join(process.cwd(), 'portal', 'public', 'gallery-core.js'), 'utf8'),
    'Archive gallery core must be the exact shared portal core.',
  );
  assert.equal(
    await readFile(path.join(archiveOutput, 'assets', 'gallery.css'), 'utf8'),
    await readFile(path.join(process.cwd(), 'portal', 'public', 'gallery.css'), 'utf8'),
    'Archive gallery CSS must be the exact shared portal CSS.',
  );

  const queryRows: GalleryQueryIndexRow[] = [];
  for (const chunk of firstDescriptor.query.chunks) {
    const details = await stat(archivePath(archiveOutput, chunk.href));
    assert(details.size <= 256 * 1024, `Query wrapper ${chunk.href} exceeded the 256 KiB cap.`);
    const wrapperSource = await readFile(archivePath(archiveOutput, chunk.href), 'utf8');
    assert.match(wrapperSource, /location\.hash\.slice\(1\)/);
    assert.match(wrapperSource, /quitting7oh-gallery-archive-v1/);
    assert.match(wrapperSource, /if\(!token\)return/);
    const payload = decodeArchiveWrapper<{
      rows: GalleryQueryIndexRow[];
      archiveDocument: { kind: string; contentRevision: string; exportRevision: string };
    }>(wrapperSource);
    assert.deepEqual(payload.archiveDocument, {
      schemaVersion: 1,
      kind: 'query',
      contentRevision: firstDescriptor.contentRevision,
      exportRevision: firstDescriptor.exportRevision,
    });
    assert(payload.rows.length <= 2);
    assert.equal(payload.rows.length, chunk.rows);
    queryRows.push(...payload.rows);
  }
  assert.equal(queryRows.length, catalog.items.length);
  assert.equal(new Set(queryRows.map(({ id }) => id)).size, catalog.items.length);
  assert(queryRows.every((row) => assertGalleryQueryRow(row) === row));
  const copiesRow = queryRows.find(({ id }) => id === copies.id);
  assert(copiesRow);
  assert.match(copiesRow.testGroupId, /^gtest_[a-f0-9]{16}$/);
  assert.equal(copiesRow.projectName, copies.project.name);
  assert.deepEqual(copiesRow.testTitlePath, copies.test.titlePath);
  assert.equal(copiesRow.primaryAuditCatalogOrdinal, 0);
  assert.equal(copiesRow.primaryFeatureSuite, 'navigation');
  assert.equal(copiesRow.featureSuites[0], 'content');
  assert.throws(() => assertGalleryQueryRow({ ...copiesRow, testGroupId: 'title-is-not-an-identity' }), /test-group/i);
  assert.doesNotMatch(JSON.stringify(queryRows), /"(?:storageLocations|poster|sourcePath)"|evidence\/[^" ]+\.(?:webm|png)/);
  assert.doesNotMatch(JSON.stringify(queryRows), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const videosOnly = queryGalleryArchiveRows(queryRows, { kinds: ['video'] });
  assert.deepEqual(videosOnly.map(({ id }) => id), catalog.items.filter(({ kind }) => kind === 'video').map(({ id }) => id));
  const crossChunkSearch = queryGalleryArchiveRows(queryRows, { search: 'same bytes', sort: 'audit' });
  assert.deepEqual(crossChunkSearch.map(({ id }) => id), sameBytesItems.map(({ id }) => id).sort());

  const videoDetailHref = galleryItemHref(firstDescriptor, videos[0]!.id);
  const videoDetail = await readWrapper<{ item: GalleryItem; media: unknown[] }>(archiveOutput, videoDetailHref);
  assert.equal(assertGalleryItemDetail(videoDetail), videoDetail);
  assert.equal(videoDetail.item.members[0]?.poster?.contentType, 'image/jpeg');
  assert.equal(videoDetail.item.members.length, 1);
  const copiesDetail = await readWrapper<{ item: GalleryItem }>(
    archiveOutput,
    galleryItemHref(firstDescriptor, copies.id),
  );
  assert.equal(copiesDetail.item.test.file, 'catalog.spec.ts');
  assert.doesNotMatch(JSON.stringify(copiesDetail), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const unavailableDetail = await readWrapper<{ item: GalleryItem; availability: { state: string } }>(
    archiveOutput,
    galleryItemHref(firstDescriptor, unavailable.id),
  );
  assert.equal(unavailableDetail.availability.state, 'tombstone');
  assert.equal(unavailableDetail.item.test.title, 'unavailable media remains navigable');

  const rawDocuments = await Promise.all(firstDescriptor.raw.chunks.map(({ href }) =>
    readWrapper<{ rows: Array<{ storageCopyCount: number; href: string | null }> }>(archiveOutput, href)));
  assert(rawDocuments.flatMap(({ rows }) => rows).some(({ storageCopyCount }) => storageCopyCount > 1));
  assert(rawDocuments.flatMap(({ rows }) => rows).every(({ href }) => href === null || !path.isAbsolute(href)));

  const firstUsableBytes = (await stat(path.join(archiveOutput, 'gallery', 'current.json'))).size
    + (await stat(archivePath(archiveOutput, firstDescriptor.query.chunks[0]!.href))).size
    + (await stat(archivePath(archiveOutput, galleryItemHref(firstDescriptor, catalog.items[0]!.id)))).size;
  assert(firstUsableBytes <= 1024 * 1024);

  const interrupted = await prepareGalleryArchive({
    outputDir: archiveOutput,
    catalog,
    exportedAt: '2026-08-24T12:35:56.000Z',
    maxRowsPerChunk: 2,
  });
  await unlink(path.join(interrupted.stagingDir, 'query', 'chunk-0001.html'));
  await assert.rejects(publishPreparedGalleryArchive(interrupted), /missing|integrity/i);
  const headAfterInterrupted = JSON.parse(await readFile(path.join(archiveOutput, 'gallery', 'current.json'), 'utf8')) as GalleryArchiveDescriptor;
  assert.equal(headAfterInterrupted.exportRevision, firstDescriptor.exportRevision);

  const secondDescriptor = await writeGalleryArchive({
    outputDir: archiveOutput,
    catalog,
    exportedAt: '2026-08-24T12:36:56.000Z',
    maxRowsPerChunk: 2,
  });
  assert.notEqual(secondDescriptor.exportRevision, firstDescriptor.exportRevision);
  assert.equal(secondDescriptor.contentRevision, firstDescriptor.contentRevision);
  assert.equal(secondDescriptor.flagRevision, firstDescriptor.flagRevision);
  await assertDescriptorReferencesExist(archiveOutput, firstDescriptor);
  await assertDescriptorReferencesExist(archiveOutput, secondDescriptor);

  const thirdDescriptor = await writeGalleryArchive({
    outputDir: archiveOutput,
    catalog,
    exportedAt: '2026-08-24T12:37:26.000Z',
    maxRowsPerChunk: 2,
    flagSnapshot: {
      schemaVersion: 1,
      throughEvent: 2,
      flags: [{ itemId: unavailable.id, state: 'resolved' }],
    },
  });
  assert.equal(thirdDescriptor.contentRevision, firstDescriptor.contentRevision);
  assert.notEqual(thirdDescriptor.flagRevision, firstDescriptor.flagRevision);
  assert.notEqual(thirdDescriptor.orderRevision, firstDescriptor.orderRevision);
  await assertDescriptorReferencesExist(archiveOutput, thirdDescriptor);
  assert.match(await readFile(path.join(archiveOutput, 'gallery.html'), 'utf8'), new RegExp(thirdDescriptor.exportRevision));
  assert.match(archivePageAtFirstExport, new RegExp(firstDescriptor.exportRevision));

  const competingA = await prepareGalleryArchive({
    outputDir: archiveOutput,
    catalog,
    exportedAt: '2026-08-24T12:37:56.000Z',
    maxRowsPerChunk: 2,
  });
  const competingB = await prepareGalleryArchive({
    outputDir: archiveOutput,
    catalog,
    exportedAt: '2026-08-24T12:38:56.000Z',
    maxRowsPerChunk: 2,
  });
  const competingResults = await Promise.allSettled([
    publishPreparedGalleryArchive(competingA),
    publishPreparedGalleryArchive(competingB),
  ]);
  assert.equal(competingResults.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(competingResults.filter(({ status }) => status === 'rejected').length, 1);
  const winningDescriptor = JSON.parse(await readFile(path.join(archiveOutput, 'gallery', 'current.json'), 'utf8')) as GalleryArchiveDescriptor;
  assert.match(await readFile(path.join(archiveOutput, 'gallery.html'), 'utf8'), new RegExp(winningDescriptor.exportRevision));
  assert.equal((await readdir(path.join(archiveOutput, 'gallery'))).some((name) => name.startsWith('.surface-')), false);
  await assertDescriptorReferencesExist(archiveOutput, firstDescriptor);
  await assertDescriptorReferencesExist(archiveOutput, secondDescriptor);
  await assertDescriptorReferencesExist(archiveOutput, thirdDescriptor);
  console.log('Gallery catalog self-test passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
