export const CONTROL_EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  REQUEST_FAILED: 1,
  USAGE: 2,
  AUTHORIZATION: 3,
  CONFLICT: 4,
  NOT_READY: 10,
  STALE: 11,
  IDENTITY_MISMATCH: 12,
  EVIDENCE_UNAVAILABLE: 13,
  TIMEOUT: 14,
});

export function controlExitCode({ status = 500, code = '' } = {}) {
  const normalized = String(code);
  if (/NOT_READY|PROMOTION_NOT_READY/u.test(normalized)) return CONTROL_EXIT_CODES.NOT_READY;
  if (/STALE|SUPERSEDED|REPLAYED|EXPIRED/u.test(normalized)) return CONTROL_EXIT_CODES.STALE;
  if (/SCOPE|SUBJECT|AUTHORITY|EXECUTION_SET|PRINCIPAL_MISMATCH/u.test(normalized)) {
    return CONTROL_EXIT_CODES.IDENTITY_MISMATCH;
  }
  if (/EMPTY|UNAVAILABLE|CORRUPT/u.test(normalized)) return CONTROL_EXIT_CODES.EVIDENCE_UNAVAILABLE;
  if (status === 401 || status === 403) return CONTROL_EXIT_CODES.AUTHORIZATION;
  if (status === 409) return CONTROL_EXIT_CODES.CONFLICT;
  return CONTROL_EXIT_CODES.REQUEST_FAILED;
}
