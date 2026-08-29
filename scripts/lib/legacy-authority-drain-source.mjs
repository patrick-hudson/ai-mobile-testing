import { promises as fs } from 'node:fs';
import path from 'node:path';

import { canonicalDigest } from '../../shared/canonical-contract.mjs';
import { listJobs } from './job-queue.mjs';

const SAFE_COMPARATIVE_ID = /^[a-z0-9][a-z0-9-]{7,79}$/u;
const MAX_LEGACY_RUNS = 4_096;
const MAX_TERMINAL_BYTES = 4 * 1_048_576;

export class LegacyAuthorityDrainError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'LegacyAuthorityDrainError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new LegacyAuthorityDrainError(code, message, details);
}

async function requireDirectory(root, label) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    fail('CUTOVER_LEGACY_SOURCE_UNAVAILABLE', `${label} root must be an absolute path.`);
  }
  let stat;
  try { stat = await fs.lstat(root); } catch (error) {
    fail('CUTOVER_LEGACY_SOURCE_UNAVAILABLE', `${label} root is unavailable.`, { cause: error?.code });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('CUTOVER_LEGACY_SOURCE_UNAVAILABLE', `${label} root must be a real directory.`);
  }
  return path.resolve(root);
}

async function regularFile(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readTerminalDocument(file, runId) {
  const stat = await regularFile(file);
  if (!stat) return null;
  if (stat.size < 2 || stat.size > MAX_TERMINAL_BYTES) {
    fail('CUTOVER_LEGACY_SOURCE_CORRUPT', `Legacy terminal document for ${runId} is outside its bound.`);
  }
  try {
    const document = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('not an object');
    return document;
  } catch (error) {
    fail('CUTOVER_LEGACY_SOURCE_CORRUPT', `Legacy terminal document for ${runId} is corrupt.`, {
      cause: error?.message,
    });
  }
}

async function comparativeState(root) {
  const entries = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && SAFE_COMPARATIVE_ID.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > MAX_LEGACY_RUNS) fail('CUTOVER_LEGACY_SOURCE_LIMIT', 'Comparative legacy run limit was exceeded.');
  const active = [];
  const heads = [];
  for (const entry of entries) {
    const directory = path.join(root, entry.name);
    const terminal = await readTerminalDocument(path.join(directory, 'sharded-run.json'), entry.name);
    if (terminal) {
      heads.push(`comparative:${entry.name}:${canonicalDigest(terminal)}`);
      continue;
    }
    const discoveryFiles = [
      path.join(directory, 'logs', 'coordinator.log'),
      path.join(directory, 'merge-lifecycle.json'),
      path.join(directory, 'sharded-heartbeat.json'),
    ];
    if ((await Promise.all(discoveryFiles.map(regularFile))).some(Boolean)) active.push(`comparative:${entry.name}`);
  }
  return { active, heads };
}

async function singleSiteState(root, clock) {
  let jobs;
  try {
    // Drain observation is a read-only proof. Construct only the narrow reader
    // shape consumed by listJobs so observation cannot initialize indexes,
    // idempotency directories, or any other state in the legacy queue.
    jobs = await listJobs({ root, fs, clock });
  } catch (error) {
    fail('CUTOVER_LEGACY_SOURCE_UNAVAILABLE', 'Single-site legacy authority queue is unreadable.', {
      cause: error?.code ?? error?.message,
    });
  }
  if (jobs.length > MAX_LEGACY_RUNS) fail('CUTOVER_LEGACY_SOURCE_LIMIT', 'Single-site legacy job limit was exceeded.');
  const active = [];
  const leases = [];
  const heads = [];
  const now = clock();
  for (const job of jobs.sort((left, right) => left.jobId.localeCompare(right.jobId))) {
    if (['completed', 'failed', 'incomplete', 'cancelled'].includes(job.executionState)) {
      heads.push(`single-site:${job.jobId}:${canonicalDigest(job)}`);
      continue;
    }
    active.push(`single-site:${job.jobId}`);
    if (job.lease && Date.parse(job.lease.expiresAt) > now) {
      leases.push(`single-site:${job.jobId}:${job.lease.workerId}:${job.lease.attemptId}:${job.lease.fencingToken}`);
    }
  }
  return { active, leases, heads };
}

export async function inspectLegacyAuthorityDrainSources({
  comparativeRoot, singleSiteQueueRoot, clock = () => Date.now(),
} = {}) {
  const [resolvedComparativeRoot, resolvedSingleSiteRoot] = await Promise.all([
    requireDirectory(comparativeRoot, 'Comparative legacy authority'),
    requireDirectory(singleSiteQueueRoot, 'Single-site legacy authority'),
  ]);
  const [comparative, singleSite] = await Promise.all([
    comparativeState(resolvedComparativeRoot),
    singleSiteState(resolvedSingleSiteRoot, clock),
  ]);
  const headSet = [...comparative.heads, ...singleSite.heads].sort();
  return Object.freeze({
    activeLegacyAuthoritativeRunIds: Object.freeze([...comparative.active, ...singleSite.active].sort()),
    unfencedLegacyLeaseIds: Object.freeze(singleSite.leases.sort()),
    legacyHeadMarkers: Object.freeze([
      `legacy-head-set:${canonicalDigest({ schemaVersion: 1, heads: headSet })}`,
    ]),
  });
}
