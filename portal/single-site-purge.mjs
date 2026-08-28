import { createHash, randomBytes } from 'node:crypto';
import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { assertNoNestedMountPoints } from './mount-boundaries.mjs';
import {
  isVisualBaselineMutationLocked,
  withVisualBaselineMutationLock,
} from './visual-baselines.mjs';
import { canonicalJson, readJob } from '../scripts/lib/job-queue.mjs';

const TERMINAL_STATES = new Set(['completed', 'failed', 'incomplete', 'cancelled']);
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const JOURNAL_NAME = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
const SECRET_TEXT = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{8,})/gi;
const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 1_000_000,
  maxDirectories: 250_000,
  maxLogicalBytes: 16 * 1024 * 1024 * 1024 * 1024,
  maxDepth: 256,
  maxJournalBytes: 1_048_576,
  maxRecoveryJournals: 10_000,
});

export class SingleSitePurgeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SingleSitePurgeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SingleSitePurgeError(code, message, details);
}

function safeJobId(value) {
  if (typeof value !== 'string' || !SAFE_JOB_ID.test(value)) {
    fail('SINGLE_SITE_PURGE_INVALID', 'Single-site job ID is invalid.');
  }
  return value;
}

export function singleSitePurgeConfirmation(jobId) {
  return `PURGE ${safeJobId(jobId)}`;
}

