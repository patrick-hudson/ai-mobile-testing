#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { CONTROL_EXIT_CODES, controlExitCode } from '../shared/control-client-contract.mjs';
import { parseRunContract } from '../shared/run-contract.mjs';
import { readCredentialFile } from './lib/credential-file.mjs';
import { createSharedReleaseHttpClient, runSharedReleaseCi } from './lib/shared-release-ci.mjs';

const MAXIMUM_INTENT_BYTES = 64 * 1_024;

function usage(message) {
  return Object.assign(new Error(message), { code: 'SHARED_RELEASE_CI_USAGE', exitCode: CONTROL_EXIT_CODES.USAGE });
}

function integer(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw usage(`${label} is invalid.`);
  return parsed;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined) throw usage(`Invalid option ${key ?? ''}.`);
    if (options[key] !== undefined) throw usage(`Duplicate option ${key}.`);
    options[key] = argv[index + 1];
  }
  if (options['--token']) throw usage('Use --token-file; command-line secrets are refused.');
  for (const required of ['--server', '--token-file', '--intent-file', '--result-file']) {
    if (!options[required]) throw usage(`${required} is required.`);
  }
  return options;
}

async function readIntentFile(file) {
  const resolved = path.resolve(file);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAXIMUM_INTENT_BYTES
    || (metadata.mode & 0o777) !== 0o600) {
    throw usage('Intent file must be a bounded, regular mode-0600 file.');
  }
  let value;
  try { value = JSON.parse(await readFile(resolved, 'utf8')); }
  catch { throw usage('Intent file must contain valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || value.schemaVersion !== 1 || !value.runContract) {
    throw usage('Intent file must contain only schemaVersion and runContract.');
  }
  return Object.freeze({ schemaVersion: 1, runContract: parseRunContract(value.runContract) });
}

async function writeAtomicResult(file, value) {
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw usage('Result parent must be a regular directory.');
  const temporary = path.join(parent, `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    await rename(temporary, resolved);
    const directory = await open(parent, fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function stableRequestId(intent) {
  return `shared-release-ci-${canonicalDigest(intent).replace(/^sha256:/u, '').slice(0, 32)}`;
}

function safeResult(requestId, result) {
  const decision = result.publication.decision;
  return Object.freeze({
    schemaVersion: 1,
    kind: 'shared-release-ci-result',
    confirmed: true,
    requestId,
    operationId: result.operationId,
    runId: result.runId,
    publicationDigest: result.publication.digest,
    subjectDigest: result.publication.finalSubjectDigest,
    executionSetDigest: decision.executionManifestDigest,
    decision: Object.freeze({
      code: decision.code,
      ready: decision.ready,
      authority: decision.grantedAuthority,
      runRevision: result.publication.runRevision,
      decisionRevision: result.publication.decisionRevision,
    }),
    assertionExpected: result.assertionExpected,
  });
}

export async function runSharedReleaseCiCommand(argv, {
  stdout = process.stdout,
  fetchImpl = globalThis.fetch,
  preflight,
  preflightOptions,
} = {}) {
  const options = parseArguments([...argv]);
  const intent = await readIntentFile(options['--intent-file']);
  const requestId = options['--request-id'] ?? stableRequestId(intent);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(requestId)) throw usage('--request-id is invalid.');
  const token = await readCredentialFile(options['--token-file'], { label: 'Control credential' });
  const maximumLaunchPolls = integer(options['--max-launch-polls'] ?? '600', 1, 10_000, '--max-launch-polls');
  const maximumPublicationPolls = integer(options['--max-publication-polls'] ?? '3600', 1, 20_000, '--max-publication-polls');
  const pollMs = integer(options['--poll-ms'] ?? '1000', 0, 60_000, '--poll-ms');
  const timeoutMs = integer(options['--request-timeout-ms'] ?? '15000', 100, 120_000, '--request-timeout-ms');
  const maximumResponseBytes = integer(options['--max-response-bytes'] ?? String(8 * 1_048_576), 1_024, 16 * 1_048_576, '--max-response-bytes');
  const client = createSharedReleaseHttpClient({
    baseUrl: options['--server'], token, fetchImpl, preflight, preflightOptions,
    timeoutMs, maximumResponseBytes,
  });
  const result = await runSharedReleaseCi({
    client, requestId, intent, maximumLaunchPolls, maximumPublicationPolls, pollMs,
  });
  const document = safeResult(requestId, result);
  await writeAtomicResult(options['--result-file'], document);
  stdout.write(`${JSON.stringify(document)}\n`);
  if (!document.decision.ready) {
    throw Object.assign(new Error(`Current release decision is ${document.decision.code}.`), {
      code: 'CI_DECISION_NOT_READY',
      exitCode: CONTROL_EXIT_CODES.NOT_READY,
    });
  }
  return document;
}

function exitCode(error) {
  if (Number.isSafeInteger(error?.exitCode)) return error.exitCode;
  if (error?.code === 'CI_COMPILATION_PENDING' || error?.code === 'CI_WORK_NOT_TERMINAL'
    || error?.code === 'CI_PUBLICATION_MISSING') return CONTROL_EXIT_CODES.TIMEOUT;
  if (/TARGET|IDENTITY|SUBJECT|AUTHORITY|MANIFEST_WORK|LAUNCH_RUN/u.test(error?.code ?? '')) {
    return CONTROL_EXIT_CODES.IDENTITY_MISMATCH;
  }
  if (/PUBLICATION_(?:STALE|CHANGED|NOT_CAUGHT_UP)/u.test(error?.code ?? '')) return CONTROL_EXIT_CODES.STALE;
  if (/PUBLICATION|EVIDENCE|RESPONSE_TOO_LARGE/u.test(error?.code ?? '')) return CONTROL_EXIT_CODES.EVIDENCE_UNAVAILABLE;
  return controlExitCode({ status: error?.status, code: error?.serverCode ?? error?.code });
}

function safeMessage(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, 1_024);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await runSharedReleaseCiCommand(process.argv.slice(2)).catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : 'SHARED_RELEASE_CI_FAILED';
    process.stderr.write(`[shared-release-ci] ${code}: ${safeMessage(error?.message ?? error)}\n`);
    process.exitCode = exitCode(error);
  });
}
