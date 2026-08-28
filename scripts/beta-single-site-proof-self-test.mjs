import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileDefinitionCoverageManifest } from '../shared/run-compiler.mjs';
import {
  claimJob,
  openJobQueue,
  publishAttemptDocument,
  settleJobAttempt,
} from './lib/job-queue.mjs';
import { launchDirectSingleSiteJob } from './run-single-site.mjs';
import {
  betaProofScenario,
  buildBetaProofReceipt,
  __testOnlyPersistBetaProofReceipt,
  __testOnlyReadBetaProofReceipt,
  parseArguments,
  validateBetaProofReceipt,
} from './run-beta-single-site-proof.mjs';

const DEFAULT_FIXTURE_ORIGIN = 'https://beta.quitting7oh-org.pages.dev';

assert.deepEqual(parseArguments(['--scenario', 'smoke']), {
  help: false,
  scenario: 'smoke',
  url: 'https://beta.quitting7oh-org.pages.dev',
  certificatePolicy: 'strict',
  timeoutMs: 90 * 60_000,
  aiModel: null,
});
assert.equal(parseArguments(['--help']).help, true);
assert.throws(() => parseArguments(['--scenario', 'unknown']), /Usage:/);
assert.throws(() => parseArguments(['--scenario', 'full', '--timeout-minutes', '0']), /1 through 240/);
assert.equal(parseArguments(['--scenario', 'smoke', '--url', 'HTTPS://BETA.QUITTING7OH-ORG.PAGES.DEV:443']).url, DEFAULT_FIXTURE_ORIGIN);
let invalidUrlError;
try {
  parseArguments(['--scenario', 'smoke', '--url', 'https://user:token-value@example.test/?api_key=secret-value']);
} catch (error) {
  invalidUrlError = error;
}
assert.match(invalidUrlError?.message ?? '', /without credentials, path, query, or fragment/);
assert.doesNotMatch(invalidUrlError?.message ?? '', /token-value|secret-value|api_key/);

const smoke = betaProofScenario('smoke');
assert.equal(smoke.scope, 'TARGETED');
assert.deepEqual(smoke.targets, ['single-site-mobile-chromium', 'single-site-desktop-chromium']);
assert.deepEqual(smoke.audits, ['CONTENT-001', 'SHELL-001', 'NAV-001', 'SEARCH-001']);

const full = betaProofScenario('full');
assert.equal(full.scope, 'FULL');
assert.deepEqual(full.targets, []);
assert.deepEqual(full.audits, []);
assert.deepEqual(full.areas, []);

const followUp = betaProofScenario('baseline-follow-up');
assert.equal(followUp.scope, 'TARGETED');
assert.deepEqual(followUp.targets, ['single-site-desktop-chromium']);
assert.deepEqual(followUp.audits, ['CONTENT-001']);
assert.ok(followUp.audits.every((auditId) => smoke.audits.includes(auditId)));
assert.ok(followUp.targets.every((targetId) => smoke.targets.includes(targetId)));

