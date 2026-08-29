import { projectPublicationView } from './release-projection.mjs';

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

export function createReleaseAssertionResult(publication, { projectId } = {}) {
  const view = projectPublicationView(publication);
  return Object.freeze({
    schemaVersion: 1,
    projectId,
    runId: publication.runId,
    subjectDigest: view.subjectDigest,
    executionSetDigest: view.decision.executionManifestDigest,
    decisionCode: view.decision.code,
    ready: view.decision.ready,
    authority: view.decision.grantedAuthority,
    certifiedScope: view.decision.certifiedScope,
    coverageBasis: view.decision.coverageBasis,
    blockingReasons: view.decision.blockingReasons,
    riskSummary: view.riskSummary,
    superseded: view.decision.superseded,
    revisions: view.revisions,
    exitCode: CONTROL_EXIT_CODES.SUCCESS,
  });
}

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
