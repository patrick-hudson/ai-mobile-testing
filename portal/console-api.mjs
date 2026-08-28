import {
  CONSOLE_INDEX_FIELD_NAMES,
  CONSOLE_INDEX_RECORD_TYPES,
  ConsoleIndexError,
  createConsoleReadBudget,
  consoleIndexOrderKey,
  decodeConsoleIndexCursor,
  encodeConsoleIndexCursor,
} from './console-index.mjs';
import {
  consoleIndexRecordToNormalizedRun,
  consoleIndexRecordToProductRiskInput,
} from './console-index-records.mjs';
import { buildConsoleOverview } from './console-overview.mjs';

export const CONSOLE_API_SCHEMA_VERSION = 1;
export const CONSOLE_API_PREFIX = '/api/console/v1';
export const CONSOLE_API_MAX_RESPONSE_BYTES = 256 * 1024;
export const DEFAULT_CONSOLE_API_BUDGET = createConsoleReadBudget({
  maxRecords: 400,
  maxSourceFiles: 0,
  maxSourceBytes: 0,
  maxElapsedMs: 150,
});

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_CURSOR_CHARACTERS = 4 * 1024;
const MAX_FILTER_VALUES = 20;
const MAX_CAPABILITY_ENTRIES = 100;
const FIELD_NAMES = new Set(CONSOLE_INDEX_FIELD_NAMES);
const RECORD_TYPES = new Set(CONSOLE_INDEX_RECORD_TYPES);
const MODES = new Set(['comparative', 'single-site']);
const LIST_MODES = new Set(['all', ...MODES]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const CURSOR_TEXT = /^[A-Za-z0-9_-]+$/;
const CONTROL_TEXT = /[\u0000-\u001f\u007f]/u;
const RESIDUAL_ESCAPE = /%[0-9A-Fa-f]{2}/u;
const PROTOTYPE_KEY = /^(?:__proto__|prototype|constructor)$/iu;
const SECRET_KEY = /(?:authorization|cookie|credential|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer)/iu;
const SECRET_VALUE = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{4,}|https?:\/\/[^\s/@:]+:[^\s/@]+@)/iu;
const ACTION_IDS = new Set(['stop', 'cancel', 'purge', 'manualEvidence', 'visualDisposition', 'baseline', 'aiReview', 'settings']);
const CONTEXT_IDS = new Set(['comparative-live', 'single-site-live', 'sealed-archive']);
const ORIGIN_FIELDS = new Set(['productionOrigin', 'candidateOrigin', 'auditedOrigin']);
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const OVERVIEW_RUN_LIMIT_PER_MODE = 100;
const OVERVIEW_RISK_LIMIT_PER_MODE = 50;
const OVERVIEW_TRUST_RECORD_IDS = Object.freeze([
  'trust:outcome', 'trust:coverage', 'trust:evidence-completion', 'trust:evidence',
  'trust:pipeline', 'trust:manual', 'trust:finalization',
]);
const OVERVIEW_METRIC_RECORD_IDS = Object.freeze([
  'metric:definition-coverage', 'metric:duration', 'metric:flaky',
]);

const ROUTES = Object.freeze({
  overview: {
    pathname: `${CONSOLE_API_PREFIX}/overview`,
    recordTypes: ['run', 'risk', 'trust', 'attention', 'metric', 'provenance'],
    facets: {},
    sorts: ['attention'],
  },
  runs: {
    pathname: `${CONSOLE_API_PREFIX}/runs`,
    recordTypes: ['run'],
    facets: { state: 'token', profile: 'token', terminal: 'boolean' },
    sorts: ['recent', 'risk', 'duration'],
    search: true,
  },
  attention: {
    pathname: `${CONSOLE_API_PREFIX}/attention`,
    recordTypes: ['risk', 'attention'],
    facets: { run: 'id', kind: 'token', severity: 'severity', blocking: 'boolean', status: 'token', suite: 'token' },
    sorts: ['risk', 'newest', 'oldest'],
    search: true,
  },
  evidence: {
    pathname: `${CONSOLE_API_PREFIX}/evidence`,
    recordTypes: ['evidence'],
    facets: { kind: 'token', status: 'token', run: 'id', stage: 'id', suite: 'token' },
    sorts: ['attention', 'capture-time', 'suite'],
    search: true,
  },
  'metrics-provenance': {
    pathname: `${CONSOLE_API_PREFIX}/metrics/provenance`,
    recordTypes: ['metric', 'provenance'],
    facets: { metric: 'id' },
    sorts: ['source'],
  },
});

const ERROR_MESSAGES = Object.freeze({
  CONSOLE_REQUEST_INVALID: 'The console request is invalid.',
  CONSOLE_QUERY_INVALID: 'The console query is invalid.',
  CONSOLE_CURSOR_INVALID: 'The console cursor is invalid.',
  CONSOLE_CURSOR_STALE: 'The console cursor no longer matches this query or source revision.',
  CONSOLE_METHOD_NOT_ALLOWED: 'This console route supports GET and HEAD only.',
  CONSOLE_REQUEST_ABORTED: 'The console request was cancelled.',
  CONSOLE_READ_BUDGET_EXCEEDED: 'The bounded console read budget was exhausted.',
  CONSOLE_INDEX_UNAVAILABLE: 'The console summary index is unavailable.',
  CONSOLE_CAPABILITIES_UNAVAILABLE: 'Current action availability could not be resolved.',
  CONSOLE_RUN_NOT_FOUND: 'The requested run is not present in the bounded console index.',
  CONSOLE_RUN_PURGED: 'The requested run has been purged.',
  CONSOLE_RESPONSE_LIMIT: 'The bounded console response could not be represented safely.',
});

class ConsoleApiError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'ConsoleApiError';
    this.code = code;
    this.statusCode = status;
  }
}

