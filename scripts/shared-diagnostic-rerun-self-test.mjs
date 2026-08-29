import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSharedControlApi } from '../portal/shared-control-api.mjs';
import { sealExecutionManifest } from '../shared/execution-contract.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { sealRiskSourceObservationSet } from '../shared/risk-source-observation.mjs';
import { sealWorkExecutionDescriptor } from '../shared/work-execution-descriptor.mjs';
import { sealWorkItemEvidenceMember } from '../shared/work-item-evidence-index.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import { createSharedCoordinatorSupervisor } from './lib/shared-coordinator-supervisor.mjs';
import {
  adoptAttemptEvidence,
  appendAttemptLog,
  createParentRun,
  listAdoptedAttemptArtifacts,
  openAdoptedAttemptArtifact,
  openParentRunStore,
  publishAttemptEvidence,
  readCurrentEnvelope,
  readParentRun,
  readReleaseAuthoritySelector,
  transitionReleaseAuthority,
} from './lib/parent-run-store.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const runId = 'run-diagnostic-rerun-proof';
const failedWorkItemId = 'work-failed';
const passedWorkItemId = 'work-passed';
const projectId = 'project-diagnostic-rerun';
const now = Date.parse('2026-08-29T20:00:00.000Z');

const [pluginRegistry, targetRegistry] = await Promise.all([
  readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8').then(JSON.parse),
]);
const subjectCore = sealReleaseSubjectCore({
  schemaVersion: 1,
  deploymentIdentity: { kind: 'target-preflight-set', value: digest('5') },
  targets: [{ role: 'audited', origin: 'https://diagnostic.example.test' }],
  mode: 'single-site',
  requestedAuthority: {
    qualifier: 'TARGETED',
    scope: { features: ['navigation'], definitions: ['NAV-001'], targets: ['audited-desktop'], knownLimits: [] },
  },
  revisions: { runner: digest('1'), plugins: digest('2'), targets: digest('3'), configuration: digest('4') },
  environmentIdentity: digest('6'),
  certificatePolicy: 'strict',
});
const workItems = [failedWorkItemId, passedWorkItemId].map((workItemId) => ({
  id: workItemId, definitionId: 'NAV-001',
  targetId: 'audited-desktop', targetRole: 'audited',
}));
const executionManifest = sealExecutionManifest({
  schemaVersion: 1, subjectCoreDigest: subjectCore.digest, workItems,
  oracleExecutions: [{
    id: 'oracle-diagnostic-proof', definitionId: 'NAV-001',
    requiredWorkItemIds: [failedWorkItemId, passedWorkItemId],
  }],
  contextWorkItemIds: [],
});
const finalSubject = sealFinalReleaseSubject({
  schemaVersion: 1, subjectCore, executionManifest, grantedAuthority: subjectCore.requestedAuthority,
  coverageBasis: {
    selectedDefinitions: ['NAV-001'], selectedTargets: ['audited-desktop'], excludedAsNotApplicable: [],
  },
  deploymentIdentityRecheck: subjectCore.deploymentIdentity,
});
const descriptors = Object.fromEntries(workItems.map(({ id, definitionId }) => [id, sealWorkExecutionDescriptor({
  workItemId: id, subjectCoreDigest: subjectCore.digest, runnerRevision: subjectCore.revisions.runner,
  mode: 'single-site', operation: 'playwright', definitionId,
  pluginId: 'navigation-search-content', caseId: `${definitionId}:tests/navigation.spec.ts:audited-desktop`,
  entrySpec: 'tests/navigation.spec.ts', targetId: 'audited-desktop', targetRole: 'audited',
  capability: 'browser:chromium', resourceClass: 'ordinary',
  origins: { candidate: 'https://diagnostic.example.test', production: null }, certificatePolicy: 'strict', route: null,
})]));

