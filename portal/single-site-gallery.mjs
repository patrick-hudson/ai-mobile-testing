import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  loadGallerySnapshot,
  readGalleryItem,
} from './gallery-data.mjs';
import {
  loadSingleSiteReportPublication,
  readPublishedReportJson,
} from './report-publication.mjs';
import { readVisualBaselineStore } from './visual-baselines.mjs';
import {
  readVisualReviewStore,
  resolveVisualReview,
  reviewVisualComparison,
} from './visual-review-dispositions.mjs';
import {
  readSingleSiteVisualComparisonPublication,
} from '../scripts/lib/single-site-visual-comparisons.mjs';
import {
  parseSingleSiteReportPage,
  parseSingleSiteReportSummary,
} from '../scripts/lib/site-health-report.mjs';
import {
  compareVisualBaselineIdentity,
  visualBaselineCanonicalJson,
  visualBaselineDigest,
} from '../shared/visual-baseline-contract.mjs';

const INTERNAL = Symbol('single-site-gallery-internal');
const REVIEW_BINDING = Symbol('single-site-gallery-review-binding');
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const GALLERY_ITEM_ID = /^gitem_[a-f0-9]{16}$/;
const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/;
const REPORT_REVISION = /^[a-f0-9]{32}$/;
const MAX_GALLERY_ROWS = 10_000;
const MAX_PAGE_ROWS = 100;
const MAX_PAGE_SCAN_ROWS = 100;
const MAX_PAGE_BYTES = 2 * 1_048_576;
const MAX_ELIGIBILITY_BYTES = 32 * 1_048_576;
const MAX_REPORT_PAGE_BYTES = 512 * 1024;
const MAX_GALLERY_INDEX_BYTES = 4 * 1_048_576;
const MAX_GALLERY_INDEX_PAGE_BYTES = 512 * 1024;
const MAX_GALLERY_INDEX_PAGES = Math.ceil(MAX_GALLERY_ROWS / MAX_PAGE_ROWS);
const MAX_RETAINED_GALLERY_INDEX_PAGES = 4;
const MAX_MEDIA_BYTES = 512 * 1_048_576;
const MEDIA_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/webm', 'video/mp4',
]);

export class SingleSiteGalleryError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'SingleSiteGalleryError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function fail(statusCode, code, message, details) {
  throw new SingleSiteGalleryError(statusCode, code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function active(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function contained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeJobId(value) {
  if (typeof value !== 'string' || !JOB_ID.test(value)) fail(400, 'SINGLE_SITE_GALLERY_INPUT_INVALID', 'Single-site gallery job ID is invalid.');
  return value;
}

function safeAttemptId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Single-site gallery attempt ID is invalid.');
  }
  return value;
}

function digest(value, label, prefixed = false) {
  const pattern = prefixed ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/;
  if (typeof value !== 'string' || !pattern.test(value)) fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', `${label} is invalid.`);
  return value;
}

function revision(value) {
  if (typeof value !== 'string' || !REPORT_REVISION.test(value)) fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Report revision is invalid.');
  return value;
}

function normalizeDigest(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) return null;
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function emptyReviewSnapshot() {
  return Object.freeze({
    state: Object.freeze({ reviewRevision: 0, historyDigest: `sha256:${'0'.repeat(64)}`, reviews: Object.freeze({}), idempotency: Object.freeze({}) }),
    history: Object.freeze([]),
    bytes: 0,
  });
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function canonicalDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function publicBaseline(record) {
  if (!record) return null;
  return {
    baselineId: record.baselineId,
    identityKey: record.identityKey,
    slotKey: record.slotKey,
    approvedAt: record.approvedAt,
    mediaSha256: record.media.sha256,
    state: record.state,
  };
}

function validateBindings(value, jobId, attemptId) {
  if (!isRecord(value) || value.jobId !== jobId || value.attemptId !== attemptId
    || !['complete', 'incomplete'].includes(value.status)) {
    fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Finalization bindings are missing or identify another run.');
  }
  digest(value.finalizationDigest, 'Finalization digest');
  revision(value.reportRevision);
  digest(value.reportPublicationDigest, 'Report publication digest');
  digest(value.visualPublicationDigest, 'Visual publication digest', true);
  digest(value.visualEligibilityManifestDigest, 'Visual eligibility manifest digest', true);
  if (value.galleryExportRevision !== null && (typeof value.galleryExportRevision !== 'string'
    || !/^export_[a-f0-9]{16}$/.test(value.galleryExportRevision))) {
    fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Gallery export revision is invalid.');
  }
  if (value.galleryPublicationDigest !== undefined && value.galleryPublicationDigest !== null) {
    digest(value.galleryPublicationDigest, 'Gallery publication digest');
  }
  if (value.galleryExportRevision === null || value.galleryIndexDigest === null) {
    fail(409, 'SINGLE_SITE_GALLERY_NOT_READY', 'This finalized run does not contain a Single-site gallery publication.');
  }
  digest(value.galleryIndexDigest, 'Gallery index digest');
  return value;
}

async function readBoundedJson(file, root, maximumBytes, label) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) {
    if (error?.code === 'ENOENT') fail(409, 'SINGLE_SITE_GALLERY_NOT_READY', `${label} is not available yet.`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximumBytes) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `${label} is unsafe or oversized.`);
  }
  const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  if (real !== path.resolve(file) || !contained(realRoot, real)) {
    fail(500, 'SINGLE_SITE_GALLERY_PATH_UNSAFE', `${label} escaped its immutable directory.`);
  }
  try { return JSON.parse(await fs.readFile(real, 'utf8')); } catch {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', `${label} is invalid JSON.`);
  }
}

function validatedCaseEntry(entry, previousItemId = null) {
  if (!isRecord(entry) || typeof entry.itemId !== 'string' || !GALLERY_ITEM_ID.test(entry.itemId)
    || (entry.auditCaseId !== null && (typeof entry.auditCaseId !== 'string' || entry.auditCaseId.length < 1 || entry.auditCaseId.length > 256))
    || !Array.isArray(entry.auditIds) || entry.auditIds.length > 128
    || entry.auditIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 128)
    || typeof entry.sourceTestId !== 'string' || entry.sourceTestId.length < 1 || entry.sourceTestId.length > 1_024
    || typeof entry.projectName !== 'string' || entry.projectName.length > 256
    || !['image', 'video'].includes(entry.kind)
    || typeof entry.status !== 'string' || entry.status.length > 64
    || (previousItemId !== null && previousItemId.localeCompare(entry.itemId) >= 0)) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Single-site gallery case index contains an invalid or duplicate entry.');
  }
  return Object.freeze({
    itemId: entry.itemId,
    auditCaseId: entry.auditCaseId,
    auditIds: Object.freeze([...entry.auditIds]),
    sourceTestId: entry.sourceTestId,
    projectName: entry.projectName,
    kind: entry.kind,
    status: entry.status,
  });
}

function caseRow(entry) {
  return Object.freeze({
    id: entry.itemId,
    kind: entry.kind,
    title: entry.sourceTestId,
    projectName: entry.projectName,
    primaryFeatureSuite: entry.auditIds[0] ?? null,
    technicalSuite: '',
    auditAssociations: Object.freeze(entry.auditIds.map((id) => Object.freeze({ id, title: id }))),
  });
}

