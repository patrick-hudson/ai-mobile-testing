import { createHash } from 'node:crypto';
import { productRiskToConsoleIndexRecord } from './console-index-records.mjs';
import { createProductRiskRecord } from './console-risk.mjs';
import { readPublishedReportJson } from './report-publication.mjs';
import {
  parseSingleSiteReportPage,
  parseSingleSiteReportSummary,
} from '../scripts/lib/site-health-report.mjs';

export const CONSOLE_REPORT_PROJECTION_SCHEMA_VERSION = 1;
export const CONSOLE_REPORT_PROJECTION_LIMITS = Object.freeze({
  maximumBatchRecords: 100,
  maximumDocumentsPerBatch: 4,
  maximumSourceBytesPerBatch: 2 * 1024 * 1024,
  maximumDocumentBytes: 2 * 1024 * 1024,
  maximumProjectedRecordsPerDocument: 2_000,
  maximumMetricsPerPublication: 6,
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const REVISION = /^[a-f0-9]{32}$/u;
const CONTROL_TEXT = /[\u0000-\u001f\u007f]/u;
const SECRET_TEXT = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|secret)\s*[=:]\s*[^\s,;]{4,}|https?:\/\/[^\s/@:]+:[^\s/@]+@)/iu;
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const ATTENTION_STATUSES = new Set(['FAIL', 'BLOCKED', 'FLAKY', 'REVIEW', 'NOT_RUN', 'MANUAL_REQUIRED']);
const SEVERITY_RANK = new Map([['P0', '0'], ['P1', '1'], ['P2', '2'], ['P3', '3']]);
const MEDIA_KINDS = new Set(['video', 'screenshot', 'trace', 'axe', 'network', 'lighthouse', 'json', 'other']);
const DOCUMENT_PATH = /^(?:summary\.json|audits\.json|audits\/[A-Z0-9-]{3,160}\.json|(?:audits|coverage|scope\/(?:selected|omitted|outside-mode))\/page-\d{6}\.json)$/u;

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : null;
}

function safeText(value, maximum = 1_200) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maximum || CONTROL_TEXT.test(text) || SECRET_TEXT.test(text)
    || ABSOLUTE_URL.test(text)) return null;
  return text;
}

function safeIdentifier(value, maximum = 160) {
  const text = safeText(value, maximum);
  return text && SAFE_ID.test(text) ? text : null;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function digest(value, length = 32) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function stableDigest(value) {
  return digest(JSON.stringify(value), 40);
}

function normalizeScopeKey(value) {
  const scope = safeText(value, 512) ?? 'unknown';
  return /^scope_[a-f0-9]{24}$/u.test(scope) ? scope : `scope_${digest(scope, 24)}`;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function safeList(value, maximum = 64, itemMaximum = 240) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, maximum).map((item) => safeText(item, itemMaximum)).filter(Boolean))];
}

function safeRelativeHref(value) {
  const href = safeText(value, 800);
  if (!href || href.startsWith('/') || href.includes('\\')) return null;
  const segments = href.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return href;
}

export function reportArtifactDestination(mode, runIdValue, href) {
  if (!['comparative', 'single-site'].includes(mode)) return null;
  const runId = safeIdentifier(runIdValue, 160);
  const relative = safeRelativeHref(href);
  if (!runId || !relative) return null;
  const encodedRelative = relative.split('/').map(encodeURIComponent).join('/');
  return mode === 'single-site'
    ? `/single-site-artifacts/${encodeURIComponent(runId)}/${encodedRelative}`
    : `/artifacts/${encodeURIComponent(runId)}/checklist/${encodedRelative}`;
}

function collectionDestination(kind, context, recordId) {
  const page = kind === 'evidence' ? 'evidence.html' : 'findings.html';
  const selection = kind === 'evidence' ? 'item' : 'record';
  return `/${page}?mode=${encodeURIComponent(context.mode)}&run=${encodeURIComponent(context.runId)}&${selection}=${encodeURIComponent(recordId)}&inspector=open`;
}

function sourceId(mode) {
  return `${mode}-report-publication`;
}

function baseRecord(context, recordType, recordId, sortKey, fields, complete = true) {
  return Object.freeze({
    schemaVersion: 1,
    mode: context.mode,
    runId: context.runId,
    recordId,
    recordType,
    scopeKey: context.scopeKey,
    sourceId: context.sourceId,
    sourceRevision: context.publicationRevision,
    sourceUpdatedAt: context.generatedAt,
    complete: complete === true,
    sortKey: safeText(sortKey, 512) ?? `${recordType}:${recordId}`,
    fields: Object.freeze(compact(fields)),
  });
}

function findingIdentity(context, auditId, finding) {
  return `finding-${stableDigest([
    context.mode,
    context.runId,
    auditId,
    safeText(finding?.title, 300),
    safeText(finding?.detail, 1_200),
    safeText(finding?.severity, 16),
    typeof finding?.blocking === 'boolean' ? finding.blocking : null,
  ])}`;
}

