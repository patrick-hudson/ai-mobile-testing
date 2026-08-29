import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyExecutionFailure,
  runSharedWorkerPool,
} from './lib/shared-worker-pool.mjs';
import { maintainSharedWorkerLease } from './lib/shared-worker-heartbeat.mjs';
import { collectSharedWorkerEvidence } from './lib/shared-worker-evidence.mjs';
import {
  acquireCoordinator,
  adoptAttemptEvidence,
  claimWorkItem,
  createParentRun,
  heartbeatWorkItem,
  adoptWorkHeartbeat,
  openParentRunStore,
  publishAttemptEvidence,
  readParentRun,
  requeueExpiredWork,
  requestPerformanceDrain,
} from './lib/parent-run-store.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const upload = (name, content, mediaType = 'text/plain') => {
  const bytes = Buffer.from(content);
  return {
    name, mediaType, sizeBytes: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    contentBase64: bytes.toString('base64'),
  };
};
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-worker-pool-'));
let now = Date.parse('2026-08-28T21:00:00.000Z');

try {
  const executorEvidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-worker-executor-evidence-'));
  const executorLease = {
    runId: 'executor-run', workItemId: 'executor-work', workerId: 'executor-worker', attempt: 1,
    epoch: 2, token: 'executor-token', subjectCoreDigest: digest('f'), runnerRevision: 'runner-u4',
  };
  const executorResult = (overrides = {}) => ({
    schemaVersion: 1,
    kind: 'shared-worker-result',
    runId: executorLease.runId,
    workItemId: executorLease.workItemId,
    attempt: executorLease.attempt,
    subjectCoreDigest: executorLease.subjectCoreDigest,
    runnerRevision: executorLease.runnerRevision,
    executionDescriptorDigest: null,
    outcome: 'completed_pass',
    reason: null,
    artifacts: [],
    ...overrides,
  });
  await fs.mkdir(path.join(executorEvidenceRoot, 'screens'));
  await fs.writeFile(path.join(executorEvidenceRoot, 'screens', 'home.png'), 'executor-screen');
  await assert.rejects(
    collectSharedWorkerEvidence(executorEvidenceRoot, { code: 0, signal: null }, executorLease),
    /result manifest is required/,
    'zero-exit execution without a result manifest must never pass',
  );
  await fs.writeFile(path.join(executorEvidenceRoot, 'result.json'), JSON.stringify(executorResult({
    artifacts: [{ path: 'screens/home.png', mediaType: 'image/png' }],
  })));
  const collected = await collectSharedWorkerEvidence(executorEvidenceRoot, { code: 0, signal: null }, executorLease);
  assert.equal(collected.artifacts[0].name, 'screens/home.png');
  assert.equal(collected.artifacts[0].contentBase64, Buffer.from('executor-screen').toString('base64'));
  await assert.rejects(
    collectSharedWorkerEvidence(executorEvidenceRoot, { code: null, signal: null }, executorLease),
    /terminated abnormally/,
  );
  await assert.rejects(
    collectSharedWorkerEvidence(executorEvidenceRoot, { code: 2, signal: null }, executorLease),
    /terminated abnormally/,
  );
  await assert.rejects(
    collectSharedWorkerEvidence(executorEvidenceRoot, { code: null, signal: 'SIGKILL' }, executorLease),
    /terminated abnormally/,
  );
  await assert.rejects(
    collectSharedWorkerEvidence(executorEvidenceRoot, { code: 1, signal: null }, executorLease),
    /exit 1 requires a completed product failure/,
    'Playwright finding exit cannot disagree with the identity-bound result outcome',
  );
  await fs.writeFile(path.join(executorEvidenceRoot, 'result.json'), JSON.stringify(executorResult({
    outcome: 'completed_product_failure', reason: 'assertion-failed',
  })));
  assert.deepEqual(await collectSharedWorkerEvidence(executorEvidenceRoot, { code: 1, signal: null }, executorLease), {
    outcome: 'completed_product_failure', reason: 'assertion-failed', executionDescriptorDigest: null, artifacts: [],
  });
  await fs.writeFile(path.join(executorEvidenceRoot, 'result.json'), JSON.stringify(executorResult()));
  assert.deepEqual((await collectSharedWorkerEvidence(executorEvidenceRoot, { code: 0, signal: null }, executorLease)).artifacts, [],
    'files not declared by the executor manifest are never uploaded');
  for (const [field, value] of [
    ['runId', 'another-run'],
    ['workItemId', 'another-work'],
    ['attempt', 2],
    ['subjectCoreDigest', digest('e')],
    ['runnerRevision', 'another-runner'],
  ]) {
    await fs.writeFile(path.join(executorEvidenceRoot, 'result.json'), JSON.stringify(executorResult({ [field]: value })));
    await assert.rejects(
      collectSharedWorkerEvidence(executorEvidenceRoot, { code: 0, signal: null }, executorLease),
      /does not match the active work lease/,
      `executor result ${field} must be bound to the active lease`,
    );
  }
  await fs.writeFile(path.join(executorEvidenceRoot, 'result.json'), JSON.stringify(executorResult({
    artifacts: [{ path: '../another-run/secret.png', mediaType: 'image/png' }],
  })));
  await assert.rejects(collectSharedWorkerEvidence(executorEvidenceRoot, { code: 0, signal: null }, executorLease), /normalized and relative/);
  await fs.rm(executorEvidenceRoot, { recursive: true, force: true });

  const store = await openParentRunStore({
    root,
    deploymentIdentity: 'compose:shared-worker-test',
    volumeIdentity: 'named-volume:shared-worker-test',
    clock: () => now,
  });
  await createParentRun(store, {
    runId: 'capability-run',
    subjectCoreDigest: digest('a'),
    runnerRevision: 'runner-u4',
    workItems: [
      { id: 'chromium-a', maxAttempts: 2, capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'candidate-desktop-chromium', specAffinity: 'tests/navigation.spec.ts' },
      { id: 'firefox-b', maxAttempts: 1, capability: 'browser:firefox', resourceClass: 'ordinary', targetId: 'candidate-desktop-firefox', specAffinity: 'tests/smoke.spec.ts' },
      { id: 'performance-c', maxAttempts: 2, capability: 'performance:lighthouse', resourceClass: 'performance', targetId: 'candidate-desktop-chromium', specAffinity: 'tests/performance.spec.ts' },
    ],
  });
  const coordinator = await acquireCoordinator(store, 'capability-run', { ownerId: 'coordinator-u4', leaseMs: 60_000 });

  const chromium = await claimWorkItem(store, 'capability-run', coordinator, {
    workerId: 'worker-chromium', capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 10_000,
  });
  assert.equal(chromium.workItemId, 'chromium-a');
  assert.equal(chromium.capability, 'browser:chromium');
  assert.equal(chromium.runnerRevision, 'runner-u4');
  const firefox = await claimWorkItem(store, 'capability-run', coordinator, {
    workerId: 'worker-firefox', capabilities: ['browser:firefox'], resourceClasses: ['ordinary'], leaseMs: 10_000,
  });
  assert.equal(firefox.workItemId, 'firefox-b');
  await assert.rejects(
    claimWorkItem(store, 'capability-run', coordinator, {
      workerId: 'worker-edge', capabilities: ['browser:msedge'], resourceClasses: ['ordinary'], leaseMs: 10_000,
    }),
    (error) => error?.code === 'NO_COMPATIBLE_WORK',
  );

  const drain = await requestPerformanceDrain(store, 'capability-run', coordinator, { workerId: 'worker-performance' });
  const revisionAfterDrain = (await readParentRun(store, 'capability-run')).runRevision;
  assert.deepEqual(await requestPerformanceDrain(store, 'capability-run', coordinator, { workerId: 'worker-performance' }), drain);
  assert.equal((await readParentRun(store, 'capability-run')).runRevision, revisionAfterDrain,
    'polling an active same-worker performance drain is revision-neutral');
  await assert.rejects(
    claimWorkItem(store, 'capability-run', coordinator, {
      workerId: 'worker-performance', capabilities: ['performance:lighthouse'], resourceClasses: ['performance'], leaseMs: 10_000,
    }),
    (error) => error?.code === 'PERFORMANCE_DRAIN_PENDING',
  );

  const chromiumInbox = await publishAttemptEvidence(store, 'capability-run', chromium, {
    outcome: 'completed_pass', artifacts: [upload('screens/home.png', 'chromium-home', 'image/png')],
  });
  now += 1;
  assert.deepEqual(await publishAttemptEvidence(store, 'capability-run', chromium, {
    outcome: 'completed_pass', artifacts: [upload('screens/home.png', 'chromium-home', 'image/png')],
  }), chromiumInbox, 'an exact artifact upload retry is idempotent even when wall-clock time advances');
  await adoptAttemptEvidence(store, 'capability-run', coordinator, chromiumInbox);
  const firefoxInbox = await publishAttemptEvidence(store, 'capability-run', firefox, {
    outcome: 'completed_product_failure', artifacts: [upload('logs/failure.txt', 'firefox-failure')],
  });
  await adoptAttemptEvidence(store, 'capability-run', coordinator, firefoxInbox);

  const performance = await claimWorkItem(store, 'capability-run', coordinator, {
    workerId: 'worker-performance', capabilities: ['performance:lighthouse'], resourceClasses: ['performance'], leaseMs: 10_000,
  });
  assert.equal(performance.workItemId, 'performance-c');
  const performanceInbox = await publishAttemptEvidence(store, 'capability-run', performance, {
    outcome: 'completed_pass', artifacts: [upload('performance/lighthouse.json', '{"score":1}', 'application/json')],
  });
  await adoptAttemptEvidence(store, 'capability-run', coordinator, performanceInbox);
  const capabilityState = await readParentRun(store, 'capability-run');
  assert.equal(capabilityState.workItems['firefox-b'].attempts.length, 1, 'product failures stay terminal and receive no retry');
  assert.equal(capabilityState.workItems['chromium-a'].attempts[0].artifacts[0].name, 'screens/home.png');
  assert.deepEqual(capabilityState.workItems['chromium-a'].canonicalResult.evidenceDigests,
    [upload('ignored', 'chromium-home', 'image/png').digest], 'canonical evidence digests are derived from adopted bytes');
  assert.equal(capabilityState.resourceScheduling.exclusiveLease, null);
  assert.equal(capabilityState.resourceScheduling.performanceDrain, null);

  assert.deepEqual(classifyExecutionFailure({ kind: 'assertion_timeout' }), {
    outcome: 'completed_product_failure', reason: 'assertion_timeout', retryable: false,
  });
  assert.deepEqual(classifyExecutionFailure({ kind: 'browser_process_crash', trustedPlatformSignal: false }), {
    outcome: 'completed_product_failure', reason: 'browser_process_crash', retryable: false,
  });
  assert.deepEqual(classifyExecutionFailure({ kind: 'browser_process_crash', trustedPlatformSignal: true }), {
    outcome: 'operational_failure', reason: 'browser_process_crash', retryable: true,
  });

  await createParentRun(store, {
    runId: 'recovery-run', subjectCoreDigest: digest('e'), runnerRevision: 'runner-u4',
    workItems: [
      { id: 'recovery-item', maxAttempts: 2, capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'candidate-desktop-chromium', specAffinity: null },
      { id: 'binding-item', maxAttempts: 1, capability: 'browser:webkit', resourceClass: 'ordinary', targetId: 'candidate-mobile-webkit', specAffinity: 'tests/smoke.spec.ts' },
    ],
  });
  now += 61_000;
  const recoveryCoordinator = await acquireCoordinator(store, 'recovery-run', { ownerId: 'coordinator-u4-recovery', leaseMs: 60_000 });
  let executions = 0;
  const recoverySummary = await runSharedWorkerPool({
    store,
    runId: 'recovery-run',
    coordinator: recoveryCoordinator,
    worker: { id: 'worker-recovery', capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
    leaseMs: 10_000,
    maxClaims: 2,
    execute: async () => {
      executions += 1;
      if (executions === 1) {
        const error = new Error('browser process exited unexpectedly');
        error.executionFailure = { kind: 'browser_process_crash', trustedPlatformSignal: true };
        throw error;
      }
      return { outcome: 'completed_pass', artifacts: [upload('recovery.txt', 'recovered')] };
    },
  });
  assert.equal(recoverySummary.claimed, 2);
  assert.equal(recoverySummary.operationalRetries, 1);
  const recoveryState = await readParentRun(store, 'recovery-run');
  assert.equal(recoveryState.workItems['recovery-item'].state, 'completed_pass');
  assert.deepEqual(recoveryState.workItems['recovery-item'].attempts.map(({ outcome }) => outcome), ['operational_failure', 'completed_pass']);

  const bindingLease = await claimWorkItem(store, 'recovery-run', recoveryCoordinator, {
    workerId: 'worker-binding', capabilities: ['browser:webkit'], resourceClasses: ['ordinary'], leaseMs: 10_000,
  });
  await assert.rejects(
    publishAttemptEvidence(store, 'recovery-run', bindingLease, {
      outcome: 'completed_pass', artifacts: [{ ...upload('evidence.webm', 'video', 'video/webm'), name: '../../another-run/evidence.webm' }],
    }),
    (error) => error?.code === 'STORE_SCHEMA_INVALID',
  );
  const mismatchedInbox = await publishAttemptEvidence(store, 'recovery-run', {
    ...bindingLease, subjectCoreDigest: digest('9'),
  }, { outcome: 'completed_pass', artifacts: [] });
  await assert.rejects(
    adoptAttemptEvidence(store, 'recovery-run', recoveryCoordinator, mismatchedInbox),
    (error) => error?.code === 'WORK_RESULT_BINDING_MISMATCH',
  );

  await createParentRun(store, {
    runId: 'evidence-boundary-run', subjectCoreDigest: digest('6'), runnerRevision: 'runner-u4',
    workItems: Array.from({ length: 8 }, (_, index) => ({
      id: `evidence-${index + 1}`, maxAttempts: 1, capability: 'browser:chromium', resourceClass: 'ordinary',
      targetId: 'candidate-desktop-chromium', specAffinity: null,
    })),
  });
  const leases = [];
  for (let index = 0; index < 8; index += 1) {
    leases.push(await claimWorkItem(store, 'evidence-boundary-run', recoveryCoordinator, {
      workerId: `worker-evidence-${index + 1}`, workItemId: `evidence-${index + 1}`,
      capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 10_000,
    }));
  }
  await assert.rejects(
    publishAttemptEvidence(store, 'evidence-boundary-run', leases[0], {
      outcome: 'completed_pass', artifacts: [upload('../another-run/escape.png', 'escape', 'image/png')],
    }),
    (error) => error?.code === 'STORE_SCHEMA_INVALID',
  );
  await assert.rejects(
    publishAttemptEvidence(store, 'recovery-run', leases[1], { outcome: 'completed_pass', artifacts: [] }),
    (error) => error?.code === 'WORK_RESULT_BINDING_MISMATCH',
  );
  await assert.rejects(
    publishAttemptEvidence(store, 'evidence-boundary-run', leases[2], {
      outcome: 'completed_pass', artifacts: [upload('same.txt', 'one'), upload('same.txt', 'two')],
    }),
    (error) => error?.code === 'STORE_SCHEMA_INVALID',
  );
  await assert.rejects(
    publishAttemptEvidence(store, 'evidence-boundary-run', leases[3], {
      outcome: 'completed_pass', artifacts: [{ ...upload('tampered.txt', 'truth'), digest: digest('0') }],
    }),
    (error) => error?.code === 'ARTIFACT_DIGEST_MISMATCH',
  );
  await assert.rejects(
    publishAttemptEvidence(store, 'evidence-boundary-run', leases[4], {
      outcome: 'completed_pass', artifacts: [{ ...upload('oversize.bin', 'x'), sizeBytes: 8 * 1_048_576 + 1 }],
    }),
    (error) => error?.code === 'STORE_SCHEMA_INVALID',
  );
  await assert.rejects(
    publishAttemptEvidence(store, 'evidence-boundary-run', leases[5], {
      outcome: 'completed_pass', evidenceDigests: [digest('1')], artifacts: [],
    }),
    (error) => error?.code === 'STORE_SCHEMA_INVALID',
  );
  await assert.rejects(
    publishAttemptEvidence(store, 'evidence-boundary-run', leases[6], {
      outcome: 'completed_pass', artifacts: [upload('copy-a.txt', 'copy'), upload('copy-b.txt', 'copy')],
    }),
    (error) => error?.code === 'STORE_SCHEMA_INVALID',
  );
  const tamperInbox = await publishAttemptEvidence(store, 'evidence-boundary-run', leases[7], {
    outcome: 'completed_pass', artifacts: [upload('screens/declared.png', 'original', 'image/png')],
  });
  const tamperDocument = JSON.parse(await fs.readFile(path.join(root, 'runs', 'evidence-boundary-run', tamperInbox.relativePath), 'utf8'));
  await fs.writeFile(path.join(root, 'runs', 'evidence-boundary-run', tamperDocument.artifacts[0].relativePath), 'replaced');
  await assert.rejects(
    adoptAttemptEvidence(store, 'evidence-boundary-run', recoveryCoordinator, tamperInbox),
    (error) => error?.code === 'ARTIFACT_DIGEST_MISMATCH',
  );

  await createParentRun(store, {
    runId: 'maintenance-run', subjectCoreDigest: digest('5'), runnerRevision: 'runner-u4',
    workItems: [{
      id: 'maintenance-performance', maxAttempts: 2, capability: 'performance:lighthouse', resourceClass: 'performance',
      targetId: 'candidate-desktop-chromium', specAffinity: 'tests/performance.spec.ts',
    }],
  });
  await requestPerformanceDrain(store, 'maintenance-run', recoveryCoordinator, { workerId: 'worker-maintenance', leaseMs: 1_000 });
  await claimWorkItem(store, 'maintenance-run', recoveryCoordinator, {
    workerId: 'worker-maintenance', capabilities: ['performance:lighthouse'], resourceClasses: ['performance'], leaseMs: 1_000,
  });
  now += 1_001;
  assert.equal(await requeueExpiredWork(store, 'maintenance-run', recoveryCoordinator), 1);
  const maintenanceState = await readParentRun(store, 'maintenance-run');
  assert.equal(maintenanceState.workItems['maintenance-performance'].state, 'queued');
  assert.equal(maintenanceState.resourceScheduling.exclusiveLease, null);
  assert.equal(maintenanceState.resourceScheduling.performanceDrain, null);
  const maintenanceRevision = maintenanceState.runRevision;
  assert.equal(await requeueExpiredWork(store, 'maintenance-run', recoveryCoordinator), 0);
  assert.equal((await readParentRun(store, 'maintenance-run')).runRevision, maintenanceRevision,
    'idle coordinator maintenance is revision-neutral');

  await createParentRun(store, {
    runId: 'heartbeat-run', subjectCoreDigest: digest('4'), runnerRevision: 'runner-u4',
    workItems: [
      { id: 'long-running-item', maxAttempts: 2, capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'candidate-desktop-chromium', specAffinity: null },
      { id: 'takeover-item', maxAttempts: 2, capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'candidate-desktop-chromium', specAffinity: null },
    ],
  });
  const longLease = await claimWorkItem(store, 'heartbeat-run', recoveryCoordinator, {
    workerId: 'worker-long-running', workItemId: 'long-running-item',
    capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 100,
  });
  let heartbeatCount = 0;
  let heartbeatTurn = 0;
  let finishLongExecution;
  const longExecution = new Promise((resolve) => { finishLongExecution = resolve; });
  const maintained = await maintainSharedWorkerLease({
    lease: longLease,
    intervalMs: 25,
    waitForHeartbeat: async (_intervalMs, signal) => {
      heartbeatTurn += 1;
      if (heartbeatTurn <= 3) return;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    heartbeat: async (lease) => {
      now += 75;
      const receipt = await heartbeatWorkItem(store, 'heartbeat-run', lease, { leaseMs: 100 });
      const renewed = await adoptWorkHeartbeat(store, 'heartbeat-run', recoveryCoordinator, receipt);
      assert.equal(await requeueExpiredWork(store, 'heartbeat-run', recoveryCoordinator), 0,
        'coordinator maintenance must not requeue a heartbeating long-running lease');
      await assert.rejects(
        claimWorkItem(store, 'heartbeat-run', recoveryCoordinator, {
          workerId: 'worker-duplicate', workItemId: 'long-running-item',
          capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 100,
        }),
        (error) => error?.code === 'WORK_ITEM_LEASE_HELD',
        'a heartbeating claim must not be duplicated',
      );
      heartbeatCount += 1;
      if (heartbeatCount === 3) finishLongExecution('executor-finished');
      return renewed;
    },
    execute: async () => longExecution,
  });
  assert.equal(heartbeatCount, 3);
  assert.equal(maintained.value, 'executor-finished');
  assert.equal(maintained.lease.workItemId, 'long-running-item');
  assert.equal((await readParentRun(store, 'heartbeat-run')).workItems['long-running-item'].attempts.length, 0,
    'lease renewal must not create a retry attempt');
  const maintainedInbox = await publishAttemptEvidence(store, 'heartbeat-run', maintained.lease, {
    outcome: 'completed_pass', artifacts: [],
  });
  await adoptAttemptEvidence(store, 'heartbeat-run', recoveryCoordinator, maintainedInbox);

  const takeoverLease = await claimWorkItem(store, 'heartbeat-run', recoveryCoordinator, {
    workerId: 'worker-before-expiry', workItemId: 'takeover-item',
    capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 100,
  });
  const staleHeartbeat = await heartbeatWorkItem(store, 'heartbeat-run', takeoverLease, { leaseMs: 100 });
  now += 101;
  assert.equal(await requeueExpiredWork(store, 'heartbeat-run', recoveryCoordinator), 1);
  const takeover = await claimWorkItem(store, 'heartbeat-run', recoveryCoordinator, {
    workerId: 'worker-after-expiry', workItemId: 'takeover-item',
    capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 100,
  });
  assert.equal(takeover.attempt, 2);
  await assert.rejects(
    adoptWorkHeartbeat(store, 'heartbeat-run', recoveryCoordinator, staleHeartbeat),
    (error) => error?.code === 'STALE_WORK_LEASE',
    'a heartbeat from the expired attempt must be fenced after takeover',
  );
  await assert.rejects(
    heartbeatWorkItem(store, 'heartbeat-run', takeoverLease, { leaseMs: 100 }),
    (error) => error?.code === 'STALE_WORK_LEASE',
  );

  let executorAborted = false;
  const heartbeatRejected = Object.assign(new Error('coordinator rejected stale lease'), { code: 'STALE_WORK_LEASE' });
  await assert.rejects(
    maintainSharedWorkerLease({
      lease: takeover,
      intervalMs: 25,
      waitForHeartbeat: async () => {},
      heartbeat: async () => { throw heartbeatRejected; },
      execute: async ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          executorAborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    }),
    (error) => error?.code === 'SHARED_WORK_LEASE_FENCED' && error?.cause === heartbeatRejected,
    'heartbeat rejection must fence the worker and abort its executor',
  );
  assert.equal(executorAborted, true);

  const oneWorker = await runTopology('one', 1);
  const multipleWorkers = await runTopology('many', 2);
  assert.deepEqual(multipleWorkers, oneWorker,
    'worker topology changes scheduling only, not canonical result identity or evidence membership');

  const [playwrightConfig, compose, sharedCoordinatorSource, sharedWorkerSource, sharedEvidenceSource, sharedDispatcherSource] = await Promise.all([
    fs.readFile(new URL('../playwright.config.ts', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8'),
    fs.readFile(new URL('./run-shared-coordinator.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('./run-shared-worker.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('./lib/shared-worker-evidence.mjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('./lib/shared-work-dispatcher.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(playwrightConfig, /retries:\s*0,/);
  assert.match(compose, /shared-coordinator:/);
  assert.match(compose, /shared-worker-ordinary-a:/);
  assert.match(compose, /shared-worker-ordinary-b:/);
  assert.match(compose, /shared-worker-performance:/);
  const workerABlock = compose.match(/shared-worker-ordinary-a:[\s\S]*?(?=\n  [a-z][a-z0-9-]+:|\nvolumes:)/)?.[0] ?? '';
  const workerBBlock = compose.match(/shared-worker-ordinary-b:[\s\S]*?(?=\n  [a-z][a-z0-9-]+:|\nvolumes:)/)?.[0] ?? '';
  for (const workerBlock of [workerABlock, workerBBlock]) {
    assert.doesNotMatch(workerBlock, /shared-parent-runs:\/var\/lib\/ai-mobile-testing\/shared\/canonical/,
      'ordinary workers must not mount the canonical parent-run store');
    assert.doesNotMatch(workerBlock, /shared-worker-exchange/,
      'ordinary workers publish through the lease-bound coordinator protocol and cannot browse another run inbox');
    assert.doesNotMatch(workerBlock, /docker\.sock/);
    assert.match(workerBlock, /user:\s*pwuser/);
  }
  assert.match(workerABlock, /shared-worker-ordinary-a-secret:/);
  assert.match(workerBBlock, /shared-worker-ordinary-b-secret:/);
  assert.match(workerABlock, /inventory:http,browser:chromium,browser:firefox,browser:webkit/,
    'Ordinary shared workers must claim the Single-site inventory barrier as well as browser work.');
  assert.match(workerBBlock, /inventory:http,browser:chromium,browser:firefox,browser:webkit/,
    'Every interchangeable ordinary worker must advertise the same inventory and browser capabilities.');
  assert.doesNotMatch(workerABlock, /shared-worker-ordinary-b-secret:/,
    'worker A must not mount worker B credentials');
  assert.doesNotMatch(workerBBlock, /shared-worker-ordinary-a-secret:/,
    'worker B must not mount worker A credentials');
  assert.match(sharedDispatcherSource, /AUDIT_SHARED_EVIDENCE_DIR/);
  assert.doesNotMatch(compose, /AUDIT_SHARED_(?:PERFORMANCE_)?EXECUTOR_JSON/,
    'Compose workers must use only the fixed repository-owned dispatcher.');
  assert.doesNotMatch(sharedWorkerSource, /AUDIT_SHARED_EXECUTOR_JSON/);
  assert.match(sharedWorkerSource, /\/v1\/heartbeat/);
  assert.match(sharedCoordinatorSource, /request\.url === '\/v1\/heartbeat'/);
  assert.match(sharedCoordinatorSource, /heartbeatWorkItem\(store, leaseRunId, body\.lease/);
  assert.match(sharedCoordinatorSource, /adoptWorkHeartbeat\(store, leaseRunId, coordinator, receipt\)/,
    'worker heartbeats must remain inbox writes adopted by the sole canonical coordinator');
  assert.match(sharedEvidenceSource, /result\.json/);
  assert.match(sharedEvidenceSource, /contentBase64/);
  assert.doesNotMatch(sharedWorkerSource, /AUDIT_SHARED_STORE_ROOT|shared\/canonical/,
    'workers exchange bounded evidence over HTTP and never learn the canonical store root');

  process.stdout.write('Shared worker pool self-test passed: capability claims, fenced per-item publication and heartbeats, terminal product failures, bounded operational retry, exclusive performance drain, authoritative retry policy, and Compose isolation are enforced.\n');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function runTopology(label, workerCount) {
  const topologyRoot = await fs.mkdtemp(path.join(os.tmpdir(), `shared-worker-topology-${label}-`));
  try {
    const topologyStore = await openParentRunStore({
      root: topologyRoot,
      deploymentIdentity: `compose:topology-${label}`,
      volumeIdentity: `named-volume:topology-${label}`,
      clock: () => Date.parse('2026-08-28T22:00:00.000Z'),
    });
    await createParentRun(topologyStore, {
      runId: 'topology-run', subjectCoreDigest: digest('7'), runnerRevision: 'runner-u4',
      workItems: [
        { id: 'topology-a', maxAttempts: 1, capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'candidate-desktop-chromium', specAffinity: 'tests/navigation.spec.ts' },
        { id: 'topology-b', maxAttempts: 1, capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'candidate-desktop-chromium', specAffinity: 'tests/smoke.spec.ts' },
      ],
    });
    const topologyCoordinator = await acquireCoordinator(topologyStore, 'topology-run', { ownerId: `coordinator-${label}`, leaseMs: 60_000 });
    await Promise.all(Array.from({ length: workerCount }, (_, index) => runSharedWorkerPool({
      store: topologyStore,
      runId: 'topology-run',
      coordinator: topologyCoordinator,
      worker: { id: `worker-${label}-${index + 1}`, capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
      leaseMs: 10_000,
      maxClaims: workerCount === 1 ? 2 : 1,
      execute: async (lease) => ({
        outcome: 'completed_pass',
        artifacts: [upload(`${lease.workItemId}.txt`, lease.workItemId)],
      }),
    })));
    const state = await readParentRun(topologyStore, 'topology-run');
    return Object.values(state.workItems)
      .map(({ id, state: workState, canonicalResult }) => ({ id, state: workState, canonicalResult }))
      .sort((left, right) => left.id.localeCompare(right.id));
  } finally {
    await fs.rm(topologyRoot, { recursive: true, force: true });
  }
}
