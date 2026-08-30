import path from 'node:path';

import {
  assertDigest,
  canonicalDigest,
  exactKeys,
  isRecord,
} from '../../shared/canonical-contract.mjs';
import {
  atomicWriteJson,
  containedPath,
  openAtomicStorage,
  pathExists,
  readBoundedJson,
  withDirectoryLock,
} from './atomic-filesystem.mjs';

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const FLOOR_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'revision', 'storeMarkerDigest', 'minimumStoreGeneration',
  'minimumSelectorRevision', 'activeBuildIdentity', 'authorityTransitionDigest',
  'activationEpoch', 'legacyPermanentlyRetired', 'activationRevision',
  'activationCutoverDigest', 'previousDigest', 'updatedAt', 'digest',
]);
const PLAN_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'planId', 'createdAt', 'basedOnFloorDigest',
  'storeMarkerDigest', 'previousMinimumStoreGeneration', 'restoredStoreGeneration',
  'nextStoreGeneration', 'previousMinimumSelectorRevision', 'restoredSelectorRevision',
  'nextSelectorRevision', 'activeBuildIdentity', 'previousAuthorityTransitionDigest',
  'nextAuthorityTransitionDigest', 'activationEpoch', 'activationRevision',
  'activationCutoverDigest', 'requiredSelectorPhase', 'requiredLegacyFenceState',
  'invalidatesPriorReleaseBindings', 'requiresNewAuthoritativeRuns', 'digest',
]);
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'planId', 'planDigest', 'completedAt',
  'previousFloorDigest', 'resultingFloorDigest', 'storeMarkerDigest',
  'previousMinimumStoreGeneration', 'minimumStoreGeneration',
  'previousMinimumSelectorRevision', 'minimumSelectorRevision', 'activeBuildIdentity',
  'previousAuthorityTransitionDigest', 'authorityTransitionDigest', 'activationEpoch',
  'activationRevision', 'activationCutoverDigest', 'authorityStateDigest', 'selectorPhase',
  'legacyFenceState', 'invalidatesPriorReleaseBindings', 'requiresNewAuthoritativeRuns',
  'digest',
]);
const UPDATE_KEYS = Object.freeze([
  'storeMarkerDigest', 'minimumStoreGeneration', 'minimumSelectorRevision',
  'activeBuildIdentity', 'authorityTransitionDigest', 'activationEpoch',
  'legacyPermanentlyRetired', 'activationRevision', 'activationCutoverDigest',
]);

export class SharedAuthorityFloorError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SharedAuthorityFloorError';
    this.code = code;
    this.details = details;
    this.statusCode = 503;
  }
}

function fail(code, message, details) {
  throw new SharedAuthorityFloorError(code, message, details);
}

function timestamp(value, label, code = 'AUTHORITY_FLOOR_CORRUPT') {
  if (typeof value !== 'string') fail(code, `${label} is invalid.`);
  try {
    if (new Date(value).toISOString() !== value) fail(code, `${label} is invalid.`);
  } catch (error) {
    if (error instanceof SharedAuthorityFloorError) throw error;
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function digest(value, label, code = 'AUTHORITY_FLOOR_CORRUPT') {
  try {
    return assertDigest(value, label);
  } catch {
    fail(code, `${label} is invalid.`);
  }
}

function safeId(value, label, code = 'AUTHORITY_RESTORE_PLAN_INVALID') {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || /^\.+$/u.test(value)) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value, label, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, `${label} must be a positive safe integer.`);
  return value;
}

function nonEmptyString(value, label, code) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1
    || value.length > 512 || value.includes('\0')) fail(code, `${label} is invalid.`);
  return value;
}

function floorBody(value) {
  return {
    schemaVersion: 1,
    kind: 'shared-release-authority-floor',
    revision: value.revision,
    storeMarkerDigest: value.storeMarkerDigest,
    minimumStoreGeneration: value.minimumStoreGeneration,
    minimumSelectorRevision: value.minimumSelectorRevision,
    activeBuildIdentity: value.activeBuildIdentity,
    authorityTransitionDigest: value.authorityTransitionDigest,
    activationEpoch: value.activationEpoch,
    legacyPermanentlyRetired: value.legacyPermanentlyRetired,
    activationRevision: value.activationRevision,
    activationCutoverDigest: value.activationCutoverDigest,
    previousDigest: value.previousDigest,
    updatedAt: value.updatedAt,
  };
}

