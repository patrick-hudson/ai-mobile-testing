import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import {
  canonicalDigest,
  canonicalJson,
} from '../../shared/canonical-contract.mjs';
import { parsePublicationEnvelope, verifyPublicationChain } from '../../shared/publication-envelope.mjs';
import {
  parseExecutionManifest,
  parseProductFailureSignature,
  sealWorkItemResult,
} from '../../shared/execution-contract.mjs';
import { parseSingleSiteInventoryBarrier } from '../../shared/execution-graph-compiler.mjs';
import {
  parseInventoryCompilationFailure,
  sealInventoryCompilationFailure,
} from '../../shared/compilation-failure.mjs';
import { parseFinalReleaseSubject, parseReleaseSubjectCore } from '../../shared/release-subject.mjs';
import {
  parseCompileRiskInputs,
  parseRiskSourceObservationSet,
  sealRiskSourceObservationSet,
} from '../../shared/risk-source-observation.mjs';
import { parseWorkExecutionDescriptor } from '../../shared/work-execution-descriptor.mjs';
import { sealWorkItemEvidenceMember } from '../../shared/work-item-evidence-index.mjs';
import { openContainedArtifactFile } from '../../portal/safe-artifact-open.mjs';
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
  readAllLedgerIncrements,
} from './durable-ledger.mjs';

export const PARENT_RUN_STORE_SCHEMA_VERSION = 2;
export const PARENT_RUN_WRITER_PROTOCOL = 'single-coordinator-global-performance-v2';
export const RELEASE_AUTHORITY_PHASES = Object.freeze(['SHADOW', 'DRAINING', 'ACTIVE', 'PROMOTION_DISABLED']);
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const STORE_MARKER = /^[a-f0-9]{64}$/;
const LOCAL_VOLUME_DRIVERS = new Set(['local']);
const WORK_OUTCOMES = new Set([
  'completed_pass', 'completed_product_failure', 'operational_failure', 'cancelled', 'incomplete_unknown',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CUTOVER_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/;
const RESOURCE_CLASSES = new Set(['ordinary', 'performance']);
export const MAX_ATTEMPT_ARTIFACTS = 64;
export const MAX_ATTEMPT_ARTIFACT_BYTES = 512 * 1_048_576;
export const MAX_ATTEMPT_EVIDENCE_BYTES = 1_024 * 1_048_576;
const ARTIFACT_MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/i;
const MAX_OPERATION_RESOURCES = 128;
const MAX_OPERATION_BODY_BYTES = 16 * 1_024;
const OPERATION_RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const MAX_DISCOVERED_PARENT_RUNS = 2_048;
export const MAX_PARENT_RUN_RECOVERY_CACHE_ENTRIES = 64;
export const MAX_PARENT_RUN_RECOVERY_CACHE_BYTES = 64 * 1_048_576;
const MAX_BUFFERED_ATTEMPT_ARTIFACT_BYTES = 8 * 1_048_576;
const MAX_BUFFERED_ATTEMPT_EVIDENCE_BYTES = 16 * 1_048_576;
const ARTIFACT_INTEGRITY_CACHES = new WeakMap();
const PARENT_RUN_RECOVERY_CACHES = new WeakMap();
const SCHEDULING_STATE_CACHES = new WeakMap();
export const ARTIFACT_READ_LEASE_MS = 15_000;
const ARTIFACT_PURGE_DRAIN_MS = 20_000;
const MAX_HANDOFF_CANARY_FAILURE_ATTEMPTS = 3;
const MAX_HANDOFF_CANARY_PERMIT_REVISIONS = 64;
const MAX_CUTOVER_CANARY_SUPERSESSION_REVISIONS = 64;
const MAX_AUTHORITY_HANDOFF_RESERVATION_REVISIONS = 256;

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

function normalizedProductFailureSignature(value, outcome, errorCode = 'STORE_SCHEMA_INVALID') {
  if (value === undefined || value === null) return null;
  if (outcome !== 'completed_product_failure') {
    fail(errorCode, 'Only a completed product failure can carry a product-failure signature.');
  }
  try {
    return parseProductFailureSignature(value);
  } catch (error) {
    fail(errorCode, 'Product-failure signature is invalid.', { cause: error?.code ?? error?.message });
  }
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
      canonicalRiskSourceObservationSet: null,
      diagnosticExecutions: [],
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
    || !['accepted', 'applied', 'completed'].includes(value.state)
    || !canonicalTimestamp(value.acceptedAt, 'operation acceptedAt')) {
    fail('STORE_CORRUPT', `Operation ${idempotencyKey} is corrupt.`);
  }
  value.appliedAt ??= null;
  if (value.state === 'accepted' && (value.appliedAt !== null || value.completedAt !== null || value.outcome !== null)) {
    fail('STORE_CORRUPT', `Accepted operation ${idempotencyKey} has a terminal outcome.`);
  }
  if (value.state === 'applied' && (!canonicalTimestamp(value.appliedAt, 'operation appliedAt')
    || value.completedAt !== null || value.outcome !== null)) {
    fail('STORE_CORRUPT', `Applied operation ${idempotencyKey} has invalid durable state.`);
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
    schemaVersion: PARENT_RUN_STORE_SCHEMA_VERSION,
    kind: 'durable-parent-run-store',
    deploymentIdentity: value.deploymentIdentity,
    volumeIdentity: value.volumeIdentity,
    volumeDriver: value.volumeDriver,
    storeMarkerDigest: value.storeMarkerDigest,
    storeGeneration: value.storeGeneration,
    schemaFloor: value.schemaFloor,
    currentWriterProtocol: value.currentWriterProtocol,
    minimumWriterProtocol: value.minimumWriterProtocol,
    coordinatorEpoch: value.coordinatorEpoch,
    activationEpoch: value.activationEpoch,
    activationRevision: value.activationRevision,
    createdAt: value.createdAt,
    cutoverRevision: value.cutoverRevision,
    backupMarker: value.backupMarker,
    prequalifiedRollbackBuilds: value.prequalifiedRollbackBuilds,
  };
}

function validateManifest(value, { supportedSchemaVersion, writerProtocol } = {}) {
  if (value?.schemaVersion !== PARENT_RUN_STORE_SCHEMA_VERSION || value.kind !== 'durable-parent-run-store'
    || typeof value.deploymentIdentity !== 'string' || !value.deploymentIdentity
    || typeof value.volumeIdentity !== 'string' || !value.volumeIdentity
    || !LOCAL_VOLUME_DRIVERS.has(value.volumeDriver)
    || !DIGEST_PATTERN.test(value.storeMarkerDigest)
    || !Number.isSafeInteger(value.storeGeneration) || value.storeGeneration < 1
    || !Number.isSafeInteger(value.schemaFloor) || value.schemaFloor < 1
    || typeof value.currentWriterProtocol !== 'string' || !value.currentWriterProtocol
    || typeof value.minimumWriterProtocol !== 'string' || !value.minimumWriterProtocol
    || !Number.isSafeInteger(value.coordinatorEpoch) || value.coordinatorEpoch < 0
    || !Number.isSafeInteger(value.activationEpoch) || ![0, 1].includes(value.activationEpoch)
    || (value.activationRevision !== null && (!Number.isSafeInteger(value.activationRevision) || value.activationRevision < 1))
    || (value.activationEpoch === 0 && value.activationRevision !== null)
    || (value.activationEpoch === 1 && value.activationRevision === null)
    || !Number.isSafeInteger(value.cutoverRevision) || value.cutoverRevision < 0
    || (value.backupMarker !== null && (typeof value.backupMarker !== 'string' || !value.backupMarker))
    || !Array.isArray(value.prequalifiedRollbackBuilds)
    || value.prequalifiedRollbackBuilds.length < 1
    || value.prequalifiedRollbackBuilds.some((entry) => typeof entry !== 'string' || !entry)
    || new Set(value.prequalifiedRollbackBuilds).size !== value.prequalifiedRollbackBuilds.length
    || canonicalDigest(manifestBody(value)) !== value.digest) {
    fail('STORE_MANIFEST_INVALID', 'Parent-run store manifest is invalid or corrupt.');
  }
  if (value.schemaFloor > supportedSchemaVersion) {
    fail('STORE_SCHEMA_FLOOR_UNSUPPORTED', 'This build cannot open the durable store schema floor.');
  }
  if (writerProtocol !== value.currentWriterProtocol || writerProtocol !== value.minimumWriterProtocol) {
    fail('STORE_WRITER_INCOMPATIBLE', 'This build writer protocol is incompatible with the durable store.');
  }
  return value;
}

async function writeManifest(store, body) {
  const manifest = { ...manifestBody(body), digest: canonicalDigest(manifestBody(body)) };
  await atomicWriteJson(store.storage, containedPath(store.root, 'store-manifest.json'), manifest);
  store.manifest = manifest;
  return manifest;
}

async function refreshManifestUnlocked(store) {
  const manifest = validateManifest(await readBoundedJson(
    store.storage,
    containedPath(store.root, 'store-manifest.json'),
    { label: 'store manifest' },
  ), {
    supportedSchemaVersion: PARENT_RUN_STORE_SCHEMA_VERSION,
    writerProtocol: store.manifest.currentWriterProtocol,
  });
  store.manifest = manifest;
  return manifest;
}

function runDirectory(store, runId) {
  return containedPath(store.root, 'runs', safeId(runId, 'runId'));
}

function runStatePath(store, runId) {
  return path.join(runDirectory(store, runId), 'state.json');
}

function releaseSupersessionFencePath(store, runId) {
  return path.join(runDirectory(store, runId), 'release-supersession-fence.json');
}

function lockPath(store, runId) {
  return path.join(runDirectory(store, runId), '.mutation-lock');
}

function artifactReadLeaseDirectory(store, runId) {
  return path.join(runDirectory(store, runId), '.artifact-read-leases');
}

function globalLockPath(store) {
  return containedPath(store.root, '.coordinator-mutation-lock');
}

function coordinatorLeaseLockPath(store) {
  return containedPath(store.root, '.coordinator-lease-lock');
}

function globalCoordinatorPath(store) {
  return containedPath(store.root, 'coordinator.json');
}

function authoritySelectorPath(store) {
  return containedPath(store.root, 'release-authority-selector.json');
}

function authorityActivationIntentPath(store) {
  return containedPath(store.root, 'release-authority-activation-intent.json');
}

function authorityBuildPrequalificationIntentPath(store) {
  return containedPath(store.root, 'release-authority-build-prequalification-intent.json');
}

function authorityBuildPrequalificationHistoryPath(store, targetBuildIdentity) {
  const key = createHash('sha256').update(targetBuildIdentity).digest('hex');
  return containedPath(store.root, 'release-authority-build-prequalification-intents', `${key}.json`);
}

function selectorBody(value) {
  const body = {
    schemaVersion: 1,
    kind: 'release-authority-selector',
    storeMarkerDigest: value.storeMarkerDigest,
    storeGeneration: value.storeGeneration,
    phase: value.phase,
    activationEpoch: value.activationEpoch,
    activationRevision: value.activationRevision,
    activatedAt: value.activatedAt,
    activeWriterProtocol: value.activeWriterProtocol,
    minimumWriterProtocol: value.minimumWriterProtocol,
    activeBuildIdentity: value.activeBuildIdentity,
    authorityTransitionDigest: value.authorityTransitionDigest,
    activationCutoverDigest: value.activationCutoverDigest,
    backupMarker: value.backupMarker,
    prequalifiedRollbackBuilds: value.prequalifiedRollbackBuilds,
    revision: value.revision,
    previousDigest: value.previousDigest,
    updatedAt: value.updatedAt,
  };
  if (Object.hasOwn(value, 'pendingBuildIdentity')) {
    body.pendingBuildIdentity = value.pendingBuildIdentity;
    body.handoffId = value.handoffId;
  }
  return body;
}

function sealAuthoritySelector(value) {
  const body = selectorBody(value);
  return { ...body, digest: canonicalDigest(body) };
}

function validateAuthorityBuildPrequalificationIntent(store, value) {
  const { digest, ...body } = value ?? {};
  if (value?.schemaVersion !== 1 || value.kind !== 'release-authority-build-prequalification-intent'
    || typeof value.targetBuildIdentity !== 'string' || !value.targetBuildIdentity
    || !DIGEST_PATTERN.test(value.authorityTransitionDigest ?? '')
    || !Number.isSafeInteger(value.expectedTargetSelectorRevision)
    || value.expectedTargetSelectorRevision < 2
    || value.fromManifest?.digest !== value.fromManifestDigest
    || value.manifest?.digest !== value.toManifestDigest
    || value.fromSelector?.digest !== value.fromSelectorDigest
    || value.selector?.digest !== value.toSelectorDigest
    || digest !== canonicalDigest(body)) {
    fail('AUTHORITY_PREQUALIFICATION_INTENT_INVALID', 'Build-prequalification intent is corrupt or unsupported.');
  }

  const currentManifest = store.manifest;
  try {
    validateManifest(value.fromManifest, {
      supportedSchemaVersion: PARENT_RUN_STORE_SCHEMA_VERSION,
      writerProtocol: currentManifest.currentWriterProtocol,
    });
    store.manifest = value.fromManifest;
    validateAuthoritySelector(store, structuredClone(value.fromSelector));
    validateManifest(value.manifest, {
      supportedSchemaVersion: PARENT_RUN_STORE_SCHEMA_VERSION,
      writerProtocol: currentManifest.currentWriterProtocol,
    });
    store.manifest = value.manifest;
    validateAuthoritySelector(store, structuredClone(value.selector));
  } catch (error) {
    if (error instanceof ParentRunStoreError) {
      fail('AUTHORITY_PREQUALIFICATION_INTENT_INVALID', 'Build-prequalification intent contains corrupt durable state.');
    }
    throw error;
  } finally {
    store.manifest = currentManifest;
  }

  const expectedBuilds = [...value.fromManifest.prequalifiedRollbackBuilds, value.targetBuildIdentity].sort();
  const expectedManifest = {
    ...manifestBody(value.fromManifest),
    prequalifiedRollbackBuilds: expectedBuilds,
  };
  const expectedSelector = sealAuthoritySelector({
    ...value.fromSelector,
    prequalifiedRollbackBuilds: expectedBuilds,
    authorityTransitionDigest: value.authorityTransitionDigest,
    revision: value.expectedTargetSelectorRevision,
    previousDigest: value.fromSelector.digest,
    updatedAt: value.selector.updatedAt,
  });
  if (value.fromSelector.phase !== 'ACTIVE' || value.fromSelector.activationEpoch !== 1
    || value.fromSelector.pendingBuildIdentity !== null
    || value.targetBuildIdentity === value.fromSelector.activeBuildIdentity
    || value.fromManifest.prequalifiedRollbackBuilds.includes(value.targetBuildIdentity)
    || new Set(expectedBuilds).size !== expectedBuilds.length
    || value.expectedTargetSelectorRevision !== value.fromSelector.revision + 1
    || canonicalJson(value.fromSelector.prequalifiedRollbackBuilds)
      !== canonicalJson(value.fromManifest.prequalifiedRollbackBuilds)
    || canonicalJson(value.manifest) !== canonicalJson({
      ...expectedManifest, digest: canonicalDigest(expectedManifest),
    })
    || canonicalJson(value.selector) !== canonicalJson(expectedSelector)) {
    fail('AUTHORITY_PREQUALIFICATION_INTENT_INVALID', 'Build-prequalification intent does not describe one append-only transition.');
  }
  return value;
}

async function persistAuthorityBuildPrequalificationIntent(store, intent) {
  const directory = containedPath(store.root, 'release-authority-build-prequalification-intents');
  const file = authorityBuildPrequalificationHistoryPath(store, intent.targetBuildIdentity);
  await ensureDirectory(store.storage.fs, directory);
  const assertExistingMatches = async () => {
    const existing = validateAuthorityBuildPrequalificationIntent(store, await readBoundedJson(
      store.storage,
      file,
      { label: 'release-authority build-prequalification history', maximumBytes: 256 * 1_024 },
    ));
    if (canonicalJson(existing) !== canonicalJson(intent)) {
      fail('AUTHORITY_PREQUALIFICATION_INTENT_INVALID', 'Build-prequalification history conflicts with the durable intent.');
    }
  };
  if (await pathExists(store.storage.fs, file)) {
    await assertExistingMatches();
    return;
  }
  try {
    await atomicWriteJson(store.storage, file, intent, { exclusive: true });
  } catch (error) {
    if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
    await assertExistingMatches();
  }
}

async function recoverAuthorityBuildPrequalificationIntentUnlocked(store) {
  const intentPath = authorityBuildPrequalificationIntentPath(store);
  if (!await pathExists(store.storage.fs, intentPath)) return false;
  let rawIntent;
  try {
    rawIntent = await readBoundedJson(store.storage, intentPath, {
      label: 'release-authority build-prequalification intent', maximumBytes: 256 * 1_024,
    });
  } catch (error) {
    if (error?.code === 'ATOMIC_NOT_FOUND') return false;
    throw error;
  }
  const intent = validateAuthorityBuildPrequalificationIntent(store, rawIntent);
  let selector;
  try {
    selector = await readBoundedJson(store.storage, authoritySelectorPath(store), {
      label: 'release-authority selector',
    });
  } catch (error) {
    if (error?.code === 'ATOMIC_NOT_FOUND') {
      fail('AUTHORITY_PREQUALIFICATION_INTENT_INVALID', 'Build-prequalification recovery found no selector.');
    }
    throw error;
  }

  const manifestDigest = store.manifest.digest;
  const selectorDigest = selector?.digest;
  if (manifestDigest === intent.fromManifestDigest && selectorDigest === intent.fromSelectorDigest) {
    await atomicWriteJson(store.storage, containedPath(store.root, 'store-manifest.json'), intent.manifest);
    store.manifest = intent.manifest;
    await atomicWriteJson(store.storage, authoritySelectorPath(store), intent.selector);
  } else if (manifestDigest === intent.toManifestDigest && selectorDigest === intent.fromSelectorDigest) {
    await atomicWriteJson(store.storage, authoritySelectorPath(store), intent.selector);
  } else if (manifestDigest !== intent.toManifestDigest || selectorDigest !== intent.toSelectorDigest) {
    fail('AUTHORITY_PREQUALIFICATION_INTENT_INVALID', 'Build-prequalification recovery found conflicting durable state.');
  }
  store.manifest = intent.manifest;
  await persistAuthorityBuildPrequalificationIntent(store, intent);
  await store.storage.fs.rm(intentPath, { force: true });
  return true;
}

function manifestCarriesPrequalificationTransition(current, intended) {
  if (!Number.isSafeInteger(current?.coordinatorEpoch)
    || current.coordinatorEpoch < intended.coordinatorEpoch) return false;
  return canonicalJson({ ...manifestBody(current), coordinatorEpoch: intended.coordinatorEpoch })
    === canonicalJson(manifestBody(intended));
}

function manifestIsCoordinatorSuccessor(current, expected) {
  if (!Number.isSafeInteger(current?.coordinatorEpoch)
    || current.coordinatorEpoch < expected.coordinatorEpoch) return false;
  return canonicalJson({ ...manifestBody(current), coordinatorEpoch: expected.coordinatorEpoch })
    === canonicalJson(manifestBody(expected));
}

async function migrateLegacyShadowAuthoritySelector(store) {
  const file = authoritySelectorPath(store);
  const value = await readBoundedJson(store.storage, file, { label: 'release-authority selector' });
  const missingTransitionDigest = !Object.hasOwn(value, 'authorityTransitionDigest');
  const missingCutoverDigest = !Object.hasOwn(value, 'activationCutoverDigest');
  if (!missingTransitionDigest && !missingCutoverDigest) return false;
  if (!missingTransitionDigest || !missingCutoverDigest
    || value.phase !== 'SHADOW' || value.activationEpoch !== 0
    || value.activationRevision !== null || value.activatedAt !== null
    || value.activeWriterProtocol !== null || value.activeBuildIdentity !== null) return false;

  const legacyBody = selectorBody(value);
  delete legacyBody.authorityTransitionDigest;
  delete legacyBody.activationCutoverDigest;
  if (canonicalDigest(legacyBody) !== value.digest) return false;

  const upgraded = sealAuthoritySelector({
    ...value,
    authorityTransitionDigest: null,
    activationCutoverDigest: null,
    revision: value.revision + 1,
    previousDigest: value.digest,
    updatedAt: timestamp(store),
  });
  validateAuthoritySelector(store, structuredClone(upgraded));
  await atomicWriteJson(store.storage, file, upgraded);
  return true;
}

function validateAuthoritySelector(store, value) {
  const body = selectorBody(value ?? {});
  if (value?.schemaVersion !== 1 || value.kind !== 'release-authority-selector'
    || value.storeMarkerDigest !== store.manifest.storeMarkerDigest
    || value.storeGeneration !== store.manifest.storeGeneration
    || !RELEASE_AUTHORITY_PHASES.includes(value.phase)
    || value.activationEpoch !== store.manifest.activationEpoch
    || value.activationRevision !== store.manifest.activationRevision
    || (value.activationRevision !== null && (!Number.isSafeInteger(value.activationRevision) || value.activationRevision < 1))
    || (value.activatedAt !== null && typeof value.activatedAt !== 'string')
    || (value.activeWriterProtocol !== null && typeof value.activeWriterProtocol !== 'string')
    || value.minimumWriterProtocol !== store.manifest.minimumWriterProtocol
    || (value.activeBuildIdentity !== null && typeof value.activeBuildIdentity !== 'string')
    || (value.authorityTransitionDigest !== null && !DIGEST_PATTERN.test(value.authorityTransitionDigest))
    || (value.activationCutoverDigest !== null && !DIGEST_PATTERN.test(value.activationCutoverDigest))
    || value.backupMarker !== store.manifest.backupMarker
    || canonicalJson(value.prequalifiedRollbackBuilds) !== canonicalJson(store.manifest.prequalifiedRollbackBuilds)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.previousDigest !== null && !DIGEST_PATTERN.test(value.previousDigest))
    || typeof value.updatedAt !== 'string'
    || canonicalDigest(body) !== value.digest) {
    fail('AUTHORITY_SELECTOR_INVALID', 'Release-authority selector is invalid, stale, or corrupt.');
  }
  value.pendingBuildIdentity ??= null;
  value.handoffId ??= null;
  const activated = ['ACTIVE', 'PROMOTION_DISABLED'].includes(value.phase);
  if ((activated && (value.activationEpoch !== 1 || value.activationRevision === null
      || value.activatedAt === null || value.activeWriterProtocol !== store.manifest.currentWriterProtocol
      || value.activeBuildIdentity === null || value.authorityTransitionDigest === null
      || value.activationCutoverDigest === null))
    || (!activated && (value.activationEpoch !== 0 || value.activationRevision !== null
      || value.activatedAt !== null || value.activeWriterProtocol !== null || value.activeBuildIdentity !== null
      || value.authorityTransitionDigest !== null || value.activationCutoverDigest !== null))) {
    fail('AUTHORITY_SELECTOR_INVALID', 'Release-authority selector activation fields disagree with its phase.');
  }
  if ((value.pendingBuildIdentity === null) !== (value.handoffId === null)
    || (value.pendingBuildIdentity !== null && (value.phase !== 'PROMOTION_DISABLED'
      || value.pendingBuildIdentity === value.activeBuildIdentity
      || !value.prequalifiedRollbackBuilds.includes(value.pendingBuildIdentity)
      || !SAFE_ID.test(value.handoffId)))) {
    fail('AUTHORITY_SELECTOR_INVALID', 'Release-authority handoff fields are contradictory.');
  }
  if (value.phase === 'ACTIVE' && (value.pendingBuildIdentity !== null || value.handoffId !== null)) {
    fail('AUTHORITY_SELECTOR_INVALID', 'Active release authority cannot retain a pending build handoff.');
  }
  return value;
}

