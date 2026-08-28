import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalSha256 } from '../shared/run-compiler.mjs';
import {
  compileSingleSiteRouteInventoryPlan,
  reconcileSingleSiteRouteInventory,
} from '../shared/single-site-route-plan.mjs';
import {
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

const origin = 'https://beta.example.test';
const targetId = 'single-site-desktop-chromium';
const environmentCase = 'ENV-002:standalone';
const pageCase = 'PAGE-001:standalone';
const runContract = {
  schemaVersion: 1,
  mode: 'single-site',
  url: origin,
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: [targetId],
  scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['ENV-002', 'PAGE-001'], areas: [] },
};
const identityFingerprint = sha256('route-report-identity');
const revisionFingerprint = sha256('route-report-revision');
const executions = [
  { auditId: 'ENV-002', caseId: environmentCase, entrySpec: 'tests/contracts.spec.ts' },
  { auditId: 'PAGE-001', caseId: pageCase, entrySpec: 'tests/page-audit.spec.ts' },
].map((execution) => ({
  executionId: `${execution.caseId}@${targetId}`,
  pluginId: 'core',
  ...execution,
  applicability: 'candidate-desktop-chromium',
  targetId,
  sourceComparativeTargetId: 'candidate-desktop-chromium',
  productOracleVariant: 'fixture',
  productOracleExpected: 'Fixture execution passes.',
}));
const manifestBody = {
  schemaVersion: 1,
  kind: 'definition-coverage-manifest',
  mode: 'single-site',
  deployment: {
    url: origin,
    deploymentRole: 'preview',
    certificatePolicy: 'strict',
    identityFingerprint,
    revision: { status: 'identified', value: revisionFingerprint },
    evidenceAuthority: { status: 'authoritative', reasons: [] },
  },
  revisions: {
    runContract: canonicalSha256(runContract),
    pluginRegistry: canonicalSha256({ fixture: 'route-report-plugin' }),
    targetRegistry: canonicalSha256({ fixture: 'route-report-target' }),
    runner: 'route-report-runner-v1',
  },
  scope: {
    requestedQualifier: 'TARGETED',
    qualifier: 'TARGETED',
    filters: { pluginIds: [], auditIds: ['ENV-002', 'PAGE-001'], areas: [] },
    selectedTargetIds: [targetId],
    requiredFullProfileTargetIds: [targetId],
    allEligibleDefinitionsSelected: false,
    allEligibleCasesSelected: false,
    allRequiredTargetsSelected: true,
  },
  coverageStatus: 'COMPLETE',
  selectedTargets: [{ targetId, deviceClass: 'desktop', engine: 'chromium' }],
  selectedDefinitions: [
    {
      pluginId: 'core', auditId: 'ENV-002', area: 'routes', title: 'Live route inventory', severity: 'P0', manual: false,
      singleSiteClassification: 'standalone-compatible', selectedCaseIds: [environmentCase], executionIds: [executions[0].executionId],
    },
    {
      pluginId: 'core', auditId: 'PAGE-001', area: 'routes', title: 'Page audit: /required', severity: 'P1', manual: false,
      singleSiteClassification: 'standalone-compatible', selectedCaseIds: [pageCase], executionIds: [executions[1].executionId],
    },
  ],
  executions,
  coverageGaps: [],
  omissions: { definitions: [], cases: [], targets: [] },
  outsideMode: [],
  counts: {
    selectedDefinitions: 2,
    executableCases: 2,
    plannedExecutions: 2,
    manualDefinitions: 0,
    coverageGaps: 0,
    omittedDefinitions: 0,
    outsideModeDefinitions: 0,
  },
};
const coverageManifest = { ...manifestBody, manifestDigest: canonicalSha256(manifestBody) };
const routeInventoryPlan = compileSingleSiteRouteInventoryPlan({
  pluginRegistry: { plugins: [{ auditDefinitions: [{ id: 'PAGE-001', title: 'Page audit: /required' }] }] },
  coverageManifest,
});
const workerInput = {
  schemaVersion: 1,
  kind: 'single-site-worker-input',
  runContract,
  coverageManifest,
  routeInventoryPlan,
  launchCheckpoint: {
    preflightDigest: sha256('route-report-preflight'),
    identityFingerprint,
    revisionFingerprint,
    evidenceAuthority: { authoritative: true, reasons: [] },
  },
  runnerRevision: 'route-report-runner-v1',
};

function auditAttachment(caseId, auditId) {
  return {
    name: 'audit-result',
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({
      schemaVersion: 1,
      mode: 'single-site',
      caseId,
      auditId,
      project: targetId,
      baseURL: origin,
      deploymentRole: 'preview',
      evidenceAuthority: { status: 'authoritative', reasons: [] },
      findings: [],
    })).toString('base64'),
  };
}