function sealFloor(value) {
  const document = floorBody(value);
  return Object.freeze({ ...document, digest: canonicalDigest(document) });
}

export function parseSharedAuthorityFloor(value) {
  try {
    exactKeys(value, FLOOR_KEYS, 'Shared release authority floor');
  } catch {
    fail('AUTHORITY_FLOOR_CORRUPT', 'Shared release authority floor has an invalid schema.');
  }
  const body = floorBody(value);
  digest(value.storeMarkerDigest, 'authority floor store marker digest');
  if (value.previousDigest !== null) digest(value.previousDigest, 'authority floor previous digest');
  if (value.activationCutoverDigest !== null) {
    digest(value.activationCutoverDigest, 'authority floor activation cutover digest');
  }
  if (value.authorityTransitionDigest !== null) {
    digest(value.authorityTransitionDigest, 'authority floor transition digest');
  }
  timestamp(value.updatedAt, 'authority floor updatedAt');
  if (value.schemaVersion !== 1 || value.kind !== 'shared-release-authority-floor'
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.minimumStoreGeneration) || value.minimumStoreGeneration < 1
    || !Number.isSafeInteger(value.minimumSelectorRevision) || value.minimumSelectorRevision < 1
    || ![0, 1].includes(value.activationEpoch)
    || typeof value.legacyPermanentlyRetired !== 'boolean'
    || value.digest !== canonicalDigest(body)) {
    fail('AUTHORITY_FLOOR_CORRUPT', 'Shared release authority floor is corrupt or unsupported.');
  }
  const active = value.activationEpoch === 1;
  if (active) {
    nonEmptyString(value.activeBuildIdentity, 'authority floor active build identity', 'AUTHORITY_FLOOR_CORRUPT');
  }
  if ((active && (value.legacyPermanentlyRetired !== true
    || !Number.isSafeInteger(value.activationRevision) || value.activationRevision < 1
    || value.activationCutoverDigest === null
    || value.authorityTransitionDigest === null))
    || (!active && (value.legacyPermanentlyRetired !== false
      || value.activationRevision !== null || value.activationCutoverDigest !== null
      || value.activeBuildIdentity !== null || value.authorityTransitionDigest !== null))) {
    fail('AUTHORITY_FLOOR_CORRUPT', 'Shared release authority floor activation fields are contradictory.');
  }
  return structuredClone(value);
}

function parsePlan(value) {
  try {
    exactKeys(value, PLAN_KEYS, 'Shared authority restore-forward plan');
  } catch {
    fail('AUTHORITY_RESTORE_PLAN_INVALID', 'Restore-forward plan has an invalid schema.');
  }
  safeId(value.planId, 'planId');
  timestamp(value.createdAt, 'restore-forward plan createdAt', 'AUTHORITY_RESTORE_PLAN_INVALID');
  for (const [entry, label] of [
    [value.basedOnFloorDigest, 'basedOnFloorDigest'],
    [value.storeMarkerDigest, 'storeMarkerDigest'],
    [value.activationCutoverDigest, 'activationCutoverDigest'],
    [value.previousAuthorityTransitionDigest, 'previousAuthorityTransitionDigest'],
    [value.nextAuthorityTransitionDigest, 'nextAuthorityTransitionDigest'],
  ]) digest(entry, label, 'AUTHORITY_RESTORE_PLAN_INVALID');
  nonEmptyString(value.activeBuildIdentity, 'activeBuildIdentity', 'AUTHORITY_RESTORE_PLAN_INVALID');
  const { digest: planDigest, ...body } = value;
  if (value.schemaVersion !== 1 || value.kind !== 'shared-authority-restore-forward-plan'
    || planDigest !== canonicalDigest(body)
    || positiveInteger(value.previousMinimumStoreGeneration, 'previousMinimumStoreGeneration', 'AUTHORITY_RESTORE_PLAN_INVALID') < 1
    || positiveInteger(value.restoredStoreGeneration, 'restoredStoreGeneration', 'AUTHORITY_RESTORE_PLAN_INVALID') < 1
    || positiveInteger(value.nextStoreGeneration, 'nextStoreGeneration', 'AUTHORITY_RESTORE_PLAN_INVALID') < 1
    || positiveInteger(value.previousMinimumSelectorRevision, 'previousMinimumSelectorRevision', 'AUTHORITY_RESTORE_PLAN_INVALID') < 1
    || positiveInteger(value.restoredSelectorRevision, 'restoredSelectorRevision', 'AUTHORITY_RESTORE_PLAN_INVALID') < 1
    || positiveInteger(value.nextSelectorRevision, 'nextSelectorRevision', 'AUTHORITY_RESTORE_PLAN_INVALID') < 1
    || value.nextStoreGeneration <= value.previousMinimumStoreGeneration
    || value.nextStoreGeneration <= value.restoredStoreGeneration
    || value.nextSelectorRevision <= value.previousMinimumSelectorRevision
    || value.nextSelectorRevision <= value.restoredSelectorRevision
    || value.nextAuthorityTransitionDigest === value.previousAuthorityTransitionDigest
    || value.activationEpoch !== 1
    || !Number.isSafeInteger(value.activationRevision) || value.activationRevision < 1
    || value.requiredSelectorPhase !== 'PROMOTION_DISABLED'
    || value.requiredLegacyFenceState !== 'ACTIVATED'
    || value.invalidatesPriorReleaseBindings !== true
    || value.requiresNewAuthoritativeRuns !== true) {
    fail('AUTHORITY_RESTORE_PLAN_INVALID', 'Restore-forward plan is corrupt or violates repair-forward invariants.');
  }
  return structuredClone(value);
}