export function createConsoleApi({
  index,
  indexAdapter = null,
  resolveCapabilities = null,
  budget = DEFAULT_CONSOLE_API_BUDGET,
  clock = () => Date.now(),
  maximumResponseBytes = CONSOLE_API_MAX_RESPONSE_BYTES,
} = {}) {
  const adapter = indexAdapter ?? defaultIndexAdapter(index);
  if (!adapter || typeof adapter.sourceVector !== 'function'
    || typeof adapter.read !== 'function' || typeof adapter.page !== 'function') {
    throw new TypeError('Console API requires an index or an index adapter with sourceVector, read, and page methods.');
  }
  if (resolveCapabilities !== null && typeof resolveCapabilities !== 'function') {
    throw new TypeError('resolveCapabilities must be a function when supplied.');
  }
  const readBudget = createConsoleReadBudget(budget);
  const responseLimit = clampInteger(maximumResponseBytes, 4_096, CONSOLE_API_MAX_RESPONSE_BYTES);

  async function handle(request = {}) {
    const method = String(request.method ?? 'GET').toUpperCase();
    let route;
    try {
      route = matchRoute(request.url);
    } catch (error) {
      return error instanceof ConsoleApiError ? errorResponse(error, method) : unhandled();
    }
    if (!route) return unhandled();
    if (!['GET', 'HEAD'].includes(method)) {
      return errorResponse(new ConsoleApiError('CONSOLE_METHOD_NOT_ALLOWED', 405), method, { Allow: 'GET, HEAD' });
    }

    const attemptTrackers = [];
    try {
      assertNotAborted(request.signal);
      const query = normalizeQuery(route, request.url);
      let settled = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const tracker = createWorkTracker(readBudget, clock);
        tracker.attempts = attempt;
        attemptTrackers.push(tracker);
        assertWithinBudget(tracker);
        const before = sanitizeSourceVector(await adapter.sourceVector({ signal: request.signal, budget: readBudget }));
        assertNotAborted(request.signal);
        const assembly = route.kind === 'summary'
          ? await assembleSummary(adapter, route, query, tracker, request.signal)
          : route.id === 'overview'
            ? await assembleOverview(adapter, route, query, before, tracker, request.signal)
            : await assemblePage(adapter, route, query, before, tracker, request.signal);
        assertNotAborted(request.signal);
        let capabilities = null;
        if (resolveCapabilities) {
          try {
            capabilities = sanitizeCapabilities(await resolveCapabilities({
              routeId: route.id,
              identities: assembly.identities,
              signal: request.signal,
              budget: readBudget,
              authorization: request.authorization,
            }));
          } catch (error) {
            if (request.signal?.aborted || error?.name === 'AbortError') throw error;
            throw new ConsoleApiError('CONSOLE_CAPABILITIES_UNAVAILABLE', 503);
          }
          if (assembly.identities.length > 0 && capabilities.items.length === 0) {
            throw new ConsoleApiError('CONSOLE_CAPABILITIES_UNAVAILABLE', 503);
          }
        }
        assertNotAborted(request.signal);
        const after = sanitizeSourceVector(await adapter.sourceVector({ signal: request.signal, budget: readBudget }));
        const stable = vectorKey(before) === vectorKey(assembly.sourceVector)
          && vectorKey(assembly.sourceVector) === vectorKey(after);
        settled = { ...assembly, capabilities, sourceVector: after, stable };
        if (stable) break;
      }

      if (!settled) throw new ConsoleApiError('CONSOLE_INDEX_UNAVAILABLE', 503);
      if (!settled.stable) {
        settled.complete = false;
        settled.freshness = 'stale';
        settled.limitations = mergeLimitations(settled.limitations, [{ sourceId: 'console-index', code: 'source-stale' }]);
      }
      const tracker = mergeAttemptTrackers(attemptTrackers, readBudget, clock);
      const response = boundedSuccessResponse({ route, query, assembly: settled, tracker, responseLimit, method });
      return response;
    } catch (error) {
      if (request.signal?.aborted || error?.name === 'AbortError') {
        return errorResponse(new ConsoleApiError('CONSOLE_REQUEST_ABORTED', 499), method);
      }
      return errorResponse(normalizeError(error), method);
    }
  }

  return Object.freeze({ handle });
}

export async function handleConsoleApiRequest(api, request) {
  if (!api || typeof api.handle !== 'function') throw new TypeError('A console API created by createConsoleApi is required.');
  return api.handle(request);
}

function defaultIndexAdapter(index) {
  if (!index) return null;
  return Object.freeze({
    sourceVector: () => index.sourceVector(),
    read: ({ identity, recordId }) => index.read(identity, recordId),
    page: ({ request }) => index.page(request),
    encodeCursor: (value) => encodeConsoleIndexCursor(value),
    decodeCursor: (value) => decodeConsoleIndexCursor(value),
  });
}

function matchRoute(input) {
  if (typeof input !== 'string' || input.length > 16_384) return null;
  const url = new URL(input, 'http://console.local');
  for (const [id, contract] of Object.entries(ROUTES)) {
    if (url.pathname === contract.pathname) return { id, kind: 'page', contract, url };
  }
  const match = url.pathname.match(/^\/api\/console\/v1\/runs\/([^/]+)\/([^/]+)(\/timeline)?$/u);
  if (!match) return null;
  const mode = decodePathSegment(match[1], 'mode');
  const runId = decodePathSegment(match[2], 'runId');
  if (!MODES.has(mode) || !SAFE_ID.test(runId)) throw new ConsoleApiError('CONSOLE_REQUEST_INVALID', 400);
  if (match[3]) {
    return {
      id: 'run-timeline',
      kind: 'page',
      contract: {
        recordTypes: ['timeline'],
        facets: { kind: 'token', stage: 'id', shard: 'id' },
        sorts: ['sequence'],
      },
      identity: { mode, runId },
      url,
    };
  }
  return { id: 'run-summary', kind: 'summary', identity: { mode, runId }, url };
}

function decodePathSegment(value) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new ConsoleApiError('CONSOLE_REQUEST_INVALID', 400); }
  if (decoded.length < 1 || decoded.length > 160 || decoded.includes('/') || decoded.includes('\\')
    || CONTROL_TEXT.test(decoded) || RESIDUAL_ESCAPE.test(decoded) || SECRET_VALUE.test(decoded)) {
    throw new ConsoleApiError('CONSOLE_REQUEST_INVALID', 400);
  }
  return decoded;
}

