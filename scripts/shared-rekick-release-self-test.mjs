import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  sealExecutionManifest,
} from '../shared/execution-contract.mjs';
import {
  sealFinalReleaseSubject,
  sealReleaseSubjectCore,
} from '../shared/release-subject.mjs';
import { sealRiskSourceObservationSet } from '../shared/risk-source-observation.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import { createSharedCoordinatorSupervisor } from './lib/shared-coordinator-supervisor.mjs';
import {
  adoptAttemptEvidence,
  createParentRun,
  openParentRunStore,
  publishAttemptEvidence,
  readCurrentEnvelope,
  readParentRun,
  readReleaseAuthoritySelector,
  transitionReleaseAuthority,
} from './lib/parent-run-store.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const runId = 'run-rekick-release-proof';
const workIds = ['work-rekick-preserved', 'work-rekick-recovered'];
const now = Date.parse('2026-08-29T18:00:00.000Z');

const [pluginRegistry, targetRegistry] = await Promise.all([
  readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8').then(JSON.parse),
]);

const subjectCore = sealReleaseSubjectCore({
  schemaVersion: 1,
  deploymentIdentity: { kind: 'target-preflight-set', value: digest('5') },
  targets: [{ role: 'audited', origin: 'https://beta.example.test' }],
  mode: 'single-site',
  requestedAuthority: {
    qualifier: 'TARGETED',
    scope: {
      features: ['navigation', 'search'],
      definitions: ['NAV-001', 'SEARCH-001'],
      targets: ['audited-desktop'],
      knownLimits: [],
    },
  },
  revisions: {
    runner: digest('1'), plugins: digest('2'), targets: digest('3'), configuration: digest('4'),
  },
  environmentIdentity: digest('6'),
  certificatePolicy: 'strict',
});
const executionManifest = sealExecutionManifest({
  schemaVersion: 1,
  subjectCoreDigest: subjectCore.digest,
  workItems: [
    { id: workIds[0], definitionId: 'NAV-001', targetId: 'audited-desktop', targetRole: 'audited' },
    { id: workIds[1], definitionId: 'SEARCH-001', targetId: 'audited-desktop', targetRole: 'audited' },
  ],
  oracleExecutions: [
    { id: 'oracle-rekick-preserved', definitionId: 'NAV-001', requiredWorkItemIds: [workIds[0]] },
    { id: 'oracle-rekick-recovered', definitionId: 'SEARCH-001', requiredWorkItemIds: [workIds[1]] },
  ],
  contextWorkItemIds: [],
});
const finalSubject = sealFinalReleaseSubject({
  schemaVersion: 1,
  subjectCore,
  executionManifest,
  grantedAuthority: subjectCore.requestedAuthority,
  coverageBasis: {
    selectedDefinitions: ['NAV-001', 'SEARCH-001'],
    selectedTargets: ['audited-desktop'],
    excludedAsNotApplicable: [],
  },
  deploymentIdentityRecheck: subjectCore.deploymentIdentity,
});

