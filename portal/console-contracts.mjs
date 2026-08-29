export const CONSOLE_CONTRACT_SCHEMA_VERSION = 1;

const MAX_QUERY_CHARACTERS = 4_096;
const MAX_PARAMETER_NAME_CHARACTERS = 64;
const DEFAULT_VALUE_CHARACTERS = 160;
const MAX_FILTER_VALUES = 20;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SECRET_KEY_PATTERN = /(?:authorization|cookie|credential|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer)/i;
const SECRET_VALUE_PATTERN = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{4,}|https?:\/\/[^\s/@:]+:[^\s/@]+@)/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const RESIDUAL_ESCAPE_PATTERN = /%[0-9A-Fa-f]{2}/;
const PROTOTYPE_KEY_PATTERN = /^(?:__proto__|prototype|constructor)$/i;

const identifier = (options = {}) => ({ type: 'identifier', maximum: 160, ...options });
const token = (options = {}) => ({ type: 'token', maximum: DEFAULT_VALUE_CHARACTERS, ...options });
const text = (options = {}) => ({ type: 'text', maximum: 1_200, ...options });
const choice = (values, options = {}) => ({ type: 'enum', values, ...options });
const multiToken = (options = {}) => ({ type: 'token', multiple: true, maximum: DEFAULT_VALUE_CHARACTERS, maximumItems: MAX_FILTER_VALUES, ...options });
const multiChoice = (values, options = {}) => ({ type: 'enum', values, multiple: true, maximumItems: MAX_FILTER_VALUES, ...options });

const commonGlobalFilters = {
  mode: choice(['all', 'comparative', 'single-site'], { default: 'all' }),
  scope: token(),
  q: text(),
};

