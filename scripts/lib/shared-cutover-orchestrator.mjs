import path from 'node:path';

import {
  assertDigest,
  canonicalDigest,
  canonicalJson,
  exactKeys,
  isRecord,
  nonEmptyString,
} from '../../shared/canonical-contract.mjs';
import { parseShadowValidationReport } from '../../shared/shadow-validation.mjs';
import {
  SHADOW_ACCEPTANCE_CASE_IDS,
  SHADOW_CORRUPTION_CASE_IDS,
  SHADOW_PRE_REGISTERED_MATRIX_DIGEST,
} from '../../shared/shadow-validation-matrix-contract.mjs';
import {
  atomicWriteJson,
  containedPath,
  openAtomicStorage,
  pathExists,
  readBoundedJson,
  withDirectoryLock,
} from './atomic-filesystem.mjs';
import {
  listParentRunIds,
  readCurrentEnvelope,
  readParentRun,
  readStoreCoordinator,
  readReleaseAuthoritySelector,
  transitionReleaseAuthority,
} from './parent-run-store.mjs';
import { listRecoverableSharedLaunchOperations } from './shared-launch-operation-store.mjs';
import { inspectLegacyAuthorityDrainSources } from './legacy-authority-drain-source.mjs';

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_OBSERVATION_AGE_MS = 5 * 60_000;
const SHADOW_CASE_IDS = Object.freeze([
  ...SHADOW_ACCEPTANCE_CASE_IDS,
  ...SHADOW_CORRUPTION_CASE_IDS,
]);
const SHADOW_CASE_ID_SET = new Set(SHADOW_CASE_IDS);

