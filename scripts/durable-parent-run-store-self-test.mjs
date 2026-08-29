import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acceptOperation,
  acquireCoordinator,
  appendAttemptLog,
  adoptWorkHeartbeat,
  adoptAttemptEvidence,
  appendRiskLifecycleEvent,
  cancelParentRun,
  claimWorkItem,
  completeOperation,
  createParentRun,
  getOperation,
  heartbeatCoordinator,
  heartbeatWorkItem,
  openParentRunStore,
  publishAttemptEvidence,
  publishCurrentEnvelope,
  readCurrentEnvelope,
  readParentRun,
  readRunHistories,
  recoverParentRun,
  requeueExpiredWork,
  sealParentRunGraph,
  takeOverCoordinator,
} from './lib/parent-run-store.mjs';
import { readLegacyRun } from './lib/legacy-run-adapter.mjs';
import { loadSharedReleasePublication } from '../portal/report-publication.mjs';
import { appendPublicationEnvelope } from '../shared/publication-envelope.mjs';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { sealExecutionManifest } from '../shared/execution-contract.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { atomicWriteJson, openAtomicStorage, withDirectoryLock } from './lib/atomic-filesystem.mjs';

const DIGEST = canonicalDigest({ fixture: 'durable-parent-run' });
const root = await mkdtemp(join(tmpdir(), 'durable-parent-run-'));
let now = Date.parse('2026-08-28T12:00:00.000Z');
const clock = () => now;

const openRaceRoot = await mkdtemp(join(tmpdir(), 'durable-store-open-race-'));
const openRace = await Promise.allSettled([
  openParentRunStore({
    root: openRaceRoot, deploymentIdentity: 'compose-project:race', volumeIdentity: 'named-volume:race-a',
    volumeDriver: 'local', clock, verifyStorage: false,
  }),
  openParentRunStore({
    root: openRaceRoot, deploymentIdentity: 'compose-project:race', volumeIdentity: 'named-volume:race-b',
    volumeDriver: 'local', clock, verifyStorage: false,
  }),
]);
assert.equal(openRace.filter(({ status }) => status === 'fulfilled').length, 1);
assert.equal(openRace.filter(({ status, reason }) => status === 'rejected' && reason.code === 'STORE_IDENTITY_MISMATCH').length, 1);
await rm(openRaceRoot, { recursive: true, force: true });

const atomicStorage = await openAtomicStorage({ root, verify: false });
const exclusiveTarget = join(root, 'exclusive-winner.json');
const exclusiveRace = await Promise.allSettled([
  atomicWriteJson(atomicStorage, exclusiveTarget, { winner: 'a' }, { exclusive: true }),
  atomicWriteJson(atomicStorage, exclusiveTarget, { winner: 'b' }, { exclusive: true }),
]);
assert.equal(exclusiveRace.filter(({ status }) => status === 'fulfilled').length, 1);
assert.equal(exclusiveRace.filter(({ status, reason }) => status === 'rejected' && reason.code === 'ATOMIC_ALREADY_EXISTS').length, 1);

function expectCode(code, operation) {
  return assert.rejects(operation, (error) => error?.code === code);
}

function operationRequest(key = 'launch-1') {
  return {
    idempotencyKey: key,
    kind: 'launch',
    actor: { id: 'operator-1', kind: 'user' },
    body: { requestedAuthority: 'FULL' },
  };
}

function envelope(runRevision, previous = null, ledgerSequences = { observations: 0, decisions: 1, risks: 0 }) {
  const decision = {
    schemaVersion: 1,
    kind: 'release-decision',
    runId: 'run-main',
    decisionRevision: 1,
    code: 'NOT_READY_INCOMPLETE_EXECUTION',
    label: 'NOT READY — INCOMPLETE EXECUTION',
    ready: false,
    exitCode: 1,
    executionManifestDigest: DIGEST,
    mode: 'single-site',
    grantedAuthority: 'FULL',
    certifiedScope: {
      features: ['site'], definitions: ['HOME-001'], targets: ['desktop'], knownLimits: [],
    },
    coverageBasis: {
      selectedDefinitions: ['HOME-001'], selectedTargets: ['desktop'], excludedAsNotApplicable: [],
    },
    subjectDigest: DIGEST,
    blockingReasons: [{ class: 'incomplete-execution', executionId: 'work-a', detail: 'Execution is incomplete.' }],
    superseded: false,
  };
  decision.digest = canonicalDigest(decision);
  return appendPublicationEnvelope(previous, {
    schemaVersion: 1,
    runId: 'run-main',
    runRevision,
    decisionRevision: 1,
    riskRevision: 1,
    ledgerSequences,
    finalSubjectDigest: DIGEST,
    decision,
    riskRegister: { schemaVersion: 1, availability: 'EMPTY', risks: [] },
  });
}

