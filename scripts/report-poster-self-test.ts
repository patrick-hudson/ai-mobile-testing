import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AuditDefinition } from '../audit/types.js';
import { AUDIT_EVIDENCE_POLICY_ANNOTATION, serializeEvidencePolicy } from '../audit/evidence-policy.js';
import { writeAuditReport, type ReportTestInput } from '../reporters/report-model.js';
import { galleryItemHref, type GalleryArchiveDescriptor, type GalleryQueryIndexRow } from '../shared/gallery-contract.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'audit-poster-self-test-'));
try {
  const videoWithPoster = path.join(root, 'with-poster.webm');
  const sourcePoster = path.join(root, 'with-poster-poster.jpg');
  const videoWithoutPoster = path.join(root, 'without-poster.webm');
  const mergedVideo = path.join(root, 'blob-resource.webm');
  const fallbackPoster = path.join(root, 'raw', 'original-video-poster.jpg');
  const mergedVideoBody = Buffer.from('synthetic merged video with checksum-matched poster');
  await mkdir(path.dirname(fallbackPoster), { recursive: true });
  await Promise.all([
    writeFile(videoWithPoster, Buffer.from('synthetic video with poster')),
    writeFile(sourcePoster, Buffer.from('synthetic jpeg poster')),
    writeFile(videoWithoutPoster, Buffer.from('synthetic video without poster')),
    writeFile(mergedVideo, mergedVideoBody),
    writeFile(fallbackPoster, Buffer.from('synthetic checksum-matched jpeg poster')),
  ]);
  await writeFile(path.join(root, 'video-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    videos: [{
      video: 'raw/original-video.webm',
      sha256: createHash('sha256').update(mergedVideoBody).digest('hex'),
      poster: 'raw/original-video-poster.jpg',
    }],
  }));

  const definition: AuditDefinition = {
    id: 'VIDEO-001',
    area: 'reliability',
    title: 'Video poster report self-test',
    userPromise: 'Recorded evidence has a reviewable preview when FFmpeg produced one.',
    severity: 'P2',
    releaseBlocking: false,
    expected: 'The report copies and links the generated poster without requiring one.',
    evidence: ['video'],
    evidencePolicy: {
      mode: 'interaction-video',
      rationale: 'Exercise the synthetic action and verify its response video receives the correct poster.',
    },
  };
  const tests: ReportTestInput[] = [{
    id: 'video-poster-self-test',
    title: '[VIDEO-001] materializes optional video posters',
    titlePath: ['report self-tests', 'video poster'],
    file: 'scripts/report-poster-self-test.ts',
    projectName: 'candidate-self-test',
    projectMetadata: {
      environment: 'candidate',
      browserLabel: 'synthetic',
      deviceClass: 'desktop',
      fullSweep: false,
      visual: true,
      tlsPolicy: 'strict',
    },
    annotations: [
      { type: 'audit-id', description: definition.id },
      { type: AUDIT_EVIDENCE_POLICY_ANNOTATION, description: serializeEvidencePolicy(definition.evidencePolicy) },
    ],
    results: [{
      status: 'passed',
      expectedStatus: 'passed',
      duration: 1,
      retry: 0,
      errors: [],
      attachments: [
        { name: 'video-with-poster', contentType: 'video/webm', path: videoWithPoster },
        { name: 'video-without-poster', contentType: 'video/webm', path: videoWithoutPoster },
        { name: 'merged-video', contentType: 'video/webm', path: mergedVideo },
      ],
      stdout: [],
      stderr: [],
    }],
  }];

  const outputDir = path.join(root, 'checklist');
  const manifest = await writeAuditReport({
    outputDir,
    tests,
    run: { status: 'passed', source: 'playwright-json', profile: 'smoke' },
    definitionCatalog: [definition],
  });
  const artifacts = manifest.audits[0]?.executions[0]?.artifacts ?? [];
  const withPoster = artifacts.find(({ name }) => name === 'video-with-poster');
  const withoutPoster = artifacts.find(({ name }) => name === 'video-without-poster');
  const mergedWithPoster = artifacts.find(({ name }) => name === 'merged-video');

  assert.equal(withPoster?.available, true);
  assert.equal(withPoster?.poster?.contentType, 'image/jpeg');
  assert.equal(withPoster?.poster?.sourcePath, sourcePoster);
  assert.match(withPoster?.poster?.href ?? '', /01-with-poster-poster\.jpg$/);
  assert.equal(withPoster?.poster?.sizeBytes, Buffer.byteLength('synthetic jpeg poster'));
  assert.match(withPoster?.poster?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(outputDir, withPoster!.poster!.href), 'utf8'), 'synthetic jpeg poster');

  assert.equal(withoutPoster?.available, true);
  assert.equal(withoutPoster?.poster, undefined);
  assert.equal(withoutPoster?.posterError, undefined);
  assert.equal(mergedWithPoster?.available, true);
  assert.equal(mergedWithPoster?.poster?.sourcePath, fallbackPoster);
  assert.match(mergedWithPoster?.poster?.href ?? '', /03-blob-resource-poster\.jpg$/);
  assert.equal(manifest.summary.videos, 3);
  assert.equal(manifest.summary.posters, 2);
  assert.equal(manifest.summary.artifacts, 5);

  const reportScript = await readFile(path.join(outputDir, 'assets', 'report.js'), 'utf8');
  assert.match(reportScript, /poster=/);
  assert.match(reportScript, /Open video poster/);

  const portalSummaryPath = path.join(outputDir, 'data', 'summary.json');
  const portalIndexPath = path.join(outputDir, 'data', 'audits.json');
  const portalDetailPath = path.join(outputDir, 'data', 'audits', 'VIDEO-001.json');
  const [portalSummary, portalIndex, portalDetail] = await Promise.all([
    readFile(portalSummaryPath, 'utf8').then((value) => JSON.parse(value)),
    readFile(portalIndexPath, 'utf8').then((value) => JSON.parse(value)),
    readFile(portalDetailPath, 'utf8').then((value) => JSON.parse(value)),
  ]);
  assert.equal(portalSummary.schemaVersion, 1);
  assert.equal(portalSummary.summary.videos, 3);
  assert.equal(portalIndex.items.length, 1);
  assert.deepEqual(portalIndex.items[0].environments, ['candidate']);
  assert.equal(portalIndex.items[0].evidenceCounts.video, 3);
  assert.equal(portalDetail.executionCount, 1);
  assert.equal(portalDetail.executions[0].artifacts[0].poster.contentType, 'image/jpeg');
  assert.equal('sourcePath' in portalDetail.executions[0].artifacts[0], false);
  assert.equal((await stat(portalSummaryPath)).size < 256 * 1024, true);
  assert.equal((await stat(portalIndexPath)).size < 2 * 1024 * 1024, true);
  assert.equal((await stat(portalDetailPath)).size < 512 * 1024, true);

  const galleryDescriptor = JSON.parse(
    await readFile(path.join(outputDir, 'gallery', 'current.json'), 'utf8'),
  ) as GalleryArchiveDescriptor;
  const galleryRows = (await Promise.all(galleryDescriptor.query.chunks.map(async ({ href }) => {
    const wrapper = await readFile(path.join(outputDir, ...href.split('/')), 'utf8');
    const encoded = wrapper.match(/data-gallery-payload="([A-Za-z0-9+/=]+)"/)?.[1];
    assert(encoded);
    return (JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { rows: GalleryQueryIndexRow[] }).rows;
  }))).flat();
  assert.equal(galleryRows.length, 3);
  assert.equal(galleryRows.every(({ kind }) => kind === 'video'), true);
  assert.equal(galleryRows.some(({ title }) => /poster/i.test(title)), true);
  assert.equal(galleryDescriptor.primaryCounts.images, 0);
  assert.equal(galleryDescriptor.primaryCounts.videos, 3);
  const galleryDetails = await Promise.all(galleryRows.map(async ({ id }) => {
    const wrapper = await readFile(path.join(outputDir, ...galleryItemHref(galleryDescriptor, id).split('/')), 'utf8');
    const encoded = wrapper.match(/data-gallery-payload="([A-Za-z0-9+/=]+)"/)?.[1];
    assert(encoded);
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
      item: { members: Array<{ poster: { contentType: string } | null }> };
    };
  }));
  assert.equal(galleryDetails.filter(({ item }) => item.members[0]?.poster?.contentType === 'image/jpeg').length, 2);
  const reportIndex = await readFile(path.join(outputDir, 'index.html'), 'utf8');
  assert.equal(reportIndex.includes('gallery-archive-head'), true);
  assert.match(reportIndex, /href="gallery\.html"[^>]*>Open Visual Gallery/);
  console.log('Report poster self-test passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
