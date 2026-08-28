const CHANNEL_NAME = 'quitting7oh-audit-console-invalidation-v1';
const EVENT_NAME = 'audit-console:run-invalidated';
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export function createRunInvalidationBus({ window = globalThis.window, onInvalidate } = {}) {
  if (!window?.addEventListener || typeof onInvalidate !== 'function') {
    throw new TypeError('Run invalidation requires a browser window and listener.');
  }
  let channel = null;
  const accept = (value) => {
    const detail = normalizeInvalidation(value);
    if (detail) onInvalidate(detail);
  };
  const onEvent = (event) => accept(event.detail);
  const onMessage = (event) => accept(event.data);
  window.addEventListener(EVENT_NAME, onEvent);
  if (typeof window.BroadcastChannel === 'function') {
    channel = new window.BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener('message', onMessage);
  }
  return Object.freeze({
    destroy() {
      window.removeEventListener(EVENT_NAME, onEvent);
      channel?.removeEventListener('message', onMessage);
      channel?.close();
      channel = null;
    },
  });
}

export function publishRunInvalidation({ window = globalThis.window, mode, runId, reason = 'purged' } = {}) {
  const detail = normalizeInvalidation({ schemaVersion: 1, mode, runId, reason, occurredAt: new Date().toISOString() });
  if (!detail || !window?.dispatchEvent) throw new TypeError('Run invalidation identity is invalid.');
  window.dispatchEvent(new window.CustomEvent(EVENT_NAME, { detail }));
  if (typeof window.BroadcastChannel === 'function') {
    const channel = new window.BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(detail);
    channel.close();
  }
  return detail;
}

function normalizeInvalidation(value) {
  if (!value || value.schemaVersion !== 1 || !['comparative', 'single-site'].includes(value.mode)
    || !RUN_ID.test(String(value.runId ?? '')) || value.reason !== 'purged') return null;
  const occurred = Date.parse(value.occurredAt ?? '');
  return Object.freeze({
    schemaVersion: 1,
    mode: value.mode,
    runId: value.runId,
    reason: 'purged',
    occurredAt: Number.isFinite(occurred) ? new Date(occurred).toISOString() : null,
  });
}
