import assert from 'node:assert/strict';
import * as nativeFilesystem from 'node:fs/promises';
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acceptOperation,
  acquireCoordinator,
  acquireStoreCoordinator,
  appendAttemptLog,
  adoptWorkHeartbeat,
  adoptAttemptEvidence,
  appendRiskLifecycleEvent,
  cancelParentRun,
  claimStoreWorkItem,
  claimWorkItem,
  completeOperation,
  createParentRun,
  getOperation,
  heartbeatCoordinator,
  heartbeatWorkItem,
  listParentRunIds,
  MAX_PARENT_RUN_RECOVERY_CACHE_ENTRIES,
  openParentRunStore,
  publishAttemptEvidence,
  publishCurrentEnvelope,
  readBoundedAttemptLogs,
  readCurrentEnvelope,
  readParentRun,
  readReleaseAuthoritySelector,
  readRunHistories,
  recoverParentRun,
  requeueExpiredWork,
  sealParentRunGraph,
  takeOverCoordinator,
  takeOverStoreCoordinator,
  transitionReleaseAuthority,
} from './lib/parent-run-store.mjs';
import { readLegacyRun } from './lib/legacy-run-adapter.mjs';
import { loadSharedReleasePublication } from '../portal/report-publication.mjs';
import { appendPublicationEnvelope } from '../shared/publication-envelope.mjs';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { sealExecutionManifest } from '../shared/execution-contract.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { atomicWriteJson, openAtomicStorage, withDirectoryLock } from './lib/atomic-filesystem.mjs';
import { appendLedgerEvent, LEDGER_KINDS } from './lib/durable-ledger.mjs';

const DIGEST = canonicalDigest({ fixture: 'durable-parent-run' });
const STORE_MARKER = '9a'.repeat(32);
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
  storeMarker: STORE_MARKER,
  volumeDriver: 'local',
  writerProtocol: 'single-coordinator-global-performance-v2',
  backupMarker: 'backup:durable-parent-run-test',
  clock,
  verifyStorage: false,
});

// The singleton coordinator owns the store, so it can acquire its fence before
// the portal has materialized any parent run.
const preRunCoordinator = await acquireStoreCoordinator(store, {
  ownerId: 'coordinator-before-runs', leaseMs: 100,
});
assert.equal(preRunCoordinator.epoch, 1);
assert.deepEqual(await listParentRunIds(store), []);
now += 101;

