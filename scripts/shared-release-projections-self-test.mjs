import assert from 'node:assert/strict';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { sealInventoryCompilationFailure } from '../shared/compilation-failure.mjs';
import { sealExecutionManifest, sealOracleResult, sealWorkItemResult } from '../shared/execution-contract.mjs';
import { appendPublicationEnvelope } from '../shared/publication-envelope.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { sealRiskSourceObservationSet } from '../shared/risk-source-observation.mjs';
import {
  appendVisualDisposition,
  projectCompilationFailureView,
  projectSharedReleaseView,
  projectPublicationView,
} from '../shared/release-projection.mjs';
import { parseChecklistRelease } from './lib/release-truth.mjs';
import { applySharedReleaseEligibility } from '../portal/release-eligibility.mjs';
import { projectSharedReleasePublication } from '../reporters/report-model.ts';
import { projectConsoleReleasePublication } from '../portal/console-risk.mjs';
import { projectReportReleasePublication } from '../portal/report-publication.mjs';
import { projectSiteHealthRelease } from './lib/site-health.mjs';
import { projectArchiveReleasePublication } from '../reporters/archive-bundle.ts';
import {
  sharedParentRunToConsoleIndexRecord,
  sharedPublicationToConsoleIndexRecord,
} from '../portal/console-index-records.mjs';
import { projectSharedParentTimeline } from '../portal/console-run.mjs';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

function fixture(mode, outcome = 'completed_pass') {
  const targetRows = mode === 'single-site'
    ? [{ role: 'audited', origin: 'https://beta.example.test' }]
    : [{ role: 'candidate', origin: 'https://beta.example.test' }, { role: 'production', origin: 'https://example.test' }];
  const targetIds = mode === 'single-site' ? ['audited-desktop'] : ['candidate-desktop', 'production-desktop'];
  const core = sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: { kind: 'build', value: `build-${mode}` },
    targets: targetRows,
    mode,
    requestedAuthority: {
      qualifier: 'FULL',
      scope: { features: ['site'], definitions: ['VISUAL-001'], targets: targetIds, knownLimits: [] },
    },
    revisions: { runner: D1, plugins: D1, targets: D1, configuration: D1 },
    environmentIdentity: D2,
    certificatePolicy: 'strict',
  });
  const workItems = targetIds.map((targetId, index) => ({
    id: `work-${index + 1}`,
    definitionId: 'VISUAL-001',
    targetId,
    targetRole: mode === 'single-site' ? 'audited' : index === 0 ? 'candidate' : 'production',
  }));
  const manifest = sealExecutionManifest({
    schemaVersion: 1,
    subjectCoreDigest: core.digest,
    workItems,
    oracleExecutions: [{ id: 'oracle-visual', definitionId: 'VISUAL-001', requiredWorkItemIds: workItems.map(({ id }) => id) }],
    contextWorkItemIds: [],
  });
  const finalSubject = sealFinalReleaseSubject({
    schemaVersion: 1,
    subjectCore: core,
    executionManifest: manifest,
    grantedAuthority: core.requestedAuthority,
    coverageBasis: { selectedDefinitions: ['VISUAL-001'], selectedTargets: targetIds, excludedAsNotApplicable: [] },
    deploymentIdentityRecheck: core.deploymentIdentity,
  });
  const results = workItems.map(({ id }) => sealWorkItemResult({
    schemaVersion: 1,
    workItemId: id,
    subjectCoreDigest: core.digest,
    attempt: 1,
    authoritative: true,
    outcome,
    evidenceDigests: [D1],
  }));
  const oracle = sealOracleResult({
    schemaVersion: 1,
    oracleExecution: manifest.oracleExecutions[0],
    finalSubjectDigest: finalSubject.digest,
    workItemResults: results,
  });
  return { core, manifest, finalSubject, oracleResults: [oracle] };
}

function riskSource(f, overrides = {}) {
  return {
    schemaVersion: 1,
    category: 'manual-check',
    severity: 'medium',
    mode: f.finalSubject.mode,
    scope: f.finalSubject.grantedAuthority.scope,
    source: { kind: 'manual-obligation', id: 'screen-reader' },
    explanation: 'A human screen-reader pass remains outstanding.',
    recommendedAction: 'Complete the manual accessibility review.',
    reviewState: 'OPEN',
    releaseEffect: 'non-blocking',
    actor: { id: 'runner', kind: 'service' },
    observedAt: '2026-08-28T20:00:00.000Z',
    updatedAt: '2026-08-28T20:00:00.000Z',
    ...overrides,
  };
}