function validatedLimits(value = {}) {
  const limits = { ...DEFAULT_LIMITS, ...value };
  for (const [name, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      fail('SINGLE_SITE_PURGE_INVALID', `Purge limit ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

function generatedNonce(nonce) {
  const value = nonce();
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/.test(value)) {
    fail('SINGLE_SITE_PURGE_INVALID', 'Purge nonce generator must return exactly 16 lowercase hexadecimal characters.');
  }
  return value;
}

function isoNow(now) {
  const date = new Date(now());
  if (!Number.isFinite(date.getTime())) fail('SINGLE_SITE_PURGE_INVALID', 'Purge clock returned an invalid timestamp.');
  return date.toISOString();
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function realDirectory(filesystem, value, label) {
  const absolute = path.resolve(value);
  if (absolute === path.parse(absolute).root) fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `${label} cannot be a filesystem root.`);
  let stat;
  try {
    stat = await filesystem.lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `${label} does not exist.`);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `${label} must be a real directory, not a symlink.`);
  }
  return { absolute, real: await filesystem.realpath(absolute) };
}

async function ensurePrivateDirectory(filesystem, root, name, label) {
  const directory = path.join(root.absolute, name);
  if (path.dirname(directory) !== root.absolute) fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `${label} escaped its root.`);
  await filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await filesystem.lstat(directory);
  const real = await filesystem.realpath(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !contains(root.real, real)) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `${label} must be a contained real directory.`);
  }
  return { absolute: directory, real };
}

async function ensureTransactionDirectory(filesystem, root, name, label) {
  const directory = path.join(root.absolute, name);
  if (path.dirname(directory) !== root.absolute) fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `${label} escaped its root.`);
  await filesystem.mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  const [stat, real] = await Promise.all([filesystem.lstat(directory), filesystem.realpath(directory)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(real) !== root.real || path.basename(real) !== name) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `${label} must be an exact contained real directory.`);
  }
  return directory;
}

async function fsyncDirectory(filesystem, directory) {
  let handle;
  try {
    handle = await filesystem.open(directory, 'r');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function digestJournalBody(body) {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function sealJournal(body) {
  return { ...body, journalDigest: digestJournalBody(body) };
}

function validateJournal(document, expected) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    fail('SINGLE_SITE_PURGE_JOURNAL_INVALID', 'Purge journal must be an object.');
  }
  const { journalDigest, ...body } = document;
  if (document.schemaVersion !== 1 || document.kind !== 'single-site-purge'
    || document.jobId !== expected.jobId || document.queueRoot !== expected.queueRoot
    || document.finalizationRoot !== expected.finalizationRoot
    || (document.aiReviewRoot ?? document.finalizationRoot) !== expected.aiReviewRoot
    || document.confirmed !== true
    || !['prepared', 'quarantined', 'deleting', 'failed', 'completed'].includes(document.status)
    || typeof journalDigest !== 'string' || journalDigest !== digestJournalBody(body)) {
    fail('SINGLE_SITE_PURGE_JOURNAL_INVALID', `Purge journal for ${expected.jobId} is invalid or belongs to different storage.`);
  }
  if (!SHA256.test(document.idempotencyKeyDigest ?? '')
    || typeof document.quarantineName !== 'string'
    || !new RegExp(`^${escapeRegex(expected.jobId)}-[a-f0-9]{16}$`).test(document.quarantineName)) {
    fail('SINGLE_SITE_PURGE_JOURNAL_INVALID', `Purge journal for ${expected.jobId} has invalid identity fields.`);
  }
  return document;
}

async function atomicWriteJournal(filesystem, journalPath, document) {
  const sealed = sealJournal(Object.fromEntries(Object.entries(document).filter(([key]) => key !== 'journalDigest')));
  const directory = path.dirname(journalPath);
  const temporary = path.join(directory, `.${path.basename(journalPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await filesystem.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson(sealed)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await filesystem.rename(temporary, journalPath);
    await fsyncDirectory(filesystem, directory);
    return sealed;
  } finally {
    await handle?.close();
    await filesystem.rm(temporary, { force: true });
  }
}

async function readJournal(filesystem, journalPath, expected, limits) {
  let stat;
  try {
    stat = await filesystem.lstat(journalPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > limits.maxJournalBytes) {
    fail('SINGLE_SITE_PURGE_JOURNAL_INVALID', `Purge journal for ${expected.jobId} is not a bounded regular file.`);
  }
  let document;
  try {
    document = JSON.parse(await filesystem.readFile(journalPath, 'utf8'));
  } catch {
    fail('SINGLE_SITE_PURGE_JOURNAL_INVALID', `Purge journal for ${expected.jobId} is not valid JSON.`);
  }
  return validateJournal(document, expected);
}

async function existingLstat(filesystem, candidate) {
  try {
    return await filesystem.lstat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function requireDirectChild(filesystem, root, candidate, name, kind) {
  const expected = path.join(root.absolute, name);
  if (path.resolve(candidate) !== expected || path.dirname(expected) !== root.absolute) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `Purge target ${name} failed exact containment checks.`);
  }
  const stat = await existingLstat(filesystem, expected);
  if (!stat) return null;
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `Purge target ${name} is not a real ${kind}.`);
  }
  if (kind === 'directory') {
    const real = await filesystem.realpath(expected);
    if (path.dirname(real) !== root.real || path.basename(real) !== name) {
      fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `Purge target ${name} resolves outside its configured root.`);
    }
  }
  return stat;
}

function addBounded(total, amount, limit, label) {
  if (!Number.isSafeInteger(amount) || amount < 0 || total > limit - amount) {
    fail('SINGLE_SITE_PURGE_LIMIT', `${label} exceeds the configured purge inspection bound.`);
  }
  return total + amount;
}

async function measureTree(filesystem, root, limits) {
  const rootStat = await filesystem.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', 'Measured purge root must be a real directory.');
  }
  const pending = [{ directory: root, depth: 0 }];
  const measurement = { entries: 0, directories: 1, fileReferences: 0, logicalBytes: 0 };
  while (pending.length > 0) {
    const { directory, depth } = pending.pop();
    if (depth > limits.maxDepth) fail('SINGLE_SITE_PURGE_LIMIT', 'Purge tree exceeds the maximum directory depth.');
    const entries = await filesystem.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      measurement.entries = addBounded(measurement.entries, 1, limits.maxEntries, 'Purge entry count');
      const candidate = path.join(directory, entry.name);
      const stat = await filesystem.lstat(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        measurement.directories = addBounded(measurement.directories, 1, limits.maxDirectories, 'Purge directory count');
        pending.push({ directory: candidate, depth: depth + 1 });
      } else {
        measurement.fileReferences += 1;
        measurement.logicalBytes = addBounded(measurement.logicalBytes, stat.size, limits.maxLogicalBytes, 'Purge logical bytes');
      }
    }
  }
  return measurement;
}

