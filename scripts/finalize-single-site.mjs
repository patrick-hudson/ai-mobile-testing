import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  openJobQueue,
  readJob,
  readJobInput,
  sha256,
} from './lib/job-queue.mjs';
import { assertWorkerInputBoundToState } from './run-single-site-worker.mjs';
import {
  buildSingleSiteReportInput,
  MAX_SINGLE_SITE_PLAYWRIGHT_RESULTS_BYTES,
} from './lib/single-site-report-input.mjs';
import { verifyStructuredEvidencePublication } from './lib/playwright-results-compaction.mjs';
import { openLegacyAuthorityFenceFromEnvironment } from './lib/legacy-authority-fence.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const TERMINAL_STATES = new Set(['completed', 'failed', 'incomplete', 'cancelled']);
const MAX_PUBLICATION_BYTES = 10 * 1_048_576;

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail('SINGLE_SITE_FINALIZER_INVALID', `${label} is invalid.`);
  }
  return value;
}

function contained(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}${path.sep}`);
}

function currentAttemptPublications(state) {
  if (state.attemptNumber === 0) return [];
  const publications = state.publications.filter((entry) => entry.attemptNumber === state.attemptNumber);
  if (publications.length === 0) return [];
  const currentFence = Math.max(...publications.map(({ fencingToken }) => fencingToken));
  return publications
    .filter(({ fencingToken }) => fencingToken === currentFence)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function publicationCheckpoint(state, input) {
  const publications = currentAttemptPublications(state).map((entry) => ({
    publicationId: entry.publicationId,
    relativePath: entry.relativePath,
    digest: entry.digest,
    attemptId: entry.attemptId,
    attemptNumber: entry.attemptNumber,
    fencingToken: entry.fencingToken,
  }));
  const body = {
    schemaVersion: 1,
    kind: 'single-site-publication-checkpoint',
    jobId: state.jobId,
    executionState: state.executionState,
    attemptNumber: state.attemptNumber,
    fencingToken: state.fencingToken,
    inputDocumentDigest: state.inputDocumentDigest,
    submissionDigest: state.submissionDigest,
    publicationsDigest: sha256(publications),
    runContract: structuredClone(input.runContract),
    launchCheckpoint: {
      identityFingerprint: input.launchCheckpoint.identityFingerprint,
      revisionFingerprint: input.launchCheckpoint.revisionFingerprint,
      evidenceAuthority: structuredClone(input.launchCheckpoint.evidenceAuthority),
    },
  };
  return { ...body, checkpointDigest: sha256(body) };
}

export async function readSingleSitePublicationCheckpoint({ queue, jobId }) {
  const state = await readJob(queue, safeIdentifier(jobId, 'jobId'));
  if (!TERMINAL_STATES.has(state.executionState)) {
    fail('SINGLE_SITE_FINALIZER_NOT_READY', `Job ${jobId} is ${state.executionState}, not terminal.`);
  }
  const rawInput = await readJobInput(queue, jobId);
  const input = assertWorkerInputBoundToState(rawInput, state);
  return publicationCheckpoint(state, input);
}

async function readVerifiedPublication(queue, state, publication) {
  const file = path.join(
    queue.root,
    'jobs',
    state.jobId,
    'attempts',
    publication.attemptId,
    'published',
    ...publication.relativePath.split('/'),
  );
  const jobRoot = path.join(queue.root, 'jobs', state.jobId);
  if (!contained(jobRoot, file)) fail('SINGLE_SITE_FINALIZER_ESCAPE', 'Publication path escaped its job directory.');
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('SINGLE_SITE_FINALIZER_EVIDENCE_MISSING', `Publication is missing: ${publication.relativePath}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_PUBLICATION_BYTES) {
    fail('SINGLE_SITE_FINALIZER_EVIDENCE_INVALID', `Publication is empty, unsafe, or oversized: ${publication.relativePath}`);
  }
  const [realJobRoot, realFile] = await Promise.all([fs.realpath(jobRoot), fs.realpath(file)]);
  if (!contained(realJobRoot, realFile)) fail('SINGLE_SITE_FINALIZER_ESCAPE', 'Publication resolved outside its real job directory.');
  let document;
  try {
    document = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    fail('SINGLE_SITE_FINALIZER_EVIDENCE_INVALID', `Publication is invalid JSON: ${publication.relativePath}`);
  }
  const actualDigest = sha256(document);
  if (actualDigest !== publication.digest) {
    fail('SINGLE_SITE_FINALIZER_EVIDENCE_INVALID', `Publication digest changed: ${publication.relativePath}`, {
      expected: publication.digest,
      actual: actualDigest,
    });
  }
  return document;
}

