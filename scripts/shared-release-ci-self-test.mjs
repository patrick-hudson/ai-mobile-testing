import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { sealInventoryCompilationFailure } from '../shared/compilation-failure.mjs';
import { sealExecutionManifest, sealOracleResult, sealWorkItemResult } from '../shared/execution-contract.mjs';
import { appendPublicationEnvelope } from '../shared/publication-envelope.mjs';
import { projectCompilationFailureView, projectSharedReleaseView } from '../shared/release-projection.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { createSharedReleaseHttpClient, runSharedReleaseCi } from './lib/shared-release-ci.mjs';
import { runSharedReleaseCiCommand } from './run-shared-release-ci.mjs';
import { deriveTargetPreflightSetIdentity } from '../shared/target-preflight-set.mjs';
import { CONTROL_EXIT_CODES } from '../shared/control-client-contract.mjs';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const OPERATION_ID = 'a'.repeat(64);
const REQUEST_ID = 'release-ci-stable-request-0001';

const fakePreflights = (targets) => targets.map((target, index) => ({
  accepted: true,
  origin: target.origin,
  deploymentRole: target.role === 'production' ? 'production' : 'preview',
  identityFingerprint: `identity-${index}`,
  deploymentRevision: { fingerprint: `revision-${index}` },
  preflightDigest: `preflight-${index}`,
}));
const fakePreflight = async (input) => fakePreflights([{
  origin: new URL(input.url).origin,
  role: input.deploymentRole,
}])[0];

function fixture() {
  const core = sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: deriveTargetPreflightSetIdentity(fakePreflights([
      { role: 'audited', origin: 'https://beta.example.test' },
    ])),
    targets: [{ role: 'audited', origin: 'https://beta.example.test' }],
    mode: 'single-site',
    requestedAuthority: {
      qualifier: 'FULL',
      scope: { features: ['site'], definitions: ['VISUAL-001'], targets: ['audited-desktop'], knownLimits: [] },
    },
    revisions: { runner: D1, plugins: D1, targets: D1, configuration: D1 },
    environmentIdentity: D2,
    certificatePolicy: 'strict',
  });
  const executionManifest = sealExecutionManifest({
    schemaVersion: 1,
    subjectCoreDigest: core.digest,
    workItems: [{
      id: 'work-visual', definitionId: 'VISUAL-001', targetId: 'audited-desktop', targetRole: 'audited',
    }],
    oracleExecutions: [{ id: 'oracle-visual', definitionId: 'VISUAL-001', requiredWorkItemIds: ['work-visual'] }],
    contextWorkItemIds: [],
  });
  const finalSubject = sealFinalReleaseSubject({
    schemaVersion: 1,
    subjectCore: core,
    executionManifest,
    grantedAuthority: core.requestedAuthority,
    coverageBasis: {
      selectedDefinitions: ['VISUAL-001'], selectedTargets: ['audited-desktop'], excludedAsNotApplicable: [],
    },
    deploymentIdentityRecheck: core.deploymentIdentity,
  });
  const workResult = sealWorkItemResult({
    schemaVersion: 1, workItemId: 'work-visual', subjectCoreDigest: core.digest,
    attempt: 1, authoritative: true, outcome: 'completed_pass', evidenceDigests: [D1],
  });
  const oracle = sealOracleResult({
    schemaVersion: 1,
    oracleExecution: executionManifest.oracleExecutions[0],
    finalSubjectDigest: finalSubject.digest,
    workItemResults: [workResult],
  });
  const projection = projectSharedReleaseView({
    schemaVersion: 1, runId: `run-${OPERATION_ID.slice(0, 32)}`,
    baseDecisionRevision: 1, baseRiskRevision: 1,
    finalSubject, executionManifest, oracleResults: [oracle],
    riskAvailability: 'EMPTY', riskSources: [], riskLifecycleEvents: [], visualDispositions: [],
  });
  const publication = appendPublicationEnvelope(null, {
    schemaVersion: 1, runId: `run-${OPERATION_ID.slice(0, 32)}`, runRevision: 1,
    decisionRevision: projection.decisionRevision, riskRevision: projection.riskRevision,
    ledgerSequences: { observations: 4, decisions: 1, risks: 0 },
    finalSubjectDigest: finalSubject.digest,
    decision: projection.decision, riskRegister: projection.riskRegister,
  });
  const run = {
    schemaVersion: 1, kind: 'durable-parent-run', runId: publication.runId, runRevision: 9,
    compilationState: 'sealed', executionManifest, executionManifestDigest: executionManifest.digest,
    subjectCoreDigest: core.digest,
    finalSubject, finalSubjectDigest: finalSubject.digest,
    workItems: { 'work-visual': { id: 'work-visual', state: 'completed_pass' } },
    ledgerSequences: { mutation: 4, decision: 1, risk: 0, operation: 0 },
    currentPublicationDigest: publication.digest,
  };
  const intent = {
    schemaVersion: 1,
    runContract: {
      schemaVersion: 1, mode: 'single-site', url: 'https://beta.example.test',
      deploymentRole: 'preview', certificatePolicy: 'strict', targetIds: ['audited-desktop'],
      scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
    },
  };
  const launch = {
    schemaVersion: 1, kind: 'shared-launch-operation', operationId: OPERATION_ID,
    requestId: REQUEST_ID, requestDigest: canonicalDigest(intent), state: 'accepted',
    runId: publication.runId, outcome: null,
  };
  return { intent, launch, run, publication, core };
}