function findingRecord(context, auditIdValue, findingValue, options = {}) {
  const finding = plainRecord(findingValue);
  const auditId = safeIdentifier(auditIdValue);
  if (!finding || !auditId) return null;
  const identity = findingIdentity(context, auditId, finding);
  const title = safeText(finding.title, 300) ?? `Finding for ${auditId}`;
  const detail = safeText(finding.detail, 1_200);
  const severity = SEVERITY_RANK.has(finding.severity) ? finding.severity : undefined;
  const affectedScope = Array.isArray(options.coveredEnvironments)
    ? new Set(options.coveredEnvironments.map((value) => safeText(value, 80)).filter(Boolean)).size
    : undefined;
  const risk = createProductRiskRecord({
    identity,
    runIdentity: { mode: context.mode, runId: context.runId },
    sourceType: 'finding',
    severity,
    blockingIntent: typeof finding.blocking === 'boolean' ? finding.blocking : undefined,
    affectedScope: affectedScope > 0 ? affectedScope : undefined,
    sourceIdentity: identity,
    sourceTimestamp: context.generatedAt,
    sourceComplete: options.complete === true,
    href: collectionDestination('finding', context, `risk:${identity}`),
  }, { hasComparablePredecessor: false, now: context.generatedAt });
  const projected = productRiskToConsoleIndexRecord(risk, context.scopeKey, {
    sourceId: context.sourceId,
    sourceRevision: context.publicationRevision,
    title,
  });
  return Object.freeze({
    ...projected,
    complete: options.complete === true,
    fields: Object.freeze(compact({
      ...projected.fields,
      auditId,
      detail,
      publicationRevision: context.publicationRevision,
      areas: safeList([options.area], 1, 160),
    })),
  });
}

function attentionFacets(row) {
  const facets = [];
  if ((safeInteger(row?.findingCount) ?? 0) > 0) facets.push('finding-summary');
  if (row?.visualStatus === 'CHANGED') facets.push('visual-review');
  if (row?.manual === true && ['MANUAL_REQUIRED', 'NOT_RUN'].includes(row?.status)) facets.push('manual-obligation');
  if (row?.status === 'FLAKY') facets.push('flaky-execution');
  if (['BLOCKED', 'NOT_RUN'].includes(row?.status)) facets.push('incomplete-execution');
  if (row?.status === 'FAIL' && facets.length === 0) facets.push('failed-audit');
  return facets;
}

function primaryAttentionKind(row, supplied = null) {
  const direct = safeText(supplied, 80);
  if (direct) return direct;
  return attentionFacets(row)[0] ?? 'audit-attention';
}

function attentionRecord(context, rowValue, options = {}) {
  const row = plainRecord(rowValue);
  const auditId = safeIdentifier(row?.auditId ?? row?.id);
  if (!row || !auditId) return null;
  const kind = primaryAttentionKind(row, options.kind);
  const recordId = `attention:${stableDigest([context.mode, context.runId, auditId, kind])}`;
  const severity = SEVERITY_RANK.has(row.severity) ? row.severity : null;
  const blocking = typeof row.releaseBlocking === 'boolean' ? row.releaseBlocking : null;
  const facets = [...new Set([kind, ...attentionFacets(row), ...safeList(row.reasonCodes, 12, 80)])].slice(0, 16);
  return baseRecord(
    context,
    'attention',
    recordId,
    `attention:${SEVERITY_RANK.get(severity) ?? '4'}:${blocking === true ? '0' : blocking === false ? '1' : '2'}:${kind}:${auditId}`,
    {
      title: safeText(row.auditTitle ?? row.title, 400) ?? auditId,
      detail: safeText(row.detail ?? row.reason, 1_200),
      status: safeText(row.auditStatus ?? row.status, 120),
      severity,
      blocking,
      attentionKind: kind,
      auditId,
      findingCount: safeInteger(row.findingCount),
      visualStatus: safeText(row.visualStatus, 120),
      sourceKind: 'report-publication',
      sourceRecordId: auditId,
      sourceRecordType: 'audit',
      sourceTimestamp: context.generatedAt,
      publicationRevision: context.publicationRevision,
      areas: safeList([row.area], 1, 160),
      reasonCodes: facets,
      destinations: [collectionDestination('finding', context, recordId)],
      limitations: options.limitations?.length ? safeList(options.limitations, 16, 160) : undefined,
    },
    options.complete === true,
  );
}

function artifactStatus(artifact) {
  if (artifact.missing === true) return 'missing';
  if (artifact.orphan === true) return 'orphan';
  if (artifact.duplicate === true) return 'duplicate';
  if (artifact.available === true) return 'available';
  if (artifact.available === false) return 'unavailable';
  return 'unknown';
}

function artifactEvidenceId(context, auditId, artifact, executionId = null) {
  const kind = MEDIA_KINDS.has(artifact?.kind) ? artifact.kind : 'other';
  const href = safeRelativeHref(artifact?.href);
  return `evidence-${stableDigest([
    context.mode,
    context.runId,
    auditId,
    href ?? safeText(artifact?.name, 300),
    kind,
    href ? null : safeText(executionId, 200),
  ])}`;
}

function evidenceRecord(context, auditIdValue, artifactValue, options = {}) {
  const artifact = plainRecord(artifactValue);
  const auditId = safeIdentifier(auditIdValue);
  if (!artifact || !auditId) return null;
  const kind = MEDIA_KINDS.has(artifact.kind) ? artifact.kind : 'other';
  const href = safeRelativeHref(artifact.href);
  const evidenceId = artifactEvidenceId(context, auditId, artifact, options.executionId);
  const recordId = `evidence:${evidenceId}`;
  const destination = href ? reportArtifactDestination(context.mode, context.runId, href) : null;
  const status = artifactStatus(artifact);
  return baseRecord(context, 'evidence', recordId, `evidence:${auditId}:${kind}:${evidenceId}`, {
    title: safeText(artifact.name, 300) ?? `${kind} evidence`,
    detail: safeText(artifact.error ?? artifact.rationale, 1_200),
    status,
    auditId,
    evidenceId,
    sourceKind: kind,
    sourceRecordId: safeIdentifier(options.executionId, 200) ?? auditId,
    sourceRecordType: options.executionId ? 'execution-artifact' : 'audit-artifact',
    sourceTimestamp: canonicalTimestamp(options.sourceTimestamp) ?? context.generatedAt,
    publicationRevision: context.publicationRevision,
    attemptNumber: safeInteger(options.attemptNumber),
    retryNumber: safeInteger(options.retryNumber),
    attentionKind: safeText(options.ownerContext, 80),
    reasonCodes: [status, kind],
    destinations: destination ? [destination] : [],
    limitations: destination ? undefined : ['artifact-destination-unavailable'],
  }, options.complete === true && status !== 'unknown');
}

