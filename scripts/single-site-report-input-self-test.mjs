import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalSha256 } from '../shared/run-compiler.mjs';
import {
  cancelJob,
  claimJob,
  openJobQueue,
  publishAttemptDocument,
  settleJobAttempt,
  sha256,
  submitJob,
} from './lib/job-queue.mjs';
import { buildSingleSiteReportInput } from './lib/single-site-report-input.mjs';
import { buildSingleSiteReportDocuments } from './lib/site-health-report.mjs';
import { queueSubmissionForWorkerInput } from './run-single-site-worker.mjs';

const generatedAt = '2026-08-25T18:00:00.000Z';
const revision = '0123456789abcdef0123456789abcdef';

function workerInput() {
  const runContract = {
    schemaVersion: 1,
    mode: 'single-site',
    url: 'https://beta.quitting7oh-org.pages.dev',
    deploymentRole: 'preview',
    certificatePolicy: 'preview-bypass',
    targetIds: ['single-site-mobile-chromium', 'single-site-desktop-chromium'],
    scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['NAV-001', 'HOME-001', 'DEVICE-001', 'SEARCH-099'], areas: [] },
  };
  const identityFingerprint = sha256('report-input-identity');
  const revisionFingerprint = sha256('report-input-revision');
  const caseNav = 'NAV-001:tests/navigation.spec.ts:candidate-projects';
  const caseHome = 'HOME-001:tests/smoke.spec.ts:all-projects';
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
      evidenceAuthority: { status: 'non-authoritative', reasons: ['development-certificate-bypass'] },
    },
    revisions: {
      runContract: canonicalSha256(runContract),
      pluginRegistry: canonicalSha256({ schemaVersion: 1, fixture: 'plugins' }),
      targetRegistry: canonicalSha256({ schemaVersion: 1, fixture: 'targets' }),
      runner: 'report-input-fixture-v1',
    },
    scope: {
      requestedQualifier: 'TARGETED',
      qualifier: 'TARGETED',
      filters: { pluginIds: [], auditIds: [...runContract.scope.auditIds], areas: [] },
      selectedTargetIds: [...runContract.targetIds],
      requiredFullProfileTargetIds: [...runContract.targetIds],
      allEligibleDefinitionsSelected: false,
      allEligibleCasesSelected: false,
      allRequiredTargetsSelected: true,
    },
    coverageStatus: 'GAPS',
    selectedTargets: runContract.targetIds.map((targetId) => ({ targetId })),
    selectedDefinitions: [
      {
        pluginId: 'core', auditId: 'DEVICE-001', area: 'responsive', title: 'Real-device acceptance', severity: 'P1',
        manual: true, singleSiteClassification: 'standalone-required', selectedCaseIds: [], executionIds: [],
      },
      {
        pluginId: 'core', auditId: 'HOME-001', area: 'homepage', title: 'Homepage shell', severity: 'P1',
        manual: false, singleSiteClassification: 'standalone-compatible', selectedCaseIds: [caseHome],
        executionIds: [`${caseHome}@single-site-mobile-chromium`],
      },
      {
        pluginId: 'core', auditId: 'CONTENT-001', area: 'content', title: 'Desktop document structure', severity: 'P1',
        manual: false, singleSiteClassification: 'standalone-compatible', selectedCaseIds: [], executionIds: [],
      },
      {
        pluginId: 'core', auditId: 'NAV-001', area: 'navigation', title: 'Browser navigation', severity: 'P0',
        manual: false, singleSiteClassification: 'standalone-compatible', selectedCaseIds: [caseNav],
        executionIds: [
          `${caseNav}@single-site-desktop-chromium`,
          `${caseNav}@single-site-mobile-chromium`,
        ],
      },
      {
        pluginId: 'core', auditId: 'SEARCH-099', area: 'search', title: 'Future standalone search oracle', severity: 'P2',
        manual: false, singleSiteClassification: 'standalone-required', selectedCaseIds: [], executionIds: [],
      },
    ],
    executions: [
      {
        executionId: `${caseHome}@single-site-mobile-chromium`, pluginId: 'core', auditId: 'HOME-001', caseId: caseHome,
        entrySpec: 'tests/smoke.spec.ts', applicability: 'all-projects', targetId: 'single-site-mobile-chromium',
        sourceComparativeTargetId: 'candidate-mobile-chromium', productOracleVariant: 'home-shell', productOracleExpected: 'The home shell renders.',
      },
      ...['single-site-desktop-chromium', 'single-site-mobile-chromium'].map((targetId) => ({
        executionId: `${caseNav}@${targetId}`, pluginId: 'core', auditId: 'NAV-001', caseId: caseNav,
        entrySpec: 'tests/navigation.spec.ts', applicability: 'candidate-projects', targetId,
        sourceComparativeTargetId: targetId.includes('desktop') ? 'candidate-desktop-chromium' : 'candidate-mobile-chromium',
        productOracleVariant: 'history-navigation', productOracleExpected: 'Back and forward navigation preserve state.',
      })),
    ],
    coverageGaps: [{
      kind: 'missing-standalone-case', pluginId: 'core', auditId: 'SEARCH-099', classification: 'standalone-required',
      detail: 'Selected automated Audit Definition has no executable Single-site Product Oracle variant.',
    }],
    omissions: {
      definitions: [{ auditId: 'CONTENT-007', disposition: 'operator-scope-omission' }],
      cases: [
        { auditId: 'CONTENT-001', caseId: 'CONTENT-001:desktop-only', disposition: 'operator-target-omission' },
        { auditId: 'NAV-001', caseId: 'NAV-008:omitted', disposition: 'operator-target-omission' },
      ],
      targets: [{ targetId: 'single-site-tablet-webkit', disposition: 'operator-omitted-required-target' }],
    },
    outsideMode: [{
      auditId: 'CONTENT-008', title: 'Production migration parity', area: 'content', severity: 'P1', manual: false,
      singleSiteClassification: 'comparison-only', disposition: 'outside-single-site-mode', comparativeCaseIds: ['CONTENT-008:parity'],
    }],
    counts: {
      selectedDefinitions: 5, executableCases: 2, plannedExecutions: 3, manualDefinitions: 1,
      coverageGaps: 1, omittedDefinitions: 1, outsideModeDefinitions: 1,
    },
  };
  const coverageManifest = { ...manifestBody, manifestDigest: canonicalSha256(manifestBody) };
  const routePlanBody = {
    schemaVersion: 1,
    kind: 'single-site-route-inventory-plan',
    coverageManifestDigest: coverageManifest.manifestDigest,
    required: false,
    reason: 'Targeted scope omitted route coverage; discovery is intentionally not executed and is not a Coverage Gap.',
    reviewedRoutes: [],
    entryPoints: ['/'],
    canonicalTargetId: null,
  };
  return {
    schemaVersion: 1,
    kind: 'single-site-worker-input',
    runContract,
    coverageManifest,
    routeInventoryPlan: { ...routePlanBody, planDigest: canonicalSha256(routePlanBody) },
    launchCheckpoint: {
      preflightDigest: sha256('report-input-preflight'),
      identityFingerprint,
      revisionFingerprint,
      evidenceAuthority: { authoritative: false, reasons: ['development-certificate-bypass'] },
    },
    runnerRevision: 'report-input-fixture-v1',
  };
}

