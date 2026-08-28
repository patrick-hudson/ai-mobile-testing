import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openJobQueue, readJob, readJobInput } from './lib/job-queue.mjs';
import { launchDirectSingleSiteJob } from './run-single-site.mjs';
import { validateSingleSiteWorkerInput } from './run-single-site-worker.mjs';
import { finalizeSingleSiteJobs } from './finalize-single-site.mjs';
import { readSingleSiteMediaStagePublication } from './lib/single-site-media-finalization.mjs';
import { readSingleSiteVisualComparisonPublication } from './lib/single-site-visual-comparisons.mjs';
import { readSingleSiteFinalizationStatus } from '../portal/single-site-finalization.mjs';
import { validateCompleteReportPublication } from '../portal/report-publication.mjs';
import { loadGallerySnapshot, readGalleryItem } from '../portal/gallery-data.mjs';
import { canonicalSha256 } from '../shared/run-compiler.mjs';

const DEFAULT_URL = 'https://beta.quitting7oh-org.pages.dev';
const TERMINAL_FINALIZATION = new Set(['complete', 'incomplete', 'deadline-exceeded', 'invalid']);
const MAX_RECEIPT_PUBLICATIONS = 32;
const MAX_RECEIPT_BYTES = 32 * 1_024;
const MAX_FINALIZATION_BYTES = 10 * 1_048_576;
const MAX_GALLERY_BINDING_BYTES = 32 * 1_048_576;
const MAX_GALLERY_INDEX_BYTES = 32 * 1_048_576;
const RECEIPT_FILE = 'beta-proof-receipt.json';
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const scenarios = Object.freeze({
  smoke: Object.freeze({
    scope: 'TARGETED',
    targets: ['single-site-mobile-chromium', 'single-site-desktop-chromium'],
    audits: ['CONTENT-001', 'SHELL-001', 'NAV-001', 'SEARCH-001'],
    areas: [],
    plugins: [],
  }),
  targeted: Object.freeze({
    scope: 'TARGETED',
    targets: ['single-site-mobile-chromium', 'single-site-desktop-chromium'],
    audits: [],
    areas: ['navigation', 'search', 'calculators'],
    plugins: [],
  }),
  full: Object.freeze({
    scope: 'FULL',
    targets: [],
    audits: [],
    areas: [],
    plugins: [],
  }),
  'baseline-follow-up': Object.freeze({
    scope: 'TARGETED',
    targets: ['single-site-desktop-chromium'],
    audits: ['CONTENT-001'],
    areas: [],
    plugins: [],
  }),
});

function usage() {
  return 'Usage: node scripts/run-beta-single-site-proof.mjs --scenario smoke|targeted|full|baseline-follow-up [--url <origin>] [--certificate-policy strict|preview-bypass] [--timeout-minutes <1-240>] [--ai-review <model-id>]\n';
}

function normalizedProofOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('--url must be a plain HTTP(S) origin.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('--url must be a plain HTTP(S) origin without credentials, path, query, or fragment.');
  }
  return parsed.origin;
}

export function parseArguments(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.length % 2 !== 0) throw new Error(usage().trim());
  const values = new Map();
  const allowed = new Set(['--scenario', '--url', '--certificate-policy', '--timeout-minutes', '--ai-review']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || values.has(flag)) throw new Error(usage().trim());
    values.set(flag, value);
  }
  const scenario = values.get('--scenario');
  if (!scenario || !(scenario in scenarios)) throw new Error(usage().trim());
  const certificatePolicy = values.get('--certificate-policy') ?? 'strict';
  if (!['strict', 'preview-bypass'].includes(certificatePolicy)) {
    throw new Error('--certificate-policy must be strict or preview-bypass.');
  }
  const timeoutMinutes = Number(values.get('--timeout-minutes') ?? (scenario === 'full' ? 150 : 90));
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 240) {
    throw new Error('--timeout-minutes must be an integer from 1 through 240.');
  }
  return {
    help: false,
    scenario,
    url: normalizedProofOrigin(values.get('--url') ?? DEFAULT_URL),
    certificatePolicy,
    timeoutMs: timeoutMinutes * 60_000,
    aiModel: values.get('--ai-review') ?? null,
  };
}

export function betaProofScenario(name) {
  if (!(name in scenarios)) throw new TypeError(`Unknown beta proof scenario: ${name}`);
  return structuredClone(scenarios[name]);
}

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
}

function boundedString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`Beta proof receipt ${label} is not a canonical timestamp.`);
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new Error(`Beta proof receipt ${label} is not a canonical timestamp.`);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function digestString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(value)) return value;
  }
  return null;
}

function currentPublicationReceipt(job) {
  const attemptNumber = Number.isInteger(job?.attemptNumber) ? job.attemptNumber : null;
  const publications = Array.isArray(job?.publications) && attemptNumber !== null
    ? job.publications.filter((entry) => entry?.attemptNumber === job.attemptNumber)
    : [];
  let attemptId = boundedString(job?.attemptId, 128);
  const terminalFence = Number.isInteger(job?.fencingToken) ? job.fencingToken : null;
  let currentFence = terminalFence;
  if (publications.length > 0) {
    const eligible = publications.filter((entry) => Number.isInteger(entry?.fencingToken)
      && (attemptId === null || entry.attemptId === attemptId)
      && (terminalFence === null || entry.fencingToken <= terminalFence));
    currentFence = eligible.length > 0
      ? Math.max(...eligible.map((entry) => entry.fencingToken))
      : null;
    if (attemptId === null) {
      const attemptIds = [...new Set(eligible
        .filter((entry) => entry.fencingToken === currentFence)
        .map((entry) => boundedString(entry.attemptId, 128))
        .filter(Boolean))];
      if (attemptIds.length > 1) throw new Error('Current proof publications have an ambiguous authoritative attempt.');
      attemptId = attemptIds[0] ?? null;
    }
  }
  const current = publications
    .filter((entry) => entry?.attemptId === attemptId && entry?.fencingToken === currentFence)
    .map((entry) => ({
      publicationId: boundedString(entry.publicationId, 128),
      relativePath: boundedString(entry.relativePath, 512),
      digest: digestString(entry.digest),
      attemptId: boundedString(entry.attemptId, 128),
      attemptNumber: Number.isInteger(entry.attemptNumber) ? entry.attemptNumber : null,
      fencingToken: Number.isInteger(entry.fencingToken) ? entry.fencingToken : null,
    }))
    .filter((entry) => entry.publicationId !== null && entry.relativePath !== null && entry.digest !== null)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifestDigest = sha256(current);
  const items = current.slice(0, MAX_RECEIPT_PUBLICATIONS);
  return {
    attemptId,
    attemptNumber,
    fencingToken: currentFence,
    total: current.length,
    included: items.length,
    truncated: current.length > items.length,
    manifestDigest,
    items,
  };
}

