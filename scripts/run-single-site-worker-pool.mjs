import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listIndexedJobs, openJobQueue } from './lib/job-queue.mjs';
import { executeSingleSiteWorker } from './run-single-site-worker.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const CLAIM_RACE_CODES = new Set([
  'QUEUE_ALREADY_CLAIMED',
  'QUEUE_LOCK_BUSY',
  'QUEUE_STATE_CONFLICT',
  'QUEUE_TERMINAL',
  'QUEUE_RETRY_EXHAUSTED',
]);
const SECRET_DETECT_PATTERN = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{8,})/gi;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function safeServiceId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail('SINGLE_SITE_POOL_INVALID', `${label} must be 1-128 safe identifier characters.`);
  }
  return value;
}

export function defaultWorkerId(hostname = os.hostname()) {
  const normalized = String(hostname).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 110);
  return safeServiceId(`worker-${normalized || 'container'}`, 'worker ID');
}

export function parsePollMilliseconds(value, fallback = 1_000) {
  const resolved = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 100 || resolved > 60_000) {
    fail('SINGLE_SITE_POOL_INVALID', 'Pool poll interval must be an integer from 100 through 60000 milliseconds.');
  }
  return resolved;
}

function redact(value, depth = 0) {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return value
      .replace(SECRET_DETECT_PATTERN, '[REDACTED]')
      .replace(/([?&](?:token|key|signature|auth)=)[^&#\s]+/gi, '$1[REDACTED]')
      .slice(0, 4_000);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key,
      /^(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer)$/i.test(key)
        ? '[REDACTED]'
        : redact(item, depth + 1),
    ]));
  }
  return String(value).slice(0, 4_000);
}

export function createPoolLogger({ service, serviceId, stream = process.stdout, clock = () => new Date() }) {
  let sequence = 0;
  return {
    emit(event, detail = {}) {
      const record = {
        schemaVersion: 1,
        sequence: ++sequence,
        at: clock().toISOString(),
        service,
        serviceId,
        event,
        detail: redact(detail),
      };
      stream.write(`${JSON.stringify(record)}\n`);
      return record;
    },
  };
}

