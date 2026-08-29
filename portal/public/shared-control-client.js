const PREFIX = '/api/control/v1';
const TERMINAL_OPERATION_STATES = new Set(['completed', 'succeeded', 'failed', 'cancelled']);
const MUTATION_PATHS = Object.freeze({
  cancel: 'cancel',
  rekick: 'rekick',
  diagnosticRerun: 'diagnostic-rerun',
  riskAcknowledge: 'risks/acknowledge',
  riskResolve: 'risks/resolve',
  visualDisposition: 'visual/disposition',
  purge: 'purge',
});
const RISK_SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
const OPERATIONAL_RISK_CATEGORIES = new Set(['certificate-bypass', 'evidence-pipeline-limitation']);
const ACTIVE_RISK_STATES = new Set(['OPEN', 'ACKNOWLEDGED', 'PENDING_REVIEW']);
export const SHARED_RISK_PAGE_SIZE = 200;

export class SharedControlBrowserError extends Error {
  constructor(message, { status = 0, code = 'SHARED_CONTROL_REQUEST_FAILED', body = null } = {}) {
    super(message);
    this.name = 'SharedControlBrowserError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function orderSharedRisksForReview(risks) {
  if (!Array.isArray(risks)) return [];
  return [...risks].sort((left, right) => {
    const active = Number(!ACTIVE_RISK_STATES.has(left?.reviewState))
      - Number(!ACTIVE_RISK_STATES.has(right?.reviewState));
    if (active !== 0) return active;
    const severity = (RISK_SEVERITY_ORDER[left?.severity] ?? 99) - (RISK_SEVERITY_ORDER[right?.severity] ?? 99);
    if (severity !== 0) return severity;
    const operational = Number(OPERATIONAL_RISK_CATEGORIES.has(left?.category))
      - Number(OPERATIONAL_RISK_CATEGORIES.has(right?.category));
    if (operational !== 0) return operational;
    return String(left?.identity ?? '').localeCompare(String(right?.identity ?? ''));
  });
}

export function pageSharedRisksForReview(risks, { offset = 0, limit = SHARED_RISK_PAGE_SIZE } = {}) {
  const ordered = orderSharedRisksForReview(risks);
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(SHARED_RISK_PAGE_SIZE, limit)) : SHARED_RISK_PAGE_SIZE;
  const maximumOffset = ordered.length === 0 ? 0 : Math.floor((ordered.length - 1) / boundedLimit) * boundedLimit;
  const boundedOffset = Number.isSafeInteger(offset) ? Math.max(0, Math.min(maximumOffset, offset)) : 0;
  const items = ordered.slice(boundedOffset, boundedOffset + boundedLimit);
  const start = items.length === 0 ? 0 : boundedOffset + 1;
  const end = boundedOffset + items.length;
  return Object.freeze({
    items: Object.freeze(items), total: ordered.length, offset: boundedOffset, limit: boundedLimit,
    start, end, showing: `Showing ${start}${items.length ? `–${end}` : ''} of ${ordered.length} risks`,
    hasPrevious: boundedOffset > 0, hasNext: end < ordered.length,
  });
}

