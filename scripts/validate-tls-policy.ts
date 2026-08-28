import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  candidateCertificateBypassAllowed,
  candidateCertificateBypassApplies,
  parsePreviewTlsBypassAllowlist,
  resolveAuditTlsPolicy,
} from '../audit/tls.js';
import { parseRunContract } from '../shared/run-contract.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productionUrl = 'https://quitting7oh.org';
const candidateUrl = 'https://beta.quitting7oh-org.pages.dev';

assert.equal(candidateCertificateBypassAllowed(candidateUrl, productionUrl), false);
assert.equal(candidateCertificateBypassAllowed(productionUrl, productionUrl), false);
assert.equal(candidateCertificateBypassAllowed('http://quitting7oh.org:8080', productionUrl), false);
assert.equal(candidateCertificateBypassAllowed('https://quitting7oh.org.', 'https://baseline.example'), false);
assert.equal(candidateCertificateBypassAllowed('https://www.quitting7oh.org', 'https://baseline.example'), false);

const fullScope = { qualifier: 'FULL' as const, pluginIds: [], auditIds: [], areas: [] };
const comparativeContract = parseRunContract({
  schemaVersion: 1,
  mode: 'comparative',
  productionUrl,
  candidateUrl,
  targetIds: ['candidate-mobile-chromium'],
  scope: fullScope,
});
assert.deepEqual(resolveAuditTlsPolicy(comparativeContract), {
  certificatePolicy: 'strict',
  browserIgnoreHTTPSErrors: false,
  bypassOrigin: null,
  evidenceAuthority: { status: 'authoritative', reasons: [] },
});

const strictPreviewContract = parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: candidateUrl,
  deploymentRole: 'preview',
  certificatePolicy: 'strict',
  targetIds: ['single-site-mobile-chromium'],
  scope: fullScope,
});
assert.equal(resolveAuditTlsPolicy(strictPreviewContract).evidenceAuthority.status, 'authoritative');

const bypassContract = parseRunContract({
  schemaVersion: 1,
  mode: 'single-site',
  url: `${candidateUrl}/`,
  deploymentRole: 'preview',
  certificatePolicy: 'preview-bypass',
  targetIds: ['single-site-mobile-chromium'],
  scope: fullScope,
});
const allowlist = parsePreviewTlsBypassAllowlist(`${candidateUrl}/`);
assert.deepEqual(allowlist, [candidateUrl]);
assert.deepEqual(resolveAuditTlsPolicy(bypassContract, { previewBypassOrigins: allowlist }), {
  certificatePolicy: 'preview-bypass',
  browserIgnoreHTTPSErrors: true,
  bypassOrigin: candidateUrl,
  evidenceAuthority: { status: 'non-authoritative', reasons: ['development-certificate-bypass'] },
});
assert.throws(
  () => resolveAuditTlsPolicy(bypassContract, { previewBypassOrigins: ['https://evil.example'] }),
  /not present in the exact Preview origin allowlist/,
);
assert.throws(
  () => resolveAuditTlsPolicy(bypassContract, { previewBypassOrigins: [`${candidateUrl}.evil.example`] }),
  /not present in the exact Preview origin allowlist/,
);
for (const invalid of [
  'http://beta.example',
  'https://user:secret@beta.example',
  'https://beta.example:8443',
  'https://beta.example/path',
  'https://beta.example?mode=unsafe',
  'https://beta.example#unsafe',
  'https://*.example',
]) {
  assert.throws(() => parsePreviewTlsBypassAllowlist(invalid), /exact HTTPS origin|default port/);
}
assert.throws(
  () => parsePreviewTlsBypassAllowlist(`${candidateUrl},${candidateUrl}/`),
  /must not contain duplicate origins/,
);

const originalEnvironment = {
  candidate: process.env.CANDIDATE_URL,
  production: process.env.PRODUCTION_URL,
  ignore: process.env.CANDIDATE_IGNORE_HTTPS_ERRORS,
};
try {
  process.env.CANDIDATE_URL = candidateUrl;
  process.env.PRODUCTION_URL = productionUrl;
  process.env.CANDIDATE_IGNORE_HTTPS_ERRORS = '1';
  assert.equal(candidateCertificateBypassApplies(candidateUrl), false);
  assert.equal(candidateCertificateBypassApplies(productionUrl), false);
} finally {
  restoreEnvironment('CANDIDATE_URL', originalEnvironment.candidate);
  restoreEnvironment('PRODUCTION_URL', originalEnvironment.production);
  restoreEnvironment('CANDIDATE_IGNORE_HTTPS_ERRORS', originalEnvironment.ignore);
}

const blockedConfig = importPlaywrightConfig({
  CANDIDATE_URL: productionUrl,
  PRODUCTION_URL: productionUrl,
  CANDIDATE_IGNORE_HTTPS_ERRORS: '1',
});
assert.notEqual(blockedConfig.status, 0, 'Playwright configuration must reject a production-host certificate bypass.');
assert.match(
  `${blockedConfig.stdout}\n${blockedConfig.stderr}`,
  /cannot be restricted to the exact candidate origin/,
  'The rejected Playwright configuration should explain why browser-wide bypass is unsafe.',
);

const developmentConfig = importPlaywrightConfig({
  CANDIDATE_URL: candidateUrl,
  PRODUCTION_URL: productionUrl,
  CANDIDATE_IGNORE_HTTPS_ERRORS: '1',
});
assert.notEqual(developmentConfig.status, 0, 'A browser-wide development bypass must fail closed even for a distinct candidate.');
assert.match(`${developmentConfig.stdout}\n${developmentConfig.stderr}`, /cannot be restricted to the exact candidate origin/i);

process.stdout.write('TLS policy validation passed: browser-wide certificate bypass is rejected for every origin and CA-based trust remains strict.\n');

function importPlaywrightConfig(environment: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--eval', "import('./playwright.config.ts')"],
    {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      encoding: 'utf8',
      shell: false,
    },
  );
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
