const SCHEMA_VERSION = 1;
const MAX_ID_CHARACTERS = 160;
const MAX_STATUS_CHARACTERS = 160;
const MAX_SOURCE_TYPE_CHARACTERS = 80;
const MAX_SOURCE_REVISION_CHARACTERS = 256;
const MAX_LIST_ITEMS = 64;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SECRET_TEXT = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{4,}|https?:\/\/[^\s/@:]+:[^\s/@]+@)/i;
const SECRET_KEY = /(?:authorization|cookie|credential|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer)/i;
const COMPLETENESS = new Set(['complete', 'partial', 'unknown', 'unavailable']);
const FRESHNESS = new Set(['current', 'stale', 'unknown']);
const CONTEXTS = new Set(['comparative-live', 'single-site-live', 'sealed-archive']);
const TERMINAL_COMPARATIVE_STATES = new Set([
  'passed', 'not-ready', 'review-required', 'failed', 'evidence-failed', 'stopped', 'spawn-failed',
]);
const TERMINAL_SINGLE_SITE_STATES = new Set(['completed', 'failed', 'incomplete', 'cancelled']);

export function consoleRunIdentityKey(identity) {
  if (!isRecord(identity) || !['comparative', 'single-site'].includes(identity.mode)) {
    throw new TypeError('Console run identity mode must be comparative or single-site.');
  }
  const runId = requiredIdentifier(identity.runId, 'runId');
  return `${identity.mode}:${runId}`;
}

export function normalizeConsoleAuthorityRecord(record, options = {}) {
  assertAuthorityRecord(record);
  return record.mode === 'comparative'
    ? normalizeComparativeConsoleRecord(record, options)
    : normalizeSingleSiteConsoleRecord(record, options);
}

export function normalizeComparativeConsoleRecord(record, options = {}) {
  assertMode(record, 'comparative');
  const issues = issueCollector(options.limitations);
  const document = isRecord(record.document) ? record.document : null;
  const manifest = objectAt(document, 'manifest') ?? document;
  const runId = runIdentifier(manifest?.id, record.sourceIdentity, issues);
  const source = normalizeSource(record, options, issues, Boolean(manifest));
  const runOptions = objectAt(manifest, 'options') ?? {};
  const runContract = objectAt(document, 'runContract') ?? objectAt(runOptions, 'runContract') ?? {};
  const contractScope = objectAt(runContract, 'scope');
  const selectedScope = contractScope ?? objectAt(runOptions, 'scope') ?? {};
  const productionOrigin = safeOrigin(
    firstDefined(runOptions.productionUrl, runContract.productionUrl),
    'scope.productionOrigin',
    issues,
  );
  const candidateOrigin = safeOrigin(
    firstDefined(runOptions.candidateUrl, runContract.candidateUrl),
    'scope.candidateOrigin',
    issues,
  );
  const profile = statusField(runOptions.profile, 'scope.profile', issues);
  const pluginIds = safeStringList(firstArray(selectedScope.pluginIds, runOptions.pluginIds), 'scope.filters.pluginIds', issues);
  const auditIds = safeStringList(firstArray(selectedScope.auditIds, runOptions.auditIds), 'scope.filters.auditIds', issues);
  const areas = safeStringList(firstArray(selectedScope.areas, runOptions.areas), 'scope.filters.areas', issues);
  const targetIds = safeStringList(
    firstArray(runContract.targetIds, runOptions.targetIds, runOptions.projects),
    'scope.targetIds',
    issues,
  );
  const qualifier = statusField(selectedScope.qualifier, 'scope.qualifier', issues);
  const execution = statusField(manifest?.status, 'lifecycle.execution', issues);
  const phase = statusField(manifest?.phase, 'lifecycle.phase', issues);
  const finishedAt = safeTimestamp(manifest?.finishedAt, 'timestamps.finishedAt', issues);
  const terminal = terminalValue(execution.raw, finishedAt, TERMINAL_COMPARATIVE_STATES);
  const scope = normalizedScope({
    mode: 'comparative', productionOrigin, candidateOrigin, origin: null, role: null,
    profile, qualifier, pluginIds, auditIds, areas, targetIds,
  });
  const identity = deepFreeze({ mode: 'comparative', runId, key: consoleRunIdentityKey({ mode: 'comparative', runId }) });
  const result = {
    schemaVersion: SCHEMA_VERSION,
    mode: 'comparative',
    identity,
    context: normalizeContext('comparative', options.contextId),
    title: comparativeTitle(productionOrigin, candidateOrigin, runId),
    source,
    lifecycle: {
      execution,
      activity: unavailableField('Not published for comparative runs'),
      phase,
      terminal,
    },
    authority: {
      outcome: statusField(objectAt(manifest, 'release')?.decision ?? manifest?.outcome, 'authority.outcome', issues),
      coverage: statusField(manifest?.coverageStatus, 'authority.coverage', issues),
      evidence: evidenceField(manifest?.evidenceAuthority, 'authority.evidence', issues),
      pipeline: statusField(objectAt(manifest, 'pipeline')?.status, 'authority.pipeline', issues),
      finalization: unavailableField('Single-site finalization does not apply to comparative runs'),
    },
    scope,
    timestamps: {
      createdAt: safeTimestamp(manifest?.createdAt, 'timestamps.createdAt', issues),
      startedAt: safeTimestamp(manifest?.startedAt, 'timestamps.startedAt', issues),
      updatedAt: safeTimestamp(manifest?.updatedAt ?? record.sourceUpdatedAt, 'timestamps.updatedAt', issues),
      finishedAt,
    },
    progress: normalizeProgress(manifest?.progress, issues),
    destinations: normalizeDestinations(document, manifest, runId, 'comparative', issues),
    limitations: issues.values,
  };
  result.source = withDetectedCompleteness(result.source, issues);
  return deepFreeze(result);
}

