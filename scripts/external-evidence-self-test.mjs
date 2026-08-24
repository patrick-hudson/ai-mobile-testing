import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateExternalTerminalEvidence } from '../portal/external-evidence.mjs';
import { validatePreferredMediaManifest } from '../portal/video-manifest.mjs';

const root = await fs.mkdtemp(join(tmpdir(), 'external-evidence-'));
const runId = 'external-evidence-run';
const finishedAt = new Date().toISOString();
const release = {
  decision: 'NOT_READY',
  ready: false,
  reason: 'Synthetic blocking result.',
  decisionBasis: 'External evidence mutation self-test.',
  blockingFailures: 1,
  blockingIncomplete: 0,
  baselineIssues: 0,
  runIntegrityFailure: false,
};
const videoBytes = Buffer.from('retained interaction video bytes');
const videoPath = join(root, 'raw', 'interaction.webm');
const posterBytes = Buffer.from('retained interaction poster bytes');
const posterPath = join(root, 'raw', 'interaction-poster.jpg');

try {
  await fs.mkdir(join(root, 'checklist', 'data'), { recursive: true });
  await fs.mkdir(join(root, 'raw'), { recursive: true });
  await Promise.all([
    fs.writeFile(join(root, 'results.json'), '{}\n'),
    fs.writeFile(join(root, 'checklist', 'index.html'), '<!doctype html><title>Checklist</title>'),
    fs.writeFile(join(root, 'checklist', 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, generatedAt: finishedAt, release })}\n`),
    fs.writeFile(videoPath, videoBytes),
    fs.writeFile(posterPath, posterBytes),
  ]);
  const publicationRevision = '0123456789abcdef0123456789abcdef';
  const publicationDocuments = new Map([
    ['summary.json', `${JSON.stringify({ schemaVersion: 1, publicationRevision, generatedAt: finishedAt, release, summary: { total: 1 } })}\n`],
    ['audits.json', `${JSON.stringify({ schemaVersion: 1, publicationRevision, generatedAt: finishedAt, items: [{ id: 'ENV-001' }] })}\n`],
    ['audits/ENV-001.json', `${JSON.stringify({ schemaVersion: 1, publicationRevision, generatedAt: finishedAt, id: 'ENV-001' })}\n`],
  ]);
  const publication = {
    schemaVersion: 1,
    publicationRevision,
    generatedAt: finishedAt,
    files: Object.fromEntries([...publicationDocuments].map(([path, source]) => [path, {
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
    }])),
  };
  const publicationDirectory = join(root, 'checklist', 'data', 'revisions', publicationRevision);
  await fs.mkdir(join(publicationDirectory, 'audits'), { recursive: true });
  await Promise.all([...publicationDocuments].map(([path, source]) => fs.writeFile(join(publicationDirectory, path), source)));
  const publicationSource = `${JSON.stringify(publication)}\n`;
  await Promise.all([
    fs.writeFile(join(publicationDirectory, 'publication.json'), publicationSource),
    fs.writeFile(join(root, 'checklist', 'data', 'current.json'), publicationSource),
  ]);
  const videoManifest = {
    schemaVersion: 2,
    videoCount: 1,
    processedCount: 1,
    usableInteractionVideoCount: 1,
    diagnosticVideoCount: 0,
    failedCount: 0,
    unavailableCount: 0,
    retention: { integrityErrors: [] },
    videos: [{
      video: 'raw/interaction.webm',
      bytes: videoBytes.length,
      sha256: createHash('sha256').update(videoBytes).digest('hex'),
      evidenceRole: 'usable-interaction',
      poster: 'raw/interaction-poster.jpg',
      posterBytes: posterBytes.length,
      processingStatus: 'created',
    }],
  };
  await fs.writeFile(join(root, 'video-manifest.json'), `${JSON.stringify(videoManifest)}\n`);

  const command = (exitCode = 0) => ({ finishedAt, exitCode, signal: null });
  const lifecycle = {
    schemaVersion: 2,
    runId,
    shardTotal: 2,
    build: command(),
    shards: [{ index: 1, ...command() }, { index: 2, ...command(1) }],
    performance: command(),
    merge: command(1),
    mergePipeline: { status: 'completed', completed: true },
    pipeline: { status: 'completed', completed: true, finishedAt },
    release,
    status: 'not-ready',
  };
  const validate = (document = lifecycle) => validateExternalTerminalEvidence({
    runDirectory: root,
    expectedRunId: runId,
    lifecycle: document,
    source: 'sharded-run.json',
  });

  assert.deepEqual((await validate()).problems, []);
  assert.match((await validate({ ...lifecycle, runId: 'copied-run-id' })).problems.join('; '), /runId/);
  assert.match((await validate({ ...lifecycle, schemaVersion: 1 })).problems.join('; '), /schemaVersion/);
  assert.match((await validate({ ...lifecycle, shards: lifecycle.shards.slice(0, 1) })).problems.join('; '), /exactly shardTotal/);
  assert.match((await validate({
    ...lifecycle,
    shards: [{ index: 1, ...command() }, { index: 1, ...command() }],
  })).problems.join('; '), /exactly once/);

  await fs.rename(join(root, 'results.json'), join(root, 'results.missing'));
  assert.match((await validate()).problems.join('; '), /results\.json.*missing/);
  await fs.rename(join(root, 'results.missing'), join(root, 'results.json'));

  await fs.writeFile(join(root, 'checklist', 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: finishedAt,
    release: { ...release, reason: 'Different checklist decision context.' },
  })}\n`);
  assert.match((await validate()).problems.join('; '), /lifecycle release disagrees/);
  await fs.writeFile(join(root, 'checklist', 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, generatedAt: finishedAt, release })}\n`);

  const publishedDetail = join(publicationDirectory, 'audits', 'ENV-001.json');
  const originalDetail = await fs.readFile(publishedDetail);
  await fs.writeFile(publishedDetail, `${originalDetail.toString('utf8').trim()} `);
  assert.match((await validate()).problems.join('; '), /compact report publication.*byte count|digest/i);
  await fs.writeFile(publishedDetail, originalDetail);

  const validatedMedia = await validatePreferredMediaManifest(root);
  assert.deepEqual(validatedMedia.errors, []);
  assert.equal(validatedMedia.records.get('raw/interaction.webm')?.evidenceRole, 'usable-interaction');
  for (const count of [
    'videoCount',
    'processedCount',
    'failedCount',
    'unavailableCount',
    'usableInteractionVideoCount',
    'diagnosticVideoCount',
  ]) {
    const omitted = structuredClone(videoManifest);
    delete omitted[count];
    await fs.writeFile(join(root, 'video-manifest.json'), `${JSON.stringify(omitted)}\n`);
    assert.match(
      (await validatePreferredMediaManifest(root)).errors.join('; '),
      new RegExp(`${count} must be a non-negative safe integer`),
      `Omitting ${count} must invalidate schema-v2 media evidence.`,
    );
  }
  await fs.writeFile(join(root, 'video-manifest.json'), `${JSON.stringify(videoManifest)}\n`);
  await fs.writeFile(join(root, 'video-manifest.json'), `${JSON.stringify({
    ...videoManifest,
    failedCount: 1,
    videos: [{ ...videoManifest.videos[0], processingStatus: 'failed' }],
  })}\n`);
  const failedMedia = await validatePreferredMediaManifest(root);
  assert.match(failedMedia.errors.join('; '), /failedCount|not completed media evidence/);
  assert.equal(failedMedia.paths.includes('raw/interaction.webm'), false);
  await fs.writeFile(join(root, 'video-manifest.json'), `${JSON.stringify(videoManifest)}\n`);
  await fs.writeFile(videoPath, Buffer.from('replaced interaction video bytes!'));
  const corruptedMedia = await validatePreferredMediaManifest(root);
  assert.match(corruptedMedia.errors.join('; '), /byte count does not match|SHA-256 does not match/);
  assert.equal(corruptedMedia.paths.includes('raw/interaction.webm'), false);
  assert.match((await validate()).problems.join('; '), /video-manifest\.json/);

  process.stdout.write('External evidence self-test passed: lifecycle identity, shard coverage, required artifacts, checklist consistency, retained-video provenance, and media digests all fail closed under mutation.\n');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
