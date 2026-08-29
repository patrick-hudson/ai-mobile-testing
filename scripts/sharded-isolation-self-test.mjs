import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFreshShardedRunDirectory,
  expectedShardedBlobs,
  inspectShardedBlobs,
  PERFORMANCE_BLOB_FILENAME,
  validatedShardedRunId,
} from './lib/sharded-evidence.mjs';
import { commandIntegrityFailures, pipelineDiagnosticsDocument } from './lib/pipeline-diagnostics.mjs';
import {
  DEFAULT_RELEASE_SHARD_CONCURRENCY,
  DEFAULT_RELEASE_SHARD_TOTAL,
  DEFAULT_RELEASE_SHARD_WORKERS,
} from './lib/sharded-defaults.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = await fs.mkdtemp(join(tmpdir(), 'audit-sharded-isolation-'));
try {
  await assertReleaseDefaults(repositoryRoot);
  assertPipelineDiagnosticClassification();
  const blobDirectory = join(temporaryRoot, 'blob-reports');
  await fs.mkdir(blobDirectory, { recursive: true });
  const expected = expectedShardedBlobs(blobDirectory, 2);
  assert.deepEqual(expected.map(({ kind }) => kind), [
    'functional-shard',
    'functional-shard',
    'isolated-performance',
  ]);
  assert.equal(expected.at(-1)?.path, join(blobDirectory, PERFORMANCE_BLOB_FILENAME));

  const runStartedAt = new Date().toISOString();
  await fs.writeFile(expected[0].path, 'fresh-functional');
  await fs.writeFile(expected[2].path, 'stale-performance');
  const staleTime = new Date(Date.parse(runStartedAt) - 60_000);
  await fs.utimes(expected[2].path, staleTime, staleTime);

  const failedPreflight = await inspectShardedBlobs(expected, runStartedAt);
  assert.deepEqual(failedPreflight.present.map(({ path }) => path), [expected[0].path]);
  assert.deepEqual(failedPreflight.missing.map(({ path }) => path), [expected[1].path]);
  assert.deepEqual(failedPreflight.stale.map(({ path }) => path), [expected[2].path]);

  await fs.writeFile(expected[1].path, 'fresh-functional-two');
  await fs.writeFile(expected[2].path, 'fresh-performance');
  const passedPreflight = await inspectShardedBlobs(expected, runStartedAt);
  assert.equal(passedPreflight.present.length, 3);
  assert.equal(passedPreflight.missing.length, 0);
  assert.equal(passedPreflight.stale.length, 0);

  for (const accepted of [
    'release1',
    'release-candidate-2026-08-24',
    `a${'b'.repeat(79)}`,
  ]) {
    assert.equal(validatedShardedRunId(accepted), accepted);
  }
  for (const rejected of [
    'release',
    '-release1',
    'Release1',
    'release_1',
    `a${'b'.repeat(80)}`,
  ]) {
    assert.throws(
      () => validatedShardedRunId(rejected),
      /must be 8–80 lowercase letters, numbers, and hyphens/,
    );
  }

  const shardedRoot = join(temporaryRoot, 'sharded-runs');
  const existingRunId = 'existing-run';
  const existingRun = join(shardedRoot, existingRunId);
  await fs.mkdir(existingRun, { recursive: true });
  const priorFiles = {
    'manual-evidence.json': '{"priorManualApproval":true}\n',
    'sharded-run.json': '{"status":"ready"}\n',
    'logs/coordinator.log': 'prior coordinator output\n',
  };
  await fs.mkdir(join(existingRun, 'logs'));
  await Promise.all(Object.entries(priorFiles).map(([relativePath, content]) =>
    fs.writeFile(join(existingRun, relativePath), content)));
  const entriesBefore = (await fs.readdir(existingRun, { recursive: true })).sort();

  await assert.rejects(
    createFreshShardedRunDirectory(shardedRoot, existingRunId),
    (error) => error?.code === 'AUDIT_SHARDED_RUN_EXISTS'
      && /Existing evidence was not modified/.test(error.message),
  );
  assert.deepEqual((await fs.readdir(existingRun, { recursive: true })).sort(), entriesBefore);
  for (const [relativePath, content] of Object.entries(priorFiles)) {
    assert.equal(await fs.readFile(join(existingRun, relativePath), 'utf8'), content);
  }

  const freshRunId = 'fresh-run-01';
  const freshRun = await createFreshShardedRunDirectory(shardedRoot, freshRunId);
  assert.equal(freshRun, join(shardedRoot, freshRunId));
  assert.deepEqual(await fs.readdir(freshRun), []);

  await assertShardedCoordinatorStopsAndTimesOut(temporaryRoot);

  process.stdout.write('Sharded isolation self-test passed: 8x1 partitions use a bounded four-container pool, diagnostic exit codes stay non-authoritative, process termination fails integrity, dedicated evidence is required, stale blobs are rejected, run IDs are portal-compatible, existing evidence is never reused, cancellation skips queued and later stages, and command deadlines fail closed.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

async function assertShardedCoordinatorStopsAndTimesOut(temporaryRoot) {
  const fakeBin = join(temporaryRoot, 'fake-bin');
  const fakeDocker = join(fakeBin, 'docker');
  const invocations = join(temporaryRoot, 'docker-invocations.log');
  const isolatedShardedRoot = join(temporaryRoot, 'sharded-artifacts');
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(fakeDocker, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_INVOCATIONS"
case " $* " in
  *" build "*)
    if [ "$FAKE_DOCKER_BUILD_FAST" = "1" ]; then exit 0; fi
    ;;
esac
trap 'exit 143' INT TERM
sleep 30 &
wait $!
`, { mode: 0o700 });

  const commonEnvironment = {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    FAKE_DOCKER_INVOCATIONS: invocations,
    AUDIT_SHARD_TOTAL: '2',
    AUDIT_SHARD_CONCURRENCY: '1',
    AUDIT_SHARDED_HEARTBEAT_MS: '1000',
    AUDIT_SHARDED_LEASE_MS: '10000',
    AUDIT_COMMAND_STOP_GRACE_MS: '1000',
    AUDIT_SHARDED_HOST_ROOT: isolatedShardedRoot,
    AUDIT_SHARDED_CONTAINER_ROOT: '/work/isolated-sharded-artifacts',
  };

  const cancelledId = `cancel-test-${process.pid}`;
  const cancelled = spawn(process.execPath, ['scripts/run-sharded-release.mjs'], {
    cwd: repositoryRoot,
    env: { ...commonEnvironment, AUDIT_SHARDED_RUN_ID: cancelledId, FAKE_DOCKER_BUILD_FAST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let cancelledOutput = '';
  cancelled.stdout.on('data', (chunk) => { cancelledOutput += chunk.toString(); });
  cancelled.stderr.on('data', (chunk) => { cancelledOutput += chunk.toString(); });
  await waitForFileMatch(invocations, /run --rm.*audit-release-shard/, 10_000);
  cancelled.kill('SIGTERM');
  await Promise.race([
    once(cancelled, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Cancelled coordinator did not exit: ${cancelledOutput.slice(-2_000)}`)), 10_000)),
  ]);
  const cancelledLifecycle = JSON.parse(await fs.readFile(
    join(isolatedShardedRoot, cancelledId, 'sharded-run.json'),
    'utf8',
  ));
  assert.equal(cancelledLifecycle.status, 'stopped');
  assert.equal(cancelledLifecycle.pipeline.status, 'stopped');
  assert.equal(cancelledLifecycle.pipeline.completed, false);
  assert.equal(cancelledLifecycle.shardWorkers, DEFAULT_RELEASE_SHARD_WORKERS);
  assert.equal(cancelledLifecycle.shardConcurrency, 1);
  assert.equal(cancelledLifecycle.shards.length, 2);
  assert.equal(cancelledLifecycle.shards.filter(({ command }) => command.length > 0).length, 1);
  assert.equal(cancelledLifecycle.shards.filter(({ command }) => command.length === 0).length, 1);
  const cancelledDiagnostics = JSON.parse(await fs.readFile(
    join(isolatedShardedRoot, cancelledId, 'pipeline-diagnostics.json'),
    'utf8',
  ));
  assert.equal(cancelledDiagnostics.source, 'coordinator');
  assert.equal(cancelledDiagnostics.authority.diagnosticCountsAuthoritative, false);
  assert.ok(cancelledDiagnostics.failures.length >= 1);
  const cancelledInvocations = await fs.readFile(invocations, 'utf8');
  assert.doesNotMatch(cancelledInvocations, /run --rm.*(?:audit-release-performance|audit-release-merge)/);

  await fs.writeFile(invocations, '');
  const timeoutId = `timeout-test-${process.pid}`;
  const timed = spawn(process.execPath, ['scripts/run-sharded-release.mjs'], {
    cwd: repositoryRoot,
    env: {
      ...commonEnvironment,
      AUDIT_SHARDED_RUN_ID: timeoutId,
      AUDIT_BUILD_DEADLINE_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let timeoutOutput = '';
  timed.stdout.on('data', (chunk) => { timeoutOutput += chunk.toString(); });
  timed.stderr.on('data', (chunk) => { timeoutOutput += chunk.toString(); });
  await Promise.race([
    once(timed, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed coordinator did not exit: ${timeoutOutput.slice(-2_000)}`)), 10_000)),
  ]);
  const timeoutLifecycle = JSON.parse(await fs.readFile(
    join(isolatedShardedRoot, timeoutId, 'sharded-run.json'),
    'utf8',
  ));
  assert.equal(timeoutLifecycle.pipeline.status, 'failed');
  assert.match(timeoutLifecycle.build.error, /deadline/i);
  assert.equal(timeoutLifecycle.performance.command.length, 0);
  assert.equal(timeoutLifecycle.merge.command.length, 0);

  await fs.rm(join(isolatedShardedRoot, cancelledId), { recursive: true, force: true });
  await fs.rm(join(isolatedShardedRoot, timeoutId), { recursive: true, force: true });
}

async function assertReleaseDefaults(repositoryRoot) {
  assert.equal(DEFAULT_RELEASE_SHARD_TOTAL, 8);
  assert.equal(DEFAULT_RELEASE_SHARD_WORKERS, 1);
  assert.equal(DEFAULT_RELEASE_SHARD_CONCURRENCY, 4);
  const [compose, workflow, portal, documentation, readme] = await Promise.all([
    fs.readFile(join(repositoryRoot, 'docker-compose.yml'), 'utf8'),
    fs.readFile(join(repositoryRoot, '.github', 'workflows', 'release-audit.yml'), 'utf8'),
    fs.readFile(join(repositoryRoot, 'portal', 'server.mjs'), 'utf8'),
    fs.readFile(join(repositoryRoot, 'docs', 'DOCKER.md'), 'utf8'),
    fs.readFile(join(repositoryRoot, 'README.md'), 'utf8'),
  ]);
  assert.match(compose, /AUDIT_WORKERS: \$\{AUDIT_SHARD_WORKERS:-1\}/);
  assert.match(compose, /AUDIT_SHARD_TOTAL: \$\{AUDIT_SHARD_TOTAL:-8\}/);
  assert.match(workflow, /workers:[\s\S]{0,240}?default: '1'/);
  assert.match(workflow, /shards:[\s\S]{0,240}?default: '8'/);
  assert.match(workflow, /shard_concurrency:[\s\S]{0,240}?default: '4'/);
  assert.match(workflow, /AUDIT_SHARD_CONCURRENCY: \$\{\{ inputs\.shard_concurrency \}\}/);
  assert.match(portal, /releaseShardTotal: DEFAULT_RELEASE_SHARD_TOTAL/);
  assert.match(portal, /releaseShardWorkers: DEFAULT_RELEASE_SHARD_WORKERS/);
  assert.match(portal, /releaseShardConcurrency: DEFAULT_RELEASE_SHARD_CONCURRENCY/);
  assert.match(documentation, /default is eight functional shards with one Playwright worker/);
  assert.match(readme, /default to eight functional shards with one Playwright worker each/);
}

function assertPipelineDiagnosticClassification() {
  const base = {
    label: 'SHARD 1/8',
    command: ['docker', 'compose', 'run'],
    exitCode: 1,
    signal: null,
    error: null,
    logPath: 'logs/shard-1-of-8.log',
  };
  assert.deepEqual(commandIntegrityFailures([base]), [], 'ordinary Playwright exit 1 remains diagnostic');
  for (const result of [
    { ...base, error: 'SHARD 1/8 exceeded its deadline.' },
    { ...base, signal: 'SIGTERM' },
    { ...base, exitCode: 137 },
  ]) {
    assert.equal(commandIntegrityFailures([result]).length, 1);
  }
  const diagnostics = pipelineDiagnosticsDocument({
    runId: 'diagnostics-run',
    source: 'coordinator',
    failures: commandIntegrityFailures([{ ...base, signal: 'SIGTERM' }]),
  });
  assert.equal(diagnostics.authority.authoritativeReleaseSource, 'sharded-run.json');
  assert.equal(diagnostics.authority.diagnosticCountsAuthoritative, false);
}

async function waitForFileMatch(path, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await fs.readFile(path, 'utf8').catch(() => '');
    if (pattern.test(content)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${path}.`);
}
