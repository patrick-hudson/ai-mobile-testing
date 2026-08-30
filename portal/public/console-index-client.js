import { CONSOLE_ACTION_IDS } from '../console-contracts.mjs';

const API_PREFIX = '/api/console/v1';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 256 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_CURSOR = /^[A-Za-z0-9_-]{1,4096}$/;
const CONTROL_TEXT = /[\u0000-\u001f\u007f]/u;
const RESIDUAL_ESCAPE = /%[0-9A-Fa-f]{2}/u;
const SECRET_TEXT = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{4,})/iu;
const MODES = new Set(['all', 'comparative', 'single-site']);
const ACTION_IDS = new Set(CONSOLE_ACTION_IDS);
const ROUTES = Object.freeze({
  overview: Object.freeze({ path: '/overview', routeId: 'overview', sorts: new Set(['attention']), facets: Object.freeze({}) }),
  runs: Object.freeze({ path: '/runs', routeId: 'runs', sorts: new Set(['recent', 'risk', 'duration']), facets: Object.freeze({ state: 'token' }), search: true }),
  findings: Object.freeze({ path: '/attention', routeId: 'attention', sorts: new Set(['risk', 'newest', 'oldest']), facets: Object.freeze({ run: 'id', kind: 'token', severity: 'severity', suite: 'token' }), search: true }),
  evidence: Object.freeze({ path: '/evidence', routeId: 'evidence', sorts: new Set(['attention', 'capture-time', 'suite']), facets: Object.freeze({ run: 'id', kind: 'token', status: 'token', suite: 'token' }), search: true }),
  provenance: Object.freeze({ path: '/metrics/provenance', routeId: 'metrics-provenance', sorts: new Set(['source']), facets: Object.freeze({ metric: 'id' }) }),
});

