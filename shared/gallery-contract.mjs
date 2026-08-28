export const GALLERY_SCHEMA_VERSION = 1;
export const GALLERY_CAPTURE_METADATA_CONTENT_TYPE = 'application/vnd.quitting7oh.gallery-capture+json';
export const GALLERY_CAPTURE_TEXT_LIMIT = 1_200;
export const GALLERY_ARCHIVE_CHANNEL = 'quitting7oh-gallery-archive-v1';
export const GALLERY_DESCRIPTOR_MAX_BYTES = 256 * 1024;
export const GALLERY_QUERY_CHUNK_MAX_BYTES = 256 * 1024;
export const GALLERY_ITEM_DETAIL_MAX_BYTES = 512 * 1024;
export const GALLERY_QUERY_CHUNK_MAX_ROWS = 100;
export const GALLERY_FLAG_REVIEWER_MAX_CHARS = 120;
export const GALLERY_FLAG_TEXT_MAX_CHARS = 4_000;
export const GALLERY_FLAG_IDEMPOTENCY_MAX_CHARS = 128;
export const GALLERY_FLAG_MAX_EVENTS = 10_000;
export const GALLERY_FLAG_HISTORY_MAX_BYTES = 16 * 1024 * 1024;

const MEDIA_KINDS = new Set(['image', 'video']);
const MEMBER_ROLES = new Set(['single', 'baseline', 'actual', 'diff', 'other', 'unknown']);
const CAPTURE_PROVENANCE = new Set(['producer', 'legacy-inferred', 'test-policy', 'missing']);
const FLAG_ACTIONS = new Set(['opened', 'resolved', 'dismissed', 'reopened']);
const FLAG_STATES = new Set(['open', 'resolved', 'dismissed']);
const GALLERY_ITEM_ID_PATTERN = /^gitem_[a-f0-9]{16}$/;
const GALLERY_TEST_GROUP_ID_PATTERN = /^gtest_[a-f0-9]{16}$/;
const GALLERY_FLAG_ID_PATTERN = /^gflag_[a-f0-9]{16,64}$/;
const GALLERY_FLAG_EVENT_ID_PATTERN = /^gfevent_[a-f0-9]{16,64}$/;

export class GalleryFlagContractError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'GalleryFlagContractError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function stableGalleryString(value) {
  return JSON.stringify(canonicalize(value));
}

// FNV-1a is used only for deterministic logical identifiers. Blob integrity
// continues to use producer-computed SHA-256 values.
export function stableGalleryKey(value) {
  const text = typeof value === 'string' ? value : stableGalleryString(value);
  let hash = 0xcbf29ce484222325n;
  for (const character of text) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function deriveGalleryItemId(identity) {
  return `gitem_${stableGalleryKey({
    sourceTestId: identity.sourceTestId,
    project: identity.project,
    attempt: identity.attempt,
    retry: identity.retry,
    attachmentKey: identity.attachmentKey,
  })}`;
}

export function deriveGalleryMemberId(itemId, attachmentKey) {
  return `gmember_${stableGalleryKey({ itemId, attachmentKey })}`;
}

export function deriveGalleryTestGroupId(identity) {
  return `gtest_${stableGalleryKey({
    sourceTestId: identity.sourceTestId,
    project: identity.project,
    attempt: identity.attempt,
    retry: identity.retry,
  })}`;
}

export function primaryGalleryAuditAssociation(associations) {
  return [...(Array.isArray(associations) ? associations : [])].sort((left, right) => {
    const ordinal = (left?.catalogOrdinal ?? Number.MAX_SAFE_INTEGER)
      - (right?.catalogOrdinal ?? Number.MAX_SAFE_INTEGER);
    if (ordinal !== 0) return ordinal;
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
  })[0] ?? null;
}

export function normalizeGalleryRoute(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const parsed = new URL(value, 'https://gallery.invalid');
    const queryKeys = [...new Set([...parsed.searchParams.keys()].filter(Boolean))].sort();
    const pathname = parsed.pathname || '/';
    return queryKeys.length === 0
      ? pathname
      : `${pathname}?${queryKeys.map((key) => encodeURIComponent(key)).join('&')}`;
  } catch {
    return null;
  }
}

export function boundedGalleryText(value, maximum = GALLERY_CAPTURE_TEXT_LIMIT) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