export function buildBetaProofReceipt({ scenarioName, scenario, preview, job, finalization, finishedAt }) {
  const runContract = preview?.runContract ?? {};
  const coverage = preview?.coverage ?? {};
  const reportUrl = `/report.html?mode=single-site&run=${encodeURIComponent(job.jobId)}`;
  const galleryUrl = `/gallery.html?mode=single-site&run=${encodeURIComponent(job.jobId)}`;
  const succeeded = finalization.status === 'complete';
  const body = {
    schemaVersion: 1,
    kind: 'beta-single-site-proof-receipt',
    finishedAt: boundedString(finishedAt, 64),
    scenario: boundedString(scenarioName, 64),
    run: {
      jobId: boundedString(job.jobId, 128),
      mode: job.runMode === 'single-site' ? job.runMode : 'single-site',
      origin: runContract.url ? normalizedProofOrigin(runContract.url) : null,
      deploymentRole: boundedString(runContract.deploymentRole, 32),
      certificatePolicy: boundedString(runContract.certificatePolicy, 64),
      scope: {
        requestedQualifier: boundedString(runContract.scope?.qualifier ?? scenario?.scope, 16),
        qualifier: boundedString(coverage.scope?.qualifier ?? scenario?.scope, 16),
        targetIds: Array.isArray(coverage.scope?.selectedTargetIds)
          ? coverage.scope.selectedTargetIds.map((value) => boundedString(value, 128)).filter(Boolean)
          : Array.isArray(runContract.targetIds)
            ? runContract.targetIds.map((value) => boundedString(value, 128)).filter(Boolean)
            : [],
        filters: {
          pluginIds: [...(scenario?.plugins ?? [])],
          auditIds: [...(scenario?.audits ?? [])],
          areas: [...(scenario?.areas ?? [])],
        },
        coverageStatus: boundedString(coverage.coverageStatus, 32),
        selectedCaseCount: Number.isInteger(job.selectedCaseCount)
          ? job.selectedCaseCount
          : Number.isInteger(coverage.counts?.executableCases) ? coverage.counts.executableCases : null,
        plannedExecutionCount: Number.isInteger(coverage.counts?.plannedExecutions)
          ? coverage.counts.plannedExecutions
          : null,
      },
    },
    revisions: {
      runnerRevision: boundedString(job.runnerRevision ?? coverage.revisions?.runner, 256),
      previewDigest: digestString(preview?.previewDigest),
      sourceRevisionDigest: digestString(job.revisionFingerprint, preview?.preflight?.deploymentRevision?.fingerprint),
      inputDocumentDigest: digestString(job.inputDocumentDigest),
      submissionDigest: digestString(job.submissionDigest),
      runContractDigest: digestString(job.runContractDigest, coverage.revisions?.runContract),
      preflightDigest: digestString(job.preflightDigest, preview?.preflight?.preflightDigest),
      identityFingerprint: digestString(job.identityFingerprint, preview?.preflight?.identityFingerprint),
      coverageManifestDigest: digestString(job.compiledManifestDigest, coverage.manifestDigest),
      routeInventoryDigest: digestString(
        job.routeInventoryDigest,
        coverage.routeInventoryDigest,
        coverage.revisions?.routeInventory,
        preview?.routeInventoryPlan?.planDigest,
        preview?.preflight?.routeInventoryDigest,
      ),
      pluginRegistryRevision: boundedString(job.registryRevision ?? coverage.revisions?.pluginRegistry, 256),
      targetRegistryRevision: boundedString(job.targetSetRevision ?? coverage.revisions?.targetRegistry, 256),
    },
    terminal: {
      executionState: boundedString(job.executionState, 64),
      activityState: boundedString(job.activityState, 64),
      resultKind: boundedString(job.result?.kind, 64),
      attemptNumber: Number.isInteger(job.attemptNumber) ? job.attemptNumber : null,
      attemptId: boundedString(job.attemptId, 128),
      fencingToken: Number.isInteger(job.fencingToken) ? job.fencingToken : null,
      infrastructureRetriesUsed: Number.isInteger(job.infrastructureRetriesUsed)
        ? job.infrastructureRetriesUsed
        : null,
    },
    publications: currentPublicationReceipt(job),
    finalization: {
      status: boundedString(finalization.status, 64),
      executionState: boundedString(finalization.executionState, 64),
      deadlineExceeded: typeof finalization.deadlineExceeded === 'boolean'
        ? finalization.deadlineExceeded
        : null,
      finalizationDigest: digestString(finalization.finalizationDigest),
      failureDigest: digestString(finalization.failureDigest),
    },
    report: {
      revision: boundedString(finalization.reportRevision, 128),
      publicationDigest: digestString(finalization.reportPublicationDigest),
      url: reportUrl,
    },
    gallery: {
      exportRevision: boundedString(finalization.galleryExportRevision, 128),
      publicationDigest: digestString(finalization.galleryPublicationDigest),
      indexDigest: digestString(finalization.galleryIndexDigest),
      url: galleryUrl,
    },
    media: {
      stageDigest: digestString(finalization.mediaStageDigest),
      qualityState: boundedString(finalization.mediaQualityState, 64),
    },
    visual: {
      publicationDigest: digestString(finalization.visualPublicationDigest),
      eligibilityManifestDigest: digestString(finalization.visualEligibilityManifestDigest),
    },
    command: {
      outcome: succeeded ? 'succeeded' : 'not-complete',
      exitCode: succeeded ? 0 : 2,
    },
  };
  return { ...body, receiptDigest: sha256(body) };
}

