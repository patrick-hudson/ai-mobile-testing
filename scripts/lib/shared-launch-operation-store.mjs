import path from 'node:path';
import { lstat as nativeLstat } from 'node:fs/promises';
import { canonicalDigest, canonicalJson } from '../../shared/canonical-contract.mjs';
import {
  atomicWriteJson,
  containedPath,
  fsyncDirectory,
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
const MAX_COMPILED_PLAN_BYTES = 8 * 1_048_576;
const MAX_LAUNCH_OPERATIONS = 2_048;
const COMPLETED_OPERATION_RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;

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

function validateCompiledPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || plan.schemaVersion !== 1 || plan.kind !== 'shared-launch-plan'
    || typeof plan.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(plan.digest)
    || !plan.createParentRunInput || 'runId' in plan.createParentRunInput) {
    fail('LAUNCH_PLAN_INVALID', 'Server-compiled launch plan is invalid.', 500);
  }
  const { digest, ...body } = plan;
  if (canonicalDigest(body) !== digest) fail('LAUNCH_PLAN_INVALID', 'Server-compiled launch plan digest is invalid.', 500);
  if (Buffer.byteLength(canonicalJson(plan)) > MAX_COMPILED_PLAN_BYTES) {
    fail('LAUNCH_PLAN_TOO_LARGE', 'Server-compiled launch plan exceeds the durable operation bound.', 500);
  }
  return plan;
}

function validateOperation(value, expectedOperationId = null) {
  const keys = [
    'schemaVersion', 'kind', 'operationId', 'projectId', 'actor', 'requestId', 'requestDigest',
    'intent', 'planDigest', 'compiledPlan', 'state', 'runId', 'outcome', 'acceptedAt', 'updatedAt',
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
    || !/^run-[a-f0-9]{32}$/u.test(value.runId ?? '')
    || (value.state === 'completed') !== (value.outcome !== null)) {
    fail('LAUNCH_OPERATION_CORRUPT', 'Stored launch operation is corrupt.', 500);
  }
  validateIntent(value.intent);
  validateCompiledPlan(value.compiledPlan);
  const expectedRequestDigest = canonicalDigest(value.intent);
  const derivedOperationId = canonicalDigest({
    schemaVersion: 1,
    kind: 'shared-launch-operation-identity',
    projectId: value.projectId,
    actor: value.actor,
    requestId: value.requestId,
  }).slice('sha256:'.length);
  if (value.requestDigest !== expectedRequestDigest
    || value.operationId !== derivedOperationId
    || value.runId !== `run-${derivedOperationId.slice(0, 32)}`
    || value.planDigest !== value.compiledPlan.digest
    || value.compiledPlan.intentDigest !== expectedRequestDigest) {
    fail('LAUNCH_OPERATION_CORRUPT', 'Stored launch operation durable bindings are corrupt.', 500);
  }
  for (const field of ['acceptedAt', 'updatedAt']) {
    if (typeof value[field] !== 'string' || new Date(value[field]).toISOString() !== value[field]) {
      fail('LAUNCH_OPERATION_CORRUPT', 'Stored launch operation timestamp is corrupt.', 500);
    }
  }
  return Object.freeze(structuredClone(value));
}

export function sharedLaunchOperationIdentity({ principal, projectId, requestId } = {}) {
  const actor = validatePrincipal(principal);
  if (typeof projectId !== 'string' || !SAFE_PROJECT_ID.test(projectId)) {
    fail('LAUNCH_PROJECT_INVALID', 'Server launch project is invalid.', 500);
  }
  if (typeof requestId !== 'string' || !SAFE_REQUEST_ID.test(requestId)) {
    fail('IDEMPOTENCY_KEY_INVALID', 'Launch requires a 16-128 character idempotency key.', 400);
  }
  const operationId = canonicalDigest({
    schemaVersion: 1,
    kind: 'shared-launch-operation-identity',
    projectId,
    actor,
    requestId,
  }).slice('sha256:'.length);
  return Object.freeze({ actor: Object.freeze(actor), operationId, runId: `run-${operationId.slice(0, 32)}` });
}

export async function openSharedLaunchOperationStore({
  root, clock = Date.now, verifyStorage = false, requireExisting = false,
} = {}) {
  if (typeof root !== 'string' || !root || typeof clock !== 'function') {
    throw new TypeError('Shared launch operation store requires root and clock.');
  }
  if (requireExisting) {
    let stat;
    try { stat = await nativeLstat(root); } catch (error) {
      fail('LAUNCH_OPERATION_STORE_UNAVAILABLE', 'Shared launch operation store is unavailable.', 503);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('LAUNCH_OPERATION_STORE_UNAVAILABLE', 'Shared launch operation store must be a real directory.', 503);
    }
  }
  const storage = await openAtomicStorage({ root, verify: verifyStorage });
  return Object.freeze({ ...storage, clock });
}