async function readGalleryCaseIndex(reportRoot, bindings, work) {
  const root = path.join(reportRoot.real, 'checklist', 'single-site-gallery-index');
  const pointer = await readBoundedJson(path.join(root, 'current.json'), root, 64 * 1024, 'Single-site gallery index pointer');
  if (!isRecord(pointer) || ![1, 2].includes(pointer.schemaVersion) || pointer.kind !== 'single-site-gallery-index-pointer'
    || pointer.indexDigest !== bindings.galleryIndexDigest
    || pointer.exportRevision !== bindings.galleryExportRevision
    || !Number.isSafeInteger(pointer.itemCount) || pointer.itemCount < 0 || pointer.itemCount > MAX_GALLERY_ROWS) {
    fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Single-site gallery index pointer does not match finalization status.');
  }
  const expectedRelativePath = pointer.schemaVersion === 2
    ? `single-site-gallery-index/revisions/${bindings.galleryIndexDigest}/index.json`
    : `single-site-gallery-index/revisions/${bindings.galleryIndexDigest}.json`;
  if (pointer.relativePath !== expectedRelativePath) {
    fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Single-site gallery index pointer path does not match finalization status.');
  }
  const revisionFile = path.join(reportRoot.real, 'checklist', ...pointer.relativePath.split('/'));
  // Retained v1 publications remain lazy at snapshot open. They cannot provide
  // authenticated random access because their digest covers one monolithic
  // array, so the first requested page explicitly reports that legacy full read.
  if (pointer.schemaVersion === 1) {
    let loaded = null;
    async function loadLegacy() {
      if (loaded) return loaded;
      const document = await readBoundedJson(revisionFile, root, MAX_GALLERY_INDEX_BYTES, 'Single-site gallery case index');
      if (!isRecord(document) || document.schemaVersion !== 1 || document.kind !== 'single-site-gallery-index'
        || document.mode !== 'single-site' || document.exportRevision !== bindings.galleryExportRevision
        || document.indexDigest !== bindings.galleryIndexDigest || !Array.isArray(document.entries)
        || document.entries.length !== pointer.itemCount || document.entries.length > MAX_GALLERY_ROWS) {
        fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Single-site gallery case index does not match finalization status.');
      }
      const { indexDigest, ...body } = document;
      if (canonicalDigest(body) !== indexDigest) fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Single-site gallery case index failed digest verification.');
      const entries = [];
      for (const entry of document.entries) entries.push(validatedCaseEntry(entry, entries.at(-1)?.itemId ?? null));
      work.galleryInventoryRowsRead += entries.length;
      work.galleryFullInventoryLoaded = true;
      loaded = Object.freeze(entries);
      return loaded;
    }
    return Object.freeze({
      pointer: Object.freeze({ ...pointer }),
      knownCaseCount: null,
      async range(offset, limit) { return (await loadLegacy()).slice(offset, offset + limit); },
      async locate(itemId) {
        const entries = await loadLegacy();
        const index = entries.findIndex((entry) => entry.itemId === itemId);
        return index < 0 ? null : { entry: entries[index], index };
      },
    });
  }
  const document = await readBoundedJson(revisionFile, root, MAX_GALLERY_INDEX_BYTES, 'Single-site gallery case index descriptor');
  if (!isRecord(document) || document.schemaVersion !== 2 || document.kind !== 'single-site-gallery-index'
    || document.mode !== 'single-site' || document.exportRevision !== bindings.galleryExportRevision
    || document.indexDigest !== bindings.galleryIndexDigest || document.itemCount !== pointer.itemCount
    || !Number.isSafeInteger(document.knownCaseCount) || document.knownCaseCount < 0
    || document.knownCaseCount > pointer.itemCount || !Array.isArray(document.pages)
    || document.pages.length > MAX_GALLERY_INDEX_PAGES) {
    fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Single-site gallery case index descriptor does not match finalization status.');
  }
  const { indexDigest, ...body } = document;
  if (canonicalDigest(body) !== indexDigest) fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Single-site gallery case index descriptor failed digest verification.');
  let itemOffset = 0;
  let previousLastItemId = null;
  const pages = document.pages.map((page, index) => {
    const ordinal = index + 1;
    if (!isRecord(page) || page.ordinal !== ordinal || !Number.isSafeInteger(page.itemCount)
      || page.itemCount < 1 || page.itemCount > MAX_PAGE_ROWS
      || typeof page.firstItemId !== 'string' || !GALLERY_ITEM_ID.test(page.firstItemId)
      || typeof page.lastItemId !== 'string' || !GALLERY_ITEM_ID.test(page.lastItemId)
      || page.firstItemId.localeCompare(page.lastItemId) > 0
      || (previousLastItemId !== null && previousLastItemId.localeCompare(page.firstItemId) >= 0)
      || typeof page.pageDigest !== 'string' || !/^[a-f0-9]{64}$/.test(page.pageDigest)
      || page.relativePath !== `pages/page-${String(ordinal).padStart(6, '0')}-${page.pageDigest}.json`) {
      fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Single-site gallery case index descriptor contains an invalid page reference.');
    }
    const normalized = Object.freeze({ ...page, itemOffset });
    itemOffset += page.itemCount;
    previousLastItemId = page.lastItemId;
    return normalized;
  });
  if (itemOffset !== pointer.itemCount || (pointer.itemCount === 0) !== (pages.length === 0)) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Single-site gallery case index descriptor has inconsistent page totals.');
  }
  const revisionDirectory = path.dirname(revisionFile);
  const pageCache = new Map();
  async function loadPage(page) {
    if (pageCache.has(page.ordinal)) return pageCache.get(page.ordinal);
    const pageFile = path.join(revisionDirectory, ...page.relativePath.split('/'));
    const pageDocument = await readBoundedJson(pageFile, revisionDirectory, MAX_GALLERY_INDEX_PAGE_BYTES, 'Single-site gallery case index page');
    if (!isRecord(pageDocument) || pageDocument.schemaVersion !== 2 || pageDocument.kind !== 'single-site-gallery-index-page'
      || pageDocument.mode !== 'single-site' || pageDocument.exportRevision !== bindings.galleryExportRevision
      || pageDocument.ordinal !== page.ordinal || pageDocument.pageDigest !== page.pageDigest
      || !Array.isArray(pageDocument.entries) || pageDocument.entries.length !== page.itemCount) {
      fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Single-site gallery case index page does not match its descriptor.');
    }
    const { pageDigest, ...pageBody } = pageDocument;
    if (canonicalDigest(pageBody) !== pageDigest) fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Single-site gallery case index page failed digest verification.');
    const entries = [];
    for (const entry of pageDocument.entries) entries.push(validatedCaseEntry(entry, entries.at(-1)?.itemId ?? null));
    if (entries[0]?.itemId !== page.firstItemId || entries.at(-1)?.itemId !== page.lastItemId) {
      fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Single-site gallery case index page boundaries do not match its descriptor.');
    }
    const frozen = Object.freeze(entries);
    pageCache.set(page.ordinal, frozen);
    work.galleryInventoryRowsRead += frozen.length;
    while (pageCache.size > MAX_RETAINED_GALLERY_INDEX_PAGES) pageCache.delete(pageCache.keys().next().value);
    return frozen;
  }
  return Object.freeze({
    pointer: Object.freeze({ ...pointer }),
    knownCaseCount: document.knownCaseCount,
    async range(offset, limit) {
      if (offset >= pointer.itemCount || limit < 1) return [];
      const end = Math.min(pointer.itemCount, offset + limit);
      const result = [];
      for (const page of pages) {
        const pageEnd = page.itemOffset + page.itemCount;
        if (pageEnd > offset && page.itemOffset < end) {
          const entries = await loadPage(page);
          result.push(...entries.slice(Math.max(0, offset - page.itemOffset), Math.min(entries.length, end - page.itemOffset)));
        }
        if (pageEnd >= end) break;
      }
      if (result.length !== end - offset) fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Single-site gallery case index range is incomplete.');
      return result;
    },
    async locate(itemId) {
      let low = 0;
      let high = pages.length - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const page = pages[middle];
        if (itemId.localeCompare(page.firstItemId) < 0) high = middle - 1;
        else if (itemId.localeCompare(page.lastItemId) > 0) low = middle + 1;
        else {
          const entries = await loadPage(page);
          const relativeIndex = entries.findIndex((entry) => entry.itemId === itemId);
          return relativeIndex < 0 ? null : { entry: entries[relativeIndex], index: page.itemOffset + relativeIndex };
        }
      }
      return null;
    },
  });
}

