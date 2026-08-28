const MAX_PAGE_SIZE = 100;
const MAX_TEXT = 240;
const MAX_ID = 160;
const MAX_CURSOR_BYTES = 1_024;
const TIMELINE_KINDS = new Set(['stage', 'shard', 'attempt', 'retry', 'event', 'publication', 'deadline']);
const MODES = new Set(['comparative', 'single-site']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function boundedString(value, maximum = MAX_TEXT) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function safeId(value) {
  const normalized = boundedString(value, MAX_ID);
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(normalized) ? normalized : null;
}

function timestamp(value) {
  const normalized = boundedString(value, 64);
  if (!normalized) return null;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function nonNegativeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function durationBetween(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

function statusField(value) {
  const source = record(value);
  if (!source) return { raw: null, label: 'Unavailable', availability: 'unavailable' };
  const raw = boundedString(source.raw, 120);
  const label = boundedString(source.label, 120);
  const availability = ['available', 'unknown', 'unavailable', 'not-applicable'].includes(source.availability)
    ? source.availability
    : raw === null ? 'unavailable' : 'available';
  return {
    raw,
    label: label ?? raw ?? 'Unavailable',
    availability,
  };
}

function progressProjection(value) {
  const source = record(value);
  if (!source) return null;
  const result = {};
  for (const key of ['total', 'completed', 'passed', 'failed', 'flaky', 'skipped']) {
    const count = nonNegativeInteger(source[key], 10_000_000);
    if (count !== null) result[key] = count;
  }
  for (const key of ['currentStage', 'currentShard']) {
    const text = boundedString(source[key], 120);
    if (text !== null) result[key] = text;
  }
  return Object.freeze(result);
}

function destinationProjection(value) {
  const source = record(value);
  const result = {};
  if (!source) return Object.freeze(result);
  for (const key of ['workspace', 'self', 'report', 'gallery', 'checklist', 'sourceReport', 'artifacts']) {
    if (source[key] === false || source[key] === null) {
      result[key] = null;
      continue;
    }
    const href = boundedString(source[key], 600);
    if (href && /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]*$/u.test(href)) result[key] = href;
  }
  return Object.freeze(result);
}

function limitationText(value) {
  const direct = boundedString(value, 240);
  if (direct) return direct;
  const source = record(value);
  const code = boundedString(source?.code, 80);
  const field = boundedString(source?.field, 160);
  return code ? `${code}${field ? `:${field}` : ''}` : null;
}

function stableIdentity(mode, runId, parts) {
  return [mode, runId, ...parts.map((part) => part ?? '-')].join(':');
}

function normalizeTimelineRecord(input, fallback = {}) {
  const source = record(input);
  if (!source) return null;
  const mode = MODES.has(source.mode) ? source.mode : fallback.mode;
  const runId = safeId(source.runId ?? fallback.runId);
  const kind = TIMELINE_KINDS.has(source.kind) ? source.kind : fallback.kind;
  if (!MODES.has(mode) || !runId || !TIMELINE_KINDS.has(kind)) return null;

  const stageId = safeId(source.stageId);
  const shardId = safeId(source.shardId);
  const attempt = nonNegativeInteger(source.attempt, 10_000);
  const retry = nonNegativeInteger(source.retry, 10_000);
  const sequence = nonNegativeInteger(source.sequence, 10_000_000);
  const startedAt = timestamp(source.startedAt ?? source.at);
  const finishedAt = timestamp(source.finishedAt);
  const explicitDuration = nonNegativeInteger(source.durationMs, 365 * 24 * 60 * 60 * 1_000);
  const status = boundedString(source.status, 120) ?? 'unknown';
  const identity = safeId(source.identity)
    ?? stableIdentity(mode, runId, [kind, stageId, shardId, attempt, retry, sequence, startedAt]);

  return Object.freeze({
    schemaVersion: 1,
    identity,
    mode,
    runId,
    kind,
    stageId,
    shardId,
    attempt,
    retry,
    sequence,
    status,
    startedAt,
    finishedAt,
    durationMs: explicitDuration ?? durationBetween(startedAt, finishedAt),
    sourceRevision: boundedString(source.sourceRevision, 160),
  });
}

function chronology(left, right) {
  const leftTime = Date.parse(left.startedAt ?? left.finishedAt ?? 0) || 0;
  const rightTime = Date.parse(right.startedAt ?? right.finishedAt ?? 0) || 0;
  return leftTime - rightTime
    || (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
    || left.identity.localeCompare(right.identity);
}

function cursorPayload(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  if (typeof cursor !== 'string' || Buffer.byteLength(cursor) > MAX_CURSOR_BYTES) throw new TypeError('Timeline cursor is invalid.');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('Timeline cursor is invalid.');
  }
  if (!record(parsed)
    || Object.keys(parsed).sort().join(',') !== 'binding,offset,schemaVersion'
    || parsed.schemaVersion !== 1
    || !Number.isSafeInteger(parsed.offset)
    || parsed.offset < 0
    || typeof parsed.binding !== 'string') {
    throw new TypeError('Timeline cursor is invalid.');
  }
  return parsed;
}

function encodeCursor(offset, binding) {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, offset, binding }), 'utf8').toString('base64url');
}

