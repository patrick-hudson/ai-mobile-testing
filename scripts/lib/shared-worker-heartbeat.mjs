export class SharedWorkLeaseFencedError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'SharedWorkLeaseFencedError';
    this.code = 'SHARED_WORK_LEASE_FENCED';
  }
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
} = {}) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    throw new TypeError('A shared work lease is required.');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 1_200_000) {
    throw new TypeError('Shared work heartbeat interval must be an integer from 1 through 1200000.');
  }
  if (typeof heartbeat !== 'function' || typeof execute !== 'function' || typeof waitForHeartbeat !== 'function') {
    throw new TypeError('Shared work heartbeat, executor, and interval wait callbacks are required.');
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
  const executorAbort = new AbortController();
  const maintenanceStop = new AbortController();

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
      try {
        const renewed = await heartbeat(currentLease, maintenanceStop.signal);
        if (!renewed || typeof renewed !== 'object' || renewed.token !== currentLease.token
          || renewed.workItemId !== currentLease.workItemId || renewed.workerId !== currentLease.workerId
          || renewed.attempt !== currentLease.attempt || renewed.epoch !== currentLease.epoch) {
          throw new Error('Coordinator returned a heartbeat lease with different fencing identity.');
        }
        currentLease = Object.freeze({ ...renewed });
      } catch (error) {
        if (maintenanceStop.signal.aborted) return;
        heartbeatFailure = error;
        reportHeartbeatFailure({ kind: 'heartbeat-failed' });
        return;
      }
    }
  })();

  const execution = Promise.resolve()
    .then(() => execute({ signal: executorAbort.signal, lease: liveLease }))
    .then(
      (value) => ({ kind: 'execution-finished', value }),
      (error) => ({ kind: 'execution-failed', error }),
    );
  const first = await Promise.race([execution, heartbeatFailed]);

  if (first.kind === 'heartbeat-failed') {
    executorAbort.abort(heartbeatFailure);
    maintenanceStop.abort(heartbeatFailure);
    throw new SharedWorkLeaseFencedError('Coordinator rejected the shared work lease heartbeat; executor was aborted and the attempt was fenced.', {
      cause: heartbeatFailure,
    });
  }

  maintenanceStop.abort(new Error('Shared work executor completed.'));
  await maintenance;
  if (heartbeatFailure) {
    executorAbort.abort(heartbeatFailure);
    throw new SharedWorkLeaseFencedError('Coordinator rejected the shared work lease heartbeat; executor was aborted and the attempt was fenced.', {
      cause: heartbeatFailure,
    });
  }
  if (first.kind === 'execution-failed') throw first.error;
  return Object.freeze({ value: first.value, lease: currentLease });
}
