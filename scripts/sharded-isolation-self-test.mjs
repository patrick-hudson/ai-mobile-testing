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

const temporaryRoot = await fs.mkdtemp(join(tmpdir(), 'audit-sharded-isolation-'));
try {
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

  process.stdout.write('Sharded isolation self-test passed: dedicated evidence is required, stale blobs are rejected, run IDs are portal-compatible, existing evidence is never reused, cancellation skips later stages, and command deadlines fail closed.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

async function assertShardedCoordinatorStopsAndTimesOut(temporaryRoot) {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
  const fakeBin = join(temporaryRoot, 'fake-bin');
  const fakeDocker = join(fakeBin, 'docker');
  const invocations = join(temporaryRoot, 'docker-invocations.log');
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
    AUDIT_SHARDED_HEARTBEAT_MS: '1000',
    AUDIT_SHARDED_LEASE_MS: '10000',
    AUDIT_COMMAND_STOP_GRACE_MS: '1000',
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
    join(repositoryRoot, 'artifacts', 'sharded', cancelledId, 'sharded-run.json'),
    'utf8',
  ));
  assert.equal(cancelledLifecycle.status, 'stopped');
  assert.equal(cancelledLifecycle.pipeline.status, 'stopped');
  assert.equal(cancelledLifecycle.pipeline.completed, false);
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
    join(repositoryRoot, 'artifacts', 'sharded', timeoutId, 'sharded-run.json'),
    'utf8',
  ));
  assert.equal(timeoutLifecycle.pipeline.status, 'failed');
  assert.match(timeoutLifecycle.build.error, /deadline/i);
  assert.equal(timeoutLifecycle.performance.command.length, 0);
  assert.equal(timeoutLifecycle.merge.command.length, 0);

  await fs.rm(join(repositoryRoot, 'artifacts', 'sharded', cancelledId), { recursive: true, force: true });
  await fs.rm(join(repositoryRoot, 'artifacts', 'sharded', timeoutId), { recursive: true, force: true });
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