const [pluginRegistry, targetRegistry] = await Promise.all([
  readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8').then(JSON.parse),
]);
for (const name of ['smoke', 'targeted', 'full', 'baseline-follow-up']) {
  const scenario = betaProofScenario(name);
  const manifest = compileDefinitionCoverageManifest({
    runContract: {
      schemaVersion: 1,
      mode: 'single-site',
      url: 'https://beta.quitting7oh-org.pages.dev',
      deploymentRole: 'preview',
      certificatePolicy: 'strict',
      targetIds: scenario.targets.length > 0 ? scenario.targets : targetRegistry.singleSiteFullProfileTargetIds,
      scope: {
        qualifier: scenario.scope,
        pluginIds: scenario.plugins,
        auditIds: scenario.audits,
        areas: scenario.areas,
      },
    },
    pluginRegistry,
    targetRegistry,
    preflightBinding: {
      schemaVersion: 1,
      url: 'https://beta.quitting7oh-org.pages.dev',
      deploymentRole: 'preview',
      identityFingerprint: 'fixture-identity',
      deploymentRevision: { status: 'identified', value: 'fixture-revision' },
      evidenceAuthority: { status: 'authoritative', reasons: [] },
    },
    runnerRevision: 'fixture-runner-revision',
  });
  assert.ok(manifest.counts.plannedExecutions > 0, `${name} must compile executable work.`);
  assert.equal(manifest.scope.qualifier, scenario.scope, `${name} must preserve its scope qualifier.`);
  assert.equal(manifest.coverageStatus, 'COMPLETE', `${name} must not introduce a predefined Coverage Gap.`);
  if (name === 'smoke' || name === 'baseline-follow-up') {
    assert.ok(
      manifest.executions.some(({ auditId, targetId }) => auditId === 'CONTENT-001' && targetId === 'single-site-desktop-chromium'),
      `${name} must execute the desktop CONTENT-001 named visual capture needed by the baseline proof.`,
    );
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const bareDigest = (character) => character.repeat(64);
const finalizationDigest = bareDigest('5');
const mediaStageDigest = bareDigest('a');
const reportRevision = sha256({ finalizationDigest, mediaStageDigest }).slice(0, 32);
const currentPublications = Array.from({ length: 40 }, (_, index) => ({
  publicationId: `publication-${String(index).padStart(2, '0')}`,
  relativePath: `worker/publication-${String(index).padStart(2, '0')}.json`,
  digest: bareDigest((index % 10).toString()),
  attemptId: 'attempt-current',
  attemptNumber: 2,
  fencingToken: 3,
  publishedAt: '2026-08-25T12:00:00.000Z',
}));
const receipt = buildBetaProofReceipt({
  scenarioName: 'smoke',
  scenario: smoke,
  preview: {
    runContract: {
      mode: 'single-site',
      url: 'https://beta.quitting7oh-org.pages.dev',
      deploymentRole: 'preview',
      certificatePolicy: 'strict',
      targetIds: smoke.targets,
      scope: { qualifier: 'TARGETED' },
    },
    preflight: {
      preflightDigest: bareDigest('a'),
      identityFingerprint: bareDigest('b'),
      deploymentRevision: { fingerprint: bareDigest('c') },
    },
    coverage: {
      manifestDigest: `sha256:${bareDigest('d')}`,
      routeInventoryDigest: `sha256:${bareDigest('e')}`,
      coverageStatus: 'COMPLETE',
      scope: { qualifier: 'TARGETED', selectedTargetIds: smoke.targets },
      counts: { executableCases: 4, plannedExecutions: 8 },
      revisions: {
        runner: 'runner-fixture',
        runContract: `sha256:${bareDigest('f')}`,
        pluginRegistry: `sha256:${bareDigest('1')}`,
        targetRegistry: `sha256:${bareDigest('2')}`,
      },
    },
  },
  job: {
    jobId: 'fixture-job',
    runMode: 'single-site',
    inputDocumentDigest: bareDigest('3'),
    submissionDigest: bareDigest('4'),
    runContractDigest: bareDigest('f'),
    compiledManifestDigest: bareDigest('d'),
    preflightDigest: bareDigest('a'),
    identityFingerprint: bareDigest('b'),
    revisionFingerprint: bareDigest('c'),
    runnerRevision: 'runner-fixture',
    registryRevision: `sha256:${bareDigest('1')}`,
    targetSetRevision: `sha256:${bareDigest('2')}`,
    selectedCaseCount: 4,
    executionState: 'completed',
    activityState: 'normal',
    result: { kind: 'findings', reason: 'must-not-appear-secret-value' },
    attemptNumber: 2,
    attemptId: 'attempt-current',
    fencingToken: 3,
    infrastructureRetriesUsed: 1,
    publications: [
      {
        publicationId: 'stale-publication', relativePath: 'worker/stale.json', digest: bareDigest('9'),
        attemptId: 'attempt-old', attemptNumber: 1, fencingToken: 1, publishedAt: '2026-08-25T11:00:00.000Z',
      },
      {
        publicationId: 'same-attempt-wrong-fence', relativePath: 'worker/wrong-fence.json', digest: bareDigest('8'),
        attemptId: 'attempt-current', attemptNumber: 2, fencingToken: 2, publishedAt: '2026-08-25T11:30:00.000Z',
      },
      ...currentPublications,
    ],
  },
  finalization: {
    status: 'complete',
    executionState: 'completed',
    deadlineExceeded: false,
    finalizationDigest,
    failureDigest: null,
    reportRevision,
    reportPublicationDigest: bareDigest('7'),
    galleryExportRevision: 'export_fixture',
    galleryPublicationDigest: bareDigest('8'),
    galleryIndexDigest: bareDigest('9'),
    mediaStageDigest,
    mediaQualityState: 'complete',
    visualPublicationDigest: `sha256:${bareDigest('b')}`,
    visualEligibilityManifestDigest: `sha256:${bareDigest('c')}`,
  },
  finishedAt: '2026-08-25T12:30:00.000Z',
});
assert.equal(receipt.kind, 'beta-single-site-proof-receipt');
assert.equal(receipt.run.scope.qualifier, 'TARGETED');
assert.equal(receipt.revisions.runnerRevision, 'runner-fixture');
assert.equal(receipt.revisions.routeInventoryDigest, `sha256:${bareDigest('e')}`);
assert.equal(receipt.terminal.resultKind, 'findings');
assert.equal(receipt.terminal.attemptNumber, 2);
assert.equal(receipt.terminal.fencingToken, 3);
assert.equal(receipt.publications.attemptId, 'attempt-current');
assert.equal(receipt.publications.attemptNumber, 2);
assert.equal(receipt.publications.fencingToken, 3);
assert.equal(receipt.publications.total, 40);
assert.equal(receipt.publications.included, 32);
assert.equal(receipt.publications.truncated, true);
assert.match(receipt.publications.manifestDigest, /^[a-f0-9]{64}$/);
assert.ok(receipt.publications.items.every(({ attemptId, fencingToken }) => attemptId === 'attempt-current' && fencingToken === 3));
assert.equal(receipt.finalization.finalizationDigest, finalizationDigest);
assert.equal(receipt.report.publicationDigest, bareDigest('7'));
assert.equal(receipt.gallery.indexDigest, bareDigest('9'));
assert.equal(receipt.media.stageDigest, bareDigest('a'));
assert.equal(receipt.visual.publicationDigest, `sha256:${bareDigest('b')}`);
assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/);
assert.equal(validateBetaProofReceipt(receipt), receipt);
assert.deepEqual(receipt.command, { outcome: 'succeeded', exitCode: 0 });
assert.equal(receipt.report.url, '/report.html?mode=single-site&run=fixture-job');
assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 32 * 1_024, 'proof receipt must remain compact');
assert.doesNotMatch(JSON.stringify(receipt), /must-not-appear-secret-value/);
assert.doesNotMatch(JSON.stringify(receipt), /stale-publication/);
assert.doesNotMatch(JSON.stringify(receipt), /same-attempt-wrong-fence/);

