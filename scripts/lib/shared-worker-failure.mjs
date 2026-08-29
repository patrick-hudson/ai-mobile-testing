const OPERATIONAL_FAILURE_ALLOWLIST = new Set([
  'browser_process_crash',
  'container_evicted',
  'worker_process_terminated',
  'coordinator_transport_unavailable',
]);

export function classifyExecutionFailure(value = {}) {
  const kind = typeof value.kind === 'string' && value.kind ? value.kind : 'unclassified_execution_failure';
  const operational = value.trustedPlatformSignal === true && OPERATIONAL_FAILURE_ALLOWLIST.has(kind);
  return operational
    ? { outcome: 'operational_failure', reason: kind, retryable: true }
    : { outcome: 'completed_product_failure', reason: kind, retryable: false };
}
