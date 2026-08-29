import assert from 'node:assert/strict';
import {
  canonicalDigest,
  canonicalJson,
  ContractError,
} from '../shared/canonical-contract.mjs';
import {
  parseFinalReleaseSubject,
  parseReleaseSubjectCore,
  sealFinalReleaseSubject,
  sealReleaseSubjectCore,
} from '../shared/release-subject.mjs';
import {
  parseExecutionManifest,
  parseOracleResult,
  parseWorkItemResult,
  sealExecutionManifest,
  sealOracleResult,
  sealWorkItemResult,
} from '../shared/execution-contract.mjs';
import {
  parseWorkItemEvidenceIndex,
  sealWorkItemEvidenceIndex,
} from '../shared/work-item-evidence-index.mjs';
import {
  assertConsumableReleaseDecision,
  deriveReleaseDecision,
  parseReleaseDecision,
} from '../shared/release-decision.mjs';
import {
  parseRiskRegister,
  riskIdentity,
} from '../shared/risk-contract.mjs';
import {
  appendPublicationEnvelope,
  parsePublicationEnvelope,
  verifyPublicationChain,
} from '../shared/publication-envelope.mjs';
import { parseChecklistRelease, releaseOutcome } from './lib/release-truth.mjs';
import { applySharedReleaseEligibility } from '../portal/release-eligibility.mjs';
import { projectSharedReleasePublication } from '../reporters/report-model.ts';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function expectCode(code, operation) {
  assert.throws(operation, (error) => error instanceof ContractError && error.code === code);
}

function subjectInput(overrides = {}) {
  return {
    schemaVersion: 1,
    deploymentIdentity: { kind: 'build', value: 'build-2026-08-28.1' },
    targets: [{ role: 'candidate', origin: 'https://beta.example.test' }],
    mode: 'single-site',
    requestedAuthority: {
      qualifier: 'FULL',
      scope: { features: ['site'], definitions: ['HOME-001'], targets: ['desktop-chromium'], knownLimits: [] },
    },
    revisions: {
      runner: DIGEST_A,
      plugins: DIGEST_A,
      targets: DIGEST_A,
      configuration: DIGEST_A,
    },
    environmentIdentity: DIGEST_B,
    certificatePolicy: 'strict',
    ...overrides,
  };
}

function workResult(subjectCoreDigest, overrides = {}) {
  return sealWorkItemResult({
    schemaVersion: 1,
    workItemId: 'work-home',
    subjectCoreDigest,
    attempt: 1,
    authoritative: true,
    outcome: 'completed_pass',
    evidenceDigests: [DIGEST_A],
    ...overrides,
  });
}

function fullSingleSiteFixture() {
  const subjectCore = sealReleaseSubjectCore(subjectInput());
  const executionManifest = sealExecutionManifest({
    schemaVersion: 1,
    subjectCoreDigest: subjectCore.digest,
    workItems: [{ id: 'work-home', definitionId: 'HOME-001', targetId: 'desktop-chromium', targetRole: 'candidate' }],
    oracleExecutions: [{ id: 'oracle-home', definitionId: 'HOME-001', requiredWorkItemIds: ['work-home'] }],
    contextWorkItemIds: [],
  });
  const finalSubject = sealFinalReleaseSubject({
    schemaVersion: 1,
    subjectCore,
    executionManifest,
    grantedAuthority: subjectCore.requestedAuthority,
    coverageBasis: { selectedDefinitions: ['HOME-001'], selectedTargets: ['desktop-chromium'], excludedAsNotApplicable: [] },
    deploymentIdentityRecheck: subjectCore.deploymentIdentity,
  });
  const item = workResult(subjectCore.digest);
  const oracle = sealOracleResult({
    schemaVersion: 1,
    oracleExecution: executionManifest.oracleExecutions[0],
    finalSubjectDigest: finalSubject.digest,
    workItemResults: [item],
  });
  return { subjectCore, executionManifest, finalSubject, workItemResults: [item], oracleResults: [oracle] };
}

