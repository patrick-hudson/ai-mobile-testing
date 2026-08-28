import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSingleSiteReportPublication,
  readPublishedReportFile,
} from './report-publication.mjs';
import { runnerSpawnIdentity, sanitizedChildEnvironment } from './runner-isolation.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(MODULE_DIR, '..');
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/;
const REVISION = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const STATES = new Set(['pending', 'running', 'completed', 'failed', 'unavailable']);
const MAX_STATUS_BYTES = 128 * 1024;
const MAX_REPORT_FILES = 1_024;
const MAX_REPORT_FILE_BYTES = 512 * 1024;
const MAX_REPORT_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const SECRET_PATTERN = /(?:sk-ant-[A-Za-z0-9_-]{12,}|\b(?:x-api-key|authorization)\s*[:=]\s*[^\s,;]+|[?&](?:token|key|signature|auth)=[^&#\s]+)/i;
const PROHIBITED_OUTPUT_KEYS = new Set([
  'releaseDecision', 'releaseRecommendation', 'promotionDecision', 'promotionAuthorized',
  'approveBaseline', 'revokeBaseline', 'findingWaiver', 'visualDispositionMutation',
  'manualAttestation', 'credentialMutation', 'stopRun', 'purgeRun',
]);

export class SingleSiteAiReviewError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'SingleSiteAiReviewError';
    this.code = code;
    this.details = details;
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function statusDigest(body) {
  return sha256(canonicalJson(body));
}

function isoNow() {
  return new Date().toISOString();
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingleSiteAiReviewError('AI_REVIEW_INVALID', `${label} must be an object.`);
  }
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length || missing.length) {
    throw new SingleSiteAiReviewError('AI_REVIEW_INVALID', `${label} contains unsupported or missing fields.`);
  }
}

function safeJobId(value) {
  if (typeof value !== 'string' || !JOB_ID.test(value)) {
    throw new SingleSiteAiReviewError('AI_REVIEW_INVALID', 'Single-site AI review job ID is invalid.');
  }
  return value;
}

function safeModel(value) {
  if (typeof value !== 'string' || !MODEL.test(value)) {
    throw new SingleSiteAiReviewError('AI_REVIEW_INVALID', 'Single-site AI review model is invalid.');
  }
  return value;
}

function safeRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) {
    throw new SingleSiteAiReviewError('AI_REVIEW_INVALID', 'Single-site AI review request ID is invalid.');
  }
  return value;
}