function combineMeasurements(values, limits) {
  return values.reduce((total, value) => ({
    entries: addBounded(total.entries, value.entries, limits.maxEntries, 'Aggregate purge entry count'),
    directories: addBounded(total.directories, value.directories, limits.maxDirectories, 'Aggregate purge directory count'),
    fileReferences: addBounded(total.fileReferences, value.fileReferences, limits.maxEntries, 'Aggregate purge file count'),
    logicalBytes: addBounded(total.logicalBytes, value.logicalBytes, limits.maxLogicalBytes, 'Aggregate purge logical bytes'),
  }), { entries: 0, directories: 0, fileReferences: 0, logicalBytes: 0 });
}

async function readFinalizationStatus(filesystem, directory, jobId, maxBytes) {
  const file = path.join(directory, 'status.json');
  const stat = await existingLstat(filesystem, file);
  if (!stat) fail('SINGLE_SITE_PURGE_FINALIZATION_PENDING', `Finalization for ${jobId} has not published terminal status yet.`);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maxBytes) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `Finalization status for ${jobId} is unsafe or oversized.`);
  }
  let value;
  try { value = JSON.parse(await filesystem.readFile(file, 'utf8')); } catch {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `Finalization status for ${jobId} is invalid JSON.`);
  }
  if (!value || typeof value !== 'object' || value.jobId !== jobId
    || value.kind !== 'single-site-finalization-status'
    || !['complete', 'incomplete', 'deadline-exceeded', 'invalid'].includes(value.status)) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `Finalization status for ${jobId} is not a terminal publication.`);
  }
  return value;
}

async function readBinding(filesystem, file, state, maxBytes) {
  const stat = await existingLstat(filesystem, file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maxBytes) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `Idempotency binding for ${state.jobId} is missing, unsafe, or oversized.`);
  }
  let value;
  try { value = JSON.parse(await filesystem.readFile(file, 'utf8')); } catch {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `Idempotency binding for ${state.jobId} is invalid JSON.`);
  }
  if (value?.schemaVersion !== 1 || value.jobId !== state.jobId
    || value.idempotencyKeyDigest !== state.idempotencyKeyDigest
    || value.submissionDigest !== state.submissionDigest) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `Idempotency binding for ${state.jobId} disagrees with terminal queue state.`);
  }
}

function targetPaths(roots, journal) {
  const queueQuarantine = path.join(roots.queue.absolute, '.single-site-purge-quarantine', journal.quarantineName);
  const finalizationQuarantine = path.join(roots.finalization.absolute, '.single-site-purge-quarantine', journal.quarantineName);
  const targets = [
    {
      key: 'job', kind: 'directory',
      original: path.join(roots.queue.absolute, 'jobs', journal.jobId),
      quarantine: path.join(queueQuarantine, 'job'),
    },
    {
      key: 'idempotency', kind: 'file',
      original: path.join(roots.queue.absolute, 'idempotency', `${journal.idempotencyKeyDigest}.json`),
      quarantine: path.join(queueQuarantine, 'idempotency.json'),
    },
    {
      key: 'finalization', kind: 'directory',
      original: path.join(roots.finalization.absolute, journal.jobId),
      quarantine: path.join(finalizationQuarantine, 'finalization'),
    },
  ];
  if (roots.aiReview) {
    const aiQuarantine = path.join(roots.aiReview.absolute, '.single-site-purge-quarantine', journal.quarantineName);
    targets.push({
      key: 'ai-review', kind: 'directory', optional: true,
      original: path.join(roots.aiReview.absolute, journal.jobId),
      quarantine: path.join(aiQuarantine, 'ai-review'),
    });
  }
  return targets;
}

