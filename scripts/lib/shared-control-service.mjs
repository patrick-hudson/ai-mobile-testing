import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonical-contract.mjs';
import { sealOracleResult, sealWorkItemResult } from '../../shared/execution-contract.mjs';
import { appendPublicationEnvelope } from '../../shared/publication-envelope.mjs';
import { appendVisualDisposition, projectSharedReleaseView } from '../../shared/release-projection.mjs';
import {
  assertPrincipalAuthorized,
  CONTROL_ACTIONS,
  ControlPlaneError,
} from '../../shared/control-plane-contract.mjs';
import {
  acceptOperation,
  appendMutationAuditEvent,
  appendRiskLifecycleEvent,
  cancelParentRun,
  completeOperation,
  getOperation,
  getOperationById,
  listAcceptedOperations,
  readBoundedAttemptLogs,
  readCurrentEnvelope,
  readParentRun,
  readRunHistories,
  rekickIncompleteWork,
  purgeParentRunEvidence,
  tombstoneParentRunAuthority,
  publishCurrentEnvelope,
  withCurrentEnvelopeFence,
} from './parent-run-store.mjs';

export const CONTROL_OPERATION_KINDS = Object.freeze({
  cancel: CONTROL_ACTIONS.RUN_CANCEL,
  rekick: CONTROL_ACTIONS.RUN_REKICK,
  'risk-acknowledge': CONTROL_ACTIONS.RISK_ACKNOWLEDGE,
  'risk-resolve': CONTROL_ACTIONS.RISK_RESOLVE,
  'visual-disposition': CONTROL_ACTIONS.VISUAL_DISPOSITION,
  purge: CONTROL_ACTIONS.RUN_PURGE,
});
const MAX_BODY_BYTES = 16 * 1024;
const MAX_LOG_EVENTS = 1_000;

function fail(code, message, statusCode = 400) { throw new ControlPlaneError(code, message, statusCode); }
function actor(principal) { return { id: principal.id, kind: principal.kind }; }
function namespacedKey(principal, kind, runId, requestId) {
  if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 256) {
    fail('IDEMPOTENCY_KEY_INVALID', 'Idempotency request id must contain 8 through 256 characters.');
  }
  return `op-${createHash('sha256').update(`${principal.id}\0${kind}\0${runId}\0${requestId}`).digest('hex')}`;
}

