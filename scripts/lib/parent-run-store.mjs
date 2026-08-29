import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  canonicalDigest,
  canonicalJson,
} from '../../shared/canonical-contract.mjs';
import { parsePublicationEnvelope, verifyPublicationChain } from '../../shared/publication-envelope.mjs';
import { parseExecutionManifest, sealWorkItemResult } from '../../shared/execution-contract.mjs';
import { parseFinalReleaseSubject, parseReleaseSubjectCore } from '../../shared/release-subject.mjs';
import {
  atomicWriteJson,
  containedPath,
  fsyncDirectory,
  openAtomicStorage,
  pathExists,
  readBoundedJson,
  withDirectoryLock,
} from './atomic-filesystem.mjs';
import {
  appendLedgerEvent,
  initializeLedgers,
  LEDGER_KINDS,
  readAllLedgers,
} from './durable-ledger.mjs';

export const PARENT_RUN_STORE_SCHEMA_VERSION = 1;
export const PARENT_RUN_WRITER_PROTOCOL = 'single-coordinator-fenced-v1';
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const LOCAL_VOLUME_DRIVERS = new Set(['local']);
const WORK_OUTCOMES = new Set([
  'completed_pass', 'completed_product_failure', 'operational_failure', 'cancelled', 'incomplete_unknown',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export class ParentRunStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ParentRunStoreError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ParentRunStoreError(code, message, details);
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('STORE_SCHEMA_INVALID', `${label} is invalid.`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    fail('STORE_CORRUPT', `${label} has an invalid schema.`);
  }
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string') fail('STORE_CORRUPT', `${label} is invalid.`);
  try {
    if (new Date(value).toISOString() !== value) fail('STORE_CORRUPT', `${label} is invalid.`);
  } catch (error) {
    if (error instanceof ParentRunStoreError) throw error;
    fail('STORE_CORRUPT', `${label} is invalid.`);
  }
  return value;
}

function timestamp(store) {
  return new Date(store.clock()).toISOString();
}

function manifestBody(value) {
  return {
    schemaVersion: 1,
    kind: 'durable-parent-run-store',
    deploymentIdentity: value.deploymentIdentity,
    volumeIdentity: value.volumeIdentity,
    volumeDriver: value.volumeDriver,
    authorityEpoch: value.authorityEpoch,
    writerProtocol: value.writerProtocol,
    createdAt: value.createdAt,
    cutoverRevision: value.cutoverRevision,
    backupMarker: value.backupMarker,
  };
}

function validateManifest(value) {
  if (value?.schemaVersion !== 1 || value.kind !== 'durable-parent-run-store'
    || typeof value.deploymentIdentity !== 'string' || !value.deploymentIdentity
    || typeof value.volumeIdentity !== 'string' || !value.volumeIdentity
    || !LOCAL_VOLUME_DRIVERS.has(value.volumeDriver)
    || value.writerProtocol !== PARENT_RUN_WRITER_PROTOCOL
    || !Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 0
    || !Number.isSafeInteger(value.cutoverRevision) || value.cutoverRevision < 0
    || canonicalDigest(manifestBody(value)) !== value.digest) {
    fail('STORE_MANIFEST_INVALID', 'Parent-run store manifest is invalid or corrupt.');
  }
  return value;
}

async function writeManifest(store, body) {
  const manifest = { ...manifestBody(body), digest: canonicalDigest(manifestBody(body)) };
  await atomicWriteJson(store.storage, containedPath(store.root, 'store-manifest.json'), manifest);
  store.manifest = manifest;
  return manifest;
}

function runDirectory(store, runId) {
  return containedPath(store.root, 'runs', safeId(runId, 'runId'));
}

function runStatePath(store, runId) {
  return path.join(runDirectory(store, runId), 'state.json');
}

function lockPath(store, runId) {
  return path.join(runDirectory(store, runId), '.mutation-lock');
}

function globalLockPath(store) {
  return containedPath(store.root, '.coordinator-mutation-lock');
}

function globalCoordinatorPath(store) {
  return containedPath(store.root, 'coordinator.json');
}

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

async function readGlobalCoordinator(store) {
  let value;
  try { value = await readBoundedJson(store.storage, globalCoordinatorPath(store), { label: 'global coordinator lease' }); } catch (error) {
    if (error?.code === 'ATOMIC_NOT_FOUND') return null;
    fail('STORE_CORRUPT', 'Global coordinator lease is unreadable.', { cause: error?.code ?? error?.message });
  }
  exactKeys(value, ['schemaVersion', 'kind', 'ownerId', 'epoch', 'token', 'acquiredAt', 'expiresAt', 'digest'], 'global coordinator lease');
  const { digest, ...body } = value;
  if (value.schemaVersion !== 1 || value.kind !== 'global-coordinator-lease'
    || !SAFE_ID.test(value.ownerId) || !SAFE_ID.test(value.token)
    || !Number.isSafeInteger(value.epoch) || value.epoch < 1
    || value.epoch > store.manifest.authorityEpoch + 1
    || canonicalTimestamp(value.acquiredAt, 'coordinator acquiredAt') >= canonicalTimestamp(value.expiresAt, 'coordinator expiresAt')
    || digest !== canonicalDigest(body)) {
    fail('STORE_CORRUPT', 'Global coordinator lease is invalid or corrupt.');
  }
  return value;
}

function sealCoordinatorLease(value) {
  const body = {
    schemaVersion: 1,
    kind: 'global-coordinator-lease',
    ownerId: value.ownerId,
    epoch: value.epoch,
    token: value.token,
    acquiredAt: value.acquiredAt,
    expiresAt: value.expiresAt,
  };
  return { ...body, digest: canonicalDigest(body) };
}

async function validateCoordinator(store, coordinator) {
  const current = await readGlobalCoordinator(store);
  if (!coordinator || current === null
    || coordinator.epoch !== current.epoch
    || coordinator.token !== current.token
    || coordinator.ownerId !== current.ownerId) {
    fail('STALE_COORDINATOR', 'Coordinator epoch or fencing token is stale.');
  }
  if (Date.parse(current.expiresAt) <= store.clock()) {
    fail('STALE_COORDINATOR', 'Coordinator lease expired.');
  }
  return current;
}

function normalizeRecoveredState(store, snapshot, ledgers) {
  const next = clone(snapshot);
  next.ledgerSequences = {};
  next.ledgerHeads = {};
  for (const kind of LEDGER_KINDS) {
    next.ledgerSequences[kind] = ledgers[kind].length;
    next.ledgerHeads[kind] = ledgers[kind].at(-1)?.digest ?? null;
  }
  next.clockNow = store.clock();
  return next;
}

async function recoverUnlocked(store, runId, { repairCache = true } = {}) {
  const directory = runDirectory(store, runId);
  if (!await pathExists(store.storage.fs, directory)) fail('RUN_NOT_FOUND', `Parent run ${runId} was not found.`);
  let ledgers;
  try {
    ledgers = await readAllLedgers(store.storage, directory);
  } catch (error) {
    fail('STORE_CORRUPT', `Parent run ${runId} has a corrupt append-only history.`, { cause: error?.message });
  }
  const events = Object.values(ledgers).flat().sort((left, right) => left.runRevision - right.runRevision);
  if (events.length === 0 || events.some((event, index) => event.runRevision !== index + 1)) {
    fail('STORE_CORRUPT', `Parent run ${runId} has a missing or duplicate run revision.`);
  }
  const latest = events.at(-1);
  const snapshot = latest.stateSnapshot;
  if (snapshot?.schemaVersion !== 1 || snapshot.kind !== 'durable-parent-run'
    || snapshot.runId !== runId || !Number.isSafeInteger(snapshot.runRevision)
    || !['active', 'cancelled'].includes(snapshot.status)
    || !DIGEST_PATTERN.test(snapshot.subjectCoreDigest)
    || (snapshot.finalSubjectDigest !== null && !DIGEST_PATTERN.test(snapshot.finalSubjectDigest))
    || (snapshot.executionManifestDigest !== null && !DIGEST_PATTERN.test(snapshot.executionManifestDigest))
    || !['pending', 'sealed'].includes(snapshot.compilationState)
    || !snapshot.workItems || typeof snapshot.workItems !== 'object' || Array.isArray(snapshot.workItems)
    || !snapshot.operations || typeof snapshot.operations !== 'object' || Array.isArray(snapshot.operations)) {
    fail('STORE_CORRUPT', `Parent run ${runId} recovery state is invalid.`);
  }
  for (const [id, item] of Object.entries(snapshot.workItems)) {
    if (item?.id !== id || !SAFE_ID.test(id) || !Number.isSafeInteger(item.maxAttempts) || item.maxAttempts < 1
      || !['queued', 'running', 'completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(item.state)
      || !Array.isArray(item.attempts)) fail('STORE_CORRUPT', `Parent run ${runId} has invalid work-item state.`);
  }
  if (snapshot.runRevision !== latest.runRevision) {
    fail('STORE_CORRUPT', `Parent run ${runId} has an invalid recovery snapshot.`);
  }
  const state = normalizeRecoveredState(store, snapshot, ledgers);
  if (repairCache) {
    let cached = null;
    try { cached = await readBoundedJson(store.storage, runStatePath(store, runId), { label: 'parent-run state' }); } catch {}
    const comparableState = { ...state };
    delete comparableState.clockNow;
    if (cached === null || canonicalJson(cached) !== canonicalJson(comparableState)) {
      await atomicWriteJson(store.storage, runStatePath(store, runId), comparableState);
    }
  }
  return state;
}

async function appendMutationUnlocked(store, state, kind, type, apply, { actor = null, data = null } = {}) {
  const next = clone(state);
  next.clockNow = store.clock();
  apply(next);
  delete next.clockNow;
  next.runRevision = state.runRevision + 1;
  next.updatedAt = timestamp(store);
  next.ledgerSequences[kind] += 1;
  const event = await appendLedgerEvent(store.storage, runDirectory(store, state.runId), kind, {
    sequence: next.ledgerSequences[kind],
    runRevision: next.runRevision,
    previousDigest: state.ledgerHeads[kind],
    occurredAt: next.updatedAt,
    type,
    actor,
    data,
    stateSnapshot: next,
  });
  next.ledgerHeads[kind] = event.digest;
  await atomicWriteJson(store.storage, runStatePath(store, state.runId), next);
  return { ...next, clockNow: store.clock() };
}

async function mutate(store, runId, { coordinator = null, kind = 'mutation', type, actor = null, data = null }, apply) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => (
    withDirectoryLock(store.storage, lockPath(store, runId), async () => {
      const state = await recoverUnlocked(store, runId);
      if (coordinator) await validateCoordinator(store, coordinator);
      return appendMutationUnlocked(store, state, kind, type, apply, { actor, data });
    })
  ));
}

