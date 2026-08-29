import assert from 'node:assert/strict';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { sealExecutionManifest, sealOracleResult, sealWorkItemResult } from '../shared/execution-contract.mjs';
import { appendPublicationEnvelope } from '../shared/publication-envelope.mjs';
import { projectSharedReleaseView } from '../shared/release-projection.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { runSharedReleaseCi } from './lib/shared-release-ci.mjs';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const OPERATION_ID = 'a'.repeat(64);
const REQUEST_ID = 'release-ci-stable-request-0001';

function fixture() {
  const core = sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: { kind: 'build', value: 'build-live-123' },
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
  return { intent, launch, run, publication };
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
assert.deepEqual(result.assertionExpected, {
  subjectDigest: happy.publication.finalSubjectDigest,
  authority: 'FULL',
  executionSetDigest: happy.run.executionManifestDigest,
  runRevision: happy.publication.runRevision,
  decisionRevision: happy.publication.decisionRevision,
});
assert.deepEqual(happyClient.calls.launch, [{ requestId: REQUEST_ID, intent: happy.intent }]);
assert.equal(happyClient.calls.reprobe, 1);

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
