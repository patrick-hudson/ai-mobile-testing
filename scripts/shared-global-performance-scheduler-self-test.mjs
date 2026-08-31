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
  claimStoreWorkItem,
  readParentRun,
  readStorePerformanceScheduler,
  rekickIncompleteWork,
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
    ['run-performance', 'c', [workItem('performance-only', 'performance:custom', 'performance', 'candidate-desktop-chromium')]],
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
  const performance = principal('worker-performance', ['performance:custom', 'performance:lighthouse'], 'performance');
  const otherPerformance = principal('worker-performance-other', ['performance:custom', 'performance:lighthouse'], 'performance');

  const ordinaryLease = await supervisor.claim(ordinary);
  assert.equal(ordinaryLease.runId, 'run-active');

  const drain = await supervisor.requestPerformanceDrain(performance);
  assert.equal(drain.runId, 'run-performance');
  assert.equal(drain.workerId, performance.id);
  const drainScheduler = await readStorePerformanceScheduler(store);
  await assert.rejects(
    supervisor.requestPerformanceDrain({ ...performance, runIds: ['run-active'] }),
    (error) => error?.code === 'PERFORMANCE_DRAIN_REQUIRED',
    'same-worker polling must not return a reservation outside the current authorized run set',
  );
  await assert.rejects(
    supervisor.requestPerformanceDrain(principal(performance.id, ['performance:lighthouse'], 'performance')),
    (error) => error?.code === 'WORKER_CAPABILITY_MISMATCH',
    'same-worker polling must not return a reservation its current grant cannot execute',
  );
  assert.equal((await readStorePerformanceScheduler(store)).revision, drainScheduler.revision,
    'rejected same-worker polls must not renew or replace the existing reservation');
  now += 4_000;
  const earlyDrainPoll = await supervisor.requestPerformanceDrain(performance);
  assert.equal(earlyDrainPoll.expiresAt, drain.expiresAt,
    'same-worker polling before the renewal threshold must preserve the existing lease');
  assert.equal((await readStorePerformanceScheduler(store)).revision, drainScheduler.revision,
    'same-worker polling before the renewal threshold must not fsync a scheduler revision');
  now += 2_000;
  const renewedDrain = await supervisor.requestPerformanceDrain(performance);
  assert.equal(renewedDrain.requestedAt, drain.requestedAt,
    'same-worker drain renewal must preserve the original reservation lineage');
  assert.ok(Date.parse(renewedDrain.expiresAt) > Date.parse(drain.expiresAt),
    'same-worker polling must renew the drain lease while ordinary work finishes');
  assert.equal((await readStorePerformanceScheduler(store)).revision, drainScheduler.revision + 1,
    'crossing the renewal threshold must persist exactly one scheduler revision');
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


  // A scheduler instance must not trust its local relevance cache after a
  // second process rekicks a known incomplete run or reserves performance work.
  const externalCacheRoot = path.join(root, 'external-cache-store');
  const cacheStore = await openParentRunStore({
    root: externalCacheRoot,
    deploymentIdentity: 'global-performance-external-cache-test',
    volumeIdentity: 'named-volume:global-performance-external-cache-test',
    verifyStorage: false,
    clock: () => now,
  });
  for (const [runId, suffix, items] of [
    ['cache-ordinary', 'e', [workItem('cache-ordinary-work', 'browser:chromium', 'ordinary', 'candidate')]],
    ['cache-performance', 'f', [workItem('cache-performance-work', 'performance:lighthouse', 'performance', 'candidate')]],
    ['cache-performance-other', '0', [workItem('cache-performance-other-work', 'performance:lighthouse', 'performance', 'candidate')]],
  ]) {
    await createParentRun(cacheStore, {
      runId,
      subjectCoreDigest: digest(suffix),
      runnerRevision: 'runner-performance-cache-v1',
      workItems: items.map((item) => ({ ...item, maxAttempts: 1 })),
    });
  }
  const cacheCoordinator = await acquireStoreCoordinator(cacheStore, {
    ownerId: 'coordinator-external-cache', leaseMs: 60_000,
  });
  const ordinaryCacheLease = await claimWorkItem(cacheStore, 'cache-ordinary', cacheCoordinator, {
    workerId: 'cache-ordinary-first-worker', capabilities: ['browser:chromium'],
    resourceClasses: ['ordinary'], leaseMs: 10_000,
  });
  const ordinaryFailureInbox = await publishAttemptEvidence(cacheStore, 'cache-ordinary', ordinaryCacheLease, {
    outcome: 'operational_failure', reason: 'synthetic exhausted ordinary failure', artifacts: [],
  });
  await adoptAttemptEvidence(cacheStore, 'cache-ordinary', cacheCoordinator, ordinaryFailureInbox);

  await requestPerformanceDrain(cacheStore, 'cache-performance', cacheCoordinator, {
    workerId: 'cache-performance-first-worker', leaseMs: 30_000,
  });
  const performanceCacheLease = await claimWorkItem(cacheStore, 'cache-performance', cacheCoordinator, {
    workerId: 'cache-performance-first-worker', capabilities: ['performance:lighthouse'],
    resourceClasses: ['performance'], leaseMs: 10_000,
  });
  const performanceFailureInbox = await publishAttemptEvidence(cacheStore, 'cache-performance', performanceCacheLease, {
    outcome: 'operational_failure', reason: 'synthetic exhausted performance failure', artifacts: [],
  });
  await adoptAttemptEvidence(cacheStore, 'cache-performance', cacheCoordinator, performanceFailureInbox);

  const externalCacheStore = await openParentRunStore({
    root: externalCacheRoot,
    deploymentIdentity: 'global-performance-external-cache-test',
    volumeIdentity: 'named-volume:global-performance-external-cache-test',
    verifyStorage: false,
    clock: () => now,
  });
  const actor = { id: 'external-rekick-operator', kind: 'service' };
  await rekickIncompleteWork(externalCacheStore, 'cache-ordinary', cacheCoordinator, {
    actor, workItemIds: ['cache-ordinary-work'],
  });
  const externallyRekickedLease = await claimStoreWorkItem(cacheStore, cacheCoordinator, {
    workerId: 'cache-ordinary-rekick-worker', runIds: ['cache-ordinary'],
    capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 10_000,
  });
  assert.equal(externallyRekickedLease.attempt, 2,
    'a global claim must revalidate a requested run that another process rekicked');
  const ordinaryPassInbox = await publishAttemptEvidence(cacheStore, 'cache-ordinary', externallyRekickedLease, {
    outcome: 'completed_pass', artifacts: [],
  });
  await adoptAttemptEvidence(cacheStore, 'cache-ordinary', cacheCoordinator, ordinaryPassInbox);

  await rekickIncompleteWork(externalCacheStore, 'cache-performance', cacheCoordinator, {
    actor, workItemIds: ['cache-performance-work'],
  });
  const externalReservation = await requestPerformanceDrain(
    externalCacheStore,
    'cache-performance',
    cacheCoordinator,
    { workerId: 'cache-performance-rekick-worker', leaseMs: 30_000 },
  );
  await assert.rejects(
    claimStoreWorkItem(cacheStore, cacheCoordinator, {
      workerId: externalReservation.workerId,
      runIds: ['cache-performance-other'],
      capabilities: ['performance:lighthouse'], resourceClasses: ['performance'], leaseMs: 10_000,
    }),
    (error) => error?.code === 'PERFORMANCE_DRAIN_REQUIRED',
    'a claim outside the reservation authorization must be rejected without erasing the reservation',
  );
  const preservedExternalReservation = await readStorePerformanceScheduler(cacheStore);
  assert.equal(preservedExternalReservation.phase, 'draining');
  assert.equal(preservedExternalReservation.reservation.runId, 'cache-performance',
    'scheduler reconciliation must revalidate the externally reserved run even when it is not requested');
  const externallyReservedLease = await claimStoreWorkItem(cacheStore, cacheCoordinator, {
    workerId: externalReservation.workerId,
    runIds: ['cache-performance'],
    capabilities: ['performance:lighthouse'], resourceClasses: ['performance'], leaseMs: 10_000,
  });
  assert.equal(externallyReservedLease.attempt, 2,
    'the original process must claim externally rekicked and reserved performance work');
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
