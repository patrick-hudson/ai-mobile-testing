import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST } from '../shared/shared-docker-resilience-contract.mjs';
import { deriveRunnerRevision, runnerRevisionDigest } from '../shared/runner-revision.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const WORK_ITEM_ID = /^proof-\d{3}$/u;
const AUTHORITATIVE_NANO_CPUS = 1_000_000_000;
const AUTHORITATIVE_MEMORY_BYTES = 2_147_483_648;

function finite(value, label, { positive = false } = {}) {
  assert(Number.isFinite(value) && (positive ? value > 0 : value >= 0),
    `${label} must be finite and ${positive ? 'positive' : 'non-negative'}.`);
}
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const variance = (values) => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
};

export function validateSharedDockerResilienceProof(report, { expectedWorkspaceRevision = null } = {}) {
  assert.equal(report?.schemaVersion, 1);
  assert.equal(report?.kind, 'shared-docker-resilience-proof');
  assert.equal(report?.authority, 'AUTHORITATIVE');
  assert.equal(report?.buildPolicy, 'compose-build-invoked');
  const generatedAtMs = Date.parse(report?.generatedAt);
  assert(Number.isFinite(generatedAtMs), 'the proof must record a canonical generation timestamp');
  assert.equal(new Date(generatedAtMs).toISOString(), report.generatedAt);
  assert.match(report?.source?.workspaceRevision ?? '', /^workspace:sha256:[a-f0-9]{64}$/u);
  assert.match(report?.source?.imageRevision ?? '', /^image:sha256:[a-f0-9]{64}$/u);
  assert.match(report?.source?.imageId ?? '', DIGEST);
  assert.equal(runnerRevisionDigest(report.source.workspaceRevision), runnerRevisionDigest(report.source.imageRevision),
    'the proof image must match the recorded workspace runner revision');
  if (expectedWorkspaceRevision !== null) {
    assert.equal(report.source.workspaceRevision, expectedWorkspaceRevision,
      'the authoritative proof is stale for the current runner source');
  }
  assert.equal(report?.workload?.digest, SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST);
  assert.equal(report?.workload?.workItemCount, 8);
  assert.equal(report?.workload?.trials, 3);
  assert.equal(report?.workload?.warmedTrials, true);
  assert.equal(report?.resources?.ordinaryWorkerCpuLimit, '1.0');
  assert.equal(report?.resources?.ordinaryWorkerMemoryLimit, '2g');
  assert.equal(report?.resources?.browserConcurrencyPerWorker, 1);
  assert.deepEqual(report?.resources?.oneWorkerPrincipals, ['ordinary-a']);
  assert.deepEqual(report?.resources?.manyWorkerPrincipals, ['ordinary-a', 'ordinary-b']);
  assert.equal(report?.measurements?.oneWorkerMs?.length, 3);
  assert.equal(report?.measurements?.manyWorkerMs?.length, 3);
  for (const [label, values] of [
    ['oneWorkerMs', report.measurements.oneWorkerMs],
    ['manyWorkerMs', report.measurements.manyWorkerMs],
  ]) for (const value of values) finite(value, label, { positive: true });
  finite(report.measurements.oneWorkerMedianMs, 'oneWorkerMedianMs', { positive: true });
  finite(report.measurements.manyWorkerMedianMs, 'manyWorkerMedianMs', { positive: true });
  finite(report.measurements.oneWorkerVarianceMs2, 'oneWorkerVarianceMs2');
  finite(report.measurements.manyWorkerVarianceMs2, 'manyWorkerVarianceMs2');
  finite(report.measurements.throughputImprovement, 'throughputImprovement', { positive: true });
  assert.equal(report.measurements.oneWorkerMedianMs, median(report.measurements.oneWorkerMs));
  assert.equal(report.measurements.manyWorkerMedianMs, median(report.measurements.manyWorkerMs));
  assert.equal(report.measurements.oneWorkerVarianceMs2, variance(report.measurements.oneWorkerMs));
  assert.equal(report.measurements.manyWorkerVarianceMs2, variance(report.measurements.manyWorkerMs));
  assert.equal(report.measurements.throughputImprovement,
    report.measurements.oneWorkerMedianMs / report.measurements.manyWorkerMedianMs);
  assert(report.measurements.manyWorkerMedianMs < report.measurements.oneWorkerMedianMs,
    'the two-worker median must be faster than the one-worker median');
  assert(report.measurements.throughputImprovement > 1,
    'the authoritative topology must record a throughput improvement');

  assert.equal(report.measurements.utilization?.length, 6);
  const topologyCells = new Set();
  for (const entry of report.measurements.utilization) {
    assert(['one', 'many'].includes(entry?.label));
    assert(Number.isSafeInteger(entry?.sequence) && entry.sequence >= 1 && entry.sequence <= 3);
    assert([1, 2].includes(entry?.workerCount));
    assert.equal(entry.workerCount, entry.label === 'one' ? 1 : 2);
    const cell = `${entry.label}:${entry.sequence}`;
    assert(!topologyCells.has(cell), `duplicate topology observation ${cell}`);
    topologyCells.add(cell);
    assert.equal(entry?.samples?.length, entry.workerCount);
    const expectedServices = entry.label === 'one'
      ? ['shared-worker-ordinary-a-1']
      : ['shared-worker-ordinary-a-1', 'shared-worker-ordinary-b-1'];
    assert.deepEqual(entry.samples.map(({ container }) => expectedServices.find((service) => container.endsWith(service))).sort(),
      [...expectedServices].sort());
    for (const sample of entry.samples) {
      assert(typeof sample?.container === 'string' && sample.container.length > 0 && sample.container.length <= 256);
      finite(sample.cpuPercent, 'cpuPercent');
      finite(sample.memoryPercent, 'memoryPercent');
      assert(typeof sample.memoryUsage === 'string' && sample.memoryUsage.length > 0 && sample.memoryUsage.length <= 128);
      assert(Number.isSafeInteger(sample.pids) && sample.pids >= 0);
      assert.equal(sample.nanoCpus, AUTHORITATIVE_NANO_CPUS,
        'every measured worker must enforce exactly one CPU');
      assert.equal(sample.memoryBytes, AUTHORITATIVE_MEMORY_BYTES,
        'every measured worker must enforce exactly 2 GiB of memory');
    }
  }
  assert.deepEqual([...topologyCells].sort(), [
    'many:1', 'many:2', 'many:3', 'one:1', 'one:2', 'one:3',
  ]);

  for (const value of [
    report?.invariants?.digest,
    report?.invariants?.transitionDigest,
    report?.invariants?.workerKillDigest,
    report?.invariants?.coordinatorKillDigest,
  ]) assert.match(value ?? '', DIGEST);
  assert.equal(report.invariants.digest, report.invariants.transitionDigest);
  assert.equal(report.invariants.digest, report.invariants.workerKillDigest);
  assert.equal(report.invariants.digest, report.invariants.coordinatorKillDigest);
  assert.match(report.invariants.workerKillRecoveredWorkItem ?? '', WORK_ITEM_ID);
  assert.match(report.invariants.coordinatorKillRecoveredWorkItem ?? '', WORK_ITEM_ID);
  assert.equal(report.invariants.productFailureAttempts, 1);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const evidencePath = process.argv[2] ?? path.join(
    repositoryRoot, 'artifacts', 'self-tests', 'shared-docker-resilience-proof.json',
  );
  validateSharedDockerResilienceProof(JSON.parse(await readFile(evidencePath, 'utf8')), {
    expectedWorkspaceRevision: await deriveRunnerRevision(repositoryRoot),
  });
  process.stdout.write(`Authoritative shared Docker resilience proof is valid: ${evidencePath}\n`);
}
