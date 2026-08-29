import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditCaseTag } from '../shared/audit-case-identity.mjs';
import {
  parseRiskSourceObservationSet,
  sealCompileRiskInputs,
  sealRiskSourceObservationSet,
} from '../shared/risk-source-observation.mjs';
import { compileSharedLaunchPlan } from '../shared/launch-plan-compiler.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import { createSharedCoordinatorSupervisor } from './lib/shared-coordinator-supervisor.mjs';
import { collectSharedPlaywrightArtifacts } from './lib/shared-playwright-work-item.mjs';
import { collectSharedWorkerEvidence } from './lib/shared-worker-evidence.mjs';
import { buildSharedWorkerResultManifest } from './execute-shared-work-item.mjs';
import {
  adoptAttemptEvidence,
  applyRekickOperation,
  cancelParentRun,
  createParentRun,
  openParentRunStore,
  publishAttemptEvidence,
  readCurrentEnvelope,
  readParentRun,
  readReleaseAuthoritySelector,
  rekickIncompleteWork,
  transitionReleaseAuthority,
} from './lib/parent-run-store.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const observedAt = '2026-08-29T12:00:00.000Z';

async function realVisualWorkerResult(lease) {
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), 'shared-real-visual-risk-'));
  try {
    const descriptor = lease.executionDescriptor;
    const artifactRoot = path.join(evidenceRoot, 'playwright');
    const rowRoot = path.join(artifactRoot, 'raw', 'row-1');
    await mkdir(rowRoot, { recursive: true });
    const policy = { mode: 'static-screenshot', rationale: 'Capture the exact rendered visual state for review.' };
    const summary = {
      schemaVersion: 1, caseId: descriptor.caseId, auditId: descriptor.definitionId,
      coveredEnvironments: [descriptor.targetRole], environment: descriptor.targetRole,
      baseURL: descriptor.origins.candidate, project: descriptor.targetId, findings: [], steps: [],
    };
    const comparison = {
      schemaVersion: 1, kind: 'shared-visual-comparison-result', caseId: descriptor.caseId,
      targetId: descriptor.targetId, observedAt, items: [{ id: 'home-light', comparison: {
        schemaVersion: 1, policyRevision: 'pixelmatch-css-ratio-0.0025-v1',
        status: 'CHANGED', comparisonStatus: 'CHANGED', differingPixels: 400,
        totalPixels: 10_000, differingPixelRatio: 0.04,
        reason: 'Pixel difference ratio 0.04 exceeds the reviewed tolerance.', review: null,
        effects: { deterministicHealth: 'none', deterministicFindings: 'none', promotion: 'none' },
      } }],
    };
    await writeFile(path.join(rowRoot, 'audit-result.json'), `${JSON.stringify({
      ...summary, definition: { id: descriptor.definitionId }, evidencePolicy: policy,
      browser: 'Chromium', viewport: { width: 390, height: 844 }, timezone: 'America/Chicago',
      startedAt: observedAt, finishedAt: observedAt, observations: [], pageInspections: [],
      consoleErrors: [], consoleWarnings: [], pageErrors: [], httpResponses: [], failedRequests: [],
      badResponses: [], runtimeExpectations: [], thirdPartyTelemetryDiagnostics: [],
    })}\n`);
    await writeFile(path.join(rowRoot, 'state.png'), Buffer.from('real-visual-state'));
    await writeFile(path.join(rowRoot, 'shared-visual-comparison-result.json'), `${JSON.stringify(comparison)}\n`);
    const document = {
      suites: [{ file: descriptor.entrySpec, specs: [{ file: 'fixtures/test.ts',
        tags: [auditCaseTag(descriptor.caseId).slice(1)], tests: [{ projectName: descriptor.targetId,
          annotations: [
            { type: 'audit-case-id', description: descriptor.caseId },
            { type: 'audit-evidence-policy', description: JSON.stringify(policy) },
          ], results: [{ status: 'passed', retry: 0, attachments: [
            { name: 'audit-result', contentType: 'application/json', path: path.join(rowRoot, 'audit-result.json') },
            { name: 'audit-result-summary', contentType: 'application/json', body: Buffer.from(JSON.stringify(summary)).toString('base64') },
            { name: 'shared-visual-comparison-result', contentType: 'application/json', path: path.join(rowRoot, 'shared-visual-comparison-result.json') },
            { name: 'rendered-visual-state', contentType: 'image/png', path: path.join(rowRoot, 'state.png') },
          ] }] }]}], suites: [] }], errors: [],
    };
    const result = await collectSharedPlaywrightArtifacts({ document, descriptor, artifactRoot, evidenceRoot });
    const identity = {
      runId: lease.runId, workItemId: lease.workItemId, attempt: lease.attempt,
      subjectCoreDigest: lease.subjectCoreDigest, runnerRevision: lease.runnerRevision,
      executionDescriptorDigest: lease.executionDescriptorDigest,
    };
    await writeFile(path.join(evidenceRoot, 'result.json'), `${JSON.stringify(buildSharedWorkerResultManifest({
      descriptor, identity, result: { ...result, reason: null, artifacts: [] },
    }))}\n`);
    const collected = await collectSharedWorkerEvidence(evidenceRoot, { code: 0, signal: null }, lease);
    return {
      ...collected,
      artifacts: await Promise.all(collected.artifacts.map(async ({ sourcePath, ...artifact }) => ({
        ...artifact, contentBase64: (await readFile(sourcePath)).toString('base64'),
      }))),
    };
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
}

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
const storeMarker = 'ab'.repeat(32);
let now = Date.parse(observedAt);
const resilienceHookEvents = [];
try {
  const store = await openParentRunStore({
    root,
    deploymentIdentity: 'shared-first-publication-test',
    volumeIdentity: 'named-volume:shared-first-publication-test',
    backupMarker: 'backup:shared-first-publication-test',
    storeMarker,
    verifyStorage: false,
    clock: () => now,
  });
  const controlService = createSharedControlService({
    store,
    projectId: 'project-first-publication',
    reprobeTargetIdentity: async ({ subjectCore: currentSubjectCore }) => currentSubjectCore.deploymentIdentity,
    afterOracleSeal: ({ runId, oracleResultsDigest }) => {
      resilienceHookEvents.push({ boundary: 'oracle-seal', runId, digest: oracleResultsDigest });
    },
    publicationHooks: {
      afterEnvelopePersist: (envelope) => resilienceHookEvents.push({
        boundary: 'envelope-fsync', runId: envelope.runId, digest: envelope.digest,
      }),
      afterDecisionPersist: (envelope) => resilienceHookEvents.push({
        boundary: 'head-swap', runId: envelope.runId, digest: envelope.digest,
      }),
    },
  });
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
  const shadowSelector = await readReleaseAuthoritySelector(store);
  const drainingSelector = await transitionReleaseAuthority(store, supervisor.coordinator(), {
    expectedSelectorDigest: shadowSelector.digest,
    phase: 'DRAINING',
    buildIdentity: store.buildIdentity,
  });
  await transitionReleaseAuthority(store, supervisor.coordinator(), {
    expectedSelectorDigest: drainingSelector.digest,
    phase: 'ACTIVE',
    activationRevision: 1,
    buildIdentity: store.buildIdentity,
  });

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
  for (const boundary of ['oracle-seal', 'envelope-fsync', 'head-swap']) {
    assert(resilienceHookEvents.some((event) => event.boundary === boundary
      && event.runId === 'run-first-comparative' && /^sha256:[a-f0-9]{64}$/u.test(event.digest)),
    `${boundary} hook must observe a digest-bound production publication boundary`);
  }
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

  await createParentRun(store, { runId: 'run-production-baseline-comparative', ...launch.createParentRunInput });
  while (true) {
    let lease;
    try { lease = await supervisor.claim(worker); } catch (error) {
      if (error?.code === 'NO_WORK_AVAILABLE') break;
      throw error;
    }
    if (lease.runId !== 'run-production-baseline-comparative') continue;
    const riskSourceObservationSet = sealRiskSourceObservationSet({
      schemaVersion: 1,
      runId: lease.runId,
      workItemId: lease.workItemId,
      subjectCoreDigest: lease.subjectCoreDigest,
      attempt: lease.attempt,
      workerId: worker.id,
      producerStates: [
        { producer: 'visual', status: 'NOT_APPLICABLE' },
        { producer: 'baseline', status: lease.executionDescriptor.targetRole === 'production' ? 'COMPLETE' : 'NOT_APPLICABLE' },
        { producer: 'evidence-pipeline', status: 'COMPLETE' },
      ],
      observations: [],
    });
    const productionFailure = lease.executionDescriptor.targetRole === 'production';
    const inbox = await publishAttemptEvidence(store, lease.runId, lease, {
      outcome: productionFailure ? 'completed_product_failure' : 'completed_pass',
      reason: productionFailure ? 'known-production-defect' : null,
      artifacts: [], riskSourceObservationSet,
      executionDescriptorDigest: lease.executionDescriptorDigest,
    });
    await adoptAttemptEvidence(store, lease.runId, supervisor.coordinator(), inbox);
  }
  await supervisor.maintain();
  const productionBaseline = await readCurrentEnvelope(store, 'run-production-baseline-comparative');
  assert.equal(productionBaseline.decision.code, 'FEATURE_READY',
    'A production-only failure must not block candidate promotion.');
  assert(productionBaseline.riskRegister.risks.some(({ category, source }) => (
    category === 'production-baseline-defect' && source.kind === 'oracle-execution'
  )), 'The non-blocking production failure must remain visible as canonical baseline risk.');

  const mixedBaselineLaunch = compileSharedLaunchPlan({
    intent: { schemaVersion: 1, runContract: {
      schemaVersion: 1,
      mode: 'comparative',
      candidateUrl: 'https://candidate.example.test',
      productionUrl: 'https://production.example.test',
      targetIds: ['candidate-desktop-chromium', 'candidate-mobile-chromium', 'production-mobile-chromium'],
      scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['A11Y-001'], areas: [] },
    } },
    pluginRegistry,
    targetRegistry,
    runnerRevision: digest('1'),
    configurationRevision: digest('2'),
    environmentRevision: digest('3'),
    deploymentIdentity: { kind: 'target-preflight-set', value: digest('4') },
  });
  await createParentRun(store, { runId: 'run-mixed-baseline-comparative', ...mixedBaselineLaunch.createParentRunInput });
  let failedCandidatePair = false;
  while (true) {
    let lease;
    try { lease = await supervisor.claim(worker); } catch (error) {
      if (error?.code === 'NO_WORK_AVAILABLE') break;
      throw error;
    }
    if (lease.runId !== 'run-mixed-baseline-comparative') continue;
    const productionFailure = lease.executionDescriptor.targetRole === 'production';
    const candidateRegression = !failedCandidatePair
      && lease.executionDescriptor.targetId === 'candidate-mobile-chromium';
    const riskSourceObservationSet = sealRiskSourceObservationSet({
      schemaVersion: 1,
      runId: lease.runId,
      workItemId: lease.workItemId,
      subjectCoreDigest: lease.subjectCoreDigest,
      attempt: lease.attempt,
      workerId: worker.id,
      producerStates: [
        { producer: 'visual', status: 'NOT_APPLICABLE' },
        { producer: 'baseline', status: productionFailure ? 'COMPLETE' : 'NOT_APPLICABLE' },
        { producer: 'evidence-pipeline', status: 'COMPLETE' },
      ],
      observations: [],
    });
    const failed = productionFailure || candidateRegression;
    const inbox = await publishAttemptEvidence(store, lease.runId, lease, {
      outcome: failed ? 'completed_product_failure' : 'completed_pass',
      reason: failed ? 'mixed-baseline-fixture' : null,
      artifacts: [], riskSourceObservationSet,
      executionDescriptorDigest: lease.executionDescriptorDigest,
    });
    await adoptAttemptEvidence(store, lease.runId, supervisor.coordinator(), inbox);
    if (candidateRegression) failedCandidatePair = true;
  }
  await supervisor.maintain();
  const mixedBaseline = await readCurrentEnvelope(store, 'run-mixed-baseline-comparative');
  assert.equal(mixedBaseline.decision.code, 'NOT_READY_TEST_FAILURE',
    'A candidate failure without sealed equivalence to its failed production pair must block release.');
  assert(mixedBaseline.riskRegister.risks.some(({ category, source }) => (
    category === 'production-baseline-defect' && source.kind === 'oracle-execution'
  )), 'Production baseline context must remain visible beside a separate candidate regression.');

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

  await createParentRun(store, { runId: 'run-inventory-recovery', ...singleLaunch.createParentRunInput });
  await assert.rejects(rekickIncompleteWork(store, 'run-inventory-recovery', supervisor.coordinator(), {
    actor: { id: 'operator-inventory-recovery', kind: 'human' },
    workItemIds: [singleLaunch.inventoryBarrier.workItem.id],
  }), (error) => error?.code === 'REKICK_NOT_INCOMPLETE',
  'inventory work cannot be rekicked before compilation terminalizes');
  let exhaustedInventoryWorkItemId = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const lease = await supervisor.claim(inventoryWorker);
    assert.equal(lease.runId, 'run-inventory-recovery');
    exhaustedInventoryWorkItemId = lease.workItemId;
    const inbox = await publishAttemptEvidence(store, lease.runId, lease, {
      outcome: 'operational_failure',
      reason: `synthetic-inventory-failure-${attempt}`,
      artifacts: [],
      executionDescriptorDigest: lease.executionDescriptorDigest,
    });
    await adoptAttemptEvidence(store, lease.runId, supervisor.coordinator(), inbox);
  }
  await supervisor.maintain();
  const inventoryFailed = await readParentRun(store, 'run-inventory-recovery');
  assert.equal(inventoryFailed.compilationState, 'failed',
    'exhausting the inventory barrier must terminalize compilation instead of waiting forever');
  assert.equal(inventoryFailed.compilationFailure.workItemId, exhaustedInventoryWorkItemId);
  assert.equal(inventoryFailed.compilationFailure.attemptCount, 3);
  assert.equal(inventoryFailed.finalSubject, null, 'inventory failure must not manufacture a final release subject');
  assert.equal(inventoryFailed.executionManifest, null, 'inventory failure must not manufacture an execution manifest');
  const coreFailure = await readCurrentEnvelope(store, 'run-inventory-recovery');
  assert.equal(coreFailure.decision.code, 'NOT_READY_INCOMPLETE_EXECUTION');
  assert.equal(coreFailure.subjectCoreDigest, inventoryFailed.subjectCoreDigest);
  assert.equal(coreFailure.finalSubjectDigest, null);
  assert.equal(coreFailure.decision.grantedAuthority, null,
    'a core-bound inventory failure must not claim granted release authority');
  await assert.rejects(rekickIncompleteWork(store, 'run-inventory-recovery', supervisor.coordinator(), {
    actor: { id: 'operator-inventory-recovery', kind: 'human' }, workItemIds: ['wrong-inventory-barrier'],
  }), (error) => error?.code === 'REKICK_NOT_INCOMPLETE',
  'failed compilation must reject any rekick that does not name its exact immutable barrier');

  const inventoryOperator = {
    id: 'operator-inventory-recovery', kind: 'human', roles: ['operator'],
    projectIds: ['project-first-publication'], runIds: ['run-inventory-recovery'],
  };
  const rekickRequest = {
    kind: 'rekick',
    requestId: 'inventory-recovery-rekick-0001',
    expectedRunRevision: inventoryFailed.runRevision,
    body: {
      expectedSubjectDigest: inventoryFailed.subjectCoreDigest,
      workItemIds: [exhaustedInventoryWorkItemId],
    },
  };
  await assert.rejects(controlService.acceptMutation(inventoryOperator, 'run-inventory-recovery', {
    ...rekickRequest,
    requestId: 'inventory-recovery-rekick-wrong-core',
    body: { ...rekickRequest.body, expectedSubjectDigest: digest('f') },
  }), (error) => error?.code === 'RELEASE_SUBJECT_MISMATCH');
  const acceptedRekick = await controlService.acceptMutation(inventoryOperator, 'run-inventory-recovery', rekickRequest);
  const durablyAppliedRekick = await applyRekickOperation(
    store, 'run-inventory-recovery', supervisor.coordinator(), acceptedRekick.operationId,
    { observedDeploymentIdentity: inventoryFailed.subjectCore.deploymentIdentity },
  );
  assert.equal(durablyAppliedRekick.state, 'applied',
    'rekick transition and durable operation application must commit atomically');
  assert.deepEqual(
    await controlService.acceptMutation(inventoryOperator, 'run-inventory-recovery', rekickRequest),
    durablyAppliedRekick,
    'an authorized duplicate core-bound rekick must recover the original operation',
  );
  await assert.rejects(controlService.acceptMutation({
    ...inventoryOperator, id: 'viewer-inventory-recovery', roles: ['viewer'],
  }, 'run-inventory-recovery', {
    ...rekickRequest,
    requestId: 'inventory-recovery-rekick-unauthorized',
    expectedRunRevision: (await readParentRun(store, 'run-inventory-recovery')).runRevision,
  }), (error) => error?.code === 'AUTHORIZATION_DENIED');
  const resumed = await readParentRun(store, 'run-inventory-recovery');
  assert.equal(resumed.compilationState, 'pending');
  assert.equal(resumed.subjectCoreDigest, inventoryFailed.subjectCoreDigest);
  assert.equal(resumed.workItems[exhaustedInventoryWorkItemId].attempts.length, 3);

  const failedManualLease = await supervisor.claim(inventoryWorker);
  assert.equal(failedManualLease.runId, 'run-inventory-recovery');
  assert.equal(failedManualLease.attempt, 4);
  const failedManualInbox = await publishAttemptEvidence(store, failedManualLease.runId, failedManualLease, {
    outcome: 'operational_failure',
    reason: 'synthetic-manual-inventory-failure',
    artifacts: [],
    executionDescriptorDigest: failedManualLease.executionDescriptorDigest,
  });
  await adoptAttemptEvidence(store, failedManualLease.runId, supervisor.coordinator(), failedManualInbox);
  const replayMaintenance = await supervisor.maintain();
  assert.equal(replayMaintenance.completedOperations, 1,
    'replay after a worker result must complete the original applied rekick without consuming another rekick');
  const failedAgain = await readParentRun(store, 'run-inventory-recovery');
  const coreFailureAgain = await readCurrentEnvelope(store, 'run-inventory-recovery');
  assert.equal(failedAgain.compilationState, 'failed');
  assert.equal(failedAgain.compilationFailure.attemptCount, 4);
  assert.equal(coreFailureAgain.previousEnvelopeDigest, coreFailure.digest);
  assert.equal(coreFailureAgain.decisionRevision, coreFailure.decisionRevision + 1);
  assert.equal(coreFailureAgain.subjectCoreDigest, coreFailure.subjectCoreDigest);

  const secondRekick = await controlService.acceptMutation(inventoryOperator, 'run-inventory-recovery', {
    kind: 'rekick',
    requestId: 'inventory-recovery-rekick-0002',
    expectedRunRevision: failedAgain.runRevision,
    body: {
      expectedSubjectDigest: failedAgain.subjectCoreDigest,
      workItemIds: [exhaustedInventoryWorkItemId],
    },
  });
  assert.equal(secondRekick.state, 'accepted');
  assert.equal((await controlService.applyAcceptedOperations(
    supervisor.coordinator(),
    'run-inventory-recovery',
  ))[0].outcome.status, 'succeeded');

  const recoveryLease = await supervisor.claim(inventoryWorker);
  assert.equal(recoveryLease.runId, 'run-inventory-recovery');
  assert.equal(recoveryLease.attempt, 5);
  const recoveryDocument = {
    ...inventoryDocument,
    workItemId: recoveryLease.workItemId,
    executionDescriptorDigest: recoveryLease.executionDescriptorDigest,
  };
  const recoveryBytes = Buffer.from(`${JSON.stringify(recoveryDocument)}\n`);
  const recoveryInbox = await publishAttemptEvidence(store, recoveryLease.runId, recoveryLease, {
    outcome: 'completed_pass',
    executionDescriptorDigest: recoveryLease.executionDescriptorDigest,
    artifacts: [{
      name: 'inventory/live-route-inventory.json',
      mediaType: 'application/json',
      sizeBytes: recoveryBytes.length,
      digest: `sha256:${createHash('sha256').update(recoveryBytes).digest('hex')}`,
      contentBase64: recoveryBytes.toString('base64'),
    }],
  });
  await adoptAttemptEvidence(store, recoveryLease.runId, supervisor.coordinator(), recoveryInbox);
  const recoveryMaintenance = await supervisor.maintain();
  assert.deepEqual(recoveryMaintenance.errors, [], JSON.stringify(recoveryMaintenance.errors));
  assert.equal(recoveryMaintenance.sealedGraphs, 1);
  const recoveredInventory = await readParentRun(store, 'run-inventory-recovery');
  assert.equal(recoveredInventory.compilationState, 'sealed');
  assert.equal(recoveredInventory.subjectCoreDigest, inventoryFailed.subjectCoreDigest);
  assert(recoveredInventory.finalSubjectDigest);
  const superseding = await readCurrentEnvelope(store, 'run-inventory-recovery');
  assert.equal(superseding.previousEnvelopeDigest, coreFailureAgain.digest);
  assert.equal(superseding.subjectCoreDigest, inventoryFailed.subjectCoreDigest);
  assert.equal(superseding.finalSubjectDigest, recoveredInventory.finalSubjectDigest);
  assert.equal(superseding.decisionRevision, coreFailureAgain.decisionRevision + 1);

  await createParentRun(store, { runId: 'run-inventory-cancelled-failure', ...singleLaunch.createParentRunInput });
  let cancelledBarrierId;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const lease = await supervisor.claim(inventoryWorker);
    assert.equal(lease.runId, 'run-inventory-cancelled-failure');
    cancelledBarrierId = lease.workItemId;
    const failedInbox = await publishAttemptEvidence(store, lease.runId, lease, {
      outcome: 'operational_failure', reason: `cancel-reopen-failure-${attempt}`, artifacts: [],
      executionDescriptorDigest: lease.executionDescriptorDigest,
    });
    await adoptAttemptEvidence(store, lease.runId, supervisor.coordinator(), failedInbox);
  }
  await supervisor.maintain();
  await cancelParentRun(store, 'run-inventory-cancelled-failure', supervisor.coordinator(), {
    actor: { id: inventoryOperator.id, kind: inventoryOperator.kind }, reason: 'Cancel after terminal inventory failure.',
  });
  await controlService.publishCurrentProjection(supervisor.coordinator(), 'run-inventory-cancelled-failure');
  const reopened = await openParentRunStore({
    root, storeMarker, expectedStoreGeneration: 2, verifyStorage: false, clock: () => now,
  });
  const cancelledFailure = await readParentRun(reopened, 'run-inventory-cancelled-failure');
  assert.equal(cancelledFailure.status, 'cancelled');
  assert.equal(cancelledFailure.compilationState, 'failed');
  assert.equal(cancelledFailure.workItems[cancelledBarrierId].state, 'incomplete',
    'cancellation must preserve the immutable exhausted inventory barrier across reopen');
  const cancelledFailurePublication = await readCurrentEnvelope(reopened, 'run-inventory-cancelled-failure');
  assert.equal(cancelledFailurePublication.decision.code, 'NOT_READY_INCOMPLETE_EXECUTION');
  assert.equal(cancelledFailurePublication.decision.grantedAuthority, null);

  const visualLaunch = compileSharedLaunchPlan({
    intent: { schemaVersion: 1, runContract: {
      schemaVersion: 1, mode: 'comparative',
      candidateUrl: 'https://candidate.example.test', productionUrl: 'https://production.example.test',
      targetIds: ['candidate-mobile-chromium', 'production-mobile-chromium'],
      scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['A11Y-001', 'CONTENT-002'], areas: [] },
    } },
    pluginRegistry, targetRegistry,
    runnerRevision: digest('1'), configurationRevision: digest('2'), environmentRevision: digest('3'),
    deploymentIdentity: { kind: 'target-preflight-set', value: digest('4') },
  });
  const compiledVisualWork = visualLaunch.createParentRunInput.workItems
    .filter(({ executionDescriptor }) => executionDescriptor?.entrySpec === 'tests/visual-regression.spec.ts');
  assert(compiledVisualWork.length > 0);
  assert(compiledVisualWork.every(({ executionDescriptor }) => executionDescriptor.targetRole === 'candidate'),
    'Comparative compilation must not schedule production visual rows that the visual spec intentionally captures in-worker.');
  await createParentRun(store, { runId: 'run-real-visual-risk', ...visualLaunch.createParentRunInput });
  while (true) {
    let lease;
    try { lease = await supervisor.claim(worker); } catch (error) {
      if (error?.code === 'NO_WORK_AVAILABLE') break;
      throw error;
    }
    if (lease.runId !== 'run-real-visual-risk') continue;
    const workerResult = lease.executionDescriptor.entrySpec === 'tests/visual-regression.spec.ts'
      ? await realVisualWorkerResult(lease)
      : {
          outcome: 'completed_pass', reason: null, artifacts: [],
          executionDescriptorDigest: lease.executionDescriptorDigest,
          riskSourceObservationSet: sealRiskSourceObservationSet({
            schemaVersion: 1, runId: lease.runId, workItemId: lease.workItemId,
            subjectCoreDigest: lease.subjectCoreDigest, attempt: lease.attempt, workerId: worker.id,
            producerStates: [
              { producer: 'visual', status: 'NOT_APPLICABLE' },
              { producer: 'baseline', status: lease.executionDescriptor.targetRole === 'production' ? 'COMPLETE' : 'NOT_APPLICABLE' },
              { producer: 'evidence-pipeline', status: 'COMPLETE' },
            ], observations: [],
          }),
        };
    const inbox = await publishAttemptEvidence(store, lease.runId, lease, workerResult);
    await adoptAttemptEvidence(store, lease.runId, supervisor.coordinator(), inbox);
  }
  const visualMaintenance = await supervisor.maintain();
  assert.deepEqual(visualMaintenance.errors, [], JSON.stringify(visualMaintenance.errors));
  const visualPublication = await readCurrentEnvelope(store, 'run-real-visual-risk');
  assert.equal(visualPublication.decision.code, 'FEATURE_READY');
  assert(visualPublication.riskRegister.risks.some(({ category, reviewState, source }) => (
    category === 'unreviewed-visual-change' && reviewState === 'PENDING_REVIEW'
      && source.kind === 'visual-result' && source.id.endsWith(':home-light')
  )), 'A real Playwright comparison artifact must survive executor, collector, adoption, and risk projection.');
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('Shared first-publication self-test passed: sealed risk observations and unseeded publication are authoritative.\n');
