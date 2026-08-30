import { createHash } from 'node:crypto';

export const CONSOLE_INDEX_SCHEMA_VERSION = 1;
export const CONSOLE_INDEX_MAX_PAGE_SIZE = 100;
export const CONSOLE_INDEX_MAX_REPLACEMENT_BATCH_RECORDS = 100;
export const CONSOLE_INDEX_MAX_REPLACEMENT_RECORDS = 10_000;
export const CONSOLE_INDEX_ORDERINGS = Object.freeze([
  'index', 'attention', 'recent', 'newest', 'capture-time', 'oldest',
  'duration', 'suite', 'risk', 'sequence', 'source',
]);
export const DEFAULT_CONSOLE_INDEX_BUDGET = Object.freeze({
  maxRecords: 100,
  maxSourceFiles: 32,
  maxSourceBytes: 2 * 1024 * 1024,
  maxElapsedMs: 100,
});

export const CONSOLE_INDEX_RECORD_TYPES = Object.freeze([
  'run',
  'risk',
  'trust',
  'attention',
  'evidence',
  'metric',
  'timeline',
  'provenance',
]);

export const CONSOLE_INDEX_FIELD_NAMES = Object.freeze([
  'title', 'subtitle', 'detail', 'status', 'phase', 'outcome', 'authority',
  'qualifier', 'profile', 'productionOrigin', 'candidateOrigin', 'auditedOrigin',
  'deploymentRole', 'certificatePolicy', 'targetSetKey', 'scopeLabel',
  'createdAt', 'startedAt', 'finishedAt', 'updatedAt', 'sourceKind', 'sourceTimestamp',
  'sourceRecordId', 'sourceRecordType', 'publicationRevision', 'finalizationRevision',
  'severity', 'blocking', 'attentionKind', 'novelty', 'affectedScope', 'unresolvedAt',
  'auditId', 'evidenceId', 'targetId', 'stageId', 'shardId',
  'executionState', 'activityState', 'finalizationStatus', 'coverageStatus',
  'evidenceCompletionStatus', 'evidenceAuthorityStatus', 'pipelineIntegrityStatus',
  'manualStatus', 'visualStatus', 'mediaQualityState',
  'progressTotal', 'progressCompleted', 'progressPassed', 'progressFailed',
  'progressFlaky', 'progressSkipped', 'findingCount', 'blockingFailures',
  'blockingIncomplete', 'baselineIssues', 'manualRequired', 'manualComplete',
  'manualOutstanding', 'manualFailedOrBlocked', 'visualTotal', 'visualAttentionRequired',
  'attemptNumber', 'retryNumber', 'durationMs', 'sequence', 'terminal',
  'publicationBlocked', 'deadlineExceeded', 'targetIds', 'pluginIds', 'auditIds',
  'areas', 'reasonCodes', 'destinations', 'limitations',
]);

const MODES = new Set(['comparative', 'single-site']);
const RECORD_TYPES = new Set(CONSOLE_INDEX_RECORD_TYPES);
const ORDERINGS = new Set(CONSOLE_INDEX_ORDERINGS);
const FIELD_NAMES = new Set(CONSOLE_INDEX_FIELD_NAMES);
const LIMITATION_CODES = new Set([
  'source-unavailable', 'source-malformed', 'source-stale', 'budget-exhausted',
  'incomplete-publication', 'purged', 'permission-denied', 'unsupported',
]);
const ORIGIN_FIELDS = new Set(['productionOrigin', 'candidateOrigin', 'auditedOrigin']);
const TIMESTAMP_FIELDS = new Set([
  'createdAt', 'startedAt', 'finishedAt', 'updatedAt', 'sourceTimestamp', 'unresolvedAt',
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const CONTROL_TEXT = /[\u0000-\u001f\u007f]/;
const SECRET_TEXT = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|secret)\s*[=:]\s*[^\s,;]{8,})/i;
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const MAX_FIELD_TEXT = 1_200;
const MAX_FIELD_LIST = 64;
const MAX_CURSOR_BYTES = 4_096;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_ORDERED_PARTITIONS = 512;

export class ConsoleIndexError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ConsoleIndexError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode = 400) {
  throw new ConsoleIndexError(code, message, statusCode);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) fail('CONSOLE_INDEX_INVALID', `${label} must be a plain object.`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    fail(
      'CONSOLE_INDEX_INVALID',
      `${label} has unsupported or missing fields.${unknown.length ? ` Unsupported: ${unknown.sort().join(', ')}.` : ''}${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}`,
    );
  }
}

function safeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('CONSOLE_INDEX_INVALID', `${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function safeText(value, label, maximum = MAX_FIELD_TEXT, { identifier = false, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || CONTROL_TEXT.test(value) || SECRET_TEXT.test(value) || (identifier && !SAFE_ID.test(value))) {
    fail('CONSOLE_INDEX_HOSTILE_VALUE', `${label} is invalid, oversized, or secret-like.`);
  }
  return value;
}

function canonicalTimestamp(value, label, nullable = true) {
  if (nullable && value === null) return null;
  safeText(value, label, 64);
  try {
    if (new Date(value).toISOString() !== value) throw new Error('non-canonical');
  } catch {
    fail('CONSOLE_INDEX_INVALID', `${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function sortableTimestamp(value, { inverted = false } = {}) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const safe = Number.isFinite(parsed) ? Math.max(0, Math.min(MAX_DATE_MS, parsed)) : inverted ? 0 : MAX_DATE_MS;
  return String(inverted ? MAX_DATE_MS - safe : safe).padStart(16, '0');
}

function sortableNumber(value, { inverted = false } = {}) {
  const safe = Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(value))
    : inverted ? 0 : Number.MAX_SAFE_INTEGER;
  return String(inverted ? Number.MAX_SAFE_INTEGER - safe : safe).padStart(16, '0');
}

function suiteKey(record) {
  const values = ['areas', 'targetIds', 'pluginIds', 'auditIds', 'auditId', 'targetId', 'subtitle']
    .flatMap((field) => Array.isArray(record.fields[field]) ? record.fields[field] : [record.fields[field]])
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort();
  return values[0] ?? '~';
}