function viewInput(f, overrides = {}) {
  return {
    schemaVersion: 1,
    runId: `run-${f.finalSubject.mode}`,
    baseDecisionRevision: 1,
    baseRiskRevision: 1,
    finalSubject: f.finalSubject,
    executionManifest: f.manifest,
    oracleResults: f.oracleResults,
    riskAvailability: 'AVAILABLE',
    riskSources: [riskSource(f)],
    riskLifecycleEvents: [],
    visualDispositions: [],
    ...overrides,
  };
}

const single = fixture('single-site');
const comparative = fixture('comparative');

const publicationCanaries = [
  'Authorization: Bearer test_publication_secret_123456789',
  'Authorization%3A%20Bearer%20test_publication_secret_123456789',
  Buffer.from('Cookie: session=test_publication_secret_123456789').toString('base64'),
  'Authorization:\r\n Bearer test_publication_secret_123456789',
  'X-API-Key: test_publication_secret_123456789',
];
for (const canary of publicationCanaries) {
  assert.throws(() => sealRiskSourceObservationSet({
    schemaVersion: 1,
    runId: 'run-publication-policy',
    workItemId: 'work-publication-policy',
    subjectCoreDigest: single.core.digest,
    attempt: 1,
    workerId: 'worker-publication-policy',
    producerStates: [
      { producer: 'visual', status: 'COMPLETE' },
      { producer: 'baseline', status: 'NOT_APPLICABLE' },
      { producer: 'evidence-pipeline', status: 'COMPLETE' },
    ],
    observations: [{
      producer: 'visual', category: 'unreviewed-visual-change', severity: 'high',
      source: { kind: 'visual-result', id: 'work-publication-policy:hero' },
      explanation: canary,
      recommendedAction: 'Inspect the visual evidence.',
      reviewState: 'PENDING_REVIEW', observedAt: '2026-08-28T20:00:00.000Z',
    }],
  }), (error) => error?.code === 'PUBLICATION_TEXT_REJECTED'
    && !String(error.message).includes('test_publication_secret'),
  'worker publication text must reject raw, encoded, and folded credential canaries without reflecting them');
}
assert.throws(() => sealRiskSourceObservationSet({
  schemaVersion: 1,
  runId: 'run-publication-policy',
  workItemId: 'work-publication-policy',
  subjectCoreDigest: single.core.digest,
  attempt: 1,
  workerId: 'worker-publication-policy',
  producerStates: [
    { producer: 'visual', status: 'COMPLETE' },
    { producer: 'baseline', status: 'NOT_APPLICABLE' },
    { producer: 'evidence-pipeline', status: 'COMPLETE' },
  ],
  observations: [{
    producer: 'visual', category: 'unreviewed-visual-change', severity: 'high',
    source: { kind: 'visual-result', id: 'work-publication-policy:sk-ant-test_source_secret_123456789' },
    explanation: 'The hero is clipped.', recommendedAction: 'Inspect the visual evidence.',
    reviewState: 'PENDING_REVIEW', observedAt: '2026-08-28T20:00:00.000Z',
  }],
}), (error) => error?.code === 'PUBLICATION_TEXT_REJECTED'
  && !String(error.message).includes('test_source_secret'),
'worker-controlled risk identifiers must not bypass the publication-text boundary');

const sanitizedWorkerText = sealRiskSourceObservationSet({
  schemaVersion: 1,
  runId: 'run-publication-policy',
  workItemId: 'work-publication-policy',
  subjectCoreDigest: single.core.digest,
  attempt: 1,
  workerId: 'worker-publication-policy',
  producerStates: [
    { producer: 'visual', status: 'COMPLETE' },
    { producer: 'baseline', status: 'NOT_APPLICABLE' },
    { producer: 'evidence-pipeline', status: 'COMPLETE' },
  ],
  observations: [{
    producer: 'visual', category: 'unreviewed-visual-change', severity: 'high',
    source: { kind: 'visual-result', id: 'work-publication-policy:hero' },
    explanation: '\u001b[31mThe hero is clipped.\u001b[0m',
    recommendedAction: 'Inspect\u202E the visual evidence.',
    reviewState: 'PENDING_REVIEW', observedAt: '2026-08-28T20:00:00.000Z',
  }],
});
assert.equal(sanitizedWorkerText.observations[0].explanation, 'The hero is clipped.');
assert.equal(sanitizedWorkerText.observations[0].recommendedAction, 'Inspect the visual evidence.');

