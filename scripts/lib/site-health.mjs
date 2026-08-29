import { AUDIT_MODES, AUTHORITY_QUALIFIERS } from '../../shared/release-subject.mjs';

export { projectPublicationView as projectSiteHealthRelease } from '../../shared/release-projection.mjs';

export const SITE_HEALTH_SCHEMA_VERSION = 1;

const EXECUTION_STATUSES = new Set([
  'queued', 'starting', 'running', 'finalizing', 'completed', 'failed', 'incomplete', 'cancelled',
]);
const ROLES = new Set(['preview', 'production']);
const QUALIFIERS = new Set(AUTHORITY_QUALIFIERS);
const AUTHORITY_STATUSES = new Set(['authoritative', 'non-authoritative']);
const VISUAL_STATUSES = new Set(['UNCHANGED', 'CHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => !nonEmptyString(entry))) {
    throw new TypeError(`${label} must be an array of non-empty strings.`);
  }
  const normalized = value.map((entry) => entry.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} must not contain duplicates.`);
  }
  return normalized;
}

function exactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${label} contains unknown fields: ${unexpected.sort().join(', ')}.`);
}

function auditedOrigin(value) {
  if (!nonEmptyString(value) || value !== value.trim()) {
    throw new TypeError('Site Health requires an audited URL and confirmed Deployment Role.');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Site Health audited URL must be an exact HTTP(S) origin.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('Site Health audited URL must be an exact HTTP(S) origin.');
  }
  return parsed.origin;
}

function optionalExplanation(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (!nonEmptyString(value) || value !== value.trim() || value.length > 2_400) {
    throw new TypeError(`${label} must be a non-empty string of at most 2400 characters when supplied.`);
  }
  return value;
}