function compilationFailureFixture() {
  const base = fixture();
  const workItemId = 'inventory-barrier';
  const compilationFailure = sealInventoryCompilationFailure({
    schemaVersion: 1,
    subjectCoreDigest: base.core.digest,
    workItemId,
    terminalResultDigest: D1,
    reason: 'Inventory worker exhausted bounded recovery.',
    attemptCount: 3,
    failedAt: '2026-08-29T12:00:00.000Z',
  });
  const projection = projectCompilationFailureView({
    schemaVersion: 1,
    runId: base.run.runId,
    decisionRevision: 1,
    riskRevision: 1,
    subjectCore: base.core,
    compilationFailure,
  });
  const publication = appendPublicationEnvelope(null, {
    schemaVersion: 1,
    runId: base.run.runId,
    runRevision: 1,
    decisionRevision: projection.decisionRevision,
    riskRevision: projection.riskRevision,
    ledgerSequences: { observations: 4, decisions: 1, risks: 0 },
    subjectCoreDigest: base.core.digest,
    finalSubjectDigest: null,
    decision: projection.decision,
    riskRegister: projection.riskRegister,
  });
  const attempt = {
    canonicalResultDigest: D1,
  };
  const run = {
    ...base.run,
    compilationState: 'failed',
    subjectCore: base.core,
    executionManifest: null,
    executionManifestDigest: null,
    finalSubject: null,
    finalSubjectDigest: null,
    compilationFailure,
    workItems: { [workItemId]: { id: workItemId, state: 'incomplete', attempts: [attempt, attempt, attempt] } },
    currentPublicationDigest: publication.digest,
  };
  const launch = {
    ...base.launch,
    state: 'completed',
    outcome: {
      status: 'succeeded', runId: base.run.runId,
      subjectCoreDigest: base.core.digest,
      executionManifestDigest: null,
      compilationState: 'pending',
    },
  };
  return { ...base, run, launch, publication, compilationFailure, projection };
}

function scriptedClient({ launch, operations, runs, publications, reprobe } = {}) {
  const calls = { launch: [], operation: 0, run: 0, publication: 0, reprobe: 0 };
  const shift = (values) => values[Math.min(values.length - 1, Math.max(0, values.calls++))];
  const operationValues = [...operations]; operationValues.calls = 0;
  const runValues = [...runs]; runValues.calls = 0;
  const publicationValues = [...publications]; publicationValues.calls = 0;
  return {
    calls,
    async launch(input) { calls.launch.push(structuredClone(input)); return structuredClone(launch); },
    async readLaunchOperation() { calls.operation += 1; return structuredClone(shift(operationValues)); },
    async readRun() { calls.run += 1; return structuredClone(shift(runValues)); },
    async readPublication() {
      calls.publication += 1;
      const value = shift(publicationValues);
      if (value instanceof Error) throw value;
      return value === null ? null : structuredClone(value);
    },
    async reprobeTargetIdentity(input) { calls.reprobe += 1; return reprobe(input); },
  };
}

function completedLaunch(base, f) {
  return {
    ...base,
    state: 'completed',
    outcome: {
      status: 'succeeded', runId: base.runId,
      subjectCoreDigest: f?.run.subjectCoreDigest ?? null,
      executionManifestDigest: f?.run.executionManifestDigest ?? null,
      compilationState: 'sealed',
    },
  };
}