export async function openParentRunStore({
  root,
  filesystem,
  nonce = () => randomBytes(12).toString('hex'),
  clock = () => Date.now(),
  deploymentIdentity,
  volumeIdentity,
  volumeDriver = 'local',
  writerProtocol = PARENT_RUN_WRITER_PROTOCOL,
  backupMarker = null,
  cutoverRevision = 0,
  verifyStorage = true,
} = {}) {
  if (!root) fail('STORE_SCHEMA_INVALID', 'Parent-run store root is required.');
  if (!LOCAL_VOLUME_DRIVERS.has(volumeDriver)) {
    fail('STORE_VOLUME_UNSUPPORTED', 'Only a Docker Engine local named volume is supported.');
  }
  const storage = await openAtomicStorage({ root, filesystem, nonce, verify: verifyStorage });
  await storage.fs.mkdir(containedPath(storage.root, 'runs'), { recursive: true, mode: 0o2770 });
  const manifestPath = containedPath(storage.root, 'store-manifest.json');
  const store = { root: storage.root, storage, clock, manifest: null };
  await withDirectoryLock(storage, containedPath(storage.root, '.store-initialization.lock'), async () => {
    if (await pathExists(storage.fs, manifestPath)) {
      const manifest = validateManifest(await readBoundedJson(storage, manifestPath, { label: 'store manifest' }));
      if ((deploymentIdentity && deploymentIdentity !== manifest.deploymentIdentity)
        || (volumeIdentity && volumeIdentity !== manifest.volumeIdentity)
        || volumeDriver !== manifest.volumeDriver || writerProtocol !== manifest.writerProtocol) {
        fail('STORE_IDENTITY_MISMATCH', 'Configured deployment, volume, or writer identity does not match the durable store.');
      }
      store.manifest = manifest;
      return;
    }
    if (!deploymentIdentity || !volumeIdentity) {
      fail('STORE_MANIFEST_REQUIRED', 'A new store requires deploymentIdentity and volumeIdentity.');
    }
    if (!volumeIdentity.startsWith('named-volume:')) {
      fail('STORE_VOLUME_UNSUPPORTED', 'Store volumeIdentity must identify a Docker named volume.');
    }
    await writeManifest(store, {
      deploymentIdentity, volumeIdentity, volumeDriver, writerProtocol, authorityEpoch: 0,
      createdAt: timestamp(store), cutoverRevision, backupMarker,
    });
  });
  return store;
}

