import { buildConsoleRunSummary } from './console-run.mjs';
import {
  createProductRiskRecord,
  selectComparablePredecessor,
  sortProductRisk,
} from './console-risk.mjs';

const MAX_OVERVIEW_RISK = 50;
const MAX_ACTIVE_RUNS = 20;
const MAX_STATISTICS = 6;
const MAX_TEXT = 240;
const MODES = new Set(['all', 'comparative', 'single-site']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function boundedString(value, maximum = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function isoTimestamp(value) {
  const normalized = boundedString(value, 64);
  if (!normalized) return null;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function clampInteger(value, fallback, maximum) {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(1, value)) : fallback;
}

function stableRunKey(run) {
  return boundedString(run?.identity?.key, 340)
    ?? (boundedString(run?.mode, 20) && boundedString(run?.identity?.runId, 160)
      ? `${run.mode}:${run.identity.runId}`
      : null);
}

function runScopeKey(run) {
  return boundedString(run?.scope?.comparability?.scopeKey, 300)
    ?? boundedString(run?.scope?.qualifier, 200)
    ?? 'unknown';
}

function matchesScope(run, mode, scopeKey) {
  if (!record(run) || !['comparative', 'single-site'].includes(run.mode) || !stableRunKey(run)) return false;
  if (mode !== 'all' && run.mode !== mode) return false;
  return scopeKey === 'all' || runScopeKey(run) === scopeKey;
}

function terminalTimestamp(run) {
  return Date.parse(run?.timestamps?.finishedAt ?? run?.timestamps?.updatedAt ?? run?.timestamps?.createdAt ?? 0) || 0;
}

function latestTerminal(runs) {
  return [...runs]
    .filter((run) => run?.lifecycle?.terminal === true)
    .sort((left, right) => terminalTimestamp(right) - terminalTimestamp(left) || stableRunKey(left).localeCompare(stableRunKey(right)))[0] ?? null;
}

function activeRuns(runs) {
  return [...runs]
    .filter((run) => run?.lifecycle?.terminal !== true)
    .sort((left, right) => terminalTimestamp(right) - terminalTimestamp(left) || stableRunKey(left).localeCompare(stableRunKey(right)));
}

function trustSupport(status) {
  const source = record(status);
  const raw = boundedString(source?.raw, 120);
  const availability = ['available', 'unknown', 'unavailable', 'not-applicable'].includes(source?.availability)
    ? source.availability
    : raw ? 'available' : 'unavailable';
  if (availability !== 'available') return availability;
  if (raw === null) return 'unknown';
  if (/^(?:complete|completed|passed|ready|authoritative|supported|healthy|success)$/iu.test(raw)) return 'supported';
  if (/^(?:partial|limited|warning|pending|running|incomplete|degraded)$/iu.test(raw)) return 'limited';
  if (/^(?:failed|failure|blocked|invalid|unavailable|non-authoritative)$/iu.test(raw)) return 'unavailable';
  return 'unknown';
}

function buildTrustFacts(run) {
  if (!run) return [];
  const labels = [
    ['coverage', 'Coverage'],
    ['evidence', 'Evidence authority'],
    ['pipeline', 'Pipeline integrity'],
    ['finalization', 'Finalization'],
  ];
  return Object.freeze(labels.map(([id, label]) => {
    const status = record(run.authority?.[id]) ?? {};
    return Object.freeze({
      schemaVersion: 1,
      id,
      label,
      raw: boundedString(status.raw, 120),
      displayLabel: boundedString(status.label, 120) ?? 'Unavailable',
      availability: ['available', 'unknown', 'unavailable', 'not-applicable'].includes(status.availability)
        ? status.availability
        : 'unavailable',
      conclusionSupport: trustSupport(status),
      source: Object.freeze({
        runIdentity: stableRunKey(run),
        sourceIdentity: boundedString(run.source?.identity, 160),
        sourceRevision: boundedString(run.source?.revision, 160),
        updatedAt: isoTimestamp(run.source?.updatedAt),
        completeness: ['complete', 'partial', 'unknown', 'unavailable'].includes(run.source?.completeness)
          ? run.source.completeness
          : 'unknown',
      }),
    });
  }));
}

function normalizeMetric(input) {
  const source = record(input);
  if (!source) return null;
  const id = boundedString(source.id, 120);
  const label = boundedString(source.label, 160);
  const population = boundedString(source.population, 240);
  const window = boundedString(source.window, 160);
  const freshness = ['current', 'stale', 'unknown', 'unavailable'].includes(source.freshness) ? source.freshness : null;
  const sourceIdentity = boundedString(source.sourceIdentity, 160);
  const sourceTimestamp = isoTimestamp(source.sourceTimestamp);
  const drilldown = boundedString(source.drilldown, 600);
  const unavailableReason = boundedString(source.unavailableReason, 240);
  const value = typeof source.value === 'number' && Number.isFinite(source.value)
    ? source.value
    : boundedString(source.value, 120);
  if (!id || !label || !population || !window || !freshness || !sourceIdentity) return null;
  if (freshness !== 'unavailable' && (sourceTimestamp === null || value === null)) return null;
  if (freshness === 'unavailable' && !unavailableReason) return null;
  if (drilldown && !/^\/(?!\/)/u.test(drilldown)) return null;
  return Object.freeze({
    schemaVersion: 1,
    id,
    label,
    value: freshness === 'unavailable' ? null : value,
    population,
    window,
    freshness,
    sourceIdentity,
    sourceTimestamp,
    drilldown,
    unavailableReason,
  });
}

function normalizeRisk(input, now) {
  let risk;
  try {
    risk = input?.schemaVersion === 1 && Array.isArray(input?.tuple)
      ? input
      : createProductRiskRecord({
        ...input,
        blockingIntent: input?.blockingIntent ?? input?.blocking,
        unresolvedSince: input?.unresolvedSince ?? input?.unresolvedAt,
        sourceIdentity: input?.sourceIdentity ?? input?.source?.identity,
        sourceTimestamp: input?.sourceTimestamp ?? input?.source?.timestamp,
        sourceComplete: input?.sourceComplete ?? input?.source?.complete,
        href: input?.href ?? input?.source?.href,
      }, { now, hasComparablePredecessor: input?.hasComparablePredecessor === true });
  } catch {
    return null;
  }
  const source = record(risk?.source);
  if (!boundedString(risk?.identity, 200)
    || !boundedString(source?.identity, 200)
    || !isoTimestamp(source?.timestamp)
    || typeof source?.complete !== 'boolean'
    || !boundedString(source?.href, 600)
    || !/^\/(?!\/)/u.test(source.href)) return null;
  return risk;
}

function explicitState(kind, reason, limitations = []) {
  return Object.freeze({
    state: kind,
    reason,
    limitations: Object.freeze(limitations),
  });
}

export function buildConsoleOverview(input = {}, options = {}) {
  const source = record(input) ?? {};
  const mode = MODES.has(source.mode) ? source.mode : 'all';
  const scopeKey = boundedString(source.scopeKey, 300) ?? 'all';
  const now = isoTimestamp(options.now instanceof Date ? options.now.toISOString() : options.now)
    ?? new Date().toISOString();
  const riskLimit = clampInteger(options.riskLimit, 12, MAX_OVERVIEW_RISK);
  const activeLimit = clampInteger(options.activeLimit, 8, MAX_ACTIVE_RUNS);
  const limitations = Array.from(new Set((Array.isArray(source.limitations) ? source.limitations : [])
    .map((value) => boundedString(value, 240)).filter(Boolean))).slice(0, 40);
  const runs = (Array.isArray(source.runs) ? source.runs.slice(0, 20_000) : [])
    .filter((run) => matchesScope(run, mode, scopeKey));
  const current = latestTerminal(runs);
  const predecessor = current ? selectComparablePredecessor(current, runs) : {
    schemaVersion: 1,
    available: false,
    currentRunId: null,
    predecessor: null,
    key: null,
    reason: 'No terminal run is available in the selected scope.',
  };
  const risks = sortProductRisk((Array.isArray(source.attention) ? source.attention.slice(0, 20_000) : [])
    .map((entry) => normalizeRisk(entry, now))
    .filter((entry) => entry && (mode === 'all' || entry.runIdentity?.mode === mode)));
  const shownRisks = risks.slice(0, riskLimit);
  const active = activeRuns(runs);
  const statistics = (Array.isArray(source.statistics) ? source.statistics : [])
    .map(normalizeMetric)
    .filter(Boolean)
    .slice(0, MAX_STATISTICS);

  let overviewState;
  if (runs.length === 0) overviewState = explicitState('empty-success', 'No indexed runs exist in the selected scope.', limitations);
  else if (limitations.length > 0 || runs.some((run) => run?.source?.completeness !== 'complete')) {
    overviewState = explicitState('partial', 'Indexed source coverage is incomplete; available facts retain their source limits.', limitations);
  } else overviewState = explicitState('ready', 'The selected scope is current and complete.', []);

  return Object.freeze({
    schemaVersion: 1,
    generatedAt: now,
    scope: Object.freeze({ mode, scopeKey }),
    state: overviewState,
    productRisk: Object.freeze({
      items: Object.freeze(shownRisks),
      total: risks.length,
      hasMore: shownRisks.length < risks.length,
      state: risks.length === 0
        ? explicitState('empty-success', predecessor.available
          ? 'No current Product Risk records match the selected scope.'
          : 'No Product Risk change claim is available without a valid Comparable Predecessor.', [])
        : explicitState('ready', 'Ranked from explicit Product Risk factors; no aggregate score is used.', []),
    }),
    runTrust: Object.freeze({
      runIdentity: current ? stableRunKey(current) : null,
      facts: buildTrustFacts(current),
      state: current
        ? explicitState('ready', 'Trust facts remain independent from Product Risk.', [])
        : explicitState('unavailable', 'No terminal run is available for trust conclusions.', []),
    }),
    activeRuns: Object.freeze({
      items: Object.freeze(active.slice(0, activeLimit).map((run) => buildConsoleRunSummary(run))),
      total: active.length,
      hasMore: active.length > activeLimit,
    }),
    latestTerminalRun: current ? buildConsoleRunSummary(current) : null,
    comparablePredecessor: predecessor,
    statistics: Object.freeze(statistics),
    provenance: Object.freeze({
      runCount: runs.length,
      attentionCount: risks.length,
      sourceVectorRevision: boundedString(source.sourceVectorRevision, 160),
      completeness: limitations.length === 0 && runs.every((run) => run?.source?.completeness === 'complete') ? 'complete' : 'partial',
      limitations: Object.freeze(limitations),
    }),
  });
}

export function buildConsoleRunsPage(runs, options = {}) {
  const mode = MODES.has(options.mode) ? options.mode : 'all';
  const scopeKey = boundedString(options.scopeKey, 300) ?? 'all';
  const limit = clampInteger(options.limit, 50, 100);
  const offset = Number.isSafeInteger(options.offset) ? Math.max(0, options.offset) : 0;
  const sort = ['recent', 'duration'].includes(options.sort) ? options.sort : 'recent';
  const filtered = (Array.isArray(runs) ? runs.slice(0, 20_000) : [])
    .filter((run) => matchesScope(run, mode, scopeKey))
    .sort((left, right) => {
      if (sort === 'duration') {
        const leftDuration = Math.max(0, Date.parse(left.timestamps?.finishedAt ?? 0) - Date.parse(left.timestamps?.startedAt ?? 0)) || 0;
        const rightDuration = Math.max(0, Date.parse(right.timestamps?.finishedAt ?? 0) - Date.parse(right.timestamps?.startedAt ?? 0)) || 0;
        if (leftDuration !== rightDuration) return rightDuration - leftDuration;
      }
      return terminalTimestamp(right) - terminalTimestamp(left) || stableRunKey(left).localeCompare(stableRunKey(right));
    });
  const items = filtered.slice(offset, offset + limit).map((run) => buildConsoleRunSummary(run));
  return Object.freeze({
    schemaVersion: 1,
    items: Object.freeze(items),
    nextOffset: offset + items.length < filtered.length ? offset + items.length : null,
    hasMore: offset + items.length < filtered.length,
    omittedRecords: Math.max(0, filtered.length - offset - items.length),
    total: filtered.length,
    scope: Object.freeze({ mode, scopeKey, sort }),
  });
}

export const CONSOLE_OVERVIEW_LIMITS = Object.freeze({
  maximumProductRisk: MAX_OVERVIEW_RISK,
  maximumActiveRuns: MAX_ACTIVE_RUNS,
  maximumStatistics: MAX_STATISTICS,
  maximumRunsPage: 100,
});
