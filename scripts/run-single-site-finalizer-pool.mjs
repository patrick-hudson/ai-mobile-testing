import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, listIndexedJobs, openJobQueue, sha256 } from './lib/job-queue.mjs';
import {
  finalizeSingleSiteJobs,
  prepareSingleSitePublicationInput,
  readSingleSitePublicationCheckpoint,
} from './finalize-single-site.mjs';
import { preflightOptions } from './run-single-site-worker.mjs';
import { preflightQuitting7ohSite } from '../shared/site-preflight.mjs';
import { writeSingleSiteReportPublication } from './lib/single-site-report-writer.mjs';
import {
  publishSingleSiteMediaStage,
  publishUnavailableSingleSiteMediaStage,
  runLoggedCommand,
} from './lib/single-site-media-finalization.mjs';
import {
  applyVisualComparisonsToSingleSiteReportInput,
  publishSingleSiteVisualComparisons,
  readSingleSiteVisualComparisonPublication,
} from './lib/single-site-visual-comparisons.mjs';
import { validateCompleteReportPublication } from '../portal/report-publication.mjs';
import { openVisualBaselineStore } from '../portal/visual-baselines.mjs';
import {
  createPoolLogger,
  interruptibleDelay,
  parsePollMilliseconds,
} from './run-single-site-worker-pool.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const TERMINAL_STATES = new Set(['completed', 'failed', 'incomplete', 'cancelled']);
const MAX_FINALIZATION_BYTES = 10 * 1_048_576;
const RETRYABLE_FINALIZATION_ERROR_CODES = new Set([
  'EAGAIN', 'EBUSY', 'ECONNRESET', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'ETIMEDOUT',
]);
const DEPLOYMENT_CHECKPOINT_INCOMPLETE_CODES = new Set([
  'SINGLE_SITE_FINALIZER_DEPLOYMENT_CHANGED',
  'SINGLE_SITE_FINALIZER_DEPLOYMENT_UNAVAILABLE',
  'SINGLE_SITE_FINALIZER_FENCE_CHANGED',
]);
const SECRET_PATTERN = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;]{8,})/gi;
const MAX_PROCESSED_TERMINAL_JOBS = 2_048;

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail('SINGLE_SITE_FINALIZER_POOL_INVALID', `${label} must be 1-128 safe identifier characters.`);
  }
  return value;
}

export function defaultFinalizerId(hostname = os.hostname()) {
  const normalized = String(hostname).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 107);
  return safeIdentifier(`finalizer-${normalized || 'container'}`, 'finalizer ID');
}

function safeMessage(value) {
  return String(value)
    .replace(SECRET_PATTERN, '[REDACTED]')
    .replace(/([?&](?:token|key|signature|auth)=)[^&#\s]+/gi, '$1[REDACTED]')
    .slice(0, 1_000);
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareOutputRoot(root) {
  const absolute = path.resolve(root);
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('SINGLE_SITE_FINALIZER_OUTPUT_UNSAFE', 'Finalization output root must be a real directory, not a symlink.');
  }
  return { absolute, real: await fs.realpath(absolute) };
}

async function jobOutputDirectory(outputRoot, jobId) {
  safeIdentifier(jobId, 'jobId');
  const directory = path.join(outputRoot.absolute, jobId);
  await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  const [stat, real] = await Promise.all([fs.lstat(directory), fs.realpath(directory)]);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (real !== outputRoot.real && !real.startsWith(`${outputRoot.real}${path.sep}`))) {
    fail('SINGLE_SITE_FINALIZER_OUTPUT_UNSAFE', `Output directory for ${jobId} escaped the configured root.`);
  }
  return directory;
}

async function readExistingDocument(file) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_FINALIZATION_BYTES) {
    fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Existing finalization output is empty, unsafe, or oversized: ${file}`);
  }
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Existing finalization output is invalid JSON: ${file}`);
  }
}

