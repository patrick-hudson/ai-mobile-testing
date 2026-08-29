import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import {
  canonicalDigest,
  canonicalJson,
} from '../../shared/canonical-contract.mjs';
import { parsePublicationEnvelope, verifyPublicationChain } from '../../shared/publication-envelope.mjs';
import { parseExecutionManifest, sealWorkItemResult } from '../../shared/execution-contract.mjs';
import { parseSingleSiteInventoryBarrier } from '../../shared/execution-graph-compiler.mjs';
import { parseFinalReleaseSubject, parseReleaseSubjectCore } from '../../shared/release-subject.mjs';
import { parseWorkExecutionDescriptor } from '../../shared/work-execution-descriptor.mjs';
import { sealWorkItemEvidenceMember } from '../../shared/work-item-evidence-index.mjs';
import {
  atomicWriteJson,
  atomicWriteFile,
  containedPath,
  ensureDirectory,
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
export const PARENT_RUN_WRITER_PROTOCOL = 'single-coordinator-global-performance-v2';
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const LOCAL_VOLUME_DRIVERS = new Set(['local']);
const WORK_OUTCOMES = new Set([
  'completed_pass', 'completed_product_failure', 'operational_failure', 'cancelled', 'incomplete_unknown',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/;
const RESOURCE_CLASSES = new Set(['ordinary', 'performance']);
export const MAX_ATTEMPT_ARTIFACTS = 64;
export const MAX_ATTEMPT_ARTIFACT_BYTES = 512 * 1_048_576;
export const MAX_ATTEMPT_EVIDENCE_BYTES = 1_024 * 1_048_576;
const ARTIFACT_MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i;
const MAX_OPERATION_RESOURCES = 128;
const MAX_OPERATION_BODY_BYTES = 16 * 1_024;
const OPERATION_RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_DISCOVERED_PARENT_RUNS = 2_048;
const MAX_BUFFERED_ATTEMPT_ARTIFACT_BYTES = 8 * 1_048_576;
const MAX_BUFFERED_ATTEMPT_EVIDENCE_BYTES = 16 * 1_048_576;

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

function normalizeScheduledWorkItems(value, { subjectCoreDigest = null, runnerRevision = null } = {}) {
  if (!Array.isArray(value) || value.length === 0) fail('STORE_SCHEMA_INVALID', 'A parent run requires work items.');
  const workItems = {};
  for (const item of value) {
    const id = safeId(item.id, 'workItem.id');
    if (workItems[id]) fail('STORE_SCHEMA_INVALID', `Duplicate work item ${id}.`);
    if (!Number.isSafeInteger(item.maxAttempts) || item.maxAttempts < 1 || item.maxAttempts > 16) {
      fail('STORE_SCHEMA_INVALID', `Work item ${id} maxAttempts must be from 1 through 16.`);
    }
    const capability = schedulingCapability(item.capability ?? 'browser:any', `Work item ${id} capability`);
    const resourceClass = item.resourceClass ?? 'ordinary';
    if (!RESOURCE_CLASSES.has(resourceClass)) fail('STORE_SCHEMA_INVALID', `Work item ${id} resourceClass is invalid.`);
    let executionDescriptor = null;
    if (item.executionDescriptor !== undefined && item.executionDescriptor !== null) {
      try { executionDescriptor = parseWorkExecutionDescriptor(item.executionDescriptor); } catch (error) {
        fail(error?.code ?? 'STORE_SCHEMA_INVALID', `Work item ${id} execution descriptor is invalid: ${error.message}`);
      }
      if (executionDescriptor.workItemId !== id || executionDescriptor.capability !== capability
        || executionDescriptor.resourceClass !== resourceClass
        || executionDescriptor.targetId !== (item.targetId ?? 'unspecified-target')
        || executionDescriptor.entrySpec !== (item.specAffinity ?? null)
        || (subjectCoreDigest !== null && executionDescriptor.subjectCoreDigest !== subjectCoreDigest)
        || (runnerRevision !== null && executionDescriptor.runnerRevision !== runnerRevision)) {
        fail('WORK_DESCRIPTOR_BINDING_MISMATCH', `Work item ${id} execution descriptor disagrees with its canonical scheduling identity.`);
      }
    }
    workItems[id] = {
      id,
      capability,
      resourceClass,
      targetId: schedulingString(item.targetId ?? 'unspecified-target', `Work item ${id} targetId`, { maximum: 128 }),
      specAffinity: schedulingString(item.specAffinity ?? null, `Work item ${id} specAffinity`, { nullable: true, maximum: 512 }),
      executionDescriptor,
      state: 'queued',
      maxAttempts: item.maxAttempts,
      lease: null,
      attempts: [],
      manualRekicks: 0,
      canonicalResult: null,
    };
  }
  return workItems;
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

async function inspectBoundedArtifact(store, file, { label, maximumBytes = MAX_ATTEMPT_ARTIFACT_BYTES } = {}) {
  let handle;
  try {
    handle = await store.storage.fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) {
      fail('STORE_CORRUPT', `${label} must be a bounded regular file.`);
    }
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1_024);
    let sizeBytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      sizeBytes += bytesRead;
      if (sizeBytes > maximumBytes) fail('STORE_CORRUPT', `${label} exceeds its byte bound.`);
      hash.update(chunk.subarray(0, bytesRead));
    }
    return { sizeBytes, digest: `sha256:${hash.digest('hex')}` };
  } catch (error) {
    if (error?.code === 'ENOENT') fail('ATTEMPT_ARTIFACT_UNAVAILABLE', `${label} was not uploaded.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function normalizeArtifactDeclaration(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 7
    || !['name', 'mediaType', 'sizeBytes', 'digest', 'logicalName', 'purpose', 'memberDigest'].every((key) => key in value)) {
    fail('STORE_SCHEMA_INVALID', 'Artifact declaration has an invalid schema.');
  }
  const name = artifactName(value.name);
  let member;
  try {
    member = sealWorkItemEvidenceMember({
      workItemId: context.workItemId,
      executionDescriptorDigest: context.executionDescriptorDigest,
      ordinal: context.ordinal,
      logicalName: value.logicalName,
      purpose: value.purpose,
      mediaType: value.mediaType,
      sizeBytes: value.sizeBytes,
      contentDigest: value.digest,
      transportPath: name,
    });
  } catch (error) {
    fail('STORE_SCHEMA_INVALID', `Artifact ${name} logical evidence declaration is invalid: ${error.message}`);
  }
  if (member.memberDigest !== value.memberDigest) {
    fail('ARTIFACT_MEMBER_DIGEST_MISMATCH', `Artifact ${name} member digest does not match its logical identity.`);
  }
  return {
    name,
    mediaType: member.mediaType,
    sizeBytes: member.sizeBytes,
    digest: member.contentDigest,
    logicalName: member.logicalName,
    purpose: member.purpose,
    memberDigest: member.memberDigest,
  };
}

function decodeArtifactUpload(value, context) {
  const keys = Object.keys(value ?? {});
  const indexed = keys.length === 8
    && ['name', 'mediaType', 'sizeBytes', 'digest', 'logicalName', 'purpose', 'memberDigest', 'contentBase64']
      .every((key) => key in value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (!indexed && (keys.length !== 5
      || !['name', 'mediaType', 'sizeBytes', 'digest', 'contentBase64'].every((key) => key in value)))) {
    fail('STORE_SCHEMA_INVALID', 'Artifact upload has an invalid schema.');
  }
  const name = artifactName(value.name);
  if (typeof value.mediaType !== 'string' || !ARTIFACT_MEDIA_TYPE.test(value.mediaType)) {
    fail('STORE_SCHEMA_INVALID', 'Artifact media type is invalid.');
  }
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_BUFFERED_ATTEMPT_ARTIFACT_BYTES
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
  let member;
  try {
    member = sealWorkItemEvidenceMember({
      workItemId: context.workItemId,
      executionDescriptorDigest: context.executionDescriptorDigest,
      ordinal: context.ordinal,
      logicalName: indexed ? value.logicalName : name,
      purpose: indexed ? value.purpose : 'structured',
      mediaType: value.mediaType,
      sizeBytes: bytes.length,
      contentDigest: digest,
      transportPath: name,
    });
  } catch (error) {
    fail('STORE_SCHEMA_INVALID', `Artifact ${name} logical evidence membership is invalid: ${error.message}`);
  }
  if (indexed && value.memberDigest !== member.memberDigest) {
    fail('ARTIFACT_MEMBER_DIGEST_MISMATCH', `Artifact ${name} member digest does not match its logical identity.`);
  }
  return {
    name, mediaType: member.mediaType, sizeBytes: bytes.length, digest, bytes,
    logicalName: member.logicalName, purpose: member.purpose, memberDigest: member.memberDigest,
  };
}

function validateArtifactRecord(value, { runId, workItemId, attempt, leaseToken }) {
  const keys = Object.keys(value ?? {});
  const indexed = keys.length === 8
    && ['name', 'mediaType', 'sizeBytes', 'digest', 'logicalName', 'purpose', 'memberDigest', 'relativePath']
      .every((key) => key in value);
  const legacy = keys.length === 5
    && ['name', 'mediaType', 'sizeBytes', 'digest', 'relativePath'].every((key) => key in value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || (!indexed && !legacy)) {
    fail('STORE_CORRUPT', 'Stored artifact record has an invalid schema.');
  }
  let name;
  try { name = artifactName(value.name); } catch {
    fail('STORE_CORRUPT', 'Stored artifact name is invalid.');
  }
  if (typeof value.mediaType !== 'string' || !ARTIFACT_MEDIA_TYPE.test(value.mediaType)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_ATTEMPT_ARTIFACT_BYTES
    || !DIGEST_PATTERN.test(value.digest)
    || (indexed && (!DIGEST_PATTERN.test(value.memberDigest)
      || typeof value.logicalName !== 'string' || !value.logicalName || value.logicalName.length > 240
      || !['structured', 'primary', 'diagnostic'].includes(value.purpose)))) {
    fail('STORE_CORRUPT', 'Stored artifact metadata is invalid.');
  }
  const expected = path.posix.join('evidence', workItemId, `${String(attempt).padStart(6, '0')}-${leaseToken}`, name);
  if (value.relativePath !== expected || value.relativePath.includes('\\') || value.relativePath.startsWith('/')) {
    fail('STORE_CORRUPT', `Stored artifact path escaped attempt ${runId}/${workItemId}.`);
  }
  return indexed ? value : {
    ...value,
    logicalName: value.name,
    purpose: 'structured',
    memberDigest: value.digest,
  };
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

function validateOperationResource(value, idempotencyKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.idempotencyKey !== idempotencyKey || !SAFE_ID.test(idempotencyKey)
    || typeof value.operationId !== 'string' || !/^[a-f0-9]{64}$/.test(value.operationId)
    || typeof value.kind !== 'string' || value.kind.length < 1 || value.kind.length > 128
    || !DIGEST_PATTERN.test(value.bodyDigest)
    || !value.body || typeof value.body !== 'object' || Array.isArray(value.body)
    || Buffer.byteLength(canonicalJson(value.body)) > MAX_OPERATION_BODY_BYTES
    || !value.actor || typeof value.actor !== 'object' || Array.isArray(value.actor)
    || typeof value.actor.id !== 'string' || !value.actor.id
    || typeof value.actor.kind !== 'string' || !value.actor.kind
    || !['accepted', 'completed'].includes(value.state)
    || !canonicalTimestamp(value.acceptedAt, 'operation acceptedAt')) {
    fail('STORE_CORRUPT', `Operation ${idempotencyKey} is corrupt.`);
  }
  if (value.state === 'accepted' && (value.completedAt !== null || value.outcome !== null)) {
    fail('STORE_CORRUPT', `Accepted operation ${idempotencyKey} has a terminal outcome.`);
  }
  if (value.state === 'completed' && (value.completedAt === null || !value.outcome || typeof value.outcome !== 'object'
    || Array.isArray(value.outcome) || !canonicalTimestamp(value.completedAt, 'operation completedAt')
    || Date.parse(value.completedAt) < Date.parse(value.acceptedAt))) {
    fail('STORE_CORRUPT', `Completed operation ${idempotencyKey} has invalid terminal state.`);
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

function performanceSchedulerPath(store) {
  return containedPath(store.root, 'performance-scheduler.json');
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

function sealPerformanceScheduler(value) {
  const body = {
    schemaVersion: 1,
    kind: 'store-performance-scheduler',
    revision: value.revision,
    phase: value.phase,
    reservation: value.reservation,
    updatedAt: value.updatedAt,
  };
  return { ...body, digest: canonicalDigest(body) };
}

function validatePerformanceReservation(value, phase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('STORE_CORRUPT', 'Store performance scheduler reservation is invalid.');
  }
  const drainingKeys = [
    'workerId', 'runId', 'workItemId', 'coordinatorEpoch', 'requestedAt', 'expiresAt',
  ];
  const runningKeys = [...drainingKeys, 'attempt', 'leaseToken', 'acquiredAt'];
  exactKeys(value, phase === 'running' ? runningKeys : drainingKeys, 'store performance reservation');
  if (!SAFE_ID.test(value.workerId) || !SAFE_ID.test(value.runId) || !SAFE_ID.test(value.workItemId)
    || !Number.isSafeInteger(value.coordinatorEpoch) || value.coordinatorEpoch < 1
    || canonicalTimestamp(value.requestedAt, 'performance reservation requestedAt')
      >= canonicalTimestamp(value.expiresAt, 'performance reservation expiresAt')) {
    fail('STORE_CORRUPT', 'Store performance scheduler reservation is invalid.');
  }
  if (phase === 'running' && (!Number.isSafeInteger(value.attempt) || value.attempt < 1
    || !SAFE_ID.test(value.leaseToken)
    || canonicalTimestamp(value.acquiredAt, 'performance reservation acquiredAt') < value.requestedAt)) {
    fail('STORE_CORRUPT', 'Store running performance reservation is invalid.');
  }
  return value;
}

function validatePerformanceScheduler(value) {
  exactKeys(value, [
    'schemaVersion', 'kind', 'revision', 'phase', 'reservation', 'updatedAt', 'digest',
  ], 'store performance scheduler');
  const { digest, ...body } = value;
  if (value.schemaVersion !== 1 || value.kind !== 'store-performance-scheduler'
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !['idle', 'draining', 'running'].includes(value.phase)
    || !canonicalTimestamp(value.updatedAt, 'performance scheduler updatedAt')
    || digest !== canonicalDigest(body)) {
    fail('STORE_CORRUPT', 'Store performance scheduler is invalid or corrupt.');
  }
  if (value.phase === 'idle') {
    if (value.reservation !== null) fail('STORE_CORRUPT', 'Idle performance scheduler cannot retain a reservation.');
  } else {
    validatePerformanceReservation(value.reservation, value.phase);
  }
  return value;
}

async function readPerformanceSchedulerUnlocked(store) {
  try {
    return validatePerformanceScheduler(await readBoundedJson(store.storage, performanceSchedulerPath(store), {
      label: 'store performance scheduler', maximumBytes: 16_384,
    }));
  } catch (error) {
    if (error?.code === 'STORE_CORRUPT') throw error;
    fail('STORE_CORRUPT', 'Store performance scheduler is unreadable.', { cause: error?.code ?? error?.message });
  }
}

async function writePerformanceSchedulerUnlocked(store, previous, phase, reservation = null) {
  const next = sealPerformanceScheduler({
    revision: previous.revision + 1,
    phase,
    reservation,
    updatedAt: timestamp(store),
  });
  await atomicWriteJson(store.storage, performanceSchedulerPath(store), next);
  return next;
}

export async function readStorePerformanceScheduler(store) {
  return clone(await readPerformanceSchedulerUnlocked(store));
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
  snapshot.compilationBarrier ??= null;
  snapshot.inventoryBarrierPlan ??= null;
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
    if (item.executionDescriptor !== null && item.executionDescriptor !== undefined) {
      let descriptor;
      try { descriptor = parseWorkExecutionDescriptor(item.executionDescriptor); } catch {
        fail('STORE_CORRUPT', `Parent run ${runId} has a corrupt execution descriptor.`);
      }
      if (descriptor.workItemId !== id || descriptor.subjectCoreDigest !== snapshot.subjectCoreDigest
        || descriptor.runnerRevision !== snapshot.runnerRevision || descriptor.capability !== item.capability
        || descriptor.resourceClass !== item.resourceClass || descriptor.targetId !== item.targetId
        || descriptor.entrySpec !== item.specAffinity) {
        fail('STORE_CORRUPT', `Parent run ${runId} has a misbound execution descriptor.`);
      }
    }
  }
  if (snapshot.compilationBarrier !== null) {
    const item = snapshot.compilationBarrier;
    item.manualRekicks ??= 0;
    if (snapshot.compilationState !== 'sealed' || item?.id === undefined || snapshot.workItems[item.id]
      || !SAFE_ID.test(item.id) || item.state !== 'completed_pass'
      || !Number.isSafeInteger(item.maxAttempts) || item.maxAttempts < 1
      || !Array.isArray(item.attempts) || item.attempts.length < 1
      || !CAPABILITY_PATTERN.test(item.capability) || !RESOURCE_CLASSES.has(item.resourceClass)
      || typeof item.targetId !== 'string' || (item.specAffinity !== null && typeof item.specAffinity !== 'string')
      || !Number.isSafeInteger(item.manualRekicks) || item.manualRekicks < 0 || item.manualRekicks > 3
      || item.lease !== null || item.canonicalResult?.outcome !== 'completed_pass') {
      fail('STORE_CORRUPT', `Parent run ${runId} has an invalid completed compilation barrier.`);
    }
  }
  for (const [idempotencyKey, operation] of Object.entries(snapshot.operations)) {
    validateOperationResource(operation, idempotencyKey);
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
  const schedulerPath = containedPath(storage.root, 'performance-scheduler.json');
  const store = { root: storage.root, storage, clock, manifest: null };
  await withDirectoryLock(storage, containedPath(storage.root, '.store-initialization.lock'), async () => {
    const existingStore = await pathExists(storage.fs, manifestPath);
    if (existingStore) {
      const manifest = validateManifest(await readBoundedJson(storage, manifestPath, { label: 'store manifest' }));
      if ((deploymentIdentity && deploymentIdentity !== manifest.deploymentIdentity)
        || (volumeIdentity && volumeIdentity !== manifest.volumeIdentity)
        || volumeDriver !== manifest.volumeDriver || writerProtocol !== manifest.writerProtocol) {
        fail('STORE_IDENTITY_MISMATCH', 'Configured deployment, volume, or writer identity does not match the durable store.');
      }
      store.manifest = manifest;
    } else {
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
    }
    if (!await pathExists(storage.fs, schedulerPath)) {
      if (existingStore) {
        const states = await schedulingStatesUnlocked(store);
        const hadPerformanceState = states.some((state) => state.resourceScheduling.performanceDrain !== null
          || state.resourceScheduling.exclusiveLease !== null
          || Object.values(state.workItems).some((item) => item.resourceClass === 'performance'
            && item.state === 'running'));
        if (hadPerformanceState) {
          fail('STORE_CORRUPT', 'Existing store is missing its performance scheduler while performance state is active.');
        }
      }
      await atomicWriteJson(storage, schedulerPath, sealPerformanceScheduler({
        revision: 0,
        phase: 'idle',
        reservation: null,
        updatedAt: timestamp(store),
      }), { exclusive: true });
    }
    await readPerformanceSchedulerUnlocked(store);
  });
  return store;
}

export async function createParentRun(store, input) {
  const runId = safeId(input?.runId, 'runId');
  const compilationState = input.compilationState ?? 'pending';
  if (!['pending', 'sealed'].includes(compilationState)) fail('STORE_SCHEMA_INVALID', 'Parent-run compilationState is invalid.');
  const subjectCore = input.subjectCore ? parseReleaseSubjectCore(input.subjectCore) : null;
  const executionManifest = input.executionManifest ? parseExecutionManifest(input.executionManifest) : null;
  const finalSubject = input.finalSubject ? parseFinalReleaseSubject(input.finalSubject) : null;
  const subjectCoreDigest = subjectCore?.digest ?? input.subjectCoreDigest;
  const executionManifestDigest = executionManifest?.digest ?? input.executionManifestDigest ?? null;
  const finalSubjectDigest = finalSubject?.digest ?? input.finalSubjectDigest ?? null;
  const runnerRevision = schedulingString(input.runnerRevision ?? 'legacy-runner', 'runnerRevision', { maximum: 256 });
  let inventoryBarrierPlan = null;
  if (input.inventoryBarrier !== undefined && input.inventoryBarrier !== null) {
    if (!subjectCore) fail('STORE_SCHEMA_INVALID', 'An inventory barrier requires the canonical release subject core.');
    try { inventoryBarrierPlan = parseSingleSiteInventoryBarrier(input.inventoryBarrier, subjectCore); } catch (error) {
      fail(error?.code ?? 'STORE_SCHEMA_INVALID', `Parent-run inventory barrier is invalid: ${error.message}`);
    }
  }
  const scheduledWorkItems = normalizeScheduledWorkItems(input.workItems, { subjectCoreDigest, runnerRevision });
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
    const workItems = clone(scheduledWorkItems);
    if (compilationState === 'sealed' && executionManifest) {
      const storedIds = Object.keys(workItems).sort();
      const manifestIds = executionManifest.workItems.map(({ id }) => id).sort();
      if (canonicalJson(storedIds) !== canonicalJson(manifestIds)) {
        fail('SEALED_MANIFEST_MISMATCH', 'Sealed execution manifest does not match the durable work-item queue.');
      }
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
      compilationBarrier: null,
      inventoryBarrierPlan,
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

export async function listParentRunIds(store, { limit = MAX_DISCOVERED_PARENT_RUNS } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISCOVERED_PARENT_RUNS) {
    fail('STORE_SCHEMA_INVALID', `Parent-run discovery limit must be from 1 through ${MAX_DISCOVERED_PARENT_RUNS}.`);
  }
  const entries = await store.storage.fs.readdir(containedPath(store.root, 'runs'));
  const runIds = [];
  for (const entry of entries.filter((name) => SAFE_ID.test(name)).sort()) {
    const metadata = await store.storage.fs.lstat(containedPath(store.root, 'runs', entry));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    runIds.push(entry);
    if (runIds.length >= limit) break;
  }
  return runIds;
}

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
    if (state.compilationState === 'sealed') {
      if (canonicalJson(storedIds) !== canonicalJson(manifestIds)) {
        fail('SEALED_MANIFEST_MISMATCH', 'Sealed execution manifest does not match the durable work-item queue.');
      }
      if (state.executionManifestDigest !== executionManifest.digest || state.finalSubjectDigest !== finalSubject.digest) {
        fail('SEALED_MANIFEST_IMMUTABLE', 'A sealed parent-run graph cannot be rewritten.');
      }
      delete state.clockNow;
      return state;
    }
    let expandedWorkItems = null;
    let completedBarrier = null;
    if (canonicalJson(storedIds) !== canonicalJson(manifestIds)) {
      const inventoryWorkItemId = safeId(input.inventoryWorkItemId, 'inventoryWorkItemId');
      if (storedIds.length !== 1 || storedIds[0] !== inventoryWorkItemId) {
        fail('SEALED_MANIFEST_MISMATCH', 'Pending parent run does not contain the declared inventory barrier.');
      }
      const barrier = state.workItems[inventoryWorkItemId];
      if (barrier.capability !== 'inventory:http' || barrier.resourceClass !== 'ordinary'
        || barrier.state !== 'completed_pass' || barrier.lease !== null
        || barrier.canonicalResult?.outcome !== 'completed_pass') {
        fail('INVENTORY_BARRIER_INCOMPLETE', 'Inventory must complete successfully before the parent graph can expand and seal.');
      }
      expandedWorkItems = normalizeScheduledWorkItems(input.workItems, {
        subjectCoreDigest,
        runnerRevision: state.runnerRevision,
      });
      if (canonicalJson(Object.keys(expandedWorkItems).sort()) !== canonicalJson(manifestIds)) {
        fail('SEALED_MANIFEST_MISMATCH', 'Expanded durable work items do not match the sealed execution manifest.');
      }
      completedBarrier = clone(barrier);
    }
    return appendMutationUnlocked(store, state, 'mutation', 'parent-run-graph-sealed', (next) => {
      next.subjectCore = subjectCore ?? next.subjectCore;
      next.executionManifest = executionManifest;
      next.executionManifestDigest = executionManifest.digest;
      next.finalSubject = finalSubject;
      next.finalSubjectDigest = finalSubject.digest;
      if (expandedWorkItems) {
        next.compilationBarrier = completedBarrier;
        next.workItems = expandedWorkItems;
      }
      next.compilationState = 'sealed';
    }, { data: { inventoryWorkItemId: completedBarrier?.id ?? null, workItemIds: manifestIds } });
  }));
}

async function acquireStoreCoordinatorUnlocked(store, input, takeoverOnly) {
  safeId(input?.ownerId, 'coordinator ownerId');
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 100) fail('STORE_SCHEMA_INVALID', 'Coordinator leaseMs is invalid.');
  const previous = await readGlobalCoordinator(store);
  const active = previous && Date.parse(previous.expiresAt) > store.clock();
  if (active) fail('COORDINATOR_LEASE_HELD', `Coordinator epoch ${previous.epoch} is still active.`);
  if (takeoverOnly && previous === null) fail('COORDINATOR_TAKEOVER_INVALID', 'No prior coordinator exists to take over.');
  const epoch = Math.max(previous?.epoch ?? 0, store.manifest.authorityEpoch) + 1;
  const coordinator = {
    ownerId: input.ownerId,
    epoch,
    token: store.storage.nonce(),
    acquiredAt: timestamp(store),
    expiresAt: new Date(store.clock() + input.leaseMs).toISOString(),
  };
  // Advance the manifest fence before publishing the lease. A crash may skip
  // an epoch, but can never expose a lease newer than the durable authority
  // epoch or allow a later coordinator to reuse the same epoch.
  await writeManifest(store, { ...store.manifest, authorityEpoch: epoch });
  await atomicWriteJson(store.storage, globalCoordinatorPath(store), sealCoordinatorLease(coordinator));
  return coordinator;
}

async function acquireWithRunAudit(store, runId, input, takeoverOnly) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => (
    withDirectoryLock(store.storage, lockPath(store, runId), async () => {
      const state = await recoverUnlocked(store, runId);
      const coordinator = await acquireStoreCoordinatorUnlocked(store, input, takeoverOnly);
      await appendMutationUnlocked(store, state, 'mutation', takeoverOnly ? 'coordinator-taken-over' : 'coordinator-acquired', (next) => {
        next.coordinator = coordinator;
      }, { actor: { id: input.ownerId, kind: 'service' }, data: { epoch: coordinator.epoch } });
      return clone(coordinator);
    })
  ));
}

export function acquireStoreCoordinator(store, input) {
  return withDirectoryLock(store.storage, globalLockPath(store), async () => (
    clone(await acquireStoreCoordinatorUnlocked(store, input, false))
  ));
}

export function takeOverStoreCoordinator(store, input) {
  return withDirectoryLock(store.storage, globalLockPath(store), async () => (
    clone(await acquireStoreCoordinatorUnlocked(store, input, true))
  ));
}

export function acquireCoordinator(store, runId, input) {
  return acquireWithRunAudit(store, runId, input, false);
}

export function takeOverCoordinator(store, runId, input) {
  return acquireWithRunAudit(store, runId, input, true);
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

async function schedulingStatesUnlocked(store) {
  const states = [];
  for (const runId of await listParentRunIds(store)) {
    const state = await recoverUnlocked(store, runId);
    states.push(state);
  }
  return states;
}

function liveRunningItems(states, store) {
  return states.flatMap((state) => Object.values(state.workItems)
    .filter((item) => item.state === 'running' && item.lease && Date.parse(item.lease.expiresAt) > store.clock())
    .map((item) => ({ state, item })));
}

async function reconcilePerformanceSchedulerUnlocked(store, coordinator, states = null) {
  const current = await readPerformanceSchedulerUnlocked(store);
  if (current.phase === 'idle') return current;
  const allStates = states ?? await schedulingStatesUnlocked(store);
  const reservation = current.reservation;
  const state = allStates.find(({ runId }) => runId === reservation.runId);
  const item = state?.workItems?.[reservation.workItemId];
  if (current.phase === 'draining') {
    if (reservation.coordinatorEpoch !== coordinator.epoch || Date.parse(reservation.expiresAt) <= store.clock()
      || !state || state.status !== 'active' || state.authorityTombstone !== null
      || !item || item.resourceClass !== 'performance'
      || (!['queued', 'running'].includes(item.state))) {
      return writePerformanceSchedulerUnlocked(store, current, 'idle');
    }
    if (item.state === 'running') {
      if (!item.lease || item.lease.workerId !== reservation.workerId
        || item.lease.epoch !== reservation.coordinatorEpoch) {
        fail('STORE_CORRUPT', 'Draining performance reservation disagrees with its running work lease.');
      }
      return writePerformanceSchedulerUnlocked(store, current, 'running', {
        ...reservation,
        attempt: item.lease.attempt,
        leaseToken: item.lease.token,
        acquiredAt: item.lease.claimedAt,
      });
    }
    return current;
  }
  if (!state || state.status !== 'active' || state.authorityTombstone !== null || !item
    || item.state !== 'running' || !item.lease) {
    return writePerformanceSchedulerUnlocked(store, current, 'idle');
  }
  if (item.resourceClass !== 'performance' || item.lease.workerId !== reservation.workerId
    || item.lease.attempt !== reservation.attempt || item.lease.epoch !== reservation.coordinatorEpoch
    || item.lease.token !== reservation.leaseToken) {
    fail('STORE_CORRUPT', 'Running performance scheduler disagrees with its fenced work lease.');
  }
  if (reservation.coordinatorEpoch !== coordinator.epoch) {
    fail('PERFORMANCE_RECOVERY_PENDING', 'A stale-epoch performance lease must be recovered before scheduling resumes.');
  }
  return current;
}

export async function reconcileStorePerformanceScheduler(store, coordinator) {
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    await validateCoordinator(store, coordinator);
    return clone(await reconcilePerformanceSchedulerUnlocked(store, coordinator));
  });
}

function normalizedRunIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DISCOVERED_PARENT_RUNS
    || value.some((runId) => typeof runId !== 'string' || !SAFE_ID.test(runId))) {
    fail('STORE_SCHEMA_INVALID', 'Store scheduling requires a bounded non-empty authorized run list.');
  }
  return [...new Set(value)];
}

export async function requestStorePerformanceDrain(store, coordinator, input) {
  const worker = validatedWorkerScheduling({
    workerId: input?.workerId,
    capabilities: input?.capabilities ?? ['performance:lighthouse'],
    resourceClasses: input?.resourceClasses ?? ['performance'],
  });
  if (!worker.resourceClasses.includes('performance') || !worker.capabilities.includes('performance:lighthouse')) {
    fail('WORKER_CAPABILITY_MISMATCH', 'Only a Lighthouse performance worker can reserve the global performance resource.');
  }
  const runIds = normalizedRunIds(input?.runIds);
  const leaseMs = input?.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
    fail('STORE_SCHEMA_INVALID', 'Performance drain leaseMs must be an integer from 1000 through 3600000.');
  }
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    await validateCoordinator(store, coordinator);
    const states = await schedulingStatesUnlocked(store);
    const current = await reconcilePerformanceSchedulerUnlocked(store, coordinator, states);
    if (current.phase === 'running') fail('PERFORMANCE_LEASE_HELD', 'The store-global performance resource is already running.');
    if (current.phase === 'draining') {
      if (current.reservation.workerId !== worker.workerId) {
        fail('PERFORMANCE_DRAIN_HELD', 'Another worker holds the store-global performance drain.');
      }
      return clone(current.reservation);
    }
    const authorized = new Set(runIds);
    const selected = states
      .filter((state) => authorized.has(state.runId) && state.status === 'active' && state.authorityTombstone === null)
      .flatMap((state) => Object.values(state.workItems).map((item) => ({ state, item })))
      .find(({ item }) => item.state === 'queued' && item.resourceClass === 'performance'
        && workerCanRun(item, worker));
    if (!selected) fail('NO_PERFORMANCE_WORK', 'No authorized queued performance work item is available.');
    const reservation = {
      workerId: worker.workerId,
      runId: selected.state.runId,
      workItemId: selected.item.id,
      coordinatorEpoch: coordinator.epoch,
      requestedAt: timestamp(store),
      expiresAt: new Date(store.clock() + leaseMs).toISOString(),
    };
    await writePerformanceSchedulerUnlocked(store, current, 'draining', reservation);
    return clone(reservation);
  });
}

export function requestPerformanceDrain(store, runId, coordinator, input) {
  return requestStorePerformanceDrain(store, coordinator, {
    ...input,
    capabilities: ['performance:lighthouse'],
    resourceClasses: ['performance'],
    runIds: [runId],
  });
}

function createWorkLease(store, state, requested, worker, coordinator, leaseMs) {
  const attempt = requested.attempts.length + 1;
  return {
    runId: state.runId,
    workItemId: requested.id,
    workerId: worker.workerId,
    attempt,
    epoch: coordinator.epoch,
    token: store.storage.nonce(),
    claimedAt: timestamp(store),
    expiresAt: new Date(store.clock() + leaseMs).toISOString(),
    subjectCoreDigest: state.subjectCoreDigest,
    runnerRevision: state.runnerRevision,
    capability: requested.capability,
    resourceClass: requested.resourceClass,
    targetId: requested.targetId,
    specAffinity: requested.specAffinity,
    executionDescriptor: requested.executionDescriptor,
    executionDescriptorDigest: requested.executionDescriptor?.digest ?? null,
  };
}

export async function claimStoreWorkItem(store, coordinator, input) {
  if (!Number.isSafeInteger(input?.leaseMs) || input.leaseMs < 100 || input.leaseMs > 3_600_000) {
    fail('STORE_SCHEMA_INVALID', 'Work-item leaseMs must be an integer from 100 through 3600000.');
  }
  const worker = validatedWorkerScheduling(input);
  const runIds = normalizedRunIds(input?.runIds);
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    await validateCoordinator(store, coordinator);
    const states = await schedulingStatesUnlocked(store);
    const scheduler = await reconcilePerformanceSchedulerUnlocked(store, coordinator, states);
    const wantsPerformance = worker.resourceClasses.includes('performance');
    if (!wantsPerformance && scheduler.phase !== 'idle') {
      fail('PERFORMANCE_DRAINING', 'Ordinary claims are paused for the store-global performance execution.');
    }
    if (wantsPerformance && (scheduler.phase !== 'draining'
      || scheduler.reservation.workerId !== worker.workerId
      || scheduler.reservation.coordinatorEpoch !== coordinator.epoch)) {
      fail('PERFORMANCE_DRAIN_REQUIRED', 'Performance work requires its active store-global drain.');
    }
    if (wantsPerformance && liveRunningItems(states, store).some(({ item }) => item.resourceClass === 'ordinary')) {
      fail('PERFORMANCE_DRAIN_PENDING', 'Performance work is waiting for active ordinary work across the store to drain.');
    }
    if (wantsPerformance && liveRunningItems(states, store).some(({ item }) => item.resourceClass === 'performance')) {
      fail('PERFORMANCE_LEASE_HELD', 'The store-global performance resource is already active.');
    }
    const authorized = new Set(runIds);
    const authorizedStates = states.filter((state) => authorized.has(state.runId));
    if (authorizedStates.length === 1 && authorizedStates[0].status === 'cancelled') {
      fail('RUN_CANCELLED', `Parent run ${authorizedStates[0].runId} is cancelled.`);
    }
    let selected;
    if (wantsPerformance) {
      const state = states.find(({ runId }) => runId === scheduler.reservation.runId);
      const item = state?.workItems?.[scheduler.reservation.workItemId];
      if (!state || !authorized.has(state.runId) || !item) {
        fail('PERFORMANCE_DRAIN_REQUIRED', 'The active performance reservation is outside this worker authorization.');
      }
      selected = { state, item };
    } else if (input.workItemId) {
      const state = states.find((candidate) => authorized.has(candidate.runId)
        && candidate.workItems[input.workItemId]);
      const item = state?.workItems?.[input.workItemId];
      if (!state || !item) fail('NO_WORK_AVAILABLE', `Work item ${input.workItemId} is unavailable.`);
      if (item.state !== 'queued') {
        if (['completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(item.state)) {
          fail('WORK_ITEM_TERMINAL', `Work item ${item.id} is terminal.`);
        }
        fail('WORK_ITEM_LEASE_HELD', `Work item ${item.id} already has an active lease.`);
      }
      selected = { state, item };
    } else {
      selected = states
        .filter((state) => authorized.has(state.runId) && state.status === 'active' && state.authorityTombstone === null)
        .flatMap((state) => Object.values(state.workItems).map((item) => ({ state, item })))
        .find(({ item }) => item.state === 'queued' && workerCanRun(item, worker));
    }
    if (!selected) {
      const queued = states.some((state) => authorized.has(state.runId)
        && Object.values(state.workItems).some(({ state: workState }) => workState === 'queued'));
      fail(queued ? 'NO_COMPATIBLE_WORK' : 'NO_WORK_AVAILABLE', queued
        ? 'No queued work item matches this worker capability.'
        : 'No queued work item is available.');
    }
    const { state: selectedState, item: selectedItem } = selected;
    if (selectedState.status === 'cancelled') fail('RUN_CANCELLED', `Parent run ${selectedState.runId} is cancelled.`);
    if (selectedItem.state !== 'queued') fail('WORK_ITEM_LEASE_HELD', `Work item ${selectedItem.id} is not queued.`);
    if (!workerCanRun(selectedItem, worker)) fail('WORKER_CAPABILITY_MISMATCH', `Worker cannot execute ${selectedItem.id}.`);
    return withDirectoryLock(store.storage, lockPath(store, selectedState.runId), async () => {
      const state = await recoverUnlocked(store, selectedState.runId);
      const requested = state.workItems[selectedItem.id];
      if (!requested || requested.state !== 'queued') fail('WORK_ITEM_LEASE_HELD', `Work item ${selectedItem.id} is not queued.`);
      const claimed = createWorkLease(store, state, requested, worker, coordinator, input.leaseMs);
      await appendMutationUnlocked(store, state, 'mutation', 'work-item-claimed', (next) => {
        const item = next.workItems[requested.id];
        item.state = 'running';
        item.lease = claimed;
      }, { data: { workerId: worker.workerId, workItemId: requested.id } });
      if (requested.resourceClass === 'performance') {
        await writePerformanceSchedulerUnlocked(store, scheduler, 'running', {
          ...scheduler.reservation,
          attempt: claimed.attempt,
          leaseToken: claimed.token,
          acquiredAt: claimed.claimedAt,
        });
      }
      return clone(claimed);
    });
  });
}

export function claimWorkItem(store, runId, coordinator, input) {
  return claimStoreWorkItem(store, coordinator, { ...input, runIds: [runId] });
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
  if (document.coordinatorEpoch !== coordinator?.epoch) {
    fail('STALE_WORK_LEASE', 'Heartbeat belongs to a stale coordinator epoch.');
  }
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

async function quarantineFailedAttemptEvidenceUnlocked(store, runId, state) {
  const runRoot = runDirectory(store, runId);
  const quarantineRoot = containedPath(runRoot, 'quarantine', 'orphan-attempts');
  const quarantined = [];
  for (const item of Object.values(state.workItems)) {
    for (const attempt of item.attempts) {
      if (attempt.outcome !== 'operational_failure' || !SAFE_ID.test(attempt.leaseToken ?? '')) continue;
      const key = `${String(attempt.attempt).padStart(6, '0')}-${attempt.leaseToken}`;
      for (const [kind, source] of [
        ['evidence', containedPath(runRoot, 'evidence', item.id, key)],
        ['upload-intent', containedPath(runRoot, 'inboxes', item.id, 'uploads', key)],
      ]) {
        if (!await pathExists(store.storage.fs, source)) continue;
        const target = containedPath(quarantineRoot, item.id, key, `${kind}-${store.storage.nonce()}`);
        await ensureDirectory(store.storage.fs, path.dirname(target));
        await store.storage.fs.rename(source, target);
        await fsyncDirectory(store.storage.fs, path.dirname(source));
        await fsyncDirectory(store.storage.fs, path.dirname(target));
        quarantined.push(target);
      }
    }
  }
  return { quarantineRoot, quarantined };
}

export async function requeueExpiredWork(store, runId, coordinator) {
  let quarantineRoot;
  const expiredCount = await withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator);
    const expiredIds = Object.values(state.workItems)
      .filter((item) => item.state === 'running'
        && (Date.parse(item.lease.expiresAt) <= store.clock() || item.lease.epoch !== coordinator.epoch))
      .map((item) => item.id);
    const drainExpired = state.resourceScheduling.performanceDrain
      && Date.parse(state.resourceScheduling.performanceDrain.expiresAt) <= store.clock();
    const exclusiveExpired = state.resourceScheduling.exclusiveLease
      && Date.parse(state.resourceScheduling.exclusiveLease.expiresAt) <= store.clock();
    let current = state;
    if (expiredIds.length > 0 || drainExpired || exclusiveExpired) {
      current = await appendMutationUnlocked(store, state, 'mutation', 'expired-work-requeued', (next) => {
        for (const id of expiredIds) {
          const item = next.workItems[id];
          const reason = item.lease.epoch !== coordinator.epoch ? 'coordinator-epoch-fenced' : 'lease-expired';
          item.attempts.push({
            attempt: item.lease.attempt,
            outcome: 'operational_failure',
            evidenceDigests: [],
            artifacts: [],
            workerId: item.lease.workerId,
            leaseToken: item.lease.token,
            completedAt: timestamp(store),
            reason,
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
    }
    const scheduler = await readPerformanceSchedulerUnlocked(store);
    if (scheduler.phase !== 'idle' && scheduler.reservation.runId === runId
      && expiredIds.includes(scheduler.reservation.workItemId)) {
      await writePerformanceSchedulerUnlocked(store, scheduler, 'idle');
    }
    ({ quarantineRoot } = await quarantineFailedAttemptEvidenceUnlocked(store, runId, current));
    return expiredIds.length;
  }));
  if (quarantineRoot) await store.storage.fs.rm(quarantineRoot, { recursive: true, force: true });
  return expiredCount;
}

export async function publishAttemptEvidence(store, runId, lease, result) {
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  validateWorkLease(state, lease);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).some((key) => !['outcome', 'reason', 'artifacts', 'executionDescriptorDigest'].includes(key))
    || !WORK_OUTCOMES.has(result?.outcome) || !Array.isArray(result.artifacts)
    || result.artifacts.length > MAX_ATTEMPT_ARTIFACTS) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence outcome or artifacts are invalid.');
  }
  const evidenceBindingDigest = lease.executionDescriptorDigest ?? lease.subjectCoreDigest ?? state.subjectCoreDigest;
  const uploads = result.artifacts.map((artifact, index) => decodeArtifactUpload(artifact, {
    workItemId: lease.workItemId,
    executionDescriptorDigest: evidenceBindingDigest,
    ordinal: index + 1,
  }));
  if (new Set(uploads.map(({ name }) => name)).size !== uploads.length) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence contains a duplicate artifact name.');
  }
  if (uploads.reduce((total, artifact) => total + artifact.sizeBytes, 0) > MAX_BUFFERED_ATTEMPT_EVIDENCE_BYTES) {
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
      logicalName: upload.logicalName,
      purpose: upload.purpose,
      memberDigest: upload.memberDigest,
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
    executionDescriptorDigest: result.executionDescriptorDigest ?? lease.executionDescriptorDigest ?? null,
    outcome: result.outcome,
    reason: schedulingString(result.reason ?? null, 'Attempt evidence reason', { nullable: true, maximum: 256 }),
    evidenceDigests: artifacts.map(({ memberDigest }) => memberDigest),
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

function attemptUploadIntentRelativePath(workItemId, attempt, leaseToken) {
  return path.posix.join('inboxes', safeId(workItemId, 'workItemId'), 'uploads',
    `${String(attempt).padStart(6, '0')}-${safeId(leaseToken, 'leaseToken')}`, 'intent.json');
}

async function readAttemptEvidenceUploadIntent(store, runId, binding) {
  const relativePath = attemptUploadIntentRelativePath(binding.workItemId, binding.attempt, binding.leaseToken);
  const document = await readBoundedJson(store.storage,
    containedPath(runDirectory(store, runId), ...relativePath.split('/')),
    { label: 'attempt evidence upload intent', maximumBytes: 262_144 });
  const { digest, ...body } = document;
  exactKeys(document, [
    'schemaVersion', 'kind', 'runId', 'workItemId', 'workerId', 'attempt', 'coordinatorEpoch',
    'leaseToken', 'subjectCoreDigest', 'runnerRevision', 'executionDescriptorDigest', 'outcome', 'reason',
    'artifacts', 'createdAt', 'digest',
  ], 'attempt evidence upload intent');
  if (document.schemaVersion !== 1 || document.kind !== 'attempt-evidence-upload-intent'
    || document.runId !== runId || document.workItemId !== binding.workItemId
    || document.attempt !== binding.attempt || document.leaseToken !== binding.leaseToken
    || document.digest !== binding.intentDigest || digest !== canonicalDigest(body)
    || !Array.isArray(document.artifacts) || document.artifacts.length > MAX_ATTEMPT_ARTIFACTS) {
    fail('STORE_CORRUPT', 'Attempt evidence upload intent is corrupt or disagrees with its binding.');
  }
  if (!SAFE_ID.test(document.workItemId) || !SAFE_ID.test(document.workerId) || !SAFE_ID.test(document.leaseToken)
    || !Number.isSafeInteger(document.attempt) || document.attempt < 1
    || !Number.isSafeInteger(document.coordinatorEpoch) || document.coordinatorEpoch < 1
    || !DIGEST_PATTERN.test(document.subjectCoreDigest)
    || typeof document.runnerRevision !== 'string' || !document.runnerRevision || document.runnerRevision.length > 512
    || (document.executionDescriptorDigest !== null && !DIGEST_PATTERN.test(document.executionDescriptorDigest))
    || !['completed_pass', 'completed_product_failure'].includes(document.outcome)
    || (document.reason !== null && (typeof document.reason !== 'string' || !document.reason || document.reason.length > 256))) {
    fail('STORE_CORRUPT', 'Attempt evidence upload intent metadata is invalid.');
  }
  canonicalTimestamp(document.createdAt, 'attempt evidence upload intent createdAt');
  const evidenceBindingDigest = document.executionDescriptorDigest ?? document.subjectCoreDigest;
  let normalizedArtifacts;
  try {
    normalizedArtifacts = document.artifacts.map((artifact, index) => normalizeArtifactDeclaration(artifact, {
      workItemId: document.workItemId,
      executionDescriptorDigest: evidenceBindingDigest,
      ordinal: index + 1,
    }));
  } catch (error) {
    fail('STORE_CORRUPT', 'Attempt evidence upload intent artifact declarations are invalid.', { cause: error?.code ?? error?.message });
  }
  if (new Set(normalizedArtifacts.map(({ name }) => name)).size !== normalizedArtifacts.length
    || normalizedArtifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) > MAX_ATTEMPT_EVIDENCE_BYTES
    || canonicalJson(normalizedArtifacts) !== canonicalJson(document.artifacts)) {
    fail('STORE_CORRUPT', 'Attempt evidence upload intent artifact declarations are invalid.');
  }
  return { document, relativePath };
}

export async function createAttemptEvidenceUploadIntent(store, runId, lease, result) {
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  validateWorkLease(state, lease);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).some((key) => !['outcome', 'reason', 'artifacts', 'executionDescriptorDigest'].includes(key))
    || !['completed_pass', 'completed_product_failure'].includes(result.outcome)
    || !Array.isArray(result.artifacts) || result.artifacts.length > MAX_ATTEMPT_ARTIFACTS) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence upload intent has an invalid result schema.');
  }
  const expectedDescriptorDigest = lease.executionDescriptorDigest ?? null;
  if ((result.executionDescriptorDigest ?? null) !== expectedDescriptorDigest) {
    fail('WORK_DESCRIPTOR_BINDING_MISMATCH', 'Attempt evidence upload intent does not match the compiler-issued execution descriptor.');
  }
  const evidenceBindingDigest = lease.executionDescriptorDigest ?? lease.subjectCoreDigest ?? state.subjectCoreDigest;
  const artifacts = result.artifacts.map((artifact, index) => normalizeArtifactDeclaration(artifact, {
    workItemId: lease.workItemId,
    executionDescriptorDigest: evidenceBindingDigest,
    ordinal: index + 1,
  }));
  if (new Set(artifacts.map(({ name }) => name)).size !== artifacts.length
    || artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) > MAX_ATTEMPT_EVIDENCE_BYTES) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence upload intent has duplicate names or exceeds its total byte bound.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'attempt-evidence-upload-intent',
    runId,
    workItemId: lease.workItemId,
    workerId: lease.workerId,
    attempt: lease.attempt,
    coordinatorEpoch: lease.epoch,
    leaseToken: lease.token,
    subjectCoreDigest: lease.subjectCoreDigest ?? state.subjectCoreDigest,
    runnerRevision: lease.runnerRevision ?? state.runnerRevision,
    executionDescriptorDigest: expectedDescriptorDigest,
    outcome: result.outcome,
    reason: schedulingString(result.reason ?? null, 'Attempt evidence reason', { nullable: true, maximum: 256 }),
    artifacts,
    createdAt: timestamp(store),
  };
  const document = { ...body, digest: canonicalDigest(body) };
  const relativePath = attemptUploadIntentRelativePath(lease.workItemId, lease.attempt, lease.token);
  const file = containedPath(runDirectory(store, runId), ...relativePath.split('/'));
  let intentDigest = document.digest;
  try {
    await atomicWriteJson(store.storage, file, document, { exclusive: true });
  } catch (error) {
    if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
    const existing = await readBoundedJson(store.storage, file, {
      label: 'attempt evidence upload intent', maximumBytes: 262_144,
    });
    const { digest: existingDigest, createdAt: existingCreatedAt, ...existingStable } = existing;
    const desiredStable = { ...body };
    delete desiredStable.createdAt;
    if (!DIGEST_PATTERN.test(existingDigest)
      || canonicalDigest({ ...existingStable, createdAt: existingCreatedAt }) !== existingDigest) {
      fail('STORE_CORRUPT', 'Immutable attempt evidence upload intent was replaced with different content.');
    }
    if (canonicalJson(existingStable) !== canonicalJson(desiredStable)) {
      fail('ATTEMPT_UPLOAD_CONFLICT', 'A different evidence upload intent already exists for this fenced attempt.');
    }
    intentDigest = existingDigest;
  }
  return Object.freeze({
    runId,
    workItemId: lease.workItemId,
    attempt: lease.attempt,
    leaseToken: lease.token,
    intentDigest,
    artifactCount: artifacts.length,
  });
}

export async function uploadAttemptEvidenceArtifact(store, runId, binding, chunks) {
  if (!chunks || typeof chunks[Symbol.asyncIterator] !== 'function') {
    fail('STORE_SCHEMA_INVALID', 'Attempt artifact upload body must be an async byte stream.');
  }
  const { document: intent } = await readAttemptEvidenceUploadIntent(store, runId, binding);
  if (binding.workerId !== intent.workerId
    || !Number.isSafeInteger(binding.ordinal) || binding.ordinal < 1 || binding.ordinal > intent.artifacts.length) {
    fail('WORK_RESULT_BINDING_MISMATCH', 'Attempt artifact upload does not match its worker or declared ordinal.');
  }
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  validateWorkLease(state, {
    runId,
    workItemId: intent.workItemId,
    workerId: intent.workerId,
    attempt: intent.attempt,
    epoch: intent.coordinatorEpoch,
    token: intent.leaseToken,
  });
  const artifact = intent.artifacts[binding.ordinal - 1];
  if (binding.contentLength !== artifact.sizeBytes
    || String(binding.mediaType ?? '').toLowerCase() !== artifact.mediaType) {
    fail('WORK_RESULT_BINDING_MISMATCH', `Attempt artifact ${artifact.name} transport metadata disagrees with its sealed declaration.`);
  }
  const attemptDirectory = path.posix.join('evidence', intent.workItemId,
    `${String(intent.attempt).padStart(6, '0')}-${intent.leaseToken}`);
  const relativePath = path.posix.join(attemptDirectory, artifact.name);
  const destination = containedPath(runDirectory(store, runId), ...relativePath.split('/'));
  const directory = path.dirname(destination);
  await ensureDirectory(store.storage.fs, directory);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${store.storage.nonce()}.upload`);
  let handle;
  let sizeBytes = 0;
  const hash = createHash('sha256');
  try {
    handle = await store.storage.fs.open(temporary, 'wx', 0o660);
    for await (const value of chunks) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.length === 0) continue;
      sizeBytes += chunk.length;
      if (sizeBytes > artifact.sizeBytes || sizeBytes > MAX_ATTEMPT_ARTIFACT_BYTES) {
        fail('STORE_SCHEMA_INVALID', `Attempt artifact ${artifact.name} exceeds its declared byte length.`);
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten < 1) fail('STORE_CORRUPT', `Attempt artifact ${artifact.name} upload made no write progress.`);
        offset += bytesWritten;
      }
    }
    const digest = `sha256:${hash.digest('hex')}`;
    if (sizeBytes !== artifact.sizeBytes || digest !== artifact.digest) {
      fail('ARTIFACT_DIGEST_MISMATCH', `Attempt artifact ${artifact.name} does not match its declared bytes.`);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    const currentState = await recoverUnlocked(store, runId, { repairCache: false });
    validateWorkLease(currentState, {
      runId,
      workItemId: intent.workItemId,
      workerId: intent.workerId,
      attempt: intent.attempt,
      epoch: intent.coordinatorEpoch,
      token: intent.leaseToken,
    });
    try {
      await store.storage.fs.link(temporary, destination);
      await store.storage.fs.unlink(temporary);
      await fsyncDirectory(store.storage.fs, directory);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await inspectBoundedArtifact(store, destination, { label: `attempt artifact ${artifact.name}` });
      if (existing.sizeBytes !== artifact.sizeBytes || existing.digest !== artifact.digest) {
        fail('STORE_CORRUPT', `Immutable attempt artifact ${artifact.name} was replaced with different bytes.`);
      }
    }
  } finally {
    await handle?.close();
    await store.storage.fs.rm(temporary, { force: true });
  }
  return Object.freeze({
    runId,
    workItemId: intent.workItemId,
    attempt: intent.attempt,
    leaseToken: intent.leaseToken,
    intentDigest: intent.digest,
    ordinal: binding.ordinal,
    sizeBytes: artifact.sizeBytes,
    digest: artifact.digest,
    memberDigest: artifact.memberDigest,
  });
}