export function assertSharedWorkspaceProjection(value, { runId, mode } = {}) {
  const publication = value?.publication;
  const executions = value?.executions;
  const logs = value?.logs;
  const register = publication?.riskRegister;
  const coreBound = publication?.decision?.subjectStage === 'core';
  const certifiedScope = coreBound
    ? publication?.decision?.requestedAuthority?.scope
    : publication?.decision?.certifiedScope;
  const subjectDigest = publication?.finalSubjectDigest ?? publication?.subjectCoreDigest;
  if (!publication || (runId !== undefined && publication.runId !== runId)
    || (mode !== undefined && publication.decision?.mode !== mode)
    || !Number.isSafeInteger(publication.runRevision) || publication.runRevision < 1
    || !Number.isSafeInteger(publication.decisionRevision) || publication.decisionRevision < 1
    || !Number.isSafeInteger(publication.riskRevision) || publication.riskRevision < 1
    || typeof subjectDigest !== 'string'
    || (coreBound ? publication.finalSubjectDigest !== null : typeof publication.finalSubjectDigest !== 'string')
    || typeof publication.decision?.label !== 'string'
    || (coreBound
      ? publication.decision?.grantedAuthority !== null
      : typeof publication.decision?.grantedAuthority !== 'string')
    || !canonicalScope(certifiedScope)
    || !['LOADING', 'PROVISIONAL', 'AVAILABLE', 'PARTIAL', 'EMPTY', 'UNAVAILABLE'].includes(register?.availability)
    || !Array.isArray(register?.risks) || !Array.isArray(executions?.executions)
    || !Array.isArray(executions?.oracleExecutions)
    || (executions?.diagnosticExecutions !== undefined
      && (!Array.isArray(executions.diagnosticExecutions)
        || executions.diagnosticExecutions.some((entry) => typeof entry?.diagnosticExecutionId !== 'string'
          || typeof entry?.workItemId !== 'string' || typeof entry?.state !== 'string')))
    || executions.executions.some((entry) => typeof entry?.id !== 'string' || typeof entry?.state !== 'string')
    || executions.oracleExecutions.some((entry) => typeof entry?.id !== 'string')
    || typeof value?.snapshotToken !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.snapshotToken)
    || !Number.isSafeInteger(value?.stateRevision) || value.stateRevision < 1
    || executions.runId !== publication.runId
    || logs?.runId !== publication.runId
    || !Array.isArray(logs?.events) || !Array.isArray(logs?.attemptLogs)) {
    throw new SharedControlBrowserError('Shared release authority is unavailable or has no coherent revision.', {
      code: 'SHARED_CONTROL_PROJECTION_INVALID',
    });
  }
  if ((['LOADING', 'EMPTY', 'UNAVAILABLE'].includes(register.availability) && register.risks.length !== 0)
    || (register.availability === 'AVAILABLE' && register.risks.length === 0)) {
    throw new SharedControlBrowserError('Shared Risk Register contains an invalid bounded projection.', {
      code: 'SHARED_CONTROL_PROJECTION_INVALID',
    });
  }
  for (const risk of register.risks) {
    if (!risk || typeof risk.identity !== 'string' || typeof risk.category !== 'string'
      || typeof risk.severity !== 'string' || typeof risk.reviewState !== 'string'
      || typeof risk.explanation !== 'string' || typeof risk.recommendedAction !== 'string'
      || typeof risk.source?.kind !== 'string' || typeof risk.source?.id !== 'string'
      || !canonicalScope(risk.scope)
      || typeof risk.actor?.id !== 'string' || typeof risk.actor?.kind !== 'string'
      || !canonicalTimestamp(risk.observedAt) || !canonicalTimestamp(risk.updatedAt)
      || risk.releaseEffect !== 'non-blocking') {
      throw new SharedControlBrowserError('Shared Risk Register contains an invalid bounded projection.', {
        code: 'SHARED_CONTROL_PROJECTION_INVALID',
      });
    }
  }
  return value;
}

function canonicalScope(value) {
  return Boolean(value && typeof value === 'object'
    && ['features', 'definitions', 'targets', 'knownLimits'].every((key) => (
      Array.isArray(value[key]) && value[key].every((entry) => typeof entry === 'string')
    )));
}

function canonicalTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function sharedWorkspaceRevisionKey(workspace) {
  const publication = workspace?.publication;
  const subjectDigest = publication?.finalSubjectDigest ?? publication?.subjectCoreDigest;
  if (!publication || !/^sha256:[a-f0-9]{64}$/u.test(workspace?.snapshotToken ?? '')
    || !Number.isSafeInteger(publication.runRevision)
    || !Number.isSafeInteger(publication.decisionRevision)
    || !Number.isSafeInteger(publication.riskRevision)
    || typeof subjectDigest !== 'string') return null;
  return [
    workspace.snapshotToken,
    publication.runRevision,
    publication.decisionRevision,
    publication.riskRevision,
    subjectDigest,
  ].join('\u0000');
}

