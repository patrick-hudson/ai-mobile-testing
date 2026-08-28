import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalSha256 } from '../shared/run-compiler.mjs';
import { openJobQueue, readJob, readJobInput, sha256 } from './lib/job-queue.mjs';
import { finalizeSingleSiteJobs } from './finalize-single-site.mjs';
import { launchSingleSiteJob } from './run-single-site.mjs';
import {
  executeSingleSiteWorker,
  createWorkerLogger,
  playwrightEnvironment,
  queueSubmissionForWorkerInput,
  runPlaywrightCommand,
  validateSingleSiteWorkerInput,
} from './run-single-site-worker.mjs';

async function expectCode(input, code) {
  await assert.rejects(typeof input === 'function' ? input : input, (error) => error?.code === code);
}

const fixtureEgressProxy = async () => ({
  url: 'http://127.0.0.1:32123',
  close: async () => {},
});

function fixtureInput() {
  const runContract = {
    schemaVersion: 1,
    mode: 'single-site',
    url: 'https://beta.quitting7oh-org.pages.dev',
    deploymentRole: 'preview',
    certificatePolicy: 'strict',
    targetIds: ['single-site-mobile-chromium'],
    scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
  };
  const identityFingerprint = sha256('fixture-identity');
  const revisionFingerprint = sha256('fixture-revision');
  const pluginRegistryRevision = canonicalSha256({ schemaVersion: 1, fixture: 'plugins' });
  const targetRegistryRevision = canonicalSha256({ schemaVersion: 1, fixture: 'targets' });
  const manifestBody = {
    schemaVersion: 1,
    kind: 'definition-coverage-manifest',
    mode: 'single-site',
    deployment: {
      url: runContract.url,
      deploymentRole: runContract.deploymentRole,
      certificatePolicy: runContract.certificatePolicy,
      identityFingerprint,
      revision: { status: 'identified', value: revisionFingerprint },
      evidenceAuthority: { status: 'authoritative', reasons: [] },
    },
    revisions: {
      runContract: canonicalSha256(runContract),
      pluginRegistry: pluginRegistryRevision,
      targetRegistry: targetRegistryRevision,
      runner: 'runner-fixture-v1',
    },
    scope: {
      requestedQualifier: 'FULL',
      qualifier: 'FULL',
      filters: { pluginIds: [], auditIds: [], areas: [] },
      selectedTargetIds: [...runContract.targetIds],
      requiredFullProfileTargetIds: [...runContract.targetIds],
      allEligibleDefinitionsSelected: true,
      allEligibleCasesSelected: true,
      allRequiredTargetsSelected: true,
    },
    coverageStatus: 'COMPLETE',
    selectedTargets: [{ targetId: 'single-site-mobile-chromium' }],
    selectedDefinitions: [{ auditId: 'NAV-001', selectedCaseIds: ['NAV-001:history'] }],
    executions: [{
      executionId: 'NAV-001:history@single-site-mobile-chromium',
      pluginId: 'core',
      auditId: 'NAV-001',
      caseId: 'NAV-001:history',
      entrySpec: 'tests/navigation.spec.ts',
      applicability: 'all-targets',
      targetId: 'single-site-mobile-chromium',
      sourceComparativeTargetId: 'candidate-mobile-chromium',
      productOracleVariant: 'history-navigation',
      productOracleExpected: 'The browser history state changes after navigation.',
    }],
    coverageGaps: [],
    omissions: { definitions: [], cases: [], targets: [] },
    outsideMode: [],
    counts: { selectedDefinitions: 1, executableCases: 1, plannedExecutions: 1 },
  };
  const coverageManifest = { ...manifestBody, manifestDigest: canonicalSha256(manifestBody) };
  const routePlanBody = {
    schemaVersion: 1,
    kind: 'single-site-route-inventory-plan',
    coverageManifestDigest: coverageManifest.manifestDigest,
    required: true,
    reason: 'FULL scope requires live route inventory before browser execution.',
    reviewedRoutes: [],
    entryPoints: ['/'],
    canonicalTargetId: 'single-site-mobile-chromium',
  };
  return {
    schemaVersion: 1,
    kind: 'single-site-worker-input',
    runContract,
    coverageManifest,
    routeInventoryPlan: { ...routePlanBody, planDigest: canonicalSha256(routePlanBody) },
    launchCheckpoint: {
      preflightDigest: sha256('fixture-preflight'),
      identityFingerprint,
      revisionFingerprint,
      evidenceAuthority: { authoritative: true, reasons: [] },
    },
    runnerRevision: 'runner-fixture-v1',
  };
}

