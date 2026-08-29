import { createWriteStream, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readChecklistRelease, releaseOutcome, unavailableRelease } from './lib/release-truth.mjs';
import {
  commandIntegrityFailures,
  PIPELINE_DIAGNOSTICS_FILENAME,
  pipelineDiagnosticsDocument,
} from './lib/pipeline-diagnostics.mjs';
import {
  DEFAULT_RELEASE_SHARD_CONCURRENCY,
  DEFAULT_RELEASE_SHARD_TOTAL,
  DEFAULT_RELEASE_SHARD_WORKERS,
  MAX_RELEASE_SHARD_TOTAL,
  MAX_RELEASE_SHARD_WORKERS,
} from './lib/sharded-defaults.mjs';
import { createFreshShardedRunDirectory, validatedShardedRunId } from './lib/sharded-evidence.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shardTotal = integerEnvironment('AUDIT_SHARD_TOTAL', DEFAULT_RELEASE_SHARD_TOTAL, 1, MAX_RELEASE_SHARD_TOTAL);
const shardWorkers = integerEnvironment('AUDIT_SHARD_WORKERS', DEFAULT_RELEASE_SHARD_WORKERS, 1, MAX_RELEASE_SHARD_WORKERS);
const shardConcurrency = integerEnvironment(
  'AUDIT_SHARD_CONCURRENCY',
  Math.min(DEFAULT_RELEASE_SHARD_CONCURRENCY, shardTotal),
  1,
  shardTotal,
);
const performanceExpectedExecutions = integerEnvironment('AUDIT_PERFORMANCE_EXPECTED_EXECUTIONS', 70, 1, 10_000);
const heartbeatIntervalMs = integerEnvironment('AUDIT_SHARDED_HEARTBEAT_MS', 5_000, 1_000, 60_000);
const heartbeatLeaseMs = integerEnvironment('AUDIT_SHARDED_LEASE_MS', 30_000, 10_000, 10 * 60_000);
const commandStopGraceMs = integerEnvironment('AUDIT_COMMAND_STOP_GRACE_MS', 8_000, 1_000, 60_000);
const maximumPartialLineCharacters = 64 * 1024;
const runId = validatedShardedRunId(process.env.AUDIT_SHARDED_RUN_ID ?? makeRunId());
const shardedHostRoot = resolve(
  process.env.AUDIT_SHARDED_HOST_ROOT ?? join(repositoryRoot, 'artifacts', 'sharded'),
);
const shardedContainerRoot = process.env.AUDIT_SHARDED_CONTAINER_ROOT ?? '/work/artifacts/sharded';
if (!shardedContainerRoot.startsWith('/') || shardedContainerRoot.includes('\0')) {
  throw new TypeError('AUDIT_SHARDED_CONTAINER_ROOT must be an absolute container path.');
}
const hostRunDirectory = await createFreshShardedRunDirectory(
  shardedHostRoot,
  runId,
);
const logDirectory = join(hostRunDirectory, 'logs');
const containerRunDirectory = `${shardedContainerRoot.replace(/\/+$/u, '')}/${runId}`;
const lifecyclePath = join(hostRunDirectory, 'sharded-run.json');
const heartbeatPath = join(hostRunDirectory, 'sharded-heartbeat.json');
const pipelineDiagnosticsPath = join(hostRunDirectory, PIPELINE_DIAGNOSTICS_FILENAME);
const activeChildren = new Set();
const commandProgress = new Map();
const startedAt = new Date().toISOString();
let stopRequest = null;
let coordinatorFailure = null;
let heartbeatWrite = Promise.resolve();
await Promise.all([
  fs.mkdir(logDirectory, { recursive: true }),
  fs.mkdir(join(hostRunDirectory, 'blob-reports'), { recursive: true }),
]);
const coordinatorLog = await openLogStream(join(logDirectory, 'coordinator.log'));
coordinatorLog.on('error', (error) => {
  coordinatorFailure ??= `Coordinator log failed: ${error.message}`;
  requestStop('LOG_FAILURE');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => requestStop(signal));
}

