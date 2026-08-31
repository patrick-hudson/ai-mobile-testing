import {
  openAdoptedAttemptArtifact,
  readParentRun,
} from '../scripts/lib/parent-run-store.mjs';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import {
  GALLERY_CAPTURE_METADATA_CONTENT_TYPE,
  boundedGalleryText,
  deriveGalleryItemId,
  normalizeGalleryRoute,
} from '../shared/gallery-contract.mjs';
import {
  VISUAL_CAPTURE_METADATA_CONTENT_TYPE,
  parseVisualCaptureMetadata,
  parseVisualComparisonResult,
} from '../shared/visual-baseline-contract.mjs';

const INTERNAL = Symbol('shared-single-site-gallery-internal');
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$/;
const ITEM_ID = /^gitem_[a-f0-9]{16}$/;
const MEDIA_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/webm', 'video/mp4',
]);
const TERMINAL_WORK_STATES = new Set(['completed_pass', 'completed_product_failure', 'incomplete', 'cancelled']);
const VISUAL_STATES = new Set(['CHANGED', 'UNCHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable']);
const EVIDENCE_POLICY_MODES = new Set(['interaction-video', 'static-screenshot', 'structured-data']);
const MAX_GALLERY_ITEMS = 10_000;
const MAX_ARTIFACTS = 50_000;
const MAX_WORK_ITEMS = 20_000;
const MAX_STRUCTURED_DOCUMENTS = 20_000;
const MAX_STRUCTURED_JSON_BYTES = 32 * 1_048_576;
const MAX_SNAPSHOT_ATTEMPTS = 2;
const MAX_PAGE_ROWS = 100;
const MAX_PAGE_SCAN_ROWS = 100;
const MAX_PAGE_BYTES = 2 * 1_048_576;
const MAX_JSON_BYTES = 8 * 1_048_576;
const MAX_RETAINED_SNAPSHOTS_PER_STORE = 16;
const SNAPSHOT_CACHES = new WeakMap();

export class SharedSingleSiteGalleryError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'SharedSingleSiteGalleryError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function fail(statusCode, code, message, details) {
  throw new SharedSingleSiteGalleryError(statusCode, code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function active(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function text(value, fallback = '', maximum = 1_200) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized) return fallback;
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function translateStoreFailure(error) {
  if (error instanceof SharedSingleSiteGalleryError) throw error;
  if (error?.code === 'RUN_NOT_FOUND') {
    fail(404, 'SINGLE_SITE_GALLERY_RUN_NOT_FOUND', 'Canonical shared gallery run was not found.');
  }
  if (error?.code === 'RELEASE_AUTHORITY_TOMBSTONED') {
    fail(410, 'GALLERY_RUN_PURGED', 'This run and its canonical gallery evidence were permanently purged.');
  }
  if (error?.code === 'ATTEMPT_ARTIFACT_UNAVAILABLE') {
    fail(404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND', 'Canonical gallery media is unavailable.');
  }
  if (error?.code === 'ARTIFACT_DIGEST_MISMATCH') {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Canonical gallery evidence failed its immutable digest check.');
  }
  throw error;
}

async function storeCall(operation) {
  try { return await operation(); } catch (error) { return translateStoreFailure(error); }
}

function mediaKind(contentType) {
  return contentType.startsWith('video/') ? 'video' : 'image';
}

function mediaUrl(runId, itemId, view) {
  return `/api/single-site/runs/${encodeURIComponent(runId)}/gallery/items/${encodeURIComponent(itemId)}/media/${view}`;
}

function artifactPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || value.includes('\\') || value.includes('\0')) return null;
  const segments = value.split('/');
  return value.startsWith('/') || segments.some((segment) => !segment || segment === '.' || segment === '..') ? null : value;
}

function normalizeAttachment(value) {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  const contentType = text(value.contentType).toLowerCase();
  const pathname = artifactPath(value.path);
  if (!name || name.length > 240 || !pathname || !/^[a-z0-9][a-z0-9.+-]{0,126}\/[a-z0-9][a-z0-9.+-]{0,126}$/iu.test(contentType)) return null;
  return { name, contentType, path: pathname };
}

function normalizeCaptureMetadata(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.attachmentName !== 'string'
    || !Number.isSafeInteger(value.attachmentOccurrence) || value.attachmentOccurrence < 0
    || value.attachmentOccurrence > 10_000) return null;
  const attachmentName = boundedGalleryText(value.attachmentName, 300);
  if (!attachmentName) return null;
  const metadata = {
    attachmentName,
    attachmentOccurrence: value.attachmentOccurrence,
    attachmentKey: boundedGalleryText(value.attachmentKey, 300) ?? `${attachmentName}#${value.attachmentOccurrence}`,
    comparisonGroup: boundedGalleryText(value.comparisonGroup, 300),
    memberRole: ['baseline', 'actual', 'diff', 'other'].includes(value.memberRole) ? value.memberRole : 'single',
    capturedAt: typeof value.capturedAt === 'string' && Number.isFinite(Date.parse(value.capturedAt))
      ? new Date(value.capturedAt).toISOString() : null,
    route: normalizeGalleryRoute(value.route),
    observedState: boundedGalleryText(value.observedState),
    rationale: boundedGalleryText(value.rationale),
    derivativeOf: boundedGalleryText(value.derivativeOf, 300),
    viewport: isRecord(value.viewport) && Number.isFinite(value.viewport.width) && Number.isFinite(value.viewport.height)
      && value.viewport.width > 0 && value.viewport.height > 0
      ? { width: value.viewport.width, height: value.viewport.height } : null,
  };
  return metadata;
}

function normalizeEvidencePolicy(value) {
  if (!isRecord(value) || !EVIDENCE_POLICY_MODES.has(value.mode)) return null;
  const rationale = boundedGalleryText(value.rationale, 500);
  if (!rationale) return null;
  return Object.freeze({ mode: value.mode, rationale });
}