function fixtureRouteInventory(input = fixtureInput()) {
  return {
    schemaVersion: 1,
    kind: 'live-route-inventory-diagnostic',
    origin: input.runContract.url,
    capabilities: {
      scriptExecution: false,
      browserRendering: false,
      formSubmission: false,
      productOracleDerivation: false,
      findingDerivation: false,
    },
    limits: {},
    sources: {},
    fetchEvidence: [],
    failures: [],
    exclusions: [],
    limitations: [],
    inventory: {
      schemaVersion: 1,
      origin: input.runContract.url,
      limits: {},
      sources: [],
      routes: [],
      exclusions: [],
      failures: [],
      limitations: [],
      responses: [],
      redirects: [],
      bounds: [],
      summary: { routes: 0, exclusions: 0, failures: 0, limitations: 0, responses: 0, redirects: 0, htmlBytesConsumed: 0 },
    },
  };
}

function fixtureLaunch(idempotencyKey, inputDocument = fixtureInput()) {
  return {
    schemaVersion: 1,
    kind: 'single-site-job-launch',
    idempotencyKey,
    stageDeadlines: {
      browser: '2099-01-01T00:10:00.000Z',
      finalizer: '2099-01-01T00:20:00.000Z',
    },
    inputDocument,
  };
}

function acceptedPreflight(input = fixtureInput()) {
  return {
    schemaVersion: 1,
    accepted: true,
    checkedAt: '2026-08-25T12:00:00.000Z',
    origin: input.runContract.url,
    deploymentRole: input.runContract.deploymentRole,
    certificatePolicy: input.runContract.certificatePolicy,
    identityFingerprint: input.launchCheckpoint.identityFingerprint,
    deploymentRevision: {
      status: 'verified',
      source: 'explicit-build-id',
      fingerprint: input.launchCheckpoint.revisionFingerprint,
      signals: [],
      limitation: null,
    },
    evidenceAuthority: { status: 'authoritative', reasons: [] },
    markers: [{ id: 'root-home-heading', probe: 'root', expected: 'Help quitting 7-OH', observed: 'Help quitting 7-OH', passed: true }],
    probes: [{
      id: 'root',
      requestedUrl: `${input.runContract.url}/`,
      finalUrl: `${input.runContract.url}/`,
      statusCode: 200,
      contentType: 'text/html',
      etag: 'fixture-etag',
      lastModified: null,
      hops: [{
        url: `${input.runContract.url}/`,
        statusCode: 200,
        resolvedAddresses: ['203.0.113.10'],
        connectedAddress: '203.0.113.10',
        location: null,
      }],
      error: null,
    }],
    issues: [],
    preflightDigest: input.launchCheckpoint.preflightDigest,
  };
}

function runtimeRevisions(input) {
  return {
    registryRevision: input.coverageManifest.revisions.pluginRegistry,
    targetSetRevision: input.coverageManifest.revisions.targetRegistry,
    runnerRevision: input.runnerRevision,
    compiledManifestDigest: input.coverageManifest.manifestDigest.slice('sha256:'.length),
  };
}

function memoryStream() {
  let output = '';
  return {
    write(value) { output += value; },
    text() { return output; },
  };
}

