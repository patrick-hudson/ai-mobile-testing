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
  atomicWriteFile,
  containedPath,
  fsyncDirectory,
  openAtomicStorage,
  pathExists,
  readBoundedJson,
  readBoundedFile,
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
const CAPABILITY_PATTERN = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/;
const RESOURCE_CLASSES = new Set(['ordinary', 'performance']);
export const MAX_ATTEMPT_ARTIFACTS = 64;
export const MAX_ATTEMPT_ARTIFACT_BYTES = 8 * 1_048_576;
export const MAX_ATTEMPT_EVIDENCE_BYTES = 16 * 1_048_576;
const ARTIFACT_MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i;

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

function schedulingCapability(value, label = 'capability') {
  if (typeof value !== 'string' || !CAPABILITY_PATTERN.test(value) || value.length > 128) {
    fail('STORE_SCHEMA_INVALID', `${label} is invalid.`);
  }
  return value;
}

function schedulingString(value, label, { nullable = false, maximum = 512 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) {
    fail('STORE_SCHEMA_INVALID', `${label} is invalid.`);
  }
  return value;
}

function artifactName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 || value.includes('\\') || value.includes('\0')) {
    fail('STORE_SCHEMA_INVALID', 'Artifact name is invalid.');
  }
  const segments = value.split('/');
  if (value.startsWith('/') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('STORE_SCHEMA_INVALID', 'Artifact name must be a normalized relative path.');
  }
  return value;
}

function decodeArtifactUpload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 5
    || !['name', 'mediaType', 'sizeBytes', 'digest', 'contentBase64'].every((key) => key in value)) {
    fail('STORE_SCHEMA_INVALID', 'Artifact upload has an invalid schema.');
  }
  const name = artifactName(value.name);
  if (typeof value.mediaType !== 'string' || !ARTIFACT_MEDIA_TYPE.test(value.mediaType)) {
    fail('STORE_SCHEMA_INVALID', 'Artifact media type is invalid.');
  }
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_ATTEMPT_ARTIFACT_BYTES
    || typeof value.contentBase64 !== 'string' || value.contentBase64.length === 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.contentBase64)) {
    fail('STORE_SCHEMA_INVALID', 'Artifact upload size or encoding is invalid.');
  }
  const bytes = Buffer.from(value.contentBase64, 'base64');
  if (bytes.length !== value.sizeBytes || bytes.toString('base64') !== value.contentBase64) {
    fail('STORE_SCHEMA_INVALID', 'Artifact upload size does not match its canonical base64 content.');
  }
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (value.digest !== digest) fail('ARTIFACT_DIGEST_MISMATCH', `Artifact ${name} digest does not match its bytes.`);
  return { name, mediaType: value.mediaType.toLowerCase(), sizeBytes: bytes.length, digest, bytes };
}

function validateArtifactRecord(value, { runId, workItemId, attempt, leaseToken }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 5
    || !['name', 'mediaType', 'sizeBytes', 'digest', 'relativePath'].every((key) => key in value)) {
    fail('STORE_CORRUPT', 'Stored artifact record has an invalid schema.');
  }
  let name;
  try { name = artifactName(value.name); } catch {
    fail('STORE_CORRUPT', 'Stored artifact name is invalid.');
  }
  if (typeof value.mediaType !== 'string' || !ARTIFACT_MEDIA_TYPE.test(value.mediaType)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_ATTEMPT_ARTIFACT_BYTES
    || !DIGEST_PATTERN.test(value.digest)) {
    fail('STORE_CORRUPT', 'Stored artifact metadata is invalid.');
  }
  const expected = path.posix.join('evidence', workItemId, `${String(attempt).padStart(6, '0')}-${leaseToken}`, name);
  if (value.relativePath !== expected || value.relativePath.includes('\\') || value.relativePath.startsWith('/')) {
    fail('STORE_CORRUPT', `Stored artifact path escaped attempt ${runId}/${workItemId}.`);
  }
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

