const DEFAULT_TERMINATION_GRACE_MS = 3_000;
const DEFAULT_KILL_SETTLE_MS = 1_000;

function positiveInteger(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 60_000) {
    throw new TypeError(`${label} must be an integer from 1 through 60000 milliseconds.`);
  }
  return resolved;
}

export function spawnProcessGroupOptions(platform = process.platform) {
  return { detached: platform !== 'win32' };
}

export function signalProcessGroup(child, signal, platform = process.platform) {
  if (!child || !Number.isInteger(child.pid)) return false;
  try {
    if (platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    try {
      return child.kill(signal);
    } catch (fallbackError) {
      if (fallbackError?.code === 'ESRCH') return false;
      throw fallbackError;
    }
  }
}

export function createProcessTerminationController(child, {
  onTerminate = () => {},
  onForceKill = () => {},
  onUnresponsive = () => {},
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  killSettleMs = DEFAULT_KILL_SETTLE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  platform = process.platform,
} = {}) {
  const graceMs = positiveInteger(terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, 'terminationGraceMs');
  const settleMs = positiveInteger(killSettleMs, DEFAULT_KILL_SETTLE_MS, 'killSettleMs');
  let requested = false;
  let forceKilled = false;
  let reason = null;
  let graceTimer = null;
  let settleTimer = null;

  const clear = () => {
    if (graceTimer !== null) clearTimer(graceTimer);
    if (settleTimer !== null) clearTimer(settleTimer);
    graceTimer = null;
    settleTimer = null;
  };
  const terminate = (requestedReason = 'aborted') => {
    if (requested) return;
    requested = true;
    reason = String(requestedReason || 'aborted').slice(0, 1_000);
    onTerminate({ reason, signal: 'SIGTERM', graceMs });
    signalProcessGroup(child, 'SIGTERM', platform);
    graceTimer = setTimer(() => {
      graceTimer = null;
      forceKilled = true;
      onForceKill({ reason, signal: 'SIGKILL', settleMs });
      signalProcessGroup(child, 'SIGKILL', platform);
      settleTimer = setTimer(() => {
        settleTimer = null;
        onUnresponsive({ reason, signal: 'SIGKILL' });
      }, settleMs);
    }, graceMs);
  };
  return {
    terminate,
    clear,
    get requested() { return requested; },
    get forceKilled() { return forceKilled; },
    get reason() { return reason; },
  };
}
