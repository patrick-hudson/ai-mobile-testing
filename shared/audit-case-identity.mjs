export const AUDIT_CASE_TAG_PREFIX = '@audit-case-';
export const AUDIT_CASE_ID_ANNOTATION = 'audit-case-id';

export function auditCaseTag(caseId) {
  const normalized = typeof caseId === 'string' ? caseId.trim() : '';
  if (!normalized) throw new Error('Audit case ID must be non-empty.');
  return `${AUDIT_CASE_TAG_PREFIX}${Buffer.from(normalized, 'utf8').toString('base64url')}`;
}

/**
 * Return a regular-expression source that matches exactly one encoded audit
 * case tag. Base64url encodings are not prefix-free, so a bare tag can also
 * match a longer case ID (for example the `/` route and `/start-here/...`).
 */
export function exactAuditCaseTagPattern(caseId) {
  const escapedTag = auditCaseTag(caseId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `${escapedTag}(?![A-Za-z0-9_-])`;
}
