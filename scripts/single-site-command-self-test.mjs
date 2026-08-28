import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openJobQueue, listJobs, sha256 } from './lib/job-queue.mjs';
import { launchDirectSingleSiteJob, parseArguments } from './run-single-site.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [pluginRegistry, targetRegistry] = await Promise.all([
  fs.readFile(path.join(repositoryRoot, 'audit', 'plugins.generated.json'), 'utf8').then(JSON.parse),
  fs.readFile(path.join(repositoryRoot, 'audit', 'targets.generated.json'), 'utf8').then(JSON.parse),
]);

const parsed = parseArguments([
  '--queue-root', '/queue',
  '--url', 'https://beta.quitting7oh-org.pages.dev',
  '--role', 'preview',
  '--scope', 'TARGETED',
  '--audits', 'HOME-001',
  '--targets', 'single-site-mobile-chromium',
  '--idempotency-key', 'command-self-test-0001',
], {});
assert.equal(parsed.launchPath, undefined);
assert.deepEqual(parsed.audits, ['HOME-001']);
assert.throws(
  () => parseArguments(['--queue-root', '/queue', '--url', 'https://example.test', '--launch', 'launch.json'], {}),
  (error) => error?.code === 'SINGLE_SITE_LAUNCH_USAGE',
);

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-command-'));
try {
  const queue = await openJobQueue({ root: path.join(temporaryRoot, 'queue') });
  const preflight = async (input) => ({
    schemaVersion: 1,
    accepted: true,
    checkedAt: '2026-08-25T12:00:00.000Z',
    origin: input.url,
    deploymentRole: input.deploymentRole,
    certificatePolicy: input.certificatePolicy,
    identityFingerprint: sha256('command-identity'),
    deploymentRevision: {
      status: 'verified',
      fingerprint: sha256('command-revision'),
      source: 'fixture',
      signals: [],
      limitation: null,
    },
    evidenceAuthority: { status: 'authoritative', reasons: [] },
    markers: [],
    probes: [],
    issues: [],
    preflightDigest: sha256('command-preflight'),
  });
  const options = {
    ...parsed,
    queueRoot: queue.root,
    previewBypassOrigins: [],
  };
  const dependencies = {
    queue,
    repositoryRoot,
    pluginRegistry,
    targetRegistry,
    runnerRevision: 'runner-command-fixture',
    preflight,
    now: () => Date.parse('2026-08-25T12:00:00.000Z'),
  };
  const first = await launchDirectSingleSiteJob(options, dependencies);
  assert.equal(first.launched.launched, true);
  assert.equal(first.launched.job.created, true);
  assert.equal(first.preview.coverage.scope.qualifier, 'TARGETED');
  assert.deepEqual(first.launched.job.selectedTargetIds, ['single-site-mobile-chromium']);
  assert.equal(first.launched.job.selectedCaseCount > 0, true);

  const repeated = await launchDirectSingleSiteJob(options, dependencies);
  assert.equal(repeated.launched.job.created, false);
  assert.equal(repeated.launched.job.jobId, first.launched.job.jobId);
  assert.equal((await listJobs(queue)).length, 1);
  process.stdout.write('Single-site command launch self-test passed: URL preflight, exact scope compilation, queue binding, and idempotency match portal semantics.\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
