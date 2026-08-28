const STATE_MESSAGES = Object.freeze({
  'initial-loading': 'Loading this region…',
  ready: 'Current data loaded.',
  refreshing: 'Refreshing while current data remains available…',
  partial: 'Available data is incomplete.',
  'empty-success': 'No matching records.',
  stale: 'Refresh failed. Showing the last known data.',
  'retryable-failure': 'This region could not be loaded.',
  unavailable: 'This region is currently unavailable.',
  'permission-denied': 'Permission is required for this region.',
  reconnecting: 'Reconnecting while the last known data remains available…',
  offline: 'Offline. Showing the last known data.',
});

const STATES = new Set(Object.keys(STATE_MESSAGES));
const BUSY_STATES = new Set(['initial-loading', 'refreshing', 'reconnecting']);
const RETRY_STATES = new Set(['partial', 'stale', 'retryable-failure', 'unavailable', 'offline']);

export function createAsyncRegion({
  root,
  load,
  render,
  isEmpty = (value) => Array.isArray(value) && value.length === 0,
  now = () => new Date(),
  describeFreshness = null,
  onError = null,
  online = () => globalThis.navigator?.onLine !== false,
}) {
  const status = root.querySelector('[data-async-status]');
  const content = root.querySelector('[data-async-content]');
  const freshness = root.querySelector('[data-async-freshness]');
  const retry = root.querySelector('[data-async-retry]');
  if (!status || !content || !freshness || !retry) throw new TypeError('Async region markup is incomplete.');
  let controller = null;
  let generation = 0;
  let lastKey = null;
  let value = null;
  let loadedAt = null;
  let freshnessText = null;
  let lastError = null;
  let state = 'initial-loading';

  function setState(nextState, message = STATE_MESSAGES[nextState]) {
    if (!STATES.has(nextState)) throw new TypeError('Unknown async region state.');
    state = nextState;
    root.dataset.asyncState = nextState;
    root.setAttribute('aria-busy', BUSY_STATES.has(nextState) ? 'true' : 'false');
    status.textContent = message ?? '';
    retry.hidden = !RETRY_STATES.has(nextState);
    freshness.textContent = freshnessText ?? (loadedAt ? `Updated ${loadedAt.toISOString()}` : 'Not loaded');
  }

  async function request(key, { refresh = value !== null } = {}) {
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    const requestGeneration = ++generation;
    lastKey = key;
    setState(refresh && value !== null ? 'refreshing' : 'initial-loading');
    try {
      const result = await load({ key, signal: requestController.signal, generation: requestGeneration });
      if (requestController.signal.aborted || requestGeneration !== generation || controller !== requestController) return null;
      value = result;
      loadedAt = now();
      lastError = null;
      freshnessText = typeof describeFreshness === 'function' ? describeFreshness(result, loadedAt) : null;
      render(result, content);
      setState(isEmpty(result) ? 'empty-success' : 'ready');
      return result;
    } catch (error) {
      if (requestController.signal.aborted || error?.name === 'AbortError' || requestGeneration !== generation) return null;
      lastError = error;
      const nextState = classifyAsyncError(error, { hasValue: value !== null, online: online() });
      setState(nextState, asyncErrorMessage(error, nextState));
      onError?.(error, Object.freeze({ key, hasValue: value !== null, state: nextState }));
      return null;
    } finally {
      if (controller === requestController) controller = null;
    }
  }

  function retryLast() {
    if (lastKey !== null) void request(lastKey, { refresh: value !== null });
  }

  retry.addEventListener('click', retryLast);
  setState('initial-loading');
  return {
    request,
    setState,
    get snapshot() { return Object.freeze({ state, key: lastKey, value, loadedAt, error: lastError }); },
    destroy() {
      generation += 1;
      controller?.abort();
      retry.removeEventListener('click', retryLast);
    },
  };
}

export function classifyAsyncError(error, { hasValue = false, online = true } = {}) {
  const status = Number(error?.status ?? error?.statusCode ?? 0);
  const code = String(error?.code ?? '');
  if (status === 401 || status === 403 || code.includes('PERMISSION') || code.includes('UNAUTHORIZED')) return 'permission-denied';
  if (!online || (status === 0 && error?.name === 'TypeError')) return 'offline';
  if (code === 'CONSOLE_RESPONSE_LIMIT' || status === 413 || status === 410 || status === 404) return 'unavailable';
  if (hasValue) return 'stale';
  if (error?.retryable === true || status === 409 || status >= 500) return 'retryable-failure';
  return 'unavailable';
}

function asyncErrorMessage(error, state) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const base = STATE_MESSAGES[state];
  return code ? `${base} (${code})` : base;
}
