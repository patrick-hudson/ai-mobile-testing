import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  SHARED_DOCKER_RESILIENCE_ENV,
  SHARED_DOCKER_RESILIENCE_WORK_ITEM_COUNT,
} from '../shared/shared-docker-resilience-contract.mjs';
import { deriveRunnerRevision, runnerRevisionDigest } from '../shared/runner-revision.mjs';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { SHARED_RESILIENCE_CRASH_BOUNDARIES } from './lib/shared-resilience-failpoint.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--authoritative';
if (!['--authoritative', '--diagnostic'].includes(mode) || process.argv.length > 3) {
  throw new Error('Use --authoritative (default) or --diagnostic as the sole shared Docker proof mode.');
}
const authority = mode === '--authoritative' ? 'AUTHORITATIVE' : 'DIAGNOSTIC';
const trials = Number(process.env.AUDIT_SHARED_PROOF_TRIALS ?? (authority === 'AUTHORITATIVE' ? 3 : 1));
const workItemCount = Number(process.env.AUDIT_SHARED_PROOF_WORK_ITEMS ?? SHARED_DOCKER_RESILIENCE_WORK_ITEM_COUNT);
const skipBuildValue = process.env.AUDIT_SHARED_PROOF_SKIP_BUILD ?? '0';
if (!Number.isSafeInteger(trials) || trials < 1 || trials > 5
  || !Number.isSafeInteger(workItemCount) || workItemCount !== SHARED_DOCKER_RESILIENCE_WORK_ITEM_COUNT
  || !['0', '1'].includes(skipBuildValue)) {
  throw new Error('Shared Docker proof bounds are invalid.');
}
if (authority === 'AUTHORITATIVE' && (trials !== 3 || skipBuildValue !== '0')) {
  throw new Error('The authoritative shared Docker resilience gate requires exactly three trials and a build invocation. Use the separate --diagnostic mode for reduced diagnostics.');
}
const ordinaryWorkerCpuLimit = authority === 'AUTHORITATIVE'
  ? '1.0' : (process.env.AUDIT_SHARED_ORDINARY_CPUS ?? '1.0');
const ordinaryWorkerMemoryLimit = authority === 'AUTHORITATIVE'
  ? '2g' : (process.env.AUDIT_SHARED_ORDINARY_MEMORY ?? '2g');
const suffix = randomBytes(5).toString('hex');
const workers = Object.freeze(['shared-worker-ordinary-a', 'shared-worker-ordinary-b']);
const performanceWorker = 'shared-worker-performance';
const authoritativeNanoCpus = 1_000_000_000;
const authoritativeMemoryBytes = 2_147_483_648;
const performanceNanoCpus = 2_000_000_000;
const performanceMemoryBytes = 4_294_967_296;
const commonEnvironment = {
  ...process.env,
  COMPOSE_ANSI: 'never',
  [SHARED_DOCKER_RESILIENCE_ENV]: '1',
  AUDIT_SHARED_ORDINARY_CAPABILITIES: 'browser:chromium',
  AUDIT_SHARED_LEASE_MS: '12000',
  AUDIT_SHARED_COORDINATOR_LEASE_MS: '5000',
  AUDIT_SHARED_POLL_MS: '100',
  AUDIT_SHARED_PROOF_WORK_ITEMS: String(workItemCount),
  AUDIT_SHARED_ORDINARY_CPUS: ordinaryWorkerCpuLimit,
  AUDIT_SHARED_ORDINARY_MEMORY: ordinaryWorkerMemoryLimit,
};
const observedEvents = new Map();
const eventFollowers = new Map();

function oneLine(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.includes('\n') || normalized.includes('\r')) {
    throw new Error(`${label} did not produce one non-empty line.`);
  }
  return normalized;
}