const legacyReceipt = buildBetaProofReceipt({
  scenarioName: 'smoke',
  scenario: smoke,
  preview: {},
  job: {
    jobId: 'legacy-job', executionState: 'completed', activityState: 'normal', result: null,
    attemptNumber: 0, attemptId: null, fencingToken: 0, publications: [],
  },
  finalization: { status: 'incomplete' },
  finishedAt: '2026-08-25T12:31:00.000Z',
});
assert.equal(legacyReceipt.revisions.routeInventoryDigest, null);
assert.equal(legacyReceipt.report.publicationDigest, null);
assert.equal(legacyReceipt.gallery.exportRevision, null);
assert.deepEqual(legacyReceipt.command, { outcome: 'not-complete', exitCode: 2 });

const terminalFenceReceipt = buildBetaProofReceipt({
  scenarioName: 'smoke',
  scenario: smoke,
  preview: {},
  job: {
    jobId: 'terminal-fence-job', executionState: 'incomplete', activityState: 'stalled',
    result: { kind: 'incomplete', reason: 'not included' }, attemptNumber: 2, attemptId: 'attempt-current',
    fencingToken: 4, publications: [
      {
        publicationId: 'wrong-fence', relativePath: 'worker/wrong.json', digest: bareDigest('1'),
        attemptId: 'attempt-current', attemptNumber: 2, fencingToken: 2,
      },
      {
        publicationId: 'authoritative', relativePath: 'worker/current.json', digest: bareDigest('2'),
        attemptId: 'attempt-current', attemptNumber: 2, fencingToken: 3,
      },
    ],
  },
  finalization: { status: 'incomplete' },
  finishedAt: '2026-08-25T12:32:00.000Z',
});
assert.equal(terminalFenceReceipt.terminal.attemptId, 'attempt-current', 'terminal envelope must preserve its attempt ID');
assert.equal(terminalFenceReceipt.terminal.fencingToken, 4, 'terminal envelope must preserve its incremented fence');
assert.equal(terminalFenceReceipt.publications.attemptId, 'attempt-current');
assert.equal(terminalFenceReceipt.publications.fencingToken, 3, 'publication fence must not be replaced by the terminal fence');
assert.equal(terminalFenceReceipt.publications.total, 1);
assert.equal(terminalFenceReceipt.publications.items[0].attemptId, 'attempt-current');
assert.equal(terminalFenceReceipt.publications.items[0].publicationId, 'authoritative');

