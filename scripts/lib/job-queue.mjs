import { createHash, randomBytes } from 'node:crypto';
import * as nativeFs from 'node:fs/promises';
import path from 'node:path';

export const JOB_QUEUE_SCHEMA_VERSION = 1;
export const DEFAULT_HEARTBEAT_MS = 5_000;
export const DEFAULT_LEASE_MS = 30_000;
export const DEFAULT_MAX_INFRASTRUCTURE_RETRIES = 1;
export const JOB_EXECUTION_STATES = Object.freeze([
  'queued',
  'starting',
  'running',
  'finalizing',
  'completed',
  'failed',
  'incomplete',
  'cancelled',
]);
export const WORKER_ACTIVITY_STATES = Object.freeze(['normal', 'stalled', 'recovering']);

const TERMINAL_STATES = new Set(['completed', 'failed', 'incomplete', 'cancelled']);
const ACTIVE_STATES = new Set(['starting', 'running', 'finalizing']);
const MAX_STATE_BYTES = 1_048_576;
const MAX_PUBLICATION_BYTES = 10 * 1_048_576;
const MAX_JOB_INPUT_BYTES = 16 * 1_048_576;
const MAX_EVENTS = 128;
const MAX_PUBLICATIONS = 512;
// The portal supervisor creates jobs as root while the browser workers run as
// the distinct non-root pwuser identity. Queue documents contain no secrets,
// so the dedicated shared queue group owns this collaboration boundary.
const SHARED_DIRECTORY_MODE = 0o2770;
const SHARED_FILE_MODE = 0o660;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const SAFE_STAGE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;
const SECRET_TEXT_PATTERN = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{8,})/i;
const SECRET_FIELD_PATTERN = /^(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer)$/i;
const JOB_INDEX_SCHEMA_VERSION = 1;
const JOB_INDEX_CATEGORIES = new Set(['ready', 'terminal']);
const DEFAULT_INDEX_PAGE_SIZE = 128;
const MAX_INDEX_PAGE_SIZE = 1_024;

// Linux filesystem magic values for network/distributed filesystems whose
// mkdir/rename/lease visibility is not the Docker-local-volume contract.
const UNSUPPORTED_FILESYSTEM_TYPES = new Map([
  [0x0000000000006969n, 'NFS'],
  [0x000000000000517bn, 'SMB'],
  [0x00000000ff534d42n, 'CIFS'],
  [0x0000000000c36400n, 'Ceph'],
  [0x000000005346414fn, 'AFS'],
  [0x0000000073757245n, 'Coda'],
  [0x000000000000564cn, 'NCP'],
  [0x0000000001021997n, '9P'],
  [0x000000000bd00bd0n, 'Lustre'],
  [0x0000000047504653n, 'GPFS'],
]);

export class JobQueueError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'JobQueueError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new JobQueueError(code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, keys, label) {
  if (!isRecord(value)) fail('QUEUE_SCHEMA_INVALID', `${label} must be an object.`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('QUEUE_SCHEMA_INVALID', `${label} contains unknown field ${JSON.stringify(key)}.`);
  }
  for (const key of keys) {
    if (!(key in value)) fail('QUEUE_SCHEMA_INVALID', `${label} is missing required field ${JSON.stringify(key)}.`);
  }
}

function assertString(value, label, { max = 512, pattern = null, nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length === 0 || value.length > max || (pattern && !pattern.test(value))) {
    fail('QUEUE_SCHEMA_INVALID', `${label} is invalid.`);
  }
}

function assertSafePersistedText(value, label, options = {}) {
  assertString(value, label, options);
  if (typeof value === 'string' && SECRET_TEXT_PATTERN.test(value)) {
    fail('QUEUE_SECRET_REJECTED', `${label} appears to contain credential material and cannot be persisted.`);
  }
}

function assertInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('QUEUE_SCHEMA_INVALID', `${label} must be an integer from ${min} through ${max}.`);
  }
}

function assertIsoTimestamp(value, label) {
  assertString(value, label, { max: 64 });
  try {
    if (new Date(value).toISOString() !== value) fail('QUEUE_SCHEMA_INVALID', `${label} must be a canonical ISO timestamp.`);
  } catch (error) {
    if (error instanceof JobQueueError) throw error;
    fail('QUEUE_SCHEMA_INVALID', `${label} must be a canonical ISO timestamp.`);
  }
}

function assertDigest(value, label, { nullable = false } = {}) {
  assertString(value, label, { max: 64, pattern: SHA256_PATTERN, nullable });
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length > 32) fail('QUEUE_SCHEMA_INVALID', `${label} must be a bounded array.`);
  for (const item of value) assertSafePersistedText(item, `${label} item`, { max: 256 });
  if (new Set(value).size !== value.length) fail('QUEUE_SCHEMA_INVALID', `${label} cannot contain duplicates.`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function assertSafeJsonValue(value, label, depth = 0, counter = { count: 0 }) {
  counter.count += 1;
  if (depth > 64 || counter.count > 100_000) fail('QUEUE_PUBLICATION_LIMIT', 'Published document exceeds structural limits.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > MAX_PUBLICATION_BYTES) fail('QUEUE_PUBLICATION_LIMIT', `${label} exceeds its string bound.`);
    if (SECRET_TEXT_PATTERN.test(value)) {
      fail('QUEUE_SECRET_REJECTED', `${label} appears to contain credential material and cannot be persisted.`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('QUEUE_SCHEMA_INVALID', `${label} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeJsonValue(item, `${label}[${index}]`, depth + 1, counter));
    return;
  }
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('QUEUE_SCHEMA_INVALID', `${label} contains a non-JSON value.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_PATTERN.test(key) && item !== null && item !== false && item !== '[REDACTED]') {
      fail('QUEUE_SECRET_REJECTED', `${label}.${key} is a credential-bearing field and must be removed or redacted.`);
    }
    assertSafeJsonValue(item, `${label}.${key}`, depth + 1, counter);
  }
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value);
  return createHash('sha256').update(bytes).digest('hex');
}

function nowIso(queue) {
  const value = queue.clock();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) fail('QUEUE_CLOCK_INVALID', 'Queue clock returned an invalid time.');
  return new Date(milliseconds).toISOString();
}

function nowMilliseconds(queue) {
  return new Date(nowIso(queue)).getTime();
}

function normalizeFilesystemType(type) {
  const bigint = typeof type === 'bigint' ? type : BigInt(type);
  return BigInt.asUintN(64, bigint);
}

export function assertSupportedFilesystemType(type) {
  const normalized = normalizeFilesystemType(type);
  const unsupported = UNSUPPORTED_FILESYSTEM_TYPES.get(normalized);
  if (unsupported) {
    fail(
      'QUEUE_UNSUPPORTED_FILESYSTEM',
      `Queue storage is on ${unsupported}; a Docker local volume with local mkdir, fsync, and rename semantics is required.`,
      { filesystemType: `0x${normalized.toString(16)}`, filesystemName: unsupported },
    );
  }
  return `0x${normalized.toString(16)}`;
}

function safeIdentifier(value, label) {
  assertString(value, label, { max: 128, pattern: SAFE_IDENTIFIER_PATTERN });
  return value;
}

function safeRelativePath(value, label) {
  assertString(value, label, { max: 512 });
  if (path.isAbsolute(value) || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('QUEUE_SCHEMA_INVALID', `${label} must be a normalized contained relative path.`);
  }
  return value;
}

function contained(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}${path.sep}`);
}

function queuePath(queue, ...parts) {
  const candidate = path.join(queue.root, ...parts);
  if (!contained(queue.root, candidate)) fail('QUEUE_PATH_ESCAPE', 'Queue path escaped its configured root.');
  return candidate;
}

async function fsyncDirectory(filesystem, directory) {
  let handle;
  try {
    handle = await filesystem.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    fail('QUEUE_FSYNC_UNSUPPORTED', `Queue directory fsync failed for ${directory}.`, { cause: error?.code ?? String(error) });
  } finally {
    await handle?.close();
  }
}

async function ensureSharedDirectory(filesystem, directory, { recursive = false } = {}) {
  const created = await filesystem.mkdir(directory, { recursive, mode: SHARED_DIRECTORY_MODE });
  const candidates = new Set([directory]);
  if (typeof created === 'string') candidates.add(created);
  for (const candidate of candidates) {
    try {
      await filesystem.chmod(candidate, SHARED_DIRECTORY_MODE);
    } catch (error) {
      if (!['EACCES', 'EPERM'].includes(error?.code)) throw error;
      const stat = await filesystem.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || (stat.mode & SHARED_DIRECTORY_MODE) !== SHARED_DIRECTORY_MODE) {
        fail('QUEUE_PERMISSION_INVALID', `Queue directory ${candidate} is not writable by the dedicated queue group.`);
      }
    }
  }
}

async function atomicWriteJson(queue, file, value, { exclusive = false } = {}) {
  const directory = path.dirname(file);
  await ensureSharedDirectory(queue.fs, directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${queue.nonce()}.tmp`);
  let handle;
  try {
    handle = await queue.fs.open(temporary, 'wx', SHARED_FILE_MODE);
    await handle.chmod(SHARED_FILE_MODE);
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (exclusive && await pathExists(queue.fs, file)) {
      fail('QUEUE_ALREADY_EXISTS', `Queue document ${path.basename(file)} already exists.`);
    }
    await queue.fs.rename(temporary, file);
    await fsyncDirectory(queue.fs, directory);
  } finally {
    await handle?.close();
    await queue.fs.rm(temporary, { force: true });
  }
}