async function realDirectory(root, candidate, label) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(candidate);
  if (!contained(absoluteRoot, absolute)) fail(500, 'SINGLE_SITE_GALLERY_PATH_UNSAFE', `${label} escapes the configured finalization root.`);
  const [rootStat, stat, realRoot, real] = await Promise.all([
    fs.lstat(absoluteRoot), fs.lstat(absolute), fs.realpath(absoluteRoot), fs.realpath(absolute),
  ]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink()
    || !contained(realRoot, real)) {
    fail(500, 'SINGLE_SITE_GALLERY_PATH_UNSAFE', `${label} must be a contained real directory.`);
  }
  return { absolute, real, root: absoluteRoot, realRoot };
}

async function readEligibilityPublication(visualRoot, bindings) {
  const file = path.join(visualRoot.real, 'eligibility.json');
  let stat;
  try { stat = await fs.lstat(file); } catch (error) {
    if (error?.code === 'ENOENT') fail(409, 'SINGLE_SITE_GALLERY_NOT_READY', 'Visual eligibility publication is not available yet.');
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_ELIGIBILITY_BYTES) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Visual eligibility publication is unsafe or oversized.');
  }
  const real = await fs.realpath(file);
  if (real !== file || !contained(visualRoot.real, real)) {
    fail(500, 'SINGLE_SITE_GALLERY_PATH_UNSAFE', 'Visual eligibility publication escaped its immutable directory.');
  }
  let document;
  try { document = JSON.parse(await fs.readFile(real, 'utf8')); } catch {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Visual eligibility publication is invalid JSON.');
  }
  if (!isRecord(document) || document.schemaVersion !== 1
    || document.kind !== 'single-site-visual-baseline-eligibility' || document.mode !== 'single-site'
    || document.jobId !== bindings.jobId || document.attemptId !== bindings.attemptId
    || document.finalizationDigest !== bindings.finalizationDigest
    || document.reportRevision !== bindings.reportRevision || !Array.isArray(document.items)
    || document.items.length > MAX_GALLERY_ROWS) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Visual eligibility publication has invalid finalization bindings.');
  }
  const { manifestDigest, ...body } = document;
  if (manifestDigest !== visualBaselineDigest(body)
    || manifestDigest !== bindings.visualEligibilityManifestDigest) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Visual eligibility publication failed digest verification.');
  }
  return document;
}

async function defaultLoadReportContext(publication, auditCatalog, dependencies, work) {
  const readJson = dependencies.readPublishedReportJson ?? readPublishedReportJson;
  const summaryDocument = (await readJson(publication, 'summary.json', MAX_REPORT_PAGE_BYTES)).document;
  work.reportDocumentsRead += 1;
  const summary = parseSingleSiteReportSummary(summaryDocument);
  const auditPages = new Map();
  const coverageGapsByAudit = new Map();
  const coverageWithoutAudit = [];
  if (summary.auditPages.pageCount > 1_000 || summary.auditPages.total > MAX_GALLERY_ROWS) {
    fail(413, 'SINGLE_SITE_GALLERY_REPORT_TOO_LARGE', 'Single-site audit report exceeds the gallery context bound.');
  }
  if (summary.coverage.pages.pageCount > 1_000 || summary.coverage.pages.total > MAX_GALLERY_ROWS) {
    fail(413, 'SINGLE_SITE_GALLERY_REPORT_TOO_LARGE', 'Single-site coverage report exceeds the gallery context bound.');
  }
  const coveragePreview = summary.coverage.preview ?? [];
  for (const item of coveragePreview) {
    if (item.kind !== 'gap') continue;
    const ids = [...new Set(item.detail.match(/[A-Z][A-Z0-9]*-[0-9]{3,}/g) ?? [])];
    if (ids.length === 0) coverageWithoutAudit.push(item.detail);
    for (const id of ids) {
      const values = coverageGapsByAudit.get(id) ?? [];
      values.push(item.detail);
      coverageGapsByAudit.set(id, values);
    }
  }
  const coverageAssociationComplete = summary.coverage.pages.total <= coveragePreview.length;
  const definitions = new Map((Array.isArray(auditCatalog) ? auditCatalog : [])
    .filter((item) => isRecord(item) && typeof item.id === 'string')
    .map((item) => [item.id, item]));
  async function readAuditPage(page, signal) {
    active(signal);
    if (auditPages.has(page)) return auditPages.get(page);
    const relativePath = `audits/page-${String(page).padStart(6, '0')}.json`;
    const document = (await readJson(publication, relativePath, MAX_REPORT_PAGE_BYTES)).document;
    work.reportDocumentsRead += 1;
    const items = parseSingleSiteReportPage(document, relativePath, summary).items;
    auditPages.set(page, items);
    return items;
  }
  async function getAudit(id, signal) {
    let low = 1;
    let high = summary.auditPages.pageCount;
    while (low <= high) {
      const page = Math.floor((low + high) / 2);
      const items = await readAuditPage(page, signal);
      if (items.length === 0) return null;
      if (id.localeCompare(items[0].id) < 0) high = page - 1;
      else if (id.localeCompare(items.at(-1).id) > 0) low = page + 1;
      else return items.find((item) => item.id === id) ?? null;
    }
    return null;
  }
  return {
    summary,
    definitions,
    coverageWithoutAudit,
    coverageAssociationComplete,
    getAudit,
    getCoverageReasons(id) {
      const known = [...(coverageGapsByAudit.get(id) ?? [])];
      if (!coverageAssociationComplete) {
        known.push('Coverage-gap association is partial because the bounded gallery read did not scan the full coverage publication.');
      }
      return known;
    },
  };
}

function visualMaps(publication, eligibility) {
  const eligibilityByCapture = new Map();
  for (const item of eligibility.items) {
    const sha256 = normalizeDigest(item?.evidence?.artifactSha256);
    if (!isRecord(item) || typeof item.identityKey !== 'string' || !sha256) continue;
    const key = `${item.identityKey}\u0000${sha256}`;
    const values = eligibilityByCapture.get(key) ?? [];
    values.push(item);
    eligibilityByCapture.set(key, values);
  }
  const byDigest = new Map();
  for (const item of publication.items) {
    if (!isRecord(item) || typeof item.identityKey !== 'string') continue;
    const sha256 = normalizeDigest(item.current?.sha256);
    if (!sha256) continue;
    const values = byDigest.get(sha256) ?? [];
    values.push(item);
    byDigest.set(sha256, values);
  }
  return { eligibilityByCapture, byDigest };
}