function normalizeQuery(route, input) {
  const url = route.url ?? new URL(input, 'http://console.local');
  const rawSearch = url.search.slice(1);
  if (Buffer.byteLength(rawSearch) > MAX_QUERY_BYTES) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
  const facets = route.contract?.facets ?? {};
  const allowed = new Set(route.kind === 'summary'
    ? []
    : ['mode', 'scope', 'filter', 'sort', 'limit', 'cursor', ...(route.contract?.search ? ['q'] : []), ...Object.keys(facets)]);
  if (route.id === 'run-timeline') allowed.delete('mode');
  const values = Object.create(null);
  for (const key of new Set(url.searchParams.keys())) {
    if (url.searchParams.getAll(key).length !== 1 || !allowed.has(key)
      || key.length > 64 || PROTOTYPE_KEY.test(key) || SECRET_KEY.test(key)) {
      throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
    }
    const value = url.searchParams.get(key);
    if (!safeQueryText(value, key === 'cursor' ? MAX_CURSOR_CHARACTERS : 1_024)) {
      throw new ConsoleApiError(key === 'cursor' ? 'CONSOLE_CURSOR_INVALID' : 'CONSOLE_QUERY_INVALID', 400);
    }
    values[key] = value;
  }
  if (route.kind === 'summary' && Object.keys(values).length > 0) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);

  const mode = route.identity?.mode ?? normalizeChoice(values.mode ?? 'all', LIST_MODES);
  const scopeKey = normalizeToken(values.scope ?? 'all', 300);
  const limit = values.limit === undefined ? DEFAULT_LIMIT : clampLimit(values.limit);
  const cursor = values.cursor === undefined ? null : normalizeCursor(values.cursor);
  const sort = normalizeChoice(values.sort ?? route.contract?.sorts?.[0] ?? 'index', new Set(route.contract?.sorts ?? ['index']));
  const q = values.q === undefined ? null : normalizeSearchText(values.q);
  const filters = Object.create(null);
  if (values.filter !== undefined) mergeFilterExpression(filters, values.filter, facets);
  for (const [facet, type] of Object.entries(facets)) {
    if (values[facet] !== undefined) mergeFacet(filters, facet, values[facet], type);
  }
  if (route.identity?.runId) mergeFacet(filters, 'run', route.identity.runId, 'id', { implicit: true });
  const normalizedFilters = Object.fromEntries(Object.keys(filters).sort().map((key) => [key, [...filters[key]].sort()]));
  const normalizedFilterKey = JSON.stringify({ filters: normalizedFilters, q, sort });
  if (normalizedFilterKey.length > 1_024 || SECRET_VALUE.test(normalizedFilterKey)) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
  return Object.freeze({ mode, scopeKey, limit, cursor, sort, q, filters: Object.freeze(normalizedFilters), normalizedFilterKey });
}

function normalizeSearchText(value) {
  if (typeof value !== 'string' || value.length > 1_200 || value.trim() !== value
    || CONTROL_TEXT.test(value) || RESIDUAL_ESCAPE.test(value) || SECRET_VALUE.test(value)) {
    throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
  }
  return value.toLocaleLowerCase('en-US');
}

function safeQueryText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !CONTROL_TEXT.test(value) && !RESIDUAL_ESCAPE.test(value) && !SECRET_VALUE.test(value);
}

function normalizeChoice(value, choices) {
  if (!choices.has(value)) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
  return value;
}

function normalizeToken(value, maximum = 160) {
  if (typeof value !== 'string' || value.length > maximum || !SAFE_TOKEN.test(value)
    || PROTOTYPE_KEY.test(value) || SECRET_VALUE.test(value)) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
  return value;
}

function clampLimit(value) {
  if (!/^\d+$/u.test(value)) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
  return Math.max(1, Math.min(MAX_LIMIT, Number(value)));
}

function normalizeCursor(value) {
  if (value.length > MAX_CURSOR_CHARACTERS || !CURSOR_TEXT.test(value)) throw new ConsoleApiError('CONSOLE_CURSOR_INVALID', 400);
  return value;
}

function mergeFilterExpression(target, expression, facets) {
  const entries = expression.split(',');
  if (entries.length < 1 || entries.length > MAX_FILTER_VALUES) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    if (separator < 1 || separator === entry.length - 1) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
    const facet = entry.slice(0, separator);
    if (!Object.hasOwn(facets, facet) || PROTOTYPE_KEY.test(facet) || SECRET_KEY.test(facet)) {
      throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
    }
    mergeFacet(target, facet, entry.slice(separator + 1), facets[facet]);
  }
}

function mergeFacet(target, facet, input, type, { implicit = false } = {}) {
  if (!implicit && !Object.hasOwn(target, facet)) target[facet] = new Set();
  target[facet] ??= new Set();
  const values = String(input).split(',');
  if (values.length < 1 || target[facet].size + values.length > MAX_FILTER_VALUES) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
  for (let value of values) {
    if (type === 'severity') value = value.toUpperCase();
    if (type === 'boolean') {
      if (!['true', 'false'].includes(value)) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
    } else if (type === 'severity') {
      if (!['P0', 'P1', 'P2', 'P3'].includes(value)) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
    } else if (type === 'id') {
      if (!SAFE_ID.test(value)) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
    } else normalizeToken(value);
    if (PROTOTYPE_KEY.test(value) || SECRET_VALUE.test(value)) throw new ConsoleApiError('CONSOLE_QUERY_INVALID', 400);
    target[facet].add(value);
  }
}

async function assembleSummary(adapter, route, query, tracker, signal) {
  const result = await adapter.read({ identity: route.identity, recordId: 'run', signal, budget: tracker.budget });
  assertNotAborted(signal);
  tracker.indexReads += 1;
  consumeWork(tracker, result?.work);
  const sourceVector = sanitizeSourceVector(result?.sourceVector);
  const limitations = sanitizeLimitations(result?.limitations);
  if (result?.value === null || result?.value === undefined) {
    if (limitations.some(({ code }) => code === 'purged')) throw new ConsoleApiError('CONSOLE_RUN_PURGED', 410);
    throw new ConsoleApiError('CONSOLE_RUN_NOT_FOUND', 404);
  }
  const record = sanitizeRecord(result.value);
  if (!record || record.recordType !== 'run'
    || record.mode !== route.identity.mode || record.runId !== route.identity.runId) {
    throw new ConsoleApiError('CONSOLE_INDEX_UNAVAILABLE', 503);
  }
  return {
    data: { record },
    makeData: null,
    identities: [{ mode: record.mode, runId: record.runId }],
    sourceVector,
    complete: result.complete === true && sourceVector.complete && record.complete,
    freshness: normalizeFreshness(result.freshness),
    limitations,
  };
}

