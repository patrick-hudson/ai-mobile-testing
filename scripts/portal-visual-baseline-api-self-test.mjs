import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  parseVisualBaselineEvidence,
  parseVisualBaselineIdentity,
  visualBaselineDigest,
  visualBaselineIdentityKey,
  visualBaselineSlotKey,
} from '../shared/visual-baseline-contract.mjs';
import {
  canonicalJson,
  claimJob,
  openJobQueue,
  publishAttemptDocument,
  settleJobAttempt,
  sha256,
  submitJob,
} from './lib/job-queue.mjs';
import { verifyVisualComparatorCalibration } from './lib/visual-comparator-calibration.mjs';
import { initializeLegacyAuthorityFence } from './lib/legacy-authority-fence.mjs';

const temporary = await fs.mkdtemp(join(tmpdir(), 'portal-visual-baseline-api-'));
const operatorToken = 'portal-visual-baseline-self-test-operator-token-0000000000000001';
const comparatorCalibration = await verifyVisualComparatorCalibration();
let child;

try {
  const legacyAuthorityFenceRoot = join(temporary, 'legacy-authority');
  await initializeLegacyAuthorityFence({ root: legacyAuthorityFenceRoot, verifyStorage: false });
  const baselineRoot = join(temporary, 'baselines');
  const queueRoot = join(temporary, 'jobs');
  const finalizationRoot = join(temporary, 'finalizations');
  const fakeFfprobe = join(temporary, 'fake-ffprobe');
  const fakeFfmpeg = join(temporary, 'fake-ffmpeg');
  await fs.writeFile(
    fakeFfprobe,
    '#!/bin/sh\nprintf \'%s\\n\' \'{"streams":[{"codec_type":"video","codec_name":"png","width":1,"height":1}]}\'\n',
    { mode: 0o700 },
  );
  await fs.writeFile(fakeFfmpeg, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const queue = await openJobQueue({ root: queueRoot, verifyStorage: false });
  const approvalInput = { schemaVersion: 1, fixture: 'portal-baseline-approval-api' };
  const approvalSubmitted = await submitJob(
    queue,
    queueSubmission(approvalInput, 'baseline-approval'),
    { inputDocument: approvalInput },
  );
  const approvalClaim = await claimJob(queue, approvalSubmitted.state.jobId, 'portal-baseline-api-worker');
  const artifactRoot = join(
    queueRoot, 'jobs', approvalClaim.jobId, 'attempts', approvalClaim.attemptId, 'work', 'artifacts',
  );
  await fs.mkdir(artifactRoot, { recursive: true });
  const firstBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const secondBytes = Buffer.concat([firstBytes, Buffer.from('portal-replacement')]);
  await fs.writeFile(join(artifactRoot, 'first.png'), firstBytes);
  await fs.writeFile(join(artifactRoot, 'second.png'), secondBytes);
  await publishAttemptDocument(queue, approvalClaim, {
    publicationId: 'portal-baseline-api-result',
    relativePath: 'worker/attempt-result.json',
    document: { fixture: true },
  });
  const approvalState = await settleJobAttempt(queue, approvalClaim, { kind: 'success' });
  const identity = visualIdentity();
  const firstEvidence = visualEvidence(approvalState.jobId, firstBytes, 'first.png');
  const secondEvidence = visualEvidence(approvalState.jobId, secondBytes, 'second.png');
  const firstEvidenceId = eligibilityEvidenceId(approvalState, identity, firstEvidence);
  const secondEvidenceId = eligibilityEvidenceId(approvalState, identity, secondEvidence);
  await publishEligibilityFixture({
    finalizationRoot,
    state: approvalState,
    identity,
    entries: [
      { evidenceId: firstEvidenceId, evidence: firstEvidence },
      { evidenceId: secondEvidenceId, evidence: secondEvidence },
    ],
  });

  const purgeInput = { schemaVersion: 1, fixture: 'portal-purge-api' };
  const submitted = await submitJob(queue, queueSubmission(purgeInput, 'purge'), { inputDocument: purgeInput });
  const purgeClaim = await claimJob(queue, submitted.state.jobId, 'portal-purge-api-worker');
  const purgeState = await settleJobAttempt(queue, purgeClaim, {
    kind: 'failed', reason: 'Synthetic terminal portal purge API fixture.',
  });
  await fs.mkdir(join(finalizationRoot, purgeState.jobId), { recursive: true });
  await fs.writeFile(join(finalizationRoot, purgeState.jobId, 'status.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'single-site-finalization-status',
    jobId: purgeState.jobId,
    status: 'incomplete',
    deadlineExceeded: false,
    executionState: 'failed',
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
      PORTAL_VISUAL_BASELINE_ROOT: baselineRoot,
      PORTAL_SECRET_ROOT: join(temporary, 'secrets'),
      PORTAL_E2E_FAILURE_INJECTION: '1',
      PORTAL_E2E_OPERATOR_TOKEN: operatorToken,
      AUDIT_LEGACY_AUTHORITY_FENCE_ROOT: legacyAuthorityFenceRoot,
      AI_REVIEW_DRY_RUN: '1',
      FFPROBE_PATH: fakeFfprobe,
      FFMPEG_PATH: fakeFfmpeg,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitForHealth(baseUrl, child, () => stderr);

  const collectionResponse = await fetch(`${baseUrl}/api/single-site/visual-baselines`);
  assert.equal(collectionResponse.status, 200);
  const collection = await collectionResponse.json();
  assert.equal(collection.storeRevision, 0);
  assert.equal(collection.total, 0);
  assert.equal(collection.mutationCapability.authorized, false);
  assert.ok(collection.items.every((item) => !('relativePath' in item.media)));

  const unauthorized = await fetch(`${baseUrl}/api/single-site/visual-baselines/not-created/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(unauthorized.status, 401);

  const eligibilityPath = join(finalizationRoot, approvalState.jobId, 'visual', 'eligibility.json');
  const heldEligibilityPath = `${eligibilityPath}.held`;
  await fs.rename(eligibilityPath, heldEligibilityPath);
  const unavailableEligibility = await operatorFetch(baseUrl, '/api/single-site/visual-baselines/approve', {
    expectedStoreRevision: 0,
    runId: approvalState.jobId,
    evidenceId: firstEvidenceId,
    reason: 'Fail-closed eligibility fixture.',
    idempotencyKey: 'unavailable-eligibility-fixture',
    confirmation: `APPROVE ${firstEvidenceId}`,
  });
  assert.equal(unavailableEligibility.status, 409);
  assert.equal((await unavailableEligibility.json()).code, 'SINGLE_SITE_BASELINE_ELIGIBILITY_UNAVAILABLE');
  await fs.rename(heldEligibilityPath, eligibilityPath);

  const forgedActor = await operatorFetch(baseUrl, '/api/single-site/visual-baselines/approve', {
    expectedStoreRevision: 0,
    runId: approvalState.jobId,
    evidenceId: firstEvidenceId,
    reason: 'Forged actor fixture.',
    idempotencyKey: 'forged-actor-fixture',
    confirmation: `APPROVE ${firstEvidenceId}`,
    actorId: 'forged-browser-reviewer',
  });
  assert.equal(forgedActor.status, 400);
  assert.match(await forgedActor.text(), /Client-supplied actor identity is not allowed/);

  const approvalBody = {
    expectedStoreRevision: 0,
    runId: approvalState.jobId,
    evidenceId: firstEvidenceId,
    reason: 'Portal baseline API manifest-bound approval fixture.',
    idempotencyKey: 'portal-approve-fixture',
    confirmation: `APPROVE ${firstEvidenceId}`,
  };
  const approval = await operatorFetch(baseUrl, '/api/single-site/visual-baselines/approve', approvalBody);
  assert.equal(approval.status, 201, await approval.clone().text());
  const approvedDocument = await approval.json();
  const approved = approvedDocument.result;
  assert.equal(approvedDocument.baseline.approvedBy, 'portal-operator');
  const approvalRetry = await operatorFetch(baseUrl, '/api/single-site/visual-baselines/approve', approvalBody);
  assert.equal(approvalRetry.status, 201, await approvalRetry.clone().text());
  assert.equal((await approvalRetry.json()).result.eventId, approved.eventId);

  const replacementBody = {
    expectedStoreRevision: 1,
    runId: approvalState.jobId,
    evidenceId: secondEvidenceId,
    reason: 'Portal baseline API manifest-bound replacement fixture.',
    idempotencyKey: 'portal-replace-fixture',
    confirmation: `REPLACE ${approved.baselineId} ${secondEvidenceId}`,
  };
  const replacement = await operatorFetch(
    baseUrl,
    `/api/single-site/visual-baselines/${approved.baselineId}/replace`,
    replacementBody,
  );
  assert.equal(replacement.status, 200, await replacement.clone().text());
  const replacedDocument = await replacement.json();
  const replaced = replacedDocument.result;
  const replacementRetry = await operatorFetch(
    baseUrl,
    `/api/single-site/visual-baselines/${approved.baselineId}/replace`,
    replacementBody,
  );
  assert.equal(replacementRetry.status, 200, await replacementRetry.clone().text());
  assert.equal((await replacementRetry.json()).result.eventId, replaced.eventId);

  const media = await fetch(`${baseUrl}/api/single-site/visual-baselines/${replaced.baselineId}/media`);
  assert.equal(media.status, 200, await media.clone().text());
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), secondBytes);

  const incorrectPurge = await operatorFetch(baseUrl, `/api/single-site/runs/${purgeState.jobId}`, {
    confirmation: purgeState.jobId,
  }, 'DELETE');
  assert.equal(incorrectPurge.status, 400);
  if (process.platform === 'linux') {
    const purgedRun = await operatorFetch(baseUrl, `/api/single-site/runs/${purgeState.jobId}`, {
      confirmation: `PURGE ${purgeState.jobId}`,
    }, 'DELETE');
    assert.equal(purgedRun.status, 200, await purgedRun.clone().text());
    const purgeResult = await purgedRun.json();
    assert.equal(purgeResult.jobId, purgeState.jobId);
    assert.equal(purgeResult.purged, true);
    assert.equal(purgeResult.terminalState, 'failed');
    assert.equal(purgeResult.baselineBytesPreserved, true);
    assert.match(purgeResult.message, /baseline media.*preserved/i);
  }
  assert.equal((await fetch(`${baseUrl}/api/single-site/visual-baselines/${replaced.baselineId}/media`)).status, 200);

  const revokeBody = {
    expectedStoreRevision: 2,
    reason: 'Portal baseline API revoke fixture.',
    idempotencyKey: 'portal-revoke-fixture',
    confirmation: `REVOKE ${replaced.baselineId}`,
  };
  const revoked = await operatorFetch(
    baseUrl,
    `/api/single-site/visual-baselines/${replaced.baselineId}/revoke`,
    revokeBody,
  );
  assert.equal(revoked.status, 200, await revoked.clone().text());
  const revokedDocument = await revoked.json();
  assert.equal(revokedDocument.baseline.state, 'revoked');
  const revokeRetry = await operatorFetch(
    baseUrl,
    `/api/single-site/visual-baselines/${replaced.baselineId}/revoke`,
    revokeBody,
  );
  assert.equal(revokeRetry.status, 200, await revokeRetry.clone().text());
  assert.equal((await revokeRetry.json()).result.eventId, revokedDocument.result.eventId);

  const staleDelete = await operatorFetch(baseUrl, `/api/single-site/visual-baselines/${replaced.baselineId}`, {
    expectedStoreRevision: 2,
    reason: 'Stale revision fixture.',
    idempotencyKey: 'portal-stale-delete-fixture',
    confirmation: `DELETE ${replaced.baselineId}`,
  }, 'DELETE');
  assert.equal(staleDelete.status, 409);
  assert.equal((await staleDelete.json()).code, 'BASELINE_CAS_CONFLICT');

  const deleteBody = {
    expectedStoreRevision: 3,
    reason: 'Portal baseline API guarded media deletion fixture.',
    idempotencyKey: 'portal-delete-fixture',
    confirmation: `DELETE ${replaced.baselineId}`,
  };
  const deleted = await operatorFetch(
    baseUrl,
    `/api/single-site/visual-baselines/${replaced.baselineId}`,
    deleteBody,
    'DELETE',
  );
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const deletedDocument = await deleted.json();
  assert.equal(deletedDocument.baseline.state, 'deleted');
  const deleteRetry = await operatorFetch(
    baseUrl,
    `/api/single-site/visual-baselines/${replaced.baselineId}`,
    deleteBody,
    'DELETE',
  );
  assert.equal(deleteRetry.status, 200, await deleteRetry.clone().text());
  assert.equal((await deleteRetry.json()).result.eventId, deletedDocument.result.eventId);
  assert.equal((await fetch(`${baseUrl}/api/single-site/visual-baselines/${replaced.baselineId}/media`)).status, 410);

  const historyResponse = await fetch(
    `${baseUrl}/api/single-site/visual-baselines/history?baselineId=${encodeURIComponent(replaced.baselineId)}&limit=20`,
  );
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  assert.deepEqual(history.items.map((event) => event.type), ['replaced', 'revoked', 'deleted']);
  assert.deepEqual(history.items.map((event) => event.actorId), ['portal-operator', 'portal-operator', 'portal-operator']);

  console.log('portal visual-baseline API self-test passed');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await fs.rm(temporary, { recursive: true, force: true });
}

function visualIdentity() {
  const digest = (character) => `sha256:${character.repeat(64)}`;
  return parseVisualBaselineIdentity({
    schemaVersion: 1,
    mode: 'single-site',
    deploymentRole: 'preview',
    route: '/',
    targetId: 'single-site-desktop-chromium',
    viewport: { width: 1280, height: 720 },
    theme: 'light',
    auditId: 'VISUAL-001',
    auditDefinitionDigest: digest('c'),
    capturePoint: 'loaded-page',
    browser: { engine: 'chromium', product: 'Chromium', version: '140.0', build: 'build-1' },
    rendering: {
      devicePixelRatio: 1,
      captureContractRevision: 'capture-v1',
      runnerImageDigest: digest('a'),
      fontPackDigest: digest('b'),
    },
  });
}

function visualEvidence(runId, bytes, artifactRelativePath) {
  return parseVisualBaselineEvidence({
    runId,
    artifactRelativePath,
    artifactSha256: visualBaselineDigest(bytes),
    artifactBytes: bytes.length,
    contentType: 'image/png',
    runStatus: 'completed',
    evidenceComplete: true,
    evidenceAuthority: { status: 'authoritative', reasons: [] },
    findingStatus: 'clear',
    findingWaiver: null,
  });
}

function queueSubmission(input, suffix) {
  const digest = (label) => sha256(`portal-${suffix}-${label}`);
  return {
    idempotencyKey: `portal-${suffix}`,
    runMode: 'single-site',
    inputDocumentDigest: sha256(canonicalJson(input)),
    runContractDigest: digest('contract'),
    compiledManifestDigest: digest('manifest'),
    preflightDigest: digest('preflight'),
    identityFingerprint: digest('identity'),
    revisionFingerprint: digest('revision'),
    evidenceAuthority: { authoritative: true, reasons: [] },
    registryRevision: `portal-${suffix}-registry-v1`,
    targetSetRevision: `portal-${suffix}-targets-v1`,
    runnerRevision: `portal-${suffix}-runner-v1`,
    stageDeadlines: {
      browser: '2099-01-01T00:10:00.000Z',
      finalizer: '2099-01-01T00:20:00.000Z',
    },
  };
}

function eligibilityEvidenceId(state, identity, evidence) {
  return visualBaselineDigest({
    jobId: state.jobId,
    attemptId: state.attemptId,
    identityKey: visualBaselineIdentityKey(identity),
    artifactSha256: evidence.artifactSha256,
  });
}

async function publishEligibilityFixture({ finalizationRoot, state, identity, entries }) {
  const finalizationDigest = 'a'.repeat(64);
  const reportRevision = finalizationDigest.slice(0, 32);
  const reportPublicationDigest = 'b'.repeat(64);
  const generatedAt = '2026-08-25T20:00:00.000Z';
  const directory = join(finalizationRoot, state.jobId);
  await fs.mkdir(join(directory, 'visual'), { recursive: true });
  const identityKey = visualBaselineIdentityKey(identity);
  const slotKey = visualBaselineSlotKey(identity);
  const manifestBody = {
    schemaVersion: 1,
    kind: 'single-site-visual-baseline-eligibility',
    mode: 'single-site',
    jobId: state.jobId,
    attemptId: state.attemptId,
    finalizationDigest,
    reportRevision,
    generatedAt,
    comparatorCalibration,
    items: entries.map(({ evidenceId, evidence }) => ({
      evidenceId,
      identity,
      identityKey,
      slotKey,
      evidence,
      requiresFindingWaiver: evidence.findingStatus === 'unresolved',
      eligible: true,
      ineligibilityReasons: [],
    })),
  };
  const manifestDigest = visualBaselineDigest(manifestBody);
  await fs.writeFile(join(directory, 'visual', 'eligibility.json'), `${JSON.stringify({
    ...manifestBody,
    manifestDigest,
  })}\n`);
  const statusBody = {
    schemaVersion: 1,
    kind: 'single-site-finalization-status',
    jobId: state.jobId,
    status: 'complete',
    deadlineExceeded: false,
    executionState: 'completed',
    finalizationDigest,
    failureDigest: null,
    reportRevision,
    reportPublicationDigest,
    visualPublicationDigest: visualBaselineDigest({ fixture: 'visual-publication' }),
    visualEligibilityManifestDigest: manifestDigest,
  };
  await fs.writeFile(join(directory, 'status.json'), `${JSON.stringify({
    ...statusBody,
    statusDigest: sha256(canonicalJson(statusBody)),
  })}\n`);
}

async function operatorFetch(baseUrl, pathname, body, method = 'POST') {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-portal-operator-token': operatorToken,
    },
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
  if (!port) throw new Error('Could not allocate a portal baseline self-test port.');
  return port;
}

async function waitForHealth(baseUrl, processHandle, stderr) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Portal exited during baseline API self-test: ${stderr()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Listener startup races are expected.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Portal did not become healthy for baseline API self-test: ${stderr()}`);
}