function options(client, f, overrides = {}) {
  return {
    client, requestId: REQUEST_ID, intent: f.intent,
    maximumLaunchPolls: 3, maximumPublicationPolls: 2,
    pollMs: 0, sleep: async () => {},
    ...overrides,
  };
}

const happy = fixture();
const happyClient = scriptedClient({
  launch: happy.launch,
  operations: [happy.launch, completedLaunch(happy.launch, happy)],
  runs: [happy.run, happy.run],
  publications: [happy.publication, happy.publication],
  reprobe: async () => happy.run.finalSubject.deploymentIdentity,
});
const result = await runSharedReleaseCi(options(happyClient, happy));
assert.equal(result.runId, happy.run.runId);
assert.equal(result.publication.digest, happy.publication.digest);
assert.equal(result.confirmed, true);
assert.equal(result.stage, 'final');
assert.deepEqual(result.assertionExpected, {
  subjectDigest: happy.publication.finalSubjectDigest,
  authority: 'FULL',
  executionSetDigest: happy.run.executionManifestDigest,
  runRevision: happy.publication.runRevision,
  decisionRevision: happy.publication.decisionRevision,
});
assert.deepEqual(happyClient.calls.launch, [{ requestId: REQUEST_ID, intent: happy.intent }]);
assert.equal(happyClient.calls.reprobe, 1);

const compilationFailed = compilationFailureFixture();
const compilationFailedClient = scriptedClient({
  launch: compilationFailed.launch,
  operations: [compilationFailed.launch],
  runs: [compilationFailed.run, compilationFailed.run],
  publications: [compilationFailed.publication, compilationFailed.publication],
  reprobe: async () => { throw new Error('core-bound failures must not reprobe as final subjects'); },
});
const compilationFailedResult = await runSharedReleaseCi(options(compilationFailedClient, compilationFailed));
assert.equal(compilationFailedResult.stage, 'core');
assert.equal(compilationFailedResult.publication.decision.code, 'NOT_READY_INCOMPLETE_EXECUTION');
assert.equal(compilationFailedResult.publication.finalSubjectDigest, null);
assert.equal(compilationFailedResult.publication.subjectCoreDigest, compilationFailed.core.digest);
assert.equal(compilationFailedResult.assertionExpected, null);
assert.equal(compilationFailedClient.calls.reprobe, 0,
  'terminal inventory failure must return a not-ready result instead of polling or pretending to promote');

async function rejectsWith(code, mutate, overrides = {}) {
  const f = fixture();
  const scenario = mutate(f) ?? {};
  const client = scriptedClient({
    launch: scenario.launch ?? f.launch,
    operations: scenario.operations ?? [completedLaunch(f.launch, f)],
    runs: scenario.runs ?? [f.run, f.run],
    publications: scenario.publications ?? [f.publication, f.publication],
    reprobe: scenario.reprobe ?? (async () => f.run.finalSubject.deploymentIdentity),
  });
  await assert.rejects(() => runSharedReleaseCi(options(client, f, overrides)),
    (error) => error?.code === code, `expected ${code}`);
}

await rejectsWith('CI_COMPILATION_PENDING', (f) => ({
  runs: [{ ...f.run, compilationState: 'pending', executionManifest: null, finalSubject: null }],
}), { maximumPublicationPolls: 1 });

await rejectsWith('CI_WORK_NOT_TERMINAL', (f) => ({
  runs: [{ ...f.run, workItems: { 'work-visual': { id: 'work-visual', state: 'running' } } }],
}), { maximumPublicationPolls: 1 });

await rejectsWith('CI_MANIFEST_WORK_MISMATCH', (f) => ({
  runs: [{ ...f.run, workItems: {} }],
}));

await rejectsWith('CI_PUBLICATION_MISSING', (f) => ({
  runs: [{ ...f.run, currentPublicationDigest: null }],
  publications: [null],
}), { maximumPublicationPolls: 1 });

await rejectsWith('CI_PUBLICATION_STALE', (f) => ({
  runs: [{ ...f.run, currentPublicationDigest: D2 }],
}));

await rejectsWith('CI_PUBLICATION_NOT_CAUGHT_UP', (f) => {
  const publication = resealEnvelope(f.publication, {
    ledgerSequences: { ...f.publication.ledgerSequences, observations: 3 },
  });
  return {
    runs: [{ ...f.run, currentPublicationDigest: publication.digest }],
    publications: [publication],
  };
});

