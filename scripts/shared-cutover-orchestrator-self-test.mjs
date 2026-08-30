import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { sealExecutionManifest } from '../shared/execution-contract.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { sealWorkExecutionDescriptor } from '../shared/work-execution-descriptor.mjs';
import {
  SHADOW_ACCEPTANCE_CASE_IDS,
  SHADOW_CORRUPTION_CASE_IDS,
  buildPreRegisteredShadowMatrix,
} from '../shared/shadow-validation-fixtures.mjs';
import { runShadowValidation } from '../shared/shadow-validation.mjs';
import {
  PARENT_RUN_STORE_SCHEMA_VERSION,
  PARENT_RUN_WRITER_PROTOCOL,
  acceptOperation,
  adoptAttemptEvidence,
  applyDiagnosticRerunOperation,
  applyRekickOperation,
  acquireStoreCoordinator,
  claimWorkItem,
  completeOperation,
  createParentRun,
  openParentRunStore,
  publishAttemptEvidence,
  readParentRun,
  readReleaseAuthoritySelector,
  readStoreCoordinator,
  transitionReleaseAuthority,
} from './lib/parent-run-store.mjs';
import {
  activateSharedAuthorityCutover,
  authorizeSharedCutoverCanaryLaunch,
  beginSharedAuthorityBuildHandoff,
  captureSharedAuthorityDrainObservation,
  createCutoverAdmissionPolicy,
  initializeCutoverAdmissionGate,
  prepareSharedAuthorityCutover,
  prepareSharedAuthorityBuildHandoff,
  prequalifySharedAuthorityBuild,
  recordSharedCutoverCanary,
  reopenSharedAdmissionAfterCanaries,
  rollbackSharedAuthorityBeforeActivation,
  setSharedPromotionAvailability,
  sharedCutoverConfigurationDigest,
} from './lib/shared-cutover-orchestrator.mjs';
import { openSharedLaunchOperationStore } from './lib/shared-launch-operation-store.mjs';
import { rehearseSharedStoreBackup } from './lib/shared-store-backup-rehearsal.mjs';
import { initializeLegacyAuthorityFence, openLegacyAuthorityFence } from './lib/legacy-authority-fence.mjs';
import { initializeSharedAuthorityFloor, openSharedAuthorityFloor } from './lib/shared-authority-floor.mjs';
import {
  beginSharedAuthorityBuildHandoffFromCli,
  runSharedAuthorityCutoverCli,
  sharedCutoverActionRequiresCoordinator,
} from './run-shared-authority-cutover.mjs';

const marker = 'cd'.repeat(32);
const build = 'build:cutover-current';
const rollbackBuild = 'build:cutover-rollback';
const backup = 'ef'.repeat(32);
const deploymentIdentity = 'compose-project:cutover-test';
const volumeIdentity = 'named-volume:cutover-test';
const root = await mkdtemp(path.join(tmpdir(), 'shared-cutover-orchestrator-'));
let now = Date.parse('2026-08-29T19:00:00.000Z');
const clock = () => now;

function expectedStore(storeGeneration = 4) {
  return {
    deploymentIdentity,
    volumeIdentity,
    storeMarkerDigest: canonicalDigest({ storeMarker: marker }),
    storeGeneration,
    schemaVersion: PARENT_RUN_STORE_SCHEMA_VERSION,
    schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
    currentWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
    backupMarker: backup,
  };
}

function shadowReport() {
  return runShadowValidation({
    ...buildPreRegisteredShadowMatrix(),
    generatedAt: new Date(now).toISOString(),
  });
}

function review() {
  return {
    reviewed: true,
    actorId: 'operator:cutover-reviewer',
    reviewedAt: new Date(now).toISOString(),
  };
}

const digest = (character) => `sha256:${character.repeat(64)}`;
const targetIdentity = Object.freeze({ kind: 'target-preflight-set', value: digest('9') });

function canaryEvidence({
  mode,
  runId,
  createdAt = new Date(now).toISOString(),
  finalSubjectDigest = digest(mode === 'single-site' ? '1' : '3'),
  publicationDigest = digest(mode === 'single-site' ? '2' : '4'),
  configurationRevision = digest(mode === 'single-site' ? '6' : '7'),
} = {}) {
  return {
    mode,
    runId,
    createdAt,
    subjectCoreDigest: digest(mode === 'single-site' ? 'a' : 'b'),
    finalSubjectDigest,
    publicationDigest,
    decisionCode: 'RELEASE_READY',
    decisionRevision: 1,
    grantedAuthority: 'FULL',
    deploymentIdentity: targetIdentity,
    trustedReprobeIdentity: targetIdentity,
    runnerRevision: digest('8'),
    configurationRevision,
    activeBuildIdentity: build,
  };
}

function canaryIntent(mode) {
  const common = {
    schemaVersion: 1,
    mode,
    targetIds: mode === 'single-site' ? ['audited'] : ['candidate', 'production'],
    scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
  };
  return {
    schemaVersion: 1,
    runContract: mode === 'single-site'
      ? { ...common, url: 'https://candidate.example.test', deploymentRole: 'preview', certificatePolicy: 'strict' }
      : { ...common, candidateUrl: 'https://candidate.example.test', productionUrl: 'https://production.example.test' },
  };
}

function cutoverReview(input) {
  return {
    ...review(),
    shadowValidationDigest: input.shadowReport.digest,
    shadowMatrixDigest: input.shadowReport.matrixDigest,
    buildIdentity: input.buildIdentity,
    expectedStoreDigest: canonicalDigest(input.expectedStore),
    configurationDigest: sharedCutoverConfigurationDigest(input),
    backupRehearsalReceiptDigest: input.backupRehearsalReceipt.digest,
  };
}

function sealedRunInput(runId, workItemId) {
  const subjectCore = sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: { kind: 'target-preflight-set', value: digest('7') },
    targets: [{ role: 'audited', origin: 'https://cutover.example.test' }],
    mode: 'single-site',
    requestedAuthority: {
      qualifier: 'TARGETED',
      scope: { features: ['navigation'], definitions: ['NAV-001'], targets: ['audited'], knownLimits: [] },
    },
    revisions: { runner: digest('1'), plugins: digest('2'), targets: digest('3'), configuration: digest('4') },
    environmentIdentity: digest('5'),
    certificatePolicy: 'strict',
  });
  const executionManifest = sealExecutionManifest({
    schemaVersion: 1,
    subjectCoreDigest: subjectCore.digest,
    workItems: [{ id: workItemId, definitionId: 'NAV-001', targetId: 'audited', targetRole: 'audited' }],
    oracleExecutions: [{ id: `${runId}-oracle`, definitionId: 'NAV-001', requiredWorkItemIds: [workItemId] }],
    contextWorkItemIds: [],
  });
  const finalSubject = sealFinalReleaseSubject({
    schemaVersion: 1,
    subjectCore,
    executionManifest,
    grantedAuthority: subjectCore.requestedAuthority,
    coverageBasis: { selectedDefinitions: ['NAV-001'], selectedTargets: ['audited'], excludedAsNotApplicable: [] },
    deploymentIdentityRecheck: subjectCore.deploymentIdentity,
  });
  const executionDescriptor = sealWorkExecutionDescriptor({
    workItemId,
    subjectCoreDigest: subjectCore.digest,
    runnerRevision: subjectCore.revisions.runner,
    mode: 'single-site',
    operation: 'playwright',
    definitionId: 'NAV-001',
    pluginId: 'navigation-search-content',
    caseId: 'NAV-001:tests/navigation.spec.ts:audited',
    entrySpec: 'tests/navigation.spec.ts',
    targetId: 'audited',
    targetRole: 'audited',
    capability: 'browser:chromium',
    resourceClass: 'ordinary',
    origins: { candidate: 'https://cutover.example.test', production: null },
    certificatePolicy: 'strict',
    route: null,
  });
  return {
    runId,
    compilationState: 'sealed',
    subjectCore,
    executionManifest,
    finalSubject,
    runnerRevision: subjectCore.revisions.runner,
    workItems: [{
      id: workItemId,
      capability: 'browser:chromium',
      resourceClass: 'ordinary',
      targetId: 'audited',
      specAffinity: 'tests/navigation.spec.ts',
      executionDescriptor,
      maxAttempts: 1,
    }],
  };
}

function observation(cutoverId, gate, coordinator) {
  const body = {
    schemaVersion: 1,
    kind: 'release-cutover-drain-observation',
    cutoverId,
    observedAt: new Date(now).toISOString(),
    admissionGateDigest: gate.digest,
    activeLegacyAuthoritativeRunIds: [],
    releaseChangingMutationIds: [],
    unresolvedOperationIds: [],
    unfencedLegacyLeaseIds: [],
    canonicalWriterOwnerIds: [coordinator.ownerId],
    legacyHeadMarkers: ['legacy-head:sealed-before-cutover'],
  };
  return { ...body, digest: canonicalDigest(body) };
}