function receiptBinding(receipt) {
  return {
    jobId: receipt.run?.jobId ?? null,
    finalization: receipt.finalization,
    report: {
      revision: receipt.report?.revision ?? null,
      publicationDigest: receipt.report?.publicationDigest ?? null,
    },
    gallery: {
      exportRevision: receipt.gallery?.exportRevision ?? null,
      publicationDigest: receipt.gallery?.publicationDigest ?? null,
      indexDigest: receipt.gallery?.indexDigest ?? null,
    },
    media: receipt.media,
    visual: receipt.visual,
    command: receipt.command,
  };
}

function finalizationBinding(finalization) {
  return {
    jobId: finalization.jobId,
    finalization: {
      status: finalization.status,
      executionState: finalization.executionState,
      deadlineExceeded: finalization.deadlineExceeded,
      finalizationDigest: finalization.finalizationDigest,
      failureDigest: finalization.failureDigest,
    },
    report: {
      revision: finalization.reportRevision,
      publicationDigest: finalization.reportPublicationDigest,
    },
    gallery: {
      exportRevision: finalization.galleryExportRevision,
      publicationDigest: finalization.galleryPublicationDigest,
      indexDigest: finalization.galleryIndexDigest,
    },
    media: {
      stageDigest: finalization.mediaStageDigest,
      qualityState: finalization.mediaQualityState,
    },
    visual: {
      publicationDigest: finalization.visualPublicationDigest,
      eligibilityManifestDigest: finalization.visualEligibilityManifestDigest,
    },
    command: {
      outcome: finalization.status === 'complete' ? 'succeeded' : 'not-complete',
      exitCode: finalization.status === 'complete' ? 0 : 2,
    },
  };
}

function reconstructedPreviewDigest(input) {
  const checkpoint = input.launchCheckpoint;
  return canonicalSha256({
    schemaVersion: 1,
    mode: 'single-site',
    runContract: input.runContract,
    preflightDigest: checkpoint.preflightDigest,
    identityFingerprint: checkpoint.identityFingerprint,
    deploymentRevisionFingerprint: checkpoint.revisionFingerprint,
    evidenceAuthority: {
      status: checkpoint.evidenceAuthority.authoritative ? 'authoritative' : 'non-authoritative',
      reasons: [...checkpoint.evidenceAuthority.reasons],
    },
    coverageManifestDigest: input.coverageManifest.manifestDigest,
    routeInventoryPlanDigest: input.routeInventoryPlan.planDigest,
    registryRevisions: input.coverageManifest.revisions,
  });
}

function durableQueueBinding(receipt, job, rawInput) {
  const input = validateSingleSiteWorkerInput(rawInput);
  const scenario = scenarios[receipt.scenario];
  if (!scenario) throw new Error('Beta proof receipt names an unknown scenario.');
  const contract = input.runContract;
  const coverage = input.coverageManifest;
  if (contract.mode !== 'single-site' || job.runMode !== 'single-site') {
    throw new Error('Beta proof receipt durable run mode is not Single-site.');
  }
  const scenarioScope = {
    qualifier: scenario.scope,
    pluginIds: scenario.plugins,
    auditIds: scenario.audits,
    areas: scenario.areas,
  };
  const contractScope = {
    qualifier: contract.scope.qualifier,
    pluginIds: contract.scope.pluginIds,
    auditIds: contract.scope.auditIds,
    areas: contract.scope.areas,
  };
  if (canonicalJson(scenarioScope) !== canonicalJson(contractScope)
    || (scenario.targets.length > 0 && canonicalJson(scenario.targets) !== canonicalJson(contract.targetIds))) {
    throw new Error('Beta proof receipt scenario does not match the durable launch scope.');
  }
  return {
    scenario: receipt.scenario,
    run: {
      jobId: job.jobId,
      mode: job.runMode,
      origin: contract.url,
      deploymentRole: contract.deploymentRole,
      certificatePolicy: contract.certificatePolicy,
      scope: {
        requestedQualifier: contract.scope.qualifier,
        qualifier: coverage.scope.qualifier,
        targetIds: [...coverage.scope.selectedTargetIds],
        filters: {
          pluginIds: [...contract.scope.pluginIds],
          auditIds: [...contract.scope.auditIds],
          areas: [...contract.scope.areas],
        },
        coverageStatus: coverage.coverageStatus,
        selectedCaseCount: input.selectedCaseIds.length,
        plannedExecutionCount: coverage.counts.plannedExecutions,
      },
    },
    revisions: {
      runnerRevision: job.runnerRevision,
      previewDigest: reconstructedPreviewDigest(input),
      sourceRevisionDigest: job.revisionFingerprint,
      inputDocumentDigest: job.inputDocumentDigest,
      submissionDigest: job.submissionDigest,
      runContractDigest: job.runContractDigest,
      preflightDigest: job.preflightDigest,
      identityFingerprint: job.identityFingerprint,
      coverageManifestDigest: job.compiledManifestDigest,
      routeInventoryDigest: input.routeInventoryPlan.planDigest,
      pluginRegistryRevision: job.registryRevision,
      targetRegistryRevision: job.targetSetRevision,
    },
    terminal: {
      executionState: job.executionState,
      activityState: job.activityState,
      resultKind: job.result?.kind ?? null,
      attemptNumber: job.attemptNumber,
      attemptId: job.attemptId,
      fencingToken: job.fencingToken,
      infrastructureRetriesUsed: job.infrastructureRetriesUsed,
    },
    publications: currentPublicationReceipt(job),
  };
}