await rejectsWith('CI_LAUNCH_IDENTITY_MISMATCH', (f) => ({
  operations: [{ ...completedLaunch(f.launch, f), requestDigest: D2 }],
}));

await rejectsWith('CI_LAUNCH_RUN_MISMATCH', (f) => ({
  operations: [{
    ...completedLaunch(f.launch, f),
    outcome: { ...completedLaunch(f.launch, f).outcome, executionManifestDigest: D2 },
  }],
}));

for (const [label, mutatePublication] of [
  ['subject', (publication) => resealEnvelope(publication, {
    finalSubjectDigest: D2,
    decision: resealDecision(publication.decision, { subjectDigest: D2 }),
  })],
  ['authority', (publication) => resealEnvelope(publication, {
    decision: resealDecision(publication.decision, {
      grantedAuthority: 'TARGETED', code: 'FEATURE_READY', label: 'FEATURE READY', ready: true, exitCode: 0,
    }),
  })],
  ['execution', (publication) => resealEnvelope(publication, {
    decision: resealDecision(publication.decision, { executionManifestDigest: D2 }),
  })],
  ['revision', (publication) => resealEnvelope(publication, {
    decisionRevision: publication.decisionRevision + 1,
  })],
]) {
  await rejectsWith('CI_PUBLICATION_INVALID', (f) => {
    const publication = mutatePublication(f.publication);
    return {
      runs: [{ ...f.run, currentPublicationDigest: publication.digest }],
      publications: [publication],
    };
  });
  assert.equal(typeof label, 'string');
}

await rejectsWith('CI_PUBLICATION_CHANGED', (f) => ({
  publications: [f.publication, { ...f.publication, digest: D2 }],
}));

await rejectsWith('CI_TARGET_IDENTITY_DRIFT', (f) => ({
  reprobe: async () => ({ ...f.run.finalSubject.deploymentIdentity, value: 'build-drifted' }),
}));

assert.deepEqual(
  deriveTargetPreflightSetIdentity(fakePreflights(happy.run.finalSubject.targets)),
  deriveTargetPreflightSetIdentity([...fakePreflights(happy.run.finalSubject.targets)].reverse()),
  'target-preflight-set identity must be canonical across launch, inventory, and CI reprobe ordering',
);

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function apiDocument(data) { return JSON.stringify({ schemaVersion: 1, data }); }
const completed = completedLaunch(happy.launch, happy);
let launchRequests = 0;
const api = await listen((request, response) => {
  assert.equal(request.headers.authorization, 'Bearer amt.integration-token.abcdefghijklmnopqrstuvwxyz012345');
  response.setHeader('content-type', 'application/json');
  if (request.method === 'POST' && request.url === '/api/control/v1/runs') {
    launchRequests += 1;
    assert.equal(request.headers['idempotency-key'], REQUEST_ID);
    request.resume();
    response.statusCode = 202;
    response.end(apiDocument(completed));
    return;
  }
  if (request.url === `/api/control/v1/launch-operations/${OPERATION_ID}`) response.end(apiDocument(completed));
  else if (request.url === `/api/control/v1/runs/${happy.run.runId}`) response.end(apiDocument(happy.run));
  else if (request.url === `/api/control/v1/runs/${happy.run.runId}/publication`) response.end(apiDocument(happy.publication));
  else { response.statusCode = 404; response.end(JSON.stringify({ schemaVersion: 1, error: { code: 'MISSING', message: 'missing' } })); }
});
try {
  let lostFirstLaunchResponse = true;
  const client = createSharedReleaseHttpClient({
    baseUrl: api.origin,
    token: 'amt.integration-token.abcdefghijklmnopqrstuvwxyz012345',
    fetchImpl: async (...args) => {
      const response = await fetch(...args);
      if (lostFirstLaunchResponse && args[1]?.method === 'POST') {
        lostFirstLaunchResponse = false;
        await response.arrayBuffer();
        throw Object.assign(new Error('simulated response loss'), { code: 'ECONNRESET' });
      }
      return response;
    },
    preflight: fakePreflight,
    timeoutMs: 2_000,
    maximumResponseBytes: 1_000_000,
  });
  const live = await runSharedReleaseCi(options(client, happy));
  assert.equal(live.publication.digest, happy.publication.digest);
  assert.equal(launchRequests, 2, 'response-loss retry must reuse the stable launch request identity');
} finally {
  await new Promise((resolve) => api.server.close(resolve));
}

