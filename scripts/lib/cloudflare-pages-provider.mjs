import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalDigest } from '../../shared/canonical-contract.mjs';
import { parseReleaseArtifactManifest } from '../../shared/release-artifact-contract.mjs';
import { verifyReleaseArtifactManifest } from './release-artifact.mjs';

const SAFE_VERSION = /^4\.[0-9]{1,4}\.[0-9]{1,4}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SOURCE_REVISION = /^[a-f0-9]{7,64}$/u;
const SECRET_PATH = /(?:^|\/)(?:\.git(?:\/|$)|\.env(?:\.|$)|[^/]*(?:credential|private[-_.]?key|secret)[^/]*$)/iu;
const MAXIMUM_OUTPUT_BYTES = 1_048_576;

export class CloudflarePagesProviderError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CloudflarePagesProviderError';
    this.code = code;
  }
}

function fail(code, message, cause) { throw new CloudflarePagesProviderError(code, message, cause); }
function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}
function sanitized(value, secrets = []) {
  let result = String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[REDACTED]');
  return result.slice(-4_096);
}

function validateInput(input, accountId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Cloudflare Pages provider input is required.');
  const manifest = parseReleaseArtifactManifest(input.artifactManifest);
  if (manifest.files.some(({ relativePath }) => SECRET_PATH.test(relativePath))) {
    fail('CLOUDFLARE_ARTIFACT_UNSAFE', 'Release artifact contains a credential-like or repository-control path.');
  }
  if (input.production?.accountId !== accountId) fail('CLOUDFLARE_ACCOUNT_MISMATCH', 'Production account does not match the configured provider account.');
  safeId(input.production?.projectName, 'production.projectName');
  safeId(input.production?.branch, 'production.branch');
  if (typeof input.requestId !== 'string' || input.requestId.length < 16 || input.requestId.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]+$/u.test(input.requestId)) {
    throw new TypeError('Cloudflare Pages requestId is invalid.');
  }
  if (!SOURCE_REVISION.test(input.sourceRevision ?? '')) throw new TypeError('Cloudflare Pages sourceRevision must be a hexadecimal revision.');
  return manifest;
}

async function validateWranglerModule(file) {
  const resolved = path.resolve(file);
  const metadata = await lstat(resolved).catch((error) => fail('CLOUDFLARE_WRANGLER_UNAVAILABLE', 'Pinned Wrangler module is unavailable.', error));
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(resolved) !== resolved) {
    fail('CLOUDFLARE_WRANGLER_UNSAFE', 'Pinned Wrangler module must be a real regular file.');
  }
  return resolved;
}

function runBounded(command, args, { environment, timeoutMs, secrets }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const capture = (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > MAXIMUM_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new CloudflarePagesProviderError('CLOUDFLARE_OUTPUT_LIMIT', 'Wrangler output exceeded the configured byte limit.')));
      } else chunks.push(Buffer.from(chunk));
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', (error) => finish(() => reject(new CloudflarePagesProviderError('CLOUDFLARE_WRANGLER_FAILED', 'Wrangler could not start.', error))));
    child.once('close', (code, signal) => finish(() => {
      const output = sanitized(Buffer.concat(chunks).toString('utf8'), secrets);
      if (code !== 0) reject(new CloudflarePagesProviderError('CLOUDFLARE_DEPLOY_FAILED', `Wrangler exited with ${signal ?? code}. ${output}`));
      else resolve(output);
    }));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new CloudflarePagesProviderError('CLOUDFLARE_DEPLOY_TIMEOUT', 'Wrangler exceeded its execution deadline.')));
    }, timeoutMs);
    timer.unref();
  });
}

export function createCloudflarePagesProvider({
  wranglerModulePath,
  expectedWranglerVersion,
  apiToken,
  accountId,
  environment = {},
  clock = () => new Date(),
} = {}) {
  if (typeof wranglerModulePath !== 'string' || !SAFE_VERSION.test(expectedWranglerVersion ?? '')
    || typeof apiToken !== 'string' || apiToken.length < 20 || apiToken.length > 4_096) {
    throw new TypeError('Cloudflare Pages provider requires a pinned Wrangler module, version, and bounded API token.');
  }
  safeId(accountId, 'accountId');
  let resolvedWrangler = null;
  const childEnvironment = Object.freeze({
    ...process.env,
    ...environment,
    CI: '1',
    CLOUDFLARE_API_TOKEN: apiToken,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  });

  return Object.freeze({
    async prepare(input) {
      validateInput(input, accountId);
      await verifyReleaseArtifactManifest(input.artifactRoot, input.artifactManifest);
      resolvedWrangler = await validateWranglerModule(wranglerModulePath);
      const observed = (await runBounded(process.execPath, [resolvedWrangler, '--version'], {
        environment: childEnvironment, timeoutMs: 30_000, secrets: [apiToken],
      })).trim();
      if (observed !== expectedWranglerVersion) {
        fail('CLOUDFLARE_WRANGLER_VERSION_MISMATCH', `Pinned Wrangler version mismatch: expected ${expectedWranglerVersion}, observed ${observed || 'no version'}.`);
      }
    },
    async deploy(input) {
      const manifest = validateInput(input, accountId);
      if (!resolvedWrangler) fail('CLOUDFLARE_PROVIDER_NOT_PREPARED', 'Cloudflare Pages provider must be prepared before claim consumption.');
      await verifyReleaseArtifactManifest(input.artifactRoot, manifest);
      const args = [
        resolvedWrangler,
        'pages', 'deploy', path.resolve(input.artifactRoot),
        `--project-name=${input.production.projectName}`,
        `--branch=${input.production.branch}`,
        `--commit-hash=${input.sourceRevision}`,
        `--commit-message=AMT exact ${input.requestId}`,
        '--commit-dirty=false',
        '--no-bundle',
        '--install-skills=false',
      ];
      const output = await runBounded(process.execPath, args, {
        environment: childEnvironment, timeoutMs: 15 * 60_000, secrets: [apiToken],
      });
      const urls = output.match(/https:\/\/[A-Za-z0-9.-]+\.pages\.dev/gu) ?? [];
      const expectedSuffix = `.${input.production.projectName}.pages.dev`;
      const deploymentUrl = urls.map((value) => new URL(value).origin)
        .find((value) => new URL(value).hostname.endsWith(expectedSuffix));
      if (!deploymentUrl) fail('CLOUDFLARE_RECEIPT_UNAVAILABLE', 'Wrangler succeeded without a bounded production deployment URL.');
      const deploymentId = new URL(deploymentUrl).hostname.slice(0, -expectedSuffix.length);
      const body = {
        schemaVersion: 1,
        provider: 'cloudflare-pages',
        deploymentId,
        deploymentUrl,
        accountId,
        projectName: input.production.projectName,
        branch: input.production.branch,
        sourceRevision: input.sourceRevision,
        artifactManifestDigest: manifest.digest,
        wranglerVersion: expectedWranglerVersion,
        deliveredAt: clock().toISOString(),
      };
      return Object.freeze({ ...body, digest: canonicalDigest(body) });
    },
  });
}