const routeContracts = {
  overview: {
    pathname: '/',
    surface: 'overview',
    runtime: 'live',
    group: 'operations',
    urlState: {
      mode: commonGlobalFilters.mode,
      scope: token(),
      view: choice(['attention', 'all'], { default: 'attention' }),
    },
  },
  runs: {
    pathname: '/runs.html',
    surface: 'runs',
    runtime: 'live',
    group: 'operations',
    urlState: {
      ...commonGlobalFilters,
      state: multiToken(),
      sort: choice(['recent', 'risk', 'duration'], { default: 'recent' }),
      run: identifier(),
      inspector: choice(['open', 'closed'], { default: 'closed' }),
    },
  },
  run: {
    pathname: '/run.html',
    surface: 'run-workspace',
    runtime: 'live',
    group: 'operations',
    urlState: {
      mode: choice(['comparative', 'single-site'], { required: true }),
      run: identifier({ required: true }),
      view: choice(['overview', 'tests', 'findings', 'evidence', 'timeline', 'logs', 'report'], { default: 'overview' }),
      record: identifier(),
      operation: identifier(),
      inspector: choice(['open', 'closed'], { default: 'closed' }),
      search: text({ maximum: 300 }),
      source: token(),
      stage: token(),
      shard: token(),
    },
  },
  findings: {
    pathname: '/findings.html',
    surface: 'findings',
    runtime: 'live',
    group: 'operations',
    urlState: {
      ...commonGlobalFilters,
      run: identifier(),
      sort: choice(['risk', 'newest', 'oldest'], { default: 'risk' }),
      kind: multiChoice(['finding', 'visual-review', 'manual', 'infrastructure', 'flaky', 'failed-audit']),
      severity: multiChoice(['P0', 'P1', 'P2', 'P3']),
      suite: multiToken(),
      record: identifier(),
      inspector: choice(['open', 'closed'], { default: 'closed' }),
    },
  },
  evidence: {
    pathname: '/evidence.html',
    surface: 'evidence',
    runtime: 'live',
    group: 'operations',
    urlState: {
      ...commonGlobalFilters,
      run: identifier(),
      sort: choice(['attention', 'capture-time', 'suite'], { default: 'attention' }),
      kind: multiChoice(['image', 'video', 'trace', 'json', 'network', 'axe', 'lighthouse']),
      suite: multiToken(),
      status: multiToken(),
      item: identifier(),
      member: identifier(),
      inspector: choice(['open', 'closed'], { default: 'closed' }),
    },
  },
  'new-audit': {
    pathname: '/new-audit.html',
    surface: 'new-audit',
    runtime: 'live',
    group: 'creation',
    urlState: {
      mode: choice(['comparative', 'single-site'], { default: 'comparative' }),
    },
  },
  settings: {
    pathname: '/settings.html',
    surface: 'settings',
    runtime: 'live',
    group: 'configuration',
    urlState: {
      section: choice(['test-catalog', 'baselines', 'environments', 'credentials'], { default: 'credentials' }),
    },
  },
  report: {
    pathname: '/report.html',
    surface: 'report',
    runtime: 'live',
    group: 'operations',
    compatibility: 'existing-direct-entry',
    urlState: {
      mode: choice(['comparative', 'single-site'], { default: 'comparative' }),
      run: identifier({ required: true }),
    },
  },
  gallery: {
    pathname: '/gallery.html',
    surface: 'gallery',
    runtime: 'live',
    group: 'operations',
    compatibility: 'existing-direct-entry',
    urlState: {
      mode: choice(['comparative', 'single-site', 'overview'], { default: 'comparative' }),
      run: identifier({ required: true }),
      from: choice(['runs', 'report'], { default: 'runs' }),
      view: choice(['overview', 'workbench'], { default: 'workbench' }),
      review: choice(['attention', 'all'], { default: 'attention' }),
      kind: multiChoice(['image', 'video']),
      status: multiToken(),
      environment: multiToken(),
      featureSuite: multiToken(),
      technicalSuite: multiToken(),
      target: multiToken(),
      flagState: multiChoice(['open', 'resolved', 'dismissed', 'unflagged']),
      suite: multiToken(),
      finding: choice(['all', 'finding', 'clear'], { default: 'all' }),
      coverage: choice(['all', 'gap', 'covered'], { default: 'all' }),
      visual: choice(['all', 'CHANGED', 'UNCHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable'], { default: 'all' }),
      q: text(),
      group: choice(['feature', 'technical', 'none'], { default: 'feature' }),
      sort: choice(['attention', 'feature', 'technical', 'audit', 'capture-time'], { default: 'attention' }),
      item: identifier(),
      member: identifier(),
      raw: choice(['0', '1'], { default: '0' }),
    },
  },
  'archive-report': {
    pathname: 'index.html',
    surface: 'report',
    runtime: 'sealed-archive',
    group: 'archive',
    urlState: {},
  },
  'archive-gallery': {
    pathname: 'gallery.html',
    surface: 'gallery',
    runtime: 'sealed-archive',
    group: 'archive',
    urlState: {
      mode: choice(['overview', 'workbench'], { default: 'workbench' }),
      kind: multiChoice(['image', 'video']),
      status: multiToken(),
      environment: multiToken(),
      featureSuite: multiToken(),
      technicalSuite: multiToken(),
      target: multiToken(),
      flagState: multiChoice(['open', 'resolved', 'dismissed', 'unflagged']),
      q: text(),
      group: choice(['feature', 'technical', 'none'], { default: 'feature' }),
      sort: choice(['attention', 'feature', 'technical', 'audit', 'capture-time'], { default: 'attention' }),
      item: identifier(),
      member: identifier(),
      raw: choice(['0', '1'], { default: '0' }),
    },
  },
};

export const CONSOLE_ROUTE_CONTRACTS = deepFreeze(Object.fromEntries(
  Object.entries(routeContracts).map(([id, contract]) => [id, {
    schemaVersion: CONSOLE_CONTRACT_SCHEMA_VERSION,
    id,
    ...contract,
  }]),
));

export const CONSOLE_SURFACE_IDS = Object.freeze(
  Object.values(CONSOLE_ROUTE_CONTRACTS).map(({ runtime, surface }) => `${runtime}:${surface}`),
);

export const CONSOLE_ASYNC_STATES = Object.freeze([
  'initial-loading',
  'ready',
  'refreshing',
  'partial',
  'empty-success',
  'stale',
  'retryable-failure',
  'unavailable',
  'permission-denied',
  'reconnecting',
  'offline',
]);

