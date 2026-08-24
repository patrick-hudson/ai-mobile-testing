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
  MIN_WINDOW_NONBLANK_RATIO,
  normalizeLeadingBlankVideoAsync,
  probeVideoQuality,
  recommendedLeadingBlankTrimSeconds,
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
        changedFrames: 0,
        postContentChangedFrames: 0,
        blankFrameRatio: 1,
        initialNonBlankRatio: 0,
        finalNonBlankRatio: 0,
        leadingBlankSeconds: null,
        usable: false,
        reasons: ['representative blank helper clip'],
      }
    : {
        path: file,
        durationSeconds: 8,
        sampledFrames: 12,
        maxFrameDifference: 7,
        changedFrames: 3,
        postContentChangedFrames: 3,
        blankFrameRatio: 0,
        initialNonBlankRatio: 1,
        finalNonBlankRatio: 1,
        leadingBlankSeconds: 0,
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
  changedFrames: 0,
  postContentChangedFrames: 0,
  blankFrameRatio: 1,
  initialNonBlankRatio: 0,
  finalNonBlankRatio: 0,
  leadingBlankSeconds: null,
}).usable, false);
assert.equal(assessVideoMetrics({
  durationSeconds: 4,
  sampledFrames: 8,
  maxFrameDifference: 6,
  changedFrames: 1,
  postContentChangedFrames: 1,
  blankFrameRatio: 0,
  initialNonBlankRatio: 1,
  finalNonBlankRatio: 1,
  leadingBlankSeconds: 0,
}).usable, true);
assert.deepEqual(
  assessVideoMetrics({
    durationSeconds: 4,
    sampledFrames: 8,
    maxFrameDifference: 6,
    changedFrames: 1,
    postContentChangedFrames: 0,
    blankFrameRatio: 0,
    initialNonBlankRatio: 1,
    finalNonBlankRatio: 1,
    leadingBlankSeconds: 0,
  }),
  { usable: false, reasons: ['no visual response was measured after the page content settled'] },
  'A page-load transition without a subsequent visual response is not interaction evidence.',
);

const leadingBlankAssessment = {
  path: path.join(root, 'leading-blank.webm'),
  durationSeconds: 6,
  sampledFrames: 24,
  maxFrameDifference: 12,
  changedFrames: 4,
  postContentChangedFrames: 2,
  blankFrameRatio: 0.5,
  initialNonBlankRatio: 0,
  finalNonBlankRatio: 1,
  leadingBlankSeconds: 3,
  usable: false,
  reasons: ['the initial-state window does not contain sustained page content'],
};
assert.equal(recommendedLeadingBlankTrimSeconds(leadingBlankAssessment), 2.5);
assert.equal(recommendedLeadingBlankTrimSeconds({
  ...leadingBlankAssessment,
  blankFrameRatio: 0.75,
}), null, 'A mostly blank clip must not be laundered by trimming.');
assert.equal(recommendedLeadingBlankTrimSeconds({
  ...leadingBlankAssessment,
  postContentChangedFrames: 0,
}), null, 'A delayed first paint without a later action must not be laundered into interaction evidence.');
assert.equal(recommendedLeadingBlankTrimSeconds({
  ...leadingBlankAssessment,
  finalNonBlankRatio: 0,
  reasons: ['the initial-state window does not contain sustained page content', 'the final-response window does not contain sustained page content'],
}), null, 'A clip ending blank must not be normalized into release evidence.');