async function moveTargetToQuarantine(filesystem, target, journalStatus) {
  const [original, quarantine] = await Promise.all([
    existingLstat(filesystem, target.original), existingLstat(filesystem, target.quarantine),
  ]);
  if (original && quarantine) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `Both live and quarantined ${target.key} targets exist.`);
  }
  if (!original && quarantine) return;
  if (!original && !quarantine) {
    if (target.optional) return;
    if (['deleting', 'failed', 'completed'].includes(journalStatus)) return;
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `${target.key} disappeared before it entered quarantine.`);
  }
  const valid = target.kind === 'directory'
    ? original.isDirectory() && !original.isSymbolicLink()
    : original.isFile() && !original.isSymbolicLink();
  if (!valid) fail('SINGLE_SITE_PURGE_PATH_UNSAFE', `${target.key} changed type before quarantine.`);
  await filesystem.mkdir(path.dirname(target.quarantine), { recursive: true, mode: 0o700 });
  await filesystem.rename(target.original, target.quarantine);
  await fsyncDirectory(filesystem, path.dirname(target.original));
  await fsyncDirectory(filesystem, path.dirname(target.quarantine));
}

async function removeTreeWithoutFollowing(filesystem, root, limits) {
  const rootStat = await existingLstat(filesystem, root);
  if (!rootStat) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('SINGLE_SITE_PURGE_PATH_UNSAFE', 'Quarantined deletion root must remain a real directory.');
  }
  const pending = [{ directory: root, depth: 0, visited: false }];
  let entriesSeen = 0;
  let directoriesSeen = 1;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > limits.maxDepth) fail('SINGLE_SITE_PURGE_LIMIT', 'Quarantined tree exceeds the maximum directory depth.');
    if (current.visited) {
      await filesystem.rmdir(current.directory);
      continue;
    }
    pending.push({ ...current, visited: true });
    const entries = await filesystem.readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen = addBounded(entriesSeen, 1, limits.maxEntries, 'Purge entry count');
      const candidate = path.join(current.directory, entry.name);
      const stat = await filesystem.lstat(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        directoriesSeen = addBounded(directoriesSeen, 1, limits.maxDirectories, 'Purge directory count');
        pending.push({ directory: candidate, depth: current.depth + 1, visited: false });
      } else {
        await filesystem.unlink(candidate);
      }
    }
  }
}

async function removeQuarantinedTarget(filesystem, target, limits) {
  const stat = await existingLstat(filesystem, target.quarantine);
  if (!stat) return;
  if (target.kind === 'file') {
    if (!stat.isFile() || stat.isSymbolicLink()) fail('SINGLE_SITE_PURGE_PATH_UNSAFE', 'Quarantined idempotency binding changed type.');
    await filesystem.unlink(target.quarantine);
    return;
  }
  await removeTreeWithoutFollowing(filesystem, target.quarantine, limits);
}