function auditAttachment(input, { caseId, auditId, project, findings = [] }) {
  const record = {
    schemaVersion: 1,
    mode: 'single-site',
    caseId,
    auditId,
    project,
    baseURL: input.runContract.url,
    deploymentRole: input.runContract.deploymentRole,
    evidenceAuthority: input.coverageManifest.deployment.evidenceAuthority,
    findings,
  };
  return { name: 'audit-result', contentType: 'application/json', body: Buffer.from(JSON.stringify(record)).toString('base64') };
}

function testResult(input, execution, {
  resultStatus = 'passed',
  testStatus = resultStatus === 'passed' ? 'expected' : 'unexpected',
  attempts = 1,
  findings = [],
  error = null,
} = {}) {
  const results = Array.from({ length: attempts }, (_, index) => ({
    status: index === attempts - 1 ? resultStatus : 'failed',
    retry: index,
    errors: index === attempts - 1 && error ? [{ message: error }] : [],
    attachments: [
      auditAttachment(input, { ...execution, project: execution.targetId, findings }),
      { name: 'screenshot', contentType: 'image/png', path: `/evidence/${execution.executionId}.png` },
    ],
  }));
  return {
    timeout: 60_000,
    annotations: [{ type: 'audit-case-id', description: execution.caseId }],
    expectedStatus: 'passed',
    projectId: execution.targetId,
    projectName: execution.targetId,
    results,
    status: testStatus,
  };
}

