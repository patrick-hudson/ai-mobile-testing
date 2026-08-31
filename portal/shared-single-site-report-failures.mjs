import {
  openAdoptedAttemptArtifact,
  readAdoptedAttemptArtifactJson,
  readParentRun,
} from '../scripts/lib/parent-run-store.mjs';
import { canonicalDigest } from '../shared/canonical-contract.mjs';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$/u;
const TERMINAL_PRODUCT_FAILURE = 'completed_product_failure';
const MAX_PAGE_ROWS = 25;
const MAX_PAGE_OFFSET = 1_000_000;
const MAX_PAGE_BYTES = 2 * 1_048_576;
const MAX_ROWS_BYTES = 1_048_576;
const MAX_SUMMARY_BYTES = 256 * 1_024;
const MAX_ERROR_CONTEXT_BYTES = 96 * 1_024;
const MAX_ASSERTION_TEXT = 2_000;
const MAX_FINDINGS = 12;
const MAX_FAILED_STEPS = 8;
const MAX_IDENTITIES = 16;
const MAX_EVIDENCE_LINKS = 12;

export class SharedSingleSiteReportFailuresError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'SharedSingleSiteReportFailuresError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function fail(statusCode, code, message, details) {
  throw new SharedSingleSiteReportFailuresError(statusCode, code, message, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function active(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function boundedText(value, fallback = '', maximum = 1_200) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return fallback;
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
}

function translateStoreFailure(error) {
  if (error instanceof SharedSingleSiteReportFailuresError) throw error;
  if (error?.code === 'RUN_NOT_FOUND') {
    fail(404, 'SINGLE_SITE_REPORT_RUN_NOT_FOUND', 'Canonical shared report run was not found.');
  }
  if (error?.code === 'RELEASE_AUTHORITY_TOMBSTONED') {
    fail(410, 'SINGLE_SITE_REPORT_RUN_PURGED', 'This run and its canonical evidence were permanently purged.');
  }
  throw error;
}

async function storeCall(operation) {
  try {
    return await operation();
  } catch (error) {
    return translateStoreFailure(error);
  }
}

function canonicalAttempt(item) {
  if (!isRecord(item?.canonicalResult) || !Array.isArray(item?.attempts)) return null;
  for (let index = item.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = item.attempts[index];
    if (attempt?.outcome === item.state
      && attempt?.canonicalResultDigest === item.canonicalResult.digest
      && attempt?.attempt === item.canonicalResult.attempt
      && Array.isArray(attempt?.artifacts)) return attempt;
  }
  return null;
}

function rawLogArtifact(artifact) {
  const segments = String(artifact?.name ?? '').replaceAll('\\', '/').split('/').filter(Boolean)
    .map((segment) => segment.toLowerCase());
  const logicalName = String(artifact?.logicalName ?? '').trim().toLowerCase().replace(/[_.\s]+/gu, '-');
  return segments.includes('logs') || segments.some((segment) => segment.endsWith('.log'))
    || ['stdout', 'stderr', 'raw-log', 'worker-log'].includes(logicalName);
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

function publicArtifact(runId, item, attempt, artifact, ordinal) {
  const artifactKey = artifactAccessKey(item, attempt, artifact, ordinal);
  return {
    name: boundedText(artifact.logicalName, boundedText(artifact.name, 'Evidence', 240), 240),
    mediaType: boundedText(artifact.mediaType, 'application/octet-stream', 160),
    purpose: ['primary', 'diagnostic', 'structured'].includes(artifact.purpose) ? artifact.purpose : 'diagnostic',
    bytes: Number.isSafeInteger(artifact.sizeBytes) && artifact.sizeBytes >= 0 ? artifact.sizeBytes : null,
    url: `/artifacts/${encodeURIComponent(runId)}/work-items/${encodeURIComponent(item.id)}/${encodeURIComponent(artifactKey)}`,
  };
}

function evidencePriority(artifact) {
  const mediaType = String(artifact.mediaType ?? '').toLowerCase();
  const logicalName = String(artifact.logicalName ?? artifact.name ?? '').toLowerCase();
  if (logicalName === 'error-context') return 0;
  if (mediaType.startsWith('image/') || mediaType.startsWith('video/')) return 1;
  if (logicalName.includes('trace')) return 2;
  if (logicalName === 'audit-result-summary' || logicalName === 'audit-result') return 3;
  if (artifact.purpose === 'structured') return 4;
  return 5;
}

function evidenceLinks(runId, item, attempt) {
  return attempt.artifacts
    .map((artifact, index) => ({ artifact, ordinal: index + 1 }))
    .filter(({ artifact }) => !rawLogArtifact(artifact))
    .sort((left, right) => evidencePriority(left.artifact) - evidencePriority(right.artifact)
      || String(left.artifact.logicalName ?? left.artifact.name).localeCompare(String(right.artifact.logicalName ?? right.artifact.name))
      || left.ordinal - right.ordinal)
    .slice(0, MAX_EVIDENCE_LINKS)
    .map(({ artifact, ordinal }) => publicArtifact(runId, item, attempt, artifact, ordinal));
}

function artifactByLogicalName(attempt, logicalName) {
  const matches = attempt.artifacts
    .map((artifact, index) => ({ artifact, ordinal: index + 1 }))
    .filter(({ artifact }) => artifact.logicalName === logicalName);
  return matches.length === 1 ? matches[0] : null;
}

async function readArtifactJson(store, runId, item, attempt, logicalName, maximumBytes) {
  const match = artifactByLogicalName(attempt, logicalName);
  if (!match) return null;
  return storeCall(() => readAdoptedAttemptArtifactJson(store, runId, {
    workItemId: item.id,
    name: match.artifact.name,
    maximumBytes,
  }));
}

async function readArtifactPrefix(store, runId, item, attempt, logicalName, maximumBytes) {
  const match = artifactByLogicalName(attempt, logicalName);
  if (!match || !/^text\/(?:markdown|plain)(?:;|$)/iu.test(match.artifact.mediaType)) return null;
  const artifactKey = artifactAccessKey(item, attempt, match.artifact, match.ordinal);
  let opened;
  try {
    const result = await storeCall(() => openAdoptedAttemptArtifact(store, runId, {
      workItemId: item.id,
      artifactKey,
    }));
    opened = result.opened;
    const length = Math.min(maximumBytes, opened.stat.size);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await opened.handle.read(bytes, 0, length, 0);
    return {
      text: bytes.subarray(0, bytesRead).toString('utf8'),
      truncated: opened.stat.size > bytesRead,
    };
  } finally {
    await opened?.handle?.close().catch(() => undefined);
    await opened?.transferLease?.release?.().catch(() => undefined);
  }
}

function validatedRows(document, item) {
  const descriptor = item.executionDescriptor;
  if (!isRecord(document) || document.schemaVersion !== 1 || document.kind !== 'shared-work-item-rows'
    || document.workItemId !== item.id || document.executionDescriptorDigest !== (descriptor?.digest ?? null)
    || !Array.isArray(document.rows) || document.rows.length !== 1 || !isRecord(document.rows[0])) return null;
  const row = document.rows[0];
  if (descriptor && (row.caseId !== descriptor.caseId || row.projectName !== descriptor.targetId
    || row.entrySpec !== descriptor.entrySpec)) return null;
  return row;
}

function validatedSummary(document, item) {
  const descriptor = item.executionDescriptor;
  const expectedBaseURL = descriptor?.targetRole === 'production'
    ? descriptor?.origins?.production : descriptor?.origins?.candidate;
  if (!isRecord(document) || document.schemaVersion !== 1 || !Array.isArray(document.findings)
    || !Array.isArray(document.steps) || (descriptor && (
      document.caseId !== descriptor.caseId
      || document.auditId !== descriptor.definitionId
      || document.project !== descriptor.targetId
      || document.mode !== descriptor.mode
      || document.deploymentRole !== descriptor.targetRole
      || document.baseURL !== expectedBaseURL
    ))) return null;
  return document;
}

export function assertionFromErrorContext(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\r\n?/gu, '\n');
  const section = /(?:^|\n)# Error details\s*\n+```[^\n]*\n([\s\S]*?)(?:\n```|$)/iu.exec(normalized)?.[1]
    ?? /(?:^|\n)# Error details\s*\n+([\s\S]*?)(?=\n# |$)/iu.exec(normalized)?.[1]
    ?? null;
  if (!section) return null;
  const lines = section.split('\n');
  const useful = [];
  let blankSeen = false;
  for (const line of lines) {
    const trimmed = line.replace(/[ \t]+$/gu, '');
    if (!trimmed.trim()) {
      if (useful.length > 0 && !blankSeen) useful.push('');
      blankSeen = true;
      continue;
    }
    blankSeen = false;
    useful.push(trimmed);
    if (useful.join('\n').length >= MAX_ASSERTION_TEXT) break;
  }
  return boundedText(useful.join('\n'), '', MAX_ASSERTION_TEXT) || null;
}

function compactFinding(value) {
  if (!isRecord(value)) return null;
  const title = boundedText(value.title, '', 500);
  const detail = boundedText(value.detail, '', 1_200);
  if (!title && !detail) return null;
  return {
    severity: /^P[0-3]$/u.test(value.severity ?? '') ? value.severity : null,
    title: title || 'Recorded finding',
    detail: detail || 'No finding detail was published.',
    blocking: value.blocking === true,
  };
}

function compactFailedStep(value) {
  if (!isRecord(value) || value.status !== 'failed') return null;
  return {
    name: boundedText(value.name, 'Failed audit step', 500),
    expected: boundedText(value.expected, 'No expected result was published.', 1_000),
    detail: boundedText(value.detail, '', 1_200) || null,
  };
}

function catalogDefinition(auditCatalog, auditId) {
  return (Array.isArray(auditCatalog) ? auditCatalog : []).find((definition) => definition?.id === auditId) ?? null;
}

function caseVariantUrl(caseId, baseURL) {
  if (typeof caseId !== 'string' || typeof baseURL !== 'string') return null;
  const marker = caseId.lastIndexOf(':case:');
  if (marker < 0) return null;
  let variant;
  try {
    variant = decodeURIComponent(caseId.slice(marker + ':case:'.length));
  } catch {
    return null;
  }
  if (!variant.startsWith('/')) return null;
  try {
    const url = new URL(variant, baseURL);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function safeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash ? url.href : null;
  } catch {
    return null;
  }
}

function targetUrl(descriptor, summary) {
  return safeHttpUrl(descriptor?.route?.url)
    ?? caseVariantUrl(descriptor?.caseId, summary?.baseURL ?? descriptor?.origins?.candidate)
    ?? safeHttpUrl(summary?.baseURL)
    ?? safeHttpUrl(descriptor?.origins?.candidate);
}

function assertionFallback({ findings, failedSteps, signature, attempt }) {
  const blockingFinding = findings.find(({ blocking }) => blocking) ?? findings[0];
  if (blockingFinding) return `${blockingFinding.title}\n${blockingFinding.detail}`;
  if (failedSteps[0]) {
    return `${failedSteps[0].name}\nExpected: ${failedSteps[0].expected}${failedSteps[0].detail ? `\n${failedSteps[0].detail}` : ''}`;
  }
  const identities = signature?.assertionIdentities;
  if (Array.isArray(identities) && identities.length > 0) {
    return `Canonical assertion identity: ${boundedText(identities[0], 'unavailable', 500)}`;
  }
  return boundedText(attempt?.reason, 'The canonical worker recorded a product failure without a readable assertion message.', MAX_ASSERTION_TEXT);
}

async function projectFailure({ store, runId, item, auditCatalog, signal }) {
  active(signal);
  const descriptor = isRecord(item.executionDescriptor) ? item.executionDescriptor : null;
  const attempt = canonicalAttempt(item);
  if (!attempt) {
    return {
      workItemId: item.id,
      auditId: boundedText(descriptor?.definitionId, 'UNKNOWN', 256),
      auditTitle: boundedText(descriptor?.definitionId, 'Unknown audit', 500),
      severity: null,
      caseId: boundedText(descriptor?.caseId, 'unknown', 512),
      targetId: boundedText(descriptor?.targetId, boundedText(item.targetId, 'unknown', 128), 128),
      targetRole: boundedText(descriptor?.targetRole, 'unknown', 128),
      state: TERMINAL_PRODUCT_FAILURE,
      releaseEffect: 'blocking',
      url: safeHttpUrl(descriptor?.route?.url) ?? safeHttpUrl(descriptor?.origins?.candidate),
      assertionMessage: 'Canonical failure details are unavailable because the adopted terminal attempt could not be resolved.',
      assertionTruncated: false,
      assertionIdentities: [],
      findingIdentities: [],
      findings: [],
      findingCount: 0,
      findingsShown: 0,
      findingsOmitted: 0,
      findingsTruncated: false,
      failedSteps: [],
      evidencePolicy: null,
      evidence: [],
      galleryUrl: `/gallery.html?mode=single-site&run=${encodeURIComponent(runId)}&from=report&review=all`,
      detailAvailability: 'unavailable',
    };
  }

  let row = null;
  let summary = null;
  let errorContext = null;
  const readProblems = [];
  try {
    row = validatedRows(await readArtifactJson(store, runId, item, attempt, 'work-item-rows', MAX_ROWS_BYTES), item);
    if (!row) readProblems.push('structured work-item row unavailable');
  } catch {
    readProblems.push('structured work-item row unreadable');
  }
  active(signal);
  try {
    summary = validatedSummary(await readArtifactJson(store, runId, item, attempt, 'audit-result-summary', MAX_SUMMARY_BYTES), item);
    if (!summary) readProblems.push('compact audit summary unavailable');
  } catch {
    readProblems.push('compact audit summary unreadable');
  }
  active(signal);
  try {
    errorContext = await readArtifactPrefix(store, runId, item, attempt, 'error-context', MAX_ERROR_CONTEXT_BYTES);
    if (!errorContext) readProblems.push('assertion context unavailable');
  } catch {
    readProblems.push('assertion context unreadable');
  }
  active(signal);

  const auditId = boundedText(descriptor?.definitionId, boundedText(summary?.auditId, 'UNKNOWN', 256), 256);
  const catalog = catalogDefinition(auditCatalog, auditId);
  const findings = (Array.isArray(summary?.findings) ? summary.findings : [])
    .map(compactFinding).filter(Boolean).slice(0, MAX_FINDINGS);
  const findingCount = Array.isArray(summary?.findings) ? summary.findings.length : findings.length;
  const failedSteps = (Array.isArray(summary?.steps) ? summary.steps : [])
    .map(compactFailedStep).filter(Boolean).slice(0, MAX_FAILED_STEPS);
  const signature = isRecord(item.canonicalResult?.productFailureSignature)
    ? item.canonicalResult.productFailureSignature : null;
  const assertionMessage = assertionFromErrorContext(errorContext?.text)
    ?? assertionFallback({ findings, failedSteps, signature, attempt });
  const caseId = boundedText(descriptor?.caseId, boundedText(row?.caseId, boundedText(summary?.caseId, 'unknown', 512), 512), 512);
  const galleryQuery = new URLSearchParams({
    mode: 'single-site', run: runId, from: 'report', review: 'all', q: caseId,
  });
  return {
    workItemId: item.id,
    auditId,
    auditTitle: boundedText(catalog?.title, boundedText(row?.title, auditId, 500), 500),
    severity: /^P[0-3]$/u.test(catalog?.severity ?? '') ? catalog.severity
      : findings.find(({ severity }) => severity)?.severity ?? null,
    caseId,
    targetId: boundedText(descriptor?.targetId, boundedText(row?.projectName, boundedText(summary?.project, item.targetId ?? 'unknown', 128), 128), 128),
    targetRole: boundedText(descriptor?.targetRole, boundedText(summary?.deploymentRole, 'unknown', 128), 128),
    state: TERMINAL_PRODUCT_FAILURE,
    releaseEffect: 'blocking',
    url: targetUrl(descriptor, summary),
    assertionMessage,
    assertionTruncated: errorContext?.truncated === true,
    assertionIdentities: (Array.isArray(signature?.assertionIdentities) ? signature.assertionIdentities : [])
      .slice(0, MAX_IDENTITIES).map((value) => boundedText(value, 'unknown', 500)),
    findingIdentities: (Array.isArray(signature?.findingIdentities) ? signature.findingIdentities : [])
      .slice(0, MAX_IDENTITIES).map((value) => boundedText(value, 'unknown', 500)),
    findings,
    findingCount,
    findingsShown: findings.length,
    findingsOmitted: Math.max(0, findingCount - findings.length),
    findingsTruncated: findingCount > findings.length,
    failedSteps,
    evidencePolicy: isRecord(row?.evidencePolicy) && ['interaction-video', 'static-screenshot', 'structured-data'].includes(row.evidencePolicy.mode)
      ? {
          mode: row.evidencePolicy.mode,
          rationale: boundedText(row.evidencePolicy.rationale, 'No evidence rationale was published.', 500),
        }
      : null,
    evidence: evidenceLinks(runId, item, attempt),
    galleryUrl: `/gallery.html?${galleryQuery.toString()}`,
    detailAvailability: readProblems.length === 0 ? 'complete' : 'partial',
    detailLimitations: readProblems.slice(0, 6),
  };
}

export async function readSharedSingleSiteFailurePage({
  store,
  runId,
  auditCatalog = [],
  offset = 0,
  limit = MAX_PAGE_ROWS,
  expectedStateRevision,
  signal,
} = {}) {
  if (!store || typeof runId !== 'string' || !RUN_ID.test(runId)) {
    fail(400, 'SINGLE_SITE_REPORT_FAILURE_PAGE_INVALID', 'A canonical shared store and valid run ID are required.');
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_PAGE_OFFSET
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_ROWS) {
    fail(400, 'SINGLE_SITE_REPORT_FAILURE_PAGE_INVALID', `Failure offset must be non-negative and limit must be between 1 and ${MAX_PAGE_ROWS}.`);
  }
  if (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 1) {
    fail(400, 'SINGLE_SITE_REPORT_FAILURE_PAGE_INVALID', 'A positive expected state revision is required.');
  }
  active(signal);
  const state = await storeCall(() => readParentRun(store, runId));
  if (state.runRevision !== expectedStateRevision) {
    fail(409, 'SINGLE_SITE_REPORT_REVISION_STALE',
      `Canonical failure detail moved from run revision ${expectedStateRevision} to ${state.runRevision}.`);
  }
  if (state.subjectCore?.mode !== 'single-site') {
    fail(422, 'SINGLE_SITE_REPORT_MODE_INVALID', 'Canonical failure detail requires a Single-site parent run.');
  }
  const failures = Object.values(isRecord(state.workItems) ? state.workItems : {})
    .filter((item) => isRecord(item) && item.state === TERMINAL_PRODUCT_FAILURE)
    .sort((left, right) => (
      String(left.executionDescriptor?.definitionId ?? '').localeCompare(String(right.executionDescriptor?.definitionId ?? ''))
      || String(left.executionDescriptor?.caseId ?? '').localeCompare(String(right.executionDescriptor?.caseId ?? ''))
      || String(left.executionDescriptor?.targetId ?? left.targetId ?? '').localeCompare(String(right.executionDescriptor?.targetId ?? right.targetId ?? ''))
      || String(left.id).localeCompare(String(right.id))
    ));
  const selected = failures.slice(offset, offset + limit);
  const items = [];
  try {
    for (const item of selected) {
      active(signal);
      items.push(await projectFailure({ store, runId, item, auditCatalog, signal }));
    }
  } catch (error) {
    const latest = await storeCall(() => readParentRun(store, runId));
    if (latest.runRevision !== expectedStateRevision) {
      fail(409, 'SINGLE_SITE_REPORT_REVISION_STALE',
        `Canonical failure detail moved from run revision ${expectedStateRevision} to ${latest.runRevision}.`);
    }
    throw error;
  }
  const confirmed = await storeCall(() => readParentRun(store, runId));
  if (confirmed.runRevision !== expectedStateRevision) {
    fail(409, 'SINGLE_SITE_REPORT_REVISION_STALE',
      `Canonical failure detail moved from run revision ${expectedStateRevision} to ${confirmed.runRevision}.`);
  }
  const nextOffset = offset + items.length;
  const result = {
    schemaVersion: 1,
    mode: 'single-site',
    runId,
    stateRevision: expectedStateRevision,
    total: failures.length,
    offset,
    limit,
    nextOffset,
    previousOffset: Math.max(0, offset - limit),
    hasMore: nextOffset < failures.length,
    hasPrevious: offset > 0,
    items,
    source: {
      authority: 'canonical-shared-parent-run',
      terminalState: TERMINAL_PRODUCT_FAILURE,
      bounded: true,
      maximumPageRows: MAX_PAGE_ROWS,
      rawLogsIncluded: false,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_PAGE_BYTES) {
    fail(413, 'SINGLE_SITE_REPORT_FAILURE_PAGE_TOO_LARGE', 'Canonical failure detail exceeds its bounded response size.');
  }
  return result;
}
