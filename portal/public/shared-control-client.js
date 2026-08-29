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

export class SharedControlBrowserError extends Error {
  constructor(message, { status = 0, code = 'SHARED_CONTROL_REQUEST_FAILED', body = null } = {}) {
    super(message);
    this.name = 'SharedControlBrowserError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
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