async function acquirePurgeLock(filesystem, lockRoot, jobId, staleMilliseconds, nonce) {
  const lock = path.join(lockRoot.absolute, jobId);
  if (path.dirname(lock) !== lockRoot.absolute) fail('SINGLE_SITE_PURGE_PATH_UNSAFE', 'Purge lock escaped its root.');
  try {
    await filesystem.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const stat = await filesystem.lstat(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SINGLE_SITE_PURGE_PATH_UNSAFE', 'Purge lock is unsafe.');
    if (Date.now() - stat.mtimeMs < staleMilliseconds) fail('SINGLE_SITE_PURGE_BUSY', `Purge for ${jobId} is already running.`);
    const stale = path.join(lockRoot.absolute, `.stale-${jobId}-${generatedNonce(nonce)}`);
    try {
      await filesystem.rename(lock, stale);
      await removeTreeWithoutFollowing(filesystem, stale, { ...DEFAULT_LIMITS, maxEntries: 16, maxDirectories: 16 });
    } catch (recoveryError) {
      if (!['ENOENT', 'EEXIST'].includes(recoveryError?.code)) throw recoveryError;
    }
    try { await filesystem.mkdir(lock, { mode: 0o700 }); } catch (retryError) {
      if (retryError?.code === 'EEXIST') fail('SINGLE_SITE_PURGE_BUSY', `Purge for ${jobId} is already running.`);
      throw retryError;
    }
  }
  await filesystem.writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
  await fsyncDirectory(filesystem, lockRoot.absolute);
  return lock;
}

async function releasePurgeLock(filesystem, lock, lockRoot) {
  await filesystem.unlink(path.join(lock, 'owner.json')).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await filesystem.rmdir(lock).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await fsyncDirectory(filesystem, lockRoot.absolute);
}

async function prepareContext({ queue, finalizationRoot, aiReviewRoot, filesystem, limits }) {
  if (!queue || typeof queue.root !== 'string') fail('SINGLE_SITE_PURGE_INVALID', 'An open single-site job queue is required.');
  const roots = {
    queue: await realDirectory(filesystem, queue.root, 'Queue root'),
    finalization: await realDirectory(filesystem, finalizationRoot, 'Finalization root'),
  };
  const configuredAiReviewRoot = await realDirectory(filesystem, aiReviewRoot ?? finalizationRoot, 'AI review root');
  roots.aiReview = configuredAiReviewRoot.real === roots.finalization.real ? null : configuredAiReviewRoot;
  const [journalRoot, lockRoot, queueQuarantineRoot, finalizationQuarantineRoot] = await Promise.all([
    ensurePrivateDirectory(filesystem, roots.queue, '.single-site-purge-journals', 'Purge journal root'),
    ensurePrivateDirectory(filesystem, roots.queue, '.single-site-purge-locks', 'Purge lock root'),
    ensurePrivateDirectory(filesystem, roots.queue, '.single-site-purge-quarantine', 'Queue purge quarantine'),
    ensurePrivateDirectory(filesystem, roots.finalization, '.single-site-purge-quarantine', 'Finalization purge quarantine'),
  ]);
  const aiReviewQuarantineRoot = roots.aiReview
    ? await ensurePrivateDirectory(filesystem, roots.aiReview, '.single-site-purge-quarantine', 'AI review purge quarantine')
    : null;
  return { roots, journalRoot, lockRoot, queueQuarantineRoot, finalizationQuarantineRoot, aiReviewQuarantineRoot, limits };
}

function journalPathFor(context, jobId) {
  const candidate = path.join(context.journalRoot.absolute, `${jobId}.json`);
  if (path.dirname(candidate) !== context.journalRoot.absolute) fail('SINGLE_SITE_PURGE_PATH_UNSAFE', 'Purge journal escaped its root.');
  return candidate;
}

async function createJournal({ queue, context, jobId, filesystem, assertNoNestedMounts, now, nonce }) {
  const state = await readJob(queue, jobId);
  if (!TERMINAL_STATES.has(state.executionState)) {
    fail('SINGLE_SITE_PURGE_NOT_TERMINAL', `Job ${jobId} is ${state.executionState}; only terminal jobs can be purged.`);
  }
  const jobsRoot = await realDirectory(filesystem, path.join(context.roots.queue.absolute, 'jobs'), 'Queue jobs root');
  const idempotencyRoot = await realDirectory(filesystem, path.join(context.roots.queue.absolute, 'idempotency'), 'Queue idempotency root');
  const jobDirectory = path.join(jobsRoot.absolute, jobId);
  await requireDirectChild(filesystem, jobsRoot, jobDirectory, jobId, 'directory');
  const finalizationDirectory = path.join(context.roots.finalization.absolute, jobId);
  const finalizationStat = await requireDirectChild(filesystem, context.roots.finalization, finalizationDirectory, jobId, 'directory');
  if (!finalizationStat) fail('SINGLE_SITE_PURGE_FINALIZATION_PENDING', `Finalization for ${jobId} is not published yet.`);
  await readFinalizationStatus(filesystem, finalizationDirectory, jobId, context.limits.maxJournalBytes);
  const binding = path.join(idempotencyRoot.absolute, `${state.idempotencyKeyDigest}.json`);
  await requireDirectChild(filesystem, idempotencyRoot, binding, `${state.idempotencyKeyDigest}.json`, 'file');
  await readBinding(filesystem, binding, state, context.limits.maxJournalBytes);
  await assertNoNestedMounts(filesystem, jobDirectory);
  await assertNoNestedMounts(filesystem, finalizationDirectory);
  const measurements = await Promise.all([
    measureTree(filesystem, jobDirectory, context.limits),
    measureTree(filesystem, finalizationDirectory, context.limits),
  ]);
  if (context.roots.aiReview) {
    const aiReviewDirectory = path.join(context.roots.aiReview.absolute, jobId);
    const aiReviewStat = await requireDirectChild(filesystem, context.roots.aiReview, aiReviewDirectory, jobId, 'directory');
    if (aiReviewStat) {
      await assertNoNestedMounts(filesystem, aiReviewDirectory);
      measurements.push(await measureTree(filesystem, aiReviewDirectory, context.limits));
    }
  }
  const bindingStat = await filesystem.lstat(binding);
  measurements.push({ entries: 1, directories: 0, fileReferences: 1, logicalBytes: bindingStat.size });
  const preparedAt = isoNow(now);
  const journal = {
    schemaVersion: 1,
    kind: 'single-site-purge',
    jobId,
    queueRoot: context.roots.queue.absolute,
    finalizationRoot: context.roots.finalization.absolute,
    aiReviewRoot: context.roots.aiReview?.absolute ?? context.roots.finalization.absolute,
    idempotencyKeyDigest: state.idempotencyKeyDigest,
    terminalState: state.executionState,
    confirmed: true,
    quarantineName: `${jobId}-${generatedNonce(nonce)}`,
    status: 'prepared',
    preparedAt,
    updatedAt: preparedAt,
    measurement: combineMeasurements(measurements, context.limits),
    error: null,
  };
  return atomicWriteJournal(filesystem, journalPathFor(context, jobId), journal);
}

async function executeJournal({ context, journal, filesystem, assertNoNestedMounts, removeTree, now, hooks, baselineStore, recovered }) {
  const journalPath = journalPathFor(context, journal.jobId);
  const targets = targetPaths(context.roots, journal);
  try {
    await withBaselinePurgeFence(baselineStore, async () => {
      await ensureTransactionDirectory(filesystem, context.queueQuarantineRoot, journal.quarantineName, 'Queue purge transaction');
      await ensureTransactionDirectory(filesystem, context.finalizationQuarantineRoot, journal.quarantineName, 'Finalization purge transaction');
      if (context.aiReviewQuarantineRoot) {
        await ensureTransactionDirectory(filesystem, context.aiReviewQuarantineRoot, journal.quarantineName, 'AI review purge transaction');
      }
      for (const target of targets) await moveTargetToQuarantine(filesystem, target, journal.status);
      journal = await atomicWriteJournal(filesystem, journalPath, {
        ...journal, status: 'quarantined', updatedAt: isoNow(now), error: null,
      });
      await hooks.afterQuarantine?.(structuredClone(journal));
    });
    for (const target of targets.filter(({ kind }) => kind === 'directory')) {
      const stat = await existingLstat(filesystem, target.quarantine);
      if (stat) await assertNoNestedMounts(filesystem, target.quarantine);
    }
    journal = await atomicWriteJournal(filesystem, journalPath, {
      ...journal, status: 'deleting', updatedAt: isoNow(now), error: null,
    });
    for (const target of targets) await removeTree(filesystem, target, context.limits);
    for (const directory of new Set(targets.map(({ quarantine }) => path.dirname(quarantine)))) {
      await filesystem.rmdir(directory).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
      });
    }
    journal = await atomicWriteJournal(filesystem, journalPath, {
      ...journal, status: 'completed', updatedAt: isoNow(now), error: null,
    });
    await filesystem.unlink(journalPath);
    await fsyncDirectory(filesystem, context.journalRoot.absolute);
    return Object.freeze({
      jobId: journal.jobId,
      purged: true,
      terminalState: journal.terminalState,
      filesRemoved: journal.measurement.fileReferences,
      directoriesRemoved: journal.measurement.directories,
      logicalBytesRemoved: journal.measurement.logicalBytes,
      physicalBytesRemoved: null,
      baselineBytesPreserved: true,
      recovered,
    });
  } catch (error) {
    const message = String(error?.message ?? error).replace(SECRET_TEXT, '[REDACTED]').slice(0, 1_000);
    await atomicWriteJournal(filesystem, journalPath, {
      ...journal,
      status: ['quarantined', 'deleting'].includes(journal.status) ? 'failed' : journal.status,
      updatedAt: isoNow(now),
      error: message,
    }).catch(() => undefined);
    if (error instanceof SingleSitePurgeError) throw error;
    fail('SINGLE_SITE_PURGE_INCOMPLETE', `Purge for ${journal.jobId} was interrupted; its journal and quarantined data were retained for retry.`, { cause: message });
  }
}

