import { createHash } from 'node:crypto';

export const VISUAL_BASELINE_SCHEMA_VERSION = 1;
export const VISUAL_BASELINE_HISTORY_SCHEMA_VERSION = 1;
export const VISUAL_CAPTURE_METADATA_CONTENT_TYPE = 'application/vnd.quitting7oh.visual-baseline-capture+json';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const AUDIT_ID = /^[A-Z0-9][A-Z0-9-]{2,159}$/;
const ROLES = new Set(['preview', 'production']);
const ENGINES = new Set(['chromium', 'firefox', 'webkit']);
const AUTHORITY = new Set(['authoritative', 'non-authoritative']);
const BASELINE_STATES = new Set(['active', 'replaced', 'revoked', 'deleted']);
const VISUAL_REVIEW_STATUSES = new Set([
  'UNCHANGED', 'CHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${label} contains unknown fields: ${unexpected.sort().join(', ')}.`);
}

function text(value, label, maximum = 240) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim() || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters without surrounding whitespace.`);
  }
  return value;
}

function safeId(value, label, pattern = SAFE_ID) {
  const result = text(value, label, 160);
  if (!pattern.test(result)) throw new TypeError(`${label} is invalid.`);
  return result;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new TypeError(`${label} must be a sha256 digest.`);
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}.`);
  }
  return value;
}