function execute(command, args, { environment = commonEnvironment, allowFailure = false, timeoutMs = 240_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 64 * 1_048_576,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed before completion within ${timeoutMs}ms: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function executeAsync(command, args, { environment = commonEnvironment, timeoutMs = 240_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    const accept = (target) => (chunk) => {
      size += chunk.length;
      if (size > 64 * 1_048_576) {
        child.kill('SIGKILL');
        reject(new Error(`${command} ${args.join(' ')} exceeded the 64 MiB output bound.`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', accept(stdout));
    child.stderr.on('data', accept(stderr));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} exceeded the ${timeoutMs}ms timeout.`));
    }, timeoutMs);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const output = { status: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (code !== 0) reject(new Error(`${command} ${args.join(' ')} failed (${code}/${signal}):\n${output.stdout}\n${output.stderr}`));
      else resolve(output);
    });
  });
}

function compose(project, args, options) {
  if (args.includes('-v') && !project.startsWith(`amt-u4-${suffix}-`)) {
    throw new Error(`Refusing destructive proof cleanup outside the generated project prefix: ${project}`);
  }
  return execute('docker', ['compose', '-p', project, '--profile', 'shared-runner', '--profile', 'shared-proof', ...args], {
    ...options,
    environment: {
      ...commonEnvironment,
      AUDIT_SHARED_VOLUME_IDENTITY: `named-volume:${project}_shared-parent-runs`,
      ...(options?.environment ?? {}),
    },
  });
}

function parseEvents(output) {
  return output.split(/\r?\n/u).flatMap((line) => {
    const offset = line.indexOf('{');
    if (offset < 0) return [];
    try {
      const parsed = JSON.parse(line.slice(offset));
      const proofService = workers.find((service) => line.includes(service));
      return [{ ...parsed, ...(proofService ? { proofService } : {}) }];
    } catch { return []; }
  });
}

function jsonLine(output, event) {
  const value = parseEvents(output).findLast((entry) => entry.event === event);
  if (!value) throw new Error(`Expected ${event} in output:\n${output}`);
  return value;
}

function workerEvents(project) {
  const followers = eventFollowers.get(project);
  const failed = [...(followers?.values() ?? [])].find(({ error }) => error !== null);
  if (failed) throw failed.error;
  return [...(observedEvents.get(project)?.values() ?? [])];
}

function startEventFollower(project, service) {
  const followers = eventFollowers.get(project) ?? new Map();
  if (followers.has(service)) return;
  const args = ['compose', '-p', project, '--profile', 'shared-runner', '--profile', 'shared-proof',
    'logs', '--follow', '--no-color', service];
  const child = spawn('docker', args, {
    cwd: repositoryRoot,
    env: { ...commonEnvironment, AUDIT_SHARED_VOLUME_IDENTITY: `named-volume:${project}_shared-parent-runs` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const follower = { child, buffer: '', error: null, stopping: false };
  followers.set(service, follower);
  eventFollowers.set(project, followers);
  const accept = (line) => {
    const offset = line.indexOf('{');
    if (offset < 0) return;
    try {
      const event = { ...JSON.parse(line.slice(offset)), proofService: service };
      const prior = observedEvents.get(project) ?? new Map();
      prior.set(JSON.stringify(event), event);
      observedEvents.set(project, prior);
    } catch {}
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    follower.buffer += chunk;
    const lines = follower.buffer.split(/\r?\n/u);
    follower.buffer = lines.pop() ?? '';
    for (const line of lines) accept(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { follower.stderr = `${follower.stderr ?? ''}${chunk}`.slice(-4_096); });
  child.once('error', (error) => { follower.error ??= error; });
  child.once('close', (code, signal) => {
    if (!follower.stopping && code !== 0) {
      follower.error ??= new Error(
        `Docker log follower for ${service} exited with code ${code} and signal ${signal}: ${follower.stderr ?? ''}`,
      );
    }
  });
}

async function stopEventFollowers(project) {
  const followers = eventFollowers.get(project);
  if (!followers) return;
  await Promise.all([...followers.values()].map(async (follower) => {
    follower.stopping = true;
    if (follower.child.exitCode !== null || follower.child.signalCode !== null) return;
    follower.child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => follower.child.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (follower.child.exitCode === null && follower.child.signalCode === null) follower.child.kill('SIGKILL');
  }));
  eventFollowers.delete(project);
  for (const follower of followers.values()) {
    if (follower.buffer) {
      // A trailing partial line cannot be trusted as a complete JSON event.
      follower.buffer = '';
    }
  }
}

async function waitFor(project, label, predicate, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let events = [];
  while (Date.now() < deadline) {
    events = workerEvents(project);
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}. Recent events: ${JSON.stringify(events.slice(-20))}`);
}

async function waitForDurableTerminalWork(project, runId, environment, label, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let inspected = null;
  while (Date.now() < deadline) {
    inspected = driver(project, 'inspect', runId, { environment });
    if (inspected.terminal === true && inspected.workItems.length === workItemCount) return inspected;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}. Durable work states: ${JSON.stringify(
    inspected?.workItems.map(({ id, state, attempts }) => ({ id, state, attempts: attempts.length })) ?? [],
  )}`);
}

const publishedIds = (events) => new Set(events.filter(({ event }) => event === 'work-item-published').map(({ workItemId }) => workItemId));
function claimedButUnpublished(events) {
  const published = publishedIds(events);
  return events.findLast(({ event, workItemId }) => event === 'work-item-claimed' && !published.has(workItemId));
}

const driverEvents = Object.freeze({
  seed: 'shared-resilience-fixture-seeded',
  'seed-inventory-completed': 'shared-resilience-inventory-staged',
  inspect: 'shared-resilience-fixture-inspected',
  'stale-fence-probe': 'shared-resilience-stale-fence-probed',
  'read-failpoint': 'shared-resilience-failpoint-read',
  'activate-authority': 'shared-resilience-authority-activated',
  'provision-operator': 'shared-resilience-operator-provisioned',
  'probe-portal': 'shared-resilience-portal-ready',
  'accept-mutation': 'shared-resilience-mutation-accepted',
  'inspect-operation': 'shared-resilience-operation-inspected',
});

function driver(project, action, runId, {
  performanceWorkItemId = null,
  environment = {},
  extraEnvironment = {},
  allowFailure = false,
} = {}) {
  const service = ['provision-operator', 'probe-portal', 'accept-mutation'].includes(action)
    ? 'shared-resilience-control-client'
    : 'shared-resilience-driver';
  const result = compose(project, ['run', '--rm', '--no-deps',
    '-e', `AUDIT_SHARED_PROOF_ACTION=${action}`,
    '-e', `AUDIT_SHARED_PROOF_RUN_ID=${runId}`,
    '-e', `AUDIT_SHARED_PROOF_WORK_ITEMS=${workItemCount}`,
    ...(performanceWorkItemId === null ? [] : ['-e', `AUDIT_SHARED_PROOF_PERFORMANCE_WORK_ITEM_ID=${performanceWorkItemId}`]),
    ...Object.entries(extraEnvironment).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    service], { environment: { ...environment }, allowFailure });
  if (allowFailure && result.status !== 0) return { failed: true, ...result };
  const event = jsonLine(result.stdout, driverEvents[action]);
  if (action === 'inspect') {
    assert.equal(event.volumeIdentity, `named-volume:${project}_shared-parent-runs`,
      'the durable store must record the project-scoped Compose volume identity');
  }
  return event;
}

async function setup(project, runId, options = {}) {
  compose(project, ['down', '-v', '--remove-orphans'], { allowFailure: true });
  compose(project, ['run', '--rm', '--no-deps', 'single-site-volume-init']);
  const seed = driver(project, 'seed', runId, options);
  compose(project, ['up', '-d', 'shared-coordinator']);
  return seed;
}

function startWorkers(project, count, environment = {}) {
  assert([1, 2].includes(count));
  compose(project, ['up', '-d', '--no-deps', ...workers.slice(0, count)], { environment });
  for (const service of workers.slice(0, count)) startEventFollower(project, service);
}
function startPerformanceWorker(project) {
  compose(project, ['up', '-d', '--no-deps', performanceWorker]);
  startEventFollower(project, performanceWorker);
}
const stopWorkerB = (project) => compose(project, ['stop', '--timeout', '90', workers[1]]);

function runningLease(inspected, workerId) {
  const matches = inspected.workItems.filter((item) => item.state === 'running'
    && item.activeLease?.workerId === workerId);
  assert.equal(matches.length, 1, `expected exactly one active lease for ${workerId}`);
  return matches[0];
}

async function containerStats(project, services, {
  expectedNanoCpus = authoritativeNanoCpus,
  expectedMemoryBytes = authoritativeMemoryBytes,
} = {}) {
  const environment = { ...commonEnvironment, AUDIT_SHARED_VOLUME_IDENTITY: `named-volume:${project}_shared-parent-runs` };
  const composePrefix = ['compose', '-p', project, '--profile', 'shared-runner', '--profile', 'shared-proof'];
  const ids = (await executeAsync('docker', [...composePrefix, 'ps', '-q', ...services], { environment }))
    .stdout.trim().split(/\s+/u).filter(Boolean);
  assert.equal(ids.length, services.length, 'every measured worker must have one running container');
  const limits = await Promise.all(ids.map(async (id) => {
    const hostConfig = JSON.parse((await executeAsync('docker', ['inspect', '--format', '{{json .HostConfig}}', id])).stdout);
    const nanoCpus = Number(hostConfig.NanoCpus);
    const memoryBytes = Number(hostConfig.Memory);
    assert(Number.isSafeInteger(nanoCpus) && nanoCpus > 0,
      `Docker returned an invalid NanoCpus limit for measured worker ${id}.`);
    assert(Number.isSafeInteger(memoryBytes) && memoryBytes > 0,
      `Docker returned an invalid memory limit for measured worker ${id}.`);
    if (authority === 'AUTHORITATIVE') {
      assert.equal(nanoCpus, expectedNanoCpus,
        `Authoritative measured worker ${id} has the wrong CPU envelope.`);
      assert.equal(memoryBytes, expectedMemoryBytes,
        `Authoritative measured worker ${id} has the wrong memory envelope.`);
    }
    return { nanoCpus, memoryBytes };
  }));
  const output = (await executeAsync('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids])).stdout;
  const samples = output.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(samples.length, services.length, 'Docker must return one utilization sample per measured worker');
  const percentage = (value) => {
    const parsed = Number.parseFloat(String(value));
    assert(Number.isFinite(parsed) && parsed >= 0, `Docker returned an invalid utilization percentage: ${value}`);
    return parsed;
  };
  return samples.map((sample, index) => {
    const pids = Number(sample.PIDs);
    assert(Number.isSafeInteger(pids) && pids >= 0, `Docker returned an invalid PID count: ${sample.PIDs}`);
    assert(typeof sample.Name === 'string' && sample.Name.length > 0, 'Docker returned an unnamed container sample.');
    assert(typeof sample.MemUsage === 'string' && sample.MemUsage.length > 0,
      'Docker returned an invalid memory usage sample.');
    return {
      container: sample.Name,
      cpuPercent: percentage(sample.CPUPerc),
      memoryPercent: percentage(sample.MemPerc),
      memoryUsage: sample.MemUsage,
      pids,
      nanoCpus: limits[index].nanoCpus,
      memoryBytes: limits[index].memoryBytes,
    };
  });
}
function serviceContainer(project, service) {
  const ids = compose(project, ['ps', '-q', service]).stdout.trim().split(/\s+/u).filter(Boolean);
  if (ids.length !== 1) throw new Error(`Expected exactly one running ${service} container.`);
  return ids[0];
}

function crashContainer(containerId, service, processPattern) {
  const crashed = execute('docker', ['exec', containerId, 'pkill', '--signal', 'SIGKILL', '--full', processPattern], { allowFailure: true });
  if (![0, 137].includes(crashed.status)) {
    throw new Error(`Could not inject a process crash into ${service}: ${crashed.stderr}`);
  }
}

function restartCount(containerId) {
  return Number(execute('docker', ['inspect', '--format', '{{.RestartCount}}', containerId]).stdout.trim());
}

async function waitForRestart(containerId, before, label, timeoutMs = 300_000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const after = restartCount(containerId);
    if (after > before) return { after, recoveryMs: Math.ceil(performance.now() - started) };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label} Docker restart.`);
}

const crashEnvironment = (boundary, generation = '1') => ({
  AUDIT_SHARED_RESILIENCE_PROOF: '1',
  AUDIT_SHARED_CRASH_BOUNDARY: boundary,
  AUDIT_SHARED_CRASH_SENTINEL_ROOT: '/var/lib/ai-mobile-testing/shared/canonical/.shared-resilience-failpoints',
  AUDIT_SHARED_STORE_GENERATION: generation,
});

function sealCrashReceipt(input) {
  const body = {
    schemaVersion: 1,
    kind: 'shared-docker-crash-boundary-receipt',
    boundary: input.boundary,
    service: input.service,
    signal: 'SIGKILL',
    injectedAt: input.injectedAt,
    restartCountBefore: input.restartCountBefore,
    restartCountAfter: input.restartCountAfter,
    recoveryMs: input.recoveryMs,
    recoveryBoundMs: 300_000,
    expectedStateDigest: input.expectedStateDigest,
    recoveredStateDigest: input.recoveredStateDigest,
    staleFenceOutcome: input.staleFenceOutcome,
    operationOutcome: input.operationOutcome,
    duplicateEvidenceCount: input.duplicateEvidenceCount,
  };
  return Object.freeze({ ...body, digest: canonicalDigest(body) });
}

function assertCompletedSemantics(inspected) {
  const productFailure = inspected.workItems.find(({ id }) => id === 'proof-008');
  assert(productFailure, 'the frozen workload must contain its product-failure assertion');
  assert.equal(productFailure.state, 'completed_product_failure');
  assert.equal(productFailure.outcome, 'completed_product_failure');
  assert.equal(productFailure.attempts.length, 1, 'product assertion failures must never be retried');
  assert(inspected.workItems.filter(({ id }) => id !== 'proof-008').every(({ state, outcome }) => (
    state === 'completed_pass' && outcome === 'completed_pass'
  )), 'all non-failing frozen cases must pass');
}

function assertAdoptedUnchanged(before, after) {
  const adopted = before.invariant.workItems.filter(({ state }) => ['completed_pass', 'completed_product_failure'].includes(state));
  assert(adopted.length > 0, 'the crash boundary must include adopted canonical results');
  for (const snapshot of adopted) {
    assert.deepEqual(after.invariant.workItems.find(({ id }) => id === snapshot.id), snapshot,
      `already-adopted work ${snapshot.id} changed after recovery`);
  }
}

async function inspectAfterDown(project, runId, environment = {}) {
  compose(project, ['down', '--remove-orphans'], { environment });
  const inspected = driver(project, 'inspect', runId, { environment });
  assert.equal(inspected.terminal, true, 'the durable workload must be terminal after Compose down/up boundaries');
  assertCompletedSemantics(inspected);
  return inspected;
}

async function withProject(label, body) {
  const project = `amt-u4-${suffix}-${label}`;
  let primaryError = null;
  try { return await body(project); } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await stopEventFollowers(project);
    const cleanup = compose(project, ['down', '-v', '--remove-orphans'], { allowFailure: true });
    observedEvents.delete(project);
    if (cleanup.status !== 0 && primaryError === null) {
      throw new Error(`Proof cleanup failed for ${project}:\n${cleanup.stdout}\n${cleanup.stderr}`);
    }
  }
}

async function runSteady(label, workerCount, sequence) {
  return withProject(`${label}-${sequence}`, async (project) => {
    const runId = `proof-${label}-${sequence}`;
    const seed = await setup(project, runId);
    startWorkers(project, workerCount);
    await waitFor(project, 'an active worker lease', (entries) => entries.some(({ event }) => event === 'work-item-claimed'));
    const started = performance.now();
    const utilizationPromise = containerStats(project, workers.slice(0, workerCount));
    const events = await waitFor(project, `${workItemCount} published work items`, (entries) => publishedIds(entries).size === workItemCount);
    const wallTimeMs = performance.now() - started;
    const utilization = await utilizationPromise;
    if (workerCount === 2) {
      assert(workers.every((service) => events.some(({ event, proofService }) => event === 'work-item-claimed' && proofService === service)),
        'the many-worker topology must execute through both unique worker principals');
      assert(workers.every((service) => events.some(({ event, proofService }) => event === 'work-item-published' && proofService === service)),
        'both workers in the many-worker topology must publish canonical work');
    }
    const inspected = await inspectAfterDown(project, runId);
    assert(inspected.workItems.every(({ attempts }) => attempts.length === 1),
      'steady topology trials must publish every work item exactly once');
    return { label, workerCount, sequence, wallTimeMs, utilization, seed, inspected };
  });
}

async function runScaleTransition(referenceInvariant) {
  return withProject('transition', async (project) => {
    const runId = 'proof-transition';
    await setup(project, runId);
    startWorkers(project, 1);
    await waitFor(project, 'first adopted result', (events) => publishedIds(events).size >= 1);
    startWorkers(project, 2);
    await waitFor(project, 'worker B claim', (events) => events.some(({ event, proofService }) => (
      event === 'work-item-claimed' && proofService === workers[1]
    )));
    const beforeStop = driver(project, 'inspect', runId);
    const workerBItem = runningLease(beforeStop, 'compose-worker-ordinary-b');
    stopWorkerB(project);
    await waitFor(project, 'all work after returning to one worker', (events) => publishedIds(events).size === workItemCount);
    const inspected = await inspectAfterDown(project, runId);
    assert.deepEqual(inspected.invariant, referenceInvariant,
      'transitioning 1→2→1 unique worker principals must preserve canonical truth and evidence membership');
    const adoptedBItem = inspected.workItems.find(({ id }) => id === workerBItem.id);
    assert.equal(adoptedBItem.attempts.length, 1, 'scale-down must adopt worker B active work exactly once');
    assert(['completed_pass', 'completed_product_failure'].includes(adoptedBItem.state));
    return inspected;
  });
}

async function runWorkerKill(referenceInvariant) {
  return withProject('worker-kill', async (project) => {
    const runId = 'proof-worker-kill';
    await setup(project, runId);
    startWorkers(project, 1);
    await waitFor(project, 'one adopted and one in-flight item', (events) => (
      publishedIds(events).size >= 1 && claimedButUnpublished(events)
    ));
    const crashedContainer = serviceContainer(project, workers[0]);
    const before = driver(project, 'inspect', runId);
    const killedWorkItemId = runningLease(before, 'compose-worker-ordinary-a').id;
    crashContainer(crashedContainer, workers[0], 'scripts/run-shared-worker.mjs');
    await waitFor(project, 'bounded recovery attempt', (events) => events.some(({ event, workItemId, attempt }) => (
      event === 'work-item-claimed' && workItemId === killedWorkItemId && attempt === 2
    )));
    await waitFor(project, 'all work after worker SIGKILL', (events) => publishedIds(events).size === workItemCount);
    const observedRestartCount = restartCount(crashedContainer);
    const inspected = await inspectAfterDown(project, runId);
    assert.deepEqual(inspected.invariant, referenceInvariant,
      'worker SIGKILL must retain adopted truth and reproduce only unfinished evidence');
    assertAdoptedUnchanged(before, inspected);
    const recovered = inspected.workItems.find(({ id }) => id === killedWorkItemId);
    assert.deepEqual(recovered.attempts.map(({ outcome }) => outcome), ['operational_failure', recovered.outcome]);
    assert(inspected.workItems.filter(({ id }) => id !== killedWorkItemId).every(({ attempts }) => attempts.length === 1),
      'worker recovery duplicated unaffected work');
    assert(observedRestartCount >= 1, 'Docker restart policy did not recover the crashed worker process');
    return { killedWorkItemId, inspected };
  });
}

async function runCoordinatorKill(referenceInvariant) {
  return withProject('coordinator-kill', async (project) => {
    const runId = 'proof-coordinator-kill';
    await setup(project, runId);
    startWorkers(project, 1);
    await waitFor(project, 'coordinator kill boundary', (events) => (
      publishedIds(events).size >= 1 && claimedButUnpublished(events)
    ));
    const crashedContainer = serviceContainer(project, 'shared-coordinator');
    const before = driver(project, 'inspect', runId);
    const interruptedWorkItemId = runningLease(before, 'compose-worker-ordinary-a').id;
    crashContainer(crashedContainer, 'shared-coordinator', 'scripts/run-shared-coordinator.mjs');
    await waitFor(project, 'all work after coordinator SIGKILL', (events) => publishedIds(events).size === workItemCount);
    const observedRestartCount = restartCount(crashedContainer);
    const inspected = await inspectAfterDown(project, runId);
    assert.deepEqual(inspected.invariant, referenceInvariant,
      'coordinator restart must preserve the sealed subject, canonical results, and evidence membership');
    assertAdoptedUnchanged(before, inspected);
    const recovered = inspected.workItems.find(({ id }) => id === interruptedWorkItemId);
    assert.deepEqual(recovered.attempts.map(({ outcome }) => outcome), ['operational_failure', recovered.outcome],
      'only the old-epoch in-flight attempt may be requeued after coordinator loss');
    assert(inspected.workItems.filter(({ id }) => id !== interruptedWorkItemId).every(({ attempts }) => attempts.length === 1),
      'coordinator recovery duplicated unaffected work');
    assert(observedRestartCount >= 1, 'Docker restart policy did not recover the crashed coordinator process');
    return { interruptedWorkItemId, inspected };
  });
}

async function runCoordinatorCrashBoundary(boundary, referenceInvariant) {
  return withProject(`boundary-${boundary}`, async (project) => {
    const runId = `proof-boundary-${boundary}`;
    compose(project, ['down', '-v', '--remove-orphans'], { allowFailure: true });
    compose(project, ['run', '--rm', '--no-deps', 'single-site-volume-init']);
    driver(project, 'seed', runId);
    const requiresPublication = ['envelope-fsync', 'head-swap'].includes(boundary);
    if (requiresPublication) {
      driver(project, 'activate-authority', runId);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const environment = crashEnvironment(boundary, requiresPublication ? '2' : '1');
    compose(project, ['up', '-d', 'shared-coordinator'], { environment });
    const containerId = compose(project, ['ps', '-aq', 'shared-coordinator'], { environment }).stdout.trim();
    assert.match(containerId, /^[a-f0-9]{12,64}$/u);
    const before = restartCount(containerId);
    startWorkers(project, 1, environment);
    const restarted = await waitForRestart(containerId, before, `${boundary} coordinator`);
    await waitForDurableTerminalWork(project, runId, environment, `durable terminal work after ${boundary}`);
    const stale = driver(project, 'stale-fence-probe', runId, { environment });
    assert.equal(stale.outcome, 'rejected');
    const sentinel = driver(project, 'read-failpoint', runId, { environment, extraEnvironment: {
      AUDIT_SHARED_CRASH_BOUNDARY: boundary,
      AUDIT_SHARED_CRASH_SENTINEL_ROOT: environment.AUDIT_SHARED_CRASH_SENTINEL_ROOT,
    } }).sentinel;
    const inspected = await inspectAfterDown(project, runId, environment);
    assert.deepEqual(inspected.invariant, referenceInvariant,
      `${boundary} recovery changed canonical state or evidence membership`);
    const duplicateEvidenceCount = inspected.workItems.reduce((total, item) => total + Math.max(0, item.attempts.length - 1), 0);
    assert.equal(duplicateEvidenceCount, 0, `${boundary} created duplicate attempt evidence`);
    return sealCrashReceipt({
      boundary,
      service: 'shared-coordinator',
      injectedAt: sentinel.armedAt,
      restartCountBefore: before,
      restartCountAfter: restarted.after,
      recoveryMs: restarted.recoveryMs,
      expectedStateDigest: canonicalDigest(referenceInvariant),
      recoveredStateDigest: canonicalDigest(inspected.invariant),
      staleFenceOutcome: 'rejected',
      operationOutcome: 'not-applicable',
      duplicateEvidenceCount,
    });
  });
}

async function runInventorySealCrashBoundary() {
  return withProject('boundary-inventory-seal', async (project) => {
    const boundary = 'inventory-seal';
    const runId = 'proof-boundary-inventory-seal';
    compose(project, ['down', '-v', '--remove-orphans'], { allowFailure: true });
    compose(project, ['run', '--rm', '--no-deps', 'single-site-volume-init']);
    const staged = driver(project, 'seed-inventory-completed', runId);
    const coordinatorExpiry = Date.parse(staged.coordinatorExpiresAt);
    assert(Number.isFinite(coordinatorExpiry), 'inventory staging must return the exact coordinator lease expiry');
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, coordinatorExpiry - Date.now() + 150)));
    const environment = crashEnvironment(boundary);
    compose(project, ['up', '-d', 'shared-coordinator'], { environment });
    const containerId = compose(project, ['ps', '-aq', 'shared-coordinator'], { environment }).stdout.trim();
    const before = restartCount(containerId);
    const restarted = await waitForRestart(containerId, before, 'inventory-seal coordinator');
    let inspected;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      inspected = driver(project, 'inspect', runId, { environment });
      if (inspected.invariant.finalSubjectDigest) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(inspected?.invariant.finalSubjectDigest, 'inventory recovery did not retain the sealed final subject');
    const stateDigest = canonicalDigest(inspected.invariant);
    const stale = driver(project, 'stale-fence-probe', runId, { environment });
    assert.equal(stale.outcome, 'rejected');
    const sentinel = driver(project, 'read-failpoint', runId, { environment, extraEnvironment: {
      AUDIT_SHARED_CRASH_BOUNDARY: boundary,
      AUDIT_SHARED_CRASH_SENTINEL_ROOT: environment.AUDIT_SHARED_CRASH_SENTINEL_ROOT,
    } }).sentinel;
    const afterRestart = driver(project, 'inspect', runId, { environment });
    assert.equal(canonicalDigest(afterRestart.invariant), stateDigest,
      'inventory sealed graph changed after bounded recovery');
    const duplicateEvidenceCount = afterRestart.workItems.reduce((total, item) => total + Math.max(0, item.attempts.length - 1), 0);
    return sealCrashReceipt({
      boundary,
      service: 'shared-coordinator',
      injectedAt: sentinel.armedAt,
      restartCountBefore: before,
      restartCountAfter: restarted.after,
      recoveryMs: restarted.recoveryMs,
      expectedStateDigest: stateDigest,
      recoveredStateDigest: canonicalDigest(afterRestart.invariant),
      staleFenceOutcome: 'rejected',
      operationOutcome: 'not-applicable',
      duplicateEvidenceCount,
    });
  });
}

async function runMutationAcceptanceCrashBoundary() {
  return withProject('boundary-mutation-acceptance', async (project) => {
    const boundary = 'mutation-acceptance';
    const runId = 'proof-boundary-mutation-acceptance';
    compose(project, ['down', '-v', '--remove-orphans'], { allowFailure: true });
    compose(project, ['run', '--rm', '--no-deps', 'single-site-volume-init']);
    driver(project, 'seed', runId);
    const environment = { ...crashEnvironment(boundary), PORTAL_SHARED_CONTROL: '1', PORTAL_PORT: '0' };
    driver(project, 'provision-operator', runId, { environment });
    compose(project, ['up', '-d', 'portal'], { environment });
    const containerId = compose(project, ['ps', '-aq', 'portal'], { environment }).stdout.trim();
    const before = restartCount(containerId);
    const readyDeadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const probe = driver(project, 'probe-portal', runId, { environment, allowFailure: true });
      if (!probe.failed) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(ready, true, 'portal did not become ready before mutation injection');
    const interrupted = driver(project, 'accept-mutation', runId, {
      environment,
      allowFailure: true,
    });
    assert.equal(interrupted.failed, true, 'the mutation response must be interrupted by the portal SIGKILL');
    const restarted = await waitForRestart(containerId, before, 'mutation-acceptance portal');
    let accepted;
    const retryDeadline = Date.now() + 60_000;
    while (Date.now() < retryDeadline) {
      const retried = driver(project, 'accept-mutation', runId, {
        environment,
        allowFailure: true,
      });
      if (!retried.failed) { accepted = retried; break; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(accepted?.operation, 'portal did not replay the accepted mutation after restart');
    const operationId = accepted.operation.operationId;
    compose(project, ['up', '-d', 'shared-coordinator'], { environment });
    let operationEvidence;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      operationEvidence = driver(project, 'inspect-operation', runId, {
        environment,
        extraEnvironment: { AUDIT_SHARED_PROOF_OPERATION_ID: operationId },
      });
      if (operationEvidence.operation.state === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(operationEvidence?.operation.state, 'completed', 'accepted mutation did not reach a durable terminal result');
    assert.equal(operationEvidence.acceptedCount, 1, 'mutation acceptance was persisted more than once');
    assert.equal(operationEvidence.completedCount, 1, 'mutation terminal evidence was persisted more than once');
    const normalized = {
      operationId,
      state: operationEvidence.operation.state,
      outcome: operationEvidence.operation.outcome,
      acceptedCount: operationEvidence.acceptedCount,
      completedCount: operationEvidence.completedCount,
    };
    const sentinel = driver(project, 'read-failpoint', runId, { environment, extraEnvironment: {
      AUDIT_SHARED_CRASH_BOUNDARY: boundary,
      AUDIT_SHARED_CRASH_SENTINEL_ROOT: environment.AUDIT_SHARED_CRASH_SENTINEL_ROOT,
    } }).sentinel;
    return sealCrashReceipt({
      boundary,
      service: 'portal',
      injectedAt: sentinel.armedAt,
      restartCountBefore: before,
      restartCountAfter: restarted.after,
      recoveryMs: restarted.recoveryMs,
      expectedStateDigest: canonicalDigest(normalized),
      recoveredStateDigest: canonicalDigest(normalized),
      staleFenceOutcome: 'not-applicable',
      operationOutcome: 'persisted-terminal',
      duplicateEvidenceCount: 0,
    });
  });
}

async function runPerformanceIsolation() {
  return withProject('performance-isolation', async (project) => {
    const runId = 'proof-performance-isolation';
    const performanceWorkItemId = 'proof-003';
    await setup(project, runId, { performanceWorkItemId });
    startWorkers(project, 1);
    await waitFor(project, 'ordinary work before performance drain', (events) => publishedIds(events).size >= 1);
    startPerformanceWorker(project);
    await waitFor(project, 'isolated performance claim', (events) => events.some(({ event, workItemId, proofService }) => (
      event === 'work-item-claimed' && workItemId === performanceWorkItemId && proofService === performanceWorker
    )));
    const exclusiveBoundary = driver(project, 'inspect', runId);
    const performanceLease = runningLease(exclusiveBoundary, 'compose-worker-performance');
    assert.equal(performanceLease.id, performanceWorkItemId);
    assert.equal(performanceLease.capability, 'performance:lighthouse');
    assert.equal(performanceLease.resourceClass, 'performance');
    const runningOrdinary = exclusiveBoundary.workItems.filter(({ state, resourceClass }) => (
      state === 'running' && resourceClass === 'ordinary'
    ));
    assert.equal(runningOrdinary.length, 0,
      'the store-global performance lease must drain every active ordinary browser execution');
    const performanceUtilization = await containerStats(project, [performanceWorker], {
      expectedNanoCpus: performanceNanoCpus,
      expectedMemoryBytes: performanceMemoryBytes,
    });
    const events = await waitFor(project, 'all work after isolated performance execution', (entries) => (
      publishedIds(entries).size === workItemCount
    ));
    assert(!events.some(({ event, workItemId, proofService }) => (
      event === 'work-item-claimed' && workItemId === performanceWorkItemId && workers.includes(proofService)
    )), 'ordinary browser workers must never claim isolated performance work');
    const inspected = await inspectAfterDown(project, runId);
    const performanceResult = inspected.workItems.find(({ id }) => id === performanceWorkItemId);
    assert.equal(performanceResult.attempts.length, 1,
      'isolated performance work must publish once through the shared result protocol');
    assert.equal(performanceResult.state, 'completed_pass');
    return {
      workItemId: performanceWorkItemId,
      workerId: performanceLease.activeLease.workerId,
      workerService: performanceWorker,
      capability: performanceLease.capability,
      resourceClass: performanceLease.resourceClass,
      runningOrdinaryAtExclusiveBoundary: runningOrdinary.length,
      attempts: performanceResult.attempts.length,
      outcome: performanceResult.outcome,
      invariantDigest: inspected.invariantDigest,
      utilization: performanceUtilization,
    };
  });
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

function variance(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
}

const evidencePath = path.join(repositoryRoot, 'artifacts', 'self-tests', authority === 'AUTHORITATIVE'
  ? 'shared-docker-resilience-proof.json' : 'shared-docker-resilience-diagnostic.json');
const failurePath = path.join(repositoryRoot, 'artifacts', 'self-tests', 'shared-docker-resilience-failure.json');

try {
  if (authority === 'AUTHORITATIVE') {
    const status = execute('git', ['status', '--porcelain=v1', '--untracked-files=all']);
    assert.equal(status.stdout, '', 'the authoritative Docker proof requires a clean source checkout');
  }
  const workspaceRevision = await deriveRunnerRevision(repositoryRoot);
  // Every proof service resolves to the same tagged image. Building one service
  // avoids running the image's full validation layer concurrently four times.
  if (skipBuildValue === '0') {
    execute('docker', ['compose', '--profile', 'shared-proof', 'build', 'shared-resilience-driver'], { timeoutMs: 1_200_000 });
  }
  const imageRevision = oneLine(execute('docker', [
    'compose', '--profile', 'shared-proof', 'run', '--rm', '--no-deps', '--entrypoint', 'node',
    'shared-resilience-driver', '-e', "process.stdout.write(require('node:fs').readFileSync('/work/.audit-runner-revision','utf8'))",
  ]).stdout, 'built image runner revision');
  assert.equal(runnerRevisionDigest(imageRevision), runnerRevisionDigest(workspaceRevision),
    'the shared proof image must contain the exact current runner source revision');
  const composeConfiguration = JSON.parse(execute('docker', [
    'compose', '--profile', 'shared-proof', 'config', '--format', 'json',
  ]).stdout);
  const proofImage = oneLine(
    composeConfiguration.services?.['shared-resilience-driver']?.image,
    'configured proof image name',
  );
  const imageId = oneLine(execute('docker', [
    'image', 'inspect', '--format', '{{.Id}}', proofImage,
  ]).stdout, 'built proof image ID');
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/u, 'the built proof image must have a content-addressed image ID');
  await runSteady('warm-one', 1, 0);
  await runSteady('warm-many', 2, 0);
  const recorded = [];
  for (let sequence = 1; sequence <= trials; sequence += 1) {
    recorded.push(await runSteady('one', 1, sequence));
    recorded.push(await runSteady('many', 2, sequence));
  }
  const referenceInvariant = recorded[0].inspected.invariant;
  for (const run of recorded) {
    assert.deepEqual(run.inspected.invariant, referenceInvariant,
      `${run.label} trial ${run.sequence} changed canonical truth or frozen evidence membership`);
    assert.equal(run.seed.subjectCoreDigest, referenceInvariant.subjectCoreDigest);
    assert.equal(run.seed.executionManifestDigest, referenceInvariant.executionManifestDigest);
    assert.equal(run.seed.finalSubjectDigest, referenceInvariant.finalSubjectDigest);
  }
  const transition = await runScaleTransition(referenceInvariant);
  const workerKill = await runWorkerKill(referenceInvariant);
  const coordinatorKill = await runCoordinatorKill(referenceInvariant);
  const performanceIsolation = await runPerformanceIsolation();
  const crashBoundaries = [
    await runInventorySealCrashBoundary(),
    await runCoordinatorCrashBoundary('work-item-adoption', referenceInvariant),
    await runCoordinatorCrashBoundary('oracle-seal', referenceInvariant),
    await runCoordinatorCrashBoundary('envelope-fsync', referenceInvariant),
    await runCoordinatorCrashBoundary('head-swap', referenceInvariant),
    await runMutationAcceptanceCrashBoundary(),
  ];
  assert.deepEqual(crashBoundaries.map(({ boundary }) => boundary), SHARED_RESILIENCE_CRASH_BOUNDARIES,
    'the proof must execute every registered crash boundary exactly once in contract order');
  const oneTimes = recorded.filter(({ workerCount }) => workerCount === 1).map(({ wallTimeMs }) => wallTimeMs);
  const manyTimes = recorded.filter(({ workerCount }) => workerCount === 2).map(({ wallTimeMs }) => wallTimeMs);
  const oneWorkerMedianMs = median(oneTimes);
  const manyWorkerMedianMs = median(manyTimes);
  if (authority === 'AUTHORITATIVE') {
    assert(manyWorkerMedianMs < oneWorkerMedianMs,
      'the authoritative two-worker median must be faster than the one-worker median');
  }
  const report = {
    schemaVersion: 1,
    kind: 'shared-docker-resilience-proof',
    authority,
    buildPolicy: skipBuildValue === '0' ? 'compose-build-invoked' : 'existing-image-diagnostic-only',
    generatedAt: new Date().toISOString(),
    source: { workspaceRevision, imageRevision, imageId },
    workload: { digest: recorded[0].seed.workloadDigest, workItemCount, trials, warmedTrials: true,
      cachePolicy: 'fresh named volume per trial; shared image layers warm' },
    resources: { oneWorkerPrincipals: ['ordinary-a'], manyWorkerPrincipals: ['ordinary-a', 'ordinary-b'],
      browserConcurrencyPerWorker: 1, ordinaryWorkerCpuLimit, ordinaryWorkerMemoryLimit,
      performanceWorkerCpuLimit: '2.0', performanceWorkerMemoryLimit: '4g', performanceWorkerPrincipal: 'performance' },
    measurements: { oneWorkerMs: oneTimes, manyWorkerMs: manyTimes, oneWorkerMedianMs,
      manyWorkerMedianMs, oneWorkerVarianceMs2: variance(oneTimes),
      manyWorkerVarianceMs2: variance(manyTimes), throughputImprovement: oneWorkerMedianMs / manyWorkerMedianMs,
      utilization: recorded.map(({ label, sequence, workerCount, utilization }) => ({ label, sequence, workerCount, samples: utilization })) },
    invariants: { digest: recorded[0].inspected.invariantDigest, transitionDigest: transition.invariantDigest,
      workerKillDigest: workerKill.inspected.invariantDigest, coordinatorKillDigest: coordinatorKill.inspected.invariantDigest,
      workerKillRecoveredWorkItem: workerKill.killedWorkItemId,
      coordinatorKillRecoveredWorkItem: coordinatorKill.interruptedWorkItemId,
      productFailureAttempts: recorded[0].inspected.workItems.find(({ id }) => id === 'proof-008').attempts.length,
      performanceIsolation },
    crashBoundaries,
    durableState: 'docker compose down preserved every inspected run; down -v was used only for isolated proof cleanup',
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Shared Docker resilience proof passed; evidence: ${evidencePath}\n`);
} catch (error) {
  await mkdir(path.dirname(failurePath), { recursive: true });
  await writeFile(failurePath, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'shared-docker-resilience-failure',
    authority,
    failedAt: new Date().toISOString(),
    failure: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  process.stderr.write(`Shared Docker resilience proof failed; diagnostic evidence: ${failurePath}\n`);
  throw error;
}