function defaultDependencies(value = {}) {
  return {
    filesystem: value.filesystem ?? nativeFs,
    assertNoNestedMounts: value.assertNoNestedMounts ?? assertNoNestedMountPoints,
    removeTree: value.removeTree ?? removeQuarantinedTarget,
    now: value.now ?? (() => Date.now()),
    nonce: value.nonce ?? (() => randomBytes(8).toString('hex')),
    hooks: value.hooks ?? {},
  };
}

async function withBaselinePurgeFence(baselineStore, operation) {
  if (!baselineStore || typeof baselineStore.lockDirectory !== 'string') {
    fail('SINGLE_SITE_PURGE_INVALID', 'A visual baseline store is required to fence baseline mutations during purge.');
  }
  if (await isVisualBaselineMutationLocked(baselineStore)) {
    fail('SINGLE_SITE_PURGE_BASELINE_BUSY', 'Purge refused while a visual baseline mutation is in progress.');
  }
  try {
    return await withVisualBaselineMutationLock({ ...baselineStore, lockRetries: 0 }, operation);
  } catch (error) {
    if (error?.code === 'BASELINE_MUTATION_LOCKED') {
      fail('SINGLE_SITE_PURGE_BASELINE_BUSY', 'Purge refused while a visual baseline mutation is in progress.');
    }
    throw error;
  }
}

