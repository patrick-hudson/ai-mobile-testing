import {
  assertDigest,
  assertSchemaVersion,
  canonicalDigest,
  exactKeys,
  failContract,
  freezeContract,
  isRecord,
  nonEmptyString,
  uniqueStrings,
} from './canonical-contract.mjs';

export const SHADOW_FORBIDDEN_AUTHORITY_FIELDS = Object.freeze([
  'authorityEpoch',
  'authoritative',
  'certifiedScope',
  'currentHead',
  'decision',
  'decisionRevision',
  'exitCode',
  'finalSubjectDigest',
  'grantedAuthority',
  'headDigest',
  'promotable',
  'promotion',
  'ready',
  'releaseDecision',
  'runRevision',
]);

const MODES = new Set(['single-site', 'comparative']);
const SCOPES = new Set(['FULL', 'TARGETED', 'NONE']);
const OUTCOMES = new Set([
  'RELEASE_READY',
  'FEATURE_READY',
  'NOT_READY_TEST_FAILURE',
  'NOT_READY_INCOMPLETE_EXECUTION',
  'REJECTED_CORRUPT_EVIDENCE',
  'REJECTED_EMPTY_EVIDENCE',
  'REJECTED_LEGACY_AUTHORITY',
  'REJECTED_NON_AUTHORITATIVE',
  'REJECTED_SCOPE_MISMATCH',
  'REJECTED_STALE_REVISION',
  'REJECTED_SUBJECT_MISMATCH',
  'REJECTED_UNAUTHORIZED',
]);
const RESULT_CLASSES = new Set([
  'CANCELLED',
  'COMPLETED_PASS',
  'COMPLETED_PRODUCT_FAILURE',
  'INCOMPLETE_UNKNOWN',
  'OPERATIONAL_FAILURE',
]);
const DIMENSIONS = Object.freeze([
  'EXECUTION_MEMBERSHIP',
  'RESULT_CLASSIFICATION',
  'RELEASE_AUTHORITY',
  'RISK_CLASSIFICATION',
  'SCOPE_MEMBERSHIP',
]);
const DIMENSION_STATUSES = new Set(['MATCH', 'REVIEWED_DIFFERENCE', 'UNEXPLAINED_DRIFT']);
const REQUIREMENT_PATTERN = /^R(?:[1-9]|1[0-9]|2[0-8])$/u;
const REASON_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;

