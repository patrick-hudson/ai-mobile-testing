import { constants as fsConstants, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import {
  VISUAL_BASELINE_HISTORY_SCHEMA_VERSION,
  assertVisualBaselineRecord,
  compareVisualBaselineIdentity,
  normalizedRelativePath,
  parseTimestamp,
  parseVisualBaselineEvidence,
  parseVisualBaselineIdentity,
  visualBaselineCanonicalJson,
  visualBaselineDigest,
  visualBaselineIdentityKey,
  visualBaselineSlotKey,
} from '../shared/visual-baseline-contract.mjs';

const EVENT_NAME = /^(\d{12})-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;

export class VisualBaselineStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'VisualBaselineStoreError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new VisualBaselineStoreError(code, message, details);
}

function contained(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('BASELINE_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function reason(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 1_200) {
    fail('BASELINE_INPUT_INVALID', `${label} must be non-empty and at most 1200 characters.`);
  }
  return value;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('BASELINE_INPUT_INVALID', 'expectedStoreRevision is invalid.');
  return value;
}

function now(store) {
  const value = store.clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('BASELINE_CLOCK_INVALID', 'Visual baseline clock returned an invalid time.');
  return date.toISOString();
}

function nonce(store) {
  return safeId(store.nonce(), 'generated nonce');
}

async function lstatDirectory(path, label) {
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('BASELINE_PATH_UNSAFE', `${label} must be a real directory, not a symlink.`);
}

async function fsyncDirectory(path) {
  let handle;
  try {
    handle = await fs.open(path, 'r');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function ensureStoreDirectories(rootValue) {
  const requested = resolve(rootValue);
  await fs.mkdir(requested, { recursive: true, mode: 0o700 });
  await lstatDirectory(requested, 'Visual baseline root');
  const root = await fs.realpath(requested);
  for (const name of ['events', 'media']) {
    const path = join(root, name);
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    await lstatDirectory(path, `Visual baseline ${name} directory`);
    if (!contained(root, await fs.realpath(path))) fail('BASELINE_PATH_UNSAFE', `Visual baseline ${name} directory escaped its root.`);
  }
  return root;
}

export async function openVisualBaselineStore(options) {
  if (!options || typeof options.root !== 'string') fail('BASELINE_INPUT_INVALID', 'Visual baseline root is required.');
  const root = await ensureStoreDirectories(options.root);
  return Object.freeze({
    root,
    eventsDirectory: join(root, 'events'),
    mediaDirectory: join(root, 'media'),
    lockDirectory: join(root, '.mutation-lock'),
    clock: options.clock ?? (() => new Date()),
    nonce: options.nonce ?? (() => randomBytes(12).toString('hex')),
    lockRetries: options.lockRetries ?? 100,
    lockRetryMilliseconds: options.lockRetryMilliseconds ?? 20,
  });
}

function emptyState() {
  return {
    schemaVersion: VISUAL_BASELINE_HISTORY_SCHEMA_VERSION,
    storeRevision: 0,
    historyDigest: ZERO_DIGEST,
    baselines: {},
    activeBySlot: {},
    idempotency: {},
  };
}

function eventBody(event) {
  const { eventDigest: _eventDigest, ...body } = event;
  return body;
}

function parseEvent(value, expectedSequence, expectedPreviousDigest, filename) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.sequence !== expectedSequence
    || !['approved', 'replaced', 'revoked', 'deleted'].includes(value.type)) {
    fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event ${filename} is invalid.`);
  }
  safeId(value.eventId, 'visual baseline eventId');
  safeId(value.actorId, 'visual baseline event actorId');
  safeId(value.idempotencyKey, 'visual baseline event idempotencyKey');
  parseTimestamp(value.at, 'visual baseline event at');
  reason(value.reason, 'visual baseline event reason');
  if (value.previousDigest !== expectedPreviousDigest
    || value.eventDigest !== visualBaselineDigest(eventBody(value))) {
    fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event ${filename} breaks the append-only digest chain.`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.requestDigest ?? '')) {
    fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event ${filename} has an invalid request digest.`);
  }
  const eventFields = [
    'schemaVersion', 'sequence', 'eventId', 'type', 'at', 'actorId', 'reason', 'idempotencyKey',
    'requestDigest', 'previousDigest', 'payload', 'result', 'eventDigest',
  ];
  if (Object.keys(value).length !== eventFields.length || eventFields.some((field) => !(field in value))) {
    fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event ${filename} has an unsupported shape.`);
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)
    || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
    fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event ${filename} has invalid payload or result data.`);
  }
  const payloadFields = value.type === 'approved' ? ['record']
    : value.type === 'replaced' ? ['replacedBaselineId', 'record'] : ['baselineId'];
  const resultFields = value.type === 'approved' || value.type === 'replaced'
    ? ['baselineId', 'slotKey', 'identityKey', 'storeRevision', 'eventId', 'eventType']
    : value.type === 'deleted'
      ? ['baselineId', 'slotKey', 'mediaRemoved', 'storeRevision', 'eventId', 'eventType']
      : ['baselineId', 'slotKey', 'storeRevision', 'eventId', 'eventType'];
  if (Object.keys(value.payload).length !== payloadFields.length || payloadFields.some((field) => !(field in value.payload))
    || Object.keys(value.result).length !== resultFields.length || resultFields.some((field) => !(field in value.result))) {
    fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event ${filename} has an unsupported payload or result shape.`);
  }
  return value;
}