async function assertBaselinePurgeAvailable(baselineStore) {
  if (!baselineStore || typeof baselineStore.lockDirectory !== 'string') {
    fail('SINGLE_SITE_PURGE_INVALID', 'A visual baseline store is required to fence baseline mutations during purge.');
  }
  if (await isVisualBaselineMutationLocked(baselineStore)) {
    fail('SINGLE_SITE_PURGE_BASELINE_BUSY', 'Purge refused while a visual baseline mutation is in progress.');
  }
}

async function purgeUnderFence(options, context, dependencies, journal = null) {
  const { filesystem, assertNoNestedMounts, removeTree, now, nonce } = dependencies;
  const hooks = dependencies.hooks;
  const jobId = safeJobId(options.jobId ?? journal?.jobId);
  const lock = await acquirePurgeLock(
    filesystem,
    context.lockRoot,
    jobId,
    options.lockStaleMilliseconds ?? options.queue.lockStaleMs ?? 30_000,
    nonce,
  );
  try {
    await assertBaselinePurgeAvailable(options.baselineStore);
    const expected = {
      jobId,
      queueRoot: context.roots.queue.absolute,
      finalizationRoot: context.roots.finalization.absolute,
      aiReviewRoot: context.roots.aiReview?.absolute ?? context.roots.finalization.absolute,
    };
    const journalPath = journalPathFor(context, jobId);
    journal ??= await readJournal(filesystem, journalPath, expected, context.limits);
    const recovered = journal !== null;
    journal ??= await createJournal({
      queue: options.queue, context, jobId, filesystem, assertNoNestedMounts, now, nonce,
    });
    validateJournal(journal, expected);
    return await executeJournal({
      context, journal, filesystem, assertNoNestedMounts, removeTree, now, hooks,
      baselineStore: options.baselineStore,
      recovered,
    });
  } finally {
    await releasePurgeLock(filesystem, lock, context.lockRoot);
  }
}