export function interruptibleDelay(milliseconds, signal, {
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (signal?.aborted || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimer(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimer(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function recoverableJob(state, now) {
  if (state.executionState === 'queued') return true;
  return ['starting', 'running', 'finalizing'].includes(state.executionState)
    && state.lease !== null
    && Date.parse(state.lease.expiresAt) <= now;
}

export function workerCandidates(states, now = Date.now()) {
  return states
    .filter((state) => recoverableJob(state, now))
    .sort((left, right) => (
      Number(left.executionState === 'queued') - Number(right.executionState === 'queued')
      || left.submittedAt.localeCompare(right.submittedAt)
      || left.jobId.localeCompare(right.jobId)
    ));
}

export async function runSingleSiteWorkerPool({
  queue,
  workerId,
  pollMs = 1_000,
  signal,
  environment = process.env,
  dependencies = {},
  maxCycles = Number.POSITIVE_INFINITY,
}) {
  safeServiceId(workerId, 'worker ID');
  parsePollMilliseconds(pollMs);
  const logger = dependencies.logger ?? createPoolLogger({
    service: 'single-site-worker-pool',
    serviceId: workerId,
    stream: dependencies.logStream,
    clock: dependencies.logClock,
  });
  const list = dependencies.listJobs ?? null;
  const listIndexed = dependencies.listIndexedJobs ?? listIndexedJobs;
  const execute = dependencies.execute ?? executeSingleSiteWorker;
  const delay = dependencies.delay ?? interruptibleDelay;
  let cycles = 0;
  let jobsStarted = 0;
  let jobsSettled = 0;
  let drainLogged = false;
  let readyCursor = null;
  const logDrain = () => {
    if (drainLogged) return;
    drainLogged = true;
    logger.emit('drain-started', { jobsStarted, jobsSettled, acceptingNewJobs: false });
  };
  signal?.addEventListener('abort', logDrain, { once: true });
  logger.emit('pool-started', { pollMs, acceptingNewJobs: !signal?.aborted });
  try {
    while (!signal?.aborted && cycles < maxCycles) {
      cycles += 1;
      let states;
      try {
        if (list) {
          states = await list(queue);
        } else {
          const page = await listIndexed(queue, { category: 'ready', cursor: readyCursor, limit: 128 });
          states = page.jobs;
          readyCursor = page.cursor;
        }
      } catch (error) {
        logger.emit('queue-list-failed', { code: error.code ?? null, message: error.message, retryInMs: pollMs });
        if (!signal?.aborted && cycles < maxCycles) await delay(pollMs, signal);
        continue;
      }
      const candidates = workerCandidates(states, dependencies.now?.() ?? Date.now());
      if (candidates.length === 0) {
        logger.emit('pool-idle', { observedJobs: states.length, retryInMs: pollMs });
        if (!signal?.aborted && cycles < maxCycles) await delay(pollMs, signal);
        continue;
      }
      let accepted = false;
      for (const candidate of candidates) {
        if (signal?.aborted) break;
        logger.emit('claim-attempted', {
          jobId: candidate.jobId,
          executionState: candidate.executionState,
          recovery: candidate.executionState !== 'queued',
          attemptNumber: candidate.attemptNumber,
          fencingToken: candidate.fencingToken,
        });
        try {
          jobsStarted += 1;
          accepted = true;
          const result = await execute({
            queue,
            jobId: candidate.jobId,
            workerId,
            environment,
            dependencies: dependencies.workerDependencies ?? {},
          });
          jobsSettled += 1;
          logger.emit('job-settled', {
            jobId: candidate.jobId,
            attemptNumber: result.claim?.attemptNumber ?? null,
            fencingToken: result.claim?.fencingToken ?? null,
            executionState: result.state?.executionState ?? null,
            result: result.state?.result ?? null,
          });
          break;
        } catch (error) {
          if (CLAIM_RACE_CODES.has(error?.code)) {
            jobsStarted -= 1;
            accepted = false;
            logger.emit('claim-race-lost', { jobId: candidate.jobId, code: error.code, message: error.message });
            continue;
          }
          jobsSettled += 1;
          accepted = false;
          logger.emit('job-adapter-failed', { jobId: candidate.jobId, code: error.code ?? null, message: error.message });
          break;
        }
      }
      if (!accepted && !signal?.aborted && cycles < maxCycles) await delay(pollMs, signal);
    }
  } finally {
    signal?.removeEventListener('abort', logDrain);
  }
  if (signal?.aborted) logDrain();
  logger.emit('pool-stopped', { cycles, jobsStarted, jobsSettled, drained: signal?.aborted === true });
  return { cycles, jobsStarted, jobsSettled, drained: signal?.aborted === true };
}

function parseArguments(argv, environment) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--queue-root', '--worker', '--poll-ms'].includes(flag) || !value) {
      fail('SINGLE_SITE_POOL_USAGE', 'Usage: node scripts/run-single-site-worker-pool.mjs --queue-root <path> [--worker <id>] [--poll-ms <milliseconds>]');
    }
    values.set(flag, value);
  }
  return {
    queueRoot: values.get('--queue-root') ?? environment.AUDIT_JOB_QUEUE_ROOT,
    workerId: values.get('--worker') ?? environment.AUDIT_WORKER_ID ?? defaultWorkerId(),
    pollMs: parsePollMilliseconds(values.get('--poll-ms') ?? environment.AUDIT_QUEUE_POLL_MS),
  };
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv, environment);
  if (!options.queueRoot) fail('SINGLE_SITE_POOL_USAGE', 'AUDIT_JOB_QUEUE_ROOT or --queue-root is required.');
  const queue = await openJobQueue({ root: options.queueRoot });
  const controller = new AbortController();
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((name) => [name, () => {
    const error = new Error(`Worker pool received ${name}; draining active work.`);
    error.code = 'SINGLE_SITE_POOL_SIGNAL';
    controller.abort(error);
  }]));
  for (const [name, handler] of handlers) process.once(name, handler);
  try {
    return await runSingleSiteWorkerPool({
      queue,
      workerId: options.workerId,
      pollMs: options.pollMs,
      signal: controller.signal,
      environment,
    });
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'worker-pool-fatal', code: error.code ?? 'WORKER_POOL_FATAL', message: redact(error.message) })}\n`);
    process.exitCode = 1;
  });
}