export function createSharedControlService({ store, projectId = 'default' } = {}) {
  if (!store) throw new TypeError('Shared control service requires the durable parent-run store.');
  const object = (runId) => ({ projectId, runId });
  return Object.freeze({
    projectId,
    async readRun(principal, runId) {
      assertPrincipalAuthorized(principal, CONTROL_ACTIONS.RUN_VIEW, object(runId));
      return readParentRun(store, runId);
    },
    async readPublication(principal, runId) {
      assertPrincipalAuthorized(principal, CONTROL_ACTIONS.RUN_VIEW, object(runId));
      return readCurrentEnvelope(store, runId);
    },
    async withPublicationFence(principal, runId, callback) {
      assertPrincipalAuthorized(principal, CONTROL_ACTIONS.PROMOTION_CONSUME, object(runId));
      return withCurrentEnvelopeFence(store, runId, callback);
    },
    async readExecutions(principal, runId) {
      assertPrincipalAuthorized(principal, CONTROL_ACTIONS.RUN_VIEW, object(runId));
      const state = await readParentRun(store, runId);
      return {
        runId,
        runRevision: state.runRevision,
        executions: Object.values(state.workItems),
        oracleExecutions: state.executionManifest?.oracleExecutions ?? [],
      };
    },
    async readLogs(principal, runId, { limit = 200 } = {}) {
      assertPrincipalAuthorized(principal, CONTROL_ACTIONS.RUN_VIEW, object(runId));
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LOG_EVENTS) fail('LOG_LIMIT_INVALID', 'Log limit is outside bounds.');
      const [histories, workerLogs] = await Promise.all([
        readRunHistories(store, runId), readBoundedAttemptLogs(store, runId, { limit }),
      ]);
      const events = Object.values(histories).flat().sort((left, right) => left.runRevision - right.runRevision);
      return {
        runId, limit, truncated: events.length > limit || workerLogs.truncated,
        events: events.slice(-limit), attemptLogs: workerLogs.entries,
      };
    },
    async acceptMutation(principal, runId, { kind, requestId, expectedRunRevision, body }) {
      const action = CONTROL_OPERATION_KINDS[kind];
      if (!action) fail('OPERATION_KIND_INVALID', 'Operation kind is unsupported.');
      assertPrincipalAuthorized(principal, action, object(runId));
      if (!Number.isSafeInteger(expectedRunRevision) || expectedRunRevision < 1) fail('EXPECTED_REVISION_REQUIRED', 'A positive expectedRunRevision is required.', 409);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('OPERATION_BODY_INVALID', 'Operation body must be a JSON object.');
      if (Buffer.byteLength(canonicalJson(body)) > MAX_BODY_BYTES) fail('OPERATION_BODY_TOO_LARGE', 'Operation body exceeds the durable bound.', 413);
      if (['rekick', 'risk-acknowledge', 'risk-resolve', 'visual-disposition', 'purge'].includes(kind)
        && typeof body.expectedSubjectDigest !== 'string') {
        fail('RELEASE_SUBJECT_REQUIRED', 'Release-affecting and review mutations must pin the immutable final subject.', 409);
      }
      if (kind === 'risk-acknowledge' || kind === 'risk-resolve') {
        const publication = await readCurrentEnvelope(store, runId);
        const risk = publication.riskRegister.risks.find(({ identity }) => identity === body?.riskIdentity);
        if (!risk) fail('RISK_OBSERVATION_CONFLICT', 'Risk mutation must name a current immutable observation.', 409);
        if (risk.category === 'unreviewed-visual-change') {
          fail('RISK_LIFECYCLE_NOT_APPLICABLE', 'Visual review risks require an explicit visual disposition.', 409);
        }
        if (kind === 'risk-acknowledge' && risk.reviewState !== 'OPEN') {
          fail('RISK_REVIEW_STATE_CONFLICT', 'Only an open risk can be acknowledged.', 409);
        }
        if (kind === 'risk-resolve' && !['OPEN', 'ACKNOWLEDGED'].includes(risk.reviewState)) {
          fail('RISK_REVIEW_STATE_CONFLICT', 'Only an open or acknowledged risk can be resolved.', 409);
        }
        if (kind === 'risk-resolve' && ['certificate-bypass', 'coverage-gap', 'evidence-pipeline-limitation'].includes(risk.category)) {
          fail('ACTIVE_RISK_CANNOT_RESOLVE', 'A live derived risk may be acknowledged but cannot be resolved while its sealed source remains active.', 409);
        }
      }
      if (kind === 'visual-disposition') {
        const [publication, state] = await Promise.all([readCurrentEnvelope(store, runId), readParentRun(store, runId)]);
        const risk = publication.riskRegister.risks.find(({ identity }) => identity === body.riskIdentity);
        if (!risk || risk.category !== 'unreviewed-visual-change') {
          fail('VISUAL_REVIEW_OBSERVATION_CONFLICT', 'Visual disposition must name a current visual-review observation.', 409);
        }
        if (!['ACCEPTED', 'DEFECT_CONFIRMED'].includes(body.disposition)
          || typeof body.rationale !== 'string' || body.rationale.length < 1 || body.rationale.length > 2_048
          || typeof body.executionId !== 'string'
          || !state.executionManifest?.oracleExecutions?.some(({ id }) => id === body.executionId)) {
          fail('VISUAL_REVIEW_INVALID', 'Visual disposition value, rationale, or execution identity is invalid.', 400);
        }
      }
      const idempotencyKey = namespacedKey(principal, kind, runId, requestId);
      const operationRequest = {
        idempotencyKey,
        kind,
        actor: actor(principal),
        body: { ...body, expectedRunRevision },
      };
      try {
        await getOperation(store, runId, idempotencyKey);
        return acceptOperation(store, runId, operationRequest);
      } catch (error) {
        if (error?.code !== 'OPERATION_NOT_FOUND') throw error;
      }
      return acceptOperation(store, runId, {
        ...operationRequest,
        expectedRunRevision,
        expectedSubjectDigest: body?.expectedSubjectDigest,
      });
    },
    async readOperation(principal, runId, { kind, requestId }) {
      const action = CONTROL_OPERATION_KINDS[kind];
      if (!action) fail('OPERATION_KIND_INVALID', 'Operation kind is unsupported.');
      assertPrincipalAuthorized(principal, action, object(runId));
      return getOperation(store, runId, namespacedKey(principal, kind, runId, requestId));
    },
    async readOperationById(principal, runId, operationId) {
      assertPrincipalAuthorized(principal, CONTROL_ACTIONS.OPERATION_READ, object(runId));
      const operation = await getOperationById(store, runId, operationId);
      const action = CONTROL_OPERATION_KINDS[operation.kind];
      if (!action) fail('OPERATION_KIND_INVALID', 'Stored operation kind is unsupported.');
      assertPrincipalAuthorized(principal, action, object(runId));
      return operation;
    },
    async applyAcceptedOperations(coordinator, runId, handlers = {}) {
      const applied = [];
      for (const operation of await listAcceptedOperations(store, runId)) {
        try {
          if (operation.kind === 'cancel') {
            await cancelParentRun(store, runId, coordinator, { actor: operation.actor, reason: operation.body?.reason ?? 'Operator cancellation.' });
          } else if (operation.kind === 'rekick') {
            await rekickIncompleteWork(store, runId, coordinator, { actor: operation.actor, workItemIds: operation.body?.workItemIds });
          } else if (operation.kind === 'risk-acknowledge' || operation.kind === 'risk-resolve') {
            const publication = await readCurrentEnvelope(store, runId);
            const currentRisk = publication.riskRegister.risks.find(({ identity }) => identity === operation.body?.riskIdentity);
            if (!currentRisk) fail('RISK_OBSERVATION_CONFLICT', 'Risk observation disappeared before operation application.', 409);
            await appendRiskLifecycleEvent(store, runId, coordinator, {
              type: operation.kind, actor: operation.actor, riskIdentity: operation.body?.riskIdentity,
              from: currentRisk.reviewState, to: operation.kind === 'risk-resolve' ? 'RESOLVED' : 'ACKNOWLEDGED',
              releaseEffect: 'non-blocking',
            });
          } else if (operation.kind === 'visual-disposition') {
            await handlers.visualDisposition?.(operation);
            await appendMutationAuditEvent(store, runId, coordinator, { type: operation.kind, actor: operation.actor, data: operation.body });
          } else if (operation.kind === 'purge') {
            await tombstoneParentRunAuthority(store, runId, coordinator, { actor: operation.actor, reason: operation.body?.reason ?? 'Privileged purge.' });
            await purgeParentRunEvidence(store, runId);
            await handlers.purgeEvidence?.(operation);
          }
          if (operation.kind !== 'purge') await publishProjection(store, runId, coordinator);
          const completed = await completeOperation(store, runId, coordinator, operation.operationId, { status: 'succeeded' });
          applied.push(completed);
        } catch (error) {
          if (operation.kind === 'purge' && error?.code === 'ARTIFACT_READERS_ACTIVE') {
            // The authority tombstone already prevents new reads. Keep the
            // durable purge operation accepted so coordinator maintenance can
            // retry after a crashed or slow reader lease drains.
            continue;
          }
          const completed = await completeOperation(store, runId, coordinator, operation.operationId, {
            status: 'failed', code: error?.code ?? 'CONTROL_OPERATION_FAILED', message: String(error?.message ?? error).slice(0, 1_024),
          });
          applied.push(completed);
        }
      }
      return applied;
    },
    async publishCurrentProjection(coordinator, runId) {
      return publishProjection(store, runId, coordinator);
    },
  });
}

