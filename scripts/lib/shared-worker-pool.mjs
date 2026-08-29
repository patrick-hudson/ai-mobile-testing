import {
  adoptAttemptEvidence,
  appendAttemptLog,
  claimWorkItem,
  publishAttemptEvidence,
} from './parent-run-store.mjs';

const OPERATIONAL_FAILURE_ALLOWLIST = new Set([
  'browser_process_crash',
  'container_evicted',
  'worker_process_terminated',
  'coordinator_transport_unavailable',
]);
const TERMINAL_OUTCOMES = new Set(['completed_pass', 'completed_product_failure']);
const SAFE_WORKER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const CAPABILITY = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/;

export class SharedWorkerPoolError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SharedWorkerPoolError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SharedWorkerPoolError(code, message, details);
}

function validateWorker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SAFE_WORKER_ID.test(value.id ?? '')) {
    fail('SHARED_WORKER_INVALID', 'Worker identity is invalid.');
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.length > 32
    || value.capabilities.some((entry) => typeof entry !== 'string' || !CAPABILITY.test(entry))) {
    fail('SHARED_WORKER_INVALID', 'Worker capabilities are invalid.');
  }
  if (!Array.isArray(value.resourceClasses) || value.resourceClasses.length !== 1
    || !['ordinary', 'performance'].includes(value.resourceClasses[0])) {
    fail('SHARED_WORKER_INVALID', 'A worker must declare exactly one resource class.');
  }
  return Object.freeze({
    id: value.id,
    capabilities: Object.freeze([...new Set(value.capabilities)].sort()),
    resourceClasses: Object.freeze([...value.resourceClasses]),
  });
}

export function classifyExecutionFailure(value = {}) {
  const kind = typeof value.kind === 'string' && value.kind ? value.kind : 'unclassified_execution_failure';
  const operational = value.trustedPlatformSignal === true && OPERATIONAL_FAILURE_ALLOWLIST.has(kind);
  return operational
    ? { outcome: 'operational_failure', reason: kind, retryable: true }
    : { outcome: 'completed_product_failure', reason: kind, retryable: false };
}

function validateSuccessfulExecution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !TERMINAL_OUTCOMES.has(value.outcome)
    || Object.keys(value).some((key) => !['outcome', 'reason', 'artifacts', 'riskSourceObservationSet'].includes(key))
    || !Array.isArray(value.artifacts)) {
    fail('SHARED_WORKER_RESULT_INVALID', 'Worker execution must return one completed outcome and artifact uploads.');
  }
  return {
    outcome: value.outcome,
    reason: value.reason ?? null,
    ...(value.riskSourceObservationSet ? { riskSourceObservationSet: value.riskSourceObservationSet } : {}),
    artifacts: [...value.artifacts],
  };
}

function logMessage(event, detail = '') {
  const suffix = detail ? `: ${String(detail).replace(/[\r\n\u001b]/g, ' ').slice(0, 512)}` : '';
  return `${event}${suffix}`;
}

export async function runSharedWorkerPool({
  store,
  runId,
  coordinator,
  worker: workerValue,
  execute,
  leaseMs = 30_000,
  maxClaims = Number.POSITIVE_INFINITY,
} = {}) {
  const worker = validateWorker(workerValue);
  if (typeof execute !== 'function') fail('SHARED_WORKER_INVALID', 'Shared worker execute callback is required.');
  if (!Number.isFinite(maxClaims) && maxClaims !== Number.POSITIVE_INFINITY) fail('SHARED_WORKER_INVALID', 'maxClaims is invalid.');
  if (maxClaims !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxClaims) || maxClaims < 1)) {
    fail('SHARED_WORKER_INVALID', 'maxClaims must be a positive integer.');
  }
  const summary = {
    workerId: worker.id,
    claimed: 0,
    completed: 0,
    productFailures: 0,
    operationalRetries: 0,
    adoptedWorkItemIds: [],
  };
  while (summary.claimed < maxClaims) {
    let lease;
    try {
      lease = await claimWorkItem(store, runId, coordinator, {
        workerId: worker.id,
        capabilities: worker.capabilities,
        resourceClasses: worker.resourceClasses,
        leaseMs,
      });
    } catch (error) {
      if (['NO_WORK_AVAILABLE', 'NO_COMPATIBLE_WORK', 'PERFORMANCE_DRAIN_PENDING', 'PERFORMANCE_DRAIN_REQUIRED'].includes(error?.code)) break;
      throw error;
    }
    summary.claimed += 1;
    let logSequence = 0;
    await appendAttemptLog(store, runId, lease, {
      sequence: ++logSequence,
      level: 'info',
      message: logMessage('command-started', `${lease.capability} ${lease.targetId}${lease.specAffinity ? ` ${lease.specAffinity}` : ''}`),
    });
    let result;
    try {
      result = validateSuccessfulExecution(await execute(Object.freeze({ ...lease }), worker));
    } catch (error) {
      const classified = classifyExecutionFailure(error?.executionFailure);
      result = { outcome: classified.outcome, reason: classified.reason, artifacts: [] };
      await appendAttemptLog(store, runId, lease, {
        sequence: ++logSequence,
        level: classified.retryable ? 'warn' : 'error',
        message: logMessage(classified.retryable ? 'operational-recovery' : 'product-failure', classified.reason),
      });
    }
    const inbox = await publishAttemptEvidence(store, runId, lease, result);
    const adopted = await adoptAttemptEvidence(store, runId, coordinator, inbox);
    summary.adoptedWorkItemIds.push(adopted.id);
    if (result.outcome === 'operational_failure') summary.operationalRetries += 1;
    else {
      summary.completed += 1;
      if (result.outcome === 'completed_product_failure') summary.productFailures += 1;
    }
  }
  return Object.freeze({ ...summary, adoptedWorkItemIds: Object.freeze([...summary.adoptedWorkItemIds]) });
}