function validateWorkerResult(document, state, publication) {
  if (!isRecord(document)
    || document.schemaVersion !== 1
    || document.kind !== 'single-site-worker-result'
    || document.jobId !== state.jobId
    || document.attemptId !== publication.attemptId
    || document.attemptNumber !== publication.attemptNumber
    || document.fencingToken !== publication.fencingToken
    || !['success', 'assertion-failure', 'infrastructure-failure', 'incomplete'].includes(document.classification)) {
    fail('SINGLE_SITE_FINALIZER_EVIDENCE_INVALID', 'Current worker-result publication does not match its fenced attempt.');
  }
  return document;
}

async function readAttemptResults(queue, state, workerResult) {
  if (!workerResult?.freshEvidence?.fresh
    || workerResult.freshEvidence.relativePath !== 'results.json'
    || typeof workerResult.artifactRoot !== 'string') return { document: undefined, bytes: undefined, artifactRoot: null };
  const jobRoot = path.join(queue.root, 'jobs', state.jobId);
  const artifactRoot = path.resolve(jobRoot, workerResult.artifactRoot);
  const file = path.resolve(artifactRoot, workerResult.freshEvidence.relativePath);
  if (!contained(jobRoot, artifactRoot) || !contained(artifactRoot, file)) return { document: undefined, bytes: undefined, artifactRoot: null };
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return { document: undefined, bytes: undefined, artifactRoot };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0
    || stat.size > MAX_SINGLE_SITE_PLAYWRIGHT_RESULTS_BYTES) {
    return { document: undefined, bytes: undefined, artifactRoot };
  }
  const [realRoot, realFile] = await Promise.all([fs.realpath(jobRoot), fs.realpath(file)]);
  if (!contained(realRoot, realFile)) return { document: undefined, bytes: undefined, artifactRoot };
  const bytes = await fs.readFile(file);
  const actualDigest = sha256(bytes);
  if (actualDigest !== workerResult.freshEvidence.digest) {
    fail('SINGLE_SITE_FINALIZER_EVIDENCE_INVALID', 'The current attempt results.json digest no longer matches the sealed worker result.', {
      expected: workerResult.freshEvidence.digest,
      actual: actualDigest,
    });
  }
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { document: undefined, bytes, artifactRoot };
  }
  const structuredBinding = workerResult.freshEvidence.structuredEvidence;
  const pending = Array.isArray(document?.suites) ? [...document.suites] : [];
  let containsStructuredSidecars = false;
  while (pending.length) {
    const suite = pending.pop();
    if (!isRecord(suite)) continue;
    pending.push(...(Array.isArray(suite.suites) ? suite.suites : []));
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      for (const test of Array.isArray(spec?.tests) ? spec.tests : []) {
        for (const result of Array.isArray(test?.results) ? test.results : []) {
          if ((Array.isArray(result?.attachments) ? result.attachments : []).some((attachment) => (
            typeof attachment?.path === 'string'
            && attachment.path.split(/[\\/]/).includes('structured-evidence')
          ))) containsStructuredSidecars = true;
        }
      }
    }
  }
  if (structuredBinding) {
    try {
      await verifyStructuredEvidencePublication({ artifactRoot, resultsBytes: bytes, binding: structuredBinding });
    } catch (error) {
      fail('SINGLE_SITE_FINALIZER_EVIDENCE_INVALID', `Structured evidence publication is invalid: ${error.message}`);
    }
  } else if (containsStructuredSidecars) {
    fail('SINGLE_SITE_FINALIZER_EVIDENCE_INVALID', 'Compact results reference structured sidecars without a worker-bound evidence manifest.');
  }
  return { document, bytes, artifactRoot };
}