function testRecord(caseId, auditId) {
  return {
    annotations: [{ type: 'audit-case-id', description: caseId }],
    expectedStatus: 'passed',
    projectName: targetId,
    status: 'expected',
    results: [{
      status: 'passed',
      retry: 0,
      errors: [],
      attachments: [auditAttachment(caseId, auditId), { name: 'screenshot', contentType: 'image/png', path: `/fixture/${caseId}.png` }],
    }],
  };
}

const diagnostic = {
  schemaVersion: 1,
  kind: 'live-route-inventory-diagnostic',
  origin,
  capabilities: { scriptExecution: false, browserRendering: false, formSubmission: false, productOracleDerivation: false, findingDerivation: false },
  limits: {},
  sources: {
    deploymentManifest: { supplied: true, candidateCount: 2 },
    sitemap: {
      documents: [{
        requestedUrl: `${origin}/sitemap.xml`, finalUrl: `${origin}/sitemap.xml`, from: null, depth: 0,
        statusCode: 200, contentType: 'application/xml', bodyBytes: 64, kind: 'url-set',
      }],
      candidateCount: 1,
      totalBodyBytes: 64,
    },
  },
  fetchEvidence: [],
  failures: [],
  exclusions: [],
  limitations: [{ code: 'not-browser-rendered', source: 'static-navigation', url: origin, detail: 'JavaScript navigation was not executed during discovery.' }],
  inventory: {
    schemaVersion: 1,
    origin,
    limits: {},
    sources: [],
    routes: [
      {
        url: `${origin}/new-route`, path: '/new-route', query: '', disposition: 'included',
        sources: [{ source: 'deployment-manifest', from: null, depth: 0 }],
      },
      {
        url: `${origin}/sitemap-404`, path: '/sitemap-404', query: '', disposition: 'unreachable',
        sources: [{ source: 'sitemap', from: `${origin}/sitemap.xml`, depth: 0 }],
      },
      {
        url: `${origin}/manifest-fetch-failure`, path: '/manifest-fetch-failure', query: '', disposition: 'fetch-failed',
        sources: [{ source: 'deployment-manifest', from: null, depth: 0 }],
      },
      {
        url: `${origin}/required`, path: '/required', query: '', disposition: 'included',
        sources: [{ source: 'catalog', from: null, depth: 0 }],
      },
    ],
    exclusions: [],
    failures: [
      { code: 'http-status', source: 'crawl', url: `${origin}/sitemap-404`, detail: 'HTTP 404.' },
      { code: 'fetch-error', source: 'crawl', url: `${origin}/manifest-fetch-failure`, detail: 'Connection reset.' },
    ],
    limitations: [],
    responses: [
      { url: `${origin}/new-route`, depth: 0, status: 200, contentType: 'text/html', bytes: 500 },
      { url: `${origin}/sitemap-404`, depth: 0, status: 404, contentType: 'text/html', bytes: 80 },
      { url: `${origin}/required`, depth: 0, status: 200, contentType: 'text/html', bytes: 300 },
    ],
    redirects: [],
    bounds: [{ code: 'route-count', limit: 500, observed: 4, exhausted: false }],
    summary: { routes: 4, exclusions: 0, failures: 2, limitations: 0, responses: 3, redirects: 0, htmlBytesConsumed: 880 },
  },
};

