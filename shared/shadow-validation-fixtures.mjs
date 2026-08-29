export {
  SHADOW_ACCEPTANCE_CASE_IDS,
  SHADOW_COMPARATIVE_FAILURE_SCENARIOS,
  SHADOW_CORRUPTION_CASE_IDS,
  SHADOW_PRE_REGISTERED_MATRIX_DIGEST,
} from './shadow-validation-matrix-contract.mjs';

const DEFAULT_TARGETS = Object.freeze(['candidate-mobile-chromium']);

function source(kind, caseId, overrides = {}) {
  const requiredExecutionIds = overrides.requiredExecutionIds ?? [`${caseId.toLowerCase()}-execution`];
  return {
    schemaVersion: 1,
    kind,
    caseId,
    mode: overrides.mode ?? 'single-site',
    requestedScope: overrides.requestedScope ?? 'FULL',
    grantedScope: overrides.grantedScope ?? overrides.requestedScope ?? 'FULL',
    selectedFeatures: overrides.selectedFeatures ?? ['site'],
    selectedDefinitions: overrides.selectedDefinitions ?? [`${caseId.toLowerCase()}-definition`],
    selectedTargets: overrides.selectedTargets ?? DEFAULT_TARGETS,
    knownLimits: overrides.knownLimits ?? [],
    requiredExecutionIds,
    results: overrides.results ?? requiredExecutionIds.map((executionId) => ({
      executionId,
      classification: 'COMPLETED_PASS',
    })),
    riskAvailability: overrides.riskAvailability ?? 'EMPTY',
    riskCategories: overrides.riskCategories ?? [],
    outcomeCode: overrides.outcomeCode ?? (overrides.requestedScope === 'TARGETED' ? 'FEATURE_READY' : 'RELEASE_READY'),
  };
}

function pair(caseId, title, governingRequirements, legacyOverrides = {}, sharedOverrides = legacyOverrides) {
  return {
    caseId,
    title,
    governingRequirements,
    legacy: source('legacy-shadow-source', caseId, legacyOverrides),
    shared: source('shared-shadow-source', caseId, sharedOverrides),
  };
}

function releaseSemantics(requestedScope, grantedScope, outcomeCode) {
  return { requestedScope, grantedScope, outcomeCode };
}

function classifications(entries) {
  return entries.map(([executionId, classification]) => ({ executionId, classification }));
}

function reviewedDifference({
  caseId,
  dimension,
  reasonCode,
  governingRequirements,
  legacySemantic,
  sharedSemantic,
}) {
  return {
    caseId,
    dimension,
    reasonCode,
    governingRequirements,
    reviewed: true,
    legacySemantic,
    sharedSemantic,
  };
}

