import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalDigest, canonicalJson } from '../../shared/canonical-contract.mjs';

export const SHARED_RESILIENCE_CRASH_BOUNDARIES = Object.freeze([
  'inventory-seal',
  'work-item-adoption',
  'oracle-seal',
  'envelope-fsync',
  'head-swap',
  'mutation-acceptance',
]);

const BOUNDARIES = new Set(SHARED_RESILIENCE_CRASH_BOUNDARIES);
const SENTINEL_DIRECTORY = '.shared-resilience-failpoints';
const MAX_SENTINEL_BYTES = 4_096;

export class SharedResilienceFailpointError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'SharedResilienceFailpointError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new SharedResilienceFailpointError(code, message, options);
}

function parseBoundary(value, label) {
  if (!BOUNDARIES.has(value)) {
    fail('SHARED_RESILIENCE_FAILPOINT_INVALID', `${label} must name one registered shared resilience crash boundary.`);
  }
  return value;
}

function parseSentinelRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.basename(value) !== SENTINEL_DIRECTORY
    || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    fail('SHARED_RESILIENCE_FAILPOINT_INVALID',
      `AUDIT_SHARED_CRASH_SENTINEL_ROOT must be an absolute ${SENTINEL_DIRECTORY} directory.`);
  }
  return path.normalize(value);
}

function parseTimestamp(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) {
    fail('SHARED_RESILIENCE_FAILPOINT_INVALID', 'The failpoint clock returned an invalid timestamp.');
  }
  return new Date(milliseconds).toISOString();
}

function parseSentinel(value, expectedBoundary) {
  const keys = Object.keys(value ?? {}).sort();
  const expectedKeys = ['armedAt', 'boundary', 'digest', 'kind', 'pid', 'schemaVersion'].sort();
  const { digest, ...body } = value ?? {};
  if (canonicalJson(keys) !== canonicalJson(expectedKeys)
    || value.schemaVersion !== 1 || value.kind !== 'shared-resilience-crash-sentinel'
    || value.boundary !== expectedBoundary || !Number.isSafeInteger(value.pid) || value.pid < 1
    || typeof value.armedAt !== 'string' || new Date(value.armedAt).toISOString() !== value.armedAt
    || digest !== canonicalDigest(body)) {
    fail('SHARED_RESILIENCE_FAILPOINT_CORRUPT',
      `The durable ${expectedBoundary} crash sentinel is corrupt.`);
  }
  return Object.freeze(value);
}

async function readSentinel(file, boundary, filesystem) {
  let stat;
  try {
    stat = await filesystem.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_SENTINEL_BYTES) {
    fail('SHARED_RESILIENCE_FAILPOINT_CORRUPT', `The durable ${boundary} crash sentinel is not a bounded regular file.`);
  }
  try {
    return parseSentinel(JSON.parse(await filesystem.readFile(file, 'utf8')), boundary);
  } catch (error) {
    if (error instanceof SharedResilienceFailpointError) throw error;
    fail('SHARED_RESILIENCE_FAILPOINT_CORRUPT', `The durable ${boundary} crash sentinel is unreadable.`, { cause: error });
  }
}

export async function readSharedResilienceCrashSentinel(boundary, {
  root,
  filesystem = fs,
} = {}) {
  const selectedBoundary = parseBoundary(boundary, 'The requested boundary');
  const sentinelRoot = parseSentinelRoot(root);
  const sentinel = await readSentinel(path.join(sentinelRoot, `${selectedBoundary}.json`), selectedBoundary, filesystem);
  if (sentinel === null) {
    fail('SHARED_RESILIENCE_FAILPOINT_MISSING', `The durable ${selectedBoundary} crash sentinel is missing.`);
  }
  return sentinel;
}

async function readConcurrentWinner(file, boundary, filesystem) {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const winner = await readSentinel(file, boundary, filesystem);
      if (winner !== null) return winner;
    } catch (error) {
      if (error?.code !== 'SHARED_RESILIENCE_FAILPOINT_CORRUPT') throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw lastError ?? new SharedResilienceFailpointError(
    'SHARED_RESILIENCE_FAILPOINT_CORRUPT', 'A concurrent crash sentinel disappeared.',
  );
}

async function fsyncDirectory(filesystem, directory) {
  const handle = await filesystem.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Arms one exact Docker-proof crash boundary once, then SIGKILLs this process.
 * Normal production execution is inert because both the isolated proof flag and
 * an exact boundary/root configuration are required. The sentinel is fsynced
 * before injection so a restarted container cannot enter a crash loop.
 */
export async function maybeCrashAtSharedResilienceBoundary(boundary, {
  environment = process.env,
  filesystem = fs,
  killProcess = process.kill.bind(process),
  pid = process.pid,
  clock = Date.now,
} = {}) {
  parseBoundary(boundary, 'The invoked boundary');
  const configuredBoundary = environment.AUDIT_SHARED_CRASH_BOUNDARY || undefined;
  const configuredRoot = environment.AUDIT_SHARED_CRASH_SENTINEL_ROOT || undefined;
  if (configuredBoundary === undefined && configuredRoot === undefined) {
    return Object.freeze({ triggered: false, reason: 'not-configured' });
  }
  if (environment.AUDIT_SHARED_RESILIENCE_PROOF !== '1') {
    fail('SHARED_RESILIENCE_FAILPOINT_DISABLED',
      'Crash injection is forbidden unless AUDIT_SHARED_RESILIENCE_PROOF is exactly 1.');
  }
  const selectedBoundary = parseBoundary(configuredBoundary, 'AUDIT_SHARED_CRASH_BOUNDARY');
  const sentinelRoot = parseSentinelRoot(configuredRoot);
  if (selectedBoundary !== boundary) {
    return Object.freeze({ triggered: false, reason: 'different-boundary' });
  }
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof killProcess !== 'function' || typeof clock !== 'function') {
    fail('SHARED_RESILIENCE_FAILPOINT_INVALID', 'Crash injection process controls are invalid.');
  }

  await filesystem.mkdir(sentinelRoot, { recursive: true, mode: 0o700 });
  const rootStat = await filesystem.lstat(sentinelRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('SHARED_RESILIENCE_FAILPOINT_INVALID', 'The crash sentinel root must be a real directory.');
  }
  const file = path.join(sentinelRoot, `${boundary}.json`);
  const existing = await readSentinel(file, boundary, filesystem);
  if (existing !== null) {
    return Object.freeze({ triggered: false, reason: 'already-triggered', sentinel: existing });
  }

  const body = {
    schemaVersion: 1,
    kind: 'shared-resilience-crash-sentinel',
    boundary,
    pid,
    armedAt: parseTimestamp(clock()),
  };
  const sentinel = Object.freeze({ ...body, digest: canonicalDigest(body) });
  let handle;
  try {
    handle = await filesystem.open(file, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson(sentinel)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsyncDirectory(filesystem, sentinelRoot);
  } catch (error) {
    await handle?.close();
    if (error?.code === 'EEXIST') {
      const winner = await readConcurrentWinner(file, boundary, filesystem);
      return Object.freeze({ triggered: false, reason: 'already-triggered', sentinel: winner });
    }
    throw error;
  }

  killProcess(pid, 'SIGKILL');
  return Object.freeze({ triggered: true, sentinel });
}
