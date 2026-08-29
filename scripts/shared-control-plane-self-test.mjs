import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTROL_ACTIONS,
  assertPrincipalAuthorized,
  validateMutationDeployment,
  validateMutationRequest,
} from '../shared/control-plane-contract.mjs';
import { openScopedCredentialAuthority } from '../portal/scoped-credential-authority.mjs';
import {
  consumePromotionClaim,
  issuePromotionClaim,
  openPromotionClaimStore,
} from './lib/promotion-claim-store.mjs';
import {
  acquireCoordinator,
  adoptAttemptEvidence,
  claimWorkItem,
  createParentRun,
  openParentRunStore,
  publishAttemptEvidence,
  publishCurrentEnvelope,
  readCurrentEnvelope,
  rekickIncompleteWork,
  recoverParentRun,
  tombstoneParentRunAuthority,
} from './lib/parent-run-store.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import { createSharedControlApi, createSharedRequestAuthorizer } from '../portal/shared-control-api.mjs';
import { assertSharedListScope, classifySharedReadRequest } from '../portal/shared-read-policy.mjs';
import { classifyRetiredLegacyMutation } from '../portal/shared-legacy-mutation-policy.mjs';
import { sealExecutionManifest, sealOracleResult, sealWorkItemResult } from '../shared/execution-contract.mjs';
import { appendPublicationEnvelope } from '../shared/publication-envelope.mjs';
import { projectSharedReleaseView } from '../shared/release-projection.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { CONTROL_EXIT_CODES, controlExitCode } from '../shared/control-client-contract.mjs';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import {
  openSharedLaunchOperationStore,
} from './lib/shared-launch-operation-store.mjs';
import { createSharedLaunchService } from './lib/shared-launch-service.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-control-plane-'));
let now = Date.parse('2026-08-28T20:00:00.000Z');
const clock = () => now;

