import assert from 'node:assert/strict';
import {
  assertSharedWorkspaceProjection,
  createSharedControlBrowserClient,
  orderSharedRisksForReview,
  pageSharedRisksForReview,
} from '../portal/public/shared-control-client.js';

const calls = [];
let operationReads = 0;
let launchOperationReads = 0;
const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => name.toLowerCase() === 'location' ? body?.data?.statusUrl ?? null : null },
  json: async () => body,
});
const client = createSharedControlBrowserClient({
  fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/control/v1/session' && options.method === 'POST') {
      return jsonResponse(200, { schemaVersion: 1, data: { csrfToken: 'csrf-memory-only', principal: { id: 'reviewer-1' } } });
    }
    if (url === '/api/control/v1/launch-preview') {
      const intent = JSON.parse(options.body);
      return jsonResponse(200, { schemaVersion: 1, data: { accepted: true, runContract: intent.runContract } });
    }
    if (url === '/api/control/v1/runs' && options.method === 'POST') {
      return jsonResponse(202, { schemaVersion: 1, data: {
        operationId: 'c'.repeat(64),
        runId: `run-${'d'.repeat(32)}`,
        state: 'accepted',
        statusUrl: `/api/control/v1/launch-operations/${'c'.repeat(64)}`,
      } });
    }
    if (String(url).includes('/launch-operations/')) {
      launchOperationReads += 1;
      return jsonResponse(200, { schemaVersion: 1, data: launchOperationReads === 1
        ? { operationId: 'c'.repeat(64), runId: `run-${'d'.repeat(32)}`, state: 'accepted' }
        : { operationId: 'c'.repeat(64), runId: `run-${'d'.repeat(32)}`, state: 'completed',
          outcome: { status: 'succeeded', runId: `run-${'d'.repeat(32)}` } } });
    }
    if (String(url).includes('/workspace?')) {
      return jsonResponse(200, { schemaVersion: 1, data: {
        schemaVersion: 1, snapshotToken: `sha256:${'a'.repeat(64)}`, stateRevision: 11,
        publication: {
        runId: 'run-1', runRevision: 6, decisionRevision: 2, riskRevision: 3,
        finalSubjectDigest: `sha256:${'b'.repeat(64)}`,
        decision: {
          mode: 'comparative', label: 'FEATURE READY', grantedAuthority: 'TARGETED',
          certifiedScope: { features: ['navigation'], definitions: ['NAV-001'], targets: ['desktop'], knownLimits: [] },
        },
        riskRegister: { availability: 'PARTIAL', risks: [] },
        },
        executions: { runId: 'run-1', executions: [{ id: 'work-incomplete', state: 'incomplete' }], oracleExecutions: [] },
        logs: { runId: 'run-1', limit: 200, truncated: false, events: [], attemptLogs: [] },
      } });
    }
    if (String(url).endsWith('/rekick')) return jsonResponse(202, { schemaVersion: 1, data: { operationId: 'a'.repeat(64), state: 'accepted', statusUrl: `/api/control/v1/runs/run-1/operations/${'a'.repeat(64)}` } });
    if (String(url).includes('/operations/')) {
      operationReads += 1;
      return jsonResponse(200, { schemaVersion: 1, data: operationReads === 1
        ? { operationId: 'a'.repeat(64), state: 'accepted' }
        : { operationId: 'a'.repeat(64), state: 'completed', outcome: { status: 'succeeded' } } });
    }
    throw new Error(`Unexpected request ${url}`);
  },
  wait: async () => {},
});

const credential = 'amt.fixture.secret-that-must-not-persist';
await client.login(credential);
assert.equal(client.session.csrfToken, 'csrf-memory-only');
assert.equal(JSON.parse(calls[0].options.body).credential, credential);
assert.equal(JSON.stringify(client.session).includes(credential), false);

const launchContract = {
  schemaVersion: 1,
  mode: 'single-site',
  url: 'https://beta.example.test',
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium'],
  scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
};
const preview = await client.previewLaunch(launchContract);
assert.equal(preview.accepted, true);
assert.deepEqual(preview.runContract, launchContract);
const launched = await client.launchRun(launchContract, { requestId: 'portal-launch-0001' });
assert.equal(launched.runId, `run-${'d'.repeat(32)}`);
const launchMutation = calls.find(({ url }) => url === '/api/control/v1/runs');
assert.equal(launchMutation.options.headers['X-Audit-CSRF'], 'csrf-memory-only');
assert.equal(launchMutation.options.headers['Idempotency-Key'], 'portal-launch-0001');
assert.deepEqual(JSON.parse(launchMutation.options.body), { schemaVersion: 1, runContract: launchContract });
await assert.rejects(
  client.waitForLaunchOperation('/api/control/v1/launch-operations/not-an-operation'),
  /invalid/u,
);
const completedLaunch = await client.waitForLaunchOperation(launched.statusUrl, { maxPolls: 3, pollMs: 0 });
assert.equal(completedLaunch.outcome.status, 'succeeded');
assert.equal(launchOperationReads, 2);