export function projectComparativeTimeline(runId, document, options = {}) {
  const id = safeId(runId);
  const source = record(document);
  if (!id || !source) return [];
  const stages = Array.isArray(source.stages) ? source.stages.slice(0, 1_000) : [];
  return stages.flatMap((stage, index) => {
    const value = record(stage);
    if (!value) return [];
    const stageId = safeId(value.stageId ?? value.id);
    if (!stageId || !/^(?:[A-Za-z][A-Za-z0-9._:-]{0,79}|shard[1-9][0-9]{0,2})$/u.test(stageId)) return [];
    const shardMatch = stageId.match(/^shard([1-9][0-9]{0,2})$/u);
    const entry = normalizeTimelineRecord({
      mode: 'comparative',
      runId: id,
      kind: shardMatch ? 'shard' : 'stage',
      identity: `${id}-stage-${index}-${stageId}`,
      stageId,
      shardId: shardMatch ? stageId : null,
      attempt: value.attempt,
      retry: value.retry,
      status: value.status,
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      durationMs: value.durationMs,
      sourceRevision: options.sourceRevision,
    });
    return entry ? [entry] : [];
  }).sort(chronology);
}

export function projectSingleSiteTimeline(runId, document, options = {}) {
  const id = safeId(runId);
  const source = record(document);
  if (!id || !source) return [];
  const result = [];
  for (const event of (Array.isArray(source.events) ? source.events.slice(0, 10_000) : [])) {
    const value = record(event);
    if (!value) continue;
    const entry = normalizeTimelineRecord({
      mode: 'single-site',
      runId: id,
      kind: value.type === 'retry-scheduled' ? 'retry' : value.type === 'claimed' ? 'attempt' : 'event',
      identity: `${id}-event-${value.sequence ?? result.length}`,
      attempt: value.attemptNumber,
      retry: value.infrastructureRetriesUsed,
      sequence: value.sequence,
      status: value.executionState,
      at: value.at,
      sourceRevision: options.sourceRevision,
    });
    if (entry) result.push(entry);
  }
  for (const [stageId, at] of Object.entries(record(source.stageDeadlines) ?? {}).slice(0, 12)) {
    if (!['inventory', 'browser', 'finalizer'].includes(stageId)) continue;
    const entry = normalizeTimelineRecord({
      mode: 'single-site', runId: id, kind: 'deadline', identity: `${id}-deadline-${stageId}`,
      stageId, status: 'deadline', at, sourceRevision: options.sourceRevision,
    });
    if (entry) result.push(entry);
  }
  for (const publication of (Array.isArray(source.publications) ? source.publications.slice(0, 1_000) : [])) {
    const value = record(publication);
    if (!value) continue;
    const publicationId = safeId(value.publicationId);
    if (!publicationId) continue;
    const entry = normalizeTimelineRecord({
      mode: 'single-site', runId: id, kind: 'publication', identity: `${id}-publication-${publicationId}`,
      stageId: publicationId, attempt: value.attemptNumber, sequence: value.sequence,
      status: 'published', at: value.publishedAt, sourceRevision: options.sourceRevision,
    });
    if (entry) result.push(entry);
  }
  return result.sort(chronology);
}