async function assembleOverview(adapter, route, query, initialVector, tracker, signal) {
  const modes = query.mode === 'all' ? ['comparative', 'single-site'] : [query.mode];
  const limitations = [];
  const runRecords = [];
  const riskRecords = [];
  const riskEntries = [];
  const groupState = { runsHasMore: false, riskHasMore: false, runsOmitted: 0, riskOmitted: 0 };
  let runHistoryComplete = initialVector.complete;
  let complete = initialVector.complete;
  let freshness = initialVector.complete ? 'current' : 'stale';

  for (const mode of modes) {
    const runs = await readOverviewGroup(adapter, {
      mode,
      recordTypes: ['run'],
      limit: OVERVIEW_RUN_LIMIT_PER_MODE,
      query,
      initialVector,
      tracker,
      signal,
    });
    runRecords.push(...runs.records);
    limitations.push(...runs.limitations);
    complete &&= runs.complete;
    runHistoryComplete &&= runs.complete;
    if (runs.freshness !== 'current') freshness = runs.freshness;
    groupState.runsHasMore ||= runs.hasMore;
    groupState.runsOmitted += runs.omittedRecords;

  }
  const runHistoryAuthoritative = runHistoryComplete && !groupState.runsHasMore;

  const normalizedRuns = runRecords.flatMap((record) => {
    try { return [consoleIndexRecordToNormalizedRun(record)]; } catch {
      limitations.push({ sourceId: record.sourceId, code: 'source-malformed' });
      complete = false;
      return [];
    }
  });
  const preliminaryModel = buildConsoleOverview({
    mode: query.mode,
    scopeKey: query.scopeKey,
    runs: normalizedRuns,
    attention: [],
    sourceVectorRevision: initialVector.vectorRevision,
    limitations: limitations.map(({ sourceId, code }) => `${sourceId}: ${code}`),
  }, {
    riskLimit: 12,
    activeLimit: 8,
    now: latestSourceTimestamp(initialVector) ?? new Date(0).toISOString(),
  });
  const currentIdentity = preliminaryModel.latestTerminalRun?.identity ?? null;
  if (currentIdentity) {
    const risks = await readOverviewGroup(adapter, {
      mode: currentIdentity.mode,
      runId: currentIdentity.runId,
      recordTypes: ['risk', 'attention'],
      limit: OVERVIEW_RISK_LIMIT_PER_MODE,
      query,
      initialVector,
      tracker,
      signal,
    });
    riskRecords.push(...risks.records);
    limitations.push(...risks.limitations);
    complete &&= risks.complete;
    if (risks.freshness !== 'current') freshness = risks.freshness;
    groupState.riskHasMore = risks.hasMore;
    groupState.riskOmitted = risks.omittedRecords;
  }
  for (const record of riskRecords) {
    try {
      riskEntries.push({ record, risk: consoleIndexRecordToProductRiskInput(record, {
        now: record.fields.sourceTimestamp ?? record.sourceUpdatedAt,
        hasComparablePredecessor: runHistoryAuthoritative
          && preliminaryModel.comparablePredecessor.available === true,
      }) });
    } catch {
      if (record.recordType === 'risk' || ['finding-summary', 'finding', 'visual-review', 'manual-obligation'].includes(record.fields.attentionKind)) {
        limitations.push({ sourceId: record.sourceId, code: 'source-malformed' });
        complete = false;
      }
    }
  }
  const model = buildConsoleOverview({
    mode: query.mode,
    scopeKey: query.scopeKey,
    runs: normalizedRuns,
    attention: riskEntries.map(({ risk }) => risk),
    sourceVectorRevision: initialVector.vectorRevision,
    limitations: limitations.map(({ sourceId, code }) => `${sourceId}: ${code}`),
  }, {
    riskLimit: 12,
    activeLimit: 8,
    now: latestSourceTimestamp(initialVector) ?? new Date(0).toISOString(),
  });

  const latestIdentity = model.latestTerminalRun?.identity ?? null;
  const detailRecords = [];
  if (latestIdentity) {
    for (const recordId of [...OVERVIEW_TRUST_RECORD_IDS, ...OVERVIEW_METRIC_RECORD_IDS]) {
      const result = await adapter.read({
        identity: { mode: latestIdentity.mode, runId: latestIdentity.runId },
        recordId,
        signal,
        budget: tracker.budget,
      });
      assertNotAborted(signal);
      tracker.indexReads += 1;
      consumeWork(tracker, result?.work);
      const vector = sanitizeSourceVector(result?.sourceVector);
      if (vectorKey(vector) !== vectorKey(initialVector)) complete = false;
      limitations.push(...sanitizeLimitations(result?.limitations));
      complete &&= result?.complete === true;
      if (normalizeFreshness(result?.freshness) !== 'current') freshness = normalizeFreshness(result?.freshness);
      if (result?.value === null || result?.value === undefined) continue;
      const record = sanitizeRecord(result.value);
      if (!record || record.mode !== latestIdentity.mode || record.runId !== latestIdentity.runId || record.recordId !== recordId) {
        limitations.push({ sourceId: 'console-index', code: 'source-malformed' });
        complete = false;
        continue;
      }
      detailRecords.push(record);
    }
  }

  const riskByIdentity = new Map(riskEntries.map(({ record, risk }) => [risk.identity, record]));
  const selectedRisk = model.productRisk.items.flatMap((risk) => {
    const record = riskByIdentity.get(risk.identity);
    if (!record) return [];
    return [runHistoryAuthoritative ? record : {
      ...record,
      fields: { ...record.fields, novelty: null },
    }];
  });
  const runsByIdentity = new Map(runRecords.map((record) => [`${record.mode}:${record.runId}`, record]));
  const active = model.activeRuns.items.flatMap((summary) => {
    const record = runsByIdentity.get(summary.identity.key);
    return record ? [record] : [];
  });
  const latest = latestIdentity ? runsByIdentity.get(latestIdentity.key) ?? null : null;
  const predecessorIdentity = runHistoryAuthoritative
    ? model.comparablePredecessor?.predecessor?.identity ?? null
    : null;
  const predecessor = predecessorIdentity ? runsByIdentity.get(predecessorIdentity.key) ?? null : null;
  const trust = detailRecords.filter(({ recordType }) => recordType === 'trust');
  const metrics = detailRecords.filter(({ recordType }) => recordType === 'metric').slice(0, 6);
  const ordered = uniqueRecords([...selectedRisk, ...trust, ...active, latest, predecessor, ...metrics].filter(Boolean));
  const references = {
    productRisk: selectedRisk.map(recordReference),
    runTrust: trust.map(recordReference),
    activeRuns: active.map(recordReference),
    latestTerminalRun: latest ? recordReference(latest) : null,
    comparablePredecessor: predecessor ? recordReference(predecessor) : null,
    statistics: metrics.map(recordReference),
  };

  const makeData = (count) => {
    const items = ordered.slice(0, count);
    const available = new Set(items.map(referenceKey));
    const keep = (reference) => reference && available.has(referenceKey(reference)) ? reference : null;
    return {
      items,
      nextCursor: null,
      hasMore: false,
      omittedRecords: groupState.runsOmitted + groupState.riskOmitted + Math.max(0, ordered.length - items.length),
      cursorBinding: {
        mode: query.mode,
        scopeKey: query.scopeKey,
        normalizedFilterKey: query.normalizedFilterKey,
        sourceVectorRevision: initialVector.vectorRevision,
      },
      overview: {
        schemaVersion: 1,
        productRisk: {
          items: references.productRisk.map(keep).filter(Boolean),
          total: model.productRisk.total,
          hasMore: model.productRisk.hasMore || groupState.riskHasMore,
          state: !runHistoryAuthoritative && model.productRisk.items.length === 0
            ? {
                state: 'partial',
                reason: 'Product Risk novelty is unavailable until indexed run history is complete.',
                limitations: ['incomplete-run-history'],
              }
            : model.productRisk.state,
        },
        runTrust: {
          runIdentity: latest ? { mode: latest.mode, runId: latest.runId } : null,
          facts: references.runTrust.map(keep).filter(Boolean),
          state: trust.length > 0
            ? { state: trust.every((record) => record.complete) ? 'ready' : 'partial', reason: 'Each trust fact retains its report authority and completeness.' }
            : model.runTrust.state,
        },
        activeRuns: {
          items: references.activeRuns.map(keep).filter(Boolean),
          total: model.activeRuns.total,
          hasMore: model.activeRuns.hasMore || groupState.runsHasMore,
        },
        latestTerminalRun: keep(references.latestTerminalRun),
        comparablePredecessor: {
          available: runHistoryAuthoritative
            && model.comparablePredecessor.available === true
            && keep(references.comparablePredecessor) !== null,
          record: keep(references.comparablePredecessor),
          reason: runHistoryAuthoritative ? model.comparablePredecessor.reason : 'incomplete-run-history',
          historyComplete: runHistoryAuthoritative,
        },
        statistics: references.statistics.map(keep).filter(Boolean),
        provenance: {
          sourceVectorRevision: initialVector.vectorRevision,
          completeness: complete && limitations.length === 0 ? 'complete' : 'partial',
          limitations: mergeLimitations(limitations),
        },
      },
    };
  };
  const data = makeData(ordered.length);
  return {
    data,
    makeData,
    totalItems: ordered.length,
    identities: uniqueIdentities(data.items),
    sourceVector: initialVector,
    complete: complete && limitations.length === 0,
    freshness,
    limitations: mergeLimitations(limitations),
  };
}