export async function createParentRun(store, input) {
  const runId = safeId(input?.runId, 'runId');
  if (!Array.isArray(input.workItems) || input.workItems.length === 0) fail('STORE_SCHEMA_INVALID', 'A parent run requires work items.');
  const compilationState = input.compilationState ?? 'pending';
  if (!['pending', 'sealed'].includes(compilationState)) fail('STORE_SCHEMA_INVALID', 'Parent-run compilationState is invalid.');
  const subjectCore = input.subjectCore ? parseReleaseSubjectCore(input.subjectCore) : null;
  const executionManifest = input.executionManifest ? parseExecutionManifest(input.executionManifest) : null;
  const finalSubject = input.finalSubject ? parseFinalReleaseSubject(input.finalSubject) : null;
  const subjectCoreDigest = subjectCore?.digest ?? input.subjectCoreDigest;
  const executionManifestDigest = executionManifest?.digest ?? input.executionManifestDigest ?? null;
  const finalSubjectDigest = finalSubject?.digest ?? input.finalSubjectDigest ?? null;
  if (!DIGEST_PATTERN.test(subjectCoreDigest)
    || (executionManifestDigest !== null && !DIGEST_PATTERN.test(executionManifestDigest))
    || (finalSubjectDigest !== null && !DIGEST_PATTERN.test(finalSubjectDigest))) {
    fail('STORE_SCHEMA_INVALID', 'Parent-run subject and manifest digests must be sha256 digests.');
  }
  if (executionManifest && executionManifest.subjectCoreDigest !== subjectCoreDigest) {
    fail('RELEASE_SUBJECT_MISMATCH', 'Execution manifest does not match the parent-run subject core.');
  }
  if (finalSubject && (finalSubject.subjectCoreDigest !== subjectCoreDigest
    || finalSubject.executionManifestDigest !== executionManifestDigest)) {
    fail('RELEASE_SUBJECT_MISMATCH', 'Final subject does not match the parent-run graph.');
  }
  if (compilationState === 'sealed' && (!executionManifestDigest || !finalSubjectDigest)) {
    fail('SEALED_MANIFEST_MISSING', 'A sealed parent run requires execution-manifest and final-subject digests.');
  }
  return withDirectoryLock(store.storage, containedPath(store.root, '.create-lock'), async () => {
    const directory = runDirectory(store, runId);
    if (await pathExists(store.storage.fs, directory)) fail('RUN_ALREADY_EXISTS', `Parent run ${runId} already exists.`);
    const temporaryDirectory = containedPath(store.root, 'runs', `.${runId}.initializing.${store.storage.nonce()}`);
    await store.storage.fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o2770 });
    await initializeLedgers(store.storage, temporaryDirectory);
    await store.storage.fs.mkdir(path.join(temporaryDirectory, 'inboxes'), { recursive: true, mode: 0o2770 });
    await store.storage.fs.mkdir(path.join(temporaryDirectory, 'publications'), { recursive: true, mode: 0o2770 });
    const createdAt = timestamp(store);
    const workItems = {};
    for (const item of input.workItems) {
      const id = safeId(item.id, 'workItem.id');
      if (workItems[id]) fail('STORE_SCHEMA_INVALID', `Duplicate work item ${id}.`);
      if (!Number.isSafeInteger(item.maxAttempts) || item.maxAttempts < 1 || item.maxAttempts > 16) {
        fail('STORE_SCHEMA_INVALID', `Work item ${id} maxAttempts must be from 1 through 16.`);
      }
      workItems[id] = {
        id,
        state: 'queued',
        maxAttempts: item.maxAttempts,
        lease: null,
        attempts: [],
        canonicalResult: null,
      };
    }
    const state = {
      schemaVersion: 1,
      kind: 'durable-parent-run',
      runId,
      runRevision: 1,
      status: 'active',
      subjectCore,
      subjectCoreDigest,
      executionManifest,
      executionManifestDigest,
      finalSubject,
      finalSubjectDigest,
      compilationState,
      createdAt,
      updatedAt: createdAt,
      coordinator: null,
      workItems,
      operations: {},
      currentPublicationDigest: null,
      ledgerSequences: { decision: 0, risk: 0, mutation: 1, operation: 0 },
      ledgerHeads: { decision: null, risk: null, mutation: null, operation: null },
    };
    try {
      const event = await appendLedgerEvent(store.storage, temporaryDirectory, 'mutation', {
        sequence: 1, runRevision: 1, previousDigest: null, occurredAt: createdAt,
        type: 'parent-run-created', data: { workItemIds: Object.keys(workItems) }, stateSnapshot: state,
      });
      state.ledgerHeads.mutation = event.digest;
      await atomicWriteJson(store.storage, path.join(temporaryDirectory, 'state.json'), state, { exclusive: true });
      await fsyncDirectory(store.storage.fs, temporaryDirectory);
      await input.afterTemporaryPersist?.(temporaryDirectory);
      await store.storage.fs.rename(temporaryDirectory, directory);
      await fsyncDirectory(store.storage.fs, path.dirname(directory));
      return clone(state);
    } catch (error) {
      await store.storage.fs.rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function recoverParentRun(store, runId) {
  const state = await recoverUnlocked(store, runId);
  delete state.clockNow;
  return state;
}

export const readParentRun = recoverParentRun;

export async function sealParentRunGraph(store, runId, coordinator, input) {
  const subjectCore = input.subjectCore ? parseReleaseSubjectCore(input.subjectCore) : null;
  const executionManifest = parseExecutionManifest(input.executionManifest);
  const finalSubject = parseFinalReleaseSubject(input.finalSubject);
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator);
    const subjectCoreDigest = subjectCore?.digest ?? state.subjectCoreDigest;
    if (executionManifest.subjectCoreDigest !== subjectCoreDigest
      || finalSubject.subjectCoreDigest !== subjectCoreDigest
      || finalSubject.executionManifestDigest !== executionManifest.digest) {
      fail('RELEASE_SUBJECT_MISMATCH', 'Sealed graph contracts do not share one subject and manifest.');
    }
    const storedIds = Object.keys(state.workItems).sort();
    const manifestIds = executionManifest.workItems.map(({ id }) => id).sort();
    if (canonicalJson(storedIds) !== canonicalJson(manifestIds)) {
      fail('SEALED_MANIFEST_MISMATCH', 'Sealed execution manifest does not match the durable work-item queue.');
    }
    if (state.compilationState === 'sealed') {
      if (state.executionManifestDigest !== executionManifest.digest || state.finalSubjectDigest !== finalSubject.digest) {
        fail('SEALED_MANIFEST_IMMUTABLE', 'A sealed parent-run graph cannot be rewritten.');
      }
      delete state.clockNow;
      return state;
    }
    return appendMutationUnlocked(store, state, 'mutation', 'parent-run-graph-sealed', (next) => {
      next.subjectCore = subjectCore ?? next.subjectCore;
      next.executionManifest = executionManifest;
      next.executionManifestDigest = executionManifest.digest;
      next.finalSubject = finalSubject;
      next.finalSubjectDigest = finalSubject.digest;
      next.compilationState = 'sealed';
    });
  }));
}

