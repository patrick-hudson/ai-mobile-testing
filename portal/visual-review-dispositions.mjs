import { constants as fsConstants, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve, relative, sep } from 'node:path';
import {
  readVisualBaselineStore,
  withVisualBaselineMutationLock,
} from './visual-baselines.mjs';
import { visualBaselineCanonicalJson, visualBaselineDigest } from '../shared/visual-baseline-contract.mjs';
export {
  appendVisualDisposition as appendScopedVisualDisposition,
  parseVisualDispositionHistory as parseScopedVisualDispositionHistory,
} from '../shared/release-projection.mjs';

const EVENT_NAME = /^(\d{12})-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const GALLERY_ITEM_ID = /^gitem_[a-f0-9]{16}$/;
const VISUAL_ITEM_ID = /^[a-f0-9]{32}$/;
const REPORT_REVISION = /^[a-f0-9]{32}$/;
const EXPORT_REVISION = /^export_[a-f0-9]{16}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DISPOSITIONS = new Set(['accepted-change', 'known-defect']);
const MAX_EVENTS = 10_000;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;

export class VisualReviewStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'VisualReviewStoreError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new VisualReviewStoreError(code, message, details);
}

function contained(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !value.startsWith(sep));
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('VISUAL_REVIEW_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function exactDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('VISUAL_REVIEW_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function boundedText(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 3 || value.length > 1_200) {
    fail('VISUAL_REVIEW_INPUT_INVALID', `${label} must be from 3 through 1200 characters without surrounding whitespace.`);
  }
  return value;
}

function revision(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('VISUAL_REVIEW_INPUT_INVALID', `${label} is invalid.`);
  return value;
}

function now(store) {
  const value = store.clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('VISUAL_REVIEW_CLOCK_INVALID', 'Visual review clock returned an invalid time.');
  return date.toISOString();
}

function nonce(store) {
  return safeId(store.nonce(), 'generated visual review nonce');
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } finally { await handle?.close(); }
}

async function realDirectory(root, label) {
  const requested = resolve(root);
  await fs.mkdir(requested, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('VISUAL_REVIEW_PATH_UNSAFE', `${label} must be a real directory.`);
  return fs.realpath(requested);
}

export async function openVisualReviewStore(options) {
  if (!options || typeof options.root !== 'string') fail('VISUAL_REVIEW_INPUT_INVALID', 'Visual review store root is required.');
  const root = await realDirectory(options.root, 'Visual review store root');
  const eventsDirectory = join(root, 'events');
  await fs.mkdir(eventsDirectory, { mode: 0o700 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  const eventStat = await fs.lstat(eventsDirectory);
  if (!eventStat.isDirectory() || eventStat.isSymbolicLink() || !contained(root, await fs.realpath(eventsDirectory))) {
    fail('VISUAL_REVIEW_PATH_UNSAFE', 'Visual review events directory escaped its root.');
  }
  return Object.freeze({
    root,
    eventsDirectory,
    clock: options.clock ?? (() => new Date()),
    nonce: options.nonce ?? (() => randomBytes(12).toString('hex')),
  });
}

function emptyState() {
  return { reviewRevision: 0, historyDigest: ZERO_DIGEST, reviews: {}, idempotency: {} };
}

function parseBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('VISUAL_REVIEW_INPUT_INVALID', 'Visual comparison binding is required.');
  const expected = [
    'jobId', 'galleryItemId', 'reportRevision', 'galleryExportRevision', 'visualPublicationDigest',
    'visualComparisonItemId', 'identityKey', 'slotKey', 'comparisonDigest', 'baselineId',
    'baselineMediaSha256', 'currentMediaSha256', 'diffSha256',
  ];
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value))) {
    fail('VISUAL_REVIEW_INPUT_INVALID', 'Visual comparison binding has unsupported or missing fields.');
  }
  safeId(value.jobId, 'binding.jobId');
  if (!GALLERY_ITEM_ID.test(value.galleryItemId)) fail('VISUAL_REVIEW_INPUT_INVALID', 'binding.galleryItemId is invalid.');
  if (!REPORT_REVISION.test(value.reportRevision)) fail('VISUAL_REVIEW_INPUT_INVALID', 'binding.reportRevision is invalid.');
  if (!EXPORT_REVISION.test(value.galleryExportRevision)) fail('VISUAL_REVIEW_INPUT_INVALID', 'binding.galleryExportRevision is invalid.');
  exactDigest(value.visualPublicationDigest, 'binding.visualPublicationDigest');
  if (!VISUAL_ITEM_ID.test(value.visualComparisonItemId)) fail('VISUAL_REVIEW_INPUT_INVALID', 'binding.visualComparisonItemId is invalid.');
  for (const key of ['identityKey', 'slotKey', 'comparisonDigest', 'baselineMediaSha256', 'currentMediaSha256', 'diffSha256']) {
    exactDigest(value[key], `binding.${key}`);
  }
  safeId(value.baselineId, 'binding.baselineId');
  return Object.freeze({ ...value });
}

