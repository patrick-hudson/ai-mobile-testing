import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { serializeEvidencePolicy } from '../audit/evidence-policy.js';
import {
  applyVideoRetentionPlan,
  assessVideoMetrics,
  buildVideoRetentionPlan,
  probeVideoQuality,
  removeRejectedVideoAttachments,
  reportableAttachments,
} from './lib/video-retention.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-retention-'));
const raw = path.join(root, 'shards', 'shard-1-of-2', 'raw');
const blob = path.join(root, 'blob-reports', 'resources');
const html = path.join(root, 'playwright-html', 'data');
const checklist = path.join(root, 'checklist', 'evidence', 'SEARCH-001');
const manual = path.join(root, 'manual-evidence');
await Promise.all([raw, blob, html, checklist, manual].map((directory) => fs.mkdir(directory, { recursive: true })));

const keepBytes = Buffer.from('meaningful click and visible response');
const failedBytes = Buffer.from('failed interaction remains review evidence');
const skippedBytes = Buffer.from('blank skipped context');
const staticBytes = Buffer.from('static test should not record video');
const orphanBytes = Buffer.from('unmapped generated recording');
const collisionBytes = Buffer.from('identical bytes shared by eligible and rejected executions');

async function copies(name: string, bytes: Buffer): Promise<string> {
  const source = path.join(blob, `${name}.webm`);
  await Promise.all([
    fs.writeFile(source, bytes),
    fs.writeFile(path.join(raw, `${name}.webm`), bytes),
    fs.writeFile(path.join(html, `${name}.webm`), bytes),
    fs.writeFile(path.join(checklist, `${name}.webm`), bytes),
  ]);
  return source;
}

const keep = await copies('keep', keepBytes);
const failed = await copies('failed', failedBytes);
const skipped = await copies('skipped', skippedBytes);
const staticVideo = await copies('static', staticBytes);
const collisionEligible = path.join(raw, 'collision-eligible.webm');
const collisionSkipped = path.join(raw, 'collision-skipped.webm');
const collisionStatic = path.join(checklist, 'collision-static.webm');
const collisionBlob = path.join(blob, 'collision-shared.webm');
const collisionHtml = path.join(html, 'collision-shared.webm');
await Promise.all([
  collisionEligible,
  collisionSkipped,
  collisionStatic,
  collisionBlob,
  collisionHtml,
].map((file) => fs.writeFile(file, collisionBytes)));
await fs.writeFile(path.join(raw, 'orphan.webm'), orphanBytes);
await fs.writeFile(path.join(raw, 'skipped-poster.jpg'), Buffer.from('poster'));
const manualVideo = path.join(manual, 'reviewer-upload.webm');
await fs.writeFile(manualVideo, skippedBytes);
const manualChecklist = path.join(root, 'checklist', 'evidence', 'A11Y-003', 'manual-iphone-safari');
await fs.mkdir(manualChecklist, { recursive: true });
const manualChecklistVideo = path.join(manualChecklist, 'reviewer-upload.webm');
await fs.writeFile(manualChecklistVideo, skippedBytes);

const interaction = {
  type: 'audit-evidence-policy',
  description: serializeEvidencePolicy({
    mode: 'interaction-video',
    rationale: 'Click the control and retain its visible response.',
  }),
};
const staticPolicy = {
  type: 'audit-evidence-policy',
  description: serializeEvidencePolicy({
    mode: 'static-screenshot',
    rationale: 'Capture the rendered placement without motion.',
  }),
};
const video = (source: string) => ({ name: 'video', contentType: 'video/webm', path: source });
const report = {
  suites: [{
    specs: [
      { title: 'passing interaction', tests: [{ annotations: [interaction], results: [{ status: 'passed', attachments: [video(keep), video(skipped), video(collisionEligible)] }] }] },
      { title: 'failed interaction', tests: [{ annotations: [interaction], results: [{ status: 'failed', attachments: [video(failed)] }] }] },
      { title: 'skipped interaction', tests: [{ annotations: [interaction], results: [{ status: 'skipped', attachments: [video(skipped), video(collisionSkipped), video(collisionBlob)] }] }] },
      { title: 'static check', tests: [{ annotations: [staticPolicy], results: [{ status: 'passed', attachments: [video(staticVideo), video(collisionStatic), video(collisionHtml)] }] }] },
    ],
  }],
};
const resultsFile = path.join(root, 'results.json');
await fs.writeFile(resultsFile, JSON.stringify(report));