const store = await openParentRunStore({
  root,
  deploymentIdentity: 'compose-project:test',
  volumeIdentity: 'named-volume:test-store',
  volumeDriver: 'local',
  writerProtocol: 'single-coordinator-fenced-v1',
  clock,
  verifyStorage: false,
});
await expectCode('SEALED_MANIFEST_MISSING', () => createParentRun(store, {
  runId: 'run-missing-manifest',
  subjectCoreDigest: DIGEST,
  compilationState: 'sealed',
  workItems: [{ id: 'work-missing', maxAttempts: 1 }],
}));
await assert.rejects(createParentRun(store, {
  runId: 'run-interrupted-create',
  subjectCoreDigest: DIGEST,
  finalSubjectDigest: DIGEST,
  executionManifestDigest: DIGEST,
  compilationState: 'sealed',
  workItems: [{ id: 'work-interrupted', maxAttempts: 1 }],
  afterTemporaryPersist: () => { throw new Error('synthetic crash before run-directory rename'); },
}), /synthetic crash/);
await createParentRun(store, {
  runId: 'run-interrupted-create',
  subjectCoreDigest: DIGEST,
  finalSubjectDigest: DIGEST,
  executionManifestDigest: DIGEST,
  compilationState: 'sealed',
  workItems: [{ id: 'work-interrupted', maxAttempts: 1 }],
});
await createParentRun(store, {
  runId: 'run-main',
  subjectCoreDigest: DIGEST,
  finalSubjectDigest: DIGEST,
  executionManifestDigest: DIGEST,
  compilationState: 'sealed',
  workItems: [
    { id: 'work-a', maxAttempts: 2 },
    { id: 'work-b', maxAttempts: 2 },
    { id: 'work-failure', maxAttempts: 2 },
  ],
});
await createParentRun(store, {
  runId: 'run-other',
  subjectCoreDigest: DIGEST,
  finalSubjectDigest: DIGEST,
  executionManifestDigest: DIGEST,
  compilationState: 'sealed',
  workItems: [{ id: 'work-other', maxAttempts: 1 }],
});
const graphCore = sealReleaseSubjectCore({
  schemaVersion: 1,
  deploymentIdentity: { kind: 'build', value: 'build-u2-graph' },
  targets: [{ role: 'candidate', origin: 'https://candidate.example.test' }],
  mode: 'single-site',
  requestedAuthority: {
    qualifier: 'FULL',
    scope: { features: ['site'], definitions: ['HOME-001'], targets: ['desktop'], knownLimits: [] },
  },
  revisions: { runner: DIGEST, plugins: DIGEST, targets: DIGEST, configuration: DIGEST },
  environmentIdentity: DIGEST,
  certificatePolicy: 'strict',
});
const graphManifest = sealExecutionManifest({
  schemaVersion: 1,
  subjectCoreDigest: graphCore.digest,
  workItems: [{ id: 'work-seal', definitionId: 'HOME-001', targetId: 'desktop', targetRole: 'candidate' }],
  oracleExecutions: [{ id: 'oracle-seal', definitionId: 'HOME-001', requiredWorkItemIds: ['work-seal'] }],
  contextWorkItemIds: [],
});
const graphFinalSubject = sealFinalReleaseSubject({
  schemaVersion: 1,
  subjectCore: graphCore,
  executionManifest: graphManifest,
  grantedAuthority: graphCore.requestedAuthority,
  coverageBasis: { selectedDefinitions: ['HOME-001'], selectedTargets: ['desktop'], excludedAsNotApplicable: [] },
  deploymentIdentityRecheck: graphCore.deploymentIdentity,
});
await createParentRun(store, {
  runId: 'run-seal-replay',
  subjectCore: graphCore,
  compilationState: 'pending',
  workItems: [{ id: 'work-seal', maxAttempts: 1 }],
});