/** Stable seek key used by the in-memory summary index and API merge pagination. */
export function consoleIndexOrderKey(record, ordering = 'index') {
  if (!ORDERINGS.has(ordering)) fail('CONSOLE_INDEX_INVALID', 'Console index ordering is unsupported.');
  const identity = `${record.mode}\u241f${record.runId}\u241f${record.recordId}`;
  const fields = record.fields;
  let primary;
  if (['recent', 'newest', 'capture-time'].includes(ordering)) {
    primary = sortableTimestamp(fields.finishedAt ?? fields.sourceTimestamp ?? fields.updatedAt ?? record.sourceUpdatedAt, { inverted: true });
  } else if (ordering === 'oldest') {
    primary = sortableTimestamp(fields.unresolvedAt ?? fields.sourceTimestamp ?? fields.updatedAt ?? record.sourceUpdatedAt);
  } else if (ordering === 'duration') {
    primary = sortableNumber(fields.durationMs, { inverted: true });
  } else if (ordering === 'suite') {
    primary = suiteKey(record);
  } else if (ordering === 'risk' && record.recordType === 'run') {
    primary = [
      sortableNumber(fields.blockingFailures, { inverted: true }),
      sortableNumber(fields.blockingIncomplete, { inverted: true }),
      sortableNumber(fields.findingCount, { inverted: true }),
      sortableTimestamp(fields.finishedAt ?? fields.updatedAt ?? record.sourceUpdatedAt, { inverted: true }),
    ].join(':');
  } else {
    primary = record.sortKey;
  }
  return `${primary}\u241f${record.sortKey}\u241f${identity}`;
}