export function visualReviewBindingKey(value) {
  return visualBaselineDigest(parseBinding(value));
}

function request(input) {
  const binding = parseBinding(input?.binding);
  const disposition = input?.disposition;
  if (!DISPOSITIONS.has(disposition)) {
    fail('VISUAL_REVIEW_INPUT_INVALID', 'disposition must be accepted-change or known-defect.');
  }
  const body = {
    expectedReviewRevision: revision(input.expectedReviewRevision, 'expectedReviewRevision'),
    expectedBaselineStoreRevision: revision(input.expectedBaselineStoreRevision, 'expectedBaselineStoreRevision'),
    binding,
    actorId: safeId(input.actorId, 'actorId'),
    rationale: boundedText(input.rationale, 'rationale'),
    disposition,
    idempotencyKey: safeId(input.idempotencyKey, 'idempotencyKey'),
  };
  return { ...body, reviewKey: visualReviewBindingKey(binding), requestDigest: visualBaselineDigest(body) };
}

function parseEvent(value, expectedSequence, expectedPreviousDigest, filename) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('VISUAL_REVIEW_HISTORY_CORRUPT', `Visual review event ${filename} is invalid.`);
  const fields = [
    'schemaVersion', 'kind', 'sequence', 'eventId', 'type', 'at', 'actorId', 'rationale',
    'disposition', 'idempotencyKey', 'requestDigest', 'previousDigest', 'binding', 'reviewKey',
    'expectedBaselineStoreRevision', 'result', 'eventDigest',
  ];
  if (Object.keys(value).length !== fields.length || fields.some((key) => !(key in value))
    || value.schemaVersion !== 1 || value.kind !== 'single-site-visual-review-event'
    || value.sequence !== expectedSequence || value.type !== 'reviewed'
    || value.previousDigest !== expectedPreviousDigest || !DISPOSITIONS.has(value.disposition)) {
    fail('VISUAL_REVIEW_HISTORY_CORRUPT', `Visual review event ${filename} has an unsupported shape.`);
  }
  safeId(value.eventId, 'eventId');
  safeId(value.actorId, 'actorId');
  safeId(value.idempotencyKey, 'idempotencyKey');
  boundedText(value.rationale, 'rationale');
  revision(value.expectedBaselineStoreRevision, 'expectedBaselineStoreRevision');
  try {
    if (typeof value.at !== 'string' || new Date(value.at).toISOString() !== value.at) throw new Error('invalid');
  } catch {
    fail('VISUAL_REVIEW_HISTORY_CORRUPT', `Visual review event ${filename} has an invalid timestamp.`);
  }
  const binding = parseBinding(value.binding);
  if (value.reviewKey !== visualReviewBindingKey(binding) || !DIGEST.test(value.requestDigest ?? '')) {
    fail('VISUAL_REVIEW_HISTORY_CORRUPT', `Visual review event ${filename} has invalid binding digests.`);
  }
  if (!value.result || typeof value.result !== 'object' || Array.isArray(value.result)
    || Object.keys(value.result).length !== 5
    || value.result.reviewRevision !== value.sequence || value.result.eventId !== value.eventId
    || value.result.reviewKey !== value.reviewKey || value.result.status !== 'REVIEWED'
    || value.result.disposition !== value.disposition) {
    fail('VISUAL_REVIEW_HISTORY_CORRUPT', `Visual review event ${filename} has an invalid result.`);
  }
  const requestBody = {
    expectedReviewRevision: value.sequence - 1,
    expectedBaselineStoreRevision: value.expectedBaselineStoreRevision,
    binding,
    actorId: value.actorId,
    rationale: value.rationale,
    disposition: value.disposition,
    idempotencyKey: value.idempotencyKey,
  };
  if (value.requestDigest !== visualBaselineDigest(requestBody)) {
    fail('VISUAL_REVIEW_HISTORY_CORRUPT', `Visual review event ${filename} has an invalid request digest.`);
  }
  const { eventDigest, ...body } = value;
  if (eventDigest !== visualBaselineDigest(body)) fail('VISUAL_REVIEW_HISTORY_CORRUPT', `Visual review event ${filename} failed digest verification.`);
  return Object.freeze({ ...value, binding });
}