writeCoordinator('sharded-release-started', {
  runId,
  shardTotal,
  hostRunDirectory,
  containerRunDirectory,
  shardWorkers,
  shardConcurrency,
  performanceWorkers: 1,
  performanceExpectedExecutions,
  performanceIsolation: 'dedicated-container-after-functional-shards',
  tlsPolicy: process.env.CANDIDATE_IGNORE_HTTPS_ERRORS === '1' ? 'candidate-development-bypass' : 'strict',
});
await publishHeartbeat('running');
const heartbeatTimer = setInterval(() => void publishHeartbeat('running'), heartbeatIntervalMs);
heartbeatTimer.unref();

let buildResult = skippedResult('BUILD', 'The coordinator stopped before the Docker build started.');
let shardResults = [];
let performanceResult = skippedResult('PERFORMANCE', 'The coordinator stopped before isolated performance checks started.');
let mergeResult = skippedResult('MERGE', 'The coordinator stopped before the merge started.');
let coordinatorIntegrityFailures = [];
try {
  if (!stopRequest) buildResult = await runBuild();
  if (!stopRequest && buildResult.exitCode === 0) {
    shardResults = await runFunctionalShards();
  }
  if (!stopRequest && buildResult.exitCode === 0) performanceResult = await runPerformance();
  else if (!stopRequest) performanceResult = skippedResult('PERFORMANCE', 'Docker image build failed; isolated performance checks were not started.');
  coordinatorIntegrityFailures = commandIntegrityFailures([...shardResults, performanceResult]);
  await atomicWriteJson(pipelineDiagnosticsPath, pipelineDiagnosticsDocument({
    runId,
    failures: coordinatorIntegrityFailures,
    source: 'coordinator',
  }));
  if (!stopRequest && buildResult.exitCode === 0) mergeResult = await runMerge();
  else if (!stopRequest) mergeResult = skippedResult('MERGE', 'Docker image build failed; shards, isolated performance checks, and merge were not started.');
} catch (error) {
  coordinatorFailure ??= `Coordinator command lifecycle failed: ${error.message}`;
  requestStop('COORDINATOR_FAILURE');
}
const pipelineFailures = [];
let mergeLifecycle = null;
if (coordinatorFailure) pipelineFailures.push(coordinatorFailure);
if (stopRequest) {
  pipelineFailures.push(`Stopped by ${stopRequest.signal}`);
} else if (buildResult.exitCode !== 0) {
  pipelineFailures.push('Docker image build failed');
} else {
  pipelineFailures.push(...coordinatorIntegrityFailures.map(({ stage, reason }) => `${stage}: ${reason}`));
  const mergeLifecyclePath = join(hostRunDirectory, 'merge-lifecycle.json');
  if (!(await isFreshFile(mergeLifecyclePath, startedAt))) {
    pipelineFailures.push('merge lifecycle is missing or stale');
  } else {
    try {
      mergeLifecycle = JSON.parse(await fs.readFile(mergeLifecyclePath, 'utf8'));
    } catch (error) {
      pipelineFailures.push(`merge lifecycle is unavailable: ${error.message}`);
    }
  }
  if (mergeLifecycle && mergeLifecycle.pipeline?.status !== 'completed') {
    pipelineFailures.push(mergeLifecycle.pipeline?.reason ?? 'merge evidence pipeline did not complete');
  }
}