function resealReceipt(receipt) {
  const { digest: ignored, ...body } = receipt;
  return { ...body, digest: canonicalDigest(body) };
}

async function fixture(name) {
  const directory = path.join(root, name);
  const store = await openParentRunStore({
    root: path.join(directory, 'store'),
    deploymentIdentity,
    volumeIdentity,
    storeMarker: marker,
    storeGeneration: 4,
    schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
    buildIdentity: build,
    backupMarker: backup,
    prequalifiedRollbackBuilds: [build, rollbackBuild],
    verifyStorage: false,
    clock,
  });
  const admissionGate = await initializeCutoverAdmissionGate({
    root: path.join(directory, 'admission'), verifyStorage: false, clock,
  });
  const legacyAuthorityFence = await initializeLegacyAuthorityFence({
    root: path.join(directory, 'legacy-authority'), verifyStorage: false, clock,
  });
  const authorityFloor = await initializeSharedAuthorityFloor({
    root: path.join(directory, 'authority-floor'),
    protectedRoots: [store.root],
    verifyStorage: false,
    clock,
    initial: {
      storeMarkerDigest: store.manifest.storeMarkerDigest,
      minimumStoreGeneration: store.manifest.storeGeneration,
      minimumSelectorRevision: 1,
      activeBuildIdentity: null,
      authorityTransitionDigest: null,
      activationEpoch: 0,
      legacyPermanentlyRetired: false,
      activationRevision: null,
      activationCutoverDigest: null,
    },
  });
  const legacyComparativeRoot = path.join(directory, 'legacy-comparative');
  const legacySingleSiteQueueRoot = path.join(directory, 'legacy-single-site');
  await Promise.all([
    mkdir(legacyComparativeRoot, { recursive: true }),
    mkdir(path.join(legacySingleSiteQueueRoot, 'jobs'), { recursive: true }),
  ]);
  const launchOperationStore = await openSharedLaunchOperationStore({
    root: path.join(directory, 'launch-operations'), clock,
  });
  const coordinator = await acquireStoreCoordinator(store, {
    ownerId: `coordinator-${name}`, leaseMs: 60_000,
  });
  return {
    directory, store, admissionGate, legacyAuthorityFence, authorityFloor, coordinator, launchOperationStore,
    legacyComparativeRoot, legacySingleSiteQueueRoot,
  };
}

async function activatedFixture(name) {
  const context = await fixture(name);
  const shadow = await readReleaseAuthoritySelector(context.store);
  const draining = await transitionReleaseAuthority(context.store, context.coordinator, {
    expectedSelectorDigest: shadow.digest,
    phase: 'DRAINING',
    buildIdentity: build,
  });
  const active = await transitionReleaseAuthority(context.store, context.coordinator, {
    expectedSelectorDigest: draining.digest,
    phase: 'ACTIVE',
    activationRevision: 73,
    buildIdentity: build,
    activationCutoverDigest: digest('c'),
    authorityTransitionDigest: digest('d'),
  });
  let legacy = await context.legacyAuthorityFence.read();
  legacy = await context.legacyAuthorityFence.close(legacy.digest, `${name}-cutover`);
  legacy = await context.legacyAuthorityFence.freeze(legacy.digest, `${name}-cutover`);
  await context.legacyAuthorityFence.activate(legacy.digest, `${name}-cutover`, 1);
  const floor = await context.authorityFloor.read();
  await context.authorityFloor.compareAndAdvance(floor.digest, {
    minimumStoreGeneration: active.storeGeneration,
    minimumSelectorRevision: active.revision,
    activeBuildIdentity: active.activeBuildIdentity,
    authorityTransitionDigest: active.authorityTransitionDigest,
    activationEpoch: 1,
    legacyPermanentlyRetired: true,
    activationRevision: active.activationRevision,
    activationCutoverDigest: active.activationCutoverDigest,
  });
  return { ...context, active };
}

async function activatedCliFixture(name) {
  const directory = path.join(root, name);
  const store = await openParentRunStore({
    root: path.join(directory, 'store'),
    deploymentIdentity,
    volumeIdentity,
    storeMarker: marker,
    storeGeneration: 4,
    schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
    buildIdentity: build,
    backupMarker: backup,
    prequalifiedRollbackBuilds: [build, rollbackBuild],
    verifyStorage: false,
    clock,
  });
  const admissionGate = await initializeCutoverAdmissionGate({
    root: path.join(store.root, 'cutover-admission'), verifyStorage: false, clock,
  });
  const legacyAuthorityFence = await initializeLegacyAuthorityFence({
    root: path.join(store.root, 'legacy-authority'), verifyStorage: false, clock,
  });
  await openSharedLaunchOperationStore({ root: path.join(store.root, 'launch-operations'), clock });
  const coordinator = await acquireStoreCoordinator(store, {
    ownerId: `coordinator-${name}`, leaseMs: 60_000,
  });
  const shadow = await readReleaseAuthoritySelector(store);
  const draining = await transitionReleaseAuthority(store, coordinator, {
    expectedSelectorDigest: shadow.digest,
    phase: 'DRAINING',
    buildIdentity: build,
  });
  const active = await transitionReleaseAuthority(store, coordinator, {
    expectedSelectorDigest: draining.digest,
    phase: 'ACTIVE',
    activationRevision: 73,
    buildIdentity: build,
    activationCutoverDigest: digest('c'),
    authorityTransitionDigest: digest('d'),
  });
  let legacy = await legacyAuthorityFence.read();
  legacy = await legacyAuthorityFence.close(legacy.digest, `${name}-cutover`);
  legacy = await legacyAuthorityFence.freeze(legacy.digest, `${name}-cutover`);
  await legacyAuthorityFence.activate(legacy.digest, `${name}-cutover`, 1);
  const authorityFloor = await initializeSharedAuthorityFloor({
    root: path.join(directory, 'authority-floor'),
    protectedRoots: [store.root],
    verifyStorage: false,
    clock,
    initial: {
      storeMarkerDigest: active.storeMarkerDigest,
      minimumStoreGeneration: active.storeGeneration,
      minimumSelectorRevision: active.revision,
      activeBuildIdentity: active.activeBuildIdentity,
      authorityTransitionDigest: active.authorityTransitionDigest,
      activationEpoch: active.activationEpoch,
      legacyPermanentlyRetired: true,
      activationRevision: active.activationRevision,
      activationCutoverDigest: active.activationCutoverDigest,
    },
  });
  return { directory, store, admissionGate, legacyAuthorityFence, authorityFloor, active };
}

function compatibilityProof(targetBuildIdentity, validationDigest = digest('a')) {
  const imageDigest = targetBuildIdentity.slice('build:'.length);
  assert.match(imageDigest, /^sha256:[a-f0-9]{64}$/u);
  const body = {
    schemaVersion: 1,
    kind: 'shared-build-compatibility-proof',
    targetBuildIdentity,
    runnerRevision: digest('8'),
    imageDigest,
    validationDigest,
    generatedAt: new Date(now).toISOString(),
  };
  return { ...body, digest: canonicalDigest(body) };
}

async function request(cutoverId, { directory, store }, suffix = 'initial', requestedRollbackBuild = rollbackBuild) {
  const input = {
    cutoverId,
    activationRevision: 73,
    buildIdentity: build,
    rollbackBuildIdentity: requestedRollbackBuild,
    expectedStore: expectedStore(),
    shadowReport: shadowReport(),
  };
  const backupRoot = path.join(directory, 'backup-rehearsals', `${cutoverId}-${suffix}-backup`);
  const restoreRoot = path.join(directory, 'backup-rehearsals', `${cutoverId}-${suffix}-restore`);
  const receiptPath = path.join(directory, 'backup-rehearsals', `${cutoverId}-${suffix}-receipt.json`);
  await mkdir(path.dirname(backupRoot), { recursive: true });
  input.backupRehearsalReceipt = await rehearseSharedStoreBackup({
    rehearsalId: `${cutoverId}-${suffix}`,
    sourceRoot: store.root,
    backupRoot,
    restoreRoot,
    receiptPath,
    storeMarker: marker,
    backupMarker: backup,
    buildIdentity: build,
    configurationDigest: sharedCutoverConfigurationDigest(input),
    expectedStore: input.expectedStore,
    clock,
  });
  input.backupRoot = backupRoot;
  input.restoreRoot = restoreRoot;
  input.operatorReview = cutoverReview(input);
  return input;
}

async function expectCode(code, operation) {
  await assert.rejects(operation, (error) => error?.code === code);
}

