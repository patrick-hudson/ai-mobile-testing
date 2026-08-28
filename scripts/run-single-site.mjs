import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openJobQueue, submitJob } from './lib/job-queue.mjs';
import { createSingleSiteLaunchCoordinator } from '../portal/single-site-launch.mjs';
import { preflightQuitting7ohSite } from '../shared/site-preflight.mjs';
import { resolveRunnerRevision } from '../shared/runner-revision.mjs';
import {
  queueSubmissionForWorkerInput,
  validateSingleSiteWorkerInput,
} from './run-single-site-worker.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const MAX_LAUNCH_BYTES = 32 * 1_048_576;

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) fail('SINGLE_SITE_LAUNCH_INVALID', `${label} must be an object.`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length || missing.length) {
    fail('SINGLE_SITE_LAUNCH_INVALID', `${label} has invalid fields.`, { unknown, missing });
  }
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !value) fail('SINGLE_SITE_LAUNCH_INVALID', `${label} must be an ISO timestamp.`);
  try {
    if (new Date(value).toISOString() !== value) fail('SINGLE_SITE_LAUNCH_INVALID', `${label} must be a canonical ISO timestamp.`);
  } catch (error) {
    if (error?.code === 'SINGLE_SITE_LAUNCH_INVALID') throw error;
    fail('SINGLE_SITE_LAUNCH_INVALID', `${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function bareDigest(value, label) {
  if (typeof value !== 'string') fail('SINGLE_SITE_LAUNCH_INVALID', `${label} is missing.`);
  const normalized = value.startsWith('sha256:') ? value.slice(7) : value;
  if (!/^[a-f0-9]{64}$/.test(normalized)) fail('SINGLE_SITE_LAUNCH_INVALID', `${label} is not a SHA-256 digest.`);
  return normalized;
}

function commaSeparated(value, label) {
  if (value === undefined) return [];
  const values = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    fail('SINGLE_SITE_LAUNCH_USAGE', `${label} must be a comma-separated list without duplicates.`);
  }
  return values;
}

function directRunContract(options, targetRegistry) {
  const targetIds = options.targets.length > 0
    ? options.targets
    : [...targetRegistry.singleSiteFullProfileTargetIds];
  const hasFilters = options.plugins.length > 0 || options.audits.length > 0 || options.areas.length > 0;
  const qualifier = options.scope ?? (hasFilters ? 'TARGETED' : 'FULL');
  return {
    schemaVersion: 1,
    mode: 'single-site',
    url: options.url,
    deploymentRole: options.role,
    certificatePolicy: options.certificatePolicy,
    targetIds,
    scope: {
      qualifier,
      pluginIds: options.plugins,
      auditIds: options.audits,
      areas: options.areas,
    },
  };
}

function launchDocumentForCompiledRun({ idempotencyKey, runContract, preflight, coverage, routeInventoryPlan, runnerRevision, advisory, now }) {
  const inputDocument = {
    schemaVersion: 1,
    kind: 'single-site-worker-input',
    runContract,
    coverageManifest: coverage,
    routeInventoryPlan,
    launchCheckpoint: {
      preflightDigest: bareDigest(preflight.preflightDigest, 'Preflight digest'),
      identityFingerprint: bareDigest(preflight.identityFingerprint, 'Identity fingerprint'),
      revisionFingerprint: preflight.deploymentRevision?.fingerprint
        ? bareDigest(preflight.deploymentRevision.fingerprint, 'Deployment revision fingerprint')
        : null,
      evidenceAuthority: {
        authoritative: preflight.evidenceAuthority?.status === 'authoritative',
        reasons: [...(preflight.evidenceAuthority?.reasons ?? [])],
      },
    },
    advisory,
    runnerRevision,
  };
  return {
    schemaVersion: 1,
    kind: 'single-site-job-launch',
    idempotencyKey,
    stageDeadlines: {
      inventory: new Date(now + 15 * 60_000).toISOString(),
      browser: new Date(now + 90 * 60_000).toISOString(),
      finalizer: new Date(now + 120 * 60_000).toISOString(),
    },
    inputDocument,
  };
}

export async function launchDirectSingleSiteJob(options, dependencies = {}) {
  const repositoryRoot = dependencies.repositoryRoot ?? path.resolve(path.dirname(scriptPath), '..');
  const [pluginRegistry, targetRegistry, runnerRevision] = await Promise.all([
    dependencies.pluginRegistry ?? fs.readFile(path.join(repositoryRoot, 'audit', 'plugins.generated.json'), 'utf8').then(JSON.parse),
    dependencies.targetRegistry ?? fs.readFile(path.join(repositoryRoot, 'audit', 'targets.generated.json'), 'utf8').then(JSON.parse),
    dependencies.runnerRevision ?? resolveRunnerRevision({ root: repositoryRoot }),
  ]);
  const contract = directRunContract(options, targetRegistry);
  let compiledLaunchDocument = null;
  const coordinator = createSingleSiteLaunchCoordinator({
    pluginRegistry,
    targetRegistry,
    runnerRevision,
    validateContract: dependencies.validateContract,
    preflight: dependencies.preflight ?? ((input) => preflightQuitting7ohSite(input, {
      previewBypassOrigins: options.previewBypassOrigins,
      tlsBypassRequestOptions: { rejectUnauthorized: false },
    })),
    createJob: async ({ idempotencyKey, runContract, preflight, coverage, routeInventoryPlan, advisory }) => {
      compiledLaunchDocument = launchDocumentForCompiledRun({
        idempotencyKey,
        runContract,
        preflight,
        coverage,
        routeInventoryPlan,
        runnerRevision,
        advisory,
        now: dependencies.now?.() ?? Date.now(),
      });
      return launchSingleSiteJob({ queue: dependencies.queue, launchDocument: compiledLaunchDocument });
    },
  });
  const preview = await coordinator.preview(contract);
  if (!preview.accepted) {
    fail('SINGLE_SITE_PREFLIGHT_REJECTED', 'The deployment failed quitting7oh identity preflight.', { preview });
  }
  const launched = await coordinator.launch({
    idempotencyKey: options.idempotencyKey,
    previewDigest: preview.previewDigest,
    runContract: preview.runContract,
    advisory: options.aiModel
      ? { schemaVersion: 1, aiReview: { optedIn: true, model: options.aiModel } }
      : { schemaVersion: 1, aiReview: { optedIn: false, model: null } },
  });
  if (!launched.launched) {
    fail('SINGLE_SITE_LAUNCH_STALE', `The deployment changed between preview and launch (${launched.reason}).`, { launched });
  }
  return { preview, launched, launchDocument: compiledLaunchDocument };
}

export function validateSingleSiteLaunchDocument(rawLaunch) {
  const launch = structuredClone(rawLaunch);
  exactKeys(launch, ['schemaVersion', 'kind', 'idempotencyKey', 'stageDeadlines', 'inputDocument'], 'launch document');
  if (launch.schemaVersion !== 1 || launch.kind !== 'single-site-job-launch') {
    fail('SINGLE_SITE_LAUNCH_INVALID', 'Launch document must use schemaVersion 1 and kind single-site-job-launch.');
  }
  if (typeof launch.idempotencyKey !== 'string' || !launch.idempotencyKey.trim() || launch.idempotencyKey.length > 256) {
    fail('SINGLE_SITE_LAUNCH_INVALID', 'idempotencyKey must be a non-empty string no longer than 256 characters.');
  }
  if (!isRecord(launch.stageDeadlines) || Object.keys(launch.stageDeadlines).length === 0 || Object.keys(launch.stageDeadlines).length > 64) {
    fail('SINGLE_SITE_LAUNCH_INVALID', 'stageDeadlines must be a non-empty bounded object.');
  }
  for (const [stage, deadline] of Object.entries(launch.stageDeadlines)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(stage)) fail('SINGLE_SITE_LAUNCH_INVALID', `Invalid stage deadline name ${stage}.`);
    canonicalTimestamp(deadline, `stageDeadlines.${stage}`);
  }
  for (const required of ['browser', 'finalizer']) {
    if (!(required in launch.stageDeadlines)) fail('SINGLE_SITE_LAUNCH_INVALID', `stageDeadlines.${required} is required.`);
  }
  if (new Date(launch.stageDeadlines.finalizer) <= new Date(launch.stageDeadlines.browser)) {
    fail('SINGLE_SITE_LAUNCH_INVALID', 'Finalizer deadline must follow the browser deadline.');
  }
  const inputDocument = validateSingleSiteWorkerInput(launch.inputDocument);
  return {
    schemaVersion: 1,
    kind: 'single-site-job-launch',
    idempotencyKey: launch.idempotencyKey,
    stageDeadlines: structuredClone(launch.stageDeadlines),
    inputDocument: launch.inputDocument,
    validatedInput: inputDocument,
  };
}

export async function launchSingleSiteJob({ queue, launchDocument }) {
  const launch = validateSingleSiteLaunchDocument(launchDocument);
  const submission = queueSubmissionForWorkerInput(launch.inputDocument, {
    idempotencyKey: launch.idempotencyKey,
    stageDeadlines: launch.stageDeadlines,
  });
  const result = await submitJob(queue, submission, { inputDocument: launch.inputDocument });
  return {
    created: result.created,
    jobId: result.state.jobId,
    inputDocumentDigest: result.state.inputDocumentDigest,
    submissionDigest: result.state.submissionDigest,
    executionState: result.state.executionState,
    selectedTargetIds: [...launch.validatedInput.selectedTargetIds],
    selectedCaseCount: launch.validatedInput.selectedCaseIds.length,
    evidenceAuthority: structuredClone(result.state.evidenceAuthority),
  };
}

async function readLaunchDocument(file) {
  const absolute = path.resolve(file);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('SINGLE_SITE_LAUNCH_NOT_FOUND', `Launch document was not found: ${absolute}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_LAUNCH_BYTES) {
    fail('SINGLE_SITE_LAUNCH_INVALID', 'Launch document must be a non-empty bounded regular file, not a symlink.');
  }
  try {
    return JSON.parse(await fs.readFile(absolute, 'utf8'));
  } catch {
    fail('SINGLE_SITE_LAUNCH_INVALID', 'Launch document is not valid JSON.');
  }
}

