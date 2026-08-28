import type { AuditApplicability, AuditRunMode } from './types.js';

export const AUDIT_CASE_TAG_PREFIX = '@audit-case-' as const;
export const AUDIT_CASE_ID_ANNOTATION = 'audit-case-id' as const;

export interface ExecutableAuditCaseSelection {
  caseId: string;
  auditId: string;
  entrySpec: string;
  applicability: AuditApplicability;
  supportedProjects: string[];
  supportedModes: AuditRunMode[];
  oracleVariants: {
    comparative?: string;
    singleSite?: string;
  };
}

export interface ExecutableAuditCaseRegistry {
  plugins: Array<{ auditCases: ExecutableAuditCaseSelection[] }>;
}

function allCases(registry: ExecutableAuditCaseRegistry): ExecutableAuditCaseSelection[] {
  return registry.plugins.flatMap(({ auditCases }) => auditCases);
}

export function auditCaseTag(caseId: string): string {
  const normalized = caseId.trim();
  if (!normalized) throw new Error('Audit case ID must be non-empty.');
  return `${AUDIT_CASE_TAG_PREFIX}${Buffer.from(normalized, 'utf8').toString('base64url')}`;
}

export function auditCaseVariantSuffix(caseVariant: string): string {
  const normalized = caseVariant.trim();
  if (!normalized) throw new Error('Audit case variant must be non-empty.');
  return `:case:${encodeURIComponent(normalized)}`;
}

export function parseSelectedSingleSiteCaseIds(
  raw: string | undefined,
  registry: ExecutableAuditCaseRegistry,
  selectedSourceTargetIds: readonly string[],
): string[] {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('AUDIT_SINGLE_SITE_CASE_IDS must be a JSON array copied from the compiled Definition Coverage Manifest.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AUDIT_SINGLE_SITE_CASE_IDS must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('AUDIT_SINGLE_SITE_CASE_IDS must be a non-empty JSON array of non-empty case IDs.');
  }
  const normalized = parsed.map((value) => (value as string).trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('AUDIT_SINGLE_SITE_CASE_IDS must not contain duplicates.');
  }
  const caseById = new Map(allCases(registry).map((auditCase) => [auditCase.caseId, auditCase]));
  for (const caseId of normalized) {
    const auditCase = caseById.get(caseId);
    if (!auditCase) throw new Error(`Compiled Single-site case ID is absent from the current plugin registry: ${caseId}.`);
    if (!auditCase.supportedModes.includes('single-site') || !auditCase.oracleVariants.singleSite) {
      throw new Error(`Compiled case is not executable in Single-site mode: ${caseId}.`);
    }
    if (!selectedSourceTargetIds.some((targetId) => auditCase.supportedProjects.includes(targetId))) {
      throw new Error(`Compiled case ${caseId} has no execution on the selected neutral browser targets.`);
    }
  }
  return normalized;
}

export function resolveDeclaredSingleSiteCaseId(
  registry: ExecutableAuditCaseRegistry,
  input: {
    auditId: string;
    applicability: AuditApplicability;
    oracleVariant?: string;
    caseVariant?: string;
  },
): string | null {
  const matches = allCases(registry).filter((auditCase) => (
    auditCase.auditId === input.auditId
    && auditCase.applicability === input.applicability
    && auditCase.supportedModes.includes('single-site')
    && (input.oracleVariant === undefined || auditCase.oracleVariants.singleSite === input.oracleVariant)
    && (input.caseVariant === undefined || auditCase.caseId.endsWith(auditCaseVariantSuffix(input.caseVariant)))
  ));
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(
      `Single-site declaration ${input.auditId}/${input.applicability} maps to ${matches.length} executable cases; `
      + 'bind a unique named Product Oracle variant.',
    );
  }
  return matches[0]!.caseId;
}

export function selectedAuditCaseGrep(caseIds: readonly string[]): RegExp {
  if (caseIds.length === 0) throw new Error('An exact Single-site case filter cannot be empty.');
  return new RegExp(caseIds.map((caseId) => auditCaseTag(caseId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
}