async function readAuthoritySelectorUnlocked(store) {
  await refreshManifestUnlocked(store);
  await recoverAuthorityBuildPrequalificationIntentUnlocked(store);
  let selector;
  try {
    selector = await readBoundedJson(store.storage, authoritySelectorPath(store), { label: 'release-authority selector' });
  } catch (error) {
    if (error?.code === 'ATOMIC_NOT_FOUND') fail('AUTHORITY_SELECTOR_INVALID', 'Release-authority selector is missing.');
    throw error;
  }
  try {
    const validated = validateAuthoritySelector(store, selector);
    await assertExternalAuthorityFloor(store, validated);
    return validated;
  } catch (error) {
    if (error?.code !== 'AUTHORITY_SELECTOR_INVALID' || store.manifest.activationEpoch !== 1) throw error;
    let intent;
    try {
      intent = await readBoundedJson(store.storage, authorityActivationIntentPath(store), { label: 'release-authority activation intent' });
    } catch (intentError) {
      if (intentError?.code === 'ATOMIC_NOT_FOUND') throw error;
      throw intentError;
    }
    const { digest, ...body } = intent ?? {};
    if (intent?.schemaVersion !== 1 || intent.kind !== 'release-authority-activation-intent'
      || !DIGEST_PATTERN.test(intent.fromSelectorDigest)
      || intent.storeGeneration !== store.manifest.storeGeneration
      || intent.activationRevision !== store.manifest.activationRevision
      || intent.selector?.digest !== intent.toSelectorDigest
      || digest !== canonicalDigest(body)) {
      fail('AUTHORITY_SELECTOR_INVALID', 'Interrupted release-authority activation intent is corrupt.');
    }
    const recovered = validateAuthoritySelector(store, intent.selector);
    if (recovered.phase !== 'ACTIVE' || recovered.previousDigest !== intent.fromSelectorDigest) {
      fail('AUTHORITY_SELECTOR_INVALID', 'Interrupted release-authority activation cannot recover a non-active selector.');
    }
    await atomicWriteJson(store.storage, authoritySelectorPath(store), recovered);
    await store.storage.fs.rm(authorityActivationIntentPath(store), { force: true });
    await assertExternalAuthorityFloor(store, recovered);
    return recovered;
  }
}

async function assertExternalAuthorityFloor(store, selector) {
  if (store.authorityFloor === null) return null;
  const legacyFence = await store.legacyAuthorityFence.read();
  return store.authorityFloor.assertAuthorityState({
    manifest: store.manifest,
    selector,
    legacyFence,
  });
}

function authorityBinding(store, selector) {
  const body = {
    storeMarkerDigest: store.manifest.storeMarkerDigest,
    storeGeneration: store.manifest.storeGeneration,
    activationEpoch: selector.activationEpoch,
    writerProtocol: store.manifest.currentWriterProtocol,
  };
  return Object.freeze({ ...body, digest: canonicalDigest(body) });
}

function handoffCanaryPermitPath(store, handoffId, mode) {
  return containedPath(store.root, 'authority-handoff-permits', `${safeId(handoffId, 'handoffId')}-${mode}.json`);
}

function handoffCanaryPermitHistoryPath(store, permitDigest) {
  if (!DIGEST_PATTERN.test(permitDigest)) fail('AUTHORITY_HANDOFF_PERMIT_INVALID', 'Handoff canary permit digest is invalid.');
  return containedPath(store.root, 'authority-handoff-permits', 'history', `${permitDigest.slice('sha256:'.length)}.json`);
}

function cutoverCanarySupersessionFenceIdentity(value) {
  return {
    schemaVersion: 1,
    kind: 'release-cutover-canary-supersession-fence',
    runId: value.runId,
    cutoverId: value.cutoverId,
    mode: value.mode,
    replacementRevision: value.replacementRevision,
    sourcePermitDigest: value.sourcePermitDigest,
    requestId: value.requestId,
    authorizationDigest: value.authorizationDigest,
    authoritySelectorDigest: value.authoritySelectorDigest,
    supersedeReason: value.supersedeReason,
  };
}

function cutoverCanarySupersessionFenceBody(value) {
  return {
    ...cutoverCanarySupersessionFenceIdentity(value),
    fencedAt: value.fencedAt,
  };
}

function sealCutoverCanarySupersessionFence(value) {
  const body = cutoverCanarySupersessionFenceBody(value);
  return { ...body, digest: canonicalDigest(body) };
}

function validateCutoverCanarySupersessionFence(value, runId) {
  const body = cutoverCanarySupersessionFenceBody(value ?? {});
  exactKeys(value, [...Object.keys(body), 'digest'], 'cutover canary supersession fence');
  if (value.schemaVersion !== 1 || value.kind !== 'release-cutover-canary-supersession-fence'
    || value.runId !== runId || !SAFE_ID.test(value.runId) || !SAFE_ID.test(value.cutoverId)
    || !['single-site', 'comparative'].includes(value.mode)
    || !Number.isSafeInteger(value.replacementRevision) || value.replacementRevision < 2
    || value.replacementRevision > MAX_CUTOVER_CANARY_SUPERSESSION_REVISIONS
    || !DIGEST_PATTERN.test(value.sourcePermitDigest)
    || !CUTOVER_REQUEST_ID_PATTERN.test(value.requestId) || !DIGEST_PATTERN.test(value.authorizationDigest)
    || !DIGEST_PATTERN.test(value.authoritySelectorDigest)
    || typeof value.supersedeReason !== 'string' || !value.supersedeReason.trim()
    || value.supersedeReason.length > 2_048 || value.supersedeReason.includes('\0')
    || value.digest !== canonicalDigest(body)) {
    fail('STORE_CORRUPT', 'Cutover canary supersession fence is invalid or corrupt.');
  }
  canonicalTimestamp(value.fencedAt, 'cutover canary supersession fencedAt');
  return value;
}

async function readCutoverCanarySupersessionFenceUnlocked(store, runId) {
  let value;
  try {
    value = await readBoundedJson(store.storage, releaseSupersessionFencePath(store, runId), {
      label: 'cutover canary supersession fence', maximumBytes: 64 * 1_024,
    });
  } catch (error) {
    if (error?.code === 'ATOMIC_NOT_FOUND') return null;
    fail('STORE_CORRUPT', 'Cutover canary supersession fence is unreadable or corrupt.', {
      cause: error?.code ?? error?.message,
    });
  }
  return validateCutoverCanarySupersessionFence(value, runId);
}

function cutoverCanarySupersessionMatches(fence, intended) {
  return canonicalJson(cutoverCanarySupersessionFenceIdentity(fence))
    === canonicalJson(cutoverCanarySupersessionFenceIdentity(intended));
}

function sealHandoffCanaryPermit(value) {
  const body = {
    schemaVersion: 1,
    kind: 'release-authority-handoff-canary-permit',
    handoffId: value.handoffId,
    mode: value.mode,
    runId: value.runId,
    targetBuildIdentity: value.targetBuildIdentity,
    selectorDigest: value.selectorDigest,
    coordinatorEpoch: value.coordinatorEpoch,
    registeredAt: value.registeredAt,
  };
  if (Object.hasOwn(value, 'revision')) {
    body.revision = value.revision;
    body.previousPermitDigest = value.previousPermitDigest;
    body.supersedesRunId = value.supersedesRunId;
    body.supersedeAuthorizationDigest = value.supersedeAuthorizationDigest;
    if (Object.hasOwn(value, 'failureAttempts')) body.failureAttempts = value.failureAttempts;
  }
  return { ...body, digest: canonicalDigest(body) };
}

function validateHandoffCanaryPermit(value, selector, mode = null) {
  const modern = Object.hasOwn(value ?? {}, 'revision');
  const body = sealHandoffCanaryPermit(value ?? {});
  const keys = Object.keys(body);
  exactKeys(value, keys, 'release-authority handoff canary permit');
  if (value?.schemaVersion !== 1 || value.kind !== 'release-authority-handoff-canary-permit'
    || value.handoffId !== selector.handoffId || value.targetBuildIdentity !== selector.pendingBuildIdentity
    || value.selectorDigest !== selector.digest || !['single-site', 'comparative'].includes(value.mode)
    || (mode !== null && value.mode !== mode) || !SAFE_ID.test(value.runId)
    || !Number.isSafeInteger(value.coordinatorEpoch) || value.coordinatorEpoch < 1
    || !Number.isFinite(Date.parse(value.registeredAt)) || value.digest !== body.digest) {
    fail('AUTHORITY_HANDOFF_PERMIT_INVALID', 'Release-authority handoff canary permit is invalid or stale.');
  }
  if (modern && (!Number.isSafeInteger(value.revision) || value.revision < 1
    || value.revision > MAX_HANDOFF_CANARY_PERMIT_REVISIONS
    || ((value.revision === 1) !== (value.previousPermitDigest === null))
    || (value.revision === 1 && (value.supersedesRunId !== null || value.supersedeAuthorizationDigest !== null))
    || (value.revision > 1 && (!DIGEST_PATTERN.test(value.previousPermitDigest ?? '')
      || !SAFE_ID.test(value.supersedesRunId ?? '') || value.supersedesRunId === value.runId
      || !DIGEST_PATTERN.test(value.supersedeAuthorizationDigest ?? ''))))) {
    fail('AUTHORITY_HANDOFF_PERMIT_INVALID', 'Release-authority handoff canary permit lineage is invalid.');
  }
  if (modern && Object.hasOwn(value, 'failureAttempts')
    && (!Number.isSafeInteger(value.failureAttempts) || value.failureAttempts < 0
      || value.failureAttempts > MAX_HANDOFF_CANARY_FAILURE_ATTEMPTS)) {
    fail('AUTHORITY_HANDOFF_PERMIT_INVALID', 'Release-authority handoff canary failure-attempt count is invalid.');
  }
  return value;
}

async function persistImmutableHandoffCanaryPermit(store, permit) {
  const history = containedPath(store.root, 'authority-handoff-permits', 'history');
  await ensureDirectory(store.storage.fs, history);
  const file = handoffCanaryPermitHistoryPath(store, permit.digest);
  if (await pathExists(store.storage.fs, file)) {
    const existing = await readBoundedJson(store.storage, file, {
      label: 'immutable release-authority handoff canary permit', maximumBytes: 64 * 1_024,
    });
    if (canonicalJson(existing) !== canonicalJson(permit)) {
      fail('AUTHORITY_HANDOFF_PERMIT_INVALID', 'Immutable handoff canary permit digest was reused with different bytes.');
    }
    return;
  }
  await atomicWriteJson(store.storage, file, permit, { exclusive: true });
}

