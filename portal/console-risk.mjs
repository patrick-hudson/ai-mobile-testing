const SCHEMA_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_CATEGORY = /^[a-z][a-z0-9-]{0,79}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SECRET_TEXT = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{4,}|https?:\/\/[^\s/@:]+:[^\s/@]+@)/i;
const SECRET_KEY = /(?:authorization|cookie|credential|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer)/i;
const MAX_CATEGORIES = 16;
const SEVERITY_PRECEDENCE = new Map([['P0', 0], ['P1', 1], ['P2', 2], ['P3', 3]]);
const SOURCE_PRECEDENCE = new Map([
  ['finding', 0],
  ['visual-review', 1],
  ['manual-obligation', 2],
]);
const NOVELTY_PRECEDENCE = new Map([
  ['new', 0],
  ['regressed', 0],
  ['introduced', 0],
  ['worsened', 1],
  ['persistent', 2],
  ['existing', 2],
  ['unchanged', 2],
  ['improved', 3],
  ['resolved', 3],
]);
const INCOMPLETE_FINALIZATION_STATES = new Set(['pending', 'incomplete', 'invalid', 'deadline-exceeded']);
const INCOMPLETE_EXECUTION_STATES = new Set(['incomplete']);

export function buildComparablePredecessorKey(run) {
  assertNormalizedRun(run);
  const factors = {
    mode: factorValue('mode', run.mode, true, `Audit mode is ${run.mode}.`),
    deployment: comparabilityFactor('deployment', run.scope.comparability.deploymentKey),
    profile: comparabilityFactor('profile', run.scope.comparability.profileKey),
    scope: comparabilityFactor('scope', run.scope.comparability.scopeKey),
    targetSet: comparabilityFactor('target-set', run.scope.comparability.targetSetKey),
  };
  const reasons = [];
  if (run.lifecycle.terminal !== true) reasons.push('run-is-active');
  if (run.source.completeness !== 'complete') reasons.push('source-is-incomplete');
  if (run.source.freshness !== 'current') reasons.push('source-is-not-current');
  if (INCOMPLETE_EXECUTION_STATES.has(run.lifecycle.execution.raw)) reasons.push('execution-is-incomplete');
  if (INCOMPLETE_FINALIZATION_STATES.has(run.authority.finalization.raw)) reasons.push('finalization-is-incomplete');
  for (const [name, factor] of Object.entries(factors)) {
    if (!factor.available) reasons.push(`${camelToKebab(name)}-is-unavailable`);
  }
  const eligible = reasons.length === 0;
  const key = eligible ? JSON.stringify([
    factors.mode.value,
    factors.deployment.value,
    factors.profile.value,
    factors.scope.value,
    factors.targetSet.value,
  ]) : null;
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    eligible,
    key,
    factors,
    reasons: [...new Set(reasons)],
  });
}

export function selectComparablePredecessor(currentRun, candidates) {
  assertNormalizedRun(currentRun);
  if (!Array.isArray(candidates)) throw new TypeError('Comparable predecessor candidates must be an array.');
  const current = buildComparablePredecessorKey(currentRun);
  if (!current.eligible) {
    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      available: false,
      currentRunId: currentRun.identity.runId,
      predecessor: null,
      key: null,
      reason: 'current-run-ineligible',
      limitations: current.reasons,
    });
  }
  const currentBoundary = comparisonBoundary(currentRun);
  const matches = [];
  for (const candidate of candidates) {
    assertNormalizedRun(candidate);
    if (candidate.identity.key === currentRun.identity.key) continue;
    const comparable = buildComparablePredecessorKey(candidate);
    if (!comparable.eligible || comparable.key !== current.key) continue;
    const finishedAt = timestampValue(candidate.timestamps.finishedAt);
    if (finishedAt === null || (currentBoundary !== null && finishedAt >= currentBoundary)) continue;
    matches.push({ candidate, finishedAt });
  }
  matches.sort((left, right) => right.finishedAt - left.finishedAt
    || left.candidate.identity.key.localeCompare(right.candidate.identity.key));
  const predecessor = matches[0]?.candidate ?? null;
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    available: predecessor !== null,
    currentRunId: currentRun.identity.runId,
    predecessor,
    key: current.key,
    reason: predecessor ? 'matched' : 'no-compatible-history',
    limitations: predecessor ? [] : ['no-comparable-predecessor'],
  });
}