export function parseSiteHealthInput(input) {
  if (!isRecord(input) || input.schemaVersion !== 1 || input.mode !== AUDIT_MODES[0]) {
    throw new TypeError('Site Health derives only from a schemaVersion 1 Single-site truth input.');
  }
  exactKeys(input, [
    'schemaVersion', 'mode', 'url', 'deploymentRole', 'scope', 'coverage', 'pipeline',
    'evidenceAuthority', 'findings', 'manual', 'visualReview',
  ], 'Site Health input');
  const url = auditedOrigin(input.url);
  if (!ROLES.has(input.deploymentRole)) {
    throw new TypeError('Site Health requires an audited URL and confirmed Deployment Role.');
  }
  if (!isRecord(input.scope) || !QUALIFIERS.has(input.scope.qualifier)) {
    throw new TypeError('Site Health requires a FULL or TARGETED scope qualifier.');
  }
  exactKeys(input.scope, ['qualifier', 'selectedCoverage', 'omittedCoverage'], 'scope');
  if (!isRecord(input.coverage) || typeof input.coverage.finalized !== 'boolean'
    || typeof input.coverage.manifestIntegrity !== 'boolean') {
    throw new TypeError('Site Health requires explicit coverage finalization and manifest integrity.');
  }
  exactKeys(input.coverage, ['finalized', 'manifestIntegrity', 'gaps', 'limitations'], 'coverage');
  if (!isRecord(input.pipeline) || !EXECUTION_STATUSES.has(input.pipeline.executionStatus)
    || typeof input.pipeline.integrityComplete !== 'boolean'
    || typeof input.pipeline.requiredEvidenceComplete !== 'boolean') {
    throw new TypeError('Site Health requires explicit execution, pipeline integrity, and evidence completion.');
  }
  exactKeys(input.pipeline, [
    'executionStatus', 'integrityComplete', 'requiredEvidenceComplete', 'reason', 'cancellationReason',
  ], 'pipeline');
  if (!isRecord(input.evidenceAuthority) || !AUTHORITY_STATUSES.has(input.evidenceAuthority.status)) {
    throw new TypeError('Site Health requires explicit Evidence Authority.');
  }
  exactKeys(input.evidenceAuthority, ['status', 'reasons'], 'evidenceAuthority');
  const authorityReasons = stringArray(input.evidenceAuthority.reasons, 'evidenceAuthority.reasons');
  if ((input.evidenceAuthority.status === 'authoritative') !== (authorityReasons.length === 0)) {
    throw new TypeError('Evidence Authority status and limitation reasons disagree.');
  }
  if (!Array.isArray(input.findings) || input.findings.some((finding) => !isRecord(finding)
    || !nonEmptyString(finding.id) || !['P0', 'P1', 'P2', 'P3'].includes(finding.severity))) {
    throw new TypeError('Site Health findings must be deterministic records with IDs and severities.');
  }
  if (new Set(input.findings.map(({ id }) => id)).size !== input.findings.length) {
    throw new TypeError('Site Health finding IDs must be unique.');
  }
  if (!isRecord(input.manual)) throw new TypeError('Site Health requires separate manual status counts.');
  exactKeys(input.manual, ['required', 'complete', 'failedOrBlocked'], 'manual');
  const manual = {
    required: count(input.manual.required, 'manual.required'),
    complete: count(input.manual.complete, 'manual.complete'),
    failedOrBlocked: count(input.manual.failedOrBlocked, 'manual.failedOrBlocked'),
  };
  if (manual.complete + manual.failedOrBlocked > manual.required) {
    throw new TypeError('Manual completion counts cannot exceed required work.');
  }
  const selectedCoverage = stringArray(input.scope.selectedCoverage, 'scope.selectedCoverage');
  const omittedCoverage = stringArray(input.scope.omittedCoverage, 'scope.omittedCoverage');
  const overlappingCoverage = selectedCoverage.filter((entry) => omittedCoverage.includes(entry));
  if (overlappingCoverage.length > 0) {
    throw new TypeError(`Selected and omitted coverage overlap: ${overlappingCoverage.join(', ')}.`);
  }
  if (input.scope.qualifier === 'FULL' && omittedCoverage.length > 0) {
    throw new TypeError('FULL scope cannot contain operator-omitted eligible coverage.');
  }
  const gaps = stringArray(input.coverage.gaps, 'coverage.gaps');
  const limitations = stringArray(input.coverage.limitations, 'coverage.limitations');
  const visualItems = Array.isArray(input.visualReview?.items) ? input.visualReview.items : [];
  if (input.visualReview !== undefined) {
    if (!isRecord(input.visualReview)) throw new TypeError('visualReview must be an object when supplied.');
    exactKeys(input.visualReview, ['items'], 'visualReview');
  }
  if (visualItems.some((item) => !isRecord(item) || !VISUAL_STATUSES.has(item.status))) {
    throw new TypeError('Visual Review items contain an unsupported status.');
  }
  for (const item of visualItems) exactKeys(item, ['status'], 'visualReview item');
  const pipelineReason = optionalExplanation(input.pipeline.reason, 'pipeline.reason');
  const cancellationReason = optionalExplanation(input.pipeline.cancellationReason, 'pipeline.cancellationReason');
  if (input.pipeline.executionStatus === 'cancelled' && cancellationReason === null) {
    throw new TypeError('Cancelled Site Health input requires pipeline.cancellationReason.');
  }
  if (input.pipeline.executionStatus !== 'cancelled' && cancellationReason !== null) {
    throw new TypeError('pipeline.cancellationReason is valid only for a cancelled run.');
  }
  return {
    ...input,
    url,
    scope: { qualifier: input.scope.qualifier, selectedCoverage, omittedCoverage },
    coverage: { finalized: input.coverage.finalized, manifestIntegrity: input.coverage.manifestIntegrity, gaps, limitations },
    pipeline: {
      executionStatus: input.pipeline.executionStatus,
      integrityComplete: input.pipeline.integrityComplete,
      requiredEvidenceComplete: input.pipeline.requiredEvidenceComplete,
      reason: pipelineReason,
      cancellationReason,
    },
    evidenceAuthority: { status: input.evidenceAuthority.status, reasons: authorityReasons },
    findings: [...input.findings],
    manual,
    visualItems,
  };
}