export function normalizeGalleryQuery(query = {}) {
  const strings = (value) => [...new Set((Array.isArray(value) ? value : [])
    .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    .map((entry) => entry.trim()))].sort();
  return {
    kinds: strings(query.kinds).filter((kind) => MEDIA_KINDS.has(kind)),
    statuses: strings(query.statuses),
    environments: strings(query.environments),
    featureSuites: strings(query.featureSuites),
    technicalSuites: strings(query.technicalSuites),
    targets: strings(query.targets),
    flagStates: strings(query.flagStates),
    search: typeof query.search === 'string' ? query.search.replace(/\s+/g, ' ').trim().toLowerCase() : '',
    group: ['feature', 'technical', 'none'].includes(query.group) ? query.group : 'feature',
    sort: ['attention', 'feature', 'technical', 'audit', 'capture-time'].includes(query.sort)
      ? query.sort
      : 'attention',
  };
}

function includesEvery(actual, expected) {
  return expected.length === 0 || expected.some((value) => actual.includes(value));
}

function statusAttentionRank(status) {
  const normalized = String(status ?? '').toLowerCase();
  if (['failed', 'blocked', 'fail', 'timedout', 'timed-out', 'interrupted'].includes(normalized)) return 1;
  if (normalized === 'flaky' || normalized === 'review') return 2;
  return 3;
}

function compareNullableText(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return String(left).localeCompare(String(right));
}

function compareNormalizedGalleryQueryRows(left, right, query) {
  const byId = () => String(left.id).localeCompare(String(right.id));
  if (query.sort === 'attention') {
    const flagRank = (row) => row.flagState === 'open' ? 0 : 1;
    const flag = flagRank(left) - flagRank(right);
    if (flag !== 0) return flag;
    const status = statusAttentionRank(left.status) - statusAttentionRank(right.status);
    if (status !== 0) return status;
    const warning = Number(Boolean(right.visualWarning || !right.available)) - Number(Boolean(left.visualWarning || !left.available));
    if (warning !== 0) return warning;
  }
  if (query.sort === 'feature' || (query.sort === 'attention' && query.group === 'feature')) {
    const feature = compareNullableText(left.primaryFeatureSuite, right.primaryFeatureSuite);
    if (feature !== 0) return feature;
  }
  if (query.sort === 'technical' || (query.sort === 'attention' && query.group === 'technical')) {
    const technical = compareNullableText(left.technicalSuite, right.technicalSuite);
    if (technical !== 0) return technical;
  }
  if (query.sort === 'audit') {
    const leftAudit = left.auditAssociations?.[0];
    const rightAudit = right.auditAssociations?.[0];
    const ordinal = (leftAudit?.catalogOrdinal ?? Number.MAX_SAFE_INTEGER)
      - (rightAudit?.catalogOrdinal ?? Number.MAX_SAFE_INTEGER);
    if (ordinal !== 0) return ordinal;
    const associations = (left.auditAssociations ?? []).map(({ id }) => id).sort().join('\u0000')
      .localeCompare((right.auditAssociations ?? []).map(({ id }) => id).sort().join('\u0000'));
    if (associations !== 0) return associations;
  }
  if (query.sort === 'capture-time') {
    const capture = compareNullableText(left.captureTime, right.captureTime);
    if (capture !== 0) return capture;
  }
  const title = String(left.title ?? '').localeCompare(String(right.title ?? ''));
  return title === 0 ? byId() : title;
}

export function compareGalleryQueryRows(left, right, query = {}) {
  return compareNormalizedGalleryQueryRows(left, right, normalizeGalleryQuery(query));
}

export function queryGalleryArchiveRows(rows, query = {}) {
  const normalized = normalizeGalleryQuery(query);
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => galleryQueryRowMatches(row, normalized))
    .sort((left, right) => compareNormalizedGalleryQueryRows(left, right, normalized));
}

export function galleryQueryRowMatches(row, query = {}) {
  const normalized = normalizeGalleryQuery(query);
  if (!row || typeof row !== 'object') return false;
  if (normalized.kinds.length > 0 && !normalized.kinds.includes(row.kind)) return false;
  if (normalized.statuses.length > 0 && !normalized.statuses.includes(row.status)) return false;
  if (normalized.environments.length > 0 && !normalized.environments.includes(row.environment)) return false;
  if (!includesEvery(row.featureSuites ?? [], normalized.featureSuites)) return false;
  if (normalized.technicalSuites.length > 0 && !normalized.technicalSuites.includes(row.technicalSuite)) return false;
  if (normalized.targets.length > 0 && !normalized.targets.some((target) => row.targets?.includes(target))) return false;
  if (normalized.flagStates.length > 0 && !normalized.flagStates.includes(row.flagState)) return false;
  if (normalized.search && !String(row.searchText ?? '').includes(normalized.search)) return false;
  return true;
}