export function createProductRiskRecord(input, options = {}) {
  if (!isRecord(input)) throw new TypeError('Product Risk input must be an object.');
  const identity = requiredIdentifier(input.identity, 'Product Risk identity');
  const runIdentity = normalizeRunIdentity(input.runIdentity);
  const sourceType = safeCategory(input.sourceType, 'Product Risk source type');
  const sourcePrecedence = SOURCE_PRECEDENCE.get(sourceType);
  if (sourcePrecedence === undefined) {
    throw new TypeError('Product Risk source type must be finding, visual-review, or manual-obligation.');
  }
  const categories = normalizeCategories(input.categories, sourceType);
  const severitySupplied = input.severity !== undefined && input.severity !== null && input.severity !== '';
  const severityRaw = safeOptionalText(input.severity, 16);
  const severityKnown = SEVERITY_PRECEDENCE.has(severityRaw);
  const severity = {
    raw: severityRaw,
    availability: severityKnown ? 'known' : severitySupplied ? 'unavailable' : 'unknown',
    precedence: severityKnown ? SEVERITY_PRECEDENCE.get(severityRaw) : 4,
    reason: severityKnown ? `Declared severity is ${severityRaw}.` : 'Declared severity is unavailable.',
  };
  const blockingIntent = normalizeBlockingIntent(input.blockingIntent);
  const sourceAuthority = {
    raw: sourceType,
    availability: 'known',
    precedence: sourcePrecedence,
    reason: sourceType === 'finding'
      ? 'Canonical Finding authority precedes review-only and manual-attention records.'
      : sourceType === 'visual-review'
        ? 'Unresolved visual review follows canonical Findings and precedes manual obligations.'
        : 'Manual obligations follow canonical Findings and unresolved visual review.',
  };
  const hasComparablePredecessor = options.hasComparablePredecessor === true;
  const novelty = normalizeNovelty(input.novelty, hasComparablePredecessor);
  const affectedScope = normalizeAffectedScope(input.affectedScope);
  const unresolvedAge = normalizeUnresolvedAge(input.unresolvedSince, options.now);
  const stableIdentity = {
    raw: identity,
    availability: 'known',
    reason: `Stable identity ${identity} breaks otherwise equal tuples.`,
  };
  const sourceIdentity = requiredIdentifier(input.sourceIdentity ?? identity, 'Product Risk source identity');
  const sourceTimestamp = safeTimestamp(input.sourceTimestamp);
  const href = safeHref(input.href);
  const sourceComplete = input.sourceComplete === true;
  const factors = {
    severity,
    blockingIntent,
    sourceAuthority,
    novelty,
    affectedScope,
    unresolvedAge,
    stableIdentity,
  };
  const tuple = [
    namedFactor('severity', severity.raw, severity.availability, severity.reason),
    namedFactor('blocking-intent', blockingIntent.raw, blockingIntent.availability, blockingIntent.reason),
    namedFactor('source-authority', sourceAuthority.raw, sourceAuthority.availability, sourceAuthority.reason),
    namedFactor('novelty', novelty.raw, novelty.availability, novelty.reason),
    namedFactor('affected-scope', affectedScope.raw, affectedScope.availability, affectedScope.reason),
    namedFactor('unresolved-age', unresolvedAge.since, unresolvedAge.availability, unresolvedAge.reason),
    namedFactor('stable-identity', identity, 'known', stableIdentity.reason),
  ];
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    identity,
    runIdentity,
    sourceType,
    categories,
    source: {
      identity: sourceIdentity,
      timestamp: sourceTimestamp,
      complete: sourceComplete,
      href,
    },
    factors,
    tuple,
    reasons: tuple.map(({ reason }) => reason),
  });
}

