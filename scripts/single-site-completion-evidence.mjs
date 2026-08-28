import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, openJobQueue, readJobInput, sha256 } from './lib/job-queue.mjs';
import { readBetaProofEvidenceBundle } from './run-beta-single-site-proof.mjs';
import { validateSingleSiteWorkerInput } from './run-single-site-worker.mjs';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_JOBS = 8;
const MAX_DOCUMENT_BYTES = 8 * 1_048_576;
const scriptPath = fileURLToPath(import.meta.url);

function usage() {
  return 'Usage: node scripts/single-site-completion-evidence.mjs --jobs <job-a,job-b> [--queue-root <path>] [--finalization-root <path>] [--output <file>]\n';
}

function parseArguments(argv, environment = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.length % 2 !== 0) throw new Error(usage().trim());
  const values = new Map();
  const allowed = new Set(['--jobs', '--queue-root', '--finalization-root', '--output']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || values.has(flag)) throw new Error(usage().trim());
    values.set(flag, value);
  }
  const jobs = String(values.get('--jobs') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (jobs.length < 1 || jobs.length > MAX_JOBS || new Set(jobs).size !== jobs.length || jobs.some((jobId) => !JOB_ID.test(jobId))) {
    throw new Error(`--jobs must name 1 through ${MAX_JOBS} unique durable job IDs.`);
  }
  const queueRoot = values.get('--queue-root')
    ?? environment.PORTAL_SINGLE_SITE_QUEUE_ROOT ?? environment.AUDIT_JOB_QUEUE_ROOT;
  const finalizationRoot = values.get('--finalization-root')
    ?? environment.PORTAL_SINGLE_SITE_FINALIZATION_ROOT ?? environment.AUDIT_FINALIZATION_OUTPUT_ROOT;
  if (!queueRoot || !finalizationRoot) throw new Error('Queue and finalization roots are required.');
  return {
    help: false,
    jobs,
    queueRoot: path.resolve(queueRoot),
    finalizationRoot: path.resolve(finalizationRoot),
    output: values.has('--output') ? path.resolve(values.get('--output')) : null,
  };
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function buildSingleSiteCompletionEvidence({ generatedAt, runs }) {
  if (typeof generatedAt !== 'string' || new Date(generatedAt).toISOString() !== generatedAt
    || !Array.isArray(runs) || runs.length < 1 || runs.length > MAX_JOBS) {
    throw new TypeError('Completion evidence requires a canonical timestamp and a bounded run list.');
  }
  const body = {
    schemaVersion: 1,
    kind: 'single-site-completion-evidence',
    generatedAt,
    advisory: true,
    promotion: { authorized: false, blocking: false, effect: 'none' },
    runs,
    identityQualification: {
      runnerRevision: 'Content-derived runner/source revision embedded in the image; not an OCI Image ID or RepoDigest.',
      visualIdentity: 'Exact baseline identity and mutation history remain separate durable baseline-store evidence.',
    },
    acceptedLimitations: [
      'Single-site results neither authorize nor block promotion.',
      'Preview certificate bypass evidence is non-authoritative.',
      'One portal and one Single-site finalizer are supported; a single job is not distributed across worker containers.',
      'Run and baseline cleanup is explicit; automatic age-based garbage collection is not implemented.',
      'Browser mobile targets are emulations; physical-device and assistive-technology acceptance remain manual.',
      'Named-volume evidence must be exported before its Docker volumes are removed.',
      'This manifest does not prove baseline approval or REVIEWED disposition history; bind those stores separately.',
    ],
  };
  const document = { ...body, completionEvidenceDigest: sha256(body) };
  if (Buffer.byteLength(canonicalJson(document)) > MAX_DOCUMENT_BYTES) {
    throw new Error('Completion evidence exceeds its bounded document size.');
  }
  return Object.freeze(document);
}

export function validateSingleSiteCompletionEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.kind !== 'single-site-completion-evidence'
    || typeof value.completionEvidenceDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.completionEvidenceDigest)
    || !Array.isArray(value.runs) || value.runs.length < 1 || value.runs.length > MAX_JOBS) {
    throw new TypeError('Single-site completion evidence is malformed.');
  }
  const expectedKeys = [
    'schemaVersion', 'kind', 'generatedAt', 'advisory', 'promotion', 'runs',
    'identityQualification', 'acceptedLimitations', 'completionEvidenceDigest',
  ];
  if (Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')
    || new Date(value.generatedAt).toISOString() !== value.generatedAt
    || value.advisory !== true || value.promotion?.authorized !== false
    || value.promotion?.blocking !== false || value.promotion?.effect !== 'none') {
    throw new TypeError('Single-site completion evidence has invalid top-level claims.');
  }
  const { completionEvidenceDigest, ...body } = value;
  if (sha256(body) !== completionEvidenceDigest) throw new Error('Single-site completion evidence digest is invalid.');
  return value;
}

async function atomicWrite(file, document) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonicalJson(document)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv, environment);
  if (options.help) {
    process.stdout.write(usage());
    return null;
  }
  const queue = await openJobQueue({ root: options.queueRoot });
  const runs = [];
  for (const jobId of options.jobs) {
    const [bundle, rawInput] = await Promise.all([
      readBetaProofEvidenceBundle(options.finalizationRoot, jobId, { queue }),
      readJobInput(queue, jobId),
    ]);
    if (!bundle) throw new Error(`Job ${jobId} has no durable beta proof receipt.`);
    const input = validateSingleSiteWorkerInput(rawInput);
    const manifest = input.coverageManifest;
    runs.push({
      jobId,
      scenario: bundle.receipt.scenario,
      receiptDigest: bundle.receipt.receiptDigest,
      receipt: bundle.receipt,
      coverage: {
        manifestDigest: manifest.manifestDigest,
        status: manifest.coverageStatus,
        selectedDefinitions: count(manifest.counts?.selectedDefinitions),
        executableCases: count(manifest.counts?.executableCases),
        plannedExecutions: count(manifest.counts?.plannedExecutions),
        coverageGaps: Array.isArray(manifest.coverageGaps) ? manifest.coverageGaps.length : null,
        omittedDefinitions: Array.isArray(manifest.omissions?.definitions) ? manifest.omissions.definitions.length : null,
        omittedCases: Array.isArray(manifest.omissions?.cases) ? manifest.omissions.cases.length : null,
        omittedTargets: Array.isArray(manifest.omissions?.targets) ? manifest.omissions.targets.length : null,
      },
      verified: bundle.evidence,
    });
  }
  const document = buildSingleSiteCompletionEvidence({ generatedAt: new Date().toISOString(), runs });
  if (options.output) await atomicWrite(options.output, document);
  process.stdout.write(`${canonicalJson(document)}\n`);
  return document;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'single-site-completion-evidence-failed', message: error.message })}\n`);
    process.exitCode = 1;
  });
}