// A durable operation is recoverable after acceptance and exact retries do not duplicate it.
const accepted = await acceptOperation(store, 'run-main', operationRequest());
const revisionAfterAccept = (await readParentRun(store, 'run-main')).runRevision;
const acceptedRetry = await acceptOperation(store, 'run-main', operationRequest());
assert.equal(acceptedRetry.operationId, accepted.operationId);
assert.equal(acceptedRetry.state, 'accepted');
assert.equal((await readParentRun(store, 'run-main')).runRevision, revisionAfterAccept);
await expectCode('IDEMPOTENCY_CONFLICT', () => acceptOperation(store, 'run-main', {
  ...operationRequest(), body: { requestedAuthority: 'TARGETED' },
}));
const reopened = await openParentRunStore({ root, clock, verifyStorage: false });
assert.equal((await getOperation(reopened, 'run-main', 'launch-1')).operationId, accepted.operationId);

// Coordinator acquisition and takeover are serialized and old epochs are fenced.
const coordinatorRace = await Promise.allSettled([
  acquireCoordinator(store, 'run-main', { ownerId: 'coordinator-a', leaseMs: 1_000 }),
  acquireCoordinator(store, 'run-other', { ownerId: 'coordinator-b', leaseMs: 1_000 }),
]);
assert.equal(coordinatorRace.filter(({ status }) => status === 'fulfilled').length, 1);
assert.equal(coordinatorRace.filter(({ status, reason }) => status === 'rejected' && reason.code === 'COORDINATOR_LEASE_HELD').length, 1);
const coordinatorA = coordinatorRace.find(({ status }) => status === 'fulfilled').value;
await sealParentRunGraph(store, 'run-seal-replay', coordinatorA, {
  subjectCore: graphCore, executionManifest: graphManifest, finalSubject: graphFinalSubject,
});
const revisionAfterSeal = (await readParentRun(store, 'run-seal-replay')).runRevision;
await sealParentRunGraph(store, 'run-seal-replay', coordinatorA, {
  subjectCore: graphCore, executionManifest: graphManifest, finalSubject: graphFinalSubject,
});
assert.equal((await readParentRun(store, 'run-seal-replay')).runRevision, revisionAfterSeal);
await expectCode('STORE_SCHEMA_INVALID', () => claimWorkItem(store, 'run-other', coordinatorA, {
  workerId: 'worker-invalid', workItemId: 'work-other', leaseMs: 99,
}));

// Simultaneous work claims choose one winner. Expiry fences stale heartbeats and results.
const claimRace = await Promise.allSettled([
  claimWorkItem(store, 'run-main', coordinatorA, { workerId: 'worker-a', workItemId: 'work-a', leaseMs: 500 }),
  claimWorkItem(store, 'run-main', coordinatorA, { workerId: 'worker-b', workItemId: 'work-a', leaseMs: 500 }),
]);
assert.equal(claimRace.filter(({ status }) => status === 'fulfilled').length, 1);
const staleLease = claimRace.find(({ status }) => status === 'fulfilled').value;
now += 501;
await requeueExpiredWork(store, 'run-main', coordinatorA);
const freshLease = await claimWorkItem(store, 'run-main', coordinatorA, {
  workerId: 'worker-b', workItemId: 'work-a', leaseMs: 500,
});
await expectCode('STALE_WORK_LEASE', () => heartbeatWorkItem(store, 'run-main', staleLease));
await expectCode('STALE_WORK_LEASE', () => publishAttemptEvidence(store, 'run-main', staleLease, {
  outcome: 'completed_pass', artifacts: [],
}));
const inbox = await publishAttemptEvidence(store, 'run-main', freshLease, {
  outcome: 'completed_pass', artifacts: [],
});
await adoptAttemptEvidence(store, 'run-main', coordinatorA, inbox);

