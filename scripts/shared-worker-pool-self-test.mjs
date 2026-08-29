import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { sealWorkItemEvidenceMember } from '../shared/work-item-evidence-index.mjs';
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
  createAttemptEvidenceUploadIntent,
  createParentRun,
  finalizeAttemptEvidenceUpload,
  heartbeatWorkItem,
  MAX_ATTEMPT_ARTIFACT_BYTES,
  adoptWorkHeartbeat,
  listAdoptedAttemptArtifacts,
  openAdoptedAttemptArtifact,
  openParentRunStore,
  publishAttemptEvidence,
  purgeParentRunEvidence,
  readParentRun,
  requeueExpiredWork,
  requestPerformanceDrain,
  tombstoneParentRunAuthority,
  uploadAttemptEvidenceArtifact,
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
  assert.equal(await fs.readFile(collected.artifacts[0].sourcePath, 'utf8'), 'executor-screen');
  assert.equal('contentBase64' in collected.artifacts[0], false, 'worker evidence remains file-backed instead of base64-buffered');
  await fs.writeFile(path.join(executorEvidenceRoot, 'screens', 'home-copy.png'), 'executor-screen');
  await fs.writeFile(path.join(executorEvidenceRoot, 'result.json'), JSON.stringify(executorResult({
    artifacts: [
      { path: 'screens/home.png', mediaType: 'image/png' },
      { path: 'screens/home-copy.png', mediaType: 'image/png' },
    ],
  })));
  const repeatedBytes = await collectSharedWorkerEvidence(executorEvidenceRoot, { code: 0, signal: null }, executorLease);
  assert.equal(repeatedBytes.artifacts.length, 2);
  assert.equal(repeatedBytes.artifacts[0].digest, repeatedBytes.artifacts[1].digest,
    'distinct logical artifacts may legitimately contain identical bytes');
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
    outcome: 'completed_product_failure', artifacts: [
      upload('logs/failure.txt', 'firefox-failure'),
      upload('Logs/stdout.txt', 'firefox-uppercase-log'),
      upload('evidence/worker.LOG', 'firefox-suffix-log'),
    ],
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
    capabilityState.workItems['chromium-a'].attempts[0].artifacts.map(({ memberDigest }) => memberDigest),
    'canonical evidence membership is derived from ordered logical members');
  assert.equal(capabilityState.workItems['chromium-a'].attempts[0].artifacts[0].digest,
    upload('ignored', 'chromium-home', 'image/png').digest, 'content integrity retains its independent byte digest');
  assert.equal(capabilityState.resourceScheduling.exclusiveLease, null);
  assert.equal(capabilityState.resourceScheduling.performanceDrain, null);
  const firstArtifactPage = await listAdoptedAttemptArtifacts(store, 'capability-run', { offset: 0, limit: 1 });
  const secondArtifactPage = await listAdoptedAttemptArtifacts(store, 'capability-run', { offset: 1, limit: 1 });
  assert.deepEqual(firstArtifactPage.files.map(({ workItemId, name }) => [workItemId, name]), [
    ['chromium-a', 'screens/home.png'],
  ], 'canonical artifact paging is deterministic by work item and adopted member order');
  assert.deepEqual(secondArtifactPage.files.map(({ workItemId, name }) => [workItemId, name]), [
    ['performance-c', 'performance/lighthouse.json'],
  ]);
  assert.equal(firstArtifactPage.total, 2, 'raw execution logs remain available only through the bounded redacting log API');
  assert.equal(firstArtifactPage.totalComplete, false);
  assert.equal(secondArtifactPage.totalComplete, true);
  assert.equal(firstArtifactPage.hasMore, true);
  assert.equal(secondArtifactPage.hasMore, false);
  assert.equal(firstArtifactPage.files.some((artifact) => 'relativePath' in artifact || 'leaseToken' in artifact), false,
    'public descriptors never disclose canonical store paths or lease tokens');
  const firefoxAttempt = capabilityState.workItems['firefox-b'].attempts[0];
  for (let index = 0; index < firefoxAttempt.artifacts.length; index += 1) {
    const logArtifact = firefoxAttempt.artifacts[index];
    const logArtifactKey = canonicalDigest({
      schemaVersion: 1,
      kind: 'adopted-artifact-access-key',
      workItemId: 'firefox-b',
      canonicalResultDigest: capabilityState.workItems['firefox-b'].canonicalResult.digest,
      attempt: firefoxAttempt.attempt,
      ordinal: index + 1,
      name: logArtifact.name,
      contentDigest: logArtifact.digest,
      memberDigest: logArtifact.memberDigest,
    });
    await assert.rejects(
      openAdoptedAttemptArtifact(store, 'capability-run', {
        workItemId: 'firefox-b', artifactKey: logArtifactKey,
      }),
      (error) => error?.code === 'ATTEMPT_ARTIFACT_UNAVAILABLE',
      `${logArtifact.name} must be denied even when its canonical access key is known`,
    );
  }
  const chromiumArtifact = capabilityState.workItems['chromium-a'].attempts[0].artifacts[0];
  const chromiumArtifactKey = firstArtifactPage.files[0].artifactKey;
  const openedChromium = await openAdoptedAttemptArtifact(store, 'capability-run', {
    workItemId: 'chromium-a', artifactKey: chromiumArtifactKey,
  });
  assert.equal(await openedChromium.opened.handle.readFile('utf8'), 'chromium-home');
  await openedChromium.opened.handle.close();
  await openedChromium.opened.transferLease.release();
  const chromiumArtifactPath = path.join(root, 'runs', 'capability-run', chromiumArtifact.relativePath);
  await fs.writeFile(chromiumArtifactPath, Buffer.alloc(chromiumArtifact.sizeBytes, 0x78));
  await assert.rejects(
    openAdoptedAttemptArtifact(store, 'capability-run', {
      workItemId: 'chromium-a', artifactKey: chromiumArtifactKey,
    }),
    (error) => error?.code === 'ARTIFACT_DIGEST_MISMATCH',
    'post-adoption same-size tampering must fail before a descriptor can stream bytes',
  );

  await createParentRun(store, {
    runId: 'purge-read-run', subjectCoreDigest: digest('b'), runnerRevision: 'runner-u4',
    workItems: [{
      id: 'purge-read-item', maxAttempts: 1, capability: 'browser:chromium', resourceClass: 'ordinary',
      targetId: 'candidate-desktop-chromium', specAffinity: null,
    }],
  });
  const purgeReadLease = await claimWorkItem(store, 'purge-read-run', coordinator, {
    workerId: 'worker-purge-read', capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 10_000,
  });
  const purgeReadInbox = await publishAttemptEvidence(store, 'purge-read-run', purgeReadLease, {
    outcome: 'completed_pass', artifacts: [upload('screens/purge.png', 'purge-reader', 'image/png')],
  });
  await adoptAttemptEvidence(store, 'purge-read-run', coordinator, purgeReadInbox);
  const purgeReadDescriptor = (await listAdoptedAttemptArtifacts(store, 'purge-read-run')).files[0];
  const openDuringPurge = await openAdoptedAttemptArtifact(store, 'purge-read-run', {
    workItemId: purgeReadDescriptor.workItemId, artifactKey: purgeReadDescriptor.artifactKey,
  });
  await tombstoneParentRunAuthority(store, 'purge-read-run', coordinator, {
    actor: { id: 'operator-purge-proof', kind: 'human' }, reason: 'Prove shared artifact transfer drain.',
  });
  let purgeSettled = false;
  const drainingPurge = purgeParentRunEvidence(store, 'purge-read-run').then((value) => {
    purgeSettled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(purgeSettled, false, 'shared purge waits for an already-open canonical artifact transfer');
  await createParentRun(store, {
    runId: 'purge-unrelated-run', subjectCoreDigest: digest('c'), runnerRevision: 'runner-u4',
    workItems: [{
      id: 'unrelated-item', maxAttempts: 1, capability: 'browser:chromium', resourceClass: 'ordinary',
      targetId: 'candidate-desktop-chromium', specAffinity: null,
    }],
  });
  assert.equal((await readParentRun(store, 'purge-unrelated-run')).status, 'active',
    'reader draining never holds the store-wide lock needed by an unrelated run');
  await openDuringPurge.opened.handle.close();
  await openDuringPurge.opened.transferLease.release();
  await drainingPurge;
  await assert.rejects(
    listAdoptedAttemptArtifacts(store, 'purge-read-run'),
    (error) => error?.code === 'RELEASE_AUTHORITY_TOMBSTONED',
    'tombstoning makes new canonical artifact lists unavailable before bytes are deleted',
  );

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
    workItems: Array.from({ length: 9 }, (_, index) => ({
      id: `evidence-${index + 1}`, maxAttempts: 1, capability: 'browser:chromium', resourceClass: 'ordinary',
      targetId: 'candidate-desktop-chromium', specAffinity: null,
    })),
  });
  const leases = [];
  for (let index = 0; index < 9; index += 1) {
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
      outcome: 'completed_pass', artifacts: [{ ...upload('oversize.bin', 'x'), sizeBytes: MAX_ATTEMPT_ARTIFACT_BYTES + 1 }],
    }),
    (error) => error?.code === 'STORE_SCHEMA_INVALID',
  );
  await assert.rejects(
    publishAttemptEvidence(store, 'evidence-boundary-run', leases[5], {
      outcome: 'completed_pass', evidenceDigests: [digest('1')], artifacts: [],
    }),
    (error) => error?.code === 'STORE_SCHEMA_INVALID',
  );
  const repeatedContentInbox = await publishAttemptEvidence(store, 'evidence-boundary-run', leases[6], {
    outcome: 'completed_pass', artifacts: [upload('copy-a.txt', 'copy'), upload('copy-b.txt', 'copy')],
  });
  await adoptAttemptEvidence(store, 'evidence-boundary-run', recoveryCoordinator, repeatedContentInbox);
  const repeatedContentState = await readParentRun(store, 'evidence-boundary-run');
  const repeatedArtifacts = repeatedContentState.workItems['evidence-7'].attempts[0].artifacts;
  assert.equal(repeatedArtifacts[0].digest, repeatedArtifacts[1].digest, 'same bytes retain the same content digest');
  assert.notEqual(repeatedArtifacts[0].memberDigest, repeatedArtifacts[1].memberDigest,
    'distinct logical names retain distinct canonical evidence membership');
  assert.deepEqual(repeatedContentState.workItems['evidence-7'].canonicalResult.evidenceDigests,
    repeatedArtifacts.map(({ memberDigest }) => memberDigest));
  const tamperInbox = await publishAttemptEvidence(store, 'evidence-boundary-run', leases[7], {
    outcome: 'completed_pass', artifacts: [upload('screens/declared.png', 'original', 'image/png')],
  });
  const tamperDocument = JSON.parse(await fs.readFile(path.join(root, 'runs', 'evidence-boundary-run', tamperInbox.relativePath), 'utf8'));
  await fs.writeFile(path.join(root, 'runs', 'evidence-boundary-run', tamperDocument.artifacts[0].relativePath), 'replaced');
  await assert.rejects(
    adoptAttemptEvidence(store, 'evidence-boundary-run', recoveryCoordinator, tamperInbox),
    (error) => error?.code === 'ARTIFACT_DIGEST_MISMATCH',
  );
  const legacyInbox = await publishAttemptEvidence(store, 'evidence-boundary-run', leases[8], {
    outcome: 'completed_pass', artifacts: [upload('legacy/result.json', '{"ok":true}', 'application/json')],
  });
  const legacyInboxPath = path.join(root, 'runs', 'evidence-boundary-run', legacyInbox.relativePath);
  const legacyDocument = JSON.parse(await fs.readFile(legacyInboxPath, 'utf8'));
  legacyDocument.evidenceDigests = legacyDocument.artifacts.map(({ digest: contentDigest }) => contentDigest);
  legacyDocument.artifacts = legacyDocument.artifacts.map(({
    name, mediaType, sizeBytes, digest: contentDigest, relativePath,
  }) => ({ name, mediaType, sizeBytes, digest: contentDigest, relativePath }));
  delete legacyDocument.digest;
  legacyDocument.digest = canonicalDigest(legacyDocument);
  await fs.writeFile(legacyInboxPath, `${JSON.stringify(legacyDocument)}\n`);
  await adoptAttemptEvidence(store, 'evidence-boundary-run', recoveryCoordinator, {
    ...legacyInbox,
    digest: legacyDocument.digest,
  });
  const legacyState = await readParentRun(store, 'evidence-boundary-run');
  assert.equal(legacyState.workItems['evidence-9'].canonicalResult.evidenceDigests[0],
    legacyState.workItems['evidence-9'].attempts[0].artifacts[0].digest,
    'legacy durable inbox records remain adoptable with their original content-digest identity');
  const boundaryArtifacts = await listAdoptedAttemptArtifacts(store, 'evidence-boundary-run');
  assert.deepEqual(boundaryArtifacts.files.map(({ workItemId }) => workItemId), ['evidence-7', 'evidence-7', 'evidence-9'],
    'artifact reads expose adopted canonical attempts only and never an unadopted or running attempt');
  const legacyArtifactDescriptor = boundaryArtifacts.files.find(({ workItemId }) => workItemId === 'evidence-9');
  const openedLegacyArtifact = await openAdoptedAttemptArtifact(store, 'evidence-boundary-run', {
    workItemId: 'evidence-9', artifactKey: legacyArtifactDescriptor.artifactKey,
  });
  assert.deepEqual(JSON.parse(await openedLegacyArtifact.opened.handle.readFile('utf8')), { ok: true },
    'a legacy-format adopted row opens through its unique advertised artifact key');
  await openedLegacyArtifact.opened.handle.close();
  await openedLegacyArtifact.opened.transferLease.release();

  await createParentRun(store, {
    runId: 'streaming-evidence-run', subjectCoreDigest: digest('4'), runnerRevision: 'runner-u4',
    workItems: [
      { id: 'stream-ok', maxAttempts: 2, capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'candidate-desktop-chromium', specAffinity: null },
      { id: 'stream-restart', maxAttempts: 2, capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'candidate-desktop-chromium', specAffinity: null },
      { id: 'stream-orphan', maxAttempts: 2, capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'candidate-desktop-chromium', specAffinity: null },
    ],
  });
  const streamingLeases = [];
  for (const workItemId of ['stream-ok', 'stream-restart', 'stream-orphan']) {
    streamingLeases.push(await claimWorkItem(store, 'streaming-evidence-run', recoveryCoordinator, {
      workerId: `worker-${workItemId}`, workItemId,
      capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 10_000,
    }));
  }
  const streamFixture = (lease, name, content) => {
    const bytes = Buffer.from(content);
    const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const member = sealWorkItemEvidenceMember({
      workItemId: lease.workItemId,
      executionDescriptorDigest: lease.executionDescriptorDigest ?? lease.subjectCoreDigest,
      ordinal: 1,
      logicalName: name,
      purpose: 'primary',
      mediaType: 'video/webm',
      sizeBytes: bytes.length,
      contentDigest,
      transportPath: name,
    });
    return {
      bytes,
      artifact: {
        name, mediaType: member.mediaType, sizeBytes: member.sizeBytes, digest: member.contentDigest,
        logicalName: member.logicalName, purpose: member.purpose, memberDigest: member.memberDigest,
      },
    };
  };
  const byteChunks = async function* (bytes) {
    const split = Math.max(1, Math.floor(bytes.length / 2));
    yield bytes.subarray(0, split);
    yield bytes.subarray(split);
  };
  const okFixture = streamFixture(streamingLeases[0], 'video/action.webm', 'streamed-video-evidence');
  const okResult = { outcome: 'completed_pass', reason: null, executionDescriptorDigest: null, artifacts: [okFixture.artifact] };
  const okIntent = await createAttemptEvidenceUploadIntent(store, 'streaming-evidence-run', streamingLeases[0], okResult);
  const replayedIntent = await createAttemptEvidenceUploadIntent(store, 'streaming-evidence-run', streamingLeases[0], okResult);
  assert.equal(replayedIntent.intentDigest, okIntent.intentDigest, 'exact intent replay is idempotent');
  const okBinding = {
    workItemId: streamingLeases[0].workItemId, workerId: streamingLeases[0].workerId,
    attempt: streamingLeases[0].attempt, leaseToken: streamingLeases[0].token,
    intentDigest: okIntent.intentDigest, ordinal: 1,
    contentLength: okFixture.bytes.length, mediaType: okFixture.artifact.mediaType,
  };
  const firstUpload = await uploadAttemptEvidenceArtifact(store, 'streaming-evidence-run', okBinding, byteChunks(okFixture.bytes));
  const replayedUpload = await uploadAttemptEvidenceArtifact(store, 'streaming-evidence-run', okBinding, byteChunks(okFixture.bytes));
  assert.deepEqual(replayedUpload, firstUpload, 'exact streamed blob replay is idempotent');
  await assert.rejects(
    uploadAttemptEvidenceArtifact(store, 'streaming-evidence-run', okBinding, byteChunks(Buffer.from('conflicting-video-bytes'))),
    (error) => error?.code === 'ARTIFACT_DIGEST_MISMATCH',
  );
  const okFinalizeBinding = {
    workItemId: okBinding.workItemId, workerId: okBinding.workerId, attempt: okBinding.attempt,
    leaseToken: okBinding.leaseToken, intentDigest: okBinding.intentDigest,
  };
  const okInbox = await finalizeAttemptEvidenceUpload(store, 'streaming-evidence-run', okFinalizeBinding);
  const adoptedStreaming = await adoptAttemptEvidence(store, 'streaming-evidence-run', recoveryCoordinator, okInbox);
  assert.equal(adoptedStreaming.state, 'completed_pass');
  const replayedInbox = await finalizeAttemptEvidenceUpload(store, 'streaming-evidence-run', okFinalizeBinding);
  assert.equal(replayedInbox.digest, okInbox.digest, 'finalization replay retains the immutable inbox');
  assert.equal((await adoptAttemptEvidence(store, 'streaming-evidence-run', recoveryCoordinator, replayedInbox)).state,
    'completed_pass', 'adoption replay succeeds after the lease has been cleared');

  const restartFixture = streamFixture(streamingLeases[1], 'trace/restart.webm', 'restartable-stream-evidence');
  const restartIntent = await createAttemptEvidenceUploadIntent(store, 'streaming-evidence-run', streamingLeases[1], {
    outcome: 'completed_pass', reason: null, executionDescriptorDigest: null, artifacts: [restartFixture.artifact],
  });
  const restartBinding = {
    workItemId: streamingLeases[1].workItemId, workerId: streamingLeases[1].workerId,
    attempt: streamingLeases[1].attempt, leaseToken: streamingLeases[1].token,
    intentDigest: restartIntent.intentDigest, ordinal: 1,
    contentLength: restartFixture.bytes.length, mediaType: restartFixture.artifact.mediaType,
  };
  const interrupted = async function* () {
    yield restartFixture.bytes.subarray(0, 4);
    throw new Error('simulated connection loss');
  };
  await assert.rejects(
    uploadAttemptEvidenceArtifact(store, 'streaming-evidence-run', restartBinding, interrupted()),
    /simulated connection loss/,
  );
  await assert.rejects(
    finalizeAttemptEvidenceUpload(store, 'streaming-evidence-run', restartBinding),
    (error) => error?.code === 'ATTEMPT_ARTIFACT_UNAVAILABLE',
    'partial uploads cannot finalize or mutate canonical truth',
  );
  await uploadAttemptEvidenceArtifact(store, 'streaming-evidence-run', restartBinding, byteChunks(restartFixture.bytes));
  const restartInbox = await finalizeAttemptEvidenceUpload(store, 'streaming-evidence-run', restartBinding);
  assert.equal((await adoptAttemptEvidence(store, 'streaming-evidence-run', recoveryCoordinator, restartInbox)).state,
    'completed_pass', 'an interrupted upload can resume from its immutable intent without rerunning work');

  const orphanFixture = streamFixture(streamingLeases[2], 'video/orphan.webm', 'orphaned-stream-evidence');
  const orphanIntent = await createAttemptEvidenceUploadIntent(store, 'streaming-evidence-run', streamingLeases[2], {
    outcome: 'completed_pass', reason: null, executionDescriptorDigest: null, artifacts: [orphanFixture.artifact],
  });
  const orphanBinding = {
    workItemId: streamingLeases[2].workItemId, workerId: streamingLeases[2].workerId,
    attempt: streamingLeases[2].attempt, leaseToken: streamingLeases[2].token,
    intentDigest: orphanIntent.intentDigest, ordinal: 1,
    contentLength: orphanFixture.bytes.length, mediaType: orphanFixture.artifact.mediaType,
  };
  await uploadAttemptEvidenceArtifact(store, 'streaming-evidence-run', orphanBinding, byteChunks(orphanFixture.bytes));
  const orphanKey = `${String(streamingLeases[2].attempt).padStart(6, '0')}-${streamingLeases[2].token}`;
  const orphanEvidenceDirectory = path.join(root, 'runs', 'streaming-evidence-run', 'evidence', 'stream-orphan', orphanKey);
  const orphanIntentDirectory = path.join(root, 'runs', 'streaming-evidence-run', 'inboxes', 'stream-orphan', 'uploads', orphanKey);
  await fs.writeFile(path.join(orphanEvidenceDirectory, '.connection-crash.upload'), 'partial-upload-temp');

  now += 10_001;
  await requeueExpiredWork(store, 'recovery-run', recoveryCoordinator);
  await requeueExpiredWork(store, 'evidence-boundary-run', recoveryCoordinator);
  assert.equal(await requeueExpiredWork(store, 'streaming-evidence-run', recoveryCoordinator), 1);
  await assert.rejects(fs.lstat(orphanEvidenceDirectory), (error) => error?.code === 'ENOENT');
  await assert.rejects(fs.lstat(orphanIntentDirectory), (error) => error?.code === 'ENOENT');
  await assert.rejects(
    fs.lstat(path.join(root, 'runs', 'streaming-evidence-run', 'quarantine', 'orphan-attempts')),
    (error) => error?.code === 'ENOENT',
    'stale attempt blobs, intents, and crash temporaries are deleted outside the mutation lock',
  );
  await assert.rejects(
    finalizeAttemptEvidenceUpload(store, 'streaming-evidence-run', orphanBinding),
    (error) => error?.code === 'ATOMIC_NOT_FOUND',
    'an expired fully uploaded attempt cannot finalize after its evidence is quarantined',
  );
  const orphanRetryLease = await claimWorkItem(store, 'streaming-evidence-run', recoveryCoordinator, {
    workerId: 'worker-stream-orphan-retry', workItemId: 'stream-orphan',
    capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 10_000,
  });
  assert.equal(orphanRetryLease.attempt, 2);
  const postTakeoverState = await readParentRun(store, 'streaming-evidence-run');
  assert.equal(postTakeoverState.workItems['stream-orphan'].canonicalResult, null);
  assert.equal(postTakeoverState.workItems['stream-orphan'].attempts[0].outcome, 'operational_failure');
  const adoptedEvidencePath = postTakeoverState.workItems['stream-ok'].attempts[0].artifacts[0].relativePath;
  assert.equal((await fs.lstat(path.join(root, 'runs', 'streaming-evidence-run', adoptedEvidencePath))).isFile(), true,
    'orphan cleanup must retain adopted evidence from completed work items');
  const retryInbox = await publishAttemptEvidence(store, 'streaming-evidence-run', orphanRetryLease, {
    outcome: 'completed_pass', artifacts: [],
  });
  await adoptAttemptEvidence(store, 'streaming-evidence-run', recoveryCoordinator, retryInbox);

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
  assert.match(compose, /shared-resilience-driver:/);
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
  assert.match(workerABlock, /cpus:.*AUDIT_SHARED_ORDINARY_CPUS/);
  assert.match(workerABlock, /mem_limit:.*AUDIT_SHARED_ORDINARY_MEMORY/);
  assert.match(workerABlock, /AUDIT_SHARED_POLL_MS/);
  assert.match(workerABlock, /AUDIT_SHARED_RESILIENCE_PROOF/);
  assert.match(workerBBlock, /cpus:.*AUDIT_SHARED_ORDINARY_CPUS/);
  assert.match(workerBBlock, /mem_limit:.*AUDIT_SHARED_ORDINARY_MEMORY/);
  const proofDriverBlock = compose.match(/shared-resilience-driver:[\s\S]*?(?=\n  [a-z][a-z0-9-]+:|\nvolumes:)/)?.[0] ?? '';
  assert.match(proofDriverBlock, /profiles: \[shared-proof\]/);
  assert.match(proofDriverBlock, /shared-parent-runs:/);
  assert.doesNotMatch(proofDriverBlock, /shared-control-identities|shared-worker-exchange|docker\.sock|PORTAL_SECRET|TOKEN_FILE/,
    'the proof driver may read the isolated canonical volume but must not receive control credentials, exchange storage, or host control');
  assert.match(sharedDispatcherSource, /AUDIT_SHARED_EVIDENCE_DIR/);
  assert.doesNotMatch(compose, /AUDIT_SHARED_(?:PERFORMANCE_)?EXECUTOR_JSON/,
    'Compose workers must use only the fixed repository-owned dispatcher.');
  assert.doesNotMatch(sharedWorkerSource, /AUDIT_SHARED_EXECUTOR_JSON/);
  assert.match(sharedWorkerSource, /\/v1\/heartbeat/);
  assert.match(sharedCoordinatorSource, /requestUrl\.pathname === '\/v1\/heartbeat'/);
  assert.match(sharedCoordinatorSource, /heartbeatWorkItem\(store, leaseRunId, body\.lease/);
  assert.match(sharedCoordinatorSource, /adoptWorkHeartbeat\(store, leaseRunId, coordinator, receipt\)/,
    'worker heartbeats must remain inbox writes adopted by the sole canonical coordinator');
  assert.match(sharedEvidenceSource, /result\.json/);
  assert.doesNotMatch(sharedEvidenceSource, /contentBase64|\.readFile\(\)/,
    'worker evidence remains file-backed and never enters the JSON metadata transport');
  assert.match(sharedWorkerSource, /method: 'PUT'/);
  assert.match(sharedWorkerSource, /duplex: 'half'/);
  assert.match(sharedWorkerSource, /\/v1\/result-intent/);
  assert.match(sharedWorkerSource, /\/v1\/result-finalize/);
  assert.match(sharedWorkerSource, /evidence-artifact-upload-started/);
  assert.match(sharedWorkerSource, /evidence-artifact-upload-completed/);
  assert.match(sharedWorkerSource, /responseStatus/,
    'operator logs must expose streaming request progress and coordinator response status');
  assert.match(sharedWorkerSource, /abortSignal, uploadTimeoutMs/,
    'large finalize hashing must use the evidence-upload timeout rather than the metadata timeout');
  assert.match(sharedCoordinatorSource, /server\.requestTimeout = uploadTimeoutMs \+ 30_000/,
    'coordinator request lifetime must exceed the worker large-upload timeout');
  assert.doesNotMatch(sharedCoordinatorSource, /\/v1\/result'|publishAttemptEvidence/,
    'the production coordinator must not retain the base64 JSON result endpoint');
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