const root = await mkdtemp(path.join(tmpdir(), 'shared-rekick-release-'));
try {
  const store = await openParentRunStore({
    root,
    deploymentIdentity: 'shared-rekick-release-test',
    volumeIdentity: 'named-volume:shared-rekick-release-test',
    backupMarker: 'backup:shared-rekick-release-test',
    storeMarker: 'cd'.repeat(32),
    verifyStorage: false,
    clock: () => now,
  });
  let observedDeploymentIdentity = subjectCore.deploymentIdentity;
  let reprobeFailure = null;
  const controlService = createSharedControlService({
    store,
    projectId: 'project-rekick-release',
    reprobeTargetIdentity: async () => {
      if (reprobeFailure) throw new Error(reprobeFailure);
      return observedDeploymentIdentity;
    },
  });
  const supervisor = createSharedCoordinatorSupervisor({
    store,
    controlService,
    projectId: 'project-rekick-release',
    ownerId: 'coordinator-rekick-release',
    pluginRegistry,
    targetRegistry,
  });
  assert.deepEqual((await supervisor.maintain()).errors, []);
  const shadow = await readReleaseAuthoritySelector(store);
  const draining = await transitionReleaseAuthority(store, supervisor.coordinator(), {
    expectedSelectorDigest: shadow.digest,
    phase: 'DRAINING',
    buildIdentity: store.buildIdentity,
  });
  await transitionReleaseAuthority(store, supervisor.coordinator(), {
    expectedSelectorDigest: draining.digest,
    phase: 'ACTIVE',
    activationRevision: 1,
    buildIdentity: store.buildIdentity,
    activationCutoverDigest: digest('c'),
    authorityTransitionDigest: digest('d'),
  });
  await createParentRun(store, {
    runId,
    compilationState: 'sealed',
    subjectCore,
    executionManifest,
    finalSubject,
    runnerRevision: subjectCore.revisions.runner,
    workItems: workIds.map((id) => ({
      id,
      capability: 'browser:chromium',
      resourceClass: 'ordinary',
      targetId: 'audited-desktop',
      specAffinity: null,
      maxAttempts: 2,
    })),
  });
  await supervisor.maintain();
  assert.equal((await readCurrentEnvelope(store, runId)).decision.code, 'NOT_READY_INCOMPLETE_EXECUTION');

  const worker = {
    id: 'worker-rekick-release', kind: 'worker', roles: ['worker'],
    projectIds: ['project-rekick-release'], runIds: [runId],
    workerGrant: { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
  };
  const publish = async (lease, outcome, reason = null) => {
    const riskSourceObservationSet = sealRiskSourceObservationSet({
      schemaVersion: 1,
      runId,
      workItemId: lease.workItemId,
      subjectCoreDigest: lease.subjectCoreDigest,
      attempt: lease.attempt,
      workerId: worker.id,
      producerStates: [
        { producer: 'visual', status: 'NOT_APPLICABLE' },
        { producer: 'baseline', status: 'NOT_APPLICABLE' },
        { producer: 'evidence-pipeline', status: 'COMPLETE' },
      ],
      observations: [],
    });
    const inbox = await publishAttemptEvidence(store, runId, lease, {
      outcome,
      reason,
      executionDescriptorDigest: lease.executionDescriptorDigest,
      artifacts: [],
      riskSourceObservationSet,
    });
    await adoptAttemptEvidence(store, runId, supervisor.coordinator(), inbox);
  };

  const preservedLease = await supervisor.claim(worker);
  assert.equal(preservedLease.workItemId, workIds[0]);
  await publish(preservedLease, 'completed_pass');
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const failedLease = await supervisor.claim(worker);
    assert.equal(failedLease.workItemId, workIds[1]);
    assert.equal(failedLease.attempt, attempt);
    await publish(failedLease, 'operational_failure', `synthetic-platform-loss-${attempt}`);
  }
  await supervisor.maintain();

  const incompleteState = await readParentRun(store, runId);
  const incompletePublication = await readCurrentEnvelope(store, runId);
  const preservedDigest = incompleteState.workItems[workIds[0]].canonicalResult.digest;
  const preservedAttempts = structuredClone(incompleteState.workItems[workIds[0]].attempts);
  const incompleteAttempts = structuredClone(incompleteState.workItems[workIds[1]].attempts);
  assert.equal(incompleteState.workItems[workIds[1]].state, 'incomplete');
  assert.equal(incompletePublication.decision.code, 'NOT_READY_INCOMPLETE_EXECUTION');

  const operator = {
    id: 'operator-rekick-release', kind: 'human', roles: ['operator'],
    projectIds: ['project-rekick-release'], runIds: [runId],
  };
  const acceptRekick = async (requestId) => {
    const state = await readParentRun(store, runId);
    return controlService.acceptMutation(operator, runId, {
      kind: 'rekick', requestId, expectedRunRevision: state.runRevision,
      body: { expectedSubjectDigest: finalSubject.digest, workItemIds: [workIds[1]] },
    });
  };

  observedDeploymentIdentity = { kind: 'target-preflight-set', value: digest('f') };
  await acceptRekick('rekick-drift-0001');
  await supervisor.maintain();
  const driftOperation = await controlService.readOperation(operator, runId, {
    kind: 'rekick', requestId: 'rekick-drift-0001',
  });
  assert.equal(driftOperation.outcome.status, 'failed');
  assert.equal(driftOperation.outcome.code, 'REKICK_TARGET_IDENTITY_MISMATCH');
  const driftState = await readParentRun(store, runId);
  const driftPublication = await readCurrentEnvelope(store, runId);
  assert.equal(driftState.workItems[workIds[1]].state, 'incomplete');
  assert.deepEqual(driftState.workItems[workIds[1]].attempts, incompleteAttempts);
  assert.equal(driftPublication.digest, incompletePublication.digest);
  assert.equal(driftPublication.runRevision, incompletePublication.runRevision);
  await assert.rejects(() => supervisor.claim(worker), { code: 'NO_WORK_AVAILABLE' });

  observedDeploymentIdentity = null;
  reprobeFailure = 'target identity endpoint unavailable';
  await acceptRekick('rekick-unverified-0001');
  await supervisor.maintain();
  const unverifiedOperation = await controlService.readOperation(operator, runId, {
    kind: 'rekick', requestId: 'rekick-unverified-0001',
  });
  assert.equal(unverifiedOperation.outcome.status, 'failed');
  assert.equal(unverifiedOperation.outcome.code, 'REKICK_TARGET_IDENTITY_UNVERIFIED');
  const unverifiedState = await readParentRun(store, runId);
  const unverifiedPublication = await readCurrentEnvelope(store, runId);
  assert.equal(unverifiedState.workItems[workIds[1]].state, 'incomplete');
  assert.deepEqual(unverifiedState.workItems[workIds[1]].attempts, incompleteAttempts);
  assert.equal(unverifiedPublication.digest, incompletePublication.digest);
  assert.equal(unverifiedPublication.runRevision, incompletePublication.runRevision);
  await assert.rejects(() => supervisor.claim(worker), { code: 'NO_WORK_AVAILABLE' });

  reprobeFailure = null;
  observedDeploymentIdentity = subjectCore.deploymentIdentity;
  await acceptRekick('rekick-matched-0001');
  await supervisor.maintain();
  assert.equal((await controlService.readOperation(operator, runId, {
    kind: 'rekick', requestId: 'rekick-matched-0001',
  })).outcome.status, 'succeeded');
  const recoveryLease = await supervisor.claim(worker);
  assert.equal(recoveryLease.workItemId, workIds[1]);
  assert.equal(recoveryLease.attempt, 3);
  await publish(recoveryLease, 'completed_pass');
  await supervisor.maintain();

  const recoveredState = await readParentRun(store, runId);
  const recoveredPublication = await readCurrentEnvelope(store, runId);
  assert.equal(recoveredPublication.decision.code, 'FEATURE_READY');
  assert.equal(recoveredPublication.subjectCoreDigest, incompletePublication.subjectCoreDigest);
  assert.equal(recoveredPublication.finalSubjectDigest, incompletePublication.finalSubjectDigest);
  assert.equal(recoveredPublication.decisionRevision, incompletePublication.decisionRevision + 1);
  assert.equal(recoveredState.workItems[workIds[0]].canonicalResult.digest, preservedDigest);
  assert.deepEqual(recoveredState.workItems[workIds[0]].attempts, preservedAttempts,
    'rekick must not rerun or rewrite already completed work');
  assert.deepEqual(recoveredState.workItems[workIds[1]].attempts.map(({ outcome }) => outcome), [
    'operational_failure', 'operational_failure', 'completed_pass',
  ]);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('Shared rekick release self-test passed: exhausted work stays incomplete until exact recovery and preserves completed evidence.\n');