const comparativeIntent = {
  schemaVersion: 1,
  runContract: {
    schemaVersion: 1,
    mode: 'comparative',
    productionUrl: 'https://www.example.test',
    candidateUrl: 'https://beta.example.test',
    targetIds: ['candidate-desktop', 'production-desktop'],
    scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
  },
};
const comparativeTargets = [
  { role: 'candidate', origin: 'https://beta.example.test' },
  { role: 'production', origin: 'https://www.example.test' },
];
let comparativeBody = null;
const comparativeApi = await listen((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    comparativeBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.setHeader('content-type', 'application/json');
    response.statusCode = 202;
    response.end(apiDocument({
      ...completed,
      requestDigest: canonicalDigest(comparativeIntent),
      mode: 'comparative',
    }));
  });
});
try {
  const client = createSharedReleaseHttpClient({
    baseUrl: comparativeApi.origin,
    token: 'amt.integration-token.abcdefghijklmnopqrstuvwxyz012345',
    preflight: fakePreflight,
  });
  await client.launch({ requestId: REQUEST_ID, intent: comparativeIntent });
  assert.equal(comparativeBody.runContract.mode, 'comparative');
  assert.deepEqual(
    await client.reprobeTargetIdentity({ targets: comparativeTargets }),
    deriveTargetPreflightSetIdentity(await Promise.all([
      fakePreflight({ url: 'https://beta.example.test', deploymentRole: 'preview' }),
      fakePreflight({ url: 'https://www.example.test', deploymentRole: 'production' }),
    ])),
  );
} finally {
  await new Promise((resolve) => comparativeApi.server.close(resolve));
}

const redirectTarget = await listen((_request, response) => response.end(apiDocument(completed)));
const redirectSource = await listen((_request, response) => {
  response.statusCode = 307;
  response.setHeader('location', `${redirectTarget.origin}/stolen`);
  response.end();
});
try {
  const client = createSharedReleaseHttpClient({
    baseUrl: redirectSource.origin,
    token: 'amt.integration-token.abcdefghijklmnopqrstuvwxyz012345',
    preflight: async () => { throw new Error('not reached'); },
  });
  await assert.rejects(() => client.launch({ requestId: REQUEST_ID, intent: happy.intent }),
    (error) => error?.code === 'CI_HTTP_CROSS_ORIGIN_REDIRECT');
} finally {
  await Promise.all([
    new Promise((resolve) => redirectSource.server.close(resolve)),
    new Promise((resolve) => redirectTarget.server.close(resolve)),
  ]);
}

const failureApi = await listen((_request, response) => {
  response.statusCode = 503;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({
    schemaVersion: 1,
    error: { code: 'LAUNCH_UNAVAILABLE', message: 'offline amt.integration-token.abcdefghijklmnopqrstuvwxyz012345' },
  }));
});
try {
  const client = createSharedReleaseHttpClient({
    baseUrl: failureApi.origin,
    token: 'amt.integration-token.abcdefghijklmnopqrstuvwxyz012345',
    preflight: async () => { throw new Error('not reached'); },
  });
  await assert.rejects(() => client.launch({ requestId: REQUEST_ID, intent: happy.intent }),
    (error) => error?.code === 'CI_HTTP_LAUNCH_UNAVAILABLE' && error.status === 503
      && !error.message.includes('amt.integration-token'));
} finally {
  await new Promise((resolve) => failureApi.server.close(resolve));
}

const oversizedApi = await listen((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(apiDocument({ padding: 'x'.repeat(2_048) }));
});
try {
  const client = createSharedReleaseHttpClient({
    baseUrl: oversizedApi.origin,
    token: 'amt.integration-token.abcdefghijklmnopqrstuvwxyz012345',
    preflight: async () => { throw new Error('not reached'); },
    maximumResponseBytes: 1_024,
  });
  await assert.rejects(() => client.launch({ requestId: REQUEST_ID, intent: happy.intent }),
    (error) => error?.code === 'CI_HTTP_RESPONSE_TOO_LARGE');
} finally {
  await new Promise((resolve) => oversizedApi.server.close(resolve));
}