async function assertHandoffCanaryPermitReplaceableUnlocked(store, permit) {
  const state = await recoverUnlocked(store, permit.runId);
  const workItems = Object.values(state.workItems ?? {});
  if (workItems.length === 0 || workItems.some((item) => (
    !['completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(item.state)
  ))) {
    fail('AUTHORITY_HANDOFF_PERMIT_CONFLICT', 'Handoff canary replacement requires a durable terminal prior run.');
  }
  if (state.currentPublicationDigest !== null) {
    const publication = (await readPublicationChain(store, permit.runId, state.currentPublicationDigest)).at(-1);
    if (publication.decision?.ready === true) {
      fail('AUTHORITY_HANDOFF_PERMIT_CONFLICT', 'A current ready handoff canary cannot be replaced.');
    }
  }
  return state;
}

function handoffRunConsumesFailureBudget(state) {
  const workItems = Object.values(state.workItems ?? {});
  if (state.status !== 'cancelled') return true;
  return workItems.some((item) => (
    item.state === 'completed_product_failure'
    || item.state === 'incomplete'
    || (Array.isArray(item.attempts) && item.attempts.some((attempt) => attempt.outcome === 'completed_product_failure'))
    || (Array.isArray(item.attempts) && item.attempts.some(
      (attempt) => ['operational_failure', 'incomplete_unknown'].includes(attempt.outcome),
    ))
  ));
}

async function failureAttemptsAfterHandoffPermit(store, selector, permit, currentState) {
  if (Object.hasOwn(permit, 'failureAttempts')) {
    return permit.failureAttempts + (handoffRunConsumesFailureBudget(currentState) ? 1 : 0);
  }
  let cursor = permit;
  let state = currentState;
  let failures = 0;
  for (let depth = 0; depth < MAX_HANDOFF_CANARY_PERMIT_REVISIONS; depth += 1) {
    if (handoffRunConsumesFailureBudget(state)) failures += 1;
    if (!Object.hasOwn(cursor, 'revision')) return failures;
    if (cursor.previousPermitDigest === null) return failures;
    const previous = validateHandoffCanaryPermit(await readBoundedJson(
      store.storage,
      handoffCanaryPermitHistoryPath(store, cursor.previousPermitDigest),
      { label: 'immutable release-authority handoff canary permit', maximumBytes: 64 * 1_024 },
    ), selector, permit.mode);
    if (previous.digest !== cursor.previousPermitDigest || previous.revision !== cursor.revision - 1
      || cursor.supersedesRunId !== previous.runId) {
      fail('AUTHORITY_HANDOFF_PERMIT_INVALID', 'Release-authority handoff canary permit history is not contiguous.');
    }
    cursor = previous;
    state = await recoverUnlocked(store, cursor.runId);
  }
  fail('AUTHORITY_HANDOFF_PERMIT_INVALID', 'Release-authority handoff canary permit history exceeds its bound.');
}

async function requireHandoffRunPermit(store, selector, runId) {
  if (selector.pendingBuildIdentity === null) return;
  for (const mode of ['single-site', 'comparative']) {
    const file = handoffCanaryPermitPath(store, selector.handoffId, mode);
    if (!await pathExists(store.storage.fs, file)) continue;
    const permit = validateHandoffCanaryPermit(await readBoundedJson(store.storage, file, {
      label: 'release-authority handoff canary permit', maximumBytes: 64 * 1_024,
    }), selector, mode);
    if (permit.runId === runId) return;
  }
  fail('AUTHORITY_HANDOFF_CANARY_REQUIRED', 'Pending target may access only a permitted handoff health canary.');
}

async function requirePublicationAuthority(store, runId) {
  const selector = await readAuthoritySelectorUnlocked(store);
  if (!['ACTIVE', 'PROMOTION_DISABLED'].includes(selector.phase)) {
    fail('RELEASE_AUTHORITY_INACTIVE', `Direct release publication requires activated shared authority; current phase is ${selector.phase}.`);
  }
  const expectedBuildIdentity = selector.pendingBuildIdentity ?? selector.activeBuildIdentity;
  if (store.buildIdentity !== expectedBuildIdentity
    || selector.activeWriterProtocol !== store.manifest.currentWriterProtocol) {
    fail('STORE_WRITER_INCOMPATIBLE', 'The active selector does not authorize this build and writer protocol.');
  }
  if (selector.phase === 'PROMOTION_DISABLED' && selector.pendingBuildIdentity !== null) {
    await requireHandoffRunPermit(store, selector, runId);
  }
  return { selector, binding: authorityBinding(store, selector) };
}

function performanceSchedulerPath(store) {
  return containedPath(store.root, 'performance-scheduler.json');
}

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

function normalizedRiskSourceObservationSet(value, identity) {
  const source = value ?? sealRiskSourceObservationSet({
    schemaVersion: 1,
    runId: identity.runId,
    workItemId: identity.workItemId,
    subjectCoreDigest: identity.subjectCoreDigest,
    attempt: identity.attempt,
    workerId: identity.workerId,
    producerStates: [
      { producer: 'visual', status: 'UNAVAILABLE' },
      { producer: 'baseline', status: 'UNAVAILABLE' },
      { producer: 'evidence-pipeline', status: 'UNAVAILABLE' },
    ],
    observations: [],
  });
  let parsed;
  try { parsed = parseRiskSourceObservationSet(source); } catch (error) {
    fail(error?.code ?? 'STORE_SCHEMA_INVALID', `Risk source observation set is invalid: ${error.message}`);
  }
  if (parsed.runId !== identity.runId || parsed.workItemId !== identity.workItemId
    || parsed.subjectCoreDigest !== identity.subjectCoreDigest || parsed.attempt !== identity.attempt
    || parsed.workerId !== identity.workerId) {
    fail('WORK_RESULT_BINDING_MISMATCH', 'Risk source observations do not match the fenced work-item attempt.');
  }
  return parsed;
}

async function readGlobalCoordinator(store) {
  let value;
  try { value = await readBoundedJson(store.storage, globalCoordinatorPath(store), { label: 'global coordinator lease' }); } catch (error) {
    if (error?.code === 'ATOMIC_NOT_FOUND') return null;
    fail('STORE_CORRUPT', 'Global coordinator lease is unreadable.', { cause: error?.code ?? error?.message });
  }
  const buildBound = Object.hasOwn(value ?? {}, 'buildIdentity');
  exactKeys(value, ['schemaVersion', 'kind', ...(buildBound ? ['buildIdentity'] : []), 'ownerId', 'epoch', 'token', 'acquiredAt', 'expiresAt', 'digest'], 'global coordinator lease');
  const { digest, ...body } = value;
  if (value.schemaVersion !== 1 || value.kind !== 'global-coordinator-lease'
    || !SAFE_ID.test(value.ownerId) || !SAFE_ID.test(value.token)
    || (buildBound && (typeof value.buildIdentity !== 'string' || !value.buildIdentity))
    || !Number.isSafeInteger(value.epoch) || value.epoch < 1
    || value.epoch > store.manifest.coordinatorEpoch
    || canonicalTimestamp(value.acquiredAt, 'coordinator acquiredAt') >= canonicalTimestamp(value.expiresAt, 'coordinator expiresAt')
    || digest !== canonicalDigest(body)) {
    fail('STORE_CORRUPT', 'Global coordinator lease is invalid or corrupt.');
  }
  value.buildIdentity ??= null;
  return value;
}

export async function readStoreCoordinator(store) {
  const coordinator = await readGlobalCoordinator(store);
  return coordinator === null ? null : clone(coordinator);
}

function sealCoordinatorLease(value) {
  const body = {
    schemaVersion: 1,
    kind: 'global-coordinator-lease',
    buildIdentity: value.buildIdentity,
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
  value.diagnosticExecutionId ??= null;
  const drainingKeys = [
    'workerId', 'runId', 'workItemId', 'diagnosticExecutionId', 'coordinatorEpoch', 'requestedAt', 'expiresAt',
  ];
  const runningKeys = [...drainingKeys, 'attempt', 'leaseToken', 'acquiredAt'];
  exactKeys(value, phase === 'running' ? runningKeys : drainingKeys, 'store performance reservation');
  if (!SAFE_ID.test(value.workerId) || !SAFE_ID.test(value.runId) || !SAFE_ID.test(value.workItemId)
    || (value.diagnosticExecutionId !== null && !/^[a-f0-9]{64}$/u.test(value.diagnosticExecutionId))
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

async function validateCoordinator(store, coordinator, runId = null) {
  await refreshManifestUnlocked(store);
  const current = await readGlobalCoordinator(store);
  const selector = await readAuthoritySelectorUnlocked(store);
  const permittedBuild = selector.pendingBuildIdentity ?? selector.activeBuildIdentity ?? store.buildIdentity;
  if (!coordinator || current === null
    || coordinator.epoch !== current.epoch
    || coordinator.token !== current.token
    || coordinator.ownerId !== current.ownerId
    || current.buildIdentity !== store.buildIdentity
    || store.buildIdentity !== permittedBuild) {
    fail('STALE_COORDINATOR', 'Coordinator epoch or fencing token is stale.');
  }
  if (Date.parse(current.expiresAt) <= store.clock()) {
    fail('STALE_COORDINATOR', 'Coordinator lease expired.');
  }
  if (runId !== null) await requireHandoffRunPermit(store, selector, runId);
  return current;
}

function normalizeRecoveredState(store, snapshot, checkpoints) {
  const next = clone(snapshot);
  next.ledgerSequences = {};
  next.ledgerHeads = {};
  for (const kind of LEDGER_KINDS) {
    next.ledgerSequences[kind] = checkpoints[kind].count;
    next.ledgerHeads[kind] = checkpoints[kind].headDigest;
  }
  next.clockNow = store.clock();
  return next;
}

function eventSummary(event) {
  const { stateSnapshot: _stateSnapshot, ...summary } = event;
  return summary;
}

function parentRunRecoveryCache(store) {
  const cache = PARENT_RUN_RECOVERY_CACHES.get(store);
  if (!cache) fail('STORE_CORRUPT', 'Parent-run recovery cache is unavailable.');
  return cache;
}

function recoveryCacheGet(store, runId, { touch = true } = {}) {
  const cache = parentRunRecoveryCache(store);
  const entry = cache.entries.get(runId);
  if (!entry) return null;
  if (touch) {
    cache.entries.delete(runId);
    cache.entries.set(runId, entry);
  }
  return entry.value;
}

function recoveryCacheDelete(store, runId) {
  const cache = parentRunRecoveryCache(store);
  const entry = cache.entries.get(runId);
  if (!entry) return;
  cache.entries.delete(runId);
  cache.bytes -= entry.bytes;
}

function recoveryCacheSet(store, runId, value) {
  const cache = parentRunRecoveryCache(store);
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  recoveryCacheDelete(store, runId);
  // Correctness never depends on retaining an accelerator entry. An unusually
  // large run is fully validated for each access instead of being allowed to
  // consume the process-wide cache budget by itself.
  if (bytes > MAX_PARENT_RUN_RECOVERY_CACHE_BYTES) return false;
  while (cache.entries.size >= MAX_PARENT_RUN_RECOVERY_CACHE_ENTRIES
    || cache.bytes + bytes > MAX_PARENT_RUN_RECOVERY_CACHE_BYTES) {
    // Retained terminal history is the first eviction tier. A large archive
    // must not repeatedly displace the queued/running state needed by claims.
    let evictionRunId = null;
    for (const candidateRunId of cache.entries.keys()) {
      if (!schedulingStateCache(store).relevantRunIds.has(candidateRunId)) {
        evictionRunId = candidateRunId;
        break;
      }
    }
    evictionRunId ??= cache.entries.keys().next().value;
    if (evictionRunId === undefined) break;
    recoveryCacheDelete(store, evictionRunId);
  }
  cache.entries.set(runId, Object.freeze({ value, bytes }));
  cache.bytes += bytes;
  return true;
}

function isSchedulingRelevantState(state) {
  if (state.status !== 'active' || state.authorityTombstone !== null) return false;
  if (state.resourceScheduling.performanceDrain !== null || state.resourceScheduling.exclusiveLease !== null) return true;
  return Object.values(state.workItems).some((item) => (
    ['queued', 'running'].includes(item.state)
    || item.diagnosticExecutions.some((diagnostic) => ['queued', 'running'].includes(diagnostic.state))
  ));
}

function schedulingStateCache(store) {
  const cache = SCHEDULING_STATE_CACHES.get(store);
  if (!cache) fail('STORE_CORRUPT', 'Parent-run scheduling-state cache is unavailable.');
  return cache;
}

function noteSchedulingState(store, state) {
  const cache = schedulingStateCache(store);
  cache.knownRunIds.add(state.runId);
  if (isSchedulingRelevantState(state)) cache.relevantRunIds.add(state.runId);
  else cache.relevantRunIds.delete(state.runId);
}

function cachedHistorySummaries(store, runId) {
  const cached = recoveryCacheGet(store, runId);
  if (!cached) fail('STORE_CORRUPT', `Parent run ${runId} has no verified recovery cache.`);
  return structuredClone(cached.histories);
}

async function repairRecoveredStateCache(store, runId, state) {
  let cached = null;
  try { cached = await readBoundedJson(store.storage, runStatePath(store, runId), { label: 'parent-run state' }); } catch {}
  const comparableState = { ...state };
  delete comparableState.clockNow;
  // An unlocked reader may have observed a stable ledger prefix immediately
  // before another process committed a newer suffix and state cache. Never
  // regress that newer derived cache; the next recovery will consume its event.
  if (Number.isSafeInteger(cached?.runRevision) && cached.runRevision > comparableState.runRevision) return false;
  if (cached === null || canonicalJson(cached) !== canonicalJson(comparableState)) {
    await atomicWriteJson(store.storage, runStatePath(store, runId), comparableState);
  }
  return true;
}

async function recoverUnlocked(store, runId, { repairCache = true, captureHistories = null } = {}) {
  const directory = runDirectory(store, runId);
  if (!await pathExists(store.storage.fs, directory)) fail('RUN_NOT_FOUND', `Parent run ${runId} was not found.`);
  const cachedRecovery = recoveryCacheGet(store, runId);
  let increment;
  try {
    increment = await readAllLedgerIncrements(store.storage, directory, cachedRecovery?.checkpoints ?? null);
  } catch (error) {
    // A changed immutable prefix is an integrity failure for this access. Drop
    // only the process-local accelerator so a later access must perform the
    // same complete cold validation used after process startup.
    recoveryCacheDelete(store, runId);
    fail('STORE_CORRUPT', `Parent run ${runId} has a corrupt append-only history.`, { cause: error?.message });
  }
  const { ledgers, checkpoints } = increment;
  const events = Object.values(ledgers).flat().sort((left, right) => left.runRevision - right.runRevision);
  const priorRevision = cachedRecovery?.state.runRevision ?? 0;
  if (events.length === 0) {
    if (!cachedRecovery) fail('STORE_CORRUPT', `Parent run ${runId} has an empty append-only history.`);
    captureHistories?.(cachedRecovery.histories);
    if (repairCache && !cachedRecovery.stateCacheVerified) {
      const stateCacheVerified = await repairRecoveredStateCache(store, runId, cachedRecovery.state);
      const currentRecovery = recoveryCacheGet(store, runId, { touch: false });
      if (stateCacheVerified && currentRecovery?.state.runRevision === cachedRecovery.state.runRevision) {
        recoveryCacheSet(store, runId, Object.freeze({ ...currentRecovery, stateCacheVerified: true }));
      }
    }
    noteSchedulingState(store, cachedRecovery.state);
    return { ...structuredClone(cachedRecovery.state), clockNow: store.clock() };
  }
  if (events.some((event, index) => event.runRevision !== priorRevision + index + 1)) {
    fail('STORE_CORRUPT', `Parent run ${runId} has a missing or duplicate run revision.`);
  }
  const latest = events.at(-1);
  const snapshot = latest.stateSnapshot;
  snapshot.authorityTombstone ??= null;
  snapshot.currentPublicationAuthorityBinding ??= null;
  snapshot.compilationBarrier ??= null;
  snapshot.compilationFailure ??= null;
  snapshot.inventoryBarrierPlan ??= null;
  snapshot.sealedCompileRiskInputs ??= null;
  if (snapshot?.schemaVersion !== 1 || snapshot.kind !== 'durable-parent-run'
    || snapshot.runId !== runId || !Number.isSafeInteger(snapshot.runRevision)
    || !['active', 'cancelled'].includes(snapshot.status)
    || !DIGEST_PATTERN.test(snapshot.subjectCoreDigest)
    || (snapshot.finalSubjectDigest !== null && !DIGEST_PATTERN.test(snapshot.finalSubjectDigest))
    || (snapshot.executionManifestDigest !== null && !DIGEST_PATTERN.test(snapshot.executionManifestDigest))
    || !['pending', 'failed', 'sealed'].includes(snapshot.compilationState)
    || !snapshot.workItems || typeof snapshot.workItems !== 'object' || Array.isArray(snapshot.workItems)
    || !snapshot.operations || typeof snapshot.operations !== 'object' || Array.isArray(snapshot.operations)) {
    fail('STORE_CORRUPT', `Parent run ${runId} recovery state is invalid.`);
  }
  if (snapshot.compilationFailure !== null) {
    let failure;
    try { failure = parseInventoryCompilationFailure(snapshot.compilationFailure); } catch {
      fail('STORE_CORRUPT', `Parent run ${runId} has an invalid compilation failure.`);
    }
    if (failure.subjectCoreDigest !== snapshot.subjectCoreDigest || !SAFE_ID.test(failure.workItemId)) {
      fail('STORE_CORRUPT', `Parent run ${runId} has an invalid compilation failure.`);
    }
    if (snapshot.compilationState === 'failed') {
      const item = snapshot.workItems[failure.workItemId];
      if (!item || item.capability !== 'inventory:http' || item.state !== 'incomplete'
        || item.attempts.length !== failure.attemptCount
        || item.attempts.at(-1)?.canonicalResultDigest !== failure.terminalResultDigest) {
        fail('STORE_CORRUPT', `Parent run ${runId} compilation failure is not bound to its exhausted inventory barrier.`);
      }
    }
  } else if (snapshot.compilationState === 'failed') {
    fail('STORE_CORRUPT', `Parent run ${runId} failed compilation without a sealed failure record.`);
  }
  if (snapshot.authorityTombstone !== null && (
    snapshot.authorityTombstone?.schemaVersion !== 1
    || snapshot.authorityTombstone.kind !== 'release-authority-tombstone'
    || snapshot.authorityTombstone.runId !== runId
    || !canonicalTimestamp(snapshot.authorityTombstone.tombstonedAt, 'authority tombstonedAt')
    || typeof snapshot.authorityTombstone.reason !== 'string'
    || !snapshot.authorityTombstone.reason
  )) fail('STORE_CORRUPT', `Parent run ${runId} has an invalid authority tombstone.`);
  if (snapshot.sealedCompileRiskInputs !== null) {
    let compileInputs;
    try { compileInputs = parseCompileRiskInputs(snapshot.sealedCompileRiskInputs); } catch {
      fail('STORE_CORRUPT', `Parent run ${runId} has corrupt sealed compile risk inputs.`);
    }
    if (compileInputs.subjectCoreDigest !== snapshot.subjectCoreDigest) {
      fail('STORE_CORRUPT', `Parent run ${runId} has misbound sealed compile risk inputs.`);
    }
  }
  if (snapshot.inventoryBarrierPlan !== null) {
    try {
      if (!snapshot.subjectCore
        || parseSingleSiteInventoryBarrier(snapshot.inventoryBarrierPlan, snapshot.subjectCore).digest
          !== snapshot.inventoryBarrierPlan.digest) throw new TypeError();
    } catch {
      fail('STORE_CORRUPT', `Parent run ${runId} has a corrupt inventory barrier plan.`);
    }
  }
  for (const [id, item] of Object.entries(snapshot.workItems)) {
    item.manualRekicks ??= 0;
    item.diagnosticExecutions ??= [];
    if (item?.id !== id || !SAFE_ID.test(id) || !Number.isSafeInteger(item.maxAttempts) || item.maxAttempts < 1
      || !['queued', 'running', 'completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(item.state)
      || !Array.isArray(item.attempts)
      || !CAPABILITY_PATTERN.test(item.capability)
      || !RESOURCE_CLASSES.has(item.resourceClass)
      || typeof item.targetId !== 'string'
      || (item.specAffinity !== null && typeof item.specAffinity !== 'string')
      || !Number.isSafeInteger(item.manualRekicks) || item.manualRekicks < 0 || item.manualRekicks > 3
      || !Array.isArray(item.diagnosticExecutions) || item.diagnosticExecutions.length > 8) {
      fail('STORE_CORRUPT', `Parent run ${runId} has invalid work-item state.`);
    }
    for (const diagnostic of item.diagnosticExecutions) {
      const identityRecheck = diagnostic?.identityRecheck;
      const expectedIdentity = identityRecheck?.expected;
      const observedIdentity = identityRecheck?.observed;
      const identityMatched = identityRecheck?.status === 'matched';
      if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)
        || !/^[a-f0-9]{64}$/u.test(diagnostic.diagnosticExecutionId)
        || diagnostic.workItemId !== id || diagnostic.subjectCoreDigest !== snapshot.subjectCoreDigest
        || diagnostic.finalSubjectDigest !== snapshot.finalSubjectDigest
        || diagnostic.executionDescriptorDigest !== (item.executionDescriptor?.digest ?? null)
        || !['queued', 'running', 'completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(diagnostic.state)
        || !Number.isSafeInteger(diagnostic.maxAttempts) || diagnostic.maxAttempts < 1 || diagnostic.maxAttempts > 16
        || !Array.isArray(diagnostic.attempts) || diagnostic.attempts.length > diagnostic.maxAttempts
        || !canonicalTimestamp(diagnostic.requestedAt, 'diagnostic rerun requestedAt')
        || !diagnostic.actor || typeof diagnostic.actor.id !== 'string'
        || !['human', 'service'].includes(diagnostic.actor.kind)
        || diagnostic.authoritative !== false || !identityRecheck
        || !['matched', 'mismatch', 'unverified'].includes(identityRecheck.status)
        || typeof expectedIdentity?.kind !== 'string' || typeof expectedIdentity?.value !== 'string'
        || canonicalJson(expectedIdentity) !== canonicalJson(snapshot.subjectCore.deploymentIdentity)
        || (observedIdentity !== null
          && (typeof observedIdentity?.kind !== 'string' || typeof observedIdentity?.value !== 'string'))
        || (identityRecheck.status === 'mismatch' && observedIdentity === null)
        || (identityRecheck.status === 'unverified' && observedIdentity !== null)
        || (identityRecheck.detail !== undefined
          && (identityRecheck.status !== 'unverified' || typeof identityRecheck.detail !== 'string'
            || identityRecheck.detail.length > 512))
        || !canonicalTimestamp(identityRecheck.checkedAt, 'diagnostic identity checkedAt')
        || (identityMatched && (canonicalJson(observedIdentity) !== canonicalJson(expectedIdentity)
          || identityRecheck.reason !== null || diagnostic.terminationReason !== null))
        || (!identityMatched && (diagnostic.state !== 'incomplete' || diagnostic.attempts.length !== 0
          || diagnostic.result !== null || diagnostic.lease !== null
          || identityRecheck.reason !== diagnostic.terminationReason
          || !['target_identity_mismatch', 'target_identity_unverified'].includes(diagnostic.terminationReason)))
        || (diagnostic.state === 'queued' && diagnostic.lease !== null)
        || (diagnostic.state === 'running' && !diagnostic.lease)
        || (['completed_pass', 'completed_product_failure', 'incomplete'].includes(diagnostic.state)
          && (diagnostic.lease !== null || (identityMatched && diagnostic.attempts.length < 1)))
        || (diagnostic.state === 'cancelled' && diagnostic.lease !== null)
        || (diagnostic.result !== null && (diagnostic.result.authoritative !== false
          || diagnostic.result.workItemId !== id || diagnostic.result.subjectCoreDigest !== snapshot.subjectCoreDigest))) {
        fail('STORE_CORRUPT', `Parent run ${runId} has invalid diagnostic execution lineage.`);
      }
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
    if (item.canonicalRiskSourceObservationSet !== null && item.canonicalRiskSourceObservationSet !== undefined) {
      let observationSet;
      try { observationSet = parseRiskSourceObservationSet(item.canonicalRiskSourceObservationSet); } catch {
        fail('STORE_CORRUPT', `Parent run ${runId} has a corrupt canonical risk source observation set.`);
      }
      if (observationSet.runId !== runId || observationSet.workItemId !== id
        || observationSet.subjectCoreDigest !== snapshot.subjectCoreDigest
        || item.canonicalResult === null || observationSet.attempt !== item.canonicalResult.attempt) {
        fail('STORE_CORRUPT', `Parent run ${runId} has a misbound canonical risk source observation set.`);
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
  if (Object.values(checkpoints).reduce((total, checkpoint) => total + checkpoint.count, 0) !== latest.runRevision) {
    fail('STORE_CORRUPT', `Parent run ${runId} ledger positions disagree with its recovery revision.`);
  }
  const state = normalizeRecoveredState(store, snapshot, checkpoints);
  const repairedStateCache = repairCache && await repairRecoveredStateCache(store, runId, state);
  const histories = Object.fromEntries(LEDGER_KINDS.map((kind) => [
    kind,
    [...(cachedRecovery?.histories[kind] ?? []), ...ledgers[kind].map(eventSummary)],
  ]));
  captureHistories?.(histories);
  const cacheState = structuredClone(state);
  delete cacheState.clockNow;
  const currentRecovery = recoveryCacheGet(store, runId, { touch: false });
  if (!currentRecovery || currentRecovery.state.runRevision <= cacheState.runRevision) {
    const stateCacheVerified = repairedStateCache
      || (currentRecovery?.state.runRevision === cacheState.runRevision && currentRecovery.stateCacheVerified);
    recoveryCacheSet(store, runId, Object.freeze({ state: cacheState, checkpoints, histories, stateCacheVerified }));
  }
  noteSchedulingState(store, state);
  return state;
}

async function recoverWithHistoriesUnlocked(store, runId, options = {}) {
  let recoveredHistories = null;
  const state = await recoverUnlocked(store, runId, {
    ...options,
    captureHistories: (histories) => { recoveredHistories = histories; },
  });
  return {
    state,
    histories: recoveredHistories === null ? cachedHistorySummaries(store, runId) : structuredClone(recoveredHistories),
  };
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
  const result = { ...next, clockNow: store.clock() };
  noteSchedulingState(store, result);
  return result;
}

async function mutate(store, runId, { coordinator = null, kind = 'mutation', type, actor = null, data = null }, apply) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => (
    withDirectoryLock(store.storage, lockPath(store, runId), async () => {
      const state = await recoverUnlocked(store, runId);
      if (coordinator) await validateCoordinator(store, coordinator, runId);
      else await readAuthoritySelectorUnlocked(store);
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
  storeMarker = null,
  storeGeneration = 1,
  expectedStoreGeneration = null,
  schemaFloor = PARENT_RUN_STORE_SCHEMA_VERSION,
  supportedSchemaVersion = PARENT_RUN_STORE_SCHEMA_VERSION,
  writerProtocol = PARENT_RUN_WRITER_PROTOCOL,
  minimumWriterProtocol = PARENT_RUN_WRITER_PROTOCOL,
  buildIdentity = `build:${PARENT_RUN_WRITER_PROTOCOL}`,
  prequalifiedRollbackBuilds = [buildIdentity],
  backupMarker = null,
  cutoverRevision = 0,
  verifyStorage = true,
  authorityFloor = null,
  legacyAuthorityFence = null,
} = {}) {
  if (!root) fail('STORE_SCHEMA_INVALID', 'Parent-run store root is required.');
  if (!LOCAL_VOLUME_DRIVERS.has(volumeDriver)) {
    fail('STORE_VOLUME_UNSUPPORTED', 'Only a Docker Engine local named volume is supported.');
  }
  if (storeMarker !== null && !STORE_MARKER.test(storeMarker)) {
    fail('STORE_MARKER_INVALID', 'Configured store marker must be 32 random bytes encoded as lowercase hex.');
  }
  if (!Number.isSafeInteger(storeGeneration) || storeGeneration < 1
    || (expectedStoreGeneration !== null && (!Number.isSafeInteger(expectedStoreGeneration) || expectedStoreGeneration < 1))) {
    fail('STORE_SCHEMA_INVALID', 'Store generation is invalid.');
  }
  if (!Number.isSafeInteger(schemaFloor) || schemaFloor < 1
    || !Number.isSafeInteger(supportedSchemaVersion) || supportedSchemaVersion < 1) {
    fail('STORE_SCHEMA_INVALID', 'Store schema floor or supported schema version is invalid.');
  }
  if (schemaFloor > supportedSchemaVersion) {
    fail('STORE_SCHEMA_FLOOR_UNSUPPORTED', 'This build cannot initialize a durable store above its supported schema floor.');
  }
  if (writerProtocol !== minimumWriterProtocol) {
    fail('STORE_WRITER_INCOMPATIBLE', 'The initializing writer protocol must satisfy the durable store minimum.');
  }
  if ((authorityFloor === null) !== (legacyAuthorityFence === null)
    || (authorityFloor !== null && (typeof authorityFloor.assertAuthorityState !== 'function'
      || typeof legacyAuthorityFence.read !== 'function'))) {
    fail('STORE_SCHEMA_INVALID', 'External authority-floor enforcement requires both authority-floor and legacy-fence handles.');
  }
  if (typeof buildIdentity !== 'string' || !buildIdentity
    || !Array.isArray(prequalifiedRollbackBuilds) || prequalifiedRollbackBuilds.length < 1
    || prequalifiedRollbackBuilds.some((entry) => typeof entry !== 'string' || !entry)) {
    fail('STORE_SCHEMA_INVALID', 'Build identity and prequalified rollback builds are required.');
  }
  const storage = await openAtomicStorage({ root, filesystem, nonce, verify: verifyStorage });
  await storage.fs.mkdir(containedPath(storage.root, 'runs'), { recursive: true, mode: 0o2770 });
  const manifestPath = containedPath(storage.root, 'store-manifest.json');
  const schedulerPath = containedPath(storage.root, 'performance-scheduler.json');
  const store = {
    root: storage.root,
    storage,
    clock,
    manifest: null,
    buildIdentity,
    authorityFloor,
    legacyAuthorityFence,
  };
  ARTIFACT_INTEGRITY_CACHES.set(store, new Map());
  PARENT_RUN_RECOVERY_CACHES.set(store, { entries: new Map(), bytes: 0 });
  SCHEDULING_STATE_CACHES.set(store, { initialized: false, knownRunIds: new Set(), relevantRunIds: new Set() });
  await withDirectoryLock(storage, containedPath(storage.root, '.store-initialization.lock'), async () => {
    const existingStore = await pathExists(storage.fs, manifestPath);
    if (existingStore) {
      const manifest = validateManifest(await readBoundedJson(storage, manifestPath, { label: 'store manifest' }), {
        supportedSchemaVersion, writerProtocol,
      });
      if ((deploymentIdentity && deploymentIdentity !== manifest.deploymentIdentity)
        || (volumeIdentity && volumeIdentity !== manifest.volumeIdentity)
        || volumeDriver !== manifest.volumeDriver) {
        fail('STORE_IDENTITY_MISMATCH', 'Configured deployment or volume identity does not match the durable store.');
      }
      if (storeMarker !== null && canonicalDigest({ storeMarker }) !== manifest.storeMarkerDigest) {
        fail('STORE_MARKER_MISMATCH', 'Configured trusted marker does not match the durable store.');
      }
      if (expectedStoreGeneration !== null && expectedStoreGeneration !== manifest.storeGeneration) {
        fail('STORE_GENERATION_MISMATCH', 'Configured store generation does not match the durable store.');
      }
      store.manifest = manifest;
    } else {
      if (!deploymentIdentity || !volumeIdentity) {
        fail('STORE_MANIFEST_REQUIRED', 'A new store requires deploymentIdentity and volumeIdentity.');
      }
      if (!volumeIdentity.startsWith('named-volume:')) {
        fail('STORE_VOLUME_UNSUPPORTED', 'Store volumeIdentity must identify a Docker named volume.');
      }
      const trustedMarker = storeMarker ?? randomBytes(32).toString('hex');
      await writeManifest(store, {
        deploymentIdentity, volumeIdentity, volumeDriver,
        storeMarkerDigest: canonicalDigest({ storeMarker: trustedMarker }), storeGeneration,
        schemaFloor, currentWriterProtocol: writerProtocol, minimumWriterProtocol,
        coordinatorEpoch: 0, activationEpoch: 0, activationRevision: null,
        createdAt: timestamp(store), cutoverRevision, backupMarker,
        prequalifiedRollbackBuilds: [...new Set(prequalifiedRollbackBuilds)].sort(),
      });
    }
    const selectorPath = authoritySelectorPath(store);
    if (!await pathExists(storage.fs, selectorPath)) {
      if (existingStore) fail('AUTHORITY_SELECTOR_INVALID', 'Existing durable store is missing its release-authority selector.');
      const initial = sealAuthoritySelector({
        storeMarkerDigest: store.manifest.storeMarkerDigest,
        storeGeneration: store.manifest.storeGeneration,
        phase: 'SHADOW', activationEpoch: 0, activationRevision: null, activatedAt: null,
        activeWriterProtocol: null, minimumWriterProtocol: store.manifest.minimumWriterProtocol,
        activeBuildIdentity: null, authorityTransitionDigest: null, activationCutoverDigest: null,
        backupMarker: store.manifest.backupMarker,
        prequalifiedRollbackBuilds: store.manifest.prequalifiedRollbackBuilds,
        revision: 1, previousDigest: null, updatedAt: timestamp(store),
      });
      await atomicWriteJson(storage, selectorPath, initial, { exclusive: true });
    } else {
      await migrateLegacyShadowAuthoritySelector(store);
    }
    const openedSelector = await readAuthoritySelectorUnlocked(store);
    if (['ACTIVE', 'PROMOTION_DISABLED'].includes(openedSelector.phase) && storeMarker === null) {
      fail('STORE_MARKER_REQUIRED', 'Activated release authority requires the trusted external store marker.');
    }
    if (['ACTIVE', 'PROMOTION_DISABLED'].includes(openedSelector.phase) && expectedStoreGeneration === null) {
      fail('STORE_GENERATION_REQUIRED', 'Activated release authority requires the configured store generation.');
    }
    if (['ACTIVE', 'PROMOTION_DISABLED'].includes(openedSelector.phase)
      && !openedSelector.prequalifiedRollbackBuilds.includes(buildIdentity)) {
      fail('STORE_BUILD_INCOMPATIBLE', 'This build is not prequalified to open the activated release-authority store.');
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
  const sealedCompileRiskInputs = input.sealedCompileRiskInputs
    ? parseCompileRiskInputs(input.sealedCompileRiskInputs)
    : null;
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
  if (sealedCompileRiskInputs && sealedCompileRiskInputs.subjectCoreDigest !== subjectCoreDigest) {
    fail('RELEASE_SUBJECT_MISMATCH', 'Sealed compile risk inputs do not match the parent-run subject core.');
  }
  if (finalSubject && (finalSubject.subjectCoreDigest !== subjectCoreDigest
    || finalSubject.executionManifestDigest !== executionManifestDigest)) {
    fail('RELEASE_SUBJECT_MISMATCH', 'Final subject does not match the parent-run graph.');
  }
  if (compilationState === 'sealed' && (!executionManifestDigest || !finalSubjectDigest)) {
    fail('SEALED_MANIFEST_MISSING', 'A sealed parent run requires execution-manifest and final-subject digests.');
  }
  return withDirectoryLock(store.storage, containedPath(store.root, '.create-lock'), async () => {
    const selector = await readAuthoritySelectorUnlocked(store);
    if (selector.phase === 'PROMOTION_DISABLED' && selector.pendingBuildIdentity !== null) {
      if (store.buildIdentity !== selector.pendingBuildIdentity) {
        fail('STORE_WRITER_NOT_ACTIVE', 'Only the pending target build may create a handoff health canary.');
      }
      await requireHandoffRunPermit(store, selector, runId);
    }
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
      compilationFailure: null,
      inventoryBarrierPlan,
      sealedCompileRiskInputs,
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
      currentPublicationAuthorityBinding: null,
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
      noteSchedulingState(store, state);
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

export async function parentRunExists(store, runId) {
  safeId(runId, 'runId');
  try {
    const metadata = await store.storage.fs.lstat(runDirectory(store, runId));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail('STORE_CORRUPT', `Parent run ${runId} is not a real directory.`);
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function listParentRunIds(store, { limit = MAX_DISCOVERED_PARENT_RUNS } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DISCOVERED_PARENT_RUNS) {
    fail('STORE_SCHEMA_INVALID', `Parent-run discovery limit must be from 1 through ${MAX_DISCOVERED_PARENT_RUNS}.`);
  }
  const entries = await store.storage.fs.readdir(containedPath(store.root, 'runs'), { withFileTypes: true });
  const runIds = [];
  for (const entry of entries.filter(({ name }) => SAFE_ID.test(name)).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    runIds.push(entry.name);
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
    await validateCoordinator(store, coordinator, runId);
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

export async function terminalizeParentRunCompilation(store, runId, coordinator) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator, runId);
    if (state.compilationState === 'failed') {
      delete state.clockNow;
      return state;
    }
    if (state.compilationState !== 'pending' || state.status !== 'active'
      || state.executionManifest !== null || state.finalSubject !== null
      || !state.subjectCore || !state.inventoryBarrierPlan) {
      fail('COMPILATION_NOT_TERMINALIZABLE', 'Only an unsealed active inventory compilation can be terminalized.');
    }
    const barriers = Object.values(state.workItems).filter(({ capability }) => capability === 'inventory:http');
    if (barriers.length !== 1 || Object.keys(state.workItems).length !== 1
      || barriers[0].id !== state.inventoryBarrierPlan.workItem.id
      || barriers[0].state !== 'incomplete' || barriers[0].canonicalResult !== null
      || barriers[0].attempts.length < barriers[0].maxAttempts) {
      fail('INVENTORY_RECOVERY_NOT_EXHAUSTED', 'Inventory compilation cannot fail before its bounded recovery is exhausted.');
    }
    const barrier = barriers[0];
    const terminalAttempt = barrier.attempts.at(-1);
    const compilationFailure = sealInventoryCompilationFailure({
      schemaVersion: 1,
      subjectCoreDigest: state.subjectCoreDigest,
      workItemId: barrier.id,
      terminalResultDigest: terminalAttempt.canonicalResultDigest,
      reason: terminalAttempt.reason || 'Inventory execution remained incomplete after bounded recovery.',
      attemptCount: barrier.attempts.length,
      failedAt: terminalAttempt.completedAt,
    });
    return appendMutationUnlocked(store, state, 'mutation', 'inventory-compilation-failed', (next) => {
      next.compilationState = 'failed';
      next.compilationFailure = compilationFailure;
    }, { data: compilationFailure });
  }));
}

async function acquireStoreCoordinatorUnlocked(store, input, takeoverOnly) {
  await refreshManifestUnlocked(store);
  safeId(input?.ownerId, 'coordinator ownerId');
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 100) fail('STORE_SCHEMA_INVALID', 'Coordinator leaseMs is invalid.');
  const previous = await readGlobalCoordinator(store);
  const selector = await readAuthoritySelectorUnlocked(store);
  const permittedBuild = selector.pendingBuildIdentity ?? selector.activeBuildIdentity ?? store.buildIdentity;
  if (store.buildIdentity !== permittedBuild) {
    fail('STORE_WRITER_NOT_ACTIVE', `Build ${store.buildIdentity} is not the active or pending canonical writer.`);
  }
  const active = previous && Date.parse(previous.expiresAt) > store.clock();
  if (active && previous.buildIdentity === permittedBuild) {
    fail('COORDINATOR_LEASE_HELD', `Coordinator epoch ${previous.epoch} is still active.`);
  }
  if (takeoverOnly && previous === null) fail('COORDINATOR_TAKEOVER_INVALID', 'No prior coordinator exists to take over.');
  const epoch = Math.max(previous?.epoch ?? 0, store.manifest.coordinatorEpoch) + 1;
  const coordinator = {
    buildIdentity: store.buildIdentity,
    ownerId: input.ownerId,
    epoch,
    token: store.storage.nonce(),
    acquiredAt: timestamp(store),
    expiresAt: new Date(store.clock() + input.leaseMs).toISOString(),
  };
  // Advance the coordinator fence before publishing the lease. This sequence
  // is deliberately independent from the one-time release activation epoch.
  // A crash may skip a coordinator epoch but can never activate release truth.
  await writeManifest(store, { ...store.manifest, coordinatorEpoch: epoch });
  await atomicWriteJson(store.storage, globalCoordinatorPath(store), sealCoordinatorLease(coordinator));
  return coordinator;
}

async function acquireWithRunAudit(store, runId, input, takeoverOnly) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => (
    withDirectoryLock(store.storage, lockPath(store, runId), async () => {
      const state = await recoverUnlocked(store, runId);
      const selector = await readAuthoritySelectorUnlocked(store);
      await requireHandoffRunPermit(store, selector, runId);
      const coordinator = await withDirectoryLock(
        store.storage,
        coordinatorLeaseLockPath(store),
        () => acquireStoreCoordinatorUnlocked(store, input, takeoverOnly),
      );
      await appendMutationUnlocked(store, state, 'mutation', takeoverOnly ? 'coordinator-taken-over' : 'coordinator-acquired', (next) => {
        next.coordinator = coordinator;
      }, { actor: { id: input.ownerId, kind: 'service' }, data: { epoch: coordinator.epoch } });
      return clone(coordinator);
    })
  ));
}

export function acquireStoreCoordinator(store, input) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => (
    withDirectoryLock(store.storage, coordinatorLeaseLockPath(store), async () => (
      clone(await acquireStoreCoordinatorUnlocked(store, input, false))
    ))
  ));
}

export function takeOverStoreCoordinator(store, input) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => (
    withDirectoryLock(store.storage, coordinatorLeaseLockPath(store), async () => (
      clone(await acquireStoreCoordinatorUnlocked(store, input, true))
    ))
  ));
}

export async function readReleaseAuthoritySelector(store) {
  return clone(await readAuthoritySelectorUnlocked(store));
}

function authorityHandoffReservationPath(store) {
  return containedPath(store.root, 'release-authority-handoff-reservation.json');
}

function authorityHandoffReservationHistoryPath(store, digest) {
  if (!DIGEST_PATTERN.test(digest ?? '')) fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation digest is invalid.');
  return containedPath(store.root, 'release-authority-handoff-reservations', `${digest.slice('sha256:'.length)}.json`);
}

function authorityHandoffReservationBody(value) {
  return {
    schemaVersion: 1,
    kind: 'release-authority-handoff-reservation',
    revision: value.revision,
    previousDigest: value.previousDigest,
    state: value.state,
    handoffId: value.handoffId,
    sourceSelectorDigest: value.sourceSelectorDigest,
    targetBuildIdentity: value.targetBuildIdentity,
    preparedAt: value.preparedAt,
    consumedAt: value.consumedAt,
    pendingSelectorDigest: value.pendingSelectorDigest,
  };
}

function parseAuthorityHandoffReservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation is invalid.');
  }
  const { digest, ...body } = value;
  const expectedKeys = [...Object.keys(authorityHandoffReservationBody(value)), 'digest'];
  if (Object.keys(value).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(value, key))
    || !DIGEST_PATTERN.test(digest ?? '') || digest !== canonicalDigest(body)
    || value.schemaVersion !== 1 || value.kind !== 'release-authority-handoff-reservation'
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || value.revision > MAX_AUTHORITY_HANDOFF_RESERVATION_REVISIONS
    || (value.previousDigest !== null && !DIGEST_PATTERN.test(value.previousDigest))
    || ((value.revision === 1) !== (value.previousDigest === null))
    || !['PREPARED', 'CONSUMED'].includes(value.state)) {
    fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation is corrupt or unsupported.');
  }
  safeId(value.handoffId, 'handoff reservation handoffId');
  if (!DIGEST_PATTERN.test(value.sourceSelectorDigest ?? '') || typeof value.targetBuildIdentity !== 'string' || !value.targetBuildIdentity
    || !canonicalTimestamp(value.preparedAt, 'handoff reservation preparedAt')) {
    fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation binding is invalid.');
  }
  if (value.state === 'PREPARED') {
    if (value.consumedAt !== null || value.pendingSelectorDigest !== null) {
      fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Prepared handoff reservation is contradictory.');
    }
  } else if (!canonicalTimestamp(value.consumedAt, 'handoff reservation consumedAt')
    || !DIGEST_PATTERN.test(value.pendingSelectorDigest ?? '')) {
    fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Consumed handoff reservation is contradictory.');
  }
  return clone(value);
}

async function readAuthorityHandoffReservationPointerUnlocked(store) {
  const bytes = await readBoundedFile(store.storage, authorityHandoffReservationPath(store), {
    label: 'release-authority handoff reservation', maximumBytes: 128 * 1_024,
  });
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch {
    fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation pointer is not JSON.');
  }
  const reservation = parseAuthorityHandoffReservation(parsed);
  if (bytes.toString('utf8') !== `${canonicalJson(reservation)}\n`) {
    fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation pointer bytes do not exactly match its sealed digest.');
  }
  return reservation;
}

async function authorityHandoffReservationHistoryHasEntriesUnlocked(store) {
  const history = containedPath(store.root, 'release-authority-handoff-reservations');
  try {
    return (await store.storage.fs.readdir(history)).length > 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function readAuthorityHandoffReservationUnlocked(store) {
  let reservation;
  try {
    reservation = await readAuthorityHandoffReservationPointerUnlocked(store);
  } catch (error) {
    if (error?.code === 'ATOMIC_NOT_FOUND') {
      if (await authorityHandoffReservationHistoryHasEntriesUnlocked(store)) {
        fail('AUTHORITY_HANDOFF_RESERVATION_INVALID',
          'Handoff reservation pointer is missing while immutable reservation history exists.');
      }
      return null;
    }
    throw error;
  }
  const head = authorityHandoffReservationHistoryPath(store, reservation.digest);
  if (!await pathExists(store.storage.fs, head)) {
    // Pointer-first persistence can crash after publishing the exact sealed
    // pointer but before linking its immutable head.  Only this exact current
    // head may be reconstructed; every ancestor must already be immutable.
    await verifyAuthorityHandoffReservationAncestorsUnlocked(store, reservation);
    await persistImmutableAuthorityHandoffReservationUnlocked(store, reservation);
  }
  await verifyAuthorityHandoffReservationHistoryUnlocked(store, reservation);
  return reservation;
}

async function readImmutableAuthorityHandoffReservation(store, digest) {
  const file = authorityHandoffReservationHistoryPath(store, digest);
  const bytes = await readBoundedFile(store.storage, file, {
    label: 'immutable release-authority handoff reservation', maximumBytes: 128 * 1_024,
  });
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch {
    fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Immutable handoff reservation is not JSON.');
  }
  const reservation = parseAuthorityHandoffReservation(parsed);
  if (reservation.digest !== digest || bytes.toString('utf8') !== `${canonicalJson(reservation)}\n`) {
    fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Immutable handoff reservation bytes do not exactly match their sealed digest.');
  }
  return reservation;
}

async function verifyAuthorityHandoffReservationAncestorsUnlocked(store, pointer) {
  let current = pointer;
  for (let depth = 0; depth < MAX_AUTHORITY_HANDOFF_RESERVATION_REVISIONS; depth += 1) {
    if (current.previousDigest === null) return;
    const previous = await readImmutableAuthorityHandoffReservation(store, current.previousDigest);
    if (previous.revision !== current.revision - 1) {
      fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation revision history is discontinuous.');
    }
    current = previous;
  }
  fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation history exceeds its bounded depth.');
}

async function verifyAuthorityHandoffReservationHistoryUnlocked(store, pointer) {
  let current = pointer;
  for (let depth = 0; depth < MAX_AUTHORITY_HANDOFF_RESERVATION_REVISIONS; depth += 1) {
    const immutable = await readImmutableAuthorityHandoffReservation(store, current.digest);
    if (canonicalJson(immutable) !== canonicalJson(current)) {
      fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation pointer does not match its immutable history member.');
    }
    if (current.previousDigest === null) return;
    const previous = await readImmutableAuthorityHandoffReservation(store, current.previousDigest);
    if (previous.revision !== current.revision - 1) {
      fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation revision history is discontinuous.');
    }
    current = previous;
  }
  fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation history exceeds its bounded depth.');
}

async function persistImmutableAuthorityHandoffReservationUnlocked(store, reservation) {
  const history = containedPath(store.root, 'release-authority-handoff-reservations');
  await store.storage.fs.mkdir(history, { recursive: true, mode: 0o700 });
  const immutable = authorityHandoffReservationHistoryPath(store, reservation.digest);
  if (await pathExists(store.storage.fs, immutable)) {
    const existing = await readImmutableAuthorityHandoffReservation(store, reservation.digest);
    if (canonicalJson(existing) !== canonicalJson(reservation)) {
      fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Immutable handoff reservation digest was reused with different bytes.');
    }
  } else {
    try { await atomicWriteJson(store.storage, immutable, reservation, { exclusive: true }); } catch (error) {
      if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
      const existing = await readImmutableAuthorityHandoffReservation(store, reservation.digest);
      if (canonicalJson(existing) !== canonicalJson(reservation)) {
        fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Concurrent immutable handoff reservation differs from this digest.');
      }
    }
  }
}

async function persistAuthorityHandoffReservationUnlocked(store, value) {
  if (!Number.isSafeInteger(value.revision) || value.revision < 1
    || value.revision > MAX_AUTHORITY_HANDOFF_RESERVATION_REVISIONS) {
    fail('AUTHORITY_HANDOFF_RESERVATION_LIMIT',
      `Handoff reservation revision cannot exceed ${MAX_AUTHORITY_HANDOFF_RESERVATION_REVISIONS}.`);
  }
  const document = { ...authorityHandoffReservationBody(value) };
  const reservation = { ...document, digest: canonicalDigest(document) };
  if (reservation.previousDigest !== null) {
    const predecessor = await readImmutableAuthorityHandoffReservation(store, reservation.previousDigest);
    if (predecessor.revision !== reservation.revision - 1) {
      fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation predecessor is not the immediately prior revision.');
    }
    await verifyAuthorityHandoffReservationHistoryUnlocked(store, predecessor);
  }
  // Publish the recoverable current pointer first.  Readers under the global
  // selector lock can recreate only its exact immutable head if a crash lands
  // between these two writes; immutable ancestry is never synthesized.
  await atomicWriteJson(store.storage, authorityHandoffReservationPath(store), reservation);
  await persistImmutableAuthorityHandoffReservationUnlocked(store, reservation);
  await verifyAuthorityHandoffReservationHistoryUnlocked(store, reservation);
  return clone(reservation);
}

function reservationMatches(reservation, { handoffId, sourceSelectorDigest, targetBuildIdentity }) {
  return reservation.handoffId === handoffId
    && reservation.sourceSelectorDigest === sourceSelectorDigest
    && reservation.targetBuildIdentity === targetBuildIdentity;
}

async function reserveAuthorityHandoffUnlocked(store, selector, input) {
  safeId(input?.handoffId, 'handoff reservation handoffId');
  if (!DIGEST_PATTERN.test(input?.sourceSelectorDigest ?? '')
    || typeof input?.targetBuildIdentity !== 'string' || !input.targetBuildIdentity) {
    fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'Handoff reservation input is invalid.');
  }
  await validateCoordinator(store, input.coordinator);
  if (selector.digest !== input.sourceSelectorDigest || selector.phase !== 'ACTIVE'
    || selector.pendingBuildIdentity !== null || selector.activeBuildIdentity !== store.buildIdentity) {
    fail('AUTHORITY_HANDOFF_RESERVATION_CONFLICT', 'Handoff reservation source selector is no longer active and exact.');
  }
  const current = await readAuthorityHandoffReservationUnlocked(store);
  if (current?.state === 'PREPARED') {
    if (reservationMatches(current, input)) return current;
    fail('AUTHORITY_HANDOFF_RESERVATION_HELD', `Handoff reservation is already held by ${current.handoffId}.`);
  }
  return persistAuthorityHandoffReservationUnlocked(store, {
    revision: (current?.revision ?? 0) + 1,
    previousDigest: current?.digest ?? null,
    state: 'PREPARED',
    handoffId: input.handoffId,
    sourceSelectorDigest: input.sourceSelectorDigest,
    targetBuildIdentity: input.targetBuildIdentity,
    preparedAt: timestamp(store),
    consumedAt: null,
    pendingSelectorDigest: null,
  });
}

async function consumeAuthorityHandoffReservationUnlocked(store, selector, input) {
  const current = await readAuthorityHandoffReservationUnlocked(store);
  if (!current || !reservationMatches(current, input)) {
    fail('AUTHORITY_HANDOFF_RESERVATION_REQUIRED', 'Build handoff requires its matching prepared authority reservation.');
  }
  if (current.state === 'CONSUMED') {
    if (current.pendingSelectorDigest !== selector.digest) {
      fail('AUTHORITY_HANDOFF_RESERVATION_CONFLICT', 'Consumed handoff reservation does not match the pending selector.');
    }
    return current;
  }
  return persistAuthorityHandoffReservationUnlocked(store, {
    ...current,
    revision: current.revision + 1,
    previousDigest: current.digest,
    state: 'CONSUMED',
    consumedAt: timestamp(store),
    pendingSelectorDigest: selector.digest,
  });
}

async function requirePreparedAuthorityHandoffReservationUnlocked(store, input) {
  const current = await readAuthorityHandoffReservationUnlocked(store);
  if (!current || !reservationMatches(current, input) || current.state !== 'PREPARED') {
    fail('AUTHORITY_HANDOFF_RESERVATION_REQUIRED', 'Build handoff requires its matching prepared authority reservation.');
  }
  return current;
}

async function recoverV1PendingAuthorityHandoffReservationUnlocked(store, selector, input) {
  safeId(input?.handoffId, 'handoff reservation handoffId');
  if (!DIGEST_PATTERN.test(input?.sourceSelectorDigest ?? '')
    || typeof input?.sourceBuildIdentity !== 'string' || !input.sourceBuildIdentity
    || typeof input?.targetBuildIdentity !== 'string' || !input.targetBuildIdentity) {
    fail('AUTHORITY_HANDOFF_RESERVATION_INVALID', 'V1 pending handoff reservation recovery input is invalid.');
  }
  await validateCoordinator(store, input.coordinator);
  if (store.buildIdentity !== input.targetBuildIdentity
    || selector.phase !== 'PROMOTION_DISABLED'
    || selector.handoffId !== input.handoffId
    || selector.activeBuildIdentity !== input.sourceBuildIdentity
    || selector.pendingBuildIdentity !== input.targetBuildIdentity
    || selector.previousDigest !== input.sourceSelectorDigest) {
    fail('AUTHORITY_HANDOFF_RESERVATION_CONFLICT',
      'V1 pending handoff reservation recovery does not match the exact pending authority selector.');
  }
  const reservationInput = {
    handoffId: input.handoffId,
    sourceSelectorDigest: input.sourceSelectorDigest,
    targetBuildIdentity: input.targetBuildIdentity,
  };
  const current = await readAuthorityHandoffReservationUnlocked(store);
  if (current?.state === 'CONSUMED') {
    if (!reservationMatches(current, reservationInput) || current.pendingSelectorDigest !== selector.digest) {
      fail('AUTHORITY_HANDOFF_RESERVATION_CONFLICT',
        'Existing consumed handoff reservation does not match the exact pending authority selector.');
    }
    return current;
  }
  let prepared = current;
  if (prepared?.state === 'PREPARED') {
    if (!reservationMatches(prepared, reservationInput)) {
      fail('AUTHORITY_HANDOFF_RESERVATION_HELD',
        `Handoff reservation is already held by ${prepared.handoffId}.`);
    }
  } else {
    prepared = await persistAuthorityHandoffReservationUnlocked(store, {
      revision: (current?.revision ?? 0) + 1,
      previousDigest: current?.digest ?? null,
      state: 'PREPARED',
      handoffId: input.handoffId,
      sourceSelectorDigest: input.sourceSelectorDigest,
      targetBuildIdentity: input.targetBuildIdentity,
      preparedAt: timestamp(store),
      consumedAt: null,
      pendingSelectorDigest: null,
    });
  }
  return consumeAuthorityHandoffReservationUnlocked(store, selector, reservationInput);
}

// Callers that need to commit another durable fence against selector identity
// must take this global lock rather than attempting an unlocked read/commit.
// The callback deliberately receives only a clone, so selector mutation still
// has to use the normal authority transition APIs and their coordinator fence.
export async function withReleaseAuthoritySelectorFence(store, expectedDigest, operation) {
  if (!DIGEST_PATTERN.test(expectedDigest ?? '')) {
    fail('AUTHORITY_SELECTOR_CONFLICT', 'Release-authority selector fence requires an exact selector digest.');
  }
  if (typeof operation !== 'function') {
    fail('AUTHORITY_SELECTOR_CONFLICT', 'Release-authority selector fence requires an operation.');
  }
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    const selector = await readAuthoritySelectorUnlocked(store);
    if (selector.digest !== expectedDigest) {
      fail('AUTHORITY_SELECTOR_CONFLICT', 'Release-authority selector changed before the fenced operation.');
    }
    return operation(clone(selector), Object.freeze({
      reserveBuildHandoff: (input) => reserveAuthorityHandoffUnlocked(store, selector, input),
      recoverV1PendingBuildHandoff: (input) => recoverV1PendingAuthorityHandoffReservationUnlocked(store, selector, input),
    }));
  });
}

export async function readReleaseAuthorityContext(store, { requireActive = false } = {}) {
  const selector = await readAuthoritySelectorUnlocked(store);
  if (requireActive && selector.phase !== 'ACTIVE') {
    fail('RELEASE_AUTHORITY_INACTIVE', `Release authority requires ACTIVE; current phase is ${selector.phase}.`);
  }
  return Object.freeze({ selector: clone(selector), binding: authorityBinding(store, selector) });
}

async function transitionReleaseAuthorityUnlocked(store, coordinator, input = {}) {
    await validateCoordinator(store, coordinator);
    const current = await readAuthoritySelectorUnlocked(store);
    const reservation = await readAuthorityHandoffReservationUnlocked(store);
    if (reservation?.state === 'PREPARED') {
      fail('AUTHORITY_HANDOFF_RESERVATION_HELD',
        `Release-authority transition is fenced by prepared handoff ${reservation.handoffId}.`);
    }
    if (input.expectedSelectorDigest !== current.digest) {
      fail('AUTHORITY_SELECTOR_CONFLICT', 'Release-authority selector changed before the requested transition.');
    }
    if (!RELEASE_AUTHORITY_PHASES.includes(input.phase)) {
      fail('AUTHORITY_TRANSITION_INVALID', 'Requested release-authority phase is invalid.');
    }
    if (typeof input.buildIdentity !== 'string' || !input.buildIdentity) {
      fail('AUTHORITY_TRANSITION_INVALID', 'Authority transition requires the exact build identity.');
    }
    if (input.buildIdentity !== store.buildIdentity) {
      fail('STORE_WRITER_INCOMPATIBLE', 'Authority transition build identity does not match the opener.');
    }
    if (current.pendingBuildIdentity !== null) {
      fail(
        input.phase === 'ACTIVE' ? 'AUTHORITY_HANDOFF_HEALTH_REQUIRED' : 'AUTHORITY_HANDOFF_REQUIRED',
        'A pending build handoff can change authority only through its dedicated health-fenced workflow.',
      );
    }
    if (input.phase === current.phase) {
      if (input.phase === 'ACTIVE'
        && (input.activationRevision !== current.activationRevision
          || input.buildIdentity !== current.activeBuildIdentity)) {
        fail('AUTHORITY_TRANSITION_INVALID', 'Repeated activation does not match the durable activation.');
      }
      return clone(current);
    }
    const wasActivated = current.activationEpoch === 1;
    const allowed = wasActivated
      ? (current.phase === 'ACTIVE' && input.phase === 'PROMOTION_DISABLED')
        || (current.phase === 'PROMOTION_DISABLED' && input.phase === 'ACTIVE')
      : (current.phase === 'SHADOW' && input.phase === 'DRAINING')
        || (current.phase === 'DRAINING' && ['SHADOW', 'ACTIVE'].includes(input.phase));
    if (!allowed) {
      fail('AUTHORITY_TRANSITION_INVALID', `Release authority cannot transition from ${current.phase} to ${input.phase}.`);
    }
    const activating = input.phase === 'ACTIVE';
    const firstActivation = activating && !wasActivated;
    const requestedActivationRevision = current.activationRevision ?? input.activationRevision;
    if (activating && (!current.prequalifiedRollbackBuilds.includes(input.buildIdentity)
      || current.backupMarker === null
      || !Number.isSafeInteger(requestedActivationRevision) || requestedActivationRevision < 1)) {
      fail('AUTHORITY_ACTIVATION_NOT_QUALIFIED', 'Activation requires a backup marker, activation revision, and prequalified shared-compatible build.');
    }
    if (activating && wasActivated && input.buildIdentity !== current.activeBuildIdentity) {
      fail('AUTHORITY_HANDOFF_REQUIRED', 'Changing the active build requires a durable health-fenced build handoff.');
    }
    if (firstActivation && (!DIGEST_PATTERN.test(input.activationCutoverDigest ?? '')
      || !DIGEST_PATTERN.test(input.authorityTransitionDigest ?? ''))) {
      fail('AUTHORITY_ACTIVATION_NOT_QUALIFIED', 'First activation requires durable cutover and authority-transition digests.');
    }
    if (wasActivated && !DIGEST_PATTERN.test(input.authorityTransitionDigest ?? '')) {
      fail('AUTHORITY_TRANSITION_INVALID', 'Post-activation authority changes require a durable transition identity.');
    }
    const nextStoreGeneration = firstActivation ? store.manifest.storeGeneration + 1 : store.manifest.storeGeneration;
    const next = sealAuthoritySelector({
      ...current,
      storeGeneration: nextStoreGeneration,
      phase: input.phase,
      activationEpoch: activating || wasActivated ? 1 : 0,
      activationRevision: activating ? requestedActivationRevision : wasActivated ? current.activationRevision : null,
      activatedAt: activating ? (current.activatedAt ?? timestamp(store)) : wasActivated ? current.activatedAt : null,
      activeWriterProtocol: activating || wasActivated ? store.manifest.currentWriterProtocol : null,
      activeBuildIdentity: activating ? input.buildIdentity : wasActivated ? current.activeBuildIdentity : null,
      authorityTransitionDigest: firstActivation || wasActivated
        ? input.authorityTransitionDigest
        : current.authorityTransitionDigest,
      activationCutoverDigest: firstActivation ? input.activationCutoverDigest : current.activationCutoverDigest,
      pendingBuildIdentity: null,
      handoffId: null,
      revision: current.revision + 1,
      previousDigest: current.digest,
      updatedAt: nextTimestamp(store, current.updatedAt),
    });
    await input.hooks?.beforeCommit?.(clone(next));
    if (firstActivation) {
      const intentBody = {
        schemaVersion: 1,
        kind: 'release-authority-activation-intent',
        fromSelectorDigest: current.digest,
        toSelectorDigest: next.digest,
        storeGeneration: nextStoreGeneration,
        activationRevision: requestedActivationRevision,
        selector: next,
        createdAt: timestamp(store),
      };
      const intentPath = authorityActivationIntentPath(store);
      if (await pathExists(store.storage.fs, intentPath)) {
        const staleIntent = await readBoundedJson(store.storage, intentPath, {
          label: 'release-authority activation intent',
        });
        const { digest: staleIntentDigest, ...staleIntentBody } = staleIntent ?? {};
        if (staleIntent?.schemaVersion !== 1 || staleIntent.kind !== 'release-authority-activation-intent'
          || staleIntent.fromSelectorDigest !== current.digest
          || staleIntent.toSelectorDigest !== staleIntent.selector?.digest
          || staleIntent.storeGeneration !== nextStoreGeneration
          || staleIntent.activationRevision !== requestedActivationRevision
          || staleIntentDigest !== canonicalDigest(staleIntentBody)) {
          fail('AUTHORITY_SELECTOR_INVALID', 'Interrupted pre-fence activation intent is corrupt or stale.');
        }
        // The manifest still carries activationEpoch=0, so this intent never
        // crossed the durable activation fence. Under the singleton global
        // lock it is safe to discard and retry from the unchanged selector.
        await store.storage.fs.rm(intentPath);
      }
      await atomicWriteJson(store.storage, authorityActivationIntentPath(store), {
        ...intentBody, digest: canonicalDigest(intentBody),
      }, { exclusive: true });
      await input.hooks?.afterActivationIntent?.(clone(next));
      await writeManifest(store, {
        ...store.manifest,
        storeGeneration: nextStoreGeneration,
        activationEpoch: 1,
        activationRevision: requestedActivationRevision,
      });
      await input.hooks?.afterActivationFence?.(clone(next));
    }
    await atomicWriteJson(store.storage, authoritySelectorPath(store), next);
    if (firstActivation) await store.storage.fs.rm(authorityActivationIntentPath(store), { force: true });
    await input.hooks?.afterCommit?.(clone(next));
    return clone(next);
}

export function transitionReleaseAuthority(store, coordinator, input = {}) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => (
    transitionReleaseAuthorityUnlocked(store, coordinator, input)
  ));
}