const canonicalLeft = { z: 3, a: { beta: true, alpha: ['x', 2] } };
const canonicalRight = { a: { alpha: ['x', 2], beta: true }, z: 3 };
assert.equal(canonicalJson(canonicalLeft), canonicalJson(canonicalRight));
assert.equal(canonicalDigest(canonicalLeft), canonicalDigest(canonicalRight));
expectCode('UNSUPPORTED_CANONICAL_VALUE', () => canonicalJson({ nope: undefined }));

const full = fullSingleSiteFixture();
assert.deepEqual(parseReleaseSubjectCore(full.subjectCore), full.subjectCore);
assert.deepEqual(parseExecutionManifest(full.executionManifest), full.executionManifest);
assert.deepEqual(parseFinalReleaseSubject(full.finalSubject), full.finalSubject);
assert.deepEqual(parseWorkItemResult(full.workItemResults[0]), full.workItemResults[0]);
const repeatedEvidence = sealWorkItemResult({
  schemaVersion: 1,
  workItemId: 'work-repeated-evidence',
  subjectCoreDigest: full.subjectCore.digest,
  attempt: 1,
  authoritative: true,
  outcome: 'completed_pass',
  evidenceDigests: [DIGEST_A, DIGEST_A],
});
assert.deepEqual(repeatedEvidence.evidenceDigests, [DIGEST_A, DIGEST_A]);
assert.deepEqual(parseWorkItemResult(repeatedEvidence), repeatedEvidence);
const logicalEvidenceIndex = sealWorkItemEvidenceIndex({
  workItemId: 'work-repeated-evidence',
  executionDescriptorDigest: DIGEST_B,
  row: {
    caseId: 'HOME-001:fixture', definitionId: 'HOME-001', entrySpec: 'tests/smoke.spec.ts',
    targetId: 'desktop-chromium', status: 'passed',
    evidencePolicy: { mode: 'static-screenshot', rationale: 'Capture the rendered home page for review.' },
  },
  members: [
    { logicalName: 'wide-home', purpose: 'primary', mediaType: 'image/png', sizeBytes: 10, contentDigest: DIGEST_A, transportPath: 'screens/wide.png' },
    { logicalName: 'narrow-home', purpose: 'primary', mediaType: 'image/png', sizeBytes: 10, contentDigest: DIGEST_A, transportPath: 'screens/narrow.png' },
  ],
});
assert.notEqual(logicalEvidenceIndex.members[0].memberDigest, logicalEvidenceIndex.members[1].memberDigest);
assert.deepEqual(parseWorkItemEvidenceIndex(logicalEvidenceIndex), logicalEvidenceIndex);
expectCode('INVALID_EVIDENCE_INDEX', () => parseWorkItemEvidenceIndex({
  ...logicalEvidenceIndex,
  members: null,
}));
assert.deepEqual(parseOracleResult(full.oracleResults[0]), full.oracleResults[0]);
const fullDecision = deriveReleaseDecision({
  schemaVersion: 1,
  runId: 'run-single-full',
  decisionRevision: 1,
  finalSubject: full.finalSubject,
  executionManifest: full.executionManifest,
  oracleResults: full.oracleResults,
  releaseDispositions: [],
});
assert.equal(fullDecision.code, 'RELEASE_READY');
assert.equal(fullDecision.label, 'RELEASE READY');
assert.equal(fullDecision.exitCode, 0);
assert.deepEqual(parseReleaseDecision(fullDecision), fullDecision);
const invalidScopeDecision = {
  ...fullDecision,
  certifiedScope: { ...fullDecision.certifiedScope, features: [] },
};
delete invalidScopeDecision.digest;
invalidScopeDecision.digest = canonicalDigest(invalidScopeDecision);
expectCode('INVALID_CONTRACT', () => parseReleaseDecision(invalidScopeDecision));
const invalidReasonDecision = {
  ...failureShape(fullDecision),
};
function failureShape(decision) {
  const body = {
    ...decision,
    code: 'NOT_READY_TEST_FAILURE',
    label: 'NOT READY — TEST FAILURE',
    ready: false,
    exitCode: 1,
    blockingReasons: [{ class: 'invented-failure', executionId: 'oracle-home', detail: 'Invalid taxonomy.' }],
  };
  delete body.digest;
  return { ...body, digest: canonicalDigest(body) };
}
expectCode('INVALID_CONTRACT', () => parseReleaseDecision(invalidReasonDecision));

