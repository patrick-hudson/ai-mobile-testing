/**
 * Canonical audit IDs are uppercase segments separated by hyphens. The first
 * segment may contain digits (for example, A11Y-001).
 */
export const AUDIT_ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

const BRACKETED_AUDIT_ID_PATTERN = /\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]/g;

export function isCanonicalAuditId(value: string): boolean {
  return AUDIT_ID_PATTERN.test(value);
}

export function bracketedAuditIds(value: string): string[] {
  return [...value.matchAll(BRACKETED_AUDIT_ID_PATTERN)].map((match) => match[1]!);
}

export function firstBracketedAuditId(value: string): string | undefined {
  return bracketedAuditIds(value)[0];
}