export function galleryItemHref(descriptor, itemId) {
  if (!descriptor?.itemDetails || typeof descriptor.itemDetails.hrefPrefix !== 'string') {
    throw new TypeError('Gallery descriptor does not define item detail documents.');
  }
  return `${descriptor.itemDetails.hrefPrefix}${encodeURIComponent(String(itemId))}${descriptor.itemDetails.hrefSuffix ?? ''}`;
}

export function assertGalleryArchiveDescriptor(value) {
  if (!value || typeof value !== 'object') throw new TypeError('Gallery archive descriptor must be an object.');
  if (value.schemaVersion !== GALLERY_SCHEMA_VERSION || value.phase !== 'sealed') {
    throw new TypeError('Unsupported gallery archive descriptor schema or phase.');
  }
  for (const key of ['contentRevision', 'flagRevision', 'orderRevision', 'exportRevision', 'exportedAt']) {
    if (typeof value[key] !== 'string' || value[key] === '') throw new TypeError(`Gallery archive descriptor needs ${key}.`);
  }
  if (value.archiveBundle !== undefined) {
    const bundle = value.archiveBundle;
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
      || bundle.schemaVersion !== 1 || bundle.bundleVersion !== 2 || bundle.runtimeVersion !== 2
      || bundle.minimumReaderVersion !== 1 || bundle.dataSchemaVersion !== GALLERY_SCHEMA_VERSION
      || bundle.assetBase !== 'assets/archive-v2'
      || bundle.manifestHref !== 'assets/archive-v2/bundle.json') {
      throw new TypeError('Gallery archive descriptor has an invalid runtime bundle contract.');
    }
  }
  if (!value.query || !Array.isArray(value.query.chunks) || !Number.isInteger(value.query.rows) || value.query.rows < 0) {
    throw new TypeError('Gallery archive descriptor has an invalid query index.');
  }
  if (
    value.query.maxRowsPerChunk < 1
    || value.query.maxRowsPerChunk > GALLERY_QUERY_CHUNK_MAX_ROWS
    || value.query.maxBytesPerChunk < 1
    || value.query.maxBytesPerChunk > GALLERY_QUERY_CHUNK_MAX_BYTES
  ) throw new TypeError('Gallery archive descriptor exceeds query chunk limits.');
  for (const chunk of value.query.chunks) {
    if (
      !chunk
      || typeof chunk.href !== 'string'
      || !Number.isInteger(chunk.rows)
      || chunk.rows < 1
      || chunk.rows > value.query.maxRowsPerChunk
      || !Number.isInteger(chunk.bytes)
      || chunk.bytes < 1
      || chunk.bytes > value.query.maxBytesPerChunk
    ) throw new TypeError('Gallery archive descriptor has an invalid query chunk.');
  }
  if (
    !value.itemDetails
    || !Number.isInteger(value.itemDetails.count)
    || value.itemDetails.count < 0
    || value.itemDetails.maxBytes !== GALLERY_ITEM_DETAIL_MAX_BYTES
  ) throw new TypeError('Gallery archive descriptor has an invalid item detail contract.');
  if (!value.raw || !Array.isArray(value.raw.chunks) || !value.flags || !value.integrity) {
    throw new TypeError('Gallery archive descriptor omits raw, flag, or integrity documents.');
  }
  if (
    value.raw.maxRowsPerChunk < 1
    || value.raw.maxRowsPerChunk > GALLERY_QUERY_CHUNK_MAX_ROWS
    || value.raw.maxBytesPerChunk < 1
    || value.raw.maxBytesPerChunk > GALLERY_QUERY_CHUNK_MAX_BYTES
  ) throw new TypeError('Gallery archive descriptor exceeds raw chunk limits.');
  for (const chunk of value.raw.chunks) {
    if (
      !chunk
      || typeof chunk.href !== 'string'
      || !Number.isInteger(chunk.rows)
      || chunk.rows < 1
      || chunk.rows > value.raw.maxRowsPerChunk
      || !Number.isInteger(chunk.bytes)
      || chunk.bytes < 1
      || chunk.bytes > value.raw.maxBytesPerChunk
    ) throw new TypeError('Gallery archive descriptor has an invalid raw chunk.');
  }
  return value;
}