function canonicalPrimaryMetadata(attachment, artifact, occurrence, descriptor, evidencePolicy) {
  const attachmentKey = occurrence === 0 ? attachment.name : `${attachment.name}#${occurrence}`;
  return {
    attachmentName: attachment.name,
    attachmentOccurrence: occurrence,
    attachmentKey,
    comparisonGroup: null,
    memberRole: 'single',
    capturedAt: typeof artifact.completedAt === 'string' && Number.isFinite(Date.parse(artifact.completedAt))
      ? new Date(artifact.completedAt).toISOString() : null,
    route: normalizeGalleryRoute(descriptor?.route?.path),
    observedState: null,
    rationale: evidencePolicy?.rationale ?? null,
    derivativeOf: null,
    viewport: null,
    captureProvenance: 'canonical-primary-evidence',
  };
}

function captureKey(name, occurrence) {
  return `${name}\0${occurrence}`;
}

export function sharedParentExecutionTerminal(state) {
  if (!isRecord(state)) return false;
  const compilationTerminal = state.compilationState === 'sealed' || state.compilationFailure != null;
  if (!compilationTerminal) return false;
  const work = [
    ...(state.compilationBarrier ? [state.compilationBarrier] : []),
    ...Object.values(isRecord(state.workItems) ? state.workItems : {}),
  ];
  return work.length > 0 && work.every((item) => isRecord(item) && TERMINAL_WORK_STATES.has(item.state));
}

function sharedExecutionStatus(state) {
  if (!sharedParentExecutionTerminal(state)) return text(state?.status, 'active');
  const work = [
    ...(state.compilationBarrier ? [state.compilationBarrier] : []),
    ...Object.values(isRecord(state.workItems) ? state.workItems : {}),
  ];
  if (state.compilationFailure !== null || work.some(({ state: status }) => status === 'incomplete')) return 'incomplete';
  if (work.some(({ state: status }) => status === 'cancelled')) return 'cancelled';
  if (work.some(({ state: status }) => status === 'completed_product_failure')) return 'completed_product_failure';
  return 'completed_pass';
}

function rawLogArtifact(name) {
  const segments = String(name ?? '').replaceAll('\\', '/').split('/').filter(Boolean)
    .map((segment) => segment.toLowerCase());
  return segments.includes('logs') || segments.some((segment) => segment.endsWith('.log'));
}

function canonicalAttempt(item) {
  if (!isRecord(item?.canonicalResult) || !Array.isArray(item?.attempts)
    || !['completed_pass', 'completed_product_failure'].includes(item.state)) return null;
  for (let index = item.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = item.attempts[index];
    if (attempt?.outcome === item.state
      && attempt?.canonicalResultDigest === item.canonicalResult.digest
      && Array.isArray(attempt?.artifacts)) return attempt;
  }
  return null;
}

function artifactAccessKey(item, attempt, artifact, ordinal) {
  return canonicalDigest({
    schemaVersion: 1,
    kind: 'adopted-artifact-access-key',
    workItemId: item.id,
    canonicalResultDigest: item.canonicalResult.digest,
    attempt: attempt.attempt,
    ordinal,
    name: artifact.name,
    contentDigest: artifact.digest,
    memberDigest: artifact.memberDigest,
  });
}

export function assertSharedGalleryInventoryBudget({ workItems = 0, descriptors = 0 } = {}) {
  if (!Number.isSafeInteger(workItems) || workItems < 0 || workItems > MAX_WORK_ITEMS) {
    fail(413, 'SINGLE_SITE_GALLERY_ITEM_TOO_LARGE', `Canonical shared gallery exceeds its ${MAX_WORK_ITEMS}-work-item bound.`);
  }
  if (!Number.isSafeInteger(descriptors) || descriptors < 0 || descriptors > MAX_ARTIFACTS) {
    fail(413, 'SINGLE_SITE_GALLERY_ITEM_TOO_LARGE', `Canonical shared gallery exceeds its ${MAX_ARTIFACTS}-descriptor scan bound.`);
  }
}

export function consumeSharedGalleryStructuredBudget(work, sizeBytes) {
  if (!isRecord(work) || !Number.isSafeInteger(work.structuredDocumentsRead)
    || !Number.isSafeInteger(work.structuredJsonBytesRead)
    || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0
    || work.structuredDocumentsRead + 1 > MAX_STRUCTURED_DOCUMENTS
    || work.structuredJsonBytesRead + sizeBytes > MAX_STRUCTURED_JSON_BYTES) {
    fail(413, 'SINGLE_SITE_GALLERY_STRUCTURED_BUDGET_EXCEEDED',
      `Canonical shared gallery exceeds its ${MAX_STRUCTURED_DOCUMENTS}-document or ${MAX_STRUCTURED_JSON_BYTES}-byte structured-data budget.`);
  }
  work.structuredDocumentsRead += 1;
  work.structuredJsonBytesRead += sizeBytes;
}

