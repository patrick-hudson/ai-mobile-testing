import type { AuditApplicability, AuditRunMode } from './types.js';
import {
  AUDIT_CASE_ID_ANNOTATION,
  AUDIT_CASE_TAG_PREFIX,
  auditCaseTag,
} from '../shared/audit-case-identity.mjs';

export { AUDIT_CASE_ID_ANNOTATION, AUDIT_CASE_TAG_PREFIX, auditCaseTag };

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

export function resolveDeclaredAuditCaseId(
  registry: ExecutableAuditCaseRegistry,
  input: {
    mode: AuditRunMode;
    auditId: string;
    applicability: AuditApplicability;
    oracleVariant?: string;
    caseVariant?: string;
  },
): string | null {
  const matches = allCases(registry).filter((auditCase) => (
    auditCase.auditId === input.auditId
    && auditCase.applicability === input.applicability
    && auditCase.supportedModes.includes(input.mode)
    && (input.oracleVariant === undefined || input.mode === 'comparative'
      || auditCase.oracleVariants.singleSite === input.oracleVariant)
    && (input.caseVariant === undefined || auditCase.caseId.endsWith(auditCaseVariantSuffix(input.caseVariant)))
  ));
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(
      `${input.mode} declaration ${input.auditId}/${input.applicability} maps to ${matches.length} executable cases; `
      + 'bind a unique named Product Oracle variant.',
    );
  }
  return matches[0]!.caseId;
}

export function resolveDeclaredSingleSiteCaseId(
  registry: ExecutableAuditCaseRegistry,
  input: Omit<Parameters<typeof resolveDeclaredAuditCaseId>[1], 'mode'>,
): string | null {
  return resolveDeclaredAuditCaseId(registry, { ...input, mode: 'single-site' });
}

export function selectedAuditCaseGrep(caseIds: readonly string[]): RegExp {
  if (caseIds.length === 0) throw new Error('An exact Single-site case filter cannot be empty.');
  return new RegExp(caseIds.map((caseId) => auditCaseTag(caseId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
}
