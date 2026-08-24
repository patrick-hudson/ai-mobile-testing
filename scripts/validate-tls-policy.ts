import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  candidateCertificateBypassAllowed,
  candidateCertificateBypassApplies,
} from '../audit/tls.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productionUrl = 'https://quitting7oh.org';
const candidateUrl = 'https://beta.quitting7oh-org.pages.dev';

assert.equal(candidateCertificateBypassAllowed(candidateUrl, productionUrl), true);
assert.equal(candidateCertificateBypassAllowed(productionUrl, productionUrl), false);
assert.equal(candidateCertificateBypassAllowed('http://quitting7oh.org:8080', productionUrl), false);
assert.equal(candidateCertificateBypassAllowed('https://quitting7oh.org.', 'https://baseline.example'), false);
assert.equal(candidateCertificateBypassAllowed('https://www.quitting7oh.org', 'https://baseline.example'), false);

const originalEnvironment = {
  candidate: process.env.CANDIDATE_URL,
  production: process.env.PRODUCTION_URL,
  ignore: process.env.CANDIDATE_IGNORE_HTTPS_ERRORS,
};
try {
  process.env.CANDIDATE_URL = candidateUrl;
  process.env.PRODUCTION_URL = productionUrl;
  process.env.CANDIDATE_IGNORE_HTTPS_ERRORS = '1';
  assert.equal(candidateCertificateBypassApplies(candidateUrl), true);
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
  /CANDIDATE_IGNORE_HTTPS_ERRORS=1 is forbidden/,
  'The rejected Playwright configuration should explain the protected-host policy.',
);

const allowedConfig = importPlaywrightConfig({
  CANDIDATE_URL: candidateUrl,
  PRODUCTION_URL: productionUrl,
  CANDIDATE_IGNORE_HTTPS_ERRORS: '1',
});
assert.equal(
  allowedConfig.status,
  0,
  `A distinct development candidate should remain eligible for the explicit bypass.\n${allowedConfig.stderr}`,
);

process.stdout.write('TLS policy validation passed: production/protected hosts fail closed and the distinct development candidate remains explicitly eligible.\n');

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