function nextTimestamp(store, previous) {
  const clockTime = store.clock();
  const previousTime = previous === null || previous === undefined ? Number.NEGATIVE_INFINITY : Date.parse(previous);
  return new Date(Math.max(clockTime, previousTime + 1)).toISOString();
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
  snapshot.authorityTombstone ??= null;
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
  if (snapshot.authorityTombstone !== null && (
    snapshot.authorityTombstone?.schemaVersion !== 1
    || snapshot.authorityTombstone.kind !== 'release-authority-tombstone'
    || snapshot.authorityTombstone.runId !== runId
    || !canonicalTimestamp(snapshot.authorityTombstone.tombstonedAt, 'authority tombstonedAt')
    || typeof snapshot.authorityTombstone.reason !== 'string'
    || !snapshot.authorityTombstone.reason
  )) fail('STORE_CORRUPT', `Parent run ${runId} has an invalid authority tombstone.`);
  for (const [id, item] of Object.entries(snapshot.workItems)) {
    item.manualRekicks ??= 0;
    if (item?.id !== id || !SAFE_ID.test(id) || !Number.isSafeInteger(item.maxAttempts) || item.maxAttempts < 1
      || !['queued', 'running', 'completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(item.state)
      || !Array.isArray(item.attempts)
      || !CAPABILITY_PATTERN.test(item.capability)
      || !RESOURCE_CLASSES.has(item.resourceClass)
      || typeof item.targetId !== 'string'
      || (item.specAffinity !== null && typeof item.specAffinity !== 'string')
      || !Number.isSafeInteger(item.manualRekicks) || item.manualRekicks < 0 || item.manualRekicks > 3) {
      fail('STORE_CORRUPT', `Parent run ${runId} has invalid work-item state.`);
    }
  }
  if (typeof snapshot.runnerRevision !== 'string' || !snapshot.runnerRevision
    || !snapshot.resourceScheduling || typeof snapshot.resourceScheduling !== 'object'
    || !('performanceDrain' in snapshot.resourceScheduling) || !('exclusiveLease' in snapshot.resourceScheduling)) {
    fail('STORE_CORRUPT', `Parent run ${runId} has invalid shared-worker scheduling state.`);
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
  next.updatedAt = nextTimestamp(store, state.updatedAt);
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
  const runnerRevision = schedulingString(input.runnerRevision ?? 'legacy-runner', 'runnerRevision', { maximum: 256 });
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
      const capability = schedulingCapability(item.capability ?? 'browser:any', `Work item ${id} capability`);
      const resourceClass = item.resourceClass ?? 'ordinary';
      if (!RESOURCE_CLASSES.has(resourceClass)) fail('STORE_SCHEMA_INVALID', `Work item ${id} resourceClass is invalid.`);
      workItems[id] = {
        id,
        capability,
        resourceClass,
        targetId: schedulingString(item.targetId ?? 'unspecified-target', `Work item ${id} targetId`, { maximum: 128 }),
        specAffinity: schedulingString(item.specAffinity ?? null, `Work item ${id} specAffinity`, { nullable: true, maximum: 512 }),
        state: 'queued',
        maxAttempts: item.maxAttempts,
        lease: null,
        attempts: [],
        manualRekicks: 0,
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
      runnerRevision,
      createdAt,
      updatedAt: createdAt,
      coordinator: null,
      workItems,
      resourceScheduling: {
        performanceDrain: null,
        exclusiveLease: null,
      },
      operations: {},
      authorityTombstone: null,
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

function validatedWorkerScheduling(input) {
  const workerId = safeId(input?.workerId, 'workerId');
  const capabilities = input.capabilities ?? ['browser:any'];
  const resourceClasses = input.resourceClasses ?? ['ordinary'];
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > 32) {
    fail('STORE_SCHEMA_INVALID', 'Worker capabilities must be a bounded non-empty array.');
  }
  if (!Array.isArray(resourceClasses) || resourceClasses.length !== 1
    || resourceClasses.some((entry) => !RESOURCE_CLASSES.has(entry))) {
    fail('STORE_SCHEMA_INVALID', 'A worker must declare exactly one resource class.');
  }
  const normalizedCapabilities = [...new Set(capabilities.map((entry) => schedulingCapability(entry, 'worker capability')))].sort();
  const normalizedResourceClasses = [...new Set(resourceClasses)].sort();
  return { workerId, capabilities: normalizedCapabilities, resourceClasses: normalizedResourceClasses };
}

function workerCanRun(item, worker) {
  return worker.resourceClasses.includes(item.resourceClass)
    && (item.capability === 'browser:any'
      || worker.capabilities.includes('browser:any')
      || worker.capabilities.includes(item.capability));
}

export async function requestPerformanceDrain(store, runId, coordinator, input) {
  const worker = validatedWorkerScheduling({
    workerId: input?.workerId,
    capabilities: ['performance:lighthouse'],
    resourceClasses: ['performance'],
  });
  const leaseMs = input?.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
    fail('STORE_SCHEMA_INVALID', 'Performance drain leaseMs must be an integer from 1000 through 3600000.');
  }
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator);
    const existing = state.resourceScheduling.performanceDrain;
    if (existing && Date.parse(existing.expiresAt) > store.clock()) {
      if (existing.workerId !== worker.workerId || existing.coordinatorEpoch !== coordinator.epoch) {
        fail('PERFORMANCE_DRAIN_HELD', 'Another worker already holds the active performance drain.');
      }
      return clone(existing);
    }
    if (state.resourceScheduling.exclusiveLease) fail('PERFORMANCE_LEASE_HELD', 'A performance resource lease is already active.');
    const eligible = Object.values(state.workItems).some((item) => item.resourceClass === 'performance' && item.state === 'queued');
    if (!eligible) fail('NO_PERFORMANCE_WORK', 'No queued performance work item is available.');
    const drain = {
      workerId: worker.workerId,
      requestedAt: timestamp(store),
      expiresAt: new Date(store.clock() + leaseMs).toISOString(),
      coordinatorEpoch: coordinator.epoch,
    };
    await appendMutationUnlocked(store, state, 'mutation', 'performance-drain-requested', (next) => {
      next.resourceScheduling.performanceDrain = drain;
    }, { data: { workerId: worker.workerId } });
    return clone(drain);
  }));
}