export async function readVisualReviewStore(store) {
  const names = (await fs.readdir(store.eventsDirectory)).filter((name) => name.endsWith('.json')).sort();
  if (names.length > MAX_EVENTS) fail('VISUAL_REVIEW_HISTORY_LIMIT', 'Visual review history exceeds its event-count bound.');
  const state = emptyState();
  const history = [];
  let totalBytes = 0;
  for (const [index, filename] of names.entries()) {
    const match = EVENT_NAME.exec(filename);
    if (!match || Number(match[1]) !== index + 1) fail('VISUAL_REVIEW_HISTORY_CORRUPT', `Visual review event ${filename} is out of sequence.`);
    const file = join(store.eventsDirectory, filename);
    if (!contained(store.root, file)) fail('VISUAL_REVIEW_PATH_UNSAFE', 'Visual review event escaped its root.');
    const stat = await fs.lstat(file);
    totalBytes += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_EVENT_BYTES || totalBytes > MAX_HISTORY_BYTES) {
      fail('VISUAL_REVIEW_HISTORY_LIMIT', 'Visual review history exceeds its bounded regular-file limits.');
    }
    const real = await fs.realpath(file);
    if (real !== file || !contained(store.root, real)) fail('VISUAL_REVIEW_PATH_UNSAFE', 'Visual review event escaped its root.');
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    let document;
    try { document = JSON.parse(bytes.toString('utf8')); } catch { fail('VISUAL_REVIEW_HISTORY_CORRUPT', `Visual review event ${filename} is invalid JSON.`); }
    const event = parseEvent(document, index + 1, state.historyDigest, filename);
    if (match[2] !== event.eventId || state.reviews[event.reviewKey] || state.idempotency[event.idempotencyKey]) {
      fail('VISUAL_REVIEW_HISTORY_CORRUPT', `Visual review event ${filename} duplicates an identity or idempotency key.`);
    }
    state.reviewRevision = event.sequence;
    state.historyDigest = event.eventDigest;
    state.reviews[event.reviewKey] = Object.freeze({
      reviewKey: event.reviewKey,
      status: 'REVIEWED',
      disposition: event.disposition,
      rationale: event.rationale,
      actorId: event.actorId,
      reviewedAt: event.at,
      reviewRevision: event.sequence,
      eventId: event.eventId,
      binding: event.binding,
    });
    state.idempotency[event.idempotencyKey] = { requestDigest: event.requestDigest, result: event.result };
    history.push(event);
  }
  return Object.freeze({ state: Object.freeze(state), history: Object.freeze(history), bytes: totalBytes });
}