export const CONSOLE_CONNECTION_STATES = Object.freeze([
  'connecting',
  'connected',
  'reconnecting',
  'offline',
  'closed',
]);

export const CONSOLE_STATE_DOMAINS = deepFreeze({
  execution: { owner: 'audit-authority', clientMutable: false, values: 'source-defined' },
  activity: { owner: 'audit-authority', clientMutable: false, values: 'source-defined' },
  connection: { owner: 'browser-transport', clientMutable: true, values: CONSOLE_CONNECTION_STATES },
  region: { owner: 'browser-region', clientMutable: true, values: CONSOLE_ASYNC_STATES },
});

const capabilityContexts = {
  'comparative-live': {
    auditMode: 'comparative',
    runtime: 'live',
    transport: { kind: 'sse', resume: 'sequence', fallback: 'bounded-snapshot' },
    actions: {
      stop: true,
      cancel: false,
      purge: true,
      manualEvidence: true,
      rekick: true,
      riskAcknowledge: true,
      riskResolve: true,
      visualDisposition: true,
      baseline: false,
      aiReview: true,
      settings: true,
    },
    destinations: { report: true, gallery: true, checklist: true, sourceReport: true, artifacts: true },
    archiveMutability: 'not-applicable',
  },
  'single-site-live': {
    auditMode: 'single-site',
    runtime: 'live',
    transport: { kind: 'polling', resume: 'revision', fallback: 'bounded-snapshot' },
    actions: {
      stop: false,
      cancel: true,
      purge: true,
      manualEvidence: false,
      rekick: true,
      riskAcknowledge: true,
      riskResolve: true,
      visualDisposition: true,
      baseline: true,
      aiReview: true,
      settings: true,
    },
    destinations: { report: true, gallery: true, checklist: false, sourceReport: true, artifacts: true },
    archiveMutability: 'not-applicable',
  },
  'sealed-archive': {
    auditMode: 'source-defined',
    runtime: 'sealed-archive',
    transport: { kind: 'sealed', resume: 'none', fallback: 'none' },
    actions: {
      stop: false,
      cancel: false,
      purge: false,
      manualEvidence: false,
      rekick: false,
      riskAcknowledge: false,
      riskResolve: false,
      visualDisposition: false,
      baseline: false,
      aiReview: false,
      settings: false,
    },
    destinations: { report: true, gallery: true, checklist: false, sourceReport: false, artifacts: true },
    archiveMutability: 'read-only',
  },
};

const ACTION_DEFINITIONS = Object.freeze({
  stop: { mutates: true, authorization: 'required', eligibility: 'source-defined' },
  cancel: { mutates: true, authorization: 'required', eligibility: 'source-defined' },
  purge: { mutates: true, authorization: 'required', eligibility: 'source-defined' },
  manualEvidence: { mutates: true, authorization: 'required', eligibility: 'source-defined' },
  rekick: { mutates: true, authorization: 'required', eligibility: 'incomplete-executions-only' },
  riskAcknowledge: { mutates: true, authorization: 'required', eligibility: 'open-nonvisual-risk-only' },
  riskResolve: { mutates: true, authorization: 'required', eligibility: 'resolvable-nonvisual-risk-only' },
  visualDisposition: { mutates: true, authorization: 'required', eligibility: 'source-defined' },
  baseline: { mutates: true, authorization: 'required', eligibility: 'source-defined' },
  aiReview: { mutates: true, authorization: 'required', eligibility: 'source-defined' },
  settings: { mutates: true, authorization: 'required', eligibility: 'source-defined' },
});

export const CONSOLE_ACTION_POLICIES = deepFreeze(Object.fromEntries(
  Object.entries(capabilityContexts).map(([contextId, context]) => [contextId, Object.fromEntries(
    Object.entries(ACTION_DEFINITIONS).map(([actionId, definition]) => {
      const supported = context.actions[actionId] === true;
      return [actionId, {
        ...definition,
        supported,
        unsupportedReason: supported ? null : unsupportedActionReason(contextId, actionId),
      }];
    }),
  )]),
));