export async function finalizeAttemptEvidenceUpload(store, runId, binding) {
  const { document: intent } = await readAttemptEvidenceUploadIntent(store, runId, binding);
  if (binding.workerId !== intent.workerId) {
    fail('WORK_RESULT_BINDING_MISMATCH', 'Attempt evidence finalization belongs to another worker.');
  }
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  const item = state.workItems[intent.workItemId];
  const alreadyAdopted = item?.attempts?.find((attempt) => attempt.attempt === intent.attempt
    && attempt.workerId === intent.workerId && attempt.leaseToken === intent.leaseToken
    && attempt.uploadIntentDigest === intent.digest && attempt.inboxDigest);
  if (!alreadyAdopted) {
    validateWorkLease(state, {
      runId,
      workItemId: intent.workItemId,
      workerId: intent.workerId,
      attempt: intent.attempt,
      epoch: intent.coordinatorEpoch,
      token: intent.leaseToken,
    });
  }
  const attemptDirectory = path.posix.join('evidence', intent.workItemId,
    `${String(intent.attempt).padStart(6, '0')}-${intent.leaseToken}`);
  const artifacts = [];
  for (const artifact of intent.artifacts) {
    const relativePath = path.posix.join(attemptDirectory, artifact.name);
    const actual = await inspectBoundedArtifact(store,
      containedPath(runDirectory(store, runId), ...relativePath.split('/')),
      { label: `attempt artifact ${artifact.name}` });
    if (actual.sizeBytes !== artifact.sizeBytes || actual.digest !== artifact.digest) {
      fail('ARTIFACT_DIGEST_MISMATCH', `Attempt artifact ${artifact.name} does not match its upload intent.`);
    }
    artifacts.push({ ...artifact, relativePath });
  }
  const body = {
    schemaVersion: 1,
    kind: 'attempt-evidence-inbox',
    runId,
    workItemId: intent.workItemId,
    workerId: intent.workerId,
    attempt: intent.attempt,
    coordinatorEpoch: intent.coordinatorEpoch,
    leaseToken: intent.leaseToken,
    subjectCoreDigest: intent.subjectCoreDigest,
    runnerRevision: intent.runnerRevision,
    executionDescriptorDigest: intent.executionDescriptorDigest,
    uploadIntentDigest: intent.digest,
    outcome: intent.outcome,
    reason: intent.reason,
    evidenceDigests: artifacts.map(({ memberDigest }) => memberDigest),
    artifacts,
    publishedAt: timestamp(store),
  };
  const document = { ...body, digest: canonicalDigest(body) };
  const relativePath = path.posix.join('inboxes', intent.workItemId,
    `${String(intent.attempt).padStart(6, '0')}-${intent.leaseToken}.json`);
  const file = containedPath(runDirectory(store, runId), ...relativePath.split('/'));
  let inboxDigest = document.digest;
  try {
    await atomicWriteJson(store.storage, file, document, { exclusive: true });
  } catch (error) {
    if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
    const existing = await readBoundedJson(store.storage, file, { label: 'attempt evidence inbox' });
    const { digest: existingDigest, publishedAt: existingPublishedAt, ...existingStable } = existing;
    const desiredStable = { ...body };
    delete desiredStable.publishedAt;
    if (!DIGEST_PATTERN.test(existingDigest)
      || canonicalDigest({ ...existingStable, publishedAt: existingPublishedAt }) !== existingDigest
      || canonicalJson(existingStable) !== canonicalJson(desiredStable)) {
      fail('STORE_CORRUPT', 'Immutable finalized attempt evidence inbox disagrees with its upload intent.');
    }
    inboxDigest = existingDigest;
  }
  return Object.freeze({
    runId,
    workItemId: intent.workItemId,
    attempt: intent.attempt,
    leaseToken: intent.leaseToken,
    relativePath,
    digest: inboxDigest,
  });
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
  const inboxKeys = [
    'schemaVersion', 'kind', 'runId', 'workItemId', 'workerId', 'attempt', 'coordinatorEpoch',
    'leaseToken', 'subjectCoreDigest', 'runnerRevision', 'executionDescriptorDigest', 'outcome', 'reason', 'evidenceDigests', 'artifacts', 'publishedAt', 'digest',
  ];
  const streamedUpload = 'uploadIntentDigest' in document;
  exactKeys(document, streamedUpload ? [...inboxKeys, 'uploadIntentDigest'] : inboxKeys, 'attempt evidence inbox');
  canonicalTimestamp(document.publishedAt, 'attempt evidence publishedAt');
  if (document.schemaVersion !== 1 || document.kind !== 'attempt-evidence-inbox' || document.runId !== runId
    || document.workItemId !== inbox.workItemId || document.attempt !== inbox.attempt
    || document.leaseToken !== inbox.leaseToken || !SAFE_ID.test(document.workItemId) || !SAFE_ID.test(document.workerId)
    || !Number.isSafeInteger(document.attempt) || document.attempt < 1
    || !Number.isSafeInteger(document.coordinatorEpoch) || document.coordinatorEpoch < 1
    || !WORK_OUTCOMES.has(document.outcome) || !Array.isArray(document.evidenceDigests) || !Array.isArray(document.artifacts)
    || (document.reason !== null && (typeof document.reason !== 'string' || !document.reason || document.reason.length > 256))
    || document.evidenceDigests.length > MAX_ATTEMPT_ARTIFACTS || document.artifacts.length !== document.evidenceDigests.length
    || document.evidenceDigests.some((entry) => !DIGEST_PATTERN.test(entry))
    || (streamedUpload && !DIGEST_PATTERN.test(document.uploadIntentDigest))
    || digest !== canonicalDigest(body) || digest !== inbox.digest) fail('STORE_CORRUPT', 'Attempt evidence inbox is corrupt.');
  if (document.subjectCoreDigest !== state.subjectCoreDigest || document.runnerRevision !== state.runnerRevision) {
    fail('WORK_RESULT_BINDING_MISMATCH', 'Attempt evidence does not match the run subject or runner revision.');
  }
  const expectedDescriptorDigest = state.workItems[document.workItemId]?.executionDescriptor?.digest ?? null;
  if (document.executionDescriptorDigest !== expectedDescriptorDigest) {
    fail('WORK_DESCRIPTOR_BINDING_MISMATCH', 'Attempt evidence does not match the compiler-issued execution descriptor.');
  }
  const existingItem = state.workItems[document.workItemId];
  const existingAttempt = existingItem?.attempts?.find((attempt) => attempt.attempt === document.attempt
    && attempt.workerId === document.workerId && attempt.inboxDigest === digest
    && (!streamedUpload || (attempt.leaseToken === document.leaseToken
      && attempt.uploadIntentDigest === document.uploadIntentDigest)));
  if (existingAttempt) return clone(existingItem);
  if (document.coordinatorEpoch !== coordinator?.epoch) {
    fail('STALE_WORK_LEASE', 'Attempt evidence belongs to a stale coordinator epoch.');
  }
  const artifactNames = new Set();
  let artifactBytes = 0;
  for (let index = 0; index < document.artifacts.length; index += 1) {
    const artifact = validateArtifactRecord(document.artifacts[index], {
      runId, workItemId: document.workItemId, attempt: document.attempt, leaseToken: document.leaseToken,
    });
    if (artifactNames.has(artifact.name) || document.evidenceDigests[index] !== artifact.memberDigest) {
      fail('STORE_CORRUPT', 'Attempt evidence artifact declaration is duplicated or out of order.');
    }
    artifactNames.add(artifact.name);
    artifactBytes += artifact.sizeBytes;
    if (artifactBytes > MAX_ATTEMPT_EVIDENCE_BYTES) fail('STORE_CORRUPT', 'Stored attempt evidence exceeds its total byte bound.');
    const artifactFile = containedPath(runDirectory(store, runId), ...artifact.relativePath.split('/'));
    const actual = streamedUpload
      ? await store.storage.fs.lstat(artifactFile).then((stat) => ({ sizeBytes: stat.isFile() && !stat.isSymbolicLink() ? stat.size : -1, digest: artifact.digest }))
      : await inspectBoundedArtifact(store, artifactFile,
        { label: `attempt artifact ${artifact.name}`, maximumBytes: MAX_ATTEMPT_ARTIFACT_BYTES });
    if (actual.sizeBytes !== artifact.sizeBytes || actual.digest !== artifact.digest) {
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
      authoritative: !next.executionManifest?.contextWorkItemIds.includes(document.workItemId),
      outcome: document.outcome,
      evidenceDigests: document.evidenceDigests,
    });
    const attempt = {
      attempt: document.attempt,
      outcome: document.outcome,
      evidenceDigests: document.evidenceDigests,
      artifacts: document.artifacts,
      workerId: document.workerId,
      leaseToken: document.leaseToken,
      completedAt: timestamp(store),
      reason: document.reason,
      inboxDigest: digest,
      ...(streamedUpload ? { uploadIntentDigest: document.uploadIntentDigest } : {}),
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
  const scheduler = await readPerformanceSchedulerUnlocked(store);
  if (scheduler.phase === 'running' && scheduler.reservation.runId === runId
    && scheduler.reservation.workItemId === document.workItemId
    && scheduler.reservation.attempt === document.attempt
    && scheduler.reservation.leaseToken === document.leaseToken) {
    await writePerformanceSchedulerUnlocked(store, scheduler, 'idle');
  }
  return adopted;
  }));
}