const targetedCore = sealReleaseSubjectCore(subjectInput({
  requestedAuthority: {
    qualifier: 'TARGETED',
    scope: {
      features: ['navigation', 'search'],
      definitions: ['NAV-001', 'SEARCH-001'],
      targets: ['desktop-chromium'],
      knownLimits: ['Checkout is outside the selected scope.'],
    },
  },
}));
const targetedManifest = sealExecutionManifest({
  schemaVersion: 1,
  subjectCoreDigest: targetedCore.digest,
  workItems: [
    { id: 'work-nav', definitionId: 'NAV-001', targetId: 'desktop-chromium', targetRole: 'candidate' },
    { id: 'work-search', definitionId: 'SEARCH-001', targetId: 'desktop-chromium', targetRole: 'candidate' },
  ],
  oracleExecutions: [
    { id: 'oracle-nav', definitionId: 'NAV-001', requiredWorkItemIds: ['work-nav'] },
    { id: 'oracle-search', definitionId: 'SEARCH-001', requiredWorkItemIds: ['work-search'] },
  ],
  contextWorkItemIds: [],
});
const targetedSubject = sealFinalReleaseSubject({
  schemaVersion: 1,
  subjectCore: targetedCore,
  executionManifest: targetedManifest,
  grantedAuthority: targetedCore.requestedAuthority,
  coverageBasis: { selectedDefinitions: ['NAV-001', 'SEARCH-001'], selectedTargets: ['desktop-chromium'], excludedAsNotApplicable: [] },
  deploymentIdentityRecheck: targetedCore.deploymentIdentity,
});
const targetedOracles = targetedManifest.oracleExecutions.map((oracleExecution) => sealOracleResult({
  schemaVersion: 1,
  oracleExecution,
  finalSubjectDigest: targetedSubject.digest,
  workItemResults: [workResult(targetedCore.digest, { workItemId: oracleExecution.requiredWorkItemIds[0] })],
}));
const targetedDecision = deriveReleaseDecision({
  schemaVersion: 1,
  runId: 'run-single-targeted',
  decisionRevision: 1,
  finalSubject: targetedSubject,
  executionManifest: targetedManifest,
  oracleResults: targetedOracles,
  releaseDispositions: [],
});
assert.equal(targetedDecision.code, 'FEATURE_READY');
assert.deepEqual(targetedDecision.certifiedScope.features, ['navigation', 'search']);