function safeMessage(value, secrets = []) {
  let message = String(value ?? '').slice(0, 2_000);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[REDACTED]');
  return message
    .replace(/sk-ant-[A-Za-z0-9_-]{12,}/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/(x-api-key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/([?&](?:token|key|signature|auth)=)[^&#\s]+/gi, '$1[REDACTED]');
}

function contained(root, ...parts) {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new SingleSiteAiReviewError('AI_REVIEW_PATH_UNSAFE', 'Single-site AI review path escaped its configured storage root.');
  }
  return target;
}

async function atomicWriteJson(file, value, assertWritable = null) {
  assertWritable?.();
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    assertWritable?.();
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

function withDigest(body) {
  return { ...body, statusDigest: statusDigest(body) };
}

function publicStatus(document) {
  return Object.freeze(structuredClone(document));
}

function validateStatus(document, jobId) {
  exactObject(document, [
    'schemaVersion', 'kind', 'jobId', 'state', 'stateRevision', 'requestId', 'attempt',
    'optIn', 'model', 'requestedAt', 'startedAt', 'finishedAt', 'reportRevision',
    'reportPublicationDigest', 'inputDigest', 'output', 'error', 'retryable', 'statusDigest',
  ], 'Single-site AI review status');
  const { statusDigest: claimed, ...body } = document;
  if (document.schemaVersion !== 1 || document.kind !== 'single-site-ai-advisory-status'
    || document.jobId !== jobId || !STATES.has(document.state)
    || !Number.isSafeInteger(document.stateRevision) || document.stateRevision < 1
    || !REQUEST_ID.test(document.requestId) || !Number.isSafeInteger(document.attempt) || document.attempt < 1
    || typeof document.optIn !== 'boolean' || !MODEL.test(document.model)
    || !REVISION.test(document.reportRevision) || !DIGEST.test(document.reportPublicationDigest)
    || (document.inputDigest !== null && !DIGEST.test(document.inputDigest))
    || claimed !== statusDigest(body)) {
    throw new SingleSiteAiReviewError('AI_REVIEW_STATUS_INVALID', `Single-site AI review status for ${jobId} failed validation.`);
  }
  return publicStatus(document);
}

function statusPath(supervisor, jobId) {
  return join(jobReviewRoot(supervisor, jobId), 'status.json');
}

function jobReviewRoot(supervisor, jobId) {
  const safe = safeJobId(jobId);
  return supervisor.nestedJobSubdirectory
    ? contained(supervisor.root, safe, supervisor.nestedJobSubdirectory)
    : contained(supervisor.root, 'jobs', safe);
}

function jobContainerRoot(supervisor) {
  return supervisor.nestedJobSubdirectory ? supervisor.root : contained(supervisor.root, 'jobs');
}

async function readStatusOrNull(supervisor, jobId) {
  const file = statusPath(supervisor, jobId);
  let stat;
  try { stat = await fs.lstat(file); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_STATUS_BYTES) {
    throw new SingleSiteAiReviewError('AI_REVIEW_STATUS_INVALID', `Single-site AI review status for ${jobId} is unsafe or oversized.`);
  }
  let document;
  try { document = JSON.parse(await fs.readFile(file, 'utf8')); } catch {
    throw new SingleSiteAiReviewError('AI_REVIEW_STATUS_INVALID', `Single-site AI review status for ${jobId} is invalid JSON.`);
  }
  return validateStatus(document, jobId);
}

async function writeStatus(supervisor, body) {
  const assertWritable = () => assertReviewWritable(supervisor, body.jobId);
  assertWritable();
  const document = withDigest(body);
  await atomicWriteJson(statusPath(supervisor, body.jobId), document, assertWritable);
  supervisor.onEvent?.({
    event: 'single-site-ai-review-state',
    jobId: body.jobId,
    state: body.state,
    stateRevision: body.stateRevision,
    at: isoNow(),
  });
  return publicStatus(document);
}

function nextStatus(previous, fields) {
  return {
    schemaVersion: 1,
    kind: 'single-site-ai-advisory-status',
    jobId: previous.jobId,
    state: fields.state,
    stateRevision: previous.stateRevision + 1,
    requestId: previous.requestId,
    attempt: previous.attempt,
    optIn: previous.optIn,
    model: previous.model,
    requestedAt: previous.requestedAt,
    startedAt: fields.startedAt ?? previous.startedAt,
    finishedAt: fields.finishedAt ?? previous.finishedAt,
    reportRevision: previous.reportRevision,
    reportPublicationDigest: previous.reportPublicationDigest,
    inputDigest: fields.inputDigest ?? previous.inputDigest,
    output: fields.output ?? null,
    error: fields.error ?? null,
    retryable: fields.retryable ?? false,
  };
}

export async function openSingleSiteAiReviewSupervisor(options) {
  if (!options || typeof options !== 'object' || !options.root) {
    throw new TypeError('Single-site AI review supervisor requires a storage root.');
  }
  const root = resolve(options.root);
  const nestedJobSubdirectory = options.nestedJobSubdirectory ?? null;
  if (nestedJobSubdirectory !== null
    && (typeof nestedJobSubdirectory !== 'string' || !JOB_ID.test(nestedJobSubdirectory))) {
    throw new TypeError('Single-site AI review nested job subdirectory is invalid.');
  }
  await fs.mkdir(nestedJobSubdirectory ? root : join(root, 'jobs'), { recursive: true, mode: 0o700 });
  const executable = options.reviewerExecutable
    ?? join(REPOSITORY_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  return {
    root,
    nestedJobSubdirectory,
    aiWorkerIdentity: options.aiWorkerIdentity ?? { active: false },
    reviewerExecutable: executable,
    reviewerArgsPrefix: options.reviewerArgsPrefix ?? [join(REPOSITORY_ROOT, 'scripts', 'analyze-run.ts')],
    timeoutMs: boundedInteger(options.timeoutMs, 180_000, 1_000, 10 * 60_000),
    maxReportInputBytes: boundedInteger(options.maxReportInputBytes, MAX_REPORT_INPUT_BYTES, 1_024, 64 * 1024 * 1024),
    onEvent: typeof options.onEvent === 'function' ? options.onEvent : null,
    spawnProcess: options.spawnProcess ?? spawn,
    active: new Map(),
    children: new Map(),
    locks: new Map(),
    purgeFences: new Set(),
    purged: new Set(),
  };
}

function assertReviewWritable(supervisor, jobId) {
  if (supervisor.purgeFences.has(jobId) || supervisor.purged.has(jobId)) {
    throw new SingleSiteAiReviewError('AI_REVIEW_PURGED', 'Single-site AI advisory state is fenced by run purge.');
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`Expected an integer from ${minimum} through ${maximum}.`);
  }
  return number;
}

export async function readSingleSiteAiReview(supervisor, jobId) {
  return readStatusOrNull(supervisor, safeJobId(jobId));
}

function serialize(supervisor, jobId, operation) {
  const previous = supervisor.locks.get(jobId) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  supervisor.locks.set(jobId, current.catch(() => undefined));
  return current;
}

export async function requestSingleSiteAiReview(supervisor, request) {
  exactObject(request, [
    'jobId', 'requestId', 'expectedStateRevision', 'optIn', 'model', 'apiKey',
    'reportDirectory', 'reportRevision', 'reportPublicationDigest',
  ], 'Single-site AI review request');
  const jobId = safeJobId(request.jobId);
  assertReviewWritable(supervisor, jobId);
  const requestId = safeRequestId(request.requestId);
  const model = safeModel(request.model);
  if (typeof request.optIn !== 'boolean' || typeof request.reportDirectory !== 'string'
    || !REVISION.test(request.reportRevision) || !DIGEST.test(request.reportPublicationDigest)
    || !Number.isSafeInteger(request.expectedStateRevision) || request.expectedStateRevision < 0) {
    throw new SingleSiteAiReviewError('AI_REVIEW_INVALID', 'Single-site AI review request fields are invalid.');
  }
  if (request.apiKey !== null && request.apiKey !== undefined
    && (typeof request.apiKey !== 'string' || request.apiKey.length < 20 || request.apiKey.length > 1_024)) {
    throw new SingleSiteAiReviewError('AI_REVIEW_INVALID', 'Anthropic credential is invalid.');
  }
  return serialize(supervisor, jobId, async () => {
    assertReviewWritable(supervisor, jobId);
    const existing = await readStatusOrNull(supervisor, jobId);
    if (existing?.requestId === requestId) return existing;
    const revision = existing?.stateRevision ?? 0;
    if (revision !== request.expectedStateRevision) {
      throw new SingleSiteAiReviewError('AI_REVIEW_CAS_CONFLICT', 'Single-site AI review state revision changed.', {
        expectedStateRevision: request.expectedStateRevision,
        actualStateRevision: revision,
      });
    }
    if (existing && ['pending', 'running'].includes(existing.state)) {
      throw new SingleSiteAiReviewError('AI_REVIEW_BUSY', 'Single-site AI review is already active.');
    }
    const attempt = (existing?.attempt ?? 0) + 1;
    const requestedAt = isoNow();
    const pending = await writeStatus(supervisor, {
      schemaVersion: 1,
      kind: 'single-site-ai-advisory-status',
      jobId,
      state: 'pending',
      stateRevision: revision + 1,
      requestId,
      attempt,
      optIn: request.optIn,
      model,
      requestedAt,
      startedAt: null,
      finishedAt: null,
      reportRevision: request.reportRevision,
      reportPublicationDigest: request.reportPublicationDigest,
      inputDigest: null,
      output: null,
      error: null,
      retryable: false,
    });
    if (!request.optIn) {
      return writeStatus(supervisor, nextStatus(pending, {
        state: 'unavailable', finishedAt: isoNow(), retryable: true,
        error: { code: 'opt-in-required', message: 'This run did not explicitly opt in to AI advisory egress.' },
      }));
    }
    if (!request.apiKey) {
      return writeStatus(supervisor, nextStatus(pending, {
        state: 'unavailable', finishedAt: isoNow(), retryable: true,
        error: { code: 'credential-unavailable', message: 'An Anthropic credential is required at retry time and is never stored with the run.' },
      }));
    }
    if (supervisor.aiWorkerIdentity?.active !== true) {
      return writeStatus(supervisor, nextStatus(pending, {
        state: 'unavailable', finishedAt: isoNow(), retryable: true,
        error: { code: 'isolated-worker-unavailable', message: 'The configured isolated AI worker identity is unavailable.' },
      }));
    }
    const execution = executeReview(supervisor, pending, request).catch(() => undefined);
    supervisor.active.set(jobId, execution);
    execution.finally(() => {
      if (supervisor.active.get(jobId) === execution) supervisor.active.delete(jobId);
    });
    return pending;
  });
}

export async function waitForSingleSiteAiReview(supervisor, jobId) {
  const active = supervisor.active.get(safeJobId(jobId));
  if (active) await active;
  return readStatusOrNull(supervisor, jobId);
}

export async function readSingleSiteAiReviewResult(supervisor, jobId) {
  const status = await readStatusOrNull(supervisor, safeJobId(jobId));
  if (!status || status.state !== 'completed' || !status.output) {
    throw new SingleSiteAiReviewError('AI_REVIEW_NOT_READY', 'The Single-site AI advisory result is not complete.');
  }
  const publicationRoot = contained(supervisor.root, ...status.output.publicationRelativePath.split('/'));
  const publicationFile = await boundedRegularJson(
    join(publicationRoot, 'publication.json'),
    MAX_STATUS_BYTES,
    'AI advisory publication',
    [],
  );
  const publication = publicationFile.document;
  if (!publication || publication.schemaVersion !== 1
    || publication.kind !== 'single-site-ai-advisory-publication'
    || publication.jobId !== status.jobId
    || publication.requestId !== status.requestId
    || publication.model !== status.model
    || publication.reportRevision !== status.reportRevision
    || publication.reportPublicationDigest !== status.reportPublicationDigest
    || publication.publicationDigest !== status.output.publicationDigest) {
    throw new SingleSiteAiReviewError('AI_REVIEW_OUTPUT_INVALID', 'AI advisory publication does not match its durable status.');
  }
  const { publicationDigest, ...publicationBody } = publication;
  if (sha256(canonicalJson(publicationBody)) !== publicationDigest) {
    throw new SingleSiteAiReviewError('AI_REVIEW_OUTPUT_INVALID', 'AI advisory publication digest is invalid.');
  }
  const readBoundFile = async (name, maximumBytes) => {
    const descriptor = publication.files?.[name];
    if (!descriptor || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 2
      || descriptor.bytes > maximumBytes || !DIGEST.test(descriptor.sha256)) {
      throw new SingleSiteAiReviewError('AI_REVIEW_OUTPUT_INVALID', `AI advisory ${name} descriptor is invalid.`);
    }
    const value = await boundedRegularJson(join(publicationRoot, name), maximumBytes, `AI advisory ${name}`, []);
    if (value.source.length !== descriptor.bytes || value.sha256 !== descriptor.sha256) {
      throw new SingleSiteAiReviewError('AI_REVIEW_OUTPUT_INVALID', `AI advisory ${name} failed digest verification.`);
    }
    return value.document;
  };
  const [review, inventory] = await Promise.all([
    readBoundFile('review.json', MAX_REVIEW_BYTES),
    readBoundFile('payload-inventory.json', MAX_INVENTORY_BYTES),
  ]);
  rejectProhibitedKeys(review);
  return Object.freeze({
    schemaVersion: 1,
    mode: 'single-site',
    advisory: true,
    gating: false,
    status,
    publication,
    review,
    inventory,
  });
}

async function prepareInput(supervisor, status, reportDirectory) {
  const publication = await loadSingleSiteReportPublication(reportDirectory, status.reportRevision);
  if (publication.publicationRevision !== status.reportRevision
    || publication.publicationDigest !== status.reportPublicationDigest) {
    throw new SingleSiteAiReviewError('AI_REVIEW_REPORT_BINDING', 'Final report publication does not match the requested immutable revision and digest.');
  }
  const entries = Object.entries(publication.files).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length < 1 || entries.length > MAX_REPORT_FILES) {
    throw new SingleSiteAiReviewError('AI_REVIEW_INPUT_LIMIT', 'Final report publication has an invalid number of compact files.');
  }
  const attemptRoot = contained(jobReviewRoot(supervisor, status.jobId), 'attempts', String(status.attempt));
  const runRoot = join(attemptRoot, 'input');
  const revisionRoot = join(runRoot, 'checklist', 'data', 'revisions', status.reportRevision);
  await fs.rm(attemptRoot, { recursive: true, force: true });
  await fs.mkdir(revisionRoot, { recursive: true, mode: 0o750 });
  await prepareWorkerTraversal(supervisor, status, attemptRoot);
  let totalBytes = 0;
  const inputFiles = [];
  for (const [relativePath, descriptor] of entries) {
    const file = await readPublishedReportFile(publication, relativePath, MAX_REPORT_FILE_BYTES);
    totalBytes += file.bytes;
    if (totalBytes > supervisor.maxReportInputBytes) {
      throw new SingleSiteAiReviewError('AI_REVIEW_INPUT_LIMIT', 'Final report AI input exceeds its total byte limit.');
    }
    const destination = contained(revisionRoot, ...relativePath.split('/'));
    await fs.mkdir(dirname(destination), { recursive: true, mode: 0o750 });
    await fs.writeFile(destination, file.buffer, { mode: 0o440 });
    inputFiles.push({ relativePath, bytes: file.bytes, sha256: descriptor.sha256 });
  }
  const publicationSource = await fs.readFile(join(publication.revisionDirectory, 'publication.json'));
  totalBytes += publicationSource.length * 2;
  if (totalBytes > supervisor.maxReportInputBytes) {
    throw new SingleSiteAiReviewError('AI_REVIEW_INPUT_LIMIT', 'Final report AI input exceeds its total byte limit.');
  }
  await fs.writeFile(join(revisionRoot, 'publication.json'), publicationSource, { mode: 0o440 });
  await fs.writeFile(join(runRoot, 'checklist', 'data', 'current.json'), publicationSource, { mode: 0o440 });
  const manifest = {
    schemaVersion: 1,
    kind: 'single-site-ai-input-publication',
    jobId: status.jobId,
    attempt: status.attempt,
    reportRevision: status.reportRevision,
    reportPublicationDigest: status.reportPublicationDigest,
    totalBytes,
    files: inputFiles,
  };
  const inputDigest = sha256(canonicalJson(manifest));
  await atomicWriteJson(join(attemptRoot, 'input-publication.json'), { ...manifest, inputDigest });
  await makeReadableByWorker(runRoot, supervisor.aiWorkerIdentity);
  const outputRoot = join(attemptRoot, 'worker-output');
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await fs.chown(outputRoot, supervisor.aiWorkerIdentity.uid, supervisor.aiWorkerIdentity.gid);
  return { attemptRoot, runRoot, outputRoot, inputDigest };
}

async function prepareWorkerTraversal(supervisor, status, attemptRoot) {
  const containerRoot = contained(supervisor.root, status.jobId);
  const jobRoot = jobReviewRoot(supervisor, status.jobId);
  const traversal = [
    supervisor.root,
    jobContainerRoot(supervisor),
    ...(supervisor.nestedJobSubdirectory ? [containerRoot] : []),
    jobRoot,
    join(jobRoot, 'attempts'),
    attemptRoot,
  ];
  for (const directory of traversal) {
    await fs.mkdir(directory, { recursive: true, mode: 0o710 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SingleSiteAiReviewError('AI_REVIEW_PATH_UNSAFE', 'AI worker traversal path is not a real directory.');
    }
    await fs.chown(directory, stat.uid, supervisor.aiWorkerIdentity.gid);
    await fs.chmod(directory, 0o710);
  }
}

async function makeReadableByWorker(root, identity) {
  const directories = [];
  async function visit(directory) {
    directories.push(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const item = join(directory, entry.name);
      const stat = await fs.lstat(item);
      if (stat.isSymbolicLink()) throw new SingleSiteAiReviewError('AI_REVIEW_PATH_UNSAFE', 'AI input contains a symbolic link.');
      if (stat.isDirectory()) await visit(item);
      else if (stat.isFile()) {
        await fs.chown(item, stat.uid, identity.gid);
        await fs.chmod(item, 0o440);
      } else throw new SingleSiteAiReviewError('AI_REVIEW_PATH_UNSAFE', 'AI input contains a non-regular entry.');
    }
  }
  await visit(root);
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    const stat = await fs.lstat(directory);
    await fs.chown(directory, stat.uid, identity.gid);
    await fs.chmod(directory, 0o750);
  }
}

async function executeReview(supervisor, pending, request) {
  let status = pending;
  const secrets = [request.apiKey];
  try {
    const prepared = await prepareInput(supervisor, status, request.reportDirectory);
    status = await writeStatus(supervisor, nextStatus(status, {
      state: 'running', startedAt: isoNow(), inputDigest: prepared.inputDigest,
    }));
    const result = await runChild(supervisor, status, request.apiKey, prepared);
    if (result.exitCode !== 0) {
      throw new SingleSiteAiReviewError('AI_REVIEW_CHILD_FAILED', `AI review worker exited with code ${result.exitCode}.`);
    }
    const output = await publishOutput(supervisor, status, prepared.outputRoot, secrets);
    await writeStatus(supervisor, nextStatus(status, {
      state: 'completed', finishedAt: isoNow(), output, retryable: false,
    }));
  } catch (error) {
    const message = safeMessage(error instanceof Error ? error.message : error, secrets);
    await writeStatus(supervisor, nextStatus(status, {
      state: 'failed', finishedAt: isoNow(), retryable: true,
      error: { code: error?.code ?? 'ai-review-failed', message },
    })).catch(() => undefined);
  }
}

function runChild(supervisor, status, apiKey, prepared) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      ...supervisor.reviewerArgsPrefix,
      '--run-dir', prepared.runRoot,
      '--output-dir', prepared.outputRoot,
      '--opt-in',
    ];
    const environment = sanitizedChildEnvironment(process.env, supervisor.aiWorkerIdentity);
    environment.ANTHROPIC_KEY_STDIN = '1';
    environment.ANTHROPIC_MODEL = status.model;
    environment.AI_REVIEW_OPT_IN = '1';
    environment.AUDIT_RUN_ID = status.jobId;
    delete environment.ANTHROPIC_API_KEY;
    let child;
    try {
      child = supervisor.spawnProcess(supervisor.reviewerExecutable, args, {
        cwd: REPOSITORY_ROOT,
        shell: false,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...runnerSpawnIdentity(supervisor.aiWorkerIdentity),
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }
    supervisor.children.set(status.jobId, child);
    let stdout = '';
    let stderr = '';
    const collect = (current, chunk) => (current + chunk.toString()).slice(-MAX_CAPTURE_BYTES);
    child.stdout?.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    child.once('error', rejectPromise);
    let forceTimer = null;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, supervisor.timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (supervisor.children.get(status.jobId) === child) supervisor.children.delete(status.jobId);
      supervisor.onEvent?.({
        event: 'single-site-ai-review-worker-exit',
        jobId: status.jobId,
        exitCode: code,
        signal,
        stdout: safeMessage(stdout, [apiKey]),
        stderr: safeMessage(stderr, [apiKey]),
      });
      resolvePromise({ exitCode: code ?? 1, signal });
    });
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') rejectPromise(error);
    });
    child.stdin.end(`${apiKey}\n`);
  });
}