function playwrightDocument(input, variants = {}) {
  const tests = input.coverageManifest.executions
    .filter((execution) => !variants.missing?.includes(execution.executionId))
    .map((execution) => testResult(input, execution, variants[execution.executionId]));
  if (variants.unexpected) tests.push({
    annotations: [{ type: 'audit-case-id', description: 'UNKNOWN-001:case' }],
    expectedStatus: 'passed', projectName: 'single-site-mobile-chromium', status: 'expected',
    results: [{ status: 'passed', retry: 0, errors: [], attachments: [] }],
  });
  return { suites: [{ title: 'fixture', specs: [{ title: 'fixture audit', tests }], suites: [] }], errors: [] };
}

async function terminalJob(queue, input, document, settlementKind, suffix) {
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  const submission = queueSubmissionForWorkerInput(input, {
    idempotencyKey: `report-input-${suffix}`,
    stageDeadlines: { browser: '2099-01-01T00:10:00.000Z', finalizer: '2099-01-01T00:20:00.000Z' },
  });
  const submitted = await submitJob(queue, submission, { inputDocument: input });
  const claim = await claimJob(queue, submitted.state.jobId, `worker-${suffix}`);
  const workerResult = {
    schemaVersion: 1,
    kind: 'single-site-worker-result',
    jobId: claim.jobId,
    attemptId: claim.attemptId,
    attemptNumber: claim.attemptNumber,
    fencingToken: claim.fencingToken,
    classification: settlementKind === 'assertion-failure' ? 'assertion-failure' : 'success',
    reason: settlementKind === 'assertion-failure' ? 'Playwright exit 1 with fresh structured evidence.' : null,
    command: { executable: 'playwright', args: ['test'], exitCode: settlementKind === 'assertion-failure' ? 1 : 0, signal: null, spawnError: null, durationMs: 10 },
    freshEvidence: { fresh: true, reason: null, relativePath: 'results.json', bytes: bytes.length, digest: sha256(bytes) },
    artifactRoot: `attempts/${claim.attemptId}/artifacts`,
    log: [],
  };
  await publishAttemptDocument(queue, claim, {
    publicationId: `attempt-${claim.attemptNumber}-worker-result`,
    relativePath: 'worker/attempt-result.json',
    document: workerResult,
  });
  const state = await settleJobAttempt(queue, claim, { kind: settlementKind, reason: workerResult.reason });
  return { state, workerResult, document, bytes };
}

