const PREFIX = '/api/control/v1';
const TERMINAL_OPERATION_STATES = new Set(['completed', 'succeeded', 'failed', 'cancelled']);
const MUTATION_PATHS = Object.freeze({
  cancel: 'cancel',
  rekick: 'rekick',
  riskAcknowledge: 'risks/acknowledge',
  riskResolve: 'risks/resolve',
  visualDisposition: 'visual/disposition',
  purge: 'purge',
});
const RISK_SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
const OPERATIONAL_RISK_CATEGORIES = new Set(['certificate-bypass', 'evidence-pipeline-limitation']);

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
    const severity = (RISK_SEVERITY_ORDER[left?.severity] ?? 99) - (RISK_SEVERITY_ORDER[right?.severity] ?? 99);
    if (severity !== 0) return severity;
    const operational = Number(OPERATIONAL_RISK_CATEGORIES.has(left?.category))
      - Number(OPERATIONAL_RISK_CATEGORIES.has(right?.category));
    if (operational !== 0) return operational;
    return String(left?.identity ?? '').localeCompare(String(right?.identity ?? ''));
  });
}

export function assertSharedWorkspaceProjection(value, { runId, mode } = {}) {
  const publication = value?.publication;
  const executions = value?.executions;
  const logs = value?.logs;
  const register = publication?.riskRegister;
  if (!publication || (runId !== undefined && publication.runId !== runId)
    || (mode !== undefined && publication.decision?.mode !== mode)
    || !Number.isSafeInteger(publication.runRevision) || publication.runRevision < 1
    || !Number.isSafeInteger(publication.decisionRevision) || publication.decisionRevision < 1
    || !Number.isSafeInteger(publication.riskRevision) || publication.riskRevision < 1
    || typeof publication.finalSubjectDigest !== 'string'
    || typeof publication.decision?.label !== 'string'
    || typeof publication.decision?.grantedAuthority !== 'string'
    || !['LOADING', 'PROVISIONAL', 'AVAILABLE', 'PARTIAL', 'EMPTY', 'UNAVAILABLE'].includes(register?.availability)
    || !Array.isArray(register?.risks) || !Array.isArray(executions?.executions)
    || !Array.isArray(executions?.oracleExecutions)
    || executions.executions.some((entry) => typeof entry?.id !== 'string' || typeof entry?.state !== 'string')
    || executions.oracleExecutions.some((entry) => typeof entry?.id !== 'string')
    || executions.runId !== publication.runId || executions.runRevision !== publication.runRevision
    || logs?.runId !== publication.runId || logs?.runRevision !== publication.runRevision
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
      || risk.releaseEffect !== 'non-blocking') {
      throw new SharedControlBrowserError('Shared Risk Register contains an invalid bounded projection.', {
        code: 'SHARED_CONTROL_PROJECTION_INVALID',
      });
    }
  }
  return value;
}

export function createSharedControlBrowserClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Shared control client requires fetch.');
  let session = null;

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
      const result = await request(`${PREFIX}/session`, { method: 'POST', body: { credential }, signal });
      session = Object.freeze({ ...result.data });
      return session;
    },
    async restore({ signal } = {}) {
      const result = await request(`${PREFIX}/session`, { signal });
      session = Object.freeze({ ...result.data });
      return session;
    },
    async logout({ signal } = {}) {
      try { await request(`${PREFIX}/session`, { method: 'DELETE', body: {}, signal }); } finally { session = null; }
    },
    async readWorkspace(runId, { signal, logLimit = 200, maxAttempts = 3 } = {}) {
      const root = `${PREFIX}/runs/${encodeURIComponent(runId)}`;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const [publication, executions, logs] = await Promise.all([
          request(`${root}/publication`, { signal }),
          request(`${root}/executions`, { signal }),
          request(`${root}/logs?limit=${Math.min(1000, Math.max(1, logLimit))}`, { signal }),
        ]);
        const revision = publication.data?.runRevision;
        if (Number.isSafeInteger(revision)
          && revision === executions.data?.runRevision && revision === logs.data?.runRevision) {
          return Object.freeze({
            publication: publication.data,
            executions: executions.data,
            logs: logs.data,
            riskAvailability: publication.data?.riskRegister?.availability ?? 'UNAVAILABLE',
          });
        }
      }
      throw new SharedControlBrowserError('Shared workspace changed while loading; no coherent revision was available.', {
        code: 'SHARED_CONTROL_REVISION_RACE',
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
