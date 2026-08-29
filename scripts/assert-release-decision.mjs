#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pipelineOnlyOutcome, readChecklistRelease, releaseOutcome } from './lib/release-truth.mjs';
import { openPromotionClaimOutput, readCredentialFile } from './lib/credential-file.mjs';
import { CONTROL_EXIT_CODES, controlExitCode } from '../shared/control-client-contract.mjs';

await main().catch((error) => {
  const code = typeof error?.code === 'string' ? error.code : 'ASSERT_RELEASE_FAILED';
  const message = safeMessage(error?.message ?? error);
  writeJson({ schemaVersion: 1, error: { code, message } });
  process.stderr.write(`[assert-release] ${code}: ${message}\n`);
  process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : CONTROL_EXIT_CODES.REQUEST_FAILED;
});

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.server) return assertLiveRelease(options);
  return assertStaticEvidence(options);
}

async function assertLiveRelease(options) {
  if (!options.tokenFile) throw usage('--token-file is required for API release assertion.');
  if (!options.claimTokenFile) throw usage('--claim-token-file is required for API release assertion.');
  const token = await readCredentialFile(options.tokenFile, { label: 'Delivery credential' });
  const claimOutput = await openPromotionClaimOutput(options.claimTokenFile);
  try {
    const response = await fetch(new URL(`/api/control/v1/runs/${encodeURIComponent(options.run)}/release/assert`, options.server), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': options.requestId,
      },
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
    let document;
    let validJson = true;
    try { document = await response.json(); } catch {
      validJson = false;
      document = {
        schemaVersion: 1,
        error: { code: 'INVALID_RESPONSE', message: 'Shared control API did not return JSON.' },
      };
    }
    if (response.ok && validJson) {
      await claimOutput.write(document.data?.token);
      document = {
        ...document,
        data: { ...document.data, token: undefined, claimTokenPath: claimOutput.path },
      };
    } else {
      await claimOutput.abort();
    }
    writeJson(document);
    if (!response.ok || !validJson) {
      process.stderr.write(`[assert-release] ${response.status} ${document.error?.code ?? 'REQUEST_FAILED'}: ${safeMessage(document.error?.message ?? response.statusText)}\n`);
      process.exitCode = validJson
        ? controlExitCode({ status: response.status, code: document.error?.code })
        : CONTROL_EXIT_CODES.REQUEST_FAILED;
    }
  } catch (error) {
    await claimOutput.abort();
    throw error;
  }
}

async function assertStaticEvidence(options) {
  let pipelineStatus = 'completed';
  if (options.pipelineManifest) {
    const lifecycle = JSON.parse(await readFile(options.pipelineManifest, 'utf8'));
    pipelineStatus = lifecycle.pipeline?.status ?? lifecycle.pipelineStatus ?? 'unavailable';
  }
  const release = await readChecklistRelease(options.manifest);
  const outcome = options.pipelineOnly
    ? pipelineOnlyOutcome(pipelineStatus, release)
    : releaseOutcome(pipelineStatus, release);
  writeJson({
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
  });
  if (options.pipelineOnly) {
    if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;
  } else {
    process.stderr.write('[assert-release] Static manifest assertion cannot authorize promotion; use --server with the live shared control API.\n');
    process.exitCode = CONTROL_EXIT_CODES.EVIDENCE_UNAVAILABLE;
  }
}

function parseArguments(argv) {
  let manifest;
  let pipelineManifest;
  let pipelineOnly = false;
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest') manifest = requiredValue(argv, ++index, argument);
    else if (argument === '--pipeline-manifest') pipelineManifest = requiredValue(argv, ++index, argument);
    else if (argument === '--pipeline-only') pipelineOnly = true;
    else if (['--server', '--token-file', '--claim-token-file', '--run', '--project', '--subject', '--authority', '--execution-set-digest', '--request-id'].includes(argument)) {
      values[argument.slice(2)] = requiredValue(argv, ++index, argument);
    } else if (argument === '--run-revision' || argument === '--decision-revision' || argument === '--ttl-ms') {
      values[argument.slice(2)] = Number(requiredValue(argv, ++index, argument));
    } else throw usage(`Unknown argument: ${argument}`);
  }
  if (!manifest && !values.server) throw usage('--manifest is required.');
  if (values.server && ['run', 'project', 'subject', 'authority', 'execution-set-digest', 'run-revision', 'decision-revision', 'request-id'].some((key) => !values[key])) {
    throw usage('API assertion requires --run, --project, --subject, --authority, --execution-set-digest, --run-revision, --decision-revision, and --request-id.');
  }
  for (const key of ['run-revision', 'decision-revision']) {
    if (values.server && (!Number.isSafeInteger(values[key]) || values[key] < 1)) throw usage(`--${key} must be a positive integer.`);
  }
  if (values['ttl-ms'] !== undefined && (!Number.isSafeInteger(values['ttl-ms']) || values['ttl-ms'] < 1 || values['ttl-ms'] > 300_000)) {
    throw usage('--ttl-ms must be an integer from 1 through 300000.');
  }
  return {
    manifest: manifest ? resolve(manifest) : null,
    pipelineManifest: pipelineManifest ? resolve(pipelineManifest) : null,
    pipelineOnly,
    server: values.server ?? null,
    tokenFile: values['token-file'] ?? null,
    claimTokenFile: values['claim-token-file'] ?? null,
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

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw usage(`${flag} requires a value.`);
  return value;
}

function usage(message) {
  return Object.assign(new Error(message), { code: 'ASSERT_RELEASE_USAGE', exitCode: CONTROL_EXIT_CODES.USAGE });
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeMessage(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, 1_024);
}
