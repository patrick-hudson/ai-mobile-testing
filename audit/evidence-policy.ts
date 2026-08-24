import type { AuditDefinition, AuditEvidenceMode, AuditEvidencePolicy } from './types.js';

export const AUDIT_EVIDENCE_POLICY_ANNOTATION = 'audit-evidence-policy';

const MODES = new Set<AuditEvidenceMode>(['interaction-video', 'static-screenshot', 'structured-data']);
const MEDIA_KINDS = new Set<AuditDefinition['evidence'][number]>(['video', 'screenshot']);

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