export async function prepareSingleSitePublicationInput({ queue, jobId, generatedAt, mediaStageEvidence = null }) {
  const state = await readJob(queue, safeIdentifier(jobId, 'jobId'));
  if (!TERMINAL_STATES.has(state.executionState)) {
    fail('SINGLE_SITE_FINALIZER_NOT_READY', `Job ${jobId} is ${state.executionState}, not terminal.`);
  }
  const rawInput = await readJobInput(queue, jobId);
  const input = assertWorkerInputBoundToState(rawInput, state);
  let workerResult = null;
  let routeInventoryPublication = null;
  for (const publication of currentAttemptPublications(state)) {
    if (!['worker/attempt-result.json', 'worker/route-inventory.json'].includes(publication.relativePath)) continue;
    const document = await readVerifiedPublication(queue, state, publication);
    if (publication.relativePath === 'worker/attempt-result.json') {
      workerResult = validateWorkerResult(document, state, publication);
    } else {
      routeInventoryPublication = document;
    }
  }
  const results = await readAttemptResults(queue, state, workerResult);
  const reportInput = buildSingleSiteReportInput({
    workerInput: rawInput,
    terminalState: state,
    workerResult,
    playwrightResults: results.document,
    playwrightResultsBytes: results.bytes,
    ...(mediaStageEvidence ? {
      processedPlaywrightResults: mediaStageEvidence.playwrightResults,
      processedPlaywrightResultsBytes: mediaStageEvidence.playwrightResultsBytes,
    mediaStage: mediaStageEvidence.manifest,
    } : {}),
    routeInventoryPublication,
    generatedAt,
  });
  return {
    reportInput,
    playwrightResults: results.document ?? { suites: [], errors: [] },
    playwrightResultsBytes: results.bytes ?? null,
    sourceResultsDigest: workerResult?.freshEvidence?.digest ?? null,
    artifactRoot: results.artifactRoot ?? path.join(queue.root, 'jobs', jobId),
    terminalState: state,
    workerResult,
    routeInventoryPublication,
    publicationCheckpoint: publicationCheckpoint(state, input),
  };
}

export async function prepareSingleSiteReportInput(options) {
  return (await prepareSingleSitePublicationInput(options)).reportInput;
}

function summaryResultKind(state, workerResult) {
  if (state.executionState === 'cancelled') return 'cancelled';
  if (state.result?.kind) return state.result.kind;
  return workerResult?.classification ?? 'unknown';
}