async function atomicMove(queue, source, destination) {
  await ensureSharedDirectory(queue.fs, path.dirname(destination), { recursive: true });
  await queue.fs.rename(source, destination);
  await fsyncDirectory(queue.fs, path.dirname(source));
  if (path.dirname(source) !== path.dirname(destination)) await fsyncDirectory(queue.fs, path.dirname(destination));
}

async function readBoundedJson(queue, file, label, maxBytes = MAX_STATE_BYTES) {
  let stat;
  try {
    stat = await queue.fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('QUEUE_NOT_FOUND', `${label} was not found.`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    fail('QUEUE_CORRUPT', `${label} is not a bounded regular file.`);
  }
  try {
    return JSON.parse(await queue.fs.readFile(file, 'utf8'));
  } catch (error) {
    fail('QUEUE_CORRUPT', `${label} is not valid JSON.`, { cause: error?.message });
  }
}

function assertEvidenceAuthority(value) {
  assertExactKeys(value, ['authoritative', 'reasons'], 'evidenceAuthority');
  if (typeof value.authoritative !== 'boolean') fail('QUEUE_SCHEMA_INVALID', 'evidenceAuthority.authoritative must be boolean.');
  assertStringArray(value.reasons, 'evidenceAuthority.reasons');
  if (value.authoritative && value.reasons.length > 0) {
    fail('QUEUE_SCHEMA_INVALID', 'Authoritative evidence cannot carry non-authoritative reasons.');
  }
  if (!value.authoritative && value.reasons.length === 0) {
    fail('QUEUE_SCHEMA_INVALID', 'Non-authoritative evidence requires at least one reason.');
  }
}

function assertStageDeadlines(value) {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).length > 64) {
    fail('QUEUE_SCHEMA_INVALID', 'stageDeadlines must be a non-empty bounded object.');
  }
  for (const [stage, deadline] of Object.entries(value)) {
    assertString(stage, 'stage name', { max: 64, pattern: SAFE_STAGE_PATTERN });
    assertIsoTimestamp(deadline, `stageDeadlines.${stage}`);
  }
}

function assertSubmission(value) {
  assertExactKeys(value, [
    'idempotencyKey',
    'runMode',
    'inputDocumentDigest',
    'runContractDigest',
    'compiledManifestDigest',
    'preflightDigest',
    'identityFingerprint',
    'revisionFingerprint',
    'evidenceAuthority',
    'registryRevision',
    'targetSetRevision',
    'runnerRevision',
    'stageDeadlines',
  ], 'job submission');
  assertString(value.idempotencyKey, 'idempotencyKey', { max: 256 });
  if (value.runMode !== 'single-site') fail('QUEUE_SCHEMA_INVALID', 'This queue core accepts only single-site jobs.');
  assertDigest(value.inputDocumentDigest, 'inputDocumentDigest');
  assertDigest(value.runContractDigest, 'runContractDigest');
  assertDigest(value.compiledManifestDigest, 'compiledManifestDigest');
  assertDigest(value.preflightDigest, 'preflightDigest');
  assertDigest(value.identityFingerprint, 'identityFingerprint');
  assertDigest(value.revisionFingerprint, 'revisionFingerprint', { nullable: true });
  assertEvidenceAuthority(value.evidenceAuthority);
  assertString(value.registryRevision, 'registryRevision', { max: 256 });
  assertString(value.targetSetRevision, 'targetSetRevision', { max: 256 });
  assertString(value.runnerRevision, 'runnerRevision', { max: 256 });
  assertStageDeadlines(value.stageDeadlines);
  if (value.revisionFingerprint === null && value.evidenceAuthority.authoritative) {
    fail('QUEUE_SCHEMA_INVALID', 'A job without a revision fingerprint cannot be authoritative.');
  }
  return value;
}

function assertLease(value, state) {
  if (value === null) return;
  assertExactKeys(value, ['workerId', 'attemptId', 'attemptNumber', 'fencingToken', 'heartbeatAt', 'expiresAt'], 'lease');
  safeIdentifier(value.workerId, 'lease.workerId');
  safeIdentifier(value.attemptId, 'lease.attemptId');
  assertInteger(value.attemptNumber, 'lease.attemptNumber', { min: 1 });
  assertInteger(value.fencingToken, 'lease.fencingToken', { min: 1 });
  assertIsoTimestamp(value.heartbeatAt, 'lease.heartbeatAt');
  assertIsoTimestamp(value.expiresAt, 'lease.expiresAt');
  if (new Date(value.expiresAt) <= new Date(value.heartbeatAt)) fail('QUEUE_SCHEMA_INVALID', 'Lease expiry must follow its heartbeat.');
  if (value.attemptId !== state.attemptId || value.attemptNumber !== state.attemptNumber || value.fencingToken !== state.fencingToken) {
    fail('QUEUE_SCHEMA_INVALID', 'Lease does not match the current attempt and fencing token.');
  }
}

function assertCancellation(value) {
  if (value === null) return;
  assertExactKeys(value, ['requestedAt', 'reason'], 'cancellation');
  assertIsoTimestamp(value.requestedAt, 'cancellation.requestedAt');
  assertSafePersistedText(value.reason, 'cancellation.reason', { max: 512 });
}

function assertResult(value) {
  if (value === null) return;
  assertExactKeys(value, ['kind', 'reason'], 'result');
  if (!['passed', 'findings', 'infrastructure-failure', 'failed', 'incomplete'].includes(value.kind)) {
    fail('QUEUE_SCHEMA_INVALID', 'result.kind is invalid.');
  }
  if (value.reason !== null) assertSafePersistedText(value.reason, 'result.reason', { max: 512 });
}

function assertEvent(value, index) {
  assertExactKeys(value, ['sequence', 'type', 'at', 'executionState', 'activityState', 'attemptNumber', 'attemptId', 'fencingToken', 'message'], `events[${index}]`);
  assertInteger(value.sequence, `events[${index}].sequence`, { min: 1 });
  assertString(value.type, `events[${index}].type`, { max: 64, pattern: SAFE_STAGE_PATTERN });
  assertIsoTimestamp(value.at, `events[${index}].at`);
  if (!JOB_EXECUTION_STATES.includes(value.executionState)) fail('QUEUE_SCHEMA_INVALID', `events[${index}].executionState is invalid.`);
  if (!WORKER_ACTIVITY_STATES.includes(value.activityState)) fail('QUEUE_SCHEMA_INVALID', `events[${index}].activityState is invalid.`);
  assertInteger(value.attemptNumber, `events[${index}].attemptNumber`);
  if (value.attemptId !== null) safeIdentifier(value.attemptId, `events[${index}].attemptId`);
  assertInteger(value.fencingToken, `events[${index}].fencingToken`);
  assertSafePersistedText(value.message, `events[${index}].message`, { max: 512 });
}