const singleView = projectSharedReleaseView(viewInput(single));
const comparativeView = projectSharedReleaseView(viewInput(comparative));
assert.equal(singleView.decision.code, 'RELEASE_READY');
assert.equal(comparativeView.decision.code, 'RELEASE_READY');
assert.equal(singleView.riskRegister.availability, comparativeView.riskRegister.availability);
for (const [outcome, expectedCode] of [
  ['completed_product_failure', 'NOT_READY_TEST_FAILURE'],
  ['operational_failure', 'NOT_READY_INCOMPLETE_EXECUTION'],
]) {
  const singleOutcome = fixture('single-site', outcome);
  const comparativeOutcome = fixture('comparative', outcome);
  assert.equal(projectSharedReleaseView(viewInput(singleOutcome)).decision.code, expectedCode);
  assert.equal(projectSharedReleaseView(viewInput(comparativeOutcome)).decision.code, expectedCode);
}

const productionBaseline = projectSharedReleaseView(viewInput(comparative, {
  riskSources: [riskSource(comparative, {
    category: 'production-baseline-defect',
    severity: 'high',
    source: { kind: 'production-context', id: 'production-nav-defect' },
    explanation: 'Production alone contains a navigation defect.',
    recommendedAction: 'Track the production baseline separately from candidate promotion.',
  })],
}));
assert.equal(productionBaseline.decision.code, 'RELEASE_READY');
assert.equal(productionBaseline.riskRegister.risks[0].releaseEffect, 'non-blocking');

const candidateRegression = fixture('comparative', 'completed_product_failure');
assert.equal(projectSharedReleaseView(viewInput(candidateRegression)).decision.code, 'NOT_READY_TEST_FAILURE');

const visualRisk = riskSource(single, {
  category: 'unreviewed-visual-change',
  severity: 'high',
  source: { kind: 'visual-result', id: 'hero-change' },
  explanation: 'The hero changed and needs human review.',
  recommendedAction: 'Review the visual comparison.',
  reviewState: 'PENDING_REVIEW',
});
const pendingVisual = projectSharedReleaseView(viewInput(single, { riskSources: [visualRisk] }));
const visualRiskIdentity = pendingVisual.riskRegister.risks[0].identity;
assert.equal(pendingVisual.decision.code, 'RELEASE_READY');

for (const canary of publicationCanaries) {
  assert.throws(() => appendVisualDisposition([], {
    schemaVersion: 1,
    expectedReviewRevision: 0,
    runId: 'run-single-site',
    mode: 'single-site',
    subjectDigest: single.finalSubject.digest,
    executionId: 'oracle-visual',
    riskIdentity: visualRiskIdentity,
    disposition: 'ACCEPTED',
    actor: { id: 'reviewer-1', kind: 'operator' },
    rationale: canary,
    at: '2026-08-28T20:01:00.000Z',
  }), (error) => error?.code === 'PUBLICATION_TEXT_REJECTED'
    && !String(error.message).includes('test_publication_secret'));
}

const acceptedHistory = appendVisualDisposition([], {
  schemaVersion: 1,
  expectedReviewRevision: 0,
  runId: 'run-single-site',
  mode: 'single-site',
  subjectDigest: single.finalSubject.digest,
  executionId: 'oracle-visual',
  riskIdentity: visualRiskIdentity,
  disposition: 'ACCEPTED',
  actor: { id: 'reviewer-1', kind: 'operator' },
  rationale: 'The redesign intentionally changes the hero.',
  at: '2026-08-28T20:01:00.000Z',
});
const accepted = projectSharedReleaseView(viewInput(single, { riskSources: [visualRisk], visualDispositions: acceptedHistory }));
assert.equal(accepted.decision.code, 'RELEASE_READY');
assert.equal(accepted.decision.decisionRevision, 2, 'Visual acceptance supersedes even an unchanged ready value.');
assert.equal(accepted.riskRegister.risks[0].reviewState, 'ACCEPTED');

