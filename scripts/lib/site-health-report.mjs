import { deriveSiteHealth } from './site-health.mjs';

export const SINGLE_SITE_REPORT_SCHEMA_VERSION = 1;
export const DEFAULT_SINGLE_SITE_REPORT_PAGE_SIZE = 50;
export const MIN_SINGLE_SITE_REPORT_PAGE_SIZE = 10;
export const MAX_SINGLE_SITE_REPORT_PAGE_SIZE = 100;
export const MAX_SINGLE_SITE_REPORT_ITEMS = 10_000;

const AUDIT_STATUSES = new Set([
  'PASS', 'FAIL', 'FLAKY', 'REVIEW', 'BLOCKED', 'NOT_RUN', 'MANUAL_REQUIRED', 'INTENDED_CHANGE',
]);
const VISUAL_STATUSES = new Set([
  'UNCHANGED', 'CHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable', 'not-applicable',
]);
const EXECUTION_STATUSES = new Set([
  'queued', 'starting', 'running', 'finalizing', 'completed', 'failed', 'incomplete', 'cancelled',
]);
const ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,159}$/;
const REVISION_PATTERN = /^[a-f0-9]{32}$/;
const PAGE_PATH_PATTERN = /^(audits|coverage|scope\/(?:selected|omitted|outside-mode))\/page-(\d{6})\.json$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new TypeError(`${label} contains unknown fields: ${unexpected.sort().join(', ')}.`);
}

function nonEmptyString(value, label, maximum = 1_200) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty string without surrounding whitespace.`);
  }
  if (value.length > maximum) throw new TypeError(`${label} exceeds its ${maximum}-character bound.`);
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value;
}

function stringList(value, label, maximumItems = MAX_SINGLE_SITE_REPORT_ITEMS, maximumLength = 240) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new TypeError(`${label} must be an array containing no more than ${maximumItems} items.`);
  }
  const normalized = value.map((item, index) => nonEmptyString(item, `${label}[${index}]`, maximumLength));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} must not contain duplicates.`);
  return normalized;
}

function pageSize(value) {
  const normalized = value ?? DEFAULT_SINGLE_SITE_REPORT_PAGE_SIZE;
  if (!Number.isSafeInteger(normalized) || normalized < MIN_SINGLE_SITE_REPORT_PAGE_SIZE
    || normalized > MAX_SINGLE_SITE_REPORT_PAGE_SIZE) {
    throw new TypeError(`pageSize must be between ${MIN_SINGLE_SITE_REPORT_PAGE_SIZE} and ${MAX_SINGLE_SITE_REPORT_PAGE_SIZE}.`);
  }
  return normalized;
}

function reportAudit(value, index) {
  const label = `audits[${index}]`;
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  exactKeys(value, [
    'id', 'title', 'area', 'status', 'findingCount', 'evidenceStatus', 'artifactCount',
    'manual', 'visualStatus', 'detail',
  ], label);
  const id = nonEmptyString(value.id, `${label}.id`, 160);
  if (!ID_PATTERN.test(id)) throw new TypeError(`${label}.id is invalid.`);
  if (!AUDIT_STATUSES.has(value.status)) throw new TypeError(`${label}.status is invalid.`);
  if (!['complete', 'incomplete'].includes(value.evidenceStatus)) {
    throw new TypeError(`${label}.evidenceStatus is invalid.`);
  }
  if (!VISUAL_STATUSES.has(value.visualStatus)) throw new TypeError(`${label}.visualStatus is invalid.`);
  if (typeof value.manual !== 'boolean') throw new TypeError(`${label}.manual must be boolean.`);
  return {
    id,
    title: nonEmptyString(value.title, `${label}.title`, 400),
    area: nonEmptyString(value.area, `${label}.area`, 160),
    status: value.status,
    findingCount: count(value.findingCount, `${label}.findingCount`),
    evidenceStatus: value.evidenceStatus,
    artifactCount: count(value.artifactCount, `${label}.artifactCount`),
    manual: value.manual,
    visualStatus: value.visualStatus,
    detail: nonEmptyString(value.detail, `${label}.detail`, 2_400),
  };
}