async function durableQueueAuthority(queue, jobId) {
  if (!queue || typeof queue !== 'object') throw new Error('Beta proof receipt verification requires the durable job queue.');
  const [job, rawInput] = await Promise.all([readJob(queue, jobId), readJobInput(queue, jobId)]);
  return { job, rawInput };
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`Beta proof receipt ${label} has invalid fields.`);
  }
}

export function validateBetaProofReceipt(value, { jobId, finalization, queueAuthority } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.kind !== 'beta-single-site-proof-receipt'
    || !JOB_ID.test(value.run?.jobId ?? '')
    || typeof value.receiptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.receiptDigest)) {
    throw new Error('Beta proof receipt is malformed.');
  }
  const keys = [
    'schemaVersion', 'kind', 'finishedAt', 'scenario', 'run', 'revisions', 'terminal', 'publications',
    'finalization', 'report', 'gallery', 'media', 'visual', 'command', 'receiptDigest',
  ];
  assertExactKeys(value, keys, 'document');
  assertExactKeys(value.run, ['jobId', 'mode', 'origin', 'deploymentRole', 'certificatePolicy', 'scope'], 'run');
  assertExactKeys(value.run.scope, [
    'requestedQualifier', 'qualifier', 'targetIds', 'filters', 'coverageStatus',
    'selectedCaseCount', 'plannedExecutionCount',
  ], 'scope');
  assertExactKeys(value.run.scope.filters, ['pluginIds', 'auditIds', 'areas'], 'scope filters');
  assertExactKeys(value.revisions, [
    'runnerRevision', 'previewDigest', 'sourceRevisionDigest', 'inputDocumentDigest', 'submissionDigest',
    'runContractDigest', 'preflightDigest', 'identityFingerprint', 'coverageManifestDigest',
    'routeInventoryDigest', 'pluginRegistryRevision', 'targetRegistryRevision',
  ], 'revisions');
  assertExactKeys(value.terminal, [
    'executionState', 'activityState', 'resultKind', 'attemptNumber', 'attemptId',
    'fencingToken', 'infrastructureRetriesUsed',
  ], 'terminal state');
  assertExactKeys(value.publications, [
    'attemptId', 'attemptNumber', 'fencingToken', 'total', 'included', 'truncated', 'manifestDigest', 'items',
  ], 'publications');
  if (!Array.isArray(value.publications.items) || value.publications.items.length > MAX_RECEIPT_PUBLICATIONS) {
    throw new Error('Beta proof receipt publications are invalid or exceed their bound.');
  }
  if (!Number.isInteger(value.publications.total) || value.publications.total < 0
    || value.publications.included !== value.publications.items.length
    || value.publications.total < value.publications.included
    || value.publications.truncated !== (value.publications.total > value.publications.included)
    || !/^[a-f0-9]{64}$/.test(value.publications.manifestDigest ?? '')) {
    throw new Error('Beta proof receipt publication summary is inconsistent.');
  }
  for (const item of value.publications.items) {
    assertExactKeys(item, [
      'publicationId', 'relativePath', 'digest', 'attemptId', 'attemptNumber', 'fencingToken',
    ], 'publication item');
    if (item.attemptId !== value.publications.attemptId
      || item.attemptNumber !== value.publications.attemptNumber
      || item.fencingToken !== value.publications.fencingToken) {
      throw new Error('Beta proof receipt publication is not bound to the authoritative attempt.');
    }
  }
  assertExactKeys(value.finalization, [
    'status', 'executionState', 'deadlineExceeded', 'finalizationDigest', 'failureDigest',
  ], 'finalization');
  assertExactKeys(value.report, ['revision', 'publicationDigest', 'url'], 'report');
  assertExactKeys(value.gallery, ['exportRevision', 'publicationDigest', 'indexDigest', 'url'], 'gallery');
  assertExactKeys(value.media, ['stageDigest', 'qualityState'], 'media');
  assertExactKeys(value.visual, ['publicationDigest', 'eligibilityManifestDigest'], 'visual');
  assertExactKeys(value.command, ['outcome', 'exitCode'], 'command');
  canonicalTimestamp(value.finishedAt, 'finishedAt');
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES) throw new Error('Beta proof receipt exceeds its size bound.');
  const { receiptDigest, ...body } = value;
  if (sha256(body) !== receiptDigest) throw new Error('Beta proof receipt failed digest verification.');
  if (jobId !== undefined && value.run.jobId !== jobId) throw new Error('Beta proof receipt is bound to a different job.');
  const expectedReport = `/report.html?mode=single-site&run=${encodeURIComponent(value.run.jobId)}`;
  const expectedGallery = `/gallery.html?mode=single-site&run=${encodeURIComponent(value.run.jobId)}`;
  if (value.report?.url !== expectedReport || value.gallery?.url !== expectedGallery) {
    throw new Error('Beta proof receipt contains an invalid report or gallery URL.');
  }
  if (value.run.origin !== null && normalizedProofOrigin(value.run.origin) !== value.run.origin) {
    throw new Error('Beta proof receipt contains a non-canonical origin.');
  }
  if (finalization && canonicalJson(receiptBinding(value)) !== canonicalJson(finalizationBinding(finalization))) {
    throw new Error('Beta proof receipt does not match the verified finalization status.');
  }
  if (queueAuthority) {
    const expected = durableQueueBinding(value, queueAuthority.job, queueAuthority.rawInput);
    const actual = {
      scenario: value.scenario,
      run: value.run,
      revisions: value.revisions,
      terminal: value.terminal,
      publications: value.publications,
    };
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error('Beta proof receipt does not match the durable queue launch and terminal state.');
    }
  }
  return value;
}