async function readOverviewGroup(adapter, { mode, runId, recordTypes, limit, query, initialVector, tracker, signal }) {
  assertWithinBudget(tracker);
  const normalizedFilterKey = runId ? `${query.normalizedFilterKey}:run:${runId}` : query.normalizedFilterKey;
  const result = await adapter.page({
    request: {
      mode,
      scopeKey: query.scopeKey,
      normalizedFilterKey,
      cursor: null,
      limit,
      recordTypes,
      orderBy: 'attention',
      ...(runId ? { runId } : {}),
    },
    signal,
    budget: tracker.budget,
  });
  assertNotAborted(signal);
  tracker.indexReads += 1;
  consumeWork(tracker, result?.work);
  const sourceVector = sanitizeSourceVector(result?.sourceVector);
  validateCursorBinding(result?.cursorBinding, mode, { ...query, normalizedFilterKey }, sourceVector);
  const limitations = sanitizeLimitations(result?.limitations);
  const records = [];
  if (!Array.isArray(result?.items) || result.items.length > limit) throw new ConsoleApiError('CONSOLE_INDEX_UNAVAILABLE', 503);
  for (const rawRecord of result.items) {
    const record = sanitizeRecord(rawRecord);
    if (!record || record.mode !== mode || (runId && record.runId !== runId) || !recordTypes.includes(record.recordType)
      || (query.scopeKey !== 'all' && record.scopeKey !== query.scopeKey)) {
      limitations.push({ sourceId: 'console-index', code: 'source-malformed' });
      continue;
    }
    records.push(record);
  }
  return {
    records,
    limitations,
    sourceVector,
    complete: result?.complete === true && vectorKey(sourceVector) === vectorKey(initialVector) && limitations.length === 0,
    freshness: normalizeFreshness(result?.freshness),
    hasMore: result?.hasMore === true,
    omittedRecords: safeCount(result?.omittedRecords),
  };
}

function latestSourceTimestamp(vector) {
  return vector.sources.map(({ updatedAt }) => updatedAt).filter(Boolean).sort().at(-1) ?? null;
}

function recordReference(record) {
  return { mode: record.mode, runId: record.runId, recordId: record.recordId };
}

function referenceKey(value) {
  return `${value.mode}\u241f${value.runId}\u241f${value.recordId}`;
}

function uniqueRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = referenceKey(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function assemblePage(adapter, route, query, initialVector, tracker, signal) {
  const cursor = decodeApiCursor(query.cursor, query, initialVector);
  const modes = query.mode === 'all' ? ['comparative', 'single-site'] : [query.mode];
  const modeResults = new Map();
  const limitations = [];
  const observedVectors = [];
  let complete = initialVector.complete;
  let freshness = initialVector.complete ? 'current' : 'stale';

  for (const mode of modes) {
    let pageCursor = cursor.lastKeys[mode]
      ? encodeAdapterCursor(adapter, {
          schemaVersion: 1,
          mode,
          scopeKey: query.scopeKey,
          normalizedFilterKey: query.normalizedFilterKey,
          vectorRevision: initialVector.vectorRevision,
          indexRevision: initialVector.indexRevision,
          lastKey: cursor.lastKeys[mode],
        })
      : null;
    let scannedLastKey = cursor.lastKeys[mode];
    let hasMore = false;
    let omittedRecords = 0;
    const matches = [];
    const maximumScans = Math.max(1, Math.floor(tracker.budget.maxRecords / (MAX_LIMIT * modes.length)));
    for (let scan = 0; scan < maximumScans; scan += 1) {
      assertWithinBudget(tracker);
      const result = await adapter.page({
        request: {
          mode,
          scopeKey: query.scopeKey,
          normalizedFilterKey: query.normalizedFilterKey,
          cursor: pageCursor,
          limit: MAX_LIMIT,
          recordTypes: route.contract.recordTypes,
          orderBy: query.sort,
          ...(route.identity?.runId ? { runId: route.identity.runId } : {}),
        },
        signal,
        budget: tracker.budget,
      });
      assertNotAborted(signal);
      tracker.indexReads += 1;
      consumeWork(tracker, result?.work);
      const pageVector = sanitizeSourceVector(result?.sourceVector);
      observedVectors.push(pageVector);
      validateCursorBinding(result?.cursorBinding, mode, query, pageVector);
      limitations.push(...sanitizeLimitations(result?.limitations));
      complete &&= result?.complete === true;
      if (normalizeFreshness(result?.freshness) !== 'current') freshness = normalizeFreshness(result?.freshness);
      if (!Array.isArray(result?.items) || result.items.length > MAX_LIMIT) throw new ConsoleApiError('CONSOLE_INDEX_UNAVAILABLE', 503);
      for (const rawRecord of result.items) {
        const record = sanitizeRecord(rawRecord);
        if (!record || record.mode !== mode
          || (query.scopeKey !== 'all' && record.scopeKey !== query.scopeKey)
          || !route.contract.recordTypes.includes(record.recordType)) {
          limitations.push({ sourceId: 'console-index', code: 'source-malformed' });
          complete = false;
          continue;
        }
        scannedLastKey = consoleIndexOrderKey(record, query.sort);
        if (recordMatches(record, query.filters, query.q)) matches.push(record);
      }
      hasMore = result.hasMore === true;
      omittedRecords = Math.max(omittedRecords, safeCount(result.omittedRecords));
      if (!hasMore || matches.length >= query.limit) break;
      if (typeof result.nextCursor !== 'string') throw new ConsoleApiError('CONSOLE_INDEX_UNAVAILABLE', 503);
      pageCursor = result.nextCursor;
      scannedLastKey = decodeAdapterCursor(adapter, pageCursor).lastKey;
    }
    if (hasMore && matches.length < query.limit) {
      limitations.push({ sourceId: 'console-api', code: 'budget-exhausted' });
      complete = false;
    }
    modeResults.set(mode, { matches, scannedLastKey, priorLastKey: cursor.lastKeys[mode], hasMore, omittedRecords });
  }

  if (observedVectors.some((vector) => vectorKey(vector) !== vectorKey(initialVector))) complete = false;
  const allMatches = [...modeResults.values()].flatMap(({ matches }) => matches).sort((left, right) => compareApiRecords(left, right, query.sort));
  const makeData = (count) => {
    const selected = allMatches.slice(0, count);
    const nextLastKeys = { comparative: cursor.lastKeys.comparative, 'single-site': cursor.lastKeys['single-site'] };
    for (const mode of modes) {
      const state = modeResults.get(mode);
      const returned = selected.filter((record) => record.mode === mode);
      if (returned.length > 0) nextLastKeys[mode] = consoleIndexOrderKey(returned.at(-1), query.sort);
      else if (state.matches.length === 0 && state.scannedLastKey) nextLastKeys[mode] = state.scannedLastKey;
    }
    const hasMore = selected.length < allMatches.length || [...modeResults.values()].some((state) => state.hasMore);
    return {
      items: selected,
      nextCursor: hasMore ? encodeApiCursor(query, initialVector, nextLastKeys) : null,
      hasMore,
      omittedRecords: Math.max(0, allMatches.length - selected.length)
        + [...modeResults.values()].reduce((total, state) => total + state.omittedRecords, 0),
      cursorBinding: {
        mode: query.mode,
        scopeKey: query.scopeKey,
        normalizedFilterKey: query.normalizedFilterKey,
        sourceVectorRevision: initialVector.vectorRevision,
      },
    };
  };
  const data = makeData(Math.min(query.limit, allMatches.length));
  return {
    data,
    makeData,
    totalItems: allMatches.length,
    identities: uniqueIdentities(data.items),
    sourceVector: initialVector,
    complete: complete && limitations.length === 0,
    freshness,
    limitations: mergeLimitations(limitations),
  };
}

function decodeApiCursor(cursor, query, vector) {
  const empty = Object.freeze({ comparative: null, 'single-site': null });
  if (cursor === null) return { lastKeys: empty };
  let document;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.length > MAX_CURSOR_CHARACTERS) throw new Error('oversized');
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ConsoleApiError('CONSOLE_CURSOR_INVALID', 400);
  }
  if (!plainRecord(document)
    || exactKeyList(document) !== 'indexRevision,lastKeys,mode,normalizedFilterKey,schemaVersion,scopeKey,vectorRevision'
    || document.schemaVersion !== CONSOLE_API_SCHEMA_VERSION
    || document.mode !== query.mode || document.scopeKey !== query.scopeKey
    || document.normalizedFilterKey !== query.normalizedFilterKey
    || document.vectorRevision !== vector.vectorRevision || document.indexRevision !== vector.indexRevision
    || !plainRecord(document.lastKeys)
    || exactKeyList(document.lastKeys) !== 'comparative,single-site') {
    throw new ConsoleApiError('CONSOLE_CURSOR_STALE', 409);
  }
  const lastKeys = Object.create(null);
  for (const mode of MODES) {
    const value = document.lastKeys[mode];
    if (value !== null && (!safeBoundedText(value, 1_024) || SECRET_VALUE.test(value))) {
      throw new ConsoleApiError('CONSOLE_CURSOR_INVALID', 400);
    }
    lastKeys[mode] = value;
  }
  return { lastKeys: Object.freeze(lastKeys) };
}

function encodeApiCursor(query, vector, lastKeys) {
  const document = {
    schemaVersion: CONSOLE_API_SCHEMA_VERSION,
    mode: query.mode,
    scopeKey: query.scopeKey,
    normalizedFilterKey: query.normalizedFilterKey,
    vectorRevision: vector.vectorRevision,
    indexRevision: vector.indexRevision,
    lastKeys: { comparative: lastKeys.comparative ?? null, 'single-site': lastKeys['single-site'] ?? null },
  };
  const encoded = Buffer.from(JSON.stringify(document)).toString('base64url');
  if (encoded.length > MAX_CURSOR_CHARACTERS) throw new ConsoleApiError('CONSOLE_RESPONSE_LIMIT', 503);
  return encoded;
}

function encodeAdapterCursor(adapter, value) {
  return typeof adapter.encodeCursor === 'function' ? adapter.encodeCursor(value) : encodeConsoleIndexCursor(value);
}

function decodeAdapterCursor(adapter, value) {
  return typeof adapter.decodeCursor === 'function' ? adapter.decodeCursor(value) : decodeConsoleIndexCursor(value);
}

function validateCursorBinding(binding, mode, query, vector) {
  if (!plainRecord(binding) || binding.mode !== mode || binding.scopeKey !== query.scopeKey
    || binding.normalizedFilterKey !== query.normalizedFilterKey
    || binding.sourceVectorRevision !== vector.vectorRevision) {
    throw new ConsoleApiError('CONSOLE_INDEX_UNAVAILABLE', 503);
  }
}

function sanitizeRecord(value) {
  if (!plainRecord(value) || value.schemaVersion !== 1 || !MODES.has(value.mode)
    || !SAFE_ID.test(String(value.runId ?? '')) || !SAFE_ID.test(String(value.recordId ?? ''))
    || !RECORD_TYPES.has(value.recordType) || !safeBoundedText(value.scopeKey, 512)
    || !SAFE_ID.test(String(value.sourceId ?? '')) || !nullableSafeText(value.sourceRevision, 256)
    || !nullableTimestamp(value.sourceUpdatedAt) || typeof value.complete !== 'boolean'
    || !safeBoundedText(value.sortKey, 1_024) || !plainRecord(value.fields)) return null;
  const fields = Object.create(null);
  for (const key of Object.keys(value.fields).sort()) {
    if (!FIELD_NAMES.has(key) || PROTOTYPE_KEY.test(key) || SECRET_KEY.test(key)) return null;
    const source = value.fields[key];
    if (Array.isArray(source)) {
      if (source.length > 100) return null;
      const normalized = source.map((entry) => sanitizeFieldValue(key, entry));
      if (normalized.some((entry) => entry === undefined)) return null;
      fields[key] = normalized;
    } else {
      const normalized = sanitizeFieldValue(key, source);
      if (normalized === undefined) return null;
      fields[key] = normalized;
    }
  }
  return {
    schemaVersion: 1,
    mode: value.mode,
    runId: value.runId,
    recordId: value.recordId,
    recordType: value.recordType,
    scopeKey: value.scopeKey,
    sourceId: value.sourceId,
    sourceRevision: value.sourceRevision,
    sourceUpdatedAt: value.sourceUpdatedAt,
    complete: value.complete,
    sortKey: value.sortKey,
    fields,
  };
}

