import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunContract } from '../shared/run-contract.mjs';
import { disabledSingleSiteAdvisory, parseSingleSiteAdvisory } from '../shared/single-site-advisory.mjs';
import {
  canonicalJson as compilerCanonicalJson,
  canonicalSha256,
  verifyDefinitionCoverageManifest,
} from '../shared/run-compiler.mjs';
import { preflightQuitting7ohSite } from '../shared/site-preflight.mjs';
import { buildLiveRouteInventory } from '../shared/live-route-inventory.mjs';
import { startBrowserEgressProxy } from './lib/browser-egress-proxy.mjs';
import { createProcessTerminationController, spawnProcessGroupOptions } from './lib/subprocess-lifecycle.mjs';
import {
  reconcileSingleSiteRouteInventory,
  verifySingleSiteRouteInventoryPlan,
} from '../shared/single-site-route-plan.mjs';
import {
  claimJob,
  heartbeatJob,
  openJobQueue,
  publishAttemptDocument,
  readJob,
  readJobInput,
  settleJobAttempt,
  sha256,
  transitionJob,
  verifyJobCheckpoint,
} from './lib/job-queue.mjs';
import { compactPlaywrightResults } from './lib/playwright-results-compaction.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SECRET_DETECT_PATTERN = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{8,})/i;
const SECRET_REDACT_PATTERN = new RegExp(SECRET_DETECT_PATTERN.source, 'gi');
const MAX_LOG_EVENTS = 2_000;
const MAX_LOG_LINE = 4_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) fail('SINGLE_SITE_INPUT_INVALID', `${label} must be an object.`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length || missing.length) {
    fail('SINGLE_SITE_INPUT_INVALID', `${label} has invalid fields.`, { unknown, missing });
  }
}

function nonEmptyString(value, label, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail('SINGLE_SITE_INPUT_INVALID', `${label} must be a non-empty string no longer than ${max} characters.`);
  }
  if (SECRET_DETECT_PATTERN.test(value)) fail('SINGLE_SITE_INPUT_SECRET', `${label} appears to contain credential material.`);
  return value;
}

function digest(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('SINGLE_SITE_INPUT_INVALID', `${label} must be a lowercase SHA-256 digest${nullable ? ' or null' : ''}.`);
  }
  return value;
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    fail('SINGLE_SITE_INPUT_INVALID', `${label} must be a non-empty string array.`);
  }
  const normalized = value.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) fail('SINGLE_SITE_INPUT_INVALID', `${label} cannot contain duplicates.`);
  return normalized;
}

function normalizeCompilerDigest(value, label) {
  nonEmptyString(value, label, 80);
  const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return digest(normalized, label);
}