export async function readAdoptedAttemptArtifactJson(store, runId, input) {
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  const workItemId = safeId(input?.workItemId, 'workItemId');
  const name = artifactName(input?.name);
  const maximumBytes = input?.maximumBytes ?? MAX_ATTEMPT_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2 || maximumBytes > MAX_ATTEMPT_ARTIFACT_BYTES) {
    fail('STORE_SCHEMA_INVALID', 'Adopted artifact JSON byte bound is invalid.');
  }
  const item = state.workItems[workItemId] ?? (state.compilationBarrier?.id === workItemId ? state.compilationBarrier : null);
  const attempt = item?.attempts?.at(-1);
  if (!item || !['completed_pass', 'completed_product_failure'].includes(item.state)
    || !attempt || attempt.outcome !== item.state) {
    fail('ATTEMPT_ARTIFACT_UNAVAILABLE', `Work item ${workItemId} has no adopted terminal artifact.`);
  }
  const artifact = attempt.artifacts.find((entry) => entry.name === name);
  if (!artifact) fail('ATTEMPT_ARTIFACT_UNAVAILABLE', `Work item ${workItemId} did not adopt artifact ${name}.`);
  validateArtifactRecord(artifact, {
    runId,
    workItemId,
    attempt: attempt.attempt,
    leaseToken: artifact.relativePath.split('/')[2]?.replace(/^\d{6}-/, ''),
  });
  const file = containedPath(runDirectory(store, runId), ...artifact.relativePath.split('/'));
  const bytes = await readBoundedFile(store.storage, file, { label: `adopted artifact ${name}`, maximumBytes });
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (bytes.length !== artifact.sizeBytes || digest !== artifact.digest) {
    fail('ARTIFACT_DIGEST_MISMATCH', `Adopted artifact ${name} no longer matches its immutable record.`);
  }
  try { return JSON.parse(bytes.toString('utf8')); } catch {
    fail('STORE_CORRUPT', `Adopted artifact ${name} is not valid JSON.`);
  }
}