const slowApi = await listen((_request, response) => {
  setTimeout(() => {
    response.setHeader('content-type', 'application/json');
    response.end(apiDocument(completed));
  }, 100);
});
try {
  const client = createSharedReleaseHttpClient({
    baseUrl: slowApi.origin,
    token: 'amt.integration-token.abcdefghijklmnopqrstuvwxyz012345',
    preflight: async () => { throw new Error('not reached'); },
    timeoutMs: 20,
    maximumLaunchAttempts: 1,
  });
  await assert.rejects(() => client.launch({ requestId: REQUEST_ID, intent: happy.intent }),
    (error) => error?.code === 'CI_HTTP_TRANSPORT_FAILED');
} finally {
  await new Promise((resolve) => slowApi.server.close(resolve));
}

const commandRoot = await mkdtemp(path.join(tmpdir(), 'shared-release-ci-command-'));
const credentialFile = path.join(commandRoot, 'credential');
const intentFile = path.join(commandRoot, 'intent.json');
const resultFile = path.join(commandRoot, 'result.json');
await writeFile(credentialFile, 'amt.integration-token.abcdefghijklmnopqrstuvwxyz012345\n', { mode: 0o600 });
await chmod(credentialFile, 0o600);
await writeFile(intentFile, `${JSON.stringify(happy.intent)}\n`, { mode: 0o600 });
await chmod(intentFile, 0o600);
const commandApi = await listen((request, response) => {
  response.setHeader('content-type', 'application/json');
  request.resume();
  if (request.method === 'POST') response.end(apiDocument(completed));
  else if (request.url === `/api/control/v1/launch-operations/${OPERATION_ID}`) response.end(apiDocument(completed));
  else if (request.url === `/api/control/v1/runs/${happy.run.runId}`) response.end(apiDocument(happy.run));
  else response.end(apiDocument(happy.publication));
});
try {
  const output = [];
  await runSharedReleaseCiCommand([
    '--server', commandApi.origin, '--token-file', credentialFile, '--intent-file', intentFile,
    '--result-file', resultFile, '--request-id', REQUEST_ID, '--poll-ms', '0',
  ], {
    stdout: { write: (value) => output.push(String(value)) },
    preflight: fakePreflight,
  });
  const resultText = await readFile(resultFile, 'utf8');
  assert.equal((await stat(resultFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(resultText, /amt\.integration-token/u);
  assert.doesNotMatch(output.join(''), /amt\.integration-token/u);
  const persistedResult = JSON.parse(resultText);
  assert.equal(persistedResult.stage, 'final');
  assert.equal(persistedResult.runId, happy.run.runId);
  assert.deepEqual(persistedResult.finalSubject, happy.run.finalSubject,
    'delivery must retain the non-secret immutable target and deployment identity contract');
} finally {
  await new Promise((resolve) => commandApi.server.close(resolve));
}

const coreResultFile = path.join(commandRoot, 'core-result.json');
const coreCommandApi = await listen((request, response) => {
  response.setHeader('content-type', 'application/json');
  request.resume();
  if (request.method === 'POST') response.end(apiDocument(compilationFailed.launch));
  else if (request.url === `/api/control/v1/launch-operations/${OPERATION_ID}`) response.end(apiDocument(compilationFailed.launch));
  else if (request.url === `/api/control/v1/runs/${compilationFailed.run.runId}`) response.end(apiDocument(compilationFailed.run));
  else response.end(apiDocument(compilationFailed.publication));
});
try {
  await assert.rejects(runSharedReleaseCiCommand([
    '--server', coreCommandApi.origin, '--token-file', credentialFile, '--intent-file', intentFile,
    '--result-file', coreResultFile, '--request-id', REQUEST_ID, '--poll-ms', '0',
  ], { stdout: { write() {} }, preflight: fakePreflight }),
  (error) => error?.code === 'CI_DECISION_NOT_READY' && error?.exitCode === CONTROL_EXIT_CODES.NOT_READY);
  const corePersistedResult = JSON.parse(await readFile(coreResultFile, 'utf8'));
  assert.equal(corePersistedResult.stage, 'core');
  assert.equal(corePersistedResult.assertionExpected, null);
  assert.equal(corePersistedResult.decision.ready, false);
} finally {
  await new Promise((resolve) => coreCommandApi.server.close(resolve));
}

function resealDecision(value, overrides) {
  const body = { ...value, ...overrides };
  delete body.digest;
  return { ...body, digest: canonicalDigest(body) };
}

function resealEnvelope(value, overrides) {
  const body = { ...value, ...overrides };
  delete body.digest;
  return { ...body, digest: canonicalDigest(body) };
}

console.log('Shared release CI self-test passed: launch identity, terminal publication convergence, head confirmation, and target reprobe are fail closed.');