export function compareProductRisk(left, right) {
  assertProductRiskRecord(left);
  assertProductRiskRecord(right);
  return compareAscending(left.factors.severity.precedence, right.factors.severity.precedence)
    || compareAscending(left.factors.blockingIntent.precedence, right.factors.blockingIntent.precedence)
    || compareAscending(left.factors.sourceAuthority.precedence, right.factors.sourceAuthority.precedence)
    || compareAscending(left.factors.novelty.precedence, right.factors.novelty.precedence)
    || compareKnownDescending(left.factors.affectedScope, right.factors.affectedScope)
    || compareKnownOldest(left.factors.unresolvedAge, right.factors.unresolvedAge)
    || left.identity.localeCompare(right.identity);
}

export function sortProductRisk(records) {
  if (!Array.isArray(records)) throw new TypeError('Product Risk records must be an array.');
  return Object.freeze([...records].sort(compareProductRisk));
}

function assertNormalizedRun(run) {
  if (!isRecord(run) || run.schemaVersion !== 1 || !['comparative', 'single-site'].includes(run.mode)
    || !isRecord(run.identity) || !isRecord(run.source) || !isRecord(run.lifecycle)
    || !isRecord(run.authority) || !isRecord(run.scope) || !isRecord(run.scope.comparability)
    || !isRecord(run.timestamps)) {
    throw new TypeError('Comparable predecessor input must be a normalized console run.');
  }
}

function assertProductRiskRecord(record) {
  if (!isRecord(record) || record.schemaVersion !== 1 || !isRecord(record.factors)
    || typeof record.identity !== 'string') {
    throw new TypeError('Product Risk comparator requires normalized Product Risk records.');
  }
}

function factorValue(name, value, available, reason) {
  return { name, value, available, reason };
}

function comparabilityFactor(name, value) {
  const available = typeof value === 'string' && value.length > 0 && value.length <= 4_096
    && !CONTROL_CHARACTERS.test(value) && !SECRET_TEXT.test(value);
  return factorValue(
    name,
    available ? value : null,
    available,
    available ? `${name} compatibility key is available.` : `${name} compatibility key is unavailable.`,
  );
}

function comparisonBoundary(run) {
  return timestampValue(run.timestamps.finishedAt)
    ?? timestampValue(run.timestamps.createdAt)
    ?? timestampValue(run.timestamps.updatedAt);
}