let release;
if (pipelineFailures.length === 0) {
  try {
    const checklistPath = join(hostRunDirectory, 'checklist', 'manifest.json');
    if (!(await isFreshFile(checklistPath, startedAt))) {
      throw new Error('Authoritative checklist manifest is missing or stale.');
    }
    release = await readChecklistRelease(checklistPath);
    if (mergeLifecycle.release?.decision !== release.decision) {
      pipelineFailures.push('merge lifecycle and checklist release decisions disagree');
      release = null;
    }
  } catch (error) {
    pipelineFailures.push(error.message);
  }
}
const pipelineStatus = stopRequest ? 'stopped' : pipelineFailures.length === 0 ? 'completed' : 'failed';
release ??= unavailableRelease(`No authoritative release decision is usable because ${pipelineFailures.join('; ') || 'the sharded pipeline failed'}.`);
const outcome = stopRequest ? { status: 'stopped', exitCode: 130 } : releaseOutcome(pipelineStatus, release);
const lifecycle = {
  schemaVersion: 2,
  runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  shardTotal,
  shardWorkers,
  shardConcurrency,
  performanceExpectedExecutions,
  productionUrl: process.env.PRODUCTION_URL ?? 'https://quitting7oh.org',
  candidateUrl: process.env.CANDIDATE_URL ?? 'https://beta.quitting7oh-org.pages.dev',
  candidateIgnoreHTTPSErrors: process.env.CANDIDATE_IGNORE_HTTPS_ERRORS === '1',
  build: buildResult,
  shards: shardResults,
  performance: performanceResult,
  merge: mergeResult,
  shardNonzeroExitCodes: shardResults
    .filter(({ exitCode }) => exitCode !== 0)
    .map(({ index, exitCode }) => ({ index, exitCode })),
  performanceNonzeroExitCode: performanceResult.exitCode === 0 ? null : performanceResult.exitCode,
  diagnostics: {
    authoritative: false,
    authoritativeReleaseSource: 'sharded-run.json',
    diagnosticCountsAuthoritative: false,
    shardNonzeroExitCodes: shardResults
      .filter(({ exitCode }) => exitCode !== 0)
      .map(({ index, exitCode }) => ({ index, exitCode })),
    performanceNonzeroExitCode: performanceResult.exitCode === 0 ? null : performanceResult.exitCode,
    integrityFailures: coordinatorIntegrityFailures,
  },
  mergePipeline: mergeLifecycle?.pipeline ?? null,
  pipeline: {
    status: pipelineStatus,
    completed: pipelineStatus === 'completed',
    reason: pipelineFailures.length > 0
      ? pipelineFailures.join('; ')
      : 'Build, parallel functional shards, isolated single-worker performance checks, merge, media processing, and checklist rebuild completed.',
    finishedAt: new Date().toISOString(),
  },
  release,
  status: outcome.status,
  stopRequestedAt: stopRequest?.requestedAt ?? null,
  stopSignal: stopRequest?.signal ?? null,
};
await atomicWriteJson(lifecyclePath, lifecycle);
clearInterval(heartbeatTimer);
await publishHeartbeat(outcome.status);
writeCoordinator('sharded-release-finished', {
  runId,
  status: lifecycle.status,
  pipelineStatus: lifecycle.pipeline.status,
  releaseDecision: lifecycle.release.decision,
  releaseReason: lifecycle.release.reason,
  lifecyclePath,
  shardExitCodes: shardResults.map(({ index, exitCode }) => ({ index, exitCode })),
  performanceExitCode: performanceResult.exitCode,
  buildExitCode: buildResult.exitCode,
  mergeExitCode: mergeResult.exitCode,
});
coordinatorLog.end();
if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;

async function runShard(index) {
  const logPath = join(logDirectory, `shard-${index}-of-${shardTotal}.log`);
  const containerArtifactDirectory = `${containerRunDirectory}/shards/shard-${index}-of-${shardTotal}`;
  const blobFile = `${containerRunDirectory}/blob-reports/report-${index}-of-${shardTotal}.zip`;
  const args = [
    'compose', '--profile', 'audit-sharded', 'run', '--rm',
    '-e', `AUDIT_SHARDED_RUN_ID=${runId}`,
    '-e', `AUDIT_SHARD_INDEX=${index}`,
    '-e', `AUDIT_SHARD_TOTAL=${shardTotal}`,
    '-e', `AUDIT_ARTIFACT_DIR=${containerArtifactDirectory}`,
    '-e', `PLAYWRIGHT_BLOB_OUTPUT_FILE=${blobFile}`,
    'audit-release-shard',
  ];
  return runDockerCommand({ kind: 'shard', index, args, logPath });
}