export async function claimWorkItem(store, runId, coordinator, input) {
  if (!Number.isSafeInteger(input?.leaseMs) || input.leaseMs < 100 || input.leaseMs > 3_600_000) {
    fail('STORE_SCHEMA_INVALID', 'Work-item leaseMs must be an integer from 100 through 3600000.');
  }
  const worker = validatedWorkerScheduling(input);
  let claimed;
  await mutate(store, runId, { coordinator, type: 'work-item-claimed', data: { workerId: worker.workerId } }, (state) => {
    if (state.status === 'cancelled') fail('RUN_CANCELLED', `Parent run ${runId} is cancelled.`);
    let drain = state.resourceScheduling.performanceDrain;
    if (drain && Date.parse(drain.expiresAt) <= store.clock()) {
      state.resourceScheduling.performanceDrain = null;
      drain = null;
    }
    const wantsPerformance = worker.resourceClasses.includes('performance');
    if (drain && !wantsPerformance) fail('PERFORMANCE_DRAINING', 'Ordinary claims are paused for an exclusive performance execution.');
    if (wantsPerformance && !drain) fail('PERFORMANCE_DRAIN_REQUIRED', 'Performance work requires an active coordinator drain.');
    if (drain && Object.values(state.workItems).some((item) => item.resourceClass === 'ordinary' && item.state === 'running')) {
      fail('PERFORMANCE_DRAIN_PENDING', 'Performance work is waiting for active ordinary browser work to drain.');
    }
    if (state.resourceScheduling.exclusiveLease) fail('PERFORMANCE_LEASE_HELD', 'A performance resource lease is already active.');
    const requested = input.workItemId
      ? state.workItems[input.workItemId]
      : Object.values(state.workItems).find((item) => item.state === 'queued' && workerCanRun(item, worker));
    if (!requested) {
      const queued = Object.values(state.workItems).some(({ state: workState }) => workState === 'queued');
      fail(queued ? 'NO_COMPATIBLE_WORK' : 'NO_WORK_AVAILABLE', queued
        ? 'No queued work item matches this worker capability.'
        : 'No queued work item is available.');
    }
    if (input.workItemId && requested.state !== 'queued') {
      if (['completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(requested.state)) {
        fail('WORK_ITEM_TERMINAL', `Work item ${requested.id} is terminal.`);
      }
      fail('WORK_ITEM_LEASE_HELD', `Work item ${requested.id} already has an active lease.`);
    }
    if (!workerCanRun(requested, worker)) fail('WORKER_CAPABILITY_MISMATCH', `Worker cannot execute ${requested.id}.`);
    if (requested.resourceClass === 'performance' && !drain) {
      fail('PERFORMANCE_DRAIN_REQUIRED', 'Performance work requires an active coordinator drain.');
    }
    if (requested.resourceClass === 'ordinary' && drain) {
      fail('PERFORMANCE_DRAINING', 'Ordinary claims are paused for an exclusive performance execution.');
    }
    const attempt = requested.attempts.length + 1;
    claimed = {
      runId,
      workItemId: requested.id,
      workerId: worker.workerId,
      attempt,
      epoch: coordinator.epoch,
      token: store.storage.nonce(),
      claimedAt: timestamp(store),
      expiresAt: new Date(store.clock() + input.leaseMs).toISOString(),
      subjectCoreDigest: state.subjectCoreDigest,
      runnerRevision: state.runnerRevision,
      capability: requested.capability,
      resourceClass: requested.resourceClass,
      targetId: requested.targetId,
      specAffinity: requested.specAffinity,
    };
    requested.state = 'running';
    requested.lease = claimed;
    if (requested.resourceClass === 'performance') {
      state.resourceScheduling.exclusiveLease = {
        workItemId: requested.id,
        workerId: worker.workerId,
        attempt,
        leaseToken: claimed.token,
        coordinatorEpoch: coordinator.epoch,
        acquiredAt: claimed.claimedAt,
        expiresAt: claimed.expiresAt,
      };
    }
  });
  return clone(claimed);
}

function validateWorkLease(state, lease) {
  if (lease?.runId !== undefined && lease.runId !== state.runId) {
    fail('WORK_RESULT_BINDING_MISMATCH', 'Work-item lease belongs to a different parent run.');
  }
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
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator);
    const expiredIds = Object.values(state.workItems)
      .filter((item) => item.state === 'running' && Date.parse(item.lease.expiresAt) <= store.clock())
      .map((item) => item.id);
    const drainExpired = state.resourceScheduling.performanceDrain
      && Date.parse(state.resourceScheduling.performanceDrain.expiresAt) <= store.clock();
    const exclusiveExpired = state.resourceScheduling.exclusiveLease
      && Date.parse(state.resourceScheduling.exclusiveLease.expiresAt) <= store.clock();
    if (expiredIds.length === 0 && !drainExpired && !exclusiveExpired) return 0;
    await appendMutationUnlocked(store, state, 'mutation', 'expired-work-requeued', (next) => {
      for (const id of expiredIds) {
        const item = next.workItems[id];
        item.attempts.push({
          attempt: item.lease.attempt,
          outcome: 'operational_failure',
          evidenceDigests: [],
          artifacts: [],
          workerId: item.lease.workerId,
          completedAt: timestamp(store),
          reason: 'lease-expired',
        });
        item.lease = null;
        item.state = item.attempts.length >= item.maxAttempts ? 'incomplete' : 'queued';
      }
      if (exclusiveExpired || expiredIds.some((id) => next.workItems[id].resourceClass === 'performance')) {
        next.resourceScheduling.exclusiveLease = null;
      }
      if (drainExpired || expiredIds.some((id) => next.workItems[id].resourceClass === 'performance'
        && next.workItems[id].state === 'incomplete')) {
        next.resourceScheduling.performanceDrain = null;
      }
    });
    return expiredIds.length;
  }));
}

