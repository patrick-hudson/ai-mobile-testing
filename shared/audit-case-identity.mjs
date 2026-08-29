export const AUDIT_CASE_TAG_PREFIX = '@audit-case-';
export const AUDIT_CASE_ID_ANNOTATION = 'audit-case-id';

export function auditCaseTag(caseId) {
  const normalized = typeof caseId === 'string' ? caseId.trim() : '';
  if (!normalized) throw new Error('Audit case ID must be non-empty.');
  return `${AUDIT_CASE_TAG_PREFIX}${Buffer.from(normalized, 'utf8').toString('base64url')}`;
}
