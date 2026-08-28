import type {
  AuditDefinition,
  AuditApplicability,
  AuditEvidenceMode,
  AuditEvidencePolicy,
  AuditEvidenceAuthority,
  AuditProjectMetadata,
  AuditStatusOverride,
  AuditStatusWaiver,
} from './types.js';

export const AUDIT_EVIDENCE_POLICY_ANNOTATION = 'audit-evidence-policy';
export const AUDIT_APPLICABILITY_ANNOTATION = 'audit-applicability';
export const AUDIT_STATUS_ANNOTATION = 'audit-status';
export const AUDIT_STATUS_WAIVER_ANNOTATION = 'audit-status-waiver';

const MODES = new Set<AuditEvidenceMode>(['interaction-video', 'static-screenshot', 'structured-data']);
const MEDIA_KINDS = new Set<AuditDefinition['evidence'][number]>(['video', 'screenshot']);
const STATUS_OVERRIDES = new Set<AuditStatusOverride>(['REVIEW', 'INTENDED_CHANGE', 'BLOCKED']);
const EVIDENCE_AUTHORITY_REASONS: readonly AuditEvidenceAuthority['reasons'][number][] = [
  'development-certificate-bypass',
  'deployment-revision-unavailable',
];
const EVIDENCE_AUTHORITY_REASON_SET = new Set(EVIDENCE_AUTHORITY_REASONS);
export const AUDIT_APPLICABILITIES = Object.freeze<AuditApplicability[]>([
  'all-projects',
  'full-sweep-projects',
  'candidate-full-sweep-projects',
  'candidate-projects',
  'production-projects',
  'candidate-non-tablet-projects',
  'candidate-chromium-projects',
  'production-chromium-projects',
  'candidate-desktop-projects',
  'candidate-desktop-chromium',
  'candidate-mobile-projects',
  'candidate-mobile-chromium',
  'production-mobile-chromium',
  'production-desktop-chromium',
  'candidate-mobile-webkit',
  'candidate-tablet-webkit',
  'candidate-desktop-firefox',
]);
const APPLICABILITIES = new Set<AuditApplicability>(AUDIT_APPLICABILITIES);

export function evidenceAuthority(
  reasons: readonly AuditEvidenceAuthority['reasons'][number][] = [],
): AuditEvidenceAuthority {
  const unique = EVIDENCE_AUTHORITY_REASONS.filter((reason) => reasons.includes(reason));
  if (unique.length !== new Set(reasons).size
    || reasons.some((reason) => !EVIDENCE_AUTHORITY_REASON_SET.has(reason))) {
    throw new Error('Evidence Authority contains an unknown or duplicate limitation reason.');
  }
  return unique.length === 0
    ? { status: 'authoritative', reasons: [] }
    : { status: 'non-authoritative', reasons: unique };
}

export function assertEvidenceAuthority(value: unknown, label = 'evidenceAuthority'): AuditEvidenceAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const candidate = value as Partial<AuditEvidenceAuthority>;
  if (!Array.isArray(candidate.reasons)
    || candidate.reasons.some((reason) => typeof reason !== 'string' || !EVIDENCE_AUTHORITY_REASON_SET.has(reason))) {
    throw new Error(`${label}.reasons contains an unknown value.`);
  }
  const normalized = evidenceAuthority(candidate.reasons);
  if (candidate.status !== normalized.status
    || JSON.stringify(candidate.reasons) !== JSON.stringify(normalized.reasons)) {
    throw new Error(`${label} status and reasons are inconsistent or not canonically ordered.`);
  }
  return normalized;
}

export function assertProjectEvidenceAuthority(metadata: AuditProjectMetadata): AuditEvidenceAuthority {
  const authority = assertEvidenceAuthority(metadata.evidenceAuthority, 'project metadata evidenceAuthority');
  const bypassed = metadata.tlsPolicy === 'ignored-for-development' || metadata.tlsPolicy === 'preview-bypass';
  const recordsBypass = authority.reasons.includes('development-certificate-bypass');
  if (bypassed !== recordsBypass) {
    throw new Error('Project TLS policy and Evidence Authority certificate-bypass reason must agree.');
  }
  if (metadata.mode === 'single-site'
    && metadata.deploymentRole === 'production'
    && metadata.tlsPolicy !== 'strict') {
    throw new Error('Production-role Single-site project metadata must enforce strict certificates.');
  }
  return authority;
}

export function createEvidencePolicy(mode: AuditEvidenceMode, rationale: string): AuditEvidencePolicy {
  const normalized = rationale.replace(/\s+/g, ' ').trim();
  if (!MODES.has(mode)) throw new Error(`Unsupported audit evidence mode: ${mode}.`);
  if (normalized.length < 12 || normalized.length > 500) {
    throw new Error('Audit evidence rationale must be 12 to 500 characters.');
  }
  return { mode, rationale: normalized };
}

export function assertEvidencePolicy(value: unknown, label = 'evidencePolicy'): AuditEvidencePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const candidate = value as Partial<AuditEvidencePolicy>;
  if (typeof candidate.mode !== 'string' || typeof candidate.rationale !== 'string') {
    throw new Error(`${label} must contain mode and rationale.`);
  }
  return createEvidencePolicy(candidate.mode as AuditEvidenceMode, candidate.rationale);
}