export function transitionReleaseAuthorityWithPublicationFence(store, coordinator, input = {}) {
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    if (!Array.isArray(input.expectedPublications) || input.expectedPublications.length === 0) {
      fail('AUTHORITY_HEALTH_EVIDENCE_REQUIRED', 'Authority transition requires current publication fences.');
    }
    const runIds = input.expectedPublications.map(({ runId }) => safeId(runId, 'health runId'));
    if (new Set(runIds).size !== runIds.length) {
      fail('AUTHORITY_HEALTH_EVIDENCE_INVALID', 'Authority health publication fences must name unique runs.');
    }
    for (const expected of input.expectedPublications) {
      if (!DIGEST_PATTERN.test(expected.envelopeDigest ?? '')) {
        fail('AUTHORITY_HEALTH_EVIDENCE_INVALID', 'Authority health publication digest is invalid.');
      }
      const state = await recoverUnlocked(store, expected.runId);
      if (state.currentPublicationDigest !== expected.envelopeDigest
        || state.currentPublicationAuthorityBinding === null) {
        fail('AUTHORITY_HEALTH_EVIDENCE_STALE', `Health run ${expected.runId} no longer has the expected current publication.`);
      }
      const selector = await readAuthoritySelectorUnlocked(store);
      validatePublicationAuthorityBinding(store, selector, state.currentPublicationAuthorityBinding);
      const current = (await readPublicationChain(store, expected.runId, state.currentPublicationDigest)).at(-1);
      if (current.digest !== expected.envelopeDigest) {
        fail('AUTHORITY_HEALTH_EVIDENCE_STALE', `Health run ${expected.runId} publication chain changed.`);
      }
    }
    const transitionInput = { ...input };
    delete transitionInput.expectedPublications;
    return transitionReleaseAuthorityUnlocked(store, coordinator, transitionInput);
  });
}