const plan = await buildVideoRetentionPlan(report, root, resultsFile, {
  probeVideo: (file) => file === skipped
    ? {
        path: file,
        durationSeconds: 1.2,
        sampledFrames: 3,
        maxFrameDifference: 0.4,
        usable: false,
        reasons: ['representative blank helper clip'],
      }
    : {
        path: file,
        durationSeconds: 8,
        sampledFrames: 12,
        maxFrameDifference: 7,
        usable: true,
        reasons: [],
      },
});
assert.equal(plan.eligibleExecutions, 2);
assert.equal(plan.rejectedExecutions, 2);
assert.equal(plan.skippedExecutions, 1);
assert.equal(plan.policyRejectedExecutions, 1);
assert.equal(plan.qualityRejectedClips, 1);
assert.equal([...plan.eligibleHashes].some((hash) => plan.rejectedHashes.has(hash)), true);
assert.equal(plan.eligiblePaths.has(collisionEligible), true);
assert.equal(plan.rejectedPaths.has(collisionSkipped), true);
assert.equal(plan.rejectedPaths.has(collisionStatic), true);
assert.deepEqual(plan.errors, []);

const removedAttachments = await removeRejectedVideoAttachments(report, plan, root, resultsFile);
assert.equal(removedAttachments, 7);
assert.equal(report.suites[0]?.specs[0]?.tests[0]?.results[0]?.attachments.length, 2);

const outcome = await applyVideoRetentionPlan(plan, root);
assert.equal(outcome.retained.filter(({ reason }) => reason === 'non-skipped interaction execution').length, 9);
assert.equal(outcome.retained.filter(({ reason }) => reason === 'shared content-addressed evidence required by an eligible interaction').length, 2);
assert.equal(outcome.pruned.length, 12);
for (const directory of [raw, blob, html, checklist]) {
  assert.equal(await fs.stat(path.join(directory, 'keep.webm')).then(() => true).catch(() => false), true);
  assert.equal(await fs.stat(path.join(directory, 'failed.webm')).then(() => true).catch(() => false), true);
  assert.equal(await fs.stat(path.join(directory, 'skipped.webm')).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(directory, 'static.webm')).then(() => true).catch(() => false), false);
}
assert.equal(await fs.stat(path.join(raw, 'orphan.webm')).then(() => true).catch(() => false), false);
assert.equal(await fs.stat(path.join(raw, 'skipped-poster.jpg')).then(() => true).catch(() => false), false);
assert.equal(await fs.stat(collisionEligible).then(() => true).catch(() => false), true);
assert.equal(await fs.stat(collisionSkipped).then(() => true).catch(() => false), false);
assert.equal(await fs.stat(collisionStatic).then(() => true).catch(() => false), false);
assert.equal(await fs.stat(collisionBlob).then(() => true).catch(() => false), true);
assert.equal(await fs.stat(collisionHtml).then(() => true).catch(() => false), true);
assert.equal(await fs.readFile(manualVideo, 'utf8'), skippedBytes.toString('utf8'));
assert.equal(await fs.readFile(manualChecklistVideo, 'utf8'), skippedBytes.toString('utf8'));

assert.deepEqual(
  reportableAttachments([video(skipped), { name: 'trace', contentType: 'application/zip' }], 'skipped', [interaction]),
  [{ name: 'trace', contentType: 'application/zip' }],
);
assert.deepEqual(reportableAttachments([video(staticVideo)], 'passed', [staticPolicy]), []);
assert.equal(reportableAttachments([video(failed)], 'failed', [interaction]).length, 1);

assert.equal(assessVideoMetrics({
  durationSeconds: 1.2,
  sampledFrames: 3,
  maxFrameDifference: 0.4,
}).usable, false);
assert.equal(assessVideoMetrics({
  durationSeconds: 4,
  sampledFrames: 8,
  maxFrameDifference: 6,
}).usable, true);

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
if (ffmpegAvailable) {
  const whiteVideo = path.join(root, 'short-white.webm');
  const actionVideo = path.join(root, 'representative-action.webm');
  const generateWhite = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=25',
    '-t', '1.2', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', whiteVideo,
  ], { encoding: 'utf8' });
  const generateAction = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=3',
    '-t', '3', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', actionVideo,
  ], { encoding: 'utf8' });
  assert.equal(generateWhite.status, 0, generateWhite.stderr);
  assert.equal(generateAction.status, 0, generateAction.stderr);
  const whiteAssessment = probeVideoQuality(whiteVideo, 'ffmpeg');
  const actionAssessment = probeVideoQuality(actionVideo, 'ffmpeg');
  assert.equal(whiteAssessment.usable, false, JSON.stringify(whiteAssessment));
  assert.equal(actionAssessment.usable, true, JSON.stringify(actionAssessment));
}

const missingReport = {
  suites: [{ specs: [{ title: 'missing interaction video', tests: [{ annotations: [interaction], results: [{ status: 'passed', attachments: [] }] }] }] }],
};
const missingPlan = await buildVideoRetentionPlan(missingReport, root, resultsFile);
assert.equal(missingPlan.errors.length, 1);
assert.match(missingPlan.errors[0] ?? '', /no video attachment was produced; no usable interaction video remains/);
const smokePlan = await buildVideoRetentionPlan(missingReport, root, resultsFile, {
  requireExecutedInteractionVideo: false,
});
assert.deepEqual(smokePlan.errors, []);