export function compareGalleryAuditOrder(left, right) {
  const leftOrdinal = left?.auditAssociations?.[0]?.catalogOrdinal ?? Number.MAX_SAFE_INTEGER;
  const rightOrdinal = right?.auditAssociations?.[0]?.catalogOrdinal ?? Number.MAX_SAFE_INTEGER;
  if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
  const leftAssociations = (left?.auditAssociations ?? []).map(({ id }) => id).sort().join('\u0000');
  const rightAssociations = (right?.auditAssociations ?? []).map(({ id }) => id).sort().join('\u0000');
  const associations = leftAssociations.localeCompare(rightAssociations);
  if (associations !== 0) return associations;
  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

export function assertGalleryCatalog(value) {
  if (!value || typeof value !== 'object') throw new TypeError('Gallery catalog must be an object.');
  if (value.schemaVersion !== GALLERY_SCHEMA_VERSION) throw new TypeError('Unsupported gallery catalog schema.');
  if (!Array.isArray(value.items) || !Array.isArray(value.blobs)) throw new TypeError('Gallery catalog items and blobs must be arrays.');
  const itemIds = new Set();
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') throw new TypeError('Every gallery item needs an ID.');
    if (itemIds.has(item.id)) throw new TypeError(`Duplicate gallery item ID: ${item.id}`);
    itemIds.add(item.id);
    if (!MEDIA_KINDS.has(item.kind)) throw new TypeError(`Unsupported gallery media kind: ${item.kind}`);
    if (!Array.isArray(item.members) || item.members.length === 0) throw new TypeError(`Gallery item ${item.id} has no members.`);
    for (const member of item.members) {
      if (!MEMBER_ROLES.has(member.role)) throw new TypeError(`Gallery item ${item.id} has an unsupported member role.`);
    }
    if (item.attempt?.rawStatus !== undefined) {
      if (typeof item.attempt.rawStatus !== 'string' || item.attempt.rawStatus.length > 120) {
        throw new TypeError(`Gallery item ${item.id} has an invalid raw attempt status.`);
      }
      if (!['reviewed-manifest', 'release-integrity'].includes(item.attempt.statusSource)) {
        throw new TypeError(`Gallery item ${item.id} has an invalid reviewed status source.`);
      }
      if (
        !Array.isArray(item.attempt.reviewReasonCodes)
        || item.attempt.reviewReasonCodes.length > 12
        || item.attempt.reviewReasonCodes.some((code) => typeof code !== 'string' || code.length > 120)
      ) throw new TypeError(`Gallery item ${item.id} has invalid review reason codes.`);
    }
    if (!CAPTURE_PROVENANCE.has(item.capture?.provenance)) throw new TypeError(`Gallery item ${item.id} has invalid capture provenance.`);
  }
  const blobIds = new Set();
  for (const blob of value.blobs) {
    if (!blob || typeof blob !== 'object' || typeof blob.id !== 'string') throw new TypeError('Every gallery blob needs an ID.');
    if (blobIds.has(blob.id)) throw new TypeError(`Duplicate gallery blob ID: ${blob.id}`);
    blobIds.add(blob.id);
  }
  for (const item of value.items) {
    for (const member of item.members) {
      if (member.blobId !== null && !blobIds.has(member.blobId)) {
        throw new TypeError(`Gallery member ${member.id} references missing blob ${member.blobId}.`);
      }
    }
  }
  if (value.primaryCounts?.total !== value.items.length) throw new TypeError('Gallery primary total is inconsistent.');
  return value;
}

function assertBoundedString(value, name, maximum = 1_200, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.trim() === '')) {
    throw new TypeError(`${name} is invalid.`);
  }
}

function assertStringArray(value, name, maximumEntries = 100, maximumLength = 1_200) {
  if (
    !Array.isArray(value)
    || value.length > maximumEntries
    || value.some((entry) => typeof entry !== 'string' || entry.length > maximumLength)
  ) throw new TypeError(`${name} is invalid.`);
}