expectCode('EMPTY_EXECUTION_MANIFEST', () => sealExecutionManifest({
  schemaVersion: 1,
  subjectCoreDigest: full.subjectCore.digest,
  workItems: [],
  oracleExecutions: [],
  contextWorkItemIds: [],
}));
expectCode('UNDECLARED_WORK_ITEM', () => sealExecutionManifest({
  schemaVersion: 1,
  subjectCoreDigest: full.subjectCore.digest,
  workItems: [{ id: 'work-home', definitionId: 'HOME-001', targetId: 'desktop-chromium', targetRole: 'candidate' }],
  oracleExecutions: [{ id: 'oracle-home', definitionId: 'HOME-001', requiredWorkItemIds: ['work-home'] }],
  contextWorkItemIds: ['work-missing'],
}));
expectCode('CONTEXT_WORK_ADOPTED', () => sealExecutionManifest({
  schemaVersion: 1,
  subjectCoreDigest: full.subjectCore.digest,
  workItems: [{ id: 'work-home', definitionId: 'HOME-001', targetId: 'desktop-chromium', targetRole: 'candidate' }],
  oracleExecutions: [{ id: 'oracle-home', definitionId: 'HOME-001', requiredWorkItemIds: ['work-home'] }],
  contextWorkItemIds: ['work-home'],
}));
expectCode('UNADOPTED_WORK_ITEM', () => sealExecutionManifest({
  schemaVersion: 1,
  subjectCoreDigest: full.subjectCore.digest,
  workItems: [
    { id: 'work-home', definitionId: 'HOME-001', targetId: 'desktop-chromium', targetRole: 'candidate' },
    { id: 'work-unclassified', definitionId: 'HOME-001', targetId: 'desktop-chromium', targetRole: 'production' },
  ],
  oracleExecutions: [{ id: 'oracle-home', definitionId: 'HOME-001', requiredWorkItemIds: ['work-home'] }],
  contextWorkItemIds: [],
}));
expectCode('ORACLE_DEFINITION_MISMATCH', () => sealExecutionManifest({
  schemaVersion: 1,
  subjectCoreDigest: full.subjectCore.digest,
  workItems: [{ id: 'work-home', definitionId: 'OTHER-001', targetId: 'desktop-chromium', targetRole: 'candidate' }],
  oracleExecutions: [{ id: 'oracle-home', definitionId: 'HOME-001', requiredWorkItemIds: ['work-home'] }],
  contextWorkItemIds: [],
}));
expectCode('UNDECLARED_EXECUTION_RESULT', () => deriveReleaseDecision({
  schemaVersion: 1,
  runId: 'run-extra-result',
  decisionRevision: 1,
  finalSubject: full.finalSubject,
  executionManifest: full.executionManifest,
  oracleResults: [...full.oracleResults, { ...full.oracleResults[0], oracleExecutionId: 'oracle-extra' }],
  releaseDispositions: [],
}));
expectCode('AUTHORITY_SCOPE_MISMATCH', () => sealFinalReleaseSubject({
  schemaVersion: 1,
  subjectCore: full.subjectCore,
  executionManifest: full.executionManifest,
  grantedAuthority: { ...full.subjectCore.requestedAuthority, qualifier: 'TARGETED' },
  coverageBasis: { selectedDefinitions: ['HOME-001'], selectedTargets: ['desktop-chromium'], excludedAsNotApplicable: [] },
  deploymentIdentityRecheck: full.subjectCore.deploymentIdentity,
}));
expectCode('AUTHORITY_SCOPE_MISMATCH', () => sealFinalReleaseSubject({
  schemaVersion: 1,
  subjectCore: full.subjectCore,
  executionManifest: full.executionManifest,
  grantedAuthority: full.subjectCore.requestedAuthority,
  coverageBasis: { selectedDefinitions: ['HOME-001'], selectedTargets: ['mobile-webkit'], excludedAsNotApplicable: [] },
  deploymentIdentityRecheck: full.subjectCore.deploymentIdentity,
}));
expectCode('RELEASE_SUBJECT_MISMATCH', () => sealFinalReleaseSubject({
  schemaVersion: 1,
  subjectCore: full.subjectCore,
  executionManifest: full.executionManifest,
  grantedAuthority: full.subjectCore.requestedAuthority,
  coverageBasis: { selectedDefinitions: ['HOME-001'], selectedTargets: ['desktop-chromium'], excludedAsNotApplicable: [] },
  deploymentIdentityRecheck: { kind: 'build', value: 'changed-build' },
}));
expectCode('STALE_RELEASE_SUBJECT', () => assertConsumableReleaseDecision(fullDecision, {
  expectedSubjectDigest: DIGEST_A,
  expectedAuthority: 'FULL',
  currentDecisionRevision: 1,
}));
expectCode('STALE_DECISION_REVISION', () => assertConsumableReleaseDecision(fullDecision, {
  expectedSubjectDigest: full.finalSubject.digest,
  expectedAuthority: 'FULL',
  currentDecisionRevision: 2,
}));
expectCode('UNSUPPORTED_SCHEMA_VERSION', () => sealReleaseSubjectCore({ ...subjectInput(), schemaVersion: 2 }));