export async function publishAttemptEvidence(store, runId, lease, result) {
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  validateWorkLease(state, lease);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).some((key) => !['outcome', 'reason', 'artifacts'].includes(key))
    || !WORK_OUTCOMES.has(result?.outcome) || !Array.isArray(result.artifacts)
    || result.artifacts.length > MAX_ATTEMPT_ARTIFACTS) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence outcome or artifacts are invalid.');
  }
  const uploads = result.artifacts.map(decodeArtifactUpload);
  if (new Set(uploads.map(({ name }) => name)).size !== uploads.length) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence contains a duplicate artifact name.');
  }
  if (new Set(uploads.map(({ digest }) => digest)).size !== uploads.length) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence contains duplicate artifact content.');
  }
  if (uploads.reduce((total, artifact) => total + artifact.sizeBytes, 0) > MAX_ATTEMPT_EVIDENCE_BYTES) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence exceeds the total byte bound.');
  }
  const attemptDirectory = path.posix.join('evidence', lease.workItemId,
    `${String(lease.attempt).padStart(6, '0')}-${lease.token}`);
  const artifacts = [];
  for (const upload of uploads) {
    const relativePath = path.posix.join(attemptDirectory, upload.name);
    const artifactPath = containedPath(runDirectory(store, runId), ...relativePath.split('/'));
    try {
      await atomicWriteFile(store.storage, artifactPath, upload.bytes, { exclusive: true });
    } catch (error) {
      if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
      const existing = await readBoundedFile(store.storage, artifactPath, {
        label: `attempt artifact ${upload.name}`, maximumBytes: MAX_ATTEMPT_ARTIFACT_BYTES,
      });
      const existingDigest = `sha256:${createHash('sha256').update(existing).digest('hex')}`;
      if (existing.length !== upload.sizeBytes || existingDigest !== upload.digest) {
        fail('STORE_CORRUPT', `Immutable attempt artifact ${upload.name} was replaced with different bytes.`);
      }
    }
    artifacts.push({
      name: upload.name,
      mediaType: upload.mediaType,
      sizeBytes: upload.sizeBytes,
      digest: upload.digest,
      relativePath,
    });
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
    subjectCoreDigest: lease.subjectCoreDigest ?? state.subjectCoreDigest,
    runnerRevision: lease.runnerRevision ?? state.runnerRevision,
    outcome: result.outcome,
    reason: schedulingString(result.reason ?? null, 'Attempt evidence reason', { nullable: true, maximum: 256 }),
    evidenceDigests: artifacts.map(({ digest }) => digest),
    artifacts,
    publishedAt: timestamp(store),
  };
  const document = { ...body, digest: canonicalDigest(body) };
  const relativePath = path.join('inboxes', lease.workItemId, `${String(lease.attempt).padStart(6, '0')}-${lease.token}.json`);
  const inboxPath = path.join(runDirectory(store, runId), relativePath);
  let inboxDigest = document.digest;
  try {
    await atomicWriteJson(store.storage, inboxPath, document, { exclusive: true });
  } catch (error) {
    if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
    const existing = await readBoundedJson(store.storage, inboxPath, { label: 'attempt evidence inbox' });
    const { digest: existingDigest, publishedAt: existingPublishedAt, ...existingStable } = existing;
    const desiredStable = { ...body };
    delete desiredStable.publishedAt;
    if (!DIGEST_PATTERN.test(existingDigest) || canonicalDigest({ ...existingStable, publishedAt: existingPublishedAt }) !== existingDigest
      || canonicalJson(existingStable) !== canonicalJson(desiredStable)) {
      fail('STORE_CORRUPT', 'Immutable attempt evidence inbox was replaced with different content.');
    }
    inboxDigest = existingDigest;
  }
  return { runId, workItemId: lease.workItemId, attempt: lease.attempt, leaseToken: lease.token, relativePath, digest: inboxDigest };
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
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
  const state = await recoverUnlocked(store, runId);
  await validateCoordinator(store, coordinator);
  const file = containedPath(runDirectory(store, runId), inbox.relativePath);
  const document = await readBoundedJson(store.storage, file, { label: 'attempt evidence inbox' });
  const { digest, ...body } = document;
  exactKeys(document, [
    'schemaVersion', 'kind', 'runId', 'workItemId', 'workerId', 'attempt', 'coordinatorEpoch',
    'leaseToken', 'subjectCoreDigest', 'runnerRevision', 'outcome', 'reason', 'evidenceDigests', 'artifacts', 'publishedAt', 'digest',
  ], 'attempt evidence inbox');
  canonicalTimestamp(document.publishedAt, 'attempt evidence publishedAt');
  if (document.schemaVersion !== 1 || document.kind !== 'attempt-evidence-inbox' || document.runId !== runId
    || document.workItemId !== inbox.workItemId || document.attempt !== inbox.attempt
    || document.leaseToken !== inbox.leaseToken || !SAFE_ID.test(document.workItemId) || !SAFE_ID.test(document.workerId)
    || !Number.isSafeInteger(document.attempt) || document.attempt < 1
    || !Number.isSafeInteger(document.coordinatorEpoch) || document.coordinatorEpoch < 1
    || !WORK_OUTCOMES.has(document.outcome) || !Array.isArray(document.evidenceDigests) || !Array.isArray(document.artifacts)
    || (document.reason !== null && (typeof document.reason !== 'string' || !document.reason || document.reason.length > 256))
    || document.evidenceDigests.length > MAX_ATTEMPT_ARTIFACTS || document.artifacts.length !== document.evidenceDigests.length
    || new Set(document.evidenceDigests).size !== document.evidenceDigests.length
    || document.evidenceDigests.some((entry) => !DIGEST_PATTERN.test(entry))
    || digest !== canonicalDigest(body) || digest !== inbox.digest) fail('STORE_CORRUPT', 'Attempt evidence inbox is corrupt.');
  validateWorkLease(state, {
    runId,
    workItemId: document.workItemId,
    workerId: document.workerId,
    attempt: document.attempt,
    epoch: document.coordinatorEpoch,
    token: document.leaseToken,
  });
  if (document.subjectCoreDigest !== state.subjectCoreDigest || document.runnerRevision !== state.runnerRevision) {
    fail('WORK_RESULT_BINDING_MISMATCH', 'Attempt evidence does not match the run subject or runner revision.');
  }
  const artifactNames = new Set();
  let artifactBytes = 0;
  for (let index = 0; index < document.artifacts.length; index += 1) {
    const artifact = validateArtifactRecord(document.artifacts[index], {
      runId, workItemId: document.workItemId, attempt: document.attempt, leaseToken: document.leaseToken,
    });
    if (artifactNames.has(artifact.name) || document.evidenceDigests[index] !== artifact.digest) {
      fail('STORE_CORRUPT', 'Attempt evidence artifact declaration is duplicated or out of order.');
    }
    artifactNames.add(artifact.name);
    artifactBytes += artifact.sizeBytes;
    if (artifactBytes > MAX_ATTEMPT_EVIDENCE_BYTES) fail('STORE_CORRUPT', 'Stored attempt evidence exceeds its total byte bound.');
    const bytes = await readBoundedFile(store.storage,
      containedPath(runDirectory(store, runId), ...artifact.relativePath.split('/')),
      { label: `attempt artifact ${artifact.name}`, maximumBytes: MAX_ATTEMPT_ARTIFACT_BYTES });
    const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.length !== artifact.sizeBytes || actualDigest !== artifact.digest) {
      fail('ARTIFACT_DIGEST_MISMATCH', `Stored attempt artifact ${artifact.name} does not match its manifest.`);
    }
  }
  let adopted;
  await appendMutationUnlocked(store, state, 'mutation', 'attempt-evidence-adopted', (next) => {
    const item = validateWorkLease(next, {
      runId,
      workItemId: document.workItemId,
      workerId: document.workerId,
      attempt: document.attempt,
      epoch: document.coordinatorEpoch,
      token: document.leaseToken,
    });
    const canonicalResult = sealWorkItemResult({
      schemaVersion: 1,
      workItemId: document.workItemId,
      subjectCoreDigest: next.subjectCoreDigest,
      attempt: document.attempt,
      authoritative: true,
      outcome: document.outcome,
      evidenceDigests: document.evidenceDigests,
    });
    const attempt = {
      attempt: document.attempt,
      outcome: document.outcome,
      evidenceDigests: document.evidenceDigests,
      artifacts: document.artifacts,
      workerId: document.workerId,
      completedAt: timestamp(store),
      reason: document.reason,
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
    if (item.resourceClass === 'performance') {
      next.resourceScheduling.exclusiveLease = null;
      if (item.state !== 'queued') next.resourceScheduling.performanceDrain = null;
    }
    adopted = clone(item);
  }, { data: { workItemId: document.workItemId, digest } });
  return adopted;
  }));
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
      next.resourceScheduling.performanceDrain = null;
      next.resourceScheduling.exclusiveLease = null;
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
    if (state.authorityTombstone !== null) fail('RELEASE_AUTHORITY_TOMBSTONED', 'Tombstoned runs cannot accept operations.');
    if (request.expectedRunRevision !== undefined
      && (!Number.isSafeInteger(request.expectedRunRevision) || request.expectedRunRevision !== state.runRevision)) {
      fail('RUN_REVISION_CONFLICT', 'Expected run revision is stale.');
    }
    if (request.expectedSubjectDigest !== undefined && request.expectedSubjectDigest !== state.finalSubjectDigest) {
      fail('RELEASE_SUBJECT_MISMATCH', 'Operation does not match the immutable final subject.');
    }
    if (Object.keys(state.operations).length >= 128) fail('OPERATION_LIMIT_REACHED', 'Run operation retention limit was reached.');
    const operation = {
      operationId: createHash('sha256').update(`${runId}\0${request.idempotencyKey}`).digest('hex'),
      idempotencyKey: request.idempotencyKey,
      kind: request.kind,
      bodyDigest: digest,
      body: clone(request.body),
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

export async function listAcceptedOperations(store, runId, { limit = 32 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) fail('STORE_SCHEMA_INVALID', 'Operation list limit is invalid.');
  const state = await recoverUnlocked(store, runId);
  return Object.values(state.operations).filter(({ state: operationState }) => operationState === 'accepted').slice(0, limit).map(clone);
}

export async function rekickIncompleteWork(store, runId, coordinator, input) {
  const ids = [...new Set(input?.workItemIds ?? [])];
  if (ids.length < 1 || ids.length > 64 || ids.some((id) => !SAFE_ID.test(id))) fail('STORE_SCHEMA_INVALID', 'Rekick requires 1 through 64 valid work-item IDs.');
  return mutate(store, runId, { coordinator, kind: 'mutation', type: 'incomplete-work-rekicked', actor: input.actor, data: { workItemIds: ids } }, (next) => {
    for (const id of ids) {
      const item = next.workItems[id];
      if (!item || item.state !== 'incomplete' || item.canonicalResult !== null || item.manualRekicks >= 3) {
        fail('REKICK_NOT_INCOMPLETE', `Work item ${id} is not eligible for incomplete-work rekick.`);
      }
      item.state = 'queued';
      item.lease = null;
      item.manualRekicks += 1;
    }
  });
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

export async function tombstoneParentRunAuthority(store, runId, coordinator, input) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator);
    if (state.authorityTombstone !== null) return clone(state.authorityTombstone);
    if (!input?.actor || typeof input.actor.id !== 'string' || !input.actor.id
      || !['human', 'service'].includes(input.actor.kind)) fail('STORE_SCHEMA_INVALID', 'Authority tombstone requires an immutable human or service actor.');
    const tombstone = {
      schemaVersion: 1,
      kind: 'release-authority-tombstone',
      runId,
      subjectCoreDigest: state.subjectCoreDigest,
      finalSubjectDigest: state.finalSubjectDigest,
      lastPublicationDigest: state.currentPublicationDigest,
      tombstonedAt: timestamp(store),
      reason: schedulingString(input?.reason, 'authority tombstone reason', { maximum: 1_024 }),
      actor: input?.actor ?? null,
    };
    await appendMutationUnlocked(store, state, 'mutation', 'release-authority-tombstoned', (next) => {
      next.authorityTombstone = tombstone;
      next.status = 'cancelled';
      for (const item of Object.values(next.workItems)) {
        if (!['completed_pass', 'completed_product_failure'].includes(item.state)) {
          item.state = 'cancelled';
          item.lease = null;
        }
      }
      next.resourceScheduling.performanceDrain = null;
      next.resourceScheduling.exclusiveLease = null;
    }, { actor: input?.actor ?? null, data: { reason: tombstone.reason, lastPublicationDigest: tombstone.lastPublicationDigest } });
    return clone(tombstone);
  }));
}