const root = await mkdtemp(path.join(tmpdir(), 'shared-diagnostic-rerun-'));
try {
  const store = await openParentRunStore({
    root, deploymentIdentity: 'shared-diagnostic-rerun-test', volumeIdentity: 'named-volume:diagnostic-rerun-test',
    backupMarker: 'backup:diagnostic-rerun-test', storeMarker: 'de'.repeat(32), verifyStorage: false, clock: () => now,
  });
  let observedDeploymentIdentity = subjectCore.deploymentIdentity;
  const reprobeInputs = [];
  const controlService = createSharedControlService({
    store,
    projectId,
    reprobeTargetIdentity: async (input) => {
      reprobeInputs.push(input);
      return observedDeploymentIdentity;
    },
  });
  const supervisor = createSharedCoordinatorSupervisor({
    store, controlService, projectId, ownerId: 'coordinator-diagnostic-rerun', pluginRegistry, targetRegistry,
  });
  await supervisor.maintain();
  const shadow = await readReleaseAuthoritySelector(store);
  const draining = await transitionReleaseAuthority(store, supervisor.coordinator(), {
    expectedSelectorDigest: shadow.digest, phase: 'DRAINING', buildIdentity: store.buildIdentity,
  });
  await transitionReleaseAuthority(store, supervisor.coordinator(), {
    expectedSelectorDigest: draining.digest, phase: 'ACTIVE', activationRevision: 1, buildIdentity: store.buildIdentity,
  });
  await createParentRun(store, {
    runId, compilationState: 'sealed', subjectCore, executionManifest, finalSubject,
    runnerRevision: subjectCore.revisions.runner,
    workItems: workItems.map(({ id }) => ({
      id, capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'audited-desktop',
      specAffinity: 'tests/navigation.spec.ts', executionDescriptor: descriptors[id], maxAttempts: 2,
    })),
  });
  await supervisor.maintain();
  const worker = {
    id: 'worker-diagnostic-rerun', kind: 'worker', roles: ['worker'], projectIds: [projectId], runIds: [runId],
    workerGrant: { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
  };
  const publish = async (lease, outcome, artifacts = []) => {
    const riskSourceObservationSet = sealRiskSourceObservationSet({
      schemaVersion: 1, runId, workItemId: lease.workItemId, subjectCoreDigest: lease.subjectCoreDigest,
      attempt: lease.attempt, workerId: worker.id,
      producerStates: [
        { producer: 'visual', status: 'NOT_APPLICABLE' },
        { producer: 'baseline', status: 'NOT_APPLICABLE' },
        { producer: 'evidence-pipeline', status: 'COMPLETE' },
      ],
      observations: [],
    });
    const inbox = await publishAttemptEvidence(store, runId, lease, {
      outcome, reason: outcome === 'completed_pass' ? null : 'assertion-failed', artifacts,
      executionDescriptorDigest: lease.executionDescriptorDigest, riskSourceObservationSet,
    });
    return adoptAttemptEvidence(store, runId, supervisor.coordinator(), inbox);
  };
  await publish(await supervisor.claim(worker), 'completed_product_failure');
  await publish(await supervisor.claim(worker), 'completed_pass');
  await supervisor.maintain();

  const failedState = await readParentRun(store, runId);
  const failedPublication = await readCurrentEnvelope(store, runId);
  const original = failedState.workItems[failedWorkItemId];
  assert.equal(failedPublication.decision.code, 'NOT_READY_TEST_FAILURE');

  const operator = { id: 'operator-diagnostic', kind: 'human', roles: ['operator'], projectIds: [projectId], runIds: [runId] };
  const api = createSharedControlApi({
    authority: { authenticateCredential: async () => operator }, service: controlService, claimStore: {},
    expectedOrigin: 'http://127.0.0.1:4173',
  });
  const mutate = (requestId, body) => api.handle({
    method: 'POST', url: `http://127.0.0.1:4173/api/control/v1/runs/${runId}/diagnostic-rerun`,
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', 'idempotency-key': requestId }, body,
  });
  const wrongSubject = await mutate('diagnostic-wrong-subject-0001', {
    expectedRunRevision: failedState.runRevision, expectedSubjectDigest: digest('f'), workItemId: failedWorkItemId,
  });
  assert.equal(wrongSubject.status, 409, JSON.stringify(wrongSubject.body));
  const nonFailed = await mutate('diagnostic-nonfailed-0001', {
    expectedRunRevision: failedState.runRevision, expectedSubjectDigest: finalSubject.digest, workItemId: passedWorkItemId,
  });
  assert.equal(nonFailed.status, 409);

  const currentState = await readParentRun(store, runId);
  const accepted = await mutate('diagnostic-rerun-0001', {
    expectedRunRevision: currentState.runRevision, expectedSubjectDigest: finalSubject.digest, workItemId: failedWorkItemId,
  });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  await supervisor.maintain();
  const firstDiagnosticLease = await supervisor.claim(worker);
  assert.equal(firstDiagnosticLease.workItemId, failedWorkItemId);
  assert.match(firstDiagnosticLease.diagnosticExecutionId, /^[a-f0-9]{64}$/u);
  assert.equal(firstDiagnosticLease.subjectCoreDigest, subjectCore.digest);
  assert.equal(firstDiagnosticLease.executionDescriptorDigest, descriptors[failedWorkItemId].digest);
  await publish(firstDiagnosticLease, 'operational_failure');
  const diagnosticLease = await supervisor.claim(worker);
  assert.equal(diagnosticLease.diagnosticExecutionId, firstDiagnosticLease.diagnosticExecutionId);
  assert.equal(diagnosticLease.attempt, 2);
  await appendAttemptLog(store, runId, diagnosticLease, {
    sequence: 1, level: 'info', message: 'diagnostic-rerun: same-subject assertion now passes',
  });
  const diagnosticBytes = Buffer.from('diagnostic-only-pass-evidence');
  const contentDigest = `sha256:${createHash('sha256').update(diagnosticBytes).digest('hex')}`;
  const member = sealWorkItemEvidenceMember({
    workItemId: failedWorkItemId, executionDescriptorDigest: diagnosticLease.executionDescriptorDigest,
    ordinal: 1, logicalName: 'diagnostic-rerun-result', purpose: 'diagnostic', mediaType: 'text/plain',
    sizeBytes: diagnosticBytes.length, contentDigest, transportPath: 'diagnostic/result.txt',
  });
  await publish(diagnosticLease, 'completed_pass', [{
    name: member.transportPath, mediaType: member.mediaType, sizeBytes: member.sizeBytes,
    digest: member.contentDigest, logicalName: member.logicalName, purpose: member.purpose,
    memberDigest: member.memberDigest, contentBase64: diagnosticBytes.toString('base64'),
  }]);
  await supervisor.maintain();

  const finalState = await readParentRun(store, runId);
  const finalPublication = await readCurrentEnvelope(store, runId);
  const finalItem = finalState.workItems[failedWorkItemId];
  assert.equal(finalItem.canonicalResult.digest, original.canonicalResult.digest);
  assert.deepEqual(finalItem.canonicalRiskSourceObservationSet, original.canonicalRiskSourceObservationSet);
  assert.deepEqual(finalItem.attempts, original.attempts);
  assert.equal(finalPublication.digest, failedPublication.digest);
  assert.equal(finalPublication.runRevision, failedPublication.runRevision);
  assert.equal(finalPublication.decisionRevision, failedPublication.decisionRevision);
  assert.equal(finalPublication.decision.code, 'NOT_READY_TEST_FAILURE');
  assert.equal(finalItem.diagnosticExecutions.length, 1);
  assert.equal(finalItem.diagnosticExecutions[0].state, 'completed_pass');
  assert.deepEqual(finalItem.diagnosticExecutions[0].attempts.map(({ outcome }) => outcome), [
    'operational_failure', 'completed_pass',
  ]);
  assert.equal(finalItem.diagnosticExecutions[0].attempts[1].artifacts[0].purpose, 'diagnostic');
  assert.equal(finalItem.diagnosticExecutions[0].result.authoritative, false);
  const [executions, workspace] = await Promise.all([
    controlService.readExecutions(operator, runId), controlService.readWorkspace(operator, runId),
  ]);
  assert.equal(executions.diagnosticExecutions[0].diagnosticExecutionId, diagnosticLease.diagnosticExecutionId);
  assert.equal(workspace.executions.diagnosticExecutions[0].state, 'completed_pass');
  assert.equal(workspace.logs.attemptLogs.find(
    ({ diagnosticExecutionId }) => diagnosticExecutionId === diagnosticLease.diagnosticExecutionId)?.message,
  'diagnostic-rerun: same-subject assertion now passes');
  const diagnosticArtifacts = await listAdoptedAttemptArtifacts(store, runId);
  assert.equal(diagnosticArtifacts.files.length, 1);
  assert.equal(diagnosticArtifacts.files[0].authoritative, false);
  assert.equal(diagnosticArtifacts.files[0].diagnosticExecutionId, diagnosticLease.diagnosticExecutionId);
  assert.equal(diagnosticArtifacts.files[0].purpose, 'diagnostic');
  const openedDiagnostic = await openAdoptedAttemptArtifact(store, runId, {
    workItemId: failedWorkItemId,
    artifactKey: diagnosticArtifacts.files[0].artifactKey,
  });
  assert.equal(await openedDiagnostic.opened.handle.readFile('utf8'), diagnosticBytes.toString('utf8'));
  await openedDiagnostic.opened.handle.close();
  await openedDiagnostic.opened.transferLease.release();

  observedDeploymentIdentity = { kind: 'target-preflight-set', value: digest('f') };
  const beforeDrift = await readParentRun(store, runId);
  const driftAccepted = await mutate('diagnostic-rerun-drift-0001', {
    expectedRunRevision: beforeDrift.runRevision,
    expectedSubjectDigest: finalSubject.digest,
    workItemId: failedWorkItemId,
  });
  assert.equal(driftAccepted.status, 202, JSON.stringify(driftAccepted.body));
  await supervisor.maintain();
  await assert.rejects(() => supervisor.claim(worker), { code: 'NO_WORK_AVAILABLE' });
  const driftState = await readParentRun(store, runId);
  const driftPublication = await readCurrentEnvelope(store, runId);
  const driftDiagnostic = driftState.workItems[failedWorkItemId].diagnosticExecutions[1];
  assert.equal(reprobeInputs.length, 2);
  assert.deepEqual(reprobeInputs[1].subjectCore.targets, finalSubject.targets);
  assert.equal(driftDiagnostic.state, 'incomplete');
  assert.equal(driftDiagnostic.authoritative, false);
  assert.equal(driftDiagnostic.terminationReason, 'target_identity_mismatch');
  assert.equal(driftDiagnostic.identityRecheck.observed.value, digest('f'));
  assert.equal(driftDiagnostic.attempts.length, 0);
  assert.equal(driftState.workItems[failedWorkItemId].canonicalResult.digest, original.canonicalResult.digest);
  assert.deepEqual(driftState.workItems[failedWorkItemId].canonicalRiskSourceObservationSet,
    original.canonicalRiskSourceObservationSet);
  assert.deepEqual(driftState.workItems[failedWorkItemId].attempts, original.attempts);
  assert.equal(driftPublication.digest, failedPublication.digest);
  assert.equal(driftPublication.runRevision, failedPublication.runRevision);
  assert.equal(driftPublication.decisionRevision, failedPublication.decisionRevision);
  assert.equal(driftPublication.decision.code, 'NOT_READY_TEST_FAILURE');
  const driftWorkspace = await controlService.readWorkspace(operator, runId);
  assert.equal(driftWorkspace.executions.diagnosticExecutions[1].terminationReason, 'target_identity_mismatch');
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('Shared diagnostic rerun self-test passed: same-subject diagnostic evidence remains visible and never rewrites release truth.\n');
