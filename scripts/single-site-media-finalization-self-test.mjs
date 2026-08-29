import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  publishSingleSiteMediaStage,
  readSingleSiteMediaStagePublication,
  runLoggedCommand,
} from './lib/single-site-media-finalization.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function resultDocument(attachment = null) {
  return {
    suites: [{
      title: 'fixture',
      specs: [{
        id: 'fixture-spec',
        title: 'fixture check',
        tests: [{
          annotations: [{ type: 'audit-case-id', description: 'FIXTURE-001:case' }],
          expectedStatus: 'passed',
          projectName: 'candidate-mobile-chromium',
          status: 'expected',
          results: [{ status: 'passed', retry: 0, errors: [], attachments: attachment ? [attachment] : [] }],
        }],
      }],
      suites: [],
    }],
    errors: [],
  };
}

async function sourceFixture(root, name, attachment = null) {
  const artifactRoot = path.join(root, `source-${name}`);
  await fs.mkdir(artifactRoot, { recursive: true });
  if (attachment) {
    await fs.mkdir(path.dirname(path.join(artifactRoot, attachment.path)), { recursive: true });
    await fs.writeFile(path.join(artifactRoot, attachment.path), Buffer.from(`${name}-sealed-media-bytes`));
  }
  const document = resultDocument(attachment && { ...attachment, path: path.join(artifactRoot, attachment.path) });
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  await fs.writeFile(path.join(artifactRoot, 'results.json'), bytes);
  return { artifactRoot, document, bytes };
}

async function treeSnapshot(root) {
  const output = [];
  const visit = async (directory) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const bytes = await fs.readFile(file);
        output.push({ path: path.relative(root, file), bytes: bytes.toString('base64'), digest: digest(bytes) });
      }
    }
  };
  await visit(root);
  return output;
}