try {
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const workerSource = await readFile(new URL('./run-shared-worker.mjs', import.meta.url), 'utf8');
  const controlCliSource = await readFile(new URL('./audit-control.mjs', import.meta.url), 'utf8');
  const releaseCliSource = await readFile(new URL('./assert-release-decision.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(compose, /AUDIT_SHARED_WORKER_TOKEN:/u, 'worker bearer secrets must never be Compose environment values');
  assert.match(compose, /PORTAL_SHARED_CREDENTIAL_ROOT: \/var\/lib\/ai-mobile-testing\/shared\/credentials/u);
  const portalComposeBlock = compose.match(/\n  portal:[\s\S]*?(?=\n  [a-z][a-z0-9-]+:)/u)?.[0] ?? '';
  assert.match(portalComposeBlock, /shared-parent-runs:\/var\/lib\/ai-mobile-testing\/shared\/canonical/u);
  assert.match(portalComposeBlock, /shared-control-identities:\/var\/lib\/ai-mobile-testing\/shared\/credentials/u);
  assert.match(portalComposeBlock, /PORTAL_SHARED_CONTROL: \$\{PORTAL_SHARED_CONTROL:-0\}/u,
    'the Compose portal must expose an explicit fail-closed shared-control switch');
  assert.match(compose, /shared-worker-ordinary-a:/u);
  assert.match(compose, /shared-worker-ordinary-b:/u);
  assert.match(compose, /shared-worker-ordinary-a-secret:\/run\/secrets\/shared-worker:ro/u);
  assert.match(compose, /shared-worker-ordinary-b-secret:\/run\/secrets\/shared-worker:ro/u);
  assert.match(compose, /AUDIT_SHARED_WORKER_TOKEN_FILE: \/run\/secrets\/shared-worker\/token/u);
  assert.match(workerSource, /mode-0600 file/u);
  assert.doesNotMatch(workerSource, /console\.(?:log|error).*workerCredential/u, 'worker credentials must never enter logs');
  assert.doesNotMatch(controlCliSource, /AUDIT_CONTROL_TOKEN/u, 'control CLI credentials must not be accepted from the process environment');
  assert.doesNotMatch(releaseCliSource, /AUDIT_CONTROL_TOKEN/u, 'release assertion credentials must not be accepted from the process environment');
  assert.equal(controlExitCode({ status: 409, code: 'NOT_READY_TEST_FAILURE' }), CONTROL_EXIT_CODES.NOT_READY);
  assert.equal(controlExitCode({ status: 409, code: 'PROMOTION_STALE_REVISION' }), CONTROL_EXIT_CODES.STALE);
  assert.equal(controlExitCode({ status: 409, code: 'PROMOTION_SCOPE_MISMATCH' }), CONTROL_EXIT_CODES.IDENTITY_MISMATCH);
  assert.equal(controlExitCode({ status: 503, code: 'PROMOTION_EMPTY_EVIDENCE' }), CONTROL_EXIT_CODES.EVIDENCE_UNAVAILABLE);
  assert.equal(controlExitCode({ status: 403, code: 'AUTHORIZATION_DENIED' }), CONTROL_EXIT_CODES.AUTHORIZATION);

  const credentialOutput = path.join(root, 'principal-output', 'worker.token');
  await mkdir(path.dirname(credentialOutput), { mode: 0o700 });
  const principalCli = await runCommand(process.execPath, [
    new URL('./manage-control-principal.mjs', import.meta.url).pathname,
    '--root', path.join(root, 'principal-cli-authority'), '--action', 'create', '--id', 'cli-worker',
    '--kind', 'worker', '--roles', 'worker', '--projects', 'project-1', '--runs', 'run-1',
    '--credential-out', credentialOutput,
  ], path.join(root, 'principal-cli-capture'));
  assert.equal(principalCli.code, 0, principalCli.stderr);
  const principalCliDocument = JSON.parse(principalCli.stdout);
  assert.equal(principalCliDocument.credential, undefined, 'principal CLI stdout must never contain a credential');
  assert.equal(principalCliDocument.principal.id, 'cli-worker');
  assert.match(await readFile(credentialOutput, 'utf8'), /^amt\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,}\n$/u);
  assert.equal((await stat(credentialOutput)).mode & 0o077, 0, 'principal credential output must be mode 0600');
  const releaseUsage = await runCommand(process.execPath, [
    new URL('./assert-release-decision.mjs', import.meta.url).pathname, '--unsupported', 'value',
  ], path.join(root, 'release-usage'));
  assert.equal(releaseUsage.code, CONTROL_EXIT_CODES.USAGE);
  assert.equal(JSON.parse(releaseUsage.stdout).error.code, 'ASSERT_RELEASE_USAGE');
  assert.doesNotMatch(releaseUsage.stderr, /\n\s+at\s/u, 'release CLI usage failures must not emit runtime stacks');
  const controlNetworkFailure = await runCommand(process.execPath, [
    new URL('./audit-control.mjs', import.meta.url).pathname,
    'publication', '--server', 'http://127.0.0.1:1', '--token-file', credentialOutput, '--run', 'run-1',
  ], path.join(root, 'control-network-failure'));
  assert.equal(controlNetworkFailure.code, CONTROL_EXIT_CODES.REQUEST_FAILED);
  assert.equal(JSON.parse(controlNetworkFailure.stdout).error.code, 'AUDIT_CONTROL_REQUEST_FAILED');
  assert.doesNotMatch(controlNetworkFailure.stderr, /\n\s+at\s/u, 'control CLI request failures must not emit runtime stacks');

  const provisionRoot = path.join(root, 'compose-provision');
  const workerCredentialFiles = {
    AUDIT_SHARED_WORKER_A_CREDENTIAL_FILE: path.join(provisionRoot, 'ordinary-a', 'token'),
    AUDIT_SHARED_WORKER_B_CREDENTIAL_FILE: path.join(provisionRoot, 'ordinary-b', 'token'),
    AUDIT_SHARED_PERFORMANCE_CREDENTIAL_FILE: path.join(provisionRoot, 'performance', 'token'),
  };
  const provisionEnvironment = {
    ...process.env,
    AUDIT_SHARED_CREDENTIAL_ROOT: path.join(provisionRoot, 'authority'),
    AUDIT_SHARED_PROJECT_ID: 'project-1',
    ...workerCredentialFiles,
  };
  const firstProvision = await runCommand(process.execPath, [
    new URL('./provision-shared-worker-identities.mjs', import.meta.url).pathname,
  ], path.join(root, 'compose-provision-first'), { env: provisionEnvironment });
  assert.equal(firstProvision.code, 0, firstProvision.stderr);
  assert.deepEqual(JSON.parse(firstProvision.stdout).provisioned.map((entry) => entry.status), ['issued', 'issued', 'issued']);
  const secondProvision = await runCommand(process.execPath, [
    new URL('./provision-shared-worker-identities.mjs', import.meta.url).pathname,
  ], path.join(root, 'compose-provision-second'), { env: provisionEnvironment });
  assert.equal(secondProvision.code, 0, secondProvision.stderr);
  assert.deepEqual(JSON.parse(secondProvision.stdout).provisioned.map((entry) => entry.status), ['reused', 'reused', 'reused']);
  const provisionedCredentials = await Promise.all(Object.values(workerCredentialFiles).map(async (file) => {
    assert.equal((await stat(file)).mode & 0o077, 0, `${file} must remain private`);
    return (await readFile(file, 'utf8')).trim();
  }));
  assert.equal(new Set(provisionedCredentials).size, 3, 'each Compose worker slot must receive a distinct credential');
  const provisionedAuthority = await openScopedCredentialAuthority({ root: provisionEnvironment.AUDIT_SHARED_CREDENTIAL_ROOT });
  const provisionedPrincipals = await Promise.all(provisionedCredentials.map((credential) => provisionedAuthority.authenticateCredential(credential)));
  assert.deepEqual(provisionedPrincipals.map((principal) => principal.id),
    ['compose-worker-ordinary-a', 'compose-worker-ordinary-b', 'compose-worker-performance']);
  assert.deepEqual(provisionedPrincipals.map((principal) => principal.workerGrant), [
    { capabilities: ['browser:chromium', 'browser:firefox', 'browser:webkit', 'inventory:http'], resourceClasses: ['ordinary'] },
    { capabilities: ['browser:chromium', 'browser:firefox', 'browser:webkit', 'inventory:http'], resourceClasses: ['ordinary'] },
    { capabilities: ['performance:lighthouse'], resourceClasses: ['performance'] },
  ]);
  await provisionedAuthority.setWorkerGrant('compose-worker-ordinary-a', {
    capabilities: ['performance:lighthouse'], resourceClasses: ['performance'],
  });
  const repairedProvision = await runCommand(process.execPath, [
    new URL('./provision-shared-worker-identities.mjs', import.meta.url).pathname,
  ], path.join(root, 'compose-provision-repair'), { env: provisionEnvironment });
  assert.equal(repairedProvision.code, 0, repairedProvision.stderr);
  assert.deepEqual(JSON.parse(repairedProvision.stdout).provisioned.map((entry) => entry.status), ['updated', 'reused', 'reused']);
  assert.deepEqual((await provisionedAuthority.authenticateCredential(provisionedCredentials[0])).workerGrant,
    { capabilities: ['browser:chromium', 'browser:firefox', 'browser:webkit', 'inventory:http'], resourceClasses: ['ordinary'] });
  await rm(workerCredentialFiles.AUDIT_SHARED_WORKER_B_CREDENTIAL_FILE);
  await provisionedAuthority.setWorkerGrant('compose-worker-ordinary-b', {
    capabilities: ['performance:lighthouse'], resourceClasses: ['performance'],
  });
  const recoveredCredentialProvision = await runCommand(process.execPath, [
    new URL('./provision-shared-worker-identities.mjs', import.meta.url).pathname,
  ], path.join(root, 'compose-provision-missing-credential'), { env: provisionEnvironment });
  assert.equal(recoveredCredentialProvision.code, 0, recoveredCredentialProvision.stderr);
  assert.deepEqual(JSON.parse(recoveredCredentialProvision.stdout).provisioned.map((entry) => entry.status), ['reused', 'issued', 'reused']);
  const recoveredCredential = (await readFile(workerCredentialFiles.AUDIT_SHARED_WORKER_B_CREDENTIAL_FILE, 'utf8')).trim();
  assert.deepEqual((await provisionedAuthority.authenticateCredential(recoveredCredential)).workerGrant,
    { capabilities: ['browser:chromium', 'browser:firefox', 'browser:webkit', 'inventory:http'], resourceClasses: ['ordinary'] },
    'credential recovery also repairs an existing principal grant before rotating the secret');
  const overriddenProvision = await runCommand(process.execPath, [
    new URL('./provision-shared-worker-identities.mjs', import.meta.url).pathname,
  ], path.join(root, 'compose-provision-override'), {
    env: { ...provisionEnvironment, AUDIT_SHARED_ORDINARY_CAPABILITIES: 'inventory:http,browser:chromium' },
  });
  assert.equal(overriddenProvision.code, 0, overriddenProvision.stderr);
  assert.deepEqual((await provisionedAuthority.authenticateCredential(provisionedCredentials[0])).workerGrant,
    { capabilities: ['browser:chromium', 'inventory:http'], resourceClasses: ['ordinary'] },
    'provisioned grants must use the same ordinary capability override advertised by Compose workers');
  assert.throws(() => validateMutationDeployment({
    bindHost: '0.0.0.0',
    publishedOrigin: 'http://audit.example.test',
    sessionSecure: false,
  }), (error) => error?.code === 'INSECURE_MUTATION_DEPLOYMENT');
  assert.doesNotThrow(() => validateMutationDeployment({
    bindHost: '127.0.0.1',
    publishedOrigin: 'http://127.0.0.1:4173',
    sessionSecure: false,
  }));
  assert.doesNotThrow(() => validateMutationDeployment({
    bindHost: '0.0.0.0',
    acceptedSocketHost: '127.0.0.1',
    publishedOrigin: 'http://127.0.0.1:4173',
    sessionSecure: false,
  }), 'a wildcard container listener is local when the externally accepted socket and published origin are loopback-only');
  assert.doesNotThrow(() => validateMutationDeployment({
    bindHost: '0.0.0.0',
    publishedOrigin: 'https://audit.example.test',
    sessionSecure: true,
  }));

  const authority = await openScopedCredentialAuthority({ root: path.join(root, 'credentials'), clock });
  await assert.rejects(() => authority.createPrincipal({
    id: 'bad-expiry', kind: 'human', roles: ['viewer'], projectIds: ['*'], runIds: ['*'], expiresAt: 'not-a-date',
  }), (error) => error?.code === 'CREDENTIAL_SCHEMA_INVALID');
  await assert.rejects(() => authority.createPrincipal({
    id: 'past-expiry', kind: 'human', roles: ['viewer'], projectIds: ['*'], runIds: ['*'], expiresAt: '2026-08-28T19:59:59.999Z',
  }), (error) => error?.code === 'CREDENTIAL_SCHEMA_INVALID');
  await assert.rejects(() => authority.createPrincipal({
    id: 'unscoped-viewer', kind: 'human', roles: ['viewer'],
  }), (error) => error?.code === 'CREDENTIAL_SCHEMA_INVALID');
  const viewerIssued = await authority.createPrincipal({
    id: 'viewer-1', kind: 'human', roles: ['viewer'], projectIds: ['project-1'], runIds: ['run-1'],
  });
  const reviewerIssued = await authority.createPrincipal({
    id: 'reviewer-1', kind: 'human', roles: ['reviewer'], projectIds: ['project-1'], runIds: ['run-1'],
  });
  const workerIssued = await authority.createPrincipal({
    id: 'worker-1', kind: 'worker', roles: ['worker'], projectIds: ['project-1'], runIds: ['run-1'],
    workerGrant: { capabilities: ['browser:firefox', 'inventory:http'], resourceClasses: ['ordinary'] },
  });
  const deliveryIssued = await authority.createPrincipal({
    id: 'delivery-1', kind: 'service', roles: ['delivery'], projectIds: ['project-1'], runIds: ['run-1'],
  });
  const administratorIssued = await authority.createPrincipal({
    id: 'administrator-1', kind: 'human', roles: ['administrator'], projectIds: ['project-1'], runIds: ['run-1'],
  });
  const viewer = await authority.authenticateCredential(viewerIssued.credential);
  const reviewer = await authority.authenticateCredential(reviewerIssued.credential);
  const worker = await authority.authenticateCredential(workerIssued.credential);
  assert.deepEqual(worker.workerGrant, { capabilities: ['browser:firefox', 'inventory:http'], resourceClasses: ['ordinary'] });
  const delivery = await authority.authenticateCredential(deliveryIssued.credential);
  const administrator = await authority.authenticateCredential(administratorIssued.credential);
  const reopenedAuthority = await openScopedCredentialAuthority({ root: path.join(root, 'credentials'), clock });
  assert.equal((await reopenedAuthority.authenticateCredential(viewerIssued.credential)).id, 'viewer-1', 'credential authority must survive service restart');
  await assert.rejects(() => authority.createPrincipal({
    id: 'confused-service', kind: 'service', roles: ['reviewer'], projectIds: ['project-1'], runIds: ['run-1'],
  }), (error) => error?.code === 'CREDENTIAL_SCHEMA_INVALID');
  await assert.rejects(() => authority.createPrincipal({
    id: 'confused-worker', kind: 'worker', roles: ['administrator'], projectIds: ['*'], runIds: ['*'],
  }), (error) => error?.code === 'CREDENTIAL_SCHEMA_INVALID');
  await assert.rejects(() => authority.createPrincipal({
    id: 'bad-worker-grant', kind: 'worker', roles: ['worker'], projectIds: ['*'], runIds: ['*'],
    workerGrant: { capabilities: ['not a capability'], resourceClasses: ['ordinary'] },
  }), (error) => error?.code === 'CREDENTIAL_SCHEMA_INVALID');
  await assert.rejects(() => authority.createPrincipal({
    id: 'multi-class-worker', kind: 'worker', roles: ['worker'], projectIds: ['*'], runIds: ['*'],
    workerGrant: { capabilities: ['browser:chromium'], resourceClasses: ['ordinary', 'performance'] },
  }), (error) => error?.code === 'CREDENTIAL_SCHEMA_INVALID');
  await assert.rejects(() => authority.createPrincipal({
    id: 'human-worker-grant', kind: 'human', roles: ['viewer'], projectIds: ['*'], runIds: ['*'],
    workerGrant: { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
  }), (error) => error?.code === 'CREDENTIAL_SCHEMA_INVALID');
  const legacyWorkerIssued = await authority.createPrincipal({
    id: 'legacy-worker', kind: 'worker', roles: ['worker'], projectIds: ['project-1'], runIds: ['run-1'],
  });
  assert.equal((await authority.authenticateCredential(legacyWorkerIssued.credential)).workerGrant, null,
    'legacy ungranted worker records remain readable but fail closed for scheduling');
  await authority.setWorkerGrant('legacy-worker', {
    capabilities: ['browser:chromium'], resourceClasses: ['ordinary'],
  });
  assert.deepEqual((await reopenedAuthority.authenticateCredential(legacyWorkerIssued.credential)).workerGrant,
    { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
    'an existing credential can receive a persisted grant without rotation');

  assert.doesNotThrow(() => assertPrincipalAuthorized(viewer, CONTROL_ACTIONS.RUN_VIEW, { projectId: 'project-1', runId: 'run-1' }));
  assert.throws(() => assertPrincipalAuthorized(viewer, CONTROL_ACTIONS.RUN_REKICK, { projectId: 'project-1', runId: 'run-1' }),
    (error) => error?.code === 'AUTHORIZATION_DENIED');
  assert.doesNotThrow(() => assertPrincipalAuthorized(reviewer, CONTROL_ACTIONS.VISUAL_DISPOSITION, { projectId: 'project-1', runId: 'run-1' }));
  assert.throws(() => assertPrincipalAuthorized(reviewer, CONTROL_ACTIONS.RUN_PURGE, { projectId: 'project-1', runId: 'run-1' }),
    (error) => error?.code === 'AUTHORIZATION_DENIED');
  assert.doesNotThrow(() => assertPrincipalAuthorized(worker, CONTROL_ACTIONS.WORK_CLAIM, { projectId: 'project-1', runId: 'run-1' }));
  assert.throws(() => assertPrincipalAuthorized(worker, CONTROL_ACTIONS.RUN_VIEW, { projectId: 'project-1', runId: 'run-2' }),
    (error) => error?.code === 'AUTHORIZATION_DENIED');
  assert.throws(() => assertPrincipalAuthorized(administrator, CONTROL_ACTIONS.WORK_PUBLISH, { projectId: 'project-1', runId: 'run-1' }),
    (error) => error?.code === 'AUTHORIZATION_DENIED');

  const requestAuthorizer = createSharedRequestAuthorizer({ authority });
  assert.equal((await requestAuthorizer.authorize({
    headers: { authorization: `Bearer ${viewerIssued.credential}` },
  }, CONTROL_ACTIONS.ARTIFACT_READ, { projectId: 'project-1', runId: 'run-1' })).principal.id, viewer.id);
  await assert.rejects(() => requestAuthorizer.authorize({
    headers: { authorization: `Bearer ${viewerIssued.credential}` },
  }, CONTROL_ACTIONS.ARTIFACT_READ, { projectId: 'project-1', runId: 'run-2' }),
  (error) => error?.code === 'AUTHORIZATION_DENIED');
  await assert.rejects(() => requestAuthorizer.authorize({
    headers: { authorization: `Bearer ${deliveryIssued.credential}` },
  }, CONTROL_ACTIONS.LOG_READ, { projectId: 'project-1', runId: 'run-1' }),
  (error) => error?.code === 'AUTHORIZATION_DENIED');
  await assert.rejects(() => requestAuthorizer.authorize({
    headers: { authorization: `Bearer ${workerIssued.credential}` },
  }, CONTROL_ACTIONS.RUN_VIEW, { projectId: 'project-1', runId: 'run-1' }),
  (error) => error?.code === 'AUTHORIZATION_DENIED');
  assert.deepEqual(classifySharedReadRequest({ method: 'GET', pathname: '/api/runs/run-1/logs' }), {
    action: CONTROL_ACTIONS.LOG_READ, runId: 'run-1', aggregate: false,
  });
  assert.deepEqual(classifySharedReadRequest({ method: 'HEAD', pathname: '/artifacts/run-1/checklist/report.html' }), {
    action: CONTROL_ACTIONS.ARCHIVE_READ, runId: 'run-1', aggregate: false,
  });
  assert.deepEqual(classifySharedReadRequest({ method: 'GET', pathname: '/api/console/v1/runs' }), {
    action: CONTROL_ACTIONS.RUN_LIST, runId: null, aggregate: true,
  });
  assert.deepEqual(classifySharedReadRequest({ method: 'GET', pathname: '/api/single-site/visual-baselines/history' }), {
    action: CONTROL_ACTIONS.BASELINE_READ, runId: null, aggregate: true,
  });
  assert.equal(classifySharedReadRequest({ method: 'POST', pathname: '/api/runs/run-1/stop' }), null);
  assert.equal(classifyRetiredLegacyMutation({ method: 'POST', pathname: '/api/runs' }), 'comparative-launch');
  assert.equal(classifyRetiredLegacyMutation({ method: 'POST', pathname: '/api/runs/run-1/manual-evidence' }), 'manual-evidence');
  assert.equal(classifyRetiredLegacyMutation({ method: 'POST', pathname: '/api/single-site/runs/run-1/gallery/items/item-1/review' }), 'single-site-visual-review');
  assert.equal(classifyRetiredLegacyMutation({ method: 'GET', pathname: '/api/runs/run-1/manual-evidence' }), null,
    'legacy evidence reads remain available through object-authorized compatibility projections');
  assert.equal(classifyRetiredLegacyMutation({ method: 'POST', pathname: '/api/single-site/preflight' }), null,
    'side-effect-free preflight remains available during shared migration');
  assert.doesNotThrow(() => assertSharedListScope({ ...viewer, runIds: ['*'] }));
  assert.throws(() => assertSharedListScope(viewer), (error) => error?.code === 'AUTHORIZATION_DENIED');
  assert.throws(() => assertPrincipalAuthorized(administrator, CONTROL_ACTIONS.RELEASE_ASSERT, { projectId: 'project-1', runId: 'run-1' }),
    (error) => error?.code === 'AUTHORIZATION_DENIED');

  const session = await authority.createBrowserSession(reviewer, { idleMs: 60_000, absoluteMs: 300_000 });
  const browser = await authority.authenticateBrowserSession(session.token);
  assert.equal(browser.principal.id, reviewer.id);
  assert.equal(browser.csrfToken, session.csrfToken);
  validateMutationRequest({
    method: 'POST',
    headers: {
      host: 'audit.example.test',
      origin: 'https://audit.example.test',
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'x-audit-csrf': session.csrfToken,
    },
  }, { expectedOrigin: 'https://audit.example.test', csrfToken: session.csrfToken, browser: true });
  for (const headers of [
    { origin: 'https://sibling.example.test', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-audit-csrf': session.csrfToken },
    { origin: 'https://audit.example.test', 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin', 'x-audit-csrf': session.csrfToken },
    { origin: 'https://audit.example.test', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', 'x-audit-csrf': session.csrfToken },
    { origin: 'https://audit.example.test', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-audit-csrf': 'wrong' },
  ]) {
    assert.throws(() => validateMutationRequest({ method: 'POST', headers }, {
      expectedOrigin: 'https://audit.example.test', csrfToken: session.csrfToken, browser: true,
    }), (error) => error?.code === 'MUTATION_REQUEST_REJECTED');
  }

  const sessionPrincipalIssued = await authority.createPrincipal({
    id: 'session-human', kind: 'human', roles: ['reviewer'], projectIds: ['project-1'], runIds: ['run-1'],
  });
  const sessionPrincipal = await authority.authenticateCredential(sessionPrincipalIssued.credential);
  const renewable = await authority.createBrowserSession(sessionPrincipal, { idleMs: 1_000, absoluteMs: 3_000 });
  now += 500;
  const renewed = await authority.authenticateBrowserSession(renewable.token);
  assert.equal(Date.parse(renewed.idleExpiresAt), now + 1_000);
  await assert.rejects(() => authority.logoutBrowserSession(`${renewable.token.slice(0, -1)}x`),
    (error) => error?.code === 'INVALID_SESSION');
  await authority.logoutBrowserSession(renewable.token);
  await assert.rejects(() => authority.authenticateBrowserSession(renewable.token),
    (error) => error?.code === 'SESSION_REVOKED');
  const roleSession = await authority.createBrowserSession(sessionPrincipal, { idleMs: 1_000, absoluteMs: 3_000 });
  await authority.setRoles('session-human', ['viewer']);
  await assert.rejects(() => authority.authenticateBrowserSession(roleSession.token),
    (error) => error?.code === 'SESSION_REVOKED');
  const updatedSessionPrincipal = await authority.authenticateCredential(sessionPrincipalIssued.credential);
  const absolute = await authority.createBrowserSession(updatedSessionPrincipal, { idleMs: 1_000, absoluteMs: 1_500 });
  now += 1_600;
  await assert.rejects(() => authority.authenticateBrowserSession(absolute.token),
    (error) => error?.code === 'SESSION_EXPIRED');

  await authority.revokePrincipal('reviewer-1');
  await assert.rejects(() => authority.authenticateCredential(reviewerIssued.credential),
    (error) => error?.code === 'CREDENTIAL_REVOKED');
  await assert.rejects(() => authority.authenticateBrowserSession(session.token),
    (error) => error?.code === 'SESSION_REVOKED');

  const parentStoreRoot = path.join(root, 'parent-store');
  const parentStore = await openParentRunStore({
    root: parentStoreRoot, deploymentIdentity: 'test-deployment', volumeIdentity: 'named-volume:test',
    verifyStorage: false, clock,
  });
  await createParentRun(parentStore, {
    runId: 'run-1', subjectCoreDigest: `sha256:${'a'.repeat(64)}`,
    workItems: [{ id: 'work-1', maxAttempts: 1, capability: 'browser:chromium', targetId: 'candidate' }],
  });
  const operatorIssued = await authority.createPrincipal({
    id: 'operator-1', kind: 'human', roles: ['operator'], projectIds: ['project-1'], runIds: ['run-1'],
  });
  const launchOperatorIssued = await authority.createPrincipal({
    id: 'launch-operator', kind: 'human', roles: ['operator'], projectIds: ['project-1'], runIds: ['*'],
  });
  const operator = await authority.authenticateCredential(operatorIssued.credential);
  const control = createSharedControlService({ store: parentStore, projectId: 'project-1' });
  const firstOperation = await control.acceptMutation(operator, 'run-1', {
    kind: 'cancel', requestId: 'same-request-0001', expectedRunRevision: 1, body: { reason: 'Operator requested stop.' },
  });
  const duplicateOperation = await control.acceptMutation(operator, 'run-1', {
    kind: 'cancel', requestId: 'same-request-0001', expectedRunRevision: 1, body: { reason: 'Operator requested stop.' },
  });
  assert.deepEqual(duplicateOperation, firstOperation, 'exact retry must return the original durable operation after its acceptance advanced the run revision');
  await assert.rejects(() => control.acceptMutation(operator, 'run-1', {
    kind: 'cancel', requestId: 'same-request-0001', expectedRunRevision: 1, body: { reason: 'Different request body.' },
  }), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');
  const reopenedStore = await openParentRunStore({ root: parentStoreRoot, verifyStorage: false, clock });
  const reopenedControl = createSharedControlService({ store: reopenedStore, projectId: 'project-1' });
  assert.deepEqual(await reopenedControl.readOperation(operator, 'run-1', { kind: 'cancel', requestId: 'same-request-0001' }), firstOperation,
    'operation must remain retrievable after a portal/service restart');
  await assert.rejects(() => reopenedControl.acceptMutation(operator, 'run-1', {
    kind: 'cancel', requestId: 'new-request-0002', expectedRunRevision: 1, body: { reason: 'Stale revision.' },
  }), (error) => error?.code === 'RUN_REVISION_CONFLICT');
  await assert.rejects(() => reopenedControl.acceptMutation(operator, 'run-1', {
    kind: 'cancel', requestId: 'large-request-0003', expectedRunRevision: 2, body: { reason: 'x'.repeat(70_000) },
  }), (error) => error?.code === 'OPERATION_BODY_TOO_LARGE');
  const coordinator = await acquireCoordinator(reopenedStore, 'run-1', { ownerId: 'control-coordinator', leaseMs: 60_000 });
  const applied = await reopenedControl.applyAcceptedOperations(coordinator, 'run-1');
  assert.equal(applied[0].outcome.status, 'succeeded');
  assert.equal((await recoverParentRun(reopenedStore, 'run-1')).status, 'cancelled');

  await createParentRun(reopenedStore, {
    runId: 'run-rekick', subjectCoreDigest: `sha256:${'b'.repeat(64)}`,
    workItems: [{ id: 'work-rekick', maxAttempts: 1, capability: 'browser:chromium', targetId: 'candidate' }],
  });
  const rekickCoordinator = coordinator;
  const failedLease = await claimWorkItem(reopenedStore, 'run-rekick', rekickCoordinator, {
    workerId: 'worker-rekick', capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 30_000,
  });
  const failedInbox = await publishAttemptEvidence(reopenedStore, 'run-rekick', failedLease, {
    outcome: 'operational_failure', reason: 'Synthetic exhausted automatic attempt.', artifacts: [],
  });
  await adoptAttemptEvidence(reopenedStore, 'run-rekick', rekickCoordinator, failedInbox);
  const exhausted = await recoverParentRun(reopenedStore, 'run-rekick');
  assert.equal(exhausted.workItems['work-rekick'].state, 'incomplete');
  const subjectBeforeRekick = exhausted.subjectCoreDigest;
  await rekickIncompleteWork(reopenedStore, 'run-rekick', rekickCoordinator, {
    actor: { id: operator.id, kind: operator.kind }, workItemIds: ['work-rekick'],
  });
  const retryLease = await claimWorkItem(reopenedStore, 'run-rekick', rekickCoordinator, {
    workerId: 'worker-rekick', capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 30_000,
  });
  assert.equal(retryLease.attempt, 2, 'manual rekick must extend exhausted automatic recovery without rewriting attempt lineage');
  const retryInbox = await publishAttemptEvidence(reopenedStore, 'run-rekick', retryLease, { outcome: 'completed_pass', artifacts: [] });
  await adoptAttemptEvidence(reopenedStore, 'run-rekick', rekickCoordinator, retryInbox);
  const recovered = await recoverParentRun(reopenedStore, 'run-rekick');
  assert.equal(recovered.workItems['work-rekick'].state, 'completed_pass');
  assert.equal(recovered.workItems['work-rekick'].manualRekicks, 1);
  assert.equal(recovered.subjectCoreDigest, subjectBeforeRekick, 'manual rekick must preserve immutable release subject identity');

  const projection = releaseFixture();
  await createParentRun(reopenedStore, {
    runId: 'run-projection', subjectCore: projection.core, executionManifest: projection.manifest,
    finalSubject: projection.finalSubject, compilationState: 'sealed',
    workItems: [{ id: 'work-visual', maxAttempts: 1, capability: 'browser:chromium', targetId: 'candidate' }],
  });
  const projectionLease = await claimWorkItem(reopenedStore, 'run-projection', coordinator, {
    workerId: 'projection-worker', capabilities: ['browser:chromium'], resourceClasses: ['ordinary'], leaseMs: 30_000,
  });
  const projectionInbox = await publishAttemptEvidence(reopenedStore, 'run-projection', projectionLease, { outcome: 'completed_pass', artifacts: [] });
  await adoptAttemptEvidence(reopenedStore, 'run-projection', coordinator, projectionInbox);
  const projectionView = projectSharedReleaseView({
    schemaVersion: 1, runId: 'run-projection', baseDecisionRevision: 1, baseRiskRevision: 1,
    finalSubject: projection.finalSubject, executionManifest: projection.manifest,
    oracleResults: [projection.oracle], riskAvailability: 'AVAILABLE', riskSources: [projection.visualRisk, projection.manualRisk],
    riskLifecycleEvents: [], visualDispositions: [],
  });
  const beforeInitialPublication = await recoverParentRun(reopenedStore, 'run-projection');
  const initialEnvelope = appendPublicationEnvelope(null, {
    schemaVersion: 1, runId: 'run-projection', runRevision: 1,
    decisionRevision: projectionView.decisionRevision, riskRevision: projectionView.riskRevision,
    ledgerSequences: {
      observations: beforeInitialPublication.ledgerSequences.mutation,
      decisions: beforeInitialPublication.ledgerSequences.decision + 1,
      risks: beforeInitialPublication.ledgerSequences.risk,
    },
    finalSubjectDigest: projection.finalSubject.digest, decision: projectionView.decision, riskRegister: projectionView.riskRegister,
  });
  await publishCurrentEnvelope(reopenedStore, 'run-projection', coordinator, initialEnvelope);
  const projectionReviewerIssued = await authority.createPrincipal({
    id: 'projection-reviewer', kind: 'human', roles: ['reviewer'], projectIds: ['project-1'], runIds: ['run-projection'],
  });
  const projectionReviewer = await authority.authenticateCredential(projectionReviewerIssued.credential);
  const projectionControl = createSharedControlService({ store: reopenedStore, projectId: 'project-1' });
  const projectedExecutions = await projectionControl.readExecutions(projectionReviewer, 'run-projection');
  assert.deepEqual(projectedExecutions.oracleExecutions.map(({ id }) => id), ['oracle-visual']);
  assert.equal(projectedExecutions.executions.length, 1);
  const projectedLogs = await projectionControl.readLogs(projectionReviewer, 'run-projection');
  assert.equal(projectedLogs.runId, 'run-projection');
  assert.equal(projectedLogs.runRevision, projectedExecutions.runRevision);
  const visualRisk = projectionView.riskRegister.risks.find(({ category }) => category === 'unreviewed-visual-change');
  const manualRisk = projectionView.riskRegister.risks.find(({ category }) => category === 'manual-check');
  let projectionState = await recoverParentRun(reopenedStore, 'run-projection');
  await assert.rejects(() => projectionControl.acceptMutation(projectionReviewer, 'run-projection', {
    kind: 'risk-acknowledge', requestId: 'visual-risk-lifecycle-invalid', expectedRunRevision: projectionState.runRevision,
    body: { expectedSubjectDigest: projection.finalSubject.digest, riskIdentity: visualRisk.identity },
  }), (error) => error?.code === 'RISK_LIFECYCLE_NOT_APPLICABLE');
  await assert.rejects(() => projectionControl.acceptMutation(projectionReviewer, 'run-projection', {
    kind: 'visual-disposition', requestId: 'visual-invalid-0000', expectedRunRevision: projectionState.runRevision,
    body: {
      expectedSubjectDigest: projection.finalSubject.digest, executionId: 'unknown-oracle',
      riskIdentity: visualRisk.identity, disposition: 'DEFECT_CONFIRMED', rationale: 'Invalid execution must not enter history.',
    },
  }), (error) => error?.code === 'VISUAL_REVIEW_INVALID');
  await projectionControl.acceptMutation(projectionReviewer, 'run-projection', {
    kind: 'visual-disposition', requestId: 'visual-defect-0001', expectedRunRevision: projectionState.runRevision,
    body: {
      expectedSubjectDigest: projection.finalSubject.digest, executionId: 'oracle-visual',
      riskIdentity: visualRisk.identity, disposition: 'DEFECT_CONFIRMED', rationale: 'Reviewer confirmed a visual defect.',
    },
  });
  assert.equal((await projectionControl.applyAcceptedOperations(coordinator, 'run-projection'))[0].outcome.status, 'succeeded');
  let projectedHead = await readCurrentEnvelope(reopenedStore, 'run-projection');
  assert.equal(projectedHead.decision.code, 'NOT_READY_TEST_FAILURE');
  assert.equal(projectedHead.decisionRevision, 2);
  projectionState = await recoverParentRun(reopenedStore, 'run-projection');
  await projectionControl.acceptMutation(projectionReviewer, 'run-projection', {
    kind: 'visual-disposition', requestId: 'visual-accept-0002', expectedRunRevision: projectionState.runRevision,
    body: {
      expectedSubjectDigest: projection.finalSubject.digest, executionId: 'oracle-visual',
      riskIdentity: visualRisk.identity, disposition: 'ACCEPTED', rationale: 'Reviewer accepted the intended change.',
    },
  });
  const visualAcceptResults = await projectionControl.applyAcceptedOperations(coordinator, 'run-projection');
  assert.equal(visualAcceptResults[0].outcome.status, 'succeeded', JSON.stringify(visualAcceptResults[0].outcome));
  projectedHead = await readCurrentEnvelope(reopenedStore, 'run-projection');
  assert.equal(projectedHead.decision.code, 'RELEASE_READY');
  assert.equal(projectedHead.decisionRevision, 3);
  const decisionRevisionBeforeRisk = projectedHead.decisionRevision;
  const riskRevisionBefore = projectedHead.riskRevision;
  projectionState = await recoverParentRun(reopenedStore, 'run-projection');
  await projectionControl.acceptMutation(projectionReviewer, 'run-projection', {
    kind: 'risk-acknowledge', requestId: 'risk-acknowledge-0003', expectedRunRevision: projectionState.runRevision,
    body: { expectedSubjectDigest: projection.finalSubject.digest, riskIdentity: manualRisk.identity },
  });
  const riskApplyResults = await projectionControl.applyAcceptedOperations(coordinator, 'run-projection');
  assert.equal(riskApplyResults[0].outcome.status, 'succeeded', JSON.stringify(riskApplyResults[0].outcome));
  projectedHead = await readCurrentEnvelope(reopenedStore, 'run-projection');
  assert.equal(projectedHead.decisionRevision, decisionRevisionBeforeRisk, 'non-blocking risk lifecycle must not revise release truth');
  assert.equal(projectedHead.riskRevision, riskRevisionBefore + 1);
  assert.equal(projectedHead.riskRegister.risks.find(({ identity }) => identity === manualRisk.identity).reviewState, 'ACKNOWLEDGED');
  assert.equal(projectedHead.riskRegister.risks.find(({ identity }) => identity === visualRisk.identity).reviewState, 'ACCEPTED');

  const projectionDeliveryIssued = await authority.createPrincipal({
    id: 'projection-delivery', kind: 'service', roles: ['delivery'], projectIds: ['project-1'], runIds: ['run-projection'],
  });
  const projectionApi = createSharedControlApi({
    authority,
    service: projectionControl,
    claimStore: await openPromotionClaimStore({ root: path.join(root, 'projection-claims'), clock }),
    expectedOrigin: 'https://audit.example.test',
  });
  const projectionAssertion = await projectionApi.handle({
    method: 'POST', url: '/api/control/v1/runs/run-projection/release/assert',
    headers: {
      authorization: `Bearer ${projectionDeliveryIssued.credential}`,
      'content-type': 'application/json',
      'idempotency-key': 'projection-assertion-0001',
    },
    body: {
      expected: {
        projectId: 'project-1', subjectDigest: projectedHead.finalSubjectDigest,
        authority: projectedHead.decision.grantedAuthority,
        executionSetDigest: projectedHead.decision.executionManifestDigest,
        runRevision: projectedHead.runRevision, decisionRevision: projectedHead.decisionRevision,
      },
      ttlMs: 60_000,
    },
  });
  assert.equal(projectionAssertion.status, 200);
  assert.equal(projectionAssertion.body.data.result.decisionCode, 'RELEASE_READY');
  assert.equal(projectionAssertion.body.data.result.ready, true);
  assert.equal(projectionAssertion.body.data.result.authority, 'FULL');
  assert.deepEqual(projectionAssertion.body.data.result.certifiedScope, projectedHead.decision.certifiedScope);
  assert.deepEqual(projectionAssertion.body.data.result.coverageBasis, projectedHead.decision.coverageBasis);
  assert.deepEqual(projectionAssertion.body.data.result.blockingReasons, []);
  assert.equal(projectionAssertion.body.data.result.riskSummary.active > 0, true,
    'active non-blocking risks must remain visible without preventing claim issuance');
  assert.deepEqual(projectionAssertion.body.data.result.revisions, {
    run: projectedHead.runRevision, decision: projectedHead.decisionRevision, risk: projectedHead.riskRevision,
  });
  assert.equal(projectionAssertion.body.data.result.exitCode, CONTROL_EXIT_CODES.SUCCESS);

  const custodianIssued = await authority.createPrincipal({
    id: 'projection-custodian', kind: 'human', roles: ['custodian'], projectIds: ['project-1'], runIds: ['run-projection'],
  });
  const custodian = await authority.authenticateCredential(custodianIssued.credential);
  projectionState = await recoverParentRun(reopenedStore, 'run-projection');
  await projectionControl.acceptMutation(custodian, 'run-projection', {
    kind: 'purge', requestId: 'purge-crash-retry-0004', expectedRunRevision: projectionState.runRevision,
    body: { expectedSubjectDigest: projection.finalSubject.digest, reason: 'Synthetic privileged purge.' },
  });
  await tombstoneParentRunAuthority(reopenedStore, 'run-projection', coordinator, {
    actor: { id: custodian.id, kind: custodian.kind }, reason: 'Synthetic crash after tombstone and before evidence removal.',
  });
  const purgeRecoveryStore = await openParentRunStore({ root: parentStoreRoot, verifyStorage: false, clock });
  const purgeRecoveryControl = createSharedControlService({ store: purgeRecoveryStore, projectId: 'project-1' });
  const purgeResults = await purgeRecoveryControl.applyAcceptedOperations(coordinator, 'run-projection');
  assert.equal(purgeResults[0].outcome.status, 'succeeded', 'restart must resume evidence cleanup from an existing authority tombstone');
  await assert.rejects(() => readCurrentEnvelope(purgeRecoveryStore, 'run-projection'),
    (error) => error?.code === 'RELEASE_AUTHORITY_TOMBSTONED');
  const purgedLineage = await recoverParentRun(purgeRecoveryStore, 'run-projection');
  assert.equal(purgedLineage.status, 'cancelled');
  assert.equal(purgedLineage.authorityTombstone.finalSubjectDigest, projection.finalSubject.digest);

  const claimStore = await openPromotionClaimStore({ root: path.join(root, 'claims'), clock });
  const launchOperationRoot = path.join(root, 'launch-operations');
  const launchOperationStore = await openSharedLaunchOperationStore({ root: launchOperationRoot, clock });
  const launchIntent = {
    schemaVersion: 1,
    runContract: {
      schemaVersion: 1,
      mode: 'single-site',
      url: 'https://beta.example.test',
      deploymentRole: 'preview',
      certificatePolicy: 'strict',
      targetIds: ['single-mobile'],
      scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
    },
  };
  let launchCompileCalls = 0;
  const compileLaunchPlan = async (intent) => {
    launchCompileCalls += 1;
    const body = {
      schemaVersion: 1,
      kind: 'shared-launch-plan',
      intentDigest: canonicalDigest(intent),
      state: 'pending-inventory',
      subjectCore: null,
      inventoryBarrier: null,
      executionGraph: null,
      createParentRunInput: {
        subjectCoreDigest: canonicalDigest(intent),
        compilationState: 'pending',
        runnerRevision: 'launch-runner-v1',
        workItems: [{
          id: 'inventory-launch', maxAttempts: 3, capability: 'inventory:http',
          resourceClass: 'ordinary', targetId: 'single-mobile', specAffinity: null,
        }],
      },
    };
    return { ...body, digest: canonicalDigest(body) };
  };
  const launchService = createSharedLaunchService({
    operationStore: launchOperationStore,
    parentRunStore: reopenedStore,
    projectId: 'project-1',
    compilePlan: compileLaunchPlan,
  });
  const api = createSharedControlApi({
    authority, service: reopenedControl, claimStore, expectedOrigin: 'https://audit.example.test', sessionCookiePath: '/',
    launch: launchService.accept, readLaunchOperation: launchService.read,
  });
  const callerAuthoredAuthority = await api.handle({
    method: 'POST', url: '/api/control/v1/runs',
    headers: {
      authorization: `Bearer ${launchOperatorIssued.credential}`,
      'content-type': 'application/json',
      'idempotency-key': 'launch-request-0001',
    },
    body: { ...launchIntent, parentRun: { runId: 'caller-selected', subjectCore: { mode: 'single-site' } } },
  });
  assert.equal(callerAuthoredAuthority.status, 400, 'launch must reject caller-authored run IDs and release authority');
  const missingLaunchKey = await api.handle({
    method: 'POST', url: '/api/control/v1/runs',
    headers: { authorization: `Bearer ${launchOperatorIssued.credential}`, 'content-type': 'application/json' },
    body: launchIntent,
  });
  assert.equal(missingLaunchKey.status, 400, 'launch must require an idempotency key');
  const narrowlyScopedLaunch = await api.handle({
    method: 'POST', url: '/api/control/v1/runs',
    headers: {
      authorization: `Bearer ${operatorIssued.credential}`,
      'content-type': 'application/json',
      'idempotency-key': 'scoped-launch-0001',
    },
    body: launchIntent,
  });
  assert.equal(narrowlyScopedLaunch.status, 403,
    'a principal scoped only to existing run IDs cannot launch a new server-derived run it would be unable to inspect');
  const acceptedLaunch = await api.handle({
    method: 'POST', url: '/api/control/v1/runs',
    headers: {
      authorization: `Bearer ${launchOperatorIssued.credential}`,
      'content-type': 'application/json',
      'idempotency-key': 'launch-request-0001',
    },
    body: launchIntent,
  });
  assert.equal(acceptedLaunch.status, 202);
  assert.match(acceptedLaunch.body.data.operationId, /^[a-f0-9]{64}$/u);
  assert.match(acceptedLaunch.body.data.runId, /^run-[a-f0-9]{32}$/u,
    'the server must reserve a deterministic safe run ID from the durable launch-operation namespace');
  assert.equal(acceptedLaunch.body.data.statusUrl,
    `/api/control/v1/launch-operations/${acceptedLaunch.body.data.operationId}`);
  assert.equal(acceptedLaunch.headers.location, acceptedLaunch.body.data.statusUrl);
  assert.equal('intent' in acceptedLaunch.body.data, false, 'launch status must not echo the full intent');
  assert.equal('compiledPlan' in acceptedLaunch.body.data, false, 'launch status must not return the internal execution plan');
  const duplicateLaunch = await api.handle({
    method: 'POST', url: '/api/control/v1/runs',
    headers: {
      authorization: `Bearer ${launchOperatorIssued.credential}`,
      'content-type': 'application/json',
      'idempotency-key': 'launch-request-0001',
    },
    body: launchIntent,
  });
  assert.deepEqual(duplicateLaunch.body.data, acceptedLaunch.body.data,
    'an exact launch retry must return the same durable operation');
  assert.equal(launchCompileCalls, 1, 'an exact retry must recover the pinned plan without recompiling live server state');
  const conflictingLaunch = await api.handle({
    method: 'POST', url: '/api/control/v1/runs',
    headers: {
      authorization: `Bearer ${launchOperatorIssued.credential}`,
      'content-type': 'application/json',
      'idempotency-key': 'launch-request-0001',
    },
    body: { ...launchIntent, runContract: { ...launchIntent.runContract, url: 'https://changed.example.test' } },
  });
  assert.equal(conflictingLaunch.status, 409);
  assert.equal(conflictingLaunch.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const reopenedLaunchStore = await openSharedLaunchOperationStore({ root: launchOperationRoot, clock });
  const restartedLaunchService = createSharedLaunchService({
    operationStore: reopenedLaunchStore,
    parentRunStore: reopenedStore,
    projectId: 'project-1',
    compilePlan: async () => { throw new Error('restart recovery must not recompile an accepted launch'); },
  });
  const restartApi = createSharedControlApi({
    authority, service: reopenedControl, claimStore, expectedOrigin: 'https://audit.example.test',
    launch: restartedLaunchService.accept,
    readLaunchOperation: restartedLaunchService.read,
  });
  const recoveredLaunch = await restartApi.handle({
    method: 'GET', url: acceptedLaunch.body.data.statusUrl,
    headers: { authorization: `Bearer ${launchOperatorIssued.credential}` },
  });
  assert.equal(recoveredLaunch.status, 200);
  assert.equal(recoveredLaunch.body.data.operationId, acceptedLaunch.body.data.operationId,
    'accepted launch operation must remain retrievable after portal/service restart');
  assert.equal('compiledPlan' in recoveredLaunch.body.data, false);
  assert.equal('intent' in recoveredLaunch.body.data, false);
  const narrowLaunchRead = await restartApi.handle({
    method: 'GET', url: acceptedLaunch.body.data.statusUrl,
    headers: { authorization: `Bearer ${operatorIssued.credential}` },
  });
  assert.equal(narrowLaunchRead.status, 403,
    'launch-operation reads must enforce the reserved run identity as well as project scope');
  const recoveredMaterializations = await restartedLaunchService.recover();
  assert.equal(recoveredMaterializations.completed.length, 1);
  assert.equal(recoveredMaterializations.completed[0].state, 'completed');
  assert.equal(recoveredMaterializations.completed[0].outcome.status, 'succeeded');
  const materializedParent = await recoverParentRun(reopenedStore, acceptedLaunch.body.data.runId);
  assert.equal(materializedParent.subjectCoreDigest, canonicalDigest(launchIntent));
  assert.deepEqual(Object.keys(materializedParent.workItems), ['inventory-launch']);
  assert.equal((await restartedLaunchService.recover()).completed.length, 0,
    'a completed launch must not materialize a duplicate parent run');
  const viewerLaunch = await restartApi.handle({
    method: 'POST', url: '/api/control/v1/runs',
    headers: {
      authorization: `Bearer ${viewerIssued.credential}`,
      'content-type': 'application/json',
      'idempotency-key': 'viewer-launch-0001',
    },
    body: launchIntent,
  });
  assert.equal(viewerLaunch.status, 403, 'view-only principals cannot launch runs');
  const login = await api.handle({
    method: 'POST', url: '/api/control/v1/session',
    headers: { origin: 'https://audit.example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: { credential: sessionPrincipalIssued.credential },
  });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'], /HttpOnly; SameSite=Strict; Path=\/; Secure/u);
  const apiCookie = login.headers['set-cookie'].split(';')[0];
  const currentSession = await api.handle({ method: 'GET', url: '/api/control/v1/session', headers: { cookie: apiCookie } });
  assert.equal(currentSession.status, 200);
  const duplicateCancel = await api.handle({
    method: 'POST', url: '/api/control/v1/runs/run-1/cancel',
    headers: {
      authorization: `Bearer ${operatorIssued.credential}`,
      'content-type': 'application/json',
      'idempotency-key': 'same-request-0001',
    },
    body: { expectedRunRevision: 1, reason: 'Operator requested stop.' },
  });
  assert.equal(duplicateCancel.status, 202);
  assert.equal(duplicateCancel.body.data.operationId, firstOperation.operationId);
  assert.equal(duplicateCancel.body.data.statusUrl,
    `/api/control/v1/runs/run-1/operations/${firstOperation.operationId}`);
  assert.equal(duplicateCancel.headers.location, duplicateCancel.body.data.statusUrl);
  const directOperation = await api.handle({
    method: 'GET', url: duplicateCancel.body.data.statusUrl,
    headers: { authorization: `Bearer ${operatorIssued.credential}` },
  });
  assert.equal(directOperation.status, 200);
  assert.equal(directOperation.body.data.operationId, firstOperation.operationId);
  const viewerOperation = await api.handle({
    method: 'GET', url: duplicateCancel.body.data.statusUrl,
    headers: { authorization: `Bearer ${viewerIssued.credential}` },
  });
  assert.equal(viewerOperation.status, 403, 'view-only principals must not inspect mutation operation resources');
  const logout = await api.handle({
    method: 'DELETE', url: '/api/control/v1/session',
    headers: { cookie: apiCookie, origin: 'https://audit.example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-audit-csrf': login.body.data.csrfToken },
    body: {},
  });
  assert.equal(logout.status, 200);
  assert.equal((await api.handle({ method: 'GET', url: '/api/control/v1/session', headers: { cookie: apiCookie } })).status, 401);
  const head = publicationHead();
  const expectedHead = {
    projectId: 'project-1', subjectDigest: head.finalSubjectDigest, authority: 'FULL',
    executionSetDigest: head.decision.executionManifestDigest,
    runRevision: head.runRevision, decisionRevision: head.decisionRevision,
  };
  await assert.rejects(() => issuePromotionClaim(claimStore, {
    principal: delivery, publication: null, expected: expectedHead, ttlMs: 60_000,
  }), (error) => error?.code === 'PROMOTION_EMPTY_EVIDENCE');
  await assert.rejects(() => issuePromotionClaim(claimStore, {
    principal: delivery, publication: { ...head, decision: { ...head.decision, ready: false, code: 'NOT_READY_TEST_FAILURE' } }, expected: expectedHead, ttlMs: 60_000,
  }), (error) => error?.code === 'NOT_READY_TEST_FAILURE');
  await assert.rejects(() => issuePromotionClaim(claimStore, {
    principal: delivery, publication: { ...head, decision: { ...head.decision, superseded: true } }, expected: expectedHead, ttlMs: 60_000,
  }), (error) => error?.code === 'PROMOTION_SUPERSEDED');
  await assert.rejects(() => issuePromotionClaim(claimStore, {
    principal: delivery, publication: head, expected: { ...expectedHead, authority: 'TARGETED' }, ttlMs: 60_000,
  }), (error) => error?.code === 'PROMOTION_SCOPE_MISMATCH');
  await assert.rejects(() => issuePromotionClaim(claimStore, {
    principal: delivery, publication: head, expected: { ...expectedHead, subjectDigest: `sha256:${'9'.repeat(64)}` }, ttlMs: 60_000,
  }), (error) => error?.code === 'PROMOTION_SUBJECT_MISMATCH');
  const issued = await issuePromotionClaim(claimStore, {
    principal: delivery,
    publication: head,
    expected: {
      projectId: 'project-1', subjectDigest: head.finalSubjectDigest,
      authority: 'FULL',
      executionSetDigest: head.decision.executionManifestDigest,
      runRevision: head.runRevision,
      decisionRevision: head.decisionRevision,
    },
    ttlMs: 60_000,
    requestId: 'promotion-assertion-0001',
  });
  const duplicateIssue = await issuePromotionClaim(claimStore, {
    principal: delivery, publication: head, expected: expectedHead, ttlMs: 60_000,
    requestId: 'promotion-assertion-0001',
  });
  assert.equal(duplicateIssue.token, issued.token, 'an exact duplicate assertion must return the original claim');
  await assert.rejects(() => issuePromotionClaim(claimStore, {
    principal: delivery, publication: head, expected: expectedHead, ttlMs: 1,
    requestId: 'promotion-assertion-0001',
  }), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');
  const changedHead = {
    ...head,
    runRevision: head.runRevision + 1,
    decisionRevision: head.decisionRevision + 1,
    decision: { ...head.decision, decisionRevision: head.decision.decisionRevision + 1 },
    digest: `sha256:${'8'.repeat(64)}`,
  };
  const retryAfterHeadChange = await issuePromotionClaim(claimStore, {
    principal: delivery, publication: changedHead, expected: expectedHead, ttlMs: 60_000,
    requestId: 'promotion-assertion-0001',
  });
  assert.equal(retryAfterHeadChange.token, issued.token, 'response-loss retry must recover the original claim even after the live head advances');
  await assert.rejects(() => issuePromotionClaim(claimStore, {
    principal: delivery, publication: changedHead,
    expected: {
      ...expectedHead, runRevision: changedHead.runRevision, decisionRevision: changedHead.decisionRevision,
    },
    ttlMs: 60_000, requestId: 'promotion-assertion-0001',
  }), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');
  let promotionFenceEntered = 0;
  const consumed = await consumePromotionClaim(claimStore, issued.token, {
    principal: delivery,
    expectedSubjectDigest: head.finalSubjectDigest,
    readCurrentPublication: async () => head,
    withCurrentPublication: async (callback) => {
      promotionFenceEntered += 1;
      return callback(head);
    },
  });
  assert.equal(consumed.consumed, true);
  assert.equal(promotionFenceEntered, 1, 'claim consumption must validate and write its receipt inside the publication fence');
  await assert.rejects(() => consumePromotionClaim(claimStore, issued.token, {
    principal: delivery,
    expectedSubjectDigest: head.finalSubjectDigest,
    readCurrentPublication: async () => head,
  }), (error) => error?.code === 'PROMOTION_CLAIM_REPLAYED');

  const stale = await issuePromotionClaim(claimStore, {
    principal: delivery, publication: head,
    expected: {
      projectId: 'project-1', subjectDigest: head.finalSubjectDigest, authority: 'FULL',
      executionSetDigest: head.decision.executionManifestDigest,
      runRevision: head.runRevision, decisionRevision: head.decisionRevision,
    }, ttlMs: 60_000,
  });
  await assert.rejects(() => consumePromotionClaim(claimStore, stale.token, {
    principal: delivery,
    expectedSubjectDigest: head.finalSubjectDigest,
    readCurrentPublication: async () => ({ ...head, runRevision: head.runRevision + 1 }),
  }), (error) => error?.code === 'PROMOTION_CLAIM_STALE');
  await assert.rejects(() => consumePromotionClaim(claimStore, stale.token, {
    principal: worker,
    expectedSubjectDigest: head.finalSubjectDigest,
    readCurrentPublication: async () => head,
  }), (error) => error?.code === 'PROMOTION_CLAIM_PRINCIPAL_MISMATCH');

  now += 120_000;
  const expired = await issuePromotionClaim(claimStore, {
    principal: delivery, publication: head,
    expected: {
      projectId: 'project-1', subjectDigest: head.finalSubjectDigest, authority: 'FULL',
      executionSetDigest: head.decision.executionManifestDigest,
      runRevision: head.runRevision, decisionRevision: head.decisionRevision,
    }, ttlMs: 1,
  });
  now += 2;
  await assert.rejects(() => consumePromotionClaim(claimStore, expired.token, {
    principal: delivery,
    expectedSubjectDigest: head.finalSubjectDigest,
    readCurrentPublication: async () => head,
  }), (error) => error?.code === 'PROMOTION_CLAIM_EXPIRED');
} finally {
  await rm(root, { recursive: true, force: true });
}

async function runCommand(command, args, capturePrefix, options = {}) {
  const stdoutPath = `${capturePrefix}.stdout`;
  const stderrPath = `${capturePrefix}.stderr`;
  const stdout = await open(stdoutPath, 'wx', 0o600);
  const stderr = await open(stderrPath, 'wx', 0o600);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const child = spawn(command, args, { ...options, stdio: ['ignore', stdout.fd, stderr.fd] });
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
  return { code, stdout: await readFile(stdoutPath, 'utf8'), stderr: await readFile(stderrPath, 'utf8') };
}

console.log('Shared control plane self-test passed: deployment policy, scoped credentials, CSRF/origin enforcement, revocation, and single-use head-bound promotion claims are fail closed.');

function publicationHead() {
  return {
    schemaVersion: 1,
    kind: 'release-publication-envelope',
    runId: 'run-1',
    runRevision: 4,
    decisionRevision: 2,
    riskRevision: 3,
    finalSubjectDigest: `sha256:${'1'.repeat(64)}`,
    digest: `sha256:${'2'.repeat(64)}`,
    decision: {
      ready: true,
      code: 'RELEASE_READY',
      grantedAuthority: 'FULL',
      superseded: false,
      executionManifestDigest: `sha256:${'3'.repeat(64)}`,
    },
    riskSummary: { active: 2 },
  };
}

function releaseFixture() {
  const digestA = `sha256:${'a'.repeat(64)}`;
  const digestB = `sha256:${'b'.repeat(64)}`;
  const core = sealReleaseSubjectCore({
    schemaVersion: 1, deploymentIdentity: { kind: 'build', value: 'projection-build' },
    targets: [{ role: 'audited', origin: 'https://candidate.example.test' }], mode: 'single-site',
    requestedAuthority: { qualifier: 'FULL', scope: { features: ['visual'], definitions: ['VISUAL-001'], targets: ['candidate'], knownLimits: [] } },
    revisions: { runner: digestA, plugins: digestA, targets: digestA, configuration: digestA },
    environmentIdentity: digestB, certificatePolicy: 'strict',
  });
  const manifest = sealExecutionManifest({
    schemaVersion: 1, subjectCoreDigest: core.digest,
    workItems: [{ id: 'work-visual', definitionId: 'VISUAL-001', targetId: 'candidate', targetRole: 'audited' }],
    oracleExecutions: [{ id: 'oracle-visual', definitionId: 'VISUAL-001', requiredWorkItemIds: ['work-visual'] }],
    contextWorkItemIds: [],
  });
  const finalSubject = sealFinalReleaseSubject({
    schemaVersion: 1, subjectCore: core, executionManifest: manifest,
    grantedAuthority: core.requestedAuthority,
    coverageBasis: { selectedDefinitions: ['VISUAL-001'], selectedTargets: ['candidate'], excludedAsNotApplicable: [] },
    deploymentIdentityRecheck: core.deploymentIdentity,
  });
  const result = sealWorkItemResult({
    schemaVersion: 1, workItemId: 'work-visual', subjectCoreDigest: core.digest,
    attempt: 1, authoritative: true, outcome: 'completed_pass', evidenceDigests: [digestA],
  });
  const oracle = sealOracleResult({
    schemaVersion: 1, oracleExecution: manifest.oracleExecutions[0],
    finalSubjectDigest: finalSubject.digest, workItemResults: [result],
  });
  const visualRisk = {
    schemaVersion: 1, category: 'unreviewed-visual-change', severity: 'high', mode: 'single-site',
    scope: finalSubject.grantedAuthority.scope, source: { kind: 'visual-result', id: 'hero-change' },
    explanation: 'The hero changed and needs human review.', recommendedAction: 'Review the visual comparison.',
    reviewState: 'PENDING_REVIEW', releaseEffect: 'non-blocking', actor: { id: 'runner', kind: 'service' },
    observedAt: '2026-08-28T20:00:00.000Z', updatedAt: '2026-08-28T20:00:00.000Z',
  };
  const manualRisk = {
    schemaVersion: 1, category: 'manual-check', severity: 'medium', mode: 'single-site',
    scope: finalSubject.grantedAuthority.scope, source: { kind: 'manual-obligation', id: 'editorial-review' },
    explanation: 'Editorial nuance still benefits from human review.', recommendedAction: 'Review the editorial presentation.',
    reviewState: 'OPEN', releaseEffect: 'non-blocking', actor: { id: 'runner', kind: 'service' },
    observedAt: '2026-08-28T20:00:00.000Z', updatedAt: '2026-08-28T20:00:00.000Z',
  };
  return { core, manifest, finalSubject, oracle, visualRisk, manualRisk };
}