const normalizationRoot = path.join(root, 'normalization-plan');
await fs.mkdir(path.join(normalizationRoot, 'normalized-videos'), { recursive: true });
const normalizationSource = path.join(normalizationRoot, 'leading-original.webm');
const normalizationTarget = path.join(normalizationRoot, 'normalized-videos', 'normalized.webm');
await fs.writeFile(normalizationSource, Buffer.from('leading blank original'));
await fs.writeFile(normalizationTarget, Buffer.from('normalized visible action'));
const normalizationReport = {
  suites: [{ specs: [{
    title: 'leading blank interaction',
    tests: [{ annotations: [interaction], results: [{ status: 'passed', attachments: [video(normalizationSource)] }] }],
  }] }],
};
const normalizationResults = path.join(normalizationRoot, 'results.json');
await fs.writeFile(normalizationResults, JSON.stringify(normalizationReport));
const normalizedPlan = await buildVideoRetentionPlan(normalizationReport, normalizationRoot, normalizationResults, {
  probeVideo: () => leadingBlankAssessment,
  normalizeVideo: () => ({
    originalPath: normalizationSource,
    normalizedPath: normalizationTarget,
    trimStartSeconds: 2.5,
    originalDurationSeconds: 6,
    normalizedDurationSeconds: 3.5,
    originalAssessment: leadingBlankAssessment,
    assessment: {
      ...leadingBlankAssessment,
      path: normalizationTarget,
      durationSeconds: 3.5,
      blankFrameRatio: 0,
      initialNonBlankRatio: 1,
      leadingBlankSeconds: 0,
      usable: true,
      reasons: [],
    },
  }),
});
assert.equal(normalizedPlan.normalizations.length, 1);
assert.equal(normalizedPlan.qualityRejectedClips, 0);
assert.deepEqual(normalizedPlan.errors, []);
assert.equal(
  normalizationReport.suites[0]?.specs[0]?.tests[0]?.results[0]?.attachments[0]?.path,
  path.join('normalized-videos', 'normalized.webm'),
  'The canonical results attachment must point at the normalized derivative, not a mutated content-addressed blob.',
);
const symlinkNormalizationRoot = path.join(root, 'normalization-symlink-root');
const symlinkNormalizationOutside = path.join(root, 'normalization-symlink-outside');
await Promise.all([
  fs.mkdir(symlinkNormalizationRoot, { recursive: true }),
  fs.mkdir(symlinkNormalizationOutside, { recursive: true }),
]);
const symlinkNormalizationSource = path.join(symlinkNormalizationRoot, 'source.webm');
await fs.writeFile(symlinkNormalizationSource, Buffer.from('source'));
await fs.symlink(symlinkNormalizationOutside, path.join(symlinkNormalizationRoot, 'normalized-videos'), 'dir');
await assert.rejects(
  normalizeLeadingBlankVideoAsync(
    symlinkNormalizationSource,
    { ...leadingBlankAssessment, path: symlinkNormalizationSource },
    symlinkNormalizationRoot,
    'ffmpeg-is-never-spawned',
  ),
  /output must be a regular directory/,
  'A generated run must not redirect normalized evidence through a symbolic-link directory.',
);

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
if (ffmpegAvailable) {
  const whiteVideo = path.join(root, 'short-white.webm');
  const actionVideo = path.join(root, 'representative-action.webm');
  const transientOverlayVideo = path.join(root, 'transient-overlay-then-white.webm');
  const transientDarkOverlayVideo = path.join(root, 'transient-overlay-then-black.webm');
  const lowMotionActionVideo = path.join(root, 'low-motion-action.webm');
  const leadingBlankActionVideo = path.join(root, 'leading-blank-then-action.webm');
  const actionThenBlankVideo = path.join(root, 'action-then-blank.webm');
  const longActionThenBlankVideo = path.join(root, 'long-action-then-blank.webm');
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
  const generateTransientOverlay = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', "color=c=white:s=320x240:r=25:d=4,drawbox=x=80:y=80:w=160:h=80:color=red:t=fill:enable='between(t,0.2,0.5)'",
    '-t', '4', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', transientOverlayVideo,
  ], { encoding: 'utf8' });
  const generateTransientDarkOverlay = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', "color=c=black:s=320x240:r=25:d=4,drawbox=x=80:y=80:w=160:h=80:color=red:t=fill:enable='between(t,0.2,0.5)'",
    '-t', '4', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', transientDarkOverlayVideo,
  ], { encoding: 'utf8' });
  const generateLowMotionAction = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', "color=c=gray:s=320x240:r=25:d=4,drawbox=x=80:y=80:w=160:h=80:color=red:t=fill:enable='lt(t,2)',drawbox=x=80:y=80:w=160:h=80:color=blue:t=fill:enable='gte(t,2)'",
    '-t', '4', '-an', '-c:v', 'libvpx', '-deadline', 'realtime', lowMotionActionVideo,
  ], { encoding: 'utf8' });
  const generateLeadingBlankAction = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=25:d=3',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=3',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-an', '-c:v', 'libvpx', '-deadline', 'realtime', leadingBlankActionVideo,
  ], { encoding: 'utf8' });
  const generateActionThenBlank = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=3',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x240:r=25:d=3',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-an', '-c:v', 'libvpx', '-deadline', 'realtime', actionThenBlankVideo,
  ], { encoding: 'utf8' });
  const generateLongActionThenBlank = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=1:d=61',
    '-f', 'lavfi', '-i', 'color=c=white:s=160x120:r=1:d=15',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
    '-an', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', longActionThenBlankVideo,
  ], { encoding: 'utf8' });
  assert.equal(generateWhite.status, 0, generateWhite.stderr);
  assert.equal(generateAction.status, 0, generateAction.stderr);
  assert.equal(generateTransientOverlay.status, 0, generateTransientOverlay.stderr);
  assert.equal(generateTransientDarkOverlay.status, 0, generateTransientDarkOverlay.stderr);
  assert.equal(generateLowMotionAction.status, 0, generateLowMotionAction.stderr);
  assert.equal(generateLeadingBlankAction.status, 0, generateLeadingBlankAction.stderr);
  assert.equal(generateActionThenBlank.status, 0, generateActionThenBlank.stderr);
  assert.equal(generateLongActionThenBlank.status, 0, generateLongActionThenBlank.stderr);
  const whiteAssessment = probeVideoQuality(whiteVideo, 'ffmpeg');
  const actionAssessment = probeVideoQuality(actionVideo, 'ffmpeg');
  const transientOverlayAssessment = probeVideoQuality(transientOverlayVideo, 'ffmpeg');
  const transientDarkOverlayAssessment = probeVideoQuality(transientDarkOverlayVideo, 'ffmpeg');
  const lowMotionActionAssessment = probeVideoQuality(lowMotionActionVideo, 'ffmpeg');
  const leadingBlankActionAssessment = probeVideoQuality(leadingBlankActionVideo, 'ffmpeg');
  const actionThenBlankAssessment = probeVideoQuality(actionThenBlankVideo, 'ffmpeg');
  const longActionThenBlankAssessment = probeVideoQuality(longActionThenBlankVideo, 'ffmpeg');
  assert.equal(whiteAssessment.usable, false, JSON.stringify(whiteAssessment));
  assert.equal(actionAssessment.usable, true, JSON.stringify(actionAssessment));
  assert.equal(
    transientOverlayAssessment.usable,
    false,
    `A brief overlay must not make a mostly white clip reviewable: ${JSON.stringify(transientOverlayAssessment)}`,
  );
  assert.equal(
    transientDarkOverlayAssessment.usable,
    false,
    `A brief overlay must not make a mostly black clip reviewable: ${JSON.stringify(transientDarkOverlayAssessment)}`,
  );
  assert.equal(
    lowMotionActionAssessment.usable,
    true,
    `One legitimate visible state transition must survive the white-video gate: ${JSON.stringify(lowMotionActionAssessment)}`,
  );
  assert.equal(leadingBlankActionAssessment.usable, false, JSON.stringify(leadingBlankActionAssessment));
  assert.ok(recommendedLeadingBlankTrimSeconds(leadingBlankActionAssessment) !== null,
    `A real action after a harmless leading capture gap should be normalizable: ${JSON.stringify(leadingBlankActionAssessment)}`);
  const normalizedLeadingBlank = await normalizeLeadingBlankVideoAsync(
    leadingBlankActionVideo,
    leadingBlankActionAssessment,
    root,
    'ffmpeg',
  );
  assert.equal(normalizedLeadingBlank?.assessment.usable, true, JSON.stringify(normalizedLeadingBlank));
  assert.equal(recommendedLeadingBlankTrimSeconds(actionThenBlankAssessment), null,
    'A video whose final response is blank must remain rejected.');
  assert.equal(longActionThenBlankAssessment.usable, false,
    `A video that becomes blank after the first 60 seconds must be rejected: ${JSON.stringify(longActionThenBlankAssessment)}`);
  assert.ok((longActionThenBlankAssessment.finalNonBlankRatio ?? 1) < MIN_WINDOW_NONBLANK_RATIO,
    'The final-response metric must include the actual video tail, not only the first 60 seconds.');
  assert.equal(recommendedLeadingBlankTrimSeconds(whiteAssessment), null,
    'An all-white video must remain rejected.');
}

