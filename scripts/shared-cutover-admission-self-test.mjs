import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createCutoverAdmissionPolicy,
  initializeCutoverAdmissionGate,
  openCutoverAdmissionGate,
} from './lib/shared-cutover-orchestrator.mjs';
import {
  acquireStoreCoordinator,
  createParentRun,
  openParentRunStore,
  readReleaseAuthoritySelector,
  transitionReleaseAuthority,
} from './lib/parent-run-store.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import { createSharedControlApi } from '../portal/shared-control-api.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-cutover-admission-'));
let now = Date.parse('2026-08-29T20:00:00.000Z');
const clock = () => now;

async function expectCode(code, operation) {
  await assert.rejects(operation, (error) => error?.code === code);
}

async function runAdmissionInit(storeRoot) {
  const child = spawn(process.execPath, ['scripts/init-shared-admission.mjs', storeRoot], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'exit');
  return { code, signal, stdout, stderr };
}

try {
  const missingRoot = path.join(root, 'missing');
  await expectCode('CUTOVER_ADMISSION_UNAVAILABLE', () => openCutoverAdmissionGate({
    root: missingRoot, verifyStorage: false, clock,
  }));

  const gate = await initializeCutoverAdmissionGate({ root: missingRoot, verifyStorage: false, clock });
  assert.equal((await gate.read()).state, 'OPEN');
  const reopened = await openCutoverAdmissionGate({ root: missingRoot, verifyStorage: false, clock });
  const policy = createCutoverAdmissionPolicy({ admissionGate: reopened });

  let releaseMutationAccepted = 0;
  await policy.withLaunchAdmission('launch-request-0001', async () => 'launched');
  await policy.withMutationAdmission('cancel', 'cancel-request-0001', async () => {
    releaseMutationAccepted += 1;
  });
  assert.equal(releaseMutationAccepted, 1);

  let releaseAcceptanceEntered;
  const entered = new Promise((resolve) => { releaseAcceptanceEntered = resolve; });
  let finishReleaseAcceptance;
  const finish = new Promise((resolve) => { finishReleaseAcceptance = resolve; });
  const inFlight = policy.withMutationAdmission('rekick', 'rekick-request-0001', async () => {
    releaseAcceptanceEntered();
    await finish;
  });
  await entered;
  const beforeClose = await reopened.read();
  let closeSettled = false;
  const closing = reopened.close(beforeClose.digest, 'cutover-admission-test').then((value) => {
    closeSettled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false, 'close must wait for an acceptance holding the admission fence');
  finishReleaseAcceptance();
  await inFlight;
  const closed = await closing;
  assert.equal(closed.state, 'CLOSED');

  for (const kind of ['cancel', 'rekick', 'visual-disposition', 'purge']) {
    await expectCode('CUTOVER_ADMISSION_CLOSED', () => policy.withMutationAdmission(
      kind, `${kind}-request-closed`, async () => { releaseMutationAccepted += 1; },
    ));
  }
  assert.equal(releaseMutationAccepted, 1, 'closed admission cannot accept release-changing work');
  let riskOnlyAccepted = false;
  await policy.withMutationAdmission('risk-acknowledge', 'risk-request-0001', async () => {
    riskOnlyAccepted = true;
  });
  assert.equal(riskOnlyAccepted, true, 'risk-only lifecycle work remains non-blocking during drain');
  await expectCode('CUTOVER_ADMISSION_CLOSED', () => policy.withLaunchAdmission(
    'launch-request-closed', async () => 'must-not-run',
  ));

  const store = await openParentRunStore({
    root: path.join(root, 'parent-store'), deploymentIdentity: 'admission-test',
    volumeIdentity: 'named-volume:admission-test', storeMarker: 'ad'.repeat(32),
    backupMarker: 'backup:admission-test', verifyStorage: false, clock,
  });
  await createParentRun(store, {
    runId: 'run-admission', subjectCoreDigest: `sha256:${'a'.repeat(64)}`,
    workItems: [{ id: 'work-admission', maxAttempts: 1, capability: 'browser:chromium', targetId: 'candidate' }],
  });
  const operator = {
    id: 'operator-admission', kind: 'human', roles: ['operator'],
    projectIds: ['project-admission'], runIds: ['run-admission'],
  };
  const service = createSharedControlService({
    store, projectId: 'project-admission', admissionPolicy: policy,
  });
  await expectCode('CUTOVER_ADMISSION_CLOSED', () => service.acceptMutation(operator, 'run-admission', {
    kind: 'cancel', requestId: 'cancel-service-0001', expectedRunRevision: 1,
    body: { reason: 'must remain unaccepted' },
  }));

  let launchCalls = 0;
  const api = createSharedControlApi({
    authority: {}, service, claimStore: {}, expectedOrigin: 'https://audit.example.test',
    admissionPolicy: policy,
    requestAuthorizer: {
      authenticate: async () => ({ principal: { ...operator, runIds: ['*'] }, browser: false, csrfToken: null }),
    },
    launch: async () => { launchCalls += 1; return {}; },
  });
  const rejectedLaunch = await api.handle({
    method: 'POST', url: '/api/control/v1/runs',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'launch-service-0001' },
    body: {
      schemaVersion: 1,
      runContract: {
        schemaVersion: 1, mode: 'single-site', targetIds: ['candidate'],
        scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
        url: 'https://beta.example.test', deploymentRole: 'preview', certificatePolicy: 'strict',
      },
    },
  });
  assert.equal(rejectedLaunch.status, 503);
  assert.equal(rejectedLaunch.body.error.code, 'CUTOVER_ADMISSION_CLOSED');
  assert.equal(launchCalls, 0, 'the API must fence launch acceptance behind the durable gate lock');
  for (const [suffix, body] of [
    ['release/assert', { expected: { projectId: 'project-admission' }, requestId: 'assert-closed-0001' }],
    ['promotion/consume', { token: 'claim-token-closed', expectedSubjectDigest: `sha256:${'b'.repeat(64)}` }],
  ]) {
    const rejectedPromotion = await api.handle({
      method: 'POST', url: `/api/control/v1/runs/run-admission/${suffix}`,
      headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(rejectedPromotion.status, 503, `${suffix} must remain disabled while admission is closed`);
    assert.equal(rejectedPromotion.body.error.code, 'CUTOVER_ADMISSION_CLOSED');
  }

  const corruptRoot = path.join(root, 'corrupt');
  const corruptGate = await initializeCutoverAdmissionGate({ root: corruptRoot, verifyStorage: false, clock });
  await writeFile(path.join(corruptGate.root, 'release-admission-gate.json'), '{"broken":true}\n');
  await expectCode('CUTOVER_ADMISSION_UNAVAILABLE', async () => {
    const opened = await openCutoverAdmissionGate({ root: corruptRoot, verifyStorage: false, clock });
    await opened.read();
  });

  const migrationRoot = path.join(root, 'preactivation-migration');
  await openParentRunStore({
    root: migrationRoot,
    deploymentIdentity: 'admission-migration-test',
    volumeIdentity: 'named-volume:admission-migration-test',
    storeMarker: 'bc'.repeat(32),
    backupMarker: 'backup:admission-migration-test',
    verifyStorage: false,
    clock,
  });
  const migrated = await runAdmissionInit(migrationRoot);
  assert.equal(migrated.code, 0, migrated.stderr);
  const migratedGate = await openCutoverAdmissionGate({
    root: path.join(migrationRoot, 'cutover-admission'), verifyStorage: false, clock,
  });
  assert.equal((await migratedGate.read()).state, 'OPEN');

  const activatedRoot = path.join(root, 'activated-missing-gate');
  const activatedStore = await openParentRunStore({
    root: activatedRoot,
    deploymentIdentity: 'admission-activated-test',
    volumeIdentity: 'named-volume:admission-activated-test',
    storeMarker: 'de'.repeat(32),
    backupMarker: 'backup:admission-activated-test',
    buildIdentity: 'build:admission-activated',
    prequalifiedRollbackBuilds: ['build:admission-activated'],
    verifyStorage: false,
    clock,
  });
  const activatedCoordinator = await acquireStoreCoordinator(activatedStore, {
    ownerId: 'coordinator-admission-activated', leaseMs: 60_000,
  });
  let selector = await readReleaseAuthoritySelector(activatedStore);
  selector = await transitionReleaseAuthority(activatedStore, activatedCoordinator, {
    expectedSelectorDigest: selector.digest,
    phase: 'DRAINING',
    buildIdentity: 'build:admission-activated',
  });
  const drainingRefused = await runAdmissionInit(activatedRoot);
  assert.notEqual(drainingRefused.code, 0, 'a draining store must never recreate a missing admission gate OPEN');
  await transitionReleaseAuthority(activatedStore, activatedCoordinator, {
    expectedSelectorDigest: selector.digest,
    phase: 'ACTIVE',
    activationRevision: 1,
    buildIdentity: 'build:admission-activated',
  });
  const refused = await runAdmissionInit(activatedRoot);
  assert.notEqual(refused.code, 0, 'an activated store must never recreate a missing admission gate OPEN');
  await expectCode('CUTOVER_ADMISSION_UNAVAILABLE', () => openCutoverAdmissionGate({
    root: path.join(activatedRoot, 'cutover-admission'), verifyStorage: false, clock,
  }));

  process.stdout.write('Shared cutover admission self-test passed.\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