function normalizedRoute(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('#')) {
    throw new TypeError('visual identity route must be a same-origin path/query without a fragment.');
  }
  let parsed;
  try {
    parsed = new URL(value, 'https://visual-baseline.invalid');
  } catch {
    throw new TypeError('visual identity route is invalid.');
  }
  if (parsed.origin !== 'https://visual-baseline.invalid') throw new TypeError('visual identity route must remain same-origin.');
  const pairs = [...parsed.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => (
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  ));
  const query = new URLSearchParams();
  for (const [key, entry] of pairs) query.append(key, entry);
  const pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  const search = query.toString();
  return `${pathname}${search ? `?${search}` : ''}`;
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON does not support non-finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`Canonical JSON does not support undefined at ${key}.`);
      output[key] = canonicalValue(value[key]);
    }
    return output;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value}.`);
}

export function visualBaselineCanonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function visualBaselineDigest(value) {
  return `sha256:${createHash('sha256').update(
    typeof value === 'string' || value instanceof Uint8Array ? value : visualBaselineCanonicalJson(value),
  ).digest('hex')}`;
}

function renderingContract(value) {
  if (!isRecord(value)) throw new TypeError('visual identity rendering must be an object.');
  exactKeys(value, [
    'devicePixelRatio', 'captureContractRevision', 'runnerImageDigest', 'fontPackDigest', 'fingerprint',
  ], 'visual identity rendering');
  if (typeof value.devicePixelRatio !== 'number' || !Number.isFinite(value.devicePixelRatio)
    || value.devicePixelRatio < 0.1 || value.devicePixelRatio > 10) {
    throw new TypeError('visual identity rendering.devicePixelRatio must be between 0.1 and 10.');
  }
  const body = {
    devicePixelRatio: value.devicePixelRatio,
    captureContractRevision: safeId(value.captureContractRevision, 'visual identity rendering.captureContractRevision'),
    runnerImageDigest: digest(value.runnerImageDigest, 'visual identity rendering.runnerImageDigest'),
    fontPackDigest: digest(value.fontPackDigest, 'visual identity rendering.fontPackDigest'),
  };
  const fingerprint = visualBaselineDigest(body);
  if (value.fingerprint !== undefined && value.fingerprint !== fingerprint) {
    throw new TypeError('visual identity rendering fingerprint contradicts its rendering contract.');
  }
  return { ...body, fingerprint };
}

export function parseVisualBaselineIdentity(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.mode !== 'single-site') {
    throw new TypeError('Visual baseline identity must use schemaVersion 1 and mode single-site.');
  }
  exactKeys(value, [
    'schemaVersion', 'mode', 'deploymentRole', 'route', 'targetId', 'viewport', 'theme',
    'auditId', 'auditDefinitionDigest', 'capturePoint', 'browser', 'rendering',
  ], 'visual baseline identity');
  if (!ROLES.has(value.deploymentRole)) throw new TypeError('visual identity deploymentRole is invalid.');
  if (!isRecord(value.viewport)) throw new TypeError('visual identity viewport must be an object.');
  exactKeys(value.viewport, ['width', 'height'], 'visual identity viewport');
  if (!isRecord(value.browser)) throw new TypeError('visual identity browser must be an object.');
  exactKeys(value.browser, ['engine', 'product', 'version', 'build'], 'visual identity browser');
  if (!ENGINES.has(value.browser.engine)) throw new TypeError('visual identity browser.engine is invalid.');
  return Object.freeze({
    schemaVersion: VISUAL_BASELINE_SCHEMA_VERSION,
    mode: 'single-site',
    deploymentRole: value.deploymentRole,
    route: normalizedRoute(value.route),
    targetId: safeId(value.targetId, 'visual identity targetId'),
    viewport: {
      width: positiveInteger(value.viewport.width, 'visual identity viewport.width', 10_000),
      height: positiveInteger(value.viewport.height, 'visual identity viewport.height', 10_000),
    },
    theme: safeId(value.theme, 'visual identity theme'),
    auditId: safeId(value.auditId, 'visual identity auditId', AUDIT_ID),
    auditDefinitionDigest: digest(value.auditDefinitionDigest, 'visual identity auditDefinitionDigest'),
    capturePoint: safeId(value.capturePoint, 'visual identity capturePoint'),
    browser: {
      engine: value.browser.engine,
      product: safeId(value.browser.product, 'visual identity browser.product'),
      version: text(value.browser.version, 'visual identity browser.version', 120),
      build: text(value.browser.build, 'visual identity browser.build', 160),
    },
    rendering: renderingContract(value.rendering),
  });
}

export function parseVisualCaptureMetadata(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'single-site-visual-capture') {
    throw new TypeError('Visual capture metadata must use schemaVersion 1 and kind single-site-visual-capture.');
  }
  exactKeys(value, [
    'schemaVersion', 'kind', 'attachmentName', 'attachmentOccurrence', 'identity', 'identityKey', 'slotKey',
  ], 'visual capture metadata');
  const identity = parseVisualBaselineIdentity(value.identity);
  const identityKey = visualBaselineIdentityKey(identity);
  const slotKey = visualBaselineSlotKey(identity);
  if (value.identityKey !== identityKey || value.slotKey !== slotKey) {
    throw new TypeError('Visual capture metadata identity digests disagree with its identity.');
  }
  if (!Number.isSafeInteger(value.attachmentOccurrence) || value.attachmentOccurrence < 0 || value.attachmentOccurrence > 10_000) {
    throw new TypeError('Visual capture metadata attachmentOccurrence must be a bounded non-negative integer.');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'single-site-visual-capture',
    attachmentName: text(value.attachmentName, 'visual capture metadata attachmentName', 300),
    attachmentOccurrence: value.attachmentOccurrence,
    identity,
    identityKey,
    slotKey,
  });
}

function slotBody(identity) {
  return {
    deploymentRole: identity.deploymentRole,
    route: identity.route,
    targetId: identity.targetId,
    viewport: identity.viewport,
    theme: identity.theme,
    auditId: identity.auditId,
    auditDefinitionDigest: identity.auditDefinitionDigest,
    capturePoint: identity.capturePoint,
  };
}

export function visualBaselineSlotKey(value) {
  return visualBaselineDigest(slotBody(parseVisualBaselineIdentity(value)));
}

export function visualBaselineIdentityKey(value) {
  return visualBaselineDigest(parseVisualBaselineIdentity(value));
}

export function compareVisualBaselineIdentity(baselineValue, currentValue) {
  const baseline = parseVisualBaselineIdentity(baselineValue);
  const current = parseVisualBaselineIdentity(currentValue);
  const differences = [];
  for (const field of ['deploymentRole', 'route', 'targetId', 'theme', 'auditId', 'auditDefinitionDigest', 'capturePoint']) {
    if (baseline[field] !== current[field]) differences.push(field);
  }
  if (baseline.viewport.width !== current.viewport.width || baseline.viewport.height !== current.viewport.height) {
    differences.push('viewport');
  }
  if (visualBaselineCanonicalJson(baseline.browser) !== visualBaselineCanonicalJson(current.browser)) {
    differences.push('browser-build');
  }
  if (baseline.rendering.fingerprint !== current.rendering.fingerprint) differences.push('rendering-fingerprint');
  return Object.freeze({
    compatible: differences.length === 0,
    differences,
    baselineSlotKey: visualBaselineDigest(slotBody(baseline)),
    currentSlotKey: visualBaselineDigest(slotBody(current)),
    baselineIdentityKey: visualBaselineDigest(baseline),
    currentIdentityKey: visualBaselineDigest(current),
    environmentChangeOnly: differences.length > 0
      && differences.every((field) => field === 'browser-build' || field === 'rendering-fingerprint'),
  });
}

export function parseVisualBaselineEvidence(value) {
  if (!isRecord(value)) throw new TypeError('Visual baseline evidence must be an object.');
  exactKeys(value, [
    'runId', 'artifactRelativePath', 'artifactSha256', 'artifactBytes', 'contentType', 'runStatus',
    'evidenceComplete', 'evidenceAuthority', 'findingStatus', 'findingWaiver',
  ], 'visual baseline evidence');
  if (value.contentType !== 'image/png') throw new TypeError('Visual baseline evidence must be image/png.');
  if (value.runStatus !== 'completed' || value.evidenceComplete !== true) {
    throw new TypeError('Visual baseline approval requires a completed run with complete evidence.');
  }
  if (!isRecord(value.evidenceAuthority) || !AUTHORITY.has(value.evidenceAuthority.status)
    || !Array.isArray(value.evidenceAuthority.reasons)) {
    throw new TypeError('Visual baseline evidence authority is invalid.');
  }
  exactKeys(value.evidenceAuthority, ['status', 'reasons'], 'visual baseline evidenceAuthority');
  const reasons = value.evidenceAuthority.reasons.map((reason, index) => text(reason, `evidenceAuthority.reasons[${index}]`, 160));
  if (new Set(reasons).size !== reasons.length
    || (value.evidenceAuthority.status === 'authoritative') !== (reasons.length === 0)) {
    throw new TypeError('Visual baseline evidence authority is contradictory.');
  }
  if (value.evidenceAuthority.status !== 'authoritative') {
    throw new TypeError('Non-authoritative evidence is not eligible for visual baseline approval.');
  }
  if (!['clear', 'unresolved'].includes(value.findingStatus)) throw new TypeError('Visual baseline findingStatus is invalid.');
  let findingWaiver = null;
  if (value.findingWaiver !== undefined && value.findingWaiver !== null) {
    if (!isRecord(value.findingWaiver)) throw new TypeError('Visual baseline findingWaiver must be an object.');
    exactKeys(value.findingWaiver, ['actorId', 'reason', 'at'], 'visual baseline findingWaiver');
    findingWaiver = {
      actorId: safeId(value.findingWaiver.actorId, 'visual baseline findingWaiver.actorId'),
      reason: text(value.findingWaiver.reason, 'visual baseline findingWaiver.reason', 1_200),
      at: parseTimestamp(value.findingWaiver.at, 'visual baseline findingWaiver.at'),
    };
  }
  if (value.findingStatus === 'unresolved' && findingWaiver === null) {
    throw new TypeError('Unresolved deterministic Findings require an explicit human waiver before baseline approval.');
  }
  if (value.findingStatus === 'clear' && findingWaiver !== null) {
    throw new TypeError('A Finding waiver is valid only when findingStatus is unresolved.');
  }
  return Object.freeze({
    runId: safeId(value.runId, 'visual baseline evidence runId'),
    artifactRelativePath: normalizedRelativePath(value.artifactRelativePath),
    artifactSha256: digest(value.artifactSha256, 'visual baseline evidence artifactSha256'),
    artifactBytes: positiveInteger(value.artifactBytes, 'visual baseline evidence artifactBytes', 100 * 1024 * 1024),
    contentType: 'image/png',
    runStatus: 'completed',
    evidenceComplete: true,
    evidenceAuthority: { status: 'authoritative', reasons: [] },
    findingStatus: value.findingStatus,
    findingWaiver,
  });
}

export function normalizedRelativePath(value) {
  const input = text(value, 'artifactRelativePath', 1_000);
  if (input.includes('\\') || input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
    throw new TypeError('artifactRelativePath must be a portable contained relative path.');
  }
  const segments = input.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TypeError('artifactRelativePath must be a portable contained relative path.');
  }
  return segments.join('/');
}

export function parseTimestamp(value, label = 'timestamp') {
  const result = text(value, label, 80);
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== result) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return result;
}

export function parseVisualReview(value) {
  if (!isRecord(value)) throw new TypeError('Visual review record must be an object.');
  exactKeys(value, ['status', 'comparisonStatus', 'reviewerId', 'disposition', 'reviewedAt'], 'visual review record');
  if (!VISUAL_REVIEW_STATUSES.has(value.status)) throw new TypeError('Visual review status is invalid.');
  if (value.status !== 'REVIEWED') {
    if (value.reviewerId !== null || value.disposition !== null || value.reviewedAt !== null) {
      throw new TypeError('Only REVIEWED visual status may contain a human disposition.');
    }
    if (['CHANGED', 'UNCHANGED'].includes(value.status) && value.comparisonStatus !== value.status) {
      throw new TypeError('An unreviewed compatible visual status must equal comparisonStatus.');
    }
    if (['absent', 'incompatible', 'unavailable'].includes(value.status) && value.comparisonStatus !== null) {
      throw new TypeError('A non-comparison visual status cannot contain comparisonStatus.');
    }
  } else {
    safeId(value.reviewerId, 'visual review reviewerId');
    text(value.disposition, 'visual review disposition', 1_200);
    parseTimestamp(value.reviewedAt, 'visual review reviewedAt');
    if (!['CHANGED', 'UNCHANGED'].includes(value.comparisonStatus)) {
      throw new TypeError('REVIEWED visual status must retain its original comparisonStatus.');
    }
  }
  return Object.freeze({ ...value });
}

export function assertVisualBaselineRecord(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !BASELINE_STATES.has(value.state)) {
    throw new TypeError('Visual baseline record is invalid.');
  }
  exactKeys(value, [
    'schemaVersion', 'baselineId', 'slotKey', 'identityKey', 'identity', 'state', 'source', 'media',
    'approvedBy', 'approvedAt', 'replacedBy', 'revokedAt', 'deletedAt', 'deletionReason',
  ], 'visual baseline record');
  const identity = parseVisualBaselineIdentity(value.identity);
  if (value.slotKey !== visualBaselineSlotKey(identity) || value.identityKey !== visualBaselineIdentityKey(identity)) {
    throw new TypeError('Visual baseline record identity digests disagree.');
  }
  safeId(value.baselineId, 'visual baseline record baselineId');
  parseVisualBaselineEvidence(value.source);
  if (!isRecord(value.media)) throw new TypeError('Visual baseline media is invalid.');
  exactKeys(value.media, ['relativePath', 'sha256', 'bytes', 'available'], 'visual baseline media');
  normalizedRelativePath(value.media.relativePath);
  digest(value.media.sha256, 'visual baseline media.sha256');
  positiveInteger(value.media.bytes, 'visual baseline media.bytes', 100 * 1024 * 1024);
  if (typeof value.media.available !== 'boolean') throw new TypeError('Visual baseline media.available must be boolean.');
  safeId(value.approvedBy, 'visual baseline approvedBy');
  parseTimestamp(value.approvedAt, 'visual baseline approvedAt');
  if (value.replacedBy !== null) safeId(value.replacedBy, 'visual baseline replacedBy');
  if (value.replacedBy !== null && value.revokedAt !== null) {
    throw new TypeError('A visual baseline cannot be both replaced and revoked.');
  }
  if (value.state === 'active' && (value.replacedBy !== null || value.revokedAt !== null
    || value.deletedAt !== null || value.deletionReason !== null || !value.media.available)) {
    throw new TypeError('Active visual baseline lifecycle fields are contradictory.');
  }
  if (value.state === 'replaced' && (!SAFE_ID.test(value.replacedBy ?? '') || value.revokedAt !== null
    || value.deletedAt !== null || value.deletionReason !== null || !value.media.available)) {
    throw new TypeError('Replaced visual baseline lifecycle fields are contradictory.');
  }
  if (value.state === 'revoked' && (value.replacedBy !== null || value.revokedAt === null
    || value.deletedAt !== null || value.deletionReason !== null || !value.media.available)) {
    throw new TypeError('Revoked visual baseline lifecycle fields are contradictory.');
  }
  if (value.revokedAt !== null) parseTimestamp(value.revokedAt, 'visual baseline revokedAt');
  if (value.deletedAt !== null) parseTimestamp(value.deletedAt, 'visual baseline deletedAt');
  if (value.deletionReason !== null) text(value.deletionReason, 'visual baseline deletionReason', 1_200);
  if ((value.state === 'deleted') !== (value.deletedAt !== null)
    || (value.state === 'deleted') !== (value.deletionReason !== null)
    || (value.state === 'deleted') === value.media.available) {
    throw new TypeError('Deleted visual baseline record must be a media-unavailable tombstone.');
  }
  return value;
}
