import { createHash } from 'node:crypto';
import { assertJobEnvelope, canonicalJson, sha256 } from './job-queue.mjs';
import {
  assertWorkerInputBoundToState,
  validateSingleSiteWorkerInput,
} from '../run-single-site-worker.mjs';
import {
  GENERIC_ROUTE_AUDIT_ID,
  verifySingleSiteRouteInventoryPublication,
} from '../../shared/single-site-route-plan.mjs';

export const MAX_SINGLE_SITE_PLAYWRIGHT_RESULTS_BYTES = 64 * 1_048_576;
export const MAX_SINGLE_SITE_REPORT_EXECUTIONS = 10_000;

const TERMINAL_STATES = new Set(['completed', 'failed', 'incomplete', 'cancelled']);
const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const PLAYWRIGHT_TEST_STATUSES = new Set(['expected', 'unexpected', 'flaky', 'skipped']);
const PLAYWRIGHT_RESULT_STATUSES = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
const SECRET_PATTERN = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{8,})/gi;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new TypeError(message);
}

function string(value, label, maximum = 2_400) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum) {
    fail(`${label} must be a non-empty, trimmed string no longer than ${maximum} characters.`);
  }
  return value;
}

function uniqueStrings(value, label, maximumItems = MAX_SINGLE_SITE_REPORT_EXECUTIONS) {
  if (!Array.isArray(value) || value.length > maximumItems) fail(`${label} must be a bounded array.`);
  const normalized = value.map((item, index) => string(item, `${label}[${index}]`, 800));
  if (new Set(normalized).size !== normalized.length) fail(`${label} must not contain duplicates.`);
  return normalized;
}

