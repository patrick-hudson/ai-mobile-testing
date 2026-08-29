import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { openScopedCredentialAuthority } from '../portal/scoped-credential-authority.mjs';
import {
  acquireCoordinator,
  adoptAttemptEvidence,
  claimWorkItem,
  createParentRun,
  listAdoptedAttemptArtifacts,
  openParentRunStore,
  publishAttemptEvidence,
  readParentRun,
} from './lib/parent-run-store.mjs';

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
  const sharedCoordinator = await acquireCoordinator(sharedStore, sharedRunId, {
    ownerId: 'portal-artifact-fixture', leaseMs: 1_000,
  });
  const sharedLease = await claimWorkItem(sharedStore, sharedRunId, sharedCoordinator, {
    workerId: 'portal-artifact-worker', capabilities: ['browser:chromium'],
    resourceClasses: ['ordinary'], leaseMs: 60_000,
  });
  const sharedCanaryBytes = Buffer.from('protected-shared-op-0001-bytes');
  const sharedActiveBytes = Buffer.from("<script>document.body.textContent='active-shared-op-0001'</script>");
  const sharedDeclaredActiveBytes = Buffer.from('<svg onload="document.body.textContent=\'declared-active\'"></svg>');
  const sharedSuffixActiveBytes = Buffer.from('<script>document.body.textContent="suffix-active"</script>');
  const sharedRawLogs = [
    ['logs/stdout.txt', 'lowercase-log'],
    ['Logs/stdout.txt', 'uppercase-directory-log'],
    ['evidence/worker.LOG', 'uppercase-suffix-log'],
  ];
  const sharedInbox = await publishAttemptEvidence(sharedStore, sharedRunId, sharedLease, {
    outcome: 'completed_pass',
    reason: 'Shared artifact delivery fixture completed.',
    artifacts: [
      bufferedArtifact('evidence/canary.bin', 'application/octet-stream', sharedCanaryBytes),
      bufferedArtifact('evidence/active.html', 'text/html', sharedActiveBytes),
      bufferedArtifact('evidence/declared-active.png', 'text/html', sharedDeclaredActiveBytes),
      bufferedArtifact('evidence/suffix-active.html', 'application/octet-stream', sharedSuffixActiveBytes),
      ...sharedRawLogs.map(([name, content]) => bufferedArtifact(name, 'text/plain', Buffer.from(content))),
    ],
  });
  await adoptAttemptEvidence(sharedStore, sharedRunId, sharedCoordinator, sharedInbox);
  const sharedState = await readParentRun(sharedStore, sharedRunId);
  const sharedArtifacts = sharedState.workItems['work-shared-op-0001'].attempts.at(-1).artifacts;
  const sharedCanary = sharedArtifacts.find(({ name }) => name === 'evidence/canary.bin');
  const sharedActive = sharedArtifacts.find(({ name }) => name === 'evidence/active.html');
  assert.ok(sharedCanary?.memberDigest && sharedActive?.memberDigest);
  const sharedArtifactDescriptors = await listAdoptedAttemptArtifacts(sharedStore, sharedRunId);
  const sharedCanaryDescriptor = sharedArtifactDescriptors.files.find(({ memberDigest }) => memberDigest === sharedCanary.memberDigest);
  const sharedActiveDescriptor = sharedArtifactDescriptors.files.find(({ memberDigest }) => memberDigest === sharedActive.memberDigest);
  const sharedDeclaredActiveDescriptor = sharedArtifactDescriptors.files.find(({ name }) => name === 'evidence/declared-active.png');
  const sharedSuffixActiveDescriptor = sharedArtifactDescriptors.files.find(({ name }) => name === 'evidence/suffix-active.html');
  assert.ok(sharedCanaryDescriptor?.artifactKey && sharedActiveDescriptor?.artifactKey);
  assert.ok(sharedDeclaredActiveDescriptor?.artifactKey && sharedSuffixActiveDescriptor?.artifactKey);
  const sharedAttempt = sharedState.workItems['work-shared-op-0001'].attempts.at(-1);
  const sharedRawLogKeys = sharedAttempt.artifacts
    .map((artifact, index) => ({ artifact, ordinal: index + 1 }))
    .filter(({ artifact }) => sharedRawLogs.some(([name]) => name === artifact.name))
    .map(({ artifact, ordinal }) => canonicalDigest({
      schemaVersion: 1,
      kind: 'adopted-artifact-access-key',
      workItemId: 'work-shared-op-0001',
      canonicalResultDigest: sharedState.workItems['work-shared-op-0001'].canonicalResult.digest,
      attempt: sharedAttempt.attempt,
      ordinal,
      name: artifact.name,
      contentDigest: artifact.digest,
      memberDigest: artifact.memberDigest,
    }));
  assert.equal(sharedRawLogKeys.length, sharedRawLogs.length);
  const collisionDirectory = path.join(artifacts, sharedRunId, 'work-items', 'work-shared-op-0001');
  const unknownMemberDigest = `sha256:${'f'.repeat(64)}`;
  await mkdir(collisionDirectory, { recursive: true });
  await writeFile(path.join(collisionDirectory, sharedCanaryDescriptor.artifactKey), 'legacy-collision-must-not-win');
  await writeFile(path.join(collisionDirectory, unknownMemberDigest), 'legacy-fallback-must-not-win');
  const authority = await openScopedCredentialAuthority({ root: credentials });
  const viewerA = await authority.createPrincipal({
    id: 'viewer-a', kind: 'human', roles: ['viewer'], projectIds: ['project-1'], runIds: ['run-a-0001', sharedRunId],
  });
  const viewerAll = await authority.createPrincipal({
    id: 'viewer-all', kind: 'human', roles: ['viewer'], projectIds: ['project-1'], runIds: ['*'],
  });
  const delivery = await authority.createPrincipal({
    id: 'delivery-a', kind: 'service', roles: ['delivery'], projectIds: ['project-1'], runIds: ['run-a-0001', sharedRunId],
  });
  const operator = await authority.createPrincipal({
    id: 'operator-a', kind: 'human', roles: ['operator'], projectIds: ['project-1'], runIds: [sharedRunId],
  });
  const operatorTokenFile = path.join(root, 'operator.token');
  const cancelBodyFile = path.join(root, 'cancel.json');
  await writeFile(operatorTokenFile, `${operator.credential}\n`, { mode: 0o600 });
  await writeFile(cancelBodyFile, `${JSON.stringify({
    expectedRunRevision: sharedState.runRevision,
    reason: 'CLI restart integration proof.',
  })}\n`, { mode: 0o600 });
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
    PORTAL_SHARED_READ_REAUTH_MS: '60000',
    PORTAL_E2E_FAILURE_INJECTION: '1',
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
    [`${origin}/artifacts/${sharedRunId}/work-items/work-shared-op-0001/${encodeURIComponent(sharedCanaryDescriptor.artifactKey)}`, {}],
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
  const sharedListResponse = await fetch(`${origin}/api/runs/${sharedRunId}/artifacts`, {
    headers: { Cookie: viewerACookie.cookie },
  });
  const sharedList = await sharedListResponse.json();
  assert.equal(sharedListResponse.status, 200, JSON.stringify(sharedList));
  assert.equal(sharedList.total, 4);
  assert.equal(sharedList.files.length, 4);
  assert.equal(sharedList.files.some(({ relativePath }) => relativePath !== undefined), false,
    'shared artifact listings must not disclose canonical store paths');
  const sharedCanaryUrl = `/artifacts/${sharedRunId}/work-items/work-shared-op-0001/${encodeURIComponent(sharedCanaryDescriptor.artifactKey)}`;
  assert.equal(sharedList.files.find(({ memberDigest }) => memberDigest === sharedCanary.memberDigest)?.url, sharedCanaryUrl);
  const sharedSingleSiteListResponse = await fetch(`${origin}/api/single-site/runs/${sharedRunId}/artifacts`, {
    headers: { Cookie: viewerACookie.cookie },
  });
  const sharedSingleSiteList = await sharedSingleSiteListResponse.json();
  assert.equal(sharedSingleSiteListResponse.status, 200, JSON.stringify(sharedSingleSiteList));
  assert.equal(sharedSingleSiteList.files.find(({ memberDigest }) => memberDigest === sharedCanary.memberDigest)?.url,
    sharedCanaryUrl, 'Single-site compatibility reads emit the same mode-neutral canonical URL');
  const sharedArtifact = await fetch(`${origin}${sharedCanaryUrl}`, { headers: { Cookie: viewerACookie.cookie } });
  const sharedArtifactBody = await sharedArtifact.text();
  assert.equal(sharedArtifact.status, 200, sharedArtifactBody);
  assert.equal(sharedArtifactBody, 'protected-shared-op-0001-bytes');
  assert.equal(sharedArtifact.headers.get('etag'), `\"${sharedCanary.digest}\"`);
  const sharedSingleSiteArtifact = await fetch(
    `${origin}${sharedCanaryUrl.replace('/artifacts/', '/single-site-artifacts/')}`,
    { headers: { Cookie: viewerACookie.cookie } },
  );
  const sharedSingleSiteArtifactBody = await sharedSingleSiteArtifact.text();
  assert.equal(sharedSingleSiteArtifact.status, 200, sharedSingleSiteArtifactBody);
  assert.equal(sharedSingleSiteArtifactBody, 'protected-shared-op-0001-bytes');
  const sharedHead = await fetch(`${origin}${sharedCanaryUrl}`, {
    method: 'HEAD', headers: { Cookie: viewerACookie.cookie },
  });
  assert.equal(sharedHead.status, 200);
  assert.equal(sharedHead.headers.get('content-length'), String(sharedCanary.sizeBytes));
  const sharedRange = await fetch(`${origin}${sharedCanaryUrl}`, {
    headers: { Cookie: viewerACookie.cookie, Range: 'bytes=0-8' },
  });
  assert.equal(sharedRange.status, 206);
  assert.equal(sharedRange.headers.get('content-range'), `bytes 0-8/${sharedCanary.sizeBytes}`);
  assert.equal(await sharedRange.text(), 'protected');
  const longTransfer = fetch(`${origin}${sharedCanaryUrl}`, {
    headers: {
      Cookie: viewerACookie.cookie,
      'x-portal-e2e-send-file-delay-ms': '16000',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 15_250));
  const leaseDirectory = path.join(store, 'runs', sharedRunId, '.artifact-read-leases');
  const leaseNames = (await readdir(leaseDirectory)).filter((name) => name.endsWith('.json'));
  assert.equal(leaseNames.length, 1, 'a long canonical transfer retains one durable read lease');
  const renewedLease = JSON.parse(await readFile(path.join(leaseDirectory, leaseNames[0]), 'utf8'));
  assert.ok(Date.parse(renewedLease.expiresAt) > Date.now() + 5_000,
    'the maximum configured portal interval is clamped below the store lease and renews before expiry');
  const longTransferResponse = await longTransfer;
  const longTransferBody = await longTransferResponse.text();
  assert.equal(longTransferResponse.status, 200, longTransferBody);
  assert.equal(longTransferBody, 'protected-shared-op-0001-bytes');
  await stopPortal(portal);
  portal = null;
  portal = await startPortal({
    environment: { ...environment, PORTAL_SHARED_READ_REAUTH_MS: '250' },
    origin,
  });
  for (const artifactKey of sharedRawLogKeys) {
    for (const options of [{}, { method: 'HEAD' }, { headers: { Range: 'bytes=0-3' } }]) {
      const deniedRawLog = await fetch(
        `${origin}/artifacts/${sharedRunId}/work-items/work-shared-op-0001/${encodeURIComponent(artifactKey)}`,
        {
          ...options,
          headers: { Cookie: viewerACookie.cookie, ...(options.headers ?? {}) },
        },
      );
      assert.equal(deniedRawLog.status, 404,
        `${options.method ?? (options.headers?.Range ? 'RANGE' : 'GET')} must not expose raw attempt logs by key`);
    }
  }
  const unknownSharedArtifact = await fetch(
    `${origin}/artifacts/${sharedRunId}/work-items/work-shared-op-0001/${encodeURIComponent(unknownMemberDigest)}`,
    { headers: { Cookie: viewerACookie.cookie } },
  );
  assert.equal(unknownSharedArtifact.status, 404, 'a canonical run must never fall through to a colliding legacy path');
  assert.doesNotMatch(await unknownSharedArtifact.text(), /legacy-fallback-must-not-win/u);
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
    `${origin}/artifacts/run-b-0002/work-items/work-shared-op-0001/${encodeURIComponent(sharedCanaryDescriptor.artifactKey)}`,
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
  const sharedActiveResponse = await fetch(
    `${origin}/artifacts/${sharedRunId}/work-items/work-shared-op-0001/${encodeURIComponent(sharedActiveDescriptor.artifactKey)}`,
    { headers: { Cookie: viewerACookie.cookie } },
  );
  assert.equal(sharedActiveResponse.status, 200);
  assert.match(sharedActiveResponse.headers.get('content-disposition') ?? '', /^attachment;/u);
  assert.match(sharedActiveResponse.headers.get('content-security-policy') ?? '', /default-src 'none'/u);
  for (const descriptor of [sharedDeclaredActiveDescriptor, sharedSuffixActiveDescriptor]) {
    const mismatchedActive = await fetch(
      `${origin}/artifacts/${sharedRunId}/work-items/${descriptor.workItemId}/${encodeURIComponent(descriptor.artifactKey)}`,
      { headers: { Cookie: viewerACookie.cookie } },
    );
    assert.equal(mismatchedActive.status, 200);
    assert.match(mismatchedActive.headers.get('content-disposition') ?? '', /^attachment;/u,
      'either an active declared media type or active filename suffix forces inert download');
    assert.match(mismatchedActive.headers.get('content-security-policy') ?? '', /default-src 'none'/u);
  }

  const racedSharedRequest = fetch(`${origin}${sharedCanaryUrl}`, {
    headers: {
      Cookie: viewerACookie.cookie,
      'x-portal-e2e-send-file-delay-ms': '1000',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await writeFile(
    path.join(store, 'runs', sharedRunId, sharedCanary.relativePath),
    Buffer.alloc(sharedCanary.sizeBytes, 0x79),
  );
  const racedSharedArtifact = await racedSharedRequest;
  const racedSharedBody = await racedSharedArtifact.text();
  assert.equal(racedSharedArtifact.status, 409, racedSharedBody);
  assert.doesNotMatch(racedSharedBody, /protected-shared-op-0001-bytes/u,
    'same-FD metadata is rechecked immediately before streaming canonical bytes');
  await writeFile(path.join(store, 'runs', sharedRunId, sharedCanary.relativePath), sharedCanaryBytes);

  await writeFile(
    path.join(store, 'runs', sharedRunId, sharedCanary.relativePath),
    Buffer.alloc(sharedCanary.sizeBytes, 0x78),
  );
  const tamperedSharedArtifact = await fetch(`${origin}${sharedCanaryUrl}`, {
    headers: { Cookie: viewerACookie.cookie },
  });
  const tamperedSharedBody = await tamperedSharedArtifact.text();
  assert.equal(tamperedSharedArtifact.status, 500, tamperedSharedBody);
  assert.doesNotMatch(tamperedSharedBody, /protected-shared-op-0001-bytes|legacy-collision-must-not-win/u,
    'digest failure must occur before canonical or fallback bytes are returned');

  const deliveryArtifact = await fetch(`${origin}/artifacts/run-a-0001/canary.bin`, {
    headers: { Authorization: `Bearer ${delivery.credential}` },
  });
  assert.equal(deliveryArtifact.status, 403, 'delivery credentials may consume release truth but not raw evidence');
  const deliverySharedArtifact = await fetch(`${origin}${sharedCanaryUrl}`, {
    headers: { Authorization: `Bearer ${delivery.credential}` },
  });
  assert.equal(deliverySharedArtifact.status, 403, 'delivery credentials may not read canonical shared evidence');

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
  const stableSharedList = await fetch(`${origin}/api/runs/${sharedRunId}/artifacts`, {
    headers: { Cookie: sharedOperatorCookie.cookie },
  });
  const stableSharedListBody = await stableSharedList.json();
  assert.equal(stableSharedList.status, 200, JSON.stringify(stableSharedListBody));
  assert.equal(stableSharedListBody.files.find(({ memberDigest }) => memberDigest === sharedCanary.memberDigest)?.url,
    sharedCanaryUrl, 'canonical artifact URLs remain stable across portal restart');

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

function bufferedArtifact(name, mediaType, bytes) {
  return {
    name,
    mediaType,
    sizeBytes: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    contentBase64: bytes.toString('base64'),
  };
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