function sanitizeFieldValue(field, value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
  if (!safeBoundedText(value, 2_048) || SECRET_VALUE.test(value)) return undefined;
  if (ORIGIN_FIELDS.has(field)) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash || url.origin !== value) return undefined;
    } catch { return undefined; }
  } else if (ABSOLUTE_URL.test(value)) return undefined;
  return value;
}

function sanitizeSourceVector(value) {
  if (!plainRecord(value) || value.schemaVersion !== 1 || !safeBoundedText(value.vectorRevision, 160)
    || !safeBoundedText(value.indexRevision, 160) || typeof value.complete !== 'boolean'
    || !Array.isArray(value.sources) || value.sources.length > 64) {
    throw new ConsoleApiError('CONSOLE_INDEX_UNAVAILABLE', 503);
  }
  const sources = [];
  let complete = value.complete;
  for (const source of value.sources) {
    if (!plainRecord(source) || !SAFE_ID.test(String(source.sourceId ?? ''))
      || !nullableSafeText(source.revision, 256) || !nullableTimestamp(source.updatedAt)
      || typeof source.complete !== 'boolean') {
      complete = false;
      continue;
    }
    sources.push({ sourceId: source.sourceId, revision: source.revision, updatedAt: source.updatedAt, complete: source.complete });
  }
  return { schemaVersion: 1, vectorRevision: value.vectorRevision, indexRevision: value.indexRevision, complete, sources };
}

function sanitizeLimitations(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((entry) => {
    if (!plainRecord(entry) || !SAFE_ID.test(String(entry.sourceId ?? '')) || !SAFE_TOKEN.test(String(entry.code ?? ''))) return [];
    return [{ sourceId: entry.sourceId, code: entry.code }];
  });
}

function sanitizeCapabilities(value) {
  if (value === null || value === undefined) return null;
  const source = Array.isArray(value) ? value : Array.isArray(value.entries) ? value.entries : [value];
  const items = source.slice(0, MAX_CAPABILITY_ENTRIES).flatMap((entry) => {
    if (!plainRecord(entry) || !CONTEXT_IDS.has(entry.contextId) || !safeBoundedText(entry.authorityRevision, 160)
      || !Array.isArray(entry.actions) || entry.actions.length > ACTION_IDS.size) return [];
    let identity = null;
    if (entry.identity !== undefined) {
      if (!plainRecord(entry.identity) || !MODES.has(entry.identity.mode) || !SAFE_ID.test(String(entry.identity.runId ?? ''))) return [];
      identity = { mode: entry.identity.mode, runId: entry.identity.runId };
    }
    const actions = entry.actions.flatMap((action) => {
      if (!plainRecord(action) || !ACTION_IDS.has(action.actionId)
        || typeof action.supported !== 'boolean'
        || ![true, false, null].includes(action.authorized)
        || ![true, false, null].includes(action.eligible)
        || (action.available !== undefined && typeof action.available !== 'boolean')
        || !nullableSafeText(action.unavailableReason, 240)) return [];
      return [{
        actionId: action.actionId,
        supported: action.supported,
        authorized: action.authorized,
        eligible: action.eligible,
        available: action.available === true,
        unavailableReason: action.unavailableReason,
      }];
    });
    return [{ schemaVersion: 1, identity, contextId: entry.contextId, authorityRevision: entry.authorityRevision, actions }];
  });
  return { schemaVersion: 1, items };
}

function recordMatches(record, filters, queryText = null) {
  for (const [facet, expected] of Object.entries(filters)) {
    const candidates = facetCandidates(record, facet).map(String);
    if (!expected.some((value) => candidates.includes(value))) return false;
  }
  if (queryText !== null && !searchableRecordText(record).includes(queryText)) return false;
  return true;
}

function facetCandidates(record, facet) {
  const fields = record.fields;
  const keys = {
    state: ['executionState', 'activityState', 'finalizationStatus', 'status'],
    profile: ['profile'],
    terminal: ['terminal'],
    kind: ['attentionKind', 'sourceKind', 'reasonCodes'],
    severity: ['severity'],
    blocking: ['blocking'],
    status: ['status', 'outcome', 'visualStatus', 'mediaQualityState', 'evidenceCompletionStatus'],
    run: [],
    stage: ['stageId'],
    shard: ['shardId'],
    metric: [],
    suite: ['areas', 'targetIds', 'pluginIds', 'auditIds', 'auditId', 'targetId', 'subtitle'],
  }[facet] ?? [];
  const result = facet === 'run' ? [record.runId] : facet === 'metric' ? [record.recordId] : facet === 'kind' ? [record.recordType] : [];
  for (const key of keys) {
    const value = fields[key];
    if (Array.isArray(value)) result.push(...value);
    else if (value !== undefined && value !== null) result.push(value);
  }
  if (facet === 'kind') {
    for (const value of [...result].map(String)) {
      if (value === 'manual-obligation') result.push('manual');
      if (value === 'incomplete-execution') result.push('infrastructure');
      if (value === 'flaky-execution') result.push('flaky');
      if (value === 'finding-summary' || value === 'risk') result.push('finding');
      if (value === 'screenshot') result.push('image');
    }
  }
  return [...new Set(result.map(String))];
}

function searchableRecordText(record) {
  const values = [record.runId, record.recordId, record.recordType];
  for (const key of ['title', 'subtitle', 'detail', 'auditId', 'evidenceId', 'targetId', 'stageId', 'shardId', 'sourceKind', 'sourceRecordId', 'areas', 'targetIds', 'pluginIds', 'auditIds']) {
    const value = record.fields[key];
    if (Array.isArray(value)) values.push(...value);
    else if (value !== undefined && value !== null) values.push(value);
  }
  return values.map(String).join('\n').toLocaleLowerCase('en-US');
}

function compareApiRecords(left, right, sort) {
  return consoleIndexOrderKey(left, sort).localeCompare(consoleIndexOrderKey(right, sort));
}

function indexRecordKey(record) {
  return consoleIndexOrderKey(record, 'index');
}

function uniqueIdentities(records) {
  const seen = new Set();
  const identities = [];
  for (const record of records) {
    const key = `${record.mode}:${record.runId}`;
    if (!seen.has(key)) {
      seen.add(key);
      identities.push({ mode: record.mode, runId: record.runId });
    }
  }
  return identities;
}