export function buildPreRegisteredShadowMatrix() {
  const cases = [
    pair('AE1', 'Full Single-site with manual work outstanding', ['R1', 'R3', 'R6', 'R9', 'R12', 'R19'], {
      riskAvailability: 'AVAILABLE', riskCategories: ['MANUAL_CHECK'],
    }),
    pair('AE2', 'Targeted feature validation', ['R3', 'R19'], {
      requestedScope: 'TARGETED',
      selectedFeatures: ['navigation', 'search'],
      selectedDefinitions: ['navigation-links', 'site-search'],
      requiredExecutionIds: ['navigation-execution', 'search-execution'],
    }),
    pair('AE3', 'Known coverage gap with passing executions', ['R3', 'R6', 'R9'], {
      riskAvailability: 'AVAILABLE', riskCategories: ['COVERAGE_GAP'], knownLimits: ['untested-route'],
    }),
    pair('AE4', 'Visual change awaiting review', ['R4', 'R6', 'R12'], {
      riskAvailability: 'AVAILABLE', riskCategories: ['UNREVIEWED_VISUAL_CHANGE'],
    }),
    pair('AE5', 'Worker cannot recover', ['R5', 'R14', 'R15', 'R16', 'R17'], {
      results: [{ executionId: 'ae5-execution', classification: 'INCOMPLETE_UNKNOWN' }],
      outcomeCode: 'NOT_READY_INCOMPLETE_EXECUTION',
      riskAvailability: 'AVAILABLE',
      riskCategories: ['PIPELINE_LIMITATION'],
    }),
    pair('AE6', 'Existing production defect', ['R6', 'R7', 'R21'], {
      mode: 'comparative',
      selectedTargets: ['candidate-mobile-chromium', 'production-mobile-chromium'],
      riskAvailability: 'AVAILABLE',
      riskCategories: ['PRODUCTION_BASELINE_DEFECT'],
    }),
    pair('AE7', 'Candidate regression', ['R4', 'R7', 'R21'], {
      mode: 'comparative',
      selectedTargets: ['candidate-mobile-chromium', 'production-mobile-chromium'],
      results: [{ executionId: 'ae7-execution', classification: 'COMPLETED_PRODUCT_FAILURE' }],
      outcomeCode: 'NOT_READY_TEST_FAILURE',
    }),
    pair('AE8', 'CD consumes a ready result with non-blocking risks', ['R3', 'R6', 'R19', 'R20', 'R23', 'R25'], {
      riskAvailability: 'AVAILABLE', riskCategories: ['MANUAL_CHECK'],
    }),
    pair('AE9', 'Requested authority does not match execution scope', ['R3', 'R19', 'R20'], {
      requestedScope: 'FULL', grantedScope: 'FULL', requiredExecutionIds: [], results: [], outcomeCode: 'RELEASE_READY',
    }, {
      requestedScope: 'FULL', grantedScope: 'NONE', requiredExecutionIds: [], results: [], outcomeCode: 'REJECTED_SCOPE_MISMATCH',
    }),
    pair('AE10', 'Late visual defect review supersedes ready evidence', ['R4', 'R12', 'R24', 'R25'], {
      riskAvailability: 'AVAILABLE', riskCategories: ['UNREVIEWED_VISUAL_CHANGE'],
    }, {
      results: [{ executionId: 'ae10-execution', classification: 'COMPLETED_PRODUCT_FAILURE' }],
      outcomeCode: 'NOT_READY_TEST_FAILURE',
      riskAvailability: 'AVAILABLE', riskCategories: ['VISUAL_DEFECT'],
    }),
    pair('AE11', 'Rekick targets a changed deployment', ['R16', 'R17', 'R23'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_SUBJECT_MISMATCH',
    }),
    pair('AE12', 'Risk data is unavailable', ['R26'], {
      riskAvailability: 'UNAVAILABLE',
    }),
    pair('AE13', 'Unauthorized or duplicate mutation is bounded', ['R16', 'R24'], {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_UNAUTHORIZED',
    }),
    pair('AE14', 'Development certificate bypass remains visible', ['R9', 'R27'], {
      riskAvailability: 'AVAILABLE', riskCategories: ['CERTIFICATE_BYPASS'], knownLimits: ['certificate-validation-bypassed'],
    }),
    pair('AE15', 'Comparison-only definition is not applicable in Single-site', ['R18', 'R22'], {
      selectedDefinitions: ['standalone-definition'], knownLimits: ['comparison-only-definition:not-applicable'],
    }),
    pair('AE16', 'Assertion rerun is diagnostic only', ['R4', 'R14', 'R23', 'R28'], {
      results: [{ executionId: 'ae16-execution', classification: 'COMPLETED_PASS' }], outcomeCode: 'RELEASE_READY',
    }, {
      results: [{ executionId: 'ae16-execution', classification: 'COMPLETED_PRODUCT_FAILURE' }], outcomeCode: 'NOT_READY_TEST_FAILURE',
    }),
    pair('CR01_MISSING_REQUIRED_RESULT', 'Missing required result remains incomplete', ['R3', 'R5', 'R20'], {
      requiredExecutionIds: ['cr01-a', 'cr01-b'],
      results: [{ executionId: 'cr01-a', classification: 'COMPLETED_PASS' }],
      outcomeCode: 'NOT_READY_INCOMPLETE_EXECUTION',
    }),
    pair('CR02_DUPLICATE_ACCEPTED_RESULT', 'Duplicate accepted result is rejected', ['R3', 'R8', 'R20'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_CORRUPT_EVIDENCE',
    }),
    pair('CR03_UNDECLARED_RESULT', 'Undeclared result is rejected', ['R3', 'R8', 'R20'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_CORRUPT_EVIDENCE',
    }),
    pair('CR04_CROSS_BATCH_RESULT', 'Cross-batch result is rejected', ['R3', 'R8', 'R20'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_CORRUPT_EVIDENCE',
    }),
    pair('CR05_STALE_FENCE', 'Stale fencing token is rejected', ['R8', 'R14', 'R17'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_CORRUPT_EVIDENCE',
    }),
    pair('CR06_WRONG_SUBJECT', 'Wrong-subject evidence is rejected', ['R8', 'R17', 'R23'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_SUBJECT_MISMATCH',
    }),
    pair('CR07_WRONG_RUN', 'Wrong-run evidence is rejected', ['R8', 'R20', 'R23'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_SUBJECT_MISMATCH',
    }),
    pair('CR08_DIGEST_BREAK', 'Digest-chain break is rejected', ['R8', 'R20', 'R25'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_CORRUPT_EVIDENCE',
    }),
    pair('CR09_WORKER_LOSS', 'Worker loss remains incomplete after bounded recovery', ['R5', 'R14', 'R15'], {
      results: [{ executionId: 'cr09_worker_loss-execution', classification: 'INCOMPLETE_UNKNOWN' }],
      outcomeCode: 'NOT_READY_INCOMPLETE_EXECUTION',
    }),
    pair('CR10_REKICK_RECOVERY', 'Incomplete-only rekick recovers without changing membership', ['R16', 'R17'], {}),
    pair('CR11_DIAGNOSTIC_RERUN', 'Diagnostic rerun cannot erase a product failure', ['R4', 'R14', 'R28'], {
      results: [{ executionId: 'cr11_diagnostic_rerun-execution', classification: 'COMPLETED_PASS' }],
      outcomeCode: 'RELEASE_READY',
    }, {
      results: [{ executionId: 'cr11_diagnostic_rerun-execution', classification: 'COMPLETED_PRODUCT_FAILURE' }],
      outcomeCode: 'NOT_READY_TEST_FAILURE',
    }),
    pair('CR12_RISK_UNAVAILABLE', 'Unavailable risk projection remains explicit', ['R9', 'R20', 'R26'], {
      riskAvailability: 'UNAVAILABLE',
    }),
    pair('CR13_STALE_REVISION', 'Stale publication revision is rejected', ['R20', 'R25'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_STALE_REVISION',
    }),
    pair('CR14_LEGACY_READY_ONLY', 'Legacy READY without shared completeness is rejected', ['R1', 'R8', 'R20'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_LEGACY_AUTHORITY',
    }),
    pair('CR15_SHADOW_CONSUMPTION', 'Shadow documents are rejected by release consumers', ['R1', 'R8', 'R20'], {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_NON_AUTHORITATIVE',
    }),
    pair('CR16_RESTORED_STALE_SNAPSHOT', 'Restored stale snapshot is rejected', ['R8', 'R20', 'R25'], {}, {
      grantedScope: 'NONE', outcomeCode: 'REJECTED_STALE_REVISION',
    }),
  ];

  const intentionalDifferences = [
    reviewedDifference({
      caseId: 'AE9', dimension: 'RELEASE_AUTHORITY', reasonCode: 'SHARED_REJECTS_SCOPE_MISMATCH', governingRequirements: ['R3', 'R19', 'R20'],
      legacySemantic: releaseSemantics('FULL', 'FULL', 'RELEASE_READY'),
      sharedSemantic: releaseSemantics('FULL', 'NONE', 'REJECTED_SCOPE_MISMATCH'),
    }),
    reviewedDifference({
      caseId: 'AE10', dimension: 'RESULT_CLASSIFICATION', reasonCode: 'SHARED_APPLIES_LATE_VISUAL_DEFECT', governingRequirements: ['R4', 'R12', 'R24', 'R25'],
      legacySemantic: classifications([['ae10-execution', 'COMPLETED_PASS']]),
      sharedSemantic: classifications([['ae10-execution', 'COMPLETED_PRODUCT_FAILURE']]),
    }),
    reviewedDifference({
      caseId: 'AE10', dimension: 'RELEASE_AUTHORITY', reasonCode: 'SHARED_SUPERSEDES_READY_AFTER_DEFECT', governingRequirements: ['R4', 'R25'],
      legacySemantic: releaseSemantics('FULL', 'FULL', 'RELEASE_READY'),
      sharedSemantic: releaseSemantics('FULL', 'FULL', 'NOT_READY_TEST_FAILURE'),
    }),
    reviewedDifference({
      caseId: 'AE10', dimension: 'RISK_CLASSIFICATION', reasonCode: 'SHARED_CLASSIFIES_CONFIRMED_VISUAL_DEFECT', governingRequirements: ['R4', 'R12'],
      legacySemantic: { availability: 'AVAILABLE', categories: ['UNREVIEWED_VISUAL_CHANGE'] },
      sharedSemantic: { availability: 'AVAILABLE', categories: ['VISUAL_DEFECT'] },
    }),
    reviewedDifference({
      caseId: 'AE11', dimension: 'RELEASE_AUTHORITY', reasonCode: 'SHARED_REJECTS_CHANGED_RELEASE_SUBJECT', governingRequirements: ['R16', 'R17', 'R23'],
      legacySemantic: releaseSemantics('FULL', 'FULL', 'RELEASE_READY'),
      sharedSemantic: releaseSemantics('FULL', 'NONE', 'REJECTED_SUBJECT_MISMATCH'),
    }),
    reviewedDifference({
      caseId: 'AE16', dimension: 'RESULT_CLASSIFICATION', reasonCode: 'SHARED_PRESERVES_CANONICAL_PRODUCT_FAILURE', governingRequirements: ['R4', 'R14', 'R28'],
      legacySemantic: classifications([['ae16-execution', 'COMPLETED_PASS']]),
      sharedSemantic: classifications([['ae16-execution', 'COMPLETED_PRODUCT_FAILURE']]),
    }),
    reviewedDifference({
      caseId: 'AE16', dimension: 'RELEASE_AUTHORITY', reasonCode: 'SHARED_DIAGNOSTIC_RERUN_CANNOT_PROMOTE', governingRequirements: ['R4', 'R23', 'R28'],
      legacySemantic: releaseSemantics('FULL', 'FULL', 'RELEASE_READY'),
      sharedSemantic: releaseSemantics('FULL', 'FULL', 'NOT_READY_TEST_FAILURE'),
    }),
    ...[
      ['CR02_DUPLICATE_ACCEPTED_RESULT', 'SHARED_REJECTS_DUPLICATE_RESULT', ['R3', 'R8', 'R20'], 'REJECTED_CORRUPT_EVIDENCE'],
      ['CR03_UNDECLARED_RESULT', 'SHARED_REJECTS_UNDECLARED_RESULT', ['R3', 'R8', 'R20'], 'REJECTED_CORRUPT_EVIDENCE'],
      ['CR04_CROSS_BATCH_RESULT', 'SHARED_REJECTS_CROSS_BATCH_RESULT', ['R3', 'R8', 'R20'], 'REJECTED_CORRUPT_EVIDENCE'],
      ['CR05_STALE_FENCE', 'SHARED_REJECTS_STALE_FENCE', ['R8', 'R14', 'R17'], 'REJECTED_CORRUPT_EVIDENCE'],
      ['CR06_WRONG_SUBJECT', 'SHARED_REJECTS_WRONG_SUBJECT', ['R8', 'R17', 'R23'], 'REJECTED_SUBJECT_MISMATCH'],
      ['CR07_WRONG_RUN', 'SHARED_REJECTS_WRONG_RUN', ['R8', 'R20', 'R23'], 'REJECTED_SUBJECT_MISMATCH'],
      ['CR08_DIGEST_BREAK', 'SHARED_REJECTS_DIGEST_BREAK', ['R8', 'R20', 'R25'], 'REJECTED_CORRUPT_EVIDENCE'],
      ['CR13_STALE_REVISION', 'SHARED_REJECTS_STALE_REVISION', ['R20', 'R25'], 'REJECTED_STALE_REVISION'],
      ['CR14_LEGACY_READY_ONLY', 'SHARED_REJECTS_LEGACY_READY_ONLY', ['R1', 'R8', 'R20'], 'REJECTED_LEGACY_AUTHORITY'],
      ['CR16_RESTORED_STALE_SNAPSHOT', 'SHARED_REJECTS_RESTORED_STALE_SNAPSHOT', ['R8', 'R20', 'R25'], 'REJECTED_STALE_REVISION'],
    ].map(([caseId, reasonCode, governingRequirements, sharedOutcome]) => reviewedDifference({
      caseId,
      dimension: 'RELEASE_AUTHORITY',
      reasonCode,
      governingRequirements,
      legacySemantic: releaseSemantics('FULL', 'FULL', 'RELEASE_READY'),
      sharedSemantic: releaseSemantics('FULL', 'NONE', sharedOutcome),
    })),
    reviewedDifference({
      caseId: 'CR11_DIAGNOSTIC_RERUN', dimension: 'RESULT_CLASSIFICATION', reasonCode: 'SHARED_PRESERVES_DIAGNOSTIC_FAILURE_RESULT', governingRequirements: ['R4', 'R14', 'R28'],
      legacySemantic: classifications([['cr11_diagnostic_rerun-execution', 'COMPLETED_PASS']]),
      sharedSemantic: classifications([['cr11_diagnostic_rerun-execution', 'COMPLETED_PRODUCT_FAILURE']]),
    }),
    reviewedDifference({
      caseId: 'CR11_DIAGNOSTIC_RERUN', dimension: 'RELEASE_AUTHORITY', reasonCode: 'SHARED_PRESERVES_DIAGNOSTIC_FAILURE_OUTCOME', governingRequirements: ['R4', 'R28'],
      legacySemantic: releaseSemantics('FULL', 'FULL', 'RELEASE_READY'),
      sharedSemantic: releaseSemantics('FULL', 'FULL', 'NOT_READY_TEST_FAILURE'),
    }),
  ];

  return structuredClone({ cases, intentionalDifferences });
}