function auditIdFor(row, detail, visual) {
  if (typeof visual?.auditId === 'string') return visual.auditId;
  const associations = detail?.item?.auditAssociations ?? row?.auditAssociations ?? [];
  return associations.find((item) => typeof item?.id === 'string')?.id ?? 'UNKNOWN';
}

function selectCurrentMedia(detail) {
  const roles = new Map((detail?.item?.members ?? []).map((member) => [member.id, member.role]));
  const priority = { actual: 0, single: 1, unknown: 2, other: 3, baseline: 4, diff: 5 };
  return [...(detail?.media ?? [])]
    .filter((member) => member?.available && typeof member.href === 'string' && MEDIA_TYPES.has(member.contentType))
    .sort((left, right) => (priority[roles.get(left.memberId)] ?? 6) - (priority[roles.get(right.memberId)] ?? 6))[0] ?? null;
}

function findVisual(internal, row, detail, current) {
  const sha256 = normalizeDigest(current?.sha256);
  if (!sha256) return null;
  let candidates = internal.visual.byDigest.get(sha256) ?? [];
  if (candidates.length === 1) return candidates[0];
  const project = detail?.item?.project?.name;
  const route = detail?.item?.capture?.route;
  const audits = new Set((detail?.item?.auditAssociations ?? row?.auditAssociations ?? []).map(({ id }) => id));
  candidates = candidates.filter((item) => (
    (!project || item.targetId === project)
    && (!route || item.identity?.route === route)
    && (audits.size === 0 || audits.has(item.auditId))
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

function baselineOverlay(internal, visual) {
  if (!visual) return {
    baseline: null,
    comparison: {
      schemaVersion: 1,
      status: 'absent',
      reason: 'This evidence has no digest-bound named visual capture, so no pixel baseline comparison applies.',
      review: null,
    },
    diff: null,
    stale: false,
  };
  const activeId = internal.baselines.state.activeBySlot[visual.slotKey] ?? null;
  const activeBaseline = activeId ? internal.baselines.state.baselines[activeId] : null;
  if (!activeBaseline) return {
    baseline: null,
    comparison: { ...visual.comparison, status: 'absent', reason: 'No active baseline exists for this exact semantic capture slot.', review: visual.comparison?.review ?? null },
    diff: null,
    stale: Boolean(visual.baseline),
  };
  let compatibility;
  try { compatibility = compareVisualBaselineIdentity(activeBaseline.identity, visual.identity); } catch {
    return {
      baseline: publicBaseline(activeBaseline),
      comparison: { ...visual.comparison, status: 'unavailable', reason: 'The active baseline identity could not be validated.', review: null },
      diff: null,
      stale: true,
    };
  }
  if (!compatibility.compatible) return {
    baseline: publicBaseline(activeBaseline),
    comparison: { ...visual.comparison, status: 'incompatible', reason: `The active baseline is incompatible: ${compatibility.differences.join(', ')}.`, review: null },
    diff: null,
    stale: true,
  };
  if (activeBaseline.media.available !== true) return {
    baseline: publicBaseline(activeBaseline),
    comparison: { ...visual.comparison, status: 'unavailable', reason: 'The active compatible baseline media was deleted or is unavailable.', review: null },
    diff: null,
    stale: true,
  };
  const original = visual.baseline;
  const sameRevision = original?.baselineId === activeBaseline.baselineId
    && normalizeDigest(original.mediaSha256) === normalizeDigest(activeBaseline.media.sha256);
  if (!sameRevision) return {
    baseline: publicBaseline(activeBaseline),
    comparison: {
      ...visual.comparison,
      status: 'unavailable',
      reason: 'The active baseline changed after this run finalized. A stale difference image is intentionally withheld; rerun this capture for a current comparison.',
      review: null,
    },
    diff: null,
    stale: true,
  };
  return {
    baseline: publicBaseline(activeBaseline),
    comparison: visual.comparison,
    diff: visual.diff,
    stale: false,
  };
}

function videoComparison() {
  return {
    baseline: null,
    comparison: {
      schemaVersion: 1,
      status: 'absent',
      reason: 'Interaction videos are behavior evidence and do not receive pixel-baseline comparisons.',
      review: null,
    },
    diff: null,
    stale: false,
  };
}

function evidenceContext(internal, visual, audit) {
  const captureKey = visual ? `${visual.identityKey}\u0000${normalizeDigest(visual.current?.sha256)}` : null;
  const eligibilityCandidates = captureKey ? internal.visual.eligibilityByCapture.get(captureKey) ?? [] : [];
  const eligibility = eligibilityCandidates.length === 1 ? eligibilityCandidates[0] : null;
  const exactFinding = eligibility?.evidence?.findingStatus;
  return {
    eligibility,
    findingCount: exactFinding === 'unresolved' ? 1 : exactFinding === 'clear' ? 0 : audit?.findingCount ?? 0,
    findingCountScope: exactFinding ? 'exact-visual-execution' : audit ? 'audit-aggregate' : 'unknown',
  };
}

function severityRank(value) {
  return /^P[0-3]$/.test(value ?? '') ? Number(value.slice(1)) : 4;
}

async function auditContexts(internal, ids, signal) {
  return Promise.all(ids.map(async (id) => {
    const report = await internal.report.getAudit(id, signal);
    const definition = internal.report.definitions.get(id) ?? null;
    return {
      auditId: id,
      title: report?.title ?? definition?.title ?? 'Unknown audit',
      area: report?.area ?? definition?.area ?? 'Uncategorized',
      status: report?.status ?? 'UNKNOWN',
      findingCount: Number.isSafeInteger(report?.findingCount) ? report.findingCount : null,
      evidenceStatus: report?.evidenceStatus ?? 'unknown',
      severity: definition?.severity ?? 'unknown',
      coverageReasons: internal.report.getCoverageReasons(id),
    };
  }));
}

function safeUrl(jobId, itemId, suffix) {
  return `/api/single-site/runs/${encodeURIComponent(jobId)}/gallery/items/${encodeURIComponent(itemId)}/media/${suffix}`;
}

async function enrichItem(snapshot, row, signal) {
  active(signal);
  const internal = snapshot[INTERNAL];
  const located = await internal.caseIndex.locate(row.id);
  const caseEntry = located?.entry;
  if (!caseEntry || caseEntry.kind !== row.kind
    || (typeof row.projectName === 'string' && row.projectName !== caseEntry.projectName)) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Gallery row does not match its digest-bound case index entry.');
  }
  const detail = await internal.dependencies.readGalleryItem(internal.gallery, internal.jobId, row.id, signal);
  internal.work.galleryDetailReads += 1;
  active(signal);
  if (detail?.item?.id !== row.id || detail?.item?.kind !== caseEntry.kind
    || detail?.item?.test?.id !== caseEntry.sourceTestId
    || detail?.item?.project?.name !== caseEntry.projectName) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Gallery detail does not match its digest-bound case index entry.');
  }
  const current = selectCurrentMedia(detail);
  const visual = row.kind === 'image' ? findVisual(internal, row, detail, current) : null;
  if (visual && ((caseEntry.auditCaseId !== null && visual.caseId !== caseEntry.auditCaseId)
    || !caseEntry.auditIds.includes(visual.auditId)
    || visual.targetId !== caseEntry.projectName)) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Visual comparison metadata conflicts with the digest-bound gallery case index.');
  }
  const auditId = caseEntry.auditIds.includes(visual?.auditId) ? visual.auditId
    : caseEntry.auditIds[0] ?? auditIdFor(row, detail, visual);
  const audit = await internal.report.getAudit(auditId, signal);
  const definition = internal.report.definitions.get(auditId) ?? null;
  const audits = await auditContexts(internal, caseEntry.auditIds.length > 0 ? caseEntry.auditIds : [auditId], signal);
  const evidence = evidenceContext(internal, visual, audit);
  const immutableOverlay = row.kind === 'video' ? videoComparison() : baselineOverlay(internal, visual);
  const reviewBinding = immutableOverlay.comparison.status === 'CHANGED'
    && visual?.itemId && visual?.identityKey && visual?.slotKey
    && immutableOverlay.baseline?.baselineId && immutableOverlay.baseline?.mediaSha256
    && visual.current?.sha256 && immutableOverlay.diff?.sha256
    ? Object.freeze({
        jobId: internal.jobId,
        galleryItemId: row.id,
        reportRevision: internal.bindings.reportRevision,
        galleryExportRevision: internal.gallery.head.exportRevision,
        visualPublicationDigest: internal.visual.publication.publicationDigest,
        visualComparisonItemId: visual.itemId,
        identityKey: visual.identityKey,
        slotKey: visual.slotKey,
        comparisonDigest: visualBaselineDigest(immutableOverlay.comparison),
        baselineId: immutableOverlay.baseline.baselineId,
        baselineMediaSha256: normalizeDigest(immutableOverlay.baseline.mediaSha256),
        currentMediaSha256: normalizeDigest(visual.current.sha256),
        diffSha256: normalizeDigest(immutableOverlay.diff.sha256),
      })
    : null;
  const review = reviewBinding ? resolveVisualReview(internal.reviews, reviewBinding) : null;
  const overlay = review ? {
    ...immutableOverlay,
    comparison: {
      ...immutableOverlay.comparison,
      status: 'REVIEWED',
      review: {
        disposition: review.disposition,
        rationale: review.rationale,
        actorId: review.actorId,
        reviewedAt: review.reviewedAt,
        reviewRevision: review.reviewRevision,
        eventId: review.eventId,
      },
    },
  } : immutableOverlay;
  const coverageReasons = [...new Set(audits.flatMap((item) => item.coverageReasons))];
  const aggregateFindingCount = audits.reduce((total, item) => total + (item.findingCount ?? 0), 0);
  const findingCount = evidence.findingCountScope === 'exact-visual-execution'
    ? evidence.findingCount : aggregateFindingCount;
  const severities = audits.map(({ severity }) => severity).filter((value) => /^P[0-3]$/.test(value));
  const severity = severities.sort((left, right) => severityRank(left) - severityRank(right))[0] ?? 'P3';
  const identity = visual?.identity ?? null;
  const result = {
    schemaVersion: 1,
    mode: 'single-site',
    itemId: row.id,
    kind: row.kind,
    title: row.title,
    suite: audit?.area ?? definition?.area ?? row.primaryFeatureSuite ?? row.technicalSuite ?? 'Uncategorized',
    auditId,
    auditTitle: audit?.title ?? definition?.title ?? row.auditAssociations?.find(({ id }) => id === auditId)?.title ?? 'Unknown audit',
    caseId: caseEntry.auditCaseId ?? 'unknown',
    caseIdSource: caseEntry.auditCaseId ? 'digest-bound-gallery-index' : 'unknown',
    auditIds: [...caseEntry.auditIds],
    targetId: visual?.targetId ?? caseEntry.projectName,
    route: identity?.route ?? detail.item.capture?.route ?? 'unknown',
    capturePoint: identity?.capturePoint ?? 'unknown',
    theme: identity?.theme ?? 'unknown',
    severity,
    severitySource: severities.length > 0 ? 'audit-catalog' : 'unknown-default',
    audits,
    findingCount,
    findingCountScope: evidence.findingCountScope === 'exact-visual-execution'
      ? evidence.findingCountScope : audits.some(({ findingCount: count }) => count !== null) ? 'associated-audits' : 'unknown',
    findingStatus: findingCount > 0 ? 'unresolved' : 'clear',
    coverageGap: coverageReasons.length > 0,
    coverageStatus: coverageReasons.length > 0 ? 'gap' : 'covered',
    coverageReasons,
    visualReviewStatus: overlay.comparison.status,
    comparison: overlay.comparison,
    visualComparisonItemId: visual?.itemId ?? null,
    identity,
    identityKey: visual?.identityKey ?? null,
    slotKey: visual?.slotKey ?? null,
    evidenceId: evidence.eligibility?.evidenceId ?? null,
    evidence: evidence.eligibility?.evidence ?? null,
    eligible: evidence.eligibility?.eligible === true,
    ineligibilityReasons: evidence.eligibility?.eligible === true
      ? []
      : evidence.eligibility?.ineligibilityReasons ?? [row.kind === 'video'
        ? 'Interaction video evidence cannot become a pixel baseline.'
        : 'No server-published eligible visual capture matches this evidence.'],
    current: current ? {
      bytes: current.sizeBytes ?? null,
      sha256: normalizeDigest(current.sha256),
      contentType: current.contentType,
    } : null,
    baseline: overlay.baseline,
    diff: overlay.diff ? { bytes: overlay.diff.bytes, sha256: overlay.diff.sha256 } : null,
    staleComparisonWithheld: overlay.stale,
    attentionRequired: findingCount > 0 || coverageReasons.length > 0
      || ['CHANGED', 'incompatible', 'unavailable'].includes(overlay.comparison.status),
    urls: {
      current: current ? safeUrl(internal.jobId, row.id, 'current') : null,
      baseline: overlay.baseline?.mediaSha256 && overlay.baseline.state === 'active'
        ? `/api/single-site/visual-baselines/${encodeURIComponent(overlay.baseline.baselineId)}/media`
        : null,
      diff: overlay.diff ? safeUrl(internal.jobId, row.id, 'diff') : null,
      poster: null,
    },
    testContext: {
      testId: caseEntry.sourceTestId,
      technicalSuite: detail.item.test?.technicalSuite ?? row.technicalSuite ?? '',
      observed: detail.item.capture?.observedState ?? null,
      rationale: detail.item.capture?.rationale ?? null,
      attempt: detail.item.attempt ?? null,
      project: detail.item.project ?? null,
    },
  };
  if (jsonBytes(result) > 512 * 1024) fail(413, 'SINGLE_SITE_GALLERY_ITEM_TOO_LARGE', 'Single-site gallery item exceeds its response byte bound.');
  Object.defineProperty(result, REVIEW_BINDING, { value: reviewBinding, enumerable: false });
  return Object.freeze(result);
}

