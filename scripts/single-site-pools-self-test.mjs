import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from './lib/job-queue.mjs';
import { initializeLegacyAuthorityFence } from './lib/legacy-authority-fence.mjs';
import { visualBaselineDigest } from '../shared/visual-baseline-contract.mjs';
import { validateCompleteReportPublication } from '../portal/report-publication.mjs';
import {
  defaultFinalizerId,
  revalidateSingleSitePublicationCheckpoint,
  runSingleSiteFinalizerPool,
} from './run-single-site-finalizer-pool.mjs';
import {
  defaultWorkerId,
  parsePollMilliseconds,
  runSingleSiteWorkerPool,
  workerCandidates,
} from './run-single-site-worker-pool.mjs';

function memoryStream() {
  let value = '';
  return {
    write(chunk) { value += chunk; },
    text() { return value; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function state(jobId, executionState, overrides = {}) {
  return {
    jobId,
    executionState,
    submittedAt: '2026-08-25T12:00:00.000Z',
    attemptNumber: 0,
    attemptId: 'attempt-001',
    fencingToken: 0,
    lease: null,
    inputDocumentDigest: sha256(`${jobId}:input`),
    submissionDigest: sha256(`${jobId}:submission`),
    stageDeadlines: {
      browser: '2099-01-01T00:10:00.000Z',
      finalizer: '2099-01-01T00:20:00.000Z',
    },
    ...overrides,
  };
}

function workerResult(job, executionState = 'completed', resultKind = 'passed') {
  return {
    claim: { attemptNumber: 1, fencingToken: 1 },
    state: { jobId: job.jobId, executionState, result: { kind: resultKind } },
  };
}

function finalization(job, status = 'complete') {
  const incomplete = status === 'incomplete' ? 1 : 0;
  const body = {
    schemaVersion: 1,
    kind: 'single-site-finalization',
    mode: 'single-site',
    runContractDigest: sha256('run-contract'),
    compiledManifestDigest: sha256('coverage-manifest'),
    jobs: [{
      jobId: job.jobId,
      inputDocumentDigest: job.inputDocumentDigest,
      submissionDigest: job.submissionDigest,
      runContractDigest: sha256({
        schemaVersion: 1,
        mode: 'single-site',
        url: 'https://beta.quitting7oh-org.pages.dev',
        deploymentRole: 'preview',
        certificatePolicy: 'preview-bypass',
        targetIds: ['candidate-mobile-chromium'],
        scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['HOME-001'], areas: [] },
      }),
      identityFingerprint: sha256('publication-checkpoint-identity'),
      revisionFingerprint: sha256('publication-checkpoint-revision-before-browser'),
      evidenceAuthority: { authoritative: false, reasons: ['development-certificate-bypass'] },
      executionState: job.executionState,
      attemptNumber: job.attemptNumber,
      fencingToken: job.fencingToken,
      publications: [],
    }],
    counts: {
      jobs: 1,
      completed: incomplete ? 0 : 1,
      incomplete,
      failed: 0,
      cancelled: 0,
      passed: incomplete ? 0 : 1,
      findings: 0,
    },
  };
  return { ...body, finalizationDigest: sha256(body) };
}

function reportInput(jobId, generatedAt) {
  return {
    schemaVersion: 1,
    mode: 'single-site',
    generatedAt,
    pageSize: 25,
    health: {
      schemaVersion: 1,
      mode: 'single-site',
      url: 'https://beta.quitting7oh-org.pages.dev',
      deploymentRole: 'preview',
      scope: { qualifier: 'TARGETED', selectedCoverage: ['HOME-001'], omittedCoverage: [] },
      coverage: { finalized: true, manifestIntegrity: true, gaps: [], limitations: [] },
      pipeline: {
        executionStatus: 'completed',
        integrityComplete: true,
        requiredEvidenceComplete: true,
        reason: `Current fenced evidence for ${jobId} is complete.`,
      },
      evidenceAuthority: { status: 'authoritative', reasons: [] },
      findings: [],
      manual: { required: 0, complete: 0, failedOrBlocked: 0 },
      visualReview: { items: [{ status: 'unavailable' }] },
    },
    audits: [{
      id: 'HOME-001',
      title: 'Homepage standalone oracle',
      area: 'Homepage',
      status: 'PASS',
      findingCount: 0,
      evidenceStatus: 'complete',
      artifactCount: 1,
      manual: false,
      visualStatus: 'unavailable',
      detail: 'The homepage identity and primary navigation matched the reviewed Product Oracle.',
    }],
    outsideMode: [],
  };
}

function publicationCheckpoint(job) {
  const body = {
    schemaVersion: 1,
    kind: 'single-site-publication-checkpoint',
    jobId: job.jobId,
    executionState: job.executionState,
    attemptNumber: job.attemptNumber,
    fencingToken: job.fencingToken,
    inputDocumentDigest: job.inputDocumentDigest,
    submissionDigest: job.submissionDigest,
    publicationsDigest: sha256([]),
    runContract: {
      schemaVersion: 1,
      mode: 'single-site',
      url: 'https://beta.quitting7oh-org.pages.dev',
      deploymentRole: 'preview',
      certificatePolicy: 'preview-bypass',
      targetIds: ['candidate-mobile-chromium'],
      scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['HOME-001'], areas: [] },
    },
    launchCheckpoint: {
      identityFingerprint: sha256('publication-checkpoint-identity'),
      revisionFingerprint: sha256('publication-checkpoint-revision-before-browser'),
      evidenceAuthority: { authoritative: false, reasons: ['development-certificate-bypass'] },
    },
  };
  return { ...body, checkpointDigest: sha256(body) };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-pools-'));
const previousFenceRoot = process.env.AUDIT_LEGACY_AUTHORITY_FENCE_ROOT;
try {
  const fenceRoot = path.join(temporaryRoot, 'legacy-authority');
  await initializeLegacyAuthorityFence({ root: fenceRoot, verifyStorage: false });
  process.env.AUDIT_LEGACY_AUTHORITY_FENCE_ROOT = fenceRoot;
  assert.equal(defaultWorkerId('worker_host.example'), 'worker-worker_host.example');
  assert.equal(defaultFinalizerId('finalizer_host.example'), 'finalizer-finalizer_host.example');
  assert.equal(parsePollMilliseconds('250'), 250);
  assert.throws(() => parsePollMilliseconds('99'), (error) => error?.code === 'SINGLE_SITE_POOL_INVALID');

  const candidateNow = Date.parse('2026-08-25T12:01:00.000Z');
  const candidates = workerCandidates([
    state('job-live', 'running', {
      lease: { expiresAt: '2026-08-25T12:02:00.000Z' },
    }),
    state('job-expired', 'running', {
      submittedAt: '2026-08-25T11:00:00.000Z',
      lease: { expiresAt: '2026-08-25T12:00:00.000Z' },
    }),
    state('job-queued-b', 'queued', { submittedAt: '2026-08-25T12:00:02.000Z' }),
    state('job-queued-a', 'queued', { submittedAt: '2026-08-25T12:00:01.000Z' }),
    state('job-done', 'completed'),
  ], candidateNow);
  assert.deepEqual(candidates.map(({ jobId }) => jobId), ['job-expired', 'job-queued-a', 'job-queued-b']);

  const raceLog = memoryStream();
  const attempted = [];
  const raceController = new AbortController();
  const raceSummary = await runSingleSiteWorkerPool({
    queue: {},
    workerId: 'worker-race-fixture',
    pollMs: 100,
    signal: raceController.signal,
    maxCycles: 1,
    dependencies: {
      logStream: raceLog,
      listJobs: async () => [
        state('job-race-loser', 'queued', { submittedAt: '2026-08-25T12:00:01.000Z' }),
        state('job-race-winner', 'queued', { submittedAt: '2026-08-25T12:00:02.000Z' }),
      ],
      execute: async ({ jobId }) => {
        attempted.push(jobId);
        if (jobId === 'job-race-loser') {
          const error = new Error('Bearer should-never-appear-in-pool-log');
          error.code = 'QUEUE_ALREADY_CLAIMED';
          throw error;
        }
        return workerResult({ jobId });
      },
    },
  });
  assert.deepEqual(attempted, ['job-race-loser', 'job-race-winner']);
  assert.equal(raceSummary.jobsStarted, 1);
  assert.equal(raceSummary.jobsSettled, 1);
  assert.match(raceLog.text(), /claim-race-lost/);
  assert.doesNotMatch(raceLog.text(), /should-never-appear/);

  const drainLog = memoryStream();
  const drainController = new AbortController();
  const active = deferred();
  const activeStarted = deferred();
  let drainListCalls = 0;
  const drainingPool = runSingleSiteWorkerPool({
    queue: {},
    workerId: 'worker-drain-fixture',
    pollMs: 100,
    signal: drainController.signal,
    dependencies: {
      logStream: drainLog,
      listJobs: async () => {
        drainListCalls += 1;
        return [state('job-active', 'queued'), state('job-not-accepted', 'queued')];
      },
      execute: async ({ jobId }) => {
        activeStarted.resolve();
        await active.promise;
        return workerResult({ jobId });
      },
    },
  });
  await activeStarted.promise;
  drainController.abort(new Error('synthetic drain'));
  let drainSettled = false;
  drainingPool.then(() => { drainSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(drainSettled, false, 'worker pool waits for active work while draining');
  active.resolve();
  const drainedWorker = await drainingPool;
  assert.equal(drainedWorker.drained, true);
  assert.equal(drainListCalls, 1, 'worker pool does not poll for another job after drain begins');
  assert.match(drainLog.text(), /drain-started/);
  assert.match(drainLog.text(), /pool-stopped/);

  const finalizerJobs = [
    state('job-final-complete', 'completed'),
    state('job-final-incomplete', 'incomplete'),
    state('job-final-media-incomplete', 'completed'),
    state('job-final-invalid', 'incomplete'),
    state('job-final-late', 'completed', {
      stageDeadlines: {
        browser: '2026-08-25T11:00:00.000Z',
        finalizer: '2026-08-25T11:30:00.000Z',
      },
    }),
  ];
  const finalizerOutput = path.join(temporaryRoot, 'finalizations');
  const finalizerLog = memoryStream();
  const finalizeCalls = [];
  const visualDependencies = {
    publishVisual: async ({ jobId, finalizationDigest, reportRevision }) => {
      const eligibilityBody = { jobId, finalizationDigest, reportRevision };
      const body = {
        schemaVersion: 1,
        kind: 'single-site-visual-comparison-publication',
        mode: 'single-site',
        runId: jobId,
        eligibility: { relativePath: 'eligibility.json', manifestDigest: visualBaselineDigest(eligibilityBody) },
        summary: { total: 0 },
        items: [],
      };
      return { ...body, publicationDigest: visualBaselineDigest(body) };
    },
    applyVisual: (input) => input,
  };
  const mediaDependencies = {
    publishMedia: async ({ sourceResults, sourceResultsBytes, artifactRoot, jobId, attemptId, finalizationDigest, generatedAt, deadlineAt }) => {
      assert(Number.isFinite(deadlineAt), 'finalizer stage deadline is propagated to media subprocesses');
      const mediaIncomplete = jobId === 'job-final-media-incomplete';
      const body = {
        schemaVersion: 1,
        kind: 'single-site-media-stage',
        mode: 'single-site',
        jobId,
        attemptId,
        finalizationDigest,
        generatedAt,
        sourceResultsDigest: sha256(sourceResultsBytes),
        sourceResultsBytes: sourceResultsBytes.length,
        processedResultsDigest: sha256(sourceResultsBytes),
        processedResultsBytes: sourceResultsBytes.length,
        videoManifestDigest: sha256('video-manifest'),
        qualityState: mediaIncomplete ? 'incomplete' : 'complete',
        integrityErrors: mediaIncomplete ? ['Required action video was blank or too short.'] : [],
      };
      return {
        manifest: { ...body, mediaStageDigest: sha256(body) },
        results: sourceResults,
        resultsBytes: sourceResultsBytes,
        artifactRoot,
      };
    },
    publishGallery: async ({ artifactRoot }) => ({
      publication: { kind: 'single-site-gallery-publication', artifactRoot },
      publicationDigest: sha256({ artifactRoot, fixture: 'gallery' }),
      exportRevision: 'export_fixture',
      indexDigest: sha256({ artifactRoot, fixture: 'gallery-index' }),
    }),
    revalidatePublicationCheckpoint: async () => ({ matched: true }),
  };
  const reportDependencies = {
    legacyAuthorityFence: Object.freeze({ withAuthority: (_capability, operation) => operation() }),
    ...visualDependencies,
    ...mediaDependencies,
    preparePublicationInput: async () => ({
      reportInput: { fixture: true },
      playwrightResults: { suites: [], errors: [] },
      playwrightResultsBytes: Buffer.from('{"suites":[],"errors":[]}'),
      sourceResultsDigest: sha256(Buffer.from('{"suites":[],"errors":[]}')),
      artifactRoot: temporaryRoot,
      terminalState: { attemptId: 'attempt-001' },
    }),
    publishReport: async ({ outputDir, publicationRevision }) => {
      const dataDirectory = path.join(outputDir, 'data');
      await fs.mkdir(dataDirectory, { recursive: true });
      await fs.writeFile(path.join(dataDirectory, 'current.json'), `${JSON.stringify({
        publicationRevision,
        mode: 'single-site',
      })}\n`, { flag: 'wx' });
    },
    validateReport: async (runDirectory) => {
      const pointer = await readJson(path.join(runDirectory, 'checklist', 'data', 'current.json'));
      return {
        problems: [],
        publication: { ...pointer, publicationDigest: sha256(pointer) },
        summary: {
          visualReview: {
            total: 0,
            attentionRequired: 0,
            byStatus: { UNCHANGED: 0, CHANGED: 0, REVIEWED: 0, absent: 0, incompatible: 0, unavailable: 0 },
          },
        },
      };
    },
  };
  const finalizeFixture = async ({ jobIds }) => {
    const job = finalizerJobs.find(({ jobId }) => jobId === jobIds[0]);
    finalizeCalls.push(job.jobId);
    if (job.jobId === 'job-final-invalid') {
      const error = new Error('Invalid evidence with api_key=definitely-secret-value');
      error.code = 'SINGLE_SITE_FINALIZER_EVIDENCE_INVALID';
      throw error;
    }
    return finalization(job, job.jobId === 'job-final-incomplete' ? 'incomplete' : 'complete');
  };
  const finalized = await runSingleSiteFinalizerPool({
    queue: {},
    outputRoot: finalizerOutput,
    finalizerId: 'finalizer-fixture',
    pollMs: 100,
    maxCycles: 1,
    dependencies: {
      ...reportDependencies,
      logStream: finalizerLog,
      listJobs: async () => finalizerJobs,
      finalize: finalizeFixture,
      now: () => Date.parse('2026-08-25T12:00:00.000Z'),
    },
  });
  assert.equal(finalized.published, 4);
  assert.equal(finalized.invalid, 1);
  assert.deepEqual(finalizeCalls.sort(), finalizerJobs.map(({ jobId }) => jobId).sort());
  const completeOutput = await readJson(path.join(finalizerOutput, 'job-final-complete', 'finalization.json'));
  assert.equal(completeOutput.finalizationDigest, sha256(Object.fromEntries(
    Object.entries(completeOutput).filter(([key]) => key !== 'finalizationDigest'),
  )));
  assert.equal((await readJson(path.join(finalizerOutput, 'job-final-complete', 'status.json'))).status, 'complete');
  assert.equal((await readJson(path.join(finalizerOutput, 'job-final-incomplete', 'status.json'))).status, 'incomplete');
  assert.equal((await readJson(path.join(finalizerOutput, 'job-final-media-incomplete', 'status.json'))).status, 'incomplete');
  assert.equal((await readJson(path.join(finalizerOutput, 'job-final-invalid', 'status.json'))).status, 'invalid');
  const lateStatus = await readJson(path.join(finalizerOutput, 'job-final-late', 'status.json'));
  assert.equal(lateStatus.status, 'incomplete');
  assert.equal(lateStatus.deadlineExceeded, true);
  const invalidFiles = await fs.readdir(path.join(finalizerOutput, 'job-final-invalid'));
  const failureFile = invalidFiles.find((file) => file.startsWith('failure-'));
  assert.ok(failureFile);
  const failureBytes = await fs.readFile(path.join(finalizerOutput, 'job-final-invalid', failureFile), 'utf8');
  assert.doesNotMatch(failureBytes, /definitely-secret-value/);
  assert.doesNotMatch(finalizerLog.text(), /definitely-secret-value/);
  assert.match(finalizerLog.text(), /finalization-invalid/);

  const redeployedJob = state('job-final-redeployed', 'completed', {
    attemptNumber: 1,
    fencingToken: 7,
  });
  const redeployedCheckpoint = publicationCheckpoint(redeployedJob);
  const redeployedOutput = path.join(temporaryRoot, 'redeployed-finalization');
  const redeployedLog = memoryStream();
  const forbiddenPublications = [];
  const redeployedResult = await runSingleSiteFinalizerPool({
    queue: {},
    outputRoot: redeployedOutput,
    finalizerId: 'finalizer-redeployed-fixture',
    pollMs: 100,
    maxCycles: 1,
    environment: {
      AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST: 'https://beta.quitting7oh-org.pages.dev',
    },
    dependencies: {
      ...reportDependencies,
      revalidatePublicationCheckpoint: revalidateSingleSitePublicationCheckpoint,
      listJobs: async () => [redeployedJob],
      finalize: async () => finalization(redeployedJob),
      preparePublicationInput: async () => ({
        reportInput: { fixture: true },
        playwrightResults: { suites: [], errors: [] },
        playwrightResultsBytes: Buffer.from('{"suites":[],"errors":[]}'),
        sourceResultsDigest: sha256(Buffer.from('{"suites":[],"errors":[]}')),
        artifactRoot: temporaryRoot,
        terminalState: redeployedJob,
        publicationCheckpoint: redeployedCheckpoint,
      }),
      readPublicationCheckpoint: async () => redeployedCheckpoint,
      preflight: async (input, options) => {
        assert.equal(input.url, redeployedCheckpoint.runContract.url);
        assert.equal(input.deploymentRole, 'preview');
        assert.equal(input.certificatePolicy, 'preview-bypass');
        assert.deepEqual(options.previewBypassOrigins, ['https://beta.quitting7oh-org.pages.dev']);
        assert.equal(options.tlsBypassRequestOptions.rejectUnauthorized, false);
        return {
          schemaVersion: 1,
          accepted: true,
          origin: input.url,
          deploymentRole: input.deploymentRole,
          certificatePolicy: input.certificatePolicy,
          identityFingerprint: redeployedCheckpoint.launchCheckpoint.identityFingerprint,
          deploymentRevision: {
            status: 'verified',
            fingerprint: sha256('publication-checkpoint-revision-after-browser'),
          },
          evidenceAuthority: { status: 'non-authoritative', reasons: ['development-certificate-bypass'] },
          preflightDigest: sha256('publication-checkpoint-after-browser'),
        };
      },
      publishMedia: async () => { forbiddenPublications.push('media'); },
      publishUnavailableMedia: async () => { forbiddenPublications.push('media-unavailable'); },
      publishVisual: async () => { forbiddenPublications.push('visual'); },
      publishGallery: async () => { forbiddenPublications.push('gallery'); },
      publishReport: async () => { forbiddenPublications.push('report'); },
      logStream: redeployedLog,
    },
  });
  assert.equal(redeployedResult.published, 1, 'the fenced terminal INCOMPLETE status is durably published');
  assert.equal(redeployedResult.invalid, 0, 'a mid-run redeploy is incomplete, not corrupt finalization');
  assert.deepEqual(forbiddenPublications, [], 'no final evidence publisher runs after deployment drift');
  const redeployedDirectory = path.join(redeployedOutput, redeployedJob.jobId);
  const redeployedStatus = await readJson(path.join(redeployedDirectory, 'status.json'));
  assert.equal(redeployedStatus.status, 'incomplete');
  assert.equal(redeployedStatus.finalizationDigest, (await readJson(path.join(redeployedDirectory, 'finalization.json'))).finalizationDigest);
  assert.equal(redeployedStatus.reportRevision, null);
  assert.equal(redeployedStatus.mediaStageDigest, null);
  assert.equal(redeployedStatus.visualPublicationDigest, null);
  assert.equal(redeployedStatus.galleryPublicationDigest, null);
  await assert.rejects(fs.lstat(path.join(redeployedDirectory, 'report')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(redeployedDirectory, 'media')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(redeployedDirectory, 'visual')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(redeployedDirectory, 'gallery-publication.json')), { code: 'ENOENT' });
  assert.match(redeployedLog.text(), /deployment-checkpoint-fenced/);

  await fs.rm(path.join(redeployedDirectory, 'finalization.json'));
  await fs.rm(path.join(redeployedDirectory, 'status.json'));

  let fencedRestartCheckpointCalls = 0;
  const redeployedRestart = await runSingleSiteFinalizerPool({
    queue: {},
    outputRoot: redeployedOutput,
    finalizerId: 'finalizer-redeployed-restart',
    pollMs: 100,
    maxCycles: 1,
    dependencies: {
      ...reportDependencies,
      listJobs: async () => [redeployedJob],
      finalize: async () => finalization(redeployedJob),
      preparePublicationInput: async () => { throw new Error('blocked restart must not rebuild publication input'); },
      revalidatePublicationCheckpoint: async () => {
        fencedRestartCheckpointCalls += 1;
        throw new Error('blocked restart must not revalidate or publish');
      },
      logStream: memoryStream(),
    },
  });
  assert.equal(redeployedRestart.published, 1, 'restart repairs the blocked terminal record from its durable fence marker');
  assert.equal(fencedRestartCheckpointCalls, 0);
  assert.equal((await readJson(path.join(redeployedDirectory, 'status.json'))).status, 'incomplete');
  assert.deepEqual((await fs.readdir(redeployedDirectory)).sort(), [
    'finalization.json',
    'publication-blocked.json',
    'status.json',
  ]);

  const matchingPreflight = async (input) => ({
    schemaVersion: 1,
    accepted: true,
    origin: input.url,
    deploymentRole: input.deploymentRole,
    certificatePolicy: input.certificatePolicy,
    identityFingerprint: redeployedCheckpoint.launchCheckpoint.identityFingerprint,
    deploymentRevision: {
      status: 'verified',
      fingerprint: redeployedCheckpoint.launchCheckpoint.revisionFingerprint,
    },
    evidenceAuthority: { status: 'non-authoritative', reasons: ['development-certificate-bypass'] },
    preflightDigest: sha256('matching-final-preflight'),
  });
  const matchedCheckpoint = await revalidateSingleSitePublicationCheckpoint({
    queue: {},
    jobId: redeployedJob.jobId,
    expected: redeployedCheckpoint,
    finalization: finalization(redeployedJob),
    preflight: matchingPreflight,
    readCheckpoint: async () => redeployedCheckpoint,
  });
  assert.equal(matchedCheckpoint.matched, true);
  await assert.rejects(
    () => revalidateSingleSitePublicationCheckpoint({
      queue: {},
      jobId: redeployedJob.jobId,
      expected: redeployedCheckpoint,
      finalization: finalization(redeployedJob),
      preflight: async (input) => ({
        ...(await matchingPreflight(input)),
        deploymentRevision: { status: 'unavailable', fingerprint: null },
        evidenceAuthority: {
          status: 'non-authoritative',
          reasons: ['deployment-revision-unavailable', 'development-certificate-bypass'],
        },
      }),
      readCheckpoint: async () => redeployedCheckpoint,
    }),
    (error) => error?.code === 'SINGLE_SITE_FINALIZER_DEPLOYMENT_UNAVAILABLE',
  );
  const { checkpointDigest: _oldCheckpointDigest, ...advancedFenceBody } = {
    ...redeployedCheckpoint,
    fencingToken: redeployedCheckpoint.fencingToken + 1,
  };
  const advancedFenceCheckpoint = {
    ...advancedFenceBody,
    checkpointDigest: sha256(advancedFenceBody),
  };
  await assert.rejects(
    () => revalidateSingleSitePublicationCheckpoint({
      queue: {},
      jobId: redeployedJob.jobId,
      expected: redeployedCheckpoint,
      finalization: finalization(redeployedJob),
      preflight: matchingPreflight,
      readCheckpoint: async () => advancedFenceCheckpoint,
    }),
    (error) => error?.code === 'SINGLE_SITE_FINALIZER_FENCE_CHANGED',
  );

  const realReportJob = state('job-real-report', 'completed');
  const realReportOutput = path.join(temporaryRoot, 'real-report-finalization');
  const realReportResult = await runSingleSiteFinalizerPool({
    queue: {},
    outputRoot: realReportOutput,
    finalizerId: 'finalizer-real-report',
    pollMs: 100,
    maxCycles: 1,
    dependencies: {
      ...visualDependencies,
      ...mediaDependencies,
      listJobs: async () => [realReportJob],
      finalize: async () => finalization(realReportJob),
      preparePublicationInput: async ({ jobId, generatedAt }) => ({
        reportInput: reportInput(jobId, generatedAt),
        playwrightResults: { suites: [], errors: [] },
        playwrightResultsBytes: Buffer.from('{"suites":[],"errors":[]}'),
        sourceResultsDigest: sha256(Buffer.from('{"suites":[],"errors":[]}')),
        artifactRoot: temporaryRoot,
        terminalState: { attemptId: 'attempt-001' },
      }),
      now: () => Date.parse('2026-08-25T12:00:00.000Z'),
      logStream: memoryStream(),
    },
  });
  assert.equal(realReportResult.published, 1);
  const realReportStatus = await readJson(path.join(realReportOutput, realReportJob.jobId, 'status.json'));
  assert.equal(realReportStatus.status, 'complete');
  const realReportPointer = await readJson(path.join(
    realReportOutput,
    realReportJob.jobId,
    'report',
    'checklist',
    'data',
    'current.json',
  ));
  assert.equal(realReportPointer.publicationRevision, sha256({
    finalizationDigest: realReportStatus.finalizationDigest,
    mediaStageDigest: realReportStatus.mediaStageDigest,
  }).slice(0, 32));
  assert.equal(realReportStatus.reportPublicationDigest.length, 64);

  const crashWindowJob = state('job-report-crash-window', 'completed');
  const crashWindowOutput = path.join(temporaryRoot, 'report-crash-window');
  let reportValidations = 0;
  const crashWindowResult = await runSingleSiteFinalizerPool({
    queue: {},
    outputRoot: crashWindowOutput,
    finalizerId: 'finalizer-report-crash-window',
    pollMs: 100,
    maxCycles: 2,
    dependencies: {
      ...visualDependencies,
      ...mediaDependencies,
      listJobs: async () => [crashWindowJob],
      finalize: async () => finalization(crashWindowJob),
      preparePublicationInput: async ({ jobId, generatedAt }) => ({
        reportInput: reportInput(jobId, generatedAt),
        playwrightResults: { suites: [], errors: [] },
        playwrightResultsBytes: Buffer.from('{"suites":[],"errors":[]}'),
        sourceResultsDigest: sha256(Buffer.from('{"suites":[],"errors":[]}')),
        artifactRoot: temporaryRoot,
        terminalState: { attemptId: 'attempt-001' },
      }),
      validateReport: async (directory) => {
        reportValidations += 1;
        if (reportValidations === 1) {
          const error = new Error('Synthetic restart after report commit.');
          error.code = 'EIO';
          throw error;
        }
        return validateCompleteReportPublication(directory);
      },
      delay: async () => {},
      now: () => Date.parse('2099-02-01T00:00:00.000Z'),
      logStream: memoryStream(),
    },
  });
  assert.equal(crashWindowResult.retryable, 1);
  assert.equal(crashWindowResult.published, 1);
  assert.equal((await readJson(path.join(crashWindowOutput, crashWindowJob.jobId, 'status.json'))).status, 'incomplete');

  const retryableJob = state('job-final-retryable', 'completed');
  let retryableAttempts = 0;
  const retryableOutput = path.join(temporaryRoot, 'retryable-finalization');
  const retryableResult = await runSingleSiteFinalizerPool({
    queue: {},
    outputRoot: retryableOutput,
    finalizerId: 'finalizer-retryable',
    pollMs: 100,
    maxCycles: 2,
    dependencies: {
      ...reportDependencies,
      listJobs: async () => [retryableJob],
      finalize: async () => {
        retryableAttempts += 1;
        if (retryableAttempts === 1) {
          const error = new Error('Temporary volume write failure.');
          error.code = 'EIO';
          throw error;
        }
        return finalization(retryableJob);
      },
      delay: async () => {},
      logStream: memoryStream(),
    },
  });
  assert.equal(retryableResult.retryable, 1);
  assert.equal(retryableResult.published, 1);
  assert.equal(retryableAttempts, 2);
  assert.equal((await readJson(path.join(retryableOutput, retryableJob.jobId, 'status.json'))).status, 'complete');

  const purgeOwnedJob = state('job-purge-owned', 'completed');
  const purgeQueueRoot = path.join(temporaryRoot, 'purge-owned-queue');
  await fs.mkdir(path.join(purgeQueueRoot, '.single-site-purge-locks', purgeOwnedJob.jobId), { recursive: true });
  let purgeOwnedFinalizeCalls = 0;
  const purgeOwnedResult = await runSingleSiteFinalizerPool({
    queue: { root: purgeQueueRoot },
    outputRoot: path.join(temporaryRoot, 'purge-owned-output'),
    finalizerId: 'finalizer-purge-owned',
    pollMs: 100,
    maxCycles: 1,
    dependencies: {
      ...reportDependencies,
      listJobs: async () => [purgeOwnedJob],
      finalize: async () => {
        purgeOwnedFinalizeCalls += 1;
        return finalization(purgeOwnedJob);
      },
      logStream: memoryStream(),
    },
  });
  assert.equal(purgeOwnedFinalizeCalls, 0, 'finalizer must not race a job owned by guarded purge');
  assert.equal(purgeOwnedResult.published, 0);

  const unchangedLog = memoryStream();
  const unchanged = await runSingleSiteFinalizerPool({
    queue: {},
    outputRoot: finalizerOutput,
    finalizerId: 'finalizer-fixture-restart',
    pollMs: 100,
    maxCycles: 1,
    dependencies: {
      ...reportDependencies,
      logStream: unchangedLog,
      listJobs: async () => finalizerJobs.filter(({ jobId }) => jobId !== 'job-final-invalid'),
      finalize: finalizeFixture,
      now: () => Date.parse('2099-02-01T00:00:00.000Z'),
    },
  });
  assert.equal(unchanged.unchanged, 4);
  assert.match(unchangedLog.text(), /finalization-unchanged/);
  assert.equal((await readJson(path.join(finalizerOutput, 'job-final-complete', 'status.json'))).status, 'complete', 'restart does not recalculate immutable status after its deadline');

  const tamperedPath = path.join(finalizerOutput, 'job-final-complete', 'finalization.json');
  const tampered = await readJson(tamperedPath);
  tampered.counts.passed = 99;
  await fs.writeFile(tamperedPath, `${JSON.stringify(tampered)}\n`);
  const tamperLog = memoryStream();
  const tamperResult = await runSingleSiteFinalizerPool({
    queue: {},
    outputRoot: finalizerOutput,
    finalizerId: 'finalizer-tamper-check',
    pollMs: 100,
    maxCycles: 1,
    dependencies: {
      ...reportDependencies,
      logStream: tamperLog,
      listJobs: async () => [finalizerJobs[0]],
      finalize: finalizeFixture,
    },
  });
  assert.equal(tamperResult.invalid, 1);
  assert.match(tamperLog.text(), /finalization-invalid/);
  assert.ok((await fs.readdir(path.join(finalizerOutput, 'job-final-complete'))).some((file) => file.startsWith('failure-')));

  const finalizerDrainOutput = path.join(temporaryRoot, 'finalizer-drain');
  const finalizerDrainController = new AbortController();
  const finalizeActive = deferred();
  const finalizeStarted = deferred();
  let drainedFinalizeCalls = 0;
  const drainingFinalizer = runSingleSiteFinalizerPool({
    queue: {},
    outputRoot: finalizerDrainOutput,
    finalizerId: 'finalizer-drain-fixture',
    pollMs: 100,
    signal: finalizerDrainController.signal,
    dependencies: {
      ...reportDependencies,
      logStream: memoryStream(),
      listJobs: async () => finalizerJobs.slice(0, 2),
      finalize: async ({ jobIds }) => {
        drainedFinalizeCalls += 1;
        finalizeStarted.resolve();
        await finalizeActive.promise;
        const job = finalizerJobs.find(({ jobId }) => jobId === jobIds[0]);
        return finalization(job);
      },
    },
  });
  await finalizeStarted.promise;
  finalizerDrainController.abort(new Error('synthetic finalizer drain'));
  finalizeActive.resolve();
  const drainedFinalizer = await drainingFinalizer;
  assert.equal(drainedFinalizer.drained, true);
  assert.equal(drainedFinalizeCalls, 1, 'finalizer does not accept another terminal job after drain begins');

  const realOutput = path.join(temporaryRoot, 'real-output');
  const symlinkOutput = path.join(temporaryRoot, 'symlink-output');
  await fs.mkdir(realOutput);
  await fs.symlink(realOutput, symlinkOutput);
  await assert.rejects(
    () => runSingleSiteFinalizerPool({
      queue: {},
      outputRoot: symlinkOutput,
      finalizerId: 'finalizer-symlink',
      pollMs: 100,
      maxCycles: 1,
      dependencies: { listJobs: async () => [] },
    }),
    (error) => error?.code === 'SINGLE_SITE_FINALIZER_OUTPUT_UNSAFE',
  );

  console.log('single-site worker/finalizer pool self-test passed');
  console.log('  worker selection: queued plus expired-lease recovery');
  console.log('  claim races: tolerated without duplicate execution');
  console.log('  SIGINT/SIGTERM model: active work drains, no new jobs accepted');
  console.log('  finalization: immutable, digest-bound, restart-idempotent');
  console.log('  incomplete/deadline/invalid states: visibly recorded');
  console.log('  tampered output and secret-bearing errors: contained');
} finally {
  if (previousFenceRoot === undefined) delete process.env.AUDIT_LEGACY_AUTHORITY_FENCE_ROOT;
  else process.env.AUDIT_LEGACY_AUTHORITY_FENCE_ROOT = previousFenceRoot;
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