export async function cancelParentRun(store, runId, coordinator, input) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator);
    if (state.status === 'cancelled') {
      delete state.clockNow;
      return state;
    }
    const cancelled = await appendMutationUnlocked(store, state, 'mutation', 'parent-run-cancelled', (next) => {
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
    const scheduler = await readPerformanceSchedulerUnlocked(store);
    if (scheduler.phase !== 'idle' && scheduler.reservation.runId === runId) {
      await writePerformanceSchedulerUnlocked(store, scheduler, 'idle');
    }
    return cancelled;
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
    const expiredCompletedKeys = Object.entries(state.operations)
      .filter(([, operation]) => operation.state === 'completed'
        && Date.parse(operation.completedAt) + OPERATION_RETRY_WINDOW_MS <= store.clock())
      .map(([idempotencyKey]) => idempotencyKey);
    const expiredCompleted = new Set(expiredCompletedKeys);
    const existing = expiredCompleted.has(request.idempotencyKey) ? null : state.operations[request.idempotencyKey];
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
    if (Object.keys(state.operations).length - expiredCompleted.size >= MAX_OPERATION_RESOURCES) {
      fail('OPERATION_LIMIT_REACHED', 'Run operation retention limit was reached.');
    }
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
      for (const idempotencyKey of expiredCompletedKeys) delete next.operations[idempotencyKey];
      next.operations[request.idempotencyKey] = operation;
    }, { actor: request.actor, data: { idempotencyKey: request.idempotencyKey, compactedOperationCount: expiredCompletedKeys.length } });
    return clone(operation);
  }));
}

export async function getOperation(store, runId, idempotencyKey) {
  const state = await recoverUnlocked(store, runId);
  const operation = state.operations[idempotencyKey];
  if (!operation) fail('OPERATION_NOT_FOUND', `Operation ${idempotencyKey} was not found.`);
  return clone(operation);
}

export async function getOperationById(store, runId, operationId) {
  safeId(operationId, 'operationId');
  const state = await recoverUnlocked(store, runId);
  const operation = Object.values(state.operations).find((candidate) => candidate.operationId === operationId);
  if (!operation) fail('OPERATION_NOT_FOUND', `Operation ${operationId} was not found.`);
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
    const scheduler = await readPerformanceSchedulerUnlocked(store);
    if (scheduler.phase !== 'idle' && scheduler.reservation.runId === runId) {
      await writePerformanceSchedulerUnlocked(store, scheduler, 'idle');
    }
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
