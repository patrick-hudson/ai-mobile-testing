import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalDigest, canonicalJson } from '../shared/canonical-contract.mjs';
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
  prequalifyReleaseAuthorityBuild,
  publishCurrentEnvelope,
  publishAttemptEvidence,
  registerReleaseAuthorityHandoffCanaryRun,
  requestStorePerformanceDrain,
  readCurrentEnvelope,
  readParentRun,
  readReleaseAuthoritySelector,
  transitionReleaseAuthority,
  withReleaseAuthoritySelectorFence,
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
const prequalificationProbeBuild = 'build:handoff-prequalification-c';
const postIntentPrequalificationBuild = 'build:handoff-prequalification-d';
const postPreparePrequalificationBuild = 'build:handoff-prequalification-e';
const racingPrequalificationBuild = 'build:handoff-prequalification-f';
const handoffId = 'handoff-a-to-b-0001';
const root = await mkdtemp(path.join(tmpdir(), 'shared-build-handoff-'));
const floorRoot = await mkdtemp(path.join(tmpdir(), 'shared-build-handoff-floor-'));
const migrationRoot = await mkdtemp(path.join(tmpdir(), 'shared-build-handoff-migration-'));
const migrationFloorRoot = await mkdtemp(path.join(tmpdir(), 'shared-build-handoff-migration-floor-'));
const reservationBoundaryRoot = await mkdtemp(path.join(tmpdir(), 'shared-build-handoff-reservation-boundary-'));
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
  // A real handoff is prepared after prequalification has advanced the active
  // selector. The retained activation report therefore names an older selector
  // digest while preserving the same activation lineage.
  const prequalificationTransition = canonicalDigest({ fixture: 'prequalification-before-admission-transfer' });
  const prequalifiedSource = await prequalifyReleaseAuthorityBuild(source, sourceCoordinator, {
    expectedSelectorDigest: activeA.digest,
    expectedManifestDigest: source.manifest.digest,
    expectedManifest: source.manifest,
    targetBuildIdentity: prequalificationProbeBuild,
    expectedTargetSelectorRevision: activeA.revision + 1,
    authorityTransitionDigest: prequalificationTransition,
  });
  const floorBeforePrequalification = await authorityFloor.read();
  await authorityFloor.compareAndAdvance(floorBeforePrequalification.digest, {
    minimumStoreGeneration: prequalifiedSource.storeGeneration,
    minimumSelectorRevision: prequalifiedSource.revision,
    activeBuildIdentity: sourceBuild,
    authorityTransitionDigest: prequalificationTransition,
    activationEpoch: 1,
    legacyPermanentlyRetired: true,
    activationRevision: activeA.activationRevision,
    activationCutoverDigest: activeA.activationCutoverDigest,
  });
  assert.ok(prequalifiedSource.revision > activeA.revision);
  assert.notEqual(prequalifiedSource.digest, activeA.digest);
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
  let activationGate = await admissionGate.read();
  activationGate = await admissionGate.close(activationGate.digest, 'initial-cutover');
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
  await mkdir(reportDirectory, { recursive: true });
  const activationReportBody = {
    schemaVersion: 1,
    kind: 'release-authority-cutover-report',
    cutoverId: 'initial-cutover',
    status: 'ACTIVE_ADMISSION_CLOSED',
    inputDigest: activeA.activationCutoverDigest,
    selectorAfter: activeA,
    admissionGateAfter: activationGate,
  };
  const activationReport = { ...activationReportBody, digest: canonicalDigest(activationReportBody) };
  await writeFile(
    path.join(reportDirectory, 'initial-cutover.json'),
    `${JSON.stringify(activationReport)}\n`,
  );
  // Transfer is intentionally metadata-only: it must leave prior cutover permits
  // and their evidence untouched even when that cutover exhausted its retry budget.
  const preservedLegacyPermit = path.join(
    admissionGate.root, 'cutover-canary-initial-cutover-single-site.json',
  );
  const preservedLegacyPermitBytes = '{"retained":"legacy-permit-and-evidence"}\n';
  await writeFile(preservedLegacyPermit, preservedLegacyPermitBytes);
  const operatorReview = {
    reviewed: true,
    actorId: 'operator:handoff-reviewer',
    reviewedAt: new Date(now).toISOString(),
  };
  await expectCode('AUTHORITY_HANDOFF_ADMISSION_TRANSFER_INVALID', () => (
    prepareSharedAuthorityBuildHandoff({
      store: source, coordinator: sourceCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
      reportDirectory, handoffId, targetBuildIdentity: targetBuild, operatorReview,
      adoptClosedAdmissionFromCutoverId: 'wrong-owner', clock,
    })
  ));
  const staleHandoffId = 'handoff-stale-selector-intent-0001';
  let selectorAfterIntentAdvance;
  await expectCode('AUTHORITY_HANDOFF_INVALID', () => (
    prepareSharedAuthorityBuildHandoff({
      store: source, coordinator: sourceCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
      reportDirectory, handoffId: staleHandoffId, targetBuildIdentity: targetBuild, operatorReview,
      adoptClosedAdmissionFromCutoverId: 'initial-cutover', clock,
      hooks: {
        afterAdmissionIntentPersisted: async () => {
          const selectorBeforeIntentAdvance = await readReleaseAuthoritySelector(source);
          const postIntentTransition = canonicalDigest({ fixture: 'prequalification-after-admission-intent' });
          selectorAfterIntentAdvance = await prequalifyReleaseAuthorityBuild(source, sourceCoordinator, {
            expectedSelectorDigest: selectorBeforeIntentAdvance.digest,
            expectedManifestDigest: source.manifest.digest,
            expectedManifest: source.manifest,
            targetBuildIdentity: postIntentPrequalificationBuild,
            expectedTargetSelectorRevision: selectorBeforeIntentAdvance.revision + 1,
            authorityTransitionDigest: postIntentTransition,
          });
          const floorBeforeIntentAdvance = await authorityFloor.read();
          await authorityFloor.compareAndAdvance(floorBeforeIntentAdvance.digest, {
            minimumStoreGeneration: selectorAfterIntentAdvance.storeGeneration,
            minimumSelectorRevision: selectorAfterIntentAdvance.revision,
            activeBuildIdentity: sourceBuild,
            authorityTransitionDigest: postIntentTransition,
            activationEpoch: 1,
            legacyPermanentlyRetired: true,
            activationRevision: activeA.activationRevision,
            activationCutoverDigest: activeA.activationCutoverDigest,
          });
        },
      },
    })
  ));
  assert.equal((await admissionGate.read()).digest, activationGate.digest,
    'selector movement after intent persistence must fail before closed-admission ownership changes');
  assert.ok(JSON.parse(await readFile(
    path.join(reportDirectory, `${staleHandoffId}.handoff.intent.json`), 'utf8',
  )).digest, 'the rejected stale handoff intent remains auditable history');
  let prequalificationRacingGateCommit;
  await assert.rejects(() => prepareSharedAuthorityBuildHandoff({
    store: source, coordinator: sourceCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
    reportDirectory, handoffId, targetBuildIdentity: targetBuild, operatorReview,
    adoptClosedAdmissionFromCutoverId: 'initial-cutover', clock,
    hooks: {
      beforeAdmissionTransferCommit: async () => {
        prequalificationRacingGateCommit = prequalifyReleaseAuthorityBuild(source, sourceCoordinator, {
          expectedSelectorDigest: selectorAfterIntentAdvance.digest,
          expectedManifestDigest: source.manifest.digest,
          expectedManifest: source.manifest,
          targetBuildIdentity: racingPrequalificationBuild,
          expectedTargetSelectorRevision: selectorAfterIntentAdvance.revision + 1,
          authorityTransitionDigest: canonicalDigest({ fixture: 'prequalification-racing-gate-commit' }),
        });
        await Promise.resolve();
      },
      afterAdmissionTransferred: async () => { throw new Error('synthetic crash after durable admission transfer'); },
    },
  }), /synthetic crash after durable admission transfer/u);
  await expectCode('AUTHORITY_HANDOFF_RESERVATION_HELD', () => prequalificationRacingGateCommit);
  const transferredGate = await admissionGate.read();
  assert.equal(transferredGate.state, 'CLOSED');
  assert.equal(transferredGate.cutoverId, handoffId);
  assert.equal(transferredGate.previousDigest, activationGate.digest,
    'closed-owner transfer must create one direct CLOSED successor without reopening admission');
  const persistedAdmissionIntent = JSON.parse(await readFile(
    path.join(reportDirectory, `${handoffId}.handoff.intent.json`), 'utf8',
  ));
  assert.equal(persistedAdmissionIntent.admissionAcquisition.activationSelectorDigest, activeA.digest,
    'the durable acquisition must bind the original activation report selector, not the newer prequalified selector');
  assert.equal(persistedAdmissionIntent.sourceSelectorDigest, selectorAfterIntentAdvance.digest,
    'a fresh handoff must adopt successfully from the selector advanced after the stale intent');
  await expectCode('AUTHORITY_HANDOFF_ADMISSION_TRANSFER_INVALID', () => (
    prepareSharedAuthorityBuildHandoff({
      store: source, coordinator: sourceCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
      reportDirectory, handoffId: 'competing-handoff-0001', targetBuildIdentity: targetBuild, operatorReview,
      adoptClosedAdmissionFromCutoverId: 'initial-cutover', clock,
    })
  ));
  assert.equal((await admissionGate.read()).digest, transferredGate.digest,
    'a competing transfer must lose without reopening or replacing the winning closed gate');
  assert.equal(await readFile(preservedLegacyPermit, 'utf8'), preservedLegacyPermitBytes,
    'admission-owner transfer must preserve the prior cutover permit/evidence bytes');
  const prepared = await prepareSharedAuthorityBuildHandoff({
    store: source, coordinator: sourceCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
    reportDirectory, handoffId, targetBuildIdentity: targetBuild, operatorReview,
    adoptClosedAdmissionFromCutoverId: 'initial-cutover', clock,
  });
  assert.equal(prepared.status, 'ADMISSION_TRANSFERRED');
  await expectCode('AUTHORITY_HANDOFF_RESERVATION_HELD', () => (
    prequalifyReleaseAuthorityBuild(source, sourceCoordinator, {
      expectedSelectorDigest: selectorAfterIntentAdvance.digest,
      expectedManifestDigest: source.manifest.digest,
      expectedManifest: source.manifest,
      targetBuildIdentity: postPreparePrequalificationBuild,
      expectedTargetSelectorRevision: selectorAfterIntentAdvance.revision + 1,
      authorityTransitionDigest: canonicalDigest({ fixture: 'prequalification-after-prepare' }),
    })
  ));
  now += 1_000;
  const replayedPreparation = await prepareSharedAuthorityBuildHandoff({
    store: source, coordinator: sourceCoordinator, admissionGate, legacyAuthorityFence, authorityFloor,
    reportDirectory, handoffId, targetBuildIdentity: targetBuild, operatorReview,
    adoptClosedAdmissionFromCutoverId: 'initial-cutover', clock,
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
  await expectCode('STALE_COORDINATOR', () => (
    withReleaseAuthoritySelectorFence(target, completed.digest, async (_selector, fence) => (
      fence.reserveBuildHandoff({
        handoffId: 'forged-reservation-0001',
        sourceSelectorDigest: completed.digest,
        targetBuildIdentity: sourceBuild,
        coordinator: { ...targetCoordinator, token: 'forged-coordinator-token' },
      })
    ))
  ));
  await expectCode('STALE_COORDINATOR', () => (
    withReleaseAuthoritySelectorFence(target, completed.digest, async (_selector, fence) => (
      fence.reserveBuildHandoff({
        handoffId: 'missing-reservation-coordinator-0001',
        sourceSelectorDigest: completed.digest,
        targetBuildIdentity: sourceBuild,
        coordinator: null,
      })
    ))
  ));
  await withReleaseAuthoritySelectorFence(target, completed.digest, async (_selector, fence) => {
    await fence.reserveBuildHandoff({
      handoffId: failureBoundHandoffId,
      sourceSelectorDigest: completed.digest,
      targetBuildIdentity: sourceBuild,
      coordinator: targetCoordinator,
    });
  });
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

  // Regression for a real v1/in-flight prepare: the former implementation
  // could publish PROMOTION_DISABLED and only then discover the missing
  // reservation.  The migration must seal PREPARED under gate -> global before
  // begin can change selector state.
  const migrationStore = await openParentRunStore({
    root: migrationRoot,
    deploymentIdentity: 'compose-project:handoff-migration-test',
    volumeIdentity: 'named-volume:handoff-migration-test',
    storeMarker: '92'.repeat(32),
    storeGeneration: 6,
    schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
    buildIdentity: sourceBuild,
    backupMarker: 'backup:handoff-migration-test',
    prequalifiedRollbackBuilds: [sourceBuild, targetBuild],
    verifyStorage: false,
    clock,
  });
  const migrationCoordinator = await acquireStoreCoordinator(migrationStore, {
    ownerId: 'coordinator-v1-migration-source', leaseMs: 60_000,
  });
  const migrationShadow = await readReleaseAuthoritySelector(migrationStore);
  const migrationDraining = await transitionReleaseAuthority(migrationStore, migrationCoordinator, {
    expectedSelectorDigest: migrationShadow.digest, phase: 'DRAINING', buildIdentity: sourceBuild,
  });
  const migrationActive = await transitionReleaseAuthority(migrationStore, migrationCoordinator, {
    expectedSelectorDigest: migrationDraining.digest,
    phase: 'ACTIVE',
    activationRevision: 88,
    buildIdentity: sourceBuild,
    activationCutoverDigest: canonicalDigest({ fixture: 'v1-migration-activation' }),
    authorityTransitionDigest: canonicalDigest({ fixture: 'v1-migration-transition' }),
  });
  const migrationFloor = await initializeSharedAuthorityFloor({
    root: migrationFloorRoot,
    protectedRoots: [migrationRoot],
    verifyStorage: false,
    clock,
    initial: {
      storeMarkerDigest: migrationActive.storeMarkerDigest,
      minimumStoreGeneration: migrationActive.storeGeneration,
      minimumSelectorRevision: migrationActive.revision,
      activeBuildIdentity: sourceBuild,
      authorityTransitionDigest: migrationActive.authorityTransitionDigest,
      activationEpoch: 1,
      legacyPermanentlyRetired: true,
      activationRevision: migrationActive.activationRevision,
      activationCutoverDigest: migrationActive.activationCutoverDigest,
    },
  });
  const migrationGate = await initializeCutoverAdmissionGate({
    root: path.join(migrationRoot, 'cutover-admission'), verifyStorage: false, clock,
  });
  const migrationHandoffId = 'handoff-v1-reservation-migration-0001';
  const migrationClosedGate = await migrationGate.close((await migrationGate.read()).digest, migrationHandoffId);
  const migrationLegacy = await initializeLegacyAuthorityFence({
    root: path.join(migrationRoot, 'legacy-authority'), verifyStorage: false, clock,
  });
  let migrationLegacyState = await migrationLegacy.read();
  migrationLegacyState = await migrationLegacy.close(migrationLegacyState.digest, 'migration-cutover');
  migrationLegacyState = await migrationLegacy.freeze(migrationLegacyState.digest, 'migration-cutover');
  await migrationLegacy.activate(migrationLegacyState.digest, 'migration-cutover', 1);
  const migrationReportDirectory = path.join(migrationRoot, 'handoff-reports');
  await mkdir(migrationReportDirectory, { recursive: true });
  const v1IntentBody = {
    schemaVersion: 1,
    kind: 'release-authority-build-handoff-intent',
    handoffId: migrationHandoffId,
    sourceBuildIdentity: sourceBuild,
    targetBuildIdentity: targetBuild,
    sourceSelectorDigest: migrationActive.digest,
    authorityFloorBeforeDigest: (await migrationFloor.read()).digest,
    activationCutoverDigest: migrationActive.activationCutoverDigest,
    activationEpoch: 1,
    activationRevision: migrationActive.activationRevision,
    operatorReview,
    requestedAt: new Date(now).toISOString(),
  };
  await writeFile(path.join(migrationReportDirectory, `${migrationHandoffId}.handoff.intent.json`),
    `${JSON.stringify({ ...v1IntentBody, digest: canonicalDigest(v1IntentBody) })}\n`);
  await expectCode('AUTHORITY_HANDOFF_RESERVATION_REQUIRED', () => (
    beginReleaseAuthorityBuildHandoff(migrationStore, migrationCoordinator, {
      expectedSelectorDigest: migrationActive.digest,
      handoffId: migrationHandoffId,
      targetBuildIdentity: targetBuild,
    })
  ));
  assert.equal((await readReleaseAuthoritySelector(migrationStore)).digest, migrationActive.digest,
    'missing v1 reservation must reject before selector state changes');
  const migratedPreparation = await prepareSharedAuthorityBuildHandoff({
    store: migrationStore,
    coordinator: migrationCoordinator,
    admissionGate: migrationGate,
    legacyAuthorityFence: migrationLegacy,
    authorityFloor: migrationFloor,
    reportDirectory: migrationReportDirectory,
    handoffId: migrationHandoffId,
    targetBuildIdentity: targetBuild,
    operatorReview,
    clock,
  });
  assert.equal(migratedPreparation.status, 'ADMISSION_CLOSED');
  assert.equal((await migrationGate.read()).digest, migrationClosedGate.digest,
    'v1 reservation migration must preserve the original closed gate evidence');
  // Simulate the legacy in-flight boundary: a v1 handoff has an exact drain
  // checkpoint before it writes the pending selector.
  const migrationCheckpointFile = path.join(migrationReportDirectory, `${migrationHandoffId}.handoff.state.json`);
  const { digest: migrationPreparationDigest, ...migrationCheckpointBase } = migratedPreparation;
  const v1PendingCheckpointBody = {
    ...migrationCheckpointBase,
    revision: migratedPreparation.revision + 1,
    previousDigest: migrationPreparationDigest,
    status: 'DRAIN_VERIFIED',
    selectorCurrent: migrationActive,
    updatedAt: new Date(now).toISOString(),
  };
  const v1PendingCheckpoint = {
    ...v1PendingCheckpointBody,
    digest: canonicalDigest(v1PendingCheckpointBody),
  };
  await mkdir(path.join(migrationReportDirectory, `${migrationHandoffId}.handoff.checkpoints`), { recursive: true });
  await writeFile(
    path.join(migrationReportDirectory, `${migrationHandoffId}.handoff.checkpoints`, `${v1PendingCheckpoint.digest.slice('sha256:'.length)}.json`),
    `${canonicalJson(v1PendingCheckpoint)}\n`,
  );
  await writeFile(migrationCheckpointFile, `${canonicalJson(v1PendingCheckpoint)}\n`);
  const migrationReservationPointer = path.join(migrationRoot, 'release-authority-handoff-reservation.json');
  const migrationReservationHistory = path.join(migrationRoot, 'release-authority-handoff-reservations');
  await assert.rejects(() => beginReleaseAuthorityBuildHandoff(migrationStore, migrationCoordinator, {
    expectedSelectorDigest: migrationActive.digest,
    handoffId: migrationHandoffId,
    targetBuildIdentity: targetBuild,
    hooks: { afterPendingSelectorWritten: () => { throw new Error('synthetic crash after pending selector write'); } },
  }), /synthetic crash after pending selector write/u);
  const migrationPending = await readReleaseAuthoritySelector(migrationStore);
  assert.equal(migrationPending.phase, 'PROMOTION_DISABLED');
  const migrationTargetStore = await openParentRunStore({
    root: migrationRoot,
    deploymentIdentity: 'compose-project:handoff-migration-test',
    volumeIdentity: 'named-volume:handoff-migration-test',
    storeMarker: '92'.repeat(32),
    expectedStoreGeneration: migrationPending.storeGeneration,
    schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
    buildIdentity: targetBuild,
    backupMarker: 'backup:handoff-migration-test',
    prequalifiedRollbackBuilds: [sourceBuild, targetBuild],
    verifyStorage: false,
    clock,
  });
  const migrationTargetCoordinator = await acquireStoreCoordinator(migrationTargetStore, {
    ownerId: 'coordinator-v1-migration-target', leaseMs: 60_000,
  });
  const resumedV1Pending = await beginSharedAuthorityBuildHandoff({
    store: migrationTargetStore,
    coordinator: migrationTargetCoordinator,
    admissionGate: migrationGate,
    legacyAuthorityFence: migrationLegacy,
    reportDirectory: migrationReportDirectory,
    handoffId: migrationHandoffId,
    drainObservation: null,
    clock,
  });
  assert.equal(resumedV1Pending.selectorPending.digest, migrationPending.digest,
    'a selector-before-reservation crash must consume the matching prepared reservation on replay');
  await rm(migrationReservationPointer);
  await rm(migrationReservationHistory, { recursive: true, force: true });
  const upgradedV1Pending = await beginSharedAuthorityBuildHandoff({
    store: migrationTargetStore,
    coordinator: migrationTargetCoordinator,
    admissionGate: migrationGate,
    legacyAuthorityFence: migrationLegacy,
    reportDirectory: migrationReportDirectory,
    handoffId: migrationHandoffId,
    drainObservation: null,
    clock,
  });
  assert.equal(upgradedV1Pending.selectorPending.digest, migrationPending.digest,
    'v1 pending-state recovery must preserve the exact pending authority selector');

  const migrationReservation = JSON.parse(await readFile(migrationReservationPointer, 'utf8'));
  const migrationReservationHead = path.join(
    migrationRoot,
    'release-authority-handoff-reservations',
    `${migrationReservation.digest.slice('sha256:'.length)}.json`,
  );
  await rm(migrationReservationHead);
  const recoveredMigrationPending = await beginReleaseAuthorityBuildHandoff(migrationTargetStore, migrationTargetCoordinator, {
    expectedSelectorDigest: migrationActive.digest,
    handoffId: migrationHandoffId,
    targetBuildIdentity: targetBuild,
  });
  assert.equal(recoveredMigrationPending.digest, migrationPending.digest,
    'a pointer-first crash must reconstruct only its missing exact immutable head');
  assert.ok(await readFile(migrationReservationHead, 'utf8'));
  await rm(migrationReservationPointer);
  await expectCode('AUTHORITY_HANDOFF_RESERVATION_INVALID', () => (
    beginReleaseAuthorityBuildHandoff(migrationTargetStore, migrationTargetCoordinator, {
      expectedSelectorDigest: migrationActive.digest,
      handoffId: migrationHandoffId,
      targetBuildIdentity: targetBuild,
    })
  ));

  // Revision 256 remains readable and sealed; the next reservation must fail
  // before it can replace the pointer (or become eligible for a gate commit).
  const reservationBoundaryStore = await openParentRunStore({
    root: reservationBoundaryRoot,
    deploymentIdentity: 'compose-project:handoff-reservation-boundary-test',
    volumeIdentity: 'named-volume:handoff-reservation-boundary-test',
    storeMarker: '93'.repeat(32),
    storeGeneration: 7,
    schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
    buildIdentity: sourceBuild,
    backupMarker: 'backup:handoff-reservation-boundary-test',
    prequalifiedRollbackBuilds: [sourceBuild, targetBuild],
    verifyStorage: false,
    clock,
  });
  const reservationBoundaryCoordinator = await acquireStoreCoordinator(reservationBoundaryStore, {
    ownerId: 'coordinator-reservation-boundary', leaseMs: 60_000,
  });
  const reservationBoundaryShadow = await readReleaseAuthoritySelector(reservationBoundaryStore);
  const reservationBoundaryDraining = await transitionReleaseAuthority(
    reservationBoundaryStore,
    reservationBoundaryCoordinator,
    { expectedSelectorDigest: reservationBoundaryShadow.digest, phase: 'DRAINING', buildIdentity: sourceBuild },
  );
  const reservationBoundaryActive = await transitionReleaseAuthority(
    reservationBoundaryStore,
    reservationBoundaryCoordinator,
    {
      expectedSelectorDigest: reservationBoundaryDraining.digest,
      phase: 'ACTIVE',
      activationRevision: 99,
      buildIdentity: sourceBuild,
      activationCutoverDigest: canonicalDigest({ fixture: 'reservation-boundary-activation' }),
      authorityTransitionDigest: canonicalDigest({ fixture: 'reservation-boundary-transition' }),
    },
  );
  const reservationHistoryDirectory = path.join(reservationBoundaryRoot, 'release-authority-handoff-reservations');
  await mkdir(reservationHistoryDirectory, { recursive: true });
  let previousReservationDigest = null;
  let reservationHead;
  for (let revision = 1; revision <= 256; revision += 1) {
    const reservationBody = {
      schemaVersion: 1,
      kind: 'release-authority-handoff-reservation',
      revision,
      previousDigest: previousReservationDigest,
      state: 'CONSUMED',
      handoffId: `reservation-history-${String(revision).padStart(3, '0')}`,
      sourceSelectorDigest: reservationBoundaryActive.digest,
      targetBuildIdentity: targetBuild,
      preparedAt: new Date(now).toISOString(),
      consumedAt: new Date(now).toISOString(),
      pendingSelectorDigest: reservationBoundaryActive.digest,
    };
    reservationHead = { ...reservationBody, digest: canonicalDigest(reservationBody) };
    await writeFile(
      path.join(reservationHistoryDirectory, `${reservationHead.digest.slice('sha256:'.length)}.json`),
      `${canonicalJson(reservationHead)}\n`,
    );
    previousReservationDigest = reservationHead.digest;
  }
  const reservationBoundaryPointer = path.join(reservationBoundaryRoot, 'release-authority-handoff-reservation.json');
  await writeFile(reservationBoundaryPointer, `${canonicalJson(reservationHead)}\n`);
  const reservationPointerBeforeOverflow = await readFile(reservationBoundaryPointer, 'utf8');
  await expectCode('AUTHORITY_HANDOFF_RESERVATION_LIMIT', () => (
    withReleaseAuthoritySelectorFence(
      reservationBoundaryStore,
      reservationBoundaryActive.digest,
      async (_selector, fence) => fence.reserveBuildHandoff({
        handoffId: 'reservation-history-overflow',
        sourceSelectorDigest: reservationBoundaryActive.digest,
        targetBuildIdentity: targetBuild,
        coordinator: reservationBoundaryCoordinator,
      }),
    )
  ));
  assert.equal(await readFile(reservationBoundaryPointer, 'utf8'), reservationPointerBeforeOverflow,
    'revision 257 must not publish a reservation pointer');
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(floorRoot, { recursive: true, force: true });
  await rm(migrationRoot, { recursive: true, force: true });
  await rm(migrationFloorRoot, { recursive: true, force: true });
  await rm(reservationBoundaryRoot, { recursive: true, force: true });
}

process.stdout.write('Shared build handoff self-test passed: separate source and target handles enforce pending writer ownership and health-fenced activation.\n');