function timestampValue(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeRunIdentity(value) {
  if (!isRecord(value) || !['comparative', 'single-site'].includes(value.mode)) {
    throw new TypeError('Product Risk run identity must declare comparative or single-site mode.');
  }
  const runId = requiredIdentifier(value.runId, 'Product Risk run ID');
  return {
    mode: value.mode,
    runId,
    key: typeof value.key === 'string' && value.key === `${value.mode}:${runId}`
      ? value.key
      : `${value.mode}:${runId}`,
  };
}

function normalizeCategories(value, sourceType) {
  const values = value === undefined ? [] : value;
  if (!Array.isArray(values) || values.length > MAX_CATEGORIES) {
    throw new TypeError(`Product Risk categories must contain at most ${MAX_CATEGORIES} values.`);
  }
  const categories = values.map((category) => safeCategory(category, 'Product Risk category'));
  return [...new Set([sourceType, ...categories])].sort();
}

function normalizeBlockingIntent(value) {
  if (value === true || value === 'blocking') {
    return { raw: value, availability: 'known', precedence: 0, reason: 'The source declares release-blocking intent.' };
  }
  if (value === false || value === 'non-blocking') {
    return { raw: value, availability: 'known', precedence: 1, reason: 'The source declares non-blocking intent.' };
  }
  return { raw: null, availability: 'unknown', precedence: 2, reason: 'Blocking intent is unknown.' };
}

function normalizeNovelty(value, hasComparablePredecessor) {
  if (!hasComparablePredecessor) {
    return {
      raw: null,
      availability: 'unavailable',
      precedence: 4,
      comparablePredecessor: false,
      reason: 'Novelty is unavailable because no Comparable Predecessor was established.',
    };
  }
  const supplied = value !== undefined && value !== null && value !== '';
  const raw = safeOptionalText(value, 40);
  const precedence = NOVELTY_PRECEDENCE.get(raw);
  return {
    raw,
    availability: precedence === undefined ? supplied ? 'unavailable' : 'unknown' : 'known',
    precedence: precedence ?? 4,
    comparablePredecessor: true,
    reason: precedence === undefined
      ? supplied
        ? 'Novelty is unavailable for the established Comparable Predecessor.'
        : 'Novelty is unknown for the established Comparable Predecessor.'
      : `Novelty relative to the Comparable Predecessor is ${raw}.`,
  };
}

function normalizeAffectedScope(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) {
    return {
      raw: value,
      availability: 'known',
      reason: `Affected scope contains ${value} record${value === 1 ? '' : 's'}.`,
    };
  }
  return {
    raw: null,
    availability: value === undefined || value === null ? 'unknown' : 'unavailable',
    reason: value === undefined || value === null ? 'Affected scope is unknown.' : 'Affected scope is unavailable.',
  };
}

function normalizeUnresolvedAge(value, nowValue) {
  const since = safeTimestamp(value);
  const sinceMs = timestampValue(since);
  const nowMs = normalizeNow(nowValue);
  if (sinceMs === null) {
    const missing = value === undefined || value === null || value === '';
    return {
      since: null,
      ageMs: null,
      availability: missing ? 'unknown' : 'unavailable',
      reason: missing ? 'Unresolved age is unknown.' : 'Unresolved age is unavailable.',
    };
  }
  const ageMs = nowMs === null ? null : Math.max(0, nowMs - sinceMs);
  return {
    since,
    ageMs,
    availability: 'known',
    reason: ageMs === null
      ? `The record has been unresolved since ${since}.`
      : `The record has been unresolved for ${ageMs} milliseconds since ${since}.`,
  };
}

function normalizeNow(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return timestampValue(value);
}

function namedFactor(name, value, availability, reason) {
  return { name, value, availability, reason };
}

function compareAscending(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareKnownDescending(left, right) {
  const leftKnown = left.availability === 'known';
  const rightKnown = right.availability === 'known';
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (!leftKnown) return 0;
  return right.raw - left.raw;
}

function compareKnownOldest(left, right) {
  const leftKnown = left.availability === 'known';
  const rightKnown = right.availability === 'known';
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (!leftKnown) return 0;
  return timestampValue(left.since) - timestampValue(right.since);
}

function requiredIdentifier(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${label} must be a safe bounded identifier.`);
  return value;
}

function safeCategory(value, label) {
  if (typeof value !== 'string' || !SAFE_CATEGORY.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function safeOptionalText(value, maximum) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && value.length <= maximum
    && !CONTROL_CHARACTERS.test(value) && !SECRET_TEXT.test(value) ? value : null;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64 || CONTROL_CHARACTERS.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function safeHref(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || value.startsWith('//')
    || CONTROL_CHARACTERS.test(value) || SECRET_TEXT.test(value)) return null;
  try {
    const parsed = new URL(value, 'http://console.local');
    if (parsed.origin !== 'http://console.local') return null;
    for (const [key, entry] of parsed.searchParams) {
      if (SECRET_KEY.test(key) || SECRET_TEXT.test(entry)) return null;
    }
    return value;
  } catch {
    return null;
  }
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