function contained(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function readContainedJson(rootValue, fileValue, maximumBytes, label) {
  const root = path.resolve(rootValue);
  const file = path.resolve(fileValue);
  if (!contained(root, file) || file === root) throw new Error(`${label} escaped its durable root.`);
  const [rootReal, fileStat] = await Promise.all([fs.realpath(root), fs.lstat(file)]).catch((error) => {
    if (error?.code === 'ENOENT') throw new Error(`${label} is missing.`);
    throw error;
  });
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size < 2 || fileStat.size > maximumBytes) {
    throw new Error(`${label} is unsafe, empty, or oversized.`);
  }
  const fileReal = await fs.realpath(file);
  if (!contained(rootReal, fileReal)) throw new Error(`${label} escaped its durable root.`);
  const handle = await fs.open(fileReal, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== fileStat.size) throw new Error(`${label} changed while being opened.`);
    try { return JSON.parse((await handle.readFile()).toString('utf8')); } catch {
      throw new Error(`${label} is not valid JSON.`);
    }
  } finally {
    await handle.close();
  }
}

function assertDigestDocument(document, digestField, expectedDigest, label) {
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || !/^[a-f0-9]{64}$/.test(document[digestField] ?? '')
    || (expectedDigest !== undefined && document[digestField] !== expectedDigest)) {
    throw new Error(`${label} has an invalid durable digest binding.`);
  }
  const { [digestField]: digestValue, ...body } = document;
  if (sha256(body) !== digestValue) throw new Error(`${label} failed digest verification.`);
  return document;
}

async function verifyDurableFinalization(location, status, queue, queueAuthority, dependencies) {
  if (status.status === 'invalid') {
    const failure = assertDigestDocument(
      await readContainedJson(location.directory, path.join(location.directory, `failure-${status.failureDigest}.json`), MAX_FINALIZATION_BYTES, 'Beta proof finalization failure'),
      'failureDigest',
      status.failureDigest,
      'Beta proof finalization failure',
    );
    if (failure.kind !== 'single-site-finalization-failure' || failure.jobId !== status.jobId
      || failure.executionState !== queueAuthority.job.executionState
      || failure.inputDocumentDigest !== queueAuthority.job.inputDocumentDigest
      || failure.submissionDigest !== queueAuthority.job.submissionDigest) {
      throw new Error('Beta proof finalization failure does not match the durable queue job.');
    }
    return { finalization: null, failure };
  }
  const finalization = assertDigestDocument(
    await readContainedJson(location.directory, path.join(location.directory, 'finalization.json'), MAX_FINALIZATION_BYTES, 'Beta proof finalization'),
    'finalizationDigest',
    status.finalizationDigest,
    'Beta proof finalization',
  );
  if (finalization.schemaVersion !== 1 || finalization.kind !== 'single-site-finalization'
    || finalization.mode !== 'single-site' || !Array.isArray(finalization.jobs)
    || finalization.jobs.length !== 1 || finalization.jobs[0]?.jobId !== status.jobId) {
    throw new Error('Beta proof finalization document has an invalid job binding.');
  }
  const reconstructed = await dependencies.finalizeSingleSiteJobs({ queue, jobIds: [status.jobId] });
  if (canonicalJson(reconstructed) !== canonicalJson(finalization)) {
    throw new Error('Beta proof finalization does not match the durable queue publications.');
  }
  return { finalization, failure: null };
}

async function verifyGalleryIndex(reportDirectory, status) {
  if (status.galleryIndexDigest === null) return null;
  const root = path.join(reportDirectory, 'checklist', 'single-site-gallery-index');
  const pointer = await readContainedJson(root, path.join(root, 'current.json'), 64 * 1024, 'Beta proof gallery index pointer');
  const relativePath = pointer?.schemaVersion === 2
    ? `single-site-gallery-index/revisions/${status.galleryIndexDigest}/index.json`
    : `single-site-gallery-index/revisions/${status.galleryIndexDigest}.json`;
  if (![1, 2].includes(pointer?.schemaVersion) || pointer.kind !== 'single-site-gallery-index-pointer'
    || pointer.indexDigest !== status.galleryIndexDigest || pointer.exportRevision !== status.galleryExportRevision
    || pointer.relativePath !== relativePath || !Number.isSafeInteger(pointer.itemCount) || pointer.itemCount < 0) {
    throw new Error('Beta proof gallery index pointer does not match finalization status.');
  }
  const document = assertDigestDocument(
    await readContainedJson(root, path.join(reportDirectory, 'checklist', ...relativePath.split('/')), MAX_GALLERY_INDEX_BYTES, 'Beta proof gallery index'),
    'indexDigest',
    status.galleryIndexDigest,
    'Beta proof gallery index',
  );
  if (document.kind !== 'single-site-gallery-index' || document.mode !== 'single-site'
    || document.exportRevision !== status.galleryExportRevision) {
    throw new Error('Beta proof gallery index does not match its pointer.');
  }
  if (pointer.schemaVersion === 1) {
    if (!Array.isArray(document.entries) || document.entries.length !== pointer.itemCount) {
      throw new Error('Beta proof gallery index does not match its pointer.');
    }
    return document;
  }
  if (document.schemaVersion !== 2 || document.itemCount !== pointer.itemCount || !Array.isArray(document.pages)) {
    throw new Error('Beta proof paged gallery index does not match its pointer.');
  }
  const revisionDirectory = path.dirname(path.join(reportDirectory, 'checklist', ...relativePath.split('/')));
  const entries = [];
  for (const [index, reference] of document.pages.entries()) {
    if (reference?.ordinal !== index + 1 || typeof reference.relativePath !== 'string') {
      throw new Error('Beta proof paged gallery index has an invalid page reference.');
    }
    const page = assertDigestDocument(
      await readContainedJson(revisionDirectory, path.join(revisionDirectory, ...reference.relativePath.split('/')), MAX_GALLERY_INDEX_BYTES, 'Beta proof gallery index page'),
      'pageDigest', reference.pageDigest, 'Beta proof gallery index page',
    );
    if (page.kind !== 'single-site-gallery-index-page' || page.mode !== 'single-site'
      || page.exportRevision !== status.galleryExportRevision || page.ordinal !== reference.ordinal
      || !Array.isArray(page.entries) || page.entries.length !== reference.itemCount) {
      throw new Error('Beta proof gallery index page does not match its descriptor.');
    }
    entries.push(...page.entries);
  }
  if (entries.length !== pointer.itemCount) throw new Error('Beta proof paged gallery index is incomplete.');
  return { ...document, entries };
}