async function acquire(store, runId, input, takeoverOnly) {
  safeId(input?.ownerId, 'coordinator ownerId');
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 100) fail('STORE_SCHEMA_INVALID', 'Coordinator leaseMs is invalid.');
  return withDirectoryLock(store.storage, globalLockPath(store), () => (
    withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    const previous = await readGlobalCoordinator(store);
    const active = previous && Date.parse(previous.expiresAt) > store.clock();
    if (active) fail('COORDINATOR_LEASE_HELD', `Coordinator epoch ${previous.epoch} is still active.`);
    if (takeoverOnly && previous === null) fail('COORDINATOR_TAKEOVER_INVALID', 'No prior coordinator exists to take over.');
    const epoch = (previous?.epoch ?? store.manifest.authorityEpoch) + 1;
    const coordinator = {
      ownerId: input.ownerId,
      epoch,
      token: store.storage.nonce(),
      acquiredAt: timestamp(store),
      expiresAt: new Date(store.clock() + input.leaseMs).toISOString(),
    };
    await atomicWriteJson(store.storage, globalCoordinatorPath(store), sealCoordinatorLease(coordinator));
    await appendMutationUnlocked(store, state, 'mutation', takeoverOnly ? 'coordinator-taken-over' : 'coordinator-acquired', (next) => {
      next.coordinator = coordinator;
    }, { actor: { id: input.ownerId, kind: 'service' }, data: { epoch } });
    await writeManifest(store, { ...store.manifest, authorityEpoch: Math.max(store.manifest.authorityEpoch, epoch) });
    return clone(coordinator);
    })
  ));
}

export function acquireCoordinator(store, runId, input) {
  return acquire(store, runId, input, false);
}

export function takeOverCoordinator(store, runId, input) {
  return acquire(store, runId, input, true);
}