export function normalizeSingleSiteConsoleRecord(record, options = {}) {
  assertMode(record, 'single-site');
  const issues = issueCollector(options.limitations);
  const document = isRecord(record.document) ? record.document : null;
  const state = objectAt(document, 'state') ?? objectAt(document, 'job') ?? document;
  const input = objectAt(document, 'input') ?? {};
  const contract = objectAt(input, 'runContract') ?? objectAt(document, 'runContract') ?? document ?? {};
  const finalization = objectAt(document, 'finalization') ?? objectAt(state, 'finalization');
  const runId = runIdentifier(state?.jobId ?? state?.id, record.sourceIdentity, issues);
  const source = normalizeSource(record, options, issues, Boolean(state));
  const publicScope = objectAt(state, 'scope');
  const contractScope = objectAt(contract, 'scope');
  const selectedScope = contractScope ?? publicScope ?? {};
  const origin = safeOrigin(firstDefined(contract.url, state?.url), 'scope.origin', issues);
  const role = statusField(firstDefined(contract.deploymentRole, state?.deploymentRole), 'scope.deploymentRole', issues);
  const profile = unavailableField('Profile does not apply to Single-site runs');
  const qualifier = statusField(firstDefined(selectedScope.qualifier, publicScope?.qualifier), 'scope.qualifier', issues);
  const filters = objectAt(publicScope, 'filters') ?? selectedScope;
  const pluginIds = safeStringList(firstArray(filters?.pluginIds), 'scope.filters.pluginIds', issues);
  const auditIds = safeStringList(firstArray(filters?.auditIds), 'scope.filters.auditIds', issues);
  const areas = safeStringList(firstArray(filters?.areas), 'scope.filters.areas', issues);
  const targetIds = safeStringList(
    firstArray(contract.targetIds, publicScope?.selectedTargetIds, selectedScope.targetIds),
    'scope.targetIds',
    issues,
  );
  const execution = statusField(firstDefined(state?.executionState, state?.status), 'lifecycle.execution', issues);
  const activity = statusField(firstDefined(state?.activityState, state?.activity), 'lifecycle.activity', issues);
  const terminalByStatus = typeof execution.raw === 'string' && TERMINAL_SINGLE_SITE_STATES.has(execution.raw);
  const finishedAt = safeTimestamp(
    firstDefined(
      state?.finishedAt,
      objectAt(state, 'result')?.finishedAt,
      terminalByStatus ? state?.updatedAt : null,
    ),
    'timestamps.finishedAt',
    issues,
  );
  const terminal = terminalValue(execution.raw, finishedAt, TERMINAL_SINGLE_SITE_STATES);
  const scope = normalizedScope({
    mode: 'single-site', productionOrigin: null, candidateOrigin: null, origin, role,
    profile, qualifier, pluginIds, auditIds, areas, targetIds,
  });
  const identity = deepFreeze({ mode: 'single-site', runId, key: consoleRunIdentityKey({ mode: 'single-site', runId }) });
  const result = {
    schemaVersion: SCHEMA_VERSION,
    mode: 'single-site',
    identity,
    context: normalizeContext('single-site', options.contextId),
    title: singleSiteTitle(origin, role.raw, runId),
    source,
    lifecycle: {
      execution,
      activity,
      phase: statusField(state?.phase, 'lifecycle.phase', issues),
      terminal,
    },
    authority: {
      outcome: statusField(objectAt(state, 'result')?.kind ?? state?.outcome, 'authority.outcome', issues),
      coverage: statusField(objectAt(state, 'coverage')?.status ?? state?.coverageStatus, 'authority.coverage', issues),
      evidence: evidenceField(state?.evidenceAuthority, 'authority.evidence', issues),
      pipeline: statusField(objectAt(state, 'pipeline')?.status, 'authority.pipeline', issues),
      finalization: statusField(finalization?.status, 'authority.finalization', issues),
    },
    scope,
    timestamps: {
      createdAt: safeTimestamp(firstDefined(state?.submittedAt, state?.createdAt), 'timestamps.createdAt', issues),
      startedAt: safeTimestamp(state?.startedAt, 'timestamps.startedAt', issues),
      updatedAt: safeTimestamp(state?.updatedAt ?? record.sourceUpdatedAt, 'timestamps.updatedAt', issues),
      finishedAt,
    },
    progress: normalizeSingleSiteProgress(state, issues),
    destinations: normalizeDestinations(document, state, runId, 'single-site', issues),
    limitations: issues.values,
  };
  result.source = withDetectedCompleteness(result.source, issues);
  return deepFreeze(result);
}

