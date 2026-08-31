import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  beginReleaseAuthorityBuildHandoff,
  cancelParentRun,
  claimWorkItem,
  createParentRun,
  openParentRunStore,
  publishCurrentEnvelope,
  publishAttemptEvidence,
  registerReleaseAuthorityHandoffCanaryRun,
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
  now += 1_000;
  const replayedPreparation = await prepareSharedAuthorityBuildHandoff({
    store: source, coordinator: sourceCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
    reportDirectory, handoffId, targetBuildIdentity: targetBuild, operatorReview, clock,
  });
  assert.equal(replayedPreparation.digest, prepared.digest,
    'handoff preparation must resume the persisted intent after admission closes');
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
  let completedSingleSiteRunId = 'handoff-health-single';
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
    const launchRun = (launchRequestId, launchRunId, operationId, maxAttempts = 1) => policy.withLaunchAdmission(
      launchRequestId,
      intent,
      async () => {
        await createParentRun(target, {
          runId: launchRunId,
          subjectCoreDigest: digest,
          finalSubjectDigest: digest,
          executionManifestDigest: digest,
          runnerRevision,
          compilationState: 'sealed',
          workItems: [{ id: `work-${mode}`, maxAttempts }],
        });
        return {
          runId: launchRunId,
          operationId,
          actor,
          compiledPlan: { createParentRunInput: { runnerRevision, subjectCore: { revisions: { configuration: configurationRevision } } } },
        };
      },
    );
    const launchPermit = await authorizeSharedBuildHandoffCanaryLaunch({
      store: target, admissionGate, reportDirectory, handoffId, mode, requestId, actor, intent,
      runId,
      probeTargetIdentity: async () => targetIdentity, clock,
    });
    assert.equal(launchPermit.activeBuildIdentity, targetBuild);
    await launchRun(requestId, runId, mode === 'single-site' ? '1'.repeat(64) : '2'.repeat(64));
    if (mode === 'single-site') {
      const permitFile = path.join(root, 'authority-handoff-permits', `${handoffId}-${mode}.json`);
      const modernPermit = JSON.parse(await readFile(permitFile, 'utf8'));
      const legacyBody = {
        schemaVersion: modernPermit.schemaVersion,
        kind: modernPermit.kind,
        handoffId: modernPermit.handoffId,
        mode: modernPermit.mode,
        runId: modernPermit.runId,
        targetBuildIdentity: modernPermit.targetBuildIdentity,
        selectorDigest: modernPermit.selectorDigest,
        coordinatorEpoch: modernPermit.coordinatorEpoch,
        registeredAt: modernPermit.registeredAt,
      };
      const legacyPermit = { ...legacyBody, digest: canonicalDigest(legacyBody) };
      await rm(path.join(root, 'authority-handoff-permits', 'history', `${modernPermit.digest.slice(7)}.json`));
      await writeFile(permitFile, `${JSON.stringify(legacyPermit)}\n`);
    }
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
    let acceptedRunId = runId;
    if (mode === 'single-site') {
      const replacementRunId = `${runId}-replacement`;
      const replacementRequestId = `handoff-${mode}-request-0002`;
      const replacementOptions = {
        store: target,
        admissionGate,
        reportDirectory,
        handoffId,
        mode,
        requestId: replacementRequestId,
        actor,
        intent,
        runId: replacementRunId,
        supersedeReason: 'The first canary reached a durable terminal non-ready result.',
        probeTargetIdentity: async () => targetIdentity,
        clock,
      };
      await expectCode('CUTOVER_CANARY_REPLACEMENT_BLOCKED', () => (
        authorizeSharedBuildHandoffCanaryLaunch(replacementOptions)
      ));
      await expectCode('AUTHORITY_HANDOFF_PERMIT_CONFLICT', () => (
        registerReleaseAuthorityHandoffCanaryRun(target, targetCoordinator, {
          expectedSelectorDigest: pending.digest,
          handoffId,
          mode,
          runId: replacementRunId,
          supersedesRunId: runId,
          supersedeAuthorizationDigest: canonicalDigest({ unsafe: 'nonterminal-replacement' }),
        })
      ));
      const failedLease = await claimWorkItem(target, runId, targetCoordinator, {
        workerId: `worker-${mode}-failed`, workItemId: `work-${mode}`, capabilities: ['browser:any'],
        resourceClasses: ['ordinary'], leaseMs: 1_000,
      });
      const failedInbox = await publishAttemptEvidence(target, runId, failedLease, {
        outcome: 'cancelled', reason: 'Synthetic terminal non-ready handoff canary.', artifacts: [],
      });
      await adoptAttemptEvidence(target, runId, targetCoordinator, failedInbox);
      await cancelParentRun(target, runId, targetCoordinator, {
        reason: 'Operator explicitly cancelled the first handoff canary.',
        actor: { id: 'operator:test', kind: 'human' },
      });
      assert.equal((await readParentRun(target, runId)).workItems[`work-${mode}`].state, 'cancelled');

      now += 10;
      const replacementPermit = await authorizeSharedBuildHandoffCanaryLaunch(replacementOptions);
      assert.equal(replacementPermit.revision, 2);
      assert.equal(replacementPermit.failureAttempts, 0);
      assert.equal(replacementPermit.supersedesRunId, runId);
      await launchRun(replacementRequestId, replacementRunId, '3'.repeat(64), 2);
      const storedPermit = JSON.parse(await readFile(
        path.join(root, 'authority-handoff-permits', `${handoffId}-${mode}.json`),
        'utf8',
      ));
      assert.equal(storedPermit.runId, replacementRunId);
      assert.equal(storedPermit.revision, 2);
      assert.equal(storedPermit.supersedesRunId, runId);
      assert.equal(storedPermit.supersedeAuthorizationDigest, replacementPermit.digest);
      assert.equal((await readdir(path.join(root, 'authority-handoff-permits', 'history'))).length, 2,
        'supersession must retain both immutable store permit revisions');

      const cancelHandoffCanary = async (cancelRunId, suffix, { failureOutcome = null } = {}) => {
        const cancelledLease = await claimWorkItem(target, cancelRunId, targetCoordinator, {
          workerId: `worker-${mode}-cancelled-${suffix}`,
          workItemId: `work-${mode}`,
          capabilities: ['browser:any'],
          resourceClasses: ['ordinary'],
          leaseMs: 1_000,
        });
        const cancelledInbox = await publishAttemptEvidence(target, cancelRunId, cancelledLease, {
          outcome: failureOutcome ?? 'cancelled',
          reason: failureOutcome !== null
            ? `Synthetic ${failureOutcome} worker failure for handoff canary ${suffix}.`
            : `Synthetic cancelled handoff canary ${suffix}.`,
          artifacts: [],
        });
        await adoptAttemptEvidence(target, cancelRunId, targetCoordinator, cancelledInbox);
        if (failureOutcome !== null) {
          assert.equal(
            (await readParentRun(target, cancelRunId)).workItems[`work-${mode}`].state,
            failureOutcome === 'operational_failure' ? 'queued' : 'incomplete',
          );
        }
        await cancelParentRun(target, cancelRunId, targetCoordinator, {
          reason: `Operator explicitly cancelled handoff canary ${suffix}.`,
          actor: { id: 'operator:test', kind: 'human' },
        });
        assert.equal((await readParentRun(target, cancelRunId)).workItems[`work-${mode}`].state, 'cancelled');
      };

      await cancelHandoffCanary(replacementRunId, 'replacement-one', { failureOutcome: 'operational_failure' });
      now += 10;
      const replacementTwoRunId = `${runId}-replacement-two`;
      const replacementTwoRequestId = `handoff-${mode}-request-0003`;
      const upperPermitFile = path.join(
        admissionGate.root,
        `cutover-canary-${handoffId}-${mode}.json`,
      );
      const validUpperPermit = JSON.parse(await readFile(upperPermitFile, 'utf8'));
      const {
        digest: ignoredUpperDigest,
        failureAttempts: ignoredUpperFailureAttempts,
        ...forgedUpperBody
      } = {
        ...validUpperPermit,
        supersedesRunId: 'unrelated-upper-lineage-run',
      };
      await writeFile(upperPermitFile, `${JSON.stringify({
        ...forgedUpperBody,
        digest: canonicalDigest(forgedUpperBody),
      })}\n`);
      await expectCode('CUTOVER_DOCUMENT_INVALID', () => authorizeSharedBuildHandoffCanaryLaunch({
        ...replacementOptions,
        requestId: replacementTwoRequestId,
        runId: replacementTwoRunId,
        supersedeReason: 'The second canary was explicitly cancelled before completion.',
      }));
      await writeFile(upperPermitFile, `${JSON.stringify(validUpperPermit)}\n`);
      const replacementTwoPermit = await authorizeSharedBuildHandoffCanaryLaunch({
        ...replacementOptions,
        requestId: replacementTwoRequestId,
        runId: replacementTwoRunId,
        supersedeReason: 'The second canary was explicitly cancelled before completion.',
      });
      assert.equal(replacementTwoPermit.revision, 3);
      assert.equal(replacementTwoPermit.failureAttempts, 1,
        'handoff cancellation must not erase a preserved operational failure attempt');
      const lowerPermitFile = path.join(root, 'authority-handoff-permits', `${handoffId}-${mode}.json`);
      const validLowerPermit = JSON.parse(await readFile(lowerPermitFile, 'utf8'));
      const {
        digest: ignoredLowerDigest,
        failureAttempts: ignoredLowerFailureAttempts,
        ...forgedLowerBody
      } = {
        ...validLowerPermit,
        supersedesRunId: 'unrelated-lower-lineage-run',
      };
      await writeFile(lowerPermitFile, `${JSON.stringify({
        ...forgedLowerBody,
        digest: canonicalDigest(forgedLowerBody),
      })}\n`);
      await expectCode('AUTHORITY_HANDOFF_PERMIT_INVALID', () => (
        launchRun(replacementTwoRequestId, replacementTwoRunId, '4'.repeat(64))
      ));
      await writeFile(lowerPermitFile, `${JSON.stringify(validLowerPermit)}\n`);
      await launchRun(replacementTwoRequestId, replacementTwoRunId, '4'.repeat(64));

      await cancelHandoffCanary(replacementTwoRunId, 'replacement-two', { failureOutcome: 'incomplete_unknown' });
      now += 10;
      const replacementThreeRunId = `${runId}-replacement-three`;
      const replacementThreeRequestId = `handoff-${mode}-request-0004`;
      const replacementThreePermit = await authorizeSharedBuildHandoffCanaryLaunch({
        ...replacementOptions,
        requestId: replacementThreeRequestId,
        runId: replacementThreeRunId,
        supersedeReason: 'The third canary was explicitly cancelled before completion.',
      });
      assert.equal(replacementThreePermit.revision, 4);
      assert.equal(replacementThreePermit.failureAttempts, 2,
        'handoff cancellation must not erase a preserved incomplete-unknown attempt');
      await launchRun(replacementThreeRequestId, replacementThreeRunId, '5'.repeat(64));
      const fourthStoredPermit = JSON.parse(await readFile(
        path.join(root, 'authority-handoff-permits', `${handoffId}-${mode}.json`),
        'utf8',
      ));
      assert.equal(fourthStoredPermit.runId, replacementThreeRunId);
      assert.equal(fourthStoredPermit.revision, 4,
        'upper and lower handoff permit histories must both accept the fourth cancellation replacement');
      assert.equal(fourthStoredPermit.failureAttempts, 2);
      assert.equal((await readdir(path.join(root, 'authority-handoff-permits', 'history'))).length, 4);
      acceptedRunId = replacementThreeRunId;
      completedSingleSiteRunId = replacementThreeRunId;
    }
    const lease = await claimWorkItem(target, acceptedRunId, targetCoordinator, {
      workerId: `worker-${mode}`, workItemId: `work-${mode}`, capabilities: ['browser:any'],
      resourceClasses: ['ordinary'], leaseMs: 1_000,
    });
    const inbox = await publishAttemptEvidence(target, acceptedRunId, lease, {
      outcome: 'completed_pass', reason: null, artifacts: [],
    });
    await adoptAttemptEvidence(target, acceptedRunId, targetCoordinator, inbox);
    const state = await readParentRun(target, acceptedRunId);
    assert.equal(state.workItems[`work-${mode}`].state, 'completed_pass');
    const publication = readyEnvelope(acceptedRunId, mode, state.ledgerSequences.mutation);
    await publishCurrentEnvelope(target, acceptedRunId, targetCoordinator, publication);
    evidenceByRun.set(acceptedRunId, {
      runId: acceptedRunId, mode, createdAt: state.createdAt,
      subjectCoreDigest: state.subjectCoreDigest, finalSubjectDigest: state.finalSubjectDigest,
      publicationDigest: publication.digest, decisionCode: 'RELEASE_READY', decisionRevision: 1,
      grantedAuthority: 'FULL', deploymentIdentity: targetIdentity, trustedReprobeIdentity: targetIdentity,
      runnerRevision, configurationRevision, activeBuildIdentity: targetBuild,
    });
    if (mode === 'single-site') {
      await expectCode('CUTOVER_CANARY_REPLACEMENT_BLOCKED', () => authorizeSharedBuildHandoffCanaryLaunch({
        store: target, admissionGate, reportDirectory, handoffId, mode,
        requestId: `handoff-${mode}-request-0005`, actor, intent,
        runId: `${acceptedRunId}-unsafe-ready-replacement`,
        supersedeReason: 'Ready publications must never be superseded.',
        probeTargetIdentity: async () => targetIdentity, clock,
      }));
      await expectCode('AUTHORITY_HANDOFF_PERMIT_CONFLICT', () => (
        registerReleaseAuthorityHandoffCanaryRun(target, targetCoordinator, {
          expectedSelectorDigest: pending.digest,
          handoffId,
          mode,
          runId: `${acceptedRunId}-unsafe-ready-replacement`,
          supersedesRunId: acceptedRunId,
          supersedeAuthorizationDigest: canonicalDigest({ unsafe: 'ready-replacement' }),
        })
      ));
      await expectCode('CUTOVER_CANARY_NOT_READY', () => recordSharedBuildHandoffCanary({
        store: target, admissionGate, reportDirectory, handoffId, mode, runId: acceptedRunId,
        readCanaryEvidence: async () => ({ ...evidenceByRun.get(acceptedRunId), decisionCode: 'NOT_READY_TEST_FAILURE' }),
        probeTargetIdentity: async () => targetIdentity, clock,
      }));
      assert.equal((await admissionGate.read()).state, 'CLOSED');
    }
    await recordSharedBuildHandoffCanary({
      store: target, admissionGate, reportDirectory, handoffId, mode, runId: acceptedRunId,
      readCanaryEvidence: async () => evidenceByRun.get(acceptedRunId),
      probeTargetIdentity: async () => targetIdentity, clock,
    });
  }

  await expectCode('STALE_COORDINATOR', () => publishCurrentEnvelope(
    source, 'handoff-health-single', sourceCoordinator, readyEnvelope('handoff-health-single', 'single-site'),
  ));
  await expectCode('CUTOVER_CANARY_STALE', () => completeSharedAuthorityBuildHandoff({
    store: target, coordinator: targetCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
    reportDirectory, handoffId,
    readCanaryEvidence: async (_store, runId) => (runId === completedSingleSiteRunId
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

  const failureBoundHandoffId = 'handoff-b-to-a-failure-bound';
  const failureBoundPending = await beginReleaseAuthorityBuildHandoff(target, targetCoordinator, {
    expectedSelectorDigest: completed.digest,
    handoffId: failureBoundHandoffId,
    targetBuildIdentity: sourceBuild,
  });
  const returnSource = await open(sourceBuild, completed.storeGeneration);
  const returnCoordinator = await acquireStoreCoordinator(returnSource, {
    ownerId: 'coordinator-return-source', leaseMs: 60_000,
  });
  const registerFailureBoundRun = (runId, supersedesRunId = null, ordinal = 1) => (
    registerReleaseAuthorityHandoffCanaryRun(returnSource, returnCoordinator, {
      expectedSelectorDigest: failureBoundPending.digest,
      handoffId: failureBoundHandoffId,
      mode: 'single-site',
      runId,
      ...(supersedesRunId === null ? {} : {
        supersedesRunId,
        supersedeAuthorizationDigest: canonicalDigest({ failureBoundHandoffId, ordinal }),
      }),
    })
  );
  const preserveHandoffProductFailure = async (runId, ordinal) => {
    await createParentRun(returnSource, {
      runId,
      subjectCoreDigest: digest,
      finalSubjectDigest: digest,
      executionManifestDigest: digest,
      runnerRevision,
      compilationState: 'sealed',
      workItems: [{ id: `work-failure-bound-${ordinal}`, maxAttempts: 1 }],
    });
    const failureLease = await claimWorkItem(returnSource, runId, returnCoordinator, {
      workerId: `worker-failure-bound-${ordinal}`,
      capabilities: ['browser:any'],
      resourceClasses: ['ordinary'],
      leaseMs: 1_000,
    });
    const failureInbox = await publishAttemptEvidence(returnSource, runId, failureLease, {
      outcome: 'completed_product_failure',
      reason: `Preserved handoff product failure ${ordinal}.`,
      artifacts: [],
    });
    await adoptAttemptEvidence(returnSource, runId, returnCoordinator, failureInbox);
  };

  const boundedRunOne = 'handoff-failure-bound-run-1';
  const boundedRunTwo = 'handoff-failure-bound-run-2';
  const boundedRunThree = 'handoff-failure-bound-run-3';
  const boundedRunFour = 'handoff-failure-bound-run-4';
  const boundedPermitOne = await registerFailureBoundRun(boundedRunOne);
  assert.equal(boundedPermitOne.revision, 1);
  await preserveHandoffProductFailure(boundedRunOne, 1);
  const boundedPermitTwo = await registerFailureBoundRun(boundedRunTwo, boundedRunOne, 2);
  assert.equal(boundedPermitTwo.revision, 2);
  assert.equal(boundedPermitTwo.failureAttempts, 1);
  await preserveHandoffProductFailure(boundedRunTwo, 2);
  const boundedPermitThree = await registerFailureBoundRun(boundedRunThree, boundedRunTwo, 3);
  assert.equal(boundedPermitThree.revision, 3);
  assert.equal(boundedPermitThree.failureAttempts, 2);
  await preserveHandoffProductFailure(boundedRunThree, 3);
  await expectCode('AUTHORITY_HANDOFF_PERMIT_CONFLICT', () => (
    registerFailureBoundRun(boundedRunFour, boundedRunThree, 4)
  ));
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(floorRoot, { recursive: true, force: true });
}

process.stdout.write('Shared build handoff self-test passed: separate source and target handles enforce pending writer ownership and health-fenced activation.\n');