export const CONSOLE_CONTEXT_CAPABILITIES = deepFreeze(Object.fromEntries(
  Object.entries(capabilityContexts).map(([id, contract]) => [id, {
    schemaVersion: CONSOLE_CONTRACT_SCHEMA_VERSION,
    id,
    ...contract,
  }]),
));

export const CONSOLE_CONTROLLER_OWNERSHIP = deepFreeze({
  'new-audit.launch-mutation': { surface: 'new-audit', concern: 'launch-mutation', owner: 'portal/public/new-audit.js', handoffUnit: 'retained' },
  'settings.credential-mutations': { surface: 'settings', concern: 'credential-mutations', owner: 'portal/public/settings.js', handoffUnit: 'retained' },
  'overview.run-list-polling': { surface: 'overview', concern: 'run-list-polling', owner: 'portal/public/overview.js', handoffUnit: 'U4' },
  'runs.run-history': { surface: 'runs', concern: 'history', owner: 'portal/public/runs.js', handoffUnit: 'U6' },
  'comparative.run-workspace': { surface: 'comparative-run', concern: 'stream-stop-purge-manual-evidence', owner: 'portal/public/run-workspace.js', handoffUnit: 'U6' },
  'single-site.run-workspace': { surface: 'single-site-run', concern: 'polling-cancel-purge', owner: 'portal/public/run-workspace.js', handoffUnit: 'U6' },
  'live.report-polling': { surface: 'live-report', concern: 'polling', owner: 'portal/public/report.js', handoffUnit: 'U7' },
  'live.report-ai-mutation': { surface: 'live-report', concern: 'ai-retry-mutation', owner: 'portal/public/report.js', handoffUnit: 'U7' },
  'live.gallery-history': { surface: 'live-gallery', concern: 'history', owner: 'portal/public/gallery.js', handoffUnit: 'U7' },
  'comparative.gallery-stream': { surface: 'comparative-gallery', concern: 'stream', owner: 'portal/public/gallery.js', handoffUnit: 'U7' },
  'comparative.gallery-mutations': { surface: 'comparative-gallery', concern: 'flag-mutations', owner: 'portal/public/gallery.js', handoffUnit: 'U7' },
  'single-site.gallery-polling': { surface: 'single-site-gallery', concern: 'polling', owner: 'portal/public/gallery.js', handoffUnit: 'U7' },
  'single-site.gallery-mutations': { surface: 'single-site-gallery', concern: 'review-baseline-mutations', owner: 'portal/public/gallery.js', handoffUnit: 'U7' },
  'live.gallery-reducer': { surface: 'live-gallery', concern: 'queue-viewer-context-reducer', owner: 'portal/public/gallery-core.js', handoffUnit: 'retained' },
  'archive.report-controller': { surface: 'sealed-report', concern: 'controller', owner: 'reporters/assets/report.js', handoffUnit: 'U8' },
  'archive.gallery-history': { surface: 'sealed-gallery', concern: 'history', owner: 'reporters/assets/gallery-archive.js', handoffUnit: 'U8' },
  'archive.gallery-transport': { surface: 'sealed-gallery', concern: 'iframe-transport', owner: 'reporters/assets/gallery-archive.js', handoffUnit: 'U8' },
  'archive.gallery-reducer': { surface: 'sealed-gallery', concern: 'queue-viewer-context-reducer', owner: 'portal/public/gallery-core.js via reporters/gallery-model.ts', handoffUnit: 'retained' },
});

export function getConsoleRouteContract(routeId) {
  const contract = CONSOLE_ROUTE_CONTRACTS[routeId];
  if (!contract) throw new Error(`Unknown console route: ${String(routeId)}.`);
  return contract;
}

export function resolveConsoleRouteId(pathname, { runtime = 'live' } = {}) {
  if (typeof pathname !== 'string') return null;
  return Object.values(CONSOLE_ROUTE_CONTRACTS).find((contract) => (
    contract.runtime === runtime && pathnameMatchesContract(pathname, contract)
  ))?.id ?? null;
}

export function getConsoleCapabilities(contextId) {
  const contract = CONSOLE_CONTEXT_CAPABILITIES[contextId];
  if (!contract) throw new Error(`Unknown console capability context: ${String(contextId)}.`);
  return contract;
}