function artifactAttemptProvenanceRecord(context, auditIdValue, artifactValue) {
  const artifact = plainRecord(artifactValue);
  const auditId = safeIdentifier(auditIdValue);
  const href = safeRelativeHref(artifact?.href);
  const kind = MEDIA_KINDS.has(artifact?.kind) ? artifact.kind : 'other';
  const attemptNumber = safeInteger(artifact?.attempt);
  if (!artifact || !auditId || !href || attemptNumber === null) return null;
  const evidenceId = artifactEvidenceId(context, auditId, artifact);
  const recordId = `provenance:artifact-${stableDigest([auditId, href, attemptNumber, artifact.context])}`;
  return baseRecord(context, 'provenance', recordId, `provenance:${auditId}:artifact:${recordId}`, {
    title: safeText(artifact.name, 300) ?? `${kind} evidence provenance`,
    status: 'published',
    auditId,
    evidenceId,
    sourceKind: kind,
    sourceRecordId: evidenceId,
    sourceRecordType: 'artifact-attempt',
    sourceTimestamp: context.generatedAt,
    publicationRevision: context.publicationRevision,
    attemptNumber,
    attentionKind: safeText(artifact.context, 80),
    destinations: [reportArtifactDestination(context.mode, context.runId, href)].filter(Boolean),
  }, true);
}

function auditEvidenceRecord(context, rowValue, options = {}) {
  const row = plainRecord(rowValue);
  const auditId = safeIdentifier(row?.auditId ?? row?.id);
  if (!row || !auditId) return null;
  const evidenceId = `audit-${digest(`${context.mode}:${context.runId}:${auditId}`, 32)}`;
  const recordId = `evidence:${evidenceId}`;
  const evidenceCounts = plainRecord(row.evidenceCounts);
  const kinds = evidenceCounts
    ? [...MEDIA_KINDS].filter((kind) => safeInteger(evidenceCounts[kind]) > 0)
    : [];
  const artifactCount = safeInteger(row.artifactCount)
    ?? (evidenceCounts ? Object.values(evidenceCounts).reduce((sum, value) => sum + (safeInteger(value) ?? 0), 0) : null);
  const status = safeText(row.evidenceStatus, 120) ?? (artifactCount === null ? 'unavailable' : 'published-summary');
  return baseRecord(context, 'evidence', recordId, `evidence:${auditId}:summary`, {
    title: safeText(row.title ?? row.auditTitle, 400) ?? `${auditId} evidence`,
    detail: artifactCount === null ? 'Artifact count is unavailable in this publication.' : `${artifactCount} artifact metadata record${artifactCount === 1 ? '' : 's'} published.`,
    status,
    auditId,
    evidenceId,
    sourceKind: 'audit-evidence-summary',
    sourceRecordId: auditId,
    sourceRecordType: 'audit',
    sourceTimestamp: context.generatedAt,
    publicationRevision: context.publicationRevision,
    findingCount: safeInteger(row.findingCount),
    visualStatus: safeText(row.visualStatus, 120),
    reasonCodes: kinds,
    destinations: [collectionDestination('evidence', context, recordId)],
    limitations: artifactCount === null ? ['artifact-count-unavailable'] : undefined,
  }, options.complete === true && status !== 'unavailable' && status !== 'incomplete');
}

function executionRecord(context, auditId, executionValue, options = {}) {
  const execution = plainRecord(executionValue);
  const executionId = safeIdentifier(execution?.id, 200);
  if (!execution || !executionId) return null;
  const history = Array.isArray(execution.attemptHistory) ? execution.attemptHistory.map(plainRecord).filter(Boolean) : [];
  const latest = history.at(-1);
  const recordId = `provenance:execution-${stableDigest([context.mode, context.runId, auditId, executionId])}`;
  return baseRecord(context, 'provenance', recordId, `provenance:${auditId}:execution:${executionId}`, {
    title: safeText(execution.title, 500) ?? executionId,
    subtitle: safeText(execution.project, 240),
    status: safeText(execution.status ?? execution.rawStatus, 120),
    authority: safeText(execution.evidenceAuthority, 120),
    auditId,
    sourceKind: 'execution',
    sourceRecordId: executionId,
    sourceRecordType: 'execution',
    sourceTimestamp: canonicalTimestamp(execution.startedAt) ?? context.generatedAt,
    publicationRevision: context.publicationRevision,
    attemptNumber: safeInteger(latest?.attempt),
    retryNumber: safeInteger(execution.retry ?? latest?.retry),
    durationMs: safeInteger(execution.durationMs),
    reasonCodes: safeList(execution.reasonCodes, 16, 80),
    limitations: options.complete === true ? undefined : ['execution-detail-truncated'],
  }, options.complete === true);
}

