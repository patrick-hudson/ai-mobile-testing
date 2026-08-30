export class SharedWorkLeaseFencedError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'SharedWorkLeaseFencedError';
    this.code = 'SHARED_WORK_LEASE_FENCED';
  }
}

const EXPLICIT_FENCE_CODES = new Set([
  'AUTHORIZATION_DENIED',
  'SHARED_WORK_HEARTBEAT_REJECTED',
  'SHARED_WORK_LEASE_IDENTITY_CHANGED',
  'STALE_WORK_LEASE',
  'WORK_RESULT_BINDING_MISMATCH',
]);

function executorAbortReason(cause, lease, { expiring = false } = {}) {
  const error = new Error(expiring
    ? 'The shared work executor reached its last acknowledged lease termination boundary.'
    : 'The shared work executor lost its acknowledged heartbeat authority.', { cause });
  error.code = expiring ? 'SHARED_WORK_LEASE_EXPIRING' : 'SHARED_WORK_LEASE_HEARTBEAT_FAILED';
  error.hardDeadlineAt = lease.expiresAt;
  error.immediate = !expiring && EXPLICIT_FENCE_CODES.has(cause?.code);
  return error;
}

export function sharedWorkHeartbeatInterval(leaseDurationMs) {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 300 || leaseDurationMs > 3_600_000) {
    throw new TypeError('Shared work lease duration must be an integer from 300 through 3600000.');
  }
  return Math.max(100, Math.min(10_000, Math.floor(leaseDurationMs / 3)));
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const elapsed = () => {
      signal.removeEventListener('abort', aborted);
      resolve();
    };
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(elapsed, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export async function maintainSharedWorkerLease({
  lease,
  intervalMs,
  heartbeat,
  execute,
  waitForHeartbeat = abortableDelay,
  retryHeartbeat = () => false,
  retryDelayMs = 250,
  maxHeartbeatRetries = 1,
  expirySafetyMs = 0,
  now = () => Date.now(),
} = {}) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    throw new TypeError('A shared work lease is required.');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 1_200_000) {
    throw new TypeError('Shared work heartbeat interval must be an integer from 1 through 1200000.');
  }
  if (typeof heartbeat !== 'function' || typeof execute !== 'function' || typeof waitForHeartbeat !== 'function'
    || typeof retryHeartbeat !== 'function' || typeof now !== 'function') {
    throw new TypeError('Shared work heartbeat, executor, interval wait, retry policy, and clock callbacks are required.');
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 60_000) {
    throw new TypeError('Shared work heartbeat retry delay must be an integer from 1 through 60000.');
  }
  if (!Number.isSafeInteger(maxHeartbeatRetries) || maxHeartbeatRetries < 0 || maxHeartbeatRetries > 8) {
    throw new TypeError('Shared work heartbeat retry count must be an integer from 0 through 8.');
  }
  if (!Number.isSafeInteger(expirySafetyMs) || expirySafetyMs < 0 || expirySafetyMs > 60_000) {
    throw new TypeError('Shared work lease expiry safety margin must be an integer from 0 through 60000.');
  }

  let currentLease = Object.freeze({ ...lease });
  const liveLease = Object.freeze(Object.defineProperties({}, Object.fromEntries(
    Object.keys(currentLease).map((key) => [key, {
      enumerable: true,
      get: () => currentLease[key],
    }]),
  )));
  let heartbeatFailure = null;
  let reportHeartbeatFailure;
  const heartbeatFailed = new Promise((resolve) => { reportHeartbeatFailure = resolve; });
  let reportLeaseExpiring;
  const leaseExpiring = new Promise((resolve) => { reportLeaseExpiring = resolve; });
  const executorAbort = new AbortController();
  const maintenanceStop = new AbortController();
  let expiryTimer = null;
  const armExpiryWatchdog = () => {
    clearTimeout(expiryTimer);
    const expiresAt = Date.parse(currentLease.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      const error = new TypeError('Shared work lease expiresAt must be a valid timestamp.');
      error.code = 'SHARED_WORK_LEASE_EXPIRY_INVALID';
      reportLeaseExpiring({ kind: 'lease-expiring', error });
      return;
    }
    const delayMs = Math.max(0, expiresAt - expirySafetyMs - now());
    expiryTimer = setTimeout(() => {
      reportLeaseExpiring({
        kind: 'lease-expiring',
        error: executorAbortReason(null, currentLease, { expiring: true }),
      });
    }, delayMs);
  };
  armExpiryWatchdog();

  const maintenance = (async () => {
    while (!maintenanceStop.signal.aborted) {
      try {
        await waitForHeartbeat(intervalMs, maintenanceStop.signal);
      } catch (error) {
        if (maintenanceStop.signal.aborted) return;
        heartbeatFailure = error;
        reportHeartbeatFailure({ kind: 'heartbeat-failed' });
        return;
      }
      if (maintenanceStop.signal.aborted) return;
      let retryCount = 0;
      while (!maintenanceStop.signal.aborted) {
        try {
          const renewed = await heartbeat(currentLease, maintenanceStop.signal);
          if (!renewed || typeof renewed !== 'object' || renewed.token !== currentLease.token
            || renewed.workItemId !== currentLease.workItemId || renewed.workerId !== currentLease.workerId
            || renewed.attempt !== currentLease.attempt || renewed.epoch !== currentLease.epoch) {
            const error = new Error('Coordinator returned a heartbeat lease with different fencing identity.');
            error.code = 'SHARED_WORK_LEASE_IDENTITY_CHANGED';
            throw error;
          }
          if (maintenanceStop.signal.aborted) return;
          currentLease = Object.freeze({ ...renewed });
          armExpiryWatchdog();
          break;
        } catch (error) {
          if (maintenanceStop.signal.aborted) return;
          const expiresAt = Date.parse(currentLease.expiresAt);
          let policyAllowsRetry = false;
          try {
            policyAllowsRetry = retryHeartbeat(error, currentLease) === true;
          } catch (policyError) {
            heartbeatFailure = policyError;
            reportHeartbeatFailure({ kind: 'heartbeat-failed' });
            return;
          }
          const retryable = error?.code !== 'SHARED_WORK_LEASE_IDENTITY_CHANGED'
            && retryCount < maxHeartbeatRetries
            && policyAllowsRetry
            && Number.isFinite(expiresAt)
            && now() + retryDelayMs + expirySafetyMs < expiresAt;
          if (!retryable) {
            heartbeatFailure = error;
            reportHeartbeatFailure({ kind: 'heartbeat-failed' });
            return;
          }
          retryCount += 1;
          try {
            await waitForHeartbeat(retryDelayMs, maintenanceStop.signal);
          } catch (retryWaitError) {
            if (maintenanceStop.signal.aborted) return;
            heartbeatFailure = retryWaitError;
            reportHeartbeatFailure({ kind: 'heartbeat-failed' });
            return;
          }
        }
      }
    }
  })();

  const execution = Promise.resolve()
    .then(() => execute({ signal: executorAbort.signal, lease: liveLease }))
    .then(
      (value) => ({ kind: 'execution-finished', value }),
      (error) => ({ kind: 'execution-failed', error }),
    );
  const first = await Promise.race([execution, heartbeatFailed, leaseExpiring]);

  if (first.kind === 'heartbeat-failed') {
    executorAbort.abort(executorAbortReason(heartbeatFailure, currentLease));
    maintenanceStop.abort(heartbeatFailure);
    clearTimeout(expiryTimer);
    throw new SharedWorkLeaseFencedError('Coordinator rejected the shared work lease heartbeat; executor was aborted and the attempt was fenced.', {
      cause: heartbeatFailure,
    });
  }
  if (first.kind === 'lease-expiring') {
    executorAbort.abort(first.error);
    maintenanceStop.abort(first.error);
    clearTimeout(expiryTimer);
    throw new SharedWorkLeaseFencedError('The last acknowledged shared work lease reached its local termination boundary; executor was aborted.', {
      cause: first.error,
    });
  }

  maintenanceStop.abort(new Error('Shared work executor completed.'));
  clearTimeout(expiryTimer);
  await maintenance;
  if (heartbeatFailure) {
    executorAbort.abort(executorAbortReason(heartbeatFailure, currentLease));
    throw new SharedWorkLeaseFencedError('Coordinator rejected the shared work lease heartbeat; executor was aborted and the attempt was fenced.', {
      cause: heartbeatFailure,
    });
  }
  if (first.kind === 'execution-failed') throw first.error;
  return Object.freeze({ value: first.value, lease: currentLease });
}