export function assertGalleryQueryRow(value) {
  if (!value || typeof value !== 'object') throw new TypeError('Gallery query row must be an object.');
  if (!GALLERY_ITEM_ID_PATTERN.test(value.id ?? '')) throw new TypeError('Gallery query row has an invalid item ID.');
  if (!GALLERY_TEST_GROUP_ID_PATTERN.test(value.testGroupId ?? '')) {
    throw new TypeError('Gallery query row has an invalid test-group ID.');
  }
  if (!MEDIA_KINDS.has(value.kind)) throw new TypeError('Gallery query row has an invalid media kind.');
  for (const [name, field, maximum] of [
    ['title', value.title, 1_200],
    ['test label', value.testLabel, 1_200],
    ['project name', value.projectName, 300],
    ['status', value.status, 120],
    ['environment', value.environment, 120],
    ['technical suite', value.technicalSuite, 1_200],
    ['search text', value.searchText, 20_000],
  ]) assertBoundedString(field, `Gallery query row ${name}`, maximum, name === 'technical suite');
  assertStringArray(value.testTitlePath, 'Gallery query row title path', 50);
  assertStringArray(value.featureSuites, 'Gallery query row feature suites');
  assertStringArray(value.targets, 'Gallery query row targets');
  if (value.primaryFeatureSuite !== null && typeof value.primaryFeatureSuite !== 'string') {
    throw new TypeError('Gallery query row primary feature suite is invalid.');
  }
  if (
    value.primaryAuditCatalogOrdinal !== null
    && (!Number.isInteger(value.primaryAuditCatalogOrdinal) || value.primaryAuditCatalogOrdinal < 0)
  ) throw new TypeError('Gallery query row primary audit ordinal is invalid.');
  if (!FLAG_STATES.has(value.flagState) && value.flagState !== 'unflagged') {
    throw new TypeError('Gallery query row flag state is invalid.');
  }
  if (
    !value.attempt
    || !Number.isInteger(value.attempt.ordinal)
    || value.attempt.ordinal < 1
    || !Number.isInteger(value.attempt.retry)
    || value.attempt.retry < 0
  ) throw new TypeError('Gallery query row attempt is invalid.');
  if (value.captureTime !== null && (typeof value.captureTime !== 'string' || Number.isNaN(Date.parse(value.captureTime)))) {
    throw new TypeError('Gallery query row capture time is invalid.');
  }
  if (typeof value.available !== 'boolean') throw new TypeError('Gallery query row availability is invalid.');
  if (typeof value.visualWarning !== 'boolean') throw new TypeError('Gallery query row visual warning is invalid.');
  if (!Array.isArray(value.auditAssociations) || value.auditAssociations.length > 100) {
    throw new TypeError('Gallery query row audit associations are invalid.');
  }
  for (const association of value.auditAssociations) {
    assertBoundedString(association?.id, 'Gallery query row audit ID', 160);
    assertBoundedString(association?.title, 'Gallery query row audit title');
    if (
      association.catalogOrdinal !== null
      && (!Number.isInteger(association.catalogOrdinal) || association.catalogOrdinal < 0)
    ) throw new TypeError('Gallery query row audit ordinal is invalid.');
  }
  return value;
}

export function assertGalleryItemDetail(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== GALLERY_SCHEMA_VERSION) {
    throw new TypeError('Gallery item detail has an unsupported schema.');
  }
  const item = value.item;
  if (!item || typeof item !== 'object' || !GALLERY_ITEM_ID_PATTERN.test(item.id ?? '')) {
    throw new TypeError('Gallery item detail has an invalid item.');
  }
  if (!MEDIA_KINDS.has(item.kind) || !Array.isArray(item.members) || item.members.length === 0 || item.members.length > 20) {
    throw new TypeError('Gallery item detail has invalid media members.');
  }
  assertBoundedString(item.test?.id, 'Gallery item test ID', 500);
  assertBoundedString(item.test?.title, 'Gallery item test title');
  assertStringArray(item.test?.titlePath, 'Gallery item title path', 50);
  assertBoundedString(item.test?.technicalSuite, 'Gallery item technical suite', 1_200, true);
  if (!Array.isArray(item.auditAssociations) || item.auditAssociations.length > 100) {
    throw new TypeError('Gallery item audit associations are invalid.');
  }
  for (const member of item.members) {
    assertBoundedString(member?.id, 'Gallery item member ID', 160);
    if (!MEMBER_ROLES.has(member.role) || typeof member.available !== 'boolean') {
      throw new TypeError('Gallery item member is invalid.');
    }
  }
  if (!Array.isArray(value.media) || value.media.length !== item.members.length) {
    throw new TypeError('Gallery item media projection is invalid.');
  }
  const memberIds = new Set(item.members.map(({ id }) => id));
  for (const media of value.media) {
    if (!memberIds.has(media?.memberId) || typeof media.available !== 'boolean') {
      throw new TypeError('Gallery item media projection references an invalid member.');
    }
    if (media.href !== null && typeof media.href !== 'string') {
      throw new TypeError('Gallery item media href is invalid.');
    }
  }
  if (
    !value.availability
    || !['available', 'tombstone'].includes(value.availability.state)
    || typeof value.availability.retryable !== 'boolean'
  ) throw new TypeError('Gallery item availability is invalid.');
  return value;
}