// A product failure remains terminal across restart and is never operationally retried.
let failureLease = await claimWorkItem(store, 'run-main', coordinatorA, {
  workerId: 'worker-failure', workItemId: 'work-failure', leaseMs: 500,
});
const revisionBeforeWorkerHeartbeat = (await readParentRun(store, 'run-main')).runRevision;
const heartbeatInbox = await heartbeatWorkItem(store, 'run-main', failureLease, { leaseMs: 500 });
assert.equal((await readParentRun(store, 'run-main')).runRevision, revisionBeforeWorkerHeartbeat);
failureLease = await adoptWorkHeartbeat(store, 'run-main', coordinatorA, heartbeatInbox);
assert.equal((await readParentRun(store, 'run-main')).runRevision, revisionBeforeWorkerHeartbeat + 1);
await appendAttemptLog(store, 'run-main', failureLease, { sequence: 1, level: 'info', message: 'assertion completed' });
await expectCode('STORE_SCHEMA_INVALID', () => publishAttemptEvidence(store, 'run-main', failureLease, {
  outcome: 'completed_product_failure', artifacts: [{ name: '../escape', mediaType: 'image/png', sizeBytes: 1, digest: DIGEST, contentBase64: 'YQ==' }],
}));
const failureInbox = await publishAttemptEvidence(store, 'run-main', failureLease, {
  outcome: 'completed_product_failure', artifacts: [],
});
await adoptAttemptEvidence(store, 'run-main', coordinatorA, failureInbox);
assert.equal((await recoverParentRun(reopened, 'run-main')).workItems['work-failure'].state, 'completed_product_failure');
await expectCode('WORK_ITEM_TERMINAL', () => claimWorkItem(store, 'run-main', coordinatorA, {
  workerId: 'worker-retry', workItemId: 'work-failure', leaseMs: 500,
}));

// Cancellation fences outstanding work, preserves evidence, and cannot be resumed.
const outstanding = await claimWorkItem(store, 'run-main', coordinatorA, {
  workerId: 'worker-cancel', workItemId: 'work-b', leaseMs: 500,
});
await cancelParentRun(store, 'run-main', coordinatorA, { actor: { id: 'operator-1', kind: 'user' }, reason: 'operator request' });
const revisionAfterCancellation = (await readParentRun(store, 'run-main')).runRevision;
await cancelParentRun(store, 'run-main', coordinatorA, { actor: { id: 'operator-1', kind: 'user' }, reason: 'operator request' });
assert.equal((await readParentRun(store, 'run-main')).runRevision, revisionAfterCancellation);
await expectCode('STALE_WORK_LEASE', () => heartbeatWorkItem(store, 'run-main', outstanding));
await expectCode('RUN_CANCELLED', () => claimWorkItem(store, 'run-main', coordinatorA, { workerId: 'worker-x', leaseMs: 500 }));
assert.equal((await readParentRun(store, 'run-main')).workItems['work-a'].state, 'completed_pass');

await completeOperation(store, 'run-main', coordinatorA, accepted.operationId, { status: 'cancelled' });
assert.equal((await getOperation(store, 'run-main', 'launch-1')).state, 'completed');
const revisionAfterCompletion = (await readParentRun(store, 'run-main')).runRevision;
await completeOperation(store, 'run-main', coordinatorA, accepted.operationId, { status: 'cancelled' });
assert.equal((await readParentRun(store, 'run-main')).runRevision, revisionAfterCompletion);
await appendRiskLifecycleEvent(store, 'run-main', coordinatorA, {
  type: 'risk-acknowledged',
  actor: { id: 'reviewer-1', kind: 'user' },
  riskIdentity: DIGEST,
  from: 'OPEN',
  to: 'ACKNOWLEDGED',
  releaseEffect: 'non-blocking',
});
assert.equal((await readRunHistories(store, 'run-main')).risk.length, 1);

// Takeover advances the epoch and prevents the stale coordinator from publishing.
now += 1_001;
const coordinatorB = await takeOverCoordinator(store, 'run-main', { ownerId: 'coordinator-b', leaseMs: 1_000 });
assert.equal(coordinatorB.epoch, coordinatorA.epoch + 1);
await expectCode('STALE_COORDINATOR', () => publishCurrentEnvelope(store, 'run-main', coordinatorA, envelope(1)));

// Envelope durability precedes the single head swap: a crash exposes the old head or the new complete head.
let histories = await readRunHistories(store, 'run-main');
const firstEnvelope = envelope(1, null, {
  observations: histories.mutation.length,
  decisions: histories.decision.length + 1,
  risks: histories.risk.length,
});
await publishCurrentEnvelope(store, 'run-main', coordinatorB, firstEnvelope);
histories = await readRunHistories(store, 'run-main');
const secondEnvelope = envelope(2, firstEnvelope, {
  observations: histories.mutation.length,
  decisions: histories.decision.length + 1,
  risks: histories.risk.length,
});
await assert.rejects(
  publishCurrentEnvelope(store, 'run-main', coordinatorB, secondEnvelope, {
    afterEnvelopePersist: () => { throw new Error('synthetic crash before head swap'); },
  }),
  /synthetic crash/,
);
assert.equal((await readCurrentEnvelope(store, 'run-main')).digest, firstEnvelope.digest);
await publishCurrentEnvelope(store, 'run-main', coordinatorB, secondEnvelope);
assert.equal((await readCurrentEnvelope(store, 'run-main')).digest, secondEnvelope.digest);
histories = await readRunHistories(store, 'run-main');
const thirdEnvelope = envelope(3, secondEnvelope, {
  observations: histories.mutation.length,
  decisions: histories.decision.length + 1,
  risks: histories.risk.length,
});
await assert.rejects(
  publishCurrentEnvelope(store, 'run-main', coordinatorB, thirdEnvelope, {
    afterDecisionPersist: () => { throw new Error('synthetic crash after decision fsync'); },
  }),
  /synthetic crash/,
);
assert.equal((await readCurrentEnvelope(store, 'run-main')).digest, thirdEnvelope.digest);
assert.equal((await loadSharedReleasePublication(root, 'run-main')).digest, thirdEnvelope.digest);