export function prequalifyReleaseAuthorityBuild(store, coordinator, input = {}) {
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    await validateCoordinator(store, coordinator);
    const current = await readAuthoritySelectorUnlocked(store);
    const reservation = await readAuthorityHandoffReservationUnlocked(store);
    if (reservation?.state === 'PREPARED') {
      fail('AUTHORITY_HANDOFF_RESERVATION_HELD',
        `Build prequalification is fenced by prepared handoff ${reservation.handoffId}.`);
    }
    const targetBuildIdentity = input.targetBuildIdentity;
    if (current.phase !== 'ACTIVE' || current.activationEpoch !== 1
      || current.pendingBuildIdentity !== null
      || store.buildIdentity !== current.activeBuildIdentity
      || coordinator.buildIdentity !== current.activeBuildIdentity) {
      fail('AUTHORITY_PREQUALIFICATION_INVALID', 'Build prequalification requires the active source opener and coordinator lease with no pending handoff.');
    }
    if (typeof targetBuildIdentity !== 'string' || !targetBuildIdentity
      || targetBuildIdentity === current.activeBuildIdentity) {
      fail('AUTHORITY_PREQUALIFICATION_TARGET_INVALID', 'Build prequalification requires a distinct non-empty target build identity.');
    }
    if (!DIGEST_PATTERN.test(input.expectedSelectorDigest ?? '')
      || !DIGEST_PATTERN.test(input.expectedManifestDigest ?? '')
      || !DIGEST_PATTERN.test(input.authorityTransitionDigest ?? '')
      || !Number.isSafeInteger(input.expectedTargetSelectorRevision)) {
      fail('AUTHORITY_PREQUALIFICATION_INVALID', 'Build prequalification requires exact manifest, selector, revision, and transition digests.');
    }
    let expectedManifest = null;
    if (input.expectedManifest !== undefined && input.expectedManifest !== null) {
      expectedManifest = validateManifest(structuredClone(input.expectedManifest), {
        supportedSchemaVersion: PARENT_RUN_STORE_SCHEMA_VERSION,
        writerProtocol: store.manifest.currentWriterProtocol,
      });
      if (expectedManifest.digest !== input.expectedManifestDigest) {
        fail('STORE_MANIFEST_CONFLICT', 'Expected build-prequalification manifest does not match its digest.');
      }
    }

    if (current.prequalifiedRollbackBuilds.includes(targetBuildIdentity)) {
      let intent = null;
      try {
        intent = validateAuthorityBuildPrequalificationIntent(store, await readBoundedJson(
          store.storage,
          authorityBuildPrequalificationHistoryPath(store, targetBuildIdentity),
          { label: 'release-authority build-prequalification history', maximumBytes: 256 * 1_024 },
        ));
      } catch (error) {
        if (error?.code !== 'ATOMIC_NOT_FOUND') throw error;
      }
      const exactReplay = intent !== null
        && intent.fromSelectorDigest === input.expectedSelectorDigest
        && intent.expectedTargetSelectorRevision === input.expectedTargetSelectorRevision
        && intent.authorityTransitionDigest === input.authorityTransitionDigest
        && intent.toSelectorDigest === current.digest
        && (intent.fromManifestDigest === input.expectedManifestDigest
          || (expectedManifest !== null
            && manifestIsCoordinatorSuccessor(intent.fromManifest, expectedManifest)))
        && manifestCarriesPrequalificationTransition(store.manifest, intent.manifest);
      if (exactReplay) return clone(current);
      fail('AUTHORITY_PREQUALIFICATION_TARGET_CONFLICT', 'Target build is already prequalified by a different durable transition.');
    }
    if (current.digest !== input.expectedSelectorDigest) {
      fail('AUTHORITY_SELECTOR_CONFLICT', 'Release-authority selector changed before build prequalification.');
    }
    if (store.manifest.digest !== input.expectedManifestDigest
      && (expectedManifest === null || !manifestIsCoordinatorSuccessor(store.manifest, expectedManifest))) {
      fail('STORE_MANIFEST_CONFLICT', 'Parent-run store manifest changed before build prequalification.');
    }
    if (input.expectedTargetSelectorRevision !== current.revision + 1) {
      fail('AUTHORITY_PREQUALIFICATION_REVISION_INVALID', 'Build prequalification requires the exact next selector revision.');
    }

    const prequalifiedRollbackBuilds = [...current.prequalifiedRollbackBuilds, targetBuildIdentity].sort();
    const nextManifestBody = {
      ...manifestBody(store.manifest),
      prequalifiedRollbackBuilds,
    };
    const nextManifest = {
      ...nextManifestBody,
      digest: canonicalDigest(nextManifestBody),
    };
    const nextSelector = sealAuthoritySelector({
      ...current,
      prequalifiedRollbackBuilds,
      authorityTransitionDigest: input.authorityTransitionDigest,
      revision: input.expectedTargetSelectorRevision,
      previousDigest: current.digest,
      updatedAt: nextTimestamp(store, current.updatedAt),
    });
    const intentBody = {
      schemaVersion: 1,
      kind: 'release-authority-build-prequalification-intent',
      targetBuildIdentity,
      authorityTransitionDigest: input.authorityTransitionDigest,
      expectedTargetSelectorRevision: input.expectedTargetSelectorRevision,
      fromManifestDigest: store.manifest.digest,
      toManifestDigest: nextManifest.digest,
      fromSelectorDigest: current.digest,
      toSelectorDigest: nextSelector.digest,
      fromManifest: store.manifest,
      manifest: nextManifest,
      fromSelector: current,
      selector: nextSelector,
      createdAt: timestamp(store),
    };
    const intent = { ...intentBody, digest: canonicalDigest(intentBody) };
    validateAuthorityBuildPrequalificationIntent(store, structuredClone(intent));
    await atomicWriteJson(store.storage, authorityBuildPrequalificationIntentPath(store), intent, { exclusive: true });
    await input.hooks?.afterIntent?.(clone(nextSelector));
    await atomicWriteJson(store.storage, containedPath(store.root, 'store-manifest.json'), nextManifest);
    store.manifest = nextManifest;
    await input.hooks?.afterManifest?.(clone(nextSelector));
    await atomicWriteJson(store.storage, authoritySelectorPath(store), nextSelector);
    await input.hooks?.afterSelector?.(clone(nextSelector));
    await persistAuthorityBuildPrequalificationIntent(store, intent);
    await store.storage.fs.rm(authorityBuildPrequalificationIntentPath(store), { force: true });
    return clone(nextSelector);
  });
}

export function beginReleaseAuthorityBuildHandoff(store, coordinator, input = {}) {
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    const current = await readAuthoritySelectorUnlocked(store);
    safeId(input.handoffId, 'handoffId');
    if (typeof input.targetBuildIdentity !== 'string' || !input.targetBuildIdentity
      || !DIGEST_PATTERN.test(input.expectedSelectorDigest ?? '')) {
      fail('AUTHORITY_HANDOFF_TARGET_UNQUALIFIED', 'Build handoff requires a distinct target and exact source selector digest.');
    }
    const reservationInput = {
      handoffId: input.handoffId,
      sourceSelectorDigest: input.expectedSelectorDigest,
      targetBuildIdentity: input.targetBuildIdentity,
    };
    if (current.phase === 'PROMOTION_DISABLED') {
      if (current.handoffId !== input.handoffId || current.pendingBuildIdentity !== input.targetBuildIdentity) {
        fail('AUTHORITY_HANDOFF_INVALID', 'Durable pending authority does not match this build handoff.');
      }
      if (current.previousDigest !== input.expectedSelectorDigest) {
        fail('AUTHORITY_HANDOFF_RESERVATION_CONFLICT',
          'Durable pending authority does not preserve this handoff source selector.');
      }
      const reservation = await readAuthorityHandoffReservationUnlocked(store);
      if (reservation?.state === 'CONSUMED') {
        if (!reservationMatches(reservation, reservationInput) || reservation.pendingSelectorDigest !== current.digest) {
          fail('AUTHORITY_HANDOFF_RESERVATION_CONFLICT',
            'Consumed handoff reservation does not match the pending authority selector.');
        }
        return clone(current);
      }
      // Only an exact already-CONSUMED replay may be coordinator-free. A
      // pending selector that still needs its PREPARED reservation consumed
      // must be owned by the live pending-target coordinator.
      await validateCoordinator(store, coordinator);
      await consumeAuthorityHandoffReservationUnlocked(store, current, reservationInput);
      return clone(current);
    }
    await validateCoordinator(store, coordinator);
    if (current.digest !== input.expectedSelectorDigest) {
      fail('AUTHORITY_SELECTOR_CONFLICT', 'Release-authority selector changed before build handoff.');
    }
    if (current.phase !== 'ACTIVE' || current.activationEpoch !== 1 || current.pendingBuildIdentity !== null
      || store.buildIdentity !== current.activeBuildIdentity) {
      fail('AUTHORITY_HANDOFF_INVALID', 'Build handoff must begin from the active source build.');
    }
    if (input.targetBuildIdentity === current.activeBuildIdentity
      || !current.prequalifiedRollbackBuilds.includes(input.targetBuildIdentity)) {
      fail('AUTHORITY_HANDOFF_TARGET_UNQUALIFIED', 'Build handoff target must be a distinct prequalified build.');
    }
    // Do not publish a pending selector until the durable PREPARED reservation
    // has been proven.  This makes an interrupted/legacy prepare fail closed
    // without stranding authority in PROMOTION_DISABLED.
    await requirePreparedAuthorityHandoffReservationUnlocked(store, reservationInput);
    const next = sealAuthoritySelector({
      ...current,
      phase: 'PROMOTION_DISABLED',
      pendingBuildIdentity: input.targetBuildIdentity,
      handoffId: input.handoffId,
      revision: current.revision + 1,
      previousDigest: current.digest,
      updatedAt: nextTimestamp(store, current.updatedAt),
    });
    await atomicWriteJson(store.storage, authoritySelectorPath(store), next);
    await input.hooks?.afterPendingSelectorWritten?.(clone(next));
    await consumeAuthorityHandoffReservationUnlocked(store, next, reservationInput);
    return clone(next);
  });
}

export function authorizeCutoverCanaryRunSupersession(store, input = {}) {
  const runId = safeId(input.runId, 'cutover canary superseded runId');
  safeId(input.cutoverId, 'cutoverId');
  if (!['single-site', 'comparative'].includes(input.mode)
    || !Number.isSafeInteger(input.replacementRevision) || input.replacementRevision < 2
    || input.replacementRevision > MAX_CUTOVER_CANARY_SUPERSESSION_REVISIONS
    || !DIGEST_PATTERN.test(input.sourcePermitDigest ?? '')
    || !DIGEST_PATTERN.test(input.authorizationDigest ?? '')
    || !DIGEST_PATTERN.test(input.expectedSelectorDigest ?? '')
    || !CUTOVER_REQUEST_ID_PATTERN.test(input.requestId ?? '')
    || typeof input.supersedeReason !== 'string' || !input.supersedeReason.trim()
    || input.supersedeReason.length > 2_048 || input.supersedeReason.includes('\0')) {
    fail('STORE_SCHEMA_INVALID', 'Cutover canary supersession authorization is invalid.');
  }
  return withDirectoryLock(store.storage, globalLockPath(store), () => (
    withDirectoryLock(store.storage, lockPath(store, runId), async () => {
      const selector = await readAuthoritySelectorUnlocked(store);
      if (selector.phase !== 'ACTIVE' || selector.digest !== input.expectedSelectorDigest
        || selector.activeBuildIdentity !== store.buildIdentity || selector.pendingBuildIdentity !== null) {
        fail('CUTOVER_CANARY_REPLACEMENT_BLOCKED',
          'Cutover canary supersession does not match the active release authority.');
      }
      const intended = sealCutoverCanarySupersessionFence({
        schemaVersion: 1,
        runId,
        cutoverId: input.cutoverId,
        mode: input.mode,
        replacementRevision: input.replacementRevision,
        sourcePermitDigest: input.sourcePermitDigest,
        requestId: input.requestId,
        authorizationDigest: input.authorizationDigest,
        authoritySelectorDigest: input.expectedSelectorDigest,
        supersedeReason: input.supersedeReason,
        fencedAt: timestamp(store),
      });
      const existing = await readCutoverCanarySupersessionFenceUnlocked(store, runId);
      if (existing !== null) {
        if (!cutoverCanarySupersessionMatches(existing, intended)) {
          fail('CUTOVER_CANARY_SUPERSESSION_CONFLICT',
            'A different replacement already fenced this cutover canary run.');
        }
        return clone(existing);
      }

      const state = await recoverUnlocked(store, runId);
      if (state.authorityTombstone !== null) {
        fail('CUTOVER_CANARY_REPLACEMENT_BLOCKED',
          'A release-authority tombstoned canary cannot be used as replacement evidence.');
      }
      if (state.currentPublicationDigest !== null) {
        const publication = (await readPublicationChain(
          store,
          runId,
          state.currentPublicationDigest,
        )).at(-1);
        if (publication.decision?.ready === true) {
          fail('CUTOVER_CANARY_REPLACEMENT_BLOCKED', 'A current ready canary cannot be replaced.');
        }
      }
      const workItems = Object.values(state.workItems ?? {});
      if (workItems.length === 0 || workItems.some((item) => (
        !['completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(item.state)
      ))) {
        fail('CUTOVER_CANARY_REPLACEMENT_BLOCKED',
          'Canary replacement requires a durable terminal non-ready run.');
      }

      try {
        await atomicWriteJson(
          store.storage,
          releaseSupersessionFencePath(store, runId),
          intended,
          { exclusive: true },
        );
      } catch (error) {
        if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
        const raced = await readCutoverCanarySupersessionFenceUnlocked(store, runId);
        if (raced === null || !cutoverCanarySupersessionMatches(raced, intended)) {
          fail('CUTOVER_CANARY_SUPERSESSION_CONFLICT',
            'A different replacement raced this cutover canary supersession.');
        }
        return clone(raced);
      }
      return clone(intended);
    })
  ));
}

export function registerReleaseAuthorityHandoffCanaryRun(store, coordinator, input = {}) {
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    if (coordinator !== null) await validateCoordinator(store, coordinator);
    const selector = await readAuthoritySelectorUnlocked(store);
    if (selector.digest !== input.expectedSelectorDigest || selector.phase !== 'PROMOTION_DISABLED'
      || selector.handoffId !== input.handoffId || selector.pendingBuildIdentity !== store.buildIdentity) {
      fail('AUTHORITY_HANDOFF_INVALID', 'Canary registration does not match the pending target build handoff.');
    }
    if (!['single-site', 'comparative'].includes(input.mode)) {
      fail('AUTHORITY_HANDOFF_PERMIT_INVALID', 'Handoff canary mode is invalid.');
    }
    safeId(input.runId, 'handoff canary runId');
    const directory = containedPath(store.root, 'authority-handoff-permits');
    await ensureDirectory(store.storage.fs, directory);
    const file = handoffCanaryPermitPath(store, input.handoffId, input.mode);
    const permit = sealHandoffCanaryPermit({
      schemaVersion: 1,
      handoffId: input.handoffId,
      mode: input.mode,
      runId: input.runId,
      targetBuildIdentity: store.buildIdentity,
      selectorDigest: selector.digest,
      coordinatorEpoch: coordinator?.epoch ?? store.manifest.coordinatorEpoch,
      registeredAt: timestamp(store),
      revision: 1,
      previousPermitDigest: null,
      supersedesRunId: null,
      supersedeAuthorizationDigest: null,
      failureAttempts: 0,
    });
    if (!await pathExists(store.storage.fs, file)) {
      if (input.supersedesRunId !== undefined && input.supersedesRunId !== null
        || input.supersedeAuthorizationDigest !== undefined && input.supersedeAuthorizationDigest !== null) {
        fail('AUTHORITY_HANDOFF_PERMIT_CONFLICT', 'Initial handoff canary registration cannot claim supersession.');
      }
      await persistImmutableHandoffCanaryPermit(store, permit);
      await atomicWriteJson(store.storage, file, permit, { exclusive: true });
      return clone(permit);
    }
    const existing = validateHandoffCanaryPermit(await readBoundedJson(store.storage, file, {
      label: 'release-authority handoff canary permit', maximumBytes: 64 * 1_024,
    }), selector, input.mode);
    if (existing.runId !== input.runId) {
      if (input.supersedesRunId !== existing.runId
        || !DIGEST_PATTERN.test(input.supersedeAuthorizationDigest ?? '')
        || (existing.revision ?? 1) >= MAX_HANDOFF_CANARY_PERMIT_REVISIONS) {
        fail('AUTHORITY_HANDOFF_PERMIT_CONFLICT', `A different ${input.mode} handoff canary is already registered.`);
      }
      return withDirectoryLock(store.storage, lockPath(store, existing.runId), async () => {
        const replacedState = await assertHandoffCanaryPermitReplaceableUnlocked(store, existing);
        const failureAttempts = await failureAttemptsAfterHandoffPermit(store, selector, existing, replacedState);
        if (failureAttempts >= MAX_HANDOFF_CANARY_FAILURE_ATTEMPTS) {
          fail('AUTHORITY_HANDOFF_PERMIT_CONFLICT',
            `The ${input.mode} handoff canary failure-recovery bound is exhausted.`);
        }
        const replacement = sealHandoffCanaryPermit({
          ...permit,
          revision: (existing.revision ?? 1) + 1,
          previousPermitDigest: existing.digest,
          supersedesRunId: existing.runId,
          supersedeAuthorizationDigest: input.supersedeAuthorizationDigest,
          failureAttempts,
        });
        await persistImmutableHandoffCanaryPermit(store, existing);
        await persistImmutableHandoffCanaryPermit(store, replacement);
        await atomicWriteJson(store.storage, file, replacement);
        return clone(replacement);
      });
    }
    await persistImmutableHandoffCanaryPermit(store, existing);
    return clone(existing);
  });
}

export function completeReleaseAuthorityBuildHandoffWithPublicationFence(store, coordinator, input = {}) {
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    await validateCoordinator(store, coordinator);
    const selector = await readAuthoritySelectorUnlocked(store);
    if (selector.digest !== input.expectedSelectorDigest || selector.phase !== 'PROMOTION_DISABLED'
      || selector.handoffId !== input.handoffId || selector.pendingBuildIdentity !== input.targetBuildIdentity
      || store.buildIdentity !== input.targetBuildIdentity) {
      fail('AUTHORITY_HANDOFF_INVALID', 'Build handoff completion does not match the pending target selector.');
    }
    if (!Array.isArray(input.expectedPublications) || input.expectedPublications.length !== 2
      || new Set(input.expectedPublications.map(({ mode }) => mode)).size !== 2
      || input.expectedPublications.some(({ mode }) => !['single-site', 'comparative'].includes(mode))) {
      fail('AUTHORITY_HANDOFF_HEALTH_REQUIRED', 'Build handoff requires exact Single-site and Comparative health publications.');
    }
    for (const expected of input.expectedPublications) {
      const permit = validateHandoffCanaryPermit(await readBoundedJson(
        store.storage,
        handoffCanaryPermitPath(store, input.handoffId, expected.mode),
        { label: 'release-authority handoff canary permit', maximumBytes: 64 * 1_024 },
      ), selector, expected.mode);
      if (permit.runId !== expected.runId || !DIGEST_PATTERN.test(expected.envelopeDigest ?? '')) {
        fail('AUTHORITY_HANDOFF_HEALTH_REQUIRED', `${expected.mode} handoff health publication is not permitted.`);
      }
      const state = await recoverUnlocked(store, expected.runId);
      if (state.currentPublicationDigest !== expected.envelopeDigest || state.currentPublicationAuthorityBinding === null) {
        fail('AUTHORITY_HANDOFF_HEALTH_STALE', `${expected.mode} handoff health publication changed.`);
      }
      validatePublicationAuthorityBinding(store, selector, state.currentPublicationAuthorityBinding);
      const publication = (await readPublicationChain(store, expected.runId, expected.envelopeDigest)).at(-1);
      if (publication.digest !== expected.envelopeDigest || publication.decision?.ready !== true
        || publication.decision?.code !== 'RELEASE_READY' || publication.decision?.grantedAuthority !== 'FULL'
        || publication.decision?.mode !== expected.mode) {
        fail('AUTHORITY_HANDOFF_HEALTH_NOT_READY', `${expected.mode} handoff health publication is not FULL release ready.`);
      }
    }
    const next = sealAuthoritySelector({
      ...selector,
      phase: 'ACTIVE',
      activeBuildIdentity: input.targetBuildIdentity,
      authorityTransitionDigest: input.authorityTransitionDigest,
      pendingBuildIdentity: null,
      handoffId: null,
      revision: selector.revision + 1,
      previousDigest: selector.digest,
      updatedAt: nextTimestamp(store, selector.updatedAt),
    });
    if (!DIGEST_PATTERN.test(input.authorityTransitionDigest ?? '')
      || input.expectedTargetSelectorRevision !== selector.revision + 1) {
      fail('AUTHORITY_HANDOFF_COMMIT_INVALID', 'Build handoff completion requires its exact durable transition digest and selector revision.');
    }
    await input.hooks?.beforeCommit?.(clone(next));
    await atomicWriteJson(store.storage, authoritySelectorPath(store), next);
    await input.hooks?.afterCommit?.(clone(next));
    return clone(next);
  });
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
  return withDirectoryLock(store.storage, coordinatorLeaseLockPath(store), async () => {
    const current = await validateCoordinator(store, coordinator);
    const renewed = sealCoordinatorLease({ ...current, expiresAt: new Date(store.clock() + leaseMs).toISOString() });
    await atomicWriteJson(store.storage, globalCoordinatorPath(store), renewed);
    return clone({
      buildIdentity: renewed.buildIdentity,
      ownerId: renewed.ownerId, epoch: renewed.epoch, token: renewed.token,
      acquiredAt: renewed.acquiredAt, expiresAt: renewed.expiresAt,
    });
  });
}