export function projectGalleryFlags(events, throughEvent = null) {
  const flags = new Map();
  const watermark = Number.isInteger(throughEvent) && throughEvent >= 0 ? throughEvent : Number.MAX_SAFE_INTEGER;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || typeof event.flagId !== 'string') continue;
    if (Number.isInteger(event.sequence) && event.sequence > watermark) continue;
    if (!FLAG_ACTIONS.has(event.action)) continue;
    const prior = flags.get(event.flagId);
    const state = event.action === 'opened' || event.action === 'reopened' ? 'open' : event.action;
    flags.set(event.flagId, {
      flagId: event.flagId,
      itemId: event.itemId ?? prior?.itemId,
      testId: event.identity?.testId ?? prior?.testId,
      identity: event.identity ?? prior?.identity,
      state,
      reviewer: event.reviewer,
      note: event.action === 'opened' || event.action === 'reopened' ? event.note : prior?.note,
      justification: event.justification ?? null,
      openedAt: prior?.openedAt ?? event.timestamp,
      updatedAt: event.timestamp,
      lastEventId: event.eventId,
      throughEvent: event.sequence ?? throughEvent,
    });
  }
  return [...flags.values()].sort((left, right) => left.flagId.localeCompare(right.flagId));
}

export function emptyGalleryFlagHistory() {
  return { schemaVersion: GALLERY_SCHEMA_VERSION, throughEvent: 0, events: [] };
}

export function galleryFlagRevision(history) {
  const value = assertGalleryFlagHistory(history);
  return `flags_${stableGalleryKey({ throughEvent: value.throughEvent, events: value.events })}`;
}

export function galleryFlagSnapshot(history) {
  const value = assertGalleryFlagHistory(history);
  return {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    throughEvent: value.throughEvent,
    flagRevision: galleryFlagRevision(value),
    flags: projectGalleryFlags(value.events, value.throughEvent),
    events: value.events,
  };
}

function requireFlagText(value, name, maximum) {
  if (typeof value !== 'string') {
    throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', `${name} is required.`);
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized === '') throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', `${name} is required.`);
  if (normalized.length > maximum) {
    throw new GalleryFlagContractError('GALLERY_FLAG_TOO_LARGE', `${name} exceeds ${maximum} characters.`, 413);
  }
  return normalized;
}

function flagRequestFingerprint(transition) {
  return stableGalleryKey({
    action: transition.action,
    flagId: transition.action === 'open' ? null : transition.flagId ?? null,
    itemId: transition.itemId ?? null,
    identity: transition.identity ?? null,
    reviewer: transition.reviewer,
    note: transition.note ?? null,
    justification: transition.justification ?? null,
  });
}

