import path from 'node:path';
import { canonicalDigest, canonicalJson } from '../../shared/canonical-contract.mjs';
import {
  atomicWriteJson,
  containedPath,
  openAtomicStorage,
  readBoundedJson,
  withDirectoryLock,
} from './atomic-filesystem.mjs';

export const SHARED_LAUNCH_OPERATION_SCHEMA_VERSION = 1;

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const SAFE_PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPERATION_ID = /^[a-f0-9]{64}$/u;
const MAX_INTENT_BYTES = 64 * 1_024;

export class SharedLaunchOperationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'SharedLaunchOperationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new SharedLaunchOperationError(code, message, statusCode);
}

function timestamp(store) {
  return new Date(store.clock()).toISOString();
}

function operationFile(store, operationId) {
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) {
    fail('LAUNCH_OPERATION_ID_INVALID', 'Launch operation ID is invalid.', 400);
  }
  return containedPath(store.root, 'operations', `${operationId}.json`);
}

function validatePrincipal(principal) {
  if (!principal || !SAFE_PRINCIPAL_ID.test(principal.id ?? '')
    || !['human', 'service'].includes(principal.kind)) {
    fail('AUTHENTICATION_REQUIRED', 'A launch operation requires an authenticated human or service principal.', 401);
  }
  return { id: principal.id, kind: principal.kind };
}

function validateIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || Object.keys(intent).length !== 2 || intent.schemaVersion !== 1 || !intent.runContract) {
    fail('LAUNCH_INTENT_INVALID', 'Launch intent is invalid.', 400);
  }
  if (Buffer.byteLength(canonicalJson(intent)) > MAX_INTENT_BYTES) {
    fail('LAUNCH_INTENT_TOO_LARGE', 'Launch intent exceeds the durable operation bound.', 413);
  }
  return intent;
}

function validateOperation(value, expectedOperationId = null) {
  const keys = [
    'schemaVersion', 'kind', 'operationId', 'projectId', 'actor', 'requestId', 'requestDigest',
    'intent', 'state', 'runId', 'outcome', 'acceptedAt', 'updatedAt',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))
    || value.schemaVersion !== 1 || value.kind !== 'shared-launch-operation'
    || !OPERATION_ID.test(value.operationId ?? '')
    || (expectedOperationId !== null && value.operationId !== expectedOperationId)
    || !SAFE_PROJECT_ID.test(value.projectId ?? '')
    || !SAFE_PRINCIPAL_ID.test(value.actor?.id ?? '')
    || !['human', 'service'].includes(value.actor?.kind)
    || !SAFE_REQUEST_ID.test(value.requestId ?? '')
    || !/^sha256:[a-f0-9]{64}$/u.test(value.requestDigest ?? '')
    || !['accepted', 'running', 'completed'].includes(value.state)
    || (value.runId !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.runId))
    || (value.state === 'completed') !== (value.outcome !== null)) {
    fail('LAUNCH_OPERATION_CORRUPT', 'Stored launch operation is corrupt.', 500);
  }
  validateIntent(value.intent);
  for (const field of ['acceptedAt', 'updatedAt']) {
    if (typeof value[field] !== 'string' || new Date(value[field]).toISOString() !== value[field]) {
      fail('LAUNCH_OPERATION_CORRUPT', 'Stored launch operation timestamp is corrupt.', 500);
    }
  }
  return Object.freeze(structuredClone(value));
}

export async function openSharedLaunchOperationStore({ root, clock = Date.now, verifyStorage = false } = {}) {
  if (typeof root !== 'string' || !root || typeof clock !== 'function') {
    throw new TypeError('Shared launch operation store requires root and clock.');
  }
  const storage = await openAtomicStorage({ root, verify: verifyStorage });
  return Object.freeze({ ...storage, clock });
}

export async function acceptSharedLaunchOperation(store, { principal, projectId, requestId, intent } = {}) {
  const actor = validatePrincipal(principal);
  if (typeof projectId !== 'string' || !SAFE_PROJECT_ID.test(projectId)) {
    fail('LAUNCH_PROJECT_INVALID', 'Server launch project is invalid.', 500);
  }
  if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) {
    fail('IDEMPOTENCY_KEY_INVALID', 'Launch requires a 16-128 character idempotency key.', 400);
  }
  const durableIntent = structuredClone(validateIntent(intent));
  const requestDigest = canonicalDigest(durableIntent);
  const operationId = canonicalDigest({
    schemaVersion: 1,
    kind: 'shared-launch-operation-identity',
    projectId,
    actor,
    requestId,
  }).slice('sha256:'.length);
  return withDirectoryLock(store, containedPath(store.root, '.launch-operations.lock'), async () => {
    const file = operationFile(store, operationId);
    let existing = null;
    try {
      existing = validateOperation(await readBoundedJson(store, file, { label: 'launch operation', maximumBytes: 128 * 1_024 }), operationId);
    } catch (error) {
      if (error?.code !== 'ATOMIC_NOT_FOUND') throw error;
    }
    if (existing) {
      if (existing.requestDigest !== requestDigest || canonicalJson(existing.intent) !== canonicalJson(durableIntent)) {
        fail('IDEMPOTENCY_CONFLICT', 'This launch idempotency key is already bound to different intent.', 409);
      }
      return existing;
    }
    const acceptedAt = timestamp(store);
    const operation = {
      schemaVersion: SHARED_LAUNCH_OPERATION_SCHEMA_VERSION,
      kind: 'shared-launch-operation',
      operationId,
      projectId,
      actor,
      requestId,
      requestDigest,
      intent: durableIntent,
      state: 'accepted',
      runId: null,
      outcome: null,
      acceptedAt,
      updatedAt: acceptedAt,
    };
    await atomicWriteJson(store, file, operation, { exclusive: true });
    return validateOperation(operation, operationId);
  });
}

export async function getSharedLaunchOperation(store, operationId) {
  try {
    return validateOperation(await readBoundedJson(store, operationFile(store, operationId), {
      label: 'launch operation', maximumBytes: 128 * 1_024,
    }), operationId);
  } catch (error) {
    if (error?.code === 'ATOMIC_NOT_FOUND') fail('LAUNCH_OPERATION_NOT_FOUND', 'Launch operation was not found.', 404);
    throw error;
  }
}