function authoritativeArtifacts(runId, state, work, signal) {
  const items = [
    ...(state.compilationBarrier ? [state.compilationBarrier] : []),
    ...Object.values(isRecord(state.workItems) ? state.workItems : {}),
  ];
  assertSharedGalleryInventoryBudget({ workItems: items.length, descriptors: 0 });
  const artifacts = [];
  for (const item of items.sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    active(signal);
    work.galleryInventoryWorkItemsScanned += 1;
    if (!Array.isArray(item?.attempts)) continue;
    for (const attempt of item.attempts) {
      if (!Array.isArray(attempt?.artifacts)) continue;
      work.galleryInventoryDescriptorsScanned += attempt.artifacts.length;
      assertSharedGalleryInventoryBudget({
        workItems: work.galleryInventoryWorkItemsScanned,
        descriptors: work.galleryInventoryDescriptorsScanned,
      });
    }
    const attempt = canonicalAttempt(item);
    if (!attempt) continue;
    for (let index = 0; index < attempt.artifacts.length; index += 1) {
      const artifact = attempt.artifacts[index];
      if (!isRecord(artifact) || typeof artifact.name !== 'string' || typeof artifact.logicalName !== 'string'
        || typeof artifact.mediaType !== 'string' || !Number.isSafeInteger(artifact.sizeBytes)
        || artifact.sizeBytes < 0 || typeof artifact.digest !== 'string' || typeof artifact.memberDigest !== 'string') {
        fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `Canonical work item ${item.id} has an invalid artifact descriptor.`);
      }
      if (rawLogArtifact(artifact.name)) continue;
      artifacts.push(Object.freeze({
        runId,
        workItemId: item.id,
        attempt: attempt.attempt,
        authoritative: true,
        diagnosticExecutionId: null,
        completedAt: attempt.completedAt,
        name: artifact.name,
        logicalName: artifact.logicalName,
        purpose: artifact.purpose,
        mediaType: artifact.mediaType,
        sizeBytes: artifact.sizeBytes,
        digest: artifact.digest,
        memberDigest: artifact.memberDigest,
        artifactKey: artifactAccessKey(item, attempt, artifact, index + 1),
      }));
    }
  }
  work.galleryInventoryRowsRead = artifacts.length;
  work.galleryFullInventoryLoaded = true;
  return artifacts;
}

function descriptorIndex(artifacts) {
  const byWorkItem = new Map();
  for (const artifact of artifacts) {
    let byName = byWorkItem.get(artifact.workItemId);
    if (!byName) byWorkItem.set(artifact.workItemId, byName = new Map());
    if (byName.has(artifact.name)) {
      fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `Canonical work item ${artifact.workItemId} has duplicate artifact names.`);
    }
    byName.set(artifact.name, artifact);
  }
  return byWorkItem;
}

async function readJson(context, descriptor, maximumBytes = MAX_JSON_BYTES) {
  const { store, runId, work, jsonCache } = context;
  if (!descriptor || descriptor.mediaType !== 'application/json'
    && descriptor.mediaType !== GALLERY_CAPTURE_METADATA_CONTENT_TYPE
    && descriptor.mediaType !== VISUAL_CAPTURE_METADATA_CONTENT_TYPE) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Canonical gallery JSON has a missing or incompatible artifact binding.');
  }
  const cached = jsonCache.get(descriptor.artifactKey);
  if (cached !== undefined) return cached;
  if (!Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes < 2 || descriptor.sizeBytes > maximumBytes) {
    fail(413, 'SINGLE_SITE_GALLERY_STRUCTURED_BUDGET_EXCEEDED',
      `Canonical gallery JSON ${descriptor.name} exceeds its ${maximumBytes}-byte document bound.`);
  }
  consumeSharedGalleryStructuredBudget(work, descriptor.sizeBytes);
  let opened;
  try {
    const result = await storeCall(() => openAdoptedAttemptArtifact(store, runId, {
      workItemId: descriptor.workItemId,
      artifactKey: descriptor.artifactKey,
    }));
    opened = result.opened;
    if (result.descriptor.name !== descriptor.name || result.descriptor.digest !== descriptor.digest
      || result.descriptor.sizeBytes !== descriptor.sizeBytes || result.descriptor.mediaType !== descriptor.mediaType) {
      fail(409, 'SINGLE_SITE_GALLERY_REVISION_STALE', 'Canonical gallery artifact binding changed during projection.');
    }
    const bytes = await opened.handle.readFile();
    if (bytes.length !== descriptor.sizeBytes) {
      fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `Canonical gallery JSON ${descriptor.name} changed while being read.`);
    }
    let document;
    try { document = JSON.parse(bytes.toString('utf8')); } catch {
      fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `Canonical gallery JSON ${descriptor.name} is malformed.`);
    }
    jsonCache.set(descriptor.artifactKey, document);
    return document;
  } finally {
    await opened?.handle?.close().catch(() => undefined);
    await opened?.transferLease?.release?.().catch(() => undefined);
  }
}

function selectComparison(document, groupKey, comparisonGroup, groupCount) {
  if (!isRecord(document) || document.schemaVersion !== 1 || document.kind !== 'shared-visual-comparison-result'
    || !Array.isArray(document.items) || document.items.length < 1 || document.items.length > 256) return null;
  const parsed = [];
  for (const value of document.items) {
    try {
      if (!isRecord(value) || typeof value.id !== 'string') continue;
      parsed.push({ id: value.id, comparison: parseVisualComparisonResult(value.comparison) });
    } catch {
      // Invalid comparison rows cannot grant visual status to canonical media.
    }
  }
  if (parsed.length === 1 && (groupCount === 1 || comparisonGroup)) return parsed[0];
  return parsed.find(({ id }) => groupKey === id || groupKey.startsWith(`${id}-`) || groupKey.includes(id)) ?? null;
}

function defaultComparison(kind) {
  return kind === 'video'
    ? {
        schemaVersion: 1,
        status: 'absent',
        reason: 'Interaction videos are behavior evidence and do not receive pixel-baseline comparisons.',
        review: null,
      }
    : {
        schemaVersion: 1,
        status: 'absent',
        reason: 'No canonical shared visual comparison is bound to this capture.',
        review: null,
      };
}

function catalogEntry(catalog, auditId) {
  return (Array.isArray(catalog) ? catalog : []).find(({ id }) => id === auditId) ?? null;
}

function auditContext({ audit, auditId, row, findingCount }) {
  const severity = /^P[0-3]$/u.test(audit?.severity ?? '') ? audit.severity : 'P3';
  return {
    auditId,
    title: audit?.title ?? auditId,
    area: audit?.area ?? 'Uncategorized',
    status: row.status,
    findingCount,
    evidenceStatus: 'available',
    severity,
    coverageReasons: [],
  };
}