export async function acceptSharedLaunchOperation(store, {
  principal, projectId, requestId, intent, compiledPlan: rawCompiledPlan,
} = {}) {
  const { actor, operationId, runId } = sharedLaunchOperationIdentity({ principal, projectId, requestId });
  const durableIntent = structuredClone(validateIntent(intent));
  const compiledPlan = structuredClone(validateCompiledPlan(rawCompiledPlan));
  const requestDigest = canonicalDigest(durableIntent);
  return withDirectoryLock(store, containedPath(store.root, '.launch-operations.lock'), async () => {
    const file = operationFile(store, operationId);
    let existing = null;
    try {
      existing = validateOperation(await readBoundedJson(store, file, {
        label: 'launch operation', maximumBytes: MAX_COMPILED_PLAN_BYTES + 256 * 1_024,
      }), operationId);
    } catch (error) {
      if (error?.code !== 'ATOMIC_NOT_FOUND') throw error;
    }
    if (existing) {
      if (existing.requestDigest !== requestDigest || canonicalJson(existing.intent) !== canonicalJson(durableIntent)) {
        fail('IDEMPOTENCY_CONFLICT', 'This launch idempotency key is already bound to different intent.', 409);
      }
      return existing;
    }
    const operationDirectory = containedPath(store.root, 'operations');
    let entries = [];
    try { entries = await store.fs.readdir(operationDirectory); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    let liveOperations = 0;
    let removedCompletedOperation = false;
    for (const entry of entries.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
      const entryId = entry.slice(0, -'.json'.length);
      let stored;
      try {
        stored = await getSharedLaunchOperation(store, entryId);
      } catch {
        liveOperations += 1;
        continue;
      }
      if (stored.state !== 'completed') {
        liveOperations += 1;
      } else if (store.clock() - Date.parse(stored.updatedAt) > COMPLETED_OPERATION_RETRY_WINDOW_MS) {
        await store.fs.unlink(operationFile(store, entryId));
        removedCompletedOperation = true;
      }
    }
    if (removedCompletedOperation) await fsyncDirectory(store.fs, operationDirectory);
    if (liveOperations >= MAX_LAUNCH_OPERATIONS) {
      fail('LAUNCH_OPERATION_QUOTA_EXCEEDED', 'Launch operation quota is exhausted.', 429);
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
      planDigest: compiledPlan.digest,
      compiledPlan,
      state: 'accepted',
      runId,
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
      label: 'launch operation', maximumBytes: MAX_COMPILED_PLAN_BYTES + 256 * 1_024,
    }), operationId);
  } catch (error) {
    if (error?.code === 'ATOMIC_NOT_FOUND') fail('LAUNCH_OPERATION_NOT_FOUND', 'Launch operation was not found.', 404);
    throw error;
  }
}

export async function findSharedLaunchOperation(store, { principal, projectId, requestId, intent } = {}) {
  const { operationId } = sharedLaunchOperationIdentity({ principal, projectId, requestId });
  const durableIntent = validateIntent(intent);
  let operation;
  try { operation = await getSharedLaunchOperation(store, operationId); } catch (error) {
    if (error?.code === 'LAUNCH_OPERATION_NOT_FOUND') return null;
    throw error;
  }
  if (operation.requestDigest !== canonicalDigest(durableIntent)
    || canonicalJson(operation.intent) !== canonicalJson(durableIntent)) {
    fail('IDEMPOTENCY_CONFLICT', 'This launch idempotency key is already bound to different intent.', 409);
  }
  return operation;
}

export async function completeSharedLaunchOperation(store, operationId, outcome) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
    || !['succeeded', 'failed'].includes(outcome.status)
    || Buffer.byteLength(canonicalJson(outcome)) > 16 * 1_024) {
    fail('LAUNCH_OUTCOME_INVALID', 'Launch operation outcome is invalid.', 500);
  }
  return withDirectoryLock(store, containedPath(store.root, '.launch-operations.lock'), async () => {
    const current = await getSharedLaunchOperation(store, operationId);
    if (current.state === 'completed') {
      if (canonicalJson(current.outcome) !== canonicalJson(outcome)) {
        fail('LAUNCH_OPERATION_ALREADY_COMPLETED', 'Launch operation already has a different terminal outcome.', 409);
      }
      return current;
    }
    const next = {
      ...structuredClone(current),
      state: 'completed',
      outcome: structuredClone(outcome),
      updatedAt: timestamp(store),
    };
    await atomicWriteJson(store, operationFile(store, operationId), next);
    return validateOperation(next, operationId);
  });
}

export async function listRecoverableSharedLaunchOperations(store, { limit = MAX_LAUNCH_OPERATIONS } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LAUNCH_OPERATIONS) {
    fail('LAUNCH_OPERATION_LIMIT_INVALID', 'Launch operation list limit is invalid.', 400);
  }
  let entries = [];
  try { entries = await store.fs.readdir(containedPath(store.root, 'operations')); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const operations = [];
  const errors = [];
  for (const entry of entries.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).sort()) {
    const operationId = entry.slice(0, -'.json'.length);
    let operation;
    try {
      operation = await getSharedLaunchOperation(store, operationId);
    } catch (error) {
      errors.push(Object.freeze({
        operationId,
        code: typeof error?.code === 'string' ? error.code : 'LAUNCH_OPERATION_RECOVERY_FAILED',
        message: error instanceof Error ? error.message : String(error),
      }));
      continue;
    }
    if (operation.state !== 'completed') operations.push(operation);
    if (operations.length >= limit) break;
  }
  return Object.freeze({ operations: Object.freeze(operations), errors: Object.freeze(errors) });
}
