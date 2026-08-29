const MINIMUM_REFRESH_MS = 1_000;
const MAXIMUM_REFRESH_MS = 5 * 60_000;

export function overviewRefreshInterval(page) {
  return page?.overview?.activeRuns?.total > 0 ? 5_000 : 30_000;
}

export function runListRefreshInterval(page) {
  return page?.items?.some((record) => record?.fields?.terminal !== true) ? 5_000 : 30_000;
}

export function createConsoleIndexRefreshController({
  document = globalThis.document,
  refresh,
  intervalFor,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  if (!document?.addEventListener || !document?.removeEventListener
    || typeof refresh !== 'function' || typeof intervalFor !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('Console index refresh requires a document, refresh callback, cadence, and timers.');
  }

  let timer = null;
  let destroyed = false;
  let refreshing = false;
  let lastResult = null;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    cancelTimer();
    if (destroyed || document.hidden || lastResult === null) return;
    const milliseconds = intervalFor(lastResult);
    if (!Number.isSafeInteger(milliseconds)
      || milliseconds < MINIMUM_REFRESH_MS || milliseconds > MAXIMUM_REFRESH_MS) {
      throw new TypeError('Console index refresh cadence must be between 1000 and 300000 milliseconds.');
    }
    timer = setTimer(() => {
      timer = null;
      void trigger();
    }, milliseconds);
  };

  async function trigger() {
    if (destroyed || document.hidden || refreshing) return false;
    cancelTimer();
    refreshing = true;
    try {
      await refresh();
      return true;
    } finally {
      refreshing = false;
      if (timer === null) schedule();
    }
  }

  const onVisibilityChange = () => {
    if (document.hidden) cancelTimer();
    else void trigger();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  return Object.freeze({
    begin() { cancelTimer(); },
    accept(result) {
      if (result !== null && result !== undefined) lastResult = result;
      schedule();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  });
}
