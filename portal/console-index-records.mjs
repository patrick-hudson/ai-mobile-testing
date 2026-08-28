import { createHash } from 'node:crypto';
import { createProductRiskRecord } from './console-risk.mjs';

const MAX_DATE_MS = 9_999_999_999_999_999;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function statusRaw(value) {
  const source = record(value);
  return typeof source?.raw === 'string' || typeof source?.raw === 'boolean' ? source.raw : null;
}

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function boundedString(value, maximum = 1_200) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function scalar(value) {
  return typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
}

function compactFields(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function timelineSortKey(timeline) {
  const milliseconds = Date.parse(timeline.startedAt ?? timeline.finishedAt ?? 0) || 0;
  const sequence = Number.isSafeInteger(timeline.sequence) ? timeline.sequence : Number.MAX_SAFE_INTEGER;
  return `timeline:${String(milliseconds).padStart(16, '0')}:${String(sequence).padStart(16, '0')}:${createHash('sha256').update(timeline.identity).digest('hex').slice(0, 16)}`;
}

function safeList(value, maximum = 64) {
  return Array.isArray(value)
    ? value.slice(0, maximum).map((entry) => scalar(entry)).filter((entry) => entry !== null)
    : [];
}

function limitationList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((entry) => {
    const direct = boundedString(entry, 240);
    if (direct) return [direct];
    const source = record(entry);
    const code = boundedString(source?.code, 80);
    const field = boundedString(source?.field, 160);
    return code ? [`${code}${field ? `:${field}` : ''}`] : [];
  });
}

function destinationList(value) {
  const source = record(value);
  if (!source) return [];
  return ['workspace', 'report', 'gallery', 'checklist', 'sourceReport', 'artifacts']
    .map((key) => boundedString(source[key], 600))
    .filter((href) => href && /^\/(?!\/)/u.test(href));
}