export async function openSingleSiteGallery(options) {
  if (!isRecord(options)) fail(400, 'SINGLE_SITE_GALLERY_INPUT_INVALID', 'Single-site gallery options are required.');
  const jobId = safeJobId(options.jobId);
  const attemptId = safeAttemptId(options.attemptId);
  const bindings = validateBindings(options.bindings, jobId, attemptId);
  const work = {
    reportDocumentsRead: 0,
    galleryDetailReads: 0,
    galleryInventoryRowsRead: 0,
    galleryFullInventoryLoaded: false,
  };
  active(options.signal);
  const dependencies = {
    loadGallerySnapshot: options.dependencies?.loadGallerySnapshot ?? loadGallerySnapshot,
    readGalleryItem: options.dependencies?.readGalleryItem ?? readGalleryItem,
    loadReportPublication: options.dependencies?.loadReportPublication ?? loadSingleSiteReportPublication,
    readPublishedReportJson: options.dependencies?.readPublishedReportJson ?? readPublishedReportJson,
    readVisualPublication: options.dependencies?.readVisualPublication ?? readSingleSiteVisualComparisonPublication,
    readBaselineStore: options.dependencies?.readBaselineStore ?? readVisualBaselineStore,
    readReviewStore: options.dependencies?.readReviewStore ?? readVisualReviewStore,
    loadReportContext: options.dependencies?.loadReportContext ?? defaultLoadReportContext,
  };
  const finalizationRoot = path.resolve(options.finalizationRoot);
  const jobRoot = await realDirectory(finalizationRoot, path.join(finalizationRoot, jobId), 'Single-site finalization job directory');
  const reportRoot = await realDirectory(jobRoot.real, options.reportRunDirectory ?? path.join(jobRoot.real, 'report'), 'Single-site report directory');
  const visualRoot = await realDirectory(jobRoot.real, options.visualDirectory ?? path.join(jobRoot.real, 'visual'), 'Single-site visual directory');
  const reportPublication = options.reportPublication ?? await dependencies.loadReportPublication(reportRoot.real, bindings.reportRevision);
  if (reportPublication.mode !== 'single-site' || reportPublication.publicationRevision !== bindings.reportRevision
    || reportPublication.publicationDigest !== bindings.reportPublicationDigest) {
    fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Compact report publication does not match finalization status.');
  }
  const visualPublication = await dependencies.readVisualPublication({
    outputDir: visualRoot.real,
    jobId,
    attemptId,
    finalizationDigest: bindings.finalizationDigest,
    reportRevision: bindings.reportRevision,
  });
  if (visualPublication.publicationDigest !== bindings.visualPublicationDigest) {
    fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Visual comparison publication does not match finalization status.');
  }
  const eligibility = await readEligibilityPublication(visualRoot, bindings);
  const [baselineSnapshot, reviewSnapshot] = await Promise.all([
    dependencies.readBaselineStore(options.baselineStore),
    options.reviewStore ? dependencies.readReviewStore(options.reviewStore) : emptyReviewSnapshot(),
  ]);
  let report = await dependencies.loadReportContext(reportPublication, options.auditCatalog ?? [], dependencies, work);
  if (report && report.audits instanceof Map) {
    report = {
      ...report,
      coverageAssociationComplete: true,
      getAudit: async (id) => report.audits.get(id) ?? null,
      getCoverageReasons: (id) => [...(report.coverageGapsByAudit.get(id) ?? [])],
    };
  }
  if (!report || typeof report.getAudit !== 'function' || typeof report.getCoverageReasons !== 'function'
    || !(report.definitions instanceof Map)) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Single-site report context does not support bounded audit lookup.');
  }
  const caseIndex = await readGalleryCaseIndex(reportRoot, bindings, work);
  const galleryRun = {
    directory: reportRoot.real,
    manifest: {
      id: jobId,
      status: bindings.executionState ?? 'completed',
      finishedAt: reportPublication.generatedAt,
      pipeline: { completed: true, status: bindings.status },
    },
  };
  const gallery = await dependencies.loadGallerySnapshot(galleryRun, options.signal, { includeRows: false });
  if (gallery.kind !== 'sealed' || gallery.head?.phase !== 'sealed'
    || gallery.head?.primaryCounts?.total > MAX_GALLERY_ROWS
    || (bindings.galleryExportRevision !== null && gallery.head.exportRevision !== bindings.galleryExportRevision)) {
    fail(500, 'SINGLE_SITE_GALLERY_BINDING_INVALID', 'Sealed gallery index does not match finalization status.');
  }
  if (caseIndex.pointer.itemCount !== gallery.head.primaryCounts.total) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Sealed gallery and digest-bound case index contain different evidence sets.');
  }
  const snapshot = {
    schemaVersion: 1,
    mode: 'single-site',
    jobId,
    publicationRevision: bindings.reportRevision,
    galleryExportRevision: gallery.head.exportRevision,
    baselineStoreRevision: baselineSnapshot.state.storeRevision,
    reviewRevision: reviewSnapshot.state.reviewRevision,
  };
  Object.defineProperty(snapshot, INTERNAL, {
    value: {
      jobId, attemptId, bindings, dependencies, jobRoot, reportRoot, visualRoot,
      reportPublication, report, gallery, caseIndex, work,
      baselines: baselineSnapshot, reviews: reviewSnapshot,
      visual: { publication: visualPublication, eligibility, ...visualMaps(visualPublication, eligibility) },
      reviewStore: options.reviewStore,
      baselineStore: options.baselineStore,
      mutationAuthorized: options.mutationAuthorized === true,
    },
    enumerable: false,
  });
  return Object.freeze(snapshot);
}