// This matches the shape that exposed the production finalization failure:
// many independently useful route findings must remain in the finding index,
// without repeating one sentence per finding in the bounded audit summary.
const overflowRoutes = Array.from({ length: 101 }, (_, index) => ({
  url: `${origin}/overflow-route-${String(index).padStart(3, '0')}`,
  path: `/overflow-route-${String(index).padStart(3, '0')}`,
  query: '',
  disposition: 'unreachable',
  sources: [{ source: 'sitemap', from: `${origin}/sitemap.xml`, depth: 0 }],
}));
diagnostic.inventory.routes.push(...overflowRoutes);
diagnostic.inventory.summary.routes += overflowRoutes.length;

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-route-report-'));
try {
  const queue = await openJobQueue({ root: path.join(temporaryRoot, 'queue'), verifyStorage: false });
  const submission = queueSubmissionForWorkerInput(workerInput, {
    idempotencyKey: 'route-report-fixture',
    stageDeadlines: { browser: '2099-01-01T00:10:00.000Z', finalizer: '2099-01-01T00:20:00.000Z' },
  });
  const submitted = await submitJob(queue, submission, { inputDocument: workerInput });
  const claim = await claimJob(queue, submitted.state.jobId, 'route-report-worker');
  const routePublication = reconcileSingleSiteRouteInventory({
    jobId: claim.jobId,
    attemptId: claim.attemptId,
    coverageManifestDigest: coverageManifest.manifestDigest,
    plan: routeInventoryPlan,
    diagnostic,
  });
  const routeQueuePublication = await publishAttemptDocument(queue, claim, {
    publicationId: `attempt-${claim.attemptNumber}-route-inventory`,
    relativePath: 'worker/route-inventory.json',
    document: routePublication,
  });
  const generic = routePublication.genericExecutions[0];
  const document = {
    suites: [{ title: 'route fixture', specs: [
      { title: 'environment inventory', tests: [testRecord(environmentCase, 'ENV-002')] },
      { title: 'reviewed page', tests: [testRecord(pageCase, 'PAGE-001')] },
      { title: 'generic route', tests: [testRecord(generic.caseId, 'ENV-002')] },
    ], suites: [] }],
    errors: [],
  };
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  const workerResult = {
    schemaVersion: 1,
    kind: 'single-site-worker-result',
    jobId: claim.jobId,
    attemptId: claim.attemptId,
    attemptNumber: claim.attemptNumber,
    fencingToken: claim.fencingToken,
    classification: 'success',
    reason: null,
    freshEvidence: { fresh: true, reason: null, relativePath: 'results.json', bytes: bytes.length, digest: sha256(bytes) },
    routeInventory: {
      publicationId: routeQueuePublication.publicationId,
      relativePath: routeQueuePublication.relativePath,
      queueDigest: routeQueuePublication.digest,
      inventoryDigest: routePublication.inventoryDigest,
      publicationDigest: routePublication.publicationDigest,
      genericExecutionCount: routePublication.genericExecutions.length,
      reviewedFindingCount: routePublication.reviewedFindings.length,
      coverageGapCount: routePublication.coverageGaps.length,
      limitationCount: routePublication.limitations.length,
    },
    artifactRoot: `attempts/${claim.attemptId}/artifacts`,
  };
  await publishAttemptDocument(queue, claim, {
    publicationId: `attempt-${claim.attemptNumber}-worker-result`,
    relativePath: 'worker/attempt-result.json',
    document: workerResult,
  });
  const state = await settleJobAttempt(queue, claim, { kind: 'success', reason: null });
  const report = buildSingleSiteReportInput({
    workerInput,
    terminalState: state,
    workerResult,
    routeInventoryPublication: routePublication,
    playwrightResults: document,
    playwrightResultsBytes: bytes,
    generatedAt: '2026-08-25T18:30:00.000Z',
  });

  assert.equal(report.health.pipeline.integrityComplete, true);
  assert.equal(report.health.pipeline.requiredEvidenceComplete, true);
  const routeFindings = report.health.findings.filter(({ source }) => source === 'route-inventory');
  assert.equal(routeFindings.length, 104);
  assert(
    routeFindings.length * ' Live route inventory added a deterministic missing/declaration Finding.'.length > 2_400,
    'the adversarial fixture must exceed the former repeated-summary representation',
  );
  assert(routeFindings.some(({ title, detail }) => (
    /sitemap-404/.test(title) && /HTTP 404/.test(detail) && /sitemap/.test(detail)
  )));
  assert(routeFindings.some(({ title, detail }) => (
    /manifest-fetch-failure/.test(title) && /Connection reset/.test(detail) && /deployment-manifest/.test(detail)
  )));
  assert(routeFindings.some(({ title, detail }) => (
    /absent from deployment declarations/.test(title) && /deployment-manifest and sitemap/.test(detail)
  )));
  const environmentAudit = report.audits.find(({ id }) => id === 'ENV-002');
  assert.equal(environmentAudit.status, 'FAIL');
  assert.equal(environmentAudit.findingCount, 104);
  assert(environmentAudit.detail.length <= 2_400, 'high-cardinality route findings must retain a bounded audit summary');
  assert.match(environmentAudit.detail, /104 deterministic route findings/);
  assert.equal((environmentAudit.detail.match(/route-level evidence remains available/g) ?? []).length, 1);
  assert(report.health.coverage.gaps.some((gap) => gap.includes('no reviewed route-specific Product Oracle')));
  assert(report.health.coverage.gaps.some((gap) => gap.includes('/sitemap-404')));
  assert(report.health.coverage.gaps.some((gap) => gap.includes('/manifest-fetch-failure')));
  assert(report.health.coverage.limitations.some((limitation) => limitation.includes('not-browser-rendered')));
  assert.equal(buildSingleSiteReportDocuments(report, { publicationRevision: '0123456789abcdef0123456789abcdef' }).summary.siteHealth.verdict, 'FINDINGS');

  const missingInventory = buildSingleSiteReportInput({
    workerInput,
    terminalState: state,
    workerResult,
    playwrightResults: document,
    playwrightResultsBytes: bytes,
    generatedAt: '2026-08-25T18:30:00.000Z',
  });
  assert.equal(missingInventory.health.pipeline.integrityComplete, false);
  assert.match(missingInventory.health.pipeline.reason, /route inventory/i);

  process.stdout.write('Single-site route report self-test passed: generic execution, reviewed-route Findings, Product Oracle gaps, discovery limitations, and missing publication fail closed.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