function outsideModeItem(value, index) {
  const label = `outsideMode[${index}]`;
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  exactKeys(value, ['auditId', 'title', 'reason'], label);
  const auditId = nonEmptyString(value.auditId, `${label}.auditId`, 160);
  if (!ID_PATTERN.test(auditId)) throw new TypeError(`${label}.auditId is invalid.`);
  if (value.reason !== 'comparison-only') throw new TypeError(`${label}.reason must be comparison-only.`);
  return {
    auditId,
    title: nonEmptyString(value.title, `${label}.title`, 400),
    reason: 'comparison-only',
  };
}

function paginate(items, size) {
  const pages = [];
  for (let offset = 0; offset < items.length; offset += size) pages.push(items.slice(offset, offset + size));
  return pages;
}

function pageDescriptor(total, size, pathPrefix) {
  const pageCount = total === 0 ? 0 : Math.ceil(total / size);
  return {
    total,
    pageSize: size,
    pageCount,
    pathTemplate: `${pathPrefix}/page-{page}.json`,
  };
}

function pagePath(prefix, page) {
  return `${prefix}/page-${String(page).padStart(6, '0')}.json`;
}

function addPages(documents, prefix, kind, items, size, common) {
  const pages = paginate(items, size);
  for (const [index, pageItems] of pages.entries()) {
    const page = index + 1;
    documents.set(pagePath(prefix, page), {
      ...common,
      kind,
      page,
      pageCount: pages.length,
      pageSize: size,
      total: items.length,
      items: pageItems,
    });
  }
}

function visualSummary(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.total) || !Number.isSafeInteger(value.attentionRequired)
    || !isRecord(value.byStatus)) throw new TypeError('visualReview summary is invalid.');
  const byStatus = {};
  let total = 0;
  for (const status of ['UNCHANGED', 'CHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable']) {
    const amount = count(value.byStatus[status], `visualReview.byStatus.${status}`);
    byStatus[status] = amount;
    total += amount;
  }
  if (Object.keys(value.byStatus).some((status) => !(status in byStatus)) || total !== value.total
    || value.attentionRequired !== byStatus.CHANGED) {
    throw new TypeError('visualReview totals and status counts disagree.');
  }
  return { total, attentionRequired: value.attentionRequired, byStatus };
}

/**
 * Builds immutable compact documents. The caller owns filesystem publication;
 * this function never reads live evidence or reconstructs truth from labels.
 */