function assertAuthorityRecord(record) {
  if (!isRecord(record) || !['comparative', 'single-site'].includes(record.mode)) {
    throw new TypeError('Console authority record must declare comparative or single-site mode.');
  }
  requiredIdentifier(record.sourceIdentity, 'sourceIdentity');
}

function assertMode(record, mode) {
  assertAuthorityRecord(record);
  if (record.mode !== mode) throw new TypeError(`Expected a ${mode} console authority record.`);
}

function requiredIdentifier(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${label} must be a safe bounded identifier.`);
  return value;
}

function runIdentifier(value, fallback, issues) {
  if (typeof value === 'string' && SAFE_ID.test(value)) return value;
  issues.add('run-identity-unavailable', 'identity.runId');
  return requiredIdentifier(fallback, 'sourceIdentity');
}

function normalizeSource(record, options, issues, available) {
  const sourceType = exactSafeString(record.sourceType, MAX_SOURCE_TYPE_CHARACTERS, 'source.type', issues);
  const revision = nullableExactSafeString(record.sourceRevision, MAX_SOURCE_REVISION_CHARACTERS, 'source.revision', issues);
  const updatedAt = safeTimestamp(record.sourceUpdatedAt, 'source.updatedAt', issues);
  const requestedCompleteness = options.completeness ?? 'unknown';
  const freshness = options.freshness ?? 'unknown';
  if (!COMPLETENESS.has(requestedCompleteness)) throw new TypeError('Console completeness is invalid.');
  if (!FRESHNESS.has(freshness)) throw new TypeError('Console freshness is invalid.');
  return {
    type: sourceType,
    identity: record.sourceIdentity,
    revision,
    updatedAt,
    completeness: available ? requestedCompleteness : 'unavailable',
    freshness: available ? freshness : 'unknown',
  };
}

function withDetectedCompleteness(source, issues) {
  if (source.completeness === 'complete' && issues.detected) return { ...source, completeness: 'partial' };
  return source;
}

function normalizeContext(mode, requested) {
  const contextId = requested ?? `${mode}-live`;
  if (!CONTEXTS.has(contextId)) throw new TypeError('Console context is invalid.');
  if (contextId !== 'sealed-archive' && contextId !== `${mode}-live`) {
    throw new TypeError('Live console context does not match the authority audit mode.');
  }
  return deepFreeze({
    id: contextId,
    runtime: contextId === 'sealed-archive' ? 'sealed-archive' : 'live',
  });
}

function normalizedScope({
  mode, productionOrigin, candidateOrigin, origin, role, profile, qualifier,
  pluginIds, auditIds, areas, targetIds,
}) {
  const deploymentKey = mode === 'comparative'
    ? productionOrigin && candidateOrigin ? JSON.stringify([productionOrigin, candidateOrigin]) : null
    : origin && role.raw !== null ? JSON.stringify([role.raw, origin]) : null;
  const profileKey = mode === 'single-site' ? 'not-applicable' : profile.raw;
  const scopeKey = JSON.stringify({
    qualifier: qualifier.raw,
    pluginIds,
    auditIds,
    areas,
  });
  const targetSetKey = targetIds.length > 0 ? JSON.stringify(targetIds) : null;
  return {
    deployment: {
      kind: mode === 'comparative' ? 'origin-pair' : 'deployment-environment',
      productionOrigin,
      candidateOrigin,
      origin,
      role,
    },
    profile,
    qualifier,
    filters: { pluginIds, auditIds, areas },
    targetIds,
    comparability: {
      deploymentKey,
      profileKey,
      scopeKey,
      targetSetKey,
      complete: deploymentKey !== null && profileKey !== null && targetSetKey !== null,
    },
  };
}

function normalizeProgress(value, issues) {
  const progress = isRecord(value) ? value : {};
  return {
    total: safeInteger(progress.total, 'progress.total', issues),
    completed: safeInteger(progress.completed, 'progress.completed', issues),
    passed: safeInteger(progress.passed, 'progress.passed', issues),
    failed: safeInteger(progress.failed, 'progress.failed', issues),
    flaky: safeInteger(progress.flaky, 'progress.flaky', issues),
    skipped: safeInteger(progress.skipped, 'progress.skipped', issues),
  };
}

function normalizeSingleSiteProgress(state, issues) {
  const attempt = objectAt(state, 'attempt');
  return {
    total: null,
    completed: null,
    passed: null,
    failed: null,
    flaky: null,
    skipped: null,
    attemptNumber: safeInteger(state?.attemptNumber ?? attempt?.number, 'progress.attemptNumber', issues),
    infrastructureRetriesUsed: safeInteger(
      state?.infrastructureRetriesUsed ?? attempt?.infrastructureRetriesUsed,
      'progress.infrastructureRetriesUsed',
      issues,
    ),
  };
}

function normalizeDestinations(document, state, runId, mode, issues) {
  const links = objectAt(state, 'links') ?? objectAt(document, 'links') ?? {};
  return {
    workspace: `/run.html?mode=${mode}&run=${encodeURIComponent(runId)}`,
    report: safeRelativeHref(links.report, 'destinations.report', issues),
    gallery: safeRelativeHref(links.gallery, 'destinations.gallery', issues),
    checklist: safeRelativeHref(links.checklist, 'destinations.checklist', issues),
    sourceReport: safeRelativeHref(links.sourceReport, 'destinations.sourceReport', issues),
    artifacts: safeRelativeHref(links.artifacts, 'destinations.artifacts', issues),
  };
}

function statusField(value, field, issues) {
  if (value === undefined || value === null || value === '') return unknownField();
  if ((typeof value !== 'string' && typeof value !== 'boolean')
    || (typeof value === 'string' && !isExactSafeText(value, MAX_STATUS_CHARACTERS))) {
    issues.add('unsafe-field-withheld', field);
    return unavailableField('Authoritative value is unavailable');
  }
  return {
    raw: value,
    label: typeof value === 'boolean'
      ? value ? 'Yes' : 'No'
      : displayLabel(value),
    availability: 'available',
  };
}

function evidenceField(value, field, issues) {
  if (!isRecord(value)) return statusField(value, field, issues);
  if (value.status !== undefined) return statusField(value.status, field, issues);
  if (typeof value.authoritative === 'boolean') {
    return {
      raw: value.authoritative,
      label: value.authoritative ? 'Authoritative' : 'Non-authoritative',
      availability: 'available',
    };
  }
  return unknownField();
}

function unknownField() {
  return { raw: null, label: 'Unknown', availability: 'unknown' };
}

function unavailableField(label) {
  return { raw: null, label, availability: 'unavailable' };
}

function displayLabel(value) {
  const label = value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return label.length === 0 ? 'Unknown' : `${label[0].toUpperCase()}${label.slice(1)}`;
}

function terminalValue(rawStatus, finishedAt, terminalStates) {
  if (typeof rawStatus === 'string' && terminalStates.has(rawStatus)) return true;
  if (finishedAt !== null) return true;
  if (typeof rawStatus === 'string') return false;
  return null;
}

function safeOrigin(value, field, issues) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2_048 || CONTROL_CHARACTERS.test(value) || SECRET_TEXT.test(value)) {
    issues.add('unsafe-field-withheld', field);
    return null;
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('unsafe origin');
    return url.origin;
  } catch {
    issues.add('invalid-field-withheld', field);
    return null;
  }
}

function safeTimestamp(value, field, issues) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64 || CONTROL_CHARACTERS.test(value)
    || !Number.isFinite(Date.parse(value))) {
    issues.add('invalid-field-withheld', field);
    return null;
  }
  return value;
}

function safeInteger(value, field, issues) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    issues.add('invalid-field-withheld', field);
    return null;
  }
  return value;
}

function safeStringList(value, field, issues) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.add('invalid-field-withheld', field);
    return [];
  }
  if (value.length > MAX_LIST_ITEMS) issues.add('list-truncated', field);
  const selected = [];
  for (const item of value.slice(0, MAX_LIST_ITEMS)) {
    if (typeof item !== 'string' || !isExactSafeText(item, MAX_ID_CHARACTERS) || !SAFE_ID.test(item)) {
      issues.add('unsafe-list-item-withheld', field);
      continue;
    }
    selected.push(item);
  }
  return [...new Set(selected)].sort();
}

function safeRelativeHref(value, field, issues) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/')
    || value.startsWith('//') || CONTROL_CHARACTERS.test(value) || SECRET_TEXT.test(value)) {
    issues.add('unsafe-field-withheld', field);
    return null;
  }
  try {
    const parsed = new URL(value, 'http://console.local');
    if (parsed.origin !== 'http://console.local') throw new Error('external URL');
    for (const [key, entry] of parsed.searchParams) {
      if (SECRET_KEY.test(key) || SECRET_TEXT.test(entry)) throw new Error('secret-like URL state');
    }
    return value;
  } catch {
    issues.add('unsafe-field-withheld', field);
    return null;
  }
}

function exactSafeString(value, maximum, field, issues) {
  if (!isExactSafeText(value, maximum)) {
    issues.add('unsafe-field-withheld', field);
    return 'unavailable';
  }
  return value;
}

function nullableExactSafeString(value, maximum, field, issues) {
  if (value === undefined || value === null) return null;
  if (!isExactSafeText(value, maximum)) {
    issues.add('unsafe-field-withheld', field);
    return null;
  }
  return value;
}

function isExactSafeText(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !CONTROL_CHARACTERS.test(value) && !SECRET_TEXT.test(value);
}

function comparativeTitle(production, candidate, runId) {
  if (!production || !candidate) return `Comparative run ${runId}`;
  return `${new URL(production).host} → ${new URL(candidate).host}`;
}

function singleSiteTitle(origin, role, runId) {
  if (!origin) return `Single-site run ${runId}`;
  const roleLabel = typeof role === 'string' ? displayLabel(role) : 'Single-site';
  return `${roleLabel} · ${new URL(origin).host}`;
}

function issueCollector(initial) {
  const entries = [];
  const seen = new Set();
  let detected = false;
  const add = (code, field) => {
    const safeCode = typeof code === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(code) ? code : 'source-limitation';
    const safeField = typeof field === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(field) ? field : 'source';
    const key = `${safeCode}\u0000${safeField}`;
    if (!seen.has(key)) entries.push({ code: safeCode, field: safeField });
    seen.add(key);
    detected = true;
  };
  if (Array.isArray(initial)) {
    for (const code of initial.slice(0, MAX_LIST_ITEMS)) add(code, 'source');
  }
  return {
    add,
    get detected() { return detected; },
    get values() { return entries; },
  };
}

function objectAt(value, key) {
  const result = isRecord(value) ? value[key] : null;
  return isRecord(result) ? result : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