export function classifySharedGalleryGroupMembers(members) {
  const source = Array.isArray(members) ? members : [];
  const withRole = (role) => source.filter((member) => member?.metadata?.memberRole === role);
  const currentMembers = source.filter((member) => ['actual', 'single'].includes(member?.metadata?.memberRole));
  const baselineMembers = withRole('baseline');
  const diffMembers = withRole('diff');
  const otherMembers = withRole('other');
  const reasons = [];
  if (currentMembers.length === 0) {
    if (baselineMembers.length > 0 && diffMembers.length === 0) {
      reasons.push('Comparison group contains baseline media but no actual/single current member.');
    } else if (diffMembers.length > 0 && baselineMembers.length === 0) {
      reasons.push('Comparison group contains difference media but no actual/single current member.');
    } else {
      reasons.push('Comparison group has no actual/single current member.');
    }
  } else if (currentMembers.length > 1) {
    reasons.push(`Comparison group has ${currentMembers.length} actual/single current members; exactly one is required.`);
  }
  if (baselineMembers.length > 1) reasons.push(`Comparison group has ${baselineMembers.length} baseline members.`);
  if (diffMembers.length > 1) reasons.push(`Comparison group has ${diffMembers.length} difference members.`);
  const current = currentMembers.length === 1 ? currentMembers[0] : null;
  return Object.freeze({
    current,
    baseline: baselineMembers.length === 1 ? baselineMembers[0] : null,
    diff: diffMembers.length === 1 ? diffMembers[0] : null,
    representative: current ?? baselineMembers[0] ?? diffMembers[0] ?? otherMembers[0] ?? source[0] ?? null,
    valid: current !== null && reasons.length === 0,
    reasons: Object.freeze(reasons),
    counts: Object.freeze({
      current: currentMembers.length,
      baseline: baselineMembers.length,
      diff: diffMembers.length,
      other: otherMembers.length,
    }),
  });
}

function buildItem({
  runId, state, workItem, row, evidencePolicy, auditRecord, visualComparison, group, groupCount, auditCatalog,
}) {
  const descriptor = workItem?.executionDescriptor ?? null;
  const mediaGroup = classifySharedGalleryGroupMembers(group.members);
  const representative = mediaGroup.representative;
  if (!representative) return null;
  const current = mediaGroup.current;
  const diff = mediaGroup.diff;
  const kind = mediaKind(representative.artifact.mediaType);
  const comparisonEntry = kind === 'image' && current
    ? selectComparison(visualComparison, group.key, group.comparisonGroup, groupCount)
    : null;
  const comparison = mediaGroup.valid
    ? comparisonEntry?.comparison ?? defaultComparison(kind)
    : {
        schemaVersion: 1,
        status: 'unavailable',
        reason: mediaGroup.reasons.join(' '),
        review: null,
      };
  const visualStatus = VISUAL_STATES.has(comparison.status) ? comparison.status : 'unavailable';
  const visualCapture = representative.visualCapture ?? null;
  const identity = visualCapture?.identity ?? null;
  const auditId = text(descriptor?.definitionId, text(auditRecord?.auditId, 'UNKNOWN'));
  const audit = catalogEntry(auditCatalog, auditId);
  const descriptorCaseId = text(descriptor?.caseId);
  const rowCaseId = text(row.caseId);
  const auditCaseId = text(auditRecord?.caseId);
  const caseId = descriptorCaseId || rowCaseId || auditCaseId || 'unknown';
  const caseIdSource = descriptorCaseId ? 'shared-execution-descriptor'
    : rowCaseId ? 'canonical-work-item-row'
      : auditCaseId ? 'canonical-audit-result' : 'unknown';
  const descriptorTargetId = text(descriptor?.targetId);
  const rowTargetId = text(row.projectName);
  const workItemTargetId = text(workItem?.targetId);
  const targetId = descriptorTargetId || rowTargetId || workItemTargetId || 'unknown';
  const targetIdSource = descriptorTargetId ? 'shared-execution-descriptor'
    : rowTargetId ? 'canonical-work-item-row'
      : workItemTargetId ? 'canonical-work-item-record' : 'unknown';
  const coverageReasons = [
    ...(caseIdSource === 'unknown' ? ['Canonical media is not mapped to an audit case.'] : []),
    ...(targetIdSource === 'unknown' ? ['Canonical media is not mapped to an execution target.'] : []),
    ...mediaGroup.reasons,
  ];
  const coverageGap = coverageReasons.length > 0;
  const findingRows = Array.isArray(auditRecord?.findings) ? auditRecord.findings : [];
  const findingCount = Math.max(findingRows.length, row.status === 'passed' ? 0 : 1);
  const itemId = deriveGalleryItemId({
    sourceTestId: caseId,
    project: targetId,
    attempt: representative.artifact.attempt,
    retry: Number.isSafeInteger(row.retry) ? row.retry : 0,
    attachmentKey: group.key,
  });
  const route = identity?.route ?? representative.metadata.route ?? descriptor?.route?.path ?? 'unknown';
  const capturePoint = identity?.capturePoint ?? representative.metadata.attachmentKey ?? representative.attachment.name;
  const severity = /^P[0-3]$/u.test(audit?.severity ?? '') ? audit.severity : 'P3';
  const suite = audit?.area ?? descriptor?.pluginId ?? 'Uncategorized';
  const context = { ...auditContext({ audit, auditId, row, findingCount }), coverageReasons };
  const currentUrl = current ? mediaUrl(runId, itemId, 'current') : null;
  const diffUrl = diff ? mediaUrl(runId, itemId, 'diff') : null;
  const eligible = false;
  const ineligibilityReasons = [kind === 'video'
    ? 'Interaction video evidence cannot become a pixel baseline.'
    : 'Baseline mutations are unavailable from the canonical shared gallery projection.'];
  return {
    public: Object.freeze({
      schemaVersion: 1,
      mode: 'single-site',
      itemId,
      kind,
      title: text(row.title, audit?.title ?? auditId),
      suite,
      auditId,
      auditIds: [auditId],
      auditTitle: audit?.title ?? auditId,
      caseId,
      caseIdSource,
      targetId,
      targetIdSource,
      route,
      capturePoint,
      captureProvenance: mediaGroup.valid
        ? representative.metadata.captureProvenance ?? 'gallery-capture-metadata'
        : 'malformed-comparison-group',
      evidencePolicy,
      theme: identity?.theme ?? 'unknown',
      severity,
      severitySource: audit ? 'audit-catalog' : 'unknown-default',
      audits: [context],
      findingCount,
      findingCountScope: 'exact-visual-execution',
      findingStatus: findingCount > 0 ? 'unresolved' : 'clear',
      coverageGap,
      coverageStatus: coverageGap ? 'gap' : 'covered',
      coverageReasons,
      mediaGroup: mediaGroup.counts,
      visualReviewStatus: visualStatus,
      comparison,
      visualComparisonItemId: comparisonEntry?.id ?? null,
      identity,
      identityKey: visualCapture?.identityKey ?? null,
      slotKey: visualCapture?.slotKey ?? null,
      evidenceId: null,
      evidence: null,
      eligible,
      ineligibilityReasons,
      current: current ? {
        bytes: current.artifact.sizeBytes,
        sha256: current.artifact.digest,
        contentType: current.artifact.mediaType,
      } : null,
      baseline: null,
      diff: diff ? { bytes: diff.artifact.sizeBytes, sha256: diff.artifact.digest } : null,
      staleComparisonWithheld: false,
      attentionRequired: coverageGap || findingCount > 0
        || ['CHANGED', 'incompatible', 'unavailable'].includes(visualStatus),
      urls: { current: currentUrl, baseline: null, diff: diffUrl, poster: null },
      capturedAt: representative.metadata.capturedAt,
      viewport: representative.metadata.viewport,
      testContext: {
        testId: caseId,
        file: text(row.entrySpec, text(descriptor?.entrySpec)),
        technicalSuite: auditId,
        expected: audit?.expected ?? audit?.userPromise ?? null,
        observed: representative.metadata.observedState,
        rationale: representative.metadata.rationale ?? evidencePolicy?.rationale ?? null,
        evidencePolicy,
        attempt: { ordinal: representative.artifact.attempt, retry: Number.isSafeInteger(row.retry) ? row.retry : 0, status: row.status },
        project: { name: targetId, deploymentRole: descriptor?.targetRole ?? state.subjectCore?.targets?.[0]?.role ?? null },
      },
    }),
    media: Object.freeze({ current: current?.artifact ?? null, diff: diff?.artifact ?? null }),
  };
}

