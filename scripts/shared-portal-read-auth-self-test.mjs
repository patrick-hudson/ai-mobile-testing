import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openScopedCredentialAuthority } from '../portal/scoped-credential-authority.mjs';
import { createParentRun, openParentRunStore } from './lib/parent-run-store.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-portal-read-auth-'));
let portal = null;
let coordinator = null;
try {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const artifacts = path.join(root, 'artifacts');
  const sharded = path.join(root, 'sharded');
  const credentials = path.join(root, 'credentials');
  const store = path.join(root, 'parent-store');
  const secrets = path.join(root, 'secrets');
  const queue = path.join(root, 'queue');
  const finalizations = path.join(root, 'finalizations');
  const baselines = path.join(root, 'baselines');
  const timestamp = '2026-08-29T12:00:00.000Z';
  await Promise.all([artifacts, sharded, secrets, queue, finalizations, baselines].map((directory) => mkdir(directory, { recursive: true })));
  for (const runId of ['run-a-0001', 'run-b-0002']) {
    const directory = path.join(artifacts, runId);
    await mkdir(path.join(directory, 'logs'), { recursive: true });
    await writeFile(path.join(directory, 'run.json'), `${JSON.stringify({
      schemaVersion: 1,
      id: runId,
      status: 'passed',
      phase: 'Complete',
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      options: { candidateIgnoreHTTPSErrors: false, projects: [], targetIds: [], pluginIds: [], areas: [], auditIds: [] },
      progress: { total: 1, completed: 1, passed: 1, failed: 0, flaky: 0, skipped: 0 },
      stages: {},
    })}\n`);
    await writeFile(path.join(directory, 'canary.bin'), `protected-${runId}-bytes`);
    await writeFile(path.join(directory, 'active.html'), `<script>document.body.textContent='active-${runId}'</script>`);
    await writeFile(path.join(directory, 'logs', 'runner.log'), `${timestamp} [playwright:stdout] ${runId} safe log\n`);
  }
  const sharedStore = await openParentRunStore({
    root: store,
    deploymentIdentity: 'self-test:shared-portal',
    volumeIdentity: 'named-volume:self-test-shared-portal',
    verifyStorage: false,
  });
  const sharedRunId = 'shared-op-0001';
  await createParentRun(sharedStore, {
    runId: sharedRunId,
    subjectCoreDigest: `sha256:${'a'.repeat(64)}`,
    workItems: [{
      id: 'work-shared-op-0001', maxAttempts: 1,
      capability: 'browser:chromium', targetId: 'candidate',
    }],
  });
  const authority = await openScopedCredentialAuthority({ root: credentials });
  const viewerA = await authority.createPrincipal({
    id: 'viewer-a', kind: 'human', roles: ['viewer'], projectIds: ['project-1'], runIds: ['run-a-0001'],
  });
  const viewerAll = await authority.createPrincipal({
    id: 'viewer-all', kind: 'human', roles: ['viewer'], projectIds: ['project-1'], runIds: ['*'],
  });
  const delivery = await authority.createPrincipal({
    id: 'delivery-a', kind: 'service', roles: ['delivery'], projectIds: ['project-1'], runIds: ['run-a-0001'],
  });
  const operator = await authority.createPrincipal({
    id: 'operator-a', kind: 'human', roles: ['operator'], projectIds: ['project-1'], runIds: [sharedRunId],
  });
  const operatorTokenFile = path.join(root, 'operator.token');
  const cancelBodyFile = path.join(root, 'cancel.json');
  await writeFile(operatorTokenFile, `${operator.credential}\n`, { mode: 0o600 });
  await writeFile(cancelBodyFile, `${JSON.stringify({ expectedRunRevision: 1, reason: 'CLI restart integration proof.' })}\n`, { mode: 0o600 });
  const environment = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    PORTAL_SHARED_CONTROL: '1',
    PORTAL_PUBLISHED_ORIGIN: origin,
    PORTAL_SESSION_SECURE: '0',
    PORTAL_ARTIFACT_ROOT: artifacts,
    PORTAL_SHARDED_ARTIFACT_ROOT: sharded,
    PORTAL_SECRET_ROOT: secrets,
    PORTAL_SINGLE_SITE_QUEUE_ROOT: queue,
    PORTAL_SINGLE_SITE_FINALIZATION_ROOT: finalizations,
    PORTAL_VISUAL_BASELINE_ROOT: baselines,
    PORTAL_SHARED_CREDENTIAL_ROOT: credentials,
    AUDIT_SHARED_STORE_ROOT: store,
    AUDIT_SHARED_DEPLOYMENT_IDENTITY: 'self-test:shared-portal',
    AUDIT_SHARED_VOLUME_IDENTITY: 'named-volume:self-test-shared-portal',
    AUDIT_SHARED_PROJECT_ID: 'project-1',
    PORTAL_EXTERNAL_RUN_SYNC_MS: '60000',
    PORTAL_SHARED_READ_REAUTH_MS: '250',
  };
  for (const name of [
    'PORTAL_RUNNER_UID', 'PORTAL_RUNNER_GID', 'PORTAL_AI_WORKER_UID', 'PORTAL_AI_WORKER_GID',
    'PORTAL_REPORT_WORKER_UID', 'PORTAL_REPORT_WORKER_GID', 'ANTHROPIC_API_KEY',
  ]) delete environment[name];

  portal = await startPortal({ environment, origin });

  const sharedOperatorCookie = await browserLogin(origin, operator.credential);
  for (const { method, pathname } of [
    { method: 'POST', pathname: '/api/runs' },
    { method: 'POST', pathname: '/api/single-site/runs' },
    { method: 'POST', pathname: `/api/runs/${sharedRunId}/stop` },
    { method: 'POST', pathname: `/api/single-site/runs/${sharedRunId}/cancel` },
    { method: 'DELETE', pathname: `/api/runs/${sharedRunId}` },
    { method: 'DELETE', pathname: `/api/single-site/runs/${sharedRunId}` },
    { method: 'POST', pathname: `/api/runs/${sharedRunId}/manual-evidence` },
    { method: 'POST', pathname: `/api/runs/${sharedRunId}/manual-uploads` },
    { method: 'POST', pathname: `/api/runs/${sharedRunId}/gallery/flags` },
    { method: 'POST', pathname: `/api/runs/${sharedRunId}/gallery/flags/gflag_0000000000000000/transitions` },
    { method: 'POST', pathname: `/api/single-site/runs/${sharedRunId}/gallery/items/gitem_0000000000000000/review` },
  ]) {
    const retired = await fetch(`${origin}${pathname}`, {
      method,
      headers: {
        Cookie: sharedOperatorCookie.cookie,
        Origin: origin,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hostileClientActor: 'must-not-be-consumed' }),
    });
    const retiredBody = await retired.json();
    assert.equal(retired.status, 410, `${method} ${pathname} must be retired before legacy state lookup`);
    assert.equal(retiredBody.code, 'SHARED_LEGACY_MUTATION_RETIRED');
  }

  for (const [url, options = {}] of [
    [`${origin}/api/runs/run-a-0001`, {}],
    [`${origin}/api/runs/run-a-0001/events`, {}],
    [`${origin}/artifacts/run-a-0001/canary.bin`, {}],
    [`${origin}/artifacts/run-a-0001/canary.bin`, { method: 'HEAD' }],
    [`${origin}/artifacts/run-a-0001/canary.bin`, { headers: { Range: 'bytes=0-8' } }],
  ]) {
    const denied = await fetch(url, options);
    assert.equal(denied.status, 401, `${options.method ?? 'GET'} ${url} must authenticate before reading`);
    assert.equal(denied.headers.has('content-range'), false);
    assert.equal(denied.headers.has('accept-ranges'), false);
    assert.doesNotMatch(await denied.text(), /protected-run-a-0001-bytes/u);
  }

  const viewerACookie = await browserLogin(origin, viewerA.credential);
  assert.match(viewerACookie.setCookie, /HttpOnly; SameSite=Strict; Path=\//u);
  const runA = await fetch(`${origin}/api/runs/run-a-0001`, { headers: { Cookie: viewerACookie.cookie } });
  assert.equal(runA.status, 200, await runA.text());
  const artifactA = await fetch(`${origin}/artifacts/run-a-0001/canary.bin`, { headers: { Cookie: viewerACookie.cookie } });
  assert.equal(artifactA.status, 200);
  assert.equal(await artifactA.text(), 'protected-run-a-0001-bytes');
  const rangeA = await fetch(`${origin}/artifacts/run-a-0001/canary.bin`, {
    headers: { Cookie: viewerACookie.cookie, Range: 'bytes=0-8' },
  });
  assert.equal(rangeA.status, 206);
  assert.equal(await rangeA.text(), 'protected');
  const logA = await fetch(`${origin}/api/runs/run-a-0001/logs?maxBytes=16384`, { headers: { Cookie: viewerACookie.cookie } });
  assert.equal(logA.status, 200, await logA.text());
  const eventController = new AbortController();
  const eventResponse = await fetch(`${origin}/api/runs/run-a-0001/events`, {
    headers: { Cookie: viewerACookie.cookie },
    signal: eventController.signal,
  });
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get('content-type') ?? '', /^text\/event-stream/u);
  const eventReader = eventResponse.body.getReader();
  let initialEvents = '';
  while (!initialEvents.includes('event: snapshot')) {
    const chunk = await eventReader.read();
    assert.equal(chunk.done, false);
    initialEvents += new TextDecoder().decode(chunk.value);
  }

  for (const url of [
    `${origin}/api/runs/run-b-0002`,
    `${origin}/api/runs/run-b-0002/report`,
    `${origin}/api/runs/run-b-0002/gallery`,
    `${origin}/artifacts/run-b-0002/canary.bin`,
  ]) {
    const denied = await fetch(url, { headers: { Cookie: viewerACookie.cookie } });
    assert.equal(denied.status, 403, `${url} must reject a foreign run before lookup`);
    assert.doesNotMatch(await denied.text(), /protected-run-b-0002-bytes/u);
    assert.equal(denied.headers.has('content-range'), false);
    assert.equal(denied.headers.has('accept-ranges'), false);
  }
  assert.equal((await fetch(`${origin}/api/runs`, { headers: { Cookie: viewerACookie.cookie } })).status, 403,
    'a run-scoped session must not receive an unfiltered aggregate');

  const active = await fetch(`${origin}/artifacts/run-a-0001/active.html`, { headers: { Cookie: viewerACookie.cookie } });
  assert.equal(active.status, 200);
  assert.match(active.headers.get('content-disposition') ?? '', /^attachment;/u);
  assert.match(active.headers.get('content-security-policy') ?? '', /default-src 'none'/u);

  const deliveryArtifact = await fetch(`${origin}/artifacts/run-a-0001/canary.bin`, {
    headers: { Authorization: `Bearer ${delivery.credential}` },
  });
  assert.equal(deliveryArtifact.status, 403, 'delivery credentials may consume release truth but not raw evidence');

  const viewerAllCookie = await browserLogin(origin, viewerAll.credential);
  const list = await fetch(`${origin}/api/runs`, { headers: { Cookie: viewerAllCookie.cookie } });
  const listBody = await list.text();
  assert.equal(list.status, 200, listBody);
  assert.deepEqual(JSON.parse(listBody).runs.map(({ id }) => id).sort(), ['run-a-0001', 'run-b-0002']);

  await authority.revokePrincipal('viewer-a');
  const revoked = await fetch(`${origin}/artifacts/run-a-0001/canary.bin`, { headers: { Cookie: viewerACookie.cookie } });
  assert.equal(revoked.status, 401, 'revocation must apply on the next native artifact request');
  assert.doesNotMatch(await revoked.text(), /protected-run-a-0001-bytes/u);
  const streamClosed = await Promise.race([
    eventReader.read().then(({ done }) => done).catch(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  assert.equal(streamClosed, true, 'an open SSE stream must close after its principal is revoked');
  eventController.abort();

  await stopPortal(portal);
  portal = await startPortal({ environment, origin });
  const afterRestart = await fetch(`${origin}/api/runs`, { headers: { Cookie: viewerAllCookie.cookie } });
  const afterRestartBody = await afterRestart.text();
  assert.equal(afterRestart.status, 200, afterRestartBody);
  assert.deepEqual(JSON.parse(afterRestartBody).runs.map(({ id }) => id).sort(), ['run-a-0001', 'run-b-0002']);

  const requestId = 'cancel-restart-0001';
  const accepted = await runAuditControl([
    'cancel', '--server', origin, '--token-file', operatorTokenFile, '--run', sharedRunId,
    '--request-id', requestId, '--body', cancelBodyFile,
  ]);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(accepted.document.data.state, 'accepted');
  const acceptedOperationId = accepted.document.data.operationId;
  assert.equal(accepted.document.data.statusUrl,
    `/api/control/v1/runs/${sharedRunId}/operations/${acceptedOperationId}`);

  await stopPortal(portal);
  portal = null;
  portal = await startPortal({ environment, origin });
  const persisted = await runAuditControl([
    'operation', '--server', origin, '--token-file', operatorTokenFile, '--run', sharedRunId,
    '--operation-id', acceptedOperationId,
  ]);
  assert.equal(persisted.code, 0, persisted.stderr);
  assert.equal(persisted.document.data.operationId, acceptedOperationId);
  assert.equal(persisted.document.data.state, 'accepted');
  const boundedWait = await runAuditControl([
    'wait-operation', '--server', origin, '--token-file', operatorTokenFile, '--run', sharedRunId,
    '--operation-id', acceptedOperationId, '--max-polls', '1', '--poll-ms', '100',
  ]);
  assert.equal(boundedWait.code, 14, boundedWait.stderr);
  assert.match(boundedWait.stderr, /did not reach a terminal state within the polling bound/u);

  const coordinatorPort = await availablePort();
  coordinator = await startCoordinator({
    port: coordinatorPort,
    environment: {
      ...environment,
      AUDIT_SHARED_COORDINATOR_PORT: String(coordinatorPort),
      AUDIT_SHARED_CREDENTIAL_ROOT: credentials,
      AUDIT_SHARED_EXCHANGE_ROOT: path.join(root, 'exchange'),
      AUDIT_SHARED_LEASE_MS: '1000',
      AUDIT_SHARED_COORDINATOR_LEASE_MS: '5000',
    },
  });
  const completed = await runAuditControl([
    'wait-operation', '--server', origin, '--token-file', operatorTokenFile, '--run', sharedRunId,
    '--operation-id', acceptedOperationId, '--max-polls', '40', '--poll-ms', '100',
  ]);
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.document.data.operationId, acceptedOperationId);
  assert.equal(completed.document.data.outcome.status, 'succeeded');

  console.log('Shared portal read-auth self-test passed: authorized reads, CLI mutation persistence, coordinator completion, revocation, active-content isolation, and portal restart fail closed.');
} finally {
  if (coordinator) await stopProcess(coordinator);
  if (portal) await stopPortal(portal);
  await rm(root, { recursive: true, force: true });
}

async function browserLogin(origin, credential) {
  const response = await fetch(`${origin}/api/control/v1/session`, {
    method: 'POST',
    headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  assert.equal(response.status, 200, await response.text());
  const setCookie = response.headers.get('set-cookie') ?? '';
  return { cookie: setCookie.split(';', 1)[0], setCookie };
}

async function startPortal({ environment, origin }) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'portal/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Portal exited ${child.exitCode}: ${stderr.slice(-4_000)}`);
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return { child, stderr: () => stderr };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGKILL');
  throw new Error(`Portal did not become healthy: ${stderr.slice(-4_000)}`);
}

async function stopPortal(portal) {
  await stopProcess(portal);
}

async function startCoordinator({ port, environment }) {
  const child = spawn(process.execPath, ['scripts/run-shared-coordinator.mjs'], {
    cwd: new URL('..', import.meta.url), env: environment, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Coordinator exited ${child.exitCode}: ${stderr.slice(-4_000)}`);
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return { child, stderr: () => stderr };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGKILL');
  throw new Error(`Coordinator did not become healthy: ${stderr.slice(-4_000)}`);
}

async function runAuditControl(arguments_) {
  const child = spawn(process.execPath, ['scripts/audit-control.mjs', ...arguments_], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const [code] = await once(child, 'exit');
  const lines = stdout.trim().split('\n').filter(Boolean);
  return { code, stdout, stderr, document: JSON.parse(lines.at(-1) ?? '{}') };
}

async function stopProcess(process_) {
  if (!process_ || process_.child.exitCode !== null) return;
  process_.child.kill('SIGTERM');
  await Promise.race([once(process_.child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (process_.child.exitCode === null) {
    process_.child.kill('SIGKILL');
    await once(process_.child, 'exit');
  }
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not allocate a test port.');
  return address.port;
}
