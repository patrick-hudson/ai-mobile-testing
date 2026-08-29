import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealWorkExecutionDescriptor } from '../shared/work-execution-descriptor.mjs';
import {
  sealSharedGenericRouteExecutionPublication,
  verifySharedGenericRouteExecutionPublication,
} from '../shared/single-site-route-plan.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-generic-registration-'));
try {
  const origin = 'https://beta.example.test';
  const descriptor = sealWorkExecutionDescriptor({
    workItemId: 'generic-route-work', subjectCoreDigest: `sha256:${'a'.repeat(64)}`,
    runnerRevision: `sha256:${'b'.repeat(64)}`, mode: 'single-site', operation: 'playwright',
    definitionId: 'ENV-002', pluginId: 'platform-routes', caseId: 'GENERIC-ROUTE-AAAAAAAAAAAAAAAAAAAAAAAA',
    entrySpec: 'tests/single-site-generic-route.spec.ts', targetId: 'single-site-desktop-chromium',
    targetRole: 'preview', capability: 'browser:chromium', resourceClass: 'ordinary',
    origins: { candidate: origin, production: null }, certificatePolicy: 'strict',
    route: {
      inventoryDigest: `sha256:${'c'.repeat(64)}`, url: `${origin}/new-route`, path: '/new-route',
      sources: [{ source: 'sitemap', from: `${origin}/sitemap.xml`, depth: 0 }],
      productOracleVariant: 'generic-page-inspection-v1',
    },
  });
  const publication = sealSharedGenericRouteExecutionPublication(descriptor);
  assert(verifySharedGenericRouteExecutionPublication(publication, {
    executionDescriptorDigest: descriptor.digest,
    publicationDigest: publication.publicationDigest,
  }));
  assert.equal(verifySharedGenericRouteExecutionPublication({
    ...publication,
    genericExecutions: [{ ...publication.genericExecutions[0], path: '/tampered' }],
  }, { executionDescriptorDigest: descriptor.digest, publicationDigest: publication.publicationDigest }), false,
  'route tampering must invalidate the compiler-issued publication');
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
          AUDIT_SINGLE_SITE_CASE_IDS: JSON.stringify([descriptor.caseId]),
          AUDIT_SINGLE_SITE_ROUTE_INVENTORY: publicationPath,
          AUDIT_SINGLE_SITE_GENERIC_TARGET_ID: 'single-site-desktop-chromium',
          AUDIT_SHARED_EXECUTION_DESCRIPTOR_DIGEST: descriptor.digest,
          AUDIT_SHARED_GENERIC_ROUTE_PUBLICATION_DIGEST: publication.publicationDigest,
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
  assert.match(result.stdout, /generic inspection of \/new-route/);
  const listedTotal = /Total: (\d+) tests? in \d+ files?/.exec(result.stdout);
  assert(listedTotal, 'Playwright must report the listed execution count.');
  assert.equal(Number(listedTotal[1]), 1, 'A compiler-issued generic work item must register exactly its one dynamic route row.');
  process.stdout.write('Single-site generic route registration self-test passed: immutable inventory adds exactly one canonical-target Playwright execution.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
