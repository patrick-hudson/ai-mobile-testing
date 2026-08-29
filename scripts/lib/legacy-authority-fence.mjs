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

export class LegacyAuthorityFenceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LegacyAuthorityFenceError';
    this.code = code;
    this.details = details;
    this.statusCode = 503;
  }
}

function fail(code, message, details) {
  throw new LegacyAuthorityFenceError(code, message, details);
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || /^\.+$/u.test(value)) {
    fail('LEGACY_AUTHORITY_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function timestamp(clock) {
  return new Date(clock()).toISOString();
}

function body(value) {
  return {
    schemaVersion: 1,
    kind: 'legacy-release-authority-fence',
    state: value.state,
    revision: value.revision,
    cutoverId: value.cutoverId,
    activationEpoch: value.activationEpoch,
    previousDigest: value.previousDigest,
    updatedAt: value.updatedAt,
  };
}

function seal(value) {
  const document = body(value);
  return Object.freeze({ ...document, digest: canonicalDigest(document) });
}

function parse(value) {
  if (!isRecord(value)) fail('LEGACY_AUTHORITY_UNAVAILABLE', 'Legacy authority fence must be an object.');
  exactKeys(value, [...Object.keys(body(value)), 'digest'], 'Legacy authority fence');
  const { digest, ...document } = value;
  assertDigest(digest, 'Legacy authority fence digest');
  if (digest !== canonicalDigest(document)
    || value.schemaVersion !== 1 || value.kind !== 'legacy-release-authority-fence'
    || !['OPEN', 'CLOSED', 'FROZEN', 'ACTIVATED'].includes(value.state)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.activationEpoch) || ![0, 1].includes(value.activationEpoch)
    || (value.cutoverId !== null && !SAFE_ID.test(value.cutoverId))
    || (value.previousDigest !== null && typeof value.previousDigest !== 'string')
    || typeof value.updatedAt !== 'string' || new Date(value.updatedAt).toISOString() !== value.updatedAt) {
    fail('LEGACY_AUTHORITY_UNAVAILABLE', 'Legacy authority fence is corrupt or unsupported.');
  }
  if (value.previousDigest !== null) assertDigest(value.previousDigest, 'Legacy authority fence previousDigest');
  if ((value.state === 'OPEN' && (value.cutoverId !== null || value.activationEpoch !== 0))
    || (value.state === 'CLOSED' && (value.cutoverId === null || value.activationEpoch !== 0))
    || (value.state === 'FROZEN' && (value.cutoverId === null || value.activationEpoch !== 0))
    || (value.state === 'ACTIVATED' && (value.cutoverId === null || value.activationEpoch !== 1))) {
    fail('LEGACY_AUTHORITY_UNAVAILABLE', 'Legacy authority fence state is contradictory.');
  }
  return structuredClone(value);
}

async function storageFor({ root, filesystem, nonce, verifyStorage = true } = {}) {
  if (typeof root !== 'string' || !root) fail('LEGACY_AUTHORITY_INPUT_INVALID', 'Legacy authority fence root is required.');
  return openAtomicStorage({ root, filesystem, nonce, verify: verifyStorage });
}