try {
  assert.equal(sharedCutoverActionRequiresCoordinator('prequalify-handoff-target'), true);
  assert.equal(sharedCutoverActionRequiresCoordinator('prepare-handoff'), true);
  assert.equal(sharedCutoverActionRequiresCoordinator('launch-handoff-single-site-canary'), false,
    'remote canary launch must not contend with the live shared coordinator lease');
  assert.equal(sharedCutoverActionRequiresCoordinator('record-handoff-comparative-canary'), false,
    'canary observation must not acquire an unrelated writer lease');
  await assert.rejects(async () => sharedCutoverActionRequiresCoordinator('unknown-action'),
    /Unknown shared cutover action/u);
  await expectCode('LAUNCH_OPERATION_STORE_UNAVAILABLE', () => openSharedLaunchOperationStore({
    root: path.join(root, 'missing-launch-operations'), requireExisting: true, clock,
  }));
  {
    const targetBuildIdentity = `build:${digest('9')}`;
    const context = await activatedFixture('prequalify-build');
    const reportDirectory = path.join(context.directory, 'reports');
    const proof = compatibilityProof(targetBuildIdentity);
    const request = {
      store: context.store,
      coordinator: context.coordinator,
      legacyAuthorityFence: context.legacyAuthorityFence,
      authorityFloor: context.authorityFloor,
      reportDirectory,
      prequalificationId: 'prequalify-build-0001',
      targetBuildIdentity,
      compatibilityProof: proof,
      operatorReview: review(),
      clock,
    };
    const receipt = await prequalifySharedAuthorityBuild(request);
    assert.equal(receipt.kind, 'release-authority-build-prequalification-receipt');
    assert.equal(receipt.compatibilityProofDigest, proof.digest);
    assert.deepEqual(receipt.selector.prequalifiedRollbackBuilds,
      [build, rollbackBuild, targetBuildIdentity].sort());
    assert.deepEqual(context.store.manifest.prequalifiedRollbackBuilds,
      receipt.selector.prequalifiedRollbackBuilds);
    assert.equal(receipt.authorityFloorAfter.minimumSelectorRevision, receipt.selector.revision);
    assert.equal(receipt.authorityFloorAfter.authorityTransitionDigest, receipt.intentDigest);
    assert.equal((await context.authorityFloor.read()).digest, receipt.authorityFloorAfter.digest);
    assert.equal((await prequalifySharedAuthorityBuild(request)).digest, receipt.digest,
      'an exact replay returns the immutable receipt');
    await expectCode('CUTOVER_CHECKPOINT_CONFLICT', () => prequalifySharedAuthorityBuild({
      ...request,
      compatibilityProof: compatibilityProof(targetBuildIdentity, digest('b')),
    }));
  }
  for (const [sequence, hook] of [
    'afterIntentPersisted', 'afterManifestCommitted', 'afterSelectorCommitted', 'afterAuthorityFloorAdvanced',
  ].entries()) {
    const targetBuildIdentity = `build:${digest(String(sequence + 5))}`;
    const context = await activatedFixture(`prequalify-build-crash-${hook}`);
    const reportDirectory = path.join(context.directory, 'reports');
    const request = {
      store: context.store,
      coordinator: context.coordinator,
      legacyAuthorityFence: context.legacyAuthorityFence,
      authorityFloor: context.authorityFloor,
      reportDirectory,
      prequalificationId: `prequalify-build-crash-${sequence + 1}`,
      targetBuildIdentity,
      compatibilityProof: compatibilityProof(targetBuildIdentity),
      operatorReview: review(),
      clock,
    };
    await assert.rejects(prequalifySharedAuthorityBuild({
      ...request,
      hooks: { [hook]: () => { throw new Error(`synthetic crash at ${hook}`); } },
    }), new RegExp(`synthetic crash at ${hook}`, 'u'));

    now += 60_001;
    const reopenedStore = await openParentRunStore({
      root: context.store.root,
      deploymentIdentity,
      volumeIdentity,
      storeMarker: marker,
      storeGeneration: context.store.manifest.storeGeneration,
      expectedStoreGeneration: context.store.manifest.storeGeneration,
      buildIdentity: build,
      writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
      verifyStorage: false,
      clock,
    });
    const reopenedCoordinator = await acquireStoreCoordinator(reopenedStore, {
      ownerId: `coordinator-replay-${sequence + 1}`,
      leaseMs: 60_000,
    });
    const reopenedLegacyFence = await openLegacyAuthorityFence({
      root: path.join(context.directory, 'legacy-authority'), verifyStorage: false, clock,
    });
    const reopenedAuthorityFloor = await openSharedAuthorityFloor({
      root: path.join(context.directory, 'authority-floor'),
      protectedRoots: [reopenedStore.root],
      verifyStorage: false,
      clock,
    });
    const recovered = await prequalifySharedAuthorityBuild({
      ...request,
      store: reopenedStore,
      coordinator: reopenedCoordinator,
      legacyAuthorityFence: reopenedLegacyFence,
      authorityFloor: reopenedAuthorityFloor,
      compatibilityProof: null,
      operatorReview: null,
    });
    const selectorAfterRecovery = await readReleaseAuthoritySelector(reopenedStore);
    assert(selectorAfterRecovery.prequalifiedRollbackBuilds.includes(targetBuildIdentity));
    assert.equal(recovered.selector.digest, selectorAfterRecovery.digest);
    assert.equal(recovered.authorityFloorAfter.authorityTransitionDigest, recovered.intentDigest);
    assert.equal((await reopenedAuthorityFloor.read()).digest, recovered.authorityFloorAfter.digest);
    assert.equal((await prequalifySharedAuthorityBuild({
      ...request,
      store: reopenedStore,
      coordinator: reopenedCoordinator,
      legacyAuthorityFence: reopenedLegacyFence,
      authorityFloor: reopenedAuthorityFloor,
    })).digest, recovered.digest, `exact ${hook} replay must return the immutable receipt`);
  }
  {
    const targetBuildIdentity = `build:${digest('6')}`;
    const context = await activatedCliFixture('prequalify-build-cli');
    const trustDirectory = path.join(context.directory, 'trust');
    const reportDirectory = path.join(context.directory, 'reports');
    await mkdir(trustDirectory, { recursive: true });
    const storeMarkerFile = path.join(trustDirectory, 'store-marker');
    const proofFile = path.join(trustDirectory, 'resilience-proof.json');
    const configFile = path.join(context.directory, 'prequalification-operator-config.json');
    const proof = compatibilityProof(targetBuildIdentity);
    await Promise.all([
      writeFile(storeMarkerFile, `${marker}\n`),
      writeFile(proofFile, `${JSON.stringify({ fixture: 'validated-resilience-proof' })}\n`),
    ]);
    await writeFile(configFile, `${JSON.stringify({
      schemaVersion: 1,
      coordinatorOwnerId: 'coordinator-prequalification-cli',
      coordinatorLeaseMs: 30_000,
      reportDirectory,
      authorityFloorRoot: context.authorityFloor.root,
      authorityFloorVerifyStorage: false,
      store: {
        root: context.store.root,
        deploymentIdentity,
        volumeIdentity,
        storeMarkerFile,
        storeGeneration: context.store.manifest.storeGeneration,
        schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
        supportedSchemaVersion: PARENT_RUN_STORE_SCHEMA_VERSION,
        writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
        minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
        buildIdentity: build,
        prequalifiedRollbackBuilds: context.store.manifest.prequalifiedRollbackBuilds,
        backupMarker: backup,
        verifyStorage: false,
      },
      handoff: {
        prequalificationId: 'prequalify-build-cli-0001',
        targetBuildIdentity,
        resilienceProofFile: proofFile,
        operatorReview: review(),
      },
    })}\n`);
    let stdout = '';
    await runSharedAuthorityCutoverCli(
      ['prequalify-handoff-target', '--config', configFile],
      {
        output: { write: (chunk) => { stdout += chunk; } },
        createCompatibilityProof: ({ resilienceProof, targetBuildIdentity: requestedTarget }) => {
          assert.deepEqual(resilienceProof, { fixture: 'validated-resilience-proof' });
          assert.equal(requestedTarget, targetBuildIdentity);
          return proof;
        },
        resolveWorkspaceRevision: async () => `workspace:${digest('e')}`,
      },
    );
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.kind, 'release-authority-build-prequalification-receipt');
    assert.equal(receipt.compatibilityProofDigest, proof.digest);
    assert(receipt.selector.prequalifiedRollbackBuilds.includes(targetBuildIdentity));
    assert.equal(receipt.authorityFloorAfter.minimumSelectorRevision, receipt.selector.revision);
    assert.equal(receipt.authorityFloorAfter.authorityTransitionDigest, receipt.intentDigest);
    assert.equal(await readStoreCoordinator(context.store), null,
      'the one-shot cutover CLI must release its coordinator lease before returning');
  }
  {
    const {
      directory, store, admissionGate, coordinator, launchOperationStore, legacyAuthorityFence,
      legacyComparativeRoot, legacySingleSiteQueueRoot,
    } = await fixture('begin-handoff-cli-resume');
    const shadow = await readReleaseAuthoritySelector(store);
    const draining = await transitionReleaseAuthority(store, coordinator, {
      expectedSelectorDigest: shadow.digest,
      phase: 'DRAINING',
      buildIdentity: build,
    });
    const active = await transitionReleaseAuthority(store, coordinator, {
      expectedSelectorDigest: draining.digest,
      phase: 'ACTIVE',
      activationRevision: 73,
      buildIdentity: build,
      activationCutoverDigest: digest('c'),
      authorityTransitionDigest: digest('d'),
    });
    let legacy = await legacyAuthorityFence.read();
    legacy = await legacyAuthorityFence.close(legacy.digest, 'initial-cli-resume-cutover');
    legacy = await legacyAuthorityFence.freeze(legacy.digest, 'initial-cli-resume-cutover');
    await legacyAuthorityFence.activate(legacy.digest, 'initial-cli-resume-cutover', 1);
    const authorityFloor = await initializeSharedAuthorityFloor({
      root: path.join(directory, 'external-authority-floor'),
      protectedRoots: [store.root],
      verifyStorage: false,
      clock,
      initial: {
        storeMarkerDigest: active.storeMarkerDigest,
        minimumStoreGeneration: active.storeGeneration,
        minimumSelectorRevision: active.revision,
        activeBuildIdentity: active.activeBuildIdentity,
        authorityTransitionDigest: active.authorityTransitionDigest,
        activationEpoch: 1,
        legacyPermanentlyRetired: true,
        activationRevision: active.activationRevision,
        activationCutoverDigest: active.activationCutoverDigest,
      },
    });
    const handoffId = 'cli-resume-handoff-0001';
    const reportDirectory = path.join(directory, 'reports');
    await prepareSharedAuthorityBuildHandoff({
      store,
      coordinator,
      admissionGate,
      legacyAuthorityFence,
      authorityFloor,
      reportDirectory,
      handoffId,
      targetBuildIdentity: rollbackBuild,
      operatorReview: review(),
      clock,
    });
    const drainObservation = await captureSharedAuthorityDrainObservation({
      store,
      coordinator,
      admissionGate,
      legacyAuthorityFence,
      launchOperationStore,
      cutoverId: handoffId,
      legacyComparativeRoot,
      legacySingleSiteQueueRoot,
      clock,
    });
    await assert.rejects(beginSharedAuthorityBuildHandoff({
      store,
      coordinator,
      admissionGate,
      legacyAuthorityFence,
      reportDirectory,
      handoffId,
      drainObservation,
      clock,
      hooks: { afterPendingSelector: () => { throw new Error('synthetic crash after pending selector'); } },
    }), /synthetic crash/u);
    const pending = await readReleaseAuthoritySelector(store);
    assert.equal(pending.phase, 'PROMOTION_DISABLED');
    assert.equal(pending.handoffId, handoffId);
    assert.equal(pending.pendingBuildIdentity, rollbackBuild);

    const resumed = await beginSharedAuthorityBuildHandoffFromCli({
      store,
      coordinator,
      admissionGate,
      legacyAuthorityFence,
      reportDirectory,
      handoffId,
      targetBuildIdentity: rollbackBuild,
      launchOperationRoot: path.join(store.root, 'launch-operations'),
      legacyComparativeRoot,
      legacySingleSiteQueueRoot,
      clock,
    });
    assert.equal(resumed.status, 'PROMOTION_DISABLED_PENDING_TARGET_HEALTH');
    assert.equal(resumed.selectorPending.digest, pending.digest,
      'the CLI begin-handoff rerun must resume without recapturing an ACTIVE-only drain observation');
  }
  {
    const { directory, store } = await fixture('backup-cli-action');
    const trustDirectory = path.join(directory, 'trust');
    const backupDirectory = path.join(directory, 'cli-backup-rehearsal');
    await Promise.all([
      mkdir(trustDirectory, { recursive: true }),
      mkdir(backupDirectory, { recursive: true }),
    ]);
    const storeMarkerFile = path.join(trustDirectory, 'store-marker');
    const backupMarkerFile = path.join(trustDirectory, 'backup-marker');
    await Promise.all([
      writeFile(storeMarkerFile, `${marker}\n`),
      writeFile(backupMarkerFile, `${backup}\n`),
    ]);
    const configFile = path.join(directory, 'backup-operator-config.json');
    const receiptFile = path.join(backupDirectory, 'receipt.json');
    const backupRoot = path.join(backupDirectory, 'backup');
    const restoreRoot = path.join(backupDirectory, 'restore');
    await writeFile(configFile, `${JSON.stringify({
      schemaVersion: 1,
      cutoverId: 'cutover-backup-cli-action',
      activationRevision: 73,
      rollbackBuildIdentity: rollbackBuild,
      store: {
        root: store.root,
        deploymentIdentity,
        volumeIdentity,
        storeMarkerFile,
        storeGeneration: 4,
        schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
        supportedSchemaVersion: PARENT_RUN_STORE_SCHEMA_VERSION,
        writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
        minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
        buildIdentity: build,
        prequalifiedRollbackBuilds: [build, rollbackBuild],
        backupMarker: backup,
        verifyStorage: false,
      },
      backupRehearsal: {
        rehearsalId: 'cutover-backup-cli-action-rehearsal',
        backupMarkerFile,
        backupRoot,
        restoreRoot,
        receiptFile,
      },
    })}\n`);
    let stdout = '';
    await runSharedAuthorityCutoverCli(
      ['rehearse-backup', '--config', configFile],
      { output: { write: (chunk) => { stdout += chunk; } } },
    );
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.kind, 'shared-store-backup-rehearsal-receipt');
    assert.equal(receipt.digest, JSON.parse(await readFile(receiptFile, 'utf8')).digest);
    assert.equal(receipt.sourceSnapshot.digest, receipt.restoreSnapshot.digest);
  }
  {
    const {
      directory, store, admissionGate, authorityFloor, coordinator, launchOperationStore,
      legacyAuthorityFence, legacyComparativeRoot, legacySingleSiteQueueRoot,
    } = await fixture('happy');
    const input = await request('cutover-happy', { directory, store });
    now += 100;
    input.operatorReview.reviewedAt = new Date(now).toISOString();
    const prepared = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, legacyAuthorityFence, authorityFloor,
      reportDirectory: path.join(directory, 'reports'), input,
    });
    assert.equal(prepared.status, 'DRAINING');
    assert.equal(prepared.admissionGate.state, 'CLOSED');
    assert.equal((await legacyAuthorityFence.read()).state, 'CLOSED');
    assert.equal((await readReleaseAuthoritySelector(store)).phase, 'DRAINING');

    const drainObservation = await captureSharedAuthorityDrainObservation({
      store, coordinator, admissionGate, legacyAuthorityFence, launchOperationStore, cutoverId: input.cutoverId,
      legacyComparativeRoot, legacySingleSiteQueueRoot, clock,
    });
    assert.deepEqual(drainObservation.activeLegacyAuthoritativeRunIds, []);
    assert.equal(drainObservation.legacyHeadMarkers.length, 1);
    assert.deepEqual(
      await readdir(legacySingleSiteQueueRoot),
      ['jobs'],
      'drain observation must not initialize indexes or otherwise mutate the legacy queue',
    );
    const report = await activateSharedAuthorityCutover({
      store, coordinator, admissionGate, legacyAuthorityFence, authorityFloor,
      reportDirectory: path.join(directory, 'reports'), input,
      drainObservation,
    });
    assert.equal(report.status, 'ACTIVE_ADMISSION_CLOSED');
    assert.equal(report.selectorAfter.phase, 'ACTIVE');
    assert.equal(report.selectorAfter.activationEpoch, 1);
    assert.equal(report.selectorAfter.activationRevision, 73);
    assert.equal((await legacyAuthorityFence.read()).state, 'ACTIVATED');
    assert.equal(report.authorityFloorAfter.activationEpoch, 1);
    assert.equal(report.authorityFloorAfter.minimumStoreGeneration, report.storeAfter.storeGeneration);
    assert.equal(report.authorityFloorAfter.minimumSelectorRevision, report.selectorAfter.revision);
    assert.equal(report.authorityFloorAfter.activeBuildIdentity, build);
    assert.equal((await authorityFloor.read()).digest, report.authorityFloorAfter.digest);
    assert.equal(report.storeAfter.storeGeneration, 5);
    assert.equal(report.preconditions.unexplainedAuthorityDrift, 0);
    assert.equal(report.preconditions.activeLegacyAuthoritativeRuns, 0);
    assert.equal(report.preconditions.releaseChangingMutations, 0);
    assert.equal(report.preconditions.singletonCanonicalWriter, true);
    assert.equal(report.preconditions.backupRehearsed, true);
    assert.equal(report.preconditions.backupRehearsalReceiptDigest, input.backupRehearsalReceipt.digest);
    assert.equal(report.backupRehearsal.receiptDigest, input.backupRehearsalReceipt.digest);
    assert.equal(report.backupRehearsal.sourceSnapshotDigest, report.backupRehearsal.backupSnapshotDigest);
    assert.equal(report.backupRehearsal.sourceSnapshotDigest, report.backupRehearsal.restoreSnapshotDigest);
    assert.equal(report.backupRehearsal.restoreMatchesSource, true);
    assert.equal(report.backupRehearsal.retainedCopiesPresent, true);
    assert.equal(report.backupRehearsal.retainedCopiesVerifiedAt, report.completedAt);
    assert.equal(report.operatorReview.reviewed, true);
    assert.equal(report.digest, canonicalDigest(Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'digest'))));
    assert.equal(JSON.parse(await readFile(path.join(directory, 'reports', 'cutover-happy.json'), 'utf8')).digest, report.digest);

    now += 100;
    const policy = createCutoverAdmissionPolicy({ admissionGate, store });
    await expectCode('CUTOVER_ADMISSION_CLOSED', () => policy.withLaunchAdmission(
      'ordinary-launch-closed-0001', canaryIntent('single-site'), async () => ({ runId: 'must-not-launch' }),
    ));
    const evidenceByRun = new Map();
    let singleCanaryRunId = 'canary-single-site';
    for (const [mode, runId] of [['single-site', 'canary-single-site'], ['comparative', 'canary-comparative']]) {
      const intent = canaryIntent(mode);
      const requestId = `cutover-${mode}-canary-0001`;
      const permit = await authorizeSharedCutoverCanaryLaunch({
        store,
        admissionGate,
        reportDirectory: path.join(directory, 'reports'),
        cutoverId: input.cutoverId,
        mode,
        requestId,
        actor: { id: 'operator:cutover-canary', kind: 'human' },
        intent,
        probeTargetIdentity: async () => targetIdentity,
        clock,
      });
      assert.equal(permit.mode, mode);
      const wrongIntent = structuredClone(intent);
      if (mode === 'single-site') wrongIntent.runContract.url = 'https://changed.example.test';
      else wrongIntent.runContract.candidateUrl = 'https://changed.example.test';
      await expectCode('CUTOVER_CANARY_LAUNCH_MISMATCH', () => policy.withLaunchAdmission(
        requestId, wrongIntent,
        async () => ({ runId: 'wrong-intent' }),
      ));
      const evidence = canaryEvidence({ mode, runId });
      const operation = await policy.withLaunchAdmission(requestId, intent, async () => ({
        operationId: digest(mode === 'single-site' ? 'c' : 'd').slice(7),
        actor: { id: 'operator:cutover-canary', kind: 'human' },
        runId,
        acceptedAt: new Date(now).toISOString(),
        compiledPlan: {
          createParentRunInput: {
            runnerRevision: evidence.runnerRevision,
            subjectCore: { revisions: { configuration: evidence.configurationRevision } },
          },
        },
      }));
      assert.equal(operation.runId, runId);
      evidenceByRun.set(runId, evidence);
    }
    let cutoverCanaryCancelAccepted = false;
    await policy.withMutationAdmission(
      'cancel',
      'cutover-canary-cancel-0001',
      { runId: singleCanaryRunId },
      async () => { cutoverCanaryCancelAccepted = true; },
    );
    assert.equal(cutoverCanaryCancelAccepted, true,
      'closed admission must permit cancellation of the exact consumed cutover canary so bounded recovery can proceed');
    await expectCode('CUTOVER_ADMISSION_CLOSED', () => policy.withMutationAdmission(
      'cancel',
      'cutover-non-canary-cancel-0001',
      { runId: 'run-not-the-current-canary' },
      async () => undefined,
    ));
    await expectCode('CUTOVER_CANARY_REPLACEMENT_BLOCKED', () => authorizeSharedCutoverCanaryLaunch({
      store,
      admissionGate,
      reportDirectory: path.join(directory, 'reports'),
      cutoverId: input.cutoverId,
      mode: 'single-site',
      requestId: 'cutover-single-site-canary-0002',
      actor: { id: 'operator:cutover-canary', kind: 'human' },
      intent: canaryIntent('single-site'),
      supersedeReason: 'Initial canary has not produced terminal evidence.',
      probeTargetIdentity: async () => targetIdentity,
      clock,
    }));
    await createParentRun(store, sealedRunInput(singleCanaryRunId, 'work-canary-single-site'));
    const failedCanaryLease = await claimWorkItem(store, singleCanaryRunId, coordinator, {
      workerId: 'worker-canary-single-site', capabilities: ['browser:chromium'],
      resourceClasses: ['ordinary'], leaseMs: 30_000,
    });
    const failedCanaryInbox = await publishAttemptEvidence(store, singleCanaryRunId, failedCanaryLease, {
      outcome: 'completed_product_failure', reason: 'canary-assertion-failed', artifacts: [],
      executionDescriptorDigest: failedCanaryLease.executionDescriptorDigest,
    });
    await adoptAttemptEvidence(store, singleCanaryRunId, coordinator, failedCanaryInbox);
    const retryIntent = canaryIntent('single-site');
    const retryPermit = await authorizeSharedCutoverCanaryLaunch({
      store,
      admissionGate,
      reportDirectory: path.join(directory, 'reports'),
      cutoverId: input.cutoverId,
      mode: 'single-site',
      requestId: 'cutover-single-site-canary-0002',
      actor: { id: 'operator:cutover-canary', kind: 'human' },
      intent: retryIntent,
      supersedeReason: 'Initial canary reached a terminal product failure after the deployment was repaired.',
      probeTargetIdentity: async () => targetIdentity,
      clock,
    });
    assert.equal(retryPermit.revision, 2);
    assert.equal(retryPermit.supersedesRunId, singleCanaryRunId);
    singleCanaryRunId = 'canary-single-site-retry';
    const retryEvidence = canaryEvidence({ mode: 'single-site', runId: singleCanaryRunId });
    await policy.withLaunchAdmission('cutover-single-site-canary-0002', retryIntent, async () => ({
      operationId: digest('e').slice(7),
      actor: { id: 'operator:cutover-canary', kind: 'human' },
      runId: singleCanaryRunId,
      acceptedAt: new Date(now).toISOString(),
      compiledPlan: { createParentRunInput: {
        runnerRevision: retryEvidence.runnerRevision,
        subjectCore: { revisions: { configuration: retryEvidence.configurationRevision } },
      } },
    }));
    evidenceByRun.set(singleCanaryRunId, retryEvidence);
    const readCanaryEvidence = async (_store, runId) => structuredClone(evidenceByRun.get(runId));
    const staleSingle = evidenceByRun.get(singleCanaryRunId);
    evidenceByRun.set(singleCanaryRunId, {
      ...staleSingle,
      createdAt: new Date(Date.parse(report.selectorAfter.activatedAt) - 1).toISOString(),
    });
    await expectCode('CUTOVER_CANARY_STALE', () => recordSharedCutoverCanary({
      store, admissionGate, reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      mode: 'single-site', runId: singleCanaryRunId, readCanaryEvidence, clock,
    }));
    evidenceByRun.set(singleCanaryRunId, {
      ...staleSingle,
      createdAt: report.selectorAfter.activatedAt,
    });
    await expectCode('CUTOVER_CANARY_LAUNCH_MISMATCH', () => recordSharedCutoverCanary({
      store, admissionGate, reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      mode: 'single-site', runId: singleCanaryRunId, readCanaryEvidence, clock,
    }));
    evidenceByRun.set(singleCanaryRunId, staleSingle);
    evidenceByRun.set(singleCanaryRunId, {
      ...staleSingle,
      trustedReprobeIdentity: { kind: 'target-preflight-set', value: digest('0') },
    });
    await expectCode('CUTOVER_CANARY_TARGET_MISMATCH', () => recordSharedCutoverCanary({
      store, admissionGate, reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      mode: 'single-site', runId: singleCanaryRunId, readCanaryEvidence, clock,
    }));
    evidenceByRun.set(singleCanaryRunId, staleSingle);
    await recordSharedCutoverCanary({
      store, admissionGate, reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      mode: 'single-site', runId: singleCanaryRunId, readCanaryEvidence, clock,
    });
    await expectCode('CUTOVER_CANARIES_INCOMPLETE', () => reopenSharedAdmissionAfterCanaries({
      store, admissionGate, reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      readCanaryEvidence, clock,
    }));
    assert.equal((await admissionGate.read()).state, 'CLOSED');
    await recordSharedCutoverCanary({
      store, admissionGate, reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      mode: 'comparative', runId: 'canary-comparative', readCanaryEvidence, clock,
    });
    evidenceByRun.get('canary-comparative').publicationDigest = `sha256:${'5'.repeat(64)}`;
    await expectCode('CUTOVER_CANARY_STALE', () => reopenSharedAdmissionAfterCanaries({
      store, admissionGate, reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      readCanaryEvidence, clock,
    }));
    assert.equal((await admissionGate.read()).state, 'CLOSED');
    evidenceByRun.get('canary-comparative').publicationDigest = `sha256:${'4'.repeat(64)}`;
    await assert.rejects(reopenSharedAdmissionAfterCanaries({
      store, admissionGate, reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      readCanaryEvidence, clock,
      hooks: { afterAdmissionOpened: () => { throw new Error('synthetic crash after admission reopen'); } },
    }), /synthetic crash after admission reopen/u);
    assert.equal((await admissionGate.read()).state, 'OPEN');
    const reopenedAdmission = await reopenSharedAdmissionAfterCanaries({
      store, admissionGate, reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      readCanaryEvidence, clock,
    });
    assert.equal(reopenedAdmission.status, 'ACTIVE_ADMISSION_OPEN');
    assert.equal((await admissionGate.read()).state, 'OPEN');

    const repeated = await activateSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observation(input.cutoverId, prepared.admissionGate, coordinator),
    });
    assert.equal(repeated.digest, report.digest, 'activation replay must return the immutable report');
    assert.equal((await readReleaseAuthoritySelector(store)).revision, report.selectorAfter.revision,
      'activation replay must not advance the selector');

    await assert.rejects(setSharedPromotionAvailability({
      store, coordinator, authorityFloor, phase: 'PROMOTION_DISABLED', buildIdentity: build,
      reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      hooks: { afterSelectorTransition: () => { throw new Error('synthetic crash after promotion selector transition'); } },
    }), /synthetic crash after promotion selector transition/u);
    const selectorAfterPromotionCrash = await readReleaseAuthoritySelector(store);
    assert.equal(selectorAfterPromotionCrash.phase, 'PROMOTION_DISABLED');
    assert.notEqual((await authorityFloor.read()).authorityTransitionDigest,
      selectorAfterPromotionCrash.authorityTransitionDigest,
      'a crash between selector and floor must fail closed until replay');
    const disabled = await setSharedPromotionAvailability({
      store, coordinator, authorityFloor, phase: 'PROMOTION_DISABLED', buildIdentity: build,
      reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
    });
    assert.equal(disabled.phase, 'PROMOTION_DISABLED');
    assert.equal(disabled.activationEpoch, 1);
    assert.equal((await authorityFloor.read()).authorityTransitionDigest, disabled.authorityTransitionDigest,
      'promotion transition replay must advance the external floor to the exact selector successor');
    await expectCode('AUTHORITY_TRANSITION_INVALID', () => rollbackSharedAuthorityBeforeActivation({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'),
      cutoverId: input.cutoverId, buildIdentity: build, operatorReview: review(),
    }));
    await expectCode('CUTOVER_PROMOTION_HEALTH_REQUIRED', () => setSharedPromotionAvailability({
      store, coordinator, authorityFloor, phase: 'ACTIVE', buildIdentity: build,
      reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      readCanaryEvidence, clock,
    }));
    now = Date.parse(disabled.updatedAt) + 1;
    evidenceByRun.set('health-single-site', canaryEvidence({ mode: 'single-site', runId: 'health-single-site' }));
    evidenceByRun.set('health-comparative', canaryEvidence({ mode: 'comparative', runId: 'health-comparative' }));
    await expectCode('CUTOVER_INPUT_INVALID', () => setSharedPromotionAvailability({
      store, coordinator, authorityFloor, phase: 'ACTIVE', buildIdentity: build,
      reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      healthCanaries: { 'single-site': 'health-single-site' }, readCanaryEvidence, clock,
    }));
    evidenceByRun.get('health-comparative').createdAt = new Date(Date.parse(disabled.updatedAt) - 1).toISOString();
    await expectCode('CUTOVER_CANARY_STALE', () => setSharedPromotionAvailability({
      store, coordinator, authorityFloor, phase: 'ACTIVE', buildIdentity: build,
      reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      healthCanaries: { 'single-site': 'health-single-site', comparative: 'health-comparative' },
      readCanaryEvidence, clock,
    }));
    evidenceByRun.get('health-comparative').createdAt = new Date(now).toISOString();
    const reenabled = await setSharedPromotionAvailability({
      store, coordinator, authorityFloor, phase: 'ACTIVE', buildIdentity: build,
      reportDirectory: path.join(directory, 'reports'), cutoverId: input.cutoverId,
      healthCanaries: { 'single-site': 'health-single-site', comparative: 'health-comparative' },
      readCanaryEvidence, clock,
      transitionWithPublicationFence: async (fencedStore, fencedCoordinator, transition) => {
        assert.deepEqual(transition.expectedPublications, [
          { runId: 'health-single-site', envelopeDigest: evidenceByRun.get('health-single-site').publicationDigest },
          { runId: 'health-comparative', envelopeDigest: evidenceByRun.get('health-comparative').publicationDigest },
        ]);
        const unfenced = { ...transition };
        delete unfenced.expectedPublications;
        return (await import('./lib/parent-run-store.mjs')).transitionReleaseAuthority(
          fencedStore, fencedCoordinator, unfenced,
        );
      },
    });
    assert.equal(reenabled.selector.phase, 'ACTIVE');
    assert.equal(reenabled.healthReceipt.kind, 'release-promotion-health-receipt');
  }

  {
    const {
      directory, store, admissionGate, authorityFloor, coordinator, launchOperationStore,
      legacyComparativeRoot, legacySingleSiteQueueRoot,
    } = await fixture('production-observer-operation');
    const input = await request('cutover-production-observer-operation', { directory, store });
    await createParentRun(store, {
      runId: 'run-cutover-operation', subjectCoreDigest: `sha256:${'e'.repeat(64)}`,
      workItems: [{ id: 'work-cutover-operation', maxAttempts: 1, capability: 'browser:chromium', targetId: 'candidate' }],
    });
    const accepted = await acceptOperation(store, 'run-cutover-operation', {
      idempotencyKey: 'cutover-operation-0001', kind: 'cancel',
      actor: { id: 'operator-cutover', kind: 'human' }, body: { reason: 'drain proof' },
    });
    await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
    });
    const observed = await captureSharedAuthorityDrainObservation({
      store, coordinator, admissionGate, launchOperationStore, cutoverId: input.cutoverId,
      legacyComparativeRoot, legacySingleSiteQueueRoot, clock,
    });
    const operationIdentity = `run-cutover-operation:${accepted.operationId}`;
    assert.deepEqual(observed.releaseChangingMutationIds, [operationIdentity]);
    assert.deepEqual(observed.unresolvedOperationIds, [operationIdentity]);
  }

  {
    const {
      directory, store, admissionGate, authorityFloor, coordinator, launchOperationStore,
      legacyComparativeRoot, legacySingleSiteQueueRoot,
    } = await fixture('claim-fenced-after-observation');
    const input = await request('cutover-claim-fenced-after-observation', { directory, store });
    await createParentRun(store, {
      runId: 'run-cutover-queued', subjectCoreDigest: digest('8'),
      workItems: [{ id: 'work-cutover-queued', maxAttempts: 1, capability: 'browser:chromium', targetId: 'candidate' }],
    });
    await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
    });
    const observed = await captureSharedAuthorityDrainObservation({
      store, coordinator, admissionGate, launchOperationStore, cutoverId: input.cutoverId,
      legacyComparativeRoot, legacySingleSiteQueueRoot, clock,
    });
    assert.deepEqual(observed.unfencedLegacyLeaseIds, []);
    await expectCode('CUTOVER_WORK_CLAIMS_FENCED', () => claimWorkItem(store, 'run-cutover-queued', coordinator, {
      workerId: 'worker-after-observation', capabilities: ['browser:chromium'],
      resourceClasses: ['ordinary'], leaseMs: 30_000,
    }));
    assert.equal((await readParentRun(store, 'run-cutover-queued')).workItems['work-cutover-queued'].state, 'queued');
  }

  {
    const {
      directory, store, admissionGate, authorityFloor, coordinator, launchOperationStore,
      legacyComparativeRoot, legacySingleSiteQueueRoot,
    } = await fixture('production-observer-applied-operation');
    const input = await request('cutover-production-observer-applied-operation', { directory, store });
    const runId = 'run-cutover-applied-operation';
    const workItemId = 'work-cutover-applied-operation';
    await createParentRun(store, sealedRunInput(runId, workItemId));
    const failedLease = await claimWorkItem(store, runId, coordinator, {
      workerId: 'worker-applied-operation', capabilities: ['browser:chromium'],
      resourceClasses: ['ordinary'], leaseMs: 30_000,
    });
    const failedInbox = await publishAttemptEvidence(store, runId, failedLease, {
      outcome: 'operational_failure', reason: 'Synthetic exhaustion before cutover.', artifacts: [],
    });
    await adoptAttemptEvidence(store, runId, coordinator, failedInbox);
    const exhausted = await readParentRun(store, runId);
    const accepted = await acceptOperation(store, runId, {
      idempotencyKey: 'cutover-applied-rekick-0001',
      kind: 'rekick',
      actor: { id: 'operator-cutover', kind: 'human' },
      body: { expectedSubjectDigest: exhausted.finalSubjectDigest, workItemIds: [workItemId] },
      expectedSubjectDigest: exhausted.finalSubjectDigest,
    });
    const applied = await applyRekickOperation(store, runId, coordinator, accepted.operationId, {
      observedDeploymentIdentity: exhausted.subjectCore.deploymentIdentity,
    });
    assert.equal(applied.state, 'applied');
    await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
    });
    const observed = await captureSharedAuthorityDrainObservation({
      store, coordinator, admissionGate, launchOperationStore, cutoverId: input.cutoverId,
      legacyComparativeRoot, legacySingleSiteQueueRoot, clock,
    });
    const operationIdentity = `${runId}:${accepted.operationId}`;
    assert.deepEqual(observed.unresolvedOperationIds, [operationIdentity]);
    assert.deepEqual(observed.releaseChangingMutationIds, [operationIdentity]);
  }

  {
    const {
      directory, store, admissionGate, authorityFloor, coordinator, launchOperationStore,
      legacyComparativeRoot, legacySingleSiteQueueRoot,
    } = await fixture('production-observer-running-diagnostic');
    const input = await request('cutover-production-observer-running-diagnostic', { directory, store });
    const runId = 'run-cutover-running-diagnostic';
    const workItemId = 'work-cutover-running-diagnostic';
    const runInput = sealedRunInput(runId, workItemId);
    await createParentRun(store, runInput);
    const failedLease = await claimWorkItem(store, runId, coordinator, {
      workerId: 'worker-canonical-failure', capabilities: ['browser:chromium'],
      resourceClasses: ['ordinary'], leaseMs: 30_000,
    });
    const failedInbox = await publishAttemptEvidence(store, runId, failedLease, {
      outcome: 'completed_product_failure', reason: 'assertion-failed', artifacts: [],
      executionDescriptorDigest: failedLease.executionDescriptorDigest,
    });
    await adoptAttemptEvidence(store, runId, coordinator, failedInbox);
    const failed = await readParentRun(store, runId);
    const accepted = await acceptOperation(store, runId, {
      idempotencyKey: 'cutover-diagnostic-rerun-0001',
      kind: 'diagnostic-rerun',
      actor: { id: 'operator-cutover', kind: 'human' },
      body: { expectedSubjectDigest: failed.finalSubjectDigest, workItemId },
      expectedSubjectDigest: failed.finalSubjectDigest,
    });
    await applyDiagnosticRerunOperation(store, runId, coordinator, accepted.operationId, {
      observedDeploymentIdentity: failed.subjectCore.deploymentIdentity,
    });
    await completeOperation(store, runId, coordinator, accepted.operationId, { status: 'succeeded' });
    const diagnosticLease = await claimWorkItem(store, runId, coordinator, {
      workerId: 'worker-diagnostic', capabilities: ['browser:chromium'],
      resourceClasses: ['ordinary'], leaseMs: 30_000,
    });
    assert.equal(diagnosticLease.diagnosticExecutionId, accepted.operationId);
    await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
    });
    const observed = await captureSharedAuthorityDrainObservation({
      store, coordinator, admissionGate, launchOperationStore, cutoverId: input.cutoverId,
      legacyComparativeRoot, legacySingleSiteQueueRoot, clock,
    });
    assert.deepEqual(observed.unfencedLegacyLeaseIds, [
      `shared-preactivation:${runId}:${workItemId}:diagnostic:${accepted.operationId}:${diagnosticLease.token}`,
    ], 'running diagnostic execution must block activation as an unfenced preactivation lease');
    await expectCode('CUTOVER_LEASES_UNFENCED', () => activateSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observed,
    }));
  }

  {
    const {
      directory, store, admissionGate, authorityFloor, coordinator, launchOperationStore,
      legacyComparativeRoot, legacySingleSiteQueueRoot,
    } = await fixture('production-observer-active-legacy');
    const input = await request('cutover-production-observer-active-legacy', { directory, store });
    await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
    });
    const activeDirectory = path.join(legacyComparativeRoot, 'active-legacy-run');
    await mkdir(path.join(activeDirectory, 'logs'), { recursive: true });
    await writeFile(path.join(activeDirectory, 'logs', 'coordinator.log'), '{"event":"started"}\n');
    const observed = await captureSharedAuthorityDrainObservation({
      store, coordinator, admissionGate, launchOperationStore, cutoverId: input.cutoverId,
      legacyComparativeRoot, legacySingleSiteQueueRoot, clock,
    });
    assert.deepEqual(observed.activeLegacyAuthoritativeRunIds, ['comparative:active-legacy-run']);
    await expectCode('CUTOVER_LEGACY_RUNS_ACTIVE', () => activateSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observed,
    }));
  }

  {
    const {
      directory, store, admissionGate, authorityFloor, coordinator, launchOperationStore,
      legacyComparativeRoot, legacySingleSiteQueueRoot,
    } = await fixture('production-observer-partial-legacy');
    const input = await request('cutover-production-observer-partial-legacy', { directory, store });
    await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
    });
    const partialDirectory = path.join(legacyComparativeRoot, 'partial-legacy-run');
    await mkdir(partialDirectory, { recursive: true });
    await writeFile(path.join(partialDirectory, 'sharded-run.json'), '{"schemaVersion":2,"runId":"partial-legacy-run"}\n');
    await expectCode('CUTOVER_LEGACY_SOURCE_CORRUPT', () => captureSharedAuthorityDrainObservation({
      store, coordinator, admissionGate, launchOperationStore, cutoverId: input.cutoverId,
      legacyComparativeRoot, legacySingleSiteQueueRoot, clock,
    }));
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('rollback');
    const input = await request('cutover-rollback', { directory, store });
    const prepared = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    });
    const rolledBack = await rollbackSharedAuthorityBeforeActivation({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'),
      cutoverId: input.cutoverId, buildIdentity: build, operatorReview: review(),
    });
    assert.equal(rolledBack.status, 'PREACTIVATION_ROLLED_BACK');
    assert.equal(rolledBack.selectorAfter.phase, 'SHADOW');
    assert.equal(rolledBack.selectorAfter.activationEpoch, 0);
    assert.equal(rolledBack.admissionGateAfter.state, 'OPEN');
    assert.equal(prepared.admissionGate.cutoverId, input.cutoverId);
  }

  {
    const { directory, store, admissionGate, authorityFloor, coordinator } = await fixture('crash');
    const input = await request('cutover-crash', { directory, store });
    await assert.rejects(prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
      hooks: { afterAdmissionClosed: () => { throw new Error('synthetic crash after admission close'); } },
    }), /synthetic crash/u);
    assert.equal((await admissionGate.read()).state, 'CLOSED');
    const resumed = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
    });
    assert.equal(resumed.status, 'DRAINING');
    await assert.rejects(activateSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observation(input.cutoverId, resumed.admissionGate, coordinator),
      hooks: { afterAuthorityActivated: () => { throw new Error('synthetic crash after authority activation'); } },
    }), /synthetic crash/u);
    assert.equal((await readReleaseAuthoritySelector(store)).phase, 'ACTIVE');
    assert.equal((await authorityFloor.read()).activationEpoch, 0,
      'a crash after selector activation but before permanent retirement must leave the old external floor');
    const recovered = await activateSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observation(input.cutoverId, resumed.admissionGate, coordinator),
    });
    assert.equal(recovered.status, 'ACTIVE_ADMISSION_CLOSED');
    assert.equal((await authorityFloor.read()).activationEpoch, 1,
      'activation replay must advance the external authority floor before completing');
  }

  {
    const {
      directory, store, admissionGate, legacyAuthorityFence, authorityFloor, coordinator,
    } = await fixture('authority-floor-crash');
    const input = await request('cutover-authority-floor-crash', { directory, store });
    const prepared = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, legacyAuthorityFence,
      reportDirectory: path.join(directory, 'reports'), input,
    });
    await assert.rejects(activateSharedAuthorityCutover({
      store, coordinator, admissionGate, legacyAuthorityFence, authorityFloor,
      reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observation(input.cutoverId, prepared.admissionGate, coordinator),
      hooks: { afterAuthorityFloorAdvanced: () => { throw new Error('synthetic crash after authority floor advance'); } },
    }), /synthetic crash after authority floor advance/u);
    const advancedFloor = await authorityFloor.read();
    assert.equal(advancedFloor.activationEpoch, 1);
    const recovered = await activateSharedAuthorityCutover({
      store, coordinator, admissionGate, legacyAuthorityFence, authorityFloor,
      reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observation(input.cutoverId, prepared.admissionGate, coordinator),
    });
    assert.equal(recovered.authorityFloorAfter.digest, advancedFloor.digest,
      'activation replay must accept only the exact already-advanced floor successor');
  }

  for (const [name, mutate, code] of [
    ['active-run', (value) => value.activeLegacyAuthoritativeRunIds.push('legacy-run'), 'CUTOVER_LEGACY_RUNS_ACTIVE'],
    ['mutation', (value) => value.releaseChangingMutationIds.push('mutation-1'), 'CUTOVER_MUTATIONS_ACTIVE'],
    ['operation', (value) => value.unresolvedOperationIds.push('operation-1'), 'CUTOVER_OPERATIONS_UNRESOLVED'],
    ['lease', (value) => value.unfencedLegacyLeaseIds.push('lease-1'), 'CUTOVER_LEASES_UNFENCED'],
    ['split-writer', (value) => value.canonicalWriterOwnerIds.push('coordinator-other'), 'CUTOVER_WRITER_NOT_SINGLETON'],
  ]) {
    const { directory, store, admissionGate, authorityFloor, coordinator } = await fixture(`reject-${name}`);
    const input = await request(`cutover-reject-${name}`, { directory, store });
    const prepared = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
    });
    const observed = observation(input.cutoverId, prepared.admissionGate, coordinator);
    mutate(observed);
    const { digest: _oldDigest, ...observedBody } = observed;
    observed.digest = canonicalDigest(observedBody);
    await expectCode(code, () => activateSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observed,
    }));
    assert.equal((await readReleaseAuthoritySelector(store)).phase, 'DRAINING');
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-drift');
    const input = await request('cutover-reject-drift', { directory, store });
    const changed = structuredClone(buildPreRegisteredShadowMatrix());
    changed.cases.find(({ caseId }) => caseId === 'AE1').shared.outcomeCode = 'NOT_READY_TEST_FAILURE';
    input.shadowReport = runShadowValidation({ ...changed, generatedAt: new Date(now).toISOString() });
    await expectCode('CUTOVER_SHADOW_BLOCKED', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
    assert.equal((await admissionGate.read()).state, 'OPEN');
  }

  for (const [name, mutate, code] of [
    ['missing-corruption-case', (matrix) => {
      matrix.cases = matrix.cases.filter(({ caseId }) => caseId !== SHADOW_CORRUPTION_CASE_IDS[0]);
    }, 'CUTOVER_SHADOW_INCOMPLETE'],
    ['different-matrix', (matrix) => {
      const changed = matrix.cases.find(({ caseId }) => caseId === SHADOW_ACCEPTANCE_CASE_IDS[0]);
      changed.legacy.selectedFeatures = ['site', 'changed-but-matching'];
      changed.shared.selectedFeatures = ['site', 'changed-but-matching'];
    }, 'CUTOVER_SHADOW_MATRIX_MISMATCH'],
  ]) {
    const { directory, store, admissionGate, coordinator } = await fixture(`reject-shadow-${name}`);
    const input = await request(`cutover-reject-shadow-${name}`, { directory, store });
    const matrix = structuredClone(buildPreRegisteredShadowMatrix());
    mutate(matrix);
    input.shadowReport = runShadowValidation({ ...matrix, generatedAt: new Date(now).toISOString() });
    input.operatorReview = cutoverReview(input);
    await expectCode(code, () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
    assert.equal((await admissionGate.read()).state, 'OPEN');
  }

  for (const field of [
    'shadowValidationDigest', 'shadowMatrixDigest', 'buildIdentity', 'expectedStoreDigest', 'configurationDigest',
    'backupRehearsalReceiptDigest',
  ]) {
    const { directory, store, admissionGate, coordinator } = await fixture(`reject-review-${field}`);
    const input = await request(`cutover-reject-review-${field}`, { directory, store });
    input.operatorReview[field] = field === 'buildIdentity' ? 'build:other' : digest('9');
    await expectCode('CUTOVER_SHADOW_REVIEW_MISMATCH', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
    assert.equal((await admissionGate.read()).state, 'OPEN');
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-review-predates-shadow');
    const input = await request('cutover-reject-review-predates-shadow', { directory, store });
    input.operatorReview.reviewedAt = new Date(now - 1).toISOString();
    await expectCode('CUTOVER_SHADOW_REVIEW_MISMATCH', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
    assert.equal((await admissionGate.read()).state, 'OPEN');
  }

  {
    const { directory, store, admissionGate, authorityFloor, coordinator } = await fixture('reject-activation-shadow-rebinding');
    const input = await request('cutover-reject-activation-shadow-rebinding', { directory, store });
    const prepared = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    });
    const drainObservation = observation(input.cutoverId, prepared.admissionGate, coordinator);

    const incompleteInput = structuredClone(input);
    const incompleteMatrix = structuredClone(buildPreRegisteredShadowMatrix());
    incompleteMatrix.cases = incompleteMatrix.cases
      .filter(({ caseId }) => caseId !== SHADOW_CORRUPTION_CASE_IDS[0]);
    incompleteInput.shadowReport = runShadowValidation({
      ...incompleteMatrix, generatedAt: new Date(now).toISOString(),
    });
    incompleteInput.operatorReview = cutoverReview(incompleteInput);
    await expectCode('CUTOVER_SHADOW_INCOMPLETE', () => activateSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'),
      input: incompleteInput, drainObservation,
    }));

    const staleReviewInput = structuredClone(input);
    staleReviewInput.operatorReview.configurationDigest = digest('9');
    await expectCode('CUTOVER_SHADOW_REVIEW_MISMATCH', () => activateSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'),
      input: staleReviewInput, drainObservation,
    }));
    assert.equal((await readReleaseAuthoritySelector(store)).phase, 'DRAINING');
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-backup-receipt-shapes');
    const input = await request('cutover-reject-backup-receipt-shapes', { directory, store });
    const markerOnly = structuredClone(input);
    markerOnly.backupRehearsalReceipt = { backupMarker: backup };
    await expectCode('CUTOVER_BACKUP_RECEIPT_INVALID', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input: markerOnly,
    }));
    const missing = structuredClone(input);
    missing.backupRehearsalReceipt = undefined;
    await expectCode('CUTOVER_BACKUP_RECEIPT_INVALID', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input: missing,
    }));
    const tampered = structuredClone(input);
    tampered.backupRehearsalReceipt.completedAt = new Date(now + 1_000).toISOString();
    await expectCode('CUTOVER_BACKUP_RECEIPT_INVALID', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input: tampered,
    }));
  }

  for (const [name, mutate] of [
    ['generation', (receipt) => { receipt.storeGeneration += 1; }],
    ['build', (receipt) => { receipt.buildIdentity = 'build:stale-backup-rehearsal'; }],
    ['configuration', (receipt) => { receipt.configurationDigest = digest('9'); }],
    ['selector', (receipt) => { receipt.selectorDigest = digest('9'); }],
  ]) {
    const { directory, store, admissionGate, coordinator } = await fixture(`reject-backup-${name}`);
    const input = await request(`cutover-reject-backup-${name}`, { directory, store });
    const changed = structuredClone(input.backupRehearsalReceipt);
    mutate(changed);
    input.backupRehearsalReceipt = resealReceipt(changed);
    input.operatorReview.backupRehearsalReceiptDigest = input.backupRehearsalReceipt.digest;
    await expectCode('CUTOVER_BACKUP_RECEIPT_MISMATCH', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-incomplete-backup-restore');
    const input = await request('cutover-reject-incomplete-backup-restore', { directory, store });
    await unlink(path.join(input.restoreRoot, 'store-manifest.json'));
    await expectCode('CUTOVER_BACKUP_RESTORE_INVALID', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-stale-backup-receipt');
    const input = await request('cutover-reject-stale-backup-receipt', { directory, store });
    now += 60 * 60_000 + 1;
    await expectCode('CUTOVER_BACKUP_RECEIPT_MISMATCH', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-mismatch');
    const input = await request('cutover-reject-mismatch', { directory, store });
    input.expectedStore.storeMarkerDigest = canonicalDigest({ storeMarker: 'ef'.repeat(32) });
    input.operatorReview = cutoverReview(input);
    await expectCode('CUTOVER_BACKUP_RECEIPT_MISMATCH', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
    input.expectedStore = expectedStore();
    input.rollbackBuildIdentity = 'build:not-prequalified';
    input.operatorReview = cutoverReview(input);
    await expectCode('CUTOVER_BACKUP_RECEIPT_MISMATCH', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-live-store-mismatch');
    const input = await request('cutover-reject-live-store-mismatch', { directory, store });
    store.buildIdentity = 'build:unexpected-live-store-opener';
    await expectCode('CUTOVER_STORE_MISMATCH', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-live-rollback-build');
    const input = await request(
      'cutover-reject-live-rollback-build',
      { directory, store },
      'initial',
      'build:not-prequalified',
    );
    await expectCode('CUTOVER_ROLLBACK_BUILD_UNQUALIFIED', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
  }

  {
    const { directory, store, admissionGate, authorityFloor, coordinator } = await fixture('reject-stale');
    const input = await request('cutover-reject-stale', { directory, store });
    const prepared = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
    });
    now += 301_000;
    const stale = observation(input.cutoverId, prepared.admissionGate, coordinator);
    stale.observedAt = new Date(now - 301_000).toISOString();
    const { digest: _oldDigest, ...staleBody } = stale;
    stale.digest = canonicalDigest(staleBody);
    await expectCode('CUTOVER_OBSERVATION_STALE', () => activateSharedAuthorityCutover({
      store, coordinator, admissionGate, authorityFloor, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: stale,
    }));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('Shared cutover orchestrator self-test passed: admission drain, shadow/store gates, crash recovery, one-time activation, and rollback remain fail closed.\n');
