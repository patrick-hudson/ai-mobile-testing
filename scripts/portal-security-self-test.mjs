import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readBoundedFileTail } from '../portal/bounded-file.mjs';
import {
  applyCompletedReleaseEligibility,
  canonicalExecutionProvenance,
  portalExecutionProvenance,
  releaseReviewReasons,
} from '../portal/release-eligibility.mjs';

const fullProjects = 7;
const ready = {
  decision: 'READY',
  reason: 'Every checklist row passed.',
  decisionBasis: 'Synthetic release-truth fixture.',
};

function manifest(overrides = {}) {
  return {
    options: {
      profile: 'release',
      projects: Array.from({ length: fullProjects }, (_, index) => `project-${index + 1}`),
      auditIds: [],
      candidateIgnoreHTTPSErrors: false,
      ...overrides.options,
    },
    progress: { flaky: 0, ...overrides.progress },
    executionProvenance: overrides.executionProvenance ?? portalExecutionProvenance(),
  };
}

const portalReady = manifest();
applyCompletedReleaseEligibility(portalReady, ready, 'Synthetic pipeline complete', fullProjects);
assert.equal(portalReady.release.decision, 'READY');
assert.equal(portalReady.status, 'review-required');
assert.match(portalReady.phase, /checklist READY/i);
assert.match(portalReady.phase, /signoff withheld/i);
assert.match(portalReady.reviewReasons.join(' '), /new-ID sharded release run/i);

for (const fixture of [
  manifest({ progress: { flaky: 1 } }),
  manifest({ options: { candidateIgnoreHTTPSErrors: true } }),
  manifest({ options: { projects: ['project-1'] } }),
]) {
  applyCompletedReleaseEligibility(fixture, ready, 'Synthetic pipeline complete', fullProjects);
  assert.equal(fixture.status, 'review-required');
  assert.ok(fixture.reviewReasons.length > 0);
}

const canonicalReady = manifest({ executionProvenance: canonicalExecutionProvenance() });
applyCompletedReleaseEligibility(canonicalReady, ready, 'Canonical sharded pipeline complete', fullProjects);
assert.equal(canonicalReady.status, 'passed');
assert.deepEqual(releaseReviewReasons(canonicalReady, fullProjects), []);

const blockedWithReviews = manifest({ progress: { flaky: 2 } });
applyCompletedReleaseEligibility(blockedWithReviews, {
  decision: 'NOT_READY', reason: 'A blocking audit failed.', decisionBasis: 'Synthetic blocking fixture.',
}, 'Synthetic pipeline complete', fullProjects);
assert.equal(blockedWithReviews.status, 'not-ready');
assert.match(blockedWithReviews.phase, /release NOT READY/);
assert.match(blockedWithReviews.phase, /additional review requirements/);
assert.ok(blockedWithReviews.reviewReasons.length >= 2);

const temporary = await mkdtemp(join(tmpdir(), 'portal-security-self-test-'));
try {
  const log = join(temporary, 'runner.log');
  await writeFile(log, `${'discarded progress line\n'.repeat(100_000)}[playwright:stdout] 99 passed\n`);
  const tail = await readBoundedFileTail(log, 32 * 1024);
  assert.equal(tail.truncated, true);
  assert.ok(tail.returnedBytes <= 32 * 1024);
  assert.match(tail.content, /99 passed/);
  await assertPortalRestartReadsLargeExternalLog(temporary);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log('Portal security self-test passed: release authority fails closed and restart progress recovery reads only a bounded log tail.');

async function assertPortalRestartReadsLargeExternalLog(temporary) {
  const artifacts = join(temporary, 'restart-runs');
  const sharded = join(temporary, 'restart-sharded');
  const secrets = join(temporary, 'restart-secrets');
  const logDirectory = join(sharded, 'restart-large-log', 'logs');
  await mkdir(logDirectory, { recursive: true });
  const timestamp = new Date().toISOString();
  await writeFile(join(logDirectory, 'coordinator.log'), `${timestamp} [COORDINATOR] sharded-release-started {"runId":"restart-large-log","shardTotal":1,"shardWorkers":"1","tlsPolicy":"strict"}\n`);
  await writeFile(join(logDirectory, 'shard-1-of-1.log'), `${timestamp} [SHARD 1/1][stdout] Running 1 test using 1 worker, shard 1 of 1\n${'[AUDIT_TEST_FINISH] passed\n'.repeat(24_000)}`);

  const port = await availablePort();
  const child = spawn(process.execPath, ['portal/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PORTAL_ARTIFACT_ROOT: artifacts,
      PORTAL_SHARDED_ARTIFACT_ROOT: sharded,
      PORTAL_SECRET_ROOT: secrets,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Portal restart probe exited ${child.exitCode}: ${stderr.slice(-2_000)}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) return;
      } catch {
        // The listener is expected to race the first few probes.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Portal restart probe did not become healthy: ${stderr.slice(-2_000)}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

async function availablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('Could not allocate a portal restart probe port.');
  return port;
}
