import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSharedDockerResilienceProof } from './assert-shared-docker-resilience-proof.mjs';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST } from '../shared/shared-docker-resilience-contract.mjs';
import { SHARED_RESILIENCE_CRASH_BOUNDARIES } from './lib/shared-resilience-failpoint.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const proofSource = await readFile(new URL('./shared-docker-resilience-self-test.mjs', import.meta.url), 'utf8');
assert.match(proofSource, /function duplicateTerminalEvidenceCount\(workItems\)/u);
assert.doesNotMatch(proofSource, /attempts\.length - 1/u,
  'operational recovery attempts are retained evidence, not duplicate terminal product evidence');
const sample = (container) => ({
  container, cpuPercent: 50, memoryPercent: 10, memoryUsage: '200MiB / 2GiB', pids: 30,
  nanoCpus: 1_000_000_000, memoryBytes: 2_147_483_648,
});
const boundaryReceipt = (boundary, index) => {
  const service = boundary === 'mutation-acceptance' ? 'portal' : 'shared-coordinator';
  const body = {
    schemaVersion: 1,
    kind: 'shared-docker-crash-boundary-receipt',
    boundary,
    service,
    signal: 'SIGKILL',
    injectedAt: `2026-08-29T23:30:0${index}.000Z`,
    restartCountBefore: index,
    restartCountAfter: index + 1,
    recoveryMs: 1_000 + index,
    recoveryBoundMs: 60_000,
    expectedStateDigest: digest(String(index + 1)),
    recoveredStateDigest: digest(String(index + 1)),
    staleFenceOutcome: boundary === 'mutation-acceptance' ? 'not-applicable' : 'rejected',
    operationOutcome: boundary === 'mutation-acceptance' ? 'persisted-terminal' : 'not-applicable',
    duplicateEvidenceCount: 0,
  };
  return { ...body, digest: canonicalDigest(body) };
};
const resealReceipt = (report, index) => {
  const { digest: _digest, ...body } = report.crashBoundaries[index];
  report.crashBoundaries[index] = { ...body, digest: canonicalDigest(body) };
};
const valid = {
  schemaVersion: 1,
  kind: 'shared-docker-resilience-proof',
  authority: 'AUTHORITATIVE',
  buildPolicy: 'compose-build-invoked',
  generatedAt: '2026-08-29T23:30:00.000Z',
  source: {
    workspaceRevision: `workspace:${digest('c')}`,
    imageRevision: `image:${digest('c')}`,
    imageId: digest('d'),
  },
  workload: { digest: SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST, workItemCount: 8, trials: 3, warmedTrials: true },
  resources: {
    ordinaryWorkerCpuLimit: '1.0', ordinaryWorkerMemoryLimit: '2g', browserConcurrencyPerWorker: 1,
    oneWorkerPrincipals: ['ordinary-a'], manyWorkerPrincipals: ['ordinary-a', 'ordinary-b'],
    performanceWorkerCpuLimit: '2.0', performanceWorkerMemoryLimit: '4g',
    performanceWorkerPrincipal: 'performance',
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
    recoveryLineages: Array.from({ length: 3 }, (_, index) => [
      { label: 'one', sequence: index + 1, workerCount: 1, workItems: [] },
      { label: 'many', sequence: index + 1, workerCount: 2, workItems: [] },
    ]).flat(),
  },
  invariants: {
    digest: digest('b'), transitionDigest: digest('b'), workerKillDigest: digest('b'), coordinatorKillDigest: digest('b'),
    workerKillRecoveredWorkItem: 'proof-002', coordinatorKillRecoveredWorkItem: 'proof-002', productFailureAttempts: 1,
    productFailureOperationalRecoveries: 0,
    performanceIsolation: {
      workItemId: 'proof-003', workerId: 'compose-worker-performance', workerService: 'shared-worker-performance',
      capability: 'performance:lighthouse', resourceClass: 'performance', runningOrdinaryAtExclusiveBoundary: 0,
      attempts: 1, outcome: 'completed_pass', invariantDigest: digest('9'),
      utilization: [{
        container: 'proof-performance-isolation-shared-worker-performance-1', cpuPercent: 75,
        memoryPercent: 15, memoryUsage: '600MiB / 4GiB', pids: 40,
        nanoCpus: 2_000_000_000, memoryBytes: 4_294_967_296,
      }],
    },
  },
  crashBoundaries: SHARED_RESILIENCE_CRASH_BOUNDARIES.map(boundaryReceipt),
};