export function parseSharedAuthorityRestoreReceipt(value) {
  try {
    exactKeys(value, RECEIPT_KEYS, 'Shared authority restore-forward receipt');
  } catch {
    fail('AUTHORITY_RESTORE_RECEIPT_INVALID', 'Restore-forward receipt has an invalid schema.');
  }
  safeId(value.planId, 'planId', 'AUTHORITY_RESTORE_RECEIPT_INVALID');
  timestamp(value.completedAt, 'restore-forward receipt completedAt', 'AUTHORITY_RESTORE_RECEIPT_INVALID');
  for (const [entry, label] of [
    [value.planDigest, 'planDigest'], [value.previousFloorDigest, 'previousFloorDigest'],
    [value.resultingFloorDigest, 'resultingFloorDigest'], [value.storeMarkerDigest, 'storeMarkerDigest'],
    [value.activationCutoverDigest, 'activationCutoverDigest'], [value.authorityStateDigest, 'authorityStateDigest'],
    [value.previousAuthorityTransitionDigest, 'previousAuthorityTransitionDigest'],
    [value.authorityTransitionDigest, 'authorityTransitionDigest'],
  ]) digest(entry, label, 'AUTHORITY_RESTORE_RECEIPT_INVALID');
  nonEmptyString(value.activeBuildIdentity, 'activeBuildIdentity', 'AUTHORITY_RESTORE_RECEIPT_INVALID');
  const { digest: receiptDigest, ...body } = value;
  if (value.schemaVersion !== 1 || value.kind !== 'shared-authority-restore-forward-receipt'
    || receiptDigest !== canonicalDigest(body)
    || !Number.isSafeInteger(value.previousMinimumStoreGeneration) || value.previousMinimumStoreGeneration < 1
    || !Number.isSafeInteger(value.minimumStoreGeneration)
    || value.minimumStoreGeneration <= value.previousMinimumStoreGeneration
    || !Number.isSafeInteger(value.previousMinimumSelectorRevision) || value.previousMinimumSelectorRevision < 1
    || !Number.isSafeInteger(value.minimumSelectorRevision)
    || value.minimumSelectorRevision <= value.previousMinimumSelectorRevision
    || value.authorityTransitionDigest === value.previousAuthorityTransitionDigest
    || value.activationEpoch !== 1 || !Number.isSafeInteger(value.activationRevision)
    || value.activationRevision < 1 || value.selectorPhase !== 'PROMOTION_DISABLED'
    || value.legacyFenceState !== 'ACTIVATED'
    || value.invalidatesPriorReleaseBindings !== true || value.requiresNewAuthoritativeRuns !== true) {
    fail('AUTHORITY_RESTORE_RECEIPT_INVALID', 'Restore-forward receipt is corrupt or violates repair-forward invariants.');
  }
  return structuredClone(value);
}

function normalizeInitial(value) {
  if (!isRecord(value)) fail('AUTHORITY_FLOOR_INPUT_INVALID', 'Initial authority floor is required.');
  const unknown = Object.keys(value).filter((key) => !UPDATE_KEYS.includes(key));
  if (unknown.length > 0 || UPDATE_KEYS.some((key) => !Object.hasOwn(value, key))) {
    fail('AUTHORITY_FLOOR_INPUT_INVALID', 'Initial authority floor has an invalid schema.');
  }
  return value;
}