function internal(snapshot) {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== 1 || snapshot.mode !== 'single-site' || !snapshot[INTERNAL]) {
    fail(500, 'SINGLE_SITE_GALLERY_SNAPSHOT_INVALID', 'Single-site gallery snapshot is invalid.');
  }
  return snapshot[INTERNAL];
}

export function singleSiteGalleryHead(snapshot) {
  const value = internal(snapshot);
  const counts = value.gallery.head.primaryCounts ?? { total: value.caseIndex.pointer.itemCount, images: 0, videos: 0 };
  const knownCaseCount = value.caseIndex.knownCaseCount;
  return {
    schemaVersion: 1,
    mode: 'single-site',
    phase: 'sealed',
    status: value.bindings.status,
    lifecycle: { status: value.bindings.executionState ?? 'completed', terminal: true },
    publicationRevision: value.bindings.reportRevision,
    publicationDigest: value.bindings.galleryPublicationDigest ?? value.bindings.galleryExportRevision,
    galleryExportRevision: value.gallery.head.exportRevision,
    galleryIndexDigest: value.bindings.galleryIndexDigest,
    baselineStoreRevision: value.baselines.state.storeRevision,
    reviewRevision: value.reviews.state.reviewRevision,
    mutationCapability: { authorized: value.mutationAuthorized, actorSource: 'server-session' },
    primaryCounts: counts,
    summary: { total: counts.total, images: counts.images, videos: counts.videos },
    caseMapping: {
      known: knownCaseCount,
      unknown: knownCaseCount === null ? null : counts.total - knownCaseCount,
      source: knownCaseCount === null ? 'legacy-index-deferred' : 'digest-bound-gallery-index',
    },
    facets: {
      suites: [...new Set([
        ...(value.gallery.head.facets?.featureSuites ?? []),
        ...(value.gallery.head.facets?.technicalSuites ?? []),
      ])].sort(),
      kinds: value.gallery.head.facets?.kinds ?? [],
      visualStatuses: ['CHANGED', 'UNCHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable'],
      findingStates: ['clear', 'unresolved'],
      coverageStates: ['covered', 'gap'],
    },
    unmappedCoverageGapCount: value.report.coverageAssociationComplete
      ? value.report.coverageWithoutAudit.length
      : null,
    sourceWork: { ...value.work },
    maximumItems: MAX_GALLERY_ROWS,
  };
}