function manualStatus(manual) {
  const outstanding = manual.required - manual.complete - manual.failedOrBlocked;
  const status = manual.required === 0
    ? 'NOT_REQUIRED'
    : manual.failedOrBlocked > 0
      ? 'FAILED_OR_BLOCKED'
      : outstanding > 0 ? 'OUTSTANDING' : 'COMPLETE';
  return { ...manual, outstanding, status };
}

function visualSummary(items) {
  const byStatus = Object.fromEntries([...VISUAL_STATUSES].map((status) => [status, 0]));
  for (const item of items) byStatus[item.status] += 1;
  return {
    total: items.length,
    attentionRequired: byStatus.CHANGED,
    byStatus,
  };
}

export function deriveSiteHealth(input) {
  const value = parseSiteHealthInput(input);
  const coverageStatus = !value.coverage.finalized || !value.coverage.manifestIntegrity
    ? 'UNKNOWN'
    : value.coverage.gaps.length > 0 || value.coverage.limitations.length > 0
      ? 'GAPS'
      : 'COMPLETE';
  const evidenceComplete = value.pipeline.requiredEvidenceComplete;
  const pipelineIntegrityComplete = value.pipeline.executionStatus === 'completed'
    && value.pipeline.integrityComplete;
  const completionTrusted = pipelineIntegrityComplete
    && evidenceComplete
    && coverageStatus !== 'UNKNOWN';
  const verdict = !completionTrusted
    ? 'INCOMPLETE'
    : value.findings.length > 0 ? 'FINDINGS' : 'HEALTHY';
  const qualifiers = [];
  if (value.scope.qualifier === 'TARGETED') qualifiers.push('TARGETED');
  if (value.evidenceAuthority.status === 'non-authoritative') qualifiers.push('NON-AUTHORITATIVE');
  const displayLabel = qualifiers.length > 0 ? `${verdict} · ${qualifiers.join(' · ')}` : verdict;
  const reason = verdict === 'INCOMPLETE'
    ? value.pipeline.cancellationReason
      ?? (coverageStatus === 'UNKNOWN' ? 'Coverage truth could not be finalized.' : null)
      ?? value.pipeline.reason
      ?? 'Required evidence or pipeline integrity did not complete.'
    : verdict === 'FINDINGS'
      ? `${value.findings.length} deterministic finding${value.findings.length === 1 ? '' : 's'} require review.`
      : 'The completed automated scope produced no deterministic Findings.';

  return Object.freeze({
    schemaVersion: SITE_HEALTH_SCHEMA_VERSION,
    kind: 'single-site-health',
    mode: 'single-site',
    advisory: true,
    auditedUrl: value.url,
    deploymentRole: value.deploymentRole,
    scope: {
      qualifier: value.scope.qualifier,
      selectedCoverage: value.scope.selectedCoverage,
      omittedCoverage: value.scope.omittedCoverage,
    },
    siteHealth: {
      verdict,
      displayLabel,
      reason,
      findingCount: value.findings.length,
    },
    coverage: {
      status: coverageStatus,
      gapCount: value.coverage.gaps.length,
      limitationCount: value.coverage.limitations.length,
      gaps: value.coverage.gaps,
      limitations: value.coverage.limitations,
    },
    evidenceCompletion: {
      status: evidenceComplete ? 'complete' : 'incomplete',
    },
    evidenceAuthority: value.evidenceAuthority,
    pipelineIntegrity: {
      status: pipelineIntegrityComplete ? 'complete' : 'incomplete',
      executionStatus: value.pipeline.executionStatus,
      reason: value.pipeline.reason,
      cancellationReason: value.pipeline.cancellationReason,
    },
    manual: manualStatus(value.manual),
    visualReview: visualSummary(value.visualItems),
    promotion: {
      authorized: false,
      effect: 'none',
      statement: 'Site Health is advisory and does not authorize or block promotion.',
    },
  });
}