export async function heartbeatCoordinator(store, coordinator, { leaseMs }) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 3_600_000) {
    fail('STORE_SCHEMA_INVALID', 'Coordinator heartbeat leaseMs must be an integer from 100 through 3600000.');
  }
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    const current = await validateCoordinator(store, coordinator);
    const renewed = sealCoordinatorLease({ ...current, expiresAt: new Date(store.clock() + leaseMs).toISOString() });
    await atomicWriteJson(store.storage, globalCoordinatorPath(store), renewed);
    return clone({
      ownerId: renewed.ownerId, epoch: renewed.epoch, token: renewed.token,
      acquiredAt: renewed.acquiredAt, expiresAt: renewed.expiresAt,
    });
  });
}

export async function claimWorkItem(store, runId, coordinator, input) {
  if (!Number.isSafeInteger(input?.leaseMs) || input.leaseMs < 100 || input.leaseMs > 3_600_000) {
    fail('STORE_SCHEMA_INVALID', 'Work-item leaseMs must be an integer from 100 through 3600000.');
  }
  let claimed;
  await mutate(store, runId, { coordinator, type: 'work-item-claimed', data: { workerId: input.workerId } }, (state) => {
    if (state.status === 'cancelled') fail('RUN_CANCELLED', `Parent run ${runId} is cancelled.`);
    const requested = input.workItemId ? state.workItems[input.workItemId] : Object.values(state.workItems).find(({ state: workState }) => workState === 'queued');
    if (!requested) fail('NO_WORK_AVAILABLE', 'No queued work item is available.');
    if (input.workItemId && requested.state !== 'queued') {
      if (['completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(requested.state)) {
        fail('WORK_ITEM_TERMINAL', `Work item ${requested.id} is terminal.`);
      }
      fail('WORK_ITEM_LEASE_HELD', `Work item ${requested.id} already has an active lease.`);
    }
    const attempt = requested.attempts.length + 1;
    claimed = {
      runId,
      workItemId: requested.id,
      workerId: safeId(input.workerId, 'workerId'),
      attempt,
      epoch: coordinator.epoch,
      token: store.storage.nonce(),
      claimedAt: timestamp(store),
      expiresAt: new Date(store.clock() + input.leaseMs).toISOString(),
    };
    requested.state = 'running';
    requested.lease = claimed;
  });
  return clone(claimed);
}

function validateWorkLease(state, lease) {
  const item = state.workItems[lease?.workItemId];
  if (!item || item.state !== 'running' || !item.lease
    || item.lease.token !== lease.token || item.lease.workerId !== lease.workerId
    || item.lease.attempt !== lease.attempt || item.lease.epoch !== lease.epoch
    || Date.parse(item.lease.expiresAt) <= state.clockNow) {
    fail('STALE_WORK_LEASE', 'Work-item lease or fencing token is stale.');
  }
  return item;
}

export async function heartbeatWorkItem(store, runId, lease, { leaseMs = 500 } = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 3_600_000) {
    fail('STORE_SCHEMA_INVALID', 'Heartbeat leaseMs must be an integer from 100 through 3600000.');
  }
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  validateWorkLease(state, lease);
  const body = {
    schemaVersion: 1,
    kind: 'attempt-heartbeat-inbox',
    runId,
    workItemId: lease.workItemId,
    workerId: lease.workerId,
    attempt: lease.attempt,
    coordinatorEpoch: lease.epoch,
    leaseToken: lease.token,
    publishedAt: timestamp(store),
    requestedExpiresAt: new Date(store.clock() + leaseMs).toISOString(),
  };
  const document = { ...body, digest: canonicalDigest(body) };
  const relativePath = path.join('inboxes', lease.workItemId,
    `${String(lease.attempt).padStart(6, '0')}-${lease.token}-heartbeat-${store.storage.nonce()}.json`);
  await atomicWriteJson(store.storage, path.join(runDirectory(store, runId), relativePath), document, { exclusive: true });
  return { relativePath, digest: document.digest, workItemId: lease.workItemId, leaseToken: lease.token };
}

export async function adoptWorkHeartbeat(store, runId, coordinator, receipt) {
  const document = await readBoundedJson(store.storage, containedPath(runDirectory(store, runId), receipt.relativePath), {
    label: 'attempt heartbeat inbox', maximumBytes: 16_384,
  });
  const { digest, ...body } = document;
  exactKeys(document, [
    'schemaVersion', 'kind', 'runId', 'workItemId', 'workerId', 'attempt', 'coordinatorEpoch',
    'leaseToken', 'publishedAt', 'requestedExpiresAt', 'digest',
  ], 'attempt heartbeat inbox');
  const publishedAt = canonicalTimestamp(document.publishedAt, 'heartbeat publishedAt');
  const requestedExpiresAt = canonicalTimestamp(document.requestedExpiresAt, 'heartbeat requestedExpiresAt');
  if (document.schemaVersion !== 1 || document.kind !== 'attempt-heartbeat-inbox' || document.runId !== runId
    || document.workItemId !== receipt.workItemId || document.leaseToken !== receipt.leaseToken
    || !SAFE_ID.test(document.workItemId) || !SAFE_ID.test(document.workerId)
    || !Number.isSafeInteger(document.attempt) || document.attempt < 1
    || !Number.isSafeInteger(document.coordinatorEpoch) || document.coordinatorEpoch < 1
    || Date.parse(requestedExpiresAt) <= Date.parse(publishedAt)
    || Date.parse(requestedExpiresAt) - Date.parse(publishedAt) > 3_600_000
    || digest !== receipt.digest || digest !== canonicalDigest(body)) fail('STORE_CORRUPT', 'Attempt heartbeat inbox is corrupt.');
  let renewed;
  await mutate(store, runId, { coordinator, type: 'work-item-heartbeat-adopted', data: { workItemId: document.workItemId } }, (state) => {
    const item = state.workItems[document.workItemId];
    if (!item || item.state !== 'running' || !item.lease
      || item.lease.token !== document.leaseToken || item.lease.workerId !== document.workerId
      || item.lease.attempt !== document.attempt || item.lease.epoch !== document.coordinatorEpoch
      || Date.parse(document.publishedAt) > Date.parse(item.lease.expiresAt)) {
      fail('STALE_WORK_LEASE', 'Heartbeat was published after its fenced lease expired.');
    }
    renewed = { ...item.lease, expiresAt: document.requestedExpiresAt };
    item.lease = renewed;
  });
  return clone(renewed);
}

