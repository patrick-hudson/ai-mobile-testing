import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSharedCoordinatorSupervisor } from './lib/shared-coordinator-supervisor.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import {
  adoptAttemptEvidence, createParentRun, openParentRunStore, publishAttemptEvidence, readParentRun,
} from './lib/parent-run-store.mjs';
import { compileSharedLaunchPlan } from '../shared/launch-plan-compiler.mjs';
import { withDirectoryLock } from './lib/atomic-filesystem.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-coordinator-supervisor-'));
const digest = (character) => `sha256:${character.repeat(64)}`;
let now = Date.parse('2026-08-29T12:00:00.000Z');
const inventorySealHooks = [];
try {
  const [pluginRegistry, targetRegistry] = await Promise.all([
    readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const store = await openParentRunStore({
    root,
    deploymentIdentity: 'supervisor-test',
    volumeIdentity: 'named-volume:supervisor-test',
    verifyStorage: false,
    clock: () => now,
  });
  const supervisor = createSharedCoordinatorSupervisor({
    store,
    controlService: createSharedControlService({ store, projectId: 'project-1' }),
    projectId: 'project-1',
    ownerId: 'coordinator-supervisor-test',
    coordinatorLeaseMs: 60_000,
    workLeaseMs: 1_000,
    pluginRegistry,
    targetRegistry,
    afterInventorySeal: (input) => { inventorySealHooks.push(input); },
  });
  assert.deepEqual(await supervisor.maintain(), {
    state: 'ready', epoch: 1, runCount: 0, requeued: 0, completedOperations: 0, sealedGraphs: 0,
    performanceScheduler: { phase: 'idle', runId: null, workItemId: null }, errors: [],
  }, 'the store-wide coordinator must acquire before the first run exists');
  for (const [runId, suffix] of [['run-a', 'a'], ['run-b', 'b']]) {
    await createParentRun(store, {
      runId,
      subjectCoreDigest: digest(suffix),
      compilationState: 'pending',
      runnerRevision: 'runner-v1',
      workItems: [{
        id: `work-${suffix}`, maxAttempts: 3, capability: 'browser:chromium', resourceClass: 'ordinary',
        targetId: 'single-site-mobile-chromium', specAffinity: 'tests/accessibility.spec.ts',
      }],
    });
  }
  const worker = {
    id: 'worker-ordinary', kind: 'worker', roles: ['worker'], projectIds: ['project-1'], runIds: ['*'],
    workerGrant: { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
  };
  const first = await supervisor.claim(worker, {
    workerId: worker.id, capabilities: ['browser:chromium'], resourceClasses: ['ordinary'],
  });
  const second = await supervisor.claim(worker, {
    workerId: worker.id, capabilities: ['browser:chromium'], resourceClasses: ['ordinary'],
  });
  assert.deepEqual([first.runId, second.runId].sort(), ['run-a', 'run-b'],
    'one store-wide scheduler must fairly claim work from multiple portal-created runs');
  assert.equal((await supervisor.maintain()).runCount, 2);
  assert.throws(() => supervisor.schedulingFor({ ...worker, workerGrant: {
    capabilities: ['performance:lighthouse'], resourceClasses: ['performance'],
  } }, { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] }), /server-issued execution grant/i);
  await assert.rejects(supervisor.claim({ ...worker, id: 'worker-performance', workerGrant: {
    capabilities: ['performance:lighthouse'], resourceClasses: ['performance'],
  } }), (error) => error?.code === 'PERFORMANCE_DRAIN_REQUIRED');

  const deploymentIdentity = { kind: 'target-preflight-set', value: digest('9') };
  const launch = compileSharedLaunchPlan({
    intent: { schemaVersion: 1, runContract: {
      schemaVersion: 1,
      mode: 'single-site',
      url: 'https://candidate.example.test',
      deploymentRole: 'preview',
      certificatePolicy: 'strict',
      targetIds: ['single-site-mobile-chromium'],
      scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['A11Y-001'], areas: [] },
    } },
    pluginRegistry,
    targetRegistry,
    runnerRevision: digest('1'),
    configurationRevision: digest('2'),
    environmentRevision: digest('3'),
    deploymentIdentity,
  });
  await createParentRun(store, { runId: 'run-inventory', ...launch.createParentRunInput });
  const inventoryWorker = {
    ...worker,
    id: 'worker-inventory',
    workerGrant: { capabilities: ['inventory:http'], resourceClasses: ['ordinary'] },
  };
  const inventoryLease = await supervisor.claim(inventoryWorker);
  assert.equal(inventoryLease.runId, 'run-inventory');
  const inventoryDocument = {
    schemaVersion: 1,
    kind: 'shared-single-site-inventory-result',
    workItemId: inventoryLease.workItemId,
    executionDescriptorDigest: inventoryLease.executionDescriptorDigest,
    deploymentIdentityRecheck: deploymentIdentity,
    preflight: { accepted: true },
    diagnostic: {
      inventory: {
        schemaVersion: 1,
        origin: 'https://candidate.example.test',
        routes: [{
          url: 'https://candidate.example.test/', path: '/', query: '', disposition: 'included',
          sources: [{ source: 'catalog', from: null, depth: 0 }],
        }],
        limitations: [], failures: [],
      },
    },
  };
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventoryDocument)}\n`);
  const inbox = await publishAttemptEvidence(store, 'run-inventory', inventoryLease, {
    outcome: 'completed_pass',
    executionDescriptorDigest: inventoryLease.executionDescriptorDigest,
    artifacts: [{
      name: 'inventory/live-route-inventory.json',
      mediaType: 'application/json',
      sizeBytes: inventoryBytes.length,
      digest: `sha256:${createHash('sha256').update(inventoryBytes).digest('hex')}`,
      contentBase64: inventoryBytes.toString('base64'),
    }],
  });
  await adoptAttemptEvidence(store, 'run-inventory', supervisor.coordinator(), inbox);
  const sealed = await supervisor.maintain();
  assert.equal(sealed.sealedGraphs, 1);
  assert.equal(inventorySealHooks.length, 1);
  assert.equal(inventorySealHooks[0].runId, 'run-inventory');
  const sealedState = await readParentRun(store, 'run-inventory');
  assert.equal(sealedState.compilationState, 'sealed');
  assert(sealedState.finalSubjectDigest);
  assert(Object.values(sealedState.workItems).every(({ executionDescriptor }) => executionDescriptor?.digest),
    'inventory expansion must preserve a compiler-issued descriptor on every browser work item');

  await createParentRun(store, { runId: 'run-inventory-expiry', ...launch.createParentRunInput });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const expiredLease = await supervisor.claim(inventoryWorker);
    assert.equal(expiredLease.runId, 'run-inventory-expiry');
    assert.equal(expiredLease.attempt, attempt);
    now += 1_001;
    const maintenance = await supervisor.maintain();
    assert.deepEqual(maintenance.errors, [], JSON.stringify(maintenance.errors));
  }
  const expiredInventory = await readParentRun(store, 'run-inventory-expiry');
  const terminalAttempt = expiredInventory.workItems[launch.inventoryBarrier.workItem.id].attempts.at(-1);
  assert.equal(expiredInventory.compilationState, 'failed',
    'final-attempt lease expiry must terminalize inventory compilation');
  assert.match(terminalAttempt.canonicalResultDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(expiredInventory.compilationFailure.terminalResultDigest, terminalAttempt.canonicalResultDigest);
} finally {
  await rm(root, { recursive: true, force: true });
}

const leaseRoot = await mkdtemp(path.join(tmpdir(), 'shared-coordinator-lease-rollover-'));
let leaseNow = Date.parse('2026-08-29T13:00:00.000Z');
let advanceDuringMaintenance = false;
let advancedMaintenance = false;
let publicationRacePending = false;
try {
  const leaseStore = await openParentRunStore({
    root: leaseRoot,
    deploymentIdentity: 'supervisor-lease-rollover-test',
    volumeIdentity: 'named-volume:supervisor-lease-rollover-test',
    verifyStorage: false,
    clock: () => leaseNow,
  });
  for (const [runId, suffix] of [['lease-run-a', 'c'], ['lease-run-b', 'd']]) {
    await createParentRun(leaseStore, {
      runId,
      subjectCoreDigest: digest(suffix),
      compilationState: 'pending',
      runnerRevision: 'runner-v1',
      workItems: [{
        id: `lease-work-${suffix}`, maxAttempts: 3, capability: 'browser:chromium', resourceClass: 'ordinary',
        targetId: 'single-site-mobile-chromium', specAffinity: 'tests/accessibility.spec.ts',
      }],
    });
  }
  const leaseSupervisor = createSharedCoordinatorSupervisor({
    store: leaseStore,
    controlService: {
      applyAcceptedOperations: async () => {
        if (advanceDuringMaintenance && !advancedMaintenance) {
          advancedMaintenance = true;
          leaseNow += 60_001;
        }
        return [];
      },
      publishCurrentProjection: async () => {
        if (publicationRacePending) {
          publicationRacePending = false;
          throw Object.assign(new Error('projection raced a durable heartbeat'), {
            code: 'PUBLICATION_LEDGER_MISMATCH',
          });
        }
        return null;
      },
    },
    projectId: 'project-1',
    ownerId: 'coordinator-lease-rollover-test',
    coordinatorLeaseMs: 60_000,
    workLeaseMs: 1_000,
  });
  assert.deepEqual((await leaseSupervisor.maintain()).errors, []);
  const leaseWorker = {
    id: 'lease-worker', kind: 'worker', roles: ['worker'], projectIds: ['project-1'], runIds: ['*'],
    workerGrant: { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
  };
  const oldEpochLease = await leaseSupervisor.claim(leaseWorker);
  assert.equal(oldEpochLease.runId, 'lease-run-a');
  advanceDuringMaintenance = true;
  const crossedLease = await leaseSupervisor.maintain();
  assert.deepEqual(crossedLease.errors, [],
    'maintenance must renew or reacquire coordinator authority when a run sweep crosses the lease deadline');
  assert.equal(crossedLease.epoch, 2,
    'maintenance must report the coordinator epoch that actually completed the sweep');
  assert.equal(crossedLease.requeued, 1,
    'an epoch rollover must revisit prior runs and recover work fenced by the new epoch in the same pass');
  assert.equal((await readParentRun(leaseStore, 'lease-run-a')).workItems['lease-work-c'].state, 'queued');
  let releaseMutationLock;
  let mutationLockAcquired;
  const mutationLockReady = new Promise((resolve) => { mutationLockAcquired = resolve; });
  const mutationLockGate = new Promise((resolve) => { releaseMutationLock = resolve; });
  const heldMutationLock = withDirectoryLock(
    leaseStore.storage,
    path.join(leaseRoot, '.coordinator-mutation-lock'),
    async () => {
      mutationLockAcquired();
      await mutationLockGate;
    },
  );
  await mutationLockReady;
  const renewal = leaseSupervisor.renewCoordinator();
  const renewalResult = await Promise.race([
    renewal.then((value) => ({ status: 'renewed', value })),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'blocked' }), 250)),
  ]);
  releaseMutationLock();
  await heldMutationLock;
  await renewal;
  assert.equal(renewalResult.status, 'renewed',
    'coordinator liveness must renew while a canonical mutation holds the global mutation lock');
  assert.equal(renewalResult.value.epoch, 2,
    'isolated coordinator renewal must retain the active fencing epoch');
  publicationRacePending = true;
  assert.deepEqual((await leaseSupervisor.maintain()).errors, [],
    'a projection that races a durable heartbeat must remain pending for the next maintenance pass');
  leaseNow += 60_001;
  const competingSupervisor = createSharedCoordinatorSupervisor({
    store: leaseStore,
    controlService: { applyAcceptedOperations: async () => [], publishCurrentProjection: async () => null },
    projectId: 'project-1', ownerId: 'competing-coordinator', coordinatorLeaseMs: 60_000, workLeaseMs: 1_000,
  });
  assert.equal((await competingSupervisor.maintain()).state, 'ready');
  const displacedStatus = await leaseSupervisor.maintain();
  assert.equal(displacedStatus.state, 'waiting-for-lease',
    'a supervisor displaced by another coordinator must not publish false-ready health');
  assert.equal(displacedStatus.epoch, null);
} finally {
  await rm(leaseRoot, { recursive: true, force: true });
}

const scaleRoot = await mkdtemp(path.join(tmpdir(), 'shared-coordinator-production-scale-'));
let scaleNow = Date.parse('2026-08-29T14:00:00.000Z');
try {
  const scaleStore = await openParentRunStore({
    root: scaleRoot,
    deploymentIdentity: 'supervisor-production-scale-test',
    volumeIdentity: 'named-volume:supervisor-production-scale-test',
    verifyStorage: false,
    clock: () => scaleNow,
  });
  for (const [runId, count, suffix] of [
    ['scale-comparative', 518, 'e'],
    ['scale-single-site', 385, 'f'],
  ]) {
    await createParentRun(scaleStore, {
      runId,
      subjectCoreDigest: digest(suffix),
      compilationState: 'pending',
      runnerRevision: 'runner-v1',
      workItems: Array.from({ length: count }, (_, index) => ({
        id: `${runId}-work-${String(index).padStart(3, '0')}`,
        maxAttempts: 3,
        capability: index === 0 ? 'performance:lighthouse' : 'browser:chromium',
        resourceClass: index === 0 ? 'performance' : 'ordinary',
        targetId: 'candidate-mobile-chromium',
        specAffinity: 'tests/accessibility.spec.ts',
      })),
    });
  }
  const scaleSupervisor = createSharedCoordinatorSupervisor({
    store: scaleStore,
    controlService: {
      applyAcceptedOperations: async () => [],
      publishCurrentProjection: async () => null,
    },
    projectId: 'project-1',
    ownerId: 'coordinator-production-scale-test',
    coordinatorLeaseMs: 60_000,
    workLeaseMs: 1_000,
  });
  assert.deepEqual((await scaleSupervisor.maintain()).errors, []);
  const scaleWorker = {
    id: 'scale-worker', kind: 'worker', roles: ['worker'], projectIds: ['project-1'], runIds: ['*'],
    workerGrant: { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
  };
  const scaleClaims = await Promise.all(Array.from({ length: 3 }, () => scaleSupervisor.claim(scaleWorker)));
  assert.deepEqual(new Set(scaleClaims.map(({ runId }) => runId)),
    new Set(['scale-comparative', 'scale-single-site']),
    'concurrent production-sized claims must preserve fairness across both modes');
  const performanceWorker = {
    id: 'scale-performance-worker', kind: 'worker', roles: ['worker'], projectIds: ['project-1'], runIds: ['*'],
    workerGrant: { capabilities: ['performance:lighthouse'], resourceClasses: ['performance'] },
  };
  const performanceReservation = await scaleSupervisor.requestPerformanceDrain(performanceWorker);
  assert.equal(performanceReservation.runId, 'scale-single-site',
    'performance reservations must honor the same rotated run order as ordinary claims');
  scaleNow += 1_001;
  const scaleRecovery = await scaleSupervisor.maintain();
  assert.deepEqual(scaleRecovery.errors, [], JSON.stringify(scaleRecovery.errors));
  assert.equal(scaleRecovery.requeued, 3,
    'one maintenance pass must reclaim every expired lease across simultaneous production-sized runs');
  assert.equal(scaleRecovery.epoch, 1,
    'ordinary production-sized recovery must not churn the coordinator epoch');
  for (const runId of ['scale-comparative', 'scale-single-site']) {
    const state = await readParentRun(scaleStore, runId);
    assert.equal(Object.values(state.workItems).filter(({ state: workState }) => workState === 'running').length, 0,
      `${runId} must not retain expired running work after bounded recovery`);
  }
} finally {
  await rm(scaleRoot, { recursive: true, force: true });
}
process.stdout.write('Shared coordinator supervisor self-test passed: store-wide startup, multi-run fairness, and server-issued worker grants are enforced.\n');
