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
import { parseRunContract } from '../../shared/run-contract.mjs';
import {
  probeTargetPreflightSet,
  targetPreflightInputsForRunContract,
} from '../../shared/target-preflight-set.mjs';
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
  authorizeCutoverCanaryRunSupersession,
  beginReleaseAuthorityBuildHandoff,
  completeReleaseAuthorityBuildHandoffWithPublicationFence,
  listParentRunIds,
  prequalifyReleaseAuthorityBuild,
  readCurrentEnvelope,
  readParentRun,
  readStorePerformanceScheduler,
  readStoreCoordinator,
  readReleaseAuthoritySelector,
  registerReleaseAuthorityHandoffCanaryRun,
  transitionReleaseAuthority,
  transitionReleaseAuthorityWithPublicationFence,
} from './parent-run-store.mjs';
import { listRecoverableSharedLaunchOperations } from './shared-launch-operation-store.mjs';
import { inspectLegacyAuthorityDrainSources } from './legacy-authority-drain-source.mjs';
import {
  parseSharedStoreBackupRehearsalReceipt,
  verifySharedStoreBackupRehearsal,
} from './shared-store-backup-rehearsal.mjs';

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_OBSERVATION_AGE_MS = 5 * 60_000;
const MAX_BACKUP_REHEARSAL_AGE_MS = 60 * 60_000;
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

  async function withState(operation) {
    if (typeof operation !== 'function') fail('CUTOVER_INPUT_INVALID', 'Admission operation is required.');
    return withDirectoryLock(storage, lockPath, async () => {
      const current = await read();
      return operation(current);
    });
  }

  async function withOpen(operation) {
    return withState((current) => {
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
    withState,
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

const CUTOVER_CANARY_MODES = Object.freeze(['single-site', 'comparative']);
const MAX_CUTOVER_CANARY_FAILURE_ATTEMPTS_PER_MODE = 3;
const MAX_CUTOVER_CANARY_PERMIT_HISTORY = 64;

function requestIdentity(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(value)) {
    fail('CUTOVER_INPUT_INVALID', 'Canary requestId is invalid.');
  }
  return value;
}

function parseCanaryActor(value) {
  if (!isRecord(value)) fail('CUTOVER_INPUT_INVALID', 'Canary launch actor is required.');
  exactKeys(value, ['id', 'kind'], 'canary launch actor');
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.id)
    || !['human', 'service'].includes(value.kind)) {
    fail('CUTOVER_INPUT_INVALID', 'Canary launch actor is invalid.');
  }
  return Object.freeze({ id: value.id, kind: value.kind });
}

function parseCanaryIntent(value, mode) {
  if (!isRecord(value)) fail('CUTOVER_INPUT_INVALID', 'Canary launch intent is required.');
  exactKeys(value, ['schemaVersion', 'runContract'], 'canary launch intent');
  if (value.schemaVersion !== 1) fail('CUTOVER_INPUT_INVALID', 'Canary launch intent schemaVersion is invalid.');
  let runContract;
  try { runContract = parseRunContract(value.runContract); } catch (error) {
    fail('CUTOVER_INPUT_INVALID', `Canary run contract is invalid: ${error.message}`);
  }
  if (runContract.mode !== mode || runContract.scope.qualifier !== 'FULL') {
    fail('CUTOVER_CANARY_LAUNCH_MISMATCH', 'Cutover canaries require the exact requested mode and FULL authority.');
  }
  return Object.freeze({ schemaVersion: 1, runContract });
}

function cutoverStoreBinding(store) {
  const manifest = store?.manifest;
  if (!isRecord(manifest)) fail('CUTOVER_STORE_MISMATCH', 'Canary launch requires the opened canonical store.');
  return Object.freeze({
    deploymentIdentity: manifest.deploymentIdentity,
    volumeIdentity: manifest.volumeIdentity,
    storeMarkerDigest: manifest.storeMarkerDigest,
    storeGeneration: manifest.storeGeneration,
    schemaVersion: manifest.schemaVersion,
    schemaFloor: manifest.schemaFloor,
    writerProtocol: manifest.currentWriterProtocol,
    buildIdentity: store.buildIdentity,
    digest: canonicalDigest({
      deploymentIdentity: manifest.deploymentIdentity,
      volumeIdentity: manifest.volumeIdentity,
      storeMarkerDigest: manifest.storeMarkerDigest,
      storeGeneration: manifest.storeGeneration,
      schemaVersion: manifest.schemaVersion,
      schemaFloor: manifest.schemaFloor,
      writerProtocol: manifest.currentWriterProtocol,
      buildIdentity: store.buildIdentity,
    }),
  });
}

function parseTrustedTargetIdentity(value, label) {
  if (!isRecord(value)) fail('CUTOVER_CANARY_TARGET_MISMATCH', `${label} is missing.`);
  exactKeys(value, ['kind', 'value'], label);
  if (value.kind !== 'target-preflight-set') fail('CUTOVER_CANARY_TARGET_MISMATCH', `${label} kind is invalid.`);
  assertDigest(value.value, `${label}.value`);
  return clone(value);
}

function canaryLaunchPermitPath(root, cutoverId, mode) {
  return containedPath(root, `cutover-canary-${safeId(cutoverId, 'cutoverId')}-${mode}.json`);
}

function canaryLaunchPermitHistoryPath(root, permitDigest) {
  assertDigest(permitDigest, 'Cutover canary permit history digest');
  return containedPath(root, 'cutover-canary-permits', `${permitDigest.slice('sha256:'.length)}.json`);
}

function canaryLaunchPermitBody(value) {
  const body = {
    schemaVersion: 1,
    kind: 'release-cutover-canary-launch-permit',
    cutoverId: value.cutoverId,
    mode: value.mode,
    revision: value.revision,
    previousPermitDigest: value.previousPermitDigest,
    requestId: value.requestId,
    actor: value.actor,
    intentDigest: value.intentDigest,
    authoritySelectorDigest: value.authoritySelectorDigest,
    admissionGateDigest: value.admissionGateDigest,
    cutoverReportDigest: value.cutoverReportDigest,
    activeBuildIdentity: value.activeBuildIdentity,
    cutoverConfigurationDigest: value.cutoverConfigurationDigest,
    storeBindingDigest: value.storeBindingDigest,
    targetIdentity: value.targetIdentity,
    authorizedRunId: value.authorizedRunId,
    supersedesRunId: value.supersedesRunId,
    supersedeReason: value.supersedeReason,
    state: value.state,
    runId: value.runId,
    operationId: value.operationId,
    runRunnerRevision: value.runRunnerRevision,
    runConfigurationRevision: value.runConfigurationRevision,
    authorizedAt: value.authorizedAt,
    consumedAt: value.consumedAt,
  };
  if (Object.hasOwn(value, 'failureAttempts')) body.failureAttempts = value.failureAttempts;
  return body;
}

function cutoverCanarySupersessionAuthorizationDigest(permit) {
  return canonicalDigest({
    schemaVersion: 1,
    kind: 'release-cutover-canary-supersession-authorization',
    cutoverId: permit.cutoverId,
    mode: permit.mode,
    replacementRevision: permit.revision,
    sourcePermitDigest: permit.previousPermitDigest,
    requestId: permit.requestId,
    actor: permit.actor,
    intentDigest: permit.intentDigest,
    authoritySelectorDigest: permit.authoritySelectorDigest,
    targetIdentity: permit.targetIdentity,
    supersedeReason: permit.supersedeReason,
  });
}

async function ensureOrdinaryCutoverCanarySupersessionFence(store, permit) {
  if (permit.revision === 1) return null;
  return authorizeCutoverCanaryRunSupersession(store, {
    expectedSelectorDigest: permit.authoritySelectorDigest,
    cutoverId: permit.cutoverId,
    mode: permit.mode,
    runId: permit.supersedesRunId,
    replacementRevision: permit.revision,
    sourcePermitDigest: permit.previousPermitDigest,
    requestId: permit.requestId,
    authorizationDigest: cutoverCanarySupersessionAuthorizationDigest(permit),
    supersedeReason: permit.supersedeReason,
  });
}

function parseCanaryLaunchPermit(value, { cutoverId = null, mode = null } = {}) {
  parseSealed(value, 'Cutover canary launch permit');
  exactKeys(value, [...Object.keys(canaryLaunchPermitBody(value)), 'digest'], 'Cutover canary launch permit');
  if (value.schemaVersion !== 1 || value.kind !== 'release-cutover-canary-launch-permit'
    || !CUTOVER_CANARY_MODES.includes(value.mode) || (cutoverId !== null && value.cutoverId !== cutoverId)
    || (mode !== null && value.mode !== mode) || !SAFE_ID.test(value.cutoverId)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || value.revision > MAX_CUTOVER_CANARY_PERMIT_HISTORY) {
    fail('CUTOVER_DOCUMENT_INVALID', 'Cutover canary launch permit identity is invalid.');
  }
  if (value.previousPermitDigest !== null) assertDigest(value.previousPermitDigest, 'Cutover canary previousPermitDigest');
  if ((value.revision === 1) !== (value.previousPermitDigest === null)) {
    fail('CUTOVER_DOCUMENT_INVALID', 'Cutover canary permit revision chain is invalid.');
  }
  if (Object.hasOwn(value, 'failureAttempts')
    && (!Number.isSafeInteger(value.failureAttempts) || value.failureAttempts < 0
      || value.failureAttempts > MAX_CUTOVER_CANARY_FAILURE_ATTEMPTS_PER_MODE)) {
    fail('CUTOVER_DOCUMENT_INVALID', 'Cutover canary failure-attempt count is invalid.');
  }
  requestIdentity(value.requestId);
  parseCanaryActor(value.actor);
  for (const [key, digest] of Object.entries({
    intentDigest: value.intentDigest,
    authoritySelectorDigest: value.authoritySelectorDigest,
    admissionGateDigest: value.admissionGateDigest,
    cutoverReportDigest: value.cutoverReportDigest,
    cutoverConfigurationDigest: value.cutoverConfigurationDigest,
    storeBindingDigest: value.storeBindingDigest,
  })) assertDigest(digest, `Cutover canary permit ${key}`);
  nonEmptyString(value.activeBuildIdentity, 'Cutover canary permit activeBuildIdentity');
  parseTrustedTargetIdentity(value.targetIdentity, 'Cutover canary target identity');
  if (value.authorizedRunId !== null) safeId(value.authorizedRunId, 'Cutover canary authorizedRunId');
  if (value.revision === 1) {
    if (value.supersedesRunId !== null || value.supersedeReason !== null) {
      fail('CUTOVER_DOCUMENT_INVALID', 'Initial cutover canary permit cannot supersede a run.');
    }
  } else {
    safeId(value.supersedesRunId, 'Cutover canary supersedesRunId');
    nonEmptyString(value.supersedeReason, 'Cutover canary supersedeReason');
  }
  canonicalTimestamp(value.authorizedAt, 'Cutover canary authorizedAt');
  if (!['AUTHORIZED', 'CONSUMED'].includes(value.state)) fail('CUTOVER_DOCUMENT_INVALID', 'Cutover canary permit state is invalid.');
  if (value.state === 'AUTHORIZED') {
    if (value.runId !== null || value.operationId !== null || value.runRunnerRevision !== null
      || value.runConfigurationRevision !== null || value.consumedAt !== null) {
      fail('CUTOVER_DOCUMENT_INVALID', 'Unconsumed canary permit contains launch output.');
    }
  } else {
    safeId(value.runId, 'Cutover canary runId');
    if (value.authorizedRunId !== null && value.runId !== value.authorizedRunId) {
      fail('CUTOVER_DOCUMENT_INVALID', 'Consumed canary run does not match its pre-authorized run identity.');
    }
    if (typeof value.operationId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.operationId)) {
      fail('CUTOVER_DOCUMENT_INVALID', 'Cutover canary operationId is invalid.');
    }
    assertDigest(value.runRunnerRevision, 'Cutover canary runRunnerRevision');
    assertDigest(value.runConfigurationRevision, 'Cutover canary runConfigurationRevision');
    canonicalTimestamp(value.consumedAt, 'Cutover canary consumedAt');
  }
  return clone(value);
}

async function readCanaryLaunchPermit(admissionGate, cutoverId, mode) {
  const storage = await openAtomicStorage({ root: admissionGate.root, verify: false });
  const file = canaryLaunchPermitPath(storage.root, cutoverId, mode);
  if (!await pathExists(storage.fs, file)) return null;
  return parseCanaryLaunchPermit(await readBoundedJson(storage, file, {
    label: 'cutover canary launch permit', maximumBytes: 256 * 1_024,
  }), { cutoverId, mode });
}

async function persistCanaryLaunchPermit(storage, permit) {
  const history = containedPath(storage.root, 'cutover-canary-permits');
  await storage.fs.mkdir(history, { recursive: true, mode: 0o700 });
  const immutable = canaryLaunchPermitHistoryPath(storage.root, permit.digest);
  const assertImmutableMatches = async () => {
    const existing = parseCanaryLaunchPermit(await readBoundedJson(storage, immutable, {
      label: 'cutover canary permit history', maximumBytes: 256 * 1_024,
    }), { cutoverId: permit.cutoverId, mode: permit.mode });
    if (canonicalJson(existing) !== canonicalJson(permit)) {
      fail('CUTOVER_DOCUMENT_INVALID', 'Immutable cutover canary permit digest was reused with different bytes.');
    }
  };
  if (await pathExists(storage.fs, immutable)) {
    await assertImmutableMatches();
  } else {
    try {
      await atomicWriteJson(storage, immutable, permit, { exclusive: true });
    } catch (error) {
      if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
      await assertImmutableMatches();
    }
  }
  await atomicWriteJson(storage, canaryLaunchPermitPath(storage.root, permit.cutoverId, permit.mode), permit);
}