export function releaseStoreCoordinator(store, coordinator) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => (
    withDirectoryLock(store.storage, coordinatorLeaseLockPath(store), async () => {
      await validateCoordinator(store, coordinator);
      await store.storage.fs.rm(globalCoordinatorPath(store), { force: true });
      return Object.freeze({
        buildIdentity: coordinator.buildIdentity,
        ownerId: coordinator.ownerId,
        epoch: coordinator.epoch,
        releasedAt: timestamp(store),
      });
    })
  ));
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

async function schedulingStatesUnlocked(store, { forceRunIds = [] } = {}) {
  const cache = schedulingStateCache(store);
  const discoveredRunIds = await listParentRunIds(store);
  const discovered = new Set(discoveredRunIds);
  for (const runId of cache.knownRunIds) {
    if (discovered.has(runId)) continue;
    cache.knownRunIds.delete(runId);
    cache.relevantRunIds.delete(runId);
    recoveryCacheDelete(store, runId);
  }
  const forcedRunIds = [...new Set(forceRunIds)].filter((runId) => discovered.has(runId));
  const cachedForcedRunIds = forcedRunIds.filter((runId) => recoveryCacheGet(store, runId, { touch: false }) !== null);
  const uncachedForcedRunIds = forcedRunIds.filter((runId) => recoveryCacheGet(store, runId, { touch: false }) === null);
  // Authenticate already-cached candidates before cold candidates. Otherwise a
  // cache that is only one entry over budget can evict the next candidate on
  // every iteration and replay the entire authorized archive.
  const candidateRunIds = cache.initialized
    ? new Set([
      ...cache.relevantRunIds,
      ...cachedForcedRunIds,
      ...discoveredRunIds.filter((runId) => !cache.knownRunIds.has(runId)),
      ...uncachedForcedRunIds,
    ])
    : new Set(discoveredRunIds);
  const states = [];
  for (const runId of candidateRunIds) {
    const state = await recoverUnlocked(store, runId);
    states.push(state);
  }
  cache.initialized = true;
  return states;
}

function liveRunningItems(states, store) {
  return states.flatMap((state) => Object.values(state.workItems).flatMap((item) => [
    ...(item.state === 'running' && item.lease && Date.parse(item.lease.expiresAt) > store.clock()
      ? [{ state, item, target: item }] : []),
    ...item.diagnosticExecutions.filter((diagnostic) => diagnostic.state === 'running'
      && diagnostic.lease && Date.parse(diagnostic.lease.expiresAt) > store.clock())
      .map((diagnostic) => ({ state, item, target: diagnostic })),
  ]));
}

async function reconcilePerformanceSchedulerUnlocked(store, coordinator, states = null, observed = null) {
  const current = observed ?? await readPerformanceSchedulerUnlocked(store);
  if (current.phase === 'idle') return current;
  const reservation = current.reservation;
  const allStates = states ?? await schedulingStatesUnlocked(store, { forceRunIds: [reservation.runId] });
  const state = allStates.find(({ runId }) => runId === reservation.runId);
  const item = state?.workItems?.[reservation.workItemId];
  const target = reservation.diagnosticExecutionId === null ? item
    : item?.diagnosticExecutions.find(({ diagnosticExecutionId }) => diagnosticExecutionId === reservation.diagnosticExecutionId);
  if (current.phase === 'draining') {
    if (reservation.coordinatorEpoch !== coordinator.epoch || Date.parse(reservation.expiresAt) <= store.clock()
      || !state || state.status !== 'active' || state.authorityTombstone !== null
      || !item || !target || item.resourceClass !== 'performance'
      || (!['queued', 'running'].includes(target.state))) {
      return writePerformanceSchedulerUnlocked(store, current, 'idle');
    }
    if (target.state === 'running') {
      if (!target.lease || target.lease.workerId !== reservation.workerId
        || target.lease.epoch !== reservation.coordinatorEpoch) {
        fail('STORE_CORRUPT', 'Draining performance reservation disagrees with its running work lease.');
      }
      return writePerformanceSchedulerUnlocked(store, current, 'running', {
        ...reservation,
        attempt: target.lease.attempt,
        leaseToken: target.lease.token,
        acquiredAt: target.lease.claimedAt,
      });
    }
    return current;
  }
  if (!state || state.status !== 'active' || state.authorityTombstone !== null || !item
    || !target || target.state !== 'running' || !target.lease) {
    return writePerformanceSchedulerUnlocked(store, current, 'idle');
  }
  if (item.resourceClass !== 'performance' || target.lease.workerId !== reservation.workerId
    || target.lease.attempt !== reservation.attempt || target.lease.epoch !== reservation.coordinatorEpoch
    || target.lease.token !== reservation.leaseToken) {
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
    const authority = await readAuthoritySelectorUnlocked(store);
    for (const runId of runIds) await requireHandoffRunPermit(store, authority, runId);
    const observedScheduler = await readPerformanceSchedulerUnlocked(store);
    const reservationRunIds = observedScheduler.phase === 'idle' ? [] : [observedScheduler.reservation.runId];
    const states = await schedulingStatesUnlocked(store, { forceRunIds: [...runIds, ...reservationRunIds] });
    const current = await reconcilePerformanceSchedulerUnlocked(store, coordinator, states, observedScheduler);
    if (current.phase === 'running') fail('PERFORMANCE_LEASE_HELD', 'The store-global performance resource is already running.');
    if (current.phase === 'draining') {
      if (current.reservation.workerId !== worker.workerId) {
        fail('PERFORMANCE_DRAIN_HELD', 'Another worker holds the store-global performance drain.');
      }
      const reservedState = states.find(({ runId }) => runId === current.reservation.runId);
      const reservedItem = reservedState?.workItems?.[current.reservation.workItemId];
      const reservedTarget = current.reservation.diagnosticExecutionId === null
        ? reservedItem
        : reservedItem?.diagnosticExecutions.find(
          ({ diagnosticExecutionId }) => diagnosticExecutionId === current.reservation.diagnosticExecutionId,
        );
      if (!runIds.includes(current.reservation.runId)
        || !reservedState || reservedState.status !== 'active' || reservedState.authorityTombstone !== null
        || !reservedItem || !reservedTarget || reservedTarget.state !== 'queued') {
        fail('PERFORMANCE_DRAIN_REQUIRED',
          'The active performance reservation is outside this worker authorization or no longer queued.');
      }
      if (!workerCanRun(reservedItem, worker)) {
        fail('WORKER_CAPABILITY_MISMATCH', `Worker cannot execute ${reservedItem.id}.`);
      }
      const remainingLeaseMs = Date.parse(current.reservation.expiresAt) - store.clock();
      if (remainingLeaseMs > Math.floor(leaseMs / 2)) {
        return clone(current.reservation);
      }
      const renewedExpiresAt = new Date(store.clock() + leaseMs).toISOString();
      if (Date.parse(renewedExpiresAt) <= Date.parse(current.reservation.expiresAt)) {
        return clone(current.reservation);
      }
      const renewedReservation = {
        ...current.reservation,
        expiresAt: renewedExpiresAt,
      };
      await writePerformanceSchedulerUnlocked(store, current, 'draining', renewedReservation);
      return clone(renewedReservation);
    }
    const statesByRunId = new Map(states.map((state) => [state.runId, state]));
    const authorizedStates = runIds.map((runId) => statesByRunId.get(runId)).filter(Boolean);
    const selected = authorizedStates
      .filter((state) => state.status === 'active' && state.authorityTombstone === null)
      .flatMap((state) => Object.values(state.workItems).flatMap((item) => [
        ...(item.state === 'queued' ? [{ state, item, diagnostic: null }] : []),
        ...(queuedDiagnostic(item) ? [{ state, item, diagnostic: queuedDiagnostic(item) }] : []),
      ]))
      .find(({ item }) => item.resourceClass === 'performance' && workerCanRun(item, worker));
    if (!selected) fail('NO_PERFORMANCE_WORK', 'No authorized queued performance work item is available.');
    const reservation = {
      workerId: worker.workerId,
      runId: selected.state.runId,
      workItemId: selected.item.id,
      diagnosticExecutionId: selected.diagnostic?.diagnosticExecutionId ?? null,
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

function createWorkLease(store, state, requested, worker, coordinator, leaseMs, diagnostic = null) {
  const attempt = (diagnostic ?? requested).attempts.length + 1;
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
    ...(diagnostic === null ? {} : { diagnosticExecutionId: diagnostic.diagnosticExecutionId }),
  };
}

function queuedDiagnostic(item) {
  return item.diagnosticExecutions?.find(({ state }) => state === 'queued') ?? null;
}

async function claimStoreWorkItemInternal(store, coordinator, input, forceRunIds = []) {
  if (!Number.isSafeInteger(input?.leaseMs) || input.leaseMs < 100 || input.leaseMs > 3_600_000) {
    fail('STORE_SCHEMA_INVALID', 'Work-item leaseMs must be an integer from 100 through 3600000.');
  }
  const worker = validatedWorkerScheduling(input);
  const runIds = normalizedRunIds(input?.runIds);
  return withDirectoryLock(store.storage, globalLockPath(store), async () => {
    await validateCoordinator(store, coordinator);
    const authority = await readAuthoritySelectorUnlocked(store);
    if (authority.phase === 'DRAINING') {
      fail('CUTOVER_WORK_CLAIMS_FENCED', 'Work claims are fenced while shared release authority is draining for cutover.');
    }
    if (authority.pendingBuildIdentity !== null) {
      for (const runId of runIds) await requireHandoffRunPermit(store, authority, runId);
    }
    const observedScheduler = await readPerformanceSchedulerUnlocked(store);
    const reservationRunIds = observedScheduler.phase === 'idle' ? [] : [observedScheduler.reservation.runId];
    const states = await schedulingStatesUnlocked(store, {
      forceRunIds: [...runIds, ...forceRunIds, ...reservationRunIds],
    });
    const scheduler = await reconcilePerformanceSchedulerUnlocked(store, coordinator, states, observedScheduler);
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
    const statesByRunId = new Map(states.map((state) => [state.runId, state]));
    // The caller orders authorized runs to provide store-wide fairness. Keep
    // that order when choosing ordinary work instead of falling back to the
    // canonical directory order used to recover all scheduling state.
    const authorizedStates = runIds.map((runId) => statesByRunId.get(runId)).filter(Boolean);
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
      const diagnostic = scheduler.reservation.diagnosticExecutionId === null ? null
        : item?.diagnosticExecutions.find(({ diagnosticExecutionId }) => diagnosticExecutionId === scheduler.reservation.diagnosticExecutionId);
      selected = { state, item, diagnostic };
    } else if (input.workItemId) {
      const state = states.find((candidate) => authorized.has(candidate.runId)
        && candidate.workItems[input.workItemId]);
      const item = state?.workItems?.[input.workItemId];
      if (!state || !item) fail('NO_WORK_AVAILABLE', `Work item ${input.workItemId} is unavailable.`);
      const diagnostic = queuedDiagnostic(item);
      if (item.state !== 'queued' && diagnostic === null) {
        if (['completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(item.state)) {
          fail('WORK_ITEM_TERMINAL', `Work item ${item.id} is terminal.`);
        }
        fail('WORK_ITEM_LEASE_HELD', `Work item ${item.id} already has an active lease.`);
      }
      selected = { state, item, diagnostic };
    } else {
      selected = authorizedStates
        .filter((state) => state.status === 'active' && state.authorityTombstone === null)
        .flatMap((state) => Object.values(state.workItems).flatMap((item) => [
          ...(item.state === 'queued' ? [{ state, item, diagnostic: null }] : []),
          ...(queuedDiagnostic(item) ? [{ state, item, diagnostic: queuedDiagnostic(item) }] : []),
        ]))
        .find(({ item }) => workerCanRun(item, worker));
    }
    if (!selected) {
      const queued = states.some((state) => authorized.has(state.runId)
        && Object.values(state.workItems).some((item) => item.state === 'queued' || queuedDiagnostic(item)));
      fail(queued ? 'NO_COMPATIBLE_WORK' : 'NO_WORK_AVAILABLE', queued
        ? 'No queued work item matches this worker capability.'
        : 'No queued work item is available.');
    }
    const { state: selectedState, item: selectedItem, diagnostic: selectedDiagnostic = null } = selected;
    if (selectedState.status === 'cancelled') fail('RUN_CANCELLED', `Parent run ${selectedState.runId} is cancelled.`);
    if (selectedDiagnostic === null && selectedItem.state !== 'queued') fail('WORK_ITEM_LEASE_HELD', `Work item ${selectedItem.id} is not queued.`);
    if (selectedDiagnostic !== null && selectedDiagnostic.state !== 'queued') fail('WORK_ITEM_LEASE_HELD', `Diagnostic execution ${selectedDiagnostic.diagnosticExecutionId} is not queued.`);
    if (!workerCanRun(selectedItem, worker)) fail('WORKER_CAPABILITY_MISMATCH', `Worker cannot execute ${selectedItem.id}.`);
    return withDirectoryLock(store.storage, lockPath(store, selectedState.runId), async () => {
      const state = await recoverUnlocked(store, selectedState.runId);
      const requested = state.workItems[selectedItem.id];
      const diagnostic = selectedDiagnostic === null ? null
        : requested?.diagnosticExecutions.find(({ diagnosticExecutionId }) => diagnosticExecutionId === selectedDiagnostic.diagnosticExecutionId);
      if (!requested || (diagnostic === null ? requested.state !== 'queued' : diagnostic.state !== 'queued')) {
        fail('WORK_ITEM_LEASE_HELD', `Work item ${selectedItem.id} is not queued.`);
      }
      const claimed = createWorkLease(store, state, requested, worker, coordinator, input.leaseMs, diagnostic);
      await appendMutationUnlocked(store, state, 'mutation', 'work-item-claimed', (next) => {
        const item = next.workItems[requested.id];
        if (diagnostic === null) {
          item.state = 'running';
          item.lease = claimed;
        } else {
          const mutable = item.diagnosticExecutions.find(({ diagnosticExecutionId }) => diagnosticExecutionId === diagnostic.diagnosticExecutionId);
          mutable.state = 'running';
          mutable.lease = claimed;
        }
      }, { data: { workerId: worker.workerId, workItemId: requested.id, diagnosticExecutionId: diagnostic?.diagnosticExecutionId ?? null } });
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

export function claimStoreWorkItem(store, coordinator, input) {
  return claimStoreWorkItemInternal(store, coordinator, input);
}

export function claimWorkItem(store, runId, coordinator, input) {
  return claimStoreWorkItemInternal(store, coordinator, { ...input, runIds: [runId] }, [runId]);
}

function validateWorkLease(state, lease) {
  if (lease?.runId !== undefined && lease.runId !== state.runId) {
    fail('WORK_RESULT_BINDING_MISMATCH', 'Work-item lease belongs to a different parent run.');
  }
  const item = state.workItems[lease?.workItemId];
  const target = lease?.diagnosticExecutionId === undefined
    ? item
    : item?.diagnosticExecutions?.find(({ diagnosticExecutionId }) => diagnosticExecutionId === lease.diagnosticExecutionId);
  if (!item || !target || target.state !== 'running' || !target.lease
    || target.lease.token !== lease.token || target.lease.workerId !== lease.workerId
    || target.lease.attempt !== lease.attempt || target.lease.epoch !== lease.epoch
    || target.lease.diagnosticExecutionId !== lease.diagnosticExecutionId
    || Date.parse(target.lease.expiresAt) <= state.clockNow) {
    fail('STALE_WORK_LEASE', 'Work-item lease or fencing token is stale.');
  }
  return target;
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
    diagnosticExecutionId: lease.diagnosticExecutionId ?? null,
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
    'leaseToken', 'diagnosticExecutionId', 'publishedAt', 'requestedExpiresAt', 'digest',
  ], 'attempt heartbeat inbox');
  const publishedAt = canonicalTimestamp(document.publishedAt, 'heartbeat publishedAt');
  const requestedExpiresAt = canonicalTimestamp(document.requestedExpiresAt, 'heartbeat requestedExpiresAt');
  if (document.schemaVersion !== 1 || document.kind !== 'attempt-heartbeat-inbox' || document.runId !== runId
    || document.workItemId !== receipt.workItemId || document.leaseToken !== receipt.leaseToken
    || !SAFE_ID.test(document.workItemId) || !SAFE_ID.test(document.workerId)
    || !Number.isSafeInteger(document.attempt) || document.attempt < 1
    || !Number.isSafeInteger(document.coordinatorEpoch) || document.coordinatorEpoch < 1
    || (document.diagnosticExecutionId !== null && !/^[a-f0-9]{64}$/u.test(document.diagnosticExecutionId))
    || Date.parse(requestedExpiresAt) <= Date.parse(publishedAt)
    || Date.parse(requestedExpiresAt) - Date.parse(publishedAt) > 3_600_000
    || digest !== receipt.digest || digest !== canonicalDigest(body)) fail('STORE_CORRUPT', 'Attempt heartbeat inbox is corrupt.');
  if (document.coordinatorEpoch !== coordinator?.epoch) {
    fail('STALE_WORK_LEASE', 'Heartbeat belongs to a stale coordinator epoch.');
  }
  let renewed;
  await mutate(store, runId, { coordinator, type: 'work-item-heartbeat-adopted', data: { workItemId: document.workItemId } }, (state) => {
    const item = state.workItems[document.workItemId];
    const target = document.diagnosticExecutionId === null ? item
      : item?.diagnosticExecutions?.find(({ diagnosticExecutionId }) => diagnosticExecutionId === document.diagnosticExecutionId);
    if (!target || target.state !== 'running' || !target.lease
      || target.lease.token !== document.leaseToken || target.lease.workerId !== document.workerId
      || target.lease.attempt !== document.attempt || target.lease.epoch !== document.coordinatorEpoch
      || target.lease.diagnosticExecutionId !== (document.diagnosticExecutionId ?? undefined)
      || Date.parse(document.publishedAt) > Date.parse(target.lease.expiresAt)) {
      fail('STALE_WORK_LEASE', 'Heartbeat was published after its fenced lease expired.');
    }
    renewed = { ...target.lease, expiresAt: document.requestedExpiresAt };
    target.lease = renewed;
  });
  return clone(renewed);
}

async function quarantineFailedAttemptEvidenceUnlocked(store, runId, state) {
  const runRoot = runDirectory(store, runId);
  const quarantineRoot = containedPath(runRoot, 'quarantine', 'orphan-attempts');
  const quarantined = [];
  for (const item of Object.values(state.workItems)) {
    for (const attempt of [
      ...item.attempts,
      ...item.diagnosticExecutions.flatMap(({ attempts }) => attempts),
    ]) {
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
    await validateCoordinator(store, coordinator, runId);
    const expiredIds = Object.values(state.workItems)
      .filter((item) => item.state === 'running'
        && (Date.parse(item.lease.expiresAt) <= store.clock() || item.lease.epoch !== coordinator.epoch))
      .map((item) => item.id);
    const expiredDiagnostics = Object.values(state.workItems).flatMap((item) => item.diagnosticExecutions
      .filter((diagnostic) => diagnostic.state === 'running'
        && (Date.parse(diagnostic.lease.expiresAt) <= store.clock() || diagnostic.lease.epoch !== coordinator.epoch))
      .map((diagnostic) => ({ workItemId: item.id, diagnosticExecutionId: diagnostic.diagnosticExecutionId })));
    const drainExpired = state.resourceScheduling.performanceDrain
      && Date.parse(state.resourceScheduling.performanceDrain.expiresAt) <= store.clock();
    const exclusiveExpired = state.resourceScheduling.exclusiveLease
      && Date.parse(state.resourceScheduling.exclusiveLease.expiresAt) <= store.clock();
    let current = state;
    if (expiredIds.length > 0 || expiredDiagnostics.length > 0 || drainExpired || exclusiveExpired) {
      current = await appendMutationUnlocked(store, state, 'mutation', 'expired-work-requeued', (next) => {
        for (const id of expiredIds) {
          const item = next.workItems[id];
          const reason = item.lease.epoch !== coordinator.epoch ? 'coordinator-epoch-fenced' : 'lease-expired';
          const canonicalResult = sealWorkItemResult({
            schemaVersion: 1,
            workItemId: item.id,
            subjectCoreDigest: next.subjectCoreDigest,
            attempt: item.lease.attempt,
            authoritative: false,
            outcome: 'operational_failure',
            evidenceDigests: [],
          });
          item.attempts.push({
            attempt: item.lease.attempt,
            outcome: 'operational_failure',
            evidenceDigests: [],
            artifacts: [],
            workerId: item.lease.workerId,
            leaseToken: item.lease.token,
            completedAt: timestamp(store),
            reason,
            canonicalResultDigest: canonicalResult.digest,
          });
          item.lease = null;
          item.state = item.attempts.length >= item.maxAttempts ? 'incomplete' : 'queued';
        }
        for (const { workItemId, diagnosticExecutionId } of expiredDiagnostics) {
          const item = next.workItems[workItemId];
          const diagnostic = item.diagnosticExecutions.find((entry) => entry.diagnosticExecutionId === diagnosticExecutionId);
          const reason = diagnostic.lease.epoch !== coordinator.epoch ? 'coordinator-epoch-fenced' : 'lease-expired';
          const result = sealWorkItemResult({
            schemaVersion: 1, workItemId, subjectCoreDigest: next.subjectCoreDigest,
            attempt: diagnostic.lease.attempt, authoritative: false,
            outcome: 'operational_failure', evidenceDigests: [],
          });
          diagnostic.attempts.push({
            attempt: diagnostic.lease.attempt, outcome: 'operational_failure', evidenceDigests: [], artifacts: [],
            workerId: diagnostic.lease.workerId, leaseToken: diagnostic.lease.token,
            completedAt: timestamp(store), reason, canonicalResultDigest: result.digest,
          });
          diagnostic.lease = null;
          diagnostic.state = diagnostic.attempts.length >= diagnostic.maxAttempts ? 'incomplete' : 'queued';
        }
        if (exclusiveExpired || expiredIds.some((id) => next.workItems[id].resourceClass === 'performance')
          || expiredDiagnostics.some(({ workItemId }) => next.workItems[workItemId].resourceClass === 'performance')) {
          next.resourceScheduling.exclusiveLease = null;
        }
        if (drainExpired || expiredIds.some((id) => next.workItems[id].resourceClass === 'performance'
          && next.workItems[id].state === 'incomplete')
          || expiredDiagnostics.some(({ workItemId, diagnosticExecutionId }) => {
            const item = next.workItems[workItemId];
            return item.resourceClass === 'performance'
              && item.diagnosticExecutions.find((entry) => entry.diagnosticExecutionId === diagnosticExecutionId)?.state === 'incomplete';
          })) {
          next.resourceScheduling.performanceDrain = null;
        }
      });
    }
    const scheduler = await readPerformanceSchedulerUnlocked(store);
    if (scheduler.phase !== 'idle' && scheduler.reservation.runId === runId
      && (expiredIds.includes(scheduler.reservation.workItemId)
        || expiredDiagnostics.some(({ workItemId, diagnosticExecutionId }) => (
          workItemId === scheduler.reservation.workItemId
          && diagnosticExecutionId === scheduler.reservation.diagnosticExecutionId)))) {
      await writePerformanceSchedulerUnlocked(store, scheduler, 'idle');
    }
    ({ quarantineRoot } = await quarantineFailedAttemptEvidenceUnlocked(store, runId, current));
    return expiredIds.length + expiredDiagnostics.length;
  }));
  if (quarantineRoot) await store.storage.fs.rm(quarantineRoot, { recursive: true, force: true });
  return expiredCount;
}

export async function publishAttemptEvidence(store, runId, lease, result) {
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  validateWorkLease(state, lease);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || Object.keys(result).some((key) => !['outcome', 'reason', 'artifacts', 'executionDescriptorDigest', 'riskSourceObservationSet', 'productFailureSignature'].includes(key))
    || !WORK_OUTCOMES.has(result?.outcome) || !Array.isArray(result.artifacts)
    || result.artifacts.length > MAX_ATTEMPT_ARTIFACTS) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence outcome or artifacts are invalid.');
  }
  const evidenceBindingDigest = lease.executionDescriptorDigest ?? lease.subjectCoreDigest ?? state.subjectCoreDigest;
  const productFailureSignature = normalizedProductFailureSignature(result.productFailureSignature, result.outcome);
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
    diagnosticExecutionId: lease.diagnosticExecutionId ?? null,
    subjectCoreDigest: lease.subjectCoreDigest ?? state.subjectCoreDigest,
    runnerRevision: lease.runnerRevision ?? state.runnerRevision,
    executionDescriptorDigest: result.executionDescriptorDigest ?? lease.executionDescriptorDigest ?? null,
    outcome: result.outcome,
    productFailureSignature,
    reason: schedulingString(result.reason ?? null, 'Attempt evidence reason', { nullable: true, maximum: 256 }),
    riskSourceObservationSet: normalizedRiskSourceObservationSet(result.riskSourceObservationSet, {
      runId,
      workItemId: lease.workItemId,
      subjectCoreDigest: lease.subjectCoreDigest ?? state.subjectCoreDigest,
      attempt: lease.attempt,
      workerId: lease.workerId,
    }),
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
  const signatureAware = 'productFailureSignature' in document;
  exactKeys(document, [
    'schemaVersion', 'kind', 'runId', 'workItemId', 'workerId', 'attempt', 'coordinatorEpoch',
    'leaseToken', 'diagnosticExecutionId', 'subjectCoreDigest', 'runnerRevision', 'executionDescriptorDigest', 'outcome', 'reason',
    'riskSourceObservationSet', ...(signatureAware ? ['productFailureSignature'] : []), 'artifacts', 'createdAt', 'digest',
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
    || (document.diagnosticExecutionId !== null && !/^[a-f0-9]{64}$/u.test(document.diagnosticExecutionId))
    || !DIGEST_PATTERN.test(document.subjectCoreDigest)
    || typeof document.runnerRevision !== 'string' || !document.runnerRevision || document.runnerRevision.length > 512
    || (document.executionDescriptorDigest !== null && !DIGEST_PATTERN.test(document.executionDescriptorDigest))
    || !['completed_pass', 'completed_product_failure'].includes(document.outcome)
    || (signatureAware && canonicalJson(normalizedProductFailureSignature(
      document.productFailureSignature, document.outcome, 'STORE_CORRUPT')) !== canonicalJson(document.productFailureSignature))
    || (document.reason !== null && (typeof document.reason !== 'string' || !document.reason || document.reason.length > 256))) {
    fail('STORE_CORRUPT', 'Attempt evidence upload intent metadata is invalid.');
  }
  canonicalTimestamp(document.createdAt, 'attempt evidence upload intent createdAt');
  normalizedRiskSourceObservationSet(document.riskSourceObservationSet, {
    runId,
    workItemId: document.workItemId,
    subjectCoreDigest: document.subjectCoreDigest,
    attempt: document.attempt,
    workerId: document.workerId,
  });
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
    || Object.keys(result).some((key) => !['outcome', 'reason', 'artifacts', 'executionDescriptorDigest', 'riskSourceObservationSet', 'productFailureSignature'].includes(key))
    || !['completed_pass', 'completed_product_failure'].includes(result.outcome)
    || !Array.isArray(result.artifacts) || result.artifacts.length > MAX_ATTEMPT_ARTIFACTS) {
    fail('STORE_SCHEMA_INVALID', 'Attempt evidence upload intent has an invalid result schema.');
  }
  const expectedDescriptorDigest = lease.executionDescriptorDigest ?? null;
  if ((result.executionDescriptorDigest ?? null) !== expectedDescriptorDigest) {
    fail('WORK_DESCRIPTOR_BINDING_MISMATCH', 'Attempt evidence upload intent does not match the compiler-issued execution descriptor.');
  }
  const evidenceBindingDigest = lease.executionDescriptorDigest ?? lease.subjectCoreDigest ?? state.subjectCoreDigest;
  const productFailureSignature = normalizedProductFailureSignature(result.productFailureSignature, result.outcome);
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
    diagnosticExecutionId: lease.diagnosticExecutionId ?? null,
    subjectCoreDigest: lease.subjectCoreDigest ?? state.subjectCoreDigest,
    runnerRevision: lease.runnerRevision ?? state.runnerRevision,
    executionDescriptorDigest: expectedDescriptorDigest,
    outcome: result.outcome,
    productFailureSignature,
    reason: schedulingString(result.reason ?? null, 'Attempt evidence reason', { nullable: true, maximum: 256 }),
    riskSourceObservationSet: normalizedRiskSourceObservationSet(result.riskSourceObservationSet, {
      runId,
      workItemId: lease.workItemId,
      subjectCoreDigest: lease.subjectCoreDigest ?? state.subjectCoreDigest,
      attempt: lease.attempt,
      workerId: lease.workerId,
    }),
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
    ...(intent.diagnosticExecutionId === null ? {} : { diagnosticExecutionId: intent.diagnosticExecutionId }),
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
      ...(intent.diagnosticExecutionId === null ? {} : { diagnosticExecutionId: intent.diagnosticExecutionId }),
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
  const attemptLineage = intent.diagnosticExecutionId === null ? item?.attempts
    : item?.diagnosticExecutions?.find(({ diagnosticExecutionId }) => diagnosticExecutionId === intent.diagnosticExecutionId)?.attempts;
  const alreadyAdopted = attemptLineage?.find((attempt) => attempt.attempt === intent.attempt
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
      ...(intent.diagnosticExecutionId === null ? {} : { diagnosticExecutionId: intent.diagnosticExecutionId }),
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
    diagnosticExecutionId: intent.diagnosticExecutionId,
    subjectCoreDigest: intent.subjectCoreDigest,
    runnerRevision: intent.runnerRevision,
    executionDescriptorDigest: intent.executionDescriptorDigest,
    uploadIntentDigest: intent.digest,
    outcome: intent.outcome,
    ...('productFailureSignature' in intent ? { productFailureSignature: intent.productFailureSignature } : {}),
    reason: intent.reason,
    riskSourceObservationSet: intent.riskSourceObservationSet,
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
    diagnosticExecutionId: lease.diagnosticExecutionId ?? null,
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
  await validateCoordinator(store, coordinator, runId);
  const file = containedPath(runDirectory(store, runId), inbox.relativePath);
  const document = await readBoundedJson(store.storage, file, { label: 'attempt evidence inbox' });
  const { digest, ...body } = document;
  const inboxKeys = [
    'schemaVersion', 'kind', 'runId', 'workItemId', 'workerId', 'attempt', 'coordinatorEpoch',
    'leaseToken', 'diagnosticExecutionId', 'subjectCoreDigest', 'runnerRevision', 'executionDescriptorDigest', 'outcome', 'reason', 'riskSourceObservationSet', 'evidenceDigests', 'artifacts', 'publishedAt', 'digest',
  ];
  const signatureAware = 'productFailureSignature' in document;
  const streamedUpload = 'uploadIntentDigest' in document;
  exactKeys(document, [
    ...inboxKeys,
    ...(signatureAware ? ['productFailureSignature'] : []),
    ...(streamedUpload ? ['uploadIntentDigest'] : []),
  ], 'attempt evidence inbox');
  canonicalTimestamp(document.publishedAt, 'attempt evidence publishedAt');
  if (document.schemaVersion !== 1 || document.kind !== 'attempt-evidence-inbox' || document.runId !== runId
    || document.workItemId !== inbox.workItemId || document.attempt !== inbox.attempt
    || document.leaseToken !== inbox.leaseToken || !SAFE_ID.test(document.workItemId) || !SAFE_ID.test(document.workerId)
    || !Number.isSafeInteger(document.attempt) || document.attempt < 1
    || !Number.isSafeInteger(document.coordinatorEpoch) || document.coordinatorEpoch < 1
    || (document.diagnosticExecutionId !== null && !/^[a-f0-9]{64}$/u.test(document.diagnosticExecutionId))
    || !WORK_OUTCOMES.has(document.outcome) || !Array.isArray(document.evidenceDigests) || !Array.isArray(document.artifacts)
    || (document.reason !== null && (typeof document.reason !== 'string' || !document.reason || document.reason.length > 256))
    || document.evidenceDigests.length > MAX_ATTEMPT_ARTIFACTS || document.artifacts.length !== document.evidenceDigests.length
    || document.evidenceDigests.some((entry) => !DIGEST_PATTERN.test(entry))
    || (signatureAware && canonicalJson(normalizedProductFailureSignature(
      document.productFailureSignature, document.outcome, 'STORE_CORRUPT')) !== canonicalJson(document.productFailureSignature))
    || (streamedUpload && !DIGEST_PATTERN.test(document.uploadIntentDigest))
    || digest !== canonicalDigest(body) || digest !== inbox.digest) fail('STORE_CORRUPT', 'Attempt evidence inbox is corrupt.');
  if (document.subjectCoreDigest !== state.subjectCoreDigest || document.runnerRevision !== state.runnerRevision) {
    fail('WORK_RESULT_BINDING_MISMATCH', 'Attempt evidence does not match the run subject or runner revision.');
  }
  const riskSourceObservationSet = normalizedRiskSourceObservationSet(document.riskSourceObservationSet, {
    runId,
    workItemId: document.workItemId,
    subjectCoreDigest: document.subjectCoreDigest,
    attempt: document.attempt,
    workerId: document.workerId,
  });
  const expectedDescriptorDigest = state.workItems[document.workItemId]?.executionDescriptor?.digest ?? null;
  if (document.executionDescriptorDigest !== expectedDescriptorDigest) {
    fail('WORK_DESCRIPTOR_BINDING_MISMATCH', 'Attempt evidence does not match the compiler-issued execution descriptor.');
  }
  const existingItem = state.workItems[document.workItemId];
  const existingLineage = document.diagnosticExecutionId === null ? existingItem?.attempts
    : existingItem?.diagnosticExecutions?.find(({ diagnosticExecutionId }) => diagnosticExecutionId === document.diagnosticExecutionId)?.attempts;
  const existingAttempt = existingLineage?.find((attempt) => attempt.attempt === document.attempt
    && attempt.workerId === document.workerId && attempt.inboxDigest === digest
    && (!streamedUpload || (attempt.leaseToken === document.leaseToken
      && attempt.uploadIntentDigest === document.uploadIntentDigest)));
  if (existingAttempt) {
    if (document.diagnosticExecutionId === null) return clone(existingItem);
    const diagnostic = existingItem.diagnosticExecutions.find(
      ({ diagnosticExecutionId }) => diagnosticExecutionId === document.diagnosticExecutionId);
    return clone({ ...diagnostic, id: existingItem.id });
  }
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
    const target = validateWorkLease(next, {
      runId,
      workItemId: document.workItemId,
      workerId: document.workerId,
      attempt: document.attempt,
      epoch: document.coordinatorEpoch,
      token: document.leaseToken,
      ...(document.diagnosticExecutionId === null ? {} : { diagnosticExecutionId: document.diagnosticExecutionId }),
    });
    const canonicalResult = sealWorkItemResult({
      schemaVersion: 1,
      workItemId: document.workItemId,
      subjectCoreDigest: next.subjectCoreDigest,
      attempt: document.attempt,
      authoritative: document.diagnosticExecutionId === null
        && !next.executionManifest?.contextWorkItemIds.includes(document.workItemId),
      outcome: document.outcome,
      evidenceDigests: document.evidenceDigests,
      ...(signatureAware ? { productFailureSignature: document.productFailureSignature } : {}),
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
      ...(signatureAware ? { productFailureSignature: document.productFailureSignature } : {}),
      inboxDigest: digest,
      ...(streamedUpload ? { uploadIntentDigest: document.uploadIntentDigest } : {}),
      canonicalResultDigest: canonicalResult.digest,
      riskSourceObservationSet,
    };
    target.attempts.push(attempt);
    target.lease = null;
    if (document.diagnosticExecutionId !== null) {
      if (document.outcome === 'completed_pass' || document.outcome === 'completed_product_failure') {
        target.state = document.outcome;
        target.result = canonicalResult;
      } else if (document.outcome === 'operational_failure' && target.attempts.length < target.maxAttempts) {
        target.state = 'queued';
      } else {
        target.state = 'incomplete';
      }
    } else if (document.outcome === 'completed_pass' || document.outcome === 'completed_product_failure') {
      target.state = document.outcome;
      target.canonicalResult = canonicalResult;
      target.canonicalRiskSourceObservationSet = riskSourceObservationSet;
    } else if (document.outcome === 'operational_failure' && target.attempts.length < target.maxAttempts) {
      target.state = 'queued';
    } else {
      target.state = document.outcome === 'cancelled' ? 'cancelled' : 'incomplete';
    }
    const item = next.workItems[document.workItemId];
    if (item.resourceClass === 'performance') {
      next.resourceScheduling.exclusiveLease = null;
      if (target.state !== 'queued') next.resourceScheduling.performanceDrain = null;
    }
    adopted = document.diagnosticExecutionId === null ? clone(item) : clone({ ...target, id: item.id });
  }, { data: { workItemId: document.workItemId, diagnosticExecutionId: document.diagnosticExecutionId, digest } });
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
  const descriptor = await resolveAdoptedAttemptArtifact(store, runId, input);
  const maximumBytes = input?.maximumBytes ?? MAX_ATTEMPT_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2 || maximumBytes > MAX_ATTEMPT_ARTIFACT_BYTES) {
    fail('STORE_SCHEMA_INVALID', 'Adopted artifact JSON byte bound is invalid.');
  }
  const bytes = await readBoundedFile(store.storage, descriptor.absolutePath, {
    label: `adopted artifact ${descriptor.name}`, maximumBytes,
  });
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (bytes.length !== descriptor.sizeBytes || digest !== descriptor.digest) {
    fail('ARTIFACT_DIGEST_MISMATCH', `Adopted artifact ${descriptor.name} no longer matches its immutable record.`);
  }
  try { return JSON.parse(bytes.toString('utf8')); } catch {
    fail('STORE_CORRUPT', `Adopted artifact ${descriptor.name} is not valid JSON.`);
  }
}

export async function listAdoptedAttemptArtifacts(store, runId, { offset = 0, limit = 100 } = {}) {
  safeId(runId, 'runId');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    fail('STORE_SCHEMA_INVALID', 'Adopted artifact page bounds are invalid.');
  }
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  if (state.authorityTombstone !== null) fail('RELEASE_AUTHORITY_TOMBSTONED', 'Tombstoned run evidence is unavailable.');
  const descriptors = [];
  let visibleCount = 0;
  let hasMore = false;
  const items = [
    ...(state.compilationBarrier ? [state.compilationBarrier] : []),
    ...Object.values(state.workItems),
  ].sort((left, right) => left.id.localeCompare(right.id));
  for (const item of items) {
    for (const lineage of terminalArtifactLineages(item)) {
      const { attempt } = lineage;
      for (let ordinal = 0; ordinal < attempt.artifacts.length; ordinal += 1) {
        const value = attempt.artifacts[ordinal];
        const artifact = validateArtifactRecord(value, {
          runId, workItemId: item.id, attempt: attempt.attempt, leaseToken: attempt.leaseToken,
        });
        if (isRawAttemptLogArtifact(artifact.name)) continue;
        if (visibleCount >= offset && descriptors.length < limit) {
          descriptors.push(publicArtifactDescriptor(runId, item, lineage, artifact, ordinal + 1));
        } else if (visibleCount >= offset + limit) {
          hasMore = true;
          break;
        }
        visibleCount += 1;
      }
      if (hasMore) break;
    }
    if (hasMore) break;
  }
  const knownTotal = hasMore ? offset + descriptors.length + 1 : visibleCount;
  return Object.freeze({
    runId,
    files: descriptors,
    total: knownTotal,
    knownTotal,
    totalComplete: !hasMore,
    offset,
    limit,
    nextOffset: offset + descriptors.length,
    hasMore,
  });
}

