import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalSha256 } from '../shared/run-compiler.mjs';
import { reconcileSingleSiteRouteInventory } from '../shared/single-site-route-plan.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-generic-registration-'));
try {
  const coverageManifestDigest = `sha256:${'b'.repeat(64)}`;
  const planBody = {
    schemaVersion: 1,
    kind: 'single-site-route-inventory-plan',
    coverageManifestDigest,
    required: true,
    reason: 'Fixture route coverage requires discovery.',
    reviewedRoutes: [],
    entryPoints: ['/'],
    canonicalTargetId: 'single-site-desktop-chromium',
  };
  const plan = { ...planBody, planDigest: canonicalSha256(planBody) };
  const origin = 'https://beta.example.test';
  const diagnostic = {
    schemaVersion: 1,
    kind: 'live-route-inventory-diagnostic',
    origin,
    capabilities: { scriptExecution: false, browserRendering: false, formSubmission: false, productOracleDerivation: false, findingDerivation: false },
    limits: {},
    sources: {},
    fetchEvidence: [],
    failures: [],
    exclusions: [],
    limitations: [],
    inventory: {
      schemaVersion: 1,
      origin,
      limits: {},
      sources: [],
      routes: [{
        url: `${origin}/new-route`, path: '/new-route', query: '', disposition: 'included',
        sources: [{ source: 'sitemap', from: `${origin}/sitemap.xml`, depth: 0 }],
      }],
      exclusions: [],
      failures: [],
      limitations: [],
      responses: [{ url: `${origin}/new-route`, depth: 0, status: 200, contentType: 'text/html', bytes: 100 }],
      redirects: [],
      bounds: [],
      summary: { routes: 1, exclusions: 0, failures: 0, limitations: 0, responses: 1, redirects: 0, htmlBytesConsumed: 100 },
    },
  };
  const publication = reconcileSingleSiteRouteInventory({
    jobId: 'job-registration-fixture',
    attemptId: 'attempt-registration-fixture',
    coverageManifestDigest,
    plan,
    diagnostic,
  });
  const publicationPath = path.join(temporaryRoot, 'route-inventory.json');
  await fs.writeFile(publicationPath, `${JSON.stringify(publication)}\n`);
  const executable = path.join(repositoryRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
  const stdoutPath = path.join(temporaryRoot, 'playwright-list.stdout');
  const stderrPath = path.join(temporaryRoot, 'playwright-list.stderr');
  const stdoutHandle = await fs.open(stdoutPath, 'w');
  const stderrHandle = await fs.open(stderrPath, 'w');
  let completion;
  try {
    completion = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['test', '--list'], {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AUDIT_RUN_MODE: 'single-site',
          AUDIT_SINGLE_SITE_URL: origin,
          AUDIT_SINGLE_SITE_ROLE: 'preview',
          AUDIT_SINGLE_SITE_CERTIFICATE_POLICY: 'strict',
          AUDIT_TARGET_IDS: 'single-site-desktop-chromium',
          AUDIT_SINGLE_SITE_CASE_IDS: '["ENV-002:tests/contracts.spec.ts:candidate-desktop-chromium"]',
          AUDIT_SINGLE_SITE_ROUTE_INVENTORY: publicationPath,
          AUDIT_SINGLE_SITE_GENERIC_TARGET_ID: 'single-site-desktop-chromium',
          AUDIT_SINGLE_SITE_EGRESS_PROXY: 'http://127.0.0.1:1',
          AUDIT_ARTIFACT_DIR: path.join(temporaryRoot, 'artifacts'),
        },
        stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  }
  const result = {
    ...completion,
    stdout: await fs.readFile(stdoutPath, 'utf8'),
    stderr: await fs.readFile(stderrPath, 'utf8'),
  };
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[ENV-002\] every declared candidate route serves HTML with its expected canonical/);
  assert.match(result.stdout, /generic inspection of \/new-route/);
  assert.match(result.stdout, /generic inventoried routes: 1/);
  const listedTotal = /Total: (\d+) tests? in \d+ files?/.exec(result.stdout);
  assert(listedTotal, 'Playwright must report the listed execution count.');
  assert.equal(Number(listedTotal[1]), 2, 'The reviewed ENV-002 case and one generic inventoried route must both register.');
  process.stdout.write('Single-site generic route registration self-test passed: immutable inventory adds exactly one canonical-target Playwright execution.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