async function projectWorkItem({ context, state, workItemId, descriptors, auditCatalog, signal }) {
  const { work } = context;
  const rowDescriptors = [...descriptors.values()].filter(({ logicalName, name }) => (
    logicalName === 'work-item-rows' || name.endsWith('/work-item-rows.json')
  ));
  if (rowDescriptors.length === 0) return [];
  if (rowDescriptors.length !== 1) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `Canonical work item ${workItemId} has ambiguous structured rows.`);
  }
  active(signal);
  const workItem = state.workItems?.[workItemId] ?? null;
  const document = await readJson(context, rowDescriptors[0]);
  work.reportDocumentsRead += 1;
  if (!isRecord(document) || document.schemaVersion !== 1 || document.kind !== 'shared-work-item-rows'
    || document.workItemId !== workItemId
    || document.executionDescriptorDigest !== (workItem?.executionDescriptor?.digest ?? null)
    || !Array.isArray(document.rows) || document.rows.length !== 1) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `Canonical work item ${workItemId} rows are invalid.`);
  }
  const row = document.rows[0];
  if (!isRecord(row) || !['passed', 'failed', 'timedOut'].includes(row.status)
    || !Array.isArray(row.attachments) || row.attachments.length > 61
    || (workItem?.executionDescriptor && (
      row.caseId !== workItem.executionDescriptor.caseId
      || row.projectName !== workItem.executionDescriptor.targetId
      || row.entrySpec !== workItem.executionDescriptor.entrySpec
    ))) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `Canonical work item ${workItemId} test row is invalid.`);
  }
  const evidencePolicy = normalizeEvidencePolicy(row.evidencePolicy);
  const attachments = row.attachments.map(normalizeAttachment);
  if (attachments.some((attachment) => attachment === null)) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `Canonical work item ${workItemId} attachment index is invalid.`);
  }
  for (const attachment of attachments) {
    const artifact = descriptors.get(attachment.path);
    if (!artifact || artifact.mediaType !== attachment.contentType) {
      fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `Canonical work item ${workItemId} attachment binding is incomplete.`);
    }
  }
  const captureMetadata = new Map();
  const visualMetadata = new Map();
  let auditRecord = null;
  let visualComparison = null;
  for (const attachment of attachments) {
    active(signal);
    if (attachment.contentType === GALLERY_CAPTURE_METADATA_CONTENT_TYPE) {
      const metadata = normalizeCaptureMetadata(await readJson(context, descriptors.get(attachment.path), 1_048_576));
      work.reportDocumentsRead += 1;
      if (metadata) captureMetadata.set(captureKey(metadata.attachmentName, metadata.attachmentOccurrence), metadata);
    } else if (attachment.contentType === VISUAL_CAPTURE_METADATA_CONTENT_TYPE) {
      const document = await readJson(context, descriptors.get(attachment.path), 1_048_576);
      try {
        const metadata = parseVisualCaptureMetadata(document);
        visualMetadata.set(captureKey(metadata.attachmentName, metadata.attachmentOccurrence), metadata);
      } catch {
        // Invalid baseline metadata cannot grant identity or mutation eligibility.
      }
      work.reportDocumentsRead += 1;
    } else if (attachment.name === 'audit-result' && attachment.contentType === 'application/json') {
      auditRecord = await readJson(context, descriptors.get(attachment.path));
      work.reportDocumentsRead += 1;
    } else if (attachment.name === 'shared-visual-comparison-result' && attachment.contentType === 'application/json') {
      visualComparison = await readJson(context, descriptors.get(attachment.path));
      work.reportDocumentsRead += 1;
    }
  }
  const occurrences = new Map();
  const groups = new Map();
  for (const attachment of attachments) {
    if (!MEDIA_TYPES.has(attachment.contentType)) continue;
    const occurrence = occurrences.get(attachment.name) ?? 0;
    occurrences.set(attachment.name, occurrence + 1);
    const key = captureKey(attachment.name, occurrence);
    const artifact = descriptors.get(attachment.path);
    let metadata = captureMetadata.get(key);
    if (!metadata) {
      if (artifact.purpose !== 'primary') continue;
      metadata = canonicalPrimaryMetadata(attachment, artifact, occurrence,
        workItem?.executionDescriptor ?? null, evidencePolicy);
    }
    const groupKey = metadata.comparisonGroup ?? metadata.derivativeOf ?? metadata.attachmentKey;
    const kind = mediaKind(artifact.mediaType);
    const identity = `${kind}\0${groupKey}`;
    let group = groups.get(identity);
    if (!group) groups.set(identity, group = { key: groupKey, comparisonGroup: metadata.comparisonGroup, members: [] });
    group.members.push({ attachment, artifact, metadata, visualCapture: visualMetadata.get(key) ?? null });
  }
  if (groups.size === 0) return [];
  return [...groups.values()].map((group) => buildItem({
    runId: context.runId, state, workItem, row, evidencePolicy, auditRecord, visualComparison,
    group, groupCount: groups.size, auditCatalog,
  })).filter(Boolean);
}