function isRawAttemptLogArtifact(name) {
  const segments = String(name).replaceAll('\\', '/').split('/').filter(Boolean).map((segment) => segment.toLowerCase());
  return segments.includes('logs') || segments.some((segment) => segment.endsWith('.log'));
}

export async function openAdoptedAttemptArtifact(store, runId, input) {
  const transferLease = await acquireArtifactReadLease(store, runId);
  let opened;
  try {
    const descriptor = await resolveAdoptedAttemptArtifact(store, runId, input);
    opened = await openContainedArtifactFile(store.storage.fs, runDirectory(store, runId), descriptor.relativePath, {
      requireDescriptorContainment: process.platform === 'linux',
    });
    const { handle, stat } = opened;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== descriptor.sizeBytes) {
      fail('ARTIFACT_DIGEST_MISMATCH', `Adopted artifact ${descriptor.name} no longer matches its immutable record.`);
    }
    const integrityFingerprint = await verifyOpenedArtifactIntegrity(store, handle, stat, descriptor, transferLease);
    return {
      descriptor: publicArtifactDescriptor(runId, descriptor.item, descriptor.lineage, descriptor, descriptor.ordinal),
      opened: {
        handle,
        stat,
        path: opened.path,
        relativePath: descriptor.name,
        transferLease,
        integrityFingerprint,
      },
    };
  } catch (error) {
    await opened?.handle?.close().catch(() => undefined);
    await transferLease.release().catch(() => undefined);
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'UNSAFE_ARTIFACT_PATH'].includes(error?.code)) {
      fail('ATTEMPT_ARTIFACT_UNAVAILABLE', 'Adopted artifact bytes are unavailable.');
    }
    throw error;
  }
}

async function acquireArtifactReadLease(store, runId) {
  safeId(runId, 'runId');
  return withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId, { repairCache: false });
    if (state.authorityTombstone !== null) fail('RELEASE_AUTHORITY_TOMBSTONED', 'Tombstoned run evidence is unavailable.');
    const token = safeId(`reader-${store.storage.nonce()}`, 'artifact read lease token');
    const file = path.join(artifactReadLeaseDirectory(store, runId), `${token}.json`);
    const write = (expiresAt) => atomicWriteJson(store.storage, file, {
      schemaVersion: 1,
      kind: 'artifact-read-lease',
      runId,
      token,
      expiresAt,
    });
    await write(new Date(store.clock() + ARTIFACT_READ_LEASE_MS).toISOString());
    let released = false;
    let maintenance = Promise.resolve();
    return Object.freeze({
      token,
      renew() {
        const operation = async () => {
          if (released) fail('ARTIFACT_READ_LEASE_EXPIRED', 'Artifact read lease was already released.');
          const current = await recoverUnlocked(store, runId, { repairCache: false });
          if (current.authorityTombstone !== null) fail('RELEASE_AUTHORITY_TOMBSTONED', 'Tombstoned run evidence is unavailable.');
          await write(new Date(store.clock() + ARTIFACT_READ_LEASE_MS).toISOString());
        };
        maintenance = maintenance.then(operation, operation);
        return maintenance;
      },
      release() {
        if (released) return maintenance.catch(() => undefined);
        released = true;
        const operation = () => store.storage.fs.rm(file, { force: true });
        maintenance = maintenance.then(operation, operation);
        return maintenance;
      },
    });
  });
}

async function activeArtifactReadLeases(store, runId) {
  const directory = artifactReadLeaseDirectory(store, runId);
  const names = await store.storage.fs.readdir(directory).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  let active = 0;
  for (const name of names) {
    if (name.startsWith('.') && name.endsWith('.tmp')) {
      await store.storage.fs.rm(path.join(directory, name), { force: true });
      continue;
    }
    if (!/^reader-[A-Za-z0-9._-]+\.json$/u.test(name)) {
      active += 1;
      continue;
    }
    const file = path.join(directory, name);
    try {
      const lease = await readBoundedJson(store.storage, file, { label: 'artifact read lease', maximumBytes: 4_096 });
      if (lease.schemaVersion !== 1 || lease.kind !== 'artifact-read-lease' || lease.runId !== runId
        || `${lease.token}.json` !== name || !SAFE_ID.test(lease.token)
        || !Number.isFinite(Date.parse(lease.expiresAt))) {
        active += 1;
      } else if (Date.parse(lease.expiresAt) <= store.clock()) {
        await store.storage.fs.rm(file, { force: true });
      } else {
        active += 1;
      }
    } catch {
      active += 1;
    }
  }
  return active;
}

async function resolveAdoptedAttemptArtifact(store, runId, input) {
  safeId(runId, 'runId');
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  if (state.authorityTombstone !== null) fail('RELEASE_AUTHORITY_TOMBSTONED', 'Tombstoned run evidence is unavailable.');
  const workItemId = safeId(input?.workItemId, 'workItemId');
  const requestedName = input?.name === undefined ? null : artifactName(input.name);
  const artifactKey = input?.artifactKey === undefined ? null : input.artifactKey;
  if ((requestedName === null) === (artifactKey === null)
    || (artifactKey !== null && !DIGEST_PATTERN.test(artifactKey))) {
    fail('STORE_SCHEMA_INVALID', 'Adopted artifact lookup requires exactly one valid name or artifact key.');
  }
  const item = state.workItems[workItemId]
    ?? (state.compilationBarrier?.id === workItemId ? state.compilationBarrier : null);
  const lineages = terminalArtifactLineages(item);
  const requestedDiagnosticExecutionId = input?.diagnosticExecutionId === undefined
    ? null
    : input.diagnosticExecutionId;
  if (requestedDiagnosticExecutionId !== null && !/^[a-f0-9]{64}$/u.test(requestedDiagnosticExecutionId)) {
    fail('STORE_SCHEMA_INVALID', 'Diagnostic artifact lookup has an invalid diagnostic execution identity.');
  }
  const eligibleLineages = requestedName !== null
    ? lineages.filter(({ diagnosticExecutionId }) => diagnosticExecutionId === requestedDiagnosticExecutionId)
    : lineages;
  if (!item || eligibleLineages.length === 0) {
    fail('ATTEMPT_ARTIFACT_UNAVAILABLE', `Work item ${workItemId} has no adopted terminal artifact.`);
  }
  let artifact = null;
  let ordinal = null;
  let matchedLineage = null;
  for (const lineage of eligibleLineages) {
    const { attempt } = lineage;
    for (let index = 0; index < attempt.artifacts.length; index += 1) {
      const candidate = validateArtifactRecord(attempt.artifacts[index], {
        runId, workItemId, attempt: attempt.attempt, leaseToken: attempt.leaseToken,
      });
      if ((requestedName !== null && candidate.name === requestedName)
        || (artifactKey !== null && artifactAccessKey(item, lineage, candidate, index + 1) === artifactKey)) {
        artifact = candidate;
        ordinal = index + 1;
        matchedLineage = lineage;
        break;
      }
    }
    if (artifact) break;
  }
  if (!artifact) fail('ATTEMPT_ARTIFACT_UNAVAILABLE', `Work item ${workItemId} did not adopt the requested artifact.`);
  if (isRawAttemptLogArtifact(artifact.name)) {
    fail('ATTEMPT_ARTIFACT_UNAVAILABLE', 'Raw attempt logs are unavailable through the canonical artifact API.');
  }
  return {
    ...artifact,
    runId,
    workItemId,
    attemptNumber: matchedLineage.attempt.attempt,
    completedAt: matchedLineage.attempt.completedAt,
    absolutePath: containedPath(runDirectory(store, runId), ...artifact.relativePath.split('/')),
    item,
    attempt: matchedLineage.attempt,
    lineage: matchedLineage,
    ordinal,
  };
}

function canonicalTerminalAttempt(item) {
  if (!item || !['completed_pass', 'completed_product_failure'].includes(item.state)
    || !item.canonicalResult?.digest || !Array.isArray(item.attempts)) return null;
  for (let index = item.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = item.attempts[index];
    const canonicalMatch = attempt.canonicalResultDigest === item.canonicalResult.digest
      || (attempt.canonicalResultDigest === undefined
        && canonicalJson(attempt.evidenceDigests) === canonicalJson(item.canonicalResult.evidenceDigests));
    if (attempt.outcome !== item.state || !canonicalMatch) continue;
    const directory = attempt.artifacts?.[0]?.relativePath?.split('/')[2] ?? '';
    const derivedLeaseToken = directory.replace(/^\d{6}-/u, '');
    const leaseToken = typeof attempt.leaseToken === 'string' ? attempt.leaseToken : derivedLeaseToken;
    if (SAFE_ID.test(leaseToken)) return { ...attempt, leaseToken };
  }
  return null;
}