const SINGLE_SITE_PAGE_FILTERS = Object.freeze({
  scope: new Set(['attention', 'all']),
  kind: new Set(['', 'image', 'video']),
  finding: new Set(['', 'all', 'finding', 'clear']),
  coverage: new Set(['', 'all', 'gap', 'covered']),
  visual: new Set(['', 'all', 'CHANGED', 'UNCHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable']),
});

function singleSitePageFilters(options) {
  const filters = {};
  for (const [key, values] of Object.entries(SINGLE_SITE_PAGE_FILTERS)) {
    const fallback = key === 'scope' ? 'all' : key === 'kind' ? '' : 'all';
    const value = options[key] ?? fallback;
    if (typeof value !== 'string' || !values.has(value)) {
      fail(400, 'SINGLE_SITE_GALLERY_PAGE_INVALID', `Gallery ${key} filter is invalid.`);
    }
    filters[key] = value;
  }
  for (const key of ['suite', 'query']) {
    const value = options[key] ?? '';
    if (typeof value !== 'string' || value.length > 1_200 || /[\u0000-\u001f\u007f]/.test(value)) {
      fail(400, 'SINGLE_SITE_GALLERY_PAGE_INVALID', `Gallery ${key} filter is invalid.`);
    }
    filters[key] = value.trim();
  }
  return filters;
}