const riskBase = {
  schemaVersion: 1,
  category: 'manual-check',
  severity: 'medium',
  mode: 'single-site',
  scope: full.subjectCore.requestedAuthority.scope,
  source: { kind: 'manual-obligation', id: 'manual-accessibility-review' },
  explanation: 'A keyboard review remains outstanding.',
  recommendedAction: 'Complete the keyboard review.',
  reviewState: 'OPEN',
  releaseEffect: 'non-blocking',
  actor: { id: 'compiler', kind: 'service' },
  observedAt: '2026-08-28T19:00:00.000Z',
  updatedAt: '2026-08-28T19:00:00.000Z',
};
const riskRecords = [
  riskBase,
  { ...riskBase, category: 'coverage-gap', source: { kind: 'coverage', id: 'missing-checkout' }, explanation: 'Checkout is outside coverage.', recommendedAction: 'Add checkout coverage.' },
  { ...riskBase, category: 'certificate-bypass', source: { kind: 'configuration', id: 'preview-tls-bypass' }, explanation: 'Development certificate bypass is active.', recommendedAction: 'Restore strict certificate validation.' },
  { ...riskBase, category: 'unreviewed-visual-change', source: { kind: 'visual-result', id: 'hero-changed' }, explanation: 'A visual change awaits review.', recommendedAction: 'Review the visual comparison.', reviewState: 'PENDING_REVIEW' },
];
const risks = parseRiskRegister({ schemaVersion: 1, availability: 'AVAILABLE', risks: riskRecords });
assert.equal(risks.risks.find(({ category }) => category === 'manual-check').identity, riskIdentity(riskBase));
const decisionWithRisksNearby = deriveReleaseDecision({
  schemaVersion: 1,
  runId: 'run-single-full',
  decisionRevision: 1,
  finalSubject: full.finalSubject,
  executionManifest: full.executionManifest,
  oracleResults: full.oracleResults,
  releaseDispositions: [],
});
assert.deepEqual(decisionWithRisksNearby, fullDecision, 'risk lifecycle state cannot enter release derivation');
for (const availability of ['LOADING', 'PROVISIONAL', 'PARTIAL', 'EMPTY', 'UNAVAILABLE']) {
  const register = parseRiskRegister({
    schemaVersion: 1,
    availability,
    risks: ['LOADING', 'EMPTY', 'UNAVAILABLE'].includes(availability) ? [] : [riskBase],
  });
  assert.equal(register.availability, availability);
}

const failedItem = workResult(full.subjectCore.digest, { outcome: 'completed_product_failure' });
const diagnosticPass = workResult(full.subjectCore.digest, { attempt: 2, authoritative: false });
assert.equal(diagnosticPass.authoritative, false);
const failureOracle = sealOracleResult({
  schemaVersion: 1,
  oracleExecution: full.executionManifest.oracleExecutions[0],
  finalSubjectDigest: full.finalSubject.digest,
  workItemResults: [failedItem],
});
const failureDecision = deriveReleaseDecision({
  schemaVersion: 1,
  runId: 'run-product-failure',
  decisionRevision: 1,
  finalSubject: full.finalSubject,
  executionManifest: full.executionManifest,
  oracleResults: [failureOracle],
  releaseDispositions: [],
});
assert.equal(failureDecision.code, 'NOT_READY_TEST_FAILURE');
assert.deepEqual(failureDecision.blockingReasons.map(({ class: reasonClass }) => reasonClass), ['product-failure']);
assert.equal(deriveReleaseDecision({
  schemaVersion: 1,
  runId: 'run-product-failure',
  decisionRevision: 1,
  finalSubject: full.finalSubject,
  executionManifest: full.executionManifest,
  oracleResults: [failureOracle],
  releaseDispositions: [],
}).code, 'NOT_READY_TEST_FAILURE', 'a later diagnostic pass cannot replace the canonical product failure');
expectCode('UNAUTHORIZED_RELEASE_DISPOSITION', () => deriveReleaseDecision({
  schemaVersion: 1,
  runId: 'run-visual-disposition',
  decisionRevision: 2,
  finalSubject: full.finalSubject,
  executionManifest: full.executionManifest,
  oracleResults: full.oracleResults,
  releaseDispositions: [{ kind: 'visual-defect', executionId: 'oracle-home', reason: 'Confirmed defect.' }],
}));
assert.equal(deriveReleaseDecision({
  schemaVersion: 1,
  runId: 'run-visual-disposition',
  decisionRevision: 2,
  finalSubject: full.finalSubject,
  executionManifest: full.executionManifest,
  oracleResults: full.oracleResults,
  releaseDispositions: [{
    kind: 'visual-defect',
    executionId: 'oracle-home',
    reason: 'Confirmed defect.',
    authorized: true,
    actor: { id: 'reviewer-1', kind: 'reviewer' },
  }],
}).code, 'NOT_READY_TEST_FAILURE');
const incompleteOracle = sealOracleResult({
  schemaVersion: 1,
  oracleExecution: full.executionManifest.oracleExecutions[0],
  finalSubjectDigest: full.finalSubject.digest,
  workItemResults: [workResult(full.subjectCore.digest, { outcome: 'operational_failure' })],
});
assert.equal(deriveReleaseDecision({
  schemaVersion: 1,
  runId: 'run-incomplete',
  decisionRevision: 1,
  finalSubject: full.finalSubject,
  executionManifest: full.executionManifest,
  oracleResults: [incompleteOracle],
  releaseDispositions: [],
}).code, 'NOT_READY_INCOMPLETE_EXECUTION');

