#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CONTROL_EXIT_CODES, controlExitCode } from '../shared/control-client-contract.mjs';
import { createCloudflarePagesProvider } from './lib/cloudflare-pages-provider.mjs';
import { readCredentialFile, readPrivateSecretFile } from './lib/credential-file.mjs';
import { executeExactPromotion } from './lib/exact-promotion.mjs';
import { createSharedReleaseHttpClient } from './lib/shared-release-ci.mjs';

const MAXIMUM_JSON_BYTES = 16 * 1_048_576;
const DEFAULT_WRANGLER_VERSION = '4.127.1';

function usage(message) {
  return Object.assign(new Error(message), { code: 'EXACT_PROMOTION_USAGE', exitCode: CONTROL_EXIT_CODES.USAGE });
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined || values[key] !== undefined) throw usage(`Invalid or duplicate option ${key ?? ''}.`);
    values[key] = argv[index + 1];
  }
  if (values['--token'] || values['--cloudflare-token']) throw usage('Secrets are accepted only through mode-0600 files.');
  for (const required of [
    '--server', '--delivery-token-file', '--cloudflare-token-file', '--ci-result-file',
    '--artifact-root', '--artifact-manifest-file', '--candidate-file', '--project-id',
    '--production-account-id', '--production-project', '--production-branch', '--source-revision',
    '--request-id', '--result-file',
  ]) if (!values[required]) throw usage(`${required} is required.`);
  return values;
}

async function readBoundedJson(file, label) {
  const resolved = path.resolve(file);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > MAXIMUM_JSON_BYTES
    || (metadata.mode & 0o022) !== 0) throw usage(`${label} must be a bounded, non-writable regular JSON file.`);
  try { return JSON.parse(await readFile(resolved, 'utf8')); }
  catch { throw usage(`${label} must contain valid JSON.`); }
}

async function writeAtomicResult(file, value) {
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw usage('Result parent must be a real directory.');
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

function defaultWranglerModule() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
}

export async function runExactPromotionCommand(argv, {
  stdout = process.stdout,
  fetchImpl = globalThis.fetch,
  providerFactory = createCloudflarePagesProvider,
} = {}) {
  const options = parseArguments([...argv]);
  const [deliveryToken, cloudflareToken, ciResult, artifactManifest, candidateDeployment] = await Promise.all([
    readCredentialFile(options['--delivery-token-file'], { label: 'Delivery credential' }),
    readPrivateSecretFile(options['--cloudflare-token-file'], { label: 'Cloudflare API token' }),
    readBoundedJson(options['--ci-result-file'], 'Shared release CI result'),
    readBoundedJson(options['--artifact-manifest-file'], 'Release artifact manifest'),
    readBoundedJson(options['--candidate-file'], 'Audited candidate deployment'),
  ]);
  const client = createSharedReleaseHttpClient({
    baseUrl: options['--server'], token: deliveryToken, fetchImpl,
    timeoutMs: Number(options['--request-timeout-ms'] ?? 15_000),
  });
  const provider = providerFactory({
    wranglerModulePath: options['--wrangler-module'] ?? defaultWranglerModule(),
    expectedWranglerVersion: options['--wrangler-version'] ?? DEFAULT_WRANGLER_VERSION,
    apiToken: cloudflareToken,
    accountId: options['--production-account-id'],
  });
  const receipt = await executeExactPromotion({
    ciResult,
    artifactRoot: path.resolve(options['--artifact-root']),
    artifactManifest,
    candidateDeployment,
    projectId: options['--project-id'],
    production: {
      accountId: options['--production-account-id'],
      projectName: options['--production-project'],
      branch: options['--production-branch'],
    },
    sourceRevision: options['--source-revision'],
    requestId: options['--request-id'],
    assertionTtlMs: Number(options['--assertion-ttl-ms'] ?? 60_000),
    client,
    provider,
  });
  await writeAtomicResult(options['--result-file'], receipt);
  stdout.write(`${JSON.stringify(receipt)}\n`);
  return receipt;
}

function safeMessage(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, 1_024);
}

function exitCode(error) {
  if (Number.isSafeInteger(error?.exitCode)) return error.exitCode;
  if (/STALE|SUPERSEDED|EXPIRED/u.test(error?.code ?? '')) return CONTROL_EXIT_CODES.STALE;
  if (/SUBJECT|AUTHORITY|ARTIFACT|CANDIDATE|SOURCE|IDENTITY/u.test(error?.code ?? '')) return CONTROL_EXIT_CODES.IDENTITY_MISMATCH;
  return controlExitCode({ status: error?.status, code: error?.serverCode ?? error?.code });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await runExactPromotionCommand(process.argv.slice(2)).catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : 'EXACT_PROMOTION_FAILED';
    process.stderr.write(`[exact-promotion] ${code}: ${safeMessage(error?.message ?? error)}\n`);
    process.exitCode = exitCode(error);
  });
}
