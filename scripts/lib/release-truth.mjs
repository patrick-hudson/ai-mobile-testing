import { readFile } from 'node:fs/promises';
import { projectPublicationView } from '../../shared/release-projection.mjs';
import { RELEASE_DECISION_CODES } from '../../shared/release-decision.mjs';

export const RELEASE_DECISIONS = Object.freeze(['READY', 'NOT_READY']);
export const PIPELINE_STATUSES = Object.freeze(['pending', 'running', 'completed', 'failed', 'stopped']);
export const CHECKLIST_SCHEMA_VERSION = 1;

export function parseReleasePublication(document, source = 'release/publication/current.json') {
  const releaseTruth = projectPublicationView(document).releaseTruth;
  return source === releaseTruth.source ? releaseTruth : { ...releaseTruth, source };
}

export function pendingRelease(source = 'checklist/manifest.json') {
  return {
    decision: 'PENDING',
    ready: null,
    reason: 'The authoritative checklist has not been evaluated yet.',
    decisionBasis: null,
    blockingFailures: null,
    blockingIncomplete: null,
    baselineIssues: null,
    runIntegrityFailure: null,
    source,
    evaluatedAt: null,
  };
}

export function unavailableRelease(reason, source = 'checklist/manifest.json') {
  return {
    ...pendingRelease(source),
    decision: 'UNAVAILABLE',
    reason,
    evaluatedAt: new Date().toISOString(),
  };
}

export function parseChecklistRelease(document, source = 'checklist/manifest.json') {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Checklist manifest must be a JSON object.');
  }
  if (document.kind === 'release-publication-envelope') return parseReleasePublication(document, source);
  if (document.schemaVersion !== CHECKLIST_SCHEMA_VERSION) {
    throw new Error(`Checklist manifest schemaVersion must be ${CHECKLIST_SCHEMA_VERSION}.`);
  }
  if (document.mode === 'single-site' || document.run?.mode === 'single-site'
    || document.kind === 'single-site-health') {
    throw new Error('Single-site Site Health evidence cannot be parsed as comparative release truth.');
  }
  const release = document.release;
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('Checklist manifest is missing release truth.');
  }
  if (!RELEASE_DECISIONS.includes(release.decision)) {
    throw new Error('Checklist release.decision must be READY or NOT_READY.');
  }
  const ready = release.decision === 'READY';
  if (typeof release.ready !== 'boolean' || release.ready !== ready) {
    throw new Error('Checklist release.ready contradicts release.decision.');
  }
  if (typeof release.reason !== 'string' || release.reason.trim().length === 0) {
    throw new Error('Checklist release.reason must explain the decision.');
  }
  const blockingFailures = requiredNonnegativeInteger(release.blockingFailures, 'release.blockingFailures');
  const blockingIncomplete = requiredNonnegativeInteger(release.blockingIncomplete, 'release.blockingIncomplete');
  const baselineIssues = requiredNonnegativeInteger(release.baselineIssues, 'release.baselineIssues');
  if (typeof release.runIntegrityFailure !== 'boolean') {
    throw new Error('Checklist release.runIntegrityFailure must be boolean.');
  }
  const runIntegrityFailure = release.runIntegrityFailure;
  if (typeof release.decisionBasis !== 'string' || release.decisionBasis.trim().length === 0) {
    throw new Error('Checklist release.decisionBasis must explain the authoritative gating policy.');
  }
  const decisionBasis = release.decisionBasis.trim();
  if (ready && (blockingFailures > 0 || blockingIncomplete > 0 || runIntegrityFailure)) {
    throw new Error('Checklist READY decision contradicts its blocking or run-integrity counts.');
  }
  return {
    decision: release.decision,
    ready,
    reason: release.reason.trim(),
    decisionBasis,
    blockingFailures,
    blockingIncomplete,
    baselineIssues,
    runIntegrityFailure,
    source,
    evaluatedAt: new Date().toISOString(),
  };
}

export async function readChecklistRelease(manifestPath, source = 'checklist/manifest.json') {
  let document;
  try {
    document = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    const detail = error?.code === 'ENOENT' ? 'file is missing' : error.message;
    throw new Error(`Authoritative checklist manifest could not be read: ${detail}`);
  }
  return parseChecklistRelease(document, source);
}

export function releaseOutcome(pipelineStatus, release) {
  const sharedCode = RELEASE_DECISION_CODES.includes(release?.code)
    ? release.code
    : RELEASE_DECISION_CODES.includes(release?.decisionCode) ? release.decisionCode : null;
  if (pipelineStatus !== 'completed'
    || (!RELEASE_DECISIONS.includes(release?.decision) && sharedCode === null)) {
    return { status: 'pipeline-failed', exitCode: 1 };
  }
  const ready = sharedCode === null ? release.decision === 'READY' : ['RELEASE_READY', 'FEATURE_READY'].includes(sharedCode);
  return ready
    ? { status: 'ready', exitCode: 0 }
    : { status: 'not-ready', exitCode: 1 };
}

export function pipelineOnlyOutcome(pipelineStatus, release) {
  const sharedCode = RELEASE_DECISION_CODES.includes(release?.code)
    ? release.code
    : RELEASE_DECISION_CODES.includes(release?.decisionCode) ? release.decisionCode : null;
  if (pipelineStatus !== 'completed'
    || (!RELEASE_DECISIONS.includes(release?.decision) && sharedCode === null)) {
    return { status: 'pipeline-failed', exitCode: 1 };
  }
  if (sharedCode !== null) {
    if (sharedCode === 'NOT_READY_TEST_FAILURE') return { status: 'smoke-checks-failed', exitCode: 1 };
    if (sharedCode === 'NOT_READY_INCOMPLETE_EXECUTION') return { status: 'completed-not-ready', exitCode: 0 };
    return { status: 'ready', exitCode: 0 };
  }
  if (release.blockingFailures === null || release.runIntegrityFailure === null) {
    return { status: 'integrity-unknown', exitCode: 1 };
  }
  if (release.runIntegrityFailure || release.blockingFailures > 0) {
    return { status: 'smoke-checks-failed', exitCode: 1 };
  }
  return {
    status: release.decision === 'READY' ? 'ready' : 'completed-not-ready',
    exitCode: 0,
  };
}

function requiredNonnegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Checklist ${path} must be a nonnegative integer.`);
  }
  return value;
}