const legacyReport = structuredClone(valid);
delete legacyReport.crashBoundaries;
assert.throws(() => validateSharedDockerResilienceProof(legacyReport),
  /six named crash-boundary receipts/,
  'a pre-boundary authoritative report must fail closed');

assert.equal(validateSharedDockerResilienceProof(valid, {
  expectedWorkspaceRevision: valid.source.workspaceRevision,
}), valid);
const rejected = [
  (report) => { report.generatedAt = 'not-a-timestamp'; },
  (report) => { report.source.workspaceRevision = `workspace:${digest('e')}`; },
  (report) => { report.source.imageRevision = `image:${digest('e')}`; },
  (report) => { report.source.imageId = 'local'; },
  (report) => { delete report.invariants.digest; },
  (report) => { report.workload.digest = digest('a'); },
  (report) => { report.invariants.workerKillDigest = digest('c'); },
  (report) => { report.measurements.manyWorkerMedianMs = 70; },
  (report) => { report.measurements.throughputImprovement = 0.9; },
  (report) => { report.measurements.oneWorkerMs[0] = 600; },
  (report) => { report.measurements.utilization[0].sequence = 2; },
  (report) => { report.measurements.utilization[0].workerCount = 2; },
  (report) => { report.measurements.recoveryLineages.pop(); },
  (report) => { report.measurements.recoveryLineages[0].workItems = [{ id: 'proof-008', attempts: [
    { attempt: 1, outcome: 'completed_product_failure', reason: 'assertion', artifactCount: 1 },
    { attempt: 2, outcome: 'completed_pass', reason: null, artifactCount: 1 },
  ] }]; },
  (report) => { report.invariants.productFailureOperationalRecoveries = 1; },
  (report) => { report.resources.manyWorkerPrincipals = ['ordinary-a']; },
  (report) => { report.resources.performanceWorkerCpuLimit = '1.0'; },
  (report) => { report.resources.performanceWorkerPrincipal = 'ordinary-a'; },
  (report) => { report.measurements.utilization[0].samples[0].cpuPercent = null; },
  (report) => { report.measurements.utilization[0].samples[0].memoryPercent = Number.NaN; },
  (report) => { report.measurements.utilization[0].samples[0].pids = -1; },
  (report) => { report.measurements.utilization[0].samples[0].nanoCpus = 2_000_000_000; },
  (report) => { report.measurements.utilization[0].samples[0].memoryBytes = 1_073_741_824; },
  (report) => { report.invariants.performanceIsolation.workerId = 'compose-worker-ordinary-a'; },
  (report) => { report.invariants.performanceIsolation.runningOrdinaryAtExclusiveBoundary = 1; },
  (report) => { report.invariants.performanceIsolation.attempts = 2; },
  (report) => { delete report.invariants.performanceIsolation.invariantDigest; },
  (report) => { report.invariants.performanceIsolation.utilization[0].container = 'proof-performance-isolation-shared-worker-performance'; },
  (report) => { report.invariants.performanceIsolation.utilization[0].nanoCpus = 1_000_000_000; },
  (report) => { report.crashBoundaries.pop(); },
  (report) => { report.crashBoundaries[0].boundary = 'generic-coordinator-kill'; resealReceipt(report, 0); },
  (report) => { report.crashBoundaries[0].restartCountAfter = report.crashBoundaries[0].restartCountBefore; resealReceipt(report, 0); },
  (report) => { report.crashBoundaries[0].recoveredStateDigest = digest('f'); resealReceipt(report, 0); },
  (report) => { report.crashBoundaries[0].duplicateEvidenceCount = 1; resealReceipt(report, 0); },
  (report) => { report.crashBoundaries.at(-1).operationOutcome = 'not-applicable'; resealReceipt(report, report.crashBoundaries.length - 1); },
  (report) => { report.crashBoundaries[0].digest = digest('f'); },
  (report) => { report.authority = 'DIAGNOSTIC'; },
];
for (const mutate of rejected) {
  const report = structuredClone(valid);
  mutate(report);
  assert.throws(() => validateSharedDockerResilienceProof(report));
}
assert.throws(() => validateSharedDockerResilienceProof(valid, {
  expectedWorkspaceRevision: `workspace:${digest('f')}`,
}), /stale for the current runner source/);

process.stdout.write('Shared Docker resilience proof validator self-test passed.\n');