const helperOnlyReport = {
  suites: [{ specs: [{ title: 'helper-only interaction', tests: [{ annotations: [interaction], results: [{ status: 'passed', attachments: [video(skipped)] }] }] }] }],
};
await fs.writeFile(skipped, skippedBytes);
const helperOnlyPlan = await buildVideoRetentionPlan(helperOnlyReport, root, resultsFile, {
  probeVideo: (file) => ({
    path: file,
    durationSeconds: 1.2,
    sampledFrames: 3,
    maxFrameDifference: 0.4,
    usable: false,
    reasons: ['short, visually static helper page'],
  }),
});
assert.equal(helperOnlyPlan.qualityRejectedClips, 1);
assert.match(helperOnlyPlan.errors.at(-1) ?? '', /no usable interaction video remains/);

const diagnosticRoot = path.join(root, 'diagnostic-failure');
const diagnosticRaw = path.join(diagnosticRoot, 'raw');
await fs.mkdir(diagnosticRaw, { recursive: true });
const shortDynamicFailure = path.join(diagnosticRaw, 'short-dynamic-failure.webm');
const shortDynamicGeneratedCopy = path.join(diagnosticRaw, 'short-dynamic-generated-copy.webm');
const shortDynamicSkippedCollision = path.join(diagnosticRaw, 'short-dynamic-skipped-collision.webm');
const shortStaticHelper = path.join(diagnosticRaw, 'short-static-helper.webm');
const shortDynamicBytes = Buffer.from('short dynamic failed response');
await fs.writeFile(shortDynamicFailure, shortDynamicBytes);
await fs.writeFile(shortDynamicGeneratedCopy, shortDynamicBytes);
await fs.writeFile(shortDynamicSkippedCollision, shortDynamicBytes);
await fs.writeFile(shortStaticHelper, Buffer.from('short white helper page'));
const diagnosticResultsFile = path.join(diagnosticRoot, 'results.json');
const diagnosticReport = {
  suites: [{ specs: [{
    title: 'immediate failed interaction',
    tests: [{ annotations: [interaction], results: [{
      status: 'failed',
      attachments: [video(shortDynamicFailure), video(shortStaticHelper)],
    }, {
      status: 'skipped',
      attachments: [video(shortDynamicSkippedCollision)],
    }] }],
  }] }],
};
await fs.writeFile(diagnosticResultsFile, JSON.stringify(diagnosticReport));
const diagnosticPlan = await buildVideoRetentionPlan(diagnosticReport, diagnosticRoot, diagnosticResultsFile, {
  probeVideo: (file) => file === shortDynamicFailure
    ? {
        path: file,
        durationSeconds: 1.2,
        sampledFrames: 3,
        maxFrameDifference: 6,
        usable: false,
        reasons: ['duration 1.200s is below 2.0s'],
      }
    : {
        path: file,
        durationSeconds: 1.2,
        sampledFrames: 3,
        maxFrameDifference: 0.4,
        usable: false,
        reasons: ['duration 1.200s is below 2.0s', 'maximum frame change 0.400 is below 0.75'],
      },
});
assert.equal(diagnosticPlan.diagnosticRetainedClips, 1);
assert.equal(diagnosticPlan.qualityRejectedClips, 1);
assert.equal(diagnosticPlan.diagnosticPaths.has(shortDynamicFailure), true);
assert.equal(diagnosticPlan.rejectedPaths.has(shortStaticHelper), true);
assert.equal(diagnosticPlan.errors.length, 1, 'A diagnostic-only failure clip must not satisfy release evidence integrity.');
assert.match(diagnosticPlan.errors[0] ?? '', /retained only as diagnostic evidence/);
assert.equal(
  await removeRejectedVideoAttachments(diagnosticReport, diagnosticPlan, diagnosticRoot, diagnosticResultsFile),
  2,
);
const diagnosticOutcome = await applyVideoRetentionPlan(diagnosticPlan, diagnosticRoot);
assert.equal(await fs.stat(shortDynamicFailure).then(() => true).catch(() => false), true);
assert.equal(await fs.stat(shortDynamicGeneratedCopy).then(() => true).catch(() => false), true);
assert.equal(await fs.stat(shortDynamicSkippedCollision).then(() => true).catch(() => false), false);
assert.equal(await fs.stat(shortStaticHelper).then(() => true).catch(() => false), false);
assert.equal(diagnosticOutcome.retained.some(({ path: file, reason }) => (
  file === shortDynamicFailure && reason.includes('diagnostic evidence')
)), true);

await fs.rm(root, { recursive: true, force: true });
console.log('Video retention policy self-test passed.');