async function runFunctionalShards() {
  const results = new Array(shardTotal);
  let nextIndex = 1;
  writeCoordinator('functional-shard-pool-started', {
    shardTotal,
    shardConcurrency,
    shardWorkers,
    maximumConcurrentBrowserWorkers: shardConcurrency * shardWorkers,
  });
  await Promise.all(Array.from({ length: shardConcurrency }, async () => {
    while (!stopRequest) {
      const index = nextIndex;
      nextIndex += 1;
      if (index > shardTotal) return;
      results[index - 1] = await runShard(index);
    }
  }));
  for (let offset = 0; offset < shardTotal; offset += 1) {
    if (results[offset]) continue;
    results[offset] = {
      index: offset + 1,
      ...skippedResult(
        `SHARD ${offset + 1}/${shardTotal}`,
        `The coordinator stopped before shard ${offset + 1} entered the bounded execution pool.`,
      ),
    };
  }
  writeCoordinator('functional-shard-pool-finished', {
    shardTotal,
    shardConcurrency,
    started: results.filter(({ command }) => command.length > 0).length,
    skippedBeforeStart: results.filter(({ command }) => command.length === 0).length,
  });
  return results;
}

async function runPerformance() {
  const logPath = join(logDirectory, 'performance.log');
  const containerArtifactDirectory = `${containerRunDirectory}/shards/performance-isolated`;
  const blobFile = `${containerRunDirectory}/blob-reports/performance-isolated.zip`;
  writeCoordinator('performance-isolation-started', {
    workers: 1,
    expectedExecutions: performanceExpectedExecutions,
    containerArtifactDirectory,
    blobFile,
    afterFunctionalShards: true,
  });
  const args = [
    'compose', '--profile', 'audit-sharded', 'run', '--rm',
    '-e', `AUDIT_SHARDED_RUN_ID=${runId}`,
    '-e', `AUDIT_ARTIFACT_DIR=${containerArtifactDirectory}`,
    '-e', `PLAYWRIGHT_BLOB_OUTPUT_FILE=${blobFile}`,
    '-e', 'AUDIT_WORKERS=1',
    'audit-release-performance',
  ];
  return runDockerCommand({ kind: 'performance', index: null, args, logPath });
}

async function runBuild() {
  const args = [
    'compose', '--profile', 'audit-sharded', 'build',
    'audit-release-shard', 'audit-release-performance', 'audit-release-merge',
  ];
  return runDockerCommand({ kind: 'build', index: null, args, logPath: join(logDirectory, 'build.log') });
}

async function runMerge() {
  const args = [
    'compose', '--profile', 'audit-sharded', 'run', '--rm',
    '-e', `AUDIT_SHARDED_RUN_ID=${runId}`,
    '-e', `AUDIT_SHARD_TOTAL=${shardTotal}`,
    '-e', `AUDIT_SHARDED_STARTED_AT=${startedAt}`,
    '-e', `AUDIT_ARTIFACT_DIR=${containerRunDirectory}`,
    'audit-release-merge',
  ];
  return runDockerCommand({ kind: 'merge', index: null, args, logPath: join(logDirectory, 'merge.log') });
}