export async function purgeParentRunEvidence(store, runId) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    if (state.authorityTombstone === null) fail('PURGE_REQUIRES_TOMBSTONE', 'Evidence cannot be purged before release authority is tombstoned.');
    const directory = runDirectory(store, runId);
    for (const relative of ['evidence', 'inboxes']) {
      const target = containedPath(directory, relative);
      await store.storage.fs.rm(target, { recursive: true, force: true });
    }
    await store.storage.fs.mkdir(path.join(directory, 'inboxes'), { recursive: true, mode: 0o2770 });
    return clone(state.authorityTombstone);
  }));
}

export async function readRunHistories(store, runId) {
  await recoverUnlocked(store, runId);
  return readAllLedgers(store.storage, runDirectory(store, runId));
}

export async function readBoundedAttemptLogs(store, runId, { limit = 200 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) fail('STORE_SCHEMA_INVALID', 'Attempt log limit is invalid.');
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  const entries = [];
  for (const workItemId of Object.keys(state.workItems)) {
    const directory = path.join(runDirectory(store, runId), 'inboxes', workItemId, 'logs');
    const names = await store.storage.fs.readdir(directory).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const name of names) {
      if (!/^\d{6}-[A-Za-z0-9._-]+-\d{8}\.json$/.test(name)) continue;
      const document = await readBoundedJson(store.storage, path.join(directory, name), { label: 'attempt log', maximumBytes: 16 * 1_024 });
      const { digest, ...body } = document;
      if (document.kind !== 'attempt-log-inbox' || document.runId !== runId || document.workItemId !== workItemId
        || digest !== canonicalDigest(body)) fail('STORE_CORRUPT', 'Attempt log is corrupt.');
      entries.push(document);
    }
  }
  entries.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence);
  return { entries: entries.slice(-limit), truncated: entries.length > limit };
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
  if (state.authorityTombstone !== null) {
    fail('RELEASE_AUTHORITY_TOMBSTONED', 'Parent run release authority was irreversibly tombstoned before purge.', state.authorityTombstone);
  }
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

export async function withCurrentEnvelopeFence(store, runId, callback) {
  if (typeof callback !== 'function') fail('STORE_SCHEMA_INVALID', 'Publication fence callback is required.');
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    if (state.authorityTombstone !== null) fail('RELEASE_AUTHORITY_TOMBSTONED', 'Parent run release authority is tombstoned.');
    if (state.currentPublicationDigest === null) fail('PUBLICATION_UNAVAILABLE', 'Parent run has no current publication.');
    const current = (await readPublicationChain(store, runId, state.currentPublicationDigest)).at(-1);
    return callback(current);
  }));
}