export async function fenceSingleSiteAiReviewForPurge(supervisor, jobIdValue) {
  const jobId = safeJobId(jobIdValue);
  supervisor.purgeFences.add(jobId);
  const child = supervisor.children.get(jobId);
  let forceTimer = null;
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 2_000);
    forceTimer.unref?.();
  }
  const active = supervisor.active.get(jobId);
  if (active) await active.catch(() => undefined);
  if (forceTimer) clearTimeout(forceTimer);
  if (supervisor.active.get(jobId) === active) supervisor.active.delete(jobId);
  const remaining = supervisor.children.get(jobId);
  if (remaining && remaining.exitCode === null && !remaining.killed) remaining.kill('SIGKILL');
  if (remaining) await supervisor.active.get(jobId)?.catch(() => undefined);
  supervisor.purged.add(jobId);
  return Object.freeze({ jobId, fenced: true, activeDrained: !supervisor.active.has(jobId) });
}

export function releaseSingleSiteAiReviewPurgeFence(supervisor, jobIdValue) {
  const jobId = safeJobId(jobIdValue);
  supervisor.purgeFences.delete(jobId);
  supervisor.purged.delete(jobId);
}

function rejectProhibitedKeys(value, path = 'review') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectProhibitedKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const allowedNullReleaseField = child === null && ['releaseDecision', 'releaseRecommendation'].includes(key);
    if (PROHIBITED_OUTPUT_KEYS.has(key) && !allowedNullReleaseField) {
      throw new SingleSiteAiReviewError('AI_REVIEW_OUTPUT_INVALID', `AI advisory output attempted prohibited field ${path}.${key}.`);
    }
    rejectProhibitedKeys(child, `${path}.${key}`);
  }
}