export async function finalizeSingleSiteJobs({ queue, jobIds }) {
  if (!Array.isArray(jobIds) || jobIds.length === 0) fail('SINGLE_SITE_FINALIZER_INVALID', 'At least one job ID is required.');
  const normalizedJobIds = jobIds.map((jobId) => safeIdentifier(jobId, 'jobId'));
  if (new Set(normalizedJobIds).size !== normalizedJobIds.length) fail('SINGLE_SITE_FINALIZER_INVALID', 'Finalizer job IDs cannot contain duplicates.');
  const rows = [];
  for (const jobId of [...normalizedJobIds].sort()) {
    const state = await readJob(queue, jobId);
    if (!TERMINAL_STATES.has(state.executionState)) {
      fail('SINGLE_SITE_FINALIZER_NOT_READY', `Job ${jobId} is ${state.executionState}, not terminal.`);
    }
    const rawInput = await readJobInput(queue, jobId);
    const input = assertWorkerInputBoundToState(rawInput, state);
    const currentPublications = currentAttemptPublications(state);
    const verifiedPublications = [];
    let workerResult = null;
    for (const publication of currentPublications) {
      const document = await readVerifiedPublication(queue, state, publication);
      if (publication.relativePath === 'worker/attempt-result.json') {
        workerResult = validateWorkerResult(document, state, publication);
      }
      verifiedPublications.push({
        publicationId: publication.publicationId,
        relativePath: publication.relativePath,
        digest: publication.digest,
        attemptId: publication.attemptId,
        attemptNumber: publication.attemptNumber,
        fencingToken: publication.fencingToken,
      });
    }
    if (state.executionState === 'completed' && workerResult === null) {
      fail('SINGLE_SITE_FINALIZER_EVIDENCE_MISSING', `Completed job ${jobId} lacks a current worker result.`);
    }
    rows.push({
      jobId,
      inputDocumentDigest: state.inputDocumentDigest,
      submissionDigest: state.submissionDigest,
      runContractDigest: state.runContractDigest,
      compiledManifestDigest: state.compiledManifestDigest,
      preflightDigest: state.preflightDigest,
      identityFingerprint: state.identityFingerprint,
      revisionFingerprint: state.revisionFingerprint,
      evidenceAuthority: structuredClone(state.evidenceAuthority),
      registryRevision: state.registryRevision,
      targetSetRevision: state.targetSetRevision,
      runnerRevision: state.runnerRevision,
      executionState: state.executionState,
      resultKind: summaryResultKind(state, workerResult),
      attemptNumber: state.attemptNumber,
      fencingToken: state.fencingToken,
      infrastructureRetriesUsed: state.infrastructureRetriesUsed,
      selectedTargetIds: [...input.selectedTargetIds],
      selectedCaseCount: input.selectedCaseIds.length,
      publications: verifiedPublications,
    });
  }

  const runContractDigests = new Set(rows.map(({ runContractDigest }) => runContractDigest));
  const manifestDigests = new Set(rows.map(({ compiledManifestDigest }) => compiledManifestDigest));
  if (runContractDigests.size !== 1 || manifestDigests.size !== 1) {
    fail('SINGLE_SITE_FINALIZER_MIXED_RUN', 'Finalizer cannot combine jobs from different run contracts or coverage manifests.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'single-site-finalization',
    mode: 'single-site',
    runContractDigest: rows[0].runContractDigest,
    compiledManifestDigest: rows[0].compiledManifestDigest,
    jobs: rows,
    counts: {
      jobs: rows.length,
      completed: rows.filter(({ executionState }) => executionState === 'completed').length,
      incomplete: rows.filter(({ executionState }) => executionState === 'incomplete').length,
      failed: rows.filter(({ executionState }) => executionState === 'failed').length,
      cancelled: rows.filter(({ executionState }) => executionState === 'cancelled').length,
      passed: rows.filter(({ resultKind }) => resultKind === 'passed').length,
      findings: rows.filter(({ resultKind }) => resultKind === 'findings').length,
    },
  };
  return { ...body, finalizationDigest: sha256(body) };
}

async function atomicWriteFinalization(file, document) {
  const absolute = path.resolve(file);
  const directory = path.dirname(absolute);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(absolute)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${canonicalJson(document)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, absolute);
    const directoryHandle = await fs.open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--queue-root', '--jobs', '--output'].includes(flag) || !value) {
      fail('SINGLE_SITE_FINALIZER_USAGE', 'Usage: node scripts/finalize-single-site.mjs --queue-root <path> --jobs <job-a,job-b> --output <file>');
    }
    values.set(flag, value);
  }
  return {
    queueRoot: values.get('--queue-root') ?? process.env.AUDIT_JOB_QUEUE_ROOT,
    jobIds: String(values.get('--jobs') ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    output: values.get('--output'),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options.queueRoot || !options.output || options.jobIds.length === 0) {
    fail('SINGLE_SITE_FINALIZER_USAGE', 'Queue root, job IDs, and output path are required.');
  }
  const queue = await openJobQueue({ root: options.queueRoot });
  process.stdout.write(`${JSON.stringify({ event: 'finalizer-started', jobs: options.jobIds.length, output: path.resolve(options.output) })}\n`);
  const legacyAuthorityFence = await openLegacyAuthorityFenceFromEnvironment(process.env);
  let document;
  const publish = async () => {
    document = await finalizeSingleSiteJobs({ queue, jobIds: options.jobIds });
    await atomicWriteFinalization(options.output, document);
  };
  if (legacyAuthorityFence) await legacyAuthorityFence.withAuthority('single-site-finalization', publish);
  else await publish();
  process.stdout.write(`${JSON.stringify({
    event: 'finalizer-finished',
    finalizationDigest: document.finalizationDigest,
    counts: document.counts,
  })}\n`);
  return document;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'finalizer-failed', code: error.code ?? 'SINGLE_SITE_FINALIZER_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  });
}