const comparativeCore = sealReleaseSubjectCore(subjectInput({
  mode: 'comparative',
  targets: [
    { role: 'candidate', origin: 'https://beta.example.test' },
    { role: 'production', origin: 'https://example.test' },
  ],
}));
const comparativeManifest = sealExecutionManifest({
  schemaVersion: 1,
  subjectCoreDigest: comparativeCore.digest,
  workItems: [
    { id: 'work-candidate', definitionId: 'HOME-001', targetId: 'desktop-chromium', targetRole: 'candidate' },
    { id: 'work-production', definitionId: 'HOME-001', targetId: 'desktop-chromium', targetRole: 'production' },
  ],
  oracleExecutions: [{ id: 'oracle-paired', definitionId: 'HOME-001', requiredWorkItemIds: ['work-candidate', 'work-production'] }],
  contextWorkItemIds: [],
});
const comparativeSubject = sealFinalReleaseSubject({
  schemaVersion: 1,
  subjectCore: comparativeCore,
  executionManifest: comparativeManifest,
  grantedAuthority: comparativeCore.requestedAuthority,
  coverageBasis: { selectedDefinitions: ['HOME-001'], selectedTargets: ['desktop-chromium'], excludedAsNotApplicable: [] },
  deploymentIdentityRecheck: comparativeCore.deploymentIdentity,
});
expectCode('ORACLE_ADOPTION_INCOMPLETE', () => sealOracleResult({
  schemaVersion: 1,
  oracleExecution: comparativeManifest.oracleExecutions[0],
  finalSubjectDigest: comparativeSubject.digest,
  workItemResults: [workResult(comparativeCore.digest, { workItemId: 'work-candidate' })],
}));
const comparativeOracle = sealOracleResult({
  schemaVersion: 1,
  oracleExecution: comparativeManifest.oracleExecutions[0],
  finalSubjectDigest: comparativeSubject.digest,
  workItemResults: [
    workResult(comparativeCore.digest, { workItemId: 'work-production' }),
    workResult(comparativeCore.digest, { workItemId: 'work-candidate' }),
  ],
});
assert.deepEqual(comparativeOracle.adoptedWorkItemIds, ['work-candidate', 'work-production']);
const mixedFailureOracle = sealOracleResult({
  schemaVersion: 1,
  oracleExecution: comparativeManifest.oracleExecutions[0],
  finalSubjectDigest: comparativeSubject.digest,
  workItemResults: [
    workResult(comparativeCore.digest, { workItemId: 'work-candidate', outcome: 'completed_product_failure' }),
    workResult(comparativeCore.digest, { workItemId: 'work-production', outcome: 'operational_failure' }),
  ],
});
const mixedFailureDecision = deriveReleaseDecision({
  schemaVersion: 1,
  runId: 'run-comparative-mixed-failure',
  decisionRevision: 1,
  finalSubject: comparativeSubject,
  executionManifest: comparativeManifest,
  oracleResults: [mixedFailureOracle],
  releaseDispositions: [],
});
assert.equal(mixedFailureDecision.code, 'NOT_READY_TEST_FAILURE');
assert.deepEqual(mixedFailureDecision.blockingReasons.map(({ class: reasonClass }) => reasonClass), ['product-failure', 'operational-incident']);