function stepRecords(context, auditId, execution, options = {}) {
  const evidence = plainRecord(execution?.evidence);
  const steps = Array.isArray(evidence?.steps) ? evidence.steps.slice(0, 64) : [];
  const history = Array.isArray(execution?.attemptHistory) ? execution.attemptHistory.map(plainRecord).filter(Boolean) : [];
  const latest = history.at(-1);
  return steps.flatMap((stepValue, index) => {
    const step = plainRecord(stepValue);
    const name = safeText(step?.name, 500);
    if (!step || !name) return [];
    const recordId = `provenance:step-${stableDigest([context.mode, context.runId, auditId, execution.id, index, name])}`;
    return [baseRecord(context, 'provenance', recordId, `provenance:${auditId}:step:${String(index).padStart(4, '0')}:${recordId}`, {
      title: name,
      detail: safeText(step.detail ?? step.expected, 1_200),
      status: safeText(step.status, 120),
      auditId,
      stageId: `step-${index + 1}`,
      sourceKind: 'step',
      sourceRecordId: safeIdentifier(execution.id, 200) ?? auditId,
      sourceRecordType: 'step',
      sourceTimestamp: canonicalTimestamp(execution.startedAt) ?? context.generatedAt,
      publicationRevision: context.publicationRevision,
      attemptNumber: safeInteger(latest?.attempt),
      retryNumber: safeInteger(execution.retry ?? latest?.retry),
      limitations: options.complete === true ? undefined : ['step-detail-truncated'],
    }, options.complete === true)];
  });
}

function trustRecord(context, id, label, statusValue, fieldName, options = {}) {
  const status = safeText(statusValue, 120) ?? 'unavailable';
  const recordId = `trust:${id}`;
  return baseRecord(context, 'trust', recordId, `trust:${id}`, {
    title: label,
    detail: safeText(options.detail, 1_200),
    status,
    authority: safeText(options.authority, 120),
    sourceKind: 'report-publication',
    sourceRecordId: 'summary',
    sourceRecordType: 'report-summary',
    sourceTimestamp: context.generatedAt,
    publicationRevision: context.publicationRevision,
    [fieldName]: status,
    limitations: status === 'unavailable' ? [options.unavailableReason ?? `${id}-unavailable`] : safeList(options.limitations, 16, 160),
    destinations: [`/report.html?mode=${encodeURIComponent(context.mode)}&run=${encodeURIComponent(context.runId)}`],
  }, options.complete === true && status !== 'unavailable');
}

function metricRecord(context, descriptor) {
  const recordId = `metric:${descriptor.id}`;
  const value = safeInteger(descriptor.value);
  const status = value === null ? 'unavailable' : 'current';
  return baseRecord(context, 'metric', recordId, `metric:${descriptor.order}:${descriptor.id}`, {
    title: descriptor.label,
    subtitle: descriptor.population,
    detail: `Window: immutable publication generation. Formula: ${descriptor.formula}`,
    status,
    sourceKind: 'report-publication',
    sourceRecordId: 'summary',
    sourceRecordType: 'metric-provenance',
    sourceTimestamp: context.generatedAt,
    publicationRevision: context.publicationRevision,
    [descriptor.field]: value,
    destinations: descriptor.destination ? [descriptor.destination] : [],
    limitations: value === null ? ['metric-source-unavailable'] : undefined,
  }, value !== null);
}

function comparativeSummaryRecords(context, document) {
  const records = [];
  const limitations = [];
  const release = plainRecord(document.release) ?? {};
  const run = plainRecord(document.run) ?? {};
  const summary = plainRecord(document.summary) ?? {};
  const manual = plainRecord(document.manualEvidence) ?? {};
  const topFindings = Array.isArray(document.topFindings) ? document.topFindings.slice(0, 20) : [];
  const topAttention = Array.isArray(document.topAttention) ? document.topAttention.slice(0, 20) : [];
  for (const finding of topFindings) {
    const item = findingRecord(context, finding?.auditId, finding, {
      area: finding?.area,
      coveredEnvironments: finding?.coveredEnvironments,
      complete: true,
    });
    if (item) records.push(item);
  }
  for (const row of topAttention) {
    const attention = attentionRecord(context, row, { complete: true });
    if (attention) records.push(attention);
    for (const artifact of Array.isArray(row?.evidence) ? row.evidence.slice(0, 16) : []) {
      const provenance = artifactAttemptProvenanceRecord(context, row.auditId, artifact);
      if (provenance) records.push(provenance);
    }
  }
  const integrityStatus = release.runIntegrityFailure === true
    ? 'failed'
    : release.runIntegrityFailure === false ? 'complete' : null;
  records.push(
    trustRecord(context, 'outcome', 'Comparative release outcome', release.decision, 'outcome', {
      detail: release.reason,
      authority: release.authoritativeReleaseSource,
      complete: safeText(release.decision, 120) !== null,
    }),
    trustRecord(context, 'pipeline', 'Pipeline integrity', integrityStatus, 'pipelineIntegrityStatus', {
      detail: release.decisionBasis,
      complete: integrityStatus !== null,
    }),
    trustRecord(context, 'coverage', 'Coverage', null, 'coverageStatus', {
      unavailableReason: 'comparative-coverage-conclusion-unavailable',
    }),
    trustRecord(context, 'evidence', 'Evidence authority', null, 'evidenceAuthorityStatus', {
      unavailableReason: 'comparative-evidence-authority-unavailable',
    }),
    trustRecord(context, 'finalization', 'Finalization', null, 'finalizationStatus', {
      unavailableReason: 'comparative-finalization-unavailable',
    }),
    trustRecord(context, 'manual', 'Manual acceptance', safeText(manual.outstanding, 40)
      ?? (safeInteger(manual.outstanding) === 0 ? 'complete' : safeInteger(manual.outstanding) !== null ? 'outstanding' : null), 'manualStatus', {
      complete: safeInteger(manual.required) !== null,
    }),
  );
  const metrics = [
    { id: 'definition-coverage', order: '1', label: 'Published Audit Definitions', population: 'Comparative Audit Definitions', formula: 'summary.total', field: 'progressTotal', value: summary.total },
    { id: 'duration', order: '2', label: 'Run duration', population: 'Current comparative publication', formula: 'run.durationMs', field: 'durationMs', value: run.durationMs },
    { id: 'flaky', order: '3', label: 'Flaky audits', population: 'Published comparative audits', formula: 'summary.byStatus.FLAKY', field: 'progressFlaky', value: plainRecord(summary.byStatus)?.FLAKY, destination: '/findings.html?mode=comparative&kind=flaky' },
    { id: 'findings', order: '4', label: 'Canonical findings', population: 'Published comparative findings', formula: 'topFindingCount', field: 'findingCount', value: document.topFindingCount, destination: '/findings.html?mode=comparative&kind=finding' },
    { id: 'manual-outstanding', order: '5', label: 'Manual checks outstanding', population: 'Required comparative manual checks', formula: 'manualEvidence.outstanding', field: 'manualOutstanding', value: manual.outstanding, destination: '/findings.html?mode=comparative&kind=manual' },
    { id: 'baseline-issues', order: '6', label: 'Baseline issues', population: 'Published comparative Audit Definitions', formula: 'summary.baselineIssues', field: 'baselineIssues', value: summary.baselineIssues },
  ];
  records.push(...metrics.slice(0, CONSOLE_REPORT_PROJECTION_LIMITS.maximumMetricsPerPublication).map((metric) => metricRecord(context, metric)));
  if (!Array.isArray(document.topFindings)) limitations.push('comparative-top-findings-unavailable');
  if (!Array.isArray(document.topAttention)) limitations.push('comparative-top-attention-unavailable');
  return { records, limitations };
}

