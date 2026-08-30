import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { appendPublicationEnvelope } from '../shared/publication-envelope.mjs';
import {
  PARENT_RUN_STORE_SCHEMA_VERSION,
  PARENT_RUN_WRITER_PROTOCOL,
  acceptOperation,
  acquireStoreCoordinator,
  adoptAttemptEvidence,
  cancelParentRun,
  claimWorkItem,
  createParentRun,
  openParentRunStore,
  publishCurrentEnvelope,
  publishAttemptEvidence,
  requestStorePerformanceDrain,
  readCurrentEnvelope,
  readParentRun,
  readReleaseAuthoritySelector,
  transitionReleaseAuthority,
} from './lib/parent-run-store.mjs';
import {
  authorizeSharedBuildHandoffCanaryLaunch,
  beginSharedAuthorityBuildHandoff,
  captureSharedAuthorityDrainObservation,
  completeSharedAuthorityBuildHandoff,
  createCutoverAdmissionPolicy,
  initializeCutoverAdmissionGate,
  prepareSharedAuthorityBuildHandoff,
  recordSharedBuildHandoffCanary,
} from './lib/shared-cutover-orchestrator.mjs';
import { initializeLegacyAuthorityFence } from './lib/legacy-authority-fence.mjs';
import { openSharedLaunchOperationStore } from './lib/shared-launch-operation-store.mjs';
import { initializeSharedAuthorityFloor } from './lib/shared-authority-floor.mjs';

const marker = '91'.repeat(32);
const sourceBuild = 'build:handoff-source-a';
const targetBuild = 'build:handoff-target-b';
const handoffId = 'handoff-a-to-b-0001';
const root = await mkdtemp(path.join(tmpdir(), 'shared-build-handoff-'));
const floorRoot = await mkdtemp(path.join(tmpdir(), 'shared-build-handoff-floor-'));
let now = Date.parse('2026-08-29T22:00:00.000Z');
const clock = () => now;
const digest = canonicalDigest({ fixture: 'shared-build-handoff' });

function expectCode(code, operation) {
  return assert.rejects(operation, (error) => error?.code === code);
}

function readyEnvelope(runId, mode, observationCount = 1) {
  const decision = {
    schemaVersion: 1,
    kind: 'release-decision',
    runId,
    decisionRevision: 1,
    code: 'RELEASE_READY',
    label: 'RELEASE READY',
    ready: true,
    exitCode: 0,
    executionManifestDigest: digest,
    mode,
    grantedAuthority: 'FULL',
    certifiedScope: { features: ['site'], definitions: ['HOME-001'], targets: ['desktop'], knownLimits: [] },
    coverageBasis: { selectedDefinitions: ['HOME-001'], selectedTargets: ['desktop'], excludedAsNotApplicable: [] },
    subjectDigest: digest,
    blockingReasons: [],
    superseded: false,
  };
  decision.digest = canonicalDigest(decision);
  return appendPublicationEnvelope(null, {
    schemaVersion: 1,
    runId,
    runRevision: 1,
    decisionRevision: 1,
    riskRevision: 1,
    ledgerSequences: { observations: observationCount, decisions: 1, risks: 0 },
    finalSubjectDigest: digest,
    decision,
    riskRegister: { schemaVersion: 1, availability: 'EMPTY', risks: [] },
  });
}

async function open(buildIdentity, expectedStoreGeneration = null) {
  return openParentRunStore({
    root,
    deploymentIdentity: 'compose-project:handoff-test',
    volumeIdentity: 'named-volume:handoff-test',
    storeMarker: marker,
    ...(expectedStoreGeneration === null ? { storeGeneration: 5 } : { expectedStoreGeneration }),
    schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
    buildIdentity,
    backupMarker: 'backup:handoff-test',
    prequalifiedRollbackBuilds: [sourceBuild, targetBuild],
    verifyStorage: false,
    clock,
  });
}