export function buildSingleSiteReportDocuments(input, publication = {}) {
  if (!isRecord(input) || input.schemaVersion !== 1 || input.mode !== 'single-site') {
    throw new TypeError('Single-site report input must use schemaVersion 1 and mode single-site.');
  }
  exactKeys(input, ['schemaVersion', 'mode', 'generatedAt', 'health', 'audits', 'outsideMode', 'pageSize'], 'report input');
  const generatedAt = nonEmptyString(input.generatedAt, 'generatedAt', 80);
  if (!Number.isFinite(Date.parse(generatedAt))) throw new TypeError('generatedAt must be an ISO-compatible timestamp.');
  const publicationRevision = nonEmptyString(publication.publicationRevision, 'publicationRevision', 32);
  if (!REVISION_PATTERN.test(publicationRevision)) throw new TypeError('publicationRevision must be 32 lowercase hexadecimal characters.');
  const size = pageSize(input.pageSize);
  if (!Array.isArray(input.audits) || input.audits.length > MAX_SINGLE_SITE_REPORT_ITEMS) {
    throw new TypeError(`audits must contain no more than ${MAX_SINGLE_SITE_REPORT_ITEMS} rows.`);
  }
  if (!Array.isArray(input.outsideMode) || input.outsideMode.length > MAX_SINGLE_SITE_REPORT_ITEMS) {
    throw new TypeError(`outsideMode must contain no more than ${MAX_SINGLE_SITE_REPORT_ITEMS} rows.`);
  }
  const audits = input.audits.map(reportAudit).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(audits.map(({ id }) => id)).size !== audits.length) throw new TypeError('Audit report IDs must be unique.');
  const outsideMode = input.outsideMode.map(outsideModeItem).sort((left, right) => left.auditId.localeCompare(right.auditId));
  if (new Set(outsideMode.map(({ auditId }) => auditId)).size !== outsideMode.length) {
    throw new TypeError('outsideMode Audit Definition IDs must be unique.');
  }
  const truth = deriveSiteHealth(input.health);
  const selected = stringList(truth.scope.selectedCoverage, 'selectedCoverage').sort();
  const omitted = stringList(truth.scope.omittedCoverage, 'omittedCoverage').sort();
  const coverageGaps = stringList(truth.coverage.gaps, 'coverage.gaps');
  const coverageLimitations = stringList(truth.coverage.limitations, 'coverage.limitations');
  const authorityReasons = stringList(truth.evidenceAuthority.reasons, 'evidenceAuthority.reasons', 20, 160);
  const coverageItems = [
    ...coverageGaps.map((detail) => ({ kind: 'gap', detail })),
    ...coverageLimitations.map((detail) => ({ kind: 'limitation', detail })),
  ].sort((left, right) => left.kind.localeCompare(right.kind) || left.detail.localeCompare(right.detail));
  if (coverageItems.length > MAX_SINGLE_SITE_REPORT_ITEMS) {
    throw new TypeError(`Combined Coverage details exceed the ${MAX_SINGLE_SITE_REPORT_ITEMS}-item publication bound.`);
  }
  if (audits.reduce((total, audit) => total + audit.findingCount, 0) !== truth.siteHealth.findingCount) {
    throw new TypeError('Audit row finding counts disagree with Site Health findingCount.');
  }
  const common = {
    schemaVersion: SINGLE_SITE_REPORT_SCHEMA_VERSION,
    mode: 'single-site',
    publicationRevision,
    generatedAt,
  };
  const descriptors = {
    audits: pageDescriptor(audits.length, size, 'audits'),
    selected: pageDescriptor(selected.length, size, 'scope/selected'),
    omitted: pageDescriptor(omitted.length, size, 'scope/omitted'),
    outsideMode: pageDescriptor(outsideMode.length, size, 'scope/outside-mode'),
    coverage: pageDescriptor(coverageItems.length, size, 'coverage'),
  };
  const summary = {
    ...common,
    kind: 'single-site-report-summary',
    advisory: true,
    auditedUrl: truth.auditedUrl,
    deploymentRole: truth.deploymentRole,
    scope: {
      qualifier: truth.scope.qualifier,
      selected: { ...descriptors.selected, preview: selected.slice(0, 12) },
      omitted: { ...descriptors.omitted, preview: omitted.slice(0, 12) },
      outsideMode: { ...descriptors.outsideMode, preview: outsideMode.slice(0, 12) },
    },
    siteHealth: truth.siteHealth,
    coverage: {
      status: truth.coverage.status,
      gapCount: truth.coverage.gapCount,
      limitationCount: truth.coverage.limitationCount,
      pages: descriptors.coverage,
      preview: coverageItems.slice(0, 12),
    },
    evidenceCompletion: truth.evidenceCompletion,
    evidenceAuthority: { status: truth.evidenceAuthority.status, reasons: authorityReasons },
    findings: { count: truth.siteHealth.findingCount },
    manual: truth.manual,
    visualReview: truth.visualReview,
    lifecycle: { executionStatus: truth.pipelineIntegrity.executionStatus },
    pipelineIntegrity: truth.pipelineIntegrity,
    promotion: truth.promotion,
    auditPages: descriptors.audits,
  };
  const documents = new Map([['summary.json', summary]]);
  addPages(documents, 'audits', 'single-site-audit-page', audits, size, common);
  addPages(documents, 'scope/selected', 'single-site-selected-scope-page', selected, size, common);
  addPages(documents, 'scope/omitted', 'single-site-omitted-scope-page', omitted, size, common);
  addPages(documents, 'scope/outside-mode', 'single-site-outside-mode-page', outsideMode, size, common);
  addPages(documents, 'coverage', 'single-site-coverage-page', coverageItems, size, common);
  return { summary, documents };
}