export function assertGalleryFlagHistory(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== GALLERY_SCHEMA_VERSION || !Array.isArray(value.events)) {
    throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag history is invalid.', 500);
  }
  if (!Number.isInteger(value.throughEvent) || value.throughEvent < 0 || value.throughEvent !== value.events.length) {
    throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag history watermark is invalid.', 500);
  }
  if (value.events.length > GALLERY_FLAG_MAX_EVENTS) {
    throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_TOO_LARGE', 'Reviewer flag history exceeds its event quota.', 413);
  }
  const eventIds = new Set();
  const idempotency = new Set();
  const lastByFlag = new Map();
  for (const [index, event] of value.events.entries()) {
    if (!event || typeof event !== 'object' || event.sequence !== index + 1) {
      throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag event sequence is invalid.', 500);
    }
    if (!GALLERY_FLAG_EVENT_ID_PATTERN.test(event.eventId) || eventIds.has(event.eventId)) {
      throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag event identity is invalid.', 500);
    }
    eventIds.add(event.eventId);
    if (!GALLERY_FLAG_ID_PATTERN.test(event.flagId) || !FLAG_ACTIONS.has(event.action)) {
      throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag transition is invalid.', 500);
    }
    if (!GALLERY_ITEM_ID_PATTERN.test(event.itemId) || typeof event.identity?.testId !== 'string' || event.identity.testId === '') {
      throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag target identity is invalid.', 500);
    }
    if (typeof event.idempotencyKey !== 'string' || event.idempotencyKey === '' || idempotency.has(event.idempotencyKey)) {
      throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag idempotency history is invalid.', 500);
    }
    idempotency.add(event.idempotencyKey);
    if (typeof event.requestFingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(event.requestFingerprint)) {
      throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag request fingerprint is invalid.', 500);
    }
    if (typeof event.expectedFlagRevision !== 'string' || !/^flags_[a-f0-9]{16}$/.test(event.expectedFlagRevision)) {
      throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag expected revision is invalid.', 500);
    }
    if (typeof event.reviewer !== 'string' || event.reviewer === '' || event.reviewer.length > GALLERY_FLAG_REVIEWER_MAX_CHARS) {
      throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer attribution is invalid.', 500);
    }
    if (
      typeof event.idempotencyKey !== 'string'
      || event.idempotencyKey.length > GALLERY_FLAG_IDEMPOTENCY_MAX_CHARS
      || (event.note !== null && (typeof event.note !== 'string' || event.note.length > GALLERY_FLAG_TEXT_MAX_CHARS))
      || (event.justification !== null && (
        typeof event.justification !== 'string'
        || event.justification.length > GALLERY_FLAG_TEXT_MAX_CHARS
      ))
    ) throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag event text is invalid.', 500);
    if (
      event.identity.testId.length > 500
      || (event.identity.title !== undefined && (typeof event.identity.title !== 'string' || event.identity.title.length > 1_200))
      || (event.identity.project !== undefined && (typeof event.identity.project !== 'string' || event.identity.project.length > 300))
      || (event.identity.attempt !== undefined && (!Number.isInteger(event.identity.attempt) || event.identity.attempt < 1))
      || (event.identity.auditIds !== undefined && (
        !Array.isArray(event.identity.auditIds)
        || event.identity.auditIds.length > 100
        || event.identity.auditIds.some((id) => typeof id !== 'string' || id.length > 160)
      ))
    ) throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag identity snapshot is invalid.', 500);
    if (Number.isNaN(Date.parse(event.timestamp))) {
      throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag timestamp is invalid.', 500);
    }
    const prior = lastByFlag.get(event.flagId);
    if (event.action === 'opened') {
      if (prior || event.previousEventId !== null || typeof event.note !== 'string' || event.note === '') {
        throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag opening event is invalid.', 500);
      }
    } else {
      if (!prior || event.previousEventId !== prior.eventId) {
        throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag event chain is invalid.', 500);
      }
      if (event.itemId !== prior.itemId || stableGalleryString(event.identity) !== stableGalleryString(prior.identity)) {
        throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag target identity changed within its history.', 500);
      }
      if (event.action === 'reopened' && (prior.action === 'opened' || prior.action === 'reopened')) {
        throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'An open reviewer flag cannot be reopened.', 500);
      }
      if (event.action === 'reopened' && (typeof event.note !== 'string' || event.note === '')) {
        throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag reopening note is invalid.', 500);
      }
      if ((event.action === 'resolved' || event.action === 'dismissed') && !['opened', 'reopened'].includes(prior.action)) {
        throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'A closed reviewer flag cannot be closed again.', 500);
      }
      if ((event.action === 'resolved' || event.action === 'dismissed') && (
        typeof event.justification !== 'string'
        || event.justification === ''
      )) throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_INVALID', 'Reviewer flag closing justification is invalid.', 500);
    }
    lastByFlag.set(event.flagId, event);
  }
  return value;
}