export class ConsoleIndexClientError extends Error {
  constructor(code, message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'ConsoleIndexClientError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function unsupportedConsoleQuery(routeId, state = {}) {
  void routeId;
  void state;
  return Object.freeze([]);
}

export function createConsoleIndexClient({
  fetch: fetchImpl = globalThis.fetch,
  base = API_PREFIX,
  maximumResponseBytes = DEFAULT_MAXIMUM_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (typeof base !== 'string' || !base.startsWith('/') || base.includes('?') || base.includes('#')) {
    throw new TypeError('The console API base must be a relative path.');
  }
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 4_096 || maximumResponseBytes > DEFAULT_MAXIMUM_RESPONSE_BYTES) {
    throw new TypeError('maximumResponseBytes must be between 4096 and 262144.');
  }

  async function request(routeName, query = {}, { cursor = null, signal } = {}) {
    const route = ROUTES[routeName];
    if (!route) throw new TypeError(`Unknown console index route: ${String(routeName)}.`);
    const parameters = normalizeQuery(route, query, cursor);
    const url = `${base}${route.path}?${parameters.toString()}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
      throw fail('CONSOLE_RESPONSE_LIMIT', 'The bounded console response is too large.', response.status, false);
    }
    const text = await readBoundedResponse(response, maximumResponseBytes);
    let body;
    try { body = JSON.parse(text); } catch { throw fail('CONSOLE_RESPONSE_INVALID', 'The console response is not valid JSON.', response.status, true); }
    if (!response.ok) {
      const code = safeErrorCode(body?.error?.code ?? body?.code) ?? 'CONSOLE_REQUEST_FAILED';
      const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
      throw fail(code, safeErrorMessage(message), response.status, response.status >= 500 || response.status === 409);
    }
    return normalizeResponse(body, route);
  }

  return Object.freeze({
    overview: (query, options) => request('overview', query, options),
    runs: (query, options) => request('runs', query, options),
    findings: (query, options) => request('findings', query, options),
    evidence: (query, options) => request('evidence', query, options),
    provenance: (query, options) => request('provenance', query, options),
  });
}

function normalizeQuery(route, query, cursor) {
  if (!plainObject(query)) throw new TypeError('Console query must be an object.');
  const parameters = new URLSearchParams();
  const mode = query.mode ?? 'all';
  if (!MODES.has(mode)) throw new TypeError('Console mode is invalid.');
  parameters.set('mode', mode);
  const scope = query.scope ?? 'all';
  assertToken(scope, 'scope');
  parameters.set('scope', scope);
  const sort = query.sort ?? route.sorts.values().next().value;
  if (!route.sorts.has(sort)) throw new TypeError(`Sort ${String(sort)} is unavailable for ${route.routeId}.`);
  parameters.set('sort', sort);
  const limit = Number.isSafeInteger(query.limit) ? Math.max(1, Math.min(MAX_LIMIT, query.limit)) : DEFAULT_LIMIT;
  parameters.set('limit', String(limit));
  if (route.search && query.q !== undefined && query.q !== null && query.q !== '') {
    const q = String(query.q);
    if (q.length > 1_200 || q.trim() !== q || CONTROL_TEXT.test(q) || RESIDUAL_ESCAPE.test(q) || SECRET_TEXT.test(q)) {
      throw new TypeError('Console search text is invalid.');
    }
    parameters.set('q', q);
  }
  for (const [facet, type] of Object.entries(route.facets)) {
    if (query[facet] === undefined || query[facet] === null || query[facet] === '') continue;
    const values = Array.isArray(query[facet]) ? query[facet] : [query[facet]];
    if (values.length < 1 || values.length > 20) throw new TypeError(`${facet} exceeds the bounded filter limit.`);
    const normalized = [...new Set(values.map((value) => String(value)))];
    for (const value of normalized) {
      if (type === 'id') assertId(value, facet);
      else if (type === 'severity' && !['P0', 'P1', 'P2', 'P3'].includes(value)) throw new TypeError(`${facet} is invalid.`);
      else if (type === 'token') assertToken(value, facet);
    }
    parameters.set(facet, normalized.join(','));
  }
  if (cursor !== null) {
    if (typeof cursor !== 'string' || !SAFE_CURSOR.test(cursor)) throw new TypeError('Console cursor is invalid.');
    parameters.set('cursor', cursor);
  }
  return parameters;
}

function normalizeResponse(body, route) {
  if (!plainObject(body) || body.schemaVersion !== 1 || body.apiVersion !== 'v1' || body.routeId !== route.routeId
    || typeof body.complete !== 'boolean' || !plainObject(body.sourceVector) || !plainObject(body.data)
    || !Array.isArray(body.data.items) || body.data.items.length > MAX_LIMIT) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'The console response failed validation.', 200, true);
  }
  const items = body.data.items.map(normalizeRecord);
  const nextCursor = body.data.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || !SAFE_CURSOR.test(nextCursor))) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'The console continuation cursor is invalid.', 200, true);
  }
  if (typeof body.data.hasMore !== 'boolean' || body.data.hasMore !== Boolean(nextCursor)) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'The console continuation state is inconsistent.', 200, true);
  }
  const limitations = Array.isArray(body.limitations) ? body.limitations.slice(0, 64).map((value) => {
    if (!plainObject(value) || typeof value.sourceId !== 'string' || typeof value.code !== 'string') {
      throw fail('CONSOLE_RESPONSE_INVALID', 'A console limitation is invalid.', 200, true);
    }
    return Object.freeze({ sourceId: boundedText(value.sourceId, 160), code: boundedText(value.code, 160) });
  }) : [];
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor,
    hasMore: body.data.hasMore,
    omittedRecords: safeInteger(body.data.omittedRecords),
    complete: body.complete,
    freshness: boundedText(body.freshness, 40),
    limitations: Object.freeze(limitations),
    sourceVector: normalizeSourceVector(body.sourceVector),
    work: normalizeWork(body.work),
    capabilities: normalizeCapabilities(body.capabilities),
    overview: route.routeId === 'overview' ? normalizeOverviewProjection(body.data.overview, items) : null,
  });
}

function normalizeOverviewProjection(value, items) {
  if (value === undefined) return null;
  if (!plainObject(value) || value.schemaVersion !== 1 || !plainObject(value.productRisk)
    || !plainObject(value.runTrust) || !plainObject(value.activeRuns)
    || !plainObject(value.comparablePredecessor) || !plainObject(value.provenance)) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'The console Overview projection is invalid.', 200, true);
  }
  const available = new Set(items.map((record) => referenceKey(record)));
  const references = (source, maximum, label) => {
    if (!Array.isArray(source) || source.length > maximum) {
      throw fail('CONSOLE_RESPONSE_INVALID', `The console Overview ${label} references are invalid.`, 200, true);
    }
    return Object.freeze(source.map((entry) => normalizeOverviewReference(entry, available)));
  };
  const latest = value.latestTerminalRun === null ? null : normalizeOverviewReference(value.latestTerminalRun, available);
  const predecessor = value.comparablePredecessor.record === null
    ? null : normalizeOverviewReference(value.comparablePredecessor.record, available);
  if (typeof value.comparablePredecessor.available !== 'boolean'
    || typeof value.comparablePredecessor.historyComplete !== 'boolean'
    || (value.comparablePredecessor.available && predecessor === null)) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'The console Overview predecessor state is invalid.', 200, true);
  }
  return Object.freeze({
    schemaVersion: 1,
    productRisk: Object.freeze({
      items: references(value.productRisk.items, 50, 'Product Risk'),
      total: safeInteger(value.productRisk.total),
      hasMore: value.productRisk.hasMore === true,
      state: normalizeOverviewState(value.productRisk.state),
    }),
    runTrust: Object.freeze({
      runIdentity: value.runTrust.runIdentity === null ? null : normalizeRunIdentity(value.runTrust.runIdentity),
      facts: references(value.runTrust.facts, 20, 'Run Trust'),
      state: normalizeOverviewState(value.runTrust.state),
    }),
    activeRuns: Object.freeze({
      items: references(value.activeRuns.items, 20, 'active run'),
      total: safeInteger(value.activeRuns.total),
      hasMore: value.activeRuns.hasMore === true,
    }),
    latestTerminalRun: latest,
    comparablePredecessor: Object.freeze({
      available: value.comparablePredecessor.available,
      record: predecessor,
      reason: boundedText(value.comparablePredecessor.reason, 240),
      historyComplete: value.comparablePredecessor.historyComplete,
    }),
    statistics: references(value.statistics, 6, 'statistic'),
    provenance: Object.freeze({
      sourceVectorRevision: boundedText(value.provenance.sourceVectorRevision, 160),
      completeness: ['complete', 'partial'].includes(value.provenance.completeness) ? value.provenance.completeness : 'partial',
      limitations: Array.isArray(value.provenance.limitations)
        ? Object.freeze(value.provenance.limitations.slice(0, 64).map((entry) => {
            if (!plainObject(entry)) throw fail('CONSOLE_RESPONSE_INVALID', 'The console Overview limitation is invalid.', 200, true);
            return Object.freeze({ sourceId: boundedText(entry.sourceId, 160), code: boundedText(entry.code, 160) });
          }))
        : Object.freeze([]),
    }),
  });
}

function normalizeOverviewReference(value, available) {
  if (!plainObject(value) || !['comparative', 'single-site'].includes(value.mode)
    || !SAFE_ID.test(String(value.runId ?? '')) || !SAFE_ID.test(String(value.recordId ?? ''))) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'A console Overview record reference is invalid.', 200, true);
  }
  const normalized = Object.freeze({ mode: value.mode, runId: value.runId, recordId: value.recordId });
  if (!available.has(referenceKey(normalized))) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'A console Overview reference is outside its bounded item set.', 200, true);
  }
  return normalized;
}

function normalizeRunIdentity(value) {
  if (!plainObject(value) || !['comparative', 'single-site'].includes(value.mode) || !SAFE_ID.test(String(value.runId ?? ''))) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'A console Overview run identity is invalid.', 200, true);
  }
  return Object.freeze({ mode: value.mode, runId: value.runId });
}

function normalizeOverviewState(value) {
  if (!plainObject(value) || !['ready', 'partial', 'empty-success', 'unavailable'].includes(value.state)) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'A console Overview region state is invalid.', 200, true);
  }
  return Object.freeze({ state: value.state, reason: boundedText(value.reason, 400) });
}

function referenceKey(value) {
  return `${value.mode}\u241f${value.runId}\u241f${value.recordId}`;
}

async function readBoundedResponse(response, maximumResponseBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumResponseBytes) {
      throw fail('CONSOLE_RESPONSE_LIMIT', 'The bounded console response is too large.', response.status, false);
    }
    return text;
  }
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumResponseBytes) {
        await reader.cancel();
        throw fail('CONSOLE_RESPONSE_LIMIT', 'The bounded console response is too large.', response.status, false);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock?.();
  }
}

function normalizeRecord(value) {
  if (!plainObject(value) || value.schemaVersion !== 1 || !['comparative', 'single-site'].includes(value.mode)
    || !SAFE_ID.test(String(value.runId ?? '')) || !SAFE_ID.test(String(value.recordId ?? ''))
    || !['run', 'risk', 'trust', 'attention', 'evidence', 'metric', 'timeline', 'provenance'].includes(value.recordType)
    || typeof value.complete !== 'boolean' || !plainObject(value.fields)) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'A console index record is invalid.', 200, true);
  }
  const fields = Object.create(null);
  const entries = Object.entries(value.fields);
  if (entries.length > 80) throw fail('CONSOLE_RESPONSE_INVALID', 'A console index record has too many fields.', 200, true);
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(key)) throw fail('CONSOLE_RESPONSE_INVALID', 'A console index field name is invalid.', 200, true);
    if (Array.isArray(raw)) {
      if (raw.length > 100) throw fail('CONSOLE_RESPONSE_INVALID', 'A console index field list is too large.', 200, true);
      fields[key] = Object.freeze(raw.map(normalizeScalar));
    } else fields[key] = normalizeScalar(raw);
  }
  return Object.freeze({
    schemaVersion: 1,
    mode: value.mode,
    runId: value.runId,
    recordId: value.recordId,
    recordType: value.recordType,
    scopeKey: boundedText(value.scopeKey, 512),
    sourceId: boundedText(value.sourceId, 160),
    sourceRevision: value.sourceRevision === null ? null : boundedText(value.sourceRevision, 256),
    sourceUpdatedAt: value.sourceUpdatedAt === null ? null : boundedText(value.sourceUpdatedAt, 64),
    complete: value.complete,
    sortKey: boundedText(value.sortKey, 1_024),
    fields: Object.freeze(fields),
  });
}

function normalizeScalar(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return value;
  return boundedText(value, 2_048);
}

function normalizeSourceVector(value) {
  if (!plainObject(value) || value.schemaVersion !== 1 || typeof value.complete !== 'boolean'
    || !Array.isArray(value.sources) || value.sources.length > 64) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'The console source vector is invalid.', 200, true);
  }
  const sources = value.sources.map((source) => {
    if (!plainObject(source) || !SAFE_ID.test(String(source.sourceId ?? '')) || typeof source.complete !== 'boolean') {
      throw fail('CONSOLE_RESPONSE_INVALID', 'A console source watermark is invalid.', 200, true);
    }
    return Object.freeze({
      sourceId: source.sourceId,
      revision: source.revision === null ? null : boundedText(source.revision, 256),
      updatedAt: source.updatedAt === null ? null : boundedText(source.updatedAt, 64),
      complete: source.complete,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    vectorRevision: boundedText(value.vectorRevision, 160),
    indexRevision: boundedText(value.indexRevision, 160),
    complete: value.complete,
    sources: Object.freeze(sources),
  });
}

function normalizeWork(value) {
  if (!plainObject(value)) return Object.freeze({});
  const output = Object.create(null);
  for (const key of ['recordsRead', 'sourceFilesRead', 'sourceBytesRead', 'elapsedMs', 'indexReads', 'assemblyAttempts']) {
    output[key] = safeInteger(value[key]);
  }
  output.budgetExhausted = value.budgetExhausted === true;
  return Object.freeze(output);
}

function normalizeCapabilities(value) {
  if (value === null || value === undefined) return null;
  if (!plainObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.items) || value.items.length > 100) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'The console capability snapshot is invalid.', 200, true);
  }
  const items = value.items.map((entry) => {
    if (!plainObject(entry) || entry.schemaVersion !== 1 || typeof entry.contextId !== 'string'
      || typeof entry.authorityRevision !== 'string' || !Array.isArray(entry.actions) || entry.actions.length > ACTION_IDS.size) {
      throw fail('CONSOLE_RESPONSE_INVALID', 'A console capability entry is invalid.', 200, true);
    }
    const identity = entry.identity === null ? null : plainObject(entry.identity)
      && ['comparative', 'single-site'].includes(entry.identity.mode) && SAFE_ID.test(String(entry.identity.runId ?? ''))
      ? Object.freeze({ mode: entry.identity.mode, runId: entry.identity.runId }) : null;
    if (entry.identity !== null && identity === null) throw fail('CONSOLE_RESPONSE_INVALID', 'A console capability identity is invalid.', 200, true);
    const actions = entry.actions.map((action) => {
      if (!plainObject(action) || !ACTION_IDS.has(action.actionId) || typeof action.supported !== 'boolean'
        || ![true, false, null].includes(action.authorized) || ![true, false, null].includes(action.eligible)
        || typeof action.available !== 'boolean') {
        throw fail('CONSOLE_RESPONSE_INVALID', 'A console capability action is invalid.', 200, true);
      }
      return Object.freeze({
        actionId: boundedText(action.actionId, 40), supported: action.supported, authorized: action.authorized,
        eligible: action.eligible, available: action.available,
        unavailableReason: action.unavailableReason === null ? null : boundedText(action.unavailableReason, 240),
      });
    });
    return Object.freeze({
      schemaVersion: 1, identity, contextId: boundedText(entry.contextId, 40),
      authorityRevision: boundedText(entry.authorityRevision, 160), actions: Object.freeze(actions),
    });
  });
  return Object.freeze({ schemaVersion: 1, items: Object.freeze(items) });
}

function boundedText(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value) || SECRET_TEXT.test(value)) {
    throw fail('CONSOLE_RESPONSE_INVALID', 'The console response contains an unsafe value.', 200, true);
  }
  return value;
}

function assertToken(value, name) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value) || SECRET_TEXT.test(value)) throw new TypeError(`${name} is invalid.`);
}

function assertId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || SECRET_TEXT.test(value)) throw new TypeError(`${name} is invalid.`);
}

function safeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function safeErrorCode(value) { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/u.test(value) ? value : null; }
function safeErrorMessage(value) { return typeof value === 'string' && value.length <= 240 && !SECRET_TEXT.test(value) ? value : 'The console request failed.'; }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fail(code, message, status, retryable) { return new ConsoleIndexClientError(code, message, { status, retryable }); }