function assertDescriptor(value, label, expectedPrefix, withPreview) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  exactKeys(value, [
    'total', 'pageSize', 'pageCount', 'pathTemplate', ...(withPreview ? ['preview'] : []),
  ], label);
  const total = count(value.total, `${label}.total`);
  const size = count(value.pageSize, `${label}.pageSize`);
  const pageCount = count(value.pageCount, `${label}.pageCount`);
  if (total > MAX_SINGLE_SITE_REPORT_ITEMS
    || size < MIN_SINGLE_SITE_REPORT_PAGE_SIZE || size > MAX_SINGLE_SITE_REPORT_PAGE_SIZE
    || pageCount !== (total === 0 ? 0 : Math.ceil(total / size))
    || value.pathTemplate !== `${expectedPrefix}/page-{page}.json`
    || (withPreview && (!Array.isArray(value.preview) || value.preview.length > 12 || value.preview.length > total))) {
    throw new TypeError(`${label} pagination metadata is inconsistent.`);
  }
  return {
    total,
    pageSize: size,
    pageCount,
    pathTemplate: value.pathTemplate,
    ...(withPreview ? { preview: value.preview } : {}),
  };
}

export function parseSingleSiteReportSummary(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.mode !== 'single-site'
    || value.kind !== 'single-site-report-summary') {
    throw new TypeError('Compact summary is not a schemaVersion 1 Single-site report summary.');
  }
  exactKeys(value, [
    'schemaVersion', 'mode', 'publicationRevision', 'generatedAt', 'kind', 'advisory', 'auditedUrl',
    'deploymentRole', 'scope', 'siteHealth', 'coverage', 'evidenceCompletion', 'evidenceAuthority',
    'findings', 'manual', 'visualReview', 'lifecycle', 'pipelineIntegrity', 'promotion', 'auditPages',
  ], 'single-site report summary');
  if (!REVISION_PATTERN.test(value.publicationRevision) || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new TypeError('Single-site report summary revision or generatedAt is invalid.');
  }
  if (value.advisory !== true || !['preview', 'production'].includes(value.deploymentRole)) {
    throw new TypeError('Single-site report summary advisory role is invalid.');
  }
  let parsedUrl;
  try { parsedUrl = new URL(value.auditedUrl); } catch { parsedUrl = null; }
  if (!parsedUrl || parsedUrl.origin !== value.auditedUrl || parsedUrl.pathname !== '/') {
    throw new TypeError('Single-site report auditedUrl must be an exact origin.');
  }
  if (!isRecord(value.scope) || !['FULL', 'TARGETED'].includes(value.scope.qualifier)) {
    throw new TypeError('Single-site report scope is invalid.');
  }
  exactKeys(value.scope, ['qualifier', 'selected', 'omitted', 'outsideMode'], 'single-site report scope');
  const selected = assertDescriptor(value.scope.selected, 'scope.selected', 'scope/selected', true);
  const omitted = assertDescriptor(value.scope.omitted, 'scope.omitted', 'scope/omitted', true);
  const outsideMode = assertDescriptor(value.scope.outsideMode, 'scope.outsideMode', 'scope/outside-mode', true);
  stringList(selected.preview, 'scope.selected.preview', 12);
  stringList(omitted.preview, 'scope.omitted.preview', 12);
  outsideMode.preview.forEach(outsideModeItem);
  if (value.scope.qualifier === 'FULL' && omitted.total > 0) throw new TypeError('FULL report scope cannot contain omissions.');
  const auditPages = assertDescriptor(value.auditPages, 'auditPages', 'audits', false);
  if (!isRecord(value.coverage)) throw new TypeError('Single-site report coverage is invalid.');
  exactKeys(value.coverage, ['status', 'gapCount', 'limitationCount', 'pages', 'preview'], 'coverage');
  if (!['COMPLETE', 'GAPS', 'UNKNOWN'].includes(value.coverage.status)) throw new TypeError('Coverage Status is invalid.');
  const gapCount = count(value.coverage.gapCount, 'coverage.gapCount');
  const limitationCount = count(value.coverage.limitationCount, 'coverage.limitationCount');
  const coveragePages = assertDescriptor(value.coverage.pages, 'coverage.pages', 'coverage', false);
  if (coveragePages.total !== gapCount + limitationCount) throw new TypeError('Coverage issue count disagrees with coverage pages.');
  if (!Array.isArray(value.coverage.preview) || value.coverage.preview.length > 12
    || value.coverage.preview.length > coveragePages.total) throw new TypeError('Coverage preview is invalid.');
  for (const [index, item] of value.coverage.preview.entries()) {
    if (!isRecord(item)) throw new TypeError(`coverage.preview[${index}] is invalid.`);
    exactKeys(item, ['kind', 'detail'], `coverage.preview[${index}]`);
    if (!['gap', 'limitation'].includes(item.kind)) throw new TypeError(`coverage.preview[${index}].kind is invalid.`);
    nonEmptyString(item.detail, `coverage.preview[${index}].detail`, 240);
  }
  if (!isRecord(value.siteHealth)) throw new TypeError('Site Health summary is invalid.');
  exactKeys(value.siteHealth, ['verdict', 'displayLabel', 'reason', 'findingCount'], 'siteHealth');
  if (!['INCOMPLETE', 'FINDINGS', 'HEALTHY'].includes(value.siteHealth.verdict)
    || !Number.isSafeInteger(value.siteHealth.findingCount) || value.siteHealth.findingCount < 0
    || typeof value.siteHealth.displayLabel !== 'string' || typeof value.siteHealth.reason !== 'string'
    || value.siteHealth.reason.trim().length === 0) {
    throw new TypeError('Site Health summary is invalid.');
  }
  if (!isRecord(value.findings) || Object.keys(value.findings).length !== 1
    || value.findings.count !== value.siteHealth.findingCount) throw new TypeError('Finding count disagrees with Site Health.');
  if (!isRecord(value.evidenceCompletion)) throw new TypeError('Evidence completion is invalid.');
  exactKeys(value.evidenceCompletion, ['status'], 'evidenceCompletion');
  if (!['complete', 'incomplete'].includes(value.evidenceCompletion.status)) {
    throw new TypeError('Evidence completion is invalid.');
  }
  if (!isRecord(value.evidenceAuthority)) throw new TypeError('Evidence Authority is invalid.');
  exactKeys(value.evidenceAuthority, ['status', 'reasons'], 'evidenceAuthority');
  const authorityReasons = stringList(value.evidenceAuthority.reasons, 'evidenceAuthority.reasons', 20, 160);
  if (!['authoritative', 'non-authoritative'].includes(value.evidenceAuthority.status)
    || (value.evidenceAuthority.status === 'authoritative') !== (authorityReasons.length === 0)) {
    throw new TypeError('Evidence Authority is invalid or contradictory.');
  }
  if (!isRecord(value.lifecycle) || Object.keys(value.lifecycle).length !== 1
    || !EXECUTION_STATUSES.has(value.lifecycle.executionStatus)) throw new TypeError('Lifecycle status is invalid.');
  if (!isRecord(value.pipelineIntegrity)) throw new TypeError('Pipeline Integrity is invalid or disagrees with lifecycle.');
  exactKeys(value.pipelineIntegrity, ['status', 'executionStatus', 'reason', 'cancellationReason'], 'pipelineIntegrity');
  if (!['complete', 'incomplete'].includes(value.pipelineIntegrity.status)
    || value.pipelineIntegrity.executionStatus !== value.lifecycle.executionStatus
    || (value.pipelineIntegrity.status === 'complete' && value.pipelineIntegrity.executionStatus !== 'completed')
    || (value.pipelineIntegrity.executionStatus === 'cancelled'
      && (typeof value.pipelineIntegrity.cancellationReason !== 'string'
        || value.pipelineIntegrity.cancellationReason.trim().length === 0))) {
    throw new TypeError('Pipeline Integrity is invalid or disagrees with lifecycle.');
  }
  if (!isRecord(value.promotion)) throw new TypeError('Single-site report promotion effect must be none.');
  exactKeys(value.promotion, ['authorized', 'effect', 'statement'], 'promotion');
  if (value.promotion.authorized !== false || value.promotion.effect !== 'none'
    || typeof value.promotion.statement !== 'string' || value.promotion.statement.length === 0) {
    throw new TypeError('Single-site report promotion effect must be none.');
  }
  visualSummary(value.visualReview);
  if (!isRecord(value.manual)) throw new TypeError('Manual status is invalid.');
  exactKeys(value.manual, ['required', 'complete', 'failedOrBlocked', 'outstanding', 'status'], 'manual');
  const manualRequired = count(value.manual.required, 'manual.required');
  const manualComplete = count(value.manual.complete, 'manual.complete');
  const manualFailed = count(value.manual.failedOrBlocked, 'manual.failedOrBlocked');
  const manualOutstanding = count(value.manual.outstanding, 'manual.outstanding');
  const expectedManualStatus = manualRequired === 0
    ? 'NOT_REQUIRED'
    : manualFailed > 0 ? 'FAILED_OR_BLOCKED' : manualOutstanding > 0 ? 'OUTSTANDING' : 'COMPLETE';
  if (manualComplete + manualFailed + manualOutstanding !== manualRequired
    || value.manual.status !== expectedManualStatus) throw new TypeError('Manual status counts disagree.');
  const completionTrusted = value.pipelineIntegrity.status === 'complete'
    && value.evidenceCompletion.status === 'complete'
    && value.coverage.status !== 'UNKNOWN';
  const expectedVerdict = !completionTrusted
    ? 'INCOMPLETE'
    : value.findings.count > 0 ? 'FINDINGS' : 'HEALTHY';
  if (value.siteHealth.verdict !== expectedVerdict) throw new TypeError('Site Health verdict contradicts compact report truth.');
  const qualifiers = [
    ...(value.scope.qualifier === 'TARGETED' ? ['TARGETED'] : []),
    ...(value.evidenceAuthority.status === 'non-authoritative' ? ['NON-AUTHORITATIVE'] : []),
  ];
  const expectedLabel = qualifiers.length > 0 ? `${expectedVerdict} · ${qualifiers.join(' · ')}` : expectedVerdict;
  if (value.siteHealth.displayLabel !== expectedLabel) throw new TypeError('Site Health displayLabel is not scope/authority qualified.');
  if ((value.coverage.status === 'COMPLETE' && coveragePages.total !== 0)
    || (value.coverage.status === 'GAPS' && coveragePages.total === 0)) {
    throw new TypeError('Coverage Status contradicts its gap and limitation counts.');
  }
  return {
    ...value,
    scope: { qualifier: value.scope.qualifier, selected, omitted, outsideMode },
    coverage: { ...value.coverage, gapCount, limitationCount, pages: coveragePages },
    auditPages,
  };
}