export function applyGalleryFlagTransition(historyValue, transitionValue) {
  const history = assertGalleryFlagHistory(historyValue);
  if (!transitionValue || typeof transitionValue !== 'object') {
    throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', 'Reviewer flag transition is required.');
  }
  const requestedAction = transitionValue.action;
  const action = requestedAction === 'open' ? 'opened'
    : requestedAction === 'resolve' ? 'resolved'
      : requestedAction === 'dismiss' ? 'dismissed'
        : requestedAction === 'reopen' ? 'reopened'
          : null;
  if (!action) throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', 'Reviewer flag action is invalid.');
  const reviewer = requireFlagText(transitionValue.reviewer, 'Reviewer', GALLERY_FLAG_REVIEWER_MAX_CHARS);
  const idempotencyKey = requireFlagText(
    transitionValue.idempotencyKey,
    'Idempotency key',
    GALLERY_FLAG_IDEMPOTENCY_MAX_CHARS,
  );
  const normalizedTransition = {
    ...transitionValue,
    action: requestedAction,
    reviewer,
    ...(transitionValue.note !== undefined
      ? { note: requireFlagText(transitionValue.note, 'Note', GALLERY_FLAG_TEXT_MAX_CHARS) }
      : {}),
    ...(transitionValue.justification !== undefined
      ? { justification: requireFlagText(transitionValue.justification, 'Justification', GALLERY_FLAG_TEXT_MAX_CHARS) }
      : {}),
  };
  const requestFingerprint = flagRequestFingerprint(normalizedTransition);
  const replay = history.events.find((event) => event.idempotencyKey === idempotencyKey);
  if (replay) {
    if (replay.requestFingerprint !== requestFingerprint) {
      throw new GalleryFlagContractError('GALLERY_FLAG_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different transition.', 409);
    }
    return { history, event: replay, flagRevision: galleryFlagRevision(history), idempotent: true };
  }
  const currentRevision = galleryFlagRevision(history);
  if (transitionValue.expectedFlagRevision !== currentRevision) {
    throw new GalleryFlagContractError('GALLERY_FLAG_REVISION_CONFLICT', 'Reviewer flag state changed. Refresh and try again.', 409);
  }
  if (history.events.length >= GALLERY_FLAG_MAX_EVENTS) {
    throw new GalleryFlagContractError('GALLERY_FLAG_HISTORY_TOO_LARGE', 'Reviewer flag history reached its event quota.', 413);
  }
  const timestamp = typeof transitionValue.timestamp === 'string' && !Number.isNaN(Date.parse(transitionValue.timestamp))
    ? new Date(transitionValue.timestamp).toISOString()
    : null;
  if (!timestamp) throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', 'A valid transition timestamp is required.');
  if (!GALLERY_FLAG_EVENT_ID_PATTERN.test(transitionValue.eventId ?? '')) {
    throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', 'A valid immutable event ID is required.');
  }

  const projected = new Map(projectGalleryFlags(history.events).map((flag) => [flag.flagId, flag]));
  let flagId;
  let itemId;
  let identity;
  let previousEventId = null;
  if (action === 'opened') {
    flagId = transitionValue.flagId;
    itemId = transitionValue.itemId;
    identity = transitionValue.identity;
    if (!GALLERY_FLAG_ID_PATTERN.test(flagId ?? '') || !GALLERY_ITEM_ID_PATTERN.test(itemId ?? '')) {
      throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', 'A valid immutable flag and media item ID are required.');
    }
    if (!identity || typeof identity.testId !== 'string' || identity.testId.trim() === '') {
      throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', 'A source-test identity snapshot is required.');
    }
    if (projected.has(flagId)) throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', 'Reviewer flag ID already exists.', 409);
    if (!normalizedTransition.note) throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', 'Note is required.');
  } else {
    flagId = transitionValue.flagId;
    const current = projected.get(flagId);
    if (!current) throw new GalleryFlagContractError('GALLERY_FLAG_NOT_FOUND', 'Reviewer flag was not found.', 404);
    const previous = [...history.events].reverse().find((event) => event.flagId === flagId);
    previousEventId = previous?.eventId ?? null;
    itemId = current.itemId;
    identity = current.identity;
    if (action === 'reopened') {
      if (current.state === 'open') throw new GalleryFlagContractError('GALLERY_FLAG_TRANSITION_CONFLICT', 'Reviewer flag is already open.', 409);
      if (!normalizedTransition.note) throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', 'Note is required when reopening a flag.');
    } else {
      if (current.state !== 'open') throw new GalleryFlagContractError('GALLERY_FLAG_TRANSITION_CONFLICT', 'Only an open reviewer flag can be closed.', 409);
      if (!normalizedTransition.justification) throw new GalleryFlagContractError('GALLERY_FLAG_INVALID', 'Justification is required.');
    }
  }
  const event = {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    sequence: history.throughEvent + 1,
    eventId: transitionValue.eventId,
    flagId,
    previousEventId,
    action,
    itemId,
    identity,
    reviewer,
    note: normalizedTransition.note ?? null,
    justification: normalizedTransition.justification ?? null,
    timestamp,
    idempotencyKey,
    requestFingerprint,
    expectedFlagRevision: transitionValue.expectedFlagRevision,
  };
  const nextHistory = assertGalleryFlagHistory({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    throughEvent: event.sequence,
    events: [...history.events, event],
  });
  return {
    history: nextHistory,
    event,
    flagRevision: galleryFlagRevision(nextHistory),
    idempotent: false,
  };
}