const missingReport = {
  suites: [{ specs: [{ title: 'missing interaction video', tests: [{ annotations: [interaction], results: [{ status: 'passed', attachments: [] }] }] }] }],
};
const missingPlan = await buildVideoRetentionPlan(missingReport, root, resultsFile);
assert.equal(missingPlan.errors.length, 1);
assert.match(missingPlan.errors[0] ?? '', /no video attachment was produced; no usable interaction video remains/);
const smokePlan = await buildVideoRetentionPlan(missingReport, root, resultsFile);
assert.equal(smokePlan.errors.length, 1, 'Smoke interactions must retain the same usable action evidence as release runs.');

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
    changedFrames: 0,
    postContentChangedFrames: 0,
    blankFrameRatio: 1,
    initialNonBlankRatio: 0,
    finalNonBlankRatio: 0,
    leadingBlankSeconds: null,
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
        changedFrames: 1,
        postContentChangedFrames: 1,
        blankFrameRatio: 0,
        initialNonBlankRatio: 1,
        finalNonBlankRatio: 1,
        leadingBlankSeconds: 0,
        usable: false,
        reasons: ['duration 1.200s is below 2.0s'],
      }
    : {
        path: file,
        durationSeconds: 1.2,
        sampledFrames: 3,
        maxFrameDifference: 0.4,
        changedFrames: 0,
        postContentChangedFrames: 0,
        blankFrameRatio: 1,
        initialNonBlankRatio: 0,
        finalNonBlankRatio: 0,
        leadingBlankSeconds: null,
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