const defectHistory = appendVisualDisposition([], {
  schemaVersion: 1,
  expectedReviewRevision: 0,
  runId: 'run-single-site',
  mode: 'single-site',
  subjectDigest: single.finalSubject.digest,
  executionId: 'oracle-visual',
  riskIdentity: visualRiskIdentity,
  disposition: 'DEFECT_CONFIRMED',
  actor: { id: 'reviewer-1', kind: 'operator' },
  rationale: 'The hero call to action is clipped.',
  at: '2026-08-28T20:01:00.000Z',
});
const defect = projectSharedReleaseView(viewInput(single, { riskSources: [visualRisk], visualDispositions: defectHistory }));
assert.equal(defect.decision.code, 'NOT_READY_TEST_FAILURE');
assert.equal(defect.decision.decisionRevision, 2);

const resolvedAfterDefect = projectSharedReleaseView(viewInput(single, {
  riskSources: [visualRisk],
  visualDispositions: defectHistory,
  riskLifecycleEvents: [{
    riskIdentity: visualRiskIdentity,
    action: 'RESOLVED',
    actor: { id: 'triage-1', kind: 'operator' },
    at: '2026-08-28T20:02:00.000Z',
  }],
}));
assert.equal(resolvedAfterDefect.riskRegister.risks[0].reviewState, 'RESOLVED', 'The latest lifecycle event controls Risk Register state.');
assert.equal(resolvedAfterDefect.decision.code, 'NOT_READY_TEST_FAILURE', 'Risk-only resolution cannot clear a confirmed release defect.');
assert.equal(resolvedAfterDefect.decision.decisionRevision, defect.decision.decisionRevision);

const correctedHistory = appendVisualDisposition(defectHistory, {
  schemaVersion: 1,
  expectedReviewRevision: 1,
  runId: 'run-single-site',
  mode: 'single-site',
  subjectDigest: single.finalSubject.digest,
  executionId: 'oracle-visual',
  riskIdentity: visualRiskIdentity,
  disposition: 'ACCEPTED',
  actor: { id: 'reviewer-2', kind: 'operator' },
  rationale: 'The screenshot was stale; current evidence is expected.',
  at: '2026-08-28T20:02:00.000Z',
});
assert.equal(correctedHistory.length, 2);
assert.equal(correctedHistory[1].supersedes, correctedHistory[0].digest);
assert.throws(() => appendVisualDisposition(correctedHistory, {
  schemaVersion: 1,
  expectedReviewRevision: 1,
  runId: 'run-single-site',
  mode: 'single-site',
  subjectDigest: single.finalSubject.digest,
  executionId: 'oracle-visual',
  riskIdentity: visualRiskIdentity,
  disposition: 'ACCEPTED',
  actor: { id: 'reviewer-2', kind: 'operator' },
  rationale: 'A stale correction must fail optimistic concurrency.',
  at: '2026-08-28T20:04:00.000Z',
}), (error) => error?.code === 'VISUAL_REVIEW_REVISION_CONFLICT');

const acknowledged = projectSharedReleaseView(viewInput(single, {
  riskLifecycleEvents: [{
    riskIdentity: singleView.riskRegister.risks[0].identity,
    action: 'ACKNOWLEDGED',
    actor: { id: 'reviewer-1', kind: 'operator' },
    at: '2026-08-28T20:03:00.000Z',
  }],
}));
assert.equal(acknowledged.decision.decisionRevision, singleView.decision.decisionRevision);
assert.equal(acknowledged.riskRevision, 2);
const superseded = projectSharedReleaseView(viewInput(single, {
  riskLifecycleEvents: [{
    riskIdentity: singleView.riskRegister.risks[0].identity,
    action: 'SUPERSEDED',
    actor: { id: 'coordinator', kind: 'service' },
    at: '2026-08-28T20:05:00.000Z',
  }],
}));
assert.equal(superseded.riskRegister.risks.length, 1, 'Disappearing risk sources remain in history instead of being deleted.');
assert.equal(superseded.riskRegister.risks[0].reviewState, 'SUPERSEDED');
assert.equal(superseded.decision.decisionRevision, singleView.decision.decisionRevision);