async function boundedRegularJson(file, maximumBytes, label, secrets) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximumBytes) {
    throw new SingleSiteAiReviewError('AI_REVIEW_OUTPUT_INVALID', `${label} is unsafe or oversized.`);
  }
  const source = await fs.readFile(file);
  const text = source.toString('utf8');
  if (secrets.some((secret) => secret && text.includes(secret)) || SECRET_PATTERN.test(text)) {
    throw new SingleSiteAiReviewError('AI_REVIEW_OUTPUT_SECRET', `${label} contains credential-like data.`);
  }
  let document;
  try { document = JSON.parse(text); } catch {
    throw new SingleSiteAiReviewError('AI_REVIEW_OUTPUT_INVALID', `${label} is invalid JSON.`);
  }
  return { source, document, sha256: sha256(source) };
}

async function publishOutput(supervisor, status, outputRoot, secrets) {
  const assertWritable = () => assertReviewWritable(supervisor, status.jobId);
  assertWritable();
  const review = await boundedRegularJson(join(outputRoot, 'review.json'), MAX_REVIEW_BYTES, 'AI review document', secrets);
  const inventory = await boundedRegularJson(join(outputRoot, 'payload-inventory.json'), MAX_INVENTORY_BYTES, 'AI payload inventory', secrets);
  if (review.document?.schemaVersion !== 1 || review.document?.advisory !== true
    || review.document?.gating !== false || review.document?.source?.mode !== 'single-site'
    || review.document?.source?.runId !== status.jobId
    || review.document?.model !== status.model
    || review.document?.review?.releaseRecommendation !== null) {
    throw new SingleSiteAiReviewError('AI_REVIEW_OUTPUT_INVALID', 'AI review document violated the Single-site advisory-only contract.');
  }
  if (inventory.document?.schemaVersion !== 1 || inventory.document?.mode !== 'single-site'
    || JSON.stringify(inventory.document.capabilities) !== JSON.stringify(['interpret-health-evidence'])) {
    throw new SingleSiteAiReviewError('AI_REVIEW_OUTPUT_INVALID', 'AI payload inventory violated its mode-aware capability contract.');
  }
  rejectProhibitedKeys(review.document);
  if (review.document.status !== 'completed') {
    throw new SingleSiteAiReviewError('AI_REVIEW_PROVIDER_FAILED', 'AI review worker completed without a successful advisory result.');
  }
  const publicationRoot = contained(jobReviewRoot(supervisor, status.jobId), 'publications', status.requestId);
  assertWritable();
  await fs.mkdir(publicationRoot, { recursive: true, mode: 0o700 });
  const files = {
    'review.json': { bytes: review.source.length, sha256: review.sha256 },
    'payload-inventory.json': { bytes: inventory.source.length, sha256: inventory.sha256 },
  };
  assertWritable();
  await fs.writeFile(join(publicationRoot, 'review.json'), review.source, { flag: 'wx', mode: 0o600 });
  assertWritable();
  await fs.writeFile(join(publicationRoot, 'payload-inventory.json'), inventory.source, { flag: 'wx', mode: 0o600 });
  const body = {
    schemaVersion: 1,
    kind: 'single-site-ai-advisory-publication',
    jobId: status.jobId,
    requestId: status.requestId,
    attempt: status.attempt,
    model: status.model,
    reportRevision: status.reportRevision,
    reportPublicationDigest: status.reportPublicationDigest,
    inputDigest: status.inputDigest,
    generatedAt: isoNow(),
    advisory: true,
    gating: false,
    files,
  };
  const publicationDigest = sha256(canonicalJson(body));
  await atomicWriteJson(join(publicationRoot, 'publication.json'), { ...body, publicationDigest }, assertWritable);
  return {
    publicationRelativePath: relative(supervisor.root, publicationRoot).split(sep).join('/'),
    publicationDigest,
    reviewSha256: review.sha256,
    reviewStatus: review.document.status,
    findingCount: Array.isArray(review.document.review?.findings) ? review.document.review.findings.length : 0,
    advisory: true,
    gating: false,
  };
}

export async function recoverSingleSiteAiReviews(supervisor) {
  const jobsRoot = jobContainerRoot(supervisor);
  const results = [];
  for (const entry of await fs.readdir(jobsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
    const status = await readStatusOrNull(supervisor, entry.name).catch((error) => {
      results.push({ jobId: entry.name, state: 'invalid', error: safeMessage(error.message) });
      return null;
    });
    if (!status || !['pending', 'running'].includes(status.state)) continue;
    const recovered = await writeStatus(supervisor, nextStatus(status, {
      state: 'unavailable',
      finishedAt: isoNow(),
      retryable: true,
      error: {
        code: 'interrupted-requires-runtime-secret',
        message: 'The portal restarted during AI review. Retry is available; the runtime credential was intentionally not persisted.',
      },
    }));
    results.push({ jobId: entry.name, state: recovered.state, stateRevision: recovered.stateRevision });
  }
  return results;
}