function normalizeUpdate(value) {
  if (!isRecord(value) || Object.keys(value).length < 1) {
    fail('AUTHORITY_FLOOR_INPUT_INVALID', 'Authority floor update must be a non-empty object.');
  }
  const unknown = Object.keys(value).filter((key) => !UPDATE_KEYS.includes(key));
  if (unknown.length > 0) fail('AUTHORITY_FLOOR_INPUT_INVALID', `Unsupported authority floor fields: ${unknown.sort().join(', ')}.`);
  return value;
}

function validateMonotonic(current, candidate) {
  if (candidate.storeMarkerDigest !== current.storeMarkerDigest) {
    fail('AUTHORITY_FLOOR_MARKER_MISMATCH', 'The external authority floor store marker is immutable.');
  }
  if (candidate.minimumStoreGeneration < current.minimumStoreGeneration
    || candidate.minimumSelectorRevision < current.minimumSelectorRevision
    || candidate.activationEpoch < current.activationEpoch
    || (current.legacyPermanentlyRetired && !candidate.legacyPermanentlyRetired)) {
    fail('AUTHORITY_FLOOR_REGRESSION', 'The external authority floor cannot move backward.');
  }
  if (current.activationEpoch === 1 && (candidate.activationEpoch !== 1
    || candidate.activationRevision !== current.activationRevision
    || candidate.activationCutoverDigest !== current.activationCutoverDigest)) {
    fail('AUTHORITY_FLOOR_REGRESSION', 'The completed shared activation identity is immutable.');
  }
  const ownerChanged = candidate.activeBuildIdentity !== current.activeBuildIdentity;
  const transitionChanged = candidate.authorityTransitionDigest !== current.authorityTransitionDigest;
  if ((ownerChanged || transitionChanged)
    && candidate.minimumSelectorRevision <= current.minimumSelectorRevision) {
    fail('AUTHORITY_FLOOR_REGRESSION', 'Authority ownership can change only with a newer selector revision.');
  }
  if (ownerChanged && !transitionChanged) {
    fail('AUTHORITY_FLOOR_REGRESSION', 'A new active build requires a new authority transition identity.');
  }
}

function revisionName(revision) {
  return `${String(revision).padStart(16, '0')}.json`;
}

function assertExternalRoot(root, protectedRoots) {
  if (!Array.isArray(protectedRoots) || protectedRoots.length < 1
    || protectedRoots.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    fail('AUTHORITY_FLOOR_INPUT_INVALID', 'At least one canonical or backup protected root is required.');
  }
  const floorRoot = path.resolve(root);
  for (const entry of protectedRoots) {
    const protectedRoot = path.resolve(entry);
    const floorInsideProtected = floorRoot === protectedRoot || floorRoot.startsWith(`${protectedRoot}${path.sep}`);
    const protectedInsideFloor = protectedRoot.startsWith(`${floorRoot}${path.sep}`);
    if (floorInsideProtected || protectedInsideFloor) {
      fail('AUTHORITY_FLOOR_NOT_EXTERNAL', 'Authority floor storage must not overlap the canonical store or any backup/restore root.', {
        authorityFloorRoot: floorRoot, protectedRoot,
      });
    }
  }
}

async function storageFor(options) {
  if (typeof options.root !== 'string' || options.root.length === 0) {
    fail('AUTHORITY_FLOOR_INPUT_INVALID', 'Authority floor root is required.');
  }
  assertExternalRoot(options.root, options.protectedRoots);
  const storage = await openAtomicStorage({
    root: options.root, filesystem: options.filesystem, nonce: options.nonce,
    verify: options.verifyStorage ?? true,
  });
  assertExternalRoot(storage.root, options.protectedRoots);
  return storage;
}