function applyEvent(state, event) {
  const result = event.result;
  if (!result || result.storeRevision !== event.sequence || result.eventId !== event.eventId) {
    fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event ${event.eventId} has an invalid idempotent result.`);
  }
  if (state.idempotency[event.idempotencyKey]) {
    fail('BASELINE_HISTORY_CORRUPT', `Visual baseline idempotency key ${event.idempotencyKey} is duplicated.`);
  }
  if (event.type === 'approved') {
    const record = assertVisualBaselineRecord(structuredClone(event.payload.record));
    if (record.state !== 'active' || result.baselineId !== record.baselineId || result.slotKey !== record.slotKey
      || result.identityKey !== record.identityKey || state.baselines[record.baselineId] || state.activeBySlot[record.slotKey]) {
      fail('BASELINE_HISTORY_CORRUPT', `Visual baseline approval ${event.eventId} conflicts with prior history.`);
    }
    state.baselines[record.baselineId] = record;
    state.activeBySlot[record.slotKey] = record.baselineId;
  } else if (event.type === 'replaced') {
    const old = state.baselines[event.payload.replacedBaselineId];
    const record = assertVisualBaselineRecord(structuredClone(event.payload.record));
    if (!old || old.state !== 'active' || old.slotKey !== record.slotKey || record.state !== 'active'
      || result.baselineId !== record.baselineId || result.slotKey !== record.slotKey || result.identityKey !== record.identityKey
      || state.activeBySlot[old.slotKey] !== old.baselineId || state.baselines[record.baselineId]) {
      fail('BASELINE_HISTORY_CORRUPT', `Visual baseline replacement ${event.eventId} conflicts with prior history.`);
    }
    state.baselines[old.baselineId] = { ...old, state: 'replaced', replacedBy: record.baselineId };
    state.baselines[record.baselineId] = record;
    state.activeBySlot[record.slotKey] = record.baselineId;
  } else if (event.type === 'revoked') {
    const old = state.baselines[event.payload.baselineId];
    if (!old || old.state !== 'active' || result.baselineId !== old.baselineId || result.slotKey !== old.slotKey
      || state.activeBySlot[old.slotKey] !== old.baselineId) {
      fail('BASELINE_HISTORY_CORRUPT', `Visual baseline revocation ${event.eventId} conflicts with prior history.`);
    }
    state.baselines[old.baselineId] = { ...old, state: 'revoked', revokedAt: event.at };
    delete state.activeBySlot[old.slotKey];
  } else {
    const old = state.baselines[event.payload.baselineId];
    if (!old || old.state === 'deleted' || result.baselineId !== old.baselineId || result.slotKey !== old.slotKey
      || typeof result.mediaRemoved !== 'boolean') {
      fail('BASELINE_HISTORY_CORRUPT', `Visual baseline deletion ${event.eventId} conflicts with prior history.`);
    }
    if (state.activeBySlot[old.slotKey] === old.baselineId) delete state.activeBySlot[old.slotKey];
    state.baselines[old.baselineId] = {
      ...old,
      state: 'deleted',
      media: { ...old.media, available: false },
      deletedAt: event.at,
      deletionReason: event.reason,
    };
  }
  state.storeRevision = event.sequence;
  state.historyDigest = event.eventDigest;
  state.idempotency[event.idempotencyKey] = { requestDigest: event.requestDigest, result: structuredClone(event.result) };
}

export async function readVisualBaselineStore(store) {
  await lstatDirectory(store.root, 'Visual baseline root');
  await lstatDirectory(store.eventsDirectory, 'Visual baseline events directory');
  const names = (await fs.readdir(store.eventsDirectory)).filter((name) => name.endsWith('.json')).sort();
  const state = emptyState();
  const history = [];
  for (const [index, filename] of names.entries()) {
    const match = EVENT_NAME.exec(filename);
    if (!match || Number(match[1]) !== index + 1) {
      fail('BASELINE_HISTORY_CORRUPT', `Visual baseline history filename ${filename} is out of sequence.`);
    }
    const path = join(store.eventsDirectory, filename);
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVENT_BYTES) {
      fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event ${filename} is not a bounded regular file.`);
    }
    const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size > MAX_EVENT_BYTES) {
        fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event ${filename} is not a bounded regular file.`);
      }
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    let document;
    try { document = JSON.parse(bytes.toString('utf8')); } catch { fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event ${filename} is invalid JSON.`); }
    const event = parseEvent(document, index + 1, state.historyDigest, filename);
    if (match[2] !== event.eventId) fail('BASELINE_HISTORY_CORRUPT', `Visual baseline event filename ${filename} disagrees with its content.`);
    applyEvent(state, event);
    history.push(Object.freeze(event));
  }
  return Object.freeze({ state: Object.freeze(state), history: Object.freeze(history) });
}