export async function requeueExpiredWork(store, runId, coordinator) {
  let count = 0;
  await mutate(store, runId, { coordinator, type: 'expired-work-requeued' }, (state) => {
    for (const item of Object.values(state.workItems)) {
      if (item.state !== 'running' || Date.parse(item.lease.expiresAt) > store.clock()) continue;
      item.attempts.push({
        attempt: item.lease.attempt,
        outcome: 'operational_failure',
        evidenceDigests: [],
        workerId: item.lease.workerId,
        completedAt: timestamp(store),
        reason: 'lease-expired',
      });
      item.lease = null;
      item.state = item.attempts.length >= item.maxAttempts ? 'incomplete' : 'queued';
      count += 1;
    }
  });
  return count;
}

export async function publishAttemptEvidence(store, runId, lease, result) {
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  validateWorkLease(state, lease);
  if (!WORK_OUTCOMES.has(result?.outcome) || !Array.isArray(result.evidenceDigests)
    || result.evidenceDigests.some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest))) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence outcome or digests are invalid.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'attempt-evidence-inbox',
    runId,
    workItemId: lease.workItemId,
    workerId: lease.workerId,
    attempt: lease.attempt,
    coordinatorEpoch: lease.epoch,
    leaseToken: lease.token,
    outcome: result.outcome,
    evidenceDigests: [...result.evidenceDigests],
    publishedAt: timestamp(store),
  };
  const document = { ...body, digest: canonicalDigest(body) };
  const relativePath = path.join('inboxes', lease.workItemId, `${String(lease.attempt).padStart(6, '0')}-${lease.token}.json`);
  await atomicWriteJson(store.storage, path.join(runDirectory(store, runId), relativePath), document, { exclusive: true });
  return { runId, workItemId: lease.workItemId, attempt: lease.attempt, leaseToken: lease.token, relativePath, digest: document.digest };
}

export async function appendAttemptLog(store, runId, lease, entry) {
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  validateWorkLease(state, lease);
  if (!Number.isSafeInteger(entry?.sequence) || entry.sequence < 1
    || !['debug', 'info', 'warn', 'error'].includes(entry.level)
    || typeof entry.message !== 'string' || entry.message.length === 0 || entry.message.length > 4_096) {
    fail('STORE_SCHEMA_INVALID', 'Attempt log entry is invalid or exceeds its bound.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'attempt-log-inbox',
    runId,
    workItemId: lease.workItemId,
    workerId: lease.workerId,
    attempt: lease.attempt,
    coordinatorEpoch: lease.epoch,
    leaseToken: lease.token,
    sequence: entry.sequence,
    level: entry.level,
    message: entry.message,
    occurredAt: timestamp(store),
  };
  const document = { ...body, digest: canonicalDigest(body) };
  const file = path.join(runDirectory(store, runId), 'inboxes', lease.workItemId, 'logs',
    `${String(lease.attempt).padStart(6, '0')}-${lease.token}-${String(entry.sequence).padStart(8, '0')}.json`);
  await atomicWriteJson(store.storage, file, document, { exclusive: true });
  return { digest: document.digest, sequence: entry.sequence };
}

export async function adoptAttemptEvidence(store, runId, coordinator, inbox) {
  const file = containedPath(runDirectory(store, runId), inbox.relativePath);
  const document = await readBoundedJson(store.storage, file, { label: 'attempt evidence inbox' });
  const { digest, ...body } = document;
  exactKeys(document, [
    'schemaVersion', 'kind', 'runId', 'workItemId', 'workerId', 'attempt', 'coordinatorEpoch',
    'leaseToken', 'outcome', 'evidenceDigests', 'publishedAt', 'digest',
  ], 'attempt evidence inbox');
  canonicalTimestamp(document.publishedAt, 'attempt evidence publishedAt');
  if (document.schemaVersion !== 1 || document.kind !== 'attempt-evidence-inbox' || document.runId !== runId
    || document.workItemId !== inbox.workItemId || document.attempt !== inbox.attempt
    || document.leaseToken !== inbox.leaseToken || !SAFE_ID.test(document.workItemId) || !SAFE_ID.test(document.workerId)
    || !Number.isSafeInteger(document.attempt) || document.attempt < 1
    || !Number.isSafeInteger(document.coordinatorEpoch) || document.coordinatorEpoch < 1
    || !WORK_OUTCOMES.has(document.outcome) || !Array.isArray(document.evidenceDigests)
    || document.evidenceDigests.some((entry) => !DIGEST_PATTERN.test(entry))
    || digest !== canonicalDigest(body) || digest !== inbox.digest) fail('STORE_CORRUPT', 'Attempt evidence inbox is corrupt.');
  let adopted;
  await mutate(store, runId, { coordinator, type: 'attempt-evidence-adopted', data: { workItemId: document.workItemId, digest } }, (state) => {
    const item = validateWorkLease(state, {
      workItemId: document.workItemId,
      workerId: document.workerId,
      attempt: document.attempt,
      epoch: document.coordinatorEpoch,
      token: document.leaseToken,
    });
    const canonicalResult = sealWorkItemResult({
      schemaVersion: 1,
      workItemId: document.workItemId,
      subjectCoreDigest: state.subjectCoreDigest,
      attempt: document.attempt,
      authoritative: true,
      outcome: document.outcome,
      evidenceDigests: document.evidenceDigests,
    });
    const attempt = {
      attempt: document.attempt,
      outcome: document.outcome,
      evidenceDigests: document.evidenceDigests,
      workerId: document.workerId,
      completedAt: timestamp(store),
      reason: null,
      inboxDigest: digest,
      canonicalResultDigest: canonicalResult.digest,
    };
    item.attempts.push(attempt);
    item.lease = null;
    if (document.outcome === 'completed_pass' || document.outcome === 'completed_product_failure') {
      item.state = document.outcome;
      item.canonicalResult = canonicalResult;
    } else if (document.outcome === 'operational_failure' && item.attempts.length < item.maxAttempts) {
      item.state = 'queued';
    } else {
      item.state = document.outcome === 'cancelled' ? 'cancelled' : 'incomplete';
    }
    adopted = clone(item);
  });
  return adopted;
}

export async function cancelParentRun(store, runId, coordinator, input) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator);
    if (state.status === 'cancelled') {
      delete state.clockNow;
      return state;
    }
    return appendMutationUnlocked(store, state, 'mutation', 'parent-run-cancelled', (next) => {
      next.status = 'cancelled';
      for (const item of Object.values(next.workItems)) {
        if (!['completed_pass', 'completed_product_failure'].includes(item.state)) {
          item.state = 'cancelled';
          item.lease = null;
        }
      }
    }, { actor: input.actor, data: { reason: input.reason } });
  }));
}

