import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  claimJob,
  heartbeatJob,
  openJobQueue,
  readJob,
  sha256,
  submitJob,
  transitionJob,
} from './lib/job-queue.mjs';
import { MAX_MEDIA_WORKERS, MAX_SINGLE_SITE_WORKER_REPLICAS } from './lib/concurrency-defaults.mjs';
import { MAX_RELEASE_SHARD_TOTAL } from './lib/sharded-defaults.mjs';
import { startHeartbeatPump } from './run-single-site-worker.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerModule = path.join(scriptDirectory, 'lib', 'lease-load-worker.mjs');
const MINIMUM_SAMPLES_PER_WORKER = 3;
const RECOVERY_PROBE_MS = 750;

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function integerOption(name, fallback, minimum, maximum) {
  const raw = option(name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function digest(label) {
  return sha256(`single-site-lease-load:${label}`);
}

function submission(index) {
  return {
    idempotencyKey: `lease-load-${String(index).padStart(2, '0')}`,
    runMode: 'single-site',
    inputDocumentDigest: digest(`input-${index}`),
    runContractDigest: digest(`contract-${index}`),
    compiledManifestDigest: digest('manifest'),
    preflightDigest: digest('preflight'),
    identityFingerprint: digest('identity'),
    revisionFingerprint: digest('revision'),
    evidenceAuthority: { authoritative: true, reasons: [] },
    registryRevision: 'lease-load-plugins-v1',
    targetSetRevision: 'lease-load-targets-v1',
    runnerRevision: 'lease-load-runner-v1',
    stageDeadlines: {
      browser: '2030-01-01T00:10:00.000Z',
      finalizer: '2030-01-01T00:20:00.000Z',
    },
  };
}

function percentile(values, percentileValue) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('Cannot calculate a percentile without samples.');
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(percentileValue * ordered.length) - 1)];
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