async function acquireLock(store) {
  for (let attempt = 0; attempt <= store.lockRetries; attempt += 1) {
    try {
      await fs.mkdir(store.lockDirectory, { mode: 0o700 });
      await fs.writeFile(join(store.lockDirectory, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: now(store) })}\n`, { flag: 'wx', mode: 0o600 });
      await fsyncDirectory(store.root);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt === store.lockRetries) fail('BASELINE_MUTATION_LOCKED', 'Visual baseline mutation lock is busy.');
      await new Promise((accept) => setTimeout(accept, store.lockRetryMilliseconds));
    }
  }
}

export async function withVisualBaselineMutationLock(store, operation) {
  await acquireLock(store);
  try { return await operation(); } finally {
    await fs.rm(store.lockDirectory, { recursive: true, force: true });
    await fsyncDirectory(store.root);
  }
}

export async function isVisualBaselineMutationLocked(store) {
  try {
    const stat = await fs.lstat(store.lockDirectory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWriteState(store, state) {
  const temporary = join(store.root, `.state-${nonce(store)}.tmp`);
  const target = join(store.root, 'state.json');
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${visualBaselineCanonicalJson(state)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    await fsyncDirectory(store.root);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function appendEvent(store, currentState, input) {
  const sequence = currentState.storeRevision + 1;
  const eventId = nonce(store);
  const result = Object.freeze({
    ...input.result,
    storeRevision: sequence,
    eventId,
    eventType: input.type,
  });
  const body = {
    schemaVersion: 1,
    sequence,
    eventId,
    type: input.type,
    at: input.at,
    actorId: input.actorId,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    requestDigest: input.requestDigest,
    previousDigest: currentState.historyDigest,
    payload: input.payload,
    result,
  };
  const event = { ...body, eventDigest: visualBaselineDigest(body) };
  const filename = `${String(sequence).padStart(12, '0')}-${eventId}.json`;
  const path = join(store.eventsDirectory, filename);
  const temporary = join(store.eventsDirectory, `.pending-${eventId}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${visualBaselineCanonicalJson(event)}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  try {
    await fsyncDirectory(store.eventsDirectory);
    const replayed = await readVisualBaselineStore(store);
    // state.json is a replaceable materialization. The immutable event chain is
    // authoritative and a cache-write failure must never roll back committed media.
    await atomicWriteState(store, replayed.state).catch(() => undefined);
    return result;
  } catch (error) {
    if (error && typeof error === 'object') error.visualBaselineEventCommitted = true;
    throw error;
  }
}

function existingIdempotentResult(state, idempotencyKey, requestDigest) {
  const existing = state.idempotency[idempotencyKey];
  if (!existing) return null;
  if (existing.requestDigest !== requestDigest) {
    fail('BASELINE_IDEMPOTENCY_CONFLICT', `Idempotency key ${idempotencyKey} was already used for a different request.`);
  }
  return structuredClone(existing.result);
}

function assertCas(state, expectedStoreRevision) {
  if (state.storeRevision !== expectedStoreRevision) {
    fail('BASELINE_CAS_CONFLICT', `Visual baseline store revision is ${state.storeRevision}, not ${expectedStoreRevision}.`, {
      expectedStoreRevision,
      actualStoreRevision: state.storeRevision,
    });
  }
}

async function readApprovedSource(store, runArtifactRootValue, evidence) {
  const requestedRoot = resolve(runArtifactRootValue);
  await lstatDirectory(requestedRoot, 'Run artifact root');
  const artifactRoot = await fs.realpath(requestedRoot);
  if (contained(artifactRoot, store.root) || contained(store.root, artifactRoot)) {
    fail('BASELINE_PATH_UNSAFE', 'Visual baseline storage must be outside the source run artifact tree.');
  }
  const sourcePath = resolve(artifactRoot, ...normalizedRelativePath(evidence.artifactRelativePath).split('/'));
  if (!contained(artifactRoot, sourcePath)) fail('BASELINE_PATH_UNSAFE', 'Visual baseline source escaped its run artifact root.');
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_MEDIA_BYTES) {
    fail('BASELINE_PATH_UNSAFE', 'Visual baseline source must be a bounded regular non-symlink file.');
  }
  const realSource = await fs.realpath(sourcePath);
  if (!contained(artifactRoot, realSource)) fail('BASELINE_PATH_UNSAFE', 'Visual baseline source resolves outside its run artifact root.');
  const handle = await fs.open(realSource, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  const sha256 = visualBaselineDigest(bytes);
  if (bytes.length !== evidence.artifactBytes || sha256 !== evidence.artifactSha256) {
    fail('BASELINE_SOURCE_MISMATCH', 'Visual baseline source bytes disagree with the approved evidence manifest.');
  }
  return bytes;
}

async function copyImmutableMedia(store, baselineId, bytes, expectedSha256) {
  const relativePath = `media/${baselineId}.png`;
  const path = join(store.root, relativePath);
  if (!contained(store.mediaDirectory, path)) fail('BASELINE_PATH_UNSAFE', 'Visual baseline destination escaped its media directory.');
  const handle = await fs.open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  await fsyncDirectory(store.mediaDirectory);
  const copiedHandle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let copied;
  try { copied = await copiedHandle.readFile(); } finally { await copiedHandle.close(); }
  if (visualBaselineDigest(copied) !== expectedSha256 || copied.length !== bytes.length) {
    fail('BASELINE_COPY_FAILED', 'Visual baseline immutable copy failed verification.');
  }
  return relativePath;
}

function approvalRequest(input, operation) {
  const identity = parseVisualBaselineIdentity(input.identity);
  const actorId = safeId(input.actorId, 'actorId');
  const rawEvidence = input.evidence;
  const unresolved = rawEvidence?.findingStatus === 'unresolved';
  const existingFindingWaiver = unresolved && rawEvidence?.findingWaiver != null;
  const findingWaiverReason = input.findingWaiverReason == null
    ? null
    : reason(input.findingWaiverReason, 'findingWaiverReason');
  if ((!unresolved && findingWaiverReason !== null)
    || (unresolved && !existingFindingWaiver && findingWaiverReason === null)
    || (existingFindingWaiver && findingWaiverReason !== null)) {
    fail(
      'BASELINE_INPUT_INVALID',
      unresolved
        ? 'Unresolved Findings require a recorded findingWaiverReason.'
        : 'A Finding waiver is valid only for evidence with unresolved Findings.',
    );
  }
  // The immutable source manifest intentionally carries no waiver. Validate
  // its complete evidence shape with a temporary timestamp, but keep the
  // request digest independent of the eventual server action time so an
  // idempotent retry remains byte-for-byte the same request.
  const validatedEvidence = parseVisualBaselineEvidence(unresolved && !existingFindingWaiver ? {
    ...rawEvidence,
    findingWaiver: { actorId, reason: findingWaiverReason, at: '1970-01-01T00:00:00.000Z' },
  } : rawEvidence);
  const evidence = unresolved && !existingFindingWaiver
    ? { ...validatedEvidence, findingWaiver: null }
    : validatedEvidence;
  const body = {
    operation,
    expectedStoreRevision: revision(input.expectedStoreRevision),
    expectedActiveBaselineId: input.expectedActiveBaselineId ?? null,
    identity,
    evidence,
    actorId,
    reason: reason(input.reason, 'reason'),
    idempotencyKey: safeId(input.idempotencyKey, 'idempotencyKey'),
    findingWaiverReason,
  };
  return { ...body, requestDigest: visualBaselineDigest(body) };
}

async function approveOrReplace(store, input, operation) {
  const request = approvalRequest(input, operation);
  return withVisualBaselineMutationLock(store, async () => {
    const { state } = await readVisualBaselineStore(store);
    const idempotent = existingIdempotentResult(state, request.idempotencyKey, request.requestDigest);
    if (idempotent) return idempotent;
    assertCas(state, request.expectedStoreRevision);
    const slotKey = visualBaselineSlotKey(request.identity);
    const activeId = state.activeBySlot[slotKey] ?? null;
    if (operation === 'approve' && activeId !== null) fail('BASELINE_ACTIVE_EXISTS', 'An active visual baseline already exists for this semantic slot.');
    if (operation === 'replace' && (activeId === null || activeId !== request.expectedActiveBaselineId)) {
      fail('BASELINE_ACTIVE_CONFLICT', 'Replacement requires the exact currently active baseline ID.');
    }
    const bytes = await readApprovedSource(store, input.runArtifactRoot, request.evidence);
    const baselineId = `vb-${nonce(store)}`;
    const relativePath = await copyImmutableMedia(store, baselineId, bytes, request.evidence.artifactSha256);
    const approvedAt = now(store);
    const approvedEvidence = request.findingWaiverReason === null
      ? request.evidence
      : parseVisualBaselineEvidence({
          ...request.evidence,
          findingWaiver: {
            actorId: request.actorId,
            reason: request.findingWaiverReason,
            at: approvedAt,
          },
        });
    const record = {
      schemaVersion: 1,
      baselineId,
      slotKey,
      identityKey: visualBaselineIdentityKey(request.identity),
      identity: request.identity,
      state: 'active',
      source: approvedEvidence,
      media: { relativePath, sha256: request.evidence.artifactSha256, bytes: bytes.length, available: true },
      approvedBy: request.actorId,
      approvedAt,
      replacedBy: null,
      revokedAt: null,
      deletedAt: null,
      deletionReason: null,
    };
    try {
      return await appendEvent(store, state, {
        type: operation === 'approve' ? 'approved' : 'replaced',
        at: approvedAt,
        actorId: request.actorId,
        reason: request.reason,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        payload: operation === 'approve' ? { record } : { replacedBaselineId: activeId, record },
        result: { baselineId, slotKey, identityKey: record.identityKey },
      });
    } catch (error) {
      if (!error?.visualBaselineEventCommitted) await fs.unlink(join(store.root, relativePath)).catch(() => undefined);
      throw error;
    }
  });
}

export async function approveVisualBaseline(store, input) {
  if (input.expectedActiveBaselineId !== undefined && input.expectedActiveBaselineId !== null) {
    fail('BASELINE_INPUT_INVALID', 'Approval cannot name an expected active baseline; use replace explicitly.');
  }
  return approveOrReplace(store, input, 'approve');
}

export async function replaceVisualBaseline(store, input) {
  safeId(input.expectedActiveBaselineId, 'expectedActiveBaselineId');
  return approveOrReplace(store, input, 'replace');
}

function lifecycleRequest(input, operation) {
  const body = {
    operation,
    expectedStoreRevision: revision(input.expectedStoreRevision),
    baselineId: safeId(input.baselineId, 'baselineId'),
    actorId: safeId(input.actorId, 'actorId'),
    reason: reason(input.reason, 'reason'),
    idempotencyKey: safeId(input.idempotencyKey, 'idempotencyKey'),
  };
  return { ...body, requestDigest: visualBaselineDigest(body) };
}

export async function revokeVisualBaseline(store, input) {
  const request = lifecycleRequest(input, 'revoke');
  return withVisualBaselineMutationLock(store, async () => {
    const { state } = await readVisualBaselineStore(store);
    const idempotent = existingIdempotentResult(state, request.idempotencyKey, request.requestDigest);
    if (idempotent) return idempotent;
    assertCas(state, request.expectedStoreRevision);
    const record = state.baselines[request.baselineId];
    if (!record || record.state !== 'active') fail('BASELINE_STATE_CONFLICT', 'Only an active visual baseline may be revoked.');
    const at = now(store);
    return appendEvent(store, state, {
      type: 'revoked', at, actorId: request.actorId, reason: request.reason,
      idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest,
      payload: { baselineId: record.baselineId }, result: { baselineId: record.baselineId, slotKey: record.slotKey },
    });
  });
}

async function quarantineMedia(store, record) {
  const relativePath = normalizedRelativePath(record.media.relativePath);
  if (!relativePath.startsWith('media/')) fail('BASELINE_PATH_UNSAFE', 'Visual baseline media path is outside its media directory.');
  const path = resolve(store.root, ...relativePath.split('/'));
  if (!contained(store.mediaDirectory, path)) fail('BASELINE_PATH_UNSAFE', 'Visual baseline media path escaped its media directory.');
  let stat;
  try { stat = await fs.lstat(path); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('BASELINE_PATH_UNSAFE', 'Visual baseline media is not a regular non-symlink file.');
  const realPath = await fs.realpath(path);
  if (!contained(store.mediaDirectory, realPath)) fail('BASELINE_PATH_UNSAFE', 'Visual baseline media resolves outside its directory.');
  const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  if (bytes.length !== record.media.bytes || visualBaselineDigest(bytes) !== record.media.sha256) {
    fail('BASELINE_MEDIA_MISMATCH', 'Visual baseline media bytes disagree with their immutable manifest.');
  }
  const quarantine = join(store.mediaDirectory, `.delete-${record.baselineId}-${Date.now()}.tmp`);
  await fs.rename(path, quarantine);
  return { original: path, quarantine };
}

export async function deleteVisualBaseline(store, input) {
  const request = lifecycleRequest(input, 'delete');
  return withVisualBaselineMutationLock(store, async () => {
    const { state } = await readVisualBaselineStore(store);
    const idempotent = existingIdempotentResult(state, request.idempotencyKey, request.requestDigest);
    if (idempotent) return idempotent;
    assertCas(state, request.expectedStoreRevision);
    const record = state.baselines[request.baselineId];
    if (!record || record.state === 'deleted') fail('BASELINE_STATE_CONFLICT', 'Only an existing non-deleted visual baseline may be deleted.');
    const staged = await quarantineMedia(store, record);
    const at = now(store);
    try {
      const result = await appendEvent(store, state, {
        type: 'deleted', at, actorId: request.actorId, reason: request.reason,
        idempotencyKey: request.idempotencyKey, requestDigest: request.requestDigest,
        payload: { baselineId: record.baselineId },
        result: { baselineId: record.baselineId, slotKey: record.slotKey, mediaRemoved: staged !== null },
      });
      if (staged) await fs.unlink(staged.quarantine);
      return result;
    } catch (error) {
      if (staged && error?.visualBaselineEventCommitted) {
        await fs.unlink(staged.quarantine).catch(() => undefined);
      } else if (staged) {
        await fs.rename(staged.quarantine, staged.original).catch(() => undefined);
      }
      throw error;
    }
  });
}

export async function resolveVisualBaseline(store, currentIdentityValue) {
  const currentIdentity = parseVisualBaselineIdentity(currentIdentityValue);
  const { state } = await readVisualBaselineStore(store);
  const slotKey = visualBaselineSlotKey(currentIdentity);
  const activeId = state.activeBySlot[slotKey] ?? null;
  if (!activeId) return Object.freeze({ status: 'absent', reason: 'No active baseline exists for this semantic capture slot.', baseline: null, compatibility: null });
  const baseline = state.baselines[activeId];
  const compatibility = compareVisualBaselineIdentity(baseline.identity, currentIdentity);
  if (!compatibility.compatible) {
    return Object.freeze({
      status: 'incompatible',
      reason: `The active baseline is incompatible: ${compatibility.differences.join(', ')}.`,
      baseline,
      compatibility,
    });
  }
  const path = resolve(store.root, ...normalizedRelativePath(baseline.media.relativePath).split('/'));
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !contained(store.mediaDirectory, await fs.realpath(path))) throw new Error('unsafe media');
    const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    if (bytes.length !== baseline.media.bytes || visualBaselineDigest(bytes) !== baseline.media.sha256) throw new Error('corrupt media');
  } catch {
    return Object.freeze({ status: 'unavailable', reason: 'The compatible baseline media is unavailable or unsafe.', baseline, compatibility });
  }
  return Object.freeze({ status: 'compatible', reason: 'A compatible immutable baseline is available.', baseline, compatibility, mediaPath: path });
}

export function listVisualBaselineHistory(snapshot, slotKey = null) {
  const values = Object.values(snapshot.state.baselines)
    .filter((record) => slotKey === null || record.slotKey === slotKey)
    .sort((left, right) => left.approvedAt.localeCompare(right.approvedAt) || left.baselineId.localeCompare(right.baselineId));
  return Object.freeze(values.map((value) => Object.freeze(structuredClone(value))));
}