export function resolveConsoleActionAvailability(contextId, actionId, {
  authorized = null,
  eligible = null,
  unavailableReason = null,
} = {}) {
  const context = getConsoleCapabilities(contextId);
  const policy = CONSOLE_ACTION_POLICIES[contextId]?.[actionId];
  if (!policy) throw new Error(`Unknown console action: ${String(actionId)}.`);
  if (!policy.supported) return deepFreeze({
    contextId,
    actionId,
    supported: false,
    authorized: null,
    eligible: null,
    available: false,
    unavailableReason: policy.unsupportedReason,
  });
  const normalizedAuthorized = authorized === true ? true : authorized === false ? false : null;
  const normalizedEligible = eligible === true ? true : eligible === false ? false : null;
  return deepFreeze({
    contextId,
    actionId,
    supported: true,
    authorized: normalizedAuthorized,
    eligible: normalizedEligible,
    available: normalizedAuthorized === true && normalizedEligible === true,
    unavailableReason: unavailableReason
      ?? (normalizedAuthorized === false ? 'Permission denied.'
        : normalizedAuthorized === null ? 'Authorization has not been established.'
          : normalizedEligible === false && actionId === 'rekick' ? 'Only incomplete executions are eligible for rekick.'
            : normalizedEligible === false ? 'The authoritative run state does not permit this action.'
            : normalizedEligible === null ? 'Action eligibility has not been established.' : null),
    runtime: context.runtime,
  });
}

export function parseConsoleUrlState(routeId, input = '') {
  const contract = getConsoleRouteContract(routeId);
  const rejected = [];
  const errors = [];
  const { parameters, pathname, rawSearch } = inputParameters(input);
  if (pathname && !pathnameMatchesContract(pathname, contract)) {
    errors.push({ code: 'route-mismatch', key: null });
  }
  if (rawSearch.length > MAX_QUERY_CHARACTERS) {
    return deepFreeze({
      schemaVersion: CONSOLE_CONTRACT_SCHEMA_VERSION,
      routeId,
      valid: false,
      state: defaultsFor(contract.urlState),
      rejected: [{ code: 'query-too-large', key: null }],
      errors,
      search: canonicalSearch(contract.urlState, defaultsFor(contract.urlState)),
    });
  }

  const seen = new Set();
  const state = {};
  for (const key of new Set(parameters.keys())) {
    const values = parameters.getAll(key);
    const spec = contract.urlState[key];
    if (key.length > MAX_PARAMETER_NAME_CHARACTERS || SECRET_KEY_PATTERN.test(key) || PROTOTYPE_KEY_PATTERN.test(key)) {
      rejected.push({ code: 'unsafe-key', key: boundedKey(key) });
      continue;
    }
    if (!spec) {
      rejected.push({ code: key === 'cursor' ? 'cursor-not-url-state' : 'unknown-key', key });
      continue;
    }
    if (!spec.multiple && values.length !== 1) {
      rejected.push({ code: 'duplicate-key', key });
      continue;
    }
    if (spec.multiple && new Set(values).size !== values.length) {
      rejected.push({ code: 'duplicate-value', key });
    }
    const accepted = [];
    for (const value of values) {
      const normalized = validateUrlValue(value, spec);
      if (normalized === null) {
        rejected.push({ code: SECRET_VALUE_PATTERN.test(value) ? 'secret-like-value' : 'invalid-value', key });
        continue;
      }
      if (!accepted.includes(normalized)) accepted.push(normalized);
    }
    if (spec.multiple && accepted.length > (spec.maximumItems ?? MAX_FILTER_VALUES)) {
      rejected.push({ code: 'too-many-values', key });
      continue;
    }
    if (accepted.length > 0) {
      state[key] = spec.multiple ? accepted : accepted[0];
      seen.add(key);
    }
  }

  for (const [key, spec] of Object.entries(contract.urlState)) {
    if (!seen.has(key) && spec.default !== undefined) state[key] = spec.default;
    if (spec.required && !seen.has(key)) errors.push({ code: 'required-key-missing', key });
  }

  return deepFreeze({
    schemaVersion: CONSOLE_CONTRACT_SCHEMA_VERSION,
    routeId,
    valid: errors.length === 0,
    state,
    rejected,
    errors,
    search: canonicalSearch(contract.urlState, state),
  });
}