async function verifyGalleryPublication(location, status, reportPublication, dependencies) {
  if (status.galleryPublicationDigest === null) return null;
  const binding = assertDigestDocument(
    await readContainedJson(location.directory, path.join(location.directory, 'gallery-publication.json'), MAX_GALLERY_BINDING_BYTES, 'Beta proof gallery binding'),
    'bindingDigest',
    undefined,
    'Beta proof gallery binding',
  );
  if (binding.kind !== 'single-site-gallery-finalization-binding' || binding.jobId !== status.jobId
    || binding.publicationDigest !== status.galleryPublicationDigest
    || binding.exportRevision !== status.galleryExportRevision || binding.indexDigest !== status.galleryIndexDigest) {
    throw new Error('Beta proof gallery binding does not match finalization status.');
  }
  const expectedPublicationDigest = binding.publication === null
    ? sha256({ jobId: status.jobId, unavailable: true, mediaStageDigest: status.mediaStageDigest })
    : sha256(binding.publication);
  if (expectedPublicationDigest !== binding.publicationDigest) {
    throw new Error('Beta proof gallery publication digest is invalid.');
  }
  const reportDirectory = reportPublication.runDirectory;
  const index = await verifyGalleryIndex(reportDirectory, status);
  if (binding.publication === null) {
    if (binding.exportRevision !== null || binding.indexDigest !== null || index !== null) {
      throw new Error('Unavailable beta proof gallery has contradictory publication references.');
    }
    return { binding, snapshot: null, index: null };
  }
  const snapshot = await dependencies.loadGallerySnapshot({
    id: status.jobId,
    directory: reportDirectory,
    manifest: { id: status.jobId, status: 'complete', finishedAt: reportPublication.generatedAt },
  }, undefined, { includeRows: true });
  if (snapshot.kind !== 'sealed' || snapshot.head.exportRevision !== status.galleryExportRevision
    || snapshot.rows.length !== index?.entries?.length
    || canonicalJson(snapshot.head.primaryCounts) !== canonicalJson(binding.publication.descriptor?.primaryCounts)) {
    throw new Error('Beta proof sealed gallery does not match its durable binding and case index.');
  }
  for (let offset = 0; offset < snapshot.rows.length; offset += 8) {
    await Promise.all(snapshot.rows.slice(offset, offset + 8)
      .map(({ id }) => dependencies.readGalleryItem(snapshot, status.jobId, id)));
  }
  return { binding, snapshot, index };
}

const PUBLICATION_VERIFICATION_DEPENDENCIES = Object.freeze({
  finalizeSingleSiteJobs,
  validateCompleteReportPublication,
  loadGallerySnapshot,
  readGalleryItem,
  readSingleSiteMediaStagePublication,
  readSingleSiteVisualComparisonPublication,
});

async function verifyReferencedPublications(
  location,
  status,
  receipt,
  queue,
  queueAuthority,
  dependencies = PUBLICATION_VERIFICATION_DEPENDENCIES,
) {
  const durable = await verifyDurableFinalization(location, status, queue, queueAuthority, dependencies);
  if (status.status === 'invalid') return { ...durable, report: null, gallery: null, media: null, visual: null };
  const reportDirectory = path.join(location.directory, 'report');
  const report = await dependencies.validateCompleteReportPublication(reportDirectory);
  if (report.problems.length > 0 || report.publication?.mode !== 'single-site'
    || report.publication.publicationRevision !== status.reportRevision
    || report.publication.publicationDigest !== status.reportPublicationDigest) {
    throw new Error(`Beta proof report publication failed durable verification: ${report.problems.join('; ') || 'binding mismatch'}.`);
  }
  const attemptId = receipt.publications.attemptId ?? receipt.terminal.attemptId;
  if (typeof attemptId !== 'string') throw new Error('Beta proof publications have no authoritative attempt ID.');
  const media = await dependencies.readSingleSiteMediaStagePublication({
    outputDir: path.join(location.directory, 'media'),
    jobId: status.jobId,
    attemptId,
    finalizationDigest: status.finalizationDigest,
    mediaStageDigest: status.mediaStageDigest,
  });
  if (media.manifest.qualityState !== status.mediaQualityState) {
    throw new Error('Beta proof media publication quality state does not match finalization status.');
  }
  const visual = await dependencies.readSingleSiteVisualComparisonPublication({
    outputDir: path.join(location.directory, 'visual'),
    jobId: status.jobId,
    attemptId,
    finalizationDigest: status.finalizationDigest,
    reportRevision: status.reportRevision,
  });
  if (visual.publicationDigest !== status.visualPublicationDigest
    || visual.eligibility?.manifestDigest !== status.visualEligibilityManifestDigest) {
    throw new Error('Beta proof visual publication does not match finalization status.');
  }
  const gallery = await verifyGalleryPublication(location, status, report.publication, dependencies);
  return { ...durable, report, gallery, media, visual };
}