export class SharedCutoverError extends Error {
  constructor(code, message, details = undefined, statusCode = undefined) {
    super(message);
    this.name = 'SharedCutoverError';
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

function fail(code, message, details, statusCode) {
  throw new SharedCutoverError(code, message, details, statusCode);
}

function timestamp(clock) {
  return new Date(clock()).toISOString();
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('CUTOVER_INPUT_INVALID', `${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || /^\.+$/u.test(value)) {
    fail('CUTOVER_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

function seal(body) {
  return Object.freeze({ ...body, digest: canonicalDigest(body) });
}

function parseSealed(value, label) {
  if (!isRecord(value)) fail('CUTOVER_DOCUMENT_INVALID', `${label} must be an object.`);
  const { digest, ...body } = value;
  assertDigest(digest, `${label}.digest`);
  if (digest !== canonicalDigest(body)) fail('CUTOVER_DOCUMENT_INVALID', `${label} digest is corrupt.`);
  return value;
}

function gateBody(value) {
  return {
    schemaVersion: 1,
    kind: 'release-admission-gate',
    state: value.state,
    revision: value.revision,
    cutoverId: value.cutoverId,
    previousDigest: value.previousDigest,
    updatedAt: value.updatedAt,
  };
}

function parseGate(value) {
  parseSealed(value, 'Admission gate');
  exactKeys(value, [...Object.keys(gateBody(value)), 'digest'], 'Admission gate');
  if (value.schemaVersion !== 1 || value.kind !== 'release-admission-gate'
    || !['OPEN', 'CLOSED'].includes(value.state)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.cutoverId !== null && !SAFE_ID.test(value.cutoverId))
    || (value.previousDigest !== null && typeof value.previousDigest !== 'string')) {
    fail('CUTOVER_DOCUMENT_INVALID', 'Admission gate is invalid.');
  }
  if (value.previousDigest !== null) assertDigest(value.previousDigest, 'Admission gate previousDigest');
  canonicalTimestamp(value.updatedAt, 'Admission gate updatedAt');
  if ((value.state === 'OPEN' && value.cutoverId !== null) || (value.state === 'CLOSED' && value.cutoverId === null)) {
    fail('CUTOVER_DOCUMENT_INVALID', 'Admission gate state and cutover ownership disagree.');
  }
  return clone(value);
}

async function openAdmissionGateStorage({ root, filesystem, nonce, verifyStorage = true } = {}) {
  if (typeof root !== 'string' || !root) fail('CUTOVER_INPUT_INVALID', 'Admission gate root is required.');
  return openAtomicStorage({ root, filesystem, nonce, verify: verifyStorage });
}

function admissionGateHandle(storage, { clock }) {
  const gatePath = containedPath(storage.root, 'release-admission-gate.json');
  const lockPath = containedPath(storage.root, '.release-admission-gate.lock');

  async function read() {
    try {
      return parseGate(await readBoundedJson(storage, gatePath, { label: 'release admission gate', maximumBytes: 64 * 1_024 }));
    } catch (error) {
      if (error instanceof SharedCutoverError && error.code === 'CUTOVER_ADMISSION_UNAVAILABLE') throw error;
      fail(
        'CUTOVER_ADMISSION_UNAVAILABLE',
        'Release admission is unavailable because its durable gate is missing, corrupt, or unreadable.',
        { cause: error?.code ?? error?.message },
        503,
      );
    }
  }

  async function transition({ expectedDigest, state, cutoverId }) {
    safeId(cutoverId, 'cutoverId');
    if (!['OPEN', 'CLOSED'].includes(state)) fail('CUTOVER_INPUT_INVALID', 'Admission state is invalid.');
    return withDirectoryLock(storage, lockPath, async () => {
      const current = await read();
      if (current.digest !== expectedDigest) fail('CUTOVER_ADMISSION_CONFLICT', 'Admission gate changed before transition.');
      const desiredCutoverId = state === 'CLOSED' ? cutoverId : null;
      if (current.state === state && current.cutoverId === desiredCutoverId) return current;
      if (current.state === 'CLOSED' && current.cutoverId !== cutoverId) {
        fail('CUTOVER_ADMISSION_OWNED', `Admission is already closed by ${current.cutoverId}.`);
      }
      if (state === 'OPEN' && current.state !== 'CLOSED') {
        fail('CUTOVER_ADMISSION_CONFLICT', 'Admission can only reopen from CLOSED.');
      }
      const next = seal(gateBody({
        state,
        revision: current.revision + 1,
        cutoverId: desiredCutoverId,
        previousDigest: current.digest,
        updatedAt: timestamp(clock),
      }));
      await atomicWriteJson(storage, gatePath, next);
      return clone(next);
    });
  }

  async function withOpen(operation) {
    if (typeof operation !== 'function') fail('CUTOVER_INPUT_INVALID', 'Admission operation is required.');
    return withDirectoryLock(storage, lockPath, async () => {
      const current = await read();
      if (current.state !== 'OPEN') {
        const error = new SharedCutoverError(
          'CUTOVER_ADMISSION_CLOSED',
          `Release admission is closed by ${current.cutoverId}; retry after the cutover completes.`,
          { cutoverId: current.cutoverId, gateDigest: current.digest },
        );
        error.statusCode = 503;
        throw error;
      }
      return operation(current);
    });
  }

  return Object.freeze({
    root: storage.root,
    read,
    withOpen,
    close: (expectedDigest, cutoverId) => transition({ expectedDigest, state: 'CLOSED', cutoverId }),
    open: (expectedDigest, cutoverId) => transition({ expectedDigest, state: 'OPEN', cutoverId }),
  });
}

export async function initializeCutoverAdmissionGate(options = {}) {
  const clock = options.clock ?? (() => Date.now());
  const storage = await openAdmissionGateStorage(options);
  const gatePath = containedPath(storage.root, 'release-admission-gate.json');
  if (!await pathExists(storage.fs, gatePath)) {
    const body = gateBody({
      state: 'OPEN', revision: 1, cutoverId: null, previousDigest: null, updatedAt: timestamp(clock),
    });
    try {
      await atomicWriteJson(storage, gatePath, seal(body), { exclusive: true });
    } catch (error) {
      if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
    }
  }
  const gate = admissionGateHandle(storage, { clock });
  await gate.read();
  return gate;
}

export async function openCutoverAdmissionGate(options = {}) {
  const clock = options.clock ?? (() => Date.now());
  const storage = await openAdmissionGateStorage(options);
  const gate = admissionGateHandle(storage, { clock });
  await gate.read();
  return gate;
}

const RELEASE_CHANGING_MUTATIONS = new Set(['cancel', 'rekick', 'visual-disposition', 'purge']);

export function createCutoverAdmissionPolicy({ admissionGate } = {}) {
  if (!admissionGate || typeof admissionGate.withOpen !== 'function') {
    fail('CUTOVER_ADMISSION_UNAVAILABLE', 'A durable release-admission gate is required.', undefined, 503);
  }
  return Object.freeze({
    withLaunchAdmission(_requestId, operation) {
      return admissionGate.withOpen(operation);
    },
    withPromotionAdmission(_requestId, operation) {
      return admissionGate.withOpen(operation);
    },
    withMutationAdmission(kind, _requestId, operation) {
      if (!RELEASE_CHANGING_MUTATIONS.has(kind)) return operation();
      return admissionGate.withOpen(operation);
    },
  });
}

export async function captureSharedAuthorityDrainObservation({
  store, coordinator, admissionGate, legacyAuthorityFence = null, launchOperationStore, cutoverId,
  legacyComparativeRoot, legacySingleSiteQueueRoot,
  clock = store?.clock ?? (() => Date.now()),
} = {}) {
  ensureCoordinator(coordinator);
  safeId(cutoverId, 'cutoverId');
  if (!store || !admissionGate || !launchOperationStore) {
    fail('CUTOVER_INPUT_INVALID', 'Drain observation requires the canonical store, admission gate, and launch-operation store.');
  }
  const [gate, selector, durableCoordinator, legacy, launchOperations, runIds] = await Promise.all([
    admissionGate.read(),
    readReleaseAuthoritySelector(store),
    readStoreCoordinator(store),
    inspectLegacyAuthorityDrainSources({
      comparativeRoot: legacyComparativeRoot,
      singleSiteQueueRoot: legacySingleSiteQueueRoot,
      clock,
    }),
    listRecoverableSharedLaunchOperations(launchOperationStore),
    listParentRunIds(store),
  ]);
  if (gate.state !== 'CLOSED' || gate.cutoverId !== cutoverId) {
    fail('CUTOVER_ADMISSION_OPEN', 'Drain observation requires admission closed by this cutover.');
  }
  if (legacyAuthorityFence) {
    const legacyFence = await legacyAuthorityFence.read();
    if (legacyFence.state !== 'CLOSED' || legacyFence.cutoverId !== cutoverId
      || legacyFence.activationEpoch !== 0) {
      fail('CUTOVER_LEGACY_FENCE_CONFLICT', 'Drain observation requires the closed pre-activation legacy authority fence.');
    }
  }
  if (selector.phase !== 'DRAINING' || selector.activationEpoch !== 0) {
    fail('CUTOVER_PHASE_INVALID', 'Drain observation may be captured only during pre-activation DRAINING.');
  }
  if (!durableCoordinator || durableCoordinator.ownerId !== coordinator.ownerId
    || durableCoordinator.epoch !== coordinator.epoch || durableCoordinator.token !== coordinator.token
    || Date.parse(durableCoordinator.expiresAt) <= clock()) {
    fail('CUTOVER_WRITER_NOT_SINGLETON', 'Drain observation requires the live singleton coordinator fence.');
  }

  const unresolvedOperationIds = [];
  const releaseChangingMutationIds = [];
  const unfencedLegacyLeaseIds = [...legacy.unfencedLegacyLeaseIds];
  for (const error of launchOperations.errors) {
    unresolvedOperationIds.push(`launch-corrupt:${error.operationId}:${error.code}`);
  }
  for (const operation of launchOperations.operations) {
    unresolvedOperationIds.push(`launch:${operation.operationId}`);
  }
  for (const runId of runIds) {
    const state = await readParentRun(store, runId);
    for (const operation of Object.values(state.operations ?? {})) {
      if (!['accepted', 'applied'].includes(operation.state)) continue;
      const identity = `${runId}:${operation.operationId}`;
      unresolvedOperationIds.push(identity);
      if (RELEASE_CHANGING_MUTATIONS.has(operation.kind)) releaseChangingMutationIds.push(identity);
    }
    for (const item of Object.values(state.workItems ?? {})) {
      if (item.state === 'running' && item.lease
        && item.lease.epoch === coordinator.epoch && Date.parse(item.lease.expiresAt) > clock()) {
        unfencedLegacyLeaseIds.push(`shared-preactivation:${runId}:${item.id}:${item.lease.token}`);
      }
      for (const diagnostic of item.diagnosticExecutions ?? []) {
        if (diagnostic.state !== 'running' || !diagnostic.lease) continue;
        if (diagnostic.lease.epoch === coordinator.epoch && Date.parse(diagnostic.lease.expiresAt) > clock()) {
          unfencedLegacyLeaseIds.push(
            `shared-preactivation:${runId}:${item.id}:diagnostic:${diagnostic.diagnosticExecutionId}:${diagnostic.lease.token}`,
          );
        }
      }
    }
  }
  const body = {
    schemaVersion: 1,
    kind: 'release-cutover-drain-observation',
    cutoverId,
    observedAt: timestamp(clock),
    admissionGateDigest: gate.digest,
    activeLegacyAuthoritativeRunIds: [...legacy.activeLegacyAuthoritativeRunIds].sort(),
    releaseChangingMutationIds: [...new Set(releaseChangingMutationIds)].sort(),
    unresolvedOperationIds: [...new Set(unresolvedOperationIds)].sort(),
    unfencedLegacyLeaseIds: [...new Set(unfencedLegacyLeaseIds)].sort(),
    canonicalWriterOwnerIds: [durableCoordinator.ownerId],
    legacyHeadMarkers: [...legacy.legacyHeadMarkers].sort(),
  };
  return Object.freeze(seal(body));
}

function parseExpectedStore(value) {
  exactKeys(value, [
    'deploymentIdentity', 'volumeIdentity', 'storeMarkerDigest', 'storeGeneration',
    'schemaVersion', 'schemaFloor', 'currentWriterProtocol', 'minimumWriterProtocol',
    'backupMarker',
  ], 'expectedStore');
  nonEmptyString(value.deploymentIdentity, 'expectedStore.deploymentIdentity');
  nonEmptyString(value.volumeIdentity, 'expectedStore.volumeIdentity');
  assertDigest(value.storeMarkerDigest, 'expectedStore.storeMarkerDigest');
  for (const key of ['storeGeneration', 'schemaVersion', 'schemaFloor']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail('CUTOVER_INPUT_INVALID', `expectedStore.${key} is invalid.`);
  }
  nonEmptyString(value.currentWriterProtocol, 'expectedStore.currentWriterProtocol');
  nonEmptyString(value.minimumWriterProtocol, 'expectedStore.minimumWriterProtocol');
  nonEmptyString(value.backupMarker, 'expectedStore.backupMarker');
  return clone(value);
}

function parseOperatorReview(value) {
  exactKeys(value, ['reviewed', 'actorId', 'reviewedAt'], 'operatorReview');
  validateOperatorReviewFields(value);
  return clone(value);
}

function validateOperatorReviewFields(value) {
  if (value.reviewed !== true) fail('CUTOVER_REVIEW_REQUIRED', 'Cutover requires an explicit operator review.');
  nonEmptyString(value.actorId, 'operatorReview.actorId');
  canonicalTimestamp(value.reviewedAt, 'operatorReview.reviewedAt');
}

function cutoverConfigurationDigest(input) {
  return canonicalDigest({
    cutoverId: input.cutoverId,
    activationRevision: input.activationRevision,
    buildIdentity: input.buildIdentity,
    rollbackBuildIdentity: input.rollbackBuildIdentity,
    expectedStore: input.expectedStore,
  });
}

function parseCutoverOperatorReview(value, input) {
  exactKeys(value, [
    'reviewed', 'actorId', 'reviewedAt', 'shadowValidationDigest', 'shadowMatrixDigest',
    'buildIdentity', 'expectedStoreDigest', 'configurationDigest',
  ], 'operatorReview');
  validateOperatorReviewFields(value);
  assertDigest(value.shadowValidationDigest, 'operatorReview.shadowValidationDigest');
  assertDigest(value.shadowMatrixDigest, 'operatorReview.shadowMatrixDigest');
  nonEmptyString(value.buildIdentity, 'operatorReview.buildIdentity');
  assertDigest(value.expectedStoreDigest, 'operatorReview.expectedStoreDigest');
  assertDigest(value.configurationDigest, 'operatorReview.configurationDigest');
  const expectedBindings = {
    shadowValidationDigest: input.shadowReport.digest,
    shadowMatrixDigest: input.shadowReport.matrixDigest,
    buildIdentity: input.buildIdentity,
    expectedStoreDigest: canonicalDigest(input.expectedStore),
    configurationDigest: cutoverConfigurationDigest(input),
  };
  const mismatches = Object.entries(expectedBindings)
    .filter(([key, expected]) => value[key] !== expected)
    .map(([key]) => key);
  if (Date.parse(value.reviewedAt) < Date.parse(input.shadowReport.generatedAt)) {
    mismatches.push('reviewedAt');
  }
  if (mismatches.length > 0) {
    fail(
      'CUTOVER_SHADOW_REVIEW_MISMATCH',
      `Operator shadow review is not bound to this cutover: ${mismatches.join(', ')}.`,
    );
  }
  return clone(value);
}

function parseCutoverInput(input) {
  exactKeys(input, [
    'cutoverId', 'activationRevision', 'buildIdentity', 'rollbackBuildIdentity',
    'expectedStore', 'shadowReport', 'operatorReview',
  ], 'cutover input');
  const cutoverId = safeId(input.cutoverId, 'cutoverId');
  if (!Number.isSafeInteger(input.activationRevision) || input.activationRevision < 1) {
    fail('CUTOVER_INPUT_INVALID', 'activationRevision must be a positive integer.');
  }
  const buildIdentity = nonEmptyString(input.buildIdentity, 'buildIdentity');
  const rollbackBuildIdentity = nonEmptyString(input.rollbackBuildIdentity, 'rollbackBuildIdentity');
  const expectedStore = parseExpectedStore(input.expectedStore);
  const shadowReport = parseShadowValidationReport(input.shadowReport);
  if (shadowReport.validationStatus !== 'PASS' || shadowReport.summary.unexplainedDrift !== 0) {
    fail('CUTOVER_SHADOW_BLOCKED', 'Cutover requires a PASS shadow report with zero unexplained drift.');
  }
  const reportCaseIds = shadowReport.comparisons.map(({ caseId }) => caseId);
  const presentCases = new Set(reportCaseIds);
  const missingCases = SHADOW_CASE_IDS.filter((caseId) => !presentCases.has(caseId));
  const unexpectedCases = reportCaseIds.filter((caseId) => !SHADOW_CASE_ID_SET.has(caseId));
  if (reportCaseIds.length !== SHADOW_CASE_IDS.length || presentCases.size !== reportCaseIds.length
    || missingCases.length > 0 || unexpectedCases.length > 0) {
    fail(
      'CUTOVER_SHADOW_INCOMPLETE',
      `Cutover shadow report must contain the complete pre-registered matrix${missingCases.length ? `; missing ${missingCases.join(', ')}` : ''}${unexpectedCases.length ? `; unexpected ${unexpectedCases.join(', ')}` : ''}.`,
    );
  }
  if (shadowReport.matrixDigest !== SHADOW_PRE_REGISTERED_MATRIX_DIGEST) {
    fail('CUTOVER_SHADOW_MATRIX_MISMATCH', 'Cutover shadow report does not match the pre-registered semantic matrix.');
  }
  const normalized = {
    cutoverId,
    activationRevision: input.activationRevision,
    buildIdentity,
    rollbackBuildIdentity,
    expectedStore,
    shadowReport,
  };
  normalized.operatorReview = parseCutoverOperatorReview(input.operatorReview, normalized);
  return { ...normalized, digest: canonicalDigest(normalized) };
}

function validateStore(store, input, { activated = false } = {}) {
  const manifest = store?.manifest;
  if (!isRecord(manifest)) fail('CUTOVER_STORE_MISMATCH', 'Parent-run store manifest is unavailable.');
  const expected = input.expectedStore;
  const expectedGeneration = expected.storeGeneration + (activated ? 1 : 0);
  const comparisons = {
    deploymentIdentity: expected.deploymentIdentity,
    volumeIdentity: expected.volumeIdentity,
    storeMarkerDigest: expected.storeMarkerDigest,
    storeGeneration: expectedGeneration,
    schemaVersion: expected.schemaVersion,
    schemaFloor: expected.schemaFloor,
    currentWriterProtocol: expected.currentWriterProtocol,
    minimumWriterProtocol: expected.minimumWriterProtocol,
    backupMarker: expected.backupMarker,
  };
  const mismatches = Object.entries(comparisons)
    .filter(([key, expectedValue]) => manifest[key] !== expectedValue)
    .map(([key]) => key);
  if (mismatches.length > 0 || store.buildIdentity !== input.buildIdentity) {
    fail('CUTOVER_STORE_MISMATCH', `Shared store identity or protocol mismatch: ${[...mismatches, ...(store.buildIdentity === input.buildIdentity ? [] : ['buildIdentity'])].join(', ')}.`);
  }
  if (!manifest.prequalifiedRollbackBuilds.includes(input.rollbackBuildIdentity)
    || !manifest.prequalifiedRollbackBuilds.includes(input.buildIdentity)) {
    fail('CUTOVER_ROLLBACK_BUILD_UNQUALIFIED', 'Current and rollback builds must both be prequalified before cutover.');
  }
  return clone(manifest);
}

function reportStoragePath(storage, cutoverId, suffix) {
  return containedPath(storage.root, `${cutoverId}${suffix}`);
}

async function openReportStorage(reportDirectory) {
  if (typeof reportDirectory !== 'string' || !reportDirectory) fail('CUTOVER_INPUT_INVALID', 'reportDirectory is required.');
  return openAtomicStorage({ root: reportDirectory, verify: false });
}

function checkpointBody(value) {
  return {
    schemaVersion: 1,
    kind: 'release-authority-cutover-checkpoint',
    cutoverId: value.cutoverId,
    inputDigest: value.inputDigest,
    status: value.status,
    selectorBefore: value.selectorBefore,
    selectorCurrent: value.selectorCurrent,
    admissionBefore: value.admissionBefore,
    admissionCurrent: value.admissionCurrent,
    drainObservation: value.drainObservation,
    updatedAt: value.updatedAt,
  };
}

function parseCheckpoint(value, cutoverId, inputDigest) {
  parseSealed(value, 'Cutover checkpoint');
  exactKeys(value, [...Object.keys(checkpointBody(value)), 'digest'], 'Cutover checkpoint');
  if (value.schemaVersion !== 1 || value.kind !== 'release-authority-cutover-checkpoint'
    || value.cutoverId !== cutoverId || value.inputDigest !== inputDigest
    || !['INITIALIZED', 'ADMISSION_CLOSED', 'DRAINING', 'ACTIVE'].includes(value.status)) {
    fail('CUTOVER_CHECKPOINT_CONFLICT', 'Cutover checkpoint does not match this request.');
  }
  return clone(value);
}

async function readCheckpoint(storage, input) {
  const file = reportStoragePath(storage, input.cutoverId, '.state.json');
  if (!await pathExists(storage.fs, file)) return null;
  return parseCheckpoint(await readBoundedJson(storage, file, { label: 'cutover checkpoint', maximumBytes: 2 * 1_048_576 }), input.cutoverId, input.digest);
}

async function writeCheckpoint(storage, value) {
  const body = checkpointBody(value);
  const checkpoint = seal(body);
  await atomicWriteJson(storage, reportStoragePath(storage, value.cutoverId, '.state.json'), checkpoint);
  return clone(checkpoint);
}

async function initializeCheckpoint(storage, input, selector, gate, clock) {
  const existing = await readCheckpoint(storage, input);
  if (existing) return existing;
  return writeCheckpoint(storage, {
    cutoverId: input.cutoverId,
    inputDigest: input.digest,
    status: 'INITIALIZED',
    selectorBefore: selector,
    selectorCurrent: selector,
    admissionBefore: gate,
    admissionCurrent: gate,
    drainObservation: null,
    updatedAt: timestamp(clock),
  });
}

function parseDrainObservation(value, { input, gate, coordinator, clock }) {
  parseSealed(value, 'Drain observation');
  exactKeys(value, [
    'schemaVersion', 'kind', 'cutoverId', 'observedAt', 'admissionGateDigest',
    'activeLegacyAuthoritativeRunIds', 'releaseChangingMutationIds',
    'unresolvedOperationIds', 'unfencedLegacyLeaseIds', 'canonicalWriterOwnerIds',
    'legacyHeadMarkers', 'digest',
  ], 'Drain observation');
  if (value.schemaVersion !== 1 || value.kind !== 'release-cutover-drain-observation'
    || value.cutoverId !== input.cutoverId || value.admissionGateDigest !== gate.digest) {
    fail('CUTOVER_OBSERVATION_MISMATCH', 'Drain observation is not bound to the closed admission gate.');
  }
  canonicalTimestamp(value.observedAt, 'Drain observation observedAt');
  const observedMs = Date.parse(value.observedAt);
  if (observedMs < Date.parse(gate.updatedAt) || observedMs > clock()
    || clock() - observedMs > MAX_OBSERVATION_AGE_MS) {
    fail('CUTOVER_OBSERVATION_STALE', 'Drain observation is stale or predates admission closure.');
  }
  for (const key of [
    'activeLegacyAuthoritativeRunIds', 'releaseChangingMutationIds', 'unresolvedOperationIds',
    'unfencedLegacyLeaseIds', 'canonicalWriterOwnerIds', 'legacyHeadMarkers',
  ]) {
    if (!Array.isArray(value[key]) || value[key].some((entry) => typeof entry !== 'string' || !entry)
      || new Set(value[key]).size !== value[key].length) {
      fail('CUTOVER_DOCUMENT_INVALID', `Drain observation ${key} must contain unique non-empty strings.`);
    }
  }
  if (value.activeLegacyAuthoritativeRunIds.length) fail('CUTOVER_LEGACY_RUNS_ACTIVE', 'Legacy authoritative runs remain active.');
  if (value.releaseChangingMutationIds.length) fail('CUTOVER_MUTATIONS_ACTIVE', 'Release-changing mutations remain in flight.');
  if (value.unresolvedOperationIds.length) fail('CUTOVER_OPERATIONS_UNRESOLVED', 'Durable operations are neither terminal nor fenced.');
  if (value.unfencedLegacyLeaseIds.length) fail('CUTOVER_LEASES_UNFENCED', 'Legacy leases remain unfenced.');
  if (value.canonicalWriterOwnerIds.length !== 1 || value.canonicalWriterOwnerIds[0] !== coordinator.ownerId) {
    fail('CUTOVER_WRITER_NOT_SINGLETON', 'The active coordinator is not the singleton canonical writer.');
  }
  if (value.legacyHeadMarkers.length < 1) {
    fail('CUTOVER_HEAD_MARKER_MISSING', 'Drain observation must record at least one sealed legacy head marker.');
  }
  return clone(value);
}

function ensureCoordinator(coordinator) {
  if (!isRecord(coordinator) || typeof coordinator.ownerId !== 'string'
    || !Number.isSafeInteger(coordinator.epoch) || coordinator.epoch < 1
    || typeof coordinator.token !== 'string') {
    fail('CUTOVER_INPUT_INVALID', 'A valid singleton store coordinator fence is required.');
  }
}

async function withCutoverLock(storage, cutoverId, operation) {
  return withDirectoryLock(storage, reportStoragePath(storage, cutoverId, '.lock'), operation);
}

export async function prepareSharedAuthorityCutover({
  store, coordinator, admissionGate, legacyAuthorityFence = null, reportDirectory, input: rawInput,
  clock = store?.clock ?? (() => Date.now()), hooks = {},
} = {}) {
  ensureCoordinator(coordinator);
  const input = parseCutoverInput(rawInput);
  const storage = await openReportStorage(reportDirectory);
  return withCutoverLock(storage, input.cutoverId, async () => {
    if (await pathExists(storage.fs, reportStoragePath(storage, input.cutoverId, '.rollback.json'))) {
      fail('CUTOVER_ALREADY_ROLLED_BACK', 'This cutover attempt was rolled back; start a new cutover ID.');
    }
    const selector = await readReleaseAuthoritySelector(store);
    if (!['SHADOW', 'DRAINING'].includes(selector.phase) || selector.activationEpoch !== 0) {
      fail('CUTOVER_PHASE_INVALID', `Prepare requires SHADOW or DRAINING; found ${selector.phase}.`);
    }
    validateStore(store, input);
    const gate = await admissionGate.read();
    if (gate.state === 'CLOSED' && gate.cutoverId !== input.cutoverId) {
      fail('CUTOVER_ADMISSION_OWNED', `Admission is closed by ${gate.cutoverId}.`);
    }
    let checkpoint = await initializeCheckpoint(storage, input, selector, gate, clock);
    if (legacyAuthorityFence) {
      const legacyFence = await legacyAuthorityFence.read();
      if (legacyFence.state === 'OPEN') {
        await legacyAuthorityFence.close(legacyFence.digest, input.cutoverId);
      } else if (legacyFence.state !== 'CLOSED' || legacyFence.cutoverId !== input.cutoverId) {
        fail('CUTOVER_LEGACY_FENCE_CONFLICT', 'Legacy authority fence is not owned by this pre-activation cutover.');
      }
    }
    let closed = gate;
    if (closed.state === 'OPEN') {
      closed = await admissionGate.close(closed.digest, input.cutoverId);
      checkpoint = await writeCheckpoint(storage, {
        ...checkpoint, status: 'ADMISSION_CLOSED', admissionCurrent: closed, updatedAt: timestamp(clock),
      });
      await hooks.afterAdmissionClosed?.(clone(closed));
    }
    let draining = selector;
    if (draining.phase === 'SHADOW') {
      draining = await transitionReleaseAuthority(store, coordinator, {
        expectedSelectorDigest: draining.digest,
        phase: 'DRAINING',
        buildIdentity: input.buildIdentity,
      });
      await hooks.afterDraining?.(clone(draining));
    }
    checkpoint = await writeCheckpoint(storage, {
      ...checkpoint,
      status: 'DRAINING',
      selectorCurrent: draining,
      admissionCurrent: closed,
      updatedAt: timestamp(clock),
    });
    return Object.freeze({
      status: checkpoint.status,
      cutoverId: input.cutoverId,
      inputDigest: input.digest,
      admissionGate: clone(closed),
      selector: clone(draining),
    });
  });
}

function reportBody({ input, checkpoint, selectorAfter, admissionGate, observation, store, completedAt }) {
  return {
    schemaVersion: 1,
    kind: 'release-authority-cutover-report',
    cutoverId: input.cutoverId,
    status: 'ACTIVE_ADMISSION_CLOSED',
    completedAt,
    inputDigest: input.digest,
    shadowValidationDigest: input.shadowReport.digest,
    shadowMatrixDigest: input.shadowReport.matrixDigest,
    selectorBefore: checkpoint.selectorBefore,
    selectorAfter,
    admissionGateBefore: checkpoint.admissionBefore,
    admissionGateAfter: admissionGate,
    drainObservation: observation,
    storeBefore: input.expectedStore,
    storeAfter: clone(store.manifest),
    rollbackBuildIdentity: input.rollbackBuildIdentity,
    preconditions: {
      activeLegacyAuthoritativeRuns: observation.activeLegacyAuthoritativeRunIds.length,
      releaseChangingMutations: observation.releaseChangingMutationIds.length,
      unresolvedOperations: observation.unresolvedOperationIds.length,
      unfencedLegacyLeases: observation.unfencedLegacyLeaseIds.length,
      singletonCanonicalWriter: observation.canonicalWriterOwnerIds.length === 1,
      unexplainedAuthorityDrift: input.shadowReport.summary.unexplainedDrift,
      shadowValidationStatus: input.shadowReport.validationStatus,
      backupRehearsed: input.expectedStore.backupMarker !== null,
      rollbackBuildPrequalified: true,
    },
    operatorReview: input.operatorReview,
  };
}

function parseFinalReport(value, input) {
  parseSealed(value, 'Cutover report');
  if (value.kind !== 'release-authority-cutover-report' || value.cutoverId !== input.cutoverId
    || value.inputDigest !== input.digest || value.status !== 'ACTIVE_ADMISSION_CLOSED') {
    fail('CUTOVER_REPORT_CONFLICT', 'Existing cutover report does not match this request.');
  }
  return clone(value);
}

export async function activateSharedAuthorityCutover({
  store, coordinator, admissionGate, legacyAuthorityFence = null, reportDirectory, input: rawInput, drainObservation,
  clock = store?.clock ?? (() => Date.now()), hooks = {},
} = {}) {
  ensureCoordinator(coordinator);
  const input = parseCutoverInput(rawInput);
  const storage = await openReportStorage(reportDirectory);
  return withCutoverLock(storage, input.cutoverId, async () => {
    if (await pathExists(storage.fs, reportStoragePath(storage, input.cutoverId, '.rollback.json'))) {
      fail('CUTOVER_ALREADY_ROLLED_BACK', 'This cutover attempt was rolled back and cannot activate.');
    }
    const reportPath = reportStoragePath(storage, input.cutoverId, '.json');
    if (await pathExists(storage.fs, reportPath)) {
      return parseFinalReport(await readBoundedJson(storage, reportPath, { label: 'cutover report', maximumBytes: 4 * 1_048_576 }), input);
    }
    let selector = await readReleaseAuthoritySelector(store);
    if (!['DRAINING', 'ACTIVE'].includes(selector.phase)) {
      fail('CUTOVER_PHASE_INVALID', `Activation requires DRAINING or a resumable ACTIVE selector; found ${selector.phase}.`);
    }
    validateStore(store, input, { activated: selector.phase === 'ACTIVE' });
    const gate = await admissionGate.read();
    if (gate.state !== 'CLOSED' || gate.cutoverId !== input.cutoverId) {
      fail('CUTOVER_ADMISSION_OPEN', 'Activation requires admission closed by this cutover.');
    }
    let checkpoint = await readCheckpoint(storage, input);
    if (!checkpoint) fail('CUTOVER_CHECKPOINT_MISSING', 'Prepare must complete before activation.');
    let observed = checkpoint.drainObservation;
    if (selector.phase !== 'ACTIVE') {
      observed = parseDrainObservation(drainObservation, { input, gate, coordinator, clock });
      checkpoint = await writeCheckpoint(storage, {
        ...checkpoint,
        status: 'DRAINING',
        selectorCurrent: selector,
        admissionCurrent: gate,
        drainObservation: observed,
        updatedAt: timestamp(clock),
      });
      if (legacyAuthorityFence) {
        const legacyFence = await legacyAuthorityFence.read();
        if (legacyFence.state === 'CLOSED' && legacyFence.cutoverId === input.cutoverId) {
          await legacyAuthorityFence.freeze(legacyFence.digest, input.cutoverId);
        } else if (legacyFence.state !== 'FROZEN' || legacyFence.cutoverId !== input.cutoverId) {
          fail('CUTOVER_LEGACY_FENCE_CONFLICT', 'Legacy authority fence must be frozen after the clean drain observation.');
        }
      }
      selector = await transitionReleaseAuthority(store, coordinator, {
        expectedSelectorDigest: selector.digest,
        phase: 'ACTIVE',
        activationRevision: input.activationRevision,
        buildIdentity: input.buildIdentity,
      });
      await hooks.afterAuthorityActivated?.(clone(selector));
    } else {
      if (selector.activationRevision !== input.activationRevision || selector.activeBuildIdentity !== input.buildIdentity) {
        fail('CUTOVER_ACTIVATION_MISMATCH', 'Durable activation does not match this cutover request.');
      }
      if (observed === null) fail('CUTOVER_OBSERVATION_MISSING', 'Recovered activation is missing its pre-activation drain observation.');
      observed = parseDrainObservation(observed, { input, gate, coordinator, clock: () => Date.parse(observed.observedAt) });
    }
    validateStore(store, input, { activated: true });
    if (legacyAuthorityFence) {
      const legacyFence = await legacyAuthorityFence.read();
      if (legacyFence.state === 'FROZEN' && legacyFence.cutoverId === input.cutoverId) {
        await legacyAuthorityFence.activate(legacyFence.digest, input.cutoverId, selector.activationEpoch);
      } else if (legacyFence.state !== 'ACTIVATED' || legacyFence.cutoverId !== input.cutoverId
        || legacyFence.activationEpoch !== selector.activationEpoch) {
        fail('CUTOVER_LEGACY_FENCE_CONFLICT', 'Legacy authority fence does not match activated shared authority.');
      }
    }
    checkpoint = await writeCheckpoint(storage, {
      ...checkpoint,
      status: 'ACTIVE',
      selectorCurrent: selector,
      admissionCurrent: gate,
      drainObservation: observed,
      updatedAt: timestamp(clock),
    });
    const report = seal(reportBody({
      input, checkpoint, selectorAfter: selector, admissionGate: gate,
      observation: observed, store, completedAt: timestamp(clock),
    }));
    await atomicWriteJson(storage, reportPath, report, { exclusive: true });
    return clone(report);
  });
}

const CUTOVER_CANARY_MODES = Object.freeze(['single-site', 'comparative']);

async function defaultReadCanaryEvidence(store, runId) {
  const [state, publication] = await Promise.all([
    readParentRun(store, runId),
    readCurrentEnvelope(store, runId),
  ]);
  return {
    mode: state.finalSubject?.mode,
    finalSubjectDigest: state.finalSubjectDigest,
    publicationDigest: publication.digest,
    decisionCode: publication.decision?.code,
    decisionRevision: publication.decisionRevision,
  };
}

function parseCanaryEvidence(value, { mode, runId }) {
  if (!isRecord(value) || value.mode !== mode || value.decisionCode !== 'RELEASE_READY'
    || !Number.isSafeInteger(value.decisionRevision) || value.decisionRevision < 1) {
    fail('CUTOVER_CANARY_NOT_READY', `${mode} canary ${runId} is not a full current ready publication.`);
  }
  assertDigest(value.finalSubjectDigest, 'Canary finalSubjectDigest');
  assertDigest(value.publicationDigest, 'Canary publicationDigest');
  return {
    mode, runId,
    finalSubjectDigest: value.finalSubjectDigest,
    publicationDigest: value.publicationDigest,
    decisionCode: value.decisionCode,
    decisionRevision: value.decisionRevision,
  };
}

function canaryHeadBody(value) {
  return {
    schemaVersion: 1,
    kind: 'release-cutover-canary-head',
    cutoverId: value.cutoverId,
    revision: value.revision,
    previousDigest: value.previousDigest,
    receipts: value.receipts,
    updatedAt: value.updatedAt,
  };
}

function parseCanaryHead(value, cutoverId) {
  parseSealed(value, 'Cutover canary head');
  exactKeys(value, [...Object.keys(canaryHeadBody(value)), 'digest'], 'Cutover canary head');
  if (value.schemaVersion !== 1 || value.kind !== 'release-cutover-canary-head'
    || value.cutoverId !== cutoverId || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.previousDigest !== null && typeof value.previousDigest !== 'string') || !isRecord(value.receipts)) {
    fail('CUTOVER_DOCUMENT_INVALID', 'Cutover canary head is invalid.');
  }
  if (value.previousDigest !== null) assertDigest(value.previousDigest, 'Cutover canary head previousDigest');
  exactKeys(value.receipts, CUTOVER_CANARY_MODES, 'Cutover canary receipts');
  for (const mode of CUTOVER_CANARY_MODES) {
    const receipt = value.receipts[mode];
    if (receipt === null) continue;
    if (!isRecord(receipt) || receipt.mode !== mode || typeof receipt.runId !== 'string'
      || !SAFE_ID.test(receipt.runId) || receipt.decisionCode !== 'RELEASE_READY'
      || !Number.isSafeInteger(receipt.decisionRevision) || receipt.decisionRevision < 1) {
      fail('CUTOVER_DOCUMENT_INVALID', `Cutover ${mode} canary receipt is invalid.`);
    }
    assertDigest(receipt.finalSubjectDigest, `Cutover ${mode} canary finalSubjectDigest`);
    assertDigest(receipt.publicationDigest, `Cutover ${mode} canary publicationDigest`);
    assertDigest(receipt.receiptDigest, `Cutover ${mode} canary receiptDigest`);
    assertDigest(receipt.admissionGateDigest, `Cutover ${mode} canary admissionGateDigest`);
  }
  return clone(value);
}

async function readCanaryHead(storage, cutoverId) {
  const file = reportStoragePath(storage, cutoverId, '.canaries.head.json');
  if (!await pathExists(storage.fs, file)) return null;
  return parseCanaryHead(await readBoundedJson(storage, file, {
    label: 'cutover canary head', maximumBytes: 256 * 1_024,
  }), cutoverId);
}

function assertActivatedCutover(selector, gate, cutoverId) {
  if (selector.phase !== 'ACTIVE' || selector.activationEpoch !== 1) {
    fail('CUTOVER_PHASE_INVALID', 'Canaries require active shared authority.');
  }
  if (gate.state !== 'CLOSED' || gate.cutoverId !== cutoverId) {
    fail('CUTOVER_ADMISSION_OPEN', 'Canaries require admission closed by this cutover.');
  }
}

export async function recordSharedCutoverCanary({
  store, admissionGate, reportDirectory, cutoverId, mode, runId,
  readCanaryEvidence = defaultReadCanaryEvidence,
  clock = store?.clock ?? (() => Date.now()),
} = {}) {
  safeId(cutoverId, 'cutoverId');
  safeId(runId, 'runId');
  if (!CUTOVER_CANARY_MODES.includes(mode)) fail('CUTOVER_INPUT_INVALID', 'Canary mode is invalid.');
  const storage = await openReportStorage(reportDirectory);
  return withCutoverLock(storage, cutoverId, async () => {
    const [selector, gate] = await Promise.all([
      readReleaseAuthoritySelector(store), admissionGate.read(),
    ]);
    assertActivatedCutover(selector, gate, cutoverId);
    const evidence = parseCanaryEvidence(await readCanaryEvidence(store, runId), { mode, runId });
    const current = await readCanaryHead(storage, cutoverId);
    const prior = current?.receipts[mode];
    if (prior && prior.runId === evidence.runId
      && prior.finalSubjectDigest === evidence.finalSubjectDigest
      && prior.publicationDigest === evidence.publicationDigest
      && prior.decisionRevision === evidence.decisionRevision) return clone(current);
    const receiptBody = {
      schemaVersion: 1,
      kind: 'release-cutover-canary-receipt',
      cutoverId,
      ...evidence,
      authoritySelectorDigest: selector.digest,
      admissionGateDigest: gate.digest,
      recordedAt: timestamp(clock),
    };
    const receipt = seal(receiptBody);
    const receiptDirectory = reportStoragePath(storage, cutoverId, '.canaries');
    await storage.fs.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    const receiptPath = containedPath(receiptDirectory, `${receipt.digest.slice(7)}.json`);
    if (!await pathExists(storage.fs, receiptPath)) {
      await atomicWriteJson(storage, receiptPath, receipt, { exclusive: true });
    }
    const summarized = { ...evidence, receiptDigest: receipt.digest, admissionGateDigest: gate.digest };
    const next = seal(canaryHeadBody({
      cutoverId,
      revision: (current?.revision ?? 0) + 1,
      previousDigest: current?.digest ?? null,
      receipts: {
        'single-site': current?.receipts['single-site'] ?? null,
        comparative: current?.receipts.comparative ?? null,
        [mode]: summarized,
      },
      updatedAt: timestamp(clock),
    }));
    await atomicWriteJson(storage, reportStoragePath(storage, cutoverId, '.canaries.head.json'), next);
    return clone(next);
  });
}

export async function reopenSharedAdmissionAfterCanaries({
  store, admissionGate, reportDirectory, cutoverId,
  readCanaryEvidence = defaultReadCanaryEvidence,
  clock = store?.clock ?? (() => Date.now()),
  hooks = {},
} = {}) {
  safeId(cutoverId, 'cutoverId');
  const storage = await openReportStorage(reportDirectory);
  return withCutoverLock(storage, cutoverId, async () => {
    const reportPath = reportStoragePath(storage, cutoverId, '.reopen.json');
    if (await pathExists(storage.fs, reportPath)) {
      return parseSealed(await readBoundedJson(storage, reportPath, {
        label: 'cutover reopen report', maximumBytes: 256 * 1_024,
      }), 'Cutover reopen report');
    }
    const [selector, gate, canaries] = await Promise.all([
      readReleaseAuthoritySelector(store), admissionGate.read(), readCanaryHead(storage, cutoverId),
    ]);
    if (selector.phase !== 'ACTIVE' || selector.activationEpoch !== 1) {
      fail('CUTOVER_PHASE_INVALID', 'Canary reopen requires active shared authority.');
    }
    const recoveringOpen = gate.state === 'OPEN';
    if (!recoveringOpen && (gate.state !== 'CLOSED' || gate.cutoverId !== cutoverId)) {
      fail('CUTOVER_ADMISSION_OPEN', 'Canary reopen requires admission closed by this cutover.');
    }
    if (!canaries || CUTOVER_CANARY_MODES.some((mode) => canaries.receipts[mode] === null)) {
      fail('CUTOVER_CANARIES_INCOMPLETE', 'Admission requires current ready Single-site and Comparative canaries.');
    }
    if (recoveringOpen && CUTOVER_CANARY_MODES.some(
      (mode) => canaries.receipts[mode].admissionGateDigest !== gate.previousDigest,
    )) {
      fail('CUTOVER_ADMISSION_RECOVERY_INVALID', 'Open admission is not chained to the canary-validated closed gate.');
    }
    for (const mode of CUTOVER_CANARY_MODES) {
      const receipt = canaries.receipts[mode];
      const current = parseCanaryEvidence(await readCanaryEvidence(store, receipt.runId), {
        mode, runId: receipt.runId,
      });
      if (current.finalSubjectDigest !== receipt.finalSubjectDigest
        || current.publicationDigest !== receipt.publicationDigest
        || current.decisionRevision !== receipt.decisionRevision) {
        fail('CUTOVER_CANARY_STALE', `${mode} canary changed after it was recorded.`);
      }
    }
    const opened = recoveringOpen ? gate : await admissionGate.open(gate.digest, cutoverId);
    await hooks.afterAdmissionOpened?.(clone(opened));
    const report = seal({
      schemaVersion: 1,
      kind: 'release-authority-cutover-reopen-report',
      cutoverId,
      status: 'ACTIVE_ADMISSION_OPEN',
      selector,
      canaryHead: canaries,
      admissionGateBefore: recoveringOpen ? { recoveredPreviousDigest: gate.previousDigest } : gate,
      admissionGateAfter: opened,
      completedAt: timestamp(clock),
    });
    await atomicWriteJson(storage, reportPath, report, { exclusive: true });
    return clone(report);
  });
}

function rollbackReportBody({ cutoverId, selectorBefore, selectorAfter, gateBefore, gateAfter, operatorReview, completedAt }) {
  return {
    schemaVersion: 1,
    kind: 'release-authority-cutover-rollback-report',
    cutoverId,
    status: 'PREACTIVATION_ROLLED_BACK',
    completedAt,
    selectorBefore,
    selectorAfter,
    admissionGateBefore: gateBefore,
    admissionGateAfter: gateAfter,
    operatorReview,
  };
}

export async function rollbackSharedAuthorityBeforeActivation({
  store, coordinator, admissionGate, legacyAuthorityFence = null, reportDirectory, cutoverId, buildIdentity,
  operatorReview: rawOperatorReview, clock = store?.clock ?? (() => Date.now()),
} = {}) {
  ensureCoordinator(coordinator);
  safeId(cutoverId, 'cutoverId');
  nonEmptyString(buildIdentity, 'buildIdentity');
  const operatorReview = parseOperatorReview(rawOperatorReview);
  const storage = await openReportStorage(reportDirectory);
  return withCutoverLock(storage, cutoverId, async () => {
    const selectorBefore = await readReleaseAuthoritySelector(store);
    if (!['DRAINING', 'SHADOW'].includes(selectorBefore.phase) || selectorBefore.activationEpoch !== 0) {
      fail('AUTHORITY_TRANSITION_INVALID', 'Pre-activation rollback is allowed only from DRAINING before activation.');
    }
    const gateBefore = await admissionGate.read();
    if (gateBefore.state !== 'CLOSED' || gateBefore.cutoverId !== cutoverId) {
      fail('CUTOVER_ADMISSION_OPEN', 'Pre-activation rollback requires this cutover to own the closed gate.');
    }
    const legacyFenceBefore = legacyAuthorityFence ? await legacyAuthorityFence.read() : null;
    if (legacyFenceBefore
      && (!['CLOSED', 'FROZEN'].includes(legacyFenceBefore.state) || legacyFenceBefore.cutoverId !== cutoverId)) {
      fail('CUTOVER_LEGACY_FENCE_CONFLICT', 'Pre-activation rollback does not own the legacy authority fence.');
    }
    const selectorAfter = selectorBefore.phase === 'SHADOW' ? selectorBefore : await transitionReleaseAuthority(
      store, coordinator, {
        expectedSelectorDigest: selectorBefore.digest,
        phase: 'SHADOW',
        buildIdentity,
      },
    );
    if (legacyFenceBefore) {
      await legacyAuthorityFence.reopenPreActivation(legacyFenceBefore.digest, cutoverId);
    }
    const gateAfter = await admissionGate.open(gateBefore.digest, cutoverId);
    const report = seal(rollbackReportBody({
      cutoverId, selectorBefore, selectorAfter, gateBefore, gateAfter,
      operatorReview, completedAt: timestamp(clock),
    }));
    await atomicWriteJson(storage, reportStoragePath(storage, cutoverId, '.rollback.json'), report);
    return clone(report);
  });
}

export async function setSharedPromotionAvailability({ store, coordinator, phase, buildIdentity } = {}) {
  ensureCoordinator(coordinator);
  if (!['ACTIVE', 'PROMOTION_DISABLED'].includes(phase)) {
    fail('CUTOVER_INPUT_INVALID', 'Post-activation authority may only be ACTIVE or PROMOTION_DISABLED.');
  }
  const selector = await readReleaseAuthoritySelector(store);
  if (selector.activationEpoch !== 1 || !['ACTIVE', 'PROMOTION_DISABLED'].includes(selector.phase)) {
    fail('AUTHORITY_TRANSITION_INVALID', 'Promotion availability can change only after shared activation.');
  }
  if (!selector.prequalifiedRollbackBuilds.includes(buildIdentity) || store.buildIdentity !== buildIdentity) {
    fail('CUTOVER_ROLLBACK_BUILD_UNQUALIFIED', 'Post-activation operation requires the exact opened prequalified build.');
  }
  return transitionReleaseAuthority(store, coordinator, {
    expectedSelectorDigest: selector.digest,
    phase,
    activationRevision: selector.activationRevision,
    buildIdentity,
  });
}
