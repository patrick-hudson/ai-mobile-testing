const CONNECTION_STATES = new Set(['connecting', 'connected', 'reconnecting', 'offline', 'closed']);

export function createConsoleLiveState({ initialDurable, assertClientMayWriteStateDomain, render, now = () => new Date().toISOString() }) {
  let connection = 'connecting';
  let durable = freezeDurable(initialDurable);
  let lastServerUpdate = null;
  let stale = true;

  function snapshot() {
    return Object.freeze({ connection, durable, lastServerUpdate, stale });
  }

  function publish() {
    const value = snapshot();
    render?.(value);
    return value;
  }

  function setConnection(next) {
    assertClientMayWriteStateDomain?.('connection');
    if (!CONNECTION_STATES.has(next)) throw new TypeError('Unknown connection state.');
    connection = next;
    if (next !== 'connected') stale = true;
    return publish();
  }

  function acceptAuthoritativeSnapshot(nextDurable, { updatedAt = now() } = {}) {
    if (!nextDurable || typeof nextDurable !== 'object' || Array.isArray(nextDurable)) {
      throw new TypeError('Authoritative state must be an object.');
    }
    durable = freezeDurable(nextDurable);
    lastServerUpdate = typeof updatedAt === 'string' && updatedAt ? updatedAt : null;
    stale = connection !== 'connected';
    return publish();
  }

  publish();
  return { setConnection, acceptAuthoritativeSnapshot, get snapshot() { return snapshot(); } };
}

function freezeDurable(value) {
  const clone = value && typeof value === 'object' ? structuredClone(value) : {};
  return deepFreeze(clone);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}