for (const availability of ['LOADING', 'PROVISIONAL', 'PARTIAL', 'UNAVAILABLE', 'EMPTY', 'AVAILABLE']) {
  const sources = ['LOADING', 'UNAVAILABLE', 'EMPTY'].includes(availability) ? [] : [riskSource(single)];
  const projected = projectSharedReleaseView(viewInput(single, { riskAvailability: availability, riskSources: sources }));
  assert.equal(projected.riskRegister.availability, availability);
  if (availability === 'EMPTY') assert.equal(projected.riskRegister.risks.length, 0);
}

const envelope = appendPublicationEnvelope(null, {
  schemaVersion: 1,
  runId: 'run-single-site',
  runRevision: 1,
  decisionRevision: accepted.decision.decisionRevision,
  riskRevision: accepted.riskRevision,
  ledgerSequences: { observations: 1, decisions: 2, risks: 2 },
  finalSubjectDigest: single.finalSubject.digest,
  decision: accepted.decision,
  riskRegister: accepted.riskRegister,
});
const golden = projectPublicationView(envelope);
assert.deepEqual(golden.publication, {
  runId: envelope.runId,
  envelopeDigest: envelope.digest,
}, 'Every report projection must retain the exact selected publication binding.');
assert.deepEqual(projectSharedReleasePublication(envelope), golden);
assert.deepEqual(projectConsoleReleasePublication(envelope), golden);
assert.deepEqual(projectReportReleasePublication(envelope), golden);
assert.deepEqual(projectSiteHealthRelease(envelope), golden);
assert.deepEqual(projectArchiveReleasePublication(envelope), golden);
const controlSanitizedView = projectSharedReleaseView(viewInput(single, {
  riskSources: [riskSource(single, {
    explanation: sanitizedWorkerText.observations[0].explanation,
    recommendedAction: sanitizedWorkerText.observations[0].recommendedAction,
  })],
}));
const controlSanitizedEnvelope = appendPublicationEnvelope(null, {
  schemaVersion: 1,
  runId: 'run-single-site',
  runRevision: 1,
  decisionRevision: controlSanitizedView.decisionRevision,
  riskRevision: controlSanitizedView.riskRevision,
  ledgerSequences: { observations: 1, decisions: 1, risks: 1 },
  finalSubjectDigest: single.finalSubject.digest,
  decision: controlSanitizedView.decision,
  riskRegister: controlSanitizedView.riskRegister,
});
const archivePublicationBytes = Buffer.from(JSON.stringify(projectArchiveReleasePublication(controlSanitizedEnvelope)));
assert.match(archivePublicationBytes.toString('utf8'), /The hero is clipped\./u);
assert.doesNotMatch(archivePublicationBytes.toString('utf8'), /[\u001b\u202e]/u,
  'archive publication bytes must contain only the already-sanitized canonical text');
const globalRunRecord = sharedPublicationToConsoleIndexRecord({
  publication: envelope,
  parentRun: {
    runId: envelope.runId,
    status: 'active',
    workItems: {
      'work-terminal-pass': { id: 'work-terminal-pass', state: 'completed_pass' },
      'work-terminal-failure': { id: 'work-terminal-failure', state: 'completed_product_failure' },
    },
    createdAt: '2026-08-28T19:59:00.000Z',
    updatedAt: '2026-08-28T20:04:00.000Z',
  },
});
assert.equal(globalRunRecord.mode, 'single-site');
assert.equal(globalRunRecord.runId, envelope.runId);
assert.equal(globalRunRecord.sourceRevision, `shared-${envelope.runRevision}`);
assert.equal(globalRunRecord.fields.outcome, envelope.decision.code);
assert.equal(globalRunRecord.fields.authority, envelope.decision.grantedAuthority);
assert.equal(globalRunRecord.fields.findingCount, envelope.riskSummary.active);
assert.equal(globalRunRecord.fields.publicationRevision, envelope.digest);
assert.equal(globalRunRecord.fields.terminal, true,
  'Execution terminality must derive from canonical work items, not the mutable parent-run control status.');