export function evidenceKindsForPolicy(
  evidence: readonly AuditDefinition['evidence'][number][],
  policy: AuditEvidencePolicy,
): AuditDefinition['evidence'] {
  const supplemental = evidence.filter((kind) => !MEDIA_KINDS.has(kind));
  const media = policy.mode === 'interaction-video'
    ? ['video' as const]
    : policy.mode === 'static-screenshot'
      ? ['screenshot' as const]
      : [];
  return [...media, ...new Set(supplemental)];
}

export function serializeEvidencePolicy(policy: AuditEvidencePolicy): string {
  return JSON.stringify(assertEvidencePolicy(policy));
}

export function parseEvidencePolicyAnnotation(
  annotations: readonly { type: string; description?: string }[] | undefined,
): AuditEvidencePolicy | null {
  const matches = (annotations ?? []).filter(({ type }) => type === AUDIT_EVIDENCE_POLICY_ANNOTATION);
  if (matches.length !== 1 || !matches[0]?.description) return null;
  try {
    return assertEvidencePolicy(JSON.parse(matches[0].description), 'audit evidence policy annotation');
  } catch {
    return null;
  }
}

export function parseAuditApplicabilityAnnotation(
  annotations: readonly { type: string; description?: string }[] | undefined,
): AuditApplicability | null {
  const matches = (annotations ?? []).filter(({ type }) => type === AUDIT_APPLICABILITY_ANNOTATION);
  if (matches.length !== 1 || !matches[0]?.description) return null;
  return APPLICABILITIES.has(matches[0].description as AuditApplicability)
    ? matches[0].description as AuditApplicability
    : null;
}

export function parseAuditStatusAnnotation(
  annotations: readonly { type: string; description?: string }[] | undefined,
  auditId: string,
): AuditStatusOverride | null {
  const matches = (annotations ?? []).filter(({ type }) => type === AUDIT_STATUS_ANNOTATION);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error(`Audit ${auditId} must have at most one ${AUDIT_STATUS_ANNOTATION} annotation.`);
  const status = matches[0]?.description;
  if (!status || !STATUS_OVERRIDES.has(status as AuditStatusOverride)) {
    throw new Error(`${AUDIT_STATUS_ANNOTATION} must be exactly REVIEW, INTENDED_CHANGE, or BLOCKED.`);
  }
  if (status !== 'INTENDED_CHANGE') return status as AuditStatusOverride;
  parseAuditStatusWaiver(annotations, auditId);
  return status;
}

export function parseAuditStatusWaiver(
  annotations: readonly { type: string; description?: string }[] | undefined,
  auditId: string,
): AuditStatusWaiver {
  const matches = (annotations ?? []).filter(({ type }) => type === AUDIT_STATUS_WAIVER_ANNOTATION);
  if (matches.length !== 1 || !matches[0]?.description) {
    throw new Error(`INTENDED_CHANGE for ${auditId} requires exactly one ${AUDIT_STATUS_WAIVER_ANNOTATION} annotation.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(matches[0].description);
  } catch {
    throw new Error(`${AUDIT_STATUS_WAIVER_ANNOTATION} for ${auditId} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${AUDIT_STATUS_WAIVER_ANNOTATION} for ${auditId} must be an object.`);
  }
  const candidate = parsed as Partial<AuditStatusWaiver>;
  const reason = typeof candidate.reason === 'string' ? candidate.reason.replace(/\s+/g, ' ').trim() : '';
  const approvedBy = typeof candidate.approvedBy === 'string' ? candidate.approvedBy.replace(/\s+/g, ' ').trim() : '';
  if (candidate.status !== 'INTENDED_CHANGE' || candidate.auditId !== auditId) {
    throw new Error(`${AUDIT_STATUS_WAIVER_ANNOTATION} must bind INTENDED_CHANGE to audit ${auditId}.`);
  }
  if (reason.length < 12 || reason.length > 500) {
    throw new Error(`${AUDIT_STATUS_WAIVER_ANNOTATION}.reason must be 12 to 500 characters.`);
  }
  if (approvedBy.length < 2 || approvedBy.length > 120) {
    throw new Error(`${AUDIT_STATUS_WAIVER_ANNOTATION}.approvedBy must be 2 to 120 characters.`);
  }
  return { status: 'INTENDED_CHANGE', auditId, reason, approvedBy };
}

export function assertStaticCheckpoint(policy: AuditEvidencePolicy, name: string): string {
  if (policy.mode !== 'static-screenshot') {
    throw new Error(
      `audit.checkpoint(...) is only valid for static-screenshot evidence; ${policy.mode} must not publish primary screenshots.`,
    );
  }
  const normalized = name.replace(/\s+/g, ' ').trim();
  if (!normalized || /^automatic(?:-|\s)|^checkpoint$/i.test(normalized)) {
    throw new Error('Static checkpoints require a purposeful name describing the asserted visible state.');
  }
  return normalized;
}

export function validateDefinitionEvidencePolicy(definition: AuditDefinition, label: string): void {
  const policy = assertEvidencePolicy(definition.evidencePolicy, `${label}.evidencePolicy`);
  const expected = evidenceKindsForPolicy(definition.evidence, policy);
  if (definition.evidence.length !== expected.length
    || definition.evidence.some((kind, index) => kind !== expected[index])) {
    throw new Error(
      `${label}.evidence must use ${expected.join(', ')} for ${policy.mode}; `
      + 'videos are reserved for interactions, rendered static checks require screenshots, and data-only checks require neither.',
    );
  }
}