try {
  const source = await open(sourceBuild);
  const sourceCoordinator = await acquireStoreCoordinator(source, {
    ownerId: 'coordinator-source-a', leaseMs: 60_000,
  });
  const shadow = await readReleaseAuthoritySelector(source);
  const draining = await transitionReleaseAuthority(source, sourceCoordinator, {
    expectedSelectorDigest: shadow.digest,
    phase: 'DRAINING',
    buildIdentity: sourceBuild,
  });
  const activeA = await transitionReleaseAuthority(source, sourceCoordinator, {
    expectedSelectorDigest: draining.digest,
    phase: 'ACTIVE',
    activationRevision: 77,
    buildIdentity: sourceBuild,
    activationCutoverDigest: digest,
    authorityTransitionDigest: digest,
  });
  await createParentRun(source, {
    runId: 'source-era-run',
    subjectCoreDigest: digest,
    runnerRevision: digest,
    workItems: [{ id: 'source-era-performance', maxAttempts: 1, resourceClass: 'performance', capability: 'performance:lighthouse' }],
  });
  const authorityFloor = await initializeSharedAuthorityFloor({
    root: floorRoot,
    protectedRoots: [root],
    verifyStorage: false,
    clock,
    initial: {
      storeMarkerDigest: activeA.storeMarkerDigest,
      minimumStoreGeneration: activeA.storeGeneration,
      minimumSelectorRevision: activeA.revision,
      activeBuildIdentity: activeA.activeBuildIdentity,
      authorityTransitionDigest: activeA.authorityTransitionDigest,
      activationEpoch: 1,
      legacyPermanentlyRetired: true,
      activationRevision: activeA.activationRevision,
      activationCutoverDigest: activeA.activationCutoverDigest,
    },
  });
  const admissionGate = await initializeCutoverAdmissionGate({
    root: path.join(root, 'cutover-admission'), verifyStorage: false, clock,
  });
  const legacyAuthorityFence = await initializeLegacyAuthorityFence({
    root: path.join(root, 'legacy-authority'), verifyStorage: false, clock,
  });
  let legacy = await legacyAuthorityFence.read();
  legacy = await legacyAuthorityFence.close(legacy.digest, 'initial-cutover');
  legacy = await legacyAuthorityFence.freeze(legacy.digest, 'initial-cutover');
  legacy = await legacyAuthorityFence.activate(legacy.digest, 'initial-cutover', 1);
  assert.equal(legacy.state, 'ACTIVATED');
  const launchOperationStore = await openSharedLaunchOperationStore({
    root: path.join(root, 'launch-operations'), clock,
  });
  const legacyComparativeRoot = path.join(root, 'legacy-comparative');
  const legacySingleSiteQueueRoot = path.join(root, 'legacy-single-site');
  await Promise.all([
    mkdir(legacyComparativeRoot, { recursive: true }),
    mkdir(path.join(legacySingleSiteQueueRoot, 'jobs'), { recursive: true }),
  ]);
  const reportDirectory = path.join(root, 'handoff-reports');
  const operatorReview = {
    reviewed: true,
    actorId: 'operator:handoff-reviewer',
    reviewedAt: new Date(now).toISOString(),
  };
  const prepared = await prepareSharedAuthorityBuildHandoff({
    store: source, coordinator: sourceCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
    reportDirectory, handoffId, targetBuildIdentity: targetBuild, operatorReview, clock,
  });
  assert.equal(prepared.status, 'ADMISSION_CLOSED');
  const drainObservation = await captureSharedAuthorityDrainObservation({
    store: source, coordinator: sourceCoordinator, admissionGate, legacyAuthorityFence,
    launchOperationStore, cutoverId: handoffId,
    legacyComparativeRoot, legacySingleSiteQueueRoot, clock,
  });
  const pendingReport = await beginSharedAuthorityBuildHandoff({
    store: source, coordinator: sourceCoordinator, admissionGate, legacyAuthorityFence,
    reportDirectory, handoffId, drainObservation, clock,
  });
  const pending = pendingReport.selectorPending;
  assert.equal(pending.phase, 'PROMOTION_DISABLED');
  assert.equal(pending.activeBuildIdentity, sourceBuild);
  assert.equal(pending.pendingBuildIdentity, targetBuild);
  assert.equal(pending.handoffId, handoffId);
  assert.equal((await legacyAuthorityFence.read()).state, 'ACTIVATED');

  await expectCode('STORE_WRITER_NOT_ACTIVE', () => acquireStoreCoordinator(source, {
    ownerId: 'coordinator-source-reacquire', leaseMs: 60_000,
  }));
  await expectCode('STALE_COORDINATOR', () => transitionReleaseAuthority(source, sourceCoordinator, {
    expectedSelectorDigest: pending.digest,
    phase: 'ACTIVE',
    activationRevision: pending.activationRevision,
    buildIdentity: sourceBuild,
  }));

  const target = await open(targetBuild, activeA.storeGeneration);
  const targetCoordinator = await acquireStoreCoordinator(target, {
    ownerId: 'coordinator-target-b', leaseMs: 60_000,
  });
  await expectCode('AUTHORITY_HANDOFF_CANARY_REQUIRED', () => acceptOperation(target, 'source-era-run', {
    idempotencyKey: 'source-era-rekick-0001', kind: 'rekick', actor: { id: 'operator:test', kind: 'human' },
    body: { reason: 'must stay fenced' },
  }));
  await expectCode('AUTHORITY_HANDOFF_CANARY_REQUIRED', () => cancelParentRun(target, 'source-era-run', targetCoordinator, {
    reason: 'must stay fenced', actor: { id: 'operator:test', kind: 'human' },
  }));
  await expectCode('AUTHORITY_HANDOFF_CANARY_REQUIRED', () => requestStorePerformanceDrain(target, targetCoordinator, {
    workerId: 'source-era-performance-worker', capabilities: ['performance:lighthouse'],
    resourceClasses: ['performance'], runIds: ['source-era-run'], leaseMs: 1_000,
  }));
  await expectCode('AUTHORITY_HANDOFF_HEALTH_REQUIRED', () => transitionReleaseAuthority(target, targetCoordinator, {
    expectedSelectorDigest: pending.digest,
    phase: 'ACTIVE',
    activationRevision: pending.activationRevision,
    buildIdentity: targetBuild,
  }));
  const targetIdentity = { kind: 'target-preflight-set', value: canonicalDigest({ target: 'handoff' }) };
  const runnerRevision = canonicalDigest({ runner: 'handoff-target' });
  const configurationRevision = canonicalDigest({ configuration: 'handoff-target' });
  const policy = createCutoverAdmissionPolicy({ admissionGate, store: target });
  const evidenceByRun = new Map();
  for (const [mode, runId] of [['single-site', 'handoff-health-single'], ['comparative', 'handoff-health-comparative']]) {
    now += 10;
    const intent = {
      schemaVersion: 1,
      runContract: mode === 'single-site'
        ? {
          schemaVersion: 1, mode, targetIds: ['audited'],
          scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
          url: 'https://candidate.example.test', deploymentRole: 'preview', certificatePolicy: 'strict',
        }
        : {
          schemaVersion: 1, mode, targetIds: ['candidate', 'production'],
          scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
          candidateUrl: 'https://candidate.example.test', productionUrl: 'https://production.example.test',
        },
    };
    const requestId = `handoff-${mode}-request-0001`;
    const actor = { id: 'operator:handoff-canary', kind: 'human' };
    const launchPermit = await authorizeSharedBuildHandoffCanaryLaunch({
      store: target, admissionGate, reportDirectory, handoffId, mode, requestId, actor, intent,
      runId,
      probeTargetIdentity: async () => targetIdentity, clock,
    });
    assert.equal(launchPermit.activeBuildIdentity, targetBuild);
    await policy.withLaunchAdmission(requestId, intent, async () => {
      await createParentRun(target, {
        runId,
        subjectCoreDigest: digest,
        finalSubjectDigest: digest,
        executionManifestDigest: digest,
        runnerRevision,
        compilationState: 'sealed',
        workItems: [{ id: `work-${mode}`, maxAttempts: 1 }],
      });
      return {
        runId,
        operationId: mode === 'single-site' ? '1'.repeat(64) : '2'.repeat(64),
        actor,
        compiledPlan: { createParentRunInput: { runnerRevision, subjectCore: { revisions: { configuration: configurationRevision } } } },
      };
    });
    const unpermittedRunId = `${runId}-unpermitted`;
    await expectCode('AUTHORITY_HANDOFF_CANARY_REQUIRED', () => createParentRun(target, {
      runId: unpermittedRunId,
      subjectCoreDigest: digest,
      finalSubjectDigest: digest,
      executionManifestDigest: digest,
      runnerRevision,
      compilationState: 'sealed',
      workItems: [{ id: `work-unpermitted-${mode}`, maxAttempts: 1 }],
    }));
    const lease = await claimWorkItem(target, runId, targetCoordinator, {
      workerId: `worker-${mode}`, workItemId: `work-${mode}`, capabilities: ['browser:any'],
      resourceClasses: ['ordinary'], leaseMs: 1_000,
    });
    const inbox = await publishAttemptEvidence(target, runId, lease, {
      outcome: 'completed_pass', reason: null, artifacts: [],
    });
    await adoptAttemptEvidence(target, runId, targetCoordinator, inbox);
    const state = await readParentRun(target, runId);
    assert.equal(state.workItems[`work-${mode}`].state, 'completed_pass');
    const publication = readyEnvelope(runId, mode, state.ledgerSequences.mutation);
    await publishCurrentEnvelope(target, runId, targetCoordinator, publication);
    evidenceByRun.set(runId, {
      runId, mode, createdAt: state.createdAt,
      subjectCoreDigest: state.subjectCoreDigest, finalSubjectDigest: state.finalSubjectDigest,
      publicationDigest: publication.digest, decisionCode: 'RELEASE_READY', decisionRevision: 1,
      grantedAuthority: 'FULL', deploymentIdentity: targetIdentity, trustedReprobeIdentity: targetIdentity,
      runnerRevision, configurationRevision, activeBuildIdentity: targetBuild,
    });
    if (mode === 'single-site') {
      await expectCode('CUTOVER_CANARY_NOT_READY', () => recordSharedBuildHandoffCanary({
        store: target, admissionGate, reportDirectory, handoffId, mode, runId,
        readCanaryEvidence: async () => ({ ...evidenceByRun.get(runId), decisionCode: 'NOT_READY_TEST_FAILURE' }),
        probeTargetIdentity: async () => targetIdentity, clock,
      }));
      assert.equal((await admissionGate.read()).state, 'CLOSED');
    }
    await recordSharedBuildHandoffCanary({
      store: target, admissionGate, reportDirectory, handoffId, mode, runId,
      readCanaryEvidence: async () => evidenceByRun.get(runId),
      probeTargetIdentity: async () => targetIdentity, clock,
    });
  }

  await expectCode('STALE_COORDINATOR', () => publishCurrentEnvelope(
    source, 'handoff-health-single', sourceCoordinator, readyEnvelope('handoff-health-single', 'single-site'),
  ));
  await expectCode('CUTOVER_CANARY_STALE', () => completeSharedAuthorityBuildHandoff({
    store: target, coordinator: targetCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
    reportDirectory, handoffId,
    readCanaryEvidence: async (_store, runId) => (runId === 'handoff-health-single'
      ? { ...evidenceByRun.get(runId), decisionRevision: 2 }
      : evidenceByRun.get(runId)),
    probeTargetIdentity: async () => targetIdentity, clock,
  }));
  assert.equal((await admissionGate.read()).state, 'CLOSED');
  await assert.rejects(() => completeSharedAuthorityBuildHandoff({
    store: target, coordinator: targetCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
    reportDirectory, handoffId, readCanaryEvidence: async (_store, runId) => evidenceByRun.get(runId),
    probeTargetIdentity: async () => targetIdentity, clock,
    hooks: { afterAuthorityFloorAdvanced: () => { throw new Error('synthetic crash after external floor advance'); } },
  }), /synthetic crash after external floor advance/u);
  assert.equal((await readReleaseAuthoritySelector(target)).phase, 'PROMOTION_DISABLED');
  assert.equal((await authorityFloor.read()).activeBuildIdentity, targetBuild);
  await expectCode('AUTHORITY_HANDOFF_HEALTH_REQUIRED', () => transitionReleaseAuthority(target, targetCoordinator, {
    expectedSelectorDigest: pending.digest,
    phase: 'ACTIVE',
    activationRevision: pending.activationRevision,
    buildIdentity: targetBuild,
  }));
  await assert.rejects(() => completeSharedAuthorityBuildHandoff({
    store: target, coordinator: targetCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
    reportDirectory, handoffId, readCanaryEvidence: async (_store, runId) => evidenceByRun.get(runId),
    probeTargetIdentity: async () => targetIdentity, clock,
    hooks: { afterAuthorityCommitted: () => { throw new Error('synthetic crash after target selector commit'); } },
  }), /synthetic crash after target selector commit/u);
  assert.equal((await admissionGate.read()).state, 'CLOSED');
  const completedReport = await completeSharedAuthorityBuildHandoff({
    store: target, coordinator: targetCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
    reportDirectory, handoffId, readCanaryEvidence: async (_store, runId) => evidenceByRun.get(runId),
    probeTargetIdentity: async () => targetIdentity, clock,
  });
  const completed = completedReport.selectorAfter;
  assert.equal(completedReport.status, 'ACTIVE_TARGET_ADMISSION_OPEN');
  assert.equal(completed.activeBuildIdentity, targetBuild);
  assert.equal(completed.pendingBuildIdentity, null);
  assert.equal((await admissionGate.read()).state, 'OPEN');
  assert.equal((await legacyAuthorityFence.read()).state, 'ACTIVATED');

  await expectCode('STORE_WRITER_NOT_ACTIVE', () => acquireStoreCoordinator(source, {
    ownerId: 'coordinator-source-after-complete', leaseMs: 60_000,
  }));
  assert.equal((await readReleaseAuthoritySelector(await open(targetBuild, completed.storeGeneration))).digest, completed.digest);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(floorRoot, { recursive: true, force: true });
}

process.stdout.write('Shared build handoff self-test passed: separate source and target handles enforce pending writer ownership and health-fenced activation.\n');