export function buildConsoleTimelinePage(records, options = {}) {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, nonNegativeInteger(options.limit, MAX_PAGE_SIZE) ?? 50));
  const binding = boundedString(options.binding, 512) ?? 'unbound';
  const parsedCursor = cursorPayload(options.cursor);
  if (parsedCursor && parsedCursor.binding !== binding) throw new TypeError('Timeline cursor does not match the current query or source revision.');
  const normalized = (Array.isArray(records) ? records.slice(0, 20_000) : [])
    .map((entry) => normalizeTimelineRecord(entry))
    .filter(Boolean)
    .sort(chronology);
  const offset = parsedCursor?.offset ?? 0;
  if (offset > normalized.length) throw new TypeError('Timeline cursor is outside the available page range.');
  const items = normalized.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return Object.freeze({
    schemaVersion: 1,
    items: Object.freeze(items),
    nextCursor: nextOffset < normalized.length ? encodeCursor(nextOffset, binding) : null,
    hasMore: nextOffset < normalized.length,
    omittedRecords: Math.max(0, normalized.length - nextOffset),
    binding,
  });
}

export function buildConsoleRunSummary(run, options = {}) {
  const source = record(run);
  const identity = record(source?.identity);
  const mode = MODES.has(source?.mode) ? source.mode : identity?.mode;
  const runId = safeId(identity?.runId ?? source?.runId);
  if (!MODES.has(mode) || !runId) throw new TypeError('A normalized comparative or Single-site run is required.');
  const lifecycle = record(source.lifecycle) ?? {};
  const authority = record(source.authority) ?? {};
  const scope = record(source.scope) ?? {};
  const timestamps = record(source.timestamps) ?? {};
  return Object.freeze({
    schemaVersion: 1,
    identity: Object.freeze({ mode, runId, key: `${mode}:${runId}` }),
    title: boundedString(source.title, 200) ?? runId,
    source: Object.freeze({
      type: boundedString(source.source?.type, 120),
      identity: boundedString(source.source?.identity, 160),
      revision: boundedString(source.source?.revision, 160),
      updatedAt: timestamp(source.source?.updatedAt),
      completeness: ['complete', 'partial', 'unknown', 'unavailable'].includes(source.source?.completeness) ? source.source.completeness : 'unknown',
      freshness: ['current', 'stale', 'unknown'].includes(source.source?.freshness) ? source.source.freshness : 'unknown',
    }),
    lifecycle: Object.freeze({
      execution: statusField(lifecycle.execution),
      activity: statusField(lifecycle.activity),
      phase: statusField(lifecycle.phase),
      terminal: lifecycle.terminal === true,
    }),
    authority: Object.freeze({
      outcome: statusField(authority.outcome),
      coverage: statusField(authority.coverage),
      evidence: statusField(authority.evidence),
      pipeline: statusField(authority.pipeline),
      finalization: statusField(authority.finalization),
    }),
    scope: Object.freeze({
      qualifier: boundedString(scope.qualifier, 200),
      profile: boundedString(scope.profile, 120),
      deployment: boundedString(scope.deployment, 240),
      targetCount: Array.isArray(scope.targetIds) ? Math.min(scope.targetIds.length, 10_000) : null,
    }),
    timestamps: Object.freeze({
      createdAt: timestamp(timestamps.createdAt),
      startedAt: timestamp(timestamps.startedAt),
      updatedAt: timestamp(timestamps.updatedAt),
      finishedAt: timestamp(timestamps.finishedAt),
      durationMs: durationBetween(timestamp(timestamps.startedAt), timestamp(timestamps.finishedAt)),
    }),
    progress: progressProjection(source.progress),
    destinations: destinationProjection(source.destinations),
    limitations: Object.freeze(Array.from(new Set([
      ...(Array.isArray(source.limitations) ? source.limitations : []),
      ...(Array.isArray(options.limitations) ? options.limitations : []),
    ].map(limitationText).filter(Boolean))).slice(0, 40)),
  });
}

export const CONSOLE_TIMELINE_MAX_PAGE_SIZE = MAX_PAGE_SIZE;
