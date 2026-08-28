import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  canonicalJson,
  claimJob,
  openJobQueue,
  publishAttemptDocument,
  settleJobAttempt,
  sha256,
  submitJob,
} from './lib/job-queue.mjs';

const temporary = await fs.mkdtemp(join(tmpdir(), 'portal-single-site-ai-api-'));
const operatorToken = 'portal-single-site-ai-api-operator-token-0000000000000001';
let child;
try {
  const queueRoot = join(temporary, 'jobs');
  const finalizationRoot = join(temporary, 'finalizations');
  const queue = await openJobQueue({ root: queueRoot, verifyStorage: false });
  const input = {
    schemaVersion: 1,
    advisory: { schemaVersion: 1, aiReview: { optedIn: true, model: 'claude-test-model' } },
  };
  const digest = (label) => sha256(`portal-ai-${label}`);
  const submitted = await submitJob(queue, {
    idempotencyKey: 'portal-ai-endpoint-fixture',
    runMode: 'single-site',
    inputDocumentDigest: sha256(canonicalJson(input)),
    runContractDigest: digest('contract'),
    compiledManifestDigest: digest('manifest'),
    preflightDigest: digest('preflight'),
    identityFingerprint: digest('identity'),
    revisionFingerprint: digest('revision'),
    evidenceAuthority: { authoritative: true, reasons: [] },
    registryRevision: 'portal-ai-registry-v1',
    targetSetRevision: 'portal-ai-targets-v1',
    runnerRevision: 'portal-ai-runner-v1',
    stageDeadlines: {
      browser: '2099-01-01T00:10:00.000Z',
      finalizer: '2099-01-01T00:20:00.000Z',
    },
  }, { inputDocument: input });
  const claim = await claimJob(queue, submitted.state.jobId, 'portal-ai-api-worker');
  await publishAttemptDocument(queue, claim, {
    publicationId: 'portal-ai-api-result',
    relativePath: 'worker/attempt-result.json',
    document: { fixture: true },
  });
  const state = await settleJobAttempt(queue, claim, { kind: 'success' });
  const reportDigest = 'b'.repeat(64);
  const finalizationDigest = 'a'.repeat(64);
  const reportRevision = finalizationDigest.slice(0, 32);
  const finalizationBody = {
    schemaVersion: 1,
    kind: 'single-site-finalization-status',
    jobId: state.jobId,
    status: 'complete',
    deadlineExceeded: false,
    executionState: 'completed',
    finalizationDigest,
    failureDigest: null,
    reportRevision,
    reportPublicationDigest: reportDigest,
    visualPublicationDigest: `sha256:${'c'.repeat(64)}`,
    visualEligibilityManifestDigest: `sha256:${'d'.repeat(64)}`,
  };
  const finalizationDirectory = join(finalizationRoot, state.jobId);
  await fs.mkdir(join(finalizationDirectory, 'ai-review'), { recursive: true });
  await fs.writeFile(join(finalizationDirectory, 'status.json'), `${JSON.stringify({
    ...finalizationBody,
    statusDigest: sha256(canonicalJson(finalizationBody)),
  })}\n`);
  const aiBody = {
    schemaVersion: 1,
    kind: 'single-site-ai-advisory-status',
    jobId: state.jobId,
    state: 'unavailable',
    stateRevision: 2,
    requestId: 'fixture-isolated-worker-unavailable',
    attempt: 1,
    optIn: true,
    model: 'claude-test-model',
    requestedAt: '2026-08-25T22:00:00.000Z',
    startedAt: null,
    finishedAt: '2026-08-25T22:00:01.000Z',
    reportRevision,
    reportPublicationDigest: reportDigest,
    inputDigest: null,
    output: null,
    error: { code: 'isolated-worker-unavailable', message: 'The isolated AI worker is unavailable.' },
    retryable: true,
  };
  await fs.writeFile(join(finalizationDirectory, 'ai-review', 'status.json'), `${JSON.stringify({
    ...aiBody,
    statusDigest: sha256(canonicalJson(aiBody)),
  })}\n`);

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['portal/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PORTAL_ARTIFACT_ROOT: join(temporary, 'runs'),
      PORTAL_SHARDED_ARTIFACT_ROOT: join(temporary, 'sharded'),
      PORTAL_SINGLE_SITE_QUEUE_ROOT: queueRoot,
      PORTAL_SINGLE_SITE_FINALIZATION_ROOT: finalizationRoot,
      PORTAL_VISUAL_BASELINE_ROOT: join(temporary, 'baselines'),
      PORTAL_SECRET_ROOT: join(temporary, 'secrets'),
      PORTAL_E2E_FAILURE_INJECTION: '1',
      PORTAL_E2E_OPERATOR_TOKEN: operatorToken,
      AI_REVIEW_DRY_RUN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitForHealth(baseUrl, child, () => stderr);

  const endpoint = `/api/single-site/runs/${encodeURIComponent(state.jobId)}/ai-review`;
  const statusResponse = await fetch(`${baseUrl}${endpoint}`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.deepEqual({ advisory: status.advisory, gating: status.gating, optedIn: status.optedIn }, {
    advisory: true, gating: false, optedIn: true,
  });
  assert.equal(status.state, 'unavailable');
  assert.equal(status.status.stateRevision, 2);
  assert(!JSON.stringify(status).includes('publicationRelativePath'));
  assert(!JSON.stringify(status).includes('sk-ant-'));

  const unauthorized = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(unauthorized.status, 401);

  const forgedActor = await operatorFetch(baseUrl, endpoint, {
    expectedStateRevision: 2,
    confirmation: `RETRY AI ${state.jobId}`,
    actorId: 'ai-worker',
  });
  assert.equal(forgedActor.status, 400);
  assert.match(await forgedActor.text(), /Client-supplied actor identity is not allowed/);

  const staleRevision = await operatorFetch(baseUrl, endpoint, {
    expectedStateRevision: 1,
    confirmation: `RETRY AI ${state.jobId}`,
  });
  assert.equal(staleRevision.status, 409);

  const retry = await operatorFetch(baseUrl, endpoint, {
    expectedStateRevision: 2,
    confirmation: `RETRY AI ${state.jobId}`,
  });
  assert.equal(retry.status, 202, await retry.clone().text());
  const retried = await retry.json();
  assert.equal(retried.state, 'unavailable');
  assert.equal(retried.stateRevision, 4);
  assert.equal(retried.error.code, 'isolated-worker-unavailable');
  assert(!JSON.stringify(retried).includes('sk-ant-'));

  const notReady = await fetch(`${baseUrl}${endpoint}/result`);
  assert.equal(notReady.status, 409);
  assert.equal((await notReady.json()).code, undefined);

  process.stdout.write('Portal Single-site AI API self-test passed: advisory status is bounded, retry is operator-only and revision-guarded, forged actors are rejected, secrets stay hidden, and incomplete results fail closed.\n');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await fs.rm(temporary, { recursive: true, force: true });
}

function operatorFetch(baseUrl, pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-portal-operator-token': operatorToken },
    body: JSON.stringify(body),
  });
}

async function availablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('Could not allocate a portal AI API self-test port.');
  return port;
}

async function waitForHealth(baseUrl, processHandle, stderr) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Portal exited during AI API self-test: ${stderr()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Listener startup races are expected.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Portal did not become healthy for AI API self-test: ${stderr()}`);
}
