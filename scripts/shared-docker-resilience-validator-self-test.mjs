import assert from 'node:assert/strict';
import { validateSharedDockerResilienceProof } from './assert-shared-docker-resilience-proof.mjs';
import { SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST } from '../shared/shared-docker-resilience-contract.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const sample = (container) => ({
  container, cpuPercent: 50, memoryPercent: 10, memoryUsage: '200MiB / 2GiB', pids: 30,
  nanoCpus: 1_000_000_000, memoryBytes: 2_147_483_648,
});
const valid = {
  schemaVersion: 1,
  kind: 'shared-docker-resilience-proof',
  authority: 'AUTHORITATIVE',
  buildPolicy: 'compose-build-invoked',
  workload: { digest: SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST, workItemCount: 8, trials: 3, warmedTrials: true },
  resources: {
    ordinaryWorkerCpuLimit: '1.0', ordinaryWorkerMemoryLimit: '2g', browserConcurrencyPerWorker: 1,
    oneWorkerPrincipals: ['ordinary-a'], manyWorkerPrincipals: ['ordinary-a', 'ordinary-b'],
  },
  measurements: {
    oneWorkerMs: [60, 62, 61], manyWorkerMs: [40, 42, 41],
    oneWorkerMedianMs: 61, manyWorkerMedianMs: 41,
    oneWorkerVarianceMs2: 2 / 3, manyWorkerVarianceMs2: 2 / 3, throughputImprovement: 61 / 41,
    utilization: Array.from({ length: 3 }, (_, index) => [
      { label: 'one', sequence: index + 1, workerCount: 1,
        samples: [sample(`proof-one-${index}-shared-worker-ordinary-a-1`)] },
      { label: 'many', sequence: index + 1, workerCount: 2,
        samples: [sample(`proof-many-${index}-shared-worker-ordinary-a-1`), sample(`proof-many-${index}-shared-worker-ordinary-b-1`)] },
    ]).flat(),
  },
  invariants: {
    digest: digest('b'), transitionDigest: digest('b'), workerKillDigest: digest('b'), coordinatorKillDigest: digest('b'),
    workerKillRecoveredWorkItem: 'proof-002', coordinatorKillRecoveredWorkItem: 'proof-002', productFailureAttempts: 1,
  },
};

assert.equal(validateSharedDockerResilienceProof(valid), valid);
const rejected = [
  (report) => { delete report.invariants.digest; },
  (report) => { report.workload.digest = digest('a'); },
  (report) => { report.invariants.workerKillDigest = digest('c'); },
  (report) => { report.measurements.manyWorkerMedianMs = 70; },
  (report) => { report.measurements.throughputImprovement = 0.9; },
  (report) => { report.measurements.oneWorkerMs[0] = 600; },
  (report) => { report.measurements.utilization[0].sequence = 2; },
  (report) => { report.measurements.utilization[0].workerCount = 2; },
  (report) => { report.resources.manyWorkerPrincipals = ['ordinary-a']; },
  (report) => { report.measurements.utilization[0].samples[0].cpuPercent = null; },
  (report) => { report.measurements.utilization[0].samples[0].memoryPercent = Number.NaN; },
  (report) => { report.measurements.utilization[0].samples[0].pids = -1; },
  (report) => { report.measurements.utilization[0].samples[0].nanoCpus = 2_000_000_000; },
  (report) => { report.measurements.utilization[0].samples[0].memoryBytes = 1_073_741_824; },
  (report) => { report.authority = 'DIAGNOSTIC'; },
];
for (const mutate of rejected) {
  const report = structuredClone(valid);
  mutate(report);
  assert.throws(() => validateSharedDockerResilienceProof(report));
}

process.stdout.write('Shared Docker resilience proof validator self-test passed.\n');
