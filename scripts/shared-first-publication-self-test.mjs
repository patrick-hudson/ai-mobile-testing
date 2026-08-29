import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseRiskSourceObservationSet,
  sealCompileRiskInputs,
  sealRiskSourceObservationSet,
} from '../shared/risk-source-observation.mjs';
import { compileSharedLaunchPlan } from '../shared/launch-plan-compiler.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import { createSharedCoordinatorSupervisor } from './lib/shared-coordinator-supervisor.mjs';
import {
  adoptAttemptEvidence,
  createParentRun,
  openParentRunStore,
  publishAttemptEvidence,
  readCurrentEnvelope,
  readParentRun,
} from './lib/parent-run-store.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const observedAt = '2026-08-29T12:00:00.000Z';

function observationSet(overrides = {}) {
  return sealRiskSourceObservationSet({
    schemaVersion: 1,
    runId: 'run-contract',
    workItemId: 'work-contract',
    subjectCoreDigest: digest('a'),
    attempt: 1,
    workerId: 'worker-contract',
    producerStates: [
      { producer: 'visual', status: 'COMPLETE' },
      { producer: 'baseline', status: 'NOT_APPLICABLE' },
      { producer: 'evidence-pipeline', status: 'COMPLETE' },
    ],
    observations: [{
      producer: 'visual',
      category: 'unreviewed-visual-change',
      severity: 'high',
      source: { kind: 'visual-result', id: 'work-contract:hero-light' },
      explanation: 'The candidate hero differs from its compatible reference.',
      recommendedAction: 'Review the candidate, baseline, and diff evidence.',
      reviewState: 'PENDING_REVIEW',
      observedAt,
    }],
    ...overrides,
  });
}

const sealed = observationSet();
assert.deepEqual(parseRiskSourceObservationSet(sealed), sealed);
assert.equal(sealed.observations[0].releaseEffect, undefined,
  'workers publish immutable observations, never release effects or decisions');
assert.throws(() => observationSet({ producerStates: [
  { producer: 'baseline', status: 'NOT_APPLICABLE' },
  { producer: 'evidence-pipeline', status: 'COMPLETE' },
] }), /every canonical producer|missing/i);
assert.throws(() => observationSet({ observations: [
  sealed.observations[0], sealed.observations[0],
] }), /duplicate/i);
assert.throws(() => observationSet({ observations: [{
  ...sealed.observations[0], producer: 'baseline', source: { kind: 'baseline-result', id: 'work-contract:hero-light' },
  category: 'production-baseline-defect', reviewState: 'OPEN',
}] }), /not-applicable|undeclared/i);
assert.notEqual(observationSet({ subjectCoreDigest: digest('b') }).digest, sealed.digest,
  'wrong-subject content must produce a different canonical digest');

const compileInputs = sealCompileRiskInputs({
  schemaVersion: 1,
  subjectCoreDigest: digest('c'),
  manualObligations: [{
    id: 'manual-real-device',
    severity: 'medium',
    explanation: 'Real-device behavior still needs a human check.',
    recommendedAction: 'Complete the real-device checklist before launch.',
  }],
});
assert.equal(compileInputs.manualObligations.length, 1);

const [pluginRegistry, targetRegistry] = await Promise.all([
  readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8').then(JSON.parse),
]);