const envelope1 = appendPublicationEnvelope(null, {
  schemaVersion: 1,
  runId: 'run-single-full',
  runRevision: 1,
  decisionRevision: 1,
  riskRevision: 1,
  ledgerSequences: { observations: 4, decisions: 1, risks: 1 },
  finalSubjectDigest: full.finalSubject.digest,
  decision: fullDecision,
  riskRegister: risks,
});
assert.deepEqual(parsePublicationEnvelope(envelope1), envelope1);
expectCode('CORRUPT_PUBLICATION_ENVELOPE', () => appendPublicationEnvelope(envelope1, {
  schemaVersion: 1,
  runId: envelope1.runId,
  runRevision: 2,
  decisionRevision: 1,
  riskRevision: 1,
  ledgerSequences: { observations: 4, decisions: 1, risks: 2 },
  finalSubjectDigest: envelope1.finalSubjectDigest,
  decision: envelope1.decision,
  riskRegister: parseRiskRegister({
    schemaVersion: 1,
    availability: 'AVAILABLE',
    risks: [{ ...riskBase, reviewState: 'ACKNOWLEDGED', updatedAt: '2026-08-28T19:05:00.000Z' }],
  }),
}));
const envelope2 = appendPublicationEnvelope(envelope1, {
  schemaVersion: 1,
  runId: envelope1.runId,
  runRevision: 2,
  decisionRevision: 1,
  riskRevision: 2,
  ledgerSequences: { observations: 4, decisions: 1, risks: 2 },
  finalSubjectDigest: envelope1.finalSubjectDigest,
  decision: envelope1.decision,
  riskRegister: parseRiskRegister({
    schemaVersion: 1,
    availability: 'AVAILABLE',
    risks: riskRecords.map((risk) => risk.category === 'manual-check'
      ? { ...risk, reviewState: 'ACKNOWLEDGED', updatedAt: '2026-08-28T19:05:00.000Z' }
      : risk),
  }),
});
assert.equal(envelope2.decisionRevision, envelope1.decisionRevision, 'risk-only events do not revise release truth');
assert.equal(parsePublicationEnvelope(envelope2).digest, envelope2.digest);
assert.equal(verifyPublicationChain([envelope1, envelope2]).length, 2);
expectCode('CORRUPT_DIGEST_CHAIN', () => verifyPublicationChain([envelope1, { ...envelope2, previousEnvelopeDigest: DIGEST_A }]));

const compatibilityRelease = parseChecklistRelease(envelope2, 'release/publication/current.json');
assert.equal(compatibilityRelease.decisionCode, 'RELEASE_READY');
assert.equal(compatibilityRelease.riskSummary.active, 4);
assert.deepEqual(releaseOutcome('completed', envelope2.decision), { status: 'ready', exitCode: 0 });
const eligibility = applySharedReleaseEligibility({}, envelope2, 'shared finalization');
assert.equal(eligibility.status, 'passed');
assert.match(eligibility.phase, /RELEASE READY · RISKS FLAGGED \(4\)/);
const reportProjection = projectSharedReleasePublication(envelope2);
assert.equal(reportProjection.subjectDigest, full.finalSubject.digest);
assert.deepEqual(reportProjection.revisions, { run: 2, decision: 1, risk: 2 });

process.stdout.write(`${JSON.stringify({
  singleSite: { subject: full.finalSubject.digest, decision: fullDecision.code },
  comparative: { subject: comparativeSubject.digest, oracle: comparativeOracle.outcome },
}, null, 2)}\n`);
process.stdout.write('Shared release contracts self-test passed.\n');