async function regularFileExists(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Existing publication path is unsafe: ${file}`);
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function publishImmutableDocument(file, document) {
  const serialized = canonicalJson(document);
  if (Buffer.byteLength(serialized) > MAX_FINALIZATION_BYTES) {
    fail('SINGLE_SITE_FINALIZER_OUTPUT_TOO_LARGE', 'Finalization document exceeds its immutable output bound.');
  }
  const existing = await readExistingDocument(file);
  if (existing !== null) {
    if (canonicalJson(existing) !== serialized) {
      fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Immutable output already exists with different content: ${file}`);
    }
    return { created: false, document: existing };
  }
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${serialized}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const raced = await readExistingDocument(file);
      if (canonicalJson(raced) !== serialized) {
        fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Concurrent immutable output differs: ${file}`);
      }
      return { created: false, document: raced };
    }
    await fsyncDirectory(directory);
    return { created: true, document };
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

function assertFinalizationDigest(document, jobId) {
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || document.schemaVersion !== 1
    || document.kind !== 'single-site-finalization'
    || typeof document.finalizationDigest !== 'string') {
    fail('SINGLE_SITE_FINALIZER_RESULT_INVALID', `Finalizer returned an invalid document for ${jobId}.`);
  }
  const { finalizationDigest, ...body } = document;
  const actual = sha256(body);
  if (actual !== finalizationDigest) {
    fail('SINGLE_SITE_FINALIZER_RESULT_INVALID', `Finalization digest is invalid for ${jobId}.`, { expected: finalizationDigest, actual });
  }
  if (!Array.isArray(document.jobs) || document.jobs.length !== 1 || document.jobs[0].jobId !== jobId) {
    fail('SINGLE_SITE_FINALIZER_RESULT_INVALID', `Finalizer output for ${jobId} contains the wrong job set.`);
  }
  return document;
}

function statusDocument(job, finalization, reportPublication, visualPublication, mediaPublication, galleryPublication, now) {
  const finalizerDeadline = Date.parse(job.stageDeadlines.finalizer ?? '');
  const deadlineExceeded = Number.isFinite(finalizerDeadline) && now > finalizerDeadline;
  const evidenceIncomplete = mediaPublication.manifest.qualityState !== 'complete'
    || finalization.counts.incomplete > 0
    || finalization.counts.failed > 0
    || finalization.counts.cancelled > 0;
  const body = {
    schemaVersion: 1,
    kind: 'single-site-finalization-status',
    jobId: job.jobId,
    status: deadlineExceeded || evidenceIncomplete ? 'incomplete' : 'complete',
    deadlineExceeded,
    executionState: job.executionState,
    finalizationDigest: finalization.finalizationDigest,
    mediaStageDigest: mediaPublication.manifest.mediaStageDigest,
    mediaQualityState: mediaPublication.manifest.qualityState,
    reportRevision: reportPublication.publicationRevision,
    reportPublicationDigest: reportPublication.publicationDigest,
    visualPublicationDigest: visualPublication.publicationDigest,
    visualEligibilityManifestDigest: visualPublication.eligibility.manifestDigest,
    galleryPublicationDigest: galleryPublication.publicationDigest,
    galleryExportRevision: galleryPublication.exportRevision,
    galleryIndexDigest: galleryPublication.indexDigest,
  };
  return { ...body, statusDigest: sha256(body) };
}

function blockedPublicationStatus(job, finalization, error) {
  const body = {
    schemaVersion: 1,
    kind: 'single-site-finalization-status',
    jobId: job.jobId,
    status: 'incomplete',
    deadlineExceeded: false,
    executionState: job.executionState,
    finalizationDigest: finalization.finalizationDigest,
    failureDigest: null,
    reportRevision: null,
    reportPublicationDigest: null,
    visualPublicationDigest: null,
    visualEligibilityManifestDigest: null,
    mediaStageDigest: null,
    mediaQualityState: null,
    galleryPublicationDigest: null,
    galleryExportRevision: null,
    galleryIndexDigest: null,
    publicationBlocked: true,
    incompleteReasonCode: error.code,
    incompleteReason: safeMessage(error.message),
  };
  return { ...body, statusDigest: sha256(body) };
}

function deploymentBlockDocument(job, finalization, error) {
  const row = finalization.jobs[0];
  const body = {
    schemaVersion: 1,
    kind: 'single-site-publication-block',
    jobId: job.jobId,
    executionState: job.executionState,
    inputDocumentDigest: job.inputDocumentDigest,
    submissionDigest: job.submissionDigest,
    attemptNumber: row.attemptNumber,
    fencingToken: row.fencingToken,
    finalizationDigest: finalization.finalizationDigest,
    code: error.code,
    message: safeMessage(error.message),
  };
  return { ...body, blockDigest: sha256(body) };
}

function validateDeploymentBlock(document, job, finalization) {
  if (!document || document.schemaVersion !== 1 || document.kind !== 'single-site-publication-block'
    || document.jobId !== job.jobId || document.executionState !== job.executionState
    || document.inputDocumentDigest !== job.inputDocumentDigest
    || document.submissionDigest !== job.submissionDigest
    || document.finalizationDigest !== finalization.finalizationDigest
    || document.attemptNumber !== finalization.jobs[0]?.attemptNumber
    || document.fencingToken !== finalization.jobs[0]?.fencingToken
    || !DEPLOYMENT_CHECKPOINT_INCOMPLETE_CODES.has(document.code)
    || typeof document.message !== 'string' || typeof document.blockDigest !== 'string') {
    fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Deployment publication block is invalid for ${job.jobId}.`);
  }
  const { blockDigest, ...body } = document;
  if (sha256(body) !== blockDigest) {
    fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Deployment publication block failed digest verification for ${job.jobId}.`);
  }
  return document;
}

function validatedPublicationCheckpoint(value, jobId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.kind !== 'single-site-publication-checkpoint'
    || value.jobId !== jobId
    || !TERMINAL_STATES.has(value.executionState)
    || !Number.isInteger(value.attemptNumber) || value.attemptNumber < 0
    || !Number.isInteger(value.fencingToken) || value.fencingToken < 0
    || !/^[a-f0-9]{64}$/.test(value.inputDocumentDigest ?? '')
    || !/^[a-f0-9]{64}$/.test(value.submissionDigest ?? '')
    || !/^[a-f0-9]{64}$/.test(value.publicationsDigest ?? '')
    || !/^[a-f0-9]{64}$/.test(value.checkpointDigest ?? '')
    || !value.runContract || value.runContract.mode !== 'single-site'
    || typeof value.runContract.url !== 'string'
    || !value.launchCheckpoint || !/^[a-f0-9]{64}$/.test(value.launchCheckpoint.identityFingerprint ?? '')
    || !Object.hasOwn(value.launchCheckpoint, 'revisionFingerprint')
    || (value.launchCheckpoint.revisionFingerprint !== null
      && !/^[a-f0-9]{64}$/.test(value.launchCheckpoint.revisionFingerprint ?? ''))
    || !value.launchCheckpoint.evidenceAuthority) {
    fail('SINGLE_SITE_FINALIZER_FENCE_CHANGED', `Publication checkpoint is invalid for ${jobId}.`);
  }
  const { checkpointDigest, ...body } = value;
  if (sha256(body) !== checkpointDigest) {
    fail('SINGLE_SITE_FINALIZER_FENCE_CHANGED', `Publication checkpoint digest changed for ${jobId}.`);
  }
  return value;
}

function authorityBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.authoritative === 'boolean' && Array.isArray(value.reasons)) {
    return { authoritative: value.authoritative, reasons: [...value.reasons].sort() };
  }
  if (['authoritative', 'non-authoritative'].includes(value.status) && Array.isArray(value.reasons)) {
    return { authoritative: value.status === 'authoritative', reasons: [...value.reasons].sort() };
  }
  return null;
}

function assertCheckpointBoundToFinalization(frozen, finalization) {
  const row = finalization?.jobs?.length === 1 ? finalization.jobs[0] : null;
  const rowAuthority = authorityBinding(row?.evidenceAuthority);
  const frozenAuthority = authorityBinding(frozen.launchCheckpoint.evidenceAuthority);
  if (!row || row.jobId !== frozen.jobId
    || row.executionState !== frozen.executionState
    || row.attemptNumber !== frozen.attemptNumber
    || row.fencingToken !== frozen.fencingToken
    || row.inputDocumentDigest !== frozen.inputDocumentDigest
    || row.submissionDigest !== frozen.submissionDigest
    || row.runContractDigest !== sha256(frozen.runContract)
    || row.identityFingerprint !== frozen.launchCheckpoint.identityFingerprint
    || row.revisionFingerprint !== frozen.launchCheckpoint.revisionFingerprint
    || sha256(row.publications ?? []) !== frozen.publicationsDigest
    || !rowAuthority || !frozenAuthority
    || canonicalJson(rowAuthority) !== canonicalJson(frozenAuthority)) {
    fail('SINGLE_SITE_FINALIZER_FENCE_CHANGED', `Finalization is not bound to the frozen publication checkpoint for ${frozen.jobId}.`);
  }
}

export async function revalidateSingleSitePublicationCheckpoint({
  queue,
  jobId,
  expected,
  finalization,
  preflight = preflightQuitting7ohSite,
  preflightOptions: outboundOptions = {},
  readCheckpoint = readSingleSitePublicationCheckpoint,
}) {
  const frozen = validatedPublicationCheckpoint(expected, jobId);
  assertCheckpointBoundToFinalization(frozen, finalization);
  let observed = null;
  let preflightError = null;
  try {
    observed = await preflight({
      url: frozen.runContract.url,
      deploymentRole: frozen.runContract.deploymentRole,
      certificatePolicy: frozen.runContract.certificatePolicy,
    }, outboundOptions);
  } catch (error) {
    preflightError = error instanceof Error ? error : new Error(String(error));
  }

  const current = validatedPublicationCheckpoint(await readCheckpoint({ queue, jobId }), jobId);
  if (canonicalJson(current) !== canonicalJson(frozen)) {
    fail('SINGLE_SITE_FINALIZER_FENCE_CHANGED', `Current attempt or evidence fence changed before final publication for ${jobId}.`);
  }
  if (preflightError || !observed || observed.accepted !== true
    || observed.origin !== frozen.runContract.url
    || observed.deploymentRole !== frozen.runContract.deploymentRole
    || observed.certificatePolicy !== frozen.runContract.certificatePolicy) {
    fail('SINGLE_SITE_FINALIZER_DEPLOYMENT_UNAVAILABLE', `Deployment identity and revision could not be revalidated before final publication for ${jobId}.`);
  }
  if (observed.identityFingerprint !== frozen.launchCheckpoint.identityFingerprint) {
    fail('SINGLE_SITE_FINALIZER_DEPLOYMENT_CHANGED', `Deployment identity changed before final publication for ${jobId}.`);
  }
  const observedRevision = observed.deploymentRevision?.status === 'verified'
    && typeof observed.deploymentRevision.fingerprint === 'string'
    ? observed.deploymentRevision.fingerprint
    : null;
  const frozenRevision = frozen.launchCheckpoint.revisionFingerprint;
  if (frozenRevision !== null && observedRevision === null) {
    fail('SINGLE_SITE_FINALIZER_DEPLOYMENT_UNAVAILABLE', `Deployment revision could no longer be authoritatively checked before final publication for ${jobId}.`);
  }
  if (observedRevision !== frozenRevision) {
    fail('SINGLE_SITE_FINALIZER_DEPLOYMENT_CHANGED', `Deployment revision changed before final publication for ${jobId}.`);
  }
  const frozenAuthority = authorityBinding(frozen.launchCheckpoint.evidenceAuthority);
  const observedAuthority = authorityBinding(observed.evidenceAuthority);
  if (!frozenAuthority || !observedAuthority
    || canonicalJson(frozenAuthority) !== canonicalJson(observedAuthority)) {
    fail('SINGLE_SITE_FINALIZER_DEPLOYMENT_UNAVAILABLE', `Deployment Evidence Authority changed before final publication for ${jobId}.`);
  }
  return {
    matched: true,
    jobId,
    attemptNumber: frozen.attemptNumber,
    fencingToken: frozen.fencingToken,
    identityFingerprint: observed.identityFingerprint,
    revisionFingerprint: observedRevision,
    evidenceAuthority: observedAuthority,
  };
}

async function publishSingleSiteGalleryByCommand({ artifactRoot, outputDir, generatedAt, jobId, logger, signal, deadlineAt }) {
  const script = path.resolve(path.dirname(scriptPath), 'publish-single-site-gallery.ts');
  const sharedStoreRoot = process.env.AUDIT_SHARED_STORE_ROOT;
  const sharedRunId = process.env.AUDIT_SHARED_RUN_ID;
  const finalSubjectDigest = process.env.AUDIT_SHARED_FINAL_SUBJECT_DIGEST;
  if (!sharedStoreRoot || !sharedRunId || !/^sha256:[a-f0-9]{64}$/.test(finalSubjectDigest ?? '')) {
    fail('SINGLE_SITE_FINALIZER_GALLERY_INVALID', 'Single-site gallery publication requires the current shared run, store, and final subject binding.');
  }
  if (sharedRunId !== jobId) {
    fail('SINGLE_SITE_FINALIZER_GALLERY_INVALID', 'Single-site gallery shared run binding does not match the finalized job.');
  }
  const result = await runLoggedCommand({
    command: process.execPath,
    args: [
      '--import', 'tsx', script,
      '--artifact-root', artifactRoot,
      '--output-dir', outputDir,
      '--generated-at', generatedAt,
      '--shared-store-root', sharedStoreRoot,
      '--shared-run-id', sharedRunId,
      '--final-subject-digest', finalSubjectDigest,
    ],
    cwd: path.dirname(path.dirname(scriptPath)),
    environment: process.env,
    logger,
    label: 'gallery-publisher',
    signal,
    deadlineAt,
  });
  if (result.exitCode !== 0 || result.signal !== null) {
    fail('SINGLE_SITE_FINALIZER_GALLERY_INVALID', 'Single-site gallery publisher failed.', {
      exitCode: result.exitCode,
      signal: result.signal,
      forceKilled: result.forceKilled,
      terminationReason: result.terminationReason,
      stderr: safeMessage(result.stderr),
    });
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let publication;
  try { publication = JSON.parse(lines.at(-1)); } catch {
    fail('SINGLE_SITE_FINALIZER_GALLERY_INVALID', 'Single-site gallery publisher returned invalid JSON.');
  }
  if (!publication || publication.kind !== 'single-site-gallery-publication'
    || publication.mode !== 'single-site'
    || typeof publication.descriptor?.exportRevision !== 'string'
    || !/^[a-f0-9]{64}$/.test(publication.index?.indexDigest ?? '')) {
    fail('SINGLE_SITE_FINALIZER_GALLERY_INVALID', 'Single-site gallery publication descriptor is malformed.');
  }
  return {
    publication,
    publicationDigest: sha256(publication),
    exportRevision: publication.descriptor.exportRevision,
    indexDigest: publication.index.indexDigest,
  };
}

function reportGeneratedAt(job) {
  for (const value of [job.updatedAt, [...(job.events ?? [])].at(-1)?.at, job.submittedAt]) {
    if (typeof value !== 'string') continue;
    try {
      if (new Date(value).toISOString() === value) return value;
    } catch {
      // Try the next immutable queue timestamp.
    }
  }
  fail('SINGLE_SITE_FINALIZER_RESULT_INVALID', `Job ${job.jobId} has no canonical timestamp for report publication.`);
}

function expectedVisualSummary(reportInput) {
  const statuses = ['UNCHANGED', 'CHANGED', 'REVIEWED', 'absent', 'incompatible', 'unavailable'];
  const byStatus = Object.fromEntries(statuses.map((status) => [status, 0]));
  for (const audit of reportInput.audits ?? []) {
    if (!(audit.visualStatus in byStatus)) fail('SINGLE_SITE_FINALIZER_VISUAL_INVALID', `Unsupported report visual status: ${audit.visualStatus}.`);
    byStatus[audit.visualStatus] += 1;
  }
  return { total: (reportInput.audits ?? []).length, attentionRequired: byStatus.CHANGED, byStatus };
}

function validateGalleryBinding(document, jobId) {
  if (!document || document.schemaVersion !== 1 || document.kind !== 'single-site-gallery-finalization-binding'
    || document.jobId !== jobId || !/^[a-f0-9]{64}$/.test(document.bindingDigest ?? '')
    || !/^[a-f0-9]{64}$/.test(document.publicationDigest ?? '')) {
    fail('SINGLE_SITE_FINALIZER_GALLERY_INVALID', `Gallery binding is malformed for ${jobId}.`);
  }
  const { bindingDigest, ...body } = document;
  if (sha256(body) !== bindingDigest
    || (document.exportRevision === null) !== (document.indexDigest === null)
    || (document.exportRevision !== null && (!/^export_[A-Za-z0-9_-]+$/.test(document.exportRevision)
      || !/^[a-f0-9]{64}$/.test(document.indexDigest ?? '')))) {
    fail('SINGLE_SITE_FINALIZER_GALLERY_INVALID', `Gallery binding failed digest or revision validation for ${jobId}.`);
  }
  return document;
}

async function immutableGalleryBinding(file, jobId, galleryPublication = null) {
  const existing = await readExistingDocument(file);
  if (existing !== null) return validateGalleryBinding(existing, jobId);
  if (!galleryPublication) fail('SINGLE_SITE_FINALIZER_GALLERY_INVALID', `Gallery publication is missing for ${jobId}.`);
  const body = {
    schemaVersion: 1,
    kind: 'single-site-gallery-finalization-binding',
    jobId,
    publication: galleryPublication.publication,
    publicationDigest: galleryPublication.publicationDigest,
    exportRevision: galleryPublication.exportRevision,
    indexDigest: galleryPublication.indexDigest,
  };
  const document = { ...body, bindingDigest: sha256(body) };
  await publishImmutableDocument(file, document);
  return validateGalleryBinding(document, jobId);
}

function isRetryableFinalizationError(error) {
  return error?.retryable === true || RETRYABLE_FINALIZATION_ERROR_CODES.has(error?.code);
}

async function purgeOwnsJob(queue, jobId) {
  if (typeof queue?.root !== 'string') return false;
  const candidates = [
    path.join(queue.root, '.single-site-purge-locks', jobId),
    path.join(queue.root, '.single-site-purge-journals', `${jobId}.json`),
  ];
  for (const candidate of candidates) {
    try {
      await fs.lstat(candidate);
      return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

function failureDocument(job, error) {
  const normalizedCode = String(error.code ?? 'FINALIZATION_FAILED')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 128) || 'FINALIZATION_FAILED';
  const body = {
    schemaVersion: 1,
    kind: 'single-site-finalization-failure',
    jobId: job.jobId,
    executionState: job.executionState,
    inputDocumentDigest: job.inputDocumentDigest,
    submissionDigest: job.submissionDigest,
    code: safeIdentifier(normalizedCode, 'failure code'),
    message: safeMessage(error.message),
  };
  return { ...body, failureDigest: sha256(body) };
}

function emitOnce(reported, key, logger, event, detail) {
  if (reported.has(key)) return;
  while (reported.size >= 4_096) reported.delete(reported.values().next().value);
  reported.add(key);
  logger.emit(event, detail);
}

async function processTerminalJob({
  queue,
  job,
  outputRoot,
  finalize,
  preparePublicationInput,
  baselineStore,
  publishVisual,
  readVisual,
  applyVisual,
  publishMedia,
  publishUnavailableMedia,
  publishGallery,
  publishReport,
  validateReport,
  revalidatePublicationCheckpoint,
  readPublicationCheckpoint,
  preflight,
  outboundPreflightOptions,
  logger,
  now,
  reported,
  signal,
}) {
  const directory = await jobOutputDirectory(outputRoot, job.jobId);
  const finalizationFile = path.join(directory, 'finalization.json');
  const statusFile = path.join(directory, 'status.json');
  const deploymentBlockFile = path.join(directory, 'publication-blocked.json');
  let finalization = null;
  try {
    finalization = assertFinalizationDigest(await finalize({ queue, jobIds: [job.jobId] }), job.jobId);
    const committedFinalization = await readExistingDocument(finalizationFile);
    if (committedFinalization !== null
      && canonicalJson(committedFinalization) !== canonicalJson(finalization)) {
      fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Committed finalization differs from current fenced evidence: ${finalizationFile}`);
    }
    const existingDeploymentBlock = await readExistingDocument(deploymentBlockFile);
    if (existingDeploymentBlock !== null) {
      const block = validateDeploymentBlock(existingDeploymentBlock, job, finalization);
      const finalizationPublication = await publishImmutableDocument(finalizationFile, finalization);
      const status = blockedPublicationStatus(job, finalization, block);
      await publishImmutableDocument(statusFile, status);
      emitOnce(reported, `checkpoint-block:${job.jobId}:${block.blockDigest}`, logger, 'deployment-checkpoint-unchanged', {
        jobId: job.jobId,
        code: block.code,
        finalizationDigest: finalization.finalizationDigest,
        status: status.status,
      });
      return {
        outcome: finalizationPublication.created ? 'status-repaired' : 'unchanged',
        finalization,
        status,
      };
    }
    const legacyStatus = await readExistingDocument(statusFile);
    if (legacyStatus !== null && legacyStatus.kind === 'single-site-finalization-status'
      && legacyStatus.finalizationDigest === finalization.finalizationDigest
      && !Object.hasOwn(legacyStatus, 'mediaStageDigest')) {
      const legacyBody = Object.fromEntries(Object.entries(legacyStatus).filter(([key]) => key !== 'statusDigest'));
      if (typeof legacyStatus.statusDigest !== 'string' || sha256(legacyBody) !== legacyStatus.statusDigest) {
        fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Existing legacy finalization status digest is invalid: ${statusFile}`);
      }
      emitOnce(reported, `legacy:${job.jobId}:${finalization.finalizationDigest}`, logger, 'legacy-finalization-unchanged', {
        jobId: job.jobId,
        finalizationDigest: finalization.finalizationDigest,
        status: legacyStatus.status,
      });
      return { outcome: 'unchanged', finalization, status: legacyStatus };
    }
    if (legacyStatus !== null && legacyStatus.kind === 'single-site-finalization-status'
      && legacyStatus.status === 'incomplete'
      && legacyStatus.publicationBlocked === true
      && legacyStatus.finalizationDigest === finalization.finalizationDigest
      && legacyStatus.reportRevision === null
      && legacyStatus.mediaStageDigest === null
      && legacyStatus.visualPublicationDigest === null
      && legacyStatus.galleryPublicationDigest === null) {
      const blockedBody = Object.fromEntries(Object.entries(legacyStatus).filter(([key]) => key !== 'statusDigest'));
      if (typeof legacyStatus.statusDigest !== 'string' || sha256(blockedBody) !== legacyStatus.statusDigest) {
        fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Existing deployment-fenced status digest is invalid: ${statusFile}`);
      }
      emitOnce(reported, `blocked:${job.jobId}:${finalization.finalizationDigest}`, logger, 'deployment-checkpoint-unchanged', {
        jobId: job.jobId,
        finalizationDigest: finalization.finalizationDigest,
        status: legacyStatus.status,
      });
      return { outcome: 'unchanged', finalization, status: legacyStatus };
    }
    const reportRunDirectory = path.join(directory, 'report');
    const reportOutputDirectory = path.join(reportRunDirectory, 'checklist');
    const reportPointer = path.join(reportOutputDirectory, 'data', 'current.json');
    const galleryBindingFile = path.join(directory, 'gallery-publication.json');
    const generatedAt = reportGeneratedAt(job);
    const finalizerDeadline = Date.parse(job.stageDeadlines.finalizer ?? '');
    const deadlineAt = Number.isFinite(finalizerDeadline) ? finalizerDeadline : undefined;
    const sealed = await preparePublicationInput({ queue, jobId: job.jobId, generatedAt });
    if (!sealed || typeof sealed !== 'object' || !sealed.reportInput) {
      fail('SINGLE_SITE_FINALIZER_REPORT_INVALID', `Publication input preparation failed for ${job.jobId}.`);
    }
    const alreadyPublished = committedFinalization !== null;
    if (!alreadyPublished) {
      logger.emit('deployment-checkpoint-started', {
        jobId: job.jobId,
        attemptNumber: sealed.publicationCheckpoint?.attemptNumber ?? null,
        fencingToken: sealed.publicationCheckpoint?.fencingToken ?? null,
        origin: sealed.publicationCheckpoint?.runContract?.url ?? null,
      });
      const checkpoint = await revalidatePublicationCheckpoint({
        queue,
        jobId: job.jobId,
        expected: sealed.publicationCheckpoint,
        finalization,
        preflight,
        preflightOptions: outboundPreflightOptions,
        readCheckpoint: readPublicationCheckpoint,
      });
      logger.emit('deployment-checkpoint-verified', checkpoint);
    }
    const attemptId = sealed.workerResult?.attemptId
      ?? finalization.jobs[0]?.publications?.[0]?.attemptId
      ?? 'no-attempt';
    safeIdentifier(attemptId, 'attemptId');
    const mediaOutputDirectory = path.join(directory, 'media');
    const mediaPublication = sealed.playwrightResultsBytes instanceof Uint8Array
      && typeof sealed.sourceResultsDigest === 'string'
      ? await publishMedia({
          artifactRoot: sealed.artifactRoot,
          sourceResults: sealed.playwrightResults,
          sourceResultsBytes: sealed.playwrightResultsBytes,
          sourceResultsDigest: sealed.sourceResultsDigest,
          outputDir: mediaOutputDirectory,
          jobId: job.jobId,
          attemptId,
          finalizationDigest: finalization.finalizationDigest,
          generatedAt,
          logger,
          signal,
          deadlineAt,
        })
      : await publishUnavailableMedia({
          outputDir: mediaOutputDirectory,
          jobId: job.jobId,
          attemptId,
          finalizationDigest: finalization.finalizationDigest,
          generatedAt,
          reason: 'The fenced attempt did not publish digest-bound Playwright results for media processing.',
          logger,
        });
    if (!mediaPublication?.manifest || !/^[a-f0-9]{64}$/.test(mediaPublication.manifest.mediaStageDigest ?? '')) {
      fail('SINGLE_SITE_FINALIZER_MEDIA_INVALID', `Media-stage publication failed validation for ${job.jobId}.`);
    }
    const prepared = mediaPublication.resultsBytes instanceof Uint8Array
      ? await preparePublicationInput({
          queue,
          jobId: job.jobId,
          generatedAt,
          mediaStageEvidence: {
            playwrightResults: mediaPublication.results,
            playwrightResultsBytes: mediaPublication.resultsBytes,
            manifest: mediaPublication.manifest,
          },
        })
      : sealed;
    const reportRevision = sha256({
      finalizationDigest: finalization.finalizationDigest,
      mediaStageDigest: mediaPublication.manifest.mediaStageDigest,
    }).slice(0, 32);
    const visualOutputDirectory = path.join(directory, 'visual');
    const visualPointer = path.join(visualOutputDirectory, 'visual-comparisons.json');
    const existingVisual = await regularFileExists(visualPointer);
    const visualPublication = !existingVisual
      ? await publishVisual({
          playwrightResults: mediaPublication.results ?? prepared.playwrightResults ?? { suites: [], errors: [] },
          deterministicFindings: prepared.reportInput.health?.findings ?? [],
          artifactRoot: mediaPublication.artifactRoot ?? prepared.artifactRoot,
          baselineStore,
          outputDir: visualOutputDirectory,
          jobId: job.jobId,
          attemptId,
          finalizationDigest: finalization.finalizationDigest,
          reportRevision,
          generatedAt,
          runStatus: job.executionState,
          evidenceComplete: prepared.reportInput.health?.pipeline?.requiredEvidenceComplete === true,
          evidenceAuthority: prepared.reportInput.health?.evidenceAuthority,
        })
      : await readVisual({
          outputDir: visualOutputDirectory,
          jobId: job.jobId,
          attemptId,
          finalizationDigest: finalization.finalizationDigest,
          reportRevision,
        });
    if (!visualPublication || visualPublication.kind !== 'single-site-visual-comparison-publication'
      || visualPublication.runId !== job.jobId || !/^sha256:[a-f0-9]{64}$/.test(visualPublication.publicationDigest ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(visualPublication.eligibility?.manifestDigest ?? '')) {
      fail('SINGLE_SITE_FINALIZER_VISUAL_INVALID', `Visual comparison publication failed validation for ${job.jobId}.`);
    }
    logger.emit(!existingVisual ? 'visual-published' : 'visual-verified', {
      jobId: job.jobId,
      publicationDigest: visualPublication.publicationDigest,
      eligibilityManifestDigest: visualPublication.eligibility.manifestDigest,
      summary: visualPublication.summary,
    });
    const reportInput = applyVisual(prepared.reportInput, visualPublication);
    const existingReport = await readExistingDocument(reportPointer);
    if (existingReport === null || existingReport.publicationRevision !== reportRevision) {
      await publishReport({
        outputDir: reportOutputDirectory,
        input: reportInput,
        publicationRevision: reportRevision,
      });
      logger.emit('report-published', { jobId: job.jobId, publicationRevision: reportRevision });
    }
    const existingGalleryBinding = await readExistingDocument(galleryBindingFile);
    const galleryCandidate = existingGalleryBinding === null
      ? mediaPublication.artifactRoot
        ? await publishGallery({
            artifactRoot: mediaPublication.artifactRoot,
            outputDir: reportOutputDirectory,
            generatedAt,
            jobId: job.jobId,
            logger,
            signal,
            deadlineAt,
          })
        : {
            publication: null,
            publicationDigest: sha256({ jobId: job.jobId, unavailable: true, mediaStageDigest: mediaPublication.manifest.mediaStageDigest }),
            exportRevision: null,
            indexDigest: null,
          }
      : null;
    const galleryPublication = await immutableGalleryBinding(galleryBindingFile, job.jobId, galleryCandidate);
    logger.emit(existingGalleryBinding === null ? 'gallery-published' : 'gallery-verified', {
      jobId: job.jobId,
      publicationDigest: galleryPublication.publicationDigest,
      exportRevision: galleryPublication.exportRevision,
      indexDigest: galleryPublication.indexDigest,
    });
    const reportValidation = await validateReport(reportRunDirectory);
    if (reportValidation.problems?.length > 0
      || reportValidation.publication?.publicationRevision !== reportRevision
      || reportValidation.publication?.mode !== 'single-site'
      || !/^[a-f0-9]{64}$/.test(reportValidation.publication?.publicationDigest ?? '')
      || canonicalJson(reportValidation.summary?.visualReview) !== canonicalJson(expectedVisualSummary(reportInput))) {
      fail('SINGLE_SITE_FINALIZER_REPORT_INVALID', `Single-site report publication failed validation for ${job.jobId}.`, {
        expectedRevision: reportRevision,
        actualRevision: reportValidation.publication?.publicationRevision ?? null,
        problems: reportValidation.problems ?? ['Report validator returned an invalid result.'],
      });
    }
    if (existingReport !== null && existingReport.publicationRevision === reportRevision) {
      logger.emit('report-verified', { jobId: job.jobId, publicationRevision: reportRevision });
    }
    const finalizationPublication = await publishImmutableDocument(finalizationFile, finalization);
    if (!finalizationPublication.created) {
      const existingStatus = await readExistingDocument(statusFile);
      const statusBody = existingStatus && typeof existingStatus === 'object' && !Array.isArray(existingStatus)
        ? Object.fromEntries(Object.entries(existingStatus).filter(([key]) => key !== 'statusDigest'))
        : null;
      if (existingStatus !== null
        && existingStatus.kind === 'single-site-finalization-status'
        && existingStatus.finalizationDigest === finalization.finalizationDigest
        && existingStatus.mediaStageDigest === mediaPublication.manifest.mediaStageDigest
        && existingStatus.reportRevision === reportValidation.publication.publicationRevision
        && existingStatus.reportPublicationDigest === reportValidation.publication.publicationDigest
        && existingStatus.visualPublicationDigest === visualPublication.publicationDigest
        && existingStatus.visualEligibilityManifestDigest === visualPublication.eligibility.manifestDigest) {
        if (existingStatus.galleryPublicationDigest !== galleryPublication.publicationDigest
          || existingStatus.galleryExportRevision !== galleryPublication.exportRevision
          || existingStatus.galleryIndexDigest !== galleryPublication.indexDigest) {
          fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Existing finalization status has a different gallery publication: ${statusFile}`);
        }
        if (typeof existingStatus.statusDigest !== 'string' || sha256(statusBody) !== existingStatus.statusDigest) {
          fail('SINGLE_SITE_FINALIZER_IMMUTABLE_CONFLICT', `Existing finalization status digest is invalid: ${statusFile}`);
        }
        emitOnce(reported, `unchanged:${job.jobId}:${finalization.finalizationDigest}`, logger, 'finalization-unchanged', {
          jobId: job.jobId,
          finalizationDigest: finalization.finalizationDigest,
          status: existingStatus.status,
        });
        return { outcome: 'unchanged', finalization, status: existingStatus };
      }
    }
    const status = statusDocument(job, finalization, reportValidation.publication, visualPublication, mediaPublication, galleryPublication, now);
    await publishImmutableDocument(statusFile, status);
    logger.emit(finalizationPublication.created ? 'finalization-published' : 'finalization-status-repaired', {
      jobId: job.jobId,
      finalizationDigest: finalization.finalizationDigest,
      status: status.status,
      counts: finalization.counts,
    });
    return { outcome: finalizationPublication.created ? 'published' : 'status-repaired', finalization, status };
  } catch (error) {
    if (isRetryableFinalizationError(error)) {
      logger.emit('finalization-retryable-failure', {
        jobId: job.jobId,
        code: error.code ?? null,
        message: error.message,
      });
      return { outcome: 'retryable', error };
    }
    if (finalization && DEPLOYMENT_CHECKPOINT_INCOMPLETE_CODES.has(error?.code)) {
      const block = deploymentBlockDocument(job, finalization, error);
      await publishImmutableDocument(deploymentBlockFile, block);
      const finalizationPublication = await publishImmutableDocument(finalizationFile, finalization);
      const status = blockedPublicationStatus(job, finalization, error);
      await publishImmutableDocument(statusFile, status);
      emitOnce(reported, `checkpoint-fenced:${job.jobId}:${finalization.finalizationDigest}`, logger, 'deployment-checkpoint-fenced', {
        jobId: job.jobId,
        code: error.code,
        message: error.message,
        blockDigest: block.blockDigest,
        finalizationDigest: finalization.finalizationDigest,
        status: status.status,
      });
      return { outcome: finalizationPublication.created ? 'published' : 'status-repaired', finalization, status };
    }
    const failure = failureDocument(job, error);
    const failureFile = path.join(directory, `failure-${failure.failureDigest}.json`);
    await publishImmutableDocument(failureFile, failure);
    const invalidStatusBody = {
      schemaVersion: 1,
      kind: 'single-site-finalization-status',
      jobId: job.jobId,
      status: 'invalid',
      deadlineExceeded: /deadline exceeded/i.test(String(error?.details?.terminationReason ?? ''))
        || (Number.isFinite(Date.parse(job.stageDeadlines.finalizer ?? ''))
          && Date.now() > Date.parse(job.stageDeadlines.finalizer)),
      executionState: job.executionState,
      failureDigest: failure.failureDigest,
    };
    const invalidStatus = { ...invalidStatusBody, statusDigest: sha256(invalidStatusBody) };
    try {
      await publishImmutableDocument(statusFile, invalidStatus);
    } catch (statusError) {
      emitOnce(reported, `status-conflict:${job.jobId}:${failure.failureDigest}`, logger, 'finalization-status-conflict', {
        jobId: job.jobId,
        code: statusError.code ?? null,
        message: statusError.message,
        failureDigest: failure.failureDigest,
      });
    }
    emitOnce(reported, `invalid:${job.jobId}:${failure.failureDigest}`, logger, 'finalization-invalid', {
      jobId: job.jobId,
      code: error.code ?? null,
      message: error.message,
      failureDigest: failure.failureDigest,
    });
    return { outcome: 'invalid', failure };
  }
}

export async function runSingleSiteFinalizerPool({
  queue,
  outputRoot,
  baselineRoot = undefined,
  finalizerId,
  pollMs = 1_000,
  signal,
  dependencies = {},
  maxCycles = Number.POSITIVE_INFINITY,
  environment = process.env,
}) {
  safeIdentifier(finalizerId, 'finalizer ID');
  parsePollMilliseconds(pollMs);
  const preparedOutput = await prepareOutputRoot(outputRoot);
  const logger = dependencies.logger ?? createPoolLogger({
    service: 'single-site-finalizer-pool',
    serviceId: finalizerId,
    stream: dependencies.logStream,
    clock: dependencies.logClock,
  });
  const list = dependencies.listJobs ?? null;
  const listIndexed = dependencies.listIndexedJobs ?? listIndexedJobs;
  const finalize = dependencies.finalize ?? finalizeSingleSiteJobs;
  const preparePublicationInput = dependencies.preparePublicationInput ?? prepareSingleSitePublicationInput;
  const publishVisual = dependencies.publishVisual ?? publishSingleSiteVisualComparisons;
  const readVisual = dependencies.readVisual ?? readSingleSiteVisualComparisonPublication;
  const applyVisual = dependencies.applyVisual ?? applyVisualComparisonsToSingleSiteReportInput;
  const publishMedia = dependencies.publishMedia ?? publishSingleSiteMediaStage;
  const publishUnavailableMedia = dependencies.publishUnavailableMedia ?? publishUnavailableSingleSiteMediaStage;
  const publishGallery = dependencies.publishGallery ?? publishSingleSiteGalleryByCommand;
  const baselineStore = dependencies.baselineStore ?? (dependencies.publishVisual
    ? null
    : await openVisualBaselineStore({
        root: baselineRoot ?? fail(
          'SINGLE_SITE_FINALIZER_POOL_INVALID',
          'Visual baseline root is required when the production visual publisher is enabled.',
        ),
      }));
  const publishReport = dependencies.publishReport ?? writeSingleSiteReportPublication;
  const validateReport = dependencies.validateReport ?? validateCompleteReportPublication;
  const revalidatePublicationCheckpoint = dependencies.revalidatePublicationCheckpoint
    ?? revalidateSingleSitePublicationCheckpoint;
  const readPublicationCheckpoint = dependencies.readPublicationCheckpoint
    ?? readSingleSitePublicationCheckpoint;
  const preflight = dependencies.preflight ?? preflightQuitting7ohSite;
  const outboundPreflightOptions = dependencies.preflightOptions ?? preflightOptions(environment);
  const delay = dependencies.delay ?? interruptibleDelay;
  let cycles = 0;
  let published = 0;
  let unchanged = 0;
  let invalid = 0;
  let retryable = 0;
  const reported = new Set();
  const processedTerminalJobs = new Map();
  let terminalCursor = null;
  const rememberTerminalJob = (jobId, signature) => {
    processedTerminalJobs.delete(jobId);
    processedTerminalJobs.set(jobId, signature);
    while (processedTerminalJobs.size > MAX_PROCESSED_TERMINAL_JOBS) {
      processedTerminalJobs.delete(processedTerminalJobs.keys().next().value);
    }
  };
  let drainLogged = false;
  const logDrain = () => {
    if (drainLogged) return;
    drainLogged = true;
    logger.emit('drain-started', { published, unchanged, invalid, retryable, acceptingNewJobs: false });
  };
  signal?.addEventListener('abort', logDrain, { once: true });
  logger.emit('pool-started', { pollMs, outputRoot: preparedOutput.absolute, acceptingNewJobs: !signal?.aborted });
  try {
    while (!signal?.aborted && cycles < maxCycles) {
      cycles += 1;
      let states;
      try {
        if (list) {
          states = await list(queue);
        } else {
          const page = await listIndexed(queue, { category: 'terminal', cursor: terminalCursor, limit: 128 });
          states = page.jobs;
          terminalCursor = page.cursor;
        }
      } catch (error) {
        logger.emit('queue-list-failed', { code: error.code ?? null, message: error.message, retryInMs: pollMs });
        if (!signal?.aborted && cycles < maxCycles) await delay(pollMs, signal);
        continue;
      }
      const terminal = states
        .filter(({ executionState }) => TERMINAL_STATES.has(executionState))
        .filter((job) => {
          const signature = `${job.executionState}:${job.submissionDigest}:${job.fencingToken}:${job.publications?.length ?? 0}`;
          return processedTerminalJobs.get(job.jobId) !== signature;
        })
        .sort((left, right) => left.jobId.localeCompare(right.jobId));
      if (terminal.length === 0) logger.emit('pool-idle', { observedJobs: states.length, retryInMs: pollMs });
      for (const job of terminal) {
        if (signal?.aborted) break;
        if (await purgeOwnsJob(queue, job.jobId)) {
          emitOnce(reported, `purge-owned:${job.jobId}`, logger, 'finalization-skipped-for-purge', {
            jobId: job.jobId,
          });
          continue;
        }
        const result = await processTerminalJob({
          queue,
          job,
          outputRoot: preparedOutput,
          finalize,
          preparePublicationInput,
          baselineStore,
          publishVisual,
          readVisual,
          applyVisual,
          publishMedia,
          publishUnavailableMedia,
          publishGallery,
          publishReport,
          validateReport,
          revalidatePublicationCheckpoint,
          readPublicationCheckpoint,
          preflight,
          outboundPreflightOptions,
          logger,
          now: dependencies.now?.() ?? Date.now(),
          reported,
          signal,
        });
        if (result.outcome === 'invalid') invalid += 1;
        else if (result.outcome === 'retryable') retryable += 1;
        else if (result.outcome === 'unchanged') unchanged += 1;
        else published += 1;
        if (result.outcome !== 'retryable') {
          rememberTerminalJob(
            job.jobId,
            `${job.executionState}:${job.submissionDigest}:${job.fencingToken}:${job.publications?.length ?? 0}`,
          );
        }
      }
      if (!signal?.aborted && cycles < maxCycles) await delay(pollMs, signal);
    }
  } finally {
    signal?.removeEventListener('abort', logDrain);
  }
  if (signal?.aborted) logDrain();
  logger.emit('pool-stopped', { cycles, published, unchanged, invalid, retryable, drained: signal?.aborted === true });
  return { cycles, published, unchanged, invalid, retryable, drained: signal?.aborted === true };
}

function parseArguments(argv, environment) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--queue-root', '--output-root', '--baseline-root', '--finalizer', '--poll-ms'].includes(flag) || !value) {
      fail('SINGLE_SITE_FINALIZER_POOL_USAGE', 'Usage: node scripts/run-single-site-finalizer-pool.mjs --queue-root <path> --output-root <path> --baseline-root <path> [--finalizer <id>] [--poll-ms <milliseconds>]');
    }
    values.set(flag, value);
  }
  return {
    queueRoot: values.get('--queue-root') ?? environment.AUDIT_JOB_QUEUE_ROOT,
    outputRoot: values.get('--output-root') ?? environment.AUDIT_FINALIZATION_OUTPUT_ROOT,
    baselineRoot: values.get('--baseline-root') ?? environment.AUDIT_VISUAL_BASELINE_ROOT,
    finalizerId: values.get('--finalizer') ?? environment.AUDIT_FINALIZER_ID ?? defaultFinalizerId(),
    pollMs: parsePollMilliseconds(values.get('--poll-ms') ?? environment.AUDIT_QUEUE_POLL_MS),
  };
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv, environment);
  if (!options.queueRoot || !options.outputRoot || !options.baselineRoot) {
    fail('SINGLE_SITE_FINALIZER_POOL_USAGE', 'Queue root, finalization output root, and visual baseline root are required.');
  }
  const queue = await openJobQueue({ root: options.queueRoot });
  const controller = new AbortController();
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((name) => [name, () => {
    const error = new Error(`Finalizer pool received ${name}; draining active publication.`);
    error.code = 'SINGLE_SITE_FINALIZER_POOL_SIGNAL';
    controller.abort(error);
  }]));
  for (const [name, handler] of handlers) process.once(name, handler);
  try {
    return await runSingleSiteFinalizerPool({
      queue,
      outputRoot: options.outputRoot,
      baselineRoot: options.baselineRoot,
      finalizerId: options.finalizerId,
      pollMs: options.pollMs,
      signal: controller.signal,
      environment,
    });
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'finalizer-pool-fatal', code: error.code ?? 'FINALIZER_POOL_FATAL', message: safeMessage(error.message) })}\n`);
    process.exitCode = 1;
  });
}