const root = await mkdtemp(path.join(tmpdir(), 'shared-first-publication-'));
let now = Date.parse(observedAt);
try {
  const store = await openParentRunStore({
    root,
    deploymentIdentity: 'shared-first-publication-test',
    volumeIdentity: 'named-volume:shared-first-publication-test',
    verifyStorage: false,
    clock: () => now,
  });
  const controlService = createSharedControlService({ store, projectId: 'project-first-publication' });
  const supervisor = createSharedCoordinatorSupervisor({
    store,
    controlService,
    projectId: 'project-first-publication',
    ownerId: 'coordinator-first-publication',
    pluginRegistry,
    targetRegistry,
  });
  const startupMaintenance = await supervisor.maintain();
  assert.deepEqual(startupMaintenance.errors, [], JSON.stringify(startupMaintenance.errors));

  const launch = compileSharedLaunchPlan({
    intent: { schemaVersion: 1, runContract: {
      schemaVersion: 1,
      mode: 'comparative',
      candidateUrl: 'https://candidate.example.test',
      productionUrl: 'https://production.example.test',
      targetIds: ['candidate-mobile-chromium', 'production-mobile-chromium'],
      scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['A11Y-001'], areas: [] },
    } },
    pluginRegistry,
    targetRegistry,
    runnerRevision: digest('1'),
    configurationRevision: digest('2'),
    environmentRevision: digest('3'),
    deploymentIdentity: { kind: 'target-preflight-set', value: digest('4') },
  });
  await createParentRun(store, { runId: 'run-first-comparative', ...launch.createParentRunInput });
  const worker = {
    id: 'worker-first-publication', kind: 'worker', roles: ['worker'],
    projectIds: ['project-first-publication'], runIds: ['*'],
    workerGrant: { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
  };
  const initial = await supervisor.maintain();
  assert.equal(initial.errors.length, 0);
  const beforeWork = await readCurrentEnvelope(store, 'run-first-comparative');
  assert.equal(beforeWork.decision.code, 'NOT_READY_INCOMPLETE_EXECUTION');
  assert.equal(beforeWork.riskRegister.availability, 'UNAVAILABLE');

  let firstWorkItem = true;
  while (true) {
    let lease;
    try { lease = await supervisor.claim(worker); } catch (error) {
      if (error?.code === 'NO_WORK_AVAILABLE') break;
      throw error;
    }
    const riskSourceObservationSet = sealRiskSourceObservationSet({
      schemaVersion: 1,
      runId: lease.runId,
      workItemId: lease.workItemId,
      subjectCoreDigest: lease.subjectCoreDigest,
      attempt: lease.attempt,
      workerId: worker.id,
      producerStates: [
        { producer: 'visual', status: firstWorkItem ? 'COMPLETE' : 'NOT_APPLICABLE' },
        { producer: 'baseline', status: firstWorkItem ? 'COMPLETE' : 'NOT_APPLICABLE' },
        { producer: 'evidence-pipeline', status: 'COMPLETE' },
      ],
      observations: firstWorkItem ? [{
        producer: 'visual', category: 'unreviewed-visual-change', severity: 'high',
        source: { kind: 'visual-result', id: `${lease.workItemId}:visual-change` },
        explanation: 'A compatible visual changed and awaits review.',
        recommendedAction: 'Review the visual evidence.', reviewState: 'PENDING_REVIEW', observedAt,
      }, {
        producer: 'baseline', category: 'production-baseline-defect', severity: 'medium',
        source: { kind: 'baseline-result', id: `${lease.workItemId}:production-context` },
        explanation: 'Production has an unchanged baseline defect.',
        recommendedAction: 'Track the production defect separately.', reviewState: 'OPEN', observedAt,
      }] : [],
    });
    firstWorkItem = false;
    const inbox = await publishAttemptEvidence(store, lease.runId, lease, {
      outcome: 'completed_pass', reason: null, artifacts: [], riskSourceObservationSet,
      executionDescriptorDigest: lease.executionDescriptorDigest,
    });
    await adoptAttemptEvidence(store, lease.runId, supervisor.coordinator(), inbox);
  }
  const adoptedState = await readParentRun(store, 'run-first-comparative');
  for (const item of Object.values(adoptedState.workItems)) {
    assert(item.attempts.some((attempt) => attempt.canonicalResultDigest === item.canonicalResult.digest
      && attempt.workerId === item.canonicalRiskSourceObservationSet.workerId), JSON.stringify(item));
  }
  const finalMaintenance = await supervisor.maintain();
  assert.deepEqual(finalMaintenance.errors, [], JSON.stringify(finalMaintenance.errors));
  const ready = await readCurrentEnvelope(store, 'run-first-comparative');
  const state = await readParentRun(store, 'run-first-comparative');
  assert.equal(ready.decision.code, 'FEATURE_READY', JSON.stringify(Object.fromEntries(
    Object.entries(state.workItems).map(([id, item]) => [id, item.state]),
  )));
  assert.equal(ready.riskRegister.availability, 'AVAILABLE');
  assert.deepEqual(ready.riskRegister.risks.map(({ category }) => category).sort(), [
    'production-baseline-defect', 'unreviewed-visual-change',
  ]);
  assert(Object.values(state.workItems).every(({ canonicalRiskSourceObservationSet }) => canonicalRiskSourceObservationSet?.digest));
  const digestBefore = ready.digest;
  await supervisor.maintain();
  assert.equal((await readCurrentEnvelope(store, 'run-first-comparative')).digest, digestBefore,
    'maintenance must be idempotent after the first publication and terminal work adoption');

  await createParentRun(store, { runId: 'run-failed-comparative', ...launch.createParentRunInput });
  let failFirstWorkItem = true;
  while (true) {
    let lease;
    try { lease = await supervisor.claim(worker); } catch (error) {
      if (error?.code === 'NO_WORK_AVAILABLE') break;
      throw error;
    }
    if (lease.runId !== 'run-failed-comparative') continue;
    const riskSourceObservationSet = sealRiskSourceObservationSet({
      schemaVersion: 1,
      runId: lease.runId,
      workItemId: lease.workItemId,
      subjectCoreDigest: lease.subjectCoreDigest,
      attempt: lease.attempt,
      workerId: worker.id,
      producerStates: [
        { producer: 'visual', status: 'NOT_APPLICABLE' },
        { producer: 'baseline', status: 'NOT_APPLICABLE' },
        { producer: 'evidence-pipeline', status: 'COMPLETE' },
      ],
      observations: [],
    });
    const shouldFail = failFirstWorkItem;
    if (shouldFail) {
      const wrongSubjectRiskSources = sealRiskSourceObservationSet({
        schemaVersion: 1,
        runId: lease.runId,
        workItemId: lease.workItemId,
        subjectCoreDigest: digest('f'),
        attempt: lease.attempt,
        workerId: worker.id,
        producerStates: riskSourceObservationSet.producerStates,
        observations: [],
      });
      await assert.rejects(publishAttemptEvidence(store, lease.runId, lease, {
        outcome: 'completed_pass', reason: null, artifacts: [],
        riskSourceObservationSet: wrongSubjectRiskSources,
        executionDescriptorDigest: lease.executionDescriptorDigest,
      }), (error) => error?.code === 'WORK_RESULT_BINDING_MISMATCH');
    }
    const inbox = await publishAttemptEvidence(store, lease.runId, lease, {
      outcome: shouldFail ? 'completed_product_failure' : 'completed_pass',
      reason: shouldFail ? 'assertion-failed' : null,
      artifacts: [],
      riskSourceObservationSet,
      executionDescriptorDigest: lease.executionDescriptorDigest,
    });
    failFirstWorkItem = false;
    await adoptAttemptEvidence(store, lease.runId, supervisor.coordinator(), inbox);
    if (shouldFail) {
      await assert.rejects(publishAttemptEvidence(store, lease.runId, lease, {
        outcome: 'completed_pass', reason: null, artifacts: [], riskSourceObservationSet,
        executionDescriptorDigest: lease.executionDescriptorDigest,
      }), (error) => ['STALE_WORK_LEASE', 'WORK_NOT_RUNNING'].includes(error?.code));
    }
  }
  await supervisor.maintain();
  assert.equal((await readCurrentEnvelope(store, 'run-failed-comparative')).decision.code,
    'NOT_READY_TEST_FAILURE', 'a canonical product failure must block the comparative release verdict');

  const singleLaunch = compileSharedLaunchPlan({
    intent: { schemaVersion: 1, runContract: {
      schemaVersion: 1,
      mode: 'single-site',
      url: 'https://candidate.example.test',
      deploymentRole: 'preview',
      certificatePolicy: 'preview-bypass',
      targetIds: ['single-site-mobile-chromium'],
      scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: [], areas: ['accessibility'] },
    } },
    pluginRegistry,
    targetRegistry,
    runnerRevision: digest('5'),
    configurationRevision: digest('6'),
    environmentRevision: digest('7'),
    deploymentIdentity: { kind: 'target-preflight-set', value: digest('8') },
  });
  assert(singleLaunch.createParentRunInput.sealedCompileRiskInputs.manualObligations.length > 0,
    'sealed compile data must carry explicit manual obligations selected by scope');
  await createParentRun(store, { runId: 'run-first-single-site', ...singleLaunch.createParentRunInput });

  const inventoryWorker = {
    ...worker,
    id: 'worker-inventory-first-publication',
    workerGrant: { capabilities: ['inventory:http'], resourceClasses: ['ordinary'] },
  };
  const inventoryLease = await supervisor.claim(inventoryWorker);
  assert.equal(inventoryLease.runId, 'run-first-single-site');
  const inventoryDocument = {
    schemaVersion: 1,
    kind: 'shared-single-site-inventory-result',
    workItemId: inventoryLease.workItemId,
    executionDescriptorDigest: inventoryLease.executionDescriptorDigest,
    deploymentIdentityRecheck: { kind: 'target-preflight-set', value: digest('8') },
    preflight: { accepted: true },
    diagnostic: {
      inventory: {
        schemaVersion: 1,
        origin: 'https://candidate.example.test',
        routes: [{
          url: 'https://candidate.example.test/', path: '/', query: '', disposition: 'included',
          sources: [{ source: 'catalog', from: null, depth: 0 }],
        }],
        limitations: [],
        failures: [],
      },
    },
  };
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventoryDocument)}\n`);
  const inventoryRiskSources = sealRiskSourceObservationSet({
    schemaVersion: 1,
    runId: inventoryLease.runId,
    workItemId: inventoryLease.workItemId,
    subjectCoreDigest: inventoryLease.subjectCoreDigest,
    attempt: inventoryLease.attempt,
    workerId: inventoryWorker.id,
    producerStates: [
      { producer: 'visual', status: 'NOT_APPLICABLE' },
      { producer: 'baseline', status: 'NOT_APPLICABLE' },
      { producer: 'evidence-pipeline', status: 'COMPLETE' },
    ],
    observations: [],
  });
  const inventoryInbox = await publishAttemptEvidence(store, inventoryLease.runId, inventoryLease, {
    outcome: 'completed_pass',
    executionDescriptorDigest: inventoryLease.executionDescriptorDigest,
    riskSourceObservationSet: inventoryRiskSources,
    artifacts: [{
      name: 'inventory/live-route-inventory.json',
      mediaType: 'application/json',
      sizeBytes: inventoryBytes.length,
      digest: `sha256:${createHash('sha256').update(inventoryBytes).digest('hex')}`,
      contentBase64: inventoryBytes.toString('base64'),
    }],
  });
  await adoptAttemptEvidence(store, inventoryLease.runId, supervisor.coordinator(), inventoryInbox);
  assert.equal((await supervisor.maintain()).sealedGraphs, 1,
    'single-site inventory must seal the execution graph before browser work is claimable');

  let unavailableEvidenceProducer = true;
  while (true) {
    let lease;
    try { lease = await supervisor.claim(worker); } catch (error) {
      if (error?.code === 'NO_WORK_AVAILABLE') break;
      throw error;
    }
    if (lease.runId !== 'run-first-single-site') continue;
    const riskSourceObservationSet = sealRiskSourceObservationSet({
      schemaVersion: 1,
      runId: lease.runId,
      workItemId: lease.workItemId,
      subjectCoreDigest: lease.subjectCoreDigest,
      attempt: lease.attempt,
      workerId: worker.id,
      producerStates: [
        { producer: 'visual', status: 'NOT_APPLICABLE' },
        { producer: 'baseline', status: 'NOT_APPLICABLE' },
        { producer: 'evidence-pipeline', status: unavailableEvidenceProducer ? 'UNAVAILABLE' : 'COMPLETE' },
      ],
      observations: [],
    });
    unavailableEvidenceProducer = false;
    const inbox = await publishAttemptEvidence(store, lease.runId, lease, {
      outcome: 'completed_pass', reason: null, artifacts: [], riskSourceObservationSet,
      executionDescriptorDigest: lease.executionDescriptorDigest,
    });
    await adoptAttemptEvidence(store, lease.runId, supervisor.coordinator(), inbox);
  }
  await supervisor.maintain();
  const singleReady = await readCurrentEnvelope(store, 'run-first-single-site');
  assert.equal(singleReady.decision.code, 'FEATURE_READY',
    'non-blocking human-review and producer-completeness risks must not invent a product failure');
  assert.equal(singleReady.riskRegister.availability, 'PARTIAL');
  assert.deepEqual([...new Set(singleReady.riskRegister.risks.map(({ category }) => category))].sort(), [
    'certificate-bypass', 'evidence-pipeline-limitation', 'manual-check',
  ]);
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('Shared first-publication self-test passed: sealed risk observations and unseeded publication are authoritative.\n');