async function runDockerCommand({ kind, index, args, logPath }) {
  const label = kind === 'shard' ? `SHARD ${index}/${shardTotal}` : kind.toUpperCase();
  const progressName = kind === 'shard' ? `shard-${index}-of-${shardTotal}.log`
    : kind === 'performance' ? 'performance.log' : null;
  if (progressName) {
    commandProgress.set(progressName, {
      kind,
      index,
      total: null,
      completed: 0,
      auditFinishes: 0,
      passed: null,
      failed: null,
      flaky: null,
      skipped: null,
      didNotRun: null,
      finished: false,
      updatedAt: new Date().toISOString(),
    });
  }
  const command = ['docker', ...args];
  const commandStartedAt = new Date().toISOString();
  const deadlineMs = commandDeadlineMs(kind);
  writeCoordinator('command-started', { label, command, logPath, deadlineMs });
  const log = await openLogStream(logPath);
  log.write(`${commandStartedAt} [${label}] command-started ${JSON.stringify({ command })}\n`);
  const started = performance.now();

  return new Promise((resolveCommand) => {
    let settled = false;
    let timeoutError = null;
    let logError = null;
    let logBackpressured = false;
    let escalationTimer = null;
    const child = spawn('docker', args, {
      cwd: repositoryRoot,
      env: process.env,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    relay(child.stdout, 'stdout');
    relay(child.stderr, 'stderr');
    const deadlineTimer = setTimeout(() => {
      timeoutError = `${label} exceeded its ${deadlineMs}ms deadline.`;
      writeLine('stderr', `${timeoutError} Sending SIGTERM to the process group.`);
      signalProcessTree(child, 'SIGTERM');
      escalationTimer = setTimeout(() => {
        if (!settled) {
          writeLine('stderr', `${label} did not stop within ${commandStopGraceMs}ms; sending SIGKILL to the process group.`);
          signalProcessTree(child, 'SIGKILL');
        }
      }, commandStopGraceMs);
      escalationTimer.unref();
    }, deadlineMs);
    deadlineTimer.unref();
    log.once('error', (error) => {
      logError = `Command log failed: ${error.message}`;
      coordinatorFailure ??= `${label} ${logError}`;
      requestStop('LOG_FAILURE');
    });
    child.once('error', (error) => settle(127, null, error.message));
    child.once('close', (exitCode, signal) => settle(exitCode ?? 1, signal, null));

    function relay(stream, channel) {
      let buffer = '';
      let omitted = 0;
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const [lineIndex, line] of lines.entries()) {
          writeLine(channel, lineIndex === 0 && omitted > 0
            ? `[coordinator omitted ${omitted} oversized output characters] ${line}`
            : line);
          if (lineIndex === 0) omitted = 0;
        }
        if (buffer.length > maximumPartialLineCharacters) {
          const remove = buffer.length - maximumPartialLineCharacters;
          buffer = buffer.slice(remove);
          omitted += remove;
        }
      });
      stream.on('end', () => {
        if (buffer) writeLine(channel, omitted > 0
          ? `[coordinator omitted ${omitted} oversized output characters] ${buffer}`
          : buffer);
      });
      stream.once('error', (error) => settle(1, null, `${channel} stream failed: ${error.message}`));
    }

    function writeLine(channel, line) {
      if (progressName) trackCommandProgress(progressName, line);
      const output = `${new Date().toISOString()} [${label}][${channel}] ${line}\n`;
      const accepted = log.write(output);
      if (!accepted && !logBackpressured) {
        logBackpressured = true;
        child.stdout?.pause();
        child.stderr?.pause();
        log.once('drain', () => {
          logBackpressured = false;
          child.stdout?.resume();
          child.stderr?.resume();
        });
      }
      process.stdout.write(output);
    }

    function settle(exitCode, signal, error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (child.auditStopTimer) clearTimeout(child.auditStopTimer);
      activeChildren.delete(child);
      if (progressName) {
        const progress = commandProgress.get(progressName);
        progress.finished = true;
        progress.completed = progress.total ?? progress.completed;
        progress.updatedAt = new Date().toISOString();
        commandProgress.set(progressName, progress);
      }
      const result = {
        ...(index === null ? {} : { index }),
        label,
        command,
        startedAt: commandStartedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        exitCode,
        signal,
        error: error ?? timeoutError ?? logError,
        deadlineMs,
        logPath: relativeArtifactPath(logPath),
      };
      if (!log.destroyed) {
        log.write(`${result.finishedAt} [${label}] command-finished ${JSON.stringify(result)}\n`);
        log.end();
      }
      writeCoordinator('command-finished', result);
      resolveCommand(result);
    }
  });
}

function commandDeadlineMs(kind) {
  if (kind === 'build') return integerEnvironment('AUDIT_BUILD_DEADLINE_MS', 20 * 60_000, 1_000, 24 * 60 * 60_000);
  if (kind === 'merge') return integerEnvironment('AUDIT_MERGE_DEADLINE_MS', 30 * 60_000, 1_000, 24 * 60 * 60_000);
  if (kind === 'performance') return integerEnvironment('AUDIT_PERFORMANCE_DEADLINE_MS', 45 * 60_000, 1_000, 24 * 60 * 60_000);
  return integerEnvironment('AUDIT_SHARD_DEADLINE_MS', 45 * 60_000, 1_000, 24 * 60 * 60_000);
}

function requestStop(signal) {
  if (!stopRequest) {
    stopRequest = { signal, requestedAt: new Date().toISOString() };
    if (signal !== 'LOG_FAILURE') writeCoordinator('signal-received', { signal, activeCommands: activeChildren.size });
    void publishHeartbeat('stopping');
  }
  const childSignal = signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM';
  for (const child of activeChildren) {
    signalProcessTree(child, childSignal);
    if (child.auditStopTimer) continue;
    child.auditStopTimer = setTimeout(() => {
      if (activeChildren.has(child)) signalProcessTree(child, 'SIGKILL');
    }, commandStopGraceMs);
    child.auditStopTimer.unref();
  }
}

