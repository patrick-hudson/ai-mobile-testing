import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readChecklistRelease, releaseOutcome, unavailableRelease } from './lib/release-truth.mjs';
import { expectedShardedBlobs, inspectShardedBlobs } from './lib/sharded-evidence.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shardTotal = integerEnvironment('AUDIT_SHARD_TOTAL', 1, 64);
const artifactRoot = containedArtifactPath(process.env.AUDIT_ARTIFACT_DIR, 'AUDIT_ARTIFACT_DIR');
const blobDirectory = join(artifactRoot, 'blob-reports');
const lifecyclePath = join(artifactRoot, 'merge-lifecycle.json');
const startedAt = new Date().toISOString();
const shardedRunStartedAt = timestampEnvironment('AUDIT_SHARDED_STARTED_AT');
await fs.mkdir(artifactRoot, { recursive: true });

const expectedBlobEvidence = expectedShardedBlobs(blobDirectory, shardTotal);
const blobPreflight = await inspectShardedBlobs(expectedBlobEvidence, shardedRunStartedAt);
const expectedBlobs = expectedBlobEvidence.map(({ path }) => path);
const missingBlobs = blobPreflight.missing.map(({ path }) => path);
const staleBlobs = blobPreflight.stale.map(({ path, kind, modifiedAt, bytes }) => ({ path, kind, modifiedAt, bytes }));
const preflightPassed = missingBlobs.length === 0 && staleBlobs.length === 0;
log('blob-preflight', {
  expected: expectedBlobs.length,
  functionalExpected: shardTotal,
  isolatedPerformanceExpected: 1,
  fresh: blobPreflight.present.length,
  missing: missingBlobs,
  stale: staleBlobs,
  runStartedAt: shardedRunStartedAt,
  passed: preflightPassed,
});