function build(input, terminal, overrides = {}) {
  return buildSingleSiteReportInput({
    workerInput: input,
    terminalState: terminal.state,
    workerResult: terminal.workerResult,
    playwrightResults: terminal.document,
    playwrightResultsBytes: terminal.bytes,
    generatedAt,
    ...overrides,
  });
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-report-input-'));
try {
  const queue = await openJobQueue({ root: path.join(temporaryRoot, 'queue'), verifyStorage: false });
  const input = workerInput();
  const [home, navDesktop] = [input.coverageManifest.executions[0], input.coverageManifest.executions[1]];

  const structured = playwrightDocument(input, {
    [home.executionId]: { findings: [{ severity: 'P3', title: 'Visible shell issue', detail: 'The home shell is visibly displaced.', blocking: false }] },
  });
  const structuredTerminal = await terminalJob(queue, input, structured, 'success', 'structured');
  const structuredReport = build(input, structuredTerminal);
  assert.equal(structuredReport.health.findings.length, 1);
  assert.equal(structuredReport.health.findings[0].severity, 'P1', 'Compiler Audit Definition severity is authoritative.');
  assert.equal(structuredReport.audits.find(({ id }) => id === 'HOME-001').status, 'FAIL');
  assert.equal(structuredReport.audits.find(({ id }) => id === 'DEVICE-001').status, 'MANUAL_REQUIRED');
  assert.equal(structuredReport.audits.find(({ id }) => id === 'SEARCH-099').status, 'NOT_RUN');
  assert.equal(structuredReport.audits.find(({ id }) => id === 'SEARCH-099').evidenceStatus, 'complete');
  assert.equal(structuredReport.audits.find(({ id }) => id === 'CONTENT-001').status, 'NOT_RUN');
  assert(structuredReport.health.scope.omittedCoverage.includes('case:CONTENT-001:desktop-only'));
  assert.equal(structuredReport.outsideMode[0].auditId, 'CONTENT-008');
  assert(!structuredReport.audits.some(({ id }) => id === 'CONTENT-007'), 'Operator omissions must not become audit rows.');
  assert(!structuredReport.audits.some(({ id }) => id === 'CONTENT-008'), 'Comparison-only definitions stay outside mode.');
  assert(structuredReport.health.scope.omittedCoverage.includes('definition:CONTENT-007'));
  assert.equal(structuredReport.health.evidenceAuthority.status, 'non-authoritative');
  assert(structuredReport.audits.every(({ visualStatus }) => visualStatus === 'absent'));
  assert.equal(structuredReport.health.pipeline.integrityComplete, true);
  assert.equal(buildSingleSiteReportDocuments(structuredReport, { publicationRevision: revision }).summary.siteHealth.verdict, 'FINDINGS');

  const processedDocument = structuredClone(structuredTerminal.document);
  const processedBytes = Buffer.from(`${JSON.stringify(processedDocument)}\n`);
  const mediaBody = {
    schemaVersion: 1,
    kind: 'single-site-media-stage',
    mode: 'single-site',
    sourceResultsDigest: structuredTerminal.workerResult.freshEvidence.digest,
    sourceResultsBytes: structuredTerminal.bytes.length,
    processedResultsDigest: sha256(processedBytes),
    processedResultsBytes: processedBytes.length,
    videoManifestDigest: sha256('video-manifest-fixture'),
    qualityState: 'complete',
    integrityErrors: [],
  };
  const processedReport = build(input, structuredTerminal, {
    processedPlaywrightResults: processedDocument,
    processedPlaywrightResultsBytes: processedBytes,
    mediaStage: { ...mediaBody, mediaStageDigest: sha256(mediaBody) },
  });
  assert.equal(processedReport.health.pipeline.integrityComplete, true, 'digest-bound processed results remain authoritative');
  const rejectedMediaBody = {
    ...mediaBody,
    qualityState: 'incomplete',
    integrityErrors: ['Required action clip was blank or too short.'],
  };
  const rejectedMediaReport = build(input, structuredTerminal, {
    processedPlaywrightResults: processedDocument,
    processedPlaywrightResultsBytes: processedBytes,
    mediaStage: { ...rejectedMediaBody, mediaStageDigest: sha256(rejectedMediaBody) },
  });
  assert.equal(rejectedMediaReport.health.pipeline.requiredEvidenceComplete, false);
  assert.equal(rejectedMediaReport.health.pipeline.integrityComplete, false);
  assert.match(rejectedMediaReport.health.pipeline.reason, /blank or too short/);
  assert.equal(buildSingleSiteReportDocuments(rejectedMediaReport, { publicationRevision: revision }).summary.siteHealth.verdict, 'INCOMPLETE');

  const assertion = playwrightDocument(input, {
    [navDesktop.executionId]: { resultStatus: 'failed', testStatus: 'unexpected', error: 'Expected navigation state, received a blank page.' },
  });
  const assertionTerminal = await terminalJob(queue, input, assertion, 'assertion-failure', 'assertion');
  const assertionReport = build(input, assertionTerminal);
  const assertionFinding = assertionReport.health.findings.find(({ source }) => source === 'playwright-assertion');
  assert.equal(assertionFinding.severity, 'P0');
  assert.equal(assertionReport.audits.find(({ id }) => id === 'NAV-001').status, 'FAIL');
  assert.equal(assertionReport.health.pipeline.integrityComplete, true);
  assert.equal(buildSingleSiteReportDocuments(assertionReport, { publicationRevision: revision }).summary.siteHealth.verdict, 'FINDINGS');

  const flaky = playwrightDocument(input, {
    [home.executionId]: { attempts: 2, resultStatus: 'passed', testStatus: 'flaky' },
  });
  const flakyReport = build(input, await terminalJob(queue, input, flaky, 'success', 'flaky'));
  assert.equal(flakyReport.audits.find(({ id }) => id === 'HOME-001').status, 'FLAKY');
  assert.equal(flakyReport.health.pipeline.integrityComplete, false);
  assert.equal(buildSingleSiteReportDocuments(flakyReport, { publicationRevision: revision }).summary.siteHealth.verdict, 'INCOMPLETE');

  const missing = playwrightDocument(input, { missing: [home.executionId] });
  const missingReport = build(input, await terminalJob(queue, input, missing, 'success', 'missing'));
  assert.equal(missingReport.audits.find(({ id }) => id === 'HOME-001').status, 'NOT_RUN');
  assert.equal(missingReport.health.pipeline.requiredEvidenceComplete, false);

  const unexpected = playwrightDocument(input, { unexpected: true });
  const unexpectedReport = build(input, await terminalJob(queue, input, unexpected, 'success', 'unexpected'));
  assert.equal(unexpectedReport.health.pipeline.integrityComplete, false);
  assert.match(unexpectedReport.health.pipeline.reason, /Unexpected Playwright execution/);

  const tamperTerminal = await terminalJob(queue, input, playwrightDocument(input), 'success', 'tamper');
  const tampered = build(input, tamperTerminal, { playwrightResultsBytes: Buffer.from('{"suites":[],"errors":[]}\n') });
  assert.equal(tampered.health.pipeline.integrityComplete, false);
  assert.equal(tampered.health.pipeline.requiredEvidenceComplete, false);
  assert.equal(buildSingleSiteReportDocuments(tampered, { publicationRevision: revision }).summary.siteHealth.verdict, 'INCOMPLETE');

  const cancelInput = workerInput();
  const cancelSubmission = queueSubmissionForWorkerInput(cancelInput, {
    idempotencyKey: 'report-input-cancelled',
    stageDeadlines: { browser: '2099-01-01T00:10:00.000Z', finalizer: '2099-01-01T00:20:00.000Z' },
  });
  const cancelSubmitted = await submitJob(queue, cancelSubmission, { inputDocument: cancelInput });
  const cancelledState = await cancelJob(queue, cancelSubmitted.state.jobId, 'Operator stopped this audit.');
  const cancelled = buildSingleSiteReportInput({
    workerInput: cancelInput,
    terminalState: cancelledState,
    generatedAt,
  });
  assert.equal(cancelled.health.pipeline.executionStatus, 'cancelled');
  assert.equal(cancelled.health.pipeline.cancellationReason, 'Operator stopped this audit.');
  assert.equal(buildSingleSiteReportDocuments(cancelled, { publicationRevision: revision }).summary.siteHealth.verdict, 'INCOMPLETE');

  const invalidManifest = workerInput();
  invalidManifest.coverageManifest.selectedDefinitions[1].severity = 'GREEN';
  const { manifestDigest: _oldDigest, ...invalidBody } = invalidManifest.coverageManifest;
  invalidManifest.coverageManifest.manifestDigest = canonicalSha256(invalidBody);
  const { planDigest: _oldPlanDigest, ...invalidPlanBody } = invalidManifest.routeInventoryPlan;
  invalidPlanBody.coverageManifestDigest = invalidManifest.coverageManifest.manifestDigest;
  invalidManifest.routeInventoryPlan = { ...invalidPlanBody, planDigest: canonicalSha256(invalidPlanBody) };
  await assert.rejects(async () => buildSingleSiteReportInput({
    workerInput: invalidManifest,
    terminalState: structuredTerminal.state,
    workerResult: structuredTerminal.workerResult,
    playwrightResults: structuredTerminal.document,
    playwrightResultsBytes: structuredTerminal.bytes,
    generatedAt,
  }), /match|severity/i);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write('Single-site report-input self-test passed: compiler mapping, manual/outside/omitted scope, deterministic findings, authority, digest fencing, flaky/missing/unexpected evidence, cancellation, and absent baselines fail closed.\n');