function fakeCommand(exitCode, { publishEvidence = true, signal = null, delayMs = 0, inspectEnvironment = null } = {}) {
  return async ({ environment, logger, artifactRoot }) => {
    inspectEnvironment?.(environment);
    logger.emit('command-started', { command: ['playwright', 'test'], selectedCaseCount: JSON.parse(environment.AUDIT_SINGLE_SITE_CASE_IDS).length });
    logger.emit('command-output', { channel: 'stdout', line: 'GET / returned HTTP 200' });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (publishEvidence) {
      await fs.mkdir(artifactRoot, { recursive: true });
      await fs.writeFile(path.join(artifactRoot, 'results.json'), `${JSON.stringify({ suites: [], errors: [] })}\n`);
    }
    const result = { exitCode, signal, spawnError: null, durationMs: delayMs };
    logger.emit('command-finished', result);
    return result;
  };
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-worker-'));
try {
  const queue = await openJobQueue({
    root: path.join(temporaryRoot, 'queue'),
    heartbeatMs: 100,
    leaseMs: 1_000,
  });
  const input = fixtureInput();
  const validated = validateSingleSiteWorkerInput(input);
  assert.deepEqual(validated.selectedCaseIds, ['NAV-001:history']);
  assert.deepEqual(validated.selectedTargetIds, ['single-site-mobile-chromium']);
  const submission = queueSubmissionForWorkerInput(input, {
    idempotencyKey: 'fixture-binding',
    stageDeadlines: fixtureLaunch('fixture-binding').stageDeadlines,
  });
  assert.equal(submission.inputDocumentDigest, sha256(input));

  const commandLog = memoryStream();
  const commandLogger = createWorkerLogger({
    jobId: 'job-command-fixture',
    claim: {
      attemptId: 'attempt-command-fixture',
      attemptNumber: 1,
      fencingToken: 1,
    },
    stream: commandLog,
  });
  const commandEnvironment = playwrightEnvironment({ PATH: process.env.PATH, HOME: process.env.HOME }, validated, '/tmp/artifacts');
  assert.equal(commandEnvironment.AUDIT_RUNNER_REVISION, validated.runnerRevision);
  const realExitOne = await runPlaywrightCommand({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("request returned HTTP 200\\n"); process.stderr.write("ffmpeg fixture\\n"); process.exit(1)'],
    environment: commandEnvironment,
    logger: commandLogger,
    cwd: temporaryRoot,
  });
  assert.equal(realExitOne.exitCode, 1);
  assert.equal(realExitOne.signal, null);
  assert.match(commandLog.text(), /request returned HTTP 200/);
  assert.match(commandLog.text(), /ffmpeg fixture/);
  const signalController = new AbortController();
  const signalledCommandPromise = runPlaywrightCommand({
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    environment: commandEnvironment,
    logger: commandLogger,
    signal: signalController.signal,
    cwd: temporaryRoot,
  });
  setTimeout(() => signalController.abort(new Error('synthetic cancellation')), 50);
  const realSignal = await signalledCommandPromise;
  assert.equal(realSignal.exitCode, null);
  assert.equal(realSignal.signal, 'SIGTERM');
  assert.match(commandLog.text(), /command-abort-requested/);

  const stubbornController = new AbortController();
  const stubbornCommandPromise = runPlaywrightCommand({
    executable: process.execPath,
    args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    environment: commandEnvironment,
    logger: commandLogger,
    signal: stubbornController.signal,
    cwd: temporaryRoot,
    terminationGraceMs: 50,
    killSettleMs: 250,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  stubbornController.abort(new Error('synthetic stubborn cancellation'));
  const stubbornSignal = await stubbornCommandPromise;
  assert.equal(stubbornSignal.exitCode, null);
  assert.equal(stubbornSignal.signal, 'SIGKILL');
  assert.equal(stubbornSignal.forceKilled, true, 'SIGTERM-ignoring Playwright trees are force-killed after the grace bound');
  assert.match(commandLog.text(), /command-force-kill-requested/);

  const secretInput = structuredClone(input);
  secretInput.coverageManifest.selectedDefinitions[0].note = 'Bearer definitely-secret-value';
  const { manifestDigest: _oldDigest, ...secretManifestBody } = secretInput.coverageManifest;
  secretInput.coverageManifest.manifestDigest = canonicalSha256(secretManifestBody);
  assert.throws(() => validateSingleSiteWorkerInput(secretInput), (error) => error?.code === 'SINGLE_SITE_INPUT_SECRET');

  const passedLaunch = await launchSingleSiteJob({ queue, launchDocument: fixtureLaunch('worker-passed') });
  assert.equal(passedLaunch.created, true);
  assert.equal((await launchSingleSiteJob({ queue, launchDocument: fixtureLaunch('worker-passed') })).created, false);
  assert.deepEqual(await readJobInput(queue, passedLaunch.jobId), input);
  const passedLog = memoryStream();
  const passed = await executeSingleSiteWorker({
    queue,
    jobId: passedLaunch.jobId,
    workerId: 'worker-passed',
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AUDIT_RUNNER_REVISION: input.runnerRevision,
      AUDIT_WORKERS: '2',
      ANTHROPIC_API_KEY: 'sk-ant-api03-must-never-reach-playwright',
    },
    dependencies: {
      startEgressProxy: fixtureEgressProxy,
      buildRouteInventory: async () => fixtureRouteInventory(input),
      preflight: async () => acceptedPreflight(input),
      runtimeRevisions,
      runCommand: fakeCommand(0, {
        delayMs: 250,
        inspectEnvironment(environment) {
          assert.equal(environment.AUDIT_RUN_MODE, 'single-site');
          assert.equal(environment.AUDIT_SINGLE_SITE_URL, input.runContract.url);
          assert.equal(environment.AUDIT_SINGLE_SITE_ROLE, 'preview');
          assert.equal(environment.AUDIT_SINGLE_SITE_CERTIFICATE_POLICY, 'strict');
          assert.equal(environment.AUDIT_RUNNER_REVISION, input.runnerRevision);
          assert.equal(environment.AUDIT_TARGET_IDS, 'single-site-mobile-chromium');
          assert.equal(environment.AUDIT_SINGLE_SITE_CASE_IDS, '["NAV-001:history"]');
          assert.equal(environment.AUDIT_WORKERS, '2');
          assert.equal(environment.AUDIT_SINGLE_SITE_EGRESS_PROXY, 'http://127.0.0.1:32123');
          assert.equal(environment.ANTHROPIC_API_KEY, undefined);
        },
      }),
      logStream: passedLog,
    },
  });
  assert.equal(passed.state.executionState, 'completed');
  assert.equal(passed.state.result.kind, 'passed');
  assert.ok(passed.state.events.filter(({ type }) => type === 'heartbeat').length >= 2, 'independent heartbeat continued during command');
  assert.match(passedLog.text(), /"event":"request-outcome"/);
  assert.match(passedLog.text(), /"responseCode":200/);
  assert.doesNotMatch(passedLog.text(), /must-never-reach-playwright/);
  assert.equal(passed.result.command.exitCode, 0);
  assert.equal(passed.result.command.signal, null);

  const findingsLaunch = await launchSingleSiteJob({ queue, launchDocument: fixtureLaunch('worker-findings') });
  const findings = await executeSingleSiteWorker({
    queue,
    jobId: findingsLaunch.jobId,
    workerId: 'worker-findings',
    environment: { AUDIT_RUNNER_REVISION: input.runnerRevision },
    dependencies: {
      startEgressProxy: fixtureEgressProxy,
      buildRouteInventory: async () => fixtureRouteInventory(input),
      preflight: async () => acceptedPreflight(input),
      runtimeRevisions,
      runCommand: fakeCommand(1),
      logStream: memoryStream(),
    },
  });
  assert.equal(findings.state.executionState, 'completed');
  assert.equal(findings.state.result.kind, 'findings');
  assert.equal(findings.state.infrastructureRetriesUsed, 0);

  const missingEvidenceLaunch = await launchSingleSiteJob({ queue, launchDocument: fixtureLaunch('worker-missing-evidence') });
  const firstMissing = await executeSingleSiteWorker({
    queue,
    jobId: missingEvidenceLaunch.jobId,
    workerId: 'worker-missing-first',
    environment: { AUDIT_RUNNER_REVISION: input.runnerRevision },
    dependencies: {
      startEgressProxy: fixtureEgressProxy,
      buildRouteInventory: async () => fixtureRouteInventory(input),
      preflight: async () => acceptedPreflight(input),
      runtimeRevisions,
      runCommand: fakeCommand(1, { publishEvidence: false }),
      logStream: memoryStream(),
    },
  });
  assert.equal(firstMissing.state.executionState, 'queued');
  assert.equal(firstMissing.state.infrastructureRetriesUsed, 1);
  const secondMissing = await executeSingleSiteWorker({
    queue,
    jobId: missingEvidenceLaunch.jobId,
    workerId: 'worker-missing-second',
    environment: { AUDIT_RUNNER_REVISION: input.runnerRevision },
    dependencies: {
      startEgressProxy: fixtureEgressProxy,
      buildRouteInventory: async () => fixtureRouteInventory(input),
      preflight: async () => acceptedPreflight(input),
      runtimeRevisions,
      runCommand: fakeCommand(1, { publishEvidence: false }),
      logStream: memoryStream(),
    },
  });
  assert.equal(secondMissing.state.executionState, 'incomplete');
  assert.equal(secondMissing.state.infrastructureRetriesUsed, 1);
  assert.equal(secondMissing.result.classification, 'infrastructure-failure');
  assert.match(secondMissing.result.reason, /fresh structured evidence/);

  const signalLaunch = await launchSingleSiteJob({ queue, launchDocument: fixtureLaunch('worker-signal') });
  const signalled = await executeSingleSiteWorker({
    queue,
    jobId: signalLaunch.jobId,
    workerId: 'worker-signal',
    environment: { AUDIT_RUNNER_REVISION: input.runnerRevision },
    dependencies: {
      startEgressProxy: fixtureEgressProxy,
      buildRouteInventory: async () => fixtureRouteInventory(input),
      preflight: async () => acceptedPreflight(input),
      runtimeRevisions,
      runCommand: fakeCommand(null, { publishEvidence: false, signal: 'SIGTERM' }),
      logStream: memoryStream(),
    },
  });
  assert.equal(signalled.state.executionState, 'queued');
  assert.equal(signalled.result.command.signal, 'SIGTERM');
  assert.match(signalled.result.reason, /SIGTERM/);

  const changedInput = fixtureInput();
  const changedLaunch = await launchSingleSiteJob({ queue, launchDocument: fixtureLaunch('worker-redeploy', changedInput) });
  let commandWasRun = false;
  const changedPreflight = acceptedPreflight(changedInput);
  changedPreflight.deploymentRevision.fingerprint = sha256('new-deployment');
  changedPreflight.preflightDigest = sha256('new-preflight');
  const redeployed = await executeSingleSiteWorker({
    queue,
    jobId: changedLaunch.jobId,
    workerId: 'worker-redeploy',
    environment: { AUDIT_RUNNER_REVISION: input.runnerRevision },
    dependencies: {
      startEgressProxy: fixtureEgressProxy,
      buildRouteInventory: async () => fixtureRouteInventory(input),
      preflight: async () => changedPreflight,
      runtimeRevisions,
      runCommand: async () => { commandWasRun = true; },
      logStream: memoryStream(),
    },
  });
  assert.equal(redeployed.state.executionState, 'incomplete');
  assert.equal(commandWasRun, false);
  assert.ok(redeployed.state.publications.some(({ relativePath }) => relativePath === 'worker/checkpoint.json'));

  const finalizationA = await finalizeSingleSiteJobs({
    queue,
    jobIds: [findingsLaunch.jobId, passedLaunch.jobId, missingEvidenceLaunch.jobId],
  });
  const finalizationB = await finalizeSingleSiteJobs({
    queue,
    jobIds: [missingEvidenceLaunch.jobId, passedLaunch.jobId, findingsLaunch.jobId],
  });
  assert.deepEqual(finalizationA, finalizationB, 'finalizer output is independent of input order');
  assert.equal(finalizationA.counts.jobs, 3);
  assert.equal(finalizationA.counts.completed, 2);
  assert.equal(finalizationA.counts.incomplete, 1);
  assert.equal(finalizationA.counts.passed, 1);
  assert.equal(finalizationA.counts.findings, 1);
  const missingRow = finalizationA.jobs.find(({ jobId }) => jobId === missingEvidenceLaunch.jobId);
  assert.ok(missingRow.publications.every(({ attemptNumber }) => attemptNumber === 2), 'finalizer excludes stale retry-attempt publications');
  assert.equal(missingRow.publications.some(({ attemptNumber }) => attemptNumber === 1), false);
  assert.equal(finalizationA.finalizationDigest, sha256({
    schemaVersion: finalizationA.schemaVersion,
    kind: finalizationA.kind,
    mode: finalizationA.mode,
    runContractDigest: finalizationA.runContractDigest,
    compiledManifestDigest: finalizationA.compiledManifestDigest,
    jobs: finalizationA.jobs,
    counts: finalizationA.counts,
  }));

  await expectCode(
    () => finalizeSingleSiteJobs({ queue, jobIds: [passedLaunch.jobId, passedLaunch.jobId] }),
    'SINGLE_SITE_FINALIZER_INVALID',
  );
  await expectCode(
    () => finalizeSingleSiteJobs({ queue, jobIds: [signalLaunch.jobId] }),
    'SINGLE_SITE_FINALIZER_NOT_READY',
  );

  const passedState = await readJob(queue, passedLaunch.jobId);
  const passedResultPublication = passedState.publications.find(({ relativePath, attemptNumber }) => (
    relativePath === 'worker/attempt-result.json' && attemptNumber === passedState.attemptNumber
  ));
  assert.ok(passedResultPublication);
  const passedResultPath = path.join(
    queue.root,
    'jobs',
    passedLaunch.jobId,
    'attempts',
    passedResultPublication.attemptId,
    'published',
    'worker',
    'attempt-result.json',
  );
  const tamperedResult = JSON.parse(await fs.readFile(passedResultPath, 'utf8'));
  tamperedResult.classification = 'assertion-failure';
  await fs.writeFile(passedResultPath, `${JSON.stringify(tamperedResult)}\n`);
  await expectCode(
    () => finalizeSingleSiteJobs({ queue, jobIds: [passedLaunch.jobId] }),
    'SINGLE_SITE_FINALIZER_EVIDENCE_INVALID',
  );

  const safeEnvironment = playwrightEnvironment({
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-api03-never',
    HTTPS_PROXY: 'https://user:password@proxy.example',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/netskope.pem',
  }, validated, '/tmp/artifacts');
  assert.equal(safeEnvironment.ANTHROPIC_API_KEY, undefined);
  assert.equal(safeEnvironment.HTTPS_PROXY, undefined);
  assert.equal(safeEnvironment.NODE_EXTRA_CA_CERTS, '/etc/ssl/netskope.pem');

  console.log('single-site worker/finalizer self-test passed');
  console.log('  exact Playwright environment: verified and secret-filtered');
  console.log('  request/response/command/exit/signal logs: retained');
  console.log('  exit 0: passed; exit 1 + fresh evidence: findings');
  console.log('  missing evidence: one infrastructure retry, then incomplete');
  console.log('  deployment change: fenced before Playwright');
  console.log('  deterministic finalizer: current attempt only');
  console.log('  finalizer integrity: tampered publication rejected');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
