import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openScopedCredentialAuthority } from '../portal/scoped-credential-authority.mjs';
import { sealWorkItemEvidenceMember } from '../shared/work-item-evidence-index.mjs';
import { createParentRun, openParentRunStore, readParentRun } from './lib/parent-run-store.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-streaming-http-'));
let coordinator = null;
try {
  const storeRoot = path.join(root, 'store');
  const credentialRoot = path.join(root, 'credentials');
  const runId = 'stream-http-run';
  const projectId = 'stream-http-project';
  const storeMarker = '56'.repeat(32);
  const backupMarker = '78'.repeat(32);
  await fs.mkdir(storeRoot, { recursive: true });
  const storeMarkerFile = path.join(storeRoot, '.trusted-store-marker');
  const backupMarkerFile = path.join(storeRoot, '.trusted-backup-marker');
  await fs.writeFile(storeMarkerFile, `${storeMarker}\n`, { mode: 0o600 });
  await fs.writeFile(backupMarkerFile, `${backupMarker}\n`, { mode: 0o600 });
  const store = await openParentRunStore({
    root: storeRoot,
    deploymentIdentity: 'self-test:streaming-http',
    volumeIdentity: 'named-volume:self-test-streaming-http',
    storeMarker,
    backupMarker,
    verifyStorage: false,
  });
  await createParentRun(store, {
    runId,
    subjectCoreDigest: `sha256:${'a'.repeat(64)}`,
    runnerRevision: 'runner-streaming-http',
    workItems: [{
      id: 'stream-http-work', maxAttempts: 2, capability: 'browser:chromium', resourceClass: 'ordinary',
      targetId: 'candidate-desktop-chromium', specAffinity: null,
    }],
  });
  const authority = await openScopedCredentialAuthority({ root: credentialRoot });
  const worker = await authority.createPrincipal({
    id: 'stream-http-worker', kind: 'worker', roles: ['worker'], projectIds: [projectId], runIds: [runId],
    workerGrant: { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
  });
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  coordinator = await startCoordinator({
    port,
    environment: {
      ...process.env,
      AUDIT_SHARED_COORDINATOR_PORT: String(port),
      AUDIT_SHARED_STORE_ROOT: storeRoot,
      AUDIT_SHARED_STORE_MARKER_FILE: storeMarkerFile,
      AUDIT_SHARED_BACKUP_MARKER_FILE: backupMarkerFile,
      AUDIT_SHARED_CREDENTIAL_ROOT: credentialRoot,
      AUDIT_SHARED_DEPLOYMENT_IDENTITY: 'self-test:streaming-http',
      AUDIT_SHARED_VOLUME_IDENTITY: 'named-volume:self-test-streaming-http',
      AUDIT_SHARED_PROJECT_ID: projectId,
      AUDIT_SHARED_LEASE_MS: '1000',
      AUDIT_SHARED_COORDINATOR_LEASE_MS: '5000',
    },
  });
  const headers = { authorization: `Bearer ${worker.credential}`, 'content-type': 'application/json' };
  const post = async (pathname, body) => {
    const response = await fetch(`${origin}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const value = await response.json();
    return { response, value };
  };
  const claimed = await post('/v1/claim', { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] });
  assert.equal(claimed.response.status, 200, JSON.stringify(claimed.value));
  let activeLease = claimed.value;
  const bytes = Buffer.alloc(256 * 1_024, 0x5a);
  const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const member = sealWorkItemEvidenceMember({
    workItemId: activeLease.workItemId,
    executionDescriptorDigest: activeLease.executionDescriptorDigest ?? activeLease.subjectCoreDigest,
    ordinal: 1,
    logicalName: 'slow-action-video',
    purpose: 'primary',
    mediaType: 'video/webm',
    sizeBytes: bytes.length,
    contentDigest,
    transportPath: 'video/slow-action.webm',
  });
  const artifact = {
    name: member.transportPath,
    mediaType: member.mediaType,
    sizeBytes: member.sizeBytes,
    digest: member.contentDigest,
    logicalName: member.logicalName,
    purpose: member.purpose,
    memberDigest: member.memberDigest,
  };
  const result = {
    outcome: 'completed_pass', reason: null,
    executionDescriptorDigest: activeLease.executionDescriptorDigest ?? null,
    artifacts: [artifact],
  };
  const intent = await post('/v1/result-intent', { lease: activeLease, result });
  assert.equal(intent.response.status, 201, JSON.stringify(intent.value));
  const conflictingMember = sealWorkItemEvidenceMember({
    workItemId: activeLease.workItemId,
    executionDescriptorDigest: activeLease.executionDescriptorDigest ?? activeLease.subjectCoreDigest,
    ordinal: 1,
    logicalName: 'conflicting-name',
    purpose: 'primary',
    mediaType: artifact.mediaType,
    sizeBytes: artifact.sizeBytes,
    contentDigest: artifact.digest,
    transportPath: artifact.name,
  });
  const conflict = await post('/v1/result-intent', {
    lease: activeLease,
    result: {
      ...result,
      artifacts: [{ ...artifact, logicalName: conflictingMember.logicalName, memberDigest: conflictingMember.memberDigest }],
    },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.value.code, 'ATTEMPT_UPLOAD_CONFLICT');

  const uploadHeaders = {
    authorization: `Bearer ${worker.credential}`,
    'content-type': artifact.mediaType,
    'x-audit-run-id': runId,
    'x-audit-work-item-id': activeLease.workItemId,
    'x-audit-attempt': String(activeLease.attempt),
    'x-audit-lease-token': activeLease.token,
    'x-audit-intent-digest': intent.value.intentDigest,
    'x-audit-artifact-ordinal': '1',
  };
  const missingLength = await fetch(`${origin}/v1/result-artifact`, {
    method: 'PUT', headers: uploadHeaders,
    body: (async function* () { yield Buffer.from('chunked'); }()), duplex: 'half',
  });
  assert.equal(missingLength.status, 411, 'chunked upload without an exact Content-Length must fail before storage');
  const encoded = await fetch(`${origin}/v1/result-artifact`, {
    method: 'PUT', headers: { ...uploadHeaders, 'content-length': '1', 'content-encoding': 'gzip' }, body: 'x',
  });
  assert.equal(encoded.status, 415, 'content encoding must not alter sealed byte identity');
  const wrongType = await fetch(`${origin}/v1/result-artifact`, {
    method: 'PUT', headers: { ...uploadHeaders, 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  assert.equal(wrongType.status, 400, 'transport media type must match the sealed member');
  for (const framing of [
    `Content-Length: 1\r\nContent-Length: 1\r\n\r\nx`,
    `Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
  ]) {
    const statusLine = await rawHttpStatus(port,
      `PUT /v1/result-artifact HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${worker.credential}\r\n${framing}`);
    assert.match(statusLine, /^HTTP\/1\.1 400 /,
      'ambiguous duplicate or Content-Length plus Transfer-Encoding framing must be parser-rejected');
  }

  let heartbeatCount = 0;
  const slowBody = async function* () {
    const chunkSize = 64 * 1_024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      if (offset + chunkSize < bytes.length) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const heartbeat = await post('/v1/heartbeat', { lease: activeLease });
        assert.equal(heartbeat.response.status, 202, JSON.stringify(heartbeat.value));
        activeLease = heartbeat.value;
        heartbeatCount += 1;
      }
    }
  };
  const uploaded = await fetch(`${origin}/v1/result-artifact`, {
    method: 'PUT',
    headers: {
      ...uploadHeaders,
      'content-length': String(artifact.sizeBytes),
    },
    body: slowBody(),
    duplex: 'half',
  });
  assert.equal(uploaded.status, 201, await uploaded.text());
  assert(heartbeatCount >= 2, 'the upload must span multiple successful lease heartbeats');
  const finalized = await post('/v1/result-finalize', { lease: activeLease, intentDigest: intent.value.intentDigest });
  assert.equal(finalized.response.status, 202, JSON.stringify(finalized.value));
  assert.equal(finalized.value.state, 'completed_pass');
  const terminalHeartbeat = await post('/v1/heartbeat', { lease: activeLease });
  assert.equal(terminalHeartbeat.response.status, 202, JSON.stringify(terminalHeartbeat.value));
  assert.equal(terminalHeartbeat.value.terminal, true,
    'a heartbeat racing the successful final response must not falsely fence the worker');
  const replayed = await post('/v1/result-finalize', { lease: activeLease, intentDigest: intent.value.intentDigest });
  assert.equal(replayed.response.status, 202, JSON.stringify(replayed.value));
  assert.equal(replayed.value.canonicalResult.digest, finalized.value.canonicalResult.digest);
  const state = await readParentRun(store, runId);
  assert.equal(state.workItems['stream-http-work'].attempts.length, 1);
  assert.equal(state.workItems['stream-http-work'].attempts[0].uploadIntentDigest, intent.value.intentDigest);
  assert.deepEqual(state.workItems['stream-http-work'].canonicalResult.evidenceDigests, [member.memberDigest]);

  const retired = await post('/v1/result', { lease: activeLease, result: { ...result, artifacts: [] } });
  assert.equal(retired.response.status, 404, 'the buffered base64 result route must remain retired');
  process.stdout.write('Shared streaming evidence HTTP self-test passed: raw uploads span heartbeats, finalize exactly once, replay safely, and never use the retired JSON evidence route.\n');
} finally {
  if (coordinator) await stopProcess(coordinator);
  await fs.rm(root, { recursive: true, force: true });
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not allocate a coordinator port.');
  return address.port;
}

async function rawHttpStatus(port, request) {
  const socket = connect(port, '127.0.0.1');
  socket.setEncoding('utf8');
  let response = '';
  socket.on('data', (chunk) => { response += chunk; });
  await once(socket, 'connect');
  socket.end(request);
  await once(socket, 'close');
  return response.split('\r\n', 1)[0] ?? '';
}

async function startCoordinator({ port, environment }) {
  const child = spawn(process.execPath, ['scripts/run-shared-coordinator.mjs'], {
    cwd: new URL('..', import.meta.url), env: environment, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Coordinator exited ${child.exitCode}: ${stderr.slice(-4_000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return { child, stderr: () => stderr };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGKILL');
  throw new Error(`Coordinator did not become healthy: ${stderr.slice(-4_000)}`);
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