export async function purgeSingleSiteRun(options) {
  if (!options || typeof options !== 'object') fail('SINGLE_SITE_PURGE_INVALID', 'Purge options are required.');
  const jobId = safeJobId(options.jobId);
  const expectedConfirmation = singleSitePurgeConfirmation(jobId);
  if (options.confirmation !== expectedConfirmation) {
    fail('SINGLE_SITE_PURGE_CONFIRMATION', `Type ${expectedConfirmation} exactly to confirm permanent deletion.`);
  }
  const dependencies = defaultDependencies(options.dependencies);
  const context = await prepareContext({
    queue: options.queue,
    finalizationRoot: options.finalizationRoot,
    aiReviewRoot: options.aiReviewRoot,
    filesystem: dependencies.filesystem,
    limits: validatedLimits(options.limits),
  });
  return purgeUnderFence(options, context, dependencies);
}

export async function recoverSingleSitePurges(options) {
  if (!options || typeof options !== 'object') fail('SINGLE_SITE_PURGE_INVALID', 'Recovery options are required.');
  const dependencies = defaultDependencies(options.dependencies);
  const context = await prepareContext({
    queue: options.queue,
    finalizationRoot: options.finalizationRoot,
    aiReviewRoot: options.aiReviewRoot,
    filesystem: dependencies.filesystem,
    limits: validatedLimits(options.limits),
  });
  return (async () => {
    const entries = await dependencies.filesystem.readdir(context.journalRoot.absolute, { withFileTypes: true });
    if (entries.length > context.limits.maxRecoveryJournals) {
      fail('SINGLE_SITE_PURGE_LIMIT', 'Purge recovery journal count exceeds its configured bound.');
    }
    const results = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const match = JOURNAL_NAME.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
      const jobId = safeJobId(match[1]);
      const expected = {
        jobId,
        queueRoot: context.roots.queue.absolute,
        finalizationRoot: context.roots.finalization.absolute,
        aiReviewRoot: context.roots.aiReview?.absolute ?? context.roots.finalization.absolute,
      };
      try {
        const journal = await readJournal(
          dependencies.filesystem,
          path.join(context.journalRoot.absolute, entry.name),
          expected,
          context.limits,
        );
        const result = await purgeUnderFence({ ...options, jobId }, context, dependencies, journal);
        results.push({ jobId, status: 'purged', result });
      } catch (error) {
        results.push({ jobId, status: 'failed', code: error?.code ?? 'SINGLE_SITE_PURGE_INCOMPLETE', message: String(error?.message ?? error).slice(0, 1_000) });
      }
    }
    return Object.freeze(results.map(Object.freeze));
  })();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