async function projectSnapshot({ store, runId, state, auditCatalog, signal, snapshotAttempt }) {
  const work = {
    snapshotAttempts: snapshotAttempt,
    reportDocumentsRead: 0,
    structuredDocumentsRead: 0,
    structuredJsonBytesRead: 0,
    galleryDetailReads: 0,
    galleryInventoryRowsRead: 0,
    galleryInventoryDescriptorsScanned: 0,
    galleryInventoryWorkItemsScanned: 0,
    galleryInventoryPagesRead: 0,
    galleryFullInventoryLoaded: false,
    inventorySource: 'revision-pinned-parent-state',
  };
  const artifacts = authoritativeArtifacts(runId, state, work, signal);
  const byWorkItem = descriptorIndex(artifacts);
  const context = { store, runId, work, jsonCache: new Map() };
  const projected = [];
  for (const [workItemId, descriptors] of [...byWorkItem.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    active(signal);
    projected.push(...await projectWorkItem({
      context, state, workItemId, descriptors, auditCatalog, signal,
    }));
    if (projected.length > MAX_GALLERY_ITEMS) {
      fail(413, 'SINGLE_SITE_GALLERY_ITEM_TOO_LARGE', `Canonical shared gallery exceeds its ${MAX_GALLERY_ITEMS}-item bound.`);
    }
  }
  projected.sort((left, right) => (
    left.public.suite.localeCompare(right.public.suite)
    || left.public.auditId.localeCompare(right.public.auditId)
    || left.public.caseId.localeCompare(right.public.caseId)
    || left.public.capturePoint.localeCompare(right.public.capturePoint)
    || left.public.itemId.localeCompare(right.public.itemId)
  ));
  const indexDigest = canonicalDigest(projected.map(({ public: item, media }) => ({
    itemId: item.itemId,
    current: media.current?.digest ?? null,
    diff: media.diff?.digest ?? null,
    coverageReasons: item.coverageReasons,
  })));
  const publicationDigest = canonicalDigest({
    schemaVersion: 1,
    kind: 'shared-single-site-gallery-projection',
    runId,
    stateRevision: state.runRevision,
    indexDigest,
  });
  return { artifacts, projected, work, indexDigest, publicationDigest };
}

function staleSnapshot(startRevision, currentRevision) {
  fail(409, 'SINGLE_SITE_GALLERY_REVISION_STALE',
    `Canonical shared gallery moved from run revision ${startRevision} to ${currentRevision} while its snapshot was being built.`);
}

export async function openSharedSingleSiteGallery({
  store, runId, auditCatalog = [], signal, snapshotHooks = null,
} = {}) {
  if (!store || typeof runId !== 'string' || !RUN_ID.test(runId)) {
    fail(400, 'SINGLE_SITE_GALLERY_INPUT_INVALID', 'A canonical shared store and valid run ID are required.');
  }
  let cache = SNAPSHOT_CACHES.get(store);
  if (!cache) SNAPSHOT_CACHES.set(store, cache = new Map());
  for (let snapshotAttempt = 1; snapshotAttempt <= MAX_SNAPSHOT_ATTEMPTS; snapshotAttempt += 1) {
    active(signal);
    const state = await storeCall(() => readParentRun(store, runId));
    if (state.subjectCore?.mode !== 'single-site') {
      fail(422, 'SINGLE_SITE_GALLERY_MODE_INVALID', 'Canonical shared gallery projection requires a Single-site parent run.');
    }
    await snapshotHooks?.afterStateRead?.({ snapshotAttempt, stateRevision: state.runRevision });
    const retained = cache.get(runId);
    if (retained?.[INTERNAL]?.state?.runRevision === state.runRevision) {
      const confirmed = await storeCall(() => readParentRun(store, runId));
      if (confirmed.runRevision === state.runRevision) {
        cache.delete(runId);
        cache.set(runId, retained);
        return retained;
      }
      cache.delete(runId);
      if (snapshotAttempt === MAX_SNAPSHOT_ATTEMPTS) staleSnapshot(state.runRevision, confirmed.runRevision);
      continue;
    }
    let projection;
    try {
      projection = await projectSnapshot({ store, runId, state, auditCatalog, signal, snapshotAttempt });
      await snapshotHooks?.beforeRevisionConfirmation?.({ snapshotAttempt, stateRevision: state.runRevision });
    } catch (error) {
      const current = await storeCall(() => readParentRun(store, runId));
      if (current.runRevision !== state.runRevision) {
        cache.delete(runId);
        if (snapshotAttempt === MAX_SNAPSHOT_ATTEMPTS) staleSnapshot(state.runRevision, current.runRevision);
        continue;
      }
      throw error;
    }
    const confirmed = await storeCall(() => readParentRun(store, runId));
    if (confirmed.runRevision !== state.runRevision) {
      cache.delete(runId);
      if (snapshotAttempt === MAX_SNAPSHOT_ATTEMPTS) staleSnapshot(state.runRevision, confirmed.runRevision);
      continue;
    }
    const publicationRevision = projection.publicationDigest.slice('sha256:'.length, 'sha256:'.length + 32);
    const snapshot = {
      schemaVersion: 1,
      mode: 'single-site',
      authority: 'canonical-shared-parent-run',
      jobId: runId,
      publicationRevision,
      galleryExportRevision: publicationRevision,
      baselineStoreRevision: 0,
      reviewRevision: 0,
    };
    Object.defineProperty(snapshot, INTERNAL, {
      enumerable: false,
      value: {
        store, runId, state, artifacts: projection.artifacts, items: projection.projected,
        byId: new Map(projection.projected.map((entry) => [entry.public.itemId, entry])),
        work: projection.work, indexDigest: projection.indexDigest,
        publicationDigest: projection.publicationDigest,
      },
    });
    const frozen = Object.freeze(snapshot);
    cache.delete(runId);
    cache.set(runId, frozen);
    while (cache.size > MAX_RETAINED_SNAPSHOTS_PER_STORE) cache.delete(cache.keys().next().value);
    return frozen;
  }
  throw new Error('Unreachable shared gallery snapshot retry state.');
}

export function isSharedSingleSiteGallerySnapshot(snapshot) {
  return Boolean(isRecord(snapshot) && snapshot.authority === 'canonical-shared-parent-run' && snapshot[INTERNAL]);
}

function internal(snapshot) {
  if (!isSharedSingleSiteGallerySnapshot(snapshot)) {
    fail(500, 'SINGLE_SITE_GALLERY_SNAPSHOT_INVALID', 'Canonical shared gallery snapshot is invalid.');
  }
  return snapshot[INTERNAL];
}

export function sharedSingleSiteGalleryHead(snapshot, { mutationAuthorized = false } = {}) {
  const value = internal(snapshot);
  const counts = {
    total: value.items.length,
    images: value.items.filter(({ public: item }) => item.kind === 'image').length,
    videos: value.items.filter(({ public: item }) => item.kind === 'video').length,
  };
  const suites = [...new Set(value.items.map(({ public: item }) => item.suite))].sort();
  const kinds = [...new Set(value.items.map(({ public: item }) => item.kind))].sort();
  const terminal = sharedParentExecutionTerminal(value.state);
  const executionStatus = sharedExecutionStatus(value.state);
  const knownCaseMappings = value.items.filter(({ public: item }) => item.caseIdSource !== 'unknown').length;
  const unknownCaseMappings = counts.total - knownCaseMappings;
  const unmappedCoverageGapCount = value.items.filter(({ public: item }) => item.coverageGap).length;
  return {
    schemaVersion: 1,
    mode: 'single-site',
    phase: terminal ? 'sealed' : 'live',
    status: executionStatus,
    lifecycle: { status: executionStatus, terminal },
    publicationRevision: snapshot.publicationRevision,
    publicationDigest: value.publicationDigest,
    galleryExportRevision: snapshot.galleryExportRevision,
    galleryIndexDigest: value.indexDigest,
    baselineStoreRevision: 0,
    reviewRevision: 0,
    mutationCapability: {
      authorized: false,
      actorSource: mutationAuthorized ? 'shared-control-workspace' : 'read-only-shared-projection',
    },
    primaryCounts: counts,
    summary: counts,
    caseMapping: {
      known: knownCaseMappings,
      unknown: unknownCaseMappings,
      source: 'canonical-work-item-identity',
    },
    facets: {
      suites,
      kinds,
      visualStatuses: ['CHANGED', 'UNCHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable'],
      findingStates: ['clear', 'unresolved'],
      coverageStates: ['covered', 'gap'],
    },
    unmappedCoverageGapCount,
    sourceWork: { ...value.work },
    maximumItems: MAX_GALLERY_ITEMS,
    sharedAuthority: { stateRevision: value.state.runRevision, immutableArtifacts: true },
  };
}

function validateRevision(snapshot, options) {
  if ((options.revision !== undefined && options.revision !== snapshot.publicationRevision)
    || (options.baselineStoreRevision !== undefined && options.baselineStoreRevision !== 0)
    || (options.reviewRevision !== undefined && options.reviewRevision !== 0)) {
    fail(409, 'SINGLE_SITE_GALLERY_REVISION_STALE', 'The requested canonical shared gallery revision is no longer current.');
  }
}

const FILTERS = Object.freeze({
  scope: new Set(['attention', 'all']),
  kind: new Set(['', 'image', 'video']),
  finding: new Set(['', 'all', 'finding', 'clear']),
  coverage: new Set(['', 'all', 'gap', 'covered']),
  visual: new Set(['', 'all', 'CHANGED', 'UNCHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable']),
});

function pageFilters(options) {
  const result = {};
  for (const [name, values] of Object.entries(FILTERS)) {
    const fallback = name === 'scope' ? 'all' : name === 'kind' ? '' : 'all';
    const value = options[name] ?? fallback;
    if (typeof value !== 'string' || !values.has(value)) {
      fail(400, 'SINGLE_SITE_GALLERY_PAGE_INVALID', `Gallery ${name} filter is invalid.`);
    }
    result[name] = value;
  }
  for (const name of ['suite', 'query']) {
    const value = options[name] ?? '';
    if (typeof value !== 'string' || value.length > 1_200 || /[\u0000-\u001f\u007f]/u.test(value)) {
      fail(400, 'SINGLE_SITE_GALLERY_PAGE_INVALID', `Gallery ${name} filter is invalid.`);
    }
    result[name] = value.trim();
  }
  return result;
}

function matches(item, filters) {
  if (filters.scope === 'attention' && !item.attentionRequired) return false;
  if (filters.kind && item.kind !== filters.kind) return false;
  if (filters.suite && item.suite !== filters.suite) return false;
  if (!['', 'all'].includes(filters.finding)
    && (filters.finding === 'finding' ? item.findingCount < 1 : item.findingCount > 0)) return false;
  if (!['', 'all'].includes(filters.coverage)
    && (filters.coverage === 'gap' ? !item.coverageGap : item.coverageGap)) return false;
  if (!['', 'all'].includes(filters.visual) && item.visualReviewStatus !== filters.visual) return false;
  const query = filters.query.toLocaleLowerCase();
  return !query || [item.title, item.auditId, item.caseId, item.suite, item.route, item.capturePoint, item.targetId]
    .some((value) => String(value ?? '').toLocaleLowerCase().includes(query));
}

export async function pageSharedSingleSiteGalleryItems(snapshot, options = {}) {
  const value = internal(snapshot);
  active(options.signal);
  validateRevision(snapshot, options);
  const limit = options.limit ?? 50;
  let offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_ROWS) {
    fail(400, 'SINGLE_SITE_GALLERY_PAGE_INVALID', `Gallery offset must be non-negative and limit must be between 1 and ${MAX_PAGE_ROWS}.`);
  }
  const filters = pageFilters(options);
  const total = value.items.length;
  let anchorIndex = -1;
  if (options.anchorItemId !== undefined && options.anchorItemId !== null) {
    if (typeof options.anchorItemId !== 'string' || !ITEM_ID.test(options.anchorItemId)) {
      fail(400, 'SINGLE_SITE_GALLERY_PAGE_INVALID', 'Gallery anchor item ID is invalid.');
    }
    anchorIndex = value.items.findIndex(({ public: item }) => item.itemId === options.anchorItemId);
    if (anchorIndex < 0) fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery anchor item was not found.');
    offset = Math.max(0, Math.min(anchorIndex - Math.floor(limit / 2), Math.max(0, total - limit)));
  }
  const scanEnd = Math.min(total, offset + MAX_PAGE_SCAN_ROWS);
  const items = [];
  let nextOffset = offset;
  let anchorExcluded = false;
  for (let index = offset; index < scanEnd; index += 1) {
    active(options.signal);
    const item = value.items[index].public;
    const matched = matches(item, filters);
    const anchored = index === anchorIndex;
    if (anchored && !matched) anchorExcluded = true;
    if (anchored || (matched && items.length < limit
      && !(anchorIndex >= 0 && index < anchorIndex && items.length >= limit - 1))) items.push(item);
    nextOffset = index + 1;
    if (items.length >= limit && (anchorIndex < 0 || index >= anchorIndex)) break;
  }
  const result = {
    schemaVersion: 1,
    mode: 'single-site',
    publicationRevision: snapshot.publicationRevision,
    baselineStoreRevision: 0,
    reviewRevision: 0,
    items,
    total,
    filteredTotal: offset === 0 && nextOffset >= total ? items.length : null,
    offset,
    limit,
    hasMore: nextOffset < total,
    nextOffset,
    hasPrevious: offset > 0,
    previousOffset: Math.max(0, offset - limit),
    queuePosition: anchorIndex < 0 ? null : {
      itemId: options.anchorItemId,
      sourceOrdinal: anchorIndex + 1,
      sourceTotal: total,
      pageOrdinal: Math.max(0, items.findIndex(({ itemId }) => itemId === options.anchorItemId)) + 1,
    },
    anchorExcluded,
    scan: { offset, nextOffset, rows: nextOffset - offset, complete: offset === 0 && nextOffset >= total },
    sourceWork: { ...value.work },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_PAGE_BYTES) {
    fail(413, 'SINGLE_SITE_GALLERY_ITEM_TOO_LARGE', 'Canonical shared gallery page exceeds its response byte bound.');
  }
  return result;
}