function assertPublication(value, index) {
  assertExactKeys(value, ['publicationId', 'relativePath', 'digest', 'attemptId', 'attemptNumber', 'fencingToken', 'publishedAt'], `publications[${index}]`);
  safeIdentifier(value.publicationId, `publications[${index}].publicationId`);
  safeRelativePath(value.relativePath, `publications[${index}].relativePath`);
  assertDigest(value.digest, `publications[${index}].digest`);
  safeIdentifier(value.attemptId, `publications[${index}].attemptId`);
  assertInteger(value.attemptNumber, `publications[${index}].attemptNumber`, { min: 1 });
  assertInteger(value.fencingToken, `publications[${index}].fencingToken`, { min: 1 });
  assertIsoTimestamp(value.publishedAt, `publications[${index}].publishedAt`);
}

export function assertJobEnvelope(value) {
  assertExactKeys(value, [
    'schemaVersion', 'jobId', 'idempotencyKeyDigest', 'submissionDigest', 'runMode',
    'inputDocumentDigest', 'runContractDigest', 'compiledManifestDigest', 'preflightDigest', 'identityFingerprint',
    'revisionFingerprint', 'evidenceAuthority', 'registryRevision', 'targetSetRevision',
    'runnerRevision', 'stageDeadlines', 'submittedAt', 'updatedAt', 'executionState',
    'activityState', 'attemptNumber', 'attemptId', 'fencingToken', 'lease',
    'infrastructureRetriesUsed', 'maxInfrastructureRetries', 'result', 'cancellation',
    'sequence', 'events', 'publications',
  ], 'job envelope');
  if (value.schemaVersion !== JOB_QUEUE_SCHEMA_VERSION) fail('QUEUE_SCHEMA_INVALID', 'Unsupported job envelope schema version.');
  safeIdentifier(value.jobId, 'jobId');
  assertDigest(value.idempotencyKeyDigest, 'idempotencyKeyDigest');
  assertDigest(value.submissionDigest, 'submissionDigest');
  if (value.runMode !== 'single-site') fail('QUEUE_SCHEMA_INVALID', 'job envelope runMode must be single-site.');
  assertDigest(value.inputDocumentDigest, 'inputDocumentDigest');
  assertDigest(value.runContractDigest, 'runContractDigest');
  assertDigest(value.compiledManifestDigest, 'compiledManifestDigest');
  assertDigest(value.preflightDigest, 'preflightDigest');
  assertDigest(value.identityFingerprint, 'identityFingerprint');
  assertDigest(value.revisionFingerprint, 'revisionFingerprint', { nullable: true });
  assertEvidenceAuthority(value.evidenceAuthority);
  assertString(value.registryRevision, 'registryRevision', { max: 256 });
  assertString(value.targetSetRevision, 'targetSetRevision', { max: 256 });
  assertString(value.runnerRevision, 'runnerRevision', { max: 256 });
  assertStageDeadlines(value.stageDeadlines);
  assertIsoTimestamp(value.submittedAt, 'submittedAt');
  assertIsoTimestamp(value.updatedAt, 'updatedAt');
  if (!JOB_EXECUTION_STATES.includes(value.executionState)) fail('QUEUE_SCHEMA_INVALID', 'executionState is invalid.');
  if (!WORKER_ACTIVITY_STATES.includes(value.activityState)) fail('QUEUE_SCHEMA_INVALID', 'activityState is invalid.');
  assertInteger(value.attemptNumber, 'attemptNumber');
  if (value.attemptId !== null) safeIdentifier(value.attemptId, 'attemptId');
  assertInteger(value.fencingToken, 'fencingToken');
  assertLease(value.lease, value);
  assertInteger(value.infrastructureRetriesUsed, 'infrastructureRetriesUsed', { max: 1 });
  assertInteger(value.maxInfrastructureRetries, 'maxInfrastructureRetries', { max: 1 });
  if (value.infrastructureRetriesUsed > value.maxInfrastructureRetries) fail('QUEUE_SCHEMA_INVALID', 'Infrastructure retry count exceeds its limit.');
  assertResult(value.result);
  assertCancellation(value.cancellation);
  assertInteger(value.sequence, 'sequence', { min: 1 });
  if (!Array.isArray(value.events) || value.events.length === 0 || value.events.length > MAX_EVENTS) fail('QUEUE_SCHEMA_INVALID', 'events must be a non-empty bounded array.');
  value.events.forEach(assertEvent);
  for (let index = 1; index < value.events.length; index += 1) {
    if (value.events[index].sequence <= value.events[index - 1].sequence) fail('QUEUE_SCHEMA_INVALID', 'Event sequences must increase.');
  }
  if (value.events.at(-1).sequence !== value.sequence) fail('QUEUE_SCHEMA_INVALID', 'The latest event sequence must equal envelope sequence.');
  if (!Array.isArray(value.publications) || value.publications.length > MAX_PUBLICATIONS) fail('QUEUE_SCHEMA_INVALID', 'publications must be a bounded array.');
  value.publications.forEach(assertPublication);
  if (new Set(value.publications.map((entry) => entry.publicationId)).size !== value.publications.length) {
    fail('QUEUE_SCHEMA_INVALID', 'publicationId values must be unique.');
  }
  if (ACTIVE_STATES.has(value.executionState) && value.lease === null) fail('QUEUE_SCHEMA_INVALID', 'Active execution requires a lease.');
  if (!ACTIVE_STATES.has(value.executionState) && value.lease !== null) fail('QUEUE_SCHEMA_INVALID', 'Only active execution can retain a lease.');
  if (value.executionState === 'queued' && value.attemptId !== null) fail('QUEUE_SCHEMA_INVALID', 'Queued execution cannot have a current attempt.');
  if (value.executionState === 'cancelled' && value.cancellation === null) fail('QUEUE_SCHEMA_INVALID', 'Cancelled execution requires cancellation evidence.');
  if (value.revisionFingerprint === null && value.evidenceAuthority.authoritative) fail('QUEUE_SCHEMA_INVALID', 'Missing revision evidence cannot be authoritative.');
  const immutableSubmission = {
    runMode: value.runMode,
    inputDocumentDigest: value.inputDocumentDigest,
    runContractDigest: value.runContractDigest,
    compiledManifestDigest: value.compiledManifestDigest,
    preflightDigest: value.preflightDigest,
    identityFingerprint: value.identityFingerprint,
    revisionFingerprint: value.revisionFingerprint,
    evidenceAuthority: value.evidenceAuthority,
    registryRevision: value.registryRevision,
    targetSetRevision: value.targetSetRevision,
    runnerRevision: value.runnerRevision,
    stageDeadlines: value.stageDeadlines,
  };
  if (sha256(immutableSubmission) !== value.submissionDigest) {
    fail('QUEUE_SCHEMA_INVALID', 'Immutable job inputs no longer match the idempotency-bound submission digest.');
  }
  return value;
}