function singleSiteSummaryRecords(context, summary) {
  const records = [];
  const limitations = [];
  records.push(
    trustRecord(context, 'outcome', 'Single-site advisory outcome', summary.siteHealth?.verdict, 'outcome', {
      detail: summary.siteHealth?.reason,
      authority: 'advisory',
      complete: safeText(summary.siteHealth?.verdict, 120) !== null,
    }),
    trustRecord(context, 'coverage', 'Coverage', summary.coverage?.status, 'coverageStatus', {
      detail: summary.coverage?.preview?.map((item) => item.detail).join(' · '),
      complete: summary.coverage?.status !== 'UNKNOWN',
    }),
    trustRecord(context, 'evidence-completion', 'Evidence completion', summary.evidenceCompletion?.status, 'evidenceCompletionStatus', {
      complete: summary.evidenceCompletion?.status === 'complete',
    }),
    trustRecord(context, 'evidence', 'Evidence authority', summary.evidenceAuthority?.status, 'evidenceAuthorityStatus', {
      limitations: summary.evidenceAuthority?.reasons,
      complete: summary.evidenceAuthority?.status === 'authoritative',
    }),
    trustRecord(context, 'pipeline', 'Pipeline integrity', summary.pipelineIntegrity?.status, 'pipelineIntegrityStatus', {
      detail: summary.pipelineIntegrity?.reason,
      complete: summary.pipelineIntegrity?.status === 'complete',
    }),
    trustRecord(context, 'manual', 'Manual acceptance', summary.manual?.status, 'manualStatus', {
      complete: summary.manual?.status !== 'OUTSTANDING',
    }),
    trustRecord(context, 'finalization', 'Finalization', null, 'finalizationStatus', {
      unavailableReason: 'single-site-finalization-unavailable-in-report',
    }),
  );
  const metrics = [
    { id: 'definition-coverage', order: '1', label: 'Published Audit Definitions', population: 'Single-site Audit Definitions', formula: 'auditPages.total', field: 'progressTotal', value: summary.auditPages?.total },
    { id: 'findings', order: '2', label: 'Finding observations', population: 'Published Single-site audit rows', formula: 'findings.count', field: 'findingCount', value: summary.findings?.count, destination: '/findings.html?mode=single-site&kind=finding' },
    { id: 'manual-outstanding', order: '3', label: 'Manual checks outstanding', population: 'Required Single-site manual checks', formula: 'manual.outstanding', field: 'manualOutstanding', value: summary.manual?.outstanding, destination: '/findings.html?mode=single-site&kind=manual' },
    { id: 'visual-attention', order: '4', label: 'Visual reviews requiring attention', population: 'Published Single-site visual review records', formula: 'visualReview.attentionRequired', field: 'visualAttentionRequired', value: summary.visualReview?.attentionRequired, destination: '/findings.html?mode=single-site&kind=visual-review' },
  ];
  records.push(...metrics.map((metric) => metricRecord(context, metric)));
  if ((safeInteger(summary.findings?.count) ?? 0) > 0) {
    limitations.push('single-site-finding-severity-and-identity-unavailable');
  }
  return { records, limitations };
}

function auditRowRecords(context, row, options = {}) {
  const records = [];
  const limitations = [];
  const auditId = safeIdentifier(row?.id ?? row?.auditId);
  if (!auditId) return { records, limitations: ['audit-row-identity-unavailable'] };
  const findings = Array.isArray(row.findingPreview) ? row.findingPreview.slice(0, 3) : [];
  for (const finding of findings) {
    const item = findingRecord(context, auditId, finding, { area: row.area, complete: options.complete === true });
    if (item) records.push(item);
  }
  const facets = attentionFacets(row);
  const needsAttention = facets.length > 0 || ATTENTION_STATUSES.has(row.status);
  if (needsAttention && findings.length === 0) {
    const attention = attentionRecord(context, row, {
      complete: options.complete === true,
      limitations: context.mode === 'single-site' && (safeInteger(row.findingCount) ?? 0) > 0
        ? ['canonical-finding-detail-unavailable'] : [],
    });
    if (attention) records.push(attention);
  }
  const evidence = auditEvidenceRecord(context, row, { complete: options.complete === true });
  if (evidence) records.push(evidence);
  if (context.mode === 'single-site' && (safeInteger(row.findingCount) ?? 0) > 0) {
    limitations.push('single-site-finding-severity-and-identity-unavailable');
  }
  return { records, limitations };
}

