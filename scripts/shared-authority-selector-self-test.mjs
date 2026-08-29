import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { appendPublicationEnvelope } from '../shared/publication-envelope.mjs';
import {
  PARENT_RUN_STORE_SCHEMA_VERSION,
  PARENT_RUN_WRITER_PROTOCOL,
  acquireStoreCoordinator,
  createParentRun,
  openParentRunStore,
  publishCurrentEnvelope,
  readCurrentEnvelope,
  readReleaseAuthorityContext,
  readReleaseAuthoritySelector,
  takeOverStoreCoordinator,
  transitionReleaseAuthority,
  withCurrentEnvelopeFence,
} from './lib/parent-run-store.mjs';
import {
  consumePromotionClaim,
  issuePromotionClaim,
  openPromotionClaimStore,
} from './lib/promotion-claim-store.mjs';

const marker = 'ab'.repeat(32);
const build = 'build:shared-selector-v1';
const rollbackBuild = 'build:shared-selector-rollback-v1';
const backup = 'backup:before-shared-activation';
const digest = canonicalDigest({ fixture: 'shared-authority-selector' });
const root = await mkdtemp(path.join(tmpdir(), 'shared-authority-selector-'));
let now = Date.parse('2026-08-29T16:00:00.000Z');
const clock = () => now;

function expectCode(code, operation) {
  return assert.rejects(operation, (error) => error?.code === code);
}

function envelope() {
  const decision = {
    schemaVersion: 1,
    kind: 'release-decision',
    runId: 'run-selector',
    decisionRevision: 1,
    code: 'RELEASE_READY',
    label: 'RELEASE READY',
    ready: true,
    exitCode: 0,
    executionManifestDigest: digest,
    mode: 'single-site',
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
    runId: 'run-selector',
    runRevision: 1,
    decisionRevision: 1,
    riskRevision: 1,
    ledgerSequences: { observations: 1, decisions: 1, risks: 0 },
    finalSubjectDigest: digest,
    decision,
    riskRegister: { schemaVersion: 1, availability: 'EMPTY', risks: [] },
  });
}