assert.equal(globalRunRecord.fields.progressTotal, 2);
assert.equal(globalRunRecord.fields.progressCompleted, 2);
assert.equal(globalRunRecord.fields.finishedAt, '2026-08-28T20:04:00.000Z');
assert.deepEqual(globalRunRecord.fields.destinations, [
  `/run.html?mode=single-site&run=${envelope.runId}`,
  `/report.html?mode=single-site&run=${envelope.runId}`,
]);
const partialEnvelope = appendPublicationEnvelope(null, {
  schemaVersion: 1,
  runId: envelope.runId,
  runRevision: envelope.runRevision,
  decisionRevision: envelope.decisionRevision,
  riskRevision: envelope.riskRevision,
  ledgerSequences: envelope.ledgerSequences,
  finalSubjectDigest: envelope.finalSubjectDigest,
  decision: envelope.decision,
  riskRegister: { ...envelope.riskRegister, availability: 'PARTIAL' },
});
const partialRunRecord = sharedPublicationToConsoleIndexRecord({
  publication: partialEnvelope,
  parentRun: {
    runId: partialEnvelope.runId,
    status: 'active',
    workItems: { 'work-pass': { id: 'work-pass', state: 'completed_pass' } },
    createdAt: '2026-08-28T19:59:00.000Z',
    updatedAt: '2026-08-28T20:04:00.000Z',
  },
});
assert.equal(partialRunRecord.complete, false,
  'A partial Risk Register must keep the aggregate Runs source explicitly incomplete.');
assert.deepEqual(partialRunRecord.fields.limitations, ['risk-register-partial']);
const provisionalRunRecord = sharedParentRunToConsoleIndexRecord({
  publication: null,
  observedAt: '2026-08-28T20:01:10.000Z',
  coordinator: {
    ownerId: 'shared-coordinator', epoch: 7,
    expiresAt: '2026-08-28T20:02:00.000Z',
  },
  parentRun: {
    runId: 'run-comparative-provisional',
    runRevision: 3,
    status: 'active',
    compilationState: 'sealed',
    subjectCore: comparative.core,
    subjectCoreDigest: comparative.core.digest,
    createdAt: '2026-08-28T20:00:00.000Z',
    updatedAt: '2026-08-28T20:01:00.000Z',
    workItems: {
      'work-running': {
        id: 'work-running', state: 'running', capability: 'browser:chromium',
        attempts: [], diagnosticExecutions: [],
        lease: {
          workerId: 'worker-a', attempt: 1, epoch: 7,
          claimedAt: '2026-08-28T20:00:30.000Z', expiresAt: '2026-08-28T20:01:40.000Z',
        },
      },
      'work-recovering': {
        id: 'work-recovering', state: 'queued', capability: 'performance:lighthouse', lease: null,
        attempts: [{ attempt: 1, workerId: 'worker-performance', outcome: 'operational_failure', reason: 'lease-expired' }],
        diagnosticExecutions: [],
      },
    },
  },
});
assert.equal(provisionalRunRecord.mode, 'comparative');
assert.equal(provisionalRunRecord.complete, false);
assert.equal(provisionalRunRecord.fields.finalizationStatus, 'publication-unavailable');
assert.equal(provisionalRunRecord.fields.activityState, 'running');
assert.deepEqual(provisionalRunRecord.fields.reasonCodes, ['release-publication-unavailable']);
assert.doesNotMatch(provisionalRunRecord.fields.title, /no risks/iu,
  'An unpublished or unavailable risk projection must never masquerade as an empty register.');
const stalledRunRecord = sharedParentRunToConsoleIndexRecord({
  publication: null,
  observedAt: '2026-08-28T20:05:00.000Z',
  coordinator: {
    ownerId: 'shared-coordinator', epoch: 7,
    expiresAt: '2026-08-28T20:02:00.000Z',
  },
  parentRun: {
    ...provisionalRunRecord,
    runId: 'run-comparative-stalled',
    runRevision: 4,
    status: 'active',
    compilationState: 'sealed',
    subjectCore: comparative.core,
    subjectCoreDigest: comparative.core.digest,
    createdAt: '2026-08-28T20:00:00.000Z',
    updatedAt: '2026-08-28T20:01:00.000Z',
    workItems: {
      'work-queued': { id: 'work-queued', state: 'queued', capability: 'browser:chromium', lease: null, attempts: [], diagnosticExecutions: [] },
    },
  },
});
assert.equal(stalledRunRecord.fields.activityState, 'stalled',
  'queued shared work without a live coordinator must not be presented as running');
