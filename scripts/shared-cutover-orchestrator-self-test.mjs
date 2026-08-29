import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { buildPreRegisteredShadowMatrix } from '../shared/shadow-validation-fixtures.mjs';
import { runShadowValidation } from '../shared/shadow-validation.mjs';
import {
  PARENT_RUN_STORE_SCHEMA_VERSION,
  PARENT_RUN_WRITER_PROTOCOL,
  acquireStoreCoordinator,
  openParentRunStore,
  readReleaseAuthoritySelector,
} from './lib/parent-run-store.mjs';
import {
  activateSharedAuthorityCutover,
  openCutoverAdmissionGate,
  prepareSharedAuthorityCutover,
  rollbackSharedAuthorityBeforeActivation,
  setSharedPromotionAvailability,
} from './lib/shared-cutover-orchestrator.mjs';

const marker = 'cd'.repeat(32);
const build = 'build:cutover-current';
const rollbackBuild = 'build:cutover-rollback';
const backup = 'backup:cutover-rehearsed';
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
  const admissionGate = await openCutoverAdmissionGate({
    root: path.join(directory, 'admission'), verifyStorage: false, clock,
  });
  const coordinator = await acquireStoreCoordinator(store, {
    ownerId: `coordinator-${name}`, leaseMs: 60_000,
  });
  return { directory, store, admissionGate, coordinator };
}

function request(cutoverId) {
  return {
    cutoverId,
    activationRevision: 73,
    buildIdentity: build,
    rollbackBuildIdentity: rollbackBuild,
    expectedStore: expectedStore(),
    shadowReport: shadowReport(),
    operatorReview: review(),
  };
}

async function expectCode(code, operation) {
  await assert.rejects(operation, (error) => error?.code === code);
}