const workspace = await client.readWorkspace('run-1');
assert.equal(workspace.publication.runRevision, 6);
assert.equal(workspace.stateRevision, 11);
assert.equal(workspace.riskAvailability, 'PARTIAL');
assert.equal(workspace.logs.limit, 200);
assert.equal(assertSharedWorkspaceProjection(workspace, { runId: 'run-1', mode: 'comparative' }), workspace);
const coreBoundWorkspace = {
  ...workspace,
  publication: {
    ...workspace.publication,
    subjectCoreDigest: `sha256:${'c'.repeat(64)}`,
    finalSubjectDigest: null,
    decision: {
      ...workspace.publication.decision,
      subjectStage: 'core',
      mode: 'single-site',
      grantedAuthority: null,
      certifiedScope: null,
      requestedAuthority: {
        qualifier: 'FULL',
        scope: { features: ['site'], definitions: ['NAV-001'], targets: ['desktop'], knownLimits: [] },
      },
    },
  },
};
assert.equal(assertSharedWorkspaceProjection(coreBoundWorkspace, {
  runId: 'run-1', mode: 'single-site',
}), coreBoundWorkspace, 'a core-bound incomplete decision must remain a coherent terminal portal projection');
assert.throws(
  () => assertSharedWorkspaceProjection(workspace, { runId: 'another-run', mode: 'comparative' }),
  /coherent revision/i,
);
assert.deepEqual(orderSharedRisksForReview([
  { identity: 'resolved-critical', severity: 'critical', category: 'manual-check', reviewState: 'RESOLVED' },
  { identity: 'operational-medium', severity: 'medium', category: 'certificate-bypass', reviewState: 'OPEN' },
  { identity: 'product-medium', severity: 'medium', category: 'unreviewed-visual-change', reviewState: 'OPEN' },
  { identity: 'product-high', severity: 'high', category: 'manual-check', reviewState: 'ACKNOWLEDGED' },
]).map(({ identity }) => identity), ['product-high', 'product-medium', 'operational-medium', 'resolved-critical']);
const riskPage = pageSharedRisksForReview(Array.from({ length: 201 }, (_, index) => ({
  identity: `risk-${String(index).padStart(3, '0')}`,
  severity: 'medium',
  category: 'manual-check',
  reviewState: index === 200 ? 'OPEN' : 'RESOLVED',
})), { offset: 0 });
assert.equal(riskPage.total, 201);
assert.equal(riskPage.items.length, 200);
assert.equal(riskPage.items[0].identity, 'risk-200', 'Active risks must appear before resolved risks.');
assert.equal(riskPage.showing, 'Showing 1–200 of 201 risks');
assert.equal(riskPage.hasNext, true);
assert.throws(
  () => assertSharedWorkspaceProjection({
    ...workspace,
    publication: {
      ...workspace.publication,
      riskRegister: {
        availability: 'UNAVAILABLE',
        risks: [{
          identity: 'risk-forged-unavailable', category: 'manual-check', severity: 'high', reviewState: 'OPEN',
          explanation: 'A malformed unavailable register must not carry rows.', recommendedAction: 'Reject it.',
          source: { kind: 'manual', id: 'manual-1' }, releaseEffect: 'non-blocking',
        }],
      },
    },
  }, { runId: 'run-1', mode: 'comparative' }),
  /invalid bounded projection/i,
);

const accepted = await client.mutate('run-1', 'rekick', {
  expectedRunRevision: 7,
  body: { expectedSubjectDigest: `sha256:${'b'.repeat(64)}`, workItemIds: ['work-incomplete'] },
  requestId: 'rekick-browser-0001',
});
const mutation = calls.find(({ url }) => String(url).endsWith('/rekick'));
assert.equal(mutation.options.headers['X-Audit-CSRF'], 'csrf-memory-only');
assert.equal(mutation.options.headers['Idempotency-Key'], 'rekick-browser-0001');
assert.deepEqual(JSON.parse(mutation.options.body).workItemIds, ['work-incomplete']);
await assert.rejects(client.waitForOperation(`/api/control/v1/runs/another-run/operations/${'a'.repeat(64)}`, { runId: 'run-1' }), /another run/i);
const completed = await client.waitForOperation(accepted.statusUrl, { runId: 'run-1', maxPolls: 3, pollMs: 0 });
assert.equal(completed.outcome.status, 'succeeded');
assert.equal(operationReads, 2);
assert.equal(JSON.stringify(calls.slice(1)).includes(credential), false);

console.log('Shared control browser client self-test passed.');