assert.deepEqual(stalledRunRecord.fields.reasonCodes,
  ['release-publication-unavailable', 'shared-coordinator-unavailable']);
const sharedTimeline = projectSharedParentTimeline('run-comparative-provisional', {
  subjectCore: comparative.core,
  updatedAt: '2026-08-28T20:01:00.000Z',
  workItems: {
    'work-running': {
      id: 'work-running', state: 'running', capability: 'browser:chromium', attempts: [], diagnosticExecutions: [],
      lease: { workerId: 'worker-a', attempt: 1, claimedAt: '2026-08-28T20:00:30.000Z', expiresAt: '2026-08-28T20:01:40.000Z' },
    },
    'work-recovering': {
      id: 'work-recovering', state: 'queued', capability: 'performance:lighthouse', lease: null,
      attempts: [{ attempt: 1, workerId: 'worker-performance', outcome: 'operational_failure', reason: 'lease-expired' }],
      diagnosticExecutions: [],
    },
  },
}, { sourceRevision: 'shared-state-3' });
assert.deepEqual(sharedTimeline.map(({ stageId, status, attempt, retry }) => ({ stageId, status, attempt, retry })), [
  { stageId: 'work-recovering', status: 'recovering:lease-expired', attempt: 1, retry: 1 },
  { stageId: 'work-running', status: 'running', attempt: 1, retry: 0 },
]);
const compilationFailure = sealInventoryCompilationFailure({
  schemaVersion: 1,
  subjectCoreDigest: single.core.digest,
  workItemId: 'inventory-barrier',
  terminalResultDigest: D1,
  reason: 'Inventory exhausted bounded recovery.',
  attemptCount: 3,
  failedAt: '2026-08-28T20:05:00.000Z',
});
const compilationFailureProjection = projectCompilationFailureView({
  schemaVersion: 1,
  runId: 'run-single-compilation-failed',
  decisionRevision: 1,
  riskRevision: 1,
  subjectCore: single.core,
  compilationFailure,
});
const compilationFailureEnvelope = appendPublicationEnvelope(null, {
  schemaVersion: 1,
  runId: 'run-single-compilation-failed',
  runRevision: 1,
  decisionRevision: 1,
  riskRevision: 1,
  ledgerSequences: { observations: 4, decisions: 1, risks: 0 },
  subjectCoreDigest: single.core.digest,
  finalSubjectDigest: null,
  decision: compilationFailureProjection.decision,
  riskRegister: compilationFailureProjection.riskRegister,
});
const compilationFailureRunRecord = sharedPublicationToConsoleIndexRecord({
  publication: compilationFailureEnvelope,
  parentRun: {
    runId: compilationFailureEnvelope.runId,
    runRevision: 5,
    status: 'active',
    compilationState: 'failed',
    subjectCore: single.core,
    subjectCoreDigest: single.core.digest,
    workItems: { 'inventory-barrier': { id: 'inventory-barrier', state: 'incomplete' } },
    createdAt: '2026-08-28T20:00:00.000Z',
    updatedAt: '2026-08-28T20:05:00.000Z',
  },
});
assert.equal(compilationFailureRunRecord.fields.terminal, true);
assert.equal(compilationFailureRunRecord.fields.status, 'completed-not-ready');
assert.equal(compilationFailureRunRecord.fields.phase, 'release-published');
assert.equal(compilationFailureRunRecord.fields.outcome, 'NOT_READY_INCOMPLETE_EXECUTION');
assert.equal(compilationFailureRunRecord.fields.authority, 'NOT_GRANTED');
assert.equal(compilationFailureRunRecord.fields.evidenceAuthorityStatus, 'core-bound-incomplete');
assert.equal(compilationFailureRunRecord.fields.activityState, 'idle');
assert.deepEqual(parseChecklistRelease(envelope, 'release/publication/current.json'), golden.releaseTruth);
const manifest = applySharedReleaseEligibility({}, envelope, 'Shared finalization');
assert.deepEqual(manifest.sharedRelease, golden);
assert.equal(canonicalDigest(manifest.sharedRelease), canonicalDigest(golden));

console.log('Shared release projections self-test passed.');