export function serializeConsoleUrlState(routeId, state = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('Console URL state must be an object.');
  }
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) {
    if (Array.isArray(value)) value.forEach((entry) => parameters.append(key, String(entry)));
    else if (value !== undefined && value !== null && value !== '') parameters.set(key, String(value));
  }
  const parsed = parseConsoleUrlState(routeId, parameters);
  if (!parsed.valid || parsed.rejected.length > 0) {
    throw new Error(`Console URL state for ${routeId} is invalid.`);
  }
  return parsed.search;
}

export function stateDomainOwner(domain) {
  const contract = CONSOLE_STATE_DOMAINS[domain];
  if (!contract) throw new Error(`Unknown console state domain: ${String(domain)}.`);
  return contract.owner;
}

export function assertClientMayWriteStateDomain(domain) {
  const contract = CONSOLE_STATE_DOMAINS[domain];
  if (!contract) throw new Error(`Unknown console state domain: ${String(domain)}.`);
  if (!contract.clientMutable) throw new Error(`Client code must not write ${domain} state.`);
  return true;
}

function inputParameters(input) {
  if (input instanceof URLSearchParams) return { parameters: input, pathname: null, rawSearch: input.toString() };
  if (input instanceof URL) return { parameters: input.searchParams, pathname: input.pathname, rawSearch: input.search.slice(1) };
  if (typeof input !== 'string') throw new TypeError('Console URL input must be a URL, URLSearchParams, or string.');
  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('file://')) {
    const url = new URL(input);
    return { parameters: url.searchParams, pathname: url.pathname, rawSearch: url.search.slice(1) };
  }
  const rawSearch = input.startsWith('?') ? input.slice(1) : input;
  return { parameters: new URLSearchParams(rawSearch), pathname: null, rawSearch };
}

function validateUrlValue(value, spec) {
  if (typeof value !== 'string' || value.length === 0 || value.length > (spec.maximum ?? DEFAULT_VALUE_CHARACTERS)
    || value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value) || SECRET_VALUE_PATTERN.test(value)
    || RESIDUAL_ESCAPE_PATTERN.test(value)) return null;
  if (spec.type === 'enum') return spec.values.includes(value) ? value : null;
  if (spec.type === 'identifier') return IDENTIFIER_PATTERN.test(value) ? value : null;
  if (spec.type === 'token') return TOKEN_PATTERN.test(value) ? value : null;
  if (spec.type === 'text') return value.replace(/\s+/g, ' ');
  return null;
}

function defaultsFor(schema) {
  return Object.fromEntries(Object.entries(schema)
    .filter(([, spec]) => spec.default !== undefined)
    .map(([key, spec]) => [key, spec.default]));
}

function canonicalSearch(schema, state) {
  const parameters = new URLSearchParams();
  for (const key of Object.keys(schema).sort()) {
    const value = state[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) [...value].sort().forEach((entry) => parameters.append(key, entry));
    else parameters.set(key, value);
  }
  return parameters.toString();
}

function boundedKey(value) {
  return typeof value === 'string' ? value.slice(0, MAX_PARAMETER_NAME_CHARACTERS) : null;
}

function pathnameMatchesContract(pathname, contract) {
  if (contract.runtime === 'live') return pathname === contract.pathname;
  const normalized = pathname.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? '';
  return normalized === contract.pathname;
}

function unsupportedActionReason(contextId, actionId) {
  if (contextId === 'sealed-archive') return 'Sealed archives are read-only and expose no live actions.';
  if (contextId === 'comparative-live') {
    if (actionId === 'cancel') return 'Comparative runs use the stop contract.';
    if (actionId === 'baseline') return 'Baseline mutation remains a Single-site evidence operation.';
  }
  if (contextId === 'single-site-live') {
    if (actionId === 'stop') return 'Single-site audits use the cancel contract.';
    if (actionId === 'manualEvidence') return 'Manual evidence is not supported by the Single-site audit contract.';
  }
  return 'This action is not supported in the current audit context.';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}