function createHandle(storage, clock) {
  const headFile = containedPath(storage.root, 'authority-floor.json');
  const revisionRoot = containedPath(storage.root, 'revisions');
  const lockFile = containedPath(storage.root, '.authority-floor.lock');

  async function readJournal() {
    let names;
    try {
      names = (await storage.fs.readdir(revisionRoot)).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if (error?.code === 'ENOENT') fail('AUTHORITY_FLOOR_CORRUPT', 'Authority floor revision journal is missing.');
      throw error;
    }
    if (names.length < 1) fail('AUTHORITY_FLOOR_CORRUPT', 'Authority floor revision journal is empty.');
    let previous = null;
    const documents = [];
    for (let index = 0; index < names.length; index += 1) {
      const expectedName = revisionName(index + 1);
      if (names[index] !== expectedName) fail('AUTHORITY_FLOOR_CORRUPT', 'Authority floor revision journal is non-contiguous.');
      let document;
      try {
        document = parseSharedAuthorityFloor(await readBoundedJson(storage, containedPath(revisionRoot, names[index]), {
          label: `authority floor revision ${index + 1}`, maximumBytes: 64 * 1_024,
        }));
      } catch (error) {
        if (error instanceof SharedAuthorityFloorError) throw error;
        fail('AUTHORITY_FLOOR_CORRUPT', 'Authority floor revision journal is unreadable.', { cause: error?.code ?? error?.message });
      }
      if (document.revision !== index + 1 || document.previousDigest !== (previous?.digest ?? null)) {
        fail('AUTHORITY_FLOOR_CORRUPT', 'Authority floor revision chain is broken.');
      }
      if (previous) validateMonotonic(previous, document);
      documents.push(document);
      previous = document;
    }
    return documents;
  }

  async function readUnlocked() {
    const journal = await readJournal();
    const latest = journal.at(-1);
    let head;
    try {
      head = parseSharedAuthorityFloor(await readBoundedJson(storage, headFile, {
        label: 'shared release authority floor', maximumBytes: 64 * 1_024,
      }));
    } catch (error) {
      if (error?.code === 'ATOMIC_NOT_FOUND') {
        await atomicWriteJson(storage, headFile, latest);
        return structuredClone(latest);
      }
      if (error instanceof SharedAuthorityFloorError) throw error;
      fail('AUTHORITY_FLOOR_CORRUPT', 'Authority floor head is missing, corrupt, or unreadable.', {
        cause: error?.code ?? error?.message,
      });
    }
    const ancestor = journal[head.revision - 1];
    if (!ancestor || ancestor.digest !== head.digest) {
      fail('AUTHORITY_FLOOR_ROLLBACK_DETECTED', 'Authority floor head is not the latest durable monotonic revision.', {
        headRevision: head.revision, journalRevision: latest.revision,
      });
    }
    if (head.digest !== latest.digest) await atomicWriteJson(storage, headFile, latest);
    return structuredClone(latest);
  }

  async function read() {
    return withDirectoryLock(storage, lockFile, readUnlocked);
  }

  async function append(current, candidate) {
    const next = sealFloor({
      ...candidate,
      revision: current.revision + 1,
      previousDigest: current.digest,
      updatedAt: new Date(clock()).toISOString(),
    });
    parseSharedAuthorityFloor(next);
    await atomicWriteJson(storage, containedPath(revisionRoot, revisionName(next.revision)), next, { exclusive: true });
    await atomicWriteJson(storage, headFile, next);
    return structuredClone(next);
  }

  async function compareAndAdvance(expectedDigest, update) {
    digest(expectedDigest, 'expected authority floor digest', 'AUTHORITY_FLOOR_INPUT_INVALID');
    const normalized = normalizeUpdate(update);
    return withDirectoryLock(storage, lockFile, async () => {
      const current = await readUnlocked();
      if (current.digest !== expectedDigest) {
        fail('AUTHORITY_FLOOR_CONFLICT', 'Authority floor changed before the monotonic update.');
      }
      const candidate = { ...current, ...normalized };
      delete candidate.digest;
      delete candidate.revision;
      delete candidate.previousDigest;
      delete candidate.updatedAt;
      validateMonotonic(current, candidate);
      const prospective = sealFloor({
        ...candidate, revision: current.revision, previousDigest: current.previousDigest, updatedAt: current.updatedAt,
      });
      parseSharedAuthorityFloor(prospective);
      if (prospective.digest === current.digest) return current;
      return append(current, candidate);
    });
  }

  async function assertAuthorityState(value) {
    if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.selector)
      || !isRecord(value.legacyFence)) {
      fail('AUTHORITY_FLOOR_STATE_INVALID', 'Manifest, selector, and legacy fence observations are required.');
    }
    const floor = await read();
    const { manifest, selector, legacyFence } = value;
    if (manifest.storeMarkerDigest !== floor.storeMarkerDigest
      || selector.storeMarkerDigest !== floor.storeMarkerDigest) {
      fail('AUTHORITY_FLOOR_MARKER_MISMATCH', 'Restored authority state belongs to another canonical store.');
    }
    if (!Number.isSafeInteger(manifest.storeGeneration) || !Number.isSafeInteger(selector.storeGeneration)
      || manifest.storeGeneration !== selector.storeGeneration
      || manifest.storeGeneration < floor.minimumStoreGeneration) {
      fail('AUTHORITY_FLOOR_STALE_STORE', 'Restored authority state is below the external generation floor.');
    }
    if (manifest.activationEpoch !== floor.activationEpoch || selector.activationEpoch !== floor.activationEpoch
      || manifest.activationRevision !== floor.activationRevision
      || selector.activationRevision !== floor.activationRevision
      || (floor.activationEpoch === 1 && !['ACTIVE', 'PROMOTION_DISABLED'].includes(selector.phase))) {
      fail('AUTHORITY_FLOOR_STALE_ACTIVATION', 'Restored manifest or selector predates the external activation floor.');
    }
    if (!Number.isSafeInteger(selector.revision) || selector.revision < floor.minimumSelectorRevision) {
      fail('AUTHORITY_FLOOR_STALE_SELECTOR', 'Restored selector predates the external selector revision floor.');
    }
    if (selector.activeBuildIdentity !== floor.activeBuildIdentity) {
      fail('AUTHORITY_FLOOR_OWNER_MISMATCH', 'Restored selector belongs to a superseded authority build.');
    }
    if (selector.authorityTransitionDigest !== floor.authorityTransitionDigest) {
      fail('AUTHORITY_FLOOR_TRANSITION_MISMATCH', 'Restored selector predates the current authority transition.');
    }
    if (floor.legacyPermanentlyRetired
      && (legacyFence.state !== 'ACTIVATED' || legacyFence.activationEpoch !== floor.activationEpoch)) {
      fail('AUTHORITY_FLOOR_LEGACY_RESTORED', 'Legacy release authority remains permanently retired.');
    }
    if (selector.activationCutoverDigest !== floor.activationCutoverDigest) {
      fail('AUTHORITY_FLOOR_CUTOVER_MISMATCH', 'Restored authority state is not bound to the activated cutover.');
    }
    return floor;
  }

  async function planRestoreForward({ expectedDigest, planId, restoredStoreGeneration, restoredSelectorRevision }) {
    digest(expectedDigest, 'expected authority floor digest', 'AUTHORITY_RESTORE_PLAN_INVALID');
    safeId(planId, 'planId');
    positiveInteger(restoredStoreGeneration, 'restoredStoreGeneration', 'AUTHORITY_RESTORE_PLAN_INVALID');
    positiveInteger(restoredSelectorRevision, 'restoredSelectorRevision', 'AUTHORITY_RESTORE_PLAN_INVALID');
    return withDirectoryLock(storage, lockFile, async () => {
      const current = await readUnlocked();
      if (current.digest !== expectedDigest) fail('AUTHORITY_FLOOR_CONFLICT', 'Authority floor changed before restore planning.');
      if (current.activationEpoch !== 1 || current.legacyPermanentlyRetired !== true) {
        fail('AUTHORITY_RESTORE_PLAN_INVALID', 'Repair-forward is available only after permanent shared activation.');
      }
      const file = containedPath(storage.root, 'restore-plans', `${planId}.json`);
      if (await pathExists(storage.fs, file)) {
        const existing = parsePlan(await readBoundedJson(storage, file, {
          label: 'restore-forward plan', maximumBytes: 64 * 1_024,
        }));
        if (existing.basedOnFloorDigest !== current.digest
          || existing.restoredStoreGeneration !== restoredStoreGeneration
          || existing.restoredSelectorRevision !== restoredSelectorRevision) {
          fail('AUTHORITY_RESTORE_PLAN_CONFLICT', 'Restore-forward plan identifier is already bound.');
        }
        return existing;
      }
      const nextStoreGeneration = Math.max(current.minimumStoreGeneration, restoredStoreGeneration) + 1;
      const nextSelectorRevision = Math.max(current.minimumSelectorRevision, restoredSelectorRevision) + 1;
      const nextAuthorityTransitionDigest = canonicalDigest({
        kind: 'shared-authority-restore-forward-transition',
        planId,
        basedOnFloorDigest: current.digest,
        previousAuthorityTransitionDigest: current.authorityTransitionDigest,
        nextStoreGeneration,
        nextSelectorRevision,
      });
      const body = {
        schemaVersion: 1,
        kind: 'shared-authority-restore-forward-plan',
        planId,
        createdAt: new Date(clock()).toISOString(),
        basedOnFloorDigest: current.digest,
        storeMarkerDigest: current.storeMarkerDigest,
        previousMinimumStoreGeneration: current.minimumStoreGeneration,
        restoredStoreGeneration,
        nextStoreGeneration,
        previousMinimumSelectorRevision: current.minimumSelectorRevision,
        restoredSelectorRevision,
        nextSelectorRevision,
        activeBuildIdentity: current.activeBuildIdentity,
        previousAuthorityTransitionDigest: current.authorityTransitionDigest,
        nextAuthorityTransitionDigest,
        activationEpoch: current.activationEpoch,
        activationRevision: current.activationRevision,
        activationCutoverDigest: current.activationCutoverDigest,
        requiredSelectorPhase: 'PROMOTION_DISABLED',
        requiredLegacyFenceState: 'ACTIVATED',
        invalidatesPriorReleaseBindings: true,
        requiresNewAuthoritativeRuns: true,
      };
      const plan = Object.freeze({ ...body, digest: canonicalDigest(body) });
      try {
        await atomicWriteJson(storage, file, plan, { exclusive: true });
      } catch (error) {
        if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
        const existing = parsePlan(await readBoundedJson(storage, file, { label: 'restore-forward plan', maximumBytes: 64 * 1_024 }));
        if (existing.digest !== plan.digest) fail('AUTHORITY_RESTORE_PLAN_CONFLICT', 'Restore-forward plan identifier is already bound.');
        return existing;
      }
      return structuredClone(plan);
    });
  }

  async function completeRestoreForward({ plan: planInput, expectedFloorDigest, state }) {
    const plan = parsePlan(planInput);
    if (expectedFloorDigest !== plan.basedOnFloorDigest) {
      fail('AUTHORITY_FLOOR_CONFLICT', 'Restore completion is not bound to the floor used for planning.');
    }
    if (!isRecord(state) || !isRecord(state.manifest) || !isRecord(state.selector)
      || !isRecord(state.legacyFence)
      || state.manifest.storeMarkerDigest !== plan.storeMarkerDigest
      || state.selector.storeMarkerDigest !== plan.storeMarkerDigest
      || state.manifest.storeGeneration !== plan.nextStoreGeneration
      || state.selector.storeGeneration !== plan.nextStoreGeneration
      || state.selector.revision !== plan.nextSelectorRevision
      || state.selector.activeBuildIdentity !== plan.activeBuildIdentity
      || state.manifest.activationEpoch !== 1 || state.selector.activationEpoch !== 1
      || state.manifest.activationRevision !== plan.activationRevision
      || state.selector.activationRevision !== plan.activationRevision
      || state.selector.phase !== plan.requiredSelectorPhase
      || state.legacyFence.state !== plan.requiredLegacyFenceState
      || state.legacyFence.activationEpoch !== 1
      || state.selector.activationCutoverDigest !== plan.activationCutoverDigest
      || state.selector.authorityTransitionDigest !== plan.nextAuthorityTransitionDigest) {
      fail('AUTHORITY_RESTORE_STATE_INVALID', 'Repair-forward state must advance generation, disable promotion, and preserve permanent legacy retirement.');
    }
    const authorityState = {
      storeMarkerDigest: state.manifest.storeMarkerDigest,
      storeGeneration: state.manifest.storeGeneration,
      activationEpoch: state.manifest.activationEpoch,
      activationRevision: state.manifest.activationRevision,
      selectorRevision: state.selector.revision,
      activeBuildIdentity: state.selector.activeBuildIdentity,
      authorityTransitionDigest: state.selector.authorityTransitionDigest,
      selectorPhase: state.selector.phase,
      legacyFenceState: state.legacyFence.state,
      activationCutoverDigest: state.selector.activationCutoverDigest,
    };
    const authorityStateDigest = canonicalDigest(authorityState);
    const file = containedPath(storage.root, 'restore-receipts', `${plan.planId}.json`);
    if (await pathExists(storage.fs, file)) {
      const existing = parseSharedAuthorityRestoreReceipt(await readBoundedJson(storage, file, {
        label: 'restore-forward receipt', maximumBytes: 64 * 1_024,
      }));
      const observed = await read();
      if (existing.planDigest !== plan.digest || existing.previousFloorDigest !== expectedFloorDigest
        || existing.resultingFloorDigest !== observed.digest
        || existing.minimumStoreGeneration !== plan.nextStoreGeneration
        || existing.minimumSelectorRevision !== plan.nextSelectorRevision
        || existing.authorityStateDigest !== authorityStateDigest) {
        fail('AUTHORITY_RESTORE_RECEIPT_CONFLICT', 'Restore-forward receipt identifier is already bound.');
      }
      return existing;
    }
    let nextFloor;
    try {
      nextFloor = await compareAndAdvance(expectedFloorDigest, {
        minimumStoreGeneration: plan.nextStoreGeneration,
        minimumSelectorRevision: plan.nextSelectorRevision,
        activeBuildIdentity: plan.activeBuildIdentity,
        authorityTransitionDigest: plan.nextAuthorityTransitionDigest,
      });
    } catch (error) {
      if (error?.code !== 'AUTHORITY_FLOOR_CONFLICT') throw error;
      const observed = await read();
      if (observed.previousDigest !== expectedFloorDigest
        || observed.minimumStoreGeneration !== plan.nextStoreGeneration
        || observed.minimumSelectorRevision !== plan.nextSelectorRevision
        || observed.activeBuildIdentity !== plan.activeBuildIdentity
        || observed.authorityTransitionDigest !== plan.nextAuthorityTransitionDigest
        || observed.storeMarkerDigest !== plan.storeMarkerDigest
        || observed.activationCutoverDigest !== plan.activationCutoverDigest) throw error;
      nextFloor = observed;
    }
    const body = {
      schemaVersion: 1,
      kind: 'shared-authority-restore-forward-receipt',
      planId: plan.planId,
      planDigest: plan.digest,
      completedAt: new Date(clock()).toISOString(),
      previousFloorDigest: expectedFloorDigest,
      resultingFloorDigest: nextFloor.digest,
      storeMarkerDigest: plan.storeMarkerDigest,
      previousMinimumStoreGeneration: plan.previousMinimumStoreGeneration,
      minimumStoreGeneration: nextFloor.minimumStoreGeneration,
      previousMinimumSelectorRevision: plan.previousMinimumSelectorRevision,
      minimumSelectorRevision: nextFloor.minimumSelectorRevision,
      activeBuildIdentity: nextFloor.activeBuildIdentity,
      previousAuthorityTransitionDigest: plan.previousAuthorityTransitionDigest,
      authorityTransitionDigest: nextFloor.authorityTransitionDigest,
      activationEpoch: nextFloor.activationEpoch,
      activationRevision: nextFloor.activationRevision,
      activationCutoverDigest: nextFloor.activationCutoverDigest,
      authorityStateDigest,
      selectorPhase: 'PROMOTION_DISABLED',
      legacyFenceState: 'ACTIVATED',
      invalidatesPriorReleaseBindings: true,
      requiresNewAuthoritativeRuns: true,
    };
    const receipt = Object.freeze({ ...body, digest: canonicalDigest(body) });
    try {
      await atomicWriteJson(storage, file, receipt, { exclusive: true });
    } catch (error) {
      if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
      const existing = parseSharedAuthorityRestoreReceipt(await readBoundedJson(storage, file, {
        label: 'restore-forward receipt', maximumBytes: 64 * 1_024,
      }));
      if (existing.digest !== receipt.digest) fail('AUTHORITY_RESTORE_RECEIPT_CONFLICT', 'Restore-forward receipt identifier is already bound.');
      return existing;
    }
    return structuredClone(receipt);
  }

  return Object.freeze({
    root: storage.root,
    read,
    compareAndAdvance,
    assertAuthorityState,
    planRestoreForward,
    completeRestoreForward,
  });
}

export async function initializeSharedAuthorityFloor(options = {}) {
  const clock = options.clock ?? (() => Date.now());
  const storage = await storageFor(options);
  const headFile = containedPath(storage.root, 'authority-floor.json');
  if (!await pathExists(storage.fs, headFile)) {
    const initial = normalizeInitial(options.initial);
    const document = sealFloor({
      ...initial,
      revision: 1,
      previousDigest: null,
      updatedAt: new Date(clock()).toISOString(),
    });
    parseSharedAuthorityFloor(document);
    try {
      await atomicWriteJson(storage, containedPath(storage.root, 'revisions', revisionName(1)), document, { exclusive: true });
      await atomicWriteJson(storage, headFile, document, { exclusive: true });
    } catch (error) {
      if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
    }
  }
  const handle = createHandle(storage, clock);
  await handle.read();
  return handle;
}

export async function openSharedAuthorityFloor(options = {}) {
  const handle = createHandle(await storageFor(options), options.clock ?? (() => Date.now()));
  await handle.read();
  return handle;
}