function operationBodyDigest(request) {
  return canonicalDigest({ kind: request.kind, actor: request.actor, body: request.body });
}

export async function acceptOperation(store, runId, request) {
  safeId(request?.idempotencyKey, 'idempotencyKey');
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    const digest = operationBodyDigest(request);
    const existing = state.operations[request.idempotencyKey];
    if (existing) {
      if (existing.bodyDigest !== digest) fail('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different operation body.');
      return clone(existing);
    }
    const operation = {
      operationId: createHash('sha256').update(`${runId}\0${request.idempotencyKey}`).digest('hex'),
      idempotencyKey: request.idempotencyKey,
      kind: request.kind,
      bodyDigest: digest,
      actor: request.actor,
      state: 'accepted',
      acceptedAt: timestamp(store),
      completedAt: null,
      outcome: null,
    };
    await appendMutationUnlocked(store, state, 'operation', 'operation-accepted', (next) => {
      next.operations[request.idempotencyKey] = operation;
    }, { actor: request.actor, data: { idempotencyKey: request.idempotencyKey } });
    return clone(operation);
  }));
}

export async function getOperation(store, runId, idempotencyKey) {
  const state = await recoverUnlocked(store, runId);
  const operation = state.operations[idempotencyKey];
  if (!operation) fail('OPERATION_NOT_FOUND', `Operation ${idempotencyKey} was not found.`);
  return clone(operation);
}

export async function completeOperation(store, runId, coordinator, operationId, outcome) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator);
    const operation = Object.values(state.operations).find((candidate) => candidate.operationId === operationId);
    if (!operation) fail('OPERATION_NOT_FOUND', `Operation ${operationId} was not found.`);
    if (operation.state === 'completed') {
      if (canonicalJson(operation.outcome) !== canonicalJson(outcome)) fail('IDEMPOTENCY_CONFLICT', 'Completed operation outcome cannot be rewritten.');
      return clone(operation);
    }
    let completed;
    await appendMutationUnlocked(store, state, 'operation', 'operation-completed', (next) => {
      const mutable = Object.values(next.operations).find((candidate) => candidate.operationId === operationId);
      mutable.state = 'completed';
      mutable.completedAt = timestamp(store);
      mutable.outcome = outcome;
      completed = mutable;
    }, { data: { operationId } });
    return clone(completed);
  }));
}

export async function appendRiskLifecycleEvent(store, runId, coordinator, input) {
  if (input?.releaseEffect !== 'non-blocking') fail('RISK_CANNOT_AFFECT_RELEASE', 'Risk lifecycle history cannot mutate release truth.');
  return mutate(store, runId, {
    coordinator,
    kind: 'risk',
    type: input.type,
    actor: input.actor,
    data: {
      riskIdentity: input.riskIdentity,
      from: input.from ?? null,
      to: input.to,
      releaseEffect: 'non-blocking',
    },
  }, () => {});
}

export async function appendMutationAuditEvent(store, runId, coordinator, input) {
  return mutate(store, runId, {
    coordinator,
    kind: 'mutation',
    type: input.type,
    actor: input.actor,
    data: input.data ?? null,
  }, () => {});
}

export async function readRunHistories(store, runId) {
  await recoverUnlocked(store, runId);
  return readAllLedgers(store.storage, runDirectory(store, runId));
}

function publicationPath(store, runId, digest) {
  return path.join(runDirectory(store, runId), 'publications', `${digest.slice('sha256:'.length)}.json`);
}

async function readPublicationByDigest(store, runId, digest) {
  const document = await readBoundedJson(store.storage, publicationPath(store, runId, digest), { label: 'publication envelope', maximumBytes: 16 * 1_048_576 });
  try { return parsePublicationEnvelope(document); } catch (error) {
    fail('STORE_CORRUPT', 'Publication envelope is corrupt.', { cause: error?.code ?? error?.message });
  }
}