async function receiptLocation(rootValue, jobId) {
  if (!JOB_ID.test(jobId)) throw new Error('Beta proof receipt job ID is invalid.');
  const root = path.resolve(rootValue);
  const directory = path.join(root, jobId);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Beta proof finalization directory is unsafe.');
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(root), fs.realpath(directory)]);
  if (!contained(realRoot, realDirectory)) throw new Error('Beta proof finalization directory escaped its root.');
  return { directory, file: path.join(directory, RECEIPT_FILE), realRoot };
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function publicVerifiedEvidence(evidence) {
  const media = evidence.media?.manifest ?? null;
  return Object.freeze({
    finalizationDigest: evidence.finalization?.finalizationDigest ?? null,
    failureDigest: evidence.failure?.failureDigest ?? null,
    report: evidence.report ? {
      publicationRevision: evidence.report.publication.publicationRevision,
      publicationDigest: evidence.report.publication.publicationDigest,
      summary: evidence.report.summary,
    } : null,
    gallery: evidence.gallery ? {
      exportRevision: evidence.gallery.binding.exportRevision,
      publicationDigest: evidence.gallery.binding.publicationDigest,
      indexDigest: evidence.gallery.binding.indexDigest,
      counts: evidence.gallery.snapshot?.head?.primaryCounts ?? { total: 0, images: 0, videos: 0 },
      indexedItems: evidence.gallery.index?.entries?.length ?? 0,
    } : null,
    media: media ? {
      revision: media.revision,
      mediaStageDigest: media.mediaStageDigest,
      qualityState: media.qualityState,
      referencedAttachmentCount: media.referencedAttachmentCount,
      copiedAttachmentCount: media.copiedAttachmentCount,
      copiedAttachmentBytes: media.copiedAttachmentBytes,
      processedAttachmentCount: media.processedAttachmentCount,
      processedAttachmentBytes: media.processedAttachmentBytes,
      mediaFileCount: media.mediaFileCount,
      mediaFileBytes: media.mediaFileBytes,
      retainedFiles: media.retainedFiles,
      prunedFiles: media.prunedFiles,
      prunedBytes: media.prunedBytes,
      qualityRejectedClips: media.qualityRejectedClips,
      usableInteractionVideoCount: media.usableInteractionVideoCount,
      diagnosticVideoCount: media.diagnosticVideoCount,
      failedCount: media.failedCount,
      unavailableCount: media.unavailableCount,
      integrityErrors: media.integrityErrors,
    } : null,
    visual: evidence.visual ? {
      publicationDigest: evidence.visual.publicationDigest,
      eligibilityManifestDigest: evidence.visual.eligibility.manifestDigest,
      summary: evidence.visual.summary,
    } : null,
  });
}