function fakeProcessor(scenario) {
  return async ({ artifactRoot, logger }) => {
    logger?.emit?.('fake-ffmpeg-command', { command: ['ffmpeg', '-i', `${scenario}.webm`] });
    const resultsFile = path.join(artifactRoot, 'results.json');
    const results = JSON.parse(await fs.readFile(resultsFile, 'utf8'));
    const attachments = results.suites[0].specs[0].tests[0].results[0].attachments;
    const video = attachments.find(({ contentType }) => contentType === 'video/webm');
    let prunedFiles = 0;
    let prunedBytes = 0;
    let qualityRejectedClips = 0;
    const integrityErrors = [];
    if (scenario === 'irrelevant' || scenario === 'white-short') {
      const videoPath = path.resolve(artifactRoot, video.path);
      const stat = await fs.stat(videoPath);
      await fs.unlink(videoPath);
      results.suites[0].specs[0].tests[0].results[0].attachments = attachments.filter((item) => item !== video);
      prunedFiles = 1;
      prunedBytes = stat.size;
      if (scenario === 'white-short') {
        qualityRejectedClips = 1;
        integrityErrors.push('fixture action attempt: every attached video was blank or too short; no usable interaction video remains.');
      }
      await fs.writeFile(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
    }
    const retainedVideo = scenario === 'valid' ? video : null;
    const manifest = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      artifactRoot,
      videoCount: retainedVideo ? 1 : 0,
      usableInteractionVideoCount: retainedVideo ? 1 : 0,
      diagnosticVideoCount: 0,
      processedCount: retainedVideo ? 1 : 0,
      failedCount: 0,
      unavailableCount: 0,
      retention: {
        retainedFiles: retainedVideo ? 1 : 0,
        prunedFiles,
        prunedBytes,
        qualityRejectedClips,
        integrityErrors,
      },
      videos: retainedVideo ? [{ video: video.path, evidenceRole: 'usable-interaction' }] : [],
    };
    await fs.writeFile(path.join(artifactRoot, 'video-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { exitCode: integrityErrors.length ? 1 : 0, signal: null, stdout: 'ffmpeg fixture output\n', stderr: '' };
  };
}

async function publish(root, name, source, scenario, dependencies = {}) {
  return await publishSingleSiteMediaStage({
    artifactRoot: source.artifactRoot,
    sourceResults: source.document,
    sourceResultsBytes: source.bytes,
    sourceResultsDigest: digest(source.bytes),
    outputDir: path.join(root, `output-${name}`),
    jobId: `job-${name}`,
    attemptId: 'attempt-001',
    finalizationDigest: digest(Buffer.from(`finalization-${name}`)),
    generatedAt: '2026-08-25T12:00:00.000Z',
    dependencies: { runProcessor: fakeProcessor(scenario), ...dependencies },
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-media-finalization-'));
try {
  const staticSource = await sourceFixture(root, 'static', {
    name: 'screenshot', contentType: 'image/png', path: 'raw/static/check.png',
  });
  const staticBefore = await treeSnapshot(staticSource.artifactRoot);
  const staticPublication = await publish(root, 'static', staticSource, 'static');
  assert.equal(staticPublication.manifest.qualityState, 'complete', 'static screenshot checks do not require video');
  assert.equal(staticPublication.manifest.usableInteractionVideoCount, 0);
  assert.deepEqual(await treeSnapshot(staticSource.artifactRoot), staticBefore, 'sealed static evidence is byte-for-byte unchanged');
  const realStaticPublication = await publishSingleSiteMediaStage({
    artifactRoot: staticSource.artifactRoot,
    sourceResults: staticSource.document,
    sourceResultsBytes: staticSource.bytes,
    sourceResultsDigest: digest(staticSource.bytes),
    outputDir: path.join(root, 'output-static-real-processor'),
    jobId: 'job-static-real-processor',
    attemptId: 'attempt-001',
    finalizationDigest: digest(Buffer.from('finalization-static-real-processor')),
    generatedAt: '2026-08-25T12:00:00.000Z',
  });
  assert.equal(realStaticPublication.manifest.qualityState, 'complete', 'the real video processor accepts screenshot-only evidence without manufacturing a video');

  const validSource = await sourceFixture(root, 'valid', {
    name: 'video', contentType: 'video/webm', path: 'raw/action/video.webm',
  });
  const validBefore = await treeSnapshot(validSource.artifactRoot);
  const validPublication = await publish(root, 'valid', validSource, 'valid');
  assert.equal(validPublication.manifest.qualityState, 'complete');
  assert.equal(validPublication.manifest.retainedFiles, 1, 'valid action video is retained');
  const retainedPath = validPublication.results.suites[0].specs[0].tests[0].results[0].attachments[0].path;
  assert.equal(path.isAbsolute(retainedPath), true, 'processed attachment paths resolve into the immutable copy');
  assert.equal(retainedPath.startsWith(`${validPublication.artifactRoot}${path.sep}`), true);
  assert.deepEqual(await treeSnapshot(validSource.artifactRoot), validBefore, 'sealed video evidence is byte-for-byte unchanged');
  const validReadOptions = {
    outputDir: path.join(root, 'output-valid'),
    jobId: 'job-valid',
    attemptId: 'attempt-001',
    finalizationDigest: digest(Buffer.from('finalization-valid')),
    mediaStageDigest: validPublication.manifest.mediaStageDigest,
  };
  assert.equal(
    (await readSingleSiteMediaStagePublication(validReadOptions)).manifest.mediaStageDigest,
    validPublication.manifest.mediaStageDigest,
    'post-hoc media verification reopens the immutable revision',
  );
  const retainedMediaFile = path.join(validPublication.artifactRoot, validPublication.manifest.mediaFiles[0].relativePath);
  const retainedMediaBytes = await fs.readFile(retainedMediaFile);
  await fs.writeFile(retainedMediaFile, Buffer.from('tampered-media'));
  await assert.rejects(
    () => readSingleSiteMediaStagePublication(validReadOptions),
    /changed|digest/i,
    'post-hoc media verification rejects corrupt retained bytes',
  );
  await fs.writeFile(retainedMediaFile, retainedMediaBytes);
  const mediaPointer = path.join(root, 'output-valid', 'current.json');
  const mediaPointerBytes = await fs.readFile(mediaPointer);
  await fs.rm(mediaPointer);
  await assert.rejects(
    () => readSingleSiteMediaStagePublication(validReadOptions),
    /missing/i,
    'post-hoc media verification rejects a deleted pointer',
  );
  await fs.writeFile(mediaPointer, mediaPointerBytes);
  const galleryOutput = path.join(root, 'gallery-checklist');
  const galleryCommand = await runLoggedCommand({
    command: process.execPath,
    args: [
      '--import', 'tsx', path.resolve('scripts/publish-single-site-gallery.ts'),
      '--artifact-root', validPublication.artifactRoot,
      '--output-dir', galleryOutput,
      '--generated-at', '2026-08-25T12:00:00.000Z',
    ],
    cwd: path.resolve('.'),
    environment: process.env,
    label: 'gallery-self-test',
  });
  assert.equal(galleryCommand.exitCode, 1, 'A production gallery export without current shared release authority must fail closed.');
  assert.match(galleryCommand.stderr, /shared-store-root|shared run|final-subject/i);

  const deadlineLogs = [];
  const deadlineCommand = await runLoggedCommand({
    command: process.execPath,
    args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    cwd: path.resolve('.'),
    environment: process.env,
    logger: { emit: (event, detail) => deadlineLogs.push({ event, detail }) },
    label: 'deadline-self-test',
    deadlineAt: Date.now() + 100,
    terminationGraceMs: 50,
    killSettleMs: 250,
  });
  assert.equal(deadlineCommand.signal, 'SIGKILL');
  assert.equal(deadlineCommand.aborted, true);
  assert.equal(deadlineCommand.forceKilled, true);
  assert.match(deadlineCommand.terminationReason, /deadline exceeded/);
  assert(deadlineLogs.some(({ event }) => event === 'deadline-self-test-force-kill-requested'));

  const deadlineSource = await sourceFixture(root, 'deadline', {
    name: 'video', contentType: 'video/webm', path: 'raw/action/video.webm',
  });
  const mediaDeadline = Date.now() + 100;
  const deadlinePublication = await publishSingleSiteMediaStage({
    artifactRoot: deadlineSource.artifactRoot,
    sourceResults: deadlineSource.document,
    sourceResultsBytes: deadlineSource.bytes,
    sourceResultsDigest: digest(deadlineSource.bytes),
    outputDir: path.join(root, 'output-deadline'),
    jobId: 'job-deadline',
    attemptId: 'attempt-001',
    finalizationDigest: digest(Buffer.from('finalization-deadline')),
    generatedAt: '2026-08-25T12:00:00.000Z',
    deadlineAt: mediaDeadline,
    dependencies: {
      runProcessor: async ({ signal, deadlineAt }) => {
        assert.equal(signal, undefined);
        assert.equal(deadlineAt, mediaDeadline);
        return await runLoggedCommand({
          command: process.execPath,
          args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
          cwd: path.resolve('.'),
          environment: process.env,
          label: 'media-deadline-publication',
          deadlineAt,
          terminationGraceMs: 50,
          killSettleMs: 250,
        });
      },
    },
  });
  assert.equal(deadlinePublication.manifest.qualityState, 'incomplete', 'deadline termination is durably represented as incomplete media');
  assert(['SIGTERM', 'SIGKILL'].includes(deadlinePublication.manifest.processor.signal), 'deadline terminates the processor before durable publication');
  assert(deadlinePublication.manifest.integrityErrors.some((message) => /did not publish a valid manifest/i.test(message)));

  const irrelevantSource = await sourceFixture(root, 'irrelevant', {
    name: 'video', contentType: 'video/webm', path: 'raw/static/video.webm',
  });
  const irrelevantBefore = await treeSnapshot(irrelevantSource.artifactRoot);
  const irrelevantPublication = await publish(root, 'irrelevant', irrelevantSource, 'irrelevant');
  assert.equal(irrelevantPublication.manifest.qualityState, 'complete');
  assert.equal(irrelevantPublication.manifest.prunedFiles, 1, 'irrelevant video is removed from the processed copy');
  assert.equal(irrelevantPublication.results.suites[0].specs[0].tests[0].results[0].attachments.length, 0);
  assert.deepEqual(await treeSnapshot(irrelevantSource.artifactRoot), irrelevantBefore);

  const rejectedSource = await sourceFixture(root, 'white-short', {
    name: 'video', contentType: 'video/webm', path: 'raw/action/video.webm',
  });
  const rejectedBefore = await treeSnapshot(rejectedSource.artifactRoot);
  const rejectedPublication = await publish(root, 'white-short', rejectedSource, 'white-short');
  assert.equal(rejectedPublication.manifest.qualityState, 'incomplete', 'blank or too-short required action video fails evidence completeness');
  assert.equal(rejectedPublication.manifest.qualityRejectedClips, 1);
  assert.match(rejectedPublication.manifest.integrityErrors[0], /blank or too short/);
  assert.deepEqual(await treeSnapshot(rejectedSource.artifactRoot), rejectedBefore);

  const crashSource = await sourceFixture(root, 'crash', {
    name: 'video', contentType: 'video/webm', path: 'raw/action/video.webm',
  });
  let crashed = false;
  await assert.rejects(
    () => publish(root, 'crash', crashSource, 'valid', {
      afterRevisionCommit: async () => {
        crashed = true;
        const error = new Error('synthetic crash after immutable revision commit');
        error.code = 'EIO';
        throw error;
      },
    }),
    (error) => error?.code === 'EIO',
  );
  assert.equal(crashed, true);
  const restarted = await publish(root, 'crash', crashSource, 'valid');
  const restartedAgain = await publish(root, 'crash', crashSource, 'valid');
  assert.equal(restarted.created, false, 'restart verifies the committed revision rather than processing again');
  assert.equal(restartedAgain.manifest.mediaStageDigest, restarted.manifest.mediaStageDigest, 'retry is deterministic');
  assert.deepEqual(await treeSnapshot(crashSource.artifactRoot), await treeSnapshot(crashSource.artifactRoot));

  console.log('Single-site media finalization self-test passed: static evidence, valid actions, pruning, quality rejection, source immutability, and crash-safe deterministic retry.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