async function readPublicationChain(store, runId, digest) {
  const newestFirst = [];
  const seen = new Set();
  let cursor = digest;
  while (cursor !== null) {
    if (seen.has(cursor)) fail('STORE_CORRUPT', 'Publication envelope chain contains a cycle.');
    seen.add(cursor);
    const envelope = await readPublicationByDigest(store, runId, cursor);
    newestFirst.push(envelope);
    cursor = envelope.previousEnvelopeDigest;
  }
  try { return verifyPublicationChain(newestFirst.reverse()); } catch (error) {
    fail('STORE_CORRUPT', 'Publication envelope digest chain is corrupt.', { cause: error?.code ?? error?.message });
  }
}

export async function publishCurrentEnvelope(store, runId, coordinator, envelopeValue, hooks = {}) {
  const envelope = parsePublicationEnvelope(envelopeValue);
  if (envelope.runId !== runId) fail('STORE_SCHEMA_INVALID', 'Publication envelope belongs to a different run.');
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator);
    if (state.compilationState !== 'sealed' || !state.executionManifestDigest || !state.finalSubjectDigest) {
      fail('SEALED_MANIFEST_MISSING', 'Release authority is unavailable until the parent-run graph is sealed.');
    }
    if (envelope.finalSubjectDigest !== state.finalSubjectDigest
      || envelope.decision.executionManifestDigest !== state.executionManifestDigest) {
      fail('RELEASE_SUBJECT_MISMATCH', 'Publication envelope does not match the sealed parent-run subject.');
    }
    const histories = await readAllLedgers(store.storage, runDirectory(store, runId));
    // U1's publication contract names the release projections: observations
    // are canonical graph/mutation history, decisions and risks map directly.
    // Durable operation history remains independently revisioned and is not
    // folded into release evidence.
    const expectedLedgerSequences = {
      observations: histories.mutation.length,
      decisions: histories.decision.length + 1,
      risks: histories.risk.length,
    };
    if (canonicalJson(envelope.ledgerSequences) !== canonicalJson(expectedLedgerSequences)) {
      fail('PUBLICATION_LEDGER_MISMATCH', 'Publication envelope does not name the exact durable ledger sequences.');
    }
    if (state.currentPublicationDigest !== null && envelope.previousEnvelopeDigest !== state.currentPublicationDigest) {
      if (state.currentPublicationDigest === envelope.digest) {
        await atomicWriteJson(store.storage, path.join(runDirectory(store, runId), 'publication-head.json'), {
          schemaVersion: 1, kind: 'publication-head', runId, envelopeDigest: envelope.digest,
        });
        return envelope;
      }
      fail('PUBLICATION_HEAD_CONFLICT', 'Publication does not extend the current immutable envelope.');
    }
    const immutablePath = publicationPath(store, runId, envelope.digest);
    if (await pathExists(store.storage.fs, immutablePath)) {
      const existing = await readPublicationByDigest(store, runId, envelope.digest);
      if (canonicalJson(existing) !== canonicalJson(envelope)) fail('STORE_CORRUPT', 'Immutable publication digest was reused with different bytes.');
    } else {
      await atomicWriteJson(store.storage, immutablePath, envelope, { exclusive: true });
    }
    await hooks.afterEnvelopePersist?.(envelope);
    const next = await appendMutationUnlocked(store, state, 'decision', 'publication-head-advanced', (candidate) => {
      candidate.currentPublicationDigest = envelope.digest;
    }, { data: { envelopeDigest: envelope.digest, decisionRevision: envelope.decisionRevision } });
    await hooks.afterDecisionPersist?.(envelope);
    await atomicWriteJson(store.storage, path.join(runDirectory(store, runId), 'publication-head.json'), {
      schemaVersion: 1, kind: 'publication-head', runId, envelopeDigest: envelope.digest,
    });
    return parsePublicationEnvelope(await readPublicationByDigest(store, runId, next.currentPublicationDigest));
  }));
}

export async function readCurrentEnvelope(store, runId) {
  const state = await recoverUnlocked(store, runId);
  if (state.currentPublicationDigest === null) fail('PUBLICATION_UNAVAILABLE', 'Parent run has no current publication.');
  let head;
  try {
    head = await readBoundedJson(store.storage, path.join(runDirectory(store, runId), 'publication-head.json'), { label: 'publication head' });
  } catch (error) {
    if (error?.code === 'ATOMIC_NOT_FOUND') head = null;
    else throw error;
  }
  if (head !== null && (head?.schemaVersion !== 1 || head.kind !== 'publication-head' || head.runId !== runId)) {
    fail('STORE_CORRUPT', 'Publication head is invalid.');
  }
  if (head?.envelopeDigest !== state.currentPublicationDigest) {
    // A durable decision event is the commit record. If a process died after
    // that fsync but before the pointer rename, recovery completes only the
    // pointer swap after validating the entire immutable envelope chain.
    await readPublicationChain(store, runId, state.currentPublicationDigest);
    head = {
      schemaVersion: 1, kind: 'publication-head', runId, envelopeDigest: state.currentPublicationDigest,
    };
    await atomicWriteJson(store.storage, path.join(runDirectory(store, runId), 'publication-head.json'), head);
  }
  const current = (await readPublicationChain(store, runId, head.envelopeDigest)).at(-1);
  if (current.digest !== state.currentPublicationDigest) {
    fail('STORE_CORRUPT', 'Publication head disagrees with canonical recovered state.');
  }
  return current;
}