function comparativeAuditIndexRecords(context, document) {
  const rows = Array.isArray(document.items) ? document.items.slice(0, 10_000) : [];
  const records = [];
  const limitations = [];
  for (const row of rows) {
    const projected = auditRowRecords(context, row, { complete: true });
    records.push(...projected.records);
    limitations.push(...projected.limitations);
  }
  if (!Array.isArray(document.items)) limitations.push('comparative-audit-index-unavailable');
  return { records, limitations };
}

function comparativeAuditDetailRecords(context, document) {
  const row = plainRecord(document) ?? {};
  const auditId = safeIdentifier(row.id);
  if (!auditId) return { records: [], limitations: ['audit-detail-identity-unavailable'] };
  const detailComplete = row.executionsTruncated !== true && row.findingsTruncated !== true && row.detailCompacted !== true;
  const base = auditRowRecords(context, row, { complete: detailComplete });
  const records = [...base.records];
  const limitations = [...base.limitations];
  if (!detailComplete) limitations.push('comparative-audit-detail-truncated');
  for (const finding of Array.isArray(row.findings) ? row.findings.slice(0, 40) : []) {
    const item = findingRecord(context, auditId, finding, { area: row.area, complete: detailComplete });
    if (item) records.push(item);
  }
  for (const executionValue of Array.isArray(row.executions) ? row.executions.slice(0, 40) : []) {
    const execution = plainRecord(executionValue);
    if (!execution) continue;
    const provenance = executionRecord(context, auditId, execution, { complete: detailComplete });
    if (provenance) records.push(provenance);
    records.push(...stepRecords(context, auditId, execution, { complete: detailComplete }));
    for (const artifact of Array.isArray(execution.artifacts) ? execution.artifacts.slice(0, 16) : []) {
      const evidence = evidenceRecord(context, auditId, artifact, {
        executionId: execution.id,
        sourceTimestamp: execution.startedAt,
        complete: detailComplete,
      });
      if (evidence) records.push(evidence);
    }
  }
  return { records, limitations };
}

function singleSiteAuditPageRecords(context, document) {
  const records = [];
  const limitations = [];
  for (const row of document.items ?? []) {
    const projected = auditRowRecords(context, row, { complete: row.evidenceStatus === 'complete' });
    records.push(...projected.records);
    limitations.push(...projected.limitations);
  }
  return { records, limitations };
}

function singleSiteCoverageRecords(context, document) {
  const records = [];
  for (const [index, item] of (document.items ?? []).entries()) {
    const detail = safeText(item?.detail, 240);
    const kind = safeText(item?.kind, 80);
    if (!detail || !kind) continue;
    const recordId = `trust:coverage-${stableDigest([kind, detail])}`;
    records.push(baseRecord(context, 'trust', recordId, `trust:coverage:${kind}:${String(index).padStart(6, '0')}:${recordId}`, {
      title: kind === 'gap' ? 'Coverage gap' : 'Coverage limitation',
      detail,
      status: kind,
      coverageStatus: kind === 'gap' ? 'GAPS' : 'LIMITED',
      sourceKind: 'coverage-detail',
      sourceRecordId: recordId,
      sourceRecordType: kind,
      sourceTimestamp: context.generatedAt,
      publicationRevision: context.publicationRevision,
      destinations: [`/report.html?mode=single-site&run=${encodeURIComponent(context.runId)}`],
    }, true));
  }
  return { records, limitations: [] };
}

function projectDocument(context, relativePath, document, singleSiteSummary = null) {
  if (relativePath === 'summary.json') {
    return context.mode === 'single-site'
      ? singleSiteSummaryRecords(context, parseSingleSiteReportSummary(document))
      : comparativeSummaryRecords(context, document);
  }
  if (context.mode === 'comparative' && relativePath === 'audits.json') {
    return comparativeAuditIndexRecords(context, document);
  }
  if (context.mode === 'comparative' && /^audits\/[A-Z0-9-]{3,160}\.json$/u.test(relativePath)) {
    return comparativeAuditDetailRecords(context, document);
  }
  if (context.mode === 'single-site') {
    if (!singleSiteSummary) throw new TypeError('Single-site page projection requires its pinned parsed summary.');
    const summary = singleSiteSummary;
    const page = parseSingleSiteReportPage(document, relativePath, summary);
    if (relativePath.startsWith('audits/')) return singleSiteAuditPageRecords(context, page);
    if (relativePath.startsWith('coverage/')) return singleSiteCoverageRecords(context, page);
  }
  return { records: [], limitations: [] };
}