const stages = [];
const playwright = join(repositoryRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
const tsx = join(repositoryRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

if (preflightPassed) {
  stages.push(await runStage(
    'merge-reports',
    playwright,
    ['merge-reports', '--config=playwright.merge.config.ts', blobDirectory],
  ));
} else {
  stages.push(skippedFailure(
    'merge-reports',
    `Blob preflight rejected ${missingBlobs.length} missing and ${staleBlobs.length} stale report(s).`,
  ));
}

const mergeStage = stages.find(({ name }) => name === 'merge-reports');
const resultsAreFresh = await isFreshFile(join(artifactRoot, 'results.json'), startedAt);
if (resultsAreFresh) {
  stages.push(await runStage(
    'process-media',
    tsx,
    ['scripts/process-videos.ts', '--run-dir', artifactRoot],
  ));
  stages.push(await runStage(
    'rebuild-checklist',
    tsx,
    ['scripts/rebuild-report.ts', join(artifactRoot, 'results.json'), join(artifactRoot, 'checklist')],
  ));
} else {
  stages.push(skippedFailure('process-media', 'Fresh merged structured results are unavailable.'));
  stages.push(skippedFailure('rebuild-checklist', 'Fresh merged structured results are unavailable.'));
}

const mediaStage = stages.find(({ name }) => name === 'process-media');
const rebuildStage = stages.find(({ name }) => name === 'rebuild-checklist');
const checklistIsFresh = await isFreshFile(join(artifactRoot, 'checklist', 'manifest.json'), startedAt);
const pipelineFailures = [];
if (missingBlobs.length > 0) pipelineFailures.push(`${missingBlobs.length} required blob report(s) are missing`);
if (staleBlobs.length > 0) pipelineFailures.push(`${staleBlobs.length} required blob report(s) are stale`);
if (!resultsAreFresh) pipelineFailures.push('report merge did not produce fresh structured results');
if (mediaStage.exitCode !== 0) pipelineFailures.push('media processing failed');
if (rebuildStage.exitCode !== 0) pipelineFailures.push('checklist rebuild failed');
if (rebuildStage.exitCode === 0 && !checklistIsFresh) {
  pipelineFailures.push('checklist rebuild did not produce a fresh authoritative manifest');
}

let release;
if (pipelineFailures.length === 0) {
  try {
    release = await readChecklistRelease(join(artifactRoot, 'checklist', 'manifest.json'));
  } catch (error) {
    pipelineFailures.push(error.message);
  }
}
const pipelineStatus = pipelineFailures.length === 0 ? 'completed' : 'failed';
release ??= unavailableRelease(`No authoritative release decision is usable because ${pipelineFailures.join('; ') || 'the merge pipeline failed'}.`);
const outcome = releaseOutcome(pipelineStatus, release);
const lifecycle = {
  schemaVersion: 2,
  startedAt,
  finishedAt: new Date().toISOString(),
  shardTotal,
  shardedRunStartedAt,
  artifactRoot,
  expectedBlobs,
  missingBlobs,
  staleBlobs,
  blobPreflight: {
    passed: preflightPassed,
    functionalExpected: shardTotal,
    isolatedPerformanceExpected: 1,
    fresh: blobPreflight.present,
  },
  stages,
  browserTestFailuresObserved: mergeStage.exitCode !== 0 && resultsAreFresh,
  pipeline: {
    status: pipelineStatus,
    completed: pipelineStatus === 'completed',
    reason: pipelineFailures.length > 0
      ? pipelineFailures.join('; ')
      : 'All functional shard evidence and isolated performance evidence were fresh, merged, processed, and rebuilt into one checklist.',
    finishedAt: new Date().toISOString(),
  },
  release,
  status: outcome.status,
};
await atomicWriteJson(lifecyclePath, lifecycle);
log('merge-pipeline-finished', {
  status: lifecycle.status,
  pipelineStatus: lifecycle.pipeline.status,
  releaseDecision: lifecycle.release.decision,
  releaseReason: lifecycle.release.reason,
  lifecyclePath,
  stageResults: stages.map(({ name, exitCode, durationMs }) => ({ name, exitCode, durationMs })),
});
if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;

async function runStage(name, executable, args) {
  const command = [displayName(executable), ...args];
  const stageStartedAt = new Date().toISOString();
  log('command-started', { stage: name, command });
  const started = performance.now();
  const result = await run(executable, args, name);
  const stage = {
    name,
    command,
    startedAt: stageStartedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    exitCode: result.exitCode ?? 1,
    signal: result.signal,
  };
  log('command-finished', stage);
  return stage;
}

function run(executable, args, stage) {
  return new Promise((resolveRun) => {
    let settled = false;
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        AUDIT_PROFILE: 'release',
        AUDIT_ARTIFACT_DIR: artifactRoot,
        AUDIT_OUTPUT_DIR: join(artifactRoot, 'checklist'),
        PLAYWRIGHT_HTML_OPEN: 'never',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    relay(child.stdout, stage, 'stdout');
    relay(child.stderr, stage, 'stderr');
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      log('spawn-error', { stage, message: error.message });
      resolveRun({ exitCode: 127, signal: null });
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolveRun({ exitCode, signal });
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  });
}

function relay(stream, stage, channel) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`${new Date().toISOString()} [MERGE][${stage}][${channel}] ${line}\n`);
  });
  stream.on('end', () => {
    if (buffer) process.stdout.write(`${new Date().toISOString()} [MERGE][${stage}][${channel}] ${buffer}\n`);
  });
}

function skippedFailure(name, error) {
  const now = new Date().toISOString();
  log('stage-skipped', { stage: name, error });
  return {
    name,
    command: [],
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    exitCode: 1,
    signal: null,
    error,
  };
}

function log(event, detail) {
  process.stdout.write(`${new Date().toISOString()} [MERGE] ${event} ${JSON.stringify(detail)}\n`);
}

function displayName(executable) {
  return executable.endsWith('playwright') || executable.endsWith('playwright.cmd') ? 'playwright' : 'tsx';
}

function integerEnvironment(name, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function timestampEnvironment(name) {
  const value = process.env[name];
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid ISO timestamp.`);
  }
  return value;
}

function containedArtifactPath(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  const artifactBase = resolve('/work/artifacts');
  const resolved = resolve(value);
  if (resolved !== artifactBase && !resolved.startsWith(`${artifactBase}${sep}`)) {
    throw new Error(`${name} must remain beneath /work/artifacts.`);
  }
  return resolved;
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
