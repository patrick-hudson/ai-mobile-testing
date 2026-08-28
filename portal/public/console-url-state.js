const SAFE_FOCUS_KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

export function createConsoleUrlState({
  window,
  routeId,
  parse,
  serialize,
  onChange,
  onRestoreFocus,
  maximumPushes = 40,
}) {
  if (!window?.history || typeof parse !== 'function' || typeof serialize !== 'function') {
    throw new TypeError('URL state requires a window and contract parser/serializer.');
  }
  let pushes = 0;
  let restoreFrame = null;
  let current;
  current = canonicalize(window.location.search, { notify: false });

  function urlFor(search) {
    return `${window.location.pathname}${search ? `?${search}` : ''}`;
  }

  function safeFocusKey(value) {
    return SAFE_FOCUS_KEY.test(String(value ?? '')) ? String(value) : null;
  }

  function canonicalize(input, { notify = true, focusKey = null } = {}) {
    const parsed = parse(routeId, input);
    if (window.location.search.slice(1) !== parsed.search || window.location.hash) {
      window.history.replaceState({ consoleFocusKey: safeFocusKey(focusKey) }, '', urlFor(parsed.search));
    }
    current = parsed;
    if (notify) onChange?.(parsed, { source: 'history' });
    return parsed;
  }

  function setState(nextState, { history = 'push', focusKey = null } = {}) {
    const search = serialize(routeId, nextState);
    const method = history === 'replace' || pushes >= maximumPushes ? 'replaceState' : 'pushState';
    if (method === 'pushState') pushes += 1;
    const storedFocus = safeFocusKey(focusKey);
    window.history[method]({ consoleFocusKey: storedFocus }, '', urlFor(search));
    current = parse(routeId, search);
    onChange?.(current, { source: method === 'pushState' ? 'push' : 'replace' });
    return current;
  }

  function onPopState(event) {
    const parsed = canonicalize(window.location.search);
    const focusKey = safeFocusKey(event.state?.consoleFocusKey);
    if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
    restoreFrame = window.requestAnimationFrame(() => {
      restoreFrame = null;
      if (current?.search !== parsed.search || window.location.search.slice(1) !== parsed.search) return;
      onRestoreFocus?.(focusKey, parsed);
    });
  }

  window.addEventListener('popstate', onPopState);
  queueMicrotask(() => onChange?.(current, { source: 'initial' }));
  return {
    get current() { return current; },
    setState,
    replaceState: (state, options = {}) => setState(state, { ...options, history: 'replace' }),
    destroy() {
      window.removeEventListener('popstate', onPopState);
      if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
    },
  };
}