function boundedArray(value, label, maximum = MAX_SINGLE_SITE_REPORT_EXECUTIONS) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be an array with no more than ${maximum} items.`);
  return value;
}

function scrub(value, maximum = 800) {
  return String(value ?? '')
    .replace(SECRET_PATTERN, '[REDACTED]')
    .replace(/([?&](?:token|key|signature|auth)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function digestBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function findingId(parts) {
  return `FINDING-${createHash('sha256').update(canonicalJson(parts)).digest('hex').slice(0, 24).toUpperCase()}`;
}

function isoTimestamp(value, label) {
  string(value, label, 80);
  if (!Number.isFinite(Date.parse(value))) fail(`${label} must be an ISO-compatible timestamp.`);
  return value;
}

function validateManifestForReport(input) {
  const manifest = input.coverageManifest;
  const definitions = boundedArray(manifest.selectedDefinitions, 'coverageManifest.selectedDefinitions');
  const executions = boundedArray(manifest.executions, 'coverageManifest.executions');
  const selectedTargets = boundedArray(manifest.selectedTargets, 'coverageManifest.selectedTargets');
  const gaps = boundedArray(manifest.coverageGaps, 'coverageManifest.coverageGaps');
  if (!isRecord(manifest.omissions)) fail('coverageManifest.omissions must be an object.');
  const omittedDefinitions = boundedArray(manifest.omissions.definitions, 'coverageManifest.omissions.definitions');
  const omittedCases = boundedArray(manifest.omissions.cases, 'coverageManifest.omissions.cases');
  const omittedTargets = boundedArray(manifest.omissions.targets, 'coverageManifest.omissions.targets');
  const outsideMode = boundedArray(manifest.outsideMode, 'coverageManifest.outsideMode');

  const targetIds = new Set(selectedTargets.map((target, index) => {
    if (!isRecord(target)) fail(`coverageManifest.selectedTargets[${index}] must be an object.`);
    return string(target.targetId, `coverageManifest.selectedTargets[${index}].targetId`, 160);
  }));
  if (targetIds.size !== selectedTargets.length) fail('coverageManifest.selectedTargets contains duplicate target IDs.');
  if (canonicalJson([...targetIds].sort()) !== canonicalJson([...manifest.scope.selectedTargetIds].sort())) {
    fail('coverageManifest selected target records disagree with its scope binding.');
  }

  const definitionById = new Map();
  for (const [index, definition] of definitions.entries()) {
    if (!isRecord(definition)) fail(`coverageManifest.selectedDefinitions[${index}] must be an object.`);
    const auditId = string(definition.auditId, `coverageManifest.selectedDefinitions[${index}].auditId`, 160);
    if (definitionById.has(auditId)) fail(`Duplicate selected Audit Definition ${auditId}.`);
    if (!SEVERITIES.has(definition.severity)) fail(`Selected Audit Definition ${auditId} has an invalid severity.`);
    if (typeof definition.manual !== 'boolean') fail(`Selected Audit Definition ${auditId} must declare manual status.`);
    const executionIds = uniqueStrings(definition.executionIds, `${auditId}.executionIds`);
    const selectedCaseIds = uniqueStrings(definition.selectedCaseIds, `${auditId}.selectedCaseIds`);
    if (definition.manual && (executionIds.length || selectedCaseIds.length)) {
      fail(`Manual Audit Definition ${auditId} must not manufacture browser executions.`);
    }
    definitionById.set(auditId, {
      auditId,
      title: string(definition.title, `${auditId}.title`, 400),
      area: string(definition.area, `${auditId}.area`, 160),
      severity: definition.severity,
      manual: definition.manual,
      executionIds,
      selectedCaseIds,
    });
  }

  const executionById = new Map();
  const executionsByAudit = new Map([...definitionById].map(([auditId]) => [auditId, []]));
  const executionKeys = new Set();
  for (const [index, execution] of executions.entries()) {
    if (!isRecord(execution)) fail(`coverageManifest.executions[${index}] must be an object.`);
    const executionId = string(execution.executionId, `coverageManifest.executions[${index}].executionId`, 800);
    const auditId = string(execution.auditId, `${executionId}.auditId`, 160);
    const caseId = string(execution.caseId, `${executionId}.caseId`, 800);
    const targetId = string(execution.targetId, `${executionId}.targetId`, 160);
    if (executionId !== `${caseId}@${targetId}`) fail(`Planned execution ${executionId} is not canonically bound to its case and target.`);
    if (executionById.has(executionId)) fail(`Duplicate planned execution ${executionId}.`);
    const definition = definitionById.get(auditId);
    if (!definition || definition.manual) fail(`Planned execution ${executionId} is not owned by an automated selected definition.`);
    if (!targetIds.has(targetId) || !definition.executionIds.includes(executionId)
      || !definition.selectedCaseIds.includes(caseId)) {
      fail(`Planned execution ${executionId} is inconsistent with selected definition or target coverage.`);
    }
    const key = `${caseId}\u0000${targetId}`;
    if (executionKeys.has(key)) fail(`Case ${caseId} has duplicate planned execution on ${targetId}.`);
    executionKeys.add(key);
    const normalized = { executionId, auditId, caseId, targetId };
    executionById.set(executionId, normalized);
    executionsByAudit.get(auditId).push(normalized);
  }
  for (const definition of definitionById.values()) {
    const actual = (executionsByAudit.get(definition.auditId) ?? []).map(({ executionId }) => executionId).sort();
    if (canonicalJson(actual) !== canonicalJson([...definition.executionIds].sort())) {
      fail(`Audit Definition ${definition.auditId} execution membership disagrees with the compiler manifest.`);
    }
  }
  const selectedCaseIds = new Set([...definitionById.values()].flatMap((definition) => definition.selectedCaseIds));
  if ([...definitionById.values()].reduce((total, definition) => total + definition.selectedCaseIds.length, 0) !== selectedCaseIds.size) {
    fail('Selected executable case IDs must belong to exactly one Audit Definition.');
  }

  const gapAuditIds = new Set();
  const coverageGaps = gaps.map((gap, index) => {
    if (!isRecord(gap)) fail(`coverageManifest.coverageGaps[${index}] must be an object.`);
    const auditId = string(gap.auditId, `coverageManifest.coverageGaps[${index}].auditId`, 160);
    gapAuditIds.add(auditId);
    return `${auditId}: ${scrub(string(gap.detail, `coverageManifest.coverageGaps[${index}].detail`), 200)}`.slice(0, 240);
  });
  const omittedCoverage = [];
  const omittedCaseAuditIds = new Set();
  for (const [index, omission] of omittedDefinitions.entries()) {
    if (!isRecord(omission) || omission.disposition !== 'operator-scope-omission') {
      fail(`coverageManifest.omissions.definitions[${index}] is invalid.`);
    }
    omittedCoverage.push(`definition:${string(omission.auditId, `omitted definition ${index}`, 160)}`);
  }
  for (const [index, omission] of omittedCases.entries()) {
    if (!isRecord(omission) || omission.disposition !== 'operator-target-omission') {
      fail(`coverageManifest.omissions.cases[${index}] is invalid.`);
    }
    const auditId = string(omission.auditId, `omitted case ${index} auditId`, 160);
    const definition = definitionById.get(auditId);
    if (!definition || definition.manual) {
      fail(`coverageManifest.omissions.cases[${index}] is not owned by an automated selected definition.`);
    }
    omittedCaseAuditIds.add(auditId);
    omittedCoverage.push(`case:${string(omission.caseId, `omitted case ${index}`, 800)}`);
  }
  for (const [index, omission] of omittedTargets.entries()) {
    if (!isRecord(omission) || !['operator-omitted-required-target', 'optional-target-not-selected'].includes(omission.disposition)) {
      fail(`coverageManifest.omissions.targets[${index}] is invalid.`);
    }
    if (omission.disposition === 'operator-omitted-required-target') {
      omittedCoverage.push(`target:${string(omission.targetId, `omitted target ${index}`, 160)}`);
    }
  }
  if (new Set(omittedCoverage).size !== omittedCoverage.length) fail('Coverage omissions contain duplicates.');
  if (manifest.scope.qualifier === 'FULL' && omittedCoverage.length) fail('FULL compiler scope contains required operator omissions.');
  for (const definition of definitionById.values()) {
    if (!definition.manual && definition.executionIds.length === 0
      && !gapAuditIds.has(definition.auditId) && !omittedCaseAuditIds.has(definition.auditId)) {
      fail(`Automated Audit Definition ${definition.auditId} has neither planned execution, explicit target omission, nor a Coverage Gap.`);
    }
  }

  const outside = outsideMode.map((definition, index) => {
    if (!isRecord(definition) || definition.singleSiteClassification !== 'comparison-only'
      || definition.disposition !== 'outside-single-site-mode') {
      fail(`coverageManifest.outsideMode[${index}] is not a comparison-only definition.`);
    }
    return {
      auditId: string(definition.auditId, `outsideMode[${index}].auditId`, 160),
      title: string(definition.title, `outsideMode[${index}].title`, 400),
      reason: 'comparison-only',
    };
  });
  if (new Set(outside.map(({ auditId }) => auditId)).size !== outside.length) fail('outsideMode contains duplicate Audit Definitions.');
  if (manifest.coverageStatus !== (coverageGaps.length ? 'GAPS' : 'COMPLETE')) {
    fail('coverageManifest.coverageStatus disagrees with its Coverage Gaps.');
  }
  const expectedCounts = {
    selectedDefinitions: definitions.length,
    executableCases: selectedCaseIds.size,
    plannedExecutions: executions.length,
    manualDefinitions: [...definitionById.values()].filter(({ manual }) => manual).length,
    coverageGaps: gaps.length,
    omittedDefinitions: omittedDefinitions.length,
    outsideModeDefinitions: outsideMode.length,
  };
  if (!isRecord(manifest.counts)
    || Object.entries(expectedCounts).some(([name, count]) => manifest.counts[name] !== count)) {
    fail('coverageManifest counts disagree with its compiled definitions, cases, executions, gaps, or exclusions.');
  }
  const selectedCoverage = [...definitionById.keys()].map((auditId) => `definition:${auditId}`).sort();
  if (selectedCoverage.some((item) => omittedCoverage.includes(item))) fail('Selected and omitted compiler coverage overlap.');

  return {
    manifest,
    definitionById,
    executionById,
    executionsByAudit,
    coverageGaps: [...new Set(coverageGaps)].sort(),
    omittedCaseAuditIds,
    selectedCoverage,
    omittedCoverage: omittedCoverage.sort(),
    outside: outside.sort((left, right) => left.auditId.localeCompare(right.auditId)),
  };
}

function rawPlaywrightEvidence(playwrightResults, playwrightResultsBytes, workerResult, problems) {
  if (!workerResult || !isRecord(workerResult.freshEvidence) || workerResult.freshEvidence.fresh !== true) {
    problems.push('The current worker did not bind fresh Playwright results.');
    return null;
  }
  if (!(typeof playwrightResultsBytes === 'string' || playwrightResultsBytes instanceof Uint8Array)) {
    problems.push('Raw Playwright results bytes were not supplied for digest verification.');
    return null;
  }
  const bytes = Buffer.from(playwrightResultsBytes);
  if (bytes.length < 2 || bytes.length > MAX_SINGLE_SITE_PLAYWRIGHT_RESULTS_BYTES) {
    problems.push('Playwright results bytes are empty or exceed the bounded parser limit.');
    return null;
  }
  if (workerResult.freshEvidence.relativePath !== 'results.json'
    || workerResult.freshEvidence.bytes !== bytes.length
    || workerResult.freshEvidence.digest !== digestBytes(bytes)) {
    problems.push('Playwright results bytes do not match the current worker evidence digest.');
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    problems.push('Playwright results bytes are not valid JSON.');
    return null;
  }
  try {
    if (canonicalJson(parsed) !== canonicalJson(playwrightResults)) {
      problems.push('Parsed Playwright results do not match their digest-bound source bytes.');
      return null;
    }
  } catch {
    problems.push('Parsed Playwright results contain unsupported non-JSON values.');
    return null;
  }
  return parsed;
}

function processedPlaywrightEvidence({
  sourceDocument,
  workerResult,
  mediaStage,
  playwrightResults,
  playwrightResultsBytes,
  problems,
}) {
  if (!isRecord(mediaStage) || mediaStage.schemaVersion !== 1 || mediaStage.kind !== 'single-site-media-stage'
    || mediaStage.mode !== 'single-site' || typeof mediaStage.mediaStageDigest !== 'string') {
    problems.push('The processed media stage is absent or malformed.');
    return null;
  }
  const { mediaStageDigest, ...body } = mediaStage;
  if (sha256(body) !== mediaStageDigest
    || mediaStage.sourceResultsDigest !== workerResult?.freshEvidence?.digest
    || mediaStage.sourceResultsBytes !== workerResult?.freshEvidence?.bytes) {
    problems.push('The processed media stage does not bind the sealed worker results.');
    return null;
  }
  if (!(typeof playwrightResultsBytes === 'string' || playwrightResultsBytes instanceof Uint8Array)) {
    problems.push('Processed Playwright results bytes were not supplied for digest verification.');
    return null;
  }
  const bytes = Buffer.from(playwrightResultsBytes);
  if (bytes.length < 2 || bytes.length > MAX_SINGLE_SITE_PLAYWRIGHT_RESULTS_BYTES
    || mediaStage.processedResultsBytes !== bytes.length
    || mediaStage.processedResultsDigest !== digestBytes(bytes)
    || !/^[a-f0-9]{64}$/.test(mediaStage.videoManifestDigest ?? '')) {
    problems.push('Processed Playwright results do not match their media-stage digest and byte bindings.');
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch {
    problems.push('Processed Playwright results bytes are not valid JSON.');
    return null;
  }
  try {
    if (canonicalJson(parsed) !== canonicalJson(playwrightResults)) {
      problems.push('Parsed processed Playwright results do not match their digest-bound bytes.');
      return null;
    }
  } catch {
    problems.push('Processed Playwright results contain unsupported non-JSON values.');
    return null;
  }
  // The processor may rewrite attachment paths and remove rejected video
  // attachments, but it cannot add, remove, or alter Playwright executions.
  const stripAttachments = (value) => {
    const clone = structuredClone(value);
    const visit = (suites) => {
      for (const suite of Array.isArray(suites) ? suites : []) {
        for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
          for (const test of Array.isArray(spec?.tests) ? spec.tests : []) {
            for (const result of Array.isArray(test?.results) ? test.results : []) result.attachments = [];
          }
        }
        visit(suite?.suites);
      }
    };
    visit(clone?.suites);
    return clone;
  };
  try {
    if (canonicalJson(stripAttachments(sourceDocument)) !== canonicalJson(stripAttachments(parsed))) {
      problems.push('The media processor changed data outside Playwright attachment lists.');
      return null;
    }
  } catch {
    problems.push('The media processor output could not be structurally compared with sealed results.');
    return null;
  }
  if (mediaStage.qualityState !== 'complete') {
    const detail = Array.isArray(mediaStage.integrityErrors)
      ? mediaStage.integrityErrors.slice(0, 8).map((item) => scrub(item, 500)).filter(Boolean).join(' ')
      : '';
    problems.push(`Required media evidence is incomplete.${detail ? ` ${detail}` : ''}`);
  }
  return parsed;
}

function bindCurrentWorkerResult(state, workerResult, problems) {
  if (!isRecord(workerResult) || workerResult.schemaVersion !== 1 || workerResult.kind !== 'single-site-worker-result') {
    problems.push('The current worker result is absent or malformed.');
    return false;
  }
  if (workerResult.jobId !== state.jobId || workerResult.attemptId !== state.attemptId
    || workerResult.attemptNumber !== state.attemptNumber || workerResult.fencingToken !== state.fencingToken) {
    problems.push('The worker result is stale or belongs to a different fenced attempt.');
    return false;
  }
  const publication = state.publications.find((entry) => (
    entry.publicationId === `attempt-${state.attemptNumber}-worker-result`
    && entry.relativePath === 'worker/attempt-result.json'
    && entry.attemptId === state.attemptId
    && entry.attemptNumber === state.attemptNumber
    && entry.fencingToken === state.fencingToken
  ));
  let workerResultDigest = null;
  try { workerResultDigest = sha256(workerResult); } catch { /* handled as untrusted evidence below */ }
  if (!publication || publication.digest !== workerResultDigest) {
    problems.push('The worker result does not match its current immutable queue publication.');
    return false;
  }
  const expectedClassification = state.result?.kind === 'passed'
    ? 'success'
    : state.result?.kind === 'findings' ? 'assertion-failure' : null;
  if (state.executionState === 'completed' && workerResult.classification !== expectedClassification) {
    problems.push('The worker classification disagrees with the completed queue result.');
    return false;
  }
  return true;
}

function routeInventoryForReport(input, state, workerResult, routeInventoryPublication, compiler, problems) {
  const required = input.routeInventoryPlan.required === true;
  if (!required) {
    if (routeInventoryPublication !== null || workerResult?.routeInventory) {
      problems.push('A route inventory was published for a run whose frozen plan intentionally omitted discovery.');
      return { valid: false, findings: [], coverageGaps: [], limitations: [] };
    }
    return { valid: true, findings: [], coverageGaps: [], limitations: [] };
  }
  if (!verifySingleSiteRouteInventoryPublication(routeInventoryPublication, {
    jobId: state.jobId,
    attemptId: state.attemptId,
    coverageManifestDigest: input.coverageManifest.manifestDigest,
  })) {
    problems.push('Required live route inventory is absent, malformed, or not bound to the current attempt and Coverage Manifest.');
    return { valid: false, findings: [], coverageGaps: [], limitations: [] };
  }
  if (routeInventoryPublication.routePlanDigest !== input.routeInventoryPlan.planDigest) {
    problems.push('Live route inventory does not match the frozen launch route plan.');
    return { valid: false, findings: [], coverageGaps: [], limitations: [] };
  }
  const queuePublication = state.publications.find((entry) => (
    entry.publicationId === `attempt-${state.attemptNumber}-route-inventory`
    && entry.relativePath === 'worker/route-inventory.json'
    && entry.attemptId === state.attemptId
    && entry.attemptNumber === state.attemptNumber
    && entry.fencingToken === state.fencingToken
  ));
  const routeBinding = workerResult?.routeInventory;
  const queueDigest = sha256(routeInventoryPublication);
  if (!queuePublication || queuePublication.digest !== queueDigest || !isRecord(routeBinding)
    || routeBinding.publicationId !== queuePublication.publicationId
    || routeBinding.relativePath !== queuePublication.relativePath
    || routeBinding.queueDigest !== queueDigest
    || routeBinding.inventoryDigest !== routeInventoryPublication.inventoryDigest
    || routeBinding.publicationDigest !== routeInventoryPublication.publicationDigest
    || routeBinding.genericExecutionCount !== routeInventoryPublication.genericExecutions.length
    || routeBinding.reviewedFindingCount !== routeInventoryPublication.reviewedFindings.length
    || routeBinding.coverageGapCount !== routeInventoryPublication.coverageGaps.length
    || routeBinding.limitationCount !== routeInventoryPublication.limitations.length) {
    problems.push('Live route inventory does not match its immutable queue and worker-result bindings.');
    return { valid: false, findings: [], coverageGaps: [], limitations: [] };
  }

  const definition = compiler.definitionById.get(GENERIC_ROUTE_AUDIT_ID);
  if (!definition || definition.manual) {
    problems.push(`Required generic route inspection is not owned by selected automated definition ${GENERIC_ROUTE_AUDIT_ID}.`);
    return { valid: false, findings: [], coverageGaps: [], limitations: [] };
  }
  if (!compiler.manifest.scope.selectedTargetIds.includes(input.routeInventoryPlan.canonicalTargetId)) {
    problems.push('The route plan canonical target is absent from selected target coverage.');
    return { valid: false, findings: [], coverageGaps: [], limitations: [] };
  }
  for (const execution of boundedArray(routeInventoryPublication.genericExecutions, 'routeInventory.genericExecutions')) {
    if (execution.targetId !== input.routeInventoryPlan.canonicalTargetId || execution.auditId !== GENERIC_ROUTE_AUDIT_ID
      || compiler.executionById.has(execution.executionId)) {
      problems.push(`Generic route execution ${scrub(execution.executionId, 700)} conflicts with the frozen compiler plan.`);
      return { valid: false, findings: [], coverageGaps: [], limitations: [] };
    }
    const normalized = {
      executionId: string(execution.executionId, 'generic executionId', 800),
      auditId: GENERIC_ROUTE_AUDIT_ID,
      caseId: string(execution.caseId, 'generic caseId', 800),
      targetId: string(execution.targetId, 'generic targetId', 160),
    };
    compiler.executionById.set(normalized.executionId, normalized);
    compiler.executionsByAudit.get(GENERIC_ROUTE_AUDIT_ID).push(normalized);
  }
  if (compiler.executionById.size > MAX_SINGLE_SITE_REPORT_EXECUTIONS) {
    fail(`Combined compiler and generic route executions exceed the ${MAX_SINGLE_SITE_REPORT_EXECUTIONS}-execution report bound.`);
  }

  const findings = boundedArray(routeInventoryPublication.reviewedFindings, 'routeInventory.reviewedFindings').map((item, index) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^FINDING-[A-F0-9]{24}$/.test(item.id)
      || !SEVERITIES.has(item.severity) || typeof item.auditId !== 'string'
      || !compiler.definitionById.has(item.auditId) || item.source !== 'route-inventory'
      || typeof item.title !== 'string' || typeof item.detail !== 'string') {
      fail(`routeInventory.reviewedFindings[${index}] is malformed or references unselected coverage.`);
    }
    return {
      id: item.id,
      severity: item.severity,
      auditId: item.auditId,
      executionId: 'route-inventory',
      targetId: null,
      source: 'route-inventory',
      title: scrub(item.title, 400),
      detail: scrub(item.detail, 1_200),
    };
  });
  const coverageGaps = boundedArray(routeInventoryPublication.coverageGaps, 'routeInventory.coverageGaps')
    .map((gap, index) => {
      if (!isRecord(gap) || gap.kind !== 'unreviewed-inventoried-route'
        || gap.auditId !== GENERIC_ROUTE_AUDIT_ID || typeof gap.route !== 'string' || typeof gap.detail !== 'string') {
        fail(`routeInventory.coverageGaps[${index}] is malformed.`);
      }
      return `${GENERIC_ROUTE_AUDIT_ID}: ${scrub(gap.detail, 500)}`;
    });
  const limitations = boundedArray(routeInventoryPublication.limitations, 'routeInventory.limitations')
    .map((limitation, index) => {
      if (!isRecord(limitation) || typeof limitation.code !== 'string'
        || typeof limitation.source !== 'string' || typeof limitation.detail !== 'string') {
        fail(`routeInventory.limitations[${index}] is malformed.`);
      }
      return `${scrub(limitation.source, 120)}/${scrub(limitation.code, 120)}: ${scrub(limitation.detail, 500)}`;
    });
  return { valid: true, findings, coverageGaps, limitations };
}

function flattenPlaywrightTests(document, problems) {
  if (!isRecord(document) || !Array.isArray(document.suites) || !Array.isArray(document.errors)) {
    problems.push('Playwright results lack bounded suites or top-level errors arrays.');
    return [];
  }
  if (document.errors.length > 100) {
    problems.push('Playwright results exceed the top-level error bound.');
    return [];
  }
  if (document.errors.length) problems.push(`Playwright reported ${document.errors.length} top-level error(s).`);
  const tests = [];
  let nodes = 0;
  const visit = (suites, depth) => {
    if (depth > 32) fail('Playwright suite nesting exceeds 32 levels.');
    for (const suite of boundedArray(suites, 'Playwright suites')) {
      nodes += 1;
      if (nodes > 50_000) fail('Playwright results exceed the structural node bound.');
      if (!isRecord(suite)) fail('Playwright suite must be an object.');
      const specs = boundedArray(suite.specs ?? [], 'Playwright suite.specs');
      for (const spec of specs) {
        if (!isRecord(spec)) fail('Playwright spec must be an object.');
        for (const test of boundedArray(spec.tests ?? [], 'Playwright spec.tests')) {
          nodes += 1;
          if (tests.length >= MAX_SINGLE_SITE_REPORT_EXECUTIONS || nodes > 50_000) {
            fail('Playwright results exceed the test execution bound.');
          }
          if (!isRecord(test)) fail('Playwright test must be an object.');
          tests.push({ test, title: typeof spec.title === 'string' ? spec.title : 'Untitled Playwright test' });
        }
      }
      visit(boundedArray(suite.suites ?? [], 'Playwright suite.suites'), depth + 1);
    }
  };
  try {
    visit(document.suites, 0);
  } catch (error) {
    problems.push(scrub(error.message));
    return [];
  }
  return tests;
}

function decodeAuditRecord(test, execution, definition, input, problems) {
  const results = boundedArray(test.results, `${execution.executionId}.results`, 20);
  let artifactCount = 0;
  for (const [resultIndex, result] of results.entries()) {
    if (!isRecord(result) || !PLAYWRIGHT_RESULT_STATUSES.has(result.status)) {
      problems.push(`${execution.executionId} has a malformed attempt result.`);
      continue;
    }
    const attachments = boundedArray(result.attachments ?? [], `${execution.executionId}.results[${resultIndex}].attachments`, 500);
    const errors = boundedArray(result.errors ?? [], `${execution.executionId}.results[${resultIndex}].errors`, 100);
    artifactCount += attachments.length;
    if (artifactCount > 2_000) fail(`${execution.executionId} exceeds the attachment bound.`);
    if (errors.some((error) => !isRecord(error))) problems.push(`${execution.executionId} contains a malformed error record.`);
  }
  const finalResult = results.at(-1) ?? null;
  const finalAttachments = isRecord(finalResult) ? (finalResult.attachments ?? []) : [];
  const summaryAttachments = Array.isArray(finalAttachments)
    ? finalAttachments.filter((attachment) => isRecord(attachment) && attachment.name === 'audit-result-summary')
    : [];
  const legacyInlineAttachments = Array.isArray(finalAttachments)
    ? finalAttachments.filter((attachment) => isRecord(attachment)
      && attachment.name === 'audit-result' && typeof attachment.body === 'string')
    : [];
  const auditAttachments = summaryAttachments.length === 1 ? summaryAttachments : legacyInlineAttachments;
  if (auditAttachments.length !== 1 || summaryAttachments.length > 1) {
    problems.push(`${execution.executionId} did not publish exactly one bounded audit-result decision summary.`);
    return { artifactCount, findings: [], evidenceValid: false };
  }
  const attachment = auditAttachments[0];
  if (attachment.contentType !== 'application/json' || typeof attachment.body !== 'string'
    || attachment.body.length < 4 || attachment.body.length > 4 * 1_048_576
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.body)) {
    problems.push(`${execution.executionId} audit-result decision summary is not bounded inline JSON evidence.`);
    return { artifactCount, findings: [], evidenceValid: false };
  }
  let record;
  try {
    record = JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
  } catch {
    problems.push(`${execution.executionId} audit-result decision summary is not valid JSON.`);
    return { artifactCount, findings: [], evidenceValid: false };
  }
  const authority = input.coverageManifest.deployment.evidenceAuthority;
  if (!isRecord(record) || record.schemaVersion !== 1 || record.mode !== 'single-site'
    || record.caseId !== execution.caseId || record.auditId !== execution.auditId
    || record.project !== execution.targetId || record.baseURL !== input.runContract.url
    || record.deploymentRole !== input.runContract.deploymentRole
    || !isRecord(record.evidenceAuthority)
    || record.evidenceAuthority.status !== authority.status
    || canonicalJson(record.evidenceAuthority.reasons) !== canonicalJson(authority.reasons)
    || !Array.isArray(record.findings) || record.findings.length > 100) {
    problems.push(`${execution.executionId} audit-result evidence does not match its manifest, target, origin, or authority.`);
    return { artifactCount, findings: [], evidenceValid: false };
  }
  const findings = [];
  for (const [index, finding] of record.findings.entries()) {
    if (!isRecord(finding) || typeof finding.title !== 'string' || !finding.title.trim()
      || typeof finding.detail !== 'string' || !finding.detail.trim()) {
      problems.push(`${execution.executionId} contains a malformed structured finding.`);
      return { artifactCount, findings: [], evidenceValid: false };
    }
    const title = scrub(finding.title, 400);
    const detail = scrub(finding.detail, 1_200);
    findings.push({
      id: findingId(['structured', execution.executionId, index, title, detail]),
      severity: definition.severity,
      auditId: execution.auditId,
      executionId: execution.executionId,
      targetId: execution.targetId,
      source: 'structured-audit-finding',
      title,
      detail,
    });
  }
  return { artifactCount, findings, evidenceValid: true };
}

function normalizeExecution(testRecord, execution, definition, input, problems) {
  const { test, title } = testRecord;
  const localProblems = [];
  if (!PLAYWRIGHT_TEST_STATUSES.has(test.status) || test.expectedStatus !== 'passed') {
    localProblems.push('unsupported or deliberately non-passing Playwright expectation');
  }
  const results = Array.isArray(test.results) ? test.results : [];
  const finalResult = isRecord(results.at(-1)) ? results.at(-1) : null;
  const retryValues = results.map((result) => isRecord(result) ? result.retry : null);
  const flaky = test.status === 'flaky' || results.length > 1 || retryValues.some((retry) => retry !== 0);
  const evidence = decodeAuditRecord(test, execution, definition, input, localProblems);
  const findings = [...evidence.findings];
  let status;
  if (!finalResult || !PLAYWRIGHT_RESULT_STATUSES.has(finalResult.status)) {
    status = 'BLOCKED';
    localProblems.push('missing or invalid final Playwright result');
  } else if (finalResult.status === 'failed' && test.expectedStatus === 'passed') {
    const finalErrors = Array.isArray(finalResult.errors) ? finalResult.errors : [];
    const error = finalErrors.find((item) => isRecord(item) && typeof item.message === 'string');
    const detail = scrub(error?.message ?? `Playwright assertion failed: ${title}`, 1_200);
    findings.push({
      id: findingId(['assertion', execution.executionId, detail]),
      severity: definition.severity,
      auditId: execution.auditId,
      executionId: execution.executionId,
      targetId: execution.targetId,
      source: 'playwright-assertion',
      title: scrub(title, 400),
      detail,
    });
    status = 'FAIL';
  } else if (['timedOut', 'interrupted'].includes(finalResult.status)) {
    status = 'BLOCKED';
    localProblems.push(`Playwright execution ended ${finalResult.status}`);
  } else if (finalResult.status === 'skipped' || test.status === 'skipped') {
    status = 'NOT_RUN';
    localProblems.push('planned execution was skipped');
  } else if (flaky) {
    status = 'FLAKY';
    localProblems.push('planned execution was flaky or retried');
  } else if (finalResult.status === 'passed' && test.status === 'expected' && evidence.evidenceValid) {
    status = findings.length ? 'FAIL' : 'PASS';
  } else {
    status = 'BLOCKED';
    localProblems.push('Playwright result and aggregate status are inconsistent');
  }
  if (!evidence.evidenceValid && status === 'PASS') status = 'BLOCKED';
  for (const problem of localProblems) problems.push(`${execution.executionId}: ${problem}.`);
  return { status, artifactCount: evidence.artifactCount, findings, evidenceValid: evidence.evidenceValid, problems: localProblems };
}

function aggregateAudit(definition, planned, observed, gapDetails, omittedCaseAuditIds) {
  if (definition.manual) {
    return {
      row: {
        id: definition.auditId,
        title: definition.title,
        area: definition.area,
        status: 'MANUAL_REQUIRED',
        findingCount: 0,
        evidenceStatus: 'complete',
        artifactCount: 0,
        manual: true,
        visualStatus: 'absent',
        detail: 'Human acceptance evidence is required; no browser execution was manufactured for this manual Audit Definition.',
      },
      findings: [],
    };
  }
  const executions = planned.map((execution) => observed.get(execution.executionId)).filter(Boolean);
  const findings = executions.flatMap((execution) => execution.findings);
  const artifactCount = executions.reduce((total, execution) => total + execution.artifactCount, 0);
  const missing = planned.length - executions.length;
  const statuses = executions.map(({ status }) => status);
  const hasGap = gapDetails.some((detail) => detail.startsWith(`${definition.auditId}:`));
  const hasTargetOmission = omittedCaseAuditIds.has(definition.auditId);
  const status = missing > 0
    ? executions.length === 0 ? 'NOT_RUN' : 'BLOCKED'
    : statuses.includes('BLOCKED') ? 'BLOCKED'
      : statuses.includes('NOT_RUN') ? 'NOT_RUN'
        : statuses.includes('FLAKY') ? 'FLAKY'
          : findings.length || statuses.includes('FAIL') ? 'FAIL'
            : planned.length === 0 && (hasGap || hasTargetOmission) ? 'NOT_RUN' : 'PASS';
  const evidenceComplete = missing === 0 && executions.every(({ evidenceValid }) => evidenceValid)
    && !statuses.some((value) => ['BLOCKED', 'NOT_RUN', 'FLAKY'].includes(value));
  const passed = statuses.filter((value) => value === 'PASS').length;
  const detailParts = [
    `${passed} of ${planned.length} planned target execution${planned.length === 1 ? '' : 's'} passed`,
    `${artifactCount} artifact${artifactCount === 1 ? '' : 's'} observed`,
  ];
  if (findings.length) detailParts.push(`${findings.length} deterministic finding${findings.length === 1 ? '' : 's'}`);
  if (missing) detailParts.push(`${missing} planned execution${missing === 1 ? '' : 's'} missing`);
  if (hasGap) detailParts.push('standalone coverage gap retained');
  if (hasTargetOmission) detailParts.push('case omitted for the selected target set');
  return {
    row: {
      id: definition.auditId,
      title: definition.title,
      area: definition.area,
      status,
      findingCount: findings.length,
      evidenceStatus: evidenceComplete ? 'complete' : 'incomplete',
      artifactCount,
      manual: false,
      visualStatus: 'absent',
      detail: `${detailParts.join('; ')}.`,
    },
    findings,
  };
}

/**
 * Pure trust-boundary adapter from fenced queue/browser evidence to the compact
 * SingleSiteReportInput consumed by site-health-report.mjs.
 */
export function buildSingleSiteReportInput({
  workerInput: rawWorkerInput,
  terminalState: rawTerminalState,
  workerResult = null,
  playwrightResults = null,
  playwrightResultsBytes = null,
  processedPlaywrightResults = null,
  processedPlaywrightResultsBytes = null,
  mediaStage = null,
  routeInventoryPublication = null,
  generatedAt,
  pageSize = undefined,
}) {
  if (pageSize !== undefined && (!Number.isSafeInteger(pageSize) || pageSize < 10 || pageSize > 100)) {
    fail('pageSize must be an integer from 10 through 100.');
  }
  const state = assertJobEnvelope(structuredClone(rawTerminalState));
  if (!TERMINAL_STATES.has(state.executionState)) fail('Single-site report input requires a terminal queue envelope.');
  const input = state.executionState === 'completed'
    ? assertWorkerInputBoundToState(rawWorkerInput, state)
    : validateSingleSiteWorkerInput(rawWorkerInput);
  // Even failed/cancelled jobs retain immutable input bindings.
  if (state.executionState !== 'completed') assertWorkerInputBoundToState(rawWorkerInput, state);
  const compiler = validateManifestForReport(input);
  const reportGeneratedAt = isoTimestamp(generatedAt, 'generatedAt');
  const problems = [];
  const workerBound = workerResult !== null && bindCurrentWorkerResult(state, workerResult, problems);
  const routeInventory = routeInventoryForReport(
    input,
    state,
    workerResult,
    routeInventoryPublication,
    compiler,
    problems,
  );
  let document = null;
  if (state.executionState === 'completed' && workerBound) {
    const sourceDocument = rawPlaywrightEvidence(playwrightResults, playwrightResultsBytes, workerResult, problems);
    document = sourceDocument && mediaStage !== null
      ? processedPlaywrightEvidence({
          sourceDocument,
          workerResult,
          mediaStage,
          playwrightResults: processedPlaywrightResults,
          playwrightResultsBytes: processedPlaywrightResultsBytes,
          problems,
        })
      : sourceDocument;
  } else if (state.executionState === 'completed') {
    problems.push('Completed queue state lacks a trustworthy current worker result.');
  }

  const observed = new Map();
  const duplicated = new Set();
  if (document) {
    const tests = flattenPlaywrightTests(document, problems);
    for (const { test, title } of tests) {
      const annotations = Array.isArray(test.annotations) ? test.annotations : [];
      if (annotations.length > 64) {
        problems.push('A Playwright test exceeds the annotation bound.');
        continue;
      }
      const caseAnnotations = annotations.filter((annotation) => isRecord(annotation) && annotation.type === 'audit-case-id');
      if (caseAnnotations.length !== 1 || typeof caseAnnotations[0].description !== 'string') {
        problems.push(`Unexpected Playwright test without exactly one audit-case-id annotation: ${scrub(title, 300)}.`);
        continue;
      }
      const caseId = caseAnnotations[0].description;
      const projectName = typeof test.projectName === 'string' ? test.projectName : '';
      const executionId = `${caseId}@${projectName}`;
      const execution = compiler.executionById.get(executionId);
      if (!execution) {
        problems.push(`Unexpected Playwright execution ${scrub(executionId, 700)} was not planned by the compiler.`);
        continue;
      }
      if (observed.has(executionId)) {
        problems.push(`Duplicate Playwright execution ${scrub(executionId, 700)} was published.`);
        observed.delete(executionId);
        duplicated.add(executionId);
        continue;
      }
      if (duplicated.has(executionId)) continue;
      try {
        observed.set(executionId, normalizeExecution(
          { test, title },
          execution,
          compiler.definitionById.get(execution.auditId),
          input,
          problems,
        ));
      } catch (error) {
        problems.push(`${executionId}: ${scrub(error.message)}.`);
        observed.set(executionId, {
          status: 'BLOCKED', artifactCount: 0, findings: [], evidenceValid: false, problems: [scrub(error.message)],
        });
      }
    }
  }

  for (const execution of compiler.executionById.values()) {
    if (!observed.has(execution.executionId)) problems.push(`Planned execution ${execution.executionId} is missing.`);
  }
  const audits = [];
  const findings = [...routeInventory.findings];
  for (const definition of [...compiler.definitionById.values()].sort((left, right) => left.auditId.localeCompare(right.auditId))) {
    const aggregate = aggregateAudit(
      definition,
      compiler.executionsByAudit.get(definition.auditId) ?? [],
      observed,
      compiler.coverageGaps,
      compiler.omittedCaseAuditIds,
    );
    audits.push(aggregate.row);
    findings.push(...aggregate.findings);
  }
  const routeFindingCountsByAudit = new Map();
  for (const { auditId } of routeInventory.findings) {
    routeFindingCountsByAudit.set(auditId, (routeFindingCountsByAudit.get(auditId) ?? 0) + 1);
  }
  for (const [auditId, routeFindingCount] of routeFindingCountsByAudit) {
    const audit = audits.find(({ id }) => id === auditId);
    if (!audit) continue;
    audit.status = 'FAIL';
    audit.findingCount += routeFindingCount;
    audit.detail = `${audit.detail} Live route inventory added ${routeFindingCount} deterministic route finding${routeFindingCount === 1 ? '' : 's'}; route-level evidence remains available in the finding index.`;
  }
  findings.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(findings.map(({ id }) => id)).size !== findings.length) fail('Deterministic finding IDs collided.');

  const completed = state.executionState === 'completed';
  const assertionFindingCount = findings.filter(({ source }) => source === 'playwright-assertion').length;
  const assertionResultConsistent = completed
    && ((assertionFindingCount === 0 && state.result?.kind === 'passed')
      || (assertionFindingCount > 0 && state.result?.kind === 'findings'));
  if (completed && document && !assertionResultConsistent) {
    problems.push('Queue completion classification disagrees with deterministic parsed findings.');
  }
  const uniqueProblems = [...new Set(problems.map((problem) => scrub(problem, 600)).filter(Boolean))].sort();
  const cancellationReason = state.executionState === 'cancelled'
    ? scrub(state.cancellation?.reason ?? 'Operator cancelled the run.', 1_200)
    : null;
  const terminalReason = scrub(state.result?.reason ?? '', 1_200) || null;
  const integrityComplete = completed && document !== null && routeInventory.valid
    && uniqueProblems.length === 0 && assertionResultConsistent;
  const requiredEvidenceComplete = completed && document !== null
    && (mediaStage === null || mediaStage.qualityState === 'complete')
    && routeInventory.valid
    && [...compiler.executionById.keys()].every((executionId) => observed.has(executionId))
    && [...observed.values()].every(({ evidenceValid, status }) => evidenceValid
      && !['BLOCKED', 'NOT_RUN'].includes(status));
  const pipelineReason = integrityComplete
    ? 'Every compiler-planned execution was mapped to current, digest-bound evidence.'
    : scrub(uniqueProblems.slice(0, 8).join(' ') || terminalReason || `Queue execution ended ${state.executionState}.`, 2_400);
  const authority = compiler.manifest.deployment.evidenceAuthority;
  const manualRequired = [...compiler.definitionById.values()].filter(({ manual }) => manual).length;

  return Object.freeze({
    schemaVersion: 1,
    mode: 'single-site',
    generatedAt: reportGeneratedAt,
    ...(pageSize === undefined ? {} : { pageSize }),
    health: {
      schemaVersion: 1,
      mode: 'single-site',
      url: input.runContract.url,
      deploymentRole: input.runContract.deploymentRole,
      scope: {
        qualifier: compiler.manifest.scope.qualifier,
        selectedCoverage: compiler.selectedCoverage,
        omittedCoverage: compiler.omittedCoverage,
      },
      coverage: {
        finalized: routeInventory.valid,
        manifestIntegrity: true,
        gaps: [...new Set([...compiler.coverageGaps, ...routeInventory.coverageGaps])].sort(),
        limitations: [...new Set(routeInventory.limitations)].sort(),
      },
      pipeline: {
        executionStatus: state.executionState,
        integrityComplete,
        requiredEvidenceComplete,
        reason: pipelineReason,
        ...(cancellationReason ? { cancellationReason } : {}),
      },
      evidenceAuthority: {
        status: authority.status,
        reasons: [...authority.reasons].sort(),
      },
      findings,
      manual: { required: manualRequired, complete: 0, failedOrBlocked: 0 },
      visualReview: { items: audits.map(() => ({ status: 'absent' })) },
    },
    audits,
    outsideMode: compiler.outside,
  });
}
