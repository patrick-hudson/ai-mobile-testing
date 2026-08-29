import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSharedCoordinatorSupervisor } from './lib/shared-coordinator-supervisor.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import {
  acquireStoreCoordinator,
  adoptAttemptEvidence,
  adoptWorkHeartbeat,
  createParentRun,
  heartbeatWorkItem,
  openParentRunStore,
  publishAttemptEvidence,
  claimWorkItem,
  readParentRun,
  readStorePerformanceScheduler,
  requeueExpiredWork,
  requestPerformanceDrain,
} from './lib/parent-run-store.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-global-performance-'));
const digest = (character) => `sha256:${character.repeat(64)}`;
let now = Date.parse('2026-08-29T12:00:00.000Z');

const principal = (id, capabilities, resourceClass) => ({
  id,
  kind: 'worker',
  roles: ['worker'],
  projectIds: ['project-1'],
  runIds: ['*'],
  workerGrant: { capabilities, resourceClasses: [resourceClass] },
});

const workItem = (id, capability, resourceClass, targetId) => ({
  id,
  maxAttempts: 2,
  capability,
  resourceClass,
  targetId,
  specAffinity: capability === 'performance:lighthouse' ? 'tests/performance.spec.ts' : 'tests/smoke.spec.ts',
});

try {
  const store = await openParentRunStore({
    root,
    deploymentIdentity: 'global-performance-test',
    volumeIdentity: 'named-volume:global-performance-test',
    verifyStorage: false,
    clock: () => now,
  });
  for (const [runId, suffix, items] of [
    ['run-active', 'a', [workItem('ordinary-active', 'browser:chromium', 'ordinary', 'candidate-desktop-chromium')]],
    ['run-later', 'b', [workItem('ordinary-later', 'browser:chromium', 'ordinary', 'candidate-desktop-chromium')]],
    ['run-performance', 'c', [workItem('performance-only', 'performance:lighthouse', 'performance', 'candidate-desktop-chromium')]],
  ]) {
    await createParentRun(store, {
      runId,
      subjectCoreDigest: digest(suffix),
      runnerRevision: 'runner-performance-v1',
      workItems: items,
    });
  }

  const supervisor = createSharedCoordinatorSupervisor({
    store,
    controlService: createSharedControlService({ store, projectId: 'project-1' }),
    projectId: 'project-1',
    ownerId: 'coordinator-global-performance',
    coordinatorLeaseMs: 60_000,
    workLeaseMs: 10_000,
  });
  await supervisor.maintain();

  const ordinary = principal('worker-ordinary', ['browser:chromium'], 'ordinary');
  const performance = principal('worker-performance', ['performance:lighthouse'], 'performance');
  const otherPerformance = principal('worker-performance-other', ['performance:lighthouse'], 'performance');

  const ordinaryLease = await supervisor.claim(ordinary);
  assert.equal(ordinaryLease.runId, 'run-active');

  const drain = await supervisor.requestPerformanceDrain(performance);
  assert.equal(drain.runId, 'run-performance');
  assert.equal(drain.workerId, performance.id);
  await assert.rejects(supervisor.claim(ordinary), (error) => error?.code === 'PERFORMANCE_DRAINING',
    'a drain in one run must pause ordinary claims in every run');
  await assert.rejects(supervisor.claim(performance), (error) => error?.code === 'PERFORMANCE_DRAIN_PENDING',
    'performance cannot start while ordinary work is active in another run');
  await assert.rejects(supervisor.requestPerformanceDrain(otherPerformance), (error) => error?.code === 'PERFORMANCE_DRAIN_HELD');

  const ordinaryInbox = await publishAttemptEvidence(store, ordinaryLease.runId, ordinaryLease, {
    outcome: 'completed_pass',
    executionDescriptorDigest: ordinaryLease.executionDescriptorDigest,
    artifacts: [],
  });
  await adoptAttemptEvidence(store, ordinaryLease.runId, supervisor.coordinator(), ordinaryInbox);

  const performanceLease = await supervisor.claim(performance);
  assert.equal(performanceLease.runId, 'run-performance');
  assert.equal(performanceLease.attempt, 1);
  await assert.rejects(supervisor.claim(ordinary), (error) => error?.code === 'PERFORMANCE_DRAINING');
  await assert.rejects(supervisor.requestPerformanceDrain(otherPerformance), (error) => error?.code === 'PERFORMANCE_LEASE_HELD');

  now += 2_000;
  const heartbeat = await heartbeatWorkItem(store, performanceLease.runId, performanceLease, { leaseMs: 10_000 });
  await adoptWorkHeartbeat(store, performanceLease.runId, supervisor.coordinator(), heartbeat);
  const heartbeatScheduler = await readStorePerformanceScheduler(store);
  assert.equal(heartbeatScheduler.phase, 'running');
  assert.equal(heartbeatScheduler.reservation.leaseToken, performanceLease.token,
    'the global exclusion must remain bound to the exact fenced performance work lease');

  now += 10_001;
  const maintenance = await supervisor.maintain();
  assert.equal(maintenance.requeued, 1, 'worker death must requeue only the expired performance item');
  const recoveredState = await readParentRun(store, 'run-performance');
  assert.equal(recoveredState.workItems['performance-only'].state, 'queued');
  assert.equal(recoveredState.workItems['performance-only'].attempts[0].reason, 'lease-expired');
  assert.equal(recoveredState.resourceScheduling.performanceDrain, null);
  assert.equal(recoveredState.resourceScheduling.exclusiveLease, null);

  const secondDrain = await supervisor.requestPerformanceDrain(performance);
  assert.equal(secondDrain.runId, 'run-performance');
  const retryLease = await supervisor.claim(performance);
  assert.equal(retryLease.attempt, 2);
  await assert.rejects(
    publishAttemptEvidence(store, performanceLease.runId, performanceLease, {
      outcome: 'completed_pass', executionDescriptorDigest: performanceLease.executionDescriptorDigest, artifacts: [],
    }),
    (error) => error?.code === 'STALE_WORK_LEASE',
    'a dead worker cannot publish through its expired fenced lease',
  );
  const performanceInbox = await publishAttemptEvidence(store, retryLease.runId, retryLease, {
    outcome: 'completed_pass',
    executionDescriptorDigest: retryLease.executionDescriptorDigest,
    artifacts: [],
  });
  await adoptAttemptEvidence(store, retryLease.runId, supervisor.coordinator(), performanceInbox);

  const resumedOrdinary = await supervisor.claim(ordinary);
  assert.equal(resumedOrdinary.runId, 'run-later', 'ordinary scheduling must resume after performance completes');

  const takeoverRoot = path.join(root, 'takeover-store');
  const takeoverStore = await openParentRunStore({
    root: takeoverRoot,
    deploymentIdentity: 'global-performance-takeover-test',
    volumeIdentity: 'named-volume:global-performance-takeover-test',
    verifyStorage: false,
    clock: () => now,
  });
  await createParentRun(takeoverStore, {
    runId: 'takeover-run',
    subjectCoreDigest: digest('d'),
    runnerRevision: 'runner-performance-v1',
    workItems: [
      workItem('takeover-performance', 'performance:lighthouse', 'performance', 'candidate-desktop-chromium'),
      workItem('takeover-ordinary', 'browser:chromium', 'ordinary', 'candidate-desktop-chromium'),
    ],
  });
  const coordinatorA = await acquireStoreCoordinator(takeoverStore, { ownerId: 'coordinator-before-takeover', leaseMs: 5_000 });
  await requestPerformanceDrain(takeoverStore, 'takeover-run', coordinatorA, {
    workerId: 'worker-before-takeover', leaseMs: 30_000,
  });
  await claimWorkItem(takeoverStore, 'takeover-run', coordinatorA, {
    workerId: 'worker-before-takeover', capabilities: ['performance:lighthouse'],
    resourceClasses: ['performance'], leaseMs: 30_000,
  });
  now += 5_001;
  const coordinatorB = await acquireStoreCoordinator(takeoverStore, { ownerId: 'coordinator-after-takeover', leaseMs: 5_000 });
  assert.equal(await requeueExpiredWork(takeoverStore, 'takeover-run', coordinatorB), 1,
    'coordinator takeover must immediately fence old-epoch work without waiting for its wall-clock lease');
  const takeoverState = await readParentRun(takeoverStore, 'takeover-run');
  assert.equal(takeoverState.workItems['takeover-performance'].attempts[0].reason, 'coordinator-epoch-fenced');
  assert.equal((await readStorePerformanceScheduler(takeoverStore)).phase, 'idle');
  const postTakeoverOrdinary = await claimWorkItem(takeoverStore, 'takeover-run', coordinatorB, {
    workerId: 'worker-after-takeover', capabilities: ['browser:chromium'],
    resourceClasses: ['ordinary'], leaseMs: 1_000,
  });
  assert.equal(postTakeoverOrdinary.workItemId, 'takeover-ordinary');
  const postTakeoverInbox = await publishAttemptEvidence(takeoverStore, 'takeover-run', postTakeoverOrdinary, {
    outcome: 'completed_pass', executionDescriptorDigest: null, artifacts: [],
  });
  await adoptAttemptEvidence(takeoverStore, 'takeover-run', coordinatorB, postTakeoverInbox);
  await requestPerformanceDrain(takeoverStore, 'takeover-run', coordinatorB, {
    workerId: 'worker-after-takeover-performance', leaseMs: 30_000,
  });
  await claimWorkItem(takeoverStore, 'takeover-run', coordinatorB, {
    workerId: 'worker-after-takeover-performance', capabilities: ['performance:lighthouse'],
    resourceClasses: ['performance'], leaseMs: 30_000,
  });
  await unlink(path.join(takeoverRoot, 'performance-scheduler.json'));
  await assert.rejects(openParentRunStore({
    root: takeoverRoot,
    deploymentIdentity: 'global-performance-takeover-test',
    volumeIdentity: 'named-volume:global-performance-takeover-test',
    verifyStorage: false,
    clock: () => now,
  }), (error) => error?.code === 'STORE_CORRUPT',
  'a missing global scheduler must never normalize an active performance lease to idle');

  const corruptRoot = path.join(root, 'corrupt-store');
  const corruptStore = await openParentRunStore({
    root: corruptRoot,
    deploymentIdentity: 'global-performance-corrupt-test',
    volumeIdentity: 'named-volume:global-performance-corrupt-test',
    verifyStorage: false,
    clock: () => now,
  });
  await writeFile(path.join(corruptRoot, 'performance-scheduler.json'), '{"phase":"idle"}\n');
  await assert.rejects(readStorePerformanceScheduler(corruptStore), (error) => error?.code === 'STORE_CORRUPT',
    'malformed global scheduler state must fail closed');
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('Shared global performance scheduler self-test passed: cross-run drain, exclusion, recovery, fencing, and ordinary resumption are enforced.\n');
