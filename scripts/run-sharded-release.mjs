import { createWriteStream, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readChecklistRelease, releaseOutcome, unavailableRelease } from './lib/release-truth.mjs';
import { createFreshShardedRunDirectory, validatedShardedRunId } from './lib/sharded-evidence.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shardTotal = integerEnvironment('AUDIT_SHARD_TOTAL', 4, 1, 16);
const performanceExpectedExecutions = integerEnvironment('AUDIT_PERFORMANCE_EXPECTED_EXECUTIONS', 70, 1, 10_000);
const runId = validatedShardedRunId(process.env.AUDIT_SHARDED_RUN_ID ?? makeRunId());
const hostRunDirectory = await createFreshShardedRunDirectory(
  join(repositoryRoot, 'artifacts', 'sharded'),
  runId,
);
const logDirectory = join(hostRunDirectory, 'logs');
const containerRunDirectory = `/work/artifacts/sharded/${runId}`;
const lifecyclePath = join(hostRunDirectory, 'sharded-run.json');
const activeChildren = new Set();
const startedAt = new Date().toISOString();
await Promise.all([
  fs.mkdir(logDirectory, { recursive: true }),
  fs.mkdir(join(hostRunDirectory, 'blob-reports'), { recursive: true }),
]);
const coordinatorLog = createWriteStream(join(logDirectory, 'coordinator.log'), { flags: 'a' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    writeCoordinator('signal-received', { signal, activeCommands: activeChildren.size });
    for (const child of activeChildren) child.kill(signal);
  });
}

writeCoordinator('sharded-release-started', {
  runId,
  shardTotal,
  hostRunDirectory,
  containerRunDirectory,
  shardWorkers: process.env.AUDIT_SHARD_WORKERS ?? '2',
  performanceWorkers: 1,
  performanceExpectedExecutions,
  performanceIsolation: 'dedicated-container-after-functional-shards',
  tlsPolicy: process.env.CANDIDATE_IGNORE_HTTPS_ERRORS === '1' ? 'candidate-development-bypass' : 'strict',
});

const buildResult = await runBuild();
const shardResults = buildResult.exitCode === 0
  ? await Promise.all(Array.from({ length: shardTotal }, (_, offset) => runShard(offset + 1)))
  : [];
const performanceResult = buildResult.exitCode === 0
  ? await runPerformance()
  : skippedResult('PERFORMANCE', 'Docker image build failed; isolated performance checks were not started.');
const mergeResult = buildResult.exitCode === 0
  ? await runMerge()
  : skippedResult('MERGE', 'Docker image build failed; shards, isolated performance checks, and merge were not started.');
const pipelineFailures = [];
let mergeLifecycle = null;
if (buildResult.exitCode !== 0) {
  pipelineFailures.push('Docker image build failed');
} else {
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
const pipelineStatus = pipelineFailures.length === 0 ? 'completed' : 'failed';
release ??= unavailableRelease(`No authoritative release decision is usable because ${pipelineFailures.join('; ') || 'the sharded pipeline failed'}.`);
const outcome = releaseOutcome(pipelineStatus, release);
const lifecycle = {
  schemaVersion: 2,
  runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  shardTotal,
  shardWorkers: integerEnvironment('AUDIT_SHARD_WORKERS', 2, 1, 16),
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
};
await atomicWriteJson(lifecyclePath, lifecycle);
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
  const command = ['docker', ...args];
  const commandStartedAt = new Date().toISOString();
  writeCoordinator('command-started', { label, command, logPath });
  const log = createWriteStream(logPath, { flags: 'a' });
  log.write(`${commandStartedAt} [${label}] command-started ${JSON.stringify({ command })}\n`);
  const started = performance.now();

  return new Promise((resolveCommand) => {
    let settled = false;
    const child = spawn('docker', args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
    relay(child.stdout, 'stdout');
    relay(child.stderr, 'stderr');
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      finish(127, null, error.message);
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      finish(exitCode ?? 1, signal, null);
    });

    function relay(stream, channel) {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) writeLine(channel, line);
      });
      stream.on('end', () => {
        if (buffer) writeLine(channel, buffer);
      });
    }

    function writeLine(channel, line) {
      const output = `${new Date().toISOString()} [${label}][${channel}] ${line}\n`;
      log.write(output);
      process.stdout.write(output);
    }

    function finish(exitCode, signal, error) {
      const result = {
        ...(index === null ? {} : { index }),
        label,
        command,
        startedAt: commandStartedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        exitCode,
        signal,
        error,
        logPath: relativeArtifactPath(logPath),
      };
      log.write(`${result.finishedAt} [${label}] command-finished ${JSON.stringify(result)}\n`);
      log.end();
      writeCoordinator('command-finished', result);
      resolveCommand(result);
    }
  });
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

function writeCoordinator(event, detail) {
  const output = `${new Date().toISOString()} [COORDINATOR] ${event} ${JSON.stringify(detail)}\n`;
  coordinatorLog.write(output);
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
  const temporary = `${path}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
  await fs.rename(temporary, path);
}

async function isFreshFile(path, runStartedAt) {
  const started = Date.parse(runStartedAt);
  return fs.stat(path)
    .then((stat) => stat.isFile() && stat.size > 0 && stat.mtimeMs >= started - 1_000)
    .catch(() => false);
}