function canonicalTimestamp(value, label) {
  nonEmptyString(value, label);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value) {
    failContract('INVALID_SHADOW_VALIDATION', `${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function optionalVolatileMetadata(value, label) {
  if (value === undefined) return;
  exactKeys(value, ['runId', 'rawByteDigest'], label);
  if (value.runId !== undefined) nonEmptyString(value.runId, `${label}.runId`);
  if (value.rawByteDigest !== undefined) nonEmptyString(value.rawByteDigest, `${label}.rawByteDigest`);
}

function parseResults(value, requiredExecutionIds, label) {
  if (!Array.isArray(value)) failContract('INVALID_SHADOW_VALIDATION', `${label} must be an array.`);
  const results = value.map((entry, index) => {
    exactKeys(entry, ['executionId', 'classification'], `${label}[${index}]`);
    const executionId = nonEmptyString(entry.executionId, `${label}[${index}].executionId`);
    if (!RESULT_CLASSES.has(entry.classification)) {
      failContract('INVALID_SHADOW_VALIDATION', `${label}[${index}].classification is unsupported.`);
    }
    return { executionId, classification: entry.classification };
  });
  if (new Set(results.map(({ executionId }) => executionId)).size !== results.length) {
    failContract('INVALID_SHADOW_VALIDATION', `${label} contains duplicate semantic execution IDs.`);
  }
  const required = new Set(requiredExecutionIds);
  if (results.some(({ executionId }) => !required.has(executionId))) {
    failContract('INVALID_SHADOW_VALIDATION', `${label} contains an undeclared semantic execution ID.`);
  }
  return results.sort((left, right) => left.executionId.localeCompare(right.executionId));
}

export function normalizeShadowSource(value, expectedKind = undefined) {
  assertSchemaVersion(value, 'Shadow source');
  exactKeys(value, [
    'schemaVersion', 'kind', 'caseId', 'mode', 'requestedScope', 'grantedScope',
    'selectedFeatures', 'selectedDefinitions', 'selectedTargets', 'knownLimits',
    'requiredExecutionIds', 'results', 'riskAvailability', 'riskCategories',
    'outcomeCode', 'volatileMetadata',
  ], 'Shadow source');
  if (!['legacy-shadow-source', 'shared-shadow-source'].includes(value.kind)
    || (expectedKind !== undefined && value.kind !== expectedKind)) {
    failContract('INVALID_SHADOW_VALIDATION', 'Shadow source kind is invalid.');
  }
  const caseId = nonEmptyString(value.caseId, 'Shadow source caseId');
  if (!MODES.has(value.mode)) failContract('INVALID_SHADOW_VALIDATION', 'Shadow source mode is invalid.');
  if (!SCOPES.has(value.requestedScope) || !SCOPES.has(value.grantedScope)) {
    failContract('INVALID_SHADOW_VALIDATION', 'Shadow source scope is invalid.');
  }
  if (!OUTCOMES.has(value.outcomeCode)) failContract('INVALID_SHADOW_VALIDATION', 'Shadow source outcome is invalid.');
  if (!['AVAILABLE', 'PARTIAL', 'EMPTY', 'UNAVAILABLE'].includes(value.riskAvailability)) {
    failContract('INVALID_SHADOW_VALIDATION', 'Shadow source risk availability is invalid.');
  }
  optionalVolatileMetadata(value.volatileMetadata, 'Shadow source volatileMetadata');
  const requiredExecutionIds = uniqueStrings(value.requiredExecutionIds, 'requiredExecutionIds');
  const semantic = {
    EXECUTION_MEMBERSHIP: requiredExecutionIds,
    RESULT_CLASSIFICATION: parseResults(value.results, requiredExecutionIds, 'results'),
    RELEASE_AUTHORITY: {
      requestedScope: value.requestedScope,
      grantedScope: value.grantedScope,
      outcomeCode: value.outcomeCode,
    },
    RISK_CLASSIFICATION: {
      availability: value.riskAvailability,
      categories: uniqueStrings(value.riskCategories, 'riskCategories'),
    },
    SCOPE_MEMBERSHIP: {
      mode: value.mode,
      features: uniqueStrings(value.selectedFeatures, 'selectedFeatures'),
      definitions: uniqueStrings(value.selectedDefinitions, 'selectedDefinitions'),
      targets: uniqueStrings(value.selectedTargets, 'selectedTargets'),
      knownLimits: uniqueStrings(value.knownLimits, 'knownLimits'),
    },
  };
  return freezeContract({ caseId, semantic });
}

export function normalizeLegacyShadowSource(value) {
  return normalizeShadowSource(value, 'legacy-shadow-source');
}

export function normalizeSharedShadowSource(value) {
  return normalizeShadowSource(value, 'shared-shadow-source');
}

function parseCase(value, index) {
  exactKeys(value, ['caseId', 'title', 'governingRequirements', 'legacy', 'shared'], `cases[${index}]`);
  const caseId = nonEmptyString(value.caseId, `cases[${index}].caseId`);
  const requirements = uniqueStrings(value.governingRequirements, `cases[${index}].governingRequirements`, { nonEmpty: true });
  if (requirements.some((requirement) => !REQUIREMENT_PATTERN.test(requirement))) {
    failContract('INVALID_SHADOW_VALIDATION', `cases[${index}] has an invalid governing requirement.`);
  }
  const legacy = normalizeLegacyShadowSource(value.legacy);
  const shared = normalizeSharedShadowSource(value.shared);
  if (legacy.caseId !== caseId || shared.caseId !== caseId) {
    failContract('INVALID_SHADOW_VALIDATION', `cases[${index}] source identity does not match its case.`);
  }
  return {
    caseId,
    title: nonEmptyString(value.title, `cases[${index}].title`),
    governingRequirements: requirements,
    legacy,
    shared,
  };
}

function parseIntentionalDifference(value, index, caseIds) {
  exactKeys(value, [
    'caseId', 'dimension', 'reasonCode', 'governingRequirements', 'reviewed',
    'legacySemantic', 'sharedSemantic',
  ], `intentionalDifferences[${index}]`);
  const caseId = nonEmptyString(value.caseId, `intentionalDifferences[${index}].caseId`);
  if (!caseIds.has(caseId)) failContract('INVALID_SHADOW_VALIDATION', 'Intentional difference names an unknown case.');
  if (!DIMENSIONS.includes(value.dimension)) failContract('INVALID_SHADOW_VALIDATION', 'Intentional difference dimension is invalid.');
  if (value.reviewed !== true) failContract('UNREVIEWED_SHADOW_DIFFERENCE', 'Every intentional difference must be reviewed.');
  const reasonCode = nonEmptyString(value.reasonCode, `intentionalDifferences[${index}].reasonCode`);
  if (!REASON_PATTERN.test(reasonCode)) failContract('INVALID_SHADOW_VALIDATION', 'Intentional difference reason code is not stable.');
  const governingRequirements = uniqueStrings(
    value.governingRequirements,
    `intentionalDifferences[${index}].governingRequirements`,
    { nonEmpty: true },
  );
  if (governingRequirements.some((requirement) => !REQUIREMENT_PATTERN.test(requirement))) {
    failContract('INVALID_SHADOW_VALIDATION', 'Intentional difference has an invalid governing requirement.');
  }
  return {
    caseId,
    dimension: value.dimension,
    reasonCode,
    governingRequirements,
    reviewed: true,
    expectedLegacyDigest: canonicalDigest(value.legacySemantic),
    expectedSharedDigest: canonicalDigest(value.sharedSemantic),
  };
}

function scanForbiddenFields(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForbiddenFields(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SHADOW_FORBIDDEN_AUTHORITY_FIELDS.includes(key)) {
      failContract('SHADOW_AUTHORITY_FIELD_FORBIDDEN', `${path}.${key} is forbidden in diagnostic shadow output.`);
    }
    scanForbiddenFields(entry, `${path}.${key}`);
  }
}

function summarizeComparisons(comparisons) {
  const dimensions = comparisons.flatMap((comparison) => comparison.dimensions);
  return {
    cases: comparisons.length,
    dimensions: dimensions.length,
    matches: dimensions.filter(({ status }) => status === 'MATCH').length,
    reviewedDifferences: dimensions.filter(({ status }) => status === 'REVIEWED_DIFFERENCE').length,
    unexplainedDrift: dimensions.filter(({ status }) => status === 'UNEXPLAINED_DRIFT').length,
  };
}

export function runShadowValidation(input) {
  exactKeys(input, ['cases', 'intentionalDifferences', 'generatedAt'], 'Shadow validation input');
  if (!Array.isArray(input.cases) || input.cases.length === 0) {
    failContract('INVALID_SHADOW_VALIDATION', 'Shadow validation cases must be non-empty.');
  }
  if (!Array.isArray(input.intentionalDifferences)) {
    failContract('INVALID_SHADOW_VALIDATION', 'intentionalDifferences must be an array.');
  }
  const cases = input.cases.map(parseCase).sort((left, right) => left.caseId.localeCompare(right.caseId, undefined, { numeric: true }));
  const caseIds = new Set(cases.map(({ caseId }) => caseId));
  if (caseIds.size !== cases.length) failContract('INVALID_SHADOW_VALIDATION', 'Shadow validation case IDs must be unique.');
  const registry = input.intentionalDifferences.map((entry, index) => parseIntentionalDifference(entry, index, caseIds));
  const registryKeys = registry.map(({ caseId, dimension }) => `${caseId}:${dimension}`);
  if (new Set(registryKeys).size !== registryKeys.length) {
    failContract('INVALID_SHADOW_VALIDATION', 'Intentional difference registry entries must be unique per case and dimension.');
  }
  const usedRegistryKeys = new Set();
  const comparisons = cases.map((entry) => ({
    caseId: entry.caseId,
    title: entry.title,
    governingRequirements: entry.governingRequirements,
    dimensions: DIMENSIONS.map((dimension) => {
      const legacyDigest = canonicalDigest(entry.legacy.semantic[dimension]);
      const sharedDigest = canonicalDigest(entry.shared.semantic[dimension]);
      if (legacyDigest === sharedDigest) {
        return { dimension, status: 'MATCH', legacyDigest, sharedDigest, reasonCode: null, governingRequirements: [], reviewed: false };
      }
      const registered = registry.find((candidate) => candidate.caseId === entry.caseId
        && candidate.dimension === dimension
        && candidate.expectedLegacyDigest === legacyDigest
        && candidate.expectedSharedDigest === sharedDigest);
      if (registered !== undefined) {
        usedRegistryKeys.add(`${entry.caseId}:${dimension}`);
        return {
          dimension,
          status: 'REVIEWED_DIFFERENCE',
          legacyDigest,
          sharedDigest,
          reasonCode: registered.reasonCode,
          governingRequirements: registered.governingRequirements,
          reviewed: true,
        };
      }
      return {
        dimension,
        status: 'UNEXPLAINED_DRIFT',
        legacyDigest,
        sharedDigest,
        reasonCode: null,
        governingRequirements: [],
        reviewed: false,
      };
    }),
  }));
  const unused = registryKeys.filter((key) => !usedRegistryKeys.has(key));
  if (unused.length > 0) {
    failContract('STALE_SHADOW_DIFFERENCE_REGISTRY', `Reviewed differences were not observed: ${unused.join(', ')}.`);
  }
  const summary = summarizeComparisons(comparisons);
  const body = {
    schemaVersion: 1,
    kind: 'release-shadow-validation',
    purpose: 'diagnostic-only',
    generatedAt: canonicalTimestamp(input.generatedAt, 'generatedAt'),
    matrixDigest: canonicalDigest({
      cases: cases.map(({ caseId, title, governingRequirements, legacy, shared }) => ({
        caseId,
        title,
        governingRequirements,
        legacy: legacy.semantic,
        shared: shared.semantic,
      })),
      registry,
    }),
    validationStatus: summary.unexplainedDrift === 0 ? 'PASS' : 'BLOCKED',
    comparisons,
    summary,
  };
  scanForbiddenFields(body);
  return freezeContract({ ...body, digest: canonicalDigest(body) });
}

export function parseShadowValidationReport(value) {
  assertSchemaVersion(value, 'Shadow validation report');
  exactKeys(value, [
    'schemaVersion', 'kind', 'purpose', 'generatedAt', 'matrixDigest', 'validationStatus',
    'comparisons', 'summary', 'digest',
  ], 'Shadow validation report');
  scanForbiddenFields(value);
  if (value.kind !== 'release-shadow-validation' || value.purpose !== 'diagnostic-only') {
    failContract('INVALID_SHADOW_VALIDATION', 'Shadow validation report purpose is invalid.');
  }
  canonicalTimestamp(value.generatedAt, 'generatedAt');
  assertDigest(value.matrixDigest, 'matrixDigest');
  if (!['PASS', 'BLOCKED'].includes(value.validationStatus) || !Array.isArray(value.comparisons)) {
    failContract('INVALID_SHADOW_VALIDATION', 'Shadow validation status or comparisons are invalid.');
  }
  const comparisons = value.comparisons.map((comparison, comparisonIndex) => {
    exactKeys(comparison, ['caseId', 'title', 'governingRequirements', 'dimensions'], `comparisons[${comparisonIndex}]`);
    const governingRequirements = uniqueStrings(comparison.governingRequirements, `comparisons[${comparisonIndex}].governingRequirements`, { nonEmpty: true });
    const dimensions = comparison.dimensions.map((dimension, dimensionIndex) => {
      exactKeys(dimension, [
        'dimension', 'status', 'legacyDigest', 'sharedDigest', 'reasonCode',
        'governingRequirements', 'reviewed',
      ], `comparisons[${comparisonIndex}].dimensions[${dimensionIndex}]`);
      if (!DIMENSIONS.includes(dimension.dimension) || !DIMENSION_STATUSES.has(dimension.status)) {
        failContract('INVALID_SHADOW_VALIDATION', 'Shadow comparison dimension or status is invalid.');
      }
      assertDigest(dimension.legacyDigest, 'legacyDigest');
      assertDigest(dimension.sharedDigest, 'sharedDigest');
      const requirements = uniqueStrings(dimension.governingRequirements, 'dimension governingRequirements');
      const match = dimension.status === 'MATCH';
      const reviewed = dimension.status === 'REVIEWED_DIFFERENCE';
      if ((match && dimension.legacyDigest !== dimension.sharedDigest)
        || (!match && dimension.legacyDigest === dimension.sharedDigest)
        || dimension.reviewed !== reviewed
        || (reviewed && (typeof dimension.reasonCode !== 'string' || requirements.length === 0))
        || (!reviewed && (dimension.reasonCode !== null || requirements.length !== 0))) {
        failContract('CORRUPT_SHADOW_VALIDATION', 'Shadow comparison dimension semantics are corrupt.');
      }
      return dimension;
    });
    if (dimensions.length !== DIMENSIONS.length
      || new Set(dimensions.map(({ dimension }) => dimension)).size !== DIMENSIONS.length) {
      failContract('CORRUPT_SHADOW_VALIDATION', 'Each shadow case must contain every comparison dimension exactly once.');
    }
    return { ...comparison, governingRequirements, dimensions };
  });
  exactKeys(value.summary, ['cases', 'dimensions', 'matches', 'reviewedDifferences', 'unexplainedDrift'], 'summary');
  const expectedSummary = summarizeComparisons(comparisons);
  if (canonicalDigest(expectedSummary) !== canonicalDigest(value.summary)
    || value.validationStatus !== (expectedSummary.unexplainedDrift === 0 ? 'PASS' : 'BLOCKED')) {
    failContract('CORRUPT_SHADOW_VALIDATION', 'Shadow validation summary is corrupt.');
  }
  const body = {
    schemaVersion: 1,
    kind: value.kind,
    purpose: value.purpose,
    generatedAt: value.generatedAt,
    matrixDigest: value.matrixDigest,
    validationStatus: value.validationStatus,
    comparisons,
    summary: expectedSummary,
  };
  if (canonicalDigest(body) !== value.digest) failContract('CORRUPT_SHADOW_VALIDATION', 'Shadow validation digest is corrupt.');
  return freezeContract({ ...body, digest: value.digest });
}
