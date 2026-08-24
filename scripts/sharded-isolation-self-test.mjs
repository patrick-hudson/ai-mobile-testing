import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  process.stdout.write('Sharded isolation self-test passed: dedicated evidence is required, stale blobs are rejected, run IDs are portal-compatible, and existing run evidence is never reused or mutated.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