function signalProcessTree(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') coordinatorFailure ??= `Could not send ${signal} to a command process group: ${error.message}`;
  }
}

function skippedResult(label, error) {
  const now = new Date().toISOString();
  return {
    label,
    command: [],
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    exitCode: 1,
    signal: null,
    error,
    logPath: null,
  };
}

function openLogStream(path) {
  return new Promise((resolveStream, rejectStream) => {
    const stream = createWriteStream(path, { flags: 'a', mode: 0o640 });
    const onError = (error) => {
      stream.removeListener('open', onOpen);
      rejectStream(error);
    };
    const onOpen = () => {
      stream.removeListener('error', onError);
      resolveStream(stream);
    };
    stream.once('error', onError);
    stream.once('open', onOpen);
  });
}

async function publishHeartbeat(status) {
  const updatedAt = new Date().toISOString();
  const heartbeat = {
    schemaVersion: 1,
    runId,
    processId: process.pid,
    status,
    startedAt,
    updatedAt,
    leaseExpiresAt: new Date(Date.now() + heartbeatLeaseMs).toISOString(),
    activeCommands: activeChildren.size,
    progress: Object.fromEntries([...commandProgress.entries()].map(([name, value]) => [name, { ...value }])),
    stopRequestedAt: stopRequest?.requestedAt ?? null,
    stopSignal: stopRequest?.signal ?? null,
  };
  heartbeatWrite = heartbeatWrite.then(() => atomicWriteJson(heartbeatPath, heartbeat));
  try {
    await heartbeatWrite;
  } catch (error) {
    coordinatorFailure ??= `Coordinator heartbeat failed: ${error.message}`;
    if (!stopRequest) {
      stopRequest = { signal: 'HEARTBEAT_FAILURE', requestedAt: new Date().toISOString() };
      for (const child of activeChildren) signalProcessTree(child, 'SIGTERM');
    }
  }
}

function trackCommandProgress(name, line) {
  const progress = commandProgress.get(name);
  if (!progress) return;
  const running = line.match(/Running\s+(\d+)\s+tests?/i);
  if (running) progress.total = Number(running[1]);
  if (line.includes('[AUDIT_TEST_FINISH]')) progress.auditFinishes += 1;
  for (const [pattern, key] of [
    [/\b(\d+)\s+passed(?:\s|\(|$)/i, 'passed'],
    [/\b(\d+)\s+failed(?:\s|$)/i, 'failed'],
    [/\b(\d+)\s+flaky(?:\s|$)/i, 'flaky'],
    [/\b(\d+)\s+skipped(?:\s|$)/i, 'skipped'],
    [/\b(\d+)\s+did not run(?:\s|$)/i, 'didNotRun'],
  ]) {
    const summary = line.match(pattern);
    if (summary) progress[key] = Number(summary[1]);
  }
  progress.completed = progress.finished && progress.total !== null
    ? progress.total
    : Math.min(progress.total ?? Number.POSITIVE_INFINITY, progress.auditFinishes);
  progress.updatedAt = new Date().toISOString();
  commandProgress.set(name, progress);
}

function writeCoordinator(event, detail) {
  const output = `${new Date().toISOString()} [COORDINATOR] ${event} ${JSON.stringify(detail)}\n`;
  if (!coordinatorLog.destroyed) coordinatorLog.write(output);
  process.stdout.write(output);
}

function relativeArtifactPath(path) {
  return path.slice(hostRunDirectory.length + 1).replaceAll('\\', '/');
}

function integerEnvironment(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function makeRunId() {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'z').replaceAll(':', '-').toLowerCase();
  return `${timestamp}-${randomBytes(3).toString('hex')}`;
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
    await fs.rename(temporary, path);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

async function isFreshFile(path, runStartedAt) {
  const started = Date.parse(runStartedAt);
  return fs.stat(path)
    .then((stat) => stat.isFile() && stat.size > 0 && stat.mtimeMs >= started - 1_000)
    .catch(() => false);
}