function indexedScopeKey(value) {
  const raw = boundedString(value, 512) ?? 'unknown';
  if (/^scope_[a-f0-9]{24}$/u.test(raw)) return raw;
  return `scope_${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function scopeKey(run) {
  return indexedScopeKey(
    boundedString(run?.scope?.comparability?.scopeKey, 512)
      ?? boundedString(run?.scope?.qualifier?.raw, 160)
      ?? 'unknown',
  );
}

function recentSortKey(run) {
  const time = Date.parse(run?.timestamps?.finishedAt ?? run?.timestamps?.updatedAt
    ?? run?.timestamps?.createdAt ?? 0) || 0;
  const inverted = Math.max(0, MAX_DATE_MS - Math.min(MAX_DATE_MS, time));
  return `recent:${String(inverted).padStart(16, '0')}:${run.identity.key}`;
}

function scopeLabel(run) {
  const qualifier = statusRaw(run?.scope?.qualifier);
  if (typeof qualifier === 'string') return qualifier;
  const deployment = record(run?.scope?.deployment);
  if (run.mode === 'comparative') return deployment?.productionOrigin && deployment?.candidateOrigin
    ? `${new URL(deployment.productionOrigin).host} → ${new URL(deployment.candidateOrigin).host}`
    : 'Comparative scope unavailable';
  return deployment?.origin ? new URL(deployment.origin).host : 'Single-site scope unavailable';
}

export function normalizedRunToConsoleIndexRecord(run, options = {}) {
  if (!record(run) || run.schemaVersion !== 1 || !['comparative', 'single-site'].includes(run.mode)
    || !record(run.identity) || !record(run.source)) {
    throw new TypeError('A normalized console run is required.');
  }
  const mode = run.mode;
  const deployment = record(run.scope?.deployment) ?? {};
  const progress = record(run.progress) ?? {};
  const targetSetKey = boundedString(run.scope?.comparability?.targetSetKey, 1_200);
  return Object.freeze({
    schemaVersion: 1,
    mode,
    runId: run.identity.runId,
    recordId: 'run',
    recordType: 'run',
    scopeKey: scopeKey(run),
    sourceId: boundedString(options.sourceId, 160) ?? boundedString(run.source.type, 160) ?? `${mode}-authority`,
    sourceRevision: boundedString(run.source.revision, 256),
    sourceUpdatedAt: timestamp(run.source.updatedAt),
    complete: run.source.completeness === 'complete',
    sortKey: recentSortKey(run),
    fields: Object.freeze(compactFields({
      title: boundedString(run.title, 240) ?? run.identity.runId,
      status: statusRaw(run.lifecycle?.execution),
      phase: statusRaw(run.lifecycle?.phase),
      outcome: statusRaw(run.authority?.outcome),
      qualifier: statusRaw(run.scope?.qualifier),
      profile: statusRaw(run.scope?.profile),
      productionOrigin: boundedString(deployment.productionOrigin, 2_048),
      candidateOrigin: boundedString(deployment.candidateOrigin, 2_048),
      auditedOrigin: boundedString(deployment.origin, 2_048),
      deploymentRole: statusRaw(deployment.role),
      targetSetKey,
      scopeLabel: scopeLabel(run),
      createdAt: timestamp(run.timestamps?.createdAt),
      startedAt: timestamp(run.timestamps?.startedAt),
      finishedAt: timestamp(run.timestamps?.finishedAt),
      updatedAt: timestamp(run.timestamps?.updatedAt),
      sourceKind: boundedString(run.source.type, 80),
      sourceTimestamp: timestamp(run.source.updatedAt),
      executionState: statusRaw(run.lifecycle?.execution),
      activityState: statusRaw(run.lifecycle?.activity),
      finalizationStatus: statusRaw(run.authority?.finalization),
      coverageStatus: statusRaw(run.authority?.coverage),
      evidenceAuthorityStatus: statusRaw(run.authority?.evidence),
      pipelineIntegrityStatus: statusRaw(run.authority?.pipeline),
      progressTotal: scalar(progress.total),
      progressCompleted: scalar(progress.completed),
      progressPassed: scalar(progress.passed),
      progressFailed: scalar(progress.failed),
      progressFlaky: scalar(progress.flaky),
      progressSkipped: scalar(progress.skipped),
      attemptNumber: scalar(progress.attemptNumber),
      retryNumber: scalar(progress.infrastructureRetriesUsed),
      terminal: run.lifecycle?.terminal === true,
      targetIds: safeList(run.scope?.targetIds),
      pluginIds: safeList(run.scope?.filters?.pluginIds),
      auditIds: safeList(run.scope?.filters?.auditIds),
      areas: safeList(run.scope?.filters?.areas),
      destinations: destinationList(run.destinations),
      limitations: limitationList(run.limitations),
    })),
  });
}

export function timelineToConsoleIndexRecord(timeline, options = {}) {
  if (!record(timeline) || timeline.schemaVersion !== 1
    || !['comparative', 'single-site'].includes(timeline.mode)
    || !boundedString(timeline.runId, 160) || !boundedString(timeline.identity, 1_200)) {
    throw new TypeError('A normalized console timeline record is required.');
  }
  const sourceId = boundedString(options.sourceId, 160);
  const scope = boundedString(options.scopeKey, 512);
  if (!sourceId || !scope) throw new TypeError('Timeline index records require a sourceId and scopeKey.');
  return Object.freeze({
    schemaVersion: 1,
    mode: timeline.mode,
    runId: timeline.runId,
    recordId: `timeline:${createHash('sha256').update(timeline.identity).digest('hex').slice(0, 40)}`,
    recordType: 'timeline',
    scopeKey: scope,
    sourceId,
    sourceRevision: boundedString(timeline.sourceRevision, 256),
    sourceUpdatedAt: timestamp(options.sourceUpdatedAt),
    complete: options.complete === true,
    sortKey: timelineSortKey(timeline),
    fields: Object.freeze(compactFields({
      title: boundedString(timeline.kind, 120),
      status: boundedString(timeline.status, 120),
      sourceKind: boundedString(timeline.kind, 80),
      sourceRecordId: boundedString(timeline.identity, 1_200),
      sourceTimestamp: timestamp(timeline.startedAt ?? timeline.finishedAt),
      startedAt: timestamp(timeline.startedAt),
      finishedAt: timestamp(timeline.finishedAt),
      stageId: boundedString(timeline.stageId, 160),
      shardId: boundedString(timeline.shardId, 160),
      attemptNumber: scalar(timeline.attempt),
      retryNumber: scalar(timeline.retry),
      sequence: scalar(timeline.sequence),
      durationMs: scalar(timeline.durationMs),
    })),
  });
}

function availableStatus(raw, unavailableLabel = 'Unavailable') {
  return raw === null || raw === undefined
    ? { raw: null, label: unavailableLabel, availability: 'unavailable' }
    : { raw, label: String(raw).replace(/[-_]+/gu, ' ').replace(/^./u, (value) => value.toUpperCase()), availability: 'available' };
}

function destinationsFromList(value) {
  const output = {};
  for (const href of safeList(value)) {
    if (typeof href !== 'string' || !/^\/(?!\/)/u.test(href)) continue;
    if (href.startsWith('/run.html')) output.workspace = href;
    else if (href.startsWith('/report')) output.report = href;
    else if (href.startsWith('/gallery')) output.gallery = href;
    else if (href.includes('checklist')) output.checklist = href;
    else if (href.includes('playwright') || href.includes('source-report')) output.sourceReport = href;
    else if (href.includes('artifact')) output.artifacts = href;
  }
  return output;
}

export function consoleIndexRecordToNormalizedRun(indexRecord) {
  const source = record(indexRecord);
  const fields = record(source?.fields);
  if (!source || source.schemaVersion !== 1 || source.recordType !== 'run'
    || !['comparative', 'single-site'].includes(source.mode) || !fields) {
    throw new TypeError('A console index run record is required.');
  }
  const mode = source.mode;
  const deploymentKey = mode === 'comparative' && fields.productionOrigin && fields.candidateOrigin
    ? JSON.stringify([fields.productionOrigin, fields.candidateOrigin])
    : mode === 'single-site' && fields.auditedOrigin && fields.deploymentRole
      ? JSON.stringify([fields.deploymentRole, fields.auditedOrigin]) : null;
  return Object.freeze({
    schemaVersion: 1,
    mode,
    identity: Object.freeze({ mode, runId: source.runId, key: `${mode}:${source.runId}` }),
    context: Object.freeze({ id: `${mode}-live`, runtime: 'live' }),
    title: fields.title ?? source.runId,
    source: Object.freeze({
      type: fields.sourceKind ?? source.sourceId,
      identity: source.runId,
      revision: source.sourceRevision,
      updatedAt: source.sourceUpdatedAt,
      completeness: source.complete ? 'complete' : 'partial',
      freshness: 'current',
    }),
    lifecycle: Object.freeze({
      execution: availableStatus(fields.executionState ?? fields.status),
      activity: availableStatus(fields.activityState),
      phase: availableStatus(fields.phase),
      terminal: fields.terminal === true,
    }),
    authority: Object.freeze({
      outcome: availableStatus(fields.outcome),
      coverage: availableStatus(fields.coverageStatus),
      evidence: availableStatus(fields.evidenceAuthorityStatus),
      pipeline: availableStatus(fields.pipelineIntegrityStatus),
      finalization: availableStatus(fields.finalizationStatus, mode === 'comparative' ? 'Not applicable' : 'Unavailable'),
    }),
    scope: Object.freeze({
      deployment: Object.freeze({
        kind: mode === 'comparative' ? 'origin-pair' : 'deployment-environment',
        productionOrigin: fields.productionOrigin ?? null,
        candidateOrigin: fields.candidateOrigin ?? null,
        origin: fields.auditedOrigin ?? null,
        role: availableStatus(fields.deploymentRole),
      }),
      profile: availableStatus(fields.profile, mode === 'single-site' ? 'Not applicable' : 'Unavailable'),
      qualifier: availableStatus(fields.qualifier),
      filters: Object.freeze({ pluginIds: safeList(fields.pluginIds), auditIds: safeList(fields.auditIds), areas: safeList(fields.areas) }),
      targetIds: Object.freeze(safeList(fields.targetIds)),
      comparability: Object.freeze({
        deploymentKey,
        profileKey: mode === 'single-site' ? 'not-applicable' : fields.profile ?? null,
        scopeKey: source.scopeKey,
        targetSetKey: fields.targetSetKey ?? null,
        complete: deploymentKey !== null && (mode === 'single-site' || fields.profile) && fields.targetSetKey !== null,
      }),
    }),
    timestamps: Object.freeze({ createdAt: fields.createdAt ?? null, startedAt: fields.startedAt ?? null, updatedAt: fields.updatedAt ?? source.sourceUpdatedAt, finishedAt: fields.finishedAt ?? null }),
    progress: Object.freeze(compactFields({
      total: fields.progressTotal, completed: fields.progressCompleted, passed: fields.progressPassed,
      failed: fields.progressFailed, flaky: fields.progressFlaky, skipped: fields.progressSkipped,
      attemptNumber: fields.attemptNumber, infrastructureRetriesUsed: fields.retryNumber,
    })),
    destinations: Object.freeze(destinationsFromList(fields.destinations)),
    limitations: Object.freeze(safeList(fields.limitations)),
  });
}

export function productRiskToConsoleIndexRecord(risk, scope, options = {}) {
  const source = record(risk);
  if (!source || source.schemaVersion !== 1 || !record(source.runIdentity) || !record(source.source)
    || !record(source.factors) || !Array.isArray(source.tuple)) throw new TypeError('A Product Risk record is required.');
  const mode = source.runIdentity.mode;
  const runId = source.runIdentity.runId;
  const factor = source.factors;
  const tupleKey = source.tuple.map(({ value, availability }) => `${availability}:${value ?? '~'}`).join('|');
  return Object.freeze({
    schemaVersion: 1,
    mode,
    runId,
    recordId: `risk:${source.identity}`,
    recordType: 'risk',
    scopeKey: indexedScopeKey(scope),
    sourceId: boundedString(options.sourceId, 160) ?? 'product-risk',
    sourceRevision: boundedString(options.sourceRevision, 256),
    sourceUpdatedAt: timestamp(source.source.timestamp),
    complete: source.source.complete === true,
    sortKey: `risk:${tupleKey}:${source.identity}`.slice(0, 512),
    fields: Object.freeze(compactFields({
      title: boundedString(options.title, 240) ?? source.identity,
      severity: factor.severity?.raw ?? null,
      blocking: factor.blockingIntent?.raw ?? null,
      attentionKind: source.sourceType,
      novelty: factor.novelty?.raw ?? null,
      affectedScope: factor.affectedScope?.raw ?? null,
      unresolvedAt: timestamp(factor.unresolvedAge?.since),
      sourceRecordId: source.source.identity,
      sourceRecordType: source.sourceType,
      sourceTimestamp: timestamp(source.source.timestamp),
      destinations: source.source.href ? [source.source.href] : [],
      reasonCodes: source.reasons?.slice(0, 16).map((_, index) => `factor-${index + 1}`),
    })),
  });
}

export function consoleIndexRecordToProductRiskInput(indexRecord, options = {}) {
  const source = record(indexRecord);
  const fields = record(source?.fields);
  if (!source || !['risk', 'attention'].includes(source.recordType) || !fields) {
    throw new TypeError('A console index Product Risk or attention record is required.');
  }
  const sourceType = fields.attentionKind === 'finding-summary' ? 'finding' : fields.attentionKind;
  if (!['finding', 'visual-review', 'manual-obligation'].includes(sourceType)) {
    throw new TypeError('The console attention record is not a Product Risk authority.');
  }
  return createProductRiskRecord({
    identity: source.recordId.replace(/^risk:/u, ''),
    runIdentity: { mode: source.mode, runId: source.runId },
    sourceType,
    categories: safeList(fields.reasonCodes),
    severity: fields.severity,
    blockingIntent: fields.blocking,
    novelty: fields.novelty,
    affectedScope: fields.affectedScope ?? (Array.isArray(fields.areas) ? fields.areas.length : undefined),
    unresolvedSince: fields.unresolvedAt,
    sourceIdentity: fields.sourceRecordId,
    sourceTimestamp: fields.sourceTimestamp,
    sourceComplete: source.complete,
    href: safeList(fields.destinations)[0] ?? null,
  }, options);
}
