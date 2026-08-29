import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pipelineOnlyOutcome, readChecklistRelease, releaseOutcome } from './lib/release-truth.mjs';
import { readCredentialFile } from './lib/credential-file.mjs';

const options = parseArguments(process.argv.slice(2));
if (options.server) {
  if (!options.tokenFile) throw new Error('--token-file is required for API release assertion.');
  const token = await readCredentialFile(options.tokenFile, { label: 'Delivery credential' });
  const response = await fetch(new URL(`/api/control/v1/runs/${encodeURIComponent(options.run)}/release/assert`, options.server), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': options.requestId },
    body: JSON.stringify({
      expected: {
        projectId: options.project,
        subjectDigest: options.subject,
        authority: options.authority,
        executionSetDigest: options.executionSetDigest,
        runRevision: options.runRevision,
        decisionRevision: options.decisionRevision,
      },
      ttlMs: options.ttlMs,
    }),
  });
  const document = await response.json();
  console.log(JSON.stringify(document));
  if (!response.ok) {
    console.error(`[assert-release] ${response.status} ${document.error?.code ?? 'REQUEST_FAILED'}: ${document.error?.message ?? response.statusText}`);
    process.exitCode = decisionExit(document.error?.code, response.status);
  }
} else {
let pipelineStatus = 'completed';
if (options.pipelineManifest) {
  const lifecycle = JSON.parse(await readFile(options.pipelineManifest, 'utf8'));
  pipelineStatus = lifecycle.pipeline?.status ?? lifecycle.pipelineStatus ?? 'unavailable';
}
const release = await readChecklistRelease(options.manifest);
const outcome = options.pipelineOnly
  ? pipelineOnlyOutcome(pipelineStatus, release)
  : releaseOutcome(pipelineStatus, release);
console.log(JSON.stringify({
  policy: options.pipelineOnly ? 'PIPELINE_ONLY' : 'LEGACY_EVIDENCE_ONLY',
  policyReason: options.pipelineOnly
    ? 'Pipeline-only validation requires complete evidence, no executed blocking failures, and no run-integrity failure; it does not certify release readiness.'
    : 'A completed evidence pipeline and authoritative READY decision are both required.',
  pipelineStatus,
  releaseDecision: release.decision,
  releaseReason: release.reason,
  outcome: outcome.status,
  authoritativePromotion: false,
  promotionReason: 'Static manifests are diagnostic evidence only; authoritative delivery requires a live single-use promotion claim.',
  manifest: options.manifest,
}));
if (options.pipelineOnly) {
  if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
} else {
  console.error('[assert-release] Static manifest assertion cannot authorize promotion; use --server with the live shared control API.');
  process.exitCode = 13;
}
}

function parseArguments(argv) {
  let manifest;
  let pipelineManifest;
  let pipelineOnly = false;
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest') manifest = argv[++index];
    else if (argument === '--pipeline-manifest') pipelineManifest = argv[++index];
    else if (argument === '--pipeline-only') pipelineOnly = true;
    else if (['--server', '--token-file', '--run', '--project', '--subject', '--authority', '--execution-set-digest', '--request-id'].includes(argument)) values[argument.slice(2)] = argv[++index];
    else if (argument === '--run-revision' || argument === '--decision-revision' || argument === '--ttl-ms') values[argument.slice(2)] = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!manifest && !values.server) throw new Error('--manifest is required.');
  if (values.server && ['run', 'project', 'subject', 'authority', 'execution-set-digest', 'run-revision', 'decision-revision', 'request-id'].some((key) => !values[key])) {
    throw new Error('API assertion requires --run, --project, --subject, --authority, --execution-set-digest, --run-revision, --decision-revision, and --request-id.');
  }
  return {
    manifest: manifest ? resolve(manifest) : null,
    pipelineManifest: pipelineManifest ? resolve(pipelineManifest) : null,
    pipelineOnly,
    server: values.server ?? null,
    tokenFile: values['token-file'] ?? null,
    run: values.run,
    project: values.project,
    subject: values.subject,
    authority: values.authority,
    executionSetDigest: values['execution-set-digest'],
    runRevision: values['run-revision'],
    decisionRevision: values['decision-revision'],
    requestId: values['request-id'],
    ttlMs: values['ttl-ms'] ?? 60_000,
  };
}

function decisionExit(code = '', status = 500) {
  if (/NOT_READY/.test(code)) return 10;
  if (/STALE|SUPERSEDED|EXPIRED/.test(code)) return 11;
  if (/SCOPE|SUBJECT|AUTHORITY|EXECUTION_SET/.test(code)) return 12;
  if (/EMPTY|UNAVAILABLE/.test(code)) return 13;
  return status === 401 || status === 403 ? 3 : 1;
}