function matchesSingleSitePage(item, filters) {
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

export async function pageSingleSiteGalleryItems(snapshot, options = {}) {
  const value = internal(snapshot);
  active(options.signal);
  if ((options.revision !== undefined && options.revision !== value.bindings.reportRevision)
    || (options.baselineStoreRevision !== undefined
      && options.baselineStoreRevision !== value.baselines.state.storeRevision)
    || (options.reviewRevision !== undefined
      && options.reviewRevision !== value.reviews.state.reviewRevision)) {
    fail(409, 'SINGLE_SITE_GALLERY_REVISION_STALE', 'The requested Single-site gallery revision is no longer current.');
  }
  const limit = options.limit ?? 50;
  const filters = singleSitePageFilters(options);
  const total = value.caseIndex.pointer.itemCount;
  let offset = options.offset ?? 0;
  let anchorIndex = -1;
  if (options.anchorItemId !== undefined && options.anchorItemId !== null) {
    if (typeof options.anchorItemId !== 'string' || !GALLERY_ITEM_ID.test(options.anchorItemId)) {
      fail(400, 'SINGLE_SITE_GALLERY_PAGE_INVALID', 'Gallery anchor item ID is invalid.');
    }
    const located = await value.caseIndex.locate(options.anchorItemId);
    if (!located) fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery anchor item was not found.');
    anchorIndex = located.index;
    offset = Math.max(0, Math.min(anchorIndex - Math.floor(limit / 2), Math.max(0, total - limit)));
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_ROWS) {
    fail(400, 'SINGLE_SITE_GALLERY_PAGE_INVALID', `Gallery offset must be non-negative and limit must be between 1 and ${MAX_PAGE_ROWS}.`);
  }
  const scanEnd = Math.min(total, offset + MAX_PAGE_SCAN_ROWS);
  let selected = (await value.caseIndex.range(offset, scanEnd - offset)).map(caseRow);
  while (selected.length > 0) {
    const items = [];
    let lastScannedOffset = offset;
    let anchorExcluded = false;
    for (const [relativeIndex, row] of selected.entries()) {
      active(options.signal);
      const sourceIndex = offset + relativeIndex;
      const item = await enrichItem(snapshot, row, options.signal);
      const matches = matchesSingleSitePage(item, filters);
      const anchored = sourceIndex === anchorIndex;
      if (anchored && !matches) anchorExcluded = true;
      if (anchored) {
        // An anchor is a selection-continuity contract, even when that item is
        // outside the active filters. Reserve one bounded slot while scanning
        // rows before it so a selective filter can never push the anchor into
        // an over-limit response.
        items.push(item);
      } else if (matches && items.length < limit
        && !(anchorIndex >= 0 && sourceIndex < anchorIndex && items.length >= limit - 1)) {
        items.push(item);
      }
      lastScannedOffset = sourceIndex + 1;
      if (items.length >= limit && (anchorIndex < 0 || sourceIndex >= anchorIndex)) break;
    }
    const nextOffset = lastScannedOffset;
    const result = {
      schemaVersion: 1,
      mode: 'single-site',
      publicationRevision: value.bindings.reportRevision,
      baselineStoreRevision: value.baselines.state.storeRevision,
      reviewRevision: value.reviews.state.reviewRevision,
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
    if (jsonBytes(result) <= MAX_PAGE_BYTES) return result;
    if (anchorIndex >= 0 && selected.length > 1) {
      // Response-size fallback must never discard a requested anchor while
      // shaving surrounding context. The next pass proves whether that one
      // authoritative item itself fits the hard response envelope.
      const located = await value.caseIndex.locate(options.anchorItemId);
      selected = located ? [caseRow(located.entry)] : [];
      offset = anchorIndex;
      continue;
    }
    selected = selected.slice(0, Math.max(0, selected.length - 1));
  }
  if (offset >= total) return {
    schemaVersion: 1,
    mode: 'single-site',
    publicationRevision: value.bindings.reportRevision,
    baselineStoreRevision: value.baselines.state.storeRevision,
    reviewRevision: value.reviews.state.reviewRevision,
    items: [], total, offset, limit, hasMore: false, nextOffset: offset,
    hasPrevious: offset > 0, previousOffset: Math.max(0, offset - MAX_PAGE_SCAN_ROWS), queuePosition: null, anchorExcluded: false,
    filteredTotal: offset === 0 ? 0 : null,
    scan: { offset, nextOffset: offset, rows: 0, complete: offset === 0 },
    sourceWork: { ...value.work },
  };
  fail(413, 'SINGLE_SITE_GALLERY_ITEM_TOO_LARGE', 'One Single-site gallery item exceeds the page byte bound.');
}

export async function readSingleSiteGalleryItem(snapshot, itemId, options = {}) {
  const value = internal(snapshot);
  if ((options.revision !== undefined && options.revision !== value.bindings.reportRevision)
    || (options.baselineStoreRevision !== undefined
      && options.baselineStoreRevision !== value.baselines.state.storeRevision)
    || (options.reviewRevision !== undefined
      && options.reviewRevision !== value.reviews.state.reviewRevision)) {
    fail(409, 'SINGLE_SITE_GALLERY_REVISION_STALE', 'The requested Single-site gallery revision is no longer current.');
  }
  if (typeof itemId !== 'string' || !GALLERY_ITEM_ID.test(itemId)) fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery item not found.');
  const located = await value.caseIndex.locate(itemId);
  if (!located) fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery item not found.');
  return { item: await enrichItem(snapshot, caseRow(located.entry), options.signal), sourceWork: { ...value.work } };
}

export async function reviewSingleSiteGalleryItem(snapshot, itemId, input) {
  const value = internal(snapshot);
  if (!value.mutationAuthorized) fail(403, 'SINGLE_SITE_VISUAL_REVIEW_FORBIDDEN', 'Visual review mutations require the authorized portal operator session.');
  if (!value.reviewStore) fail(409, 'SINGLE_SITE_VISUAL_REVIEW_UNAVAILABLE', 'Visual review storage is not configured.');
  if (typeof itemId !== 'string' || !GALLERY_ITEM_ID.test(itemId)) fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery item not found.');
  const located = await value.caseIndex.locate(itemId);
  if (!located) fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery item not found.');
  const row = caseRow(located.entry);
  if (!isRecord(input)) fail(400, 'SINGLE_SITE_VISUAL_REVIEW_INPUT_INVALID', 'Visual review request is required.');
  const fields = ['expectedReviewRevision', 'expectedBaselineStoreRevision', 'disposition', 'rationale', 'idempotencyKey', 'confirmation'];
  if (Object.keys(input).length !== fields.length || fields.some((key) => !(key in input))) {
    fail(400, 'SINGLE_SITE_VISUAL_REVIEW_INPUT_INVALID', 'Visual review request has unsupported or missing fields.');
  }
  if (input.confirmation !== `REVIEW ${itemId}`) {
    fail(400, 'SINGLE_SITE_VISUAL_REVIEW_CONFIRMATION', `Type ${JSON.stringify(`REVIEW ${itemId}`)} exactly.`);
  }
  const item = await enrichItem(snapshot, row);
  const binding = item[REVIEW_BINDING];
  if (!binding || !['CHANGED', 'REVIEWED'].includes(item.visualReviewStatus)) {
    fail(409, 'SINGLE_SITE_VISUAL_REVIEW_NOT_CHANGED', 'Only an exact current CHANGED visual comparison can receive a human disposition.');
  }
  const result = await reviewVisualComparison(value.reviewStore, value.baselineStore, {
    expectedReviewRevision: input.expectedReviewRevision,
    expectedBaselineStoreRevision: input.expectedBaselineStoreRevision,
    binding,
    actorId: 'portal-operator',
    rationale: input.rationale,
    disposition: input.disposition,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    schemaVersion: 1,
    mode: 'single-site',
    jobId: value.jobId,
    itemId,
    baselineStoreRevision: input.expectedBaselineStoreRevision,
    reviewRevision: result.reviewRevision,
    status: result.status,
    disposition: result.disposition,
    eventId: result.eventId,
    reviewKey: result.reviewKey,
    idempotent: result.idempotent,
    policyEffects: {
      deterministicFindings: 'none',
      siteHealth: 'none',
      coverage: 'none',
      immutableRunPublication: 'none',
    },
  };
}

function artifactRelativePath(jobId, href) {
  if (typeof href !== 'string' || href.includes('\\')) return null;
  let url;
  try { url = new URL(href, 'https://single-site-gallery.invalid'); } catch { return null; }
  if (url.origin !== 'https://single-site-gallery.invalid' || url.search || url.hash) return null;
  const prefix = `/artifacts/${encodeURIComponent(jobId)}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const segments = url.pathname.slice(prefix.length).split('/');
  const decoded = [];
  for (const segment of segments) {
    let value;
    try { value = decodeURIComponent(segment); } catch { return null; }
    if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return null;
    decoded.push(value);
  }
  return decoded.join('/');
}

async function fileDigest(handle, size) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, size));
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead < 1) fail(410, 'SINGLE_SITE_GALLERY_MEDIA_GONE', 'Gallery media changed while it was being read.');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `sha256:${hash.digest('hex')}`;
}

async function secureMediaDescriptor(root, file, expected, contentType) {
  if (!MEDIA_TYPES.has(contentType)) fail(404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND', 'Gallery media type is not supported.');
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(file);
  if (!contained(absoluteRoot, absolute) || absolute === absoluteRoot) fail(404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND', 'Gallery media path is invalid.');
  let stat;
  try { stat = await fs.lstat(absolute); } catch (error) {
    if (error?.code === 'ENOENT') fail(410, 'SINGLE_SITE_GALLERY_MEDIA_GONE', 'Gallery media is no longer available.');
    throw error;
  }
  const [realRoot, real] = await Promise.all([fs.realpath(absoluteRoot), fs.realpath(absolute)]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_MEDIA_BYTES
    || real !== absolute || !contained(realRoot, real)) {
    fail(410, 'SINGLE_SITE_GALLERY_MEDIA_GONE', 'Gallery media is unsafe, empty, or oversized.');
  }
  const handle = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let opened;
  let actualDigest;
  try {
    opened = await handle.stat();
    if (!opened.isFile() || opened.size !== stat.size || (stat.ino && opened.ino !== stat.ino) || (stat.dev && opened.dev !== stat.dev)) {
      fail(410, 'SINGLE_SITE_GALLERY_MEDIA_GONE', 'Gallery media changed while it was being opened.');
    }
    actualDigest = await fileDigest(handle, opened.size);
    const expectedBytes = Number.isSafeInteger(expected?.bytes) ? expected.bytes : null;
    const expectedDigest = normalizeDigest(expected?.sha256);
    if (expectedBytes !== null && opened.size !== expectedBytes) fail(422, 'SINGLE_SITE_GALLERY_MEDIA_INTEGRITY', 'Gallery media byte count does not match immutable metadata.');
    if (expectedDigest && actualDigest !== expectedDigest) fail(422, 'SINGLE_SITE_GALLERY_MEDIA_INTEGRITY', 'Gallery media digest does not match immutable metadata.');
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  const descriptor = {
    contentType,
    bytes: opened.size,
    sha256: actualDigest,
    etag: `"${actualDigest.slice('sha256:'.length)}"`,
  };
  Object.defineProperty(descriptor, 'absolutePath', { value: real, enumerable: false });
  Object.defineProperty(descriptor, 'opened', {
    value: Object.freeze({ handle, stat: opened }),
    enumerable: false,
  });
  return Object.freeze(descriptor);
}

export async function resolveSingleSiteGalleryMedia(snapshot, itemId, view, options = {}) {
  const value = internal(snapshot);
  if (typeof itemId !== 'string' || !GALLERY_ITEM_ID.test(itemId)) fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery item not found.');
  if (!['current', 'diff'].includes(view)) fail(404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND', 'Gallery media view not found.');
  const located = await value.caseIndex.locate(itemId);
  if (!located) fail(404, 'SINGLE_SITE_GALLERY_ITEM_NOT_FOUND', 'Gallery item not found.');
  const row = caseRow(located.entry);
  active(options.signal);
  const detail = await value.dependencies.readGalleryItem(value.gallery, value.jobId, itemId, options.signal);
  const current = selectCurrentMedia(detail);
  if (view === 'current') {
    const relative = artifactRelativePath(value.jobId, current?.href);
    if (!current || !relative) fail(404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND', 'Current gallery media is unavailable.');
    return secureMediaDescriptor(value.reportRoot.real, path.join(value.reportRoot.real, ...relative.split('/')), {
      bytes: current.sizeBytes,
      sha256: current.sha256,
    }, current.contentType);
  }
  if (row.kind !== 'image' || !current) fail(404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND', 'This evidence has no pixel difference image.');
  const visual = findVisual(value, row, detail, current);
  const overlay = baselineOverlay(value, visual);
  if (!overlay.diff || overlay.stale) fail(404, 'SINGLE_SITE_GALLERY_MEDIA_NOT_FOUND', 'No current-baseline difference image is available.');
  if (typeof overlay.diff.relativePath !== 'string' || path.isAbsolute(overlay.diff.relativePath)
    || !/^diffs\/[a-f0-9]{32}\.png$/.test(overlay.diff.relativePath)) {
    fail(500, 'SINGLE_SITE_GALLERY_INTEGRITY_INVALID', 'Visual difference path is invalid.');
  }
  return secureMediaDescriptor(value.visualRoot.real, path.join(value.visualRoot.real, ...overlay.diff.relativePath.split('/')), overlay.diff, 'image/png');
}