async function appendEvent(store, state, value) {
  const sequence = state.reviewRevision + 1;
  const eventId = nonce(store);
  const result = Object.freeze({
    reviewRevision: sequence,
    eventId,
    reviewKey: value.reviewKey,
    status: 'REVIEWED',
    disposition: value.disposition,
  });
  const body = {
    schemaVersion: 1,
    kind: 'single-site-visual-review-event',
    sequence,
    eventId,
    type: 'reviewed',
    at: value.at,
    actorId: value.actorId,
    rationale: value.rationale,
    disposition: value.disposition,
    idempotencyKey: value.idempotencyKey,
    requestDigest: value.requestDigest,
    previousDigest: state.historyDigest,
    binding: value.binding,
    reviewKey: value.reviewKey,
    expectedBaselineStoreRevision: value.expectedBaselineStoreRevision,
    result,
  };
  const event = { ...body, eventDigest: visualBaselineDigest(body) };
  const filename = `${String(sequence).padStart(12, '0')}-${eventId}.json`;
  const temporary = join(store.eventsDirectory, `.pending-${eventId}.tmp`);
  const destination = join(store.eventsDirectory, filename);
  const handle = await fs.open(temporary, 'wx', 0o600);
  let writeError = null;
  try {
    await handle.writeFile(`${visualBaselineCanonicalJson(event)}\n`);
    await handle.sync();
  } catch (error) {
    writeError = error;
  } finally { await handle.close(); }
  if (writeError) {
    await fs.unlink(temporary).catch(() => undefined);
    throw writeError;
  }
  try {
    await fs.rename(temporary, destination);
    await fsyncDirectory(store.eventsDirectory);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  return result;
}

export async function reviewVisualComparison(store, baselineStore, input) {
  const value = request(input);
  return withVisualBaselineMutationLock(baselineStore, async () => {
    const [reviews, baselines] = await Promise.all([
      readVisualReviewStore(store),
      readVisualBaselineStore(baselineStore),
    ]);
    const idempotent = reviews.state.idempotency[value.idempotencyKey];
    if (idempotent) {
      if (idempotent.requestDigest !== value.requestDigest) {
        fail('VISUAL_REVIEW_IDEMPOTENCY_CONFLICT', `Idempotency key ${value.idempotencyKey} was already used for another review.`);
      }
      return Object.freeze({ ...structuredClone(idempotent.result), idempotent: true });
    }
    if (reviews.state.reviewRevision !== value.expectedReviewRevision) {
      fail('VISUAL_REVIEW_CAS_CONFLICT', 'Visual review revision is stale.', {
        expectedReviewRevision: value.expectedReviewRevision,
        actualReviewRevision: reviews.state.reviewRevision,
      });
    }
    if (baselines.state.storeRevision !== value.expectedBaselineStoreRevision) {
      fail('VISUAL_REVIEW_BASELINE_STALE', 'Visual baseline store changed before the review could be recorded.', {
        expectedBaselineStoreRevision: value.expectedBaselineStoreRevision,
        actualBaselineStoreRevision: baselines.state.storeRevision,
      });
    }
    if (reviews.state.reviews[value.reviewKey]) {
      fail('VISUAL_REVIEW_ALREADY_RECORDED', 'This exact visual comparison already has a human disposition.');
    }
    const baselineId = baselines.state.activeBySlot[value.binding.slotKey] ?? null;
    const baseline = baselineId ? baselines.state.baselines[baselineId] : null;
    if (!baseline || baseline.state !== 'active' || baseline.baselineId !== value.binding.baselineId
      || baseline.media.available !== true || baseline.media.sha256 !== value.binding.baselineMediaSha256) {
      fail('VISUAL_REVIEW_BASELINE_STALE', 'The exact active baseline revision no longer matches this visual comparison.');
    }
    const result = await appendEvent(store, reviews.state, { ...value, at: now(store) });
    return Object.freeze({ ...result, idempotent: false });
  });
}

export function resolveVisualReview(snapshot, binding) {
  if (!snapshot?.state?.reviews) fail('VISUAL_REVIEW_INPUT_INVALID', 'Visual review snapshot is invalid.');
  const review = snapshot.state.reviews[visualReviewBindingKey(binding)] ?? null;
  return review ? Object.freeze(structuredClone(review)) : null;
}