try {
  {
    const { directory, store, admissionGate, coordinator } = await fixture('happy');
    const input = request('cutover-happy');
    const prepared = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    });
    assert.equal(prepared.status, 'DRAINING');
    assert.equal(prepared.admissionGate.state, 'CLOSED');
    assert.equal((await readReleaseAuthoritySelector(store)).phase, 'DRAINING');

    const report = await activateSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observation(input.cutoverId, prepared.admissionGate, coordinator),
    });
    assert.equal(report.status, 'ACTIVE_ADMISSION_CLOSED');
    assert.equal(report.selectorAfter.phase, 'ACTIVE');
    assert.equal(report.selectorAfter.activationEpoch, 1);
    assert.equal(report.selectorAfter.activationRevision, 73);
    assert.equal(report.storeAfter.storeGeneration, 5);
    assert.equal(report.preconditions.unexplainedAuthorityDrift, 0);
    assert.equal(report.preconditions.activeLegacyAuthoritativeRuns, 0);
    assert.equal(report.preconditions.releaseChangingMutations, 0);
    assert.equal(report.preconditions.singletonCanonicalWriter, true);
    assert.equal(report.operatorReview.reviewed, true);
    assert.equal(report.digest, canonicalDigest(Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'digest'))));
    assert.equal(JSON.parse(await readFile(path.join(directory, 'reports', 'cutover-happy.json'), 'utf8')).digest, report.digest);

    const repeated = await activateSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observation(input.cutoverId, prepared.admissionGate, coordinator),
    });
    assert.equal(repeated.digest, report.digest, 'activation replay must return the immutable report');
    assert.equal((await readReleaseAuthoritySelector(store)).revision, report.selectorAfter.revision,
      'activation replay must not advance the selector');

    const disabled = await setSharedPromotionAvailability({
      store, coordinator, phase: 'PROMOTION_DISABLED', buildIdentity: build,
    });
    assert.equal(disabled.phase, 'PROMOTION_DISABLED');
    assert.equal(disabled.activationEpoch, 1);
    await expectCode('AUTHORITY_TRANSITION_INVALID', () => rollbackSharedAuthorityBeforeActivation({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'),
      cutoverId: input.cutoverId, buildIdentity: build, operatorReview: review(),
    }));
    const reenabled = await setSharedPromotionAvailability({
      store, coordinator, phase: 'ACTIVE', buildIdentity: build,
    });
    assert.equal(reenabled.phase, 'ACTIVE');
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('rollback');
    const input = request('cutover-rollback');
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
    const { directory, store, admissionGate, coordinator } = await fixture('crash');
    const input = request('cutover-crash');
    await assert.rejects(prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
      hooks: { afterAdmissionClosed: () => { throw new Error('synthetic crash after admission close'); } },
    }), /synthetic crash/u);
    assert.equal((await admissionGate.read()).state, 'CLOSED');
    const resumed = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    });
    assert.equal(resumed.status, 'DRAINING');
    await assert.rejects(activateSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observation(input.cutoverId, resumed.admissionGate, coordinator),
      hooks: { afterAuthorityActivated: () => { throw new Error('synthetic crash after authority activation'); } },
    }), /synthetic crash/u);
    assert.equal((await readReleaseAuthoritySelector(store)).phase, 'ACTIVE');
    const recovered = await activateSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observation(input.cutoverId, resumed.admissionGate, coordinator),
    });
    assert.equal(recovered.status, 'ACTIVE_ADMISSION_CLOSED');
  }

  for (const [name, mutate, code] of [
    ['active-run', (value) => value.activeLegacyAuthoritativeRunIds.push('legacy-run'), 'CUTOVER_LEGACY_RUNS_ACTIVE'],
    ['mutation', (value) => value.releaseChangingMutationIds.push('mutation-1'), 'CUTOVER_MUTATIONS_ACTIVE'],
    ['operation', (value) => value.unresolvedOperationIds.push('operation-1'), 'CUTOVER_OPERATIONS_UNRESOLVED'],
    ['lease', (value) => value.unfencedLegacyLeaseIds.push('lease-1'), 'CUTOVER_LEASES_UNFENCED'],
    ['split-writer', (value) => value.canonicalWriterOwnerIds.push('coordinator-other'), 'CUTOVER_WRITER_NOT_SINGLETON'],
  ]) {
    const { directory, store, admissionGate, coordinator } = await fixture(`reject-${name}`);
    const input = request(`cutover-reject-${name}`);
    const prepared = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    });
    const observed = observation(input.cutoverId, prepared.admissionGate, coordinator);
    mutate(observed);
    const { digest: _oldDigest, ...observedBody } = observed;
    observed.digest = canonicalDigest(observedBody);
    await expectCode(code, () => activateSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: observed,
    }));
    assert.equal((await readReleaseAuthoritySelector(store)).phase, 'DRAINING');
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-drift');
    const input = request('cutover-reject-drift');
    const changed = structuredClone(buildPreRegisteredShadowMatrix());
    changed.cases.find(({ caseId }) => caseId === 'AE1').shared.outcomeCode = 'NOT_READY_TEST_FAILURE';
    input.shadowReport = runShadowValidation({ ...changed, generatedAt: new Date(now).toISOString() });
    await expectCode('CUTOVER_SHADOW_BLOCKED', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
    assert.equal((await admissionGate.read()).state, 'OPEN');
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-mismatch');
    const input = request('cutover-reject-mismatch');
    input.expectedStore.storeMarkerDigest = canonicalDigest({ storeMarker: 'ef'.repeat(32) });
    await expectCode('CUTOVER_STORE_MISMATCH', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
    input.expectedStore = expectedStore();
    input.rollbackBuildIdentity = 'build:not-prequalified';
    await expectCode('CUTOVER_ROLLBACK_BUILD_UNQUALIFIED', () => prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    }));
  }

  {
    const { directory, store, admissionGate, coordinator } = await fixture('reject-stale');
    const input = request('cutover-reject-stale');
    const prepared = await prepareSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
    });
    now += 301_000;
    const stale = observation(input.cutoverId, prepared.admissionGate, coordinator);
    stale.observedAt = new Date(now - 301_000).toISOString();
    const { digest: _oldDigest, ...staleBody } = stale;
    stale.digest = canonicalDigest(staleBody);
    await expectCode('CUTOVER_OBSERVATION_STALE', () => activateSharedAuthorityCutover({
      store, coordinator, admissionGate, reportDirectory: path.join(directory, 'reports'), input,
      drainObservation: stale,
    }));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('Shared cutover orchestrator self-test passed: admission drain, shadow/store gates, crash recovery, one-time activation, and rollback remain fail closed.\n');