try {
  const store = await openParentRunStore({
    root,
    deploymentIdentity: 'compose-project:selector-test',
    volumeIdentity: 'named-volume:selector-test',
    storeMarker: marker,
    storeGeneration: 7,
    schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
    buildIdentity: build,
    backupMarker: backup,
    prequalifiedRollbackBuilds: [build, rollbackBuild],
    verifyStorage: false,
    clock,
  });
  assert.equal(store.manifest.storeMarkerDigest, canonicalDigest({ storeMarker: marker }));
  assert.equal(store.manifest.storeGeneration, 7);
  assert.equal(store.manifest.coordinatorEpoch, 0);
  assert.equal(store.manifest.schemaFloor, PARENT_RUN_STORE_SCHEMA_VERSION);
  assert.equal(store.manifest.currentWriterProtocol, PARENT_RUN_WRITER_PROTOCOL);
  assert.equal(store.manifest.minimumWriterProtocol, PARENT_RUN_WRITER_PROTOCOL);

  const shadow = await readReleaseAuthoritySelector(store);
  assert.equal(shadow.phase, 'SHADOW');
  assert.equal(shadow.activationEpoch, 0);
  assert.equal(shadow.activationRevision, null);

  await createParentRun(store, {
    runId: 'run-selector', subjectCoreDigest: digest, finalSubjectDigest: digest,
    executionManifestDigest: digest, compilationState: 'sealed',
    workItems: [{ id: 'work-selector', maxAttempts: 1 }],
  });
  const readyEnvelope = envelope();
  const claimStore = await openPromotionClaimStore({ root: path.join(root, 'claim-store'), clock });
  const delivery = {
    id: 'delivery-selector', kind: 'service', roles: ['delivery'],
    projectIds: ['project-selector'], runIds: ['run-selector'],
  };
  const expected = {
    projectId: 'project-selector', subjectDigest: readyEnvelope.finalSubjectDigest,
    authority: 'FULL', executionSetDigest: readyEnvelope.decision.executionManifestDigest,
    runRevision: readyEnvelope.runRevision, decisionRevision: readyEnvelope.decisionRevision,
  };
  const shadowContext = await readReleaseAuthorityContext(store);
  await expectCode('PROMOTION_AUTHORITY_INACTIVE', () => issuePromotionClaim(claimStore, {
    principal: delivery, publication: readyEnvelope,
    authorityContext: shadowContext,
    expected, requestId: 'selector-shadow-ready', ttlMs: 60_000,
  }));
  const firstCoordinator = await acquireStoreCoordinator(store, { ownerId: 'coordinator-before-activation', leaseMs: 100 });
  assert.equal(firstCoordinator.epoch, 1);
  assert.equal((await readReleaseAuthoritySelector(store)).activationEpoch, 0,
    'coordinator lease epochs must not activate release authority');
  await expectCode('RELEASE_AUTHORITY_INACTIVE', () => publishCurrentEnvelope(
    store, 'run-selector', firstCoordinator, readyEnvelope,
  ));
  await expectCode('PUBLICATION_UNAVAILABLE', () => readCurrentEnvelope(store, 'run-selector'));

  const draining = await transitionReleaseAuthority(store, firstCoordinator, {
    expectedSelectorDigest: shadow.digest,
    phase: 'DRAINING',
    buildIdentity: build,
  });
  assert.equal(draining.phase, 'DRAINING');
  await assert.rejects(transitionReleaseAuthority(store, firstCoordinator, {
    expectedSelectorDigest: draining.digest,
    phase: 'ACTIVE',
    activationRevision: 41,
    buildIdentity: build,
    hooks: { afterActivationIntent: () => { throw new Error('synthetic interrupted pre-fence activation'); } },
  }), /synthetic interrupted pre-fence activation/);
  assert.equal((await readReleaseAuthoritySelector(store)).phase, 'DRAINING',
    'an interrupted activation must remain safely retryable and non-authoritative');

  now += 101;
  const takeover = await takeOverStoreCoordinator(store, { ownerId: 'coordinator-after-crash', leaseMs: 100 });
  assert.equal(takeover.epoch, 2);
  await assert.rejects(transitionReleaseAuthority(store, takeover, {
    expectedSelectorDigest: draining.digest,
    phase: 'ACTIVE',
    activationRevision: 41,
    buildIdentity: build,
    hooks: { afterActivationFence: () => { throw new Error('synthetic crash after activation fence'); } },
  }), /synthetic crash after activation fence/);
  const active = await readReleaseAuthoritySelector(store);
  assert.equal(active.phase, 'ACTIVE');
  assert.equal(active.activationEpoch, 1);
  assert.equal(active.activationRevision, 41);
  assert.equal(active.storeGeneration, 8);
  assert.equal(store.manifest.storeGeneration, 8);
  assert.equal(store.manifest.coordinatorEpoch, 2);
  const repeated = await transitionReleaseAuthority(store, takeover, {
    expectedSelectorDigest: active.digest,
    phase: 'ACTIVE',
    activationRevision: 41,
    buildIdentity: build,
  });
  assert.equal(repeated.digest, active.digest, 'repeated activation must be idempotent');
  await expectCode('AUTHORITY_SELECTOR_CONFLICT', () => transitionReleaseAuthority(store, takeover, {
    expectedSelectorDigest: draining.digest,
    phase: 'PROMOTION_DISABLED',
    buildIdentity: build,
  }));
  await expectCode('AUTHORITY_TRANSITION_INVALID', () => transitionReleaseAuthority(store, takeover, {
    expectedSelectorDigest: active.digest,
    phase: 'SHADOW',
    buildIdentity: build,
  }));

  const published = await publishCurrentEnvelope(store, 'run-selector', takeover, readyEnvelope);
  assert.equal((await readCurrentEnvelope(store, 'run-selector')).digest, published.digest);
  const activeContext = await readReleaseAuthorityContext(store, { requireActive: true });
  const claim = await issuePromotionClaim(claimStore, {
    principal: delivery, publication: published, authorityContext: activeContext,
    expected, requestId: 'selector-claim-0001', ttlMs: 60_000,
  });
  const staleBindingBody = { ...activeContext.binding, storeGeneration: activeContext.binding.storeGeneration + 1 };
  delete staleBindingBody.digest;
  const staleContext = {
    selector: activeContext.selector,
    binding: { ...staleBindingBody, digest: canonicalDigest(staleBindingBody) },
  };
  await expectCode('PROMOTION_CLAIM_STALE', () => consumePromotionClaim(claimStore, claim.token, {
    principal: delivery,
    expectedSubjectDigest: published.finalSubjectDigest,
    withCurrentPublication: (callback) => callback(published, staleContext),
  }));
  const disabled = await transitionReleaseAuthority(store, takeover, {
    expectedSelectorDigest: active.digest,
    phase: 'PROMOTION_DISABLED',
    buildIdentity: build,
  });
  assert.equal(disabled.phase, 'PROMOTION_DISABLED');
  assert.equal(disabled.activationEpoch, 1);
  const disabledContext = await readReleaseAuthorityContext(store);
  await expectCode('PROMOTION_AUTHORITY_INACTIVE', () => issuePromotionClaim(claimStore, {
    principal: delivery, publication: published, authorityContext: disabledContext,
    expected, requestId: 'selector-claim-disabled', ttlMs: 60_000,
  }));
  await expectCode('RELEASE_AUTHORITY_INACTIVE', () => consumePromotionClaim(claimStore, claim.token, {
    principal: delivery,
    expectedSubjectDigest: published.finalSubjectDigest,
    withCurrentPublication: (callback) => withCurrentEnvelopeFence(store, 'run-selector', callback),
  }));
  await expectCode('RELEASE_AUTHORITY_INACTIVE', () => publishCurrentEnvelope(
    store, 'run-selector', takeover, published,
  ));
  await expectCode('AUTHORITY_TRANSITION_INVALID', () => transitionReleaseAuthority(store, takeover, {
    expectedSelectorDigest: disabled.digest,
    phase: 'DRAINING',
    buildIdentity: build,
  }));

  await expectCode('STORE_GENERATION_REQUIRED', () => openParentRunStore({
    root, deploymentIdentity: 'compose-project:selector-test', volumeIdentity: 'named-volume:selector-test',
    storeMarker: marker, writerProtocol: PARENT_RUN_WRITER_PROTOCOL, buildIdentity: build,
    verifyStorage: false,
  }));
  const compatibleReopen = await openParentRunStore({
    root, deploymentIdentity: 'compose-project:selector-test', volumeIdentity: 'named-volume:selector-test',
    storeMarker: marker, expectedStoreGeneration: 8,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL, buildIdentity: build,
    verifyStorage: false,
  });
  assert.equal((await readReleaseAuthoritySelector(compatibleReopen)).phase, 'PROMOTION_DISABLED');
  await expectCode('STORE_BUILD_INCOMPATIBLE', () => openParentRunStore({
    root, deploymentIdentity: 'compose-project:selector-test', volumeIdentity: 'named-volume:selector-test',
    storeMarker: marker, expectedStoreGeneration: 8,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL, buildIdentity: 'build:unqualified',
    verifyStorage: false,
  }));

  const rollbackStore = await openParentRunStore({
    root, deploymentIdentity: 'compose-project:selector-test', volumeIdentity: 'named-volume:selector-test',
    storeMarker: marker, expectedStoreGeneration: 8,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL, buildIdentity: rollbackBuild,
    verifyStorage: false, clock,
  });
  now += 101;
  const rollbackCoordinator = await takeOverStoreCoordinator(rollbackStore, {
    ownerId: 'coordinator-compatible-rollback', leaseMs: 100,
  });
  const rollbackActive = await transitionReleaseAuthority(rollbackStore, rollbackCoordinator, {
    expectedSelectorDigest: disabled.digest,
    phase: 'ACTIVE', activationRevision: 41, buildIdentity: rollbackBuild,
  });
  assert.equal(rollbackActive.activeBuildIdentity, rollbackBuild);
  await expectCode('AUTHORITY_TRANSITION_INVALID', () => transitionReleaseAuthority(
    rollbackStore, rollbackCoordinator, {
      expectedSelectorDigest: rollbackActive.digest, phase: 'SHADOW', buildIdentity: rollbackBuild,
    },
  ));
  await transitionReleaseAuthority(rollbackStore, rollbackCoordinator, {
    expectedSelectorDigest: rollbackActive.digest, phase: 'PROMOTION_DISABLED', buildIdentity: rollbackBuild,
  });

  await expectCode('STORE_IDENTITY_MISMATCH', () => openParentRunStore({
    root, deploymentIdentity: 'compose-project:selector-test', volumeIdentity: 'named-volume:wrong',
    storeMarker: marker, writerProtocol: PARENT_RUN_WRITER_PROTOCOL, buildIdentity: build,
    verifyStorage: false,
  }));
  await expectCode('STORE_MARKER_MISMATCH', () => openParentRunStore({
    root, deploymentIdentity: 'compose-project:selector-test', volumeIdentity: 'named-volume:selector-test',
    storeMarker: 'cd'.repeat(32), writerProtocol: PARENT_RUN_WRITER_PROTOCOL, buildIdentity: build,
    verifyStorage: false,
  }));
  await expectCode('STORE_GENERATION_MISMATCH', () => openParentRunStore({
    root, deploymentIdentity: 'compose-project:selector-test', volumeIdentity: 'named-volume:selector-test',
    storeMarker: marker, expectedStoreGeneration: 6, writerProtocol: PARENT_RUN_WRITER_PROTOCOL, buildIdentity: build,
    verifyStorage: false,
  }));
  await expectCode('STORE_WRITER_INCOMPATIBLE', () => openParentRunStore({
    root, deploymentIdentity: 'compose-project:selector-test', volumeIdentity: 'named-volume:selector-test',
    storeMarker: marker, writerProtocol: 'single-coordinator-global-performance-v1', buildIdentity: 'build:old',
    verifyStorage: false,
  }));
  await expectCode('STORE_SCHEMA_FLOOR_UNSUPPORTED', () => openParentRunStore({
    root, deploymentIdentity: 'compose-project:selector-test', volumeIdentity: 'named-volume:selector-test',
    storeMarker: marker, writerProtocol: PARENT_RUN_WRITER_PROTOCOL, buildIdentity: build,
    supportedSchemaVersion: PARENT_RUN_STORE_SCHEMA_VERSION - 1,
    verifyStorage: false,
  }));

  const selectorPath = path.join(root, 'release-authority-selector.json');
  const saved = await readFile(selectorPath, 'utf8');
  const stale = JSON.parse(saved);
  stale.storeGeneration -= 1;
  const { digest: _oldDigest, ...staleBody } = stale;
  stale.digest = canonicalDigest(staleBody);
  await writeFile(selectorPath, `${JSON.stringify(stale)}\n`);
  await expectCode('AUTHORITY_SELECTOR_INVALID', () => openParentRunStore({
    root, deploymentIdentity: 'compose-project:selector-test', volumeIdentity: 'named-volume:selector-test',
    storeMarker: marker, writerProtocol: PARENT_RUN_WRITER_PROTOCOL, buildIdentity: build,
    verifyStorage: false,
  }));
  await writeFile(selectorPath, saved);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('Shared authority selector self-test passed: store identity, writer floors, one-way activation, coordinator takeover, publication gating, and promotion-disabled rollback fail closed.\n');