function appendEvent(state, { type, at, message }) {
  state.sequence += 1;
  state.events.push({
    sequence: state.sequence,
    type,
    at,
    executionState: state.executionState,
    activityState: state.activityState,
    attemptNumber: state.attemptNumber,
    attemptId: state.attemptId,
    fencingToken: state.fencingToken,
    message,
  });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

async function acquireDirectoryLock(queue, directory, label) {
  let waits = 0;
  while (true) {
    try {
      await ensureSharedDirectory(queue.fs, directory);
      await fsyncDirectory(queue.fs, path.dirname(directory));
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stat;
      try {
        stat = await queue.fs.lstat(directory);
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      if (queue.lockClock() - stat.mtimeMs >= queue.lockStaleMs) {
        const quarantine = path.join(
          path.dirname(directory),
          `.stale-${path.basename(directory)}-${process.pid}-${queue.nonce()}`,
        );
        try {
          await queue.fs.rename(directory, quarantine);
          await fsyncDirectory(queue.fs, path.dirname(directory));
          await queue.fs.rm(quarantine, { recursive: true, force: true });
          await fsyncDirectory(queue.fs, path.dirname(directory));
          continue;
        } catch (recoveryError) {
          if (!['ENOENT', 'EEXIST'].includes(recoveryError?.code)) throw recoveryError;
          // Another contender either recovered the stale lock or acquired its
          // replacement. Re-enter the normal bounded wait path.
        }
      }
      if (waits >= queue.lockRetries) fail('QUEUE_LOCK_BUSY', `${label} is busy.`);
      waits += 1;
      await queue.sleep(queue.lockRetryMs);
    }
  }
}

async function releaseDirectoryLock(queue, directory) {
  try {
    await queue.fs.rmdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('QUEUE_LOCK_LOST', `Queue control lock ${path.basename(directory)} was lost before publication completed.`);
    throw error;
  }
  await fsyncDirectory(queue.fs, path.dirname(directory));
}

async function withControlLock(queue, jobId, operation) {
  safeIdentifier(jobId, 'jobId');
  const directory = queuePath(queue, 'jobs', jobId, 'control.lock');
  await acquireDirectoryLock(queue, directory, `Job ${jobId}`);
  try {
    return await operation();
  } finally {
    await releaseDirectoryLock(queue, directory);
  }
}

function statePath(queue, jobId) {
  return queuePath(queue, 'jobs', safeIdentifier(jobId, 'jobId'), 'state.json');
}

function jobIndexCategory(executionState) {
  return TERMINAL_STATES.has(executionState) ? 'terminal' : 'ready';
}

function jobIndexShard(jobId) {
  return sha256(safeIdentifier(jobId, 'jobId')).slice(0, 2);
}

function jobIndexPath(queue, category, jobId) {
  if (!JOB_INDEX_CATEGORIES.has(category)) fail('QUEUE_INDEX_INVALID', `Unknown queue index category ${String(category)}.`);
  return queuePath(queue, '.job-index', category, jobIndexShard(jobId), `${safeIdentifier(jobId, 'jobId')}.json`);
}

async function writeJobIndexMarker(queue, state) {
  const category = jobIndexCategory(state.executionState);
  const marker = jobIndexPath(queue, category, state.jobId);
  await ensureSharedDirectory(queue.fs, path.dirname(marker), { recursive: true });
  await atomicWriteJson(queue, marker, {
    schemaVersion: JOB_INDEX_SCHEMA_VERSION,
    category,
    jobId: state.jobId,
  });
  return category;
}

async function removeOppositeJobIndexMarker(queue, state, category) {
  const opposite = category === 'terminal' ? 'ready' : 'terminal';
  await queue.fs.rm(jobIndexPath(queue, opposite, state.jobId), { force: true });
}

async function writeState(queue, state) {
  state.updatedAt = nowIso(queue);
  assertJobEnvelope(state);
  // Publish the new work marker before the state transition. A crash can leave
  // a harmless stale marker, but cannot make newly-ready or newly-terminal
  // work invisible to the bounded pool scanners.
  const category = await writeJobIndexMarker(queue, state);
  await atomicWriteJson(queue, statePath(queue, state.jobId), state);
  await removeOppositeJobIndexMarker(queue, state, category);
}

export async function readJob(queue, jobId) {
  const value = await readBoundedJson(queue, statePath(queue, jobId), `Job ${jobId}`);
  return assertJobEnvelope(value);
}

async function pathExists(filesystem, candidate) {
  try {
    await filesystem.lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function verifyQueueStorageSemantics({ root, filesystem = nativeFs, nonce = () => randomBytes(8).toString('hex') }) {
  const absoluteRoot = path.resolve(root);
  await filesystem.mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  const rootStat = await filesystem.lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('QUEUE_UNSUPPORTED_FILESYSTEM', 'Queue root must be a real directory, not a symlink.');
  const filesystemStats = await filesystem.statfs(absoluteRoot, { bigint: true });
  const filesystemType = assertSupportedFilesystemType(filesystemStats.type);
  const probe = path.join(absoluteRoot, `.semantics-probe-${process.pid}-${nonce()}`);
  await filesystem.mkdir(probe, { mode: 0o700 });
  try {
    const lock = path.join(probe, 'atomic.lock');
    const claims = await Promise.allSettled(Array.from({ length: 8 }, () => filesystem.mkdir(lock, { mode: 0o700 })));
    if (claims.filter((result) => result.status === 'fulfilled').length !== 1
      || claims.filter((result) => result.status === 'rejected' && result.reason?.code === 'EEXIST').length !== 7) {
      fail('QUEUE_UNSUPPORTED_FILESYSTEM', 'Queue storage did not provide exclusive atomic mkdir semantics.');
    }
    const probeQueue = { root: absoluteRoot, fs: filesystem, nonce };
    const source = path.join(probe, 'publication.json');
    await atomicWriteJson(probeQueue, source, { schemaVersion: 1, probe: 'fsync-rename' });
    const destination = path.join(probe, 'published.json');
    await atomicMove(probeQueue, source, destination);
    const published = JSON.parse(await filesystem.readFile(destination, 'utf8'));
    if (published.probe !== 'fsync-rename' || await pathExists(filesystem, source)) {
      fail('QUEUE_UNSUPPORTED_FILESYSTEM', 'Queue storage did not provide atomic rename visibility.');
    }
    return { filesystemType, atomicMkdir: true, atomicRename: true, fsync: true };
  } finally {
    await filesystem.rm(probe, { recursive: true, force: true });
    await fsyncDirectory(filesystem, absoluteRoot);
  }
}

export async function openJobQueue({
  root,
  filesystem = nativeFs,
  clock = () => Date.now(),
  nonce = () => randomBytes(8).toString('hex'),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  lockClock = () => Date.now(),
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  leaseMs = DEFAULT_LEASE_MS,
  maxInfrastructureRetries = DEFAULT_MAX_INFRASTRUCTURE_RETRIES,
  lockRetryMs = 10,
  lockRetries = 3_000,
  lockStaleMs = 30_000,
  verifyStorage = true,
} = {}) {
  assertString(root, 'queue root', { max: 4096 });
  assertInteger(heartbeatMs, 'heartbeatMs', { min: 100 });
  assertInteger(leaseMs, 'leaseMs', { min: heartbeatMs * 4 });
  assertInteger(maxInfrastructureRetries, 'maxInfrastructureRetries', { max: 1 });
  assertInteger(lockRetryMs, 'lockRetryMs', { min: 1, max: 1_000 });
  assertInteger(lockRetries, 'lockRetries', { min: 0, max: 10_000 });
  assertInteger(lockStaleMs, 'lockStaleMs', { min: 1_000, max: 3_600_000 });
  const absoluteRoot = path.resolve(root);
  const storage = verifyStorage
    ? await verifyQueueStorageSemantics({ root: absoluteRoot, filesystem, nonce })
    : null;
  await ensureSharedDirectory(filesystem, absoluteRoot, { recursive: true });
  await ensureSharedDirectory(filesystem, path.join(absoluteRoot, 'jobs'), { recursive: true });
  await ensureSharedDirectory(filesystem, path.join(absoluteRoot, 'idempotency'), { recursive: true });
  await ensureSharedDirectory(filesystem, path.join(absoluteRoot, '.job-index', 'ready'), { recursive: true });
  await ensureSharedDirectory(filesystem, path.join(absoluteRoot, '.job-index', 'terminal'), { recursive: true });
  await fsyncDirectory(filesystem, absoluteRoot);
  const queue = Object.freeze({
    root: absoluteRoot,
    fs: filesystem,
    clock,
    nonce,
    sleep,
    lockClock,
    heartbeatMs,
    leaseMs,
    maxInfrastructureRetries,
    lockRetryMs,
    lockRetries,
    lockStaleMs,
    storage,
  });
  await ensureJobIndexes(queue);
  return queue;
}

async function ensureJobIndexes(queue) {
  const versionFile = queuePath(queue, '.job-index', 'version.json');
  if (await pathExists(queue.fs, versionFile)) return;
  const lock = queuePath(queue, '.job-index', 'rebuild.lock');
  await acquireDirectoryLock(queue, lock, 'Queue work index');
  try {
    if (await pathExists(queue.fs, versionFile)) return;
    const entries = await queue.fs.readdir(queuePath(queue, 'jobs'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_IDENTIFIER_PATTERN.test(entry.name)) continue;
      try {
        const state = await readJob(queue, entry.name);
        const category = await writeJobIndexMarker(queue, state);
        await removeOppositeJobIndexMarker(queue, state, category);
      } catch (error) {
        if (error?.code !== 'QUEUE_NOT_FOUND' && error?.code !== 'ENOENT') throw error;
      }
    }
    await atomicWriteJson(queue, versionFile, { schemaVersion: JOB_INDEX_SCHEMA_VERSION });
  } finally {
    await releaseDirectoryLock(queue, lock);
  }
}

function submissionForDigest(submission) {
  const { idempotencyKey: _ignored, ...boundInput } = submission;
  return boundInput;
}

function initialState(queue, submission, { jobId, idempotencyKeyDigest, submissionDigest, submittedAt }) {
  const state = {
    schemaVersion: JOB_QUEUE_SCHEMA_VERSION,
    jobId,
    idempotencyKeyDigest,
    submissionDigest,
    runMode: submission.runMode,
    inputDocumentDigest: submission.inputDocumentDigest,
    runContractDigest: submission.runContractDigest,
    compiledManifestDigest: submission.compiledManifestDigest,
    preflightDigest: submission.preflightDigest,
    identityFingerprint: submission.identityFingerprint,
    revisionFingerprint: submission.revisionFingerprint,
    evidenceAuthority: structuredClone(submission.evidenceAuthority),
    registryRevision: submission.registryRevision,
    targetSetRevision: submission.targetSetRevision,
    runnerRevision: submission.runnerRevision,
    stageDeadlines: structuredClone(submission.stageDeadlines),
    submittedAt,
    updatedAt: submittedAt,
    executionState: 'queued',
    activityState: 'normal',
    attemptNumber: 0,
    attemptId: null,
    fencingToken: 0,
    lease: null,
    infrastructureRetriesUsed: 0,
    maxInfrastructureRetries: queue.maxInfrastructureRetries,
    result: null,
    cancellation: null,
    sequence: 1,
    events: [{
      sequence: 1,
      type: 'submitted',
      at: submittedAt,
      executionState: 'queued',
      activityState: 'normal',
      attemptNumber: 0,
      attemptId: null,
      fencingToken: 0,
      message: 'Validated job envelope was durably queued.',
    }],
    publications: [],
  };
  return assertJobEnvelope(state);
}

function assertBinding(value) {
  assertExactKeys(value, ['schemaVersion', 'idempotencyKeyDigest', 'submissionDigest', 'jobId'], 'idempotency binding');
  if (value.schemaVersion !== 1) fail('QUEUE_CORRUPT', 'Unsupported idempotency binding schema.');
  assertDigest(value.idempotencyKeyDigest, 'idempotency binding key digest');
  assertDigest(value.submissionDigest, 'idempotency binding submission digest');
  safeIdentifier(value.jobId, 'idempotency binding jobId');
  return value;
}

function jobInputPath(queue, jobId) {
  return queuePath(queue, 'jobs', safeIdentifier(jobId, 'jobId'), 'input.json');
}

function validatedInputDocument(inputDocument, expectedDigest) {
  if (!isRecord(inputDocument)) fail('QUEUE_SCHEMA_INVALID', 'Job input document must be an object.');
  const document = structuredClone(inputDocument);
  assertSafeJsonValue(document, 'job input document');
  const serialized = canonicalJson(document);
  if (Buffer.byteLength(serialized) > MAX_JOB_INPUT_BYTES) {
    fail('QUEUE_PUBLICATION_LIMIT', `Job input document exceeds ${MAX_JOB_INPUT_BYTES} bytes.`);
  }
  const actualDigest = sha256(serialized);
  if (actualDigest !== expectedDigest) {
    fail('QUEUE_INPUT_MISMATCH', 'Job input document does not match inputDocumentDigest.', {
      expectedDigest,
      actualDigest,
    });
  }
  return document;
}

export async function readJobInput(queue, jobId) {
  const state = await readJob(queue, jobId);
  const document = await readBoundedJson(
    queue,
    jobInputPath(queue, state.jobId),
    `Job input for ${state.jobId}`,
    MAX_JOB_INPUT_BYTES,
  );
  return validatedInputDocument(document, state.inputDocumentDigest);
}

export async function submitJob(queue, input, { inputDocument } = {}) {
  const submission = assertSubmission(structuredClone(input));
  const validatedDocument = inputDocument === undefined
    ? null
    : validatedInputDocument(inputDocument, submission.inputDocumentDigest);
  const idempotencyKeyDigest = sha256(submission.idempotencyKey);
  const submissionDigest = sha256(submissionForDigest(submission));
  const jobId = `job-${idempotencyKeyDigest.slice(0, 12)}-${submissionDigest.slice(0, 12)}`;
  const bindingFile = queuePath(queue, 'idempotency', `${idempotencyKeyDigest}.json`);
  const bindingLock = queuePath(queue, 'idempotency', `${idempotencyKeyDigest}.lock`);
  await acquireDirectoryLock(queue, bindingLock, 'Idempotency key');
  try {
    if (await pathExists(queue.fs, bindingFile)) {
      const binding = assertBinding(await readBoundedJson(queue, bindingFile, 'Idempotency binding'));
      if (binding.submissionDigest !== submissionDigest) {
        fail('QUEUE_IDEMPOTENCY_CONFLICT', 'Idempotency key is already bound to different launch inputs.', {
          existingJobId: binding.jobId,
          existingSubmissionDigest: binding.submissionDigest,
          requestedSubmissionDigest: submissionDigest,
        });
      }
      const state = await readJob(queue, binding.jobId);
      if (validatedDocument !== null) {
        const persistedInput = await readJobInput(queue, binding.jobId);
        if (canonicalJson(persistedInput) !== canonicalJson(validatedDocument)) {
          fail('QUEUE_INPUT_MISMATCH', 'Existing job input bytes do not match the idempotent launch input.');
        }
      }
      return { created: false, state };
    }

    let state;
    let created = false;
    if (await pathExists(queue.fs, statePath(queue, jobId))) {
      state = await readJob(queue, jobId);
      if (state.idempotencyKeyDigest !== idempotencyKeyDigest || state.submissionDigest !== submissionDigest) {
        fail('QUEUE_CORRUPT', 'Deterministic job ID is bound to inconsistent launch inputs.');
      }
      if (validatedDocument !== null) {
        const persistedInput = await readJobInput(queue, jobId);
        if (canonicalJson(persistedInput) !== canonicalJson(validatedDocument)) {
          fail('QUEUE_INPUT_MISMATCH', 'Existing job input bytes do not match the idempotent launch input.');
        }
      }
    } else {
      const submittedAt = nowIso(queue);
      state = initialState(queue, submission, { jobId, idempotencyKeyDigest, submissionDigest, submittedAt });
      const jobDirectory = queuePath(queue, 'jobs', jobId);
      if (!(await pathExists(queue.fs, jobDirectory))) {
        await ensureSharedDirectory(queue.fs, jobDirectory);
      }
      await fsyncDirectory(queue.fs, queuePath(queue, 'jobs'));
      if (validatedDocument !== null) {
        const inputFile = jobInputPath(queue, jobId);
        if (await pathExists(queue.fs, inputFile)) {
          const interruptedInput = await readBoundedJson(
            queue,
            inputFile,
            `Interrupted job input for ${jobId}`,
            MAX_JOB_INPUT_BYTES,
          );
          validatedInputDocument(interruptedInput, submission.inputDocumentDigest);
          if (canonicalJson(interruptedInput) !== canonicalJson(validatedDocument)) {
            fail('QUEUE_INPUT_MISMATCH', 'Interrupted job input does not match the retried submission.');
          }
        } else {
          await atomicWriteJson(queue, inputFile, validatedDocument, { exclusive: true });
        }
      }
      await writeJobIndexMarker(queue, state);
      await atomicWriteJson(queue, statePath(queue, jobId), state, { exclusive: true });
      created = true;
    }
    await atomicWriteJson(queue, bindingFile, {
      schemaVersion: 1,
      idempotencyKeyDigest,
      submissionDigest,
      jobId,
    }, { exclusive: true });
    return { created, state };
  } finally {
    await releaseDirectoryLock(queue, bindingLock);
  }
}

function claimPath(queue, jobId) {
  return queuePath(queue, 'jobs', jobId, 'claim.lock');
}

function attemptPath(queue, jobId, attemptId, ...parts) {
  safeIdentifier(attemptId, 'attemptId');
  return queuePath(queue, 'jobs', jobId, 'attempts', attemptId, ...parts);
}

function claimDocument(claim) {
  return {
    schemaVersion: 1,
    jobId: claim.jobId,
    workerId: claim.workerId,
    attemptId: claim.attemptId,
    attemptNumber: claim.attemptNumber,
    fencingToken: claim.fencingToken,
  };
}

function assertClaim(value) {
  assertExactKeys(value, ['schemaVersion', 'jobId', 'workerId', 'attemptId', 'attemptNumber', 'fencingToken'], 'claim');
  if (value.schemaVersion !== 1) fail('QUEUE_STALE_FENCE', 'Claim schema is invalid.');
  safeIdentifier(value.jobId, 'claim.jobId');
  safeIdentifier(value.workerId, 'claim.workerId');
  safeIdentifier(value.attemptId, 'claim.attemptId');
  assertInteger(value.attemptNumber, 'claim.attemptNumber', { min: 1 });
  assertInteger(value.fencingToken, 'claim.fencingToken', { min: 1 });
  return value;
}

async function readClaimLock(queue, jobId) {
  const file = path.join(claimPath(queue, jobId), 'claim.json');
  const value = await readBoundedJson(queue, file, `Claim for ${jobId}`);
  return assertClaim(value);
}

function claimMatchesState(claim, state) {
  return claim.jobId === state.jobId
    && claim.attemptId === state.attemptId
    && claim.attemptNumber === state.attemptNumber
    && claim.fencingToken === state.fencingToken
    && claim.workerId === state.lease?.workerId;
}

async function assertCurrentClaim(queue, claim, state, { requireUnexpired = true } = {}) {
  assertClaim(claim);
  if (!claimMatchesState(claim, state) || state.lease === null) {
    fail('QUEUE_STALE_FENCE', 'Attempt no longer owns the current fencing token.', { currentFencingToken: state.fencingToken });
  }
  const diskClaim = await readClaimLock(queue, state.jobId);
  if (canonicalJson(diskClaim) !== canonicalJson(claimDocument(claim))) {
    fail('QUEUE_STALE_FENCE', 'Attempt claim lock no longer matches the current owner.');
  }
  if (requireUnexpired && new Date(state.lease.expiresAt).getTime() <= nowMilliseconds(queue)) {
    fail('QUEUE_LEASE_EXPIRED', 'Attempt lease expired before publication or heartbeat.');
  }
}

async function archiveCurrentClaim(queue, state, disposition) {
  const current = claimPath(queue, state.jobId);
  if (!(await pathExists(queue.fs, current))) return;
  const archived = attemptPath(
    queue,
    state.jobId,
    state.attemptId,
    `claim-${disposition}-fence-${state.fencingToken}`,
  );
  await atomicMove(queue, current, archived);
}

function leaseFor(queue, claim, at) {
  return {
    workerId: claim.workerId,
    attemptId: claim.attemptId,
    attemptNumber: claim.attemptNumber,
    fencingToken: claim.fencingToken,
    heartbeatAt: at,
    expiresAt: new Date(new Date(at).getTime() + queue.leaseMs).toISOString(),
  };
}

function newAttemptId(queue, attemptNumber) {
  return `attempt-${String(attemptNumber).padStart(3, '0')}-${queue.nonce()}`;
}

async function fenceExpiredAttempt(queue, state, at) {
  await archiveCurrentClaim(queue, state, 'expired');
  state.fencingToken += 1;
  state.lease = null;
  state.attemptId = null;
  state.result = { kind: 'infrastructure-failure', reason: 'Worker lease expired.' };
  if (state.infrastructureRetriesUsed < state.maxInfrastructureRetries) {
    state.infrastructureRetriesUsed += 1;
    state.executionState = 'queued';
    state.activityState = 'recovering';
    appendEvent(state, { type: 'lease-expired', at, message: 'Expired attempt was fenced and queued for its single infrastructure retry.' });
    await writeState(queue, state);
    return true;
  }
  state.executionState = 'incomplete';
  state.activityState = 'stalled';
  appendEvent(state, { type: 'retry-exhausted', at, message: 'Expired attempt exhausted the infrastructure retry budget.' });
  await writeState(queue, state);
  return false;
}

export async function claimJob(queue, jobId, workerId) {
  safeIdentifier(workerId, 'workerId');
  return withControlLock(queue, jobId, async () => {
    const state = await readJob(queue, jobId);
    if (TERMINAL_STATES.has(state.executionState)) fail('QUEUE_TERMINAL', `Job is already ${state.executionState}.`);
    const at = nowIso(queue);
    if (state.lease !== null) {
      if (new Date(state.lease.expiresAt).getTime() > new Date(at).getTime()) {
        fail('QUEUE_ALREADY_CLAIMED', `Job is leased by ${state.lease.workerId}.`, { expiresAt: state.lease.expiresAt });
      }
      if (!(await fenceExpiredAttempt(queue, state, at))) {
        fail('QUEUE_RETRY_EXHAUSTED', 'Job exhausted its single infrastructure retry after lease expiry.');
      }
    } else if (await pathExists(queue.fs, claimPath(queue, jobId))) {
      // A process can die after mkdir but before committing state. The empty or
      // unreferenced claim is fenced before a new attempt is issued.
      const orphan = queuePath(queue, 'jobs', jobId, 'orphaned-claims', `claim-${queue.nonce()}`);
      await atomicMove(queue, claimPath(queue, jobId), orphan);
    }

    const refreshed = await readJob(queue, jobId);
    if (refreshed.executionState !== 'queued') fail('QUEUE_STATE_CONFLICT', `Job cannot be claimed from ${refreshed.executionState}.`);
    const attemptNumber = refreshed.attemptNumber + 1;
    const attemptId = newAttemptId(queue, attemptNumber);
    const fencingToken = refreshed.fencingToken + 1;
    const claim = Object.freeze({ schemaVersion: 1, jobId, workerId, attemptId, attemptNumber, fencingToken });
    const currentClaimPath = claimPath(queue, jobId);
    try {
      await ensureSharedDirectory(queue.fs, currentClaimPath);
      await fsyncDirectory(queue.fs, path.dirname(currentClaimPath));
    } catch (error) {
      if (error?.code === 'EEXIST') fail('QUEUE_ALREADY_CLAIMED', 'Another worker won the atomic claim.');
      throw error;
    }
    try {
      await atomicWriteJson(queue, path.join(currentClaimPath, 'claim.json'), claimDocument(claim), { exclusive: true });
      await ensureSharedDirectory(queue.fs, attemptPath(queue, jobId, attemptId, 'pending'), { recursive: true });
      await ensureSharedDirectory(queue.fs, attemptPath(queue, jobId, attemptId, 'published'), { recursive: true });
      refreshed.attemptNumber = attemptNumber;
      refreshed.attemptId = attemptId;
      refreshed.fencingToken = fencingToken;
      refreshed.executionState = 'starting';
      refreshed.activityState = refreshed.infrastructureRetriesUsed > 0 ? 'recovering' : 'normal';
      refreshed.result = null;
      refreshed.lease = leaseFor(queue, claim, at);
      appendEvent(refreshed, { type: 'claimed', at, message: `Worker ${workerId} acquired the job with fencing token ${fencingToken}.` });
      await writeState(queue, refreshed);
      return claim;
    } catch (error) {
      await queue.fs.rm(currentClaimPath, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function heartbeatJob(queue, inputClaim, { activityState = 'normal' } = {}) {
  const claim = assertClaim(structuredClone(inputClaim));
  if (!WORKER_ACTIVITY_STATES.includes(activityState)) fail('QUEUE_SCHEMA_INVALID', 'Heartbeat activityState is invalid.');
  return withControlLock(queue, claim.jobId, async () => {
    const state = await readJob(queue, claim.jobId);
    await assertCurrentClaim(queue, claim, state);
    const at = nowIso(queue);
    state.activityState = activityState;
    state.lease = leaseFor(queue, claim, at);
    appendEvent(state, { type: 'heartbeat', at, message: `Worker ${claim.workerId} renewed its independent lease heartbeat.` });
    await writeState(queue, state);
    return claim;
  });
}

const ALLOWED_TRANSITIONS = new Map([
  ['starting', new Set(['running', 'finalizing'])],
  ['running', new Set(['finalizing'])],
  ['finalizing', new Set([])],
]);

export async function transitionJob(queue, inputClaim, executionState, { activityState = 'normal', message = null } = {}) {
  const claim = assertClaim(structuredClone(inputClaim));
  if (!['running', 'finalizing'].includes(executionState)) fail('QUEUE_SCHEMA_INVALID', 'transitionJob accepts running or finalizing.');
  if (!WORKER_ACTIVITY_STATES.includes(activityState)) fail('QUEUE_SCHEMA_INVALID', 'Transition activityState is invalid.');
  if (message !== null) assertSafePersistedText(message, 'transition message', { max: 512 });
  return withControlLock(queue, claim.jobId, async () => {
    const state = await readJob(queue, claim.jobId);
    await assertCurrentClaim(queue, claim, state);
    if (!ALLOWED_TRANSITIONS.get(state.executionState)?.has(executionState)) {
      fail('QUEUE_STATE_CONFLICT', `Cannot transition ${state.executionState} to ${executionState}.`);
    }
    const at = nowIso(queue);
    state.executionState = executionState;
    state.activityState = activityState;
    appendEvent(state, { type: 'transition', at, message: message ?? `Execution entered ${executionState}.` });
    await writeState(queue, state);
    return state;
  });
}

export async function publishAttemptDocument(queue, inputClaim, input) {
  const claim = assertClaim(structuredClone(inputClaim));
  assertExactKeys(input, ['publicationId', 'relativePath', 'document'], 'attempt publication');
  safeIdentifier(input.publicationId, 'publicationId');
  const relativePath = safeRelativePath(input.relativePath, 'publication relativePath');
  if (!isRecord(input.document) && !Array.isArray(input.document)) fail('QUEUE_SCHEMA_INVALID', 'Published document must be an object or array.');
  const document = structuredClone(input.document);
  assertSafeJsonValue(document, 'published document');
  const serializedDocument = canonicalJson(document);
  if (Buffer.byteLength(serializedDocument) > MAX_PUBLICATION_BYTES) {
    fail('QUEUE_PUBLICATION_LIMIT', `Published document exceeds ${MAX_PUBLICATION_BYTES} bytes.`);
  }
  const digest = sha256(serializedDocument);
  const pending = attemptPath(queue, claim.jobId, claim.attemptId, 'pending', `${input.publicationId}-${queue.nonce()}.json`);
  await atomicWriteJson(queue, pending, document, { exclusive: true });
  try {
    return await withControlLock(queue, claim.jobId, async () => {
      const state = await readJob(queue, claim.jobId);
      await assertCurrentClaim(queue, claim, state);
      const duplicate = state.publications.find((entry) => entry.publicationId === input.publicationId);
      if (duplicate) {
        if (duplicate.digest !== digest || duplicate.relativePath !== relativePath) {
          fail('QUEUE_PUBLICATION_CONFLICT', 'Publication ID is already bound to different bytes or a different path.');
        }
        await queue.fs.rm(pending, { force: true });
        return duplicate;
      }
      if (state.publications.length >= MAX_PUBLICATIONS) fail('QUEUE_PUBLICATION_LIMIT', 'Job exceeded its bounded publication manifest.');
      const destination = attemptPath(queue, claim.jobId, claim.attemptId, 'published', ...relativePath.split('/'));
      if (await pathExists(queue.fs, destination)) fail('QUEUE_PUBLICATION_CONFLICT', 'Publication destination already exists.');
      await atomicMove(queue, pending, destination);
      const publishedAt = nowIso(queue);
      const entry = {
        publicationId: input.publicationId,
        relativePath,
        digest,
        attemptId: claim.attemptId,
        attemptNumber: claim.attemptNumber,
        fencingToken: claim.fencingToken,
        publishedAt,
      };
      state.publications.push(entry);
      appendEvent(state, { type: 'publication', at: publishedAt, message: `Published ${relativePath} from the current fenced attempt.` });
      await writeState(queue, state);
      return entry;
    });
  } finally {
    await queue.fs.rm(pending, { force: true });
  }
}

export async function settleJobAttempt(queue, inputClaim, { kind, reason = null } = {}) {
  const claim = assertClaim(structuredClone(inputClaim));
  if (!['success', 'assertion-failure', 'infrastructure-failure', 'failed', 'incomplete'].includes(kind)) {
    fail('QUEUE_SCHEMA_INVALID', 'Attempt settlement kind is invalid.');
  }
  if (reason !== null) assertSafePersistedText(reason, 'settlement reason', { max: 512 });
  return withControlLock(queue, claim.jobId, async () => {
    const state = await readJob(queue, claim.jobId);
    await assertCurrentClaim(queue, claim, state);
    if ((kind === 'success' || kind === 'assertion-failure')
      && !state.publications.some((entry) => entry.attemptId === claim.attemptId && entry.fencingToken === claim.fencingToken)) {
      fail('QUEUE_EVIDENCE_REQUIRED', 'Successful and assertion-result settlements require fresh evidence from the current fenced attempt.');
    }
    const at = nowIso(queue);
    await archiveCurrentClaim(queue, state, 'settled');
    state.lease = null;
    if (kind === 'success' || kind === 'assertion-failure') {
      state.executionState = 'completed';
      state.activityState = 'normal';
      state.result = { kind: kind === 'success' ? 'passed' : 'findings', reason };
      appendEvent(state, {
        type: kind === 'success' ? 'completed' : 'findings-completed',
        at,
        message: kind === 'success'
          ? 'Current attempt completed with fresh evidence.'
          : 'Assertion findings were retained as completed evidence and were not retried.',
      });
    } else if (kind === 'infrastructure-failure') {
      state.fencingToken += 1;
      state.attemptId = null;
      state.result = { kind: 'infrastructure-failure', reason: reason ?? 'Worker infrastructure failed.' };
      if (state.infrastructureRetriesUsed < state.maxInfrastructureRetries) {
        state.infrastructureRetriesUsed += 1;
        state.executionState = 'queued';
        state.activityState = 'recovering';
        appendEvent(state, { type: 'infrastructure-retry', at, message: 'Infrastructure failure was fenced and queued for its single retry.' });
      } else {
        state.executionState = 'incomplete';
        state.activityState = 'stalled';
        appendEvent(state, { type: 'retry-exhausted', at, message: 'Infrastructure failure exhausted the single retry; evidence is incomplete.' });
      }
    } else {
      state.fencingToken += 1;
      state.executionState = kind;
      state.activityState = kind === 'incomplete' ? 'stalled' : 'normal';
      state.result = { kind, reason };
      appendEvent(state, { type: kind, at, message: reason ?? `Attempt settled ${kind}.` });
    }
    await writeState(queue, state);
    return state;
  });
}

export async function verifyJobCheckpoint(queue, inputClaim, inputCheckpoint) {
  const claim = assertClaim(structuredClone(inputClaim));
  assertExactKeys(inputCheckpoint, [
    'identityFingerprint',
    'revisionFingerprint',
    'preflightDigest',
    'compiledManifestDigest',
    'registryRevision',
    'targetSetRevision',
    'runnerRevision',
  ], 'execution checkpoint');
  assertDigest(inputCheckpoint.identityFingerprint, 'checkpoint.identityFingerprint');
  assertDigest(inputCheckpoint.revisionFingerprint, 'checkpoint.revisionFingerprint', { nullable: true });
  assertDigest(inputCheckpoint.preflightDigest, 'checkpoint.preflightDigest');
  assertDigest(inputCheckpoint.compiledManifestDigest, 'checkpoint.compiledManifestDigest');
  assertString(inputCheckpoint.registryRevision, 'checkpoint.registryRevision', { max: 256 });
  assertString(inputCheckpoint.targetSetRevision, 'checkpoint.targetSetRevision', { max: 256 });
  assertString(inputCheckpoint.runnerRevision, 'checkpoint.runnerRevision', { max: 256 });
  const checkpoint = structuredClone(inputCheckpoint);
  return withControlLock(queue, claim.jobId, async () => {
    const state = await readJob(queue, claim.jobId);
    await assertCurrentClaim(queue, claim, state);
    const mismatches = [
      ['identityFingerprint', state.identityFingerprint, checkpoint.identityFingerprint],
      ['revisionFingerprint', state.revisionFingerprint, checkpoint.revisionFingerprint],
      ['preflightDigest', state.preflightDigest, checkpoint.preflightDigest],
      ['compiledManifestDigest', state.compiledManifestDigest, checkpoint.compiledManifestDigest],
      ['registryRevision', state.registryRevision, checkpoint.registryRevision],
      ['targetSetRevision', state.targetSetRevision, checkpoint.targetSetRevision],
      ['runnerRevision', state.runnerRevision, checkpoint.runnerRevision],
    ].filter(([, expected, actual]) => expected !== actual).map(([field]) => field);
    const at = nowIso(queue);
    if (mismatches.length === 0) {
      appendEvent(state, { type: 'checkpoint-verified', at, message: 'Deployment identity, revision, preflight, scope, targets, and runner revisions still match.' });
      await writeState(queue, state);
      return state;
    }
    await archiveCurrentClaim(queue, state, 'checkpoint-mismatch');
    state.fencingToken += 1;
    state.lease = null;
    state.executionState = 'incomplete';
    state.activityState = 'stalled';
    state.result = { kind: 'incomplete', reason: `Execution checkpoint changed: ${mismatches.join(', ')}.` };
    appendEvent(state, {
      type: 'checkpoint-mismatch',
      at,
      message: `Execution was fenced before evidence could mix across changed inputs: ${mismatches.join(', ')}.`,
    });
    await writeState(queue, state);
    fail('QUEUE_CHECKPOINT_CHANGED', 'Job inputs changed after launch; remaining work was fenced INCOMPLETE.', {
      jobId: state.jobId,
      mismatches,
      fencingToken: state.fencingToken,
    });
  });
}

export async function cancelJob(queue, jobId, reason) {
  assertSafePersistedText(reason, 'cancellation reason', { max: 512 });
  return withControlLock(queue, jobId, async () => {
    const state = await readJob(queue, jobId);
    if (state.executionState === 'cancelled') return state;
    if (TERMINAL_STATES.has(state.executionState)) fail('QUEUE_TERMINAL', `Cannot cancel a job that is already ${state.executionState}.`);
    const at = nowIso(queue);
    if (state.lease !== null) await archiveCurrentClaim(queue, state, 'cancelled');
    state.fencingToken += 1;
    state.lease = null;
    state.executionState = 'cancelled';
    state.activityState = 'normal';
    state.result = { kind: 'incomplete', reason };
    state.cancellation = { requestedAt: at, reason };
    appendEvent(state, { type: 'cancelled', at, message: `Operator cancellation fenced all outstanding work: ${reason}` });
    await writeState(queue, state);
    return state;
  });
}

export async function listJobs(queue) {
  const entries = await queue.fs.readdir(queuePath(queue, 'jobs'), { withFileTypes: true });
  const jobs = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !SAFE_IDENTIFIER_PATTERN.test(entry.name)) continue;
    try {
      jobs.push(await readJob(queue, entry.name));
    } catch (error) {
      if (error?.code !== 'QUEUE_NOT_FOUND') throw error;
    }
  }
  return jobs;
}

function parseIndexCursor(value) {
  if (value === undefined || value === null || value === '') return { shard: 0, after: null };
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Number.isInteger(parsed.shard) || parsed.shard < 0 || parsed.shard > 255
      || (parsed.after !== null && (typeof parsed.after !== 'string' || !SAFE_IDENTIFIER_PATTERN.test(parsed.after)))) {
      throw new Error('invalid cursor');
    }
    return parsed;
  } catch {
    fail('QUEUE_INDEX_CURSOR_INVALID', 'Queue work-index cursor is invalid.');
  }
}

function encodeIndexCursor(shard, after) {
  return Buffer.from(JSON.stringify({ shard, after })).toString('base64url');
}

export async function listIndexedJobs(queue, {
  category,
  cursor = null,
  limit = DEFAULT_INDEX_PAGE_SIZE,
} = {}) {
  if (!JOB_INDEX_CATEGORIES.has(category)) fail('QUEUE_INDEX_INVALID', 'Queue index category must be ready or terminal.');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INDEX_PAGE_SIZE) {
    fail('QUEUE_INDEX_INVALID', `Queue index page limit must be from 1 through ${MAX_INDEX_PAGE_SIZE}.`);
  }
  const start = parseIndexCursor(cursor);
  const jobs = [];
  let scannedMarkers = 0;
  let shard = start.shard;
  let after = start.after;
  let visitedShards = 0;
  const scanLimit = Math.max(limit * 4, limit);
  while (visitedShards < 256 && jobs.length < limit && scannedMarkers < scanLimit) {
    const shardName = shard.toString(16).padStart(2, '0');
    const directory = queuePath(queue, '.job-index', category, shardName);
    let entries = [];
    try {
      entries = await queue.fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .filter((name) => SAFE_IDENTIFIER_PATTERN.test(name) && (after === null || name > after))
      .sort((left, right) => left.localeCompare(right));
    for (const jobId of names) {
      scannedMarkers += 1;
      after = jobId;
      try {
        const state = await readJob(queue, jobId);
        if (jobIndexCategory(state.executionState) === category) jobs.push(state);
      } catch (error) {
        // Marker publication intentionally precedes state publication. Never
        // delete a marker observed in that crash-safe transition window; stale
        // markers cost one bounded scan slot but cannot hide real work.
        if (error?.code !== 'QUEUE_NOT_FOUND' && error?.code !== 'ENOENT') {
          throw error;
        }
      }
      if (jobs.length >= limit || scannedMarkers >= scanLimit) break;
    }
    if (jobs.length >= limit || scannedMarkers >= scanLimit) break;
    shard = (shard + 1) % 256;
    after = null;
    visitedShards += 1;
  }
  const nextShard = jobs.length >= limit || scannedMarkers >= scanLimit ? shard : (shard + 1) % 256;
  const nextAfter = nextShard === shard ? after : null;
  return {
    jobs,
    cursor: encodeIndexCursor(nextShard, nextAfter),
    scannedMarkers,
  };
}