function boundedSuccessResponse({ route, query, assembly, tracker, responseLimit, method }) {
  let itemCount = Array.isArray(assembly.data?.items) ? assembly.data.items.length : null;
  let byteLimited = false;
  let body;
  let serialized;
  for (;;) {
    const data = itemCount === null ? assembly.data : assembly.makeData(itemCount);
    const limitations = byteLimited
      ? mergeLimitations(assembly.limitations, [{ sourceId: 'console-api', code: 'budget-exhausted' }])
      : assembly.limitations;
    body = {
      schemaVersion: CONSOLE_API_SCHEMA_VERSION,
      apiVersion: 'v1',
      routeId: route.id,
      query: publicQuery(query),
      sourceVector: assembly.sourceVector,
      complete: assembly.complete && !byteLimited,
      freshness: assembly.freshness,
      limitations,
      work: publicWork(tracker, byteLimited),
      capabilities: assembly.capabilities,
      data,
    };
    serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) <= responseLimit) break;
    if (itemCount === null || itemCount <= 1) throw new ConsoleApiError('CONSOLE_RESPONSE_LIMIT', 503);
    itemCount = Math.max(1, Math.floor(itemCount * 0.7));
    byteLimited = true;
  }
  assertWithinBudget(tracker);
  const bytes = Buffer.byteLength(serialized);
  const headers = responseHeaders(bytes);
  return Object.freeze({ handled: true, status: 200, headers, body: method === 'HEAD' ? null : body });
}

function publicQuery(query) {
  return {
    mode: query.mode,
    scopeKey: query.scopeKey,
    sort: query.sort,
    q: query.q,
    filters: query.filters,
    limit: query.limit,
    normalizedFilterKey: query.normalizedFilterKey,
  };
}

function createWorkTracker(budget, clock) {
  return { budget, clock, startedAt: Number(clock()), attempts: 0, indexReads: 0, recordsRead: 0, sourceFilesRead: 0, sourceBytesRead: 0 };
}

function mergeAttemptTrackers(trackers, budget, clock) {
  const attempts = Math.max(1, trackers.length);
  return {
    budget: {
      maxRecords: budget.maxRecords * attempts,
      maxSourceFiles: budget.maxSourceFiles * attempts,
      maxSourceBytes: budget.maxSourceBytes * attempts,
      maxElapsedMs: budget.maxElapsedMs * attempts,
    },
    clock,
    startedAt: trackers[0]?.startedAt ?? Number(clock()),
    attempts,
    indexReads: trackers.reduce((total, tracker) => total + tracker.indexReads, 0),
    recordsRead: trackers.reduce((total, tracker) => total + tracker.recordsRead, 0),
    sourceFilesRead: trackers.reduce((total, tracker) => total + tracker.sourceFilesRead, 0),
    sourceBytesRead: trackers.reduce((total, tracker) => total + tracker.sourceBytesRead, 0),
  };
}

function consumeWork(tracker, value) {
  const work = plainRecord(value) ? value : {};
  tracker.recordsRead += safeCount(work.recordsRead);
  tracker.sourceFilesRead += safeCount(work.sourceFilesRead);
  tracker.sourceBytesRead += safeCount(work.sourceBytesRead);
  assertWithinBudget(tracker, work.budgetExhausted === true);
}

function assertWithinBudget(tracker, sourceExhausted = false) {
  const elapsed = Math.max(0, Number(tracker.clock()) - tracker.startedAt);
  if (sourceExhausted || tracker.recordsRead > tracker.budget.maxRecords
    || tracker.sourceFilesRead > tracker.budget.maxSourceFiles
    || tracker.sourceBytesRead > tracker.budget.maxSourceBytes
    || elapsed > tracker.budget.maxElapsedMs) {
    throw new ConsoleApiError('CONSOLE_READ_BUDGET_EXCEEDED', 503);
  }
}

function publicWork(tracker, budgetExhausted = false) {
  return {
    recordsRead: tracker.recordsRead,
    sourceFilesRead: tracker.sourceFilesRead,
    sourceBytesRead: tracker.sourceBytesRead,
    elapsedMs: Math.max(0, Math.round(Number(tracker.clock()) - tracker.startedAt)),
    budgetExhausted,
    indexReads: tracker.indexReads,
    assemblyAttempts: tracker.attempts,
  };
}

function vectorKey(value) {
  return `${value.vectorRevision}\u241f${value.indexRevision}`;
}

function mergeLimitations(...groups) {
  const values = groups.flat().filter(Boolean);
  const seen = new Set();
  return values.filter((entry) => {
    const key = `${entry.sourceId}:${entry.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 64);
}

function normalizeFreshness(value) {
  return ['current', 'stale', 'unknown'].includes(value) ? value : 'unknown';
}

function nullableTimestamp(value) {
  if (value === null) return true;
  if (!safeBoundedText(value, 64)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function nullableSafeText(value, maximum) {
  return value === null || safeBoundedText(value, maximum);
}

function safeBoundedText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !CONTROL_TEXT.test(value) && !SECRET_VALUE.test(value);
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeyList(value) {
  return Object.keys(value).sort().join(',');
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function clampInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : maximum;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Console request aborted.', 'AbortError');
}

function normalizeError(error) {
  if (error instanceof ConsoleApiError) return error;
  if (error instanceof ConsoleIndexError) {
    if (error.code === 'CONSOLE_INDEX_CURSOR_STALE') return new ConsoleApiError('CONSOLE_CURSOR_STALE', 409);
    if (error.code === 'CONSOLE_INDEX_CURSOR_INVALID') return new ConsoleApiError('CONSOLE_CURSOR_INVALID', 400);
    if (error.statusCode >= 400 && error.statusCode < 500) return new ConsoleApiError('CONSOLE_QUERY_INVALID', error.statusCode);
  }
  return new ConsoleApiError('CONSOLE_INDEX_UNAVAILABLE', 503);
}

function responseHeaders(bytes, extra = {}) {
  return Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Console-Schema-Version': String(CONSOLE_API_SCHEMA_VERSION),
    ...extra,
  });
}

function errorResponse(error, method, extraHeaders = {}) {
  const code = Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : 'CONSOLE_INDEX_UNAVAILABLE';
  const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 503;
  const body = { schemaVersion: CONSOLE_API_SCHEMA_VERSION, error: { code, message: ERROR_MESSAGES[code] } };
  const serialized = JSON.stringify(body);
  return Object.freeze({
    handled: true,
    status,
    headers: responseHeaders(Buffer.byteLength(serialized), extraHeaders),
    body: method === 'HEAD' ? null : body,
  });
}

function unhandled() {
  return Object.freeze({ handled: false, status: 0, headers: Object.freeze({}), body: null });
}
