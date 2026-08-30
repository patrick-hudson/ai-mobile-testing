import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST } from '../shared/shared-docker-resilience-contract.mjs';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { deriveRunnerRevision, runnerRevisionDigest } from '../shared/runner-revision.mjs';
import { SHARED_RESILIENCE_CRASH_BOUNDARIES } from './lib/shared-resilience-failpoint.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const WORK_ITEM_ID = /^proof-\d{3}$/u;
const AUTHORITATIVE_NANO_CPUS = 1_000_000_000;
const AUTHORITATIVE_MEMORY_BYTES = 2_147_483_648;
const CRASH_BOUNDARY_SERVICE = Object.freeze({
  'inventory-seal': 'shared-coordinator',
  'work-item-adoption': 'shared-coordinator',
  'oracle-seal': 'shared-coordinator',
  'envelope-fsync': 'shared-coordinator',
  'head-swap': 'shared-coordinator',
  'mutation-acceptance': 'portal',
});
const CRASH_RECEIPT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'boundary', 'service', 'signal', 'injectedAt',
  'restartCountBefore', 'restartCountAfter', 'recoveryMs', 'recoveryBoundMs',
  'expectedStateDigest', 'recoveredStateDigest', 'staleFenceOutcome',
  'operationOutcome', 'duplicateEvidenceCount', 'digest',
].sort());

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
  assert.equal(report?.resources?.performanceWorkerCpuLimit, '2.0');
  assert.equal(report?.resources?.performanceWorkerMemoryLimit, '4g');
  assert.equal(report?.resources?.performanceWorkerPrincipal, 'performance');
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
  assert.equal(report.measurements.recoveryLineages?.length, 6);
  const recoveryCells = new Set();
  let productFailureOperationalRecoveries = 0;
  for (const entry of report.measurements.recoveryLineages) {
    assert(['one', 'many'].includes(entry?.label));
    assert(Number.isSafeInteger(entry?.sequence) && entry.sequence >= 1 && entry.sequence <= 3);
    assert.equal(entry?.workerCount, entry.label === 'one' ? 1 : 2);
    const cell = `${entry.label}:${entry.sequence}`;
    assert(!recoveryCells.has(cell), `duplicate recovery-lineage observation ${cell}`);
    recoveryCells.add(cell);
    assert(Array.isArray(entry.workItems) && entry.workItems.length <= 8);
    const workItemIds = new Set();
    for (const workItem of entry.workItems) {
      assert.match(workItem?.id ?? '', WORK_ITEM_ID);
      assert(!workItemIds.has(workItem.id), `duplicate recovery lineage for ${workItem.id} in ${cell}`);
      workItemIds.add(workItem.id);
      assert(Array.isArray(workItem.attempts) && workItem.attempts.length >= 2 && workItem.attempts.length <= 3);
      assert.deepEqual(workItem.attempts.map(({ attempt }) => attempt),
        Array.from({ length: workItem.attempts.length }, (_, index) => index + 1));
      assert(workItem.attempts.slice(0, -1).every(({ outcome }) => outcome === 'operational_failure'),
        `${workItem.id} may retain only pre-terminal operational recovery attempts`);
      assert(['completed_pass', 'completed_product_failure'].includes(workItem.attempts.at(-1)?.outcome),
        `${workItem.id} must end in one terminal product outcome`);
      assert.equal(workItem.attempts.filter(({ outcome }) => (
        outcome === 'completed_pass' || outcome === 'completed_product_failure'
      )).length, 1, `${workItem.id} must not retry a completed product outcome`);
      if (workItem.id === 'proof-008') productFailureOperationalRecoveries += workItem.attempts.length - 1;
    }
  }
  assert.deepEqual([...recoveryCells].sort(), [
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
  assert(Number.isSafeInteger(report.invariants.productFailureOperationalRecoveries)
    && report.invariants.productFailureOperationalRecoveries >= 0
    && report.invariants.productFailureOperationalRecoveries <= 12);
  assert.equal(report.invariants.productFailureOperationalRecoveries, productFailureOperationalRecoveries);
  assert.deepEqual(report.invariants.performanceIsolation, {
    workItemId: 'proof-003',
    workerId: 'compose-worker-performance',
    workerService: 'shared-worker-performance',
    capability: 'performance:lighthouse',
    resourceClass: 'performance',
    runningOrdinaryAtExclusiveBoundary: 0,
    attempts: 1,
    outcome: 'completed_pass',
    invariantDigest: report.invariants.performanceIsolation?.invariantDigest,
    utilization: report.invariants.performanceIsolation?.utilization,
  });
  assert.match(report.invariants.performanceIsolation.invariantDigest ?? '', DIGEST);
  assert.equal(report.invariants.performanceIsolation.utilization?.length, 1);
  const performanceSample = report.invariants.performanceIsolation.utilization[0];
  assert(typeof performanceSample?.container === 'string'
    && performanceSample.container.endsWith('-shared-worker-performance-1'));
  finite(performanceSample.cpuPercent, 'performance cpuPercent');
  finite(performanceSample.memoryPercent, 'performance memoryPercent');
  assert(typeof performanceSample.memoryUsage === 'string' && performanceSample.memoryUsage.length > 0);
  assert(Number.isSafeInteger(performanceSample.pids) && performanceSample.pids >= 0);
  assert.equal(performanceSample.nanoCpus, 2_000_000_000);
  assert.equal(performanceSample.memoryBytes, 4_294_967_296);

  assert.equal(report?.crashBoundaries?.length, SHARED_RESILIENCE_CRASH_BOUNDARIES.length,
    'the authoritative proof must contain all six named crash-boundary receipts');
  assert.deepEqual(report.crashBoundaries.map(({ boundary }) => boundary), SHARED_RESILIENCE_CRASH_BOUNDARIES,
    'crash-boundary receipts must be complete, unique, and in canonical order');
  for (const receipt of report.crashBoundaries) {
    assert.deepEqual(Object.keys(receipt ?? {}).sort(), CRASH_RECEIPT_KEYS,
      `the ${receipt?.boundary ?? 'unknown'} crash receipt has an unexpected shape`);
    const { digest, ...body } = receipt;
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.kind, 'shared-docker-crash-boundary-receipt');
    assert.equal(receipt.service, CRASH_BOUNDARY_SERVICE[receipt.boundary]);
    assert.equal(receipt.signal, 'SIGKILL');
    const injectedAtMs = Date.parse(receipt.injectedAt);
    assert(Number.isFinite(injectedAtMs));
    assert.equal(new Date(injectedAtMs).toISOString(), receipt.injectedAt);
    assert(Number.isSafeInteger(receipt.restartCountBefore) && receipt.restartCountBefore >= 0);
    assert(Number.isSafeInteger(receipt.restartCountAfter)
      && receipt.restartCountAfter > receipt.restartCountBefore,
    `${receipt.boundary} must prove that its killed container restarted`);
    assert(Number.isSafeInteger(receipt.recoveryBoundMs)
      && receipt.recoveryBoundMs >= 1_000 && receipt.recoveryBoundMs <= 300_000);
    assert(Number.isFinite(receipt.recoveryMs)
      && receipt.recoveryMs >= 0 && receipt.recoveryMs <= receipt.recoveryBoundMs,
    `${receipt.boundary} exceeded its registered recovery bound`);
    assert.match(receipt.expectedStateDigest ?? '', DIGEST);
    assert.equal(receipt.recoveredStateDigest, receipt.expectedStateDigest,
      `${receipt.boundary} recovered the wrong canonical state`);
    assert.equal(receipt.staleFenceOutcome,
      receipt.boundary === 'mutation-acceptance' ? 'not-applicable' : 'rejected');
    assert.equal(receipt.operationOutcome,
      receipt.boundary === 'mutation-acceptance' ? 'persisted-terminal' : 'not-applicable');
    assert.equal(receipt.duplicateEvidenceCount, 0);
    assert.equal(digest, canonicalDigest(body), `${receipt.boundary} receipt digest is invalid`);
  }
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