function assertSecretFree(value, label = 'worker input', depth = 0, counter = { count: 0 }) {
  counter.count += 1;
  if (depth > 64 || counter.count > 100_000) fail('SINGLE_SITE_INPUT_INVALID', `${label} exceeds structural limits.`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('SINGLE_SITE_INPUT_INVALID', `${label} contains a non-finite number.`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 1_048_576) fail('SINGLE_SITE_INPUT_INVALID', `${label} exceeds its string bound.`);
    if (SECRET_DETECT_PATTERN.test(value)) fail('SINGLE_SITE_INPUT_SECRET', `${label} appears to contain credential material.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretFree(item, `${label}[${index}]`, depth + 1, counter));
    return;
  }
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('SINGLE_SITE_INPUT_INVALID', `${label} contains a non-JSON value.`);
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer)$/i.test(key)
      && item !== null && item !== false && item !== '[REDACTED]') {
      fail('SINGLE_SITE_INPUT_SECRET', `${label}.${key} is a credential-bearing field.`);
    }
    assertSecretFree(item, `${label}.${key}`, depth + 1, counter);
  }
}

function authorityFromCompiler(value, label) {
  exactKeys(value, ['status', 'reasons'], label);
  if (!['authoritative', 'non-authoritative'].includes(value.status)) {
    fail('SINGLE_SITE_INPUT_INVALID', `${label}.status is invalid.`);
  }
  const reasons = Array.isArray(value.reasons) ? [...value.reasons] : null;
  if (!reasons || reasons.some((reason) => typeof reason !== 'string' || !reason)) {
    fail('SINGLE_SITE_INPUT_INVALID', `${label}.reasons must be a string array.`);
  }
  if (new Set(reasons).size !== reasons.length) fail('SINGLE_SITE_INPUT_INVALID', `${label}.reasons cannot contain duplicates.`);
  if ((value.status === 'authoritative') !== (reasons.length === 0)) {
    fail('SINGLE_SITE_INPUT_INVALID', `${label} status and reasons disagree.`);
  }
  return { authoritative: value.status === 'authoritative', reasons: reasons.sort() };
}

function assertLaunchCheckpoint(value) {
  exactKeys(value, ['preflightDigest', 'identityFingerprint', 'revisionFingerprint', 'evidenceAuthority'], 'launchCheckpoint');
  digest(value.preflightDigest, 'launchCheckpoint.preflightDigest');
  digest(value.identityFingerprint, 'launchCheckpoint.identityFingerprint');
  digest(value.revisionFingerprint, 'launchCheckpoint.revisionFingerprint', true);
  exactKeys(value.evidenceAuthority, ['authoritative', 'reasons'], 'launchCheckpoint.evidenceAuthority');
  if (typeof value.evidenceAuthority.authoritative !== 'boolean' || !Array.isArray(value.evidenceAuthority.reasons)) {
    fail('SINGLE_SITE_INPUT_INVALID', 'launchCheckpoint.evidenceAuthority is invalid.');
  }
  const reasons = value.evidenceAuthority.reasons.map((reason) => nonEmptyString(reason, 'authority reason', 256));
  if (new Set(reasons).size !== reasons.length) fail('SINGLE_SITE_INPUT_INVALID', 'Authority reasons cannot contain duplicates.');
  if (value.evidenceAuthority.authoritative !== (reasons.length === 0)) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Evidence authority status and reasons disagree.');
  }
  if (value.revisionFingerprint === null && value.evidenceAuthority.authoritative) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Missing deployment revision cannot produce authoritative evidence.');
  }
  return {
    preflightDigest: value.preflightDigest,
    identityFingerprint: value.identityFingerprint,
    revisionFingerprint: value.revisionFingerprint,
    evidenceAuthority: { authoritative: value.evidenceAuthority.authoritative, reasons: [...reasons].sort() },
  };
}

export function validateSingleSiteWorkerInput(rawInput) {
  const input = structuredClone(rawInput);
  if (isRecord(input) && !('advisory' in input)) input.advisory = disabledSingleSiteAdvisory();
  exactKeys(input, ['schemaVersion', 'kind', 'runContract', 'coverageManifest', 'routeInventoryPlan', 'launchCheckpoint', 'runnerRevision', 'advisory'], 'worker input');
  if (input.schemaVersion !== 1 || input.kind !== 'single-site-worker-input') {
    fail('SINGLE_SITE_INPUT_INVALID', 'Worker input must use schemaVersion 1 and kind single-site-worker-input.');
  }
  assertSecretFree(input);
  const runContract = parseRunContract(input.runContract);
  if (runContract.mode !== 'single-site') fail('SINGLE_SITE_INPUT_INVALID', 'Worker input requires a Single-site run contract.');
  if (!verifyDefinitionCoverageManifest(input.coverageManifest)) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Definition Coverage Manifest digest is invalid.');
  }
  const manifest = input.coverageManifest;
  if (manifest.mode !== 'single-site' || manifest.kind !== 'definition-coverage-manifest') {
    fail('SINGLE_SITE_INPUT_INVALID', 'Definition Coverage Manifest is not for Single-site execution.');
  }
  if (!verifySingleSiteRouteInventoryPlan(input.routeInventoryPlan)) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Single-site route inventory plan digest or shape is invalid.');
  }
  if (input.routeInventoryPlan.coverageManifestDigest !== input.coverageManifest.manifestDigest) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Single-site route inventory plan is not bound to this Coverage Manifest.');
  }
  const routeInventoryRequired = input.coverageManifest.scope.qualifier === 'FULL'
    || input.coverageManifest.selectedDefinitions?.some(({ auditId }) => auditId === 'ENV-002');
  if (input.routeInventoryPlan.required !== routeInventoryRequired) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Single-site route inventory plan requirement disagrees with compiled route coverage.');
  }
  if (!isRecord(manifest.deployment) || !isRecord(manifest.revisions) || !isRecord(manifest.scope)) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Definition Coverage Manifest lacks deployment, revision, or scope bindings.');
  }
  if (manifest.deployment.url !== runContract.url
    || manifest.deployment.deploymentRole !== runContract.deploymentRole
    || manifest.deployment.certificatePolicy !== runContract.certificatePolicy) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Coverage deployment does not match the run contract.');
  }
  if (manifest.revisions.runContract !== canonicalSha256(runContract)) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Coverage Manifest is not bound to this normalized run contract.');
  }
  nonEmptyString(input.runnerRevision, 'runnerRevision', 256);
  if (manifest.revisions.runner !== input.runnerRevision) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Coverage Manifest runner revision does not match worker input.');
  }
  nonEmptyString(manifest.revisions.pluginRegistry, 'coverageManifest.revisions.pluginRegistry', 256);
  nonEmptyString(manifest.revisions.targetRegistry, 'coverageManifest.revisions.targetRegistry', 256);
  const selectedTargetIds = uniqueStrings(manifest.scope.selectedTargetIds, 'coverageManifest.scope.selectedTargetIds');
  if (compilerCanonicalJson([...selectedTargetIds].sort()) !== compilerCanonicalJson([...runContract.targetIds].sort())) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Coverage target selection does not match the run contract.');
  }
  if (!Array.isArray(manifest.executions) || manifest.executions.length === 0) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Coverage Manifest must contain executable Single-site cases.');
  }
  const caseIds = [...new Set(manifest.executions.map((execution, index) => {
    if (!isRecord(execution)) fail('SINGLE_SITE_INPUT_INVALID', `coverageManifest.executions[${index}] is invalid.`);
    nonEmptyString(execution.caseId, `coverageManifest.executions[${index}].caseId`, 256);
    nonEmptyString(execution.targetId, `coverageManifest.executions[${index}].targetId`, 128);
    if (!selectedTargetIds.includes(execution.targetId)) {
      fail('SINGLE_SITE_INPUT_INVALID', `Execution references unselected target ${execution.targetId}.`);
    }
    return execution.caseId;
  }))].sort();
  const checkpoint = assertLaunchCheckpoint(input.launchCheckpoint);
  let advisory;
  try {
    advisory = parseSingleSiteAdvisory(input.advisory);
  } catch (error) {
    fail('SINGLE_SITE_INPUT_INVALID', error instanceof Error ? error.message : String(error));
  }
  if (checkpoint.identityFingerprint !== manifest.deployment.identityFingerprint) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Launch identity fingerprint does not match coverage deployment.');
  }
  if (!isRecord(manifest.deployment.revision)
    || !['identified', 'unavailable'].includes(manifest.deployment.revision.status)
    || manifest.deployment.revision.value !== checkpoint.revisionFingerprint) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Launch deployment revision does not match coverage deployment.');
  }
  const manifestAuthority = authorityFromCompiler(manifest.deployment.evidenceAuthority, 'coverageManifest.deployment.evidenceAuthority');
  if (compilerCanonicalJson(manifestAuthority) !== compilerCanonicalJson(checkpoint.evidenceAuthority)) {
    fail('SINGLE_SITE_INPUT_INVALID', 'Launch evidence authority does not match coverage deployment.');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'single-site-worker-input',
    runContract,
    coverageManifest: manifest,
    routeInventoryPlan: input.routeInventoryPlan,
    launchCheckpoint: checkpoint,
    advisory,
    runnerRevision: input.runnerRevision,
    selectedCaseIds: Object.freeze(caseIds),
    selectedTargetIds: Object.freeze([...selectedTargetIds].sort()),
  });
}

export function queueSubmissionForWorkerInput(rawInput, { idempotencyKey, stageDeadlines }) {
  const input = validateSingleSiteWorkerInput(rawInput);
  nonEmptyString(idempotencyKey, 'idempotencyKey', 256);
  if (!isRecord(stageDeadlines)) fail('SINGLE_SITE_INPUT_INVALID', 'stageDeadlines must be an object.');
  return {
    idempotencyKey,
    runMode: 'single-site',
    inputDocumentDigest: sha256(rawInput),
    runContractDigest: sha256(input.runContract),
    compiledManifestDigest: normalizeCompilerDigest(input.coverageManifest.manifestDigest, 'coverageManifest.manifestDigest'),
    preflightDigest: input.launchCheckpoint.preflightDigest,
    identityFingerprint: input.launchCheckpoint.identityFingerprint,
    revisionFingerprint: input.launchCheckpoint.revisionFingerprint,
    evidenceAuthority: structuredClone(input.launchCheckpoint.evidenceAuthority),
    registryRevision: input.coverageManifest.revisions.pluginRegistry,
    targetSetRevision: input.coverageManifest.revisions.targetRegistry,
    runnerRevision: input.runnerRevision,
    stageDeadlines: structuredClone(stageDeadlines),
  };
}

export function assertWorkerInputBoundToState(rawInput, state) {
  const input = validateSingleSiteWorkerInput(rawInput);
  const expected = queueSubmissionForWorkerInput(rawInput, {
    idempotencyKey: 'binding-check-only',
    stageDeadlines: state.stageDeadlines,
  });
  const comparisons = [
    ['inputDocumentDigest', expected.inputDocumentDigest, state.inputDocumentDigest],
    ['runContractDigest', expected.runContractDigest, state.runContractDigest],
    ['compiledManifestDigest', expected.compiledManifestDigest, state.compiledManifestDigest],
    ['preflightDigest', expected.preflightDigest, state.preflightDigest],
    ['identityFingerprint', expected.identityFingerprint, state.identityFingerprint],
    ['revisionFingerprint', expected.revisionFingerprint, state.revisionFingerprint],
    ['registryRevision', expected.registryRevision, state.registryRevision],
    ['targetSetRevision', expected.targetSetRevision, state.targetSetRevision],
    ['runnerRevision', expected.runnerRevision, state.runnerRevision],
  ];
  const mismatches = comparisons.filter(([, expectedValue, actualValue]) => expectedValue !== actualValue).map(([field]) => field);
  if (compilerCanonicalJson(expected.evidenceAuthority) !== compilerCanonicalJson(state.evidenceAuthority)) mismatches.push('evidenceAuthority');
  if (mismatches.length) fail('SINGLE_SITE_INPUT_BINDING_MISMATCH', 'Worker input does not match its durable job envelope.', { mismatches });
  return input;
}

function redactText(value) {
  return String(value)
    .replace(SECRET_REDACT_PATTERN, '[REDACTED]')
    .replace(/([?&](?:token|key|signature|auth)=)[^&#\s]+/gi, '$1[REDACTED]')
    .slice(0, MAX_LOG_LINE);
}

function safeLogValue(value, depth = 0) {
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeLogValue(item, depth + 1));
  if (isRecord(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      output[key] = /^(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer)$/i.test(key)
        ? '[REDACTED]'
        : safeLogValue(item, depth + 1);
    }
    return output;
  }
  return redactText(value);
}

export function createWorkerLogger({
  jobId,
  claim,
  clock = () => new Date(),
  stream = process.stdout,
  persistPath = null,
  appendFile = fs.appendFile,
}) {
  const events = [];
  let sequence = 0;
  let dropped = 0;
  let persistence = Promise.resolve();
  let persistenceError = null;
  return {
    emit(event, detail = {}) {
      const record = {
        schemaVersion: 1,
        sequence: ++sequence,
        at: clock().toISOString(),
        jobId,
        attemptId: claim.attemptId,
        attemptNumber: claim.attemptNumber,
        fencingToken: claim.fencingToken,
        event,
        detail: safeLogValue(detail),
      };
      if (events.length < MAX_LOG_EVENTS) events.push(record);
      else dropped += 1;
      const line = `${JSON.stringify(record)}\n`;
      stream.write(line);
      if (persistPath !== null) {
        persistence = persistence
          .then(() => appendFile(persistPath, line, { encoding: 'utf8', mode: 0o600 }))
          .catch((error) => { persistenceError ??= error; });
      }
      return record;
    },
    async flush() {
      await persistence;
      if (persistenceError) {
        fail('SINGLE_SITE_LOG_PERSISTENCE_FAILED', `Durable worker logging failed: ${persistenceError.message}`);
      }
    },
    snapshot() {
      return { events: structuredClone(events), droppedEvents: dropped };
    },
  };
}

export function startHeartbeatPump(queue, claim, {
  heartbeat = heartbeatJob,
  intervalMs = queue.heartbeatMs,
  onFatal = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let stopped = false;
  let timer = null;
  let inFlight = null;
  let fatalError = null;
  const tick = () => {
    if (stopped) return;
    inFlight = Promise.resolve(heartbeat(queue, claim, { activityState: 'normal' }))
      .catch((error) => {
        fatalError = error;
        stopped = true;
        onFatal(error);
      })
      .finally(() => {
        inFlight = null;
        if (!stopped) timer = setTimer(tick, intervalMs);
      });
  };
  timer = setTimer(tick, intervalMs);
  return {
    get fatalError() { return fatalError; },
    async stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      await inFlight;
      return fatalError;
    },
  };
}

export async function runPlaywrightCommand({
  executable,
  args,
  environment,
  logger,
  signal,
  cwd = repositoryRoot,
  terminationGraceMs = 3_000,
  killSettleMs = 1_000,
}) {
  logger.emit('command-started', {
    command: ['playwright', ...args],
    cwd,
    environment: {
      AUDIT_RUN_MODE: environment.AUDIT_RUN_MODE,
      AUDIT_SINGLE_SITE_URL: environment.AUDIT_SINGLE_SITE_URL,
      AUDIT_SINGLE_SITE_ROLE: environment.AUDIT_SINGLE_SITE_ROLE,
      AUDIT_SINGLE_SITE_CERTIFICATE_POLICY: environment.AUDIT_SINGLE_SITE_CERTIFICATE_POLICY,
      AUDIT_TARGET_IDS: environment.AUDIT_TARGET_IDS,
      selectedCaseCount: JSON.parse(environment.AUDIT_SINGLE_SITE_CASE_IDS).length,
      AUDIT_ARTIFACT_DIR: environment.AUDIT_ARTIFACT_DIR,
    },
  });
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    let settled = false;
    let spawnError = null;
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnProcessGroupOptions(),
    });
    let termination;
    const finish = (exitCode, closeSignal, unresponsive = false) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      termination?.clear();
      const result = {
        exitCode,
        signal: closeSignal,
        spawnError,
        durationMs: Date.now() - startedAt,
        aborted: termination?.requested === true,
        forceKilled: termination?.forceKilled === true,
        terminationReason: termination?.reason ?? null,
        unresponsive,
      };
      logger.emit('command-finished', result);
      resolve(result);
    };
    termination = createProcessTerminationController(child, {
      terminationGraceMs,
      killSettleMs,
      onTerminate: (detail) => logger.emit('command-abort-requested', detail),
      onForceKill: (detail) => logger.emit('command-force-kill-requested', detail),
      onUnresponsive: () => finish(null, 'SIGKILL', true),
    });
    const relay = (stream, channel) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        lines.forEach((line) => logger.emit('command-output', { channel, line }));
      });
      stream.on('end', () => {
        if (buffer) logger.emit('command-output', { channel, line: buffer });
      });
    };
    relay(child.stdout, 'stdout');
    relay(child.stderr, 'stderr');
    const abort = () => {
      termination.terminate(signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason ?? 'aborted'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      spawnError = error.message;
      logger.emit('command-spawn-error', { message: error.message, code: error.code ?? null });
    });
    child.once('close', (exitCode, closeSignal) => {
      finish(exitCode, closeSignal);
    });
  });
}

export async function inspectFreshPlaywrightEvidence(artifactRoot, commandStartedAt, options = {}) {
  const resultsPath = path.join(artifactRoot, 'results.json');
  let stat;
  try {
    stat = await fs.lstat(resultsPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { fresh: false, reason: 'results.json was not published', relativePath: 'results.json', bytes: 0, digest: null };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    return { fresh: false, reason: 'results.json is empty or unsafe', relativePath: 'results.json', bytes: stat.size, digest: null };
  }
  if (stat.mtimeMs < commandStartedAt - 1_000) {
    return { fresh: false, reason: 'results.json predates this attempt', relativePath: 'results.json', bytes: stat.size, digest: null };
  }
  try {
    const compacted = await compactPlaywrightResults({
      artifactRoot,
      resultsPath,
      ...(options.compactionLimits ? { limits: options.compactionLimits } : {}),
    });
    return {
      fresh: true,
      reason: null,
      relativePath: 'results.json',
      bytes: compacted.resultsBytes.length,
      digest: compacted.resultsDigest,
      sourceBytes: compacted.sourceResultsBytes,
      sourceDigest: compacted.sourceResultsDigest,
      compacted: compacted.compacted,
      structuredEvidence: {
        relativePath: compacted.manifestRelativePath,
        bytes: compacted.manifestBytes.length,
        digest: sha256(compacted.manifestBytes),
        manifestDigest: compacted.manifest.manifestDigest,
        itemCount: compacted.manifest.items.length,
        totalBytes: compacted.manifest.structuredSidecarBytes,
      },
    };
  } catch (error) {
    return {
      fresh: false,
      reason: `results.json compaction rejected evidence: ${error?.code ?? 'RESULTS_INVALID'} ${redactText(error?.message ?? error)}`,
      relativePath: 'results.json',
      bytes: stat.size,
      digest: null,
    };
  }
}

async function prepareAttemptArtifactRoot(queue, claim) {
  const attemptRoot = path.join(queue.root, 'jobs', claim.jobId, 'attempts', claim.attemptId);
  const artifactRoot = attemptArtifactRoot(queue, claim);
  await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const [attemptStat, artifactStat, realAttempt, realArtifact] = await Promise.all([
    fs.lstat(attemptRoot),
    fs.lstat(artifactRoot),
    fs.realpath(attemptRoot),
    fs.realpath(artifactRoot),
  ]);
  if (!attemptStat.isDirectory() || attemptStat.isSymbolicLink()
    || !artifactStat.isDirectory() || artifactStat.isSymbolicLink()
    || (realArtifact !== realAttempt && !realArtifact.startsWith(`${realAttempt}${path.sep}`))) {
    fail('SINGLE_SITE_ARTIFACT_ROOT_UNSAFE', 'Attempt artifact root escaped its real fenced attempt directory.');
  }
  return artifactRoot;
}

async function prepareAttemptLogPath(queue, claim) {
  const attemptRoot = path.join(queue.root, 'jobs', claim.jobId, 'attempts', claim.attemptId);
  const logDirectory = path.join(attemptRoot, 'work', 'logs');
  const logPath = path.join(logDirectory, 'worker.ndjson');
  await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const [directoryStat, realAttempt, realDirectory] = await Promise.all([
    fs.lstat(logDirectory),
    fs.realpath(attemptRoot),
    fs.realpath(logDirectory),
  ]);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (realDirectory !== realAttempt && !realDirectory.startsWith(`${realAttempt}${path.sep}`))) {
    fail('SINGLE_SITE_LOG_ROOT_UNSAFE', 'Attempt log root escaped its real fenced attempt directory.');
  }
  const existing = await fs.lstat(logPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) fail('SINGLE_SITE_LOG_ROOT_UNSAFE', 'Attempt log path already exists before the fenced worker starts.');
  return logPath;
}

function startDeadlineTimer(deadline, controller, {
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let stopped = false;
  const tick = () => {
    if (stopped || controller.signal.aborted) return;
    const remaining = deadline - now();
    if (remaining <= 0) {
      const error = new Error('Browser stage deadline expired.');
      error.code = 'SINGLE_SITE_STAGE_DEADLINE';
      controller.abort(error);
      return;
    }
    timer = setTimer(tick, Math.min(remaining, 2_147_483_647));
  };
  tick();
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
  };
}

async function currentRuntimeRevisions(input, { pluginRegistryPath, targetRegistryPath, runnerRevision }) {
  const [pluginRegistry, targetRegistry] = await Promise.all([
    fs.readFile(pluginRegistryPath, 'utf8').then(JSON.parse),
    fs.readFile(targetRegistryPath, 'utf8').then(JSON.parse),
  ]);
  return {
    registryRevision: canonicalSha256(pluginRegistry),
    targetSetRevision: canonicalSha256(targetRegistry),
    runnerRevision: nonEmptyString(runnerRevision, 'AUDIT_RUNNER_REVISION', 256),
    compiledManifestDigest: normalizeCompilerDigest(input.coverageManifest.manifestDigest, 'coverageManifest.manifestDigest'),
  };
}

export function preflightOptions(environment) {
  const previewBypassOrigins = String(environment.AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    previewBypassOrigins,
    ...(previewBypassOrigins.length > 0 ? { tlsBypassRequestOptions: { rejectUnauthorized: false } } : {}),
  };
}

function logPreflight(logger, result) {
  logger.emit('preflight-finished', {
    accepted: result.accepted,
    origin: result.origin,
    deploymentRole: result.deploymentRole,
    certificatePolicy: result.certificatePolicy,
    evidenceAuthority: result.evidenceAuthority,
    identityFingerprint: result.identityFingerprint,
    revisionStatus: result.deploymentRevision.status,
    revisionFingerprint: result.deploymentRevision.fingerprint,
    preflightDigest: result.preflightDigest,
  });
  for (const probe of result.probes) {
    logger.emit('request-outcome', {
      probe: probe.id,
      requestedUrl: probe.requestedUrl,
      finalUrl: probe.finalUrl,
      responseCode: probe.statusCode,
      contentType: probe.contentType,
      etag: probe.etag,
      lastModified: probe.lastModified,
      error: probe.error ? { code: probe.error.code, message: probe.error.message } : null,
      hops: probe.hops.map((hop) => ({
        url: hop.url,
        responseCode: hop.statusCode,
        resolvedAddresses: hop.resolvedAddresses,
        connectedAddress: hop.connectedAddress,
        location: hop.location,
      })),
    });
  }
  for (const marker of result.markers) {
    logger.emit('identity-marker', { id: marker.id, probe: marker.probe, passed: marker.passed });
  }
  for (const issue of result.issues) {
    logger.emit('preflight-issue', { code: issue.code, focusTarget: issue.focusTarget, message: issue.message });
  }
}

function attemptArtifactRoot(queue, claim) {
  return path.join(queue.root, 'jobs', claim.jobId, 'attempts', claim.attemptId, 'work', 'artifacts');
}

function safeProxyValue(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.username || parsed.password ? null : value;
  } catch {
    return null;
  }
}

export function playwrightEnvironment(baseEnvironment, input, artifactRoot) {
  const inherited = {};
  for (const name of [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP',
    'LANG', 'LC_ALL', 'TZ', 'CI',
    'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'AUDIT_MSEDGE_AVAILABLE', 'AUDIT_WORKERS', 'AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST',
  ]) {
    if (typeof baseEnvironment[name] === 'string') inherited[name] = baseEnvironment[name];
  }
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const safe = name === 'NO_PROXY' ? baseEnvironment[name] : safeProxyValue(baseEnvironment[name]);
    if (safe) inherited[name] = safe;
  }
  return {
    ...inherited,
    AUDIT_RUN_MODE: 'single-site',
    AUDIT_SINGLE_SITE_URL: input.runContract.url,
    AUDIT_SINGLE_SITE_ROLE: input.runContract.deploymentRole,
    AUDIT_SINGLE_SITE_CERTIFICATE_POLICY: input.runContract.certificatePolicy,
    AUDIT_RUNNER_REVISION: input.runnerRevision,
    AUDIT_TARGET_IDS: input.selectedTargetIds.join(','),
    AUDIT_SINGLE_SITE_CASE_IDS: JSON.stringify(input.selectedCaseIds),
    AUDIT_ARTIFACT_DIR: artifactRoot,
    AUDIT_PROFILE: 'release',
    ...(input.routeInventoryPublicationPath ? {
      AUDIT_SINGLE_SITE_ROUTE_INVENTORY: input.routeInventoryPublicationPath,
      AUDIT_SINGLE_SITE_GENERIC_TARGET_ID: input.routeInventoryPublication?.genericExecutions?.length
        ? input.routeInventoryPlan.canonicalTargetId
        : '',
    } : {}),
  };
}

function routeInventoryOutboundOptions(runContract, environment, dependencies) {
  if (dependencies.routeInventoryOutbound) return dependencies.routeInventoryOutbound;
  const tls = preflightOptions(environment);
  return {
    deploymentRole: runContract.deploymentRole,
    certificatePolicy: runContract.certificatePolicy,
    ...tls,
    timeoutMs: 10_000,
    maxBodyBytes: 2 * 1_048_576,
    maxRedirects: 4,
  };
}

async function publishLiveRouteInventory({ queue, claim, input, environment, dependencies, logger }) {
  if (!input.routeInventoryPlan.required) {
    logger.emit('route-inventory-omitted', { reason: input.routeInventoryPlan.reason });
    return { publication: null, path: null, queuePublication: null };
  }
  logger.emit('route-inventory-started', {
    reviewedRoutes: input.routeInventoryPlan.reviewedRoutes.length,
    entryPoints: input.routeInventoryPlan.entryPoints,
    canonicalTargetId: input.routeInventoryPlan.canonicalTargetId,
  });
  const diagnostic = await (dependencies.buildRouteInventory ?? buildLiveRouteInventory)({
    origin: input.runContract.url,
    catalogRoutes: input.routeInventoryPlan.reviewedRoutes.map(({ path: routePath }) => routePath),
    ...(dependencies.deploymentRoutes === undefined ? {} : { deploymentRoutes: dependencies.deploymentRoutes }),
    entryPoints: input.routeInventoryPlan.entryPoints,
    outbound: routeInventoryOutboundOptions(input.runContract, environment, dependencies),
    ...(dependencies.routeInventoryLimits ? { limits: dependencies.routeInventoryLimits } : {}),
    ...(dependencies.routeCrawlLimits ? { routeInventoryLimits: dependencies.routeCrawlLimits } : {}),
    ...(dependencies.routeInventoryClock ? { now: dependencies.routeInventoryClock } : {}),
  });
  const publication = reconcileSingleSiteRouteInventory({
    jobId: claim.jobId,
    attemptId: claim.attemptId,
    coverageManifestDigest: input.coverageManifest.manifestDigest,
    plan: input.routeInventoryPlan,
    diagnostic,
  });
  const queuePublication = await publishAttemptDocument(queue, claim, {
    publicationId: `attempt-${claim.attemptNumber}-route-inventory`,
    relativePath: 'worker/route-inventory.json',
    document: publication,
  });
  const publicationPath = path.join(
    queue.root,
    'jobs',
    claim.jobId,
    'attempts',
    claim.attemptId,
    'published',
    'worker',
    'route-inventory.json',
  );
  logger.emit('route-inventory-finished', {
    inventoryDigest: publication.inventoryDigest,
    publicationDigest: publication.publicationDigest,
    routes: publication.diagnostic.inventory.summary.routes,
    genericExecutions: publication.genericExecutions.length,
    reviewedFindings: publication.reviewedFindings.length,
    coverageGaps: publication.coverageGaps.length,
    limitations: publication.limitations.length,
  });
  return { publication, path: publicationPath, queuePublication };
}

function resultClassification(command, evidence, heartbeatError, abortReason = null) {
  if (heartbeatError) return { kind: 'infrastructure-failure', reason: `Heartbeat failed: ${heartbeatError.message}` };
  if (abortReason) return { kind: 'infrastructure-failure', reason: `Playwright execution was aborted: ${abortReason instanceof Error ? abortReason.message : String(abortReason)}` };
  if (command.signal) return { kind: 'infrastructure-failure', reason: `Playwright was terminated by ${command.signal}.` };
  if (command.spawnError) return { kind: 'infrastructure-failure', reason: `Playwright could not start: ${command.spawnError}` };
  if (![0, 1].includes(command.exitCode)) return { kind: 'infrastructure-failure', reason: `Playwright exited abnormally with code ${command.exitCode ?? 'unknown'}.` };
  if (!evidence.fresh) return { kind: 'infrastructure-failure', reason: `Playwright did not publish fresh structured evidence: ${evidence.reason}.` };
  return command.exitCode === 0
    ? { kind: 'success', reason: null }
    : { kind: 'assertion-failure', reason: 'Playwright exit 1 with fresh structured evidence.' };
}

export async function executeSingleSiteWorker({
  queue,
  jobId,
  workerId,
  environment = process.env,
  signal = undefined,
  dependencies = {},
}) {
  const stateBeforeClaim = await readJob(queue, jobId);
  const rawInput = await (dependencies.readInput ?? readJobInput)(queue, jobId);
  const input = assertWorkerInputBoundToState(rawInput, stateBeforeClaim);
  const claim = await (dependencies.claim ?? claimJob)(queue, jobId, workerId);
  const durableLogPath = dependencies.logPersistPath === false
    ? null
    : dependencies.logPersistPath ?? await prepareAttemptLogPath(queue, claim);
  const logger = createWorkerLogger({
    jobId,
    claim,
    clock: dependencies.logClock,
    stream: dependencies.logStream,
    persistPath: durableLogPath,
    appendFile: dependencies.appendLogFile,
  });
  const heartbeatAbort = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, heartbeatAbort.signal]) : heartbeatAbort.signal;
  const heartbeatPump = startHeartbeatPump(queue, claim, {
    heartbeat: dependencies.heartbeat,
    intervalMs: dependencies.heartbeatIntervalMs ?? queue.heartbeatMs,
    onFatal: (error) => {
      logger.emit('heartbeat-failed', { code: error.code ?? null, message: error.message });
      heartbeatAbort.abort(error);
    },
  });
  let artifactRoot = attemptArtifactRoot(queue, claim);
  let deadlineTimer = null;
  let egressProxy = null;
  try {
    artifactRoot = await prepareAttemptArtifactRoot(queue, claim);
    logger.emit('worker-claimed', {
      leaseMs: queue.leaseMs,
      heartbeatMs: queue.heartbeatMs,
      artifactRoot,
      selectedTargets: input.selectedTargetIds,
      selectedCaseCount: input.selectedCaseIds.length,
      evidenceAuthority: input.launchCheckpoint.evidenceAuthority,
    });
    logger.emit('preflight-started', {
      origin: input.runContract.url,
      deploymentRole: input.runContract.deploymentRole,
      certificatePolicy: input.runContract.certificatePolicy,
    });
    const preflight = await (dependencies.preflight ?? preflightQuitting7ohSite)({
      url: input.runContract.url,
      deploymentRole: input.runContract.deploymentRole,
      certificatePolicy: input.runContract.certificatePolicy,
    }, dependencies.preflightOptions ?? preflightOptions(environment));
    logPreflight(logger, preflight);
    if (!preflight.accepted || !preflight.identityFingerprint || !preflight.preflightDigest) {
      await heartbeatPump.stop();
      const diagnostic = {
        schemaVersion: 1,
        kind: 'single-site-worker-result',
        jobId,
        attemptId: claim.attemptId,
        attemptNumber: claim.attemptNumber,
        fencingToken: claim.fencingToken,
        classification: 'incomplete',
        reason: 'Required worker-start identity preflight was rejected.',
        command: null,
        freshEvidence: null,
        artifactRoot: path.relative(path.join(queue.root, 'jobs', jobId), artifactRoot),
        log: logger.snapshot(),
      };
      await logger.flush();
      await publishAttemptDocument(queue, claim, {
        publicationId: `attempt-${claim.attemptNumber}-worker-result`,
        relativePath: 'worker/attempt-result.json',
        document: diagnostic,
      });
      const state = await settleJobAttempt(queue, claim, { kind: 'incomplete', reason: diagnostic.reason });
      return { claim, input, state, result: diagnostic };
    }

    const revisions = await (dependencies.runtimeRevisions ?? currentRuntimeRevisions)(input, {
      pluginRegistryPath: path.join(repositoryRoot, 'audit', 'plugins.generated.json'),
      targetRegistryPath: path.join(repositoryRoot, 'audit', 'targets.generated.json'),
      runnerRevision: environment.AUDIT_RUNNER_REVISION,
    });
    await logger.flush();
    await publishAttemptDocument(queue, claim, {
      publicationId: `attempt-${claim.attemptNumber}-checkpoint`,
      relativePath: 'worker/checkpoint.json',
      document: {
        schemaVersion: 1,
        kind: 'single-site-worker-checkpoint',
        jobId,
        attemptId: claim.attemptId,
        attemptNumber: claim.attemptNumber,
        fencingToken: claim.fencingToken,
        observed: {
          identityFingerprint: preflight.identityFingerprint,
          revisionFingerprint: preflight.deploymentRevision.fingerprint,
          preflightDigest: preflight.preflightDigest,
          ...revisions,
        },
        requestOutcomes: preflight.probes.map((probe) => ({
          id: probe.id,
          finalUrl: probe.finalUrl,
          responseCode: probe.statusCode,
          contentType: probe.contentType,
          hopCount: probe.hops.length,
          errorCode: probe.error?.code ?? null,
        })),
        log: logger.snapshot(),
      },
    });
    try {
      await verifyJobCheckpoint(queue, claim, {
        identityFingerprint: preflight.identityFingerprint,
        revisionFingerprint: preflight.deploymentRevision.fingerprint,
        preflightDigest: preflight.preflightDigest,
        compiledManifestDigest: revisions.compiledManifestDigest,
        registryRevision: revisions.registryRevision,
        targetSetRevision: revisions.targetSetRevision,
        runnerRevision: revisions.runnerRevision,
      });
    } catch (error) {
      if (error?.code === 'QUEUE_CHECKPOINT_CHANGED') {
        await heartbeatPump.stop();
        logger.emit('checkpoint-fenced', { code: error.code, message: error.message, details: error.details });
        await logger.flush();
        return { claim, input, state: await readJob(queue, jobId), result: null };
      }
      throw error;
    }
    logger.emit('checkpoint-verified', revisions);
    const routeInventory = await publishLiveRouteInventory({
      queue,
      claim,
      input,
      environment,
      dependencies,
      logger,
    });
    await transitionJob(queue, claim, 'running', { message: 'Worker-start preflight and runtime revisions matched the immutable launch input.' });

    const commandStartedAt = Date.now();
    const executable = dependencies.playwrightExecutable
      ?? path.join(repositoryRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    const args = ['test'];
    const commandInput = {
      ...input,
      routeInventoryPublication: routeInventory.publication,
      routeInventoryPublicationPath: routeInventory.path,
    };
    egressProxy = await (dependencies.startEgressProxy ?? startBrowserEgressProxy)({
      lookup: dependencies.browserEgressLookup,
      logger,
    });
    if (!egressProxy || typeof egressProxy.url !== 'string' || typeof egressProxy.close !== 'function') {
      fail('SINGLE_SITE_BROWSER_EGRESS_UNAVAILABLE', 'Single-site browser egress enforcement could not be started.');
    }
    const commandEnvironment = {
      ...playwrightEnvironment(environment, commandInput, artifactRoot),
      AUDIT_SINGLE_SITE_EGRESS_PROXY: egressProxy.url,
    };
    const deadlineAbort = new AbortController();
    const browserDeadline = Date.parse(stateBeforeClaim.stageDeadlines.browser ?? '');
    deadlineTimer = Number.isFinite(browserDeadline)
      ? startDeadlineTimer(browserDeadline, deadlineAbort)
      : null;
    const commandSignal = AbortSignal.any([combinedSignal, deadlineAbort.signal]);
    const command = await (dependencies.runCommand ?? runPlaywrightCommand)({
      executable,
      args,
      environment: commandEnvironment,
      logger,
      signal: commandSignal,
      cwd: repositoryRoot,
      artifactRoot,
    });
    if (deadlineTimer !== null) {
      deadlineTimer();
      deadlineTimer = null;
    }
    const freshEvidence = await (dependencies.inspectEvidence ?? inspectFreshPlaywrightEvidence)(artifactRoot, commandStartedAt);
    logger.emit('evidence-inspected', freshEvidence);
    const heartbeatError = await heartbeatPump.stop();
    const classification = resultClassification(
      command,
      freshEvidence,
      heartbeatError,
      commandSignal.aborted ? commandSignal.reason : null,
    );
    const workerResult = {
      schemaVersion: 1,
      kind: 'single-site-worker-result',
      jobId,
      attemptId: claim.attemptId,
      attemptNumber: claim.attemptNumber,
      fencingToken: claim.fencingToken,
      classification: classification.kind,
      reason: classification.reason,
      command: {
        executable: 'playwright',
        args,
        exitCode: command.exitCode,
        signal: command.signal,
        spawnError: command.spawnError,
        durationMs: command.durationMs,
        aborted: command.aborted === true,
        forceKilled: command.forceKilled === true,
        terminationReason: command.terminationReason ?? null,
      },
      freshEvidence,
      routeInventory: routeInventory.publication ? {
        publicationId: routeInventory.queuePublication.publicationId,
        relativePath: routeInventory.queuePublication.relativePath,
        queueDigest: routeInventory.queuePublication.digest,
        inventoryDigest: routeInventory.publication.inventoryDigest,
        publicationDigest: routeInventory.publication.publicationDigest,
        genericExecutionCount: routeInventory.publication.genericExecutions.length,
        reviewedFindingCount: routeInventory.publication.reviewedFindings.length,
        coverageGapCount: routeInventory.publication.coverageGaps.length,
        limitationCount: routeInventory.publication.limitations.length,
      } : null,
      artifactRoot: path.relative(path.join(queue.root, 'jobs', jobId), artifactRoot),
      log: logger.snapshot(),
    };
    await logger.flush();
    await publishAttemptDocument(queue, claim, {
      publicationId: `attempt-${claim.attemptNumber}-worker-result`,
      relativePath: 'worker/attempt-result.json',
      document: workerResult,
    });
    const state = await settleJobAttempt(queue, claim, classification);
    return { claim, input, state, result: workerResult, commandEnvironment };
  } catch (error) {
    if (deadlineTimer !== null) deadlineTimer();
    await heartbeatPump.stop();
    if (['QUEUE_STALE_FENCE', 'QUEUE_LEASE_EXPIRED', 'QUEUE_TERMINAL'].includes(error?.code)) throw error;
    logger.emit('worker-infrastructure-error', { code: error.code ?? null, message: error.message });
    let current;
    try {
      current = await readJob(queue, jobId);
    } catch {
      throw error;
    }
    if (current.attemptId !== claim.attemptId || current.fencingToken !== claim.fencingToken || current.lease === null) throw error;
    const fallback = {
      schemaVersion: 1,
      kind: 'single-site-worker-result',
      jobId,
      attemptId: claim.attemptId,
      attemptNumber: claim.attemptNumber,
      fencingToken: claim.fencingToken,
      classification: 'infrastructure-failure',
      reason: redactText(error.message),
      command: null,
      freshEvidence: null,
      artifactRoot: path.relative(path.join(queue.root, 'jobs', jobId), artifactRoot),
      log: logger.snapshot(),
    };
    await logger.flush();
    await publishAttemptDocument(queue, claim, {
      publicationId: `attempt-${claim.attemptNumber}-worker-result`,
      relativePath: 'worker/attempt-result.json',
      document: fallback,
    });
    const state = await settleJobAttempt(queue, claim, { kind: 'infrastructure-failure', reason: fallback.reason });
    return { claim, input, state, result: fallback };
  } finally {
    if (egressProxy !== null) {
      try {
        await egressProxy.close();
      } catch (error) {
        logger.emit('browser-egress-proxy-stop-failed', { code: error?.code ?? null, message: redactText(error?.message ?? error) });
      }
    }
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--queue-root', '--job', '--worker'].includes(flag) || !value) {
      fail('SINGLE_SITE_WORKER_USAGE', 'Usage: node scripts/run-single-site-worker.mjs --queue-root <path> --job <job-id> --worker <worker-id>');
    }
    values.set(flag, value);
  }
  return {
    queueRoot: values.get('--queue-root') ?? process.env.AUDIT_JOB_QUEUE_ROOT,
    jobId: values.get('--job'),
    workerId: values.get('--worker') ?? `worker-${process.pid}`,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options.queueRoot || !options.jobId) fail('SINGLE_SITE_WORKER_USAGE', 'Queue root and job ID are required.');
  const queue = await openJobQueue({ root: options.queueRoot });
  const controller = new AbortController();
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((name) => [name, () => {
    const error = new Error(`Worker received ${name}.`);
    error.code = 'SINGLE_SITE_WORKER_SIGNAL';
    controller.abort(error);
  }]));
  for (const [name, handler] of handlers) process.once(name, handler);
  let result;
  try {
    result = await executeSingleSiteWorker({
      queue,
      jobId: options.jobId,
      workerId: options.workerId,
      signal: controller.signal,
    });
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
  process.stdout.write(`${JSON.stringify({
    event: 'worker-settled',
    jobId: options.jobId,
    attemptNumber: result.claim.attemptNumber,
    fencingToken: result.claim.fencingToken,
    executionState: result.state.executionState,
    result: result.state.result,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'worker-fatal', code: error.code ?? 'WORKER_FATAL', message: redactText(error.message) })}\n`);
    process.exitCode = 1;
  });
}