function validatePublication(publicationValue, identityValue, scopeKeyValue) {
  const publication = plainRecord(publicationValue);
  const identity = plainRecord(identityValue);
  if (!publication || !identity || !['comparative', 'single-site'].includes(identity.mode)) {
    throw new TypeError('Report projection requires a descriptor-pinned publication and run identity.');
  }
  const runId = safeIdentifier(identity.runId, 160);
  if (!runId) throw new TypeError('Report projection runId must be a safe bounded identifier.');
  if (!REVISION.test(publication.publicationRevision ?? '')) {
    throw new TypeError('Report projection publicationRevision is invalid.');
  }
  if (!/^[a-f0-9]{64}$/u.test(publication.publicationDigest ?? '')) {
    throw new TypeError('Report projection publicationDigest is invalid.');
  }
  const generatedAt = canonicalTimestamp(publication.generatedAt);
  if (!generatedAt) throw new TypeError('Report projection generatedAt is invalid.');
  if ((identity.mode === 'single-site') !== (publication.mode === 'single-site')) {
    throw new TypeError('Report projection mode disagrees with the pinned publication.');
  }
  if (!plainRecord(publication.files)) throw new TypeError('Report projection publication files are invalid.');
  const paths = Object.keys(publication.files).filter((path) => DOCUMENT_PATH.test(path)).sort((left, right) => {
    if (left === 'summary.json') return -1;
    if (right === 'summary.json') return 1;
    if (left === 'audits.json') return -1;
    if (right === 'audits.json') return 1;
    return left.localeCompare(right);
  });
  return {
    publication,
    mode: identity.mode,
    runId,
    scopeKey: normalizeScopeKey(scopeKeyValue),
    sourceId: sourceId(identity.mode),
    publicationRevision: publication.publicationRevision,
    generatedAt,
    paths,
  };
}

function checkpointDigest(value) {
  return digest(JSON.stringify(value), 32);
}

function checkpointBody(context, documentIndex, recordOffset, incomplete) {
  return Object.freeze({
    schemaVersion: 1,
    mode: context.mode,
    runId: context.runId,
    scopeKey: context.scopeKey,
    publicationRevision: context.publicationRevision,
    publicationDigest: context.publication.publicationDigest,
    documentIndex,
    recordOffset,
    incomplete: incomplete === true,
  });
}

export function encodeReportProjectionCheckpoint(value) {
  const checkpoint = decodeCheckpointValue(value);
  const body = JSON.stringify(checkpoint);
  return Buffer.from(JSON.stringify({ body, digest: checkpointDigest(body) })).toString('base64url');
}

export function decodeReportProjectionCheckpoint(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) {
    throw new TypeError('Report projection checkpoint is invalid.');
  }
  let wrapper;
  try {
    wrapper = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('Report projection checkpoint is invalid.');
  }
  if (!plainRecord(wrapper) || typeof wrapper.body !== 'string'
    || wrapper.digest !== checkpointDigest(wrapper.body)) {
    throw new TypeError('Report projection checkpoint integrity check failed.');
  }
  let checkpoint;
  try { checkpoint = JSON.parse(wrapper.body); } catch { checkpoint = null; }
  return decodeCheckpointValue(checkpoint);
}

function decodeCheckpointValue(value) {
  const checkpoint = plainRecord(value);
  const expected = [
    'schemaVersion', 'mode', 'runId', 'scopeKey', 'publicationRevision', 'publicationDigest',
    'documentIndex', 'recordOffset', 'incomplete',
  ];
  if (!checkpoint || Object.keys(checkpoint).sort().join(',') !== [...expected].sort().join(',')
    || checkpoint.schemaVersion !== 1 || !['comparative', 'single-site'].includes(checkpoint.mode)
    || !safeIdentifier(checkpoint.runId, 160) || !safeText(checkpoint.scopeKey, 512)
    || !REVISION.test(checkpoint.publicationRevision ?? '')
    || !/^[a-f0-9]{64}$/u.test(checkpoint.publicationDigest ?? '')
    || !Number.isSafeInteger(checkpoint.documentIndex) || checkpoint.documentIndex < 0
    || !Number.isSafeInteger(checkpoint.recordOffset) || checkpoint.recordOffset < 0
    || typeof checkpoint.incomplete !== 'boolean') {
    throw new TypeError('Report projection checkpoint is invalid.');
  }
  return Object.freeze({ ...checkpoint });
}

function contextMatchesCheckpoint(context, checkpoint) {
  return checkpoint.mode === context.mode && checkpoint.runId === context.runId
    && checkpoint.scopeKey === context.scopeKey
    && checkpoint.publicationRevision === context.publicationRevision
    && checkpoint.publicationDigest === context.publication.publicationDigest;
}