function terminalArtifactLineages(item) {
  if (!item) return [];
  const lineages = [];
  const canonical = canonicalTerminalAttempt(item);
  if (canonical) {
    lineages.push({
      attempt: canonical,
      authoritative: true,
      diagnosticExecutionId: null,
      resultDigest: item.canonicalResult.digest,
    });
  }
  for (const diagnostic of item.diagnosticExecutions ?? []) {
    if (!['completed_pass', 'completed_product_failure'].includes(diagnostic.state)
      || diagnostic.result?.authoritative !== false || !DIGEST_PATTERN.test(diagnostic.result?.digest ?? '')) continue;
    for (let index = diagnostic.attempts.length - 1; index >= 0; index -= 1) {
      const attempt = diagnostic.attempts[index];
      if (attempt.outcome !== diagnostic.state || attempt.canonicalResultDigest !== diagnostic.result.digest) continue;
      const directory = attempt.artifacts?.[0]?.relativePath?.split('/')[2] ?? '';
      const derivedLeaseToken = directory.replace(/^\d{6}-/u, '');
      const leaseToken = typeof attempt.leaseToken === 'string' ? attempt.leaseToken : derivedLeaseToken;
      if (!SAFE_ID.test(leaseToken)) continue;
      lineages.push({
        attempt: { ...attempt, leaseToken },
        authoritative: false,
        diagnosticExecutionId: diagnostic.diagnosticExecutionId,
        resultDigest: diagnostic.result.digest,
      });
      break;
    }
  }
  return lineages;
}

function publicArtifactDescriptor(runId, item, lineage, artifact, ordinal) {
  const { attempt } = lineage;
  return Object.freeze({
    runId,
    workItemId: item.id,
    attempt: attempt.attempt,
    authoritative: lineage.authoritative,
    diagnosticExecutionId: lineage.diagnosticExecutionId,
    completedAt: attempt.completedAt,
    name: artifact.name,
    logicalName: artifact.logicalName,
    purpose: artifact.purpose,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    digest: artifact.digest,
    memberDigest: artifact.memberDigest,
    artifactKey: artifactAccessKey(item, lineage, artifact, ordinal),
  });
}

function artifactAccessKey(item, lineage, artifact, ordinal) {
  const { attempt } = lineage;
  return canonicalDigest({
    schemaVersion: 1,
    kind: lineage.authoritative ? 'adopted-artifact-access-key' : 'diagnostic-artifact-access-key',
    workItemId: item.id,
    ...(lineage.authoritative
      ? { canonicalResultDigest: lineage.resultDigest }
      : { diagnosticExecutionId: lineage.diagnosticExecutionId, diagnosticResultDigest: lineage.resultDigest }),
    attempt: attempt.attempt,
    ordinal,
    name: artifact.name,
    contentDigest: artifact.digest,
    memberDigest: artifact.memberDigest,
  });
}

async function verifyOpenedArtifactIntegrity(store, handle, initialStat, descriptor, transferLease) {
  const fingerprint = [
    initialStat.dev, initialStat.ino, initialStat.size, initialStat.mtimeMs, initialStat.ctimeMs,
  ].join(':');
  const integrityCache = ARTIFACT_INTEGRITY_CACHES.get(store);
  if (!integrityCache) fail('STORE_CORRUPT', 'Parent-run artifact integrity cache is unavailable.');
  const cached = integrityCache.get(descriptor.digest);
  if (cached === fingerprint) return fingerprint;
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(64 * 1_024);
  let sizeBytes = 0;
  let renewedAt = Date.now();
  while (true) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, sizeBytes);
    if (bytesRead === 0) break;
    sizeBytes += bytesRead;
    if (sizeBytes > descriptor.sizeBytes) break;
    hash.update(chunk.subarray(0, bytesRead));
    if (Date.now() - renewedAt >= Math.floor(ARTIFACT_READ_LEASE_MS / 3)) {
      await transferLease.renew();
      renewedAt = Date.now();
    }
  }
  const finalStat = await handle.stat();
  const finalFingerprint = [
    finalStat.dev, finalStat.ino, finalStat.size, finalStat.mtimeMs, finalStat.ctimeMs,
  ].join(':');
  const digest = `sha256:${hash.digest('hex')}`;
  if (fingerprint !== finalFingerprint || sizeBytes !== descriptor.sizeBytes || digest !== descriptor.digest) {
    fail('ARTIFACT_DIGEST_MISMATCH', `Adopted artifact ${descriptor.name} no longer matches its immutable record.`);
  }
  integrityCache.delete(descriptor.digest);
  integrityCache.set(descriptor.digest, fingerprint);
  while (integrityCache.size > 1_024) {
    integrityCache.delete(integrityCache.keys().next().value);
  }
  return fingerprint;
}

export async function cancelParentRun(store, runId, coordinator, input) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator, runId);
    if (state.status === 'cancelled') {
      delete state.clockNow;
      return state;
    }
    const cancelled = await appendMutationUnlocked(store, state, 'mutation', 'parent-run-cancelled', (next) => {
      next.status = 'cancelled';
      for (const item of Object.values(next.workItems)) {
        if (next.compilationState === 'failed' && item.id === next.compilationFailure?.workItemId
          && item.state === 'incomplete') continue;
        if (!['completed_pass', 'completed_product_failure'].includes(item.state)) {
          item.state = 'cancelled';
          item.lease = null;
        }
        for (const diagnostic of item.diagnosticExecutions) {
          if (['queued', 'running'].includes(diagnostic.state)) {
            diagnostic.state = 'cancelled';
            diagnostic.lease = null;
          }
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
    const selector = await readAuthoritySelectorUnlocked(store);
    await requireHandoffRunPermit(store, selector, runId);
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
    const operationSubjectDigest = request.kind === 'rekick' && state.compilationState === 'failed'
      ? state.subjectCoreDigest
      : state.finalSubjectDigest;
    if (request.expectedSubjectDigest !== undefined && request.expectedSubjectDigest !== operationSubjectDigest) {
      fail('RELEASE_SUBJECT_MISMATCH', 'Operation does not match the immutable release subject for its current compilation stage.');
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
      appliedAt: null,
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

export async function listPendingOperations(store, runId, { limit = 32 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) fail('STORE_SCHEMA_INVALID', 'Operation list limit is invalid.');
  const state = await recoverUnlocked(store, runId);
  return Object.values(state.operations).filter(({ state: operationState }) => ['accepted', 'applied'].includes(operationState)).slice(0, limit).map(clone);
}

function applyIncompleteWorkRekick(next, input) {
  const ids = [...new Set(input?.workItemIds ?? [])];
  if (ids.length < 1 || ids.length > 64 || ids.some((id) => !SAFE_ID.test(id))) fail('STORE_SCHEMA_INVALID', 'Rekick requires 1 through 64 valid work-item IDs.');
  if (!input?.actor || typeof input.actor.id !== 'string' || !input.actor.id
    || !['human', 'service'].includes(input.actor.kind)) {
    fail('STORE_SCHEMA_INVALID', 'Rekick requires an immutable authorized human or service actor.');
  }
  const resumesInventoryCompilation = next.compilationState === 'failed';
  if (resumesInventoryCompilation && (ids.length !== 1 || ids[0] !== next.compilationFailure?.workItemId)) {
    fail('REKICK_NOT_INCOMPLETE', 'Failed inventory compilation can only rekick its exact exhausted barrier.');
  }
  if (next.compilationState === 'pending'
    && ids.some((id) => next.workItems[id]?.capability === 'inventory:http')) {
    fail('REKICK_NOT_INCOMPLETE', 'Inventory compilation must terminalize before it can be rekicked.');
  }
  for (const id of ids) {
    const item = next.workItems[id];
    if (!item || item.state !== 'incomplete' || item.canonicalResult !== null || item.manualRekicks >= 3) {
      fail('REKICK_NOT_INCOMPLETE', `Work item ${id} is not eligible for incomplete-work rekick.`);
    }
    item.state = 'queued';
    item.lease = null;
    item.manualRekicks += 1;
  }
  if (resumesInventoryCompilation) next.compilationState = 'pending';
  return ids;
}

export async function rekickIncompleteWork(store, runId, coordinator, input) {
  const ids = [...new Set(input?.workItemIds ?? [])];
  return mutate(store, runId, { coordinator, kind: 'mutation', type: 'incomplete-work-rekicked', actor: input.actor, data: { workItemIds: ids } }, (next) => {
    applyIncompleteWorkRekick(next, input);
  });
}

function classifyTargetIdentityRecheck(state, input) {
  const observed = input?.observedDeploymentIdentity;
  const validObserved = observed && typeof observed === 'object' && !Array.isArray(observed)
    && typeof observed.kind === 'string' && observed.kind && typeof observed.value === 'string' && observed.value
    ? { kind: observed.kind, value: observed.value }
    : null;
  return {
    observed: validObserved,
    status: validObserved === null ? 'unverified'
      : canonicalJson(validObserved) === canonicalJson(state.subjectCore.deploymentIdentity) ? 'matched' : 'mismatch',
  };
}

export async function applyRekickOperation(store, runId, coordinator, operationId, input = {}) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator, runId);
    const operation = Object.values(state.operations).find((candidate) => candidate.operationId === operationId);
    if (!operation) fail('OPERATION_NOT_FOUND', `Operation ${operationId} was not found.`);
    if (operation.kind !== 'rekick') fail('OPERATION_KIND_INVALID', 'Only a rekick operation can use the atomic rekick transition.');
    if (operation.state !== 'accepted') return clone(operation);
    const operationSubjectDigest = state.compilationState === 'failed'
      ? state.subjectCoreDigest : state.finalSubjectDigest;
    if (operation.body?.expectedSubjectDigest !== operationSubjectDigest) {
      fail('RELEASE_SUBJECT_MISMATCH', 'A changed deployment, configuration, or scope requires a new authoritative run.');
    }
    const identity = classifyTargetIdentityRecheck(state, input);
    if (identity.status === 'mismatch') {
      fail('REKICK_TARGET_IDENTITY_MISMATCH', 'Target deployment identity changed; a new authoritative run is required.');
    }
    if (identity.status === 'unverified') {
      fail('REKICK_TARGET_IDENTITY_UNVERIFIED', 'Target deployment identity could not be re-proved; rekick remains rejected.');
    }
    let applied;
    await appendMutationUnlocked(store, state, 'operation', 'incomplete-work-rekick-applied', (next) => {
      applyIncompleteWorkRekick(next, { actor: operation.actor, workItemIds: operation.body?.workItemIds });
      const mutable = Object.values(next.operations).find((candidate) => candidate.operationId === operationId);
      mutable.state = 'applied';
      mutable.appliedAt = timestamp(store);
      applied = mutable;
    }, { actor: operation.actor, data: {
      operationId, workItemIds: operation.body?.workItemIds, identityStatus: identity.status,
    } });
    return clone(applied);
  }));
}

export async function applyDiagnosticRerunOperation(store, runId, coordinator, operationId, input = {}) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator, runId);
    const operation = Object.values(state.operations).find((candidate) => candidate.operationId === operationId);
    if (!operation) fail('OPERATION_NOT_FOUND', `Operation ${operationId} was not found.`);
    if (operation.kind !== 'diagnostic-rerun') {
      fail('OPERATION_KIND_INVALID', 'Only a diagnostic-rerun operation can create diagnostic execution lineage.');
    }
    if (operation.state !== 'accepted') return clone(operation);
    const workItemId = operation.body?.workItemId;
    const item = state.workItems[workItemId];
    if (operation.body?.expectedSubjectDigest !== state.finalSubjectDigest) {
      fail('RELEASE_SUBJECT_MISMATCH', 'A changed deployment, configuration, or scope requires a new authoritative run.');
    }
    if (state.status !== 'active' || state.compilationState !== 'sealed'
      || !item || item.state !== 'completed_product_failure'
      || item.canonicalResult?.outcome !== 'completed_product_failure'
      || item.lease !== null || item.executionDescriptor === null) {
      fail('DIAGNOSTIC_RERUN_NOT_FAILED', 'Diagnostic rerun requires one terminal compiler-issued product-failed work item.');
    }
    if (item.diagnosticExecutions.length >= 8
      || item.diagnosticExecutions.some(({ state: diagnosticState }) => ['queued', 'running'].includes(diagnosticState))) {
      fail('DIAGNOSTIC_RERUN_LIMIT', 'Diagnostic rerun is already active or its durable lineage bound was reached.');
    }
    const identity = classifyTargetIdentityRecheck(state, input);
    const validObserved = identity.observed;
    const identityStatus = identity.status;
    const terminationReason = identityStatus === 'matched' ? null
      : identityStatus === 'mismatch' ? 'target_identity_mismatch' : 'target_identity_unverified';
    let applied;
    await appendMutationUnlocked(store, state, 'operation', 'diagnostic-rerun-applied', (next) => {
      const mutableItem = next.workItems[workItemId];
      mutableItem.diagnosticExecutions.push({
        diagnosticExecutionId: operation.operationId,
        workItemId,
        subjectCoreDigest: next.subjectCoreDigest,
        finalSubjectDigest: next.finalSubjectDigest,
        executionDescriptorDigest: mutableItem.executionDescriptor.digest,
        requestedAt: timestamp(store),
        actor: operation.actor,
        authoritative: false,
        state: identityStatus === 'matched' ? 'queued' : 'incomplete',
        maxAttempts: mutableItem.maxAttempts,
        lease: null,
        attempts: [],
        result: null,
        terminationReason,
        identityRecheck: {
          status: identityStatus,
          expected: next.subjectCore.deploymentIdentity,
          observed: validObserved,
          checkedAt: timestamp(store),
          reason: terminationReason,
          ...(identityStatus === 'unverified' && input?.failureReason
            ? { detail: String(input.failureReason).slice(0, 512) } : {}),
        },
      });
      const mutable = Object.values(next.operations).find((candidate) => candidate.operationId === operationId);
      mutable.state = 'applied';
      mutable.appliedAt = timestamp(store);
      applied = mutable;
    }, { actor: operation.actor, data: { operationId, workItemId, identityStatus, terminationReason } });
    return clone(applied);
  }));
}

export async function completeOperation(store, runId, coordinator, operationId, outcome) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator, runId);
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
    await validateCoordinator(store, coordinator, runId);
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
  const tombstone = await withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    if (state.authorityTombstone === null) fail('PURGE_REQUIRES_TOMBSTONE', 'Evidence cannot be purged before release authority is tombstoned.');
    return clone(state.authorityTombstone);
  }));

  // The authority tombstone prevents new read leases. Drain existing readers
  // without holding the coordinator-wide mutation lock so unrelated runs keep
  // claiming, heartbeating, and adopting work normally.
  const deadline = Date.now() + ARTIFACT_PURGE_DRAIN_MS;
  while (await activeArtifactReadLeases(store, runId) > 0) {
    if (Date.now() >= deadline) fail('ARTIFACT_READERS_ACTIVE', 'Evidence purge could not drain active artifact readers within its bound.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    if (state.authorityTombstone === null || state.authorityTombstone.tombstonedAt !== tombstone.tombstonedAt) {
      fail('STORE_CORRUPT', 'Evidence purge authority changed while artifact readers drained.');
    }
    if (await activeArtifactReadLeases(store, runId) > 0) {
      fail('ARTIFACT_READERS_ACTIVE', 'An artifact reader remained active at the purge commit boundary.');
    }
    const directory = runDirectory(store, runId);
    for (const relative of ['evidence', 'inboxes']) {
      const target = containedPath(directory, relative);
      await store.storage.fs.rm(target, { recursive: true, force: true });
    }
    await store.storage.fs.mkdir(path.join(directory, 'inboxes'), { recursive: true, mode: 0o2770 });
    await store.storage.fs.rm(artifactReadLeaseDirectory(store, runId), { recursive: true, force: true });
    return clone(tombstone);
  }));
}

export async function readRunHistories(store, runId) {
  return (await recoverWithHistoriesUnlocked(store, runId)).histories;
}

async function readBoundedAttemptLogsUnlocked(store, runId, state, { limit = 200 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) fail('STORE_SCHEMA_INVALID', 'Attempt log limit is invalid.');
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

export async function readBoundedAttemptLogs(store, runId, { limit = 200 } = {}) {
  const state = await recoverUnlocked(store, runId, { repairCache: false });
  return readBoundedAttemptLogsUnlocked(store, runId, state, { limit });
}

export async function readParentRunWorkspaceSnapshot(store, runId, { logLimit = 200 } = {}) {
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const selector = await readAuthoritySelectorUnlocked(store);
    const { state, histories } = await recoverWithHistoriesUnlocked(store, runId, { repairCache: false });
    const publication = await readCurrentEnvelopeUnlocked(store, runId, { selector, state });
    const workerLogs = await readBoundedAttemptLogsUnlocked(store, runId, state, { limit: logLimit });
    const snapshotToken = canonicalDigest({
      schemaVersion: 1,
      kind: 'shared-workspace-snapshot',
      runId,
      stateRevision: state.runRevision,
      publicationDigest: publication.digest,
      ledgerHeads: state.ledgerHeads,
      attemptLogsDigest: canonicalDigest({
        limit: logLimit,
        truncated: workerLogs.truncated,
        entries: workerLogs.entries.map(({ digest }) => digest),
      }),
    });
    delete state.clockNow;
    return Object.freeze({
      schemaVersion: 1,
      snapshotToken,
      stateRevision: state.runRevision,
      publication,
      state,
      histories,
      workerLogs,
    });
  }));
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

function publicationHeadDocument(runId, envelopeDigest, binding) {
  const body = {
    schemaVersion: 2,
    kind: 'publication-head',
    runId,
    envelopeDigest,
    authorityBinding: binding,
  };
  return { ...body, digest: canonicalDigest(body) };
}

function validatePublicationAuthorityBinding(store, selector, value) {
  const expected = authorityBinding(store, selector);
  if (canonicalJson(value) !== canonicalJson(expected)) {
    fail('PUBLICATION_AUTHORITY_STALE', 'Publication head is bound to a stale store generation or activation epoch.');
  }
  return expected;
}

export async function publishCurrentEnvelope(store, runId, coordinator, envelopeValue, hooks = {}) {
  const envelope = parsePublicationEnvelope(envelopeValue);
  if (envelope.runId !== runId) fail('STORE_SCHEMA_INVALID', 'Publication envelope belongs to a different run.');
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    await validateCoordinator(store, coordinator, runId);
    const supersessionFence = await readCutoverCanarySupersessionFenceUnlocked(store, runId);
    if (supersessionFence !== null) {
      fail('RELEASE_AUTHORITY_SUPERSEDED',
        'Parent run release publication is fenced by an authorized cutover canary replacement.',
        supersessionFence);
    }
    const { selector, binding } = await requirePublicationAuthority(store, runId);
    if (state.compilationState === 'failed') {
      if (!state.compilationFailure || !Object.hasOwn(envelope, 'subjectCoreDigest')
        || envelope.subjectCoreDigest !== state.subjectCoreDigest || envelope.finalSubjectDigest !== null
        || envelope.decision.subjectStage !== 'core'
        || envelope.decision.compilationFailureDigest !== state.compilationFailure.digest
        || envelope.decision.executionManifestDigest !== null) {
        fail('RELEASE_SUBJECT_MISMATCH', 'Compilation-failure publication does not match the parent-run subject core.');
      }
    } else if (state.compilationState === 'sealed' && state.executionManifestDigest && state.finalSubjectDigest) {
      if (envelope.finalSubjectDigest !== state.finalSubjectDigest
        || envelope.decision.executionManifestDigest !== state.executionManifestDigest
        || (Object.hasOwn(envelope, 'subjectCoreDigest') && envelope.subjectCoreDigest !== state.subjectCoreDigest)) {
        fail('RELEASE_SUBJECT_MISMATCH', 'Publication envelope does not match the sealed parent-run subject.');
      }
    } else {
      fail('SEALED_MANIFEST_MISSING', 'Release authority is unavailable until compilation is terminal or the parent-run graph is sealed.');
    }
    // U1's publication contract names the release projections: observations
    // are canonical graph/mutation history, decisions and risks map directly.
    // Durable operation history remains independently revisioned and is not
    // folded into release evidence.
    const expectedLedgerSequences = {
      observations: state.ledgerSequences.mutation,
      decisions: state.ledgerSequences.decision + 1,
      risks: state.ledgerSequences.risk,
    };
    if (canonicalJson(envelope.ledgerSequences) !== canonicalJson(expectedLedgerSequences)) {
      fail('PUBLICATION_LEDGER_MISMATCH', 'Publication envelope does not name the exact durable ledger sequences.');
    }
    if (state.currentPublicationDigest !== null && envelope.previousEnvelopeDigest !== state.currentPublicationDigest) {
      if (state.currentPublicationDigest === envelope.digest) {
        validatePublicationAuthorityBinding(store, selector, state.currentPublicationAuthorityBinding);
        await atomicWriteJson(store.storage, path.join(runDirectory(store, runId), 'publication-head.json'),
          publicationHeadDocument(runId, envelope.digest, binding));
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
      candidate.currentPublicationAuthorityBinding = binding;
    }, { data: { envelopeDigest: envelope.digest, decisionRevision: envelope.decisionRevision, authorityBindingDigest: binding.digest } });
    await hooks.afterDecisionPersist?.(envelope);
    await atomicWriteJson(store.storage, path.join(runDirectory(store, runId), 'publication-head.json'),
      publicationHeadDocument(runId, envelope.digest, binding));
    return parsePublicationEnvelope(await readPublicationByDigest(store, runId, next.currentPublicationDigest));
  }));
}

async function readCurrentEnvelopeUnlocked(store, runId, {
  selector = null,
  state = null,
} = {}) {
  selector ??= await readAuthoritySelectorUnlocked(store);
  state ??= await recoverUnlocked(store, runId);
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
  if (head !== null) {
    const { digest, ...body } = head ?? {};
    if (head?.schemaVersion !== 2 || head.kind !== 'publication-head' || head.runId !== runId
      || !DIGEST_PATTERN.test(head.envelopeDigest) || digest !== canonicalDigest(body)) {
      fail('STORE_CORRUPT', 'Publication head is invalid.');
    }
  }
  if (state.currentPublicationAuthorityBinding === null) {
    fail('PUBLICATION_AUTHORITY_STALE', 'Publication has no durable release-authority binding.');
  }
  const binding = validatePublicationAuthorityBinding(store, selector, state.currentPublicationAuthorityBinding);
  if (head !== null && canonicalJson(head.authorityBinding) !== canonicalJson(binding)) {
    fail('STORE_CORRUPT', 'Publication head is invalid.');
  }
  if (head?.envelopeDigest !== state.currentPublicationDigest) {
    // A durable decision event is the commit record. If a process died after
    // that fsync but before the pointer rename, recovery completes only the
    // pointer swap after validating the entire immutable envelope chain.
    await readPublicationChain(store, runId, state.currentPublicationDigest);
    head = publicationHeadDocument(runId, state.currentPublicationDigest, binding);
    await atomicWriteJson(store.storage, path.join(runDirectory(store, runId), 'publication-head.json'), head);
  }
  const current = (await readPublicationChain(store, runId, head.envelopeDigest)).at(-1);
  if (current.digest !== state.currentPublicationDigest) {
    fail('STORE_CORRUPT', 'Publication head disagrees with canonical recovered state.');
  }
  return current;
}

export async function readCurrentEnvelope(store, runId) {
  return readCurrentEnvelopeUnlocked(store, runId);
}

export async function withCurrentEnvelopeFence(store, runId, callback) {
  if (typeof callback !== 'function') fail('STORE_SCHEMA_INVALID', 'Publication fence callback is required.');
  return withDirectoryLock(store.storage, globalLockPath(store), () => withDirectoryLock(store.storage, lockPath(store, runId), async () => {
    const state = await recoverUnlocked(store, runId);
    if (state.authorityTombstone !== null) fail('RELEASE_AUTHORITY_TOMBSTONED', 'Parent run release authority is tombstoned.');
    if (state.currentPublicationDigest === null) fail('PUBLICATION_UNAVAILABLE', 'Parent run has no current publication.');
    const selector = await readAuthoritySelectorUnlocked(store);
    if (selector.phase !== 'ACTIVE') {
      fail('RELEASE_AUTHORITY_INACTIVE', `Promotion consumption requires ACTIVE; current phase is ${selector.phase}.`);
    }
    validatePublicationAuthorityBinding(store, selector, state.currentPublicationAuthorityBinding);
    const current = (await readPublicationChain(store, runId, state.currentPublicationDigest)).at(-1);
    return callback(current, { selector: clone(selector), binding: authorityBinding(store, selector) });
  }));
}