const digestTamper = structuredClone(receipt);
digestTamper.command.outcome = 'tampered';
assert.throws(() => validateBetaProofReceipt(digestTamper), /digest verification/);
const secretFieldTamper = structuredClone(receipt);
secretFieldTamper.report.apiKey = 'must-never-be-accepted';
delete secretFieldTamper.receiptDigest;
secretFieldTamper.receiptDigest = sha256(secretFieldTamper);
assert.throws(() => validateBetaProofReceipt(secretFieldTamper), /report has invalid fields/);
const timeTamper = structuredClone(receipt);
timeTamper.finishedAt = 'not-a-time';
delete timeTamper.receiptDigest;
timeTamper.receiptDigest = sha256(timeTamper);
assert.throws(() => validateBetaProofReceipt(timeTamper), /finishedAt is not a canonical timestamp/);

const receiptRoot = await mkdtemp(path.join(os.tmpdir(), 'beta-proof-receipt-'));
try {
  const queueRoot = path.join(receiptRoot, 'queue');
  const finalizationRoot = path.join(receiptRoot, 'finalizations');
  const queue = await openJobQueue({ root: queueRoot });
  const direct = await launchDirectSingleSiteJob({
    queueRoot,
    url: DEFAULT_FIXTURE_ORIGIN,
    role: 'preview',
    certificatePolicy: 'strict',
    scope: smoke.scope,
    targets: [...smoke.targets],
    plugins: [...smoke.plugins],
    audits: [...smoke.audits],
    areas: [...smoke.areas],
    aiModel: null,
    idempotencyKey: 'beta-proof-self-test-fixture',
    previewBypassOrigins: [],
  }, {
    queue,
    pluginRegistry,
    targetRegistry,
    runnerRevision: 'fixture-runner-revision',
    preflight: async ({ url, deploymentRole, certificatePolicy }) => ({
      schemaVersion: 1,
      accepted: true,
      checkedAt: '2026-08-25T12:00:00.000Z',
      origin: url,
      deploymentRole,
      certificatePolicy,
      identityFingerprint: bareDigest('b'),
      deploymentRevision: { status: 'verified', fingerprint: bareDigest('c') },
      evidenceAuthority: { status: 'authoritative', reasons: [] },
      markers: [],
      probes: [],
      issues: [],
      preflightDigest: bareDigest('a'),
    }),
    now: () => Date.parse('2026-08-25T12:00:00.000Z'),
  });
  const jobId = direct.launched.job.jobId;
  const claim = await claimJob(queue, jobId, 'proof-self-test-worker');
  await publishAttemptDocument(queue, claim, {
    publicationId: 'fixture-checkpoint',
    relativePath: 'worker/checkpoint.json',
    document: { schemaVersion: 1, kind: 'fixture-checkpoint' },
  });
  await publishAttemptDocument(queue, claim, {
    publicationId: 'fixture-result',
    relativePath: 'worker/attempt-result.json',
    document: { schemaVersion: 1, kind: 'fixture-result' },
  });
  const durableJob = await settleJobAttempt(queue, claim, { kind: 'assertion-failure', reason: 'fixture finding' });
  const durableFinalizationBody = {
    schemaVersion: 1,
    kind: 'single-site-finalization',
    mode: 'single-site',
    runContractDigest: durableJob.runContractDigest,
    compiledManifestDigest: durableJob.compiledManifestDigest,
    jobs: [{ jobId, fixture: true }],
    counts: { jobs: 1, completed: 1, incomplete: 0, failed: 0, cancelled: 0, passed: 0, findings: 1 },
  };
  const durableFinalizationDocument = {
    ...durableFinalizationBody,
    finalizationDigest: sha256(durableFinalizationBody),
  };
  const durableMediaStageDigest = bareDigest('a');
  const durableReportRevision = sha256({
    finalizationDigest: durableFinalizationDocument.finalizationDigest,
    mediaStageDigest: durableMediaStageDigest,
  }).slice(0, 32);
  const galleryIndexBody = {
    schemaVersion: 1,
    kind: 'single-site-gallery-index',
    mode: 'single-site',
    generatedAt: '2026-08-25T12:00:00.000Z',
    exportRevision: 'export_fixture',
    entries: [{
      itemId: 'gitem_0000000000000001', auditCaseId: 'CONTENT-001:named', auditIds: ['CONTENT-001'],
      sourceTestId: 'fixture-test', projectName: 'single-site-desktop-chromium', kind: 'image', status: 'passed',
    }],
  };
  const galleryIndex = { ...galleryIndexBody, indexDigest: sha256(galleryIndexBody) };
  const galleryPublication = {
    schemaVersion: 1,
    kind: 'single-site-gallery-publication',
    mode: 'single-site',
    generatedAt: '2026-08-25T12:00:00.000Z',
    source: { processedArtifactRoot: '/fixture', testCount: 1 },
    descriptor: { exportRevision: 'export_fixture', primaryCounts: { total: 1, images: 1, videos: 0 } },
    index: { indexDigest: galleryIndex.indexDigest, exportRevision: 'export_fixture', itemCount: 1 },
    warnings: [],
  };
  const durableFinalization = {
    jobId,
    status: 'complete',
    deadlineExceeded: false,
    executionState: 'completed',
    finalizationDigest: durableFinalizationDocument.finalizationDigest,
    failureDigest: null,
    mediaStageDigest: durableMediaStageDigest,
    mediaQualityState: 'complete',
    reportRevision: durableReportRevision,
    reportPublicationDigest: bareDigest('7'),
    visualPublicationDigest: `sha256:${bareDigest('b')}`,
    visualEligibilityManifestDigest: `sha256:${bareDigest('c')}`,
    galleryPublicationDigest: sha256(galleryPublication),
    galleryExportRevision: 'export_fixture',
    galleryIndexDigest: galleryIndex.indexDigest,
  };
  const durableReceipt = buildBetaProofReceipt({
    scenarioName: 'smoke',
    scenario: smoke,
    preview: direct.preview,
    job: durableJob,
    finalization: durableFinalization,
    finishedAt: '2026-08-25T12:30:00.000Z',
  });
  assert.equal(durableReceipt.revisions.previewDigest, direct.preview.previewDigest);
  assert.equal(durableReceipt.revisions.routeInventoryDigest, direct.preview.routeInventoryPlan.planDigest);

  const jobDirectory = path.join(finalizationRoot, jobId);
  await mkdir(finalizationRoot);
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'finalization.json'), `${JSON.stringify(durableFinalizationDocument)}\n`);
  await mkdir(path.join(jobDirectory, 'report', 'checklist', 'single-site-gallery-index', 'revisions'), { recursive: true });
  await mkdir(path.join(jobDirectory, 'media'));
  await mkdir(path.join(jobDirectory, 'visual'));
  const galleryIndexRoot = path.join(jobDirectory, 'report', 'checklist', 'single-site-gallery-index');
  await writeFile(path.join(galleryIndexRoot, 'current.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'single-site-gallery-index-pointer',
    indexDigest: galleryIndex.indexDigest,
    exportRevision: 'export_fixture',
    relativePath: `single-site-gallery-index/revisions/${galleryIndex.indexDigest}.json`,
    itemCount: 1,
  })}\n`);
  await writeFile(path.join(galleryIndexRoot, 'revisions', `${galleryIndex.indexDigest}.json`), `${JSON.stringify(galleryIndex)}\n`);
  const galleryBindingBody = {
    schemaVersion: 1,
    kind: 'single-site-gallery-finalization-binding',
    jobId,
    publication: galleryPublication,
    publicationDigest: durableFinalization.galleryPublicationDigest,
    exportRevision: 'export_fixture',
    indexDigest: galleryIndex.indexDigest,
  };
  await writeFile(path.join(jobDirectory, 'gallery-publication.json'), `${JSON.stringify({
    ...galleryBindingBody,
    bindingDigest: sha256(galleryBindingBody),
  })}\n`);
  for (const marker of [
    path.join(jobDirectory, 'report', 'report-marker.json'),
    path.join(jobDirectory, 'media', 'media-marker.json'),
    path.join(jobDirectory, 'visual', 'visual-marker.json'),
    path.join(jobDirectory, 'report', 'gallery-marker.json'),
  ]) await writeFile(marker, '{}\n');
  const publicationDependencies = {
    finalizeSingleSiteJobs: async () => structuredClone(durableFinalizationDocument),
    validateCompleteReportPublication: async (runDirectory) => {
      await readFile(path.join(runDirectory, 'report-marker.json'));
      return {
        problems: [],
        publication: {
          runDirectory,
          mode: 'single-site',
          publicationRevision: durableReportRevision,
          publicationDigest: durableFinalization.reportPublicationDigest,
          generatedAt: '2026-08-25T12:00:00.000Z',
        },
        summary: {}, audits: null,
      };
    },
    readSingleSiteMediaStagePublication: async ({ outputDir }) => {
      await readFile(path.join(outputDir, 'media-marker.json'));
      return { manifest: { qualityState: 'complete' } };
    },
    readSingleSiteVisualComparisonPublication: async ({ outputDir }) => {
      await readFile(path.join(outputDir, 'visual-marker.json'));
      return {
        publicationDigest: durableFinalization.visualPublicationDigest,
        eligibility: { manifestDigest: durableFinalization.visualEligibilityManifestDigest },
      };
    },
    loadGallerySnapshot: async ({ directory }) => {
      await readFile(path.join(directory, 'gallery-marker.json'));
      return {
        kind: 'sealed',
        head: { exportRevision: 'export_fixture', primaryCounts: galleryPublication.descriptor.primaryCounts },
        rows: [{ id: 'gitem_0000000000000001' }],
      };
    },
    readGalleryItem: async () => ({ item: { id: 'gitem_0000000000000001' } }),
  };
  const statusBody = {
    schemaVersion: 1,
    kind: 'single-site-finalization-status',
    jobId,
    status: 'complete',
    deadlineExceeded: false,
    executionState: 'completed',
    finalizationDigest: durableFinalization.finalizationDigest,
    mediaStageDigest: durableMediaStageDigest,
    mediaQualityState: 'complete',
    reportRevision: durableReportRevision,
    reportPublicationDigest: bareDigest('7'),
    visualPublicationDigest: `sha256:${bareDigest('b')}`,
    visualEligibilityManifestDigest: `sha256:${bareDigest('c')}`,
    galleryPublicationDigest: durableFinalization.galleryPublicationDigest,
    galleryExportRevision: 'export_fixture',
    galleryIndexDigest: galleryIndex.indexDigest,
  };
  await writeFile(
    path.join(jobDirectory, 'status.json'),
    `${JSON.stringify({ ...statusBody, statusDigest: sha256(statusBody) })}\n`,
  );

  assert.equal(await __testOnlyReadBetaProofReceipt(finalizationRoot, jobId), null, 'older finalizations may have no receipt');
  const firstPublish = await __testOnlyPersistBetaProofReceipt(finalizationRoot, durableReceipt, { queue, publicationDependencies });
  assert.equal(firstPublish.created, true);
  assert.equal(firstPublish.receipt.receiptDigest, durableReceipt.receiptDigest);
  const restartedRead = await __testOnlyReadBetaProofReceipt(finalizationRoot, jobId, { queue, publicationDependencies });
  assert.equal(restartedRead.receiptDigest, durableReceipt.receiptDigest);
  const restartedPublish = await __testOnlyPersistBetaProofReceipt(finalizationRoot, durableReceipt, { queue, publicationDependencies });
  assert.equal(restartedPublish.created, false, 'restart must reuse the exact immutable receipt');

  const assertAuthorityTamperRejected = async (mutate, pattern) => {
    const tampered = structuredClone(durableReceipt);
    mutate(tampered);
    delete tampered.receiptDigest;
    tampered.receiptDigest = sha256(tampered);
    await writeFile(path.join(jobDirectory, 'beta-proof-receipt.json'), `${JSON.stringify(tampered)}\n`);
    await assert.rejects(__testOnlyReadBetaProofReceipt(finalizationRoot, jobId, { queue, publicationDependencies }), pattern);
  };
  await assertAuthorityTamperRejected((tampered) => { tampered.scenario = 'baseline-follow-up'; }, /scenario does not match/);
  await assertAuthorityTamperRejected((tampered) => { tampered.run.mode = 'comparative'; }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => { tampered.run.scope.qualifier = 'FULL'; }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => { tampered.revisions.runnerRevision = 'forged-runner'; }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => { tampered.revisions.previewDigest = `sha256:${bareDigest('0')}`; }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => { tampered.revisions.coverageManifestDigest = bareDigest('0'); }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => { tampered.terminal.resultKind = 'passed'; }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => { tampered.terminal.attemptNumber += 1; }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => { tampered.terminal.attemptId = 'forged-attempt'; }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => { tampered.terminal.fencingToken += 1; }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => {
    tampered.publications.fencingToken += 1;
    for (const item of tampered.publications.items) item.fencingToken += 1;
  }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => { tampered.publications.manifestDigest = bareDigest('0'); }, /durable queue launch/);
  await assertAuthorityTamperRejected((tampered) => {
    tampered.command.outcome = 'not-complete';
    tampered.command.exitCode = 2;
  }, /verified finalization status/);

  const receiptFile = path.join(jobDirectory, 'beta-proof-receipt.json');
  const statusFile = path.join(jobDirectory, 'status.json');
  const writeAuthoritativeFixture = async () => {
    await writeFile(receiptFile, `${JSON.stringify(durableReceipt)}\n`);
    await writeFile(statusFile, `${JSON.stringify({ ...statusBody, statusDigest: sha256(statusBody) })}\n`);
  };
  await writeAuthoritativeFixture();
  const forgedFinalizationDigest = bareDigest('f');
  const forgedReportRevision = sha256({
    finalizationDigest: forgedFinalizationDigest,
    mediaStageDigest: durableMediaStageDigest,
  }).slice(0, 32);
  const forgedStatusBody = {
    ...statusBody,
    finalizationDigest: forgedFinalizationDigest,
    reportRevision: forgedReportRevision,
  };
  const forgedReceipt = structuredClone(durableReceipt);
  forgedReceipt.finalization.finalizationDigest = forgedFinalizationDigest;
  forgedReceipt.report.revision = forgedReportRevision;
  delete forgedReceipt.receiptDigest;
  forgedReceipt.receiptDigest = sha256(forgedReceipt);
  await writeFile(statusFile, `${JSON.stringify({ ...forgedStatusBody, statusDigest: sha256(forgedStatusBody) })}\n`);
  await writeFile(receiptFile, `${JSON.stringify(forgedReceipt)}\n`);
  await assert.rejects(
    __testOnlyReadBetaProofReceipt(finalizationRoot, jobId, { queue, publicationDependencies }),
    /finalization has an invalid durable digest binding/,
    'rehashing status and receipt must not forge the durable finalization',
  );
  await writeAuthoritativeFixture();

  const durablePublicationFiles = [
    path.join(jobDirectory, 'finalization.json'),
    path.join(jobDirectory, 'report', 'report-marker.json'),
    path.join(jobDirectory, 'media', 'media-marker.json'),
    path.join(jobDirectory, 'visual', 'visual-marker.json'),
    path.join(jobDirectory, 'report', 'gallery-marker.json'),
    path.join(galleryIndexRoot, 'revisions', `${galleryIndex.indexDigest}.json`),
  ];
  for (const file of durablePublicationFiles) {
    const bytes = await readFile(file);
    await rm(file);
    await assert.rejects(
      __testOnlyReadBetaProofReceipt(finalizationRoot, jobId, { queue, publicationDependencies }),
      /missing|ENOENT/,
      `missing durable publication must invalidate the receipt: ${path.basename(file)}`,
    );
    await writeFile(file, bytes);
  }
} finally {
  await rm(receiptRoot, { recursive: true, force: true });
}

process.stdout.write('Beta Single-site proof contract self-test passed.\n');