export function isRetryableSharedControlError(error) {
  const status = Number(error?.status ?? 0);
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500
    || error?.code === 'SHARED_CONTROL_REVISION_RACE';
}

export function createSharedWorkspacePoller({
  load,
  onSnapshot,
  onConfirmed = () => {},
  onUnavailable,
  onStale = onUnavailable,
  isTerminal,
  isRetryable = isRetryableSharedControlError,
  activeRefreshMs = 5_000,
  terminalRefreshMs = 30_000,
  maximumRetryMs = 30_000,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  if (typeof load !== 'function' || typeof onSnapshot !== 'function'
    || typeof onUnavailable !== 'function' || typeof isTerminal !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('Shared workspace poller requires load, render, terminal, and timer functions.');
  }
  for (const [name, value] of Object.entries({ activeRefreshMs, terminalRefreshMs, maximumRetryMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  }

  let controller = null;
  let timer = null;
  let generation = 0;
  let visible = true;
  let destroyed = false;
  let retryAttempt = 0;
  let revisionKey = null;
  let lastSnapshot = null;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const current = (requestGeneration, requestController) => !destroyed && visible
    && generation === requestGeneration && controller === requestController && !requestController.signal.aborted;
  const schedule = (delay) => {
    cancelTimer();
    if (destroyed || !visible) return;
    timer = setTimer(() => {
      timer = null;
      void refresh();
    }, delay);
  };

  async function refresh(options = {}) {
    if (destroyed || !visible) return false;
    cancelTimer();
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    const requestGeneration = ++generation;
    try {
      const snapshot = await load({ signal: requestController.signal });
      if (!current(requestGeneration, requestController)) return false;
      const nextRevisionKey = sharedWorkspaceRevisionKey(snapshot);
      const changed = nextRevisionKey === null || nextRevisionKey !== revisionKey;
      revisionKey = nextRevisionKey;
      lastSnapshot = snapshot;
      retryAttempt = 0;
      if (changed) onSnapshot(snapshot, options);
      else onConfirmed(snapshot, options);
      schedule(isTerminal(snapshot) ? terminalRefreshMs : activeRefreshMs);
      return true;
    } catch (error) {
      if (!current(requestGeneration, requestController) || error?.name === 'AbortError') return false;
      if (!isRetryable(error)) {
        onUnavailable(error, { retrying: false, snapshot: lastSnapshot });
        return false;
      }
      const retryMs = Math.min(maximumRetryMs, activeRefreshMs * (2 ** Math.min(retryAttempt, 8)));
      retryAttempt += 1;
      if (lastSnapshot) onStale(error, { retrying: true, retryMs, snapshot: lastSnapshot });
      else onUnavailable(error, { retrying: true, retryMs, snapshot: null });
      schedule(retryMs);
      return false;
    } finally {
      if (controller === requestController) controller = null;
    }
  }

  return Object.freeze({
    refresh,
    setVisible(nextVisible) {
      const next = Boolean(nextVisible);
      if (visible === next || destroyed) return;
      visible = next;
      cancelTimer();
      controller?.abort();
      controller = null;
      generation += 1;
      if (visible) void refresh();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelTimer();
      controller?.abort();
      controller = null;
      generation += 1;
    },
  });
}

export function createSharedControlBrowserClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Shared control client requires fetch.');
  let session = null;
  let authenticationAttempt = 0;

  async function request(path, { method = 'GET', body, idempotencyKey, signal } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD' && session?.csrfToken) headers['X-Audit-CSRF'] = session.csrfToken;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetchImpl(path, {
      method, headers, credentials: 'same-origin', signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const document = await response.json().catch(() => null);
    if (!response.ok) {
      const error = document?.error;
      const message = typeof error === 'string' ? error : error?.message;
      throw new SharedControlBrowserError(message ?? `Shared control request failed (${response.status}).`, {
        status: response.status, code: document?.code ?? error?.code, body: document,
      });
    }
    return { data: document?.data, location: response.headers?.get?.('location') ?? null };
  }

  return Object.freeze({
    get session() { return session ? Object.freeze({ ...session }) : null; },
    async login(credential, { signal } = {}) {
      if (typeof credential !== 'string' || !credential.trim()) throw new TypeError('A control credential is required.');
      const attempt = ++authenticationAttempt;
      const result = await request(`${PREFIX}/session`, { method: 'POST', body: { credential }, signal });
      if (attempt !== authenticationAttempt) throw supersededAuthenticationError();
      session = Object.freeze({ ...result.data });
      return session;
    },
    async restore({ signal } = {}) {
      const attempt = ++authenticationAttempt;
      const result = await request(`${PREFIX}/session`, { signal });
      if (attempt !== authenticationAttempt) throw supersededAuthenticationError();
      session = Object.freeze({ ...result.data });
      return session;
    },
    async logout({ signal } = {}) {
      const attempt = ++authenticationAttempt;
      try { await request(`${PREFIX}/session`, { method: 'DELETE', body: {}, signal }); } finally {
        if (attempt === authenticationAttempt) session = null;
      }
    },
    async readWorkspace(runId, { signal, logLimit = 200 } = {}) {
      const root = `${PREFIX}/runs/${encodeURIComponent(runId)}`;
      const snapshot = (await request(`${root}/workspace?logLimit=${Math.min(1000, Math.max(1, logLimit))}`, { signal })).data;
      return Object.freeze({
        ...snapshot,
        riskAvailability: snapshot?.publication?.riskRegister?.availability ?? 'UNAVAILABLE',
      });
    },
    async mutate(runId, kind, { expectedRunRevision, body = {}, requestId = crypto.randomUUID(), signal } = {}) {
      const suffix = MUTATION_PATHS[kind];
      if (!suffix) throw new TypeError(`Unsupported shared control mutation: ${String(kind)}.`);
      if (!Number.isSafeInteger(expectedRunRevision) || expectedRunRevision < 1) throw new TypeError('A current run revision is required.');
      const result = await request(`${PREFIX}/runs/${encodeURIComponent(runId)}/${suffix}`, {
        method: 'POST', body: { ...body, expectedRunRevision, requestId }, idempotencyKey: requestId, signal,
      });
      return Object.freeze({ ...result.data, statusUrl: result.data?.statusUrl ?? result.location });
    },
    async waitForOperation(statusUrl, { runId, signal, maxPolls = 40, pollMs = 250 } = {}) {
      const match = typeof statusUrl === 'string'
        ? statusUrl.match(/^\/api\/control\/v1\/runs\/([^/]+)\/operations\/([a-f0-9]{64})$/u)
        : null;
      if (!match || (runId !== undefined && decodeURIComponent(match[1]) !== runId)) {
        throw new TypeError('Operation status URL is invalid or belongs to another run.');
      }
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const operation = (await request(statusUrl, { signal })).data;
        if (operation?.outcome || TERMINAL_OPERATION_STATES.has(operation?.state)) return operation;
        if (poll + 1 < maxPolls) await wait(pollMs);
      }
      throw new SharedControlBrowserError('The durable operation did not finish within the bounded polling window.', { code: 'CONTROL_OPERATION_PENDING' });
    },
  });
}

function supersededAuthenticationError() {
  const error = new SharedControlBrowserError('A newer browser authorization attempt superseded this request.', {
    code: 'SHARED_CONTROL_AUTH_SUPERSEDED',
  });
  error.name = 'AbortError';
  return error;
}