const discoveryRoot = await mkdtemp(join(tmpdir(), 'durable-parent-run-discovery-'));
try {
  const discoveryStore = await openParentRunStore({
    root: discoveryRoot,
    deploymentIdentity: 'compose-project:discovery',
    volumeIdentity: 'named-volume:discovery-store',
    volumeDriver: 'local',
    clock,
    verifyStorage: false,
  });
  for (const runId of ['run-zeta', 'run-alpha']) {
    await createParentRun(discoveryStore, {
      runId,
      subjectCoreDigest: DIGEST,
      workItems: [{ id: `work-${runId}`, maxAttempts: 1 }],
    });
  }
  assert.deepEqual(await listParentRunIds(discoveryStore), ['run-alpha', 'run-zeta']);
  assert.deepEqual(await listParentRunIds(discoveryStore, { limit: 1 }), ['run-alpha']);
  await expectCode('STORE_SCHEMA_INVALID', () => listParentRunIds(discoveryStore, { limit: 0 }));
} finally {
  await rm(discoveryRoot, { recursive: true, force: true });
}
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
await createParentRun(store, {
  runId: 'run-stale-worker-epoch',
  subjectCoreDigest: DIGEST,
  workItems: [
    { id: 'work-stale-heartbeat', maxAttempts: 2 },
    { id: 'work-stale-result', maxAttempts: 2 },
  ],
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
const staleEpochHeartbeatLease = await claimWorkItem(store, 'run-stale-worker-epoch', coordinatorA, {
  workerId: 'worker-stale-heartbeat', workItemId: 'work-stale-heartbeat', leaseMs: 10_000,
});
const staleEpochHeartbeat = await heartbeatWorkItem(store, 'run-stale-worker-epoch', staleEpochHeartbeatLease, {
  leaseMs: 10_000,
});
const staleEpochResultLease = await claimWorkItem(store, 'run-stale-worker-epoch', coordinatorA, {
  workerId: 'worker-stale-result', workItemId: 'work-stale-result', leaseMs: 10_000,
});
const staleEpochResult = await publishAttemptEvidence(store, 'run-stale-worker-epoch', staleEpochResultLease, {
  outcome: 'completed_pass', artifacts: [],
});
now += 1_001;
const coordinatorB = await takeOverStoreCoordinator(store, { ownerId: 'coordinator-b', leaseMs: 1_000 });
assert.equal(coordinatorB.epoch, coordinatorA.epoch + 1);
await expectCode('STALE_COORDINATOR', () => publishCurrentEnvelope(store, 'run-main', coordinatorA, envelope(1)));
const shadowSelector = await readReleaseAuthoritySelector(store);
const drainingSelector = await transitionReleaseAuthority(store, coordinatorB, {
  expectedSelectorDigest: shadowSelector.digest,
  phase: 'DRAINING',
  buildIdentity: store.buildIdentity,
});
await transitionReleaseAuthority(store, coordinatorB, {
  expectedSelectorDigest: drainingSelector.digest,
  phase: 'ACTIVE',
  activationRevision: 1,
  buildIdentity: store.buildIdentity,
  activationCutoverDigest: DIGEST,
  authorityTransitionDigest: DIGEST,
});
await expectCode('STALE_WORK_LEASE', () => adoptWorkHeartbeat(
  store, 'run-stale-worker-epoch', coordinatorB, staleEpochHeartbeat,
));
await expectCode('STALE_WORK_LEASE', () => adoptAttemptEvidence(
  store, 'run-stale-worker-epoch', coordinatorB, staleEpochResult,
));

// Envelope durability precedes the single head swap: a crash exposes the old head or the new complete head.
let histories = await readRunHistories(store, 'run-main');
const firstEnvelope = envelope(1, null, {
  observations: histories.mutation.length,
  decisions: histories.decision.length + 1,
  risks: histories.risk.length,
});
await assert.rejects(
  publishCurrentEnvelope(store, 'run-main', coordinatorB, firstEnvelope, {
    afterEnvelopePersist: () => { throw new Error('synthetic crash before first head swap'); },
  }),
  /synthetic crash/,
);
await expectCode('PUBLICATION_UNAVAILABLE', () => readCurrentEnvelope(store, 'run-main'));
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
assert.equal((await loadSharedReleasePublication(root, 'run-main', {
  storeMarker: STORE_MARKER,
  expectedStoreGeneration: 2,
})).digest, thirdEnvelope.digest);

let externalAuthorityRejected = false;
let externalAuthorityChecks = 0;
const externalAuthorityFloor = {
  async assertAuthorityState({ manifest, selector, legacyFence }) {
    externalAuthorityChecks += 1;
    assert.equal(manifest.storeGeneration, 2);
    assert.equal(selector.phase, 'ACTIVE');
    assert.equal(legacyFence.state, 'ACTIVATED');
    if (externalAuthorityRejected) {
      throw Object.assign(new Error('synthetic stale restored authority'), { code: 'AUTHORITY_FLOOR_STALE_STORE' });
    }
    return { digest: DIGEST };
  },
};
const externalLegacyFence = {
  async read() { return { state: 'ACTIVATED', activationEpoch: 1 }; },
};
const guardedStore = await openParentRunStore({
  root,
  storeMarker: STORE_MARKER,
  expectedStoreGeneration: 2,
  verifyStorage: false,
  authorityFloor: externalAuthorityFloor,
  legacyAuthorityFence: externalLegacyFence,
});
assert.equal((await readCurrentEnvelope(guardedStore, 'run-main')).digest, thirdEnvelope.digest);
assert.ok(externalAuthorityChecks >= 2, 'store open and current-envelope consumption must both consult the external floor');
externalAuthorityRejected = true;
await expectCode('AUTHORITY_FLOOR_STALE_STORE', () => readCurrentEnvelope(guardedStore, 'run-main'));
await expectCode('AUTHORITY_FLOOR_STALE_STORE', () => acquireStoreCoordinator(guardedStore, {
  ownerId: 'must-not-acquire-after-external-floor-rejection', leaseMs: 1_000,
}));
await expectCode('AUTHORITY_FLOOR_STALE_STORE', () => createParentRun(guardedStore, {
  runId: 'must-not-create-after-external-floor-rejection',
  subjectCoreDigest: DIGEST,
  workItems: [{ id: 'must-not-create-work', maxAttempts: 1 }],
}));

const coordinatorPath = join(root, 'coordinator.json');
const coordinatorDocument = await readFile(coordinatorPath, 'utf8');
const forgedCoordinator = JSON.parse(coordinatorDocument);
forgedCoordinator.token = 'forged-token';
await writeFile(coordinatorPath, `${JSON.stringify(forgedCoordinator)}\n`);
await expectCode('STORE_CORRUPT', () => heartbeatCoordinator(store, coordinatorB, { leaseMs: 1_000 }));
await writeFile(coordinatorPath, coordinatorDocument);
const renewedCoordinator = await heartbeatCoordinator(store, coordinatorB, { leaseMs: 1_000 });
assert.equal(renewedCoordinator.buildIdentity, coordinatorB.buildIdentity);

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
const coldIntegrityStore = await openParentRunStore({
  root,
  clock,
  storeMarker: STORE_MARKER,
  expectedStoreGeneration: store.manifest.storeGeneration,
  verifyStorage: false,
});
await expectCode('STORE_CORRUPT', () => recoverParentRun(coldIntegrityStore, 'run-main'));
await writeFile(decisionEvent, originalEvent);
await expectCode('STORE_CORRUPT', () => recoverParentRun(store, 'run-main'));
const restoredIntegrityStore = await openParentRunStore({
  root,
  clock,
  storeMarker: STORE_MARKER,
  expectedStoreGeneration: store.manifest.storeGeneration,
  verifyStorage: false,
});

// Completed operation resources expire after the retry window without erasing their append-only audit history.
now += 24 * 60 * 60 * 1_000 + 1;
await acceptOperation(restoredIntegrityStore, 'run-main', operationRequest('after-retention-window'));
await expectCode('OPERATION_NOT_FOUND', () => getOperation(restoredIntegrityStore, 'run-main', 'launch-1'));
assert.equal(
  (await readRunHistories(restoredIntegrityStore, 'run-main')).operation.filter(({ type }) => type === 'operation-completed').length,
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

// Recovery keeps append-only history authoritative without rereading the large
// state snapshot embedded in every immutable event on every warm access.
const recoveryCacheRoot = await mkdtemp(join(tmpdir(), 'durable-parent-run-recovery-cache-'));
let ledgerBodyReads = 0;
let ledgerEventMetadataReads = 0;
let ledgerDirectoryReads = 0;
let ledgerDirectoryEntriesRead = 0;
let totalFilesystemCalls = 0;
const countingFilesystem = new Proxy(nativeFilesystem, {
  get(target, property) {
    const operation = Reflect.get(target, property);
    if (typeof operation !== 'function') return operation;
    return async (...args) => {
      totalFilesystemCalls += 1;
      const candidate = String(args[0]);
      const isLedgerEvent = candidate.includes(`${sep}ledgers${sep}`) && /\d{12}\.json$/u.test(candidate);
      if (property === 'readFile' && isLedgerEvent) {
        ledgerBodyReads += 1;
      }
      if (property === 'lstat' && isLedgerEvent) {
        ledgerEventMetadataReads += 1;
      }
      const result = await operation(...args);
      if (property === 'readdir' && candidate.includes(`${sep}ledgers${sep}`)) {
        ledgerDirectoryReads += 1;
        ledgerDirectoryEntriesRead += result.length;
      }
      return result;
    };
  },
});
try {
  const cachedStore = await openParentRunStore({
    root: recoveryCacheRoot,
    filesystem: countingFilesystem,
    deploymentIdentity: 'compose-project:recovery-cache',
    volumeIdentity: 'named-volume:recovery-cache',
    clock,
    verifyStorage: false,
  });
  await createParentRun(cachedStore, {
    runId: 'run-cache',
    subjectCoreDigest: DIGEST,
    workItems: [{ id: 'work-cache', maxAttempts: 1 }],
  });
  ledgerBodyReads = 0;
  const coldState = await readParentRun(cachedStore, 'run-cache');
  assert.ok(ledgerBodyReads > 0, 'cold recovery must validate complete immutable event bodies');
  ledgerBodyReads = 0;
  assert.equal((await readParentRun(cachedStore, 'run-cache')).runRevision, coldState.runRevision);
  assert.equal(ledgerBodyReads, 0, 'unchanged warm recovery must not reread immutable event bodies');
  assert.equal((await readRunHistories(cachedStore, 'run-cache')).mutation.length, 1);
  assert.equal(ledgerBodyReads, 0, 'warm history projection must reuse verified event summaries');

  const externalStore = await openParentRunStore({
    root: recoveryCacheRoot,
    deploymentIdentity: 'compose-project:recovery-cache',
    volumeIdentity: 'named-volume:recovery-cache',
    clock,
    verifyStorage: false,
  });
  const staleState = await readFile(join(recoveryCacheRoot, 'runs', 'run-cache', 'state.json'), 'utf8');
  await acceptOperation(externalStore, 'run-cache', operationRequest('external-suffix'));
  await writeFile(join(recoveryCacheRoot, 'runs', 'run-cache', 'state.json'), staleState);
  ledgerBodyReads = 0;
  await readBoundedAttemptLogs(cachedStore, 'run-cache');
  assert.equal(ledgerBodyReads, 1, 'repair-disabled recovery must still validate only the new suffix event');
  assert.equal(
    JSON.parse(await readFile(join(recoveryCacheRoot, 'runs', 'run-cache', 'state.json'), 'utf8')).runRevision,
    coldState.runRevision,
    'repair-disabled recovery must not mutate the derived state cache',
  );
  ledgerBodyReads = 0;
  const suffixState = await readParentRun(cachedStore, 'run-cache');
  assert.equal(suffixState.runRevision, coldState.runRevision + 1,
    'a ledger append must remain the commit record when state.json repair was interrupted');
  assert.equal(ledgerBodyReads, 0, 'later repair must use the already verified suffix without rereading its event body');
  assert.equal(
    JSON.parse(await readFile(join(recoveryCacheRoot, 'runs', 'run-cache', 'state.json'), 'utf8')).runRevision,
    suffixState.runRevision,
    'suffix recovery must repair a stale derived state cache',
  );

  // A long immutable history performs O(prefix) metadata authentication on
  // every warm recovery while avoiding all historical event body reads. Count
  // directory payload and total calls so the cost model remains explicit.
  const HIGH_EVENT_APPEND_COUNT = 256;
  const syntheticState = structuredClone(suffixState);
  for (let index = 0; index < HIGH_EVENT_APPEND_COUNT; index += 1) {
    syntheticState.runRevision += 1;
    syntheticState.ledgerSequences.mutation += 1;
    syntheticState.updatedAt = new Date(Date.parse(syntheticState.updatedAt) + 1).toISOString();
    const event = await appendLedgerEvent(
      cachedStore.storage,
      join(recoveryCacheRoot, 'runs', 'run-cache'),
      'mutation',
      {
        sequence: syntheticState.ledgerSequences.mutation,
        runRevision: syntheticState.runRevision,
        previousDigest: syntheticState.ledgerHeads.mutation,
        occurredAt: syntheticState.updatedAt,
        type: 'synthetic-high-event-history',
        data: { index },
        stateSnapshot: syntheticState,
      },
    );
    syntheticState.ledgerHeads.mutation = event.digest;
  }
  assert.equal(
    (await readParentRun(cachedStore, 'run-cache')).runRevision,
    suffixState.runRevision + HIGH_EVENT_APPEND_COUNT,
  );
  const WARM_RECOVERY_READS = 10;
  ledgerBodyReads = 0;
  ledgerEventMetadataReads = 0;
  ledgerDirectoryReads = 0;
  ledgerDirectoryEntriesRead = 0;
  totalFilesystemCalls = 0;
  for (let index = 0; index < WARM_RECOVERY_READS; index += 1) {
    await readParentRun(cachedStore, 'run-cache');
  }
  const expectedPrefixMetadataReads = WARM_RECOVERY_READS * syntheticState.runRevision * 3;
  assert.equal(ledgerBodyReads, 0, 'warm recovery must not reread any high-event history body');
  assert.equal(
    ledgerEventMetadataReads,
    expectedPrefixMetadataReads,
    'warm recovery must authenticate every cached prefix event across three stable vectors',
  );
  assert.equal(
    ledgerDirectoryReads,
    WARM_RECOVERY_READS * LEDGER_KINDS.length * 3,
    'warm recovery must sample three finite name vectors for every ledger',
  );
  assert.equal(
    ledgerDirectoryEntriesRead,
    expectedPrefixMetadataReads,
    'warm recovery directory payload must match its authenticated finite prefix vectors',
  );
  assert.ok(
    totalFilesystemCalls <= expectedPrefixMetadataReads + (WARM_RECOVERY_READS * 100),
    `warm recovery adds only bounded bookkeeping beyond prefix authentication; observed ${totalFilesystemCalls} calls`,
  );

  // The process accelerator is a bounded LRU. Exceeding its run budget evicts
  // the oldest entry, whose next access safely performs a complete cold read.
  const lruRunIds = Array.from(
    { length: MAX_PARENT_RUN_RECOVERY_CACHE_ENTRIES + 1 },
    (_, index) => `run-cache-lru-${String(index).padStart(3, '0')}`,
  );
  for (const runId of lruRunIds) {
    await createParentRun(cachedStore, {
      runId,
      subjectCoreDigest: DIGEST,
      workItems: [{ id: `work-${runId}`, maxAttempts: 1 }],
    });
    await readParentRun(cachedStore, runId);
  }
  ledgerBodyReads = 0;
  await readParentRun(cachedStore, lruRunIds.at(-1));
  assert.equal(ledgerBodyReads, 0, 'most-recent recovery entry must remain warm');
  await readParentRun(cachedStore, lruRunIds[0]);
  assert.ok(ledgerBodyReads > 0, 'evicted recovery entry must safely repeat cold event validation');
} finally {
  await rm(recoveryCacheRoot, { recursive: true, force: true });
}

// Claims authenticate every explicitly authorized run, including known terminal
// entries that another process could have rekicked. Cached candidates run first
// so cold validation is bounded by the amount the authorized set exceeds LRU.
const schedulerCacheRoot = await mkdtemp(join(tmpdir(), 'durable-parent-run-scheduler-cache-'));
const schedulerLedgerBodyPaths = [];
const schedulerCountingFilesystem = new Proxy(nativeFilesystem, {
  get(target, property) {
    const operation = Reflect.get(target, property);
    if (typeof operation !== 'function') return operation;
    return async (...args) => {
      const candidate = String(args[0]);
      if (property === 'readFile'
        && candidate.includes(`${sep}ledgers${sep}`)
        && /\d{12}\.json$/u.test(candidate)) {
        schedulerLedgerBodyPaths.push(candidate);
      }
      return operation(...args);
    };
  },
});
try {
  const schedulerStore = await openParentRunStore({
    root: schedulerCacheRoot,
    filesystem: schedulerCountingFilesystem,
    deploymentIdentity: 'compose-project:scheduler-cache',
    volumeIdentity: 'named-volume:scheduler-cache',
    clock,
    verifyStorage: false,
  });
  const schedulerCoordinator = await acquireStoreCoordinator(schedulerStore, {
    ownerId: 'scheduler-cache-coordinator',
    leaseMs: 3_600_000,
  });
  const schedulerAuthorizedRunIds = [];
  for (let index = 0; index < MAX_PARENT_RUN_RECOVERY_CACHE_ENTRIES + 1; index += 1) {
    const runId = `run-scheduler-terminal-${String(index).padStart(3, '0')}`;
    schedulerAuthorizedRunIds.push(runId);
    await createParentRun(schedulerStore, {
      runId,
      subjectCoreDigest: DIGEST,
      workItems: [{ id: `work-terminal-${String(index).padStart(3, '0')}`, maxAttempts: 1 }],
    });
    await cancelParentRun(schedulerStore, runId, schedulerCoordinator, {
      actor: { id: 'scheduler-cache-test', kind: 'service' },
      reason: 'terminal scheduler-cache fixture',
    });
  }
  const activeRunId = 'run-scheduler-active';
  await createParentRun(schedulerStore, {
    runId: activeRunId,
    subjectCoreDigest: DIGEST,
    workItems: [
      { id: 'work-scheduler-active-a', maxAttempts: 1 },
      { id: 'work-scheduler-active-b', maxAttempts: 1 },
    ],
  });
  schedulerAuthorizedRunIds.push(activeRunId);
  await claimStoreWorkItem(schedulerStore, schedulerCoordinator, {
    workerId: 'scheduler-cache-worker-a', runIds: schedulerAuthorizedRunIds, leaseMs: 1_000,
  });
  schedulerLedgerBodyPaths.length = 0;
  await claimStoreWorkItem(schedulerStore, schedulerCoordinator, {
    workerId: 'scheduler-cache-worker-b', runIds: schedulerAuthorizedRunIds, leaseMs: 1_000,
  });
  const coldRunBudget = schedulerAuthorizedRunIds.length - MAX_PARENT_RUN_RECOVERY_CACHE_ENTRIES;
  assert.equal(
    schedulerLedgerBodyPaths.length,
    1 + (coldRunBudget * 2),
    'a warm claim reads its active suffix plus complete bodies only for authorized runs outside the LRU',
  );
  assert.equal(
    new Set(schedulerLedgerBodyPaths
      .filter((candidate) => candidate.includes('run-scheduler-terminal-'))
      .map((candidate) => candidate.match(/run-scheduler-terminal-\d+/u)?.[0])).size,
    coldRunBudget,
    'cached-first scheduling bounds terminal cold replay to the recovery-cache excess',
  );
} finally {
  await rm(schedulerCacheRoot, { recursive: true, force: true });
}

async function assertCachedHistoryFailsClosed(name, mutateHistory) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), `durable-parent-run-${name}-`));
  try {
    const fixtureStore = await openParentRunStore({
      root: fixtureRoot,
      deploymentIdentity: `compose-project:${name}`,
      volumeIdentity: `named-volume:${name}`,
      clock,
      verifyStorage: false,
    });
    await createParentRun(fixtureStore, {
      runId: 'run-cache-integrity',
      subjectCoreDigest: DIGEST,
      workItems: [{ id: 'work-cache-integrity', maxAttempts: 1 }],
    });
    await readParentRun(fixtureStore, 'run-cache-integrity');
    await mutateHistory(fixtureRoot);
    await expectCode('STORE_CORRUPT', () => readParentRun(fixtureStore, 'run-cache-integrity'));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

await assertCachedHistoryFailsClosed('fingerprint-change', async (fixtureRoot) => {
  const eventFile = join(fixtureRoot, 'runs', 'run-cache-integrity', 'ledgers', 'mutation', '000000000001.json');
  const event = JSON.parse(await readFile(eventFile, 'utf8'));
  event.type = 'tampered-parent-run-created';
  await writeFile(eventFile, `${JSON.stringify(event)}\n`);
});
await assertCachedHistoryFailsClosed('missing-history', async (fixtureRoot) => {
  await unlink(join(fixtureRoot, 'runs', 'run-cache-integrity', 'ledgers', 'mutation', '000000000001.json'));
});
await assertCachedHistoryFailsClosed('renumbered-history', async (fixtureRoot) => {
  const directory = join(fixtureRoot, 'runs', 'run-cache-integrity', 'ledgers', 'mutation');
  await rename(join(directory, '000000000001.json'), join(directory, '000000000002.json'));
});
await assertCachedHistoryFailsClosed('run-revision-gap', async (fixtureRoot) => {
  const secondStore = await openParentRunStore({
    root: fixtureRoot,
    deploymentIdentity: 'compose-project:run-revision-gap',
    volumeIdentity: 'named-volume:run-revision-gap',
    clock,
    verifyStorage: false,
  });
  const state = await readParentRun(secondStore, 'run-cache-integrity');
  const invalidSnapshot = structuredClone(state);
  invalidSnapshot.runRevision += 2;
  invalidSnapshot.ledgerSequences.operation = 1;
  await appendLedgerEvent(secondStore.storage, join(fixtureRoot, 'runs', 'run-cache-integrity'), 'operation', {
    sequence: 1,
    runRevision: invalidSnapshot.runRevision,
    previousDigest: null,
    occurredAt: new Date(now + 1).toISOString(),
    type: 'synthetic-run-revision-gap',
    stateSnapshot: invalidSnapshot,
  });
});

await rm(root, { recursive: true, force: true });
console.log('durable parent-run store self-test passed');