function boundedOption(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function uniqueProjection(records, maximum) {
  const byId = new Map();
  for (const record of records) {
    if (!byId.has(record.recordId)) byId.set(record.recordId, record);
    if (byId.size === maximum) break;
  }
  return [...byId.values()].sort((left, right) => left.sortKey.localeCompare(right.sortKey)
    || left.recordId.localeCompare(right.recordId));
}

export function projectPublishedReportDocument(input) {
  const source = plainRecord(input);
  if (!source || typeof source.relativePath !== 'string' || !DOCUMENT_PATH.test(source.relativePath)) {
    throw new TypeError('Published report document projection input is invalid.');
  }
  const context = validatePublication(source.publication, source.identity, source.scopeKey);
  const projected = projectDocument(context, source.relativePath, source.document, source.singleSiteSummary);
  const overflow = projected.records.length > CONSOLE_REPORT_PROJECTION_LIMITS.maximumProjectedRecordsPerDocument;
  return Object.freeze({
    schemaVersion: 1,
    records: Object.freeze(uniqueProjection(projected.records, CONSOLE_REPORT_PROJECTION_LIMITS.maximumProjectedRecordsPerDocument)),
    limitations: Object.freeze([...new Set([
      ...projected.limitations,
      ...(overflow ? ['document-record-limit'] : []),
    ])].sort()),
    complete: projected.limitations.length === 0 && !overflow,
  });
}

export async function projectReportPublicationBatch(input = {}, options = {}) {
  const context = validatePublication(input.publication, input.identity, input.scopeKey);
  const limit = boundedOption(options.limit, 50, CONSOLE_REPORT_PROJECTION_LIMITS.maximumBatchRecords);
  const maximumDocuments = boundedOption(options.maximumDocuments, 2, CONSOLE_REPORT_PROJECTION_LIMITS.maximumDocumentsPerBatch);
  const maximumSourceBytes = boundedOption(options.maximumSourceBytes, 1024 * 1024, CONSOLE_REPORT_PROJECTION_LIMITS.maximumSourceBytesPerBatch);
  const maximumDocumentBytes = boundedOption(options.maximumDocumentBytes, 1024 * 1024, CONSOLE_REPORT_PROJECTION_LIMITS.maximumDocumentBytes);
  const supplied = input.cursor === undefined || input.cursor === null
    ? null
    : decodeReportProjectionCheckpoint(input.cursor);
  if (supplied && !contextMatchesCheckpoint(context, supplied)) {
    throw new TypeError('Report projection checkpoint does not match this publication generation.');
  }
  let documentIndex = supplied?.documentIndex ?? 0;
  let recordOffset = supplied?.recordOffset ?? 0;
  let incomplete = supplied?.incomplete ?? false;
  let sourceFilesRead = 0;
  let sourceBytesRead = 0;
  let documentsVisited = 0;
  const output = [];
  const limitations = [];
  const missingSummary = !context.paths.includes('summary.json');
  const startingDocumentIndex = documentIndex;
  const startingRecordOffset = recordOffset;
  if (missingSummary) {
    limitations.push('publication-summary-missing');
    incomplete = true;
  }

  while (documentIndex < context.paths.length && output.length < limit && documentsVisited < maximumDocuments) {
    const relativePath = context.paths[documentIndex];
    const descriptor = plainRecord(context.publication.files[relativePath]);
    const declaredBytes = safeInteger(descriptor?.bytes);
    if (declaredBytes === null || declaredBytes > maximumDocumentBytes || declaredBytes > maximumSourceBytes) {
      limitations.push('source-document-too-large');
      incomplete = true;
      documentIndex += 1;
      recordOffset = 0;
      documentsVisited += 1;
      continue;
    }
    let singleSiteSummary = null;
    if (context.mode === 'single-site' && relativePath !== 'summary.json') {
      const summaryDescriptor = plainRecord(context.publication.files['summary.json']);
      const summaryBytes = safeInteger(summaryDescriptor?.bytes);
      if (summaryBytes === null || summaryBytes > maximumDocumentBytes
        || summaryBytes + declaredBytes > maximumSourceBytes) {
        limitations.push('source-document-too-large');
        incomplete = true;
        documentIndex += 1;
        recordOffset = 0;
        documentsVisited += 1;
        continue;
      }
      if (sourceBytesRead + summaryBytes + declaredBytes > maximumSourceBytes) break;
      const summaryRead = await readPublishedReportJson(context.publication, 'summary.json', maximumDocumentBytes);
      sourceFilesRead += 1;
      sourceBytesRead += summaryRead.bytes;
      singleSiteSummary = parseSingleSiteReportSummary(summaryRead.document);
    } else if (sourceBytesRead + declaredBytes > maximumSourceBytes) break;

    const read = await readPublishedReportJson(context.publication, relativePath, maximumDocumentBytes);
    sourceFilesRead += 1;
    sourceBytesRead += read.bytes;
    documentsVisited += 1;
    const projected = projectPublishedReportDocument({
      publication: context.publication,
      identity: { mode: context.mode, runId: context.runId },
      scopeKey: context.scopeKey,
      relativePath,
      document: read.document,
      singleSiteSummary,
    });
    limitations.push(...projected.limitations);
    if (!projected.complete) incomplete = true;
    const available = projected.records.slice(recordOffset, recordOffset + Math.max(0, limit - output.length));
    output.push(...available);
    recordOffset += available.length;
    if (recordOffset >= projected.records.length) {
      documentIndex += 1;
      recordOffset = 0;
    }
  }

  if (documentIndex < context.paths.length && documentIndex === startingDocumentIndex
    && recordOffset === startingRecordOffset && output.length === 0) {
    limitations.push('projection-zero-progress');
    incomplete = true;
    documentIndex += 1;
    recordOffset = 0;
    documentsVisited += 1;
  }

  const budgetStopped = documentIndex < context.paths.length && output.length < limit
    && (documentsVisited >= maximumDocuments || sourceBytesRead >= maximumSourceBytes
      || (documentsVisited === 0 && context.paths.length > 0));
  if (budgetStopped && output.length === 0) limitations.push('budget-exhausted');
  const done = documentIndex >= context.paths.length;
  const nextCheckpoint = done ? null : checkpointBody(context, documentIndex, recordOffset, incomplete);
  const records = Object.freeze(output);
  const generationKey = `${context.mode}:${context.runId}:${context.publicationRevision}`;
  const start = supplied ?? checkpointBody(context, 0, 0, false);
  return Object.freeze({
    schemaVersion: 1,
    identity: Object.freeze({ mode: context.mode, runId: context.runId }),
    sourceId: context.sourceId,
    sourceRevision: context.publicationRevision,
    sourceUpdatedAt: context.generatedAt,
    generation: Object.freeze({
      key: generationKey,
      publicationDigest: context.publication.publicationDigest,
      resetPreviousGeneration: supplied === null,
      batchId: digest(`${generationKey}:${start.documentIndex}:${start.recordOffset}`, 32),
    }),
    records,
    checkpoint: nextCheckpoint,
    cursor: nextCheckpoint ? encodeReportProjectionCheckpoint(nextCheckpoint) : null,
    done,
    complete: done && !incomplete && limitations.length === 0,
    limitations: Object.freeze([...new Set(limitations)].sort()),
    work: Object.freeze({
      sourceFilesRead,
      sourceBytesRead,
      documentsVisited,
      recordsProjected: records.length,
      budgetExhausted: budgetStopped,
    }),
  });
}