async function readBetaProofReceiptInternal(finalizationRoot, jobId, {
  queue,
  publicationDependencies,
  includeVerifiedEvidence = false,
} = {}) {
  const finalization = await readSingleSiteFinalizationStatus(finalizationRoot, jobId);
  const location = await receiptLocation(finalizationRoot, jobId);
  let stat;
  try {
    stat = await fs.lstat(location.file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) {
    throw new Error('Beta proof receipt file is unsafe or oversized.');
  }
  const realFile = await fs.realpath(location.file);
  if (!contained(location.realRoot, realFile)) throw new Error('Beta proof receipt escaped its finalization root.');
  let document;
  try { document = JSON.parse(await fs.readFile(location.file, 'utf8')); } catch {
    throw new Error('Beta proof receipt is not valid JSON.');
  }
  const queueAuthority = await durableQueueAuthority(queue, jobId);
  const receipt = validateBetaProofReceipt(document, { jobId, finalization, queueAuthority });
  const evidence = await verifyReferencedPublications(
    location,
    finalization,
    receipt,
    queue,
    queueAuthority,
    publicationDependencies ?? PUBLICATION_VERIFICATION_DEPENDENCIES,
  );
  return includeVerifiedEvidence ? Object.freeze({ receipt, evidence: publicVerifiedEvidence(evidence) }) : receipt;
}

export async function readBetaProofReceipt(finalizationRoot, jobId, { queue } = {}) {
  return readBetaProofReceiptInternal(finalizationRoot, jobId, { queue });
}

export async function readBetaProofEvidenceBundle(finalizationRoot, jobId, { queue } = {}) {
  return readBetaProofReceiptInternal(finalizationRoot, jobId, { queue, includeVerifiedEvidence: true });
}

export async function __testOnlyReadBetaProofReceipt(finalizationRoot, jobId, options = {}) {
  return readBetaProofReceiptInternal(finalizationRoot, jobId, options);
}

async function persistBetaProofReceiptInternal(finalizationRoot, receipt, { queue, publicationDependencies } = {}) {
  const jobId = receipt?.run?.jobId;
  if (!JOB_ID.test(jobId ?? '')) throw new Error('Beta proof receipt job ID is invalid.');
  const finalization = await readSingleSiteFinalizationStatus(finalizationRoot, jobId);
  if (!TERMINAL_FINALIZATION.has(finalization.status)) {
    throw new Error('Beta proof receipt requires a terminal verified finalization status.');
  }
  const queueAuthority = await durableQueueAuthority(queue, jobId);
  validateBetaProofReceipt(receipt, { jobId, finalization, queueAuthority });
  const location = await receiptLocation(finalizationRoot, jobId);
  const dependencies = publicationDependencies ?? PUBLICATION_VERIFICATION_DEPENDENCIES;
  await verifyReferencedPublications(location, finalization, receipt, queue, queueAuthority, dependencies);
  const existing = await readBetaProofReceiptInternal(finalizationRoot, jobId, { queue, publicationDependencies: dependencies });
  if (existing !== null) {
    if (existing.receiptDigest !== receipt.receiptDigest) throw new Error('A different immutable beta proof receipt already exists.');
    return { created: false, receipt: existing };
  }
  const temporary = path.join(location.directory, `.${RECEIPT_FILE}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson(receipt)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(temporary, location.file);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const raced = await readBetaProofReceiptInternal(finalizationRoot, jobId, { queue, publicationDependencies: dependencies });
      if (raced?.receiptDigest !== receipt.receiptDigest) {
        throw new Error('A concurrent immutable beta proof receipt differs.');
      }
      return { created: false, receipt: raced };
    }
    await fsyncDirectory(location.directory);
    const published = await readBetaProofReceiptInternal(finalizationRoot, jobId, { queue, publicationDependencies: dependencies });
    if (published?.receiptDigest !== receipt.receiptDigest) throw new Error('Published beta proof receipt failed read-back verification.');
    return { created: true, receipt: published };
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}


export async function persistBetaProofReceipt(finalizationRoot, receipt, { queue } = {}) {
  return persistBetaProofReceiptInternal(finalizationRoot, receipt, { queue });
}

export async function __testOnlyPersistBetaProofReceipt(finalizationRoot, receipt, options = {}) {
  return persistBetaProofReceiptInternal(finalizationRoot, receipt, options);
}

async function waitForFinalization({ queue, finalizationRoot, jobId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastEventSequence = 0;
  let lastState = null;
  let lastFinalization = null;
  while (Date.now() <= deadline) {
    const [job, finalization] = await Promise.all([
      readJob(queue, jobId),
      readSingleSiteFinalizationStatus(finalizationRoot, jobId),
    ]);
    const stateKey = `${job.executionState}:${job.activityState}:${job.attemptId ?? 'none'}:${job.fencingToken}`;
    if (stateKey !== lastState) {
      log('execution-state', {
        jobId,
        executionState: job.executionState,
        activityState: job.activityState,
        attemptId: job.attemptId,
        fencingToken: job.fencingToken,
      });
      lastState = stateKey;
    }
    for (const event of job.events.filter(({ sequence }) => sequence > lastEventSequence)) {
      log('queue-event', {
        jobId,
        sequence: event.sequence,
        type: event.type,
        executionState: event.executionState,
        activityState: event.activityState,
        message: event.message,
      });
      lastEventSequence = Math.max(lastEventSequence, event.sequence);
    }
    if (finalization.status !== lastFinalization) {
      log('finalization-state', {
        jobId,
        status: finalization.status,
        mediaQualityState: finalization.mediaQualityState,
        reportRevision: finalization.reportRevision,
        galleryExportRevision: finalization.galleryExportRevision,
      });
      lastFinalization = finalization.status;
    }
    if (TERMINAL_FINALIZATION.has(finalization.status)) return { job, finalization };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${jobId} after ${Math.round(timeoutMs / 60_000)} minutes.`);
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return null;
  }
  const queueRoot = environment.PORTAL_SINGLE_SITE_QUEUE_ROOT ?? environment.AUDIT_JOB_QUEUE_ROOT;
  const finalizationRoot = environment.PORTAL_SINGLE_SITE_FINALIZATION_ROOT ?? environment.AUDIT_FINALIZATION_OUTPUT_ROOT;
  if (!queueRoot || !finalizationRoot) {
    throw new Error('Run this proof inside the portal container so the durable queue and finalization roots are available.');
  }
  const scenario = betaProofScenario(options.scenario);
  const queue = await openJobQueue({ root: path.resolve(queueRoot) });
  log('proof-start', {
    scenario: options.scenario,
    url: options.url,
    deploymentRole: 'preview',
    certificatePolicy: options.certificatePolicy,
    scope: scenario.scope,
    targets: scenario.targets,
    audits: scenario.audits,
    areas: scenario.areas,
  });
  const direct = await launchDirectSingleSiteJob({
    queueRoot,
    url: options.url,
    role: 'preview',
    certificatePolicy: options.certificatePolicy,
    scope: scenario.scope,
    targets: [...scenario.targets],
    plugins: [...scenario.plugins],
    audits: [...scenario.audits],
    areas: [...scenario.areas],
    aiModel: options.aiModel,
    idempotencyKey: `beta-proof-${options.scenario}-${randomUUID()}`,
    previewBypassOrigins: String(environment.AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST ?? '')
      .split(',').map((value) => value.trim()).filter(Boolean),
  }, { queue });
  const job = direct.launched.job;
  log(job.created ? 'job-created' : 'job-reused', {
    jobId: job.jobId,
    previewDigest: direct.preview.previewDigest,
    coverageStatus: direct.preview.coverage.coverageStatus,
    coverageCounts: direct.preview.coverage.counts,
    selectedCaseCount: job.selectedCaseCount,
    selectedTargetIds: job.selectedTargetIds,
    evidenceAuthority: job.evidenceAuthority,
    portalRun: `/?singleSiteRun=${encodeURIComponent(job.jobId)}`,
  });
  const settled = await waitForFinalization({
    queue,
    finalizationRoot: path.resolve(finalizationRoot),
    jobId: job.jobId,
    timeoutMs: options.timeoutMs,
  });
  const finishedAt = new Date().toISOString();
  const candidateReceipt = buildBetaProofReceipt({
    scenarioName: options.scenario,
    scenario,
    preview: direct.preview,
    job: settled.job,
    finalization: settled.finalization,
    finishedAt,
  });
  const { receipt } = await persistBetaProofReceipt(path.resolve(finalizationRoot), candidateReceipt, { queue });
  log('proof-finished', {
    jobId: job.jobId,
    executionState: settled.job.executionState,
    finalizationStatus: settled.finalization.status,
    reportRevision: settled.finalization.reportRevision,
    report: receipt.report.url,
    gallery: receipt.gallery.url,
    receipt,
  });
  if (settled.finalization.status !== 'complete') process.exitCode = 2;
  return { ...settled, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event: 'proof-failed', message: error.message })}\n`);
    process.exitCode = 1;
  });
}