function normalizedOrigin(value, label) {
  safeText(value, label, 2_048);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('CONSOLE_INDEX_HOSTILE_VALUE', `${label} must be an HTTP(S) origin.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) {
    fail('CONSOLE_INDEX_HOSTILE_VALUE', `${label} must be an exact credential-free HTTP(S) origin.`);
  }
  return parsed.origin;
}

function safeFieldScalar(field, value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      fail('CONSOLE_INDEX_HOSTILE_VALUE', `fields.${field} contains an unsafe number.`);
    }
    return value;
  }
  if (typeof value !== 'string') {
    fail('CONSOLE_INDEX_INVALID', `fields.${field} must be a scalar or a bounded scalar list.`);
  }
  if (ORIGIN_FIELDS.has(field)) return normalizedOrigin(value, `fields.${field}`);
  if (TIMESTAMP_FIELDS.has(field)) return canonicalTimestamp(value, `fields.${field}`, false);
  safeText(value, `fields.${field}`);
  if (ABSOLUTE_URL.test(value)) {
    fail('CONSOLE_INDEX_HOSTILE_VALUE', `fields.${field} cannot contain an unchecked absolute URL.`);
  }
  return value;
}

function safeFields(value) {
  if (!isRecord(value)) fail('CONSOLE_INDEX_INVALID', 'fields must be a plain object.');
  const keys = Object.keys(value);
  const unsupported = keys.filter((key) => !FIELD_NAMES.has(key));
  if (unsupported.length) {
    fail('CONSOLE_INDEX_INVALID', `fields contains unsupported fields: ${unsupported.sort().join(', ')}.`);
  }
  const output = {};
  for (const key of keys.sort()) {
    const item = value[key];
    if (Array.isArray(item)) {
      if (item.length > MAX_FIELD_LIST) {
        fail('CONSOLE_INDEX_HOSTILE_VALUE', `fields.${key} exceeds its ${MAX_FIELD_LIST}-item bound.`);
      }
      output[key] = Object.freeze(item.map((entry) => safeFieldScalar(key, entry)));
    } else {
      output[key] = safeFieldScalar(key, item);
    }
  }
  return Object.freeze(output);
}

function safeMode(value) {
  if (!MODES.has(value)) fail('CONSOLE_INDEX_INVALID', 'mode must be comparative or single-site.');
  return value;
}

function validateRecord(value) {
  exactKeys(value, [
    'schemaVersion', 'mode', 'runId', 'recordId', 'recordType', 'scopeKey', 'sourceId',
    'sourceRevision', 'sourceUpdatedAt', 'complete', 'sortKey', 'fields',
  ], 'console index record');
  if (value.schemaVersion !== CONSOLE_INDEX_SCHEMA_VERSION) {
    fail('CONSOLE_INDEX_INVALID', `console index record schemaVersion must be ${CONSOLE_INDEX_SCHEMA_VERSION}.`);
  }
  const mode = safeMode(value.mode);
  const runId = safeText(value.runId, 'runId', 160, { identifier: true });
  const recordId = safeText(value.recordId, 'recordId', 256, { identifier: true });
  if (!RECORD_TYPES.has(value.recordType)) fail('CONSOLE_INDEX_INVALID', 'recordType is unsupported.');
  const scopeKey = safeText(value.scopeKey, 'scopeKey', 512);
  const sourceId = safeText(value.sourceId, 'sourceId', 160, { identifier: true });
  const sourceRevision = safeText(value.sourceRevision, 'sourceRevision', 256, { identifier: true, nullable: true });
  const sourceUpdatedAt = canonicalTimestamp(value.sourceUpdatedAt, 'sourceUpdatedAt');
  if (typeof value.complete !== 'boolean') fail('CONSOLE_INDEX_INVALID', 'complete must be boolean.');
  const sortKey = safeText(value.sortKey, 'sortKey', 512);
  return Object.freeze({
    schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
    mode,
    runId,
    recordId,
    recordType: value.recordType,
    scopeKey,
    sourceId,
    sourceRevision,
    sourceUpdatedAt,
    complete: value.complete,
    sortKey,
    fields: safeFields(value.fields),
  });
}

function validateBudget(value) {
  exactKeys(value, ['maxRecords', 'maxSourceFiles', 'maxSourceBytes', 'maxElapsedMs'], 'console read budget');
  return Object.freeze({
    maxRecords: safeInteger(value.maxRecords, 'maxRecords'),
    maxSourceFiles: safeInteger(value.maxSourceFiles, 'maxSourceFiles'),
    maxSourceBytes: safeInteger(value.maxSourceBytes, 'maxSourceBytes'),
    maxElapsedMs: safeInteger(value.maxElapsedMs, 'maxElapsedMs'),
  });
}

export function createConsoleReadBudget(overrides = {}) {
  if (!isRecord(overrides)) fail('CONSOLE_INDEX_INVALID', 'Budget overrides must be a plain object.');
  const unknown = Object.keys(overrides).filter((key) => !Object.hasOwn(DEFAULT_CONSOLE_INDEX_BUDGET, key));
  if (unknown.length) fail('CONSOLE_INDEX_INVALID', `Budget overrides contain unsupported fields: ${unknown.sort().join(', ')}.`);
  return validateBudget({ ...DEFAULT_CONSOLE_INDEX_BUDGET, ...overrides });
}

export function createConsoleReadWork(value = {}) {
  if (!isRecord(value)) fail('CONSOLE_INDEX_INVALID', 'Read work must be a plain object.');
  const unknown = Object.keys(value).filter((key) => ![
    'recordsRead', 'sourceFilesRead', 'sourceBytesRead', 'elapsedMs', 'budgetExhausted',
  ].includes(key));
  if (unknown.length) fail('CONSOLE_INDEX_INVALID', `Read work contains unsupported fields: ${unknown.sort().join(', ')}.`);
  return Object.freeze({
    recordsRead: safeInteger(value.recordsRead ?? 0, 'recordsRead'),
    sourceFilesRead: safeInteger(value.sourceFilesRead ?? 0, 'sourceFilesRead'),
    sourceBytesRead: safeInteger(value.sourceBytesRead ?? 0, 'sourceBytesRead'),
    elapsedMs: safeInteger(value.elapsedMs ?? 0, 'elapsedMs'),
    budgetExhausted: value.budgetExhausted === true,
  });
}

export function consumeConsoleReadWork(workValue, budgetValue, deltaValue) {
  const work = createConsoleReadWork(workValue);
  const budget = validateBudget(budgetValue);
  if (!isRecord(deltaValue)) fail('CONSOLE_INDEX_INVALID', 'Read work delta must be a plain object.');
  const unknown = Object.keys(deltaValue).filter((key) => ![
    'recordsRead', 'sourceFilesRead', 'sourceBytesRead', 'elapsedMs',
  ].includes(key));
  if (unknown.length) fail('CONSOLE_INDEX_INVALID', `Read work delta contains unsupported fields: ${unknown.sort().join(', ')}.`);
  const delta = {
    recordsRead: safeInteger(deltaValue.recordsRead ?? 0, 'delta.recordsRead'),
    sourceFilesRead: safeInteger(deltaValue.sourceFilesRead ?? 0, 'delta.sourceFilesRead'),
    sourceBytesRead: safeInteger(deltaValue.sourceBytesRead ?? 0, 'delta.sourceBytesRead'),
    elapsedMs: safeInteger(deltaValue.elapsedMs ?? 0, 'delta.elapsedMs'),
  };
  const candidate = {
    recordsRead: work.recordsRead + delta.recordsRead,
    sourceFilesRead: work.sourceFilesRead + delta.sourceFilesRead,
    sourceBytesRead: work.sourceBytesRead + delta.sourceBytesRead,
    elapsedMs: work.elapsedMs + delta.elapsedMs,
  };
  const accepted = !work.budgetExhausted
    && candidate.recordsRead <= budget.maxRecords
    && candidate.sourceFilesRead <= budget.maxSourceFiles
    && candidate.sourceBytesRead <= budget.maxSourceBytes
    && candidate.elapsedMs <= budget.maxElapsedMs;
  return Object.freeze({
    accepted,
    work: accepted
      ? createConsoleReadWork(candidate)
      : createConsoleReadWork({
          recordsRead: work.recordsRead,
          sourceFilesRead: work.sourceFilesRead,
          sourceBytesRead: work.sourceBytesRead,
          elapsedMs: candidate.elapsedMs,
          budgetExhausted: true,
        }),
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function indexRevision(sequence) {
  return `index_${sequence.toString(16).padStart(16, '0')}`;
}

function identityKey(identity) {
  return `${identity.mode}\u0000${identity.runId}`;
}

function recordKey(record) {
  return `${record.runId}\u0000${record.recordId}`;
}

function validateIdentity(value) {
  exactKeys(value, ['mode', 'runId'], 'console run identity');
  return Object.freeze({
    mode: safeMode(value.mode),
    runId: safeText(value.runId, 'runId', 160, { identifier: true }),
  });
}

function validateLimitation(value, label = 'limitation') {
  if (value === null) return null;
  if (!LIMITATION_CODES.has(value)) fail('CONSOLE_INDEX_INVALID', `${label} is unsupported.`);
  return value;
}

function zeroWork(recordsRead = 0) {
  return createConsoleReadWork({ recordsRead });
}

function cursorDocument(value) {
  exactKeys(value, [
    'schemaVersion', 'mode', 'scopeKey', 'normalizedFilterKey', 'vectorRevision',
    'indexRevision', 'lastKey',
  ], 'console index cursor');
  if (value.schemaVersion !== CONSOLE_INDEX_SCHEMA_VERSION) fail('CONSOLE_INDEX_CURSOR_INVALID', 'Cursor schemaVersion is unsupported.');
  return Object.freeze({
    schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
    mode: safeMode(value.mode),
    scopeKey: safeText(value.scopeKey, 'cursor.scopeKey', 512),
    normalizedFilterKey: safeText(value.normalizedFilterKey, 'cursor.normalizedFilterKey', 1_024),
    vectorRevision: safeText(value.vectorRevision, 'cursor.vectorRevision', 96),
    indexRevision: safeText(value.indexRevision, 'cursor.indexRevision', 96),
    lastKey: safeText(value.lastKey, 'cursor.lastKey', 1_024),
  });
}

export function encodeConsoleIndexCursor(value) {
  const document = cursorDocument(value);
  return Buffer.from(JSON.stringify(document)).toString('base64url');
}

export function decodeConsoleIndexCursor(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CURSOR_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('CONSOLE_INDEX_CURSOR_INVALID', 'Cursor is malformed.');
  }
  let document;
  try {
    const source = Buffer.from(value, 'base64url');
    if (source.length > MAX_CURSOR_BYTES) throw new Error('oversized');
    document = JSON.parse(source.toString('utf8'));
  } catch {
    fail('CONSOLE_INDEX_CURSOR_INVALID', 'Cursor is malformed.');
  }
  return cursorDocument(document);
}

function nowIso(clock) {
  const date = new Date(clock());
  if (!Number.isFinite(date.getTime())) fail('CONSOLE_INDEX_INVALID', 'Console index clock returned an invalid time.');
  return date.toISOString();
}

export function createConsoleIndex(options = {}) {
  if (!isRecord(options)) fail('CONSOLE_INDEX_INVALID', 'Console index options must be a plain object.');
  const unknownOptions = Object.keys(options).filter((key) => !['clock', 'sources'].includes(key));
  if (unknownOptions.length) fail('CONSOLE_INDEX_INVALID', `Console index options contain unsupported fields: ${unknownOptions.sort().join(', ')}.`);
  const clock = options.clock ?? (() => Date.now());
  if (typeof clock !== 'function') fail('CONSOLE_INDEX_INVALID', 'Console index clock must be a function.');

  const modeRecords = {
    comparative: new Map(),
    'single-site': new Map(),
  };
  const identityRecords = new Map();
  const scopeRecords = {
    comparative: new Map(),
    'single-site': new Map(),
  };
  const orderedPartitions = new Map();
  const recordAuthorityRanks = new Map();
  const generations = new Map();
  const replacements = new Map();
  const tombstones = new Map();
  const sources = new Map();
  const backfills = new Map();
  let revisionSequence = 0;
  let lastPageRecordsExamined = 0;
  let pageSorts = 0;

  function bumpRevision() {
    revisionSequence += 1;
    orderedPartitions.clear();
    return indexRevision(revisionSequence);
  }

  function currentIndexRevision() {
    return indexRevision(revisionSequence);
  }

  function sourceState(sourceId) {
    return sources.get(sourceId) ?? null;
  }

  function setSource(sourceIdValue, value) {
    const sourceId = safeText(sourceIdValue, 'sourceId', 160, { identifier: true });
    const current = sources.get(sourceId);
    const next = Object.freeze({
      sourceId,
      revision: value.revision === undefined
        ? current?.revision ?? null
        : safeText(value.revision, 'source revision', 256, { identifier: true, nullable: true }),
      updatedAt: value.updatedAt === undefined
        ? current?.updatedAt ?? null
        : canonicalTimestamp(value.updatedAt, 'source updatedAt'),
      complete: value.complete === undefined ? current?.complete ?? false : value.complete === true,
      limitation: value.limitation === undefined
        ? current?.limitation ?? null
        : validateLimitation(value.limitation, 'source limitation'),
    });
    sources.set(sourceId, next);
    return next;
  }

  function publicSourceVector() {
    const sourceValues = [...sources.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const publicSources = Object.freeze(sourceValues.map((source) => Object.freeze({
      sourceId: source.sourceId,
      revision: source.revision,
      updatedAt: source.updatedAt,
      complete: source.complete,
    })));
    const complete = publicSources.length > 0 && publicSources.every((source) => source.complete);
    const vectorRevision = `vector_${digest({ indexRevision: currentIndexRevision(), sources: publicSources }).slice(0, 32)}`;
    return Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      vectorRevision,
      indexRevision: currentIndexRevision(),
      complete,
      sources: publicSources,
    });
  }

  function limitationsForVector(vector) {
    if (vector.sources.length === 0) {
      return Object.freeze([{ sourceId: 'console-index', code: 'source-unavailable' }]);
    }
    return Object.freeze([...sources.values()]
      .filter((source) => !source.complete || source.limitation)
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
      .map((source) => Object.freeze({
        sourceId: source.sourceId,
        code: source.limitation ?? 'incomplete-publication',
      })));
  }

  function generationFor(identity) {
    return generations.get(identityKey(identity)) ?? 0;
  }

  function advanceGeneration(identity) {
    const key = identityKey(identity);
    const generation = generationFor(identity) + 1;
    generations.set(key, generation);
    replacements.delete(key);
    return generation;
  }

  function evictIdentity(identity) {
    const key = identityKey(identity);
    const keys = identityRecords.get(key);
    if (!keys) return 0;
    let removed = 0;
    for (const itemKey of keys) {
      const record = modeRecords[identity.mode].get(itemKey);
      if (record && removeStoredRecord(record)) removed += 1;
    }
    identityRecords.delete(key);
    return removed;
  }

  function removeStoredRecord(record) {
    const key = recordKey(record);
    const removed = modeRecords[record.mode].delete(key);
    if (!removed) return false;
    recordAuthorityRanks.delete(`${record.mode}\u0000${key}`);
    const scopeKeys = scopeRecords[record.mode].get(record.scopeKey);
    scopeKeys?.delete(key);
    if (scopeKeys?.size === 0) scopeRecords[record.mode].delete(record.scopeKey);
    const idKeys = identityRecords.get(identityKey(record));
    idKeys?.delete(key);
    if (idKeys?.size === 0) identityRecords.delete(identityKey(record));
    return true;
  }

  function storeRecord(record, sourceComplete, updateSource = true, authorityRank = 0) {
    const key = recordKey(record);
    const previous = modeRecords[record.mode].get(key);
    if (previous) removeStoredRecord(previous);
    modeRecords[record.mode].set(key, record);
    recordAuthorityRanks.set(`${record.mode}\u0000${key}`, authorityRank);
    const identity = { mode: record.mode, runId: record.runId };
    const idKey = identityKey(identity);
    const keys = identityRecords.get(idKey) ?? new Set();
    keys.add(key);
    identityRecords.set(idKey, keys);
    const scopeKeys = scopeRecords[record.mode].get(record.scopeKey) ?? new Set();
    scopeKeys.add(key);
    scopeRecords[record.mode].set(record.scopeKey, scopeKeys);
    if (updateSource) {
      setSource(record.sourceId, {
        revision: record.sourceRevision,
        updatedAt: record.sourceUpdatedAt,
        ...(sourceComplete === undefined ? {} : { complete: sourceComplete }),
        ...(sourceComplete === true ? { limitation: null } : {}),
      });
    }
  }

  function setSourceWatermark(sourceIdValue, value) {
    if (!isRecord(value)) fail('CONSOLE_INDEX_INVALID', 'Source watermark must be a plain object.');
    exactKeys(value, ['revision', 'updatedAt', 'complete', 'limitation'], 'source watermark');
    if (typeof value.complete !== 'boolean') fail('CONSOLE_INDEX_INVALID', 'Source watermark complete must be boolean.');
    const source = setSource(sourceIdValue, value);
    bumpRevision();
    return source;
  }

  function beginReplacement(identityValue, value = {}) {
    const identity = validateIdentity(identityValue);
    if (!isRecord(value)) fail('CONSOLE_INDEX_INVALID', 'Replacement options must be a plain object.');
    exactKeys(value, ['sourceId', 'sourceRevision', 'sourceUpdatedAt', 'maximumRecords'], 'replacement options');
    const sourceId = safeText(value.sourceId, 'replacement sourceId', 160, { identifier: true });
    const sourceRevision = safeText(value.sourceRevision, 'replacement sourceRevision', 256, {
      identifier: true,
      nullable: true,
    });
    const sourceUpdatedAt = canonicalTimestamp(value.sourceUpdatedAt, 'replacement sourceUpdatedAt', false);
    const maximumRecords = safeInteger(value.maximumRecords, 'replacement maximumRecords', {
      minimum: 1,
      maximum: CONSOLE_INDEX_MAX_REPLACEMENT_RECORDS,
    });
    const key = identityKey(identity);
    if (tombstones.has(key)) return Object.freeze({ accepted: false, reason: 'purged', token: null });
    const generation = advanceGeneration(identity);
    const token = Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      ...identity,
      generation,
      sourceId,
      sourceRevision,
      sourceUpdatedAt,
      maximumRecords,
    });
    replacements.set(key, {
      token,
      records: new Map(),
    });
    return Object.freeze({ accepted: true, reason: null, token });
  }

  function validateReplacementToken(value) {
    exactKeys(value, [
      'schemaVersion', 'mode', 'runId', 'generation', 'sourceId', 'sourceRevision',
      'sourceUpdatedAt', 'maximumRecords',
    ], 'replacement token');
    if (value.schemaVersion !== CONSOLE_INDEX_SCHEMA_VERSION) {
      fail('CONSOLE_INDEX_INVALID', 'Replacement token schemaVersion is unsupported.');
    }
    const identity = validateIdentity({ mode: value.mode, runId: value.runId });
    return Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      ...identity,
      generation: safeInteger(value.generation, 'replacement generation', { minimum: 1 }),
      sourceId: safeText(value.sourceId, 'replacement sourceId', 160, { identifier: true }),
      sourceRevision: safeText(value.sourceRevision, 'replacement sourceRevision', 256, {
        identifier: true,
        nullable: true,
      }),
      sourceUpdatedAt: canonicalTimestamp(value.sourceUpdatedAt, 'replacement sourceUpdatedAt', false),
      maximumRecords: safeInteger(value.maximumRecords, 'replacement maximumRecords', {
        minimum: 1,
        maximum: CONSOLE_INDEX_MAX_REPLACEMENT_RECORDS,
      }),
    });
  }

  function currentReplacement(tokenValue) {
    const token = validateReplacementToken(tokenValue);
    const key = identityKey(token);
    const replacement = replacements.get(key);
    const stale = tombstones.has(key) || generationFor(token) !== token.generation
      || !replacement || replacement.token.generation !== token.generation
      || replacement.token.sourceId !== token.sourceId
      || replacement.token.sourceRevision !== token.sourceRevision;
    return { token, replacement: stale ? null : replacement };
  }

  function stageReplacement(tokenValue, recordsValue) {
    const { token, replacement } = currentReplacement(tokenValue);
    if (!replacement) return Object.freeze({ accepted: false, reason: 'stale-capture', stagedRecords: 0 });
    if (!Array.isArray(recordsValue) || recordsValue.length > CONSOLE_INDEX_MAX_REPLACEMENT_BATCH_RECORDS) {
      fail(
        'CONSOLE_INDEX_REPLACEMENT_BATCH_LIMIT',
        `Replacement batches may contain at most ${CONSOLE_INDEX_MAX_REPLACEMENT_BATCH_RECORDS} records.`,
        413,
      );
    }
    const records = recordsValue.map(validateRecord);
    if (records.some((record) => record.mode !== token.mode || record.runId !== token.runId
      || record.sourceId !== token.sourceId || record.sourceRevision !== token.sourceRevision
      || record.sourceUpdatedAt !== token.sourceUpdatedAt)) {
      fail('CONSOLE_INDEX_INVALID', 'Replacement records do not match the captured publication generation.');
    }
    const nextRecordIds = new Set(records.map(({ recordId }) => recordId));
    const additional = [...nextRecordIds].filter((recordId) => !replacement.records.has(recordId)).length;
    if (replacement.records.size + additional > token.maximumRecords) {
      replacements.delete(identityKey(token));
      fail(
        'CONSOLE_INDEX_REPLACEMENT_LIMIT',
        `Replacement exceeds its ${token.maximumRecords}-record bound.`,
        413,
      );
    }
    for (const record of records) replacement.records.set(record.recordId, record);
    return Object.freeze({ accepted: true, reason: null, stagedRecords: replacement.records.size });
  }

  function commitReplacement(tokenValue, optionsValue = {}) {
    if (!isRecord(optionsValue)) fail('CONSOLE_INDEX_INVALID', 'Replacement commit options must be a plain object.');
    exactKeys(optionsValue, ['complete'], 'replacement commit options');
    if (optionsValue.complete !== true) {
      fail('CONSOLE_INDEX_REPLACEMENT_INCOMPLETE', 'Replacement commit requires an explicitly complete staged generation.', 409);
    }
    const { token, replacement } = currentReplacement(tokenValue);
    if (!replacement) return Object.freeze({ committed: false, reason: 'stale-capture', records: Object.freeze([]) });
    const identity = { mode: token.mode, runId: token.runId };
    const idKey = identityKey(identity);
    const stagedRecords = [...replacement.records.values()];
    for (const record of stagedRecords) {
      const existing = modeRecords[token.mode].get(recordKey(record));
      if (existing && existing.sourceId !== token.sourceId) {
        replacements.delete(idKey);
        fail('CONSOLE_INDEX_RECORD_COLLISION', `Replacement record ${record.recordId} collides with another source.`, 409);
      }
    }
    let removed = 0;
    const keys = identityRecords.get(idKey);
    if (keys) {
      for (const key of [...keys]) {
        const existing = modeRecords[token.mode].get(key);
        if (existing?.sourceId !== token.sourceId) continue;
        if (removeStoredRecord(existing)) removed += 1;
      }
      if (keys.size === 0) identityRecords.delete(idKey);
    }
    for (const record of stagedRecords) storeRecord(record, undefined, false);
    replacements.delete(idKey);
    bumpRevision();
    return Object.freeze({
      committed: true,
      reason: null,
      removed,
      records: Object.freeze(stagedRecords),
    });
  }

  function abortReplacement(tokenValue) {
    const { token, replacement } = currentReplacement(tokenValue);
    if (!replacement) return false;
    replacements.delete(identityKey(token));
    return true;
  }

  function upsert(value, optionsValue = {}) {
    if (!isRecord(optionsValue)) fail('CONSOLE_INDEX_INVALID', 'Upsert options must be a plain object.');
    const unknown = Object.keys(optionsValue).filter((key) => !['sourceComplete', 'authorityRank'].includes(key));
    if (unknown.length) fail('CONSOLE_INDEX_INVALID', `Upsert options contain unsupported fields: ${unknown.sort().join(', ')}.`);
    if (optionsValue.sourceComplete !== undefined && typeof optionsValue.sourceComplete !== 'boolean') {
      fail('CONSOLE_INDEX_INVALID', 'sourceComplete must be boolean when provided.');
    }
    const authorityRank = optionsValue.authorityRank === undefined
      ? 0
      : safeInteger(optionsValue.authorityRank, 'authorityRank', { maximum: 10_000 });
    const record = validateRecord(value);
    const identity = { mode: record.mode, runId: record.runId };
    if (tombstones.has(identityKey(identity))) return Object.freeze({ committed: false, reason: 'purged' });
    const key = recordKey(record);
    const existing = modeRecords[record.mode].get(key);
    const existingRank = recordAuthorityRanks.get(`${record.mode}\u0000${key}`) ?? 0;
    if (existing && existing.sourceId !== record.sourceId && existingRank > authorityRank) {
      return Object.freeze({ committed: false, reason: 'lower-authority', record: existing });
    }
    advanceGeneration(identity);
    storeRecord(record, optionsValue.sourceComplete, true, authorityRank);
    bumpRevision();
    return Object.freeze({ committed: true, reason: null, record });
  }

  function capture(identityValue, sourceIdValue, sourceRevisionValue = null) {
    const identity = validateIdentity(identityValue);
    const sourceId = safeText(sourceIdValue, 'sourceId', 160, { identifier: true });
    const sourceRevision = safeText(sourceRevisionValue, 'sourceRevision', 256, { identifier: true, nullable: true });
    return Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      ...identity,
      generation: generationFor(identity),
      sourceId,
      sourceRevision,
      watermarkRevision: sourceState(sourceId)?.revision ?? null,
    });
  }

  function validateCommitToken(token) {
    exactKeys(token, [
      'schemaVersion', 'mode', 'runId', 'generation', 'sourceId', 'sourceRevision', 'watermarkRevision',
    ], 'console index commit token');
    if (token.schemaVersion !== CONSOLE_INDEX_SCHEMA_VERSION) fail('CONSOLE_INDEX_INVALID', 'Commit token schemaVersion is unsupported.');
    const identity = validateIdentity({ mode: token.mode, runId: token.runId });
    return Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      ...identity,
      generation: safeInteger(token.generation, 'commit generation'),
      sourceId: safeText(token.sourceId, 'commit sourceId', 160, { identifier: true }),
      sourceRevision: safeText(token.sourceRevision, 'commit sourceRevision', 256, { identifier: true, nullable: true }),
      watermarkRevision: safeText(token.watermarkRevision, 'commit watermarkRevision', 256, { identifier: true, nullable: true }),
    });
  }

  function commitAsync(tokenValue, recordValue, optionsValue = {}) {
    const token = validateCommitToken(tokenValue);
    const record = validateRecord(recordValue);
    const identity = { mode: token.mode, runId: token.runId };
    const stale = record.mode !== token.mode || record.runId !== token.runId
      || record.sourceId !== token.sourceId || record.sourceRevision !== token.sourceRevision
      || generationFor(identity) !== token.generation
      || tombstones.has(identityKey(identity))
      || (sourceState(token.sourceId)?.revision ?? null) !== token.watermarkRevision;
    if (stale) return Object.freeze({ committed: false, reason: 'stale-capture' });
    const result = upsert(record, optionsValue);
    return result.committed
      ? Object.freeze({ committed: true, reason: null, record: result.record })
      : result;
  }

  function invalidate(identityValue, recordIdValue = 'run') {
    const identity = validateIdentity(identityValue);
    const recordId = safeText(recordIdValue, 'recordId', 256, { identifier: true });
    if (tombstones.has(identityKey(identity))) return false;
    advanceGeneration(identity);
    const key = recordKey({ runId: identity.runId, recordId });
    const existing = modeRecords[identity.mode].get(key);
    const removed = existing ? removeStoredRecord(existing) : false;
    bumpRevision();
    return removed;
  }

  function beginBackfill(sourceIdValue, value = {}) {
    if (!isRecord(value)) fail('CONSOLE_INDEX_INVALID', 'Backfill options must be a plain object.');
    const unknown = Object.keys(value).filter((key) => !['revision', 'updatedAt', 'cursor', 'budget'].includes(key));
    if (unknown.length) fail('CONSOLE_INDEX_INVALID', `Backfill options contain unsupported fields: ${unknown.sort().join(', ')}.`);
    const sourceId = safeText(sourceIdValue, 'sourceId', 160, { identifier: true });
    const cursor = safeText(value.cursor, 'backfill cursor', 2_048, { nullable: true });
    const budget = value.budget === undefined ? DEFAULT_CONSOLE_INDEX_BUDGET : validateBudget(value.budget);
    const state = Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      sourceId,
      revision: safeText(value.revision ?? null, 'backfill revision', 256, { identifier: true, nullable: true }),
      updatedAt: canonicalTimestamp(value.updatedAt ?? null, 'backfill updatedAt'),
      cursor,
      complete: false,
      limitation: 'incomplete-publication',
      budget,
      work: createConsoleReadWork(),
    });
    backfills.set(sourceId, state);
    setSource(sourceId, { ...state, complete: false, limitation: state.limitation });
    bumpRevision();
    return state;
  }

  function updateBackfill(sourceIdValue, value) {
    const sourceId = safeText(sourceIdValue, 'sourceId', 160, { identifier: true });
    const current = backfills.get(sourceId);
    if (!current) fail('CONSOLE_INDEX_BACKFILL_MISSING', `Backfill ${sourceId} has not begun.`, 409);
    exactKeys(value, ['revision', 'updatedAt', 'cursor', 'complete', 'limitation', 'work'], 'backfill update');
    const work = createConsoleReadWork(value.work);
    if (work.recordsRead > current.budget.maxRecords
      || work.sourceFilesRead > current.budget.maxSourceFiles
      || work.sourceBytesRead > current.budget.maxSourceBytes
      || (work.elapsedMs > current.budget.maxElapsedMs && !work.budgetExhausted)) {
      fail('CONSOLE_INDEX_BUDGET_EXCEEDED', `Backfill ${sourceId} reported work beyond its configured budget.`);
    }
    if (typeof value.complete !== 'boolean') fail('CONSOLE_INDEX_INVALID', 'Backfill complete must be boolean.');
    const limitation = value.complete
      ? null
      : validateLimitation(value.limitation ?? (work.budgetExhausted ? 'budget-exhausted' : 'incomplete-publication'));
    const cursor = safeText(value.cursor, 'backfill cursor', 2_048, { nullable: true });
    if (value.complete && cursor !== null) fail('CONSOLE_INDEX_INVALID', 'A completed backfill cannot retain a cursor.');
    const state = Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      sourceId,
      revision: safeText(value.revision, 'backfill revision', 256, { identifier: true, nullable: true }),
      updatedAt: canonicalTimestamp(value.updatedAt, 'backfill updatedAt'),
      cursor,
      complete: value.complete,
      limitation,
      budget: current.budget,
      work,
    });
    backfills.set(sourceId, state);
    setSource(sourceId, state);
    bumpRevision();
    return state;
  }

  function backfillState(sourceIdValue) {
    const sourceId = safeText(sourceIdValue, 'sourceId', 160, { identifier: true });
    return backfills.get(sourceId) ?? null;
  }

  function read(identityValue, recordIdValue = 'run') {
    const identity = validateIdentity(identityValue);
    const recordId = safeText(recordIdValue, 'recordId', 256, { identifier: true });
    const vector = publicSourceVector();
    const tombstone = tombstones.get(identityKey(identity));
    if (tombstone) {
      return Object.freeze({
        schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
        value: null,
        sourceVector: vector,
        complete: false,
        freshness: 'unknown',
        limitations: Object.freeze([{ sourceId: tombstone.sourceId, code: 'purged' }]),
        work: zeroWork(),
      });
    }
    const record = modeRecords[identity.mode].get(recordKey({ runId: identity.runId, recordId })) ?? null;
    const complete = vector.complete && (record?.complete ?? true);
    const limitations = [...limitationsForVector(vector)];
    if (record && !record.complete && !limitations.some(({ sourceId }) => sourceId === record.sourceId)) {
      limitations.push(Object.freeze({ sourceId: record.sourceId, code: 'incomplete-publication' }));
    }
    return Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      value: record,
      sourceVector: vector,
      complete,
      freshness: record
        ? limitations.some(({ code }) => code === 'source-stale') ? 'stale' : 'current'
        : 'unknown',
      limitations: Object.freeze(limitations),
      work: zeroWork(record ? 1 : 0),
    });
  }

  function page(request) {
    const pageFields = ['mode', 'scopeKey', 'normalizedFilterKey', 'cursor', 'limit', 'recordTypes'];
    const optionalFields = ['orderBy', 'runId'].filter((field) => Object.hasOwn(request, field));
    exactKeys(request, [...pageFields, ...optionalFields], 'console index page request');
    const mode = safeMode(request.mode);
    const scopeKey = safeText(request.scopeKey, 'scopeKey', 512);
    const normalizedFilterKey = safeText(request.normalizedFilterKey, 'normalizedFilterKey', 1_024);
    const limit = safeInteger(request.limit, 'limit', { minimum: 1, maximum: CONSOLE_INDEX_MAX_PAGE_SIZE });
    if (!Array.isArray(request.recordTypes) || request.recordTypes.length < 1
      || request.recordTypes.length > CONSOLE_INDEX_RECORD_TYPES.length
      || request.recordTypes.some((value) => !RECORD_TYPES.has(value))
      || new Set(request.recordTypes).size !== request.recordTypes.length) {
      fail('CONSOLE_INDEX_INVALID', 'recordTypes must be a non-empty bounded list of supported record types.');
    }
    const recordTypes = new Set(request.recordTypes);
    const runId = request.runId === undefined ? null : safeText(request.runId, 'runId', 160, { identifier: true });
    const orderBy = request.orderBy === undefined ? 'index' : safeText(request.orderBy, 'orderBy', 40, { identifier: true });
    if (!ORDERINGS.has(orderBy)) fail('CONSOLE_INDEX_INVALID', 'Console index ordering is unsupported.');
    const vector = publicSourceVector();
    const decoded = request.cursor === null ? null : decodeConsoleIndexCursor(request.cursor);
    if (decoded && (decoded.mode !== mode || decoded.scopeKey !== scopeKey
      || decoded.normalizedFilterKey !== normalizedFilterKey
      || decoded.vectorRevision !== vector.vectorRevision
      || decoded.indexRevision !== vector.indexRevision)) {
      fail('CONSOLE_INDEX_CURSOR_STALE', 'Cursor no longer matches this query or source vector.', 409);
    }
    const partitionKey = JSON.stringify([mode, scopeKey, runId, [...recordTypes].sort(), orderBy]);
    let entries = orderedPartitions.get(partitionKey);
    if (!entries) {
      let candidateKeys;
      if (runId !== null) {
        candidateKeys = identityRecords.get(identityKey({ mode, runId })) ?? [];
      } else if (scopeKey !== 'all') {
        candidateKeys = scopeRecords[mode].get(scopeKey) ?? [];
      } else {
        candidateKeys = modeRecords[mode].keys();
      }
      const candidates = [...candidateKeys]
        .map((key) => modeRecords[mode].get(key))
        .filter((record) => record && (scopeKey === 'all' || record.scopeKey === scopeKey)
          && (runId === null || record.runId === runId) && recordTypes.has(record.recordType));
      lastPageRecordsExamined = candidates.length;
      pageSorts += 1;
      entries = Object.freeze(candidates.map((record) => ({
        record,
        key: consoleIndexOrderKey(record, orderBy),
      })).sort((left, right) => left.key.localeCompare(right.key)));
      if (entries.length > 0) {
        orderedPartitions.delete(partitionKey);
        orderedPartitions.set(partitionKey, entries);
        while (orderedPartitions.size > MAX_ORDERED_PARTITIONS) {
          orderedPartitions.delete(orderedPartitions.keys().next().value);
        }
      }
    } else {
      lastPageRecordsExamined = 0;
    }
    const start = decoded ? entries.findIndex(({ key }) => key > decoded.lastKey) : 0;
    const safeStart = start < 0 ? entries.length : start;
    const selected = entries.slice(safeStart, safeStart + limit);
    const nextOffset = safeStart + selected.length;
    const hasMore = nextOffset < entries.length;
    const nextCursor = hasMore && selected.length > 0
      ? encodeConsoleIndexCursor({
          schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
          mode,
          scopeKey,
          normalizedFilterKey,
          vectorRevision: vector.vectorRevision,
          indexRevision: vector.indexRevision,
          lastKey: selected.at(-1).key,
        })
      : null;
    const records = Object.freeze(selected.map(({ record }) => record));
    const complete = vector.complete && records.every((record) => record.complete);
    const limitations = [...limitationsForVector(vector)];
    for (const record of records) {
      if (!record.complete && !limitations.some(({ sourceId }) => sourceId === record.sourceId)) {
        limitations.push(Object.freeze({ sourceId: record.sourceId, code: 'incomplete-publication' }));
      }
    }
    return Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      items: records,
      nextCursor,
      hasMore,
      omittedRecords: Math.max(0, entries.length - nextOffset),
      cursorBinding: Object.freeze({
        mode,
        scopeKey,
        normalizedFilterKey,
        sourceVectorRevision: vector.vectorRevision,
      }),
      sourceVector: vector,
      complete,
      freshness: records.length > 0
        ? limitations.some(({ code }) => code === 'source-stale') ? 'stale' : 'current'
        : 'unknown',
      limitations: Object.freeze(limitations),
      work: zeroWork(records.length),
    });
  }

  function beginPurge(identityValue, value = {}) {
    const identity = validateIdentity(identityValue);
    if (!isRecord(value)) fail('CONSOLE_INDEX_INVALID', 'Purge options must be a plain object.');
    const unknown = Object.keys(value).filter((key) => !['sourceId', 'sourceRevision', 'updatedAt'].includes(key));
    if (unknown.length) fail('CONSOLE_INDEX_INVALID', `Purge options contain unsupported fields: ${unknown.sort().join(', ')}.`);
    const key = identityKey(identity);
    if (tombstones.has(key)) fail('CONSOLE_INDEX_PURGE_ACTIVE', 'This identity already has a purge barrier.', 409);
    const firstRecordKey = identityRecords.get(key)?.values().next().value;
    const firstRecord = firstRecordKey ? modeRecords[identity.mode].get(firstRecordKey) : null;
    const sourceId = safeText(value.sourceId ?? firstRecord?.sourceId ?? 'console-index', 'purge sourceId', 160, { identifier: true });
    const sourceRevision = safeText(value.sourceRevision ?? firstRecord?.sourceRevision ?? null, 'purge sourceRevision', 256, { identifier: true, nullable: true });
    const updatedAt = canonicalTimestamp(value.updatedAt ?? nowIso(clock), 'purge updatedAt', false);
    const generation = advanceGeneration(identity);
    evictIdentity(identity);
    const tombstone = Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      ...identity,
      generation,
      sourceId,
      sourceRevision,
      updatedAt,
      status: 'pending',
    });
    tombstones.set(key, tombstone);
    bumpRevision();
    return tombstone;
  }

  function validatePurgeToken(token) {
    exactKeys(token, [
      'schemaVersion', 'mode', 'runId', 'generation', 'sourceId', 'sourceRevision', 'updatedAt', 'status',
    ], 'purge token');
    if (token.schemaVersion !== CONSOLE_INDEX_SCHEMA_VERSION || !['pending', 'committed'].includes(token.status)) {
      fail('CONSOLE_INDEX_INVALID', 'Purge token is invalid.');
    }
    const identity = validateIdentity({ mode: token.mode, runId: token.runId });
    return Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      ...identity,
      generation: safeInteger(token.generation, 'purge generation', { minimum: 1 }),
      sourceId: safeText(token.sourceId, 'purge sourceId', 160, { identifier: true }),
      sourceRevision: safeText(token.sourceRevision, 'purge sourceRevision', 256, { identifier: true, nullable: true }),
      updatedAt: canonicalTimestamp(token.updatedAt, 'purge updatedAt', false),
      status: token.status,
    });
  }

  function requirePendingPurge(tokenValue) {
    const token = validatePurgeToken(tokenValue);
    const current = tombstones.get(identityKey(token));
    if (!current || current.generation !== token.generation || current.status !== 'pending') {
      fail('CONSOLE_INDEX_PURGE_STALE', 'Purge token is no longer current.', 409);
    }
    return { token, current };
  }

  function commitPurge(tokenValue, value = {}) {
    const { token, current } = requirePendingPurge(tokenValue);
    if (!isRecord(value)) fail('CONSOLE_INDEX_INVALID', 'Purge commit options must be a plain object.');
    const unknown = Object.keys(value).filter((key) => !['sourceRevision', 'updatedAt'].includes(key));
    if (unknown.length) fail('CONSOLE_INDEX_INVALID', `Purge commit options contain unsupported fields: ${unknown.sort().join(', ')}.`);
    const committed = Object.freeze({
      ...current,
      sourceRevision: value.sourceRevision === undefined
        ? current.sourceRevision
        : safeText(value.sourceRevision, 'purge sourceRevision', 256, { identifier: true, nullable: true }),
      updatedAt: value.updatedAt === undefined
        ? nowIso(clock)
        : canonicalTimestamp(value.updatedAt, 'purge updatedAt', false),
      status: 'committed',
    });
    tombstones.set(identityKey(token), committed);
    bumpRevision();
    return committed;
  }

  function abortPurge(tokenValue, recordsValue, optionsValue = {}) {
    const { token } = requirePendingPurge(tokenValue);
    if (!Array.isArray(recordsValue) || recordsValue.length < 1 || recordsValue.length > CONSOLE_INDEX_MAX_PAGE_SIZE) {
      fail('CONSOLE_INDEX_PURGE_REVERIFY_REQUIRED', 'Aborting purge requires a bounded authoritative reread.', 409);
    }
    if (!isRecord(optionsValue) || Object.keys(optionsValue).some((key) => key !== 'sourceComplete')) {
      fail('CONSOLE_INDEX_INVALID', 'Purge abort options are invalid.');
    }
    const records = recordsValue.map(validateRecord);
    if (records.some((record) => record.mode !== token.mode || record.runId !== token.runId)) {
      fail('CONSOLE_INDEX_PURGE_REVERIFY_REQUIRED', 'Authoritative reread records identify a different run.', 409);
    }
    const identity = { mode: token.mode, runId: token.runId };
    tombstones.delete(identityKey(identity));
    advanceGeneration(identity);
    for (const record of records) storeRecord(record, optionsValue.sourceComplete);
    bumpRevision();
    return Object.freeze({ restored: true, records: Object.freeze(records) });
  }

  function diagnostics() {
    return Object.freeze({
      schemaVersion: CONSOLE_INDEX_SCHEMA_VERSION,
      indexRevision: currentIndexRevision(),
      records: modeRecords.comparative.size + modeRecords['single-site'].size,
      recordsByMode: Object.freeze({
        comparative: modeRecords.comparative.size,
        'single-site': modeRecords['single-site'].size,
      }),
      sources: sources.size,
      incompleteSources: [...sources.values()].filter(({ complete }) => !complete).length,
      backfills: backfills.size,
      pendingPurges: [...tombstones.values()].filter(({ status }) => status === 'pending').length,
      tombstones: tombstones.size,
      replacements: replacements.size,
      cacheEntries: orderedPartitions.size,
      pageSorts,
      lastPageRecordsExamined,
    });
  }

  function clear() {
    modeRecords.comparative.clear();
    modeRecords['single-site'].clear();
    scopeRecords.comparative.clear();
    scopeRecords['single-site'].clear();
    orderedPartitions.clear();
    identityRecords.clear();
    generations.clear();
    replacements.clear();
    tombstones.clear();
    sources.clear();
    backfills.clear();
    bumpRevision();
  }

  if (options.sources !== undefined) {
    if (!Array.isArray(options.sources) || options.sources.length > 64) {
      fail('CONSOLE_INDEX_INVALID', 'Initial sources must be a bounded array.');
    }
    for (const source of options.sources) {
      exactKeys(source, ['sourceId', 'revision', 'updatedAt', 'complete'], 'initial source');
      const sourceId = safeText(source.sourceId, 'sourceId', 160, { identifier: true });
      setSource(sourceId, {
        revision: source.revision,
        updatedAt: source.updatedAt,
        complete: source.complete,
        limitation: source.complete ? null : 'incomplete-publication',
      });
    }
    if (options.sources.length > 0) bumpRevision();
  }

  return Object.freeze({
    upsert,
    setSourceWatermark,
    beginReplacement,
    stageReplacement,
    commitReplacement,
    abortReplacement,
    capture,
    commitAsync,
    invalidate,
    beginBackfill,
    updateBackfill,
    backfillState,
    sourceVector: publicSourceVector,
    read,
    page,
    beginPurge,
    commitPurge,
    abortPurge,
    diagnostics,
    clear,
  });
}