async function publishProjection(store, runId, coordinator) {
  const [state, histories] = await Promise.all([readParentRun(store, runId), readRunHistories(store, runId)]);
  if (!state.finalSubject || !state.executionManifest || state.authorityTombstone) return null;
  let current;
  try { current = await readCurrentEnvelope(store, runId); } catch (error) {
    if (error?.code === 'PUBLICATION_UNAVAILABLE') return null;
    throw error;
  }
  const workResults = new Map(Object.values(state.workItems).map((item) => [item.id, item.canonicalResult ?? sealWorkItemResult({
    schemaVersion: 1, workItemId: item.id, subjectCoreDigest: state.subjectCoreDigest,
    attempt: Math.max(1, item.attempts.length), authoritative: true,
    outcome: item.state === 'cancelled' ? 'cancelled' : 'incomplete_unknown', evidenceDigests: [],
  })]));
  const oracleResults = state.executionManifest.oracleExecutions.map((oracleExecution) => sealOracleResult({
    schemaVersion: 1, oracleExecution, finalSubjectDigest: state.finalSubject.digest,
    workItemResults: oracleExecution.requiredWorkItemIds.map((id) => workResults.get(id)),
  }));
  const riskLifecycleEvents = histories.risk.map((event) => ({
    riskIdentity: event.data.riskIdentity, action: event.data.to, actor: event.actor, at: event.occurredAt,
  }));
  let visualDispositions = [];
  for (const event of histories.mutation.filter(({ type }) => type === 'visual-disposition')) {
    visualDispositions = appendVisualDisposition(visualDispositions, {
      schemaVersion: 1, expectedReviewRevision: visualDispositions.length, runId, mode: state.finalSubject.mode,
      subjectDigest: state.finalSubject.digest, executionId: event.data.executionId,
      riskIdentity: event.data.riskIdentity, disposition: event.data.disposition,
      actor: event.actor, rationale: event.data.rationale, at: event.occurredAt,
    });
  }
  const baseDecisionRevision = Math.max(1, current.decisionRevision - visualDispositions.length);
  const baseRiskRevision = Math.max(1, current.riskRevision - riskLifecycleEvents.length - visualDispositions.length);
  const projection = projectSharedReleaseView({
    schemaVersion: 1, runId, baseDecisionRevision, baseRiskRevision,
    finalSubject: state.finalSubject, executionManifest: state.executionManifest, oracleResults,
    riskAvailability: current.riskRegister.availability, riskSources: current.riskRegister.risks,
    riskLifecycleEvents, visualDispositions,
  });
  if (projection.decision.digest === current.decision.digest
    && canonicalJson(projection.riskRegister) === canonicalJson(current.riskRegister)) return current;
  const next = appendPublicationEnvelope(current, {
    schemaVersion: 1, runId, runRevision: current.runRevision + 1,
    decisionRevision: projection.decisionRevision, riskRevision: projection.riskRevision,
    ledgerSequences: {
      observations: state.ledgerSequences.mutation,
      decisions: state.ledgerSequences.decision + 1,
      risks: state.ledgerSequences.risk,
    },
    finalSubjectDigest: state.finalSubject.digest, decision: projection.decision, riskRegister: projection.riskRegister,
  });
  return publishCurrentEnvelope(store, runId, coordinator, next);
}