function canaryRunConsumesFailureBudget(state) {
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

async function failureAttemptsAfterCanaryPermit(storage, store, permit, currentState) {
  if (Object.hasOwn(permit, 'failureAttempts')) {
    return permit.failureAttempts + (canaryRunConsumesFailureBudget(currentState) ? 1 : 0);
  }
  let cursor = permit;
  let state = currentState;
  let failures = 0;
  for (let depth = 0; depth < MAX_CUTOVER_CANARY_PERMIT_HISTORY; depth += 1) {
    if (cursor.state !== 'CONSUMED' || cursor.runId === null) {
      fail('CUTOVER_DOCUMENT_INVALID', 'Legacy canary permit history contains an unconsumed revision.');
    }
    if (canaryRunConsumesFailureBudget(state)) failures += 1;
    if (cursor.previousPermitDigest === null) return failures;
    const previous = parseCanaryLaunchPermit(await readBoundedJson(
      storage,
      canaryLaunchPermitHistoryPath(storage.root, cursor.previousPermitDigest),
      { label: 'cutover canary permit history', maximumBytes: 256 * 1_024 },
    ), { cutoverId: permit.cutoverId, mode: permit.mode });
    if (previous.digest !== cursor.previousPermitDigest || previous.revision !== cursor.revision - 1
      || cursor.supersedesRunId !== previous.runId) {
      fail('CUTOVER_DOCUMENT_INVALID', 'Cutover canary permit history lineage is invalid.');
    }
    cursor = previous;
    state = await readParentRun(store, cursor.runId);
  }
  fail('CUTOVER_DOCUMENT_INVALID', 'Cutover canary permit history exceeds the bounded recovery limit.');
}

async function assertCanaryPermitReplaceable(store, permit) {
  let state;
  try { state = await readParentRun(store, permit.runId); } catch (error) {
    fail('CUTOVER_CANARY_REPLACEMENT_BLOCKED', 'Failed canary replacement requires a durable terminal parent run.');
  }
  try {
    const publication = await readCurrentEnvelope(store, permit.runId);
    if (publication.decision?.ready === true) {
      fail('CUTOVER_CANARY_REPLACEMENT_BLOCKED', 'A current ready canary cannot be replaced.');
    }
  } catch (error) {
    if (error?.code !== 'PUBLICATION_UNAVAILABLE') throw error;
  }
  const workItems = Object.values(state.workItems ?? {});
  const terminal = workItems.length > 0 && workItems.every((item) => (
    ['completed_pass', 'completed_product_failure', 'cancelled', 'incomplete'].includes(item.state)
  ));
  if (!terminal) {
    fail('CUTOVER_CANARY_REPLACEMENT_BLOCKED', 'Canary replacement requires a terminal non-ready run.');
  }
  return state;
}

async function defaultProbeCanaryTargetIdentity(intent) {
  const contract = intent.runContract;
  const preflightOptions = contract.mode === 'single-site' && contract.certificatePolicy === 'preview-bypass'
    ? { previewBypassOrigins: [contract.url], tlsBypassRequestOptions: { rejectUnauthorized: false } }
    : {};
  return (await probeTargetPreflightSet(targetPreflightInputsForRunContract(contract), { preflightOptions })).identity;
}

export async function authorizeSharedCutoverCanaryLaunch({
  store, admissionGate, reportDirectory, cutoverId, mode, requestId, actor: rawActor, intent: rawIntent,
  supersedeReason = null,
  probeTargetIdentity = defaultProbeCanaryTargetIdentity,
  clock = store?.clock ?? (() => Date.now()),
  hooks = {},
} = {}) {
  safeId(cutoverId, 'cutoverId');
  if (!CUTOVER_CANARY_MODES.includes(mode)) fail('CUTOVER_INPUT_INVALID', 'Canary mode is invalid.');
  requestIdentity(requestId);
  const actor = parseCanaryActor(rawActor);
  const intent = parseCanaryIntent(rawIntent, mode);
  if (typeof probeTargetIdentity !== 'function') fail('CUTOVER_INPUT_INVALID', 'A trusted target probe is required.');
  const targetIdentity = parseTrustedTargetIdentity(
    await probeTargetIdentity(intent),
    'Trusted canary target identity',
  );
  const reportStorage = await openReportStorage(reportDirectory);
  const report = parseSealed(await readBoundedJson(
    reportStorage,
    reportStoragePath(reportStorage, cutoverId, '.json'),
    { label: 'cutover report', maximumBytes: 4 * 1_048_576 },
  ), 'Cutover report');
  if (report.kind !== 'release-authority-cutover-report' || report.cutoverId !== cutoverId
    || report.status !== 'ACTIVE_ADMISSION_CLOSED') {
    fail('CUTOVER_REPORT_CONFLICT', 'Canary launch requires this cutover active report.');
  }
  const storage = await openAtomicStorage({ root: admissionGate.root, verify: false });
  return admissionGate.withState(async (gate) => {
    const selector = await readReleaseAuthoritySelector(store);
    assertActivatedCutover(selector, gate, cutoverId);
    if (selector.digest !== report.selectorAfter?.digest || store.buildIdentity !== selector.activeBuildIdentity) {
      fail('CUTOVER_CANARY_LAUNCH_MISMATCH', 'Canary permit is not bound to the active cutover build and selector.');
    }
    const binding = cutoverStoreBinding(store);
    const file = canaryLaunchPermitPath(storage.root, cutoverId, mode);
    if (await pathExists(storage.fs, file)) {
      const existing = parseCanaryLaunchPermit(await readBoundedJson(storage, file, {
        label: 'cutover canary launch permit', maximumBytes: 256 * 1_024,
      }), { cutoverId, mode });
      if (existing.requestId === requestId && canonicalJson(existing.actor) === canonicalJson(actor)
        && existing.intentDigest === canonicalDigest(intent)
        && existing.supersedeReason === (existing.revision === 1 ? null : supersedeReason)
        && canonicalJson(existing.targetIdentity) === canonicalJson(targetIdentity)) {
        await ensureOrdinaryCutoverCanarySupersessionFence(store, existing);
        return existing;
      }
      if (existing.state !== 'CONSUMED') {
        fail('CUTOVER_CANARY_LAUNCH_CONFLICT', `A different ${mode} canary launch is already authorized.`);
      }
      if (existing.revision >= MAX_CUTOVER_CANARY_PERMIT_HISTORY) {
        fail('CUTOVER_CANARY_LAUNCH_CONFLICT', `The ${mode} canary permit history bound is exhausted.`);
      }
      nonEmptyString(supersedeReason, 'Canary supersedeReason');
      const replacedRun = await assertCanaryPermitReplaceable(store, existing);
      const failureAttempts = await failureAttemptsAfterCanaryPermit(storage, store, existing, replacedRun);
      if (failureAttempts >= MAX_CUTOVER_CANARY_FAILURE_ATTEMPTS_PER_MODE) {
        fail('CUTOVER_CANARY_LAUNCH_CONFLICT',
          `The ${mode} canary failure-recovery bound is exhausted; explicitly cancelled canaries do not consume this budget.`);
      }
      let replacement = seal(canaryLaunchPermitBody({
        ...existing,
        revision: existing.revision + 1,
        previousPermitDigest: existing.digest,
        requestId,
        actor,
        intentDigest: canonicalDigest(intent),
        targetIdentity: clone(targetIdentity),
        supersedesRunId: existing.runId,
        supersedeReason,
        failureAttempts,
        state: 'AUTHORIZED',
        runId: null,
        operationId: null,
        runRunnerRevision: null,
        runConfigurationRevision: null,
        authorizedAt: timestamp(clock),
        consumedAt: null,
      }));
      const supersessionFence = await ensureOrdinaryCutoverCanarySupersessionFence(store, replacement);
      replacement = seal(canaryLaunchPermitBody({
        ...replacement,
        authorizedAt: supersessionFence.fencedAt,
      }));
      await hooks.afterSupersessionFence?.(clone(supersessionFence));
      await persistCanaryLaunchPermit(storage, replacement);
      return clone(replacement);
    }
    const permit = seal(canaryLaunchPermitBody({
      cutoverId,
      mode,
      revision: 1,
      previousPermitDigest: null,
      requestId,
      actor,
      intentDigest: canonicalDigest(intent),
      authoritySelectorDigest: selector.digest,
      admissionGateDigest: gate.digest,
      cutoverReportDigest: report.digest,
      activeBuildIdentity: selector.activeBuildIdentity,
      cutoverConfigurationDigest: report.operatorReview?.configurationDigest,
      storeBindingDigest: binding.digest,
      targetIdentity: clone(targetIdentity),
      authorizedRunId: null,
      supersedesRunId: null,
      supersedeReason: null,
      failureAttempts: 0,
      state: 'AUTHORIZED',
      runId: null,
      operationId: null,
      runRunnerRevision: null,
      runConfigurationRevision: null,
      authorizedAt: timestamp(clock),
      consumedAt: null,
    }));
    assertDigest(permit.cutoverConfigurationDigest, 'Cutover report configurationDigest');
    await persistCanaryLaunchPermit(storage, permit);
    return clone(permit);
  });
}

export function createCutoverAdmissionPolicy({ admissionGate, store = null } = {}) {
  if (!admissionGate || typeof admissionGate.withOpen !== 'function' || typeof admissionGate.withState !== 'function') {
    fail('CUTOVER_ADMISSION_UNAVAILABLE', 'A durable release-admission gate is required.', undefined, 503);
  }
  return Object.freeze({
    withLaunchAdmission(requestId, intentOrOperation, maybeOperation) {
      const operation = maybeOperation ?? intentOrOperation;
      const intent = maybeOperation ? intentOrOperation : null;
      if (typeof operation !== 'function') fail('CUTOVER_INPUT_INVALID', 'Admission operation is required.');
      return admissionGate.withState(async (gate) => {
        if (gate.state === 'OPEN') return operation(gate);
        if (!store || intent === null) {
          fail('CUTOVER_ADMISSION_CLOSED', `Release admission is closed by ${gate.cutoverId}; retry after the cutover completes.`, {
            cutoverId: gate.cutoverId, gateDigest: gate.digest,
          }, 503);
        }
        requestIdentity(requestId);
        const mode = intent?.runContract?.mode;
        if (!CUTOVER_CANARY_MODES.includes(mode)) fail('CUTOVER_CANARY_LAUNCH_MISMATCH', 'Closed admission accepts only a cutover canary.');
        const normalizedIntent = parseCanaryIntent(intent, mode);
        const selector = await readReleaseAuthoritySelector(store);
        const buildHandoff = selector.phase === 'PROMOTION_DISABLED'
          && selector.handoffId === gate.cutoverId && selector.pendingBuildIdentity !== null;
        if (buildHandoff) {
          if (store.buildIdentity !== selector.pendingBuildIdentity) {
            fail('AUTHORITY_HANDOFF_INVALID', 'Only the pending target build may consume handoff canary admission.');
          }
        } else {
          assertActivatedCutover(selector, gate, gate.cutoverId);
        }
        const permit = await readCanaryLaunchPermit(admissionGate, gate.cutoverId, mode);
        const binding = cutoverStoreBinding(store);
        if (!permit) {
          fail('CUTOVER_ADMISSION_CLOSED', `Release admission is closed by ${gate.cutoverId}; no ${mode} canary permit is active.`, {
            cutoverId: gate.cutoverId, gateDigest: gate.digest,
          }, 503);
        }
        if (permit.requestId !== requestId || permit.intentDigest !== canonicalDigest(normalizedIntent)
          || permit.authoritySelectorDigest !== selector.digest || permit.admissionGateDigest !== gate.digest
          || permit.activeBuildIdentity !== (buildHandoff ? selector.pendingBuildIdentity : selector.activeBuildIdentity)
          || permit.activeBuildIdentity !== store.buildIdentity
          || permit.storeBindingDigest !== binding.digest) {
          fail('CUTOVER_CANARY_LAUNCH_MISMATCH', 'Closed-admission launch does not match the active cutover canary permit.');
        }
        if (buildHandoff) {
          safeId(permit.authorizedRunId, 'Handoff canary authorizedRunId');
          await registerReleaseAuthorityHandoffCanaryRun(store, null, {
            expectedSelectorDigest: selector.digest,
            handoffId: selector.handoffId,
            mode,
            runId: permit.authorizedRunId,
            supersedesRunId: permit.supersedesRunId,
            supersedeAuthorizationDigest: permit.supersedesRunId === null ? null : permit.digest,
          });
        }
        const launched = await operation(gate);
        const runnerRevision = launched?.compiledPlan?.createParentRunInput?.runnerRevision;
        const configurationRevision = launched?.compiledPlan?.createParentRunInput?.subjectCore?.revisions?.configuration;
        if (!isRecord(launched) || !SAFE_ID.test(launched.runId ?? '')
          || !/^[a-f0-9]{64}$/u.test(launched.operationId ?? '')) {
          fail('CUTOVER_CANARY_LAUNCH_MISMATCH', 'Canary launch returned an invalid durable operation identity.');
        }
        if (buildHandoff && launched.runId !== permit.authorizedRunId) {
          fail('CUTOVER_CANARY_LAUNCH_MISMATCH', 'Handoff canary launch returned a run other than its pre-authorized identity.');
        }
        if (!isRecord(launched.actor) || canonicalJson(launched.actor) !== canonicalJson(permit.actor)) {
          fail('CUTOVER_CANARY_LAUNCH_MISMATCH', 'Canary launch actor does not match its one-time permit.');
        }
        assertDigest(runnerRevision, 'Canary launch runner revision');
        assertDigest(configurationRevision, 'Canary launch configuration revision');
        if (permit.state === 'CONSUMED') {
          if (permit.runId !== launched.runId || permit.operationId !== launched.operationId
            || permit.runRunnerRevision !== runnerRevision
            || permit.runConfigurationRevision !== configurationRevision) {
            fail('CUTOVER_CANARY_LAUNCH_CONFLICT', 'Canary launch replay returned different immutable output.');
          }
          if (buildHandoff) {
            await registerReleaseAuthorityHandoffCanaryRun(store, null, {
              expectedSelectorDigest: selector.digest,
              handoffId: selector.handoffId,
              mode,
              runId: launched.runId,
              supersedesRunId: permit.supersedesRunId,
              supersedeAuthorizationDigest: permit.supersedesRunId === null ? null : permit.digest,
            });
          }
          return launched;
        }
        const consumed = seal(canaryLaunchPermitBody({
          ...permit,
          state: 'CONSUMED',
          runId: launched.runId,
          operationId: launched.operationId,
          runRunnerRevision: runnerRevision,
          runConfigurationRevision: configurationRevision,
          consumedAt: timestamp(store.clock ?? (() => Date.now())),
        }));
        const storage = await openAtomicStorage({ root: admissionGate.root, verify: false });
        await persistCanaryLaunchPermit(storage, consumed);
        if (buildHandoff) {
          await registerReleaseAuthorityHandoffCanaryRun(store, null, {
            expectedSelectorDigest: selector.digest,
            handoffId: selector.handoffId,
            mode,
            runId: launched.runId,
            supersedesRunId: permit.supersedesRunId,
            supersedeAuthorizationDigest: permit.supersedesRunId === null ? null : permit.digest,
          });
        }
        return launched;
      });
    },
    withPromotionAdmission(_requestId, operation) {
      return admissionGate.withOpen(operation);
    },
    withMutationAdmission(kind, _requestId, contextOrOperation, maybeOperation) {
      const operation = maybeOperation ?? contextOrOperation;
      const context = maybeOperation ? contextOrOperation : null;
      if (typeof operation !== 'function') fail('CUTOVER_INPUT_INVALID', 'Admission operation is required.');
      if (!RELEASE_CHANGING_MUTATIONS.has(kind)) return operation();
      if (kind !== 'cancel' || !store || !isRecord(context)) return admissionGate.withOpen(operation);
      return admissionGate.withState(async (gate) => {
        if (gate.state === 'OPEN') return operation(gate);
        const reject = () => fail(
          'CUTOVER_ADMISSION_CLOSED',
          `Release admission is closed by ${gate.cutoverId}; only its exact active canary may be cancelled for recovery.`,
          { cutoverId: gate.cutoverId, gateDigest: gate.digest },
          503,
        );
        if (!SAFE_ID.test(context.runId ?? '') || !SAFE_ID.test(gate.cutoverId ?? '')) return reject();
        const selector = await readReleaseAuthoritySelector(store);
        try {
          assertActivatedCutover(selector, gate, gate.cutoverId);
        } catch {
          return reject();
        }
        const permits = await Promise.all(CUTOVER_CANARY_MODES.map(
          (mode) => readCanaryLaunchPermit(admissionGate, gate.cutoverId, mode),
        ));
        const permit = permits.find((candidate) => candidate?.state === 'CONSUMED'
          && candidate.runId === context.runId);
        const binding = cutoverStoreBinding(store);
        if (!permit || permit.state !== 'CONSUMED' || permit.runId !== context.runId
          || permit.authoritySelectorDigest !== selector.digest || permit.admissionGateDigest !== gate.digest
          || permit.activeBuildIdentity !== selector.activeBuildIdentity
          || permit.activeBuildIdentity !== store.buildIdentity || permit.storeBindingDigest !== binding.digest) {
          return reject();
        }
        return operation(gate);
      });
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
  const [gate, selector, durableCoordinator, performanceScheduler, legacy, launchOperations, runIds] = await Promise.all([
    admissionGate.read(),
    readReleaseAuthoritySelector(store),
    readStoreCoordinator(store),
    readStorePerformanceScheduler(store),
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
    const preactivation = selector.phase === 'DRAINING' && selector.activationEpoch === 0;
    const postactivation = selector.phase === 'ACTIVE' && selector.activationEpoch === 1;
    if ((preactivation && (legacyFence.state !== 'CLOSED' || legacyFence.cutoverId !== cutoverId
      || legacyFence.activationEpoch !== 0))
      || (postactivation && (legacyFence.state !== 'ACTIVATED' || legacyFence.activationEpoch !== 1))
      || (!preactivation && !postactivation)) {
      fail('CUTOVER_LEGACY_FENCE_CONFLICT', 'Drain observation does not match the durable legacy-authority phase.');
    }
  }
  if (!((selector.phase === 'DRAINING' && selector.activationEpoch === 0)
    || (selector.phase === 'ACTIVE' && selector.activationEpoch === 1 && selector.pendingBuildIdentity === null))) {
    fail('CUTOVER_PHASE_INVALID', 'Drain observation requires pre-activation DRAINING or post-activation ACTIVE authority.');
  }
  if (!durableCoordinator || durableCoordinator.ownerId !== coordinator.ownerId
    || durableCoordinator.epoch !== coordinator.epoch || durableCoordinator.token !== coordinator.token
    || Date.parse(durableCoordinator.expiresAt) <= clock()) {
    fail('CUTOVER_WRITER_NOT_SINGLETON', 'Drain observation requires the live singleton coordinator fence.');
  }

  const unresolvedOperationIds = [];
  const releaseChangingMutationIds = [];
  const unfencedLegacyLeaseIds = [...legacy.unfencedLegacyLeaseIds];
  if (performanceScheduler.phase !== 'idle' || performanceScheduler.reservation !== null) {
    unfencedLegacyLeaseIds.push(`shared-performance-scheduler:${performanceScheduler.digest}`);
  }
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
        && Date.parse(item.lease.expiresAt) > clock()) {
        unfencedLegacyLeaseIds.push(`shared-preactivation:${runId}:${item.id}:${item.lease.token}`);
      }
      for (const diagnostic of item.diagnosticExecutions ?? []) {
        if (diagnostic.state !== 'running' || !diagnostic.lease) continue;
        if (Date.parse(diagnostic.lease.expiresAt) > clock()) {
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

export function sharedCutoverConfigurationDigest(input) {
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
    'buildIdentity', 'expectedStoreDigest', 'configurationDigest', 'backupRehearsalReceiptDigest',
  ], 'operatorReview');
  validateOperatorReviewFields(value);
  assertDigest(value.shadowValidationDigest, 'operatorReview.shadowValidationDigest');
  assertDigest(value.shadowMatrixDigest, 'operatorReview.shadowMatrixDigest');
  nonEmptyString(value.buildIdentity, 'operatorReview.buildIdentity');
  assertDigest(value.expectedStoreDigest, 'operatorReview.expectedStoreDigest');
  assertDigest(value.configurationDigest, 'operatorReview.configurationDigest');
  assertDigest(value.backupRehearsalReceiptDigest, 'operatorReview.backupRehearsalReceiptDigest');
  const expectedBindings = {
    shadowValidationDigest: input.shadowReport.digest,
    shadowMatrixDigest: input.shadowReport.matrixDigest,
    buildIdentity: input.buildIdentity,
    expectedStoreDigest: canonicalDigest(input.expectedStore),
    configurationDigest: sharedCutoverConfigurationDigest(input),
    backupRehearsalReceiptDigest: input.backupRehearsalReceipt.digest,
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
    'expectedStore', 'shadowReport', 'operatorReview', 'backupRehearsalReceipt',
    'backupRoot', 'restoreRoot',
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
  for (const key of ['backupRoot', 'restoreRoot']) {
    nonEmptyString(input[key], key);
    if (!path.isAbsolute(input[key])) fail('CUTOVER_INPUT_INVALID', `${key} must be an absolute isolated path.`);
    normalized[key] = path.resolve(input[key]);
  }
  try {
    normalized.backupRehearsalReceipt = parseSharedStoreBackupRehearsalReceipt(
      input.backupRehearsalReceipt,
      {
        expectedStore: normalized.expectedStore,
        buildIdentity: normalized.buildIdentity,
        configurationDigest: sharedCutoverConfigurationDigest(normalized),
        backupMarker: normalized.expectedStore.backupMarker,
        notBefore: normalized.shadowReport.generatedAt,
      },
    );
  } catch (error) {
    const mismatch = error?.code === 'BACKUP_BINDING_MISMATCH';
    fail(
      mismatch ? 'CUTOVER_BACKUP_RECEIPT_MISMATCH' : 'CUTOVER_BACKUP_RECEIPT_INVALID',
      mismatch
        ? 'Backup rehearsal receipt is stale or does not match this cutover.'
        : 'Cutover requires a valid sealed backup rehearsal receipt.',
      { cause: error?.code ?? error?.message },
    );
  }
  normalized.operatorReview = parseCutoverOperatorReview(input.operatorReview, normalized);
  return { ...normalized, digest: canonicalDigest(normalized) };
}

function assertBackupSelectorLineage(receipt, selector, checkpoint = null) {
  let expectedReceiptSelector = checkpoint?.selectorBefore?.digest;
  if (selector.phase === 'SHADOW') expectedReceiptSelector = selector.digest;
  if (selector.phase === 'DRAINING') expectedReceiptSelector = selector.previousDigest;
  if (receipt.selectorDigest !== expectedReceiptSelector) {
    fail(
      'CUTOVER_BACKUP_RECEIPT_MISMATCH',
      'Backup rehearsal receipt is not descended from this cutover preactivation selector.',
    );
  }
}

async function verifyCutoverBackup({ input, selector, checkpoint = null, clock, enforceFreshness = false }) {
  assertBackupSelectorLineage(input.backupRehearsalReceipt, selector, checkpoint);
  try {
    return await verifySharedStoreBackupRehearsal({
      receipt: input.backupRehearsalReceipt,
      backupRoot: input.backupRoot,
      restoreRoot: input.restoreRoot,
      expectedStore: input.expectedStore,
      buildIdentity: input.buildIdentity,
      configurationDigest: sharedCutoverConfigurationDigest(input),
      backupMarker: input.expectedStore.backupMarker,
      notBefore: input.shadowReport.generatedAt,
      ...(enforceFreshness ? { maximumAgeMs: MAX_BACKUP_REHEARSAL_AGE_MS, now: clock() } : {}),
    });
  } catch (error) {
    const mismatch = error?.code === 'BACKUP_BINDING_MISMATCH';
    fail(
      mismatch ? 'CUTOVER_BACKUP_RECEIPT_MISMATCH' : 'CUTOVER_BACKUP_RESTORE_INVALID',
      mismatch
        ? 'Backup rehearsal receipt is stale or does not match this cutover.'
        : 'Retained backup and restore content no longer proves a complete rehearsal.',
      { cause: error?.code ?? error?.message },
    );
  }
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
    authorityFloorBeforeDigest: value.authorityFloorBeforeDigest,
    authorityFloorAfterDigest: value.authorityFloorAfterDigest,
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
    authorityFloorBeforeDigest: null,
    authorityFloorAfterDigest: null,
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
    let checkpoint = await readCheckpoint(storage, input);
    await verifyCutoverBackup({
      input,
      selector,
      checkpoint,
      clock,
      enforceFreshness: checkpoint === null && selector.phase === 'SHADOW' && gate.state === 'OPEN',
    });
    checkpoint ??= await initializeCheckpoint(storage, input, selector, gate, clock);
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

function reportBody({
  input, checkpoint, selectorAfter, admissionGate, observation, store,
  authorityFloorBeforeDigest, authorityFloorAfter, completedAt,
}) {
  const backupReceipt = input.backupRehearsalReceipt;
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
    authorityFloorBeforeDigest,
    authorityFloorAfter,
    rollbackBuildIdentity: input.rollbackBuildIdentity,
    backupRehearsal: {
      receiptDigest: backupReceipt.digest,
      completedAt: backupReceipt.completedAt,
      retainedCopiesVerifiedAt: completedAt,
      manifestDigest: backupReceipt.manifestDigest,
      selectorDigest: backupReceipt.selectorDigest,
      expectedStoreDigest: backupReceipt.expectedStoreDigest,
      sourceSnapshotDigest: backupReceipt.sourceSnapshot.digest,
      backupSnapshotDigest: backupReceipt.backupSnapshot.digest,
      restoreSnapshotDigest: backupReceipt.restoreSnapshot.digest,
      entryCount: backupReceipt.sourceSnapshot.entryCount,
      totalBytes: backupReceipt.sourceSnapshot.totalBytes,
      sourceQuiesced: backupReceipt.verification.sourceQuiesced,
      backupMatchesSource: backupReceipt.verification.backupMatchesSource,
      restoreMatchesSource: backupReceipt.verification.restoreMatchesSource,
      unsupportedEntriesRejected: backupReceipt.verification.unsupportedEntriesRejected,
      isolatedPaths: backupReceipt.verification.isolatedPaths,
      retainedCopiesPresent: true,
    },
    preconditions: {
      activeLegacyAuthoritativeRuns: observation.activeLegacyAuthoritativeRunIds.length,
      releaseChangingMutations: observation.releaseChangingMutationIds.length,
      unresolvedOperations: observation.unresolvedOperationIds.length,
      unfencedLegacyLeases: observation.unfencedLegacyLeaseIds.length,
      singletonCanonicalWriter: observation.canonicalWriterOwnerIds.length === 1,
      unexplainedAuthorityDrift: input.shadowReport.summary.unexplainedDrift,
      shadowValidationStatus: input.shadowReport.validationStatus,
      backupRehearsed: backupReceipt.verification.sourceQuiesced === true
        && backupReceipt.verification.backupMatchesSource === true
        && backupReceipt.verification.restoreMatchesSource === true,
      backupRehearsalReceiptDigest: backupReceipt.digest,
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

function authorityFloorMatchesActivatedSelector(floor, selector) {
  return floor.storeMarkerDigest === selector.storeMarkerDigest
    && floor.minimumStoreGeneration === selector.storeGeneration
    && floor.minimumSelectorRevision === selector.revision
    && floor.activeBuildIdentity === selector.activeBuildIdentity
    && floor.authorityTransitionDigest === selector.authorityTransitionDigest
    && floor.activationEpoch === 1
    && floor.legacyPermanentlyRetired === true
    && floor.activationRevision === selector.activationRevision
    && floor.activationCutoverDigest === selector.activationCutoverDigest;
}

function promotionTransitionIntentPath(storage, cutoverId, selectorRevision, phase) {
  return reportStoragePath(storage, cutoverId, `.promotion-transition-${selectorRevision}-${phase}.json`);
}

function promotionTransitionIntentBody(value) {
  return {
    schemaVersion: 1,
    kind: 'release-promotion-transition-intent',
    cutoverId: value.cutoverId,
    selectorBeforeDigest: value.selectorBeforeDigest,
    selectorBeforeRevision: value.selectorBeforeRevision,
    targetPhase: value.targetPhase,
    activeBuildIdentity: value.activeBuildIdentity,
    authorityFloorBeforeDigest: value.authorityFloorBeforeDigest,
    activationRevision: value.activationRevision,
    activationCutoverDigest: value.activationCutoverDigest,
    healthReceiptDigest: value.healthReceiptDigest,
    createdAt: value.createdAt,
  };
}

function parsePromotionTransitionIntent(value, cutoverId, selectorRevision, phase) {
  parseSealed(value, 'Promotion transition intent');
  exactKeys(value, [...Object.keys(promotionTransitionIntentBody(value)), 'digest'], 'Promotion transition intent');
  if (value.schemaVersion !== 1 || value.kind !== 'release-promotion-transition-intent'
    || value.cutoverId !== cutoverId || value.selectorBeforeRevision !== selectorRevision
    || value.targetPhase !== phase || !['ACTIVE', 'PROMOTION_DISABLED'].includes(value.targetPhase)) {
    fail('CUTOVER_CHECKPOINT_CONFLICT', 'Promotion transition intent does not match this request.');
  }
  return clone(value);
}

async function persistPromotionTransitionIntent(storage, proposed) {
  const file = promotionTransitionIntentPath(
    storage, proposed.cutoverId, proposed.selectorBeforeRevision, proposed.targetPhase,
  );
  if (await pathExists(storage.fs, file)) {
    const existing = parsePromotionTransitionIntent(await readBoundedJson(storage, file, {
      label: 'promotion transition intent', maximumBytes: 256 * 1_024,
    }), proposed.cutoverId, proposed.selectorBeforeRevision, proposed.targetPhase);
    const expected = promotionTransitionIntentBody({ ...proposed, createdAt: existing.createdAt });
    if (canonicalJson(promotionTransitionIntentBody(existing)) !== canonicalJson(expected)) {
      fail('CUTOVER_CHECKPOINT_CONFLICT', 'Promotion transition intent is immutable.');
    }
    return existing;
  }
  const intent = seal(promotionTransitionIntentBody(proposed));
  await atomicWriteJson(storage, file, intent, { exclusive: true });
  return clone(intent);
}

async function advancePromotionAuthorityFloor(authorityFloor, intent, selector) {
  let floor = await authorityFloor.read();
  if (floor.digest === intent.authorityFloorBeforeDigest) {
    floor = await authorityFloor.compareAndAdvance(intent.authorityFloorBeforeDigest, {
      storeMarkerDigest: selector.storeMarkerDigest,
      minimumStoreGeneration: selector.storeGeneration,
      minimumSelectorRevision: selector.revision,
      activeBuildIdentity: selector.activeBuildIdentity,
      authorityTransitionDigest: selector.authorityTransitionDigest,
      activationEpoch: selector.activationEpoch,
      legacyPermanentlyRetired: true,
      activationRevision: selector.activationRevision,
      activationCutoverDigest: selector.activationCutoverDigest,
    });
  } else if (!authorityFloorMatchesActivatedSelector(floor, selector)) {
    fail('AUTHORITY_FLOOR_STATE_INVALID', 'External authority floor is neither before nor exactly after this promotion transition.');
  }
  return floor;
}

export async function activateSharedAuthorityCutover({
  store, coordinator, admissionGate, legacyAuthorityFence = null, authorityFloor,
  reportDirectory, input: rawInput, drainObservation,
  clock = store?.clock ?? (() => Date.now()), hooks = {},
} = {}) {
  ensureCoordinator(coordinator);
  if (!authorityFloor || typeof authorityFloor.read !== 'function'
    || typeof authorityFloor.compareAndAdvance !== 'function') {
    fail('AUTHORITY_FLOOR_REQUIRED', 'Shared activation requires the external authority floor.');
  }
  const input = parseCutoverInput(rawInput);
  const storage = await openReportStorage(reportDirectory);
  return withCutoverLock(storage, input.cutoverId, async () => {
    if (await pathExists(storage.fs, reportStoragePath(storage, input.cutoverId, '.rollback.json'))) {
      fail('CUTOVER_ALREADY_ROLLED_BACK', 'This cutover attempt was rolled back and cannot activate.');
    }
    const reportPath = reportStoragePath(storage, input.cutoverId, '.json');
    if (await pathExists(storage.fs, reportPath)) {
      const report = parseFinalReport(await readBoundedJson(storage, reportPath, { label: 'cutover report', maximumBytes: 4 * 1_048_576 }), input);
      const floor = await authorityFloor.read();
      if (floor.digest !== report.authorityFloorAfter?.digest) {
        fail('AUTHORITY_FLOOR_STATE_INVALID', 'Completed activation report no longer matches the external authority floor.');
      }
      return report;
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
    let floor = await authorityFloor.read();
    if (checkpoint.authorityFloorBeforeDigest === null) {
      if (floor.activationEpoch !== 0 || floor.legacyPermanentlyRetired !== false
        || floor.storeMarkerDigest !== selector.storeMarkerDigest
        || floor.minimumStoreGeneration > selector.storeGeneration
        || floor.minimumSelectorRevision > selector.revision) {
        fail('AUTHORITY_FLOOR_STATE_INVALID', 'External authority floor is not a valid preactivation ancestor.');
      }
      checkpoint = await writeCheckpoint(storage, {
        ...checkpoint,
        authorityFloorBeforeDigest: floor.digest,
        updatedAt: timestamp(clock),
      });
    } else if (floor.digest !== checkpoint.authorityFloorBeforeDigest
      && !authorityFloorMatchesActivatedSelector(floor, selector)) {
      fail('AUTHORITY_FLOOR_STATE_INVALID', 'External authority floor changed outside this activation.');
    }
    await verifyCutoverBackup({ input, selector, checkpoint, clock });
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
        activationCutoverDigest: input.digest,
        authorityTransitionDigest: input.digest,
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
    floor = await authorityFloor.read();
    if (floor.digest === checkpoint.authorityFloorBeforeDigest) {
      floor = await authorityFloor.compareAndAdvance(checkpoint.authorityFloorBeforeDigest, {
        storeMarkerDigest: selector.storeMarkerDigest,
        minimumStoreGeneration: selector.storeGeneration,
        minimumSelectorRevision: selector.revision,
        activeBuildIdentity: selector.activeBuildIdentity,
        authorityTransitionDigest: selector.authorityTransitionDigest,
        activationEpoch: 1,
        legacyPermanentlyRetired: true,
        activationRevision: selector.activationRevision,
        activationCutoverDigest: selector.activationCutoverDigest,
      });
      await hooks.afterAuthorityFloorAdvanced?.(clone(floor));
    } else if (!authorityFloorMatchesActivatedSelector(floor, selector)) {
      fail('AUTHORITY_FLOOR_STATE_INVALID', 'External authority floor is neither before nor exactly after this activation.');
    }
    checkpoint = await writeCheckpoint(storage, {
      ...checkpoint,
      status: 'ACTIVE',
      selectorCurrent: selector,
      admissionCurrent: gate,
      drainObservation: observed,
      authorityFloorBeforeDigest: checkpoint.authorityFloorBeforeDigest,
      authorityFloorAfterDigest: floor.digest,
      updatedAt: timestamp(clock),
    });
    const report = seal(reportBody({
      input, checkpoint, selectorAfter: selector, admissionGate: gate,
      observation: observed, store,
      authorityFloorBeforeDigest: checkpoint.authorityFloorBeforeDigest,
      authorityFloorAfter: floor,
      completedAt: timestamp(clock),
    }));
    await atomicWriteJson(storage, reportPath, report, { exclusive: true });
    return clone(report);
  });
}

async function defaultReadCanaryEvidence(store, runId, { probeTargetIdentity } = {}) {
  if (typeof probeTargetIdentity !== 'function') {
    fail('CUTOVER_CANARY_REPROBE_REQUIRED', 'Canary authority requires a trusted current target re-probe.');
  }
  const [state, publication] = await Promise.all([
    readParentRun(store, runId),
    readCurrentEnvelope(store, runId),
  ]);
  const trustedReprobeIdentity = await probeTargetIdentity(clone(state));
  return {
    runId,
    mode: state.finalSubject?.mode,
    createdAt: state.createdAt,
    subjectCoreDigest: state.subjectCoreDigest,
    finalSubjectDigest: state.finalSubjectDigest,
    publicationDigest: publication.digest,
    decisionCode: publication.decision?.code,
    decisionRevision: publication.decisionRevision,
    grantedAuthority: publication.decision?.grantedAuthority,
    deploymentIdentity: state.finalSubject?.deploymentIdentity,
    trustedReprobeIdentity,
    runnerRevision: state.runnerRevision,
    configurationRevision: state.subjectCore?.revisions?.configuration,
    activeBuildIdentity: store.buildIdentity,
  };
}

function parseCanaryEvidence(value, {
  mode, runId, selector, store, minimumCreatedAt = null, launchPermit = null,
  expectedBuildIdentity = selector.activeBuildIdentity,
}) {
  if (!isRecord(value) || value.mode !== mode || value.decisionCode !== 'RELEASE_READY'
    || value.grantedAuthority !== 'FULL' || value.runId !== runId
    || !Number.isSafeInteger(value.decisionRevision) || value.decisionRevision < 1) {
    fail('CUTOVER_CANARY_NOT_READY', `${mode} canary ${runId} is not a full current ready publication.`);
  }
  canonicalTimestamp(value.createdAt, 'Canary createdAt');
  assertDigest(value.finalSubjectDigest, 'Canary finalSubjectDigest');
  assertDigest(value.subjectCoreDigest, 'Canary subjectCoreDigest');
  assertDigest(value.publicationDigest, 'Canary publicationDigest');
  assertDigest(value.runnerRevision, 'Canary runnerRevision');
  assertDigest(value.configurationRevision, 'Canary configurationRevision');
  nonEmptyString(value.activeBuildIdentity, 'Canary activeBuildIdentity');
  const deploymentIdentity = parseTrustedTargetIdentity(value.deploymentIdentity, 'Canary deployment identity');
  const trustedReprobeIdentity = parseTrustedTargetIdentity(value.trustedReprobeIdentity, 'Canary trusted re-probe identity');
  if (canonicalJson(deploymentIdentity) !== canonicalJson(trustedReprobeIdentity)) {
    fail('CUTOVER_CANARY_TARGET_MISMATCH', `${mode} canary target identity changed at trusted re-probe.`);
  }
  const storeBinding = cutoverStoreBinding(store);
  if (value.activeBuildIdentity !== expectedBuildIdentity
    || value.activeBuildIdentity !== store.buildIdentity) {
    fail('CUTOVER_CANARY_BUILD_MISMATCH', `${mode} canary is not bound to the active cutover build.`);
  }
  if (minimumCreatedAt !== null && Date.parse(value.createdAt) < Date.parse(minimumCreatedAt)) {
    fail('CUTOVER_CANARY_STALE', `${mode} canary predates the authority event it must prove.`);
  }
  if (launchPermit) {
    if (launchPermit.state !== 'CONSUMED' || launchPermit.runId !== runId
      || launchPermit.activeBuildIdentity !== value.activeBuildIdentity
      || launchPermit.storeBindingDigest !== storeBinding.digest
      || launchPermit.runRunnerRevision !== value.runnerRevision
      || launchPermit.runConfigurationRevision !== value.configurationRevision
      || canonicalJson(launchPermit.targetIdentity) !== canonicalJson(value.deploymentIdentity)
      || Date.parse(value.createdAt) < Date.parse(launchPermit.authorizedAt)
      || Date.parse(value.createdAt) > Date.parse(launchPermit.consumedAt)) {
      fail('CUTOVER_CANARY_LAUNCH_MISMATCH', `${mode} canary evidence does not match its one-time cutover launch permit.`);
    }
  }
  return {
    mode, runId,
    createdAt: value.createdAt,
    subjectCoreDigest: value.subjectCoreDigest,
    finalSubjectDigest: value.finalSubjectDigest,
    publicationDigest: value.publicationDigest,
    decisionCode: value.decisionCode,
    decisionRevision: value.decisionRevision,
    grantedAuthority: value.grantedAuthority,
    deploymentIdentity,
    trustedReprobeIdentity,
    runnerRevision: value.runnerRevision,
    configurationRevision: value.configurationRevision,
    activeBuildIdentity: value.activeBuildIdentity,
    storeBindingDigest: storeBinding.digest,
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
    assertDigest(receipt.launchPermitDigest, `Cutover ${mode} canary launchPermitDigest`);
    assertDigest(receipt.storeBindingDigest, `Cutover ${mode} canary storeBindingDigest`);
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

function handoffCanaryAuthority(selector, gate, authorityId, store) {
  const handoff = selector.phase === 'PROMOTION_DISABLED' && selector.activationEpoch === 1
    && selector.handoffId === authorityId && selector.pendingBuildIdentity !== null;
  if (!handoff) {
    assertActivatedCutover(selector, gate, authorityId);
    return { handoff: false, buildIdentity: selector.activeBuildIdentity, minimumCreatedAt: selector.activatedAt };
  }
  if (gate.state !== 'CLOSED' || gate.cutoverId !== authorityId
    || store.buildIdentity !== selector.pendingBuildIdentity) {
    fail('AUTHORITY_HANDOFF_INVALID', 'Handoff canary evidence is not owned by the pending target build.');
  }
  return { handoff: true, buildIdentity: selector.pendingBuildIdentity, minimumCreatedAt: selector.updatedAt };
}

export async function recordSharedCutoverCanary({
  store, admissionGate, reportDirectory, cutoverId, mode, runId,
  readCanaryEvidence = defaultReadCanaryEvidence,
  probeTargetIdentity,
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
    const authority = handoffCanaryAuthority(selector, gate, cutoverId, store);
    const launchPermit = await readCanaryLaunchPermit(admissionGate, cutoverId, mode);
    if (!launchPermit) fail('CUTOVER_CANARY_LAUNCH_MISMATCH', `${mode} canary has no cutover launch permit.`);
    const evidence = parseCanaryEvidence(await readCanaryEvidence(store, runId, { probeTargetIdentity }), {
      mode,
      runId,
      selector,
      store,
      minimumCreatedAt: authority.minimumCreatedAt,
      launchPermit,
      expectedBuildIdentity: authority.buildIdentity,
    });
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
      launchPermitDigest: launchPermit.digest,
      cutoverReportDigest: launchPermit.cutoverReportDigest,
      cutoverConfigurationDigest: launchPermit.cutoverConfigurationDigest,
      recordedAt: timestamp(clock),
    };
    const receipt = seal(receiptBody);
    const receiptDirectory = reportStoragePath(storage, cutoverId, '.canaries');
    await storage.fs.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    const receiptPath = containedPath(receiptDirectory, `${receipt.digest.slice(7)}.json`);
    if (!await pathExists(storage.fs, receiptPath)) {
      await atomicWriteJson(storage, receiptPath, receipt, { exclusive: true });
    }
    const summarized = {
      ...evidence,
      receiptDigest: receipt.digest,
      admissionGateDigest: gate.digest,
      launchPermitDigest: launchPermit.digest,
    };
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

export async function recordSharedBuildHandoffCanary(options = {}) {
  const { reportDirectory, handoffId, clock = options.store?.clock ?? (() => Date.now()) } = options;
  const storage = await openReportStorage(reportDirectory);
  try {
    const head = await recordSharedCutoverCanary({ ...options, cutoverId: handoffId, clock });
    return withCutoverLock(storage, handoffId, async () => {
      const { intent, checkpoint } = await readHandoffDocuments(storage, handoffId);
      const next = await writeHandoffCheckpoint(storage, {
        ...checkpoint,
        status: 'PENDING_TARGET_HEALTH',
        canaryHeadDigest: head.digest,
        failure: null,
        updatedAt: timestamp(clock),
      });
      return Object.freeze({ head, checkpoint: next, intentDigest: intent.digest });
    });
  } catch (error) {
    await withCutoverLock(storage, handoffId, async () => {
      const { checkpoint } = await readHandoffDocuments(storage, handoffId);
      const failure = {
        code: error?.code ?? 'HANDOFF_CANARY_FAILED',
        message: error instanceof Error ? error.message : String(error),
        failedAt: timestamp(clock),
      };
      const next = await writeHandoffCheckpoint(storage, {
        ...checkpoint,
        status: 'FAILED_HOLD',
        failure,
        updatedAt: timestamp(clock),
      });
      const report = seal({
        schemaVersion: 1,
        kind: 'release-authority-build-handoff-failed-hold',
        handoffId,
        status: 'FAILED_HOLD',
        checkpointDigest: next.digest,
        selector: await readReleaseAuthoritySelector(options.store),
        admissionGate: await options.admissionGate.read(),
        failure,
      });
      const file = handoffPath(storage, handoffId, `.failed-${next.digest.slice(7)}.json`);
      if (!await pathExists(storage.fs, file)) await atomicWriteJson(storage, file, report, { exclusive: true });
    });
    throw error;
  }
}

export async function reopenSharedAdmissionAfterCanaries({
  store, admissionGate, reportDirectory, cutoverId,
  readCanaryEvidence = defaultReadCanaryEvidence,
  probeTargetIdentity,
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
      const launchPermit = await readCanaryLaunchPermit(admissionGate, cutoverId, mode);
      if (!launchPermit || launchPermit.digest !== receipt.launchPermitDigest) {
        fail('CUTOVER_CANARY_LAUNCH_MISMATCH', `${mode} canary launch permit changed after recording.`);
      }
      const current = parseCanaryEvidence(await readCanaryEvidence(store, receipt.runId, { probeTargetIdentity }), {
        mode,
        runId: receipt.runId,
        selector,
        store,
        minimumCreatedAt: selector.activatedAt,
        launchPermit,
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

function handoffIntentBody(value) {
  return {
    schemaVersion: 1,
    kind: 'release-authority-build-handoff-intent',
    handoffId: value.handoffId,
    sourceBuildIdentity: value.sourceBuildIdentity,
    targetBuildIdentity: value.targetBuildIdentity,
    sourceSelectorDigest: value.sourceSelectorDigest,
    authorityFloorBeforeDigest: value.authorityFloorBeforeDigest,
    activationCutoverDigest: value.activationCutoverDigest,
    activationEpoch: value.activationEpoch,
    activationRevision: value.activationRevision,
    operatorReview: value.operatorReview,
    requestedAt: value.requestedAt,
  };
}

function parseHandoffIntent(value, handoffId = null) {
  parseSealed(value, 'Build handoff intent');
  exactKeys(value, [...Object.keys(handoffIntentBody(value)), 'digest'], 'Build handoff intent');
  if (value.schemaVersion !== 1 || value.kind !== 'release-authority-build-handoff-intent'
    || (handoffId !== null && value.handoffId !== handoffId) || !SAFE_ID.test(value.handoffId)) {
    fail('CUTOVER_DOCUMENT_INVALID', 'Build handoff intent identity is invalid.');
  }
  nonEmptyString(value.sourceBuildIdentity, 'Build handoff sourceBuildIdentity');
  nonEmptyString(value.targetBuildIdentity, 'Build handoff targetBuildIdentity');
  if (value.sourceBuildIdentity === value.targetBuildIdentity || value.activationEpoch !== 1
    || !Number.isSafeInteger(value.activationRevision) || value.activationRevision < 1) {
    fail('CUTOVER_DOCUMENT_INVALID', 'Build handoff intent authority binding is invalid.');
  }
  assertDigest(value.sourceSelectorDigest, 'Build handoff sourceSelectorDigest');
  assertDigest(value.authorityFloorBeforeDigest, 'Build handoff authorityFloorBeforeDigest');
  assertDigest(value.activationCutoverDigest, 'Build handoff activationCutoverDigest');
  parseOperatorReview(value.operatorReview);
  canonicalTimestamp(value.requestedAt, 'Build handoff requestedAt');
  return clone(value);
}

function handoffCheckpointBody(value) {
  return {
    schemaVersion: 1,
    kind: 'release-authority-build-handoff-checkpoint',
    handoffId: value.handoffId,
    intentDigest: value.intentDigest,
    revision: value.revision,
    previousDigest: value.previousDigest,
    status: value.status,
    selectorBefore: value.selectorBefore,
    selectorCurrent: value.selectorCurrent,
    admissionBefore: value.admissionBefore,
    admissionCurrent: value.admissionCurrent,
    drainObservation: value.drainObservation,
    canaryHeadDigest: value.canaryHeadDigest,
    commitIntentDigest: value.commitIntentDigest,
    authorityFloorAfterDigest: value.authorityFloorAfterDigest,
    failure: value.failure,
    updatedAt: value.updatedAt,
  };
}

function parseHandoffCheckpoint(value, intent) {
  parseSealed(value, 'Build handoff checkpoint');
  exactKeys(value, [...Object.keys(handoffCheckpointBody(value)), 'digest'], 'Build handoff checkpoint');
  if (value.schemaVersion !== 1 || value.kind !== 'release-authority-build-handoff-checkpoint'
    || value.handoffId !== intent.handoffId || value.intentDigest !== intent.digest
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || ((value.revision === 1) !== (value.previousDigest === null))
    || !['ADMISSION_CLOSED', 'DRAIN_VERIFIED', 'PENDING_TARGET_HEALTH', 'FAILED_HOLD', 'COMPLETED'].includes(value.status)) {
    fail('CUTOVER_CHECKPOINT_CONFLICT', 'Build handoff checkpoint does not match its intent.');
  }
  if (value.previousDigest !== null) assertDigest(value.previousDigest, 'Build handoff checkpoint previousDigest');
  if (value.commitIntentDigest !== null) assertDigest(value.commitIntentDigest, 'Build handoff checkpoint commitIntentDigest');
  if (value.authorityFloorAfterDigest !== null) assertDigest(value.authorityFloorAfterDigest, 'Build handoff checkpoint authorityFloorAfterDigest');
  return clone(value);
}

function handoffPath(storage, handoffId, suffix) {
  return reportStoragePath(storage, safeId(handoffId, 'handoffId'), `.handoff${suffix}`);
}

function buildCompatibilityProof(value, targetBuildIdentity) {
  parseSealed(value, 'Build compatibility proof');
  exactKeys(value, [
    'schemaVersion', 'kind', 'targetBuildIdentity', 'runnerRevision', 'imageDigest',
    'validationDigest', 'generatedAt', 'digest',
  ], 'Build compatibility proof');
  if (value.schemaVersion !== 1 || value.kind !== 'shared-build-compatibility-proof'
    || value.targetBuildIdentity !== targetBuildIdentity
    || value.targetBuildIdentity !== `build:${value.imageDigest}`) {
    fail('AUTHORITY_BUILD_QUALIFICATION_INVALID', 'Build compatibility proof does not identify the requested target.');
  }
  for (const key of ['runnerRevision', 'imageDigest', 'validationDigest']) {
    assertDigest(value[key], `Build compatibility proof ${key}`);
  }
  canonicalTimestamp(value.generatedAt, 'Build compatibility proof generatedAt');
  return clone(value);
}

function buildPrequalificationPath(storage, prequalificationId, suffix) {
  return reportStoragePath(storage, safeId(prequalificationId, 'prequalificationId'), `.build-prequalification${suffix}`);
}

export async function prequalifySharedAuthorityBuild({
  store, coordinator, legacyAuthorityFence, authorityFloor, reportDirectory,
  prequalificationId, targetBuildIdentity, compatibilityProof: rawCompatibilityProof,
  operatorReview: rawOperatorReview, clock = store?.clock ?? (() => Date.now()), hooks = {},
} = {}) {
  const storage = await openReportStorage(reportDirectory);
  safeId(prequalificationId, 'prequalificationId');
  nonEmptyString(targetBuildIdentity, 'targetBuildIdentity');
  return withCutoverLock(storage, prequalificationId, async () => {
    const intentPath = buildPrequalificationPath(storage, prequalificationId, '.intent.json');
    const receiptPath = buildPrequalificationPath(storage, prequalificationId, '.json');
    let intent;
    if (await pathExists(storage.fs, intentPath)) {
      intent = parseSealed(await readBoundedJson(storage, intentPath, {
        label: 'build prequalification intent', maximumBytes: 256 * 1_024,
      }), 'Build prequalification intent');
      const compatibilityProof = buildCompatibilityProof(intent.compatibilityProof, targetBuildIdentity);
      const operatorReview = parseOperatorReview(intent.operatorReview);
      if (intent.compatibilityProofDigest !== compatibilityProof.digest) {
        fail('CUTOVER_CHECKPOINT_CONFLICT', 'Durable build prequalification proof binding is invalid.');
      }
      if (intent.kind !== 'release-authority-build-prequalification-intent'
        || intent.prequalificationId !== prequalificationId
        || intent.targetBuildIdentity !== targetBuildIdentity
        || (rawCompatibilityProof !== null && rawCompatibilityProof !== undefined
          && canonicalJson(buildCompatibilityProof(rawCompatibilityProof, targetBuildIdentity)) !== canonicalJson(compatibilityProof))
        || (rawOperatorReview !== null && rawOperatorReview !== undefined
          && canonicalJson(parseOperatorReview(rawOperatorReview)) !== canonicalJson(operatorReview))) {
        fail('CUTOVER_CHECKPOINT_CONFLICT', 'Build prequalification intent is immutable.');
      }
    } else {
      const operatorReview = parseOperatorReview(rawOperatorReview);
      const compatibilityProof = buildCompatibilityProof(rawCompatibilityProof, targetBuildIdentity);
      const [selector, floor, legacy] = await Promise.all([
        readReleaseAuthoritySelector(store), authorityFloor?.read(), legacyAuthorityFence?.read(),
      ]);
      if (!authorityFloor || !floor || selector.phase !== 'ACTIVE' || selector.activationEpoch !== 1
        || selector.activeBuildIdentity !== store.buildIdentity || selector.pendingBuildIdentity !== null
        || targetBuildIdentity === selector.activeBuildIdentity
        || floor.storeMarkerDigest !== selector.storeMarkerDigest
        || floor.minimumStoreGeneration !== selector.storeGeneration
        || floor.minimumSelectorRevision !== selector.revision
        || floor.activeBuildIdentity !== selector.activeBuildIdentity
        || floor.authorityTransitionDigest !== selector.authorityTransitionDigest
        || floor.activationEpoch !== 1 || floor.legacyPermanentlyRetired !== true
        || floor.activationRevision !== selector.activationRevision
        || floor.activationCutoverDigest !== selector.activationCutoverDigest) {
        fail('AUTHORITY_FLOOR_STATE_INVALID', 'Build prequalification requires exact active selector and authority-floor lineage.');
      }
      if (!legacy || legacy.state !== 'ACTIVATED' || legacy.activationEpoch !== 1) {
        fail('CUTOVER_LEGACY_FENCE_CONFLICT', 'Build prequalification requires permanently retired legacy authority.');
      }
      intent = seal({
        schemaVersion: 1,
        kind: 'release-authority-build-prequalification-intent',
        prequalificationId,
        sourceBuildIdentity: selector.activeBuildIdentity,
        targetBuildIdentity,
        sourceManifest: clone(store.manifest),
        sourceManifestDigest: store.manifest.digest,
        sourceSelectorDigest: selector.digest,
        targetSelectorRevision: selector.revision + 1,
        authorityFloorBeforeDigest: floor.digest,
        activationCutoverDigest: selector.activationCutoverDigest,
        activationRevision: selector.activationRevision,
        compatibilityProof,
        compatibilityProofDigest: compatibilityProof.digest,
        operatorReview,
        requestedAt: timestamp(clock),
      });
      await atomicWriteJson(storage, intentPath, intent, { exclusive: true });
      await hooks.afterIntentPersisted?.(clone(intent));
    }
    let selector = await prequalifyReleaseAuthorityBuild(store, coordinator, {
      expectedSelectorDigest: intent.sourceSelectorDigest,
      expectedManifestDigest: intent.sourceManifestDigest,
      expectedManifest: intent.sourceManifest,
      targetBuildIdentity: intent.targetBuildIdentity,
      expectedTargetSelectorRevision: intent.targetSelectorRevision,
      authorityTransitionDigest: intent.digest,
      hooks: {
        afterManifest: hooks.afterManifestCommitted,
        afterSelector: hooks.afterSelectorCommitted,
      },
    });
    let floorAfter = await authorityFloor.read();
    if (floorAfter.digest === intent.authorityFloorBeforeDigest) {
      floorAfter = await authorityFloor.compareAndAdvance(intent.authorityFloorBeforeDigest, {
        minimumStoreGeneration: selector.storeGeneration,
        minimumSelectorRevision: selector.revision,
        activeBuildIdentity: intent.sourceBuildIdentity,
        authorityTransitionDigest: intent.digest,
        activationEpoch: 1,
        legacyPermanentlyRetired: true,
        activationRevision: intent.activationRevision,
        activationCutoverDigest: intent.activationCutoverDigest,
      });
      await hooks.afterAuthorityFloorAdvanced?.(clone(floorAfter));
    } else if (floorAfter.minimumStoreGeneration !== selector.storeGeneration
      || floorAfter.minimumSelectorRevision !== selector.revision
      || floorAfter.activeBuildIdentity !== intent.sourceBuildIdentity
      || floorAfter.authorityTransitionDigest !== intent.digest
      || floorAfter.activationEpoch !== 1 || floorAfter.legacyPermanentlyRetired !== true
      || floorAfter.activationRevision !== intent.activationRevision
      || floorAfter.activationCutoverDigest !== intent.activationCutoverDigest) {
      fail('AUTHORITY_FLOOR_STATE_INVALID', 'Authority floor is neither before nor exactly after this build prequalification.');
    }
    const receipt = seal({
      schemaVersion: 1,
      kind: 'release-authority-build-prequalification-receipt',
      prequalificationId,
      intentDigest: intent.digest,
      compatibilityProofDigest: intent.compatibilityProofDigest,
      selector,
      authorityFloorAfter: floorAfter,
      completedAt: timestamp(clock),
    });
    if (await pathExists(storage.fs, receiptPath)) {
      const existing = parseSealed(await readBoundedJson(storage, receiptPath, {
        label: 'build prequalification receipt', maximumBytes: 512 * 1_024,
      }), 'Build prequalification receipt');
      if (existing.intentDigest !== receipt.intentDigest
        || existing.selector?.digest !== receipt.selector.digest
        || existing.authorityFloorAfter?.digest !== receipt.authorityFloorAfter.digest) {
        fail('CUTOVER_CHECKPOINT_CONFLICT', 'Build prequalification receipt conflicts with durable authority state.');
      }
      return clone(existing);
    }
    await atomicWriteJson(storage, receiptPath, receipt, { exclusive: true });
    return clone(receipt);
  });
}

async function readHandoffDocuments(storage, handoffId) {
  const intent = parseHandoffIntent(await readBoundedJson(storage, handoffPath(storage, handoffId, '.intent.json'), {
    label: 'build handoff intent', maximumBytes: 256 * 1_024,
  }), handoffId);
  const checkpoint = parseHandoffCheckpoint(await readBoundedJson(storage, handoffPath(storage, handoffId, '.state.json'), {
    label: 'build handoff checkpoint', maximumBytes: 2 * 1_048_576,
  }), intent);
  return { intent, checkpoint };
}

async function writeHandoffCheckpoint(storage, value) {
  const previousDigest = value.digest ?? null;
  if (previousDigest !== null) {
    const previousFile = handoffPath(storage, value.handoffId, `.checkpoints/${previousDigest.slice('sha256:'.length)}.json`);
    if (!await pathExists(storage.fs, previousFile)) {
      fail('CUTOVER_CHECKPOINT_CONFLICT', 'Build handoff checkpoint history is incomplete.');
    }
  }
  const checkpoint = seal(handoffCheckpointBody({
    ...value,
    revision: previousDigest === null ? 1 : value.revision + 1,
    previousDigest,
  }));
  const historyDirectory = handoffPath(storage, value.handoffId, '.checkpoints');
  await storage.fs.mkdir(historyDirectory, { recursive: true, mode: 0o700 });
  const immutable = containedPath(historyDirectory, `${checkpoint.digest.slice('sha256:'.length)}.json`);
  if (!await pathExists(storage.fs, immutable)) await atomicWriteJson(storage, immutable, checkpoint, { exclusive: true });
  await atomicWriteJson(storage, handoffPath(storage, value.handoffId, '.state.json'), checkpoint);
  return clone(checkpoint);
}

export async function prepareSharedAuthorityBuildHandoff({
  store, coordinator, admissionGate, legacyAuthorityFence, authorityFloor, reportDirectory,
  handoffId, targetBuildIdentity, operatorReview: rawOperatorReview,
  clock = store?.clock ?? (() => Date.now()),
  hooks = {},
} = {}) {
  ensureCoordinator(coordinator);
  safeId(handoffId, 'handoffId');
  nonEmptyString(targetBuildIdentity, 'targetBuildIdentity');
  const operatorReview = parseOperatorReview(rawOperatorReview);
  const storage = await openReportStorage(reportDirectory);
  return withCutoverLock(storage, handoffId, async () => {
    const selector = await readReleaseAuthoritySelector(store);
    if (selector.phase !== 'ACTIVE' || selector.activationEpoch !== 1
      || selector.activeBuildIdentity !== store.buildIdentity || selector.pendingBuildIdentity !== null
      || targetBuildIdentity === selector.activeBuildIdentity
      || !selector.prequalifiedRollbackBuilds.includes(targetBuildIdentity)) {
      fail('AUTHORITY_HANDOFF_INVALID', 'Build handoff preparation requires ACTIVE source authority and a distinct prequalified target.');
    }
    if (!authorityFloor || typeof authorityFloor.read !== 'function') {
      fail('AUTHORITY_FLOOR_REQUIRED', 'Build handoff requires the external authority floor.');
    }
    const floorBefore = await authorityFloor.read();
    if (floorBefore.storeMarkerDigest !== selector.storeMarkerDigest
      || floorBefore.minimumStoreGeneration !== selector.storeGeneration
      || floorBefore.minimumSelectorRevision !== selector.revision
      || floorBefore.activeBuildIdentity !== selector.activeBuildIdentity
      || floorBefore.authorityTransitionDigest !== selector.authorityTransitionDigest
      || floorBefore.activationCutoverDigest !== selector.activationCutoverDigest
      || floorBefore.activationEpoch !== 1 || floorBefore.legacyPermanentlyRetired !== true
      || floorBefore.activationRevision !== selector.activationRevision) {
      fail('AUTHORITY_FLOOR_STATE_INVALID', 'Build handoff source selector does not exactly match the external authority floor.');
    }
    const legacy = await legacyAuthorityFence?.read();
    if (!legacy || legacy.state !== 'ACTIVATED' || legacy.activationEpoch !== 1) {
      fail('CUTOVER_LEGACY_FENCE_CONFLICT', 'Post-activation handoff requires the permanently activated legacy fence.');
    }
    const gateBefore = await admissionGate.read();
    if (gateBefore.state === 'CLOSED' && gateBefore.cutoverId !== handoffId) {
      fail('CUTOVER_ADMISSION_OWNED', `Admission is already closed by ${gateBefore.cutoverId}.`);
    }
    const intentFile = handoffPath(storage, handoffId, '.intent.json');
    if (await pathExists(storage.fs, intentFile)) {
      const existing = parseHandoffIntent(await readBoundedJson(storage, intentFile, {
        label: 'build handoff intent', maximumBytes: 256 * 1_024,
      }), handoffId);
      const expected = handoffIntentBody({
        ...existing,
        handoffId,
        sourceBuildIdentity: selector.activeBuildIdentity,
        targetBuildIdentity,
        sourceSelectorDigest: selector.digest,
        authorityFloorBeforeDigest: floorBefore.digest,
        activationCutoverDigest: selector.activationCutoverDigest,
        activationEpoch: selector.activationEpoch,
        activationRevision: selector.activationRevision,
        operatorReview,
      });
      if (canonicalJson(handoffIntentBody(existing)) !== canonicalJson(expected)) {
        fail('CUTOVER_CHECKPOINT_CONFLICT', 'Build handoff intent is immutable.');
      }
      return (await readHandoffDocuments(storage, handoffId)).checkpoint;
    }
    const intent = seal(handoffIntentBody({
      handoffId,
      sourceBuildIdentity: selector.activeBuildIdentity,
      targetBuildIdentity,
      sourceSelectorDigest: selector.digest,
      authorityFloorBeforeDigest: floorBefore.digest,
      activationCutoverDigest: selector.activationCutoverDigest,
      activationEpoch: selector.activationEpoch,
      activationRevision: selector.activationRevision,
      operatorReview,
      requestedAt: timestamp(clock),
    }));
    await atomicWriteJson(storage, intentFile, intent, { exclusive: true });
    const gateAfter = gateBefore.state === 'OPEN' ? await admissionGate.close(gateBefore.digest, handoffId) : gateBefore;
    const checkpoint = await writeHandoffCheckpoint(storage, {
      handoffId,
      intentDigest: intent.digest,
      status: 'ADMISSION_CLOSED',
      selectorBefore: selector,
      selectorCurrent: selector,
      admissionBefore: gateBefore,
      admissionCurrent: gateAfter,
      drainObservation: null,
      canaryHeadDigest: null,
      commitIntentDigest: null,
      authorityFloorAfterDigest: null,
      failure: null,
      updatedAt: timestamp(clock),
    });
    await hooks.afterAdmissionClosed?.(clone(gateAfter));
    return checkpoint;
  });
}

export async function beginSharedAuthorityBuildHandoff({
  store, coordinator, admissionGate, legacyAuthorityFence, reportDirectory, handoffId, drainObservation,
  clock = store?.clock ?? (() => Date.now()), hooks = {},
} = {}) {
  ensureCoordinator(coordinator);
  const storage = await openReportStorage(reportDirectory);
  return withCutoverLock(storage, handoffId, async () => {
    const { intent, checkpoint: storedCheckpoint } = await readHandoffDocuments(storage, handoffId);
    let checkpoint = storedCheckpoint;
    const gate = await admissionGate.read();
    if (gate.state !== 'CLOSED' || gate.cutoverId !== handoffId) {
      fail('CUTOVER_ADMISSION_OPEN', 'Build handoff requires admission closed by this handoff.');
    }
    const legacy = await legacyAuthorityFence?.read();
    if (!legacy || legacy.state !== 'ACTIVATED' || legacy.activationEpoch !== 1) {
      fail('CUTOVER_LEGACY_FENCE_CONFLICT', 'Legacy authority must remain permanently activated during build handoff.');
    }
    let selector = await readReleaseAuthoritySelector(store);
    if (checkpoint.status === 'ADMISSION_CLOSED') {
      const observed = parseDrainObservation(drainObservation, {
        input: { cutoverId: handoffId }, gate, coordinator, clock,
      });
      checkpoint = await writeHandoffCheckpoint(storage, {
        ...checkpoint, status: 'DRAIN_VERIFIED', drainObservation: observed,
        admissionCurrent: gate, updatedAt: timestamp(clock),
      });
    }
    if (selector.phase === 'ACTIVE') {
      if (selector.digest !== intent.sourceSelectorDigest || selector.activeBuildIdentity !== intent.sourceBuildIdentity) {
        fail('AUTHORITY_HANDOFF_INVALID', 'Active source selector changed after handoff preparation.');
      }
      selector = await beginReleaseAuthorityBuildHandoff(store, coordinator, {
        expectedSelectorDigest: selector.digest,
        handoffId,
        targetBuildIdentity: intent.targetBuildIdentity,
      });
      await hooks.afterPendingSelector?.(clone(selector));
    } else if (selector.phase !== 'PROMOTION_DISABLED' || selector.handoffId !== handoffId
      || selector.pendingBuildIdentity !== intent.targetBuildIdentity) {
      fail('AUTHORITY_HANDOFF_INVALID', 'Durable selector does not match this resumable build handoff.');
    }
    checkpoint = await writeHandoffCheckpoint(storage, {
      ...checkpoint,
      status: 'PENDING_TARGET_HEALTH',
      selectorCurrent: selector,
      admissionCurrent: gate,
      failure: null,
      updatedAt: timestamp(clock),
    });
    const pendingReport = seal({
      schemaVersion: 1,
      kind: 'release-authority-build-handoff-pending-report',
      handoffId,
      status: 'PROMOTION_DISABLED_PENDING_TARGET_HEALTH',
      intentDigest: intent.digest,
      checkpointDigest: checkpoint.digest,
      selectorBefore: checkpoint.selectorBefore,
      selectorPending: selector,
      admissionGate: gate,
      drainObservation: checkpoint.drainObservation,
      legacyAuthorityFenceDigest: legacy.digest,
      preparedAt: timestamp(clock),
    });
    await atomicWriteJson(storage, handoffPath(storage, handoffId, '.pending.json'), pendingReport);
    return clone(pendingReport);
  });
}

export async function authorizeSharedBuildHandoffCanaryLaunch({
  store, admissionGate, reportDirectory, handoffId, mode, runId, requestId, actor: rawActor, intent: rawIntent,
  supersedeReason = null,
  probeTargetIdentity = defaultProbeCanaryTargetIdentity,
  clock = store?.clock ?? (() => Date.now()),
} = {}) {
  safeId(handoffId, 'handoffId');
  safeId(runId, 'runId');
  if (!CUTOVER_CANARY_MODES.includes(mode)) fail('CUTOVER_INPUT_INVALID', 'Handoff canary mode is invalid.');
  requestIdentity(requestId);
  const actor = parseCanaryActor(rawActor);
  const intent = parseCanaryIntent(rawIntent, mode);
  const targetIdentity = parseTrustedTargetIdentity(await probeTargetIdentity(intent), 'Trusted handoff target identity');
  const reportStorage = await openReportStorage(reportDirectory);
  const pendingReport = parseSealed(await readBoundedJson(
    reportStorage,
    handoffPath(reportStorage, handoffId, '.pending.json'),
    { label: 'build handoff pending report', maximumBytes: 2 * 1_048_576 },
  ), 'Build handoff pending report');
  const { intent: handoffIntent } = await readHandoffDocuments(reportStorage, handoffId);
  const storage = await openAtomicStorage({ root: admissionGate.root, verify: false });
  return admissionGate.withState(async (gate) => {
    const selector = await readReleaseAuthoritySelector(store);
    if (gate.state !== 'CLOSED' || gate.cutoverId !== handoffId
      || selector.phase !== 'PROMOTION_DISABLED' || selector.handoffId !== handoffId
      || selector.pendingBuildIdentity !== handoffIntent.targetBuildIdentity
      || store.buildIdentity !== handoffIntent.targetBuildIdentity
      || pendingReport.selectorPending?.digest !== selector.digest) {
      fail('AUTHORITY_HANDOFF_INVALID', 'Handoff canary authorization is not bound to the pending target build.');
    }
    const binding = cutoverStoreBinding(store);
    const file = canaryLaunchPermitPath(storage.root, handoffId, mode);
    if (await pathExists(storage.fs, file)) {
      const existing = parseCanaryLaunchPermit(await readBoundedJson(storage, file, {
        label: 'handoff canary launch permit', maximumBytes: 256 * 1_024,
      }), { cutoverId: handoffId, mode });
      if (existing.requestId === requestId && existing.intentDigest === canonicalDigest(intent)
        && canonicalJson(existing.actor) === canonicalJson(actor)
        && existing.authorizedRunId === runId
        && canonicalJson(existing.targetIdentity) === canonicalJson(targetIdentity)) return existing;
      if (existing.state !== 'CONSUMED') {
        fail('CUTOVER_CANARY_LAUNCH_CONFLICT', `A different ${mode} handoff canary launch is already authorized.`);
      }
      if (existing.revision >= MAX_CUTOVER_CANARY_PERMIT_HISTORY) {
        fail('CUTOVER_CANARY_LAUNCH_CONFLICT', `The ${mode} handoff canary permit history bound is exhausted.`);
      }
      nonEmptyString(supersedeReason, 'Handoff canary supersedeReason');
      const replacedRun = await assertCanaryPermitReplaceable(store, existing);
      const failureAttempts = await failureAttemptsAfterCanaryPermit(storage, store, existing, replacedRun);
      if (failureAttempts >= MAX_CUTOVER_CANARY_FAILURE_ATTEMPTS_PER_MODE) {
        fail('CUTOVER_CANARY_LAUNCH_CONFLICT',
          `The ${mode} handoff canary failure-recovery bound is exhausted; explicitly cancelled canaries do not consume this budget.`);
      }
      const replacement = seal(canaryLaunchPermitBody({
        ...existing,
        revision: existing.revision + 1,
        previousPermitDigest: existing.digest,
        requestId,
        actor,
        intentDigest: canonicalDigest(intent),
        targetIdentity,
        authorizedRunId: runId,
        supersedesRunId: existing.runId,
        supersedeReason,
        failureAttempts,
        state: 'AUTHORIZED',
        runId: null,
        operationId: null,
        runRunnerRevision: null,
        runConfigurationRevision: null,
        authorizedAt: timestamp(clock),
        consumedAt: null,
      }));
      await persistCanaryLaunchPermit(storage, replacement);
      return clone(replacement);
    }
    const permit = seal(canaryLaunchPermitBody({
      cutoverId: handoffId,
      mode,
      revision: 1,
      previousPermitDigest: null,
      requestId,
      actor,
      intentDigest: canonicalDigest(intent),
      authoritySelectorDigest: selector.digest,
      admissionGateDigest: gate.digest,
      cutoverReportDigest: pendingReport.digest,
      activeBuildIdentity: handoffIntent.targetBuildIdentity,
      cutoverConfigurationDigest: handoffIntent.digest,
      storeBindingDigest: binding.digest,
      targetIdentity,
      authorizedRunId: runId,
      supersedesRunId: null,
      supersedeReason: null,
      failureAttempts: 0,
      state: 'AUTHORIZED',
      runId: null,
      operationId: null,
      runRunnerRevision: null,
      runConfigurationRevision: null,
      authorizedAt: timestamp(clock),
      consumedAt: null,
    }));
    await persistCanaryLaunchPermit(storage, permit);
    return clone(permit);
  });
}

export async function completeSharedAuthorityBuildHandoff({
  store, coordinator, admissionGate, legacyAuthorityFence, authorityFloor, reportDirectory, handoffId,
  readCanaryEvidence = defaultReadCanaryEvidence,
  probeTargetIdentity,
  clock = store?.clock ?? (() => Date.now()),
  hooks = {},
} = {}) {
  ensureCoordinator(coordinator);
  safeId(handoffId, 'handoffId');
  if (typeof probeTargetIdentity !== 'function') {
    fail('CUTOVER_CANARY_REPROBE_REQUIRED', 'Build handoff completion requires a trusted current target re-probe.');
  }
  if (!authorityFloor || typeof authorityFloor.read !== 'function'
    || typeof authorityFloor.compareAndAdvance !== 'function') {
    fail('AUTHORITY_FLOOR_REQUIRED', 'Build handoff completion requires the external authority floor.');
  }
  const storage = await openReportStorage(reportDirectory);
  return withCutoverLock(storage, handoffId, async () => {
    const finalPath = handoffPath(storage, handoffId, '.json');
    if (await pathExists(storage.fs, finalPath)) {
      const report = parseSealed(await readBoundedJson(storage, finalPath, {
        label: 'build handoff report', maximumBytes: 4 * 1_048_576,
      }), 'Build handoff report');
      const [selector, floor] = await Promise.all([readReleaseAuthoritySelector(store), authorityFloor.read()]);
      if (selector.digest !== report.selectorAfter?.digest || floor.digest !== report.authorityFloorAfter?.digest
        || selector.authorityTransitionDigest !== report.commitIntentDigest
        || floor.authorityTransitionDigest !== selector.authorityTransitionDigest) {
        fail('AUTHORITY_FLOOR_STATE_INVALID', 'Completed handoff report no longer matches selector and external floor authority.');
      }
      const gate = await admissionGate.read();
      if (gate.state === 'CLOSED' && gate.cutoverId === handoffId) await admissionGate.open(gate.digest, handoffId);
      return clone(report);
    }
    const { intent, checkpoint: originalCheckpoint } = await readHandoffDocuments(storage, handoffId);
    let checkpoint = originalCheckpoint;
    const legacy = await legacyAuthorityFence?.read();
    if (!legacy || legacy.state !== 'ACTIVATED' || legacy.activationEpoch !== 1) {
      fail('CUTOVER_LEGACY_FENCE_CONFLICT', 'Legacy authority must remain permanently activated through build handoff.');
    }
    let gate = await admissionGate.read();
    if (!((gate.state === 'CLOSED' && gate.cutoverId === handoffId) || gate.state === 'OPEN')) {
      fail('CUTOVER_ADMISSION_OWNED', 'Build handoff completion lost admission ownership.');
    }
    const canaries = await readCanaryHead(storage, handoffId);
    if (!canaries || CUTOVER_CANARY_MODES.some((mode) => canaries.receipts[mode] === null)) {
      fail('CUTOVER_CANARIES_INCOMPLETE', 'Build handoff requires current Single-site and Comparative target canaries.');
    }
    let selector = await readReleaseAuthoritySelector(store);
    if (!(selector.phase === 'ACTIVE' && selector.activeBuildIdentity === intent.targetBuildIdentity)
      && (selector.phase !== 'PROMOTION_DISABLED' || selector.handoffId !== handoffId
      || selector.pendingBuildIdentity !== intent.targetBuildIdentity || store.buildIdentity !== intent.targetBuildIdentity)) {
      fail('AUTHORITY_HANDOFF_INVALID', 'Selector is neither pending nor a recoverable committed target handoff.');
    }
    const expectedPublications = [];
    try {
      for (const mode of CUTOVER_CANARY_MODES) {
        const receipt = canaries.receipts[mode];
        const launchPermit = await readCanaryLaunchPermit(admissionGate, handoffId, mode);
        if (!launchPermit || launchPermit.digest !== receipt.launchPermitDigest) {
          fail('CUTOVER_CANARY_LAUNCH_MISMATCH', `${mode} handoff permit changed after recording.`);
        }
        const current = parseCanaryEvidence(await readCanaryEvidence(store, receipt.runId, { probeTargetIdentity }), {
          mode,
          runId: receipt.runId,
          selector,
          store,
          minimumCreatedAt: checkpoint.selectorCurrent.updatedAt,
          launchPermit,
          expectedBuildIdentity: intent.targetBuildIdentity,
        });
        if (current.finalSubjectDigest !== receipt.finalSubjectDigest
          || current.publicationDigest !== receipt.publicationDigest
          || current.decisionRevision !== receipt.decisionRevision) {
          fail('CUTOVER_CANARY_STALE', `${mode} handoff canary changed after recording.`);
        }
        expectedPublications.push({ mode, runId: receipt.runId, envelopeDigest: receipt.publicationDigest });
      }
    } catch (error) {
      const failure = {
        code: error?.code ?? 'HANDOFF_HEALTH_REPROBE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        failedAt: timestamp(clock),
      };
      checkpoint = await writeHandoffCheckpoint(storage, {
        ...checkpoint, status: 'FAILED_HOLD', failure, updatedAt: timestamp(clock),
      });
      const failed = seal({
        schemaVersion: 1,
        kind: 'release-authority-build-handoff-failed-hold',
        handoffId,
        status: 'FAILED_HOLD',
        intentDigest: intent.digest,
        checkpointDigest: checkpoint.digest,
        selector,
        admissionGate: gate,
        canaryHeadDigest: canaries.digest,
        failure,
      });
      const failedPath = handoffPath(storage, handoffId, `.failed-${checkpoint.digest.slice('sha256:'.length)}.json`);
      if (!await pathExists(storage.fs, failedPath)) await atomicWriteJson(storage, failedPath, failed, { exclusive: true });
      throw error;
    }
    const targetSelectorRevision = checkpoint.selectorCurrent.revision + 1;
    const proposedCommitIntent = seal({
      schemaVersion: 1,
      kind: 'release-authority-build-handoff-commit-intent',
      handoffId,
      intentDigest: intent.digest,
      checkpointDigest: checkpoint.digest,
      selectorBeforeDigest: checkpoint.selectorCurrent.digest,
      targetSelectorRevision,
      targetBuildIdentity: intent.targetBuildIdentity,
      authorityFloorBeforeDigest: intent.authorityFloorBeforeDigest,
      activationCutoverDigest: intent.activationCutoverDigest,
      canaryHeadDigest: canaries.digest,
      admissionGateDigest: checkpoint.admissionCurrent.digest,
      expectedPublications,
      createdAt: timestamp(clock),
    });
    const commitPath = handoffPath(storage, handoffId, '.commit-intent.json');
    let commitIntent = proposedCommitIntent;
    if (await pathExists(storage.fs, commitPath)) {
      const existing = parseSealed(await readBoundedJson(storage, commitPath, {
        label: 'build handoff commit intent', maximumBytes: 512 * 1_024,
      }), 'Build handoff commit intent');
      if (existing.kind !== proposedCommitIntent.kind || existing.handoffId !== handoffId
        || existing.intentDigest !== proposedCommitIntent.intentDigest
        || existing.selectorBeforeDigest !== proposedCommitIntent.selectorBeforeDigest
        || existing.targetSelectorRevision !== proposedCommitIntent.targetSelectorRevision
        || existing.targetBuildIdentity !== proposedCommitIntent.targetBuildIdentity
        || existing.authorityFloorBeforeDigest !== proposedCommitIntent.authorityFloorBeforeDigest
        || existing.activationCutoverDigest !== proposedCommitIntent.activationCutoverDigest
        || existing.canaryHeadDigest !== proposedCommitIntent.canaryHeadDigest
        || existing.admissionGateDigest !== proposedCommitIntent.admissionGateDigest
        || canonicalJson(existing.expectedPublications) !== canonicalJson(proposedCommitIntent.expectedPublications)) {
        fail('CUTOVER_CHECKPOINT_CONFLICT', 'Build handoff commit intent is immutable.');
      }
      commitIntent = existing;
    } else {
      await atomicWriteJson(storage, commitPath, commitIntent, { exclusive: true });
    }
    await hooks.afterCommitIntentPersisted?.(clone(commitIntent));
    let floorAfter = await authorityFloor.read();
    if (floorAfter.digest === commitIntent.authorityFloorBeforeDigest) {
      floorAfter = await authorityFloor.compareAndAdvance(commitIntent.authorityFloorBeforeDigest, {
        minimumStoreGeneration: selector.storeGeneration,
        minimumSelectorRevision: commitIntent.targetSelectorRevision,
        activeBuildIdentity: intent.targetBuildIdentity,
        authorityTransitionDigest: commitIntent.digest,
        activationEpoch: 1,
        legacyPermanentlyRetired: true,
        activationRevision: selector.activationRevision,
        activationCutoverDigest: commitIntent.activationCutoverDigest,
      });
    } else if (floorAfter.minimumStoreGeneration !== selector.storeGeneration
      || floorAfter.minimumSelectorRevision !== commitIntent.targetSelectorRevision
      || floorAfter.activeBuildIdentity !== intent.targetBuildIdentity
      || floorAfter.authorityTransitionDigest !== commitIntent.digest
      || floorAfter.activationEpoch !== 1 || floorAfter.legacyPermanentlyRetired !== true
      || floorAfter.activationRevision !== selector.activationRevision
      || floorAfter.activationCutoverDigest !== commitIntent.activationCutoverDigest) {
      fail('AUTHORITY_FLOOR_STATE_INVALID', 'External authority floor is neither before nor exactly after this handoff commit.');
    }
    await hooks.afterAuthorityFloorAdvanced?.(clone(floorAfter));
    selector = await readReleaseAuthoritySelector(store);
    const recoveringCommitted = selector.phase === 'ACTIVE'
      && selector.activeBuildIdentity === intent.targetBuildIdentity
      && selector.revision === commitIntent.targetSelectorRevision
      && selector.previousDigest === commitIntent.selectorBeforeDigest
      && selector.authorityTransitionDigest === commitIntent.digest;
    if (!recoveringCommitted) {
      if (selector.phase !== 'PROMOTION_DISABLED' || selector.digest !== commitIntent.selectorBeforeDigest) {
        fail('AUTHORITY_HANDOFF_INVALID', 'Floor advanced, but selector is not the exact pending or committed handoff state.');
      }
      selector = await completeReleaseAuthorityBuildHandoffWithPublicationFence(store, coordinator, {
        expectedSelectorDigest: commitIntent.selectorBeforeDigest,
        handoffId,
        targetBuildIdentity: intent.targetBuildIdentity,
        expectedTargetSelectorRevision: commitIntent.targetSelectorRevision,
        authorityTransitionDigest: commitIntent.digest,
        expectedPublications,
      });
      await hooks.afterAuthorityCommitted?.(clone(selector));
    }
    if (gate.state === 'CLOSED') gate = await admissionGate.open(gate.digest, handoffId);
    await hooks.afterAdmissionOpened?.(clone(gate));
    checkpoint = await writeHandoffCheckpoint(storage, {
      ...checkpoint,
      status: 'COMPLETED',
      selectorCurrent: selector,
      admissionCurrent: gate,
      canaryHeadDigest: canaries.digest,
      commitIntentDigest: commitIntent.digest,
      authorityFloorAfterDigest: floorAfter.digest,
      failure: null,
      updatedAt: timestamp(clock),
    });
    const report = seal({
      schemaVersion: 1,
      kind: 'release-authority-build-handoff-report',
      handoffId,
      status: 'ACTIVE_TARGET_ADMISSION_OPEN',
      intent,
      commitIntentDigest: commitIntent.digest,
      authorityFloorBeforeDigest: commitIntent.authorityFloorBeforeDigest,
      authorityFloorAfter: floorAfter,
      checkpointDigest: checkpoint.digest,
      selectorBefore: checkpoint.selectorBefore,
      selectorAfter: selector,
      admissionBefore: checkpoint.admissionBefore,
      admissionAfter: gate,
      drainObservation: checkpoint.drainObservation,
      canaryHead: canaries,
      legacyAuthorityFence: legacy,
      completedAt: timestamp(clock),
    });
    try {
      await atomicWriteJson(storage, finalPath, report, { exclusive: true });
    } catch (error) {
      if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
      const existing = parseSealed(await readBoundedJson(storage, finalPath, {
        label: 'build handoff report', maximumBytes: 4 * 1_048_576,
      }), 'Build handoff report');
      return clone(existing);
    }
    return clone(report);
  });
}

export async function setSharedPromotionAvailability({
  store,
  coordinator,
  authorityFloor,
  phase,
  buildIdentity,
  reportDirectory = null,
  cutoverId = null,
  healthCanaries = null,
  readCanaryEvidence = defaultReadCanaryEvidence,
  probeTargetIdentity,
  transitionWithPublicationFence = transitionReleaseAuthorityWithPublicationFence,
  clock = store?.clock ?? (() => Date.now()),
  hooks = {},
} = {}) {
  ensureCoordinator(coordinator);
  if (!authorityFloor || typeof authorityFloor.read !== 'function'
    || typeof authorityFloor.compareAndAdvance !== 'function') {
    fail('AUTHORITY_FLOOR_REQUIRED', 'Promotion availability changes require the external authority floor.');
  }
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
  safeId(cutoverId, 'cutoverId');
  const storage = await openReportStorage(reportDirectory);
  const floorBefore = await authorityFloor.read();
  if (phase === selector.phase) {
    if (authorityFloorMatchesActivatedSelector(floorBefore, selector)) return clone(selector);
    if (selector.revision < 2 || selector.previousDigest === null) {
      fail('AUTHORITY_FLOOR_STATE_INVALID', 'Promotion transition recovery has no prior selector lineage.');
    }
    const intent = parsePromotionTransitionIntent(await readBoundedJson(
      storage,
      promotionTransitionIntentPath(storage, cutoverId, selector.revision - 1, phase),
      { label: 'promotion transition intent', maximumBytes: 256 * 1_024 },
    ), cutoverId, selector.revision - 1, phase);
    if (selector.previousDigest !== intent.selectorBeforeDigest
      || selector.authorityTransitionDigest !== intent.digest
      || selector.activeBuildIdentity !== intent.activeBuildIdentity) {
      fail('AUTHORITY_FLOOR_STATE_INVALID', 'Promotion transition recovery does not match the durable selector successor.');
    }
    const recoveredFloor = await advancePromotionAuthorityFloor(authorityFloor, intent, selector);
    await hooks.afterAuthorityFloorAdvanced?.(clone(recoveredFloor));
    return clone(selector);
  }
  if (!authorityFloorMatchesActivatedSelector(floorBefore, selector)) {
    fail('AUTHORITY_FLOOR_STATE_INVALID', 'Promotion transition requires selector state exactly bound to the external authority floor.');
  }
  let healthReceipt = null;
  if (!isRecord(healthCanaries)) {
    if (phase === 'ACTIVE') {
      fail('CUTOVER_PROMOTION_HEALTH_REQUIRED', 'Promotion re-enable requires fresh Single-site and Comparative health canaries.');
    }
  } else if (phase !== 'ACTIVE') {
    fail('CUTOVER_INPUT_INVALID', 'Promotion disable does not accept health-canary evidence.');
  }
  const evidence = {};
  if (phase === 'ACTIVE') {
    exactKeys(healthCanaries, CUTOVER_CANARY_MODES, 'promotion health canaries');
    for (const mode of CUTOVER_CANARY_MODES) {
      const runId = safeId(healthCanaries[mode], `${mode} health canary runId`);
      evidence[mode] = parseCanaryEvidence(
        await readCanaryEvidence(store, runId, { probeTargetIdentity }),
        { mode, runId, selector, store, minimumCreatedAt: selector.updatedAt },
      );
    }
    const healthBinding = {
      schemaVersion: 1,
      kind: 'release-promotion-health-receipt',
      cutoverId,
      selectorBeforeDigest: selector.digest,
      activeBuildIdentity: selector.activeBuildIdentity,
      storeBindingDigest: cutoverStoreBinding(store).digest,
      canaries: evidence,
    };
    const evidenceTime = Math.max(...CUTOVER_CANARY_MODES.map((mode) => Date.parse(evidence[mode].createdAt)));
    healthReceipt = seal({ ...healthBinding, recordedAt: new Date(evidenceTime).toISOString() });
    const healthPath = reportStoragePath(
      storage,
      cutoverId,
      `.promotion-health-${healthReceipt.digest.slice('sha256:'.length)}.json`,
    );
    if (!await pathExists(storage.fs, healthPath)) {
      await atomicWriteJson(storage, healthPath, healthReceipt, { exclusive: true });
    }
  }
  const intent = await persistPromotionTransitionIntent(storage, {
    cutoverId,
    selectorBeforeDigest: selector.digest,
    selectorBeforeRevision: selector.revision,
    targetPhase: phase,
    activeBuildIdentity: selector.activeBuildIdentity,
    authorityFloorBeforeDigest: floorBefore.digest,
    activationRevision: selector.activationRevision,
    activationCutoverDigest: selector.activationCutoverDigest,
    healthReceiptDigest: healthReceipt?.digest ?? null,
    createdAt: timestamp(clock),
  });
  if (phase === 'ACTIVE' && typeof transitionWithPublicationFence !== 'function') {
    fail('CUTOVER_INPUT_INVALID', 'Promotion health publication fence is required.');
  }
  const transition = {
    expectedSelectorDigest: selector.digest,
    phase,
    activationRevision: selector.activationRevision,
    buildIdentity,
    authorityTransitionDigest: intent.digest,
  };
  if (phase === 'ACTIVE') transition.expectedPublications = CUTOVER_CANARY_MODES.map((mode) => ({
      runId: evidence[mode].runId,
      envelopeDigest: evidence[mode].publicationDigest,
    }));
  const transitioned = phase === 'ACTIVE'
    ? await transitionWithPublicationFence(store, coordinator, transition)
    : await transitionReleaseAuthority(store, coordinator, transition);
  await hooks.afterSelectorTransition?.(clone(transitioned));
  const floorAfter = await advancePromotionAuthorityFloor(authorityFloor, intent, transitioned);
  await hooks.afterAuthorityFloorAdvanced?.(clone(floorAfter));
  if (phase === 'PROMOTION_DISABLED') return clone(transitioned);
  const reenableReport = seal({
    schemaVersion: 1,
    kind: 'release-promotion-reenable-report',
    cutoverId,
    selectorBefore: selector,
    selectorAfter: transitioned,
    transitionIntentDigest: intent.digest,
    authorityFloorBeforeDigest: intent.authorityFloorBeforeDigest,
    authorityFloorAfter: floorAfter,
    healthReceiptDigest: healthReceipt.digest,
    completedAt: timestamp(clock),
  });
  const reenablePath = reportStoragePath(storage, cutoverId, `.promotion-reenable-${selector.revision}.json`);
  if (!await pathExists(storage.fs, reenablePath)) {
    await atomicWriteJson(storage, reenablePath, reenableReport, { exclusive: true });
  }
  return Object.freeze({ selector: transitioned, healthReceipt: clone(healthReceipt) });
}