async function isContainer() {
  try {
    const stat = await fs.lstat('/.dockerenv');
    if (stat.isFile()) return true;
  } catch {}
  try {
    return /(?:docker|containerd|kubepods)/i.test(await fs.readFile('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

async function cgroupLimits() {
  const cpuMax = await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8').then((value) => value.trim()).catch(() => null);
  const memoryMax = await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8').then((value) => value.trim()).catch(() => null);
  const [quota, period] = cpuMax?.split(/\s+/) ?? [];
  const effectiveCpuCount = quota && quota !== 'max' && Number(quota) > 0 && Number(period) > 0
    ? Number(quota) / Number(period)
    : null;
  return {
    cpuMax,
    effectiveCpuCount,
    memoryMaxBytes: memoryMax && memoryMax !== 'max' && /^\d+$/.test(memoryMax) ? Number(memoryMax) : null,
  };
}

async function atomicWriteJson(file, value) {
  const destination = path.resolve(file);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

function loadLane(kind, lane, control, durationMs, scratchDirectory) {
  const worker = new Worker(workerModule, {
    workerData: {
      kind,
      lane,
      control,
      durationMs,
      scratchPath: path.join(scratchDirectory, `${kind}-${lane}.bin`),
    },
  });
  let readyResolve;
  let doneResolve;
  let rejectReady;
  let rejectDone;
  const ready = new Promise((resolve, rejectPromise) => {
    readyResolve = resolve;
    rejectReady = rejectPromise;
  });
  const done = new Promise((resolve, rejectPromise) => {
    doneResolve = resolve;
    rejectDone = rejectPromise;
  });
  worker.on('message', (message) => {
    if (message?.event === 'ready') readyResolve(message);
    if (message?.event === 'done') doneResolve(message);
  });
  worker.once('error', (error) => {
    rejectReady(error);
    rejectDone(error);
  });
  worker.once('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`${kind} load lane ${lane} exited ${code}.`);
      rejectReady(error);
      rejectDone(error);
    }
  });
  return { worker, ready, done };
}

const container = await isContainer();
if (process.argv.includes('--require-container') && !container) {
  throw new Error('The formal maximum-load lease proof must run inside the Docker fixture.');
}
const minimumDuration = DEFAULT_HEARTBEAT_MS * (MINIMUM_SAMPLES_PER_WORKER + 1) + 1_000;
const durationMs = integerOption('--duration-ms', minimumDuration, minimumDuration, 120_000);
const configuredRoot = option('--queue-root') ?? process.env.AUDIT_JOB_QUEUE_ROOT ?? os.tmpdir();
const evidencePath = option('--evidence')
  ?? path.resolve('artifacts', 'self-tests', container ? 'single-site-lease-load-proof.json' : 'single-site-lease-load-proof.host.json');
await fs.mkdir(configuredRoot, { recursive: true });
const temporaryRoot = await fs.mkdtemp(path.join(path.resolve(configuredRoot), 'lease-load-proof-'));
const queueRoot = path.join(temporaryRoot, 'queue');
const scratchDirectory = path.join(temporaryRoot, 'scratch');
await fs.mkdir(scratchDirectory, { recursive: true });
const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
const controlView = new Int32Array(control);
const loadLanes = [];
const heartbeatPumps = [];
let recoveryTimer = null;
let recoveryInFlight = Promise.resolve();
let recoveryProbeCount = 0;
let recoveryLockBusyCount = 0;
let falseFencingCount = 0;
const falseFencing = [];

try {
  const queue = await openJobQueue({ root: queueRoot });
  assert.equal(queue.heartbeatMs, DEFAULT_HEARTBEAT_MS);
  assert.equal(queue.leaseMs, DEFAULT_LEASE_MS);
  assert.ok(queue.leaseMs >= queue.heartbeatMs * 4, 'queue configuration must retain its static four-times interval invariant');

  const jobs = await Promise.all(Array.from({ length: MAX_SINGLE_SITE_WORKER_REPLICAS }, async (_, index) => {
    const submitted = await submitJob(queue, submission(index));
    const claim = await claimJob(queue, submitted.state.jobId, `lease-load-worker-${index}`);
    await transitionJob(queue, claim, 'running');
    return { jobId: submitted.state.jobId, claim };
  }));

  for (const kind of ['worker', 'shard', 'media']) {
    const count = kind === 'worker' ? MAX_SINGLE_SITE_WORKER_REPLICAS
      : kind === 'shard' ? MAX_RELEASE_SHARD_TOTAL
        : MAX_MEDIA_WORKERS;
    for (let lane = 0; lane < count; lane += 1) {
      loadLanes.push(loadLane(kind, lane, control, durationMs, scratchDirectory));
    }
  }
  await Promise.all(loadLanes.map(({ ready }) => ready));

  const samples = [];
  const heartbeatFatal = [];
  const loadStartedAtMonotonic = performance.now();
  for (const { claim } of jobs) {
    let previousDurableCompletionAt = loadStartedAtMonotonic;
    const pump = startHeartbeatPump(queue, claim, {
      heartbeat: async (...args) => {
        const startedAt = performance.now();
        const result = await heartbeatJob(...args);
        const completedAt = performance.now();
        const sample = {
          workerId: claim.workerId,
          durableCompletionGapMs: completedAt - previousDurableCompletionAt,
          scheduleLatenessMs: Math.max(0, startedAt - (previousDurableCompletionAt + queue.heartbeatMs)),
          operationMs: completedAt - startedAt,
          completedAt,
        };
        samples.push(sample);
        previousDurableCompletionAt = completedAt;
        return result;
      },
      onFatal: (error) => heartbeatFatal.push({ workerId: claim.workerId, code: error?.code ?? null, message: error?.message ?? String(error) }),
    });
    heartbeatPumps.push(pump);
  }

  const probeRecoveries = async () => {
    const results = await Promise.allSettled(jobs.map(({ jobId }, index) => (
      claimJob(queue, jobId, `lease-load-recovery-${index}`)
    )));
    recoveryProbeCount += results.length;
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        falseFencingCount += 1;
        falseFencing.push({ jobId: jobs[index].jobId, fencingToken: result.value.fencingToken });
      } else if (result.reason?.code === 'QUEUE_LOCK_BUSY') {
        recoveryLockBusyCount += 1;
      } else if (result.reason?.code !== 'QUEUE_ALREADY_CLAIMED') {
        throw result.reason;
      }
    }
  };
  recoveryTimer = setInterval(() => {
    recoveryInFlight = recoveryInFlight.then(probeRecoveries);
  }, RECOVERY_PROBE_MS);

  Atomics.store(controlView, 0, 1);
  Atomics.notify(controlView, 0, loadLanes.length);
  const laneResults = await Promise.all(loadLanes.map(({ done }) => done));
  const loadCompletedAtMonotonic = performance.now();
  clearInterval(recoveryTimer);
  recoveryTimer = null;
  await recoveryInFlight;
  await Promise.all(heartbeatPumps.map((pump) => pump.stop()));

  const states = await Promise.all(jobs.map(({ jobId }) => readJob(queue, jobId)));
  const samplesDuringLoad = samples.filter(({ completedAt }) => completedAt <= loadCompletedAtMonotonic);
  const delays = samplesDuringLoad.map(({ durableCompletionGapMs }) => durableCompletionGapMs);
  const scheduleLateness = samplesDuringLoad.map(({ scheduleLatenessMs }) => scheduleLatenessMs);
  const operationDurations = samplesDuringLoad.map(({ operationMs }) => operationMs);
  const p99DelayMs = percentile(delays, 0.99);
  const p99OperationMs = percentile(operationDurations, 0.99);
  const minimumRequiredSamples = jobs.length * MINIMUM_SAMPLES_PER_WORKER;
  const workersMeetingMinimumSamples = jobs.filter(({ claim }) => (
    samplesDuringLoad.filter(({ workerId }) => workerId === claim.workerId).length >= MINIMUM_SAMPLES_PER_WORKER
  )).length;
  const eachWorkerSampled = workersMeetingMinimumSamples === jobs.length;
  const currentFenceIntact = states.every((state, index) => (
    state.executionState === 'running'
      && state.attemptId === jobs[index].claim.attemptId
      && state.fencingToken === jobs[index].claim.fencingToken
      && state.lease?.workerId === jobs[index].claim.workerId
      && !state.events.some(({ type }) => type === 'lease-expired')
  ));
  const zeroFalseFencing = falseFencingCount === 0 && heartbeatFatal.length === 0 && currentFenceIntact;
  const leaseAtLeastFourTimesObservedP99 = queue.leaseMs >= 4 * p99DelayMs;
  const passed = samplesDuringLoad.length >= minimumRequiredSamples && eachWorkerSampled
    && zeroFalseFencing && leaseAtLeastFourTimesObservedP99;
  const evidence = {
    schemaVersion: 1,
    kind: 'single-site-maximum-load-lease-proof',
    generatedAt: new Date().toISOString(),
    environment: {
      container,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      cpuCount: os.cpus().length,
      cgroupLimits: await cgroupLimits(),
      filesystemType: queue.storage?.filesystemType ?? 'unverified',
    },
    declaredConcurrency: {
      workerReplicas: MAX_SINGLE_SITE_WORKER_REPLICAS,
      shardContainers: MAX_RELEASE_SHARD_TOTAL,
      mediaWorkers: MAX_MEDIA_WORKERS,
      totalConcurrentLoadLanes: loadLanes.length,
    },
    queuePolicy: {
      heartbeatMs: queue.heartbeatMs,
      leaseMs: queue.leaseMs,
      staticMinimumLeaseMs: queue.heartbeatMs * 4,
      observedMinimumLeaseMs: rounded(p99DelayMs * 4),
    },
    workload: {
      profile: 'bounded-worker-thread-cpu-plus-media-fsync-v1',
      requestedDurationMs: durationMs,
      observedDurationMs: rounded(loadCompletedAtMonotonic - loadStartedAtMonotonic),
      laneIterations: laneResults.reduce((total, result) => total + result.iterations, 0),
      mediaWrites: laneResults.reduce((total, result) => total + result.writes, 0),
      limitations: [
        'The fixture uses real concurrent CPU and fsync pressure rather than launching browsers or FFmpeg codecs.',
        'The Docker proof uses the artifact bind for an isolated, automatically removed queue workspace so existing production queue volumes are never mutated.',
        'The formal completion-matrix evidence is the --require-container run; host output is diagnostic only.',
      ],
    },
    observation: {
      heartbeatDelayDefinition: 'elapsed milliseconds between durable heartbeat completions, including the configured interval and persistence latency',
      heartbeatSamples: samples.length,
      heartbeatSamplesDuringMaximumLoad: samplesDuringLoad.length,
      minimumRequiredSamples,
      workersMeetingMinimumSamples,
      p99HeartbeatDelayMs: rounded(p99DelayMs),
      maximumHeartbeatDelayMs: rounded(Math.max(...delays)),
      p99HeartbeatScheduleLatenessMs: rounded(percentile(scheduleLateness, 0.99)),
      p99HeartbeatOperationMs: rounded(p99OperationMs),
      recoveryProbeCount,
      recoveryLockBusyCount,
      falseFencingCount,
      falseFencing,
      heartbeatFatal,
      currentFenceIntact,
    },
    verdict: {
      zeroFalseFencing,
      leaseAtLeastFourTimesObservedP99,
      configuredLeaseToObservedP99Ratio: rounded(queue.leaseMs / Math.max(p99DelayMs, 0.001)),
      independentHeartbeatObserved: samplesDuringLoad.length >= minimumRequiredSamples && eachWorkerSampled,
      passed,
    },
  };
  await atomicWriteJson(evidencePath, evidence);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  assert.equal(passed, true, `Maximum-load lease proof failed; inspect ${evidencePath}.`);
} finally {
  if (recoveryTimer !== null) clearInterval(recoveryTimer);
  await recoveryInFlight.catch(() => undefined);
  await Promise.all(heartbeatPumps.map((pump) => pump.stop().catch(() => undefined)));
  await Promise.all(loadLanes.map(({ worker }) => worker.terminate().catch(() => undefined)));
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