const coordinatorPath = join(root, 'coordinator.json');
const coordinatorDocument = await readFile(coordinatorPath, 'utf8');
const forgedCoordinator = JSON.parse(coordinatorDocument);
forgedCoordinator.token = 'forged-token';
await writeFile(coordinatorPath, `${JSON.stringify(forgedCoordinator)}\n`);
await expectCode('STORE_CORRUPT', () => heartbeatCoordinator(store, coordinatorB, { leaseMs: 1_000 }));
await writeFile(coordinatorPath, coordinatorDocument);

// An OS-backed lock is not stolen from a live paused writer; takeover waits,
// then the durable epoch advances and fences the prior owner.
now += 1_001;
let releasePausedWriter;
const pausedWriterGate = new Promise((resolve) => { releasePausedWriter = resolve; });
const pausedWriter = withDirectoryLock(atomicStorage, join(root, '.coordinator-mutation-lock'), async () => pausedWriterGate);
await new Promise((resolve) => setTimeout(resolve, 20));
let takeoverFinished = false;
const coordinatorCTask = takeOverCoordinator(store, 'run-main', { ownerId: 'coordinator-c', leaseMs: 1_000 })
  .then((value) => { takeoverFinished = true; return value; });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(takeoverFinished, false);
releasePausedWriter();
await pausedWriter;
const coordinatorC = await coordinatorCTask;
assert.equal(coordinatorC.epoch, coordinatorB.epoch + 1);
await expectCode('STALE_COORDINATOR', () => heartbeatCoordinator(store, coordinatorB, { leaseMs: 1_000 }));

// A broken append-only chain fails closed, while a legacy source stays explicitly non-authoritative.
const decisionEvent = join(root, 'runs', 'run-main', 'ledgers', 'decision', '000000000001.json');
const originalEvent = await readFile(decisionEvent, 'utf8');
const corrupted = JSON.parse(originalEvent);
corrupted.previousDigest = DIGEST;
await writeFile(decisionEvent, `${JSON.stringify(corrupted)}\n`);
await expectCode('STORE_CORRUPT', () => recoverParentRun(store, 'run-main'));
await writeFile(decisionEvent, originalEvent);

// Completed operation resources expire after the retry window without erasing their append-only audit history.
now += 24 * 60 * 60 * 1_000 + 1;
await acceptOperation(store, 'run-main', operationRequest('after-retention-window'));
await expectCode('OPERATION_NOT_FOUND', () => getOperation(store, 'run-main', 'launch-1'));
assert.equal(
  (await readRunHistories(store, 'run-main')).operation.filter(({ type }) => type === 'operation-completed').length,
  1,
  'compacting completed operation resources must retain their append-only audit history',
);

const legacyRoot = join(root, 'legacy-fixture');
await writeFile(join(root, 'legacy.json'), JSON.stringify({ auditId: 'legacy-1', status: 'passed' }));
const legacy = await readLegacyRun(join(root, 'legacy.json'));
assert.equal(legacy.authoritative, false);
assert.equal(legacy.releaseDecision, null);
assert.equal(legacy.sourcePath.endsWith('legacy.json'), true);

await expectCode('STORE_VOLUME_UNSUPPORTED', () => openParentRunStore({
  root: legacyRoot,
  deploymentIdentity: 'compose-project:test',
  volumeIdentity: 'named-volume:nfs',
  volumeDriver: 'nfs',
  verifyStorage: false,
}));

await rm(root, { recursive: true, force: true });
console.log('durable parent-run store self-test passed');