export async function readSharedSingleSiteGalleryItem(snapshot, itemId, options = {}) {
  const value = internal(snapshot);
  active(options.signal);
  validateRevision(snapshot, options);
  if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) {
    fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery item not found.');
  }
  const entry = value.byId.get(itemId);
  if (!entry) fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery item not found.');
  value.work.galleryDetailReads += 1;
  return { item: entry.public, sourceWork: { ...value.work } };
}

export async function resolveSharedSingleSiteGalleryMedia(snapshot, itemId, view, { signal } = {}) {
  const value = internal(snapshot);
  active(signal);
  if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) {
    fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery item not found.');
  }
  if (!['current', 'diff'].includes(view)) {
    fail(404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND', 'Gallery media view not found.');
  }
  const expected = value.byId.get(itemId)?.media?.[view] ?? null;
  if (!expected) fail(404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND', 'Gallery media is unavailable.');
  const opened = await storeCall(() => openAdoptedAttemptArtifact(value.store, value.runId, {
    workItemId: expected.workItemId,
    artifactKey: expected.artifactKey,
  }));
  if (opened.descriptor.digest !== expected.digest || opened.descriptor.sizeBytes !== expected.sizeBytes
    || opened.descriptor.mediaType !== expected.mediaType || opened.descriptor.name !== expected.name) {
    await opened.opened.handle.close().catch(() => undefined);
    await opened.opened.transferLease?.release?.().catch(() => undefined);
    fail(409, 'SINGLE_SITE_GALLERY_MEDIA_GONE', 'Canonical gallery media changed after projection.');
  }
  const descriptor = {
    contentType: expected.mediaType,
    bytes: expected.sizeBytes,
    sha256: expected.digest,
    etag: `"${expected.digest.slice('sha256:'.length)}"`,
  };
  Object.defineProperty(descriptor, 'absolutePath', { value: opened.opened.path, enumerable: false });
  Object.defineProperty(descriptor, 'opened', { value: opened.opened, enumerable: false });
  return Object.freeze(descriptor);
}