export function expectedSingleSiteReportPaths(summary) {
  const parsed = parseSingleSiteReportSummary(summary);
  const paths = ['summary.json'];
  for (const [prefix, descriptor] of [
    ['audits', parsed.auditPages],
    ['scope/selected', parsed.scope.selected],
    ['scope/omitted', parsed.scope.omitted],
    ['scope/outside-mode', parsed.scope.outsideMode],
    ['coverage', parsed.coverage.pages],
  ]) {
    for (let page = 1; page <= descriptor.pageCount; page += 1) paths.push(pagePath(prefix, page));
  }
  return paths;
}

export function parseSingleSiteReportPage(value, relativePath, summary) {
  const pathMatch = PAGE_PATH_PATTERN.exec(relativePath);
  if (!pathMatch) throw new TypeError('Single-site report page path is invalid.');
  if (!isRecord(value) || value.schemaVersion !== 1 || value.mode !== 'single-site'
    || value.publicationRevision !== summary.publicationRevision || value.generatedAt !== summary.generatedAt) {
    throw new TypeError(`Single-site report page ${relativePath} is not bound to its summary revision.`);
  }
  exactKeys(value, [
    'schemaVersion', 'mode', 'publicationRevision', 'generatedAt', 'kind', 'page', 'pageCount',
    'pageSize', 'total', 'items',
  ], `single-site report page ${relativePath}`);
  const expectedPage = Number(pathMatch[2]);
  if (!Number.isSafeInteger(value.page) || value.page !== expectedPage || !Array.isArray(value.items)
    || value.items.length < 1 || value.items.length > value.pageSize) {
    throw new TypeError(`Single-site report page ${relativePath} has invalid page metadata.`);
  }
  const key = pathMatch[1];
  const expectedKinds = {
    audits: 'single-site-audit-page',
    coverage: 'single-site-coverage-page',
    'scope/selected': 'single-site-selected-scope-page',
    'scope/omitted': 'single-site-omitted-scope-page',
    'scope/outside-mode': 'single-site-outside-mode-page',
  };
  if (value.kind !== expectedKinds[key]) throw new TypeError(`Single-site report page ${relativePath} has the wrong kind.`);
  const descriptor = key === 'audits'
    ? summary.auditPages
    : key === 'coverage'
      ? summary.coverage.pages
      : key === 'scope/selected'
        ? summary.scope.selected
        : key === 'scope/omitted'
          ? summary.scope.omitted
          : summary.scope.outsideMode;
  if (value.pageCount !== descriptor.pageCount || value.pageSize !== descriptor.pageSize || value.total !== descriptor.total
    || value.page > descriptor.pageCount) throw new TypeError(`Single-site report page ${relativePath} contradicts its summary descriptor.`);
  const expectedLength = value.page < value.pageCount
    ? value.pageSize
    : value.total - value.pageSize * (value.pageCount - 1);
  if (value.items.length !== expectedLength) throw new TypeError(`Single-site report page ${relativePath} item count is invalid.`);
  let items;
  if (key === 'audits') items = value.items.map(reportAudit);
  else if (key === 'scope/selected' || key === 'scope/omitted') {
    items = stringList(value.items, `${relativePath}.items`, MAX_SINGLE_SITE_REPORT_PAGE_SIZE);
  } else if (key === 'scope/outside-mode') items = value.items.map(outsideModeItem);
  else {
    items = value.items.map((item, index) => {
      if (!isRecord(item)) throw new TypeError(`${relativePath}.items[${index}] is invalid.`);
      exactKeys(item, ['kind', 'detail'], `${relativePath}.items[${index}]`);
      if (!['gap', 'limitation'].includes(item.kind)) throw new TypeError(`${relativePath}.items[${index}].kind is invalid.`);
      return { kind: item.kind, detail: nonEmptyString(item.detail, `${relativePath}.items[${index}].detail`, 240) };
    });
  }
  return { ...value, items };
}