export function parseArguments(argv, environment = process.env) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (![
      '--queue-root', '--launch', '--url', '--role', '--certificate-policy', '--scope', '--targets',
      '--plugins', '--audits', '--areas', '--idempotency-key', '--ai-review',
    ].includes(flag) || !value) {
      fail('SINGLE_SITE_LAUNCH_USAGE', 'Usage: node scripts/run-single-site.mjs --queue-root <path> (--launch <launch.json> | --url <origin> --role <preview|production> [--certificate-policy strict|preview-bypass] [--scope FULL|TARGETED] [--targets id,...] [--plugins id,...] [--audits id,...] [--areas name,...] [--ai-review model-id] [--idempotency-key key])');
    }
    if (values.has(flag)) fail('SINGLE_SITE_LAUNCH_USAGE', `Duplicate option ${flag}.`);
    values.set(flag, value);
  }
  const launchPath = values.get('--launch');
  const url = values.get('--url');
  if (Boolean(launchPath) === Boolean(url)) {
    fail('SINGLE_SITE_LAUNCH_USAGE', 'Choose exactly one launch input: --launch or --url.');
  }
  const role = values.get('--role') ?? 'preview';
  const certificatePolicy = values.get('--certificate-policy') ?? 'strict';
  const scope = values.get('--scope');
  if (!['preview', 'production'].includes(role)) fail('SINGLE_SITE_LAUNCH_USAGE', '--role must be preview or production.');
  if (!['strict', 'preview-bypass'].includes(certificatePolicy)) fail('SINGLE_SITE_LAUNCH_USAGE', '--certificate-policy must be strict or preview-bypass.');
  if (scope !== undefined && !['FULL', 'TARGETED'].includes(scope)) fail('SINGLE_SITE_LAUNCH_USAGE', '--scope must be FULL or TARGETED.');
  return {
    queueRoot: values.get('--queue-root') ?? environment.AUDIT_JOB_QUEUE_ROOT,
    launchPath,
    url,
    role,
    certificatePolicy,
    scope,
    targets: commaSeparated(values.get('--targets'), '--targets'),
    plugins: commaSeparated(values.get('--plugins'), '--plugins'),
    audits: commaSeparated(values.get('--audits'), '--audits'),
    areas: commaSeparated(values.get('--areas'), '--areas'),
    aiModel: values.get('--ai-review') ?? null,
    idempotencyKey: values.get('--idempotency-key') ?? `cli-${randomUUID()}`,
    previewBypassOrigins: String(environment.AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options.queueRoot) fail('SINGLE_SITE_LAUNCH_USAGE', 'Queue root is required.');
  const queue = await openJobQueue({ root: options.queueRoot });
  let result;
  if (options.launchPath) {
    const launchDocument = await readLaunchDocument(options.launchPath);
    result = await launchSingleSiteJob({ queue, launchDocument });
  } else {
    const direct = await launchDirectSingleSiteJob(options, { queue });
    result = direct.launched.job;
    process.stdout.write(`${JSON.stringify({
      event: 'single-site-preview-accepted',
      previewDigest: direct.preview.previewDigest,
      coverageStatus: direct.preview.coverage.coverageStatus,
      counts: direct.preview.coverage.counts,
      evidenceAuthority: direct.preview.preflight.evidenceAuthority,
    })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ event: result.created ? 'job-created' : 'job-reused', ...result })}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'launch-failed', code: error.code ?? 'SINGLE_SITE_LAUNCH_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  });
}