function handle(storage, clock) {
  const file = containedPath(storage.root, 'legacy-authority-fence.json');
  const lock = containedPath(storage.root, '.legacy-authority-fence.lock');

  async function read() {
    try {
      return parse(await readBoundedJson(storage, file, {
        label: 'legacy authority fence', maximumBytes: 64 * 1_024,
      }));
    } catch (error) {
      if (error instanceof LegacyAuthorityFenceError) throw error;
      fail('LEGACY_AUTHORITY_UNAVAILABLE', 'Legacy authority fence is missing, corrupt, or unreadable.', {
        cause: error?.code ?? error?.message,
      });
    }
  }

  async function transition(expectedDigest, cutoverId, nextState, activationEpoch) {
    safeId(cutoverId, 'cutoverId');
    return withDirectoryLock(storage, lock, async () => {
      const current = await read();
      if (current.digest !== expectedDigest) fail('LEGACY_AUTHORITY_CONFLICT', 'Legacy authority fence changed before transition.');
      if (current.state === nextState && current.cutoverId === cutoverId
        && current.activationEpoch === activationEpoch) return current;
      if (current.state === 'ACTIVATED') {
        fail('LEGACY_AUTHORITY_PERMANENTLY_RETIRED', 'Legacy release authority cannot be restored after shared activation.');
      }
      if (nextState === 'CLOSED' && current.state !== 'OPEN') {
        fail('LEGACY_AUTHORITY_CONFLICT', 'Legacy authority can close only from OPEN.');
      }
      if (nextState === 'ACTIVATED' && (current.state !== 'FROZEN' || current.cutoverId !== cutoverId)) {
        fail('LEGACY_AUTHORITY_CONFLICT', 'Legacy authority activation must preserve the frozen cutover owner.');
      }
      if (nextState === 'FROZEN' && (current.state !== 'CLOSED' || current.cutoverId !== cutoverId)) {
        fail('LEGACY_AUTHORITY_CONFLICT', 'Legacy authority can freeze only after drain closure.');
      }
      if (nextState === 'OPEN' && (!['CLOSED', 'FROZEN'].includes(current.state) || current.cutoverId !== cutoverId)) {
        fail('LEGACY_AUTHORITY_CONFLICT', 'Legacy authority can reopen only for its pre-activation cutover owner.');
      }
      const next = seal({
        state: nextState,
        revision: current.revision + 1,
        cutoverId: nextState === 'OPEN' ? null : cutoverId,
        activationEpoch,
        previousDigest: current.digest,
        updatedAt: timestamp(clock),
      });
      await atomicWriteJson(storage, file, next);
      return structuredClone(next);
    });
  }

  return Object.freeze({
    root: storage.root,
    read,
    async withAuthority(capability, operation) {
      safeId(capability, 'capability');
      if (typeof operation !== 'function') fail('LEGACY_AUTHORITY_INPUT_INVALID', 'Legacy authority operation is required.');
      return withDirectoryLock(storage, lock, async () => {
        const current = await read();
        const drainingFinalization = current.state === 'CLOSED' && capability.endsWith('-finalization');
        if (current.state !== 'OPEN' && !drainingFinalization) {
          fail('LEGACY_AUTHORITY_FENCED', `Legacy ${capability} is fenced by ${current.cutoverId}.`, {
            cutoverId: current.cutoverId, state: current.state, fenceDigest: current.digest,
          });
        }
        return operation(current);
      });
    },
    close: (expectedDigest, cutoverId) => transition(expectedDigest, cutoverId, 'CLOSED', 0),
    freeze: (expectedDigest, cutoverId) => transition(expectedDigest, cutoverId, 'FROZEN', 0),
    activate: (expectedDigest, cutoverId, activationEpoch) => {
      if (activationEpoch !== 1) fail('LEGACY_AUTHORITY_INPUT_INVALID', 'activationEpoch must be 1.');
      return transition(expectedDigest, cutoverId, 'ACTIVATED', activationEpoch);
    },
    reopenPreActivation: (expectedDigest, cutoverId) => transition(expectedDigest, cutoverId, 'OPEN', 0),
  });
}

export async function initializeLegacyAuthorityFence(options = {}) {
  const clock = options.clock ?? (() => Date.now());
  const storage = await storageFor(options);
  const file = containedPath(storage.root, 'legacy-authority-fence.json');
  if (!await pathExists(storage.fs, file)) {
    try {
      await atomicWriteJson(storage, file, seal({
        state: 'OPEN', revision: 1, cutoverId: null, activationEpoch: 0,
        previousDigest: null, updatedAt: timestamp(clock),
      }), { exclusive: true });
    } catch (error) {
      if (error?.code !== 'ATOMIC_ALREADY_EXISTS') throw error;
    }
  }
  const fence = handle(storage, clock);
  await fence.read();
  return fence;
}

export async function openLegacyAuthorityFence(options = {}) {
  const clock = options.clock ?? (() => Date.now());
  const fence = handle(await storageFor(options), clock);
  await fence.read();
  return fence;
}

export async function openLegacyAuthorityFenceFromEnvironment(environment = process.env) {
  const root = environment.AUDIT_LEGACY_AUTHORITY_FENCE_ROOT;
  if (typeof root !== 'string' || !root) return null;
  if (!root.startsWith('/')) {
    fail('LEGACY_AUTHORITY_INPUT_INVALID', 'AUDIT_LEGACY_AUTHORITY_FENCE_ROOT must be absolute.');
  }
  return openLegacyAuthorityFence({ root });
}
