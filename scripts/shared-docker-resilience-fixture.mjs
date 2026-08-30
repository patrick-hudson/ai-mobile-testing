import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sealExecutionManifest } from '../shared/execution-contract.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { resolveRunnerRevision, runnerRevisionDigest } from '../shared/runner-revision.mjs';
import { sealWorkExecutionDescriptor } from '../shared/work-execution-descriptor.mjs';
import { compileSharedLaunchPlan } from '../shared/launch-plan-compiler.mjs';
import { openScopedCredentialAuthority } from '../portal/scoped-credential-authority.mjs';
import {
  SHARED_DOCKER_RESILIENCE_CASES,
  SHARED_DOCKER_RESILIENCE_ORIGIN,
  SHARED_DOCKER_RESILIENCE_SPEC,
  SHARED_DOCKER_RESILIENCE_TARGET_ID,
  SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST,
} from '../shared/shared-docker-resilience-contract.mjs';
import {
  createParentRun,
  acquireStoreCoordinator,
  adoptAttemptEvidence,
  claimWorkItem,
  getOperationById,
  heartbeatCoordinator,
  openParentRunStore,
  publishAttemptEvidence,
  readAdoptedAttemptArtifactJson,
  readParentRun,
  readReleaseAuthoritySelector,
  readRunHistories,
  readStoreCoordinator,
  transitionReleaseAuthority,
} from './lib/parent-run-store.mjs';
import { readSharedResilienceCrashSentinel } from './lib/shared-resilience-failpoint.mjs';
import { readTrustedStoreMarker, sharedStoreBuildIdentity, sharedStoreGeneration, sharedStoreRollbackBuilds } from './lib/shared-store-runtime.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const action = required('AUDIT_SHARED_PROOF_ACTION');
const runId = required('AUDIT_SHARED_PROOF_RUN_ID');
if (!/^[A-Za-z0-9._-]{1,128}$/u.test(runId)) throw new Error('AUDIT_SHARED_PROOF_RUN_ID is invalid.');
const workItemCount = Number(process.env.AUDIT_SHARED_PROOF_WORK_ITEMS ?? 6);
const performanceWorkItemId = process.env.AUDIT_SHARED_PROOF_PERFORMANCE_WORK_ITEM_ID ?? null;
if (!Number.isSafeInteger(workItemCount) || workItemCount < 2 || workItemCount > 8) {
  throw new Error('AUDIT_SHARED_PROOF_WORK_ITEMS must be an integer from 2 through 8.');
}
if (performanceWorkItemId !== null && !/^proof-00[1-8]$/u.test(performanceWorkItemId)) {
  throw new Error('AUDIT_SHARED_PROOF_PERFORMANCE_WORK_ITEM_ID must identify one frozen proof item.');
}
const CONTROL_CLIENT_ACTIONS = new Set(['provision-operator', 'probe-portal', 'accept-mutation']);
let buildIdentity = null;
let store = null;
if (!CONTROL_CLIENT_ACTIONS.has(action)) {
  const storeMarker = await readTrustedStoreMarker(required('AUDIT_SHARED_STORE_MARKER_FILE'));
  const backupMarker = await readTrustedStoreMarker(required('AUDIT_SHARED_BACKUP_MARKER_FILE'), 'shared backup marker');
  buildIdentity = sharedStoreBuildIdentity();
  store = await openParentRunStore({
    root: required('AUDIT_SHARED_STORE_ROOT'),
    deploymentIdentity: required('AUDIT_SHARED_DEPLOYMENT_IDENTITY'),
    volumeIdentity: required('AUDIT_SHARED_VOLUME_IDENTITY'),
    storeMarker,
    storeGeneration: sharedStoreGeneration(),
    expectedStoreGeneration: sharedStoreGeneration(),
    buildIdentity,
    backupMarker,
    prequalifiedRollbackBuilds: sharedStoreRollbackBuilds(process.env, buildIdentity),
  });
}

if (action === 'seed') {
  const runnerRevision = runnerRevisionDigest(await resolveRunnerRevision({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  }));
  const targetId = SHARED_DOCKER_RESILIENCE_TARGET_ID;
  const origin = SHARED_DOCKER_RESILIENCE_ORIGIN;
  const definitions = SHARED_DOCKER_RESILIENCE_CASES.slice(0, workItemCount).map(({ auditId }) => auditId);
  if (performanceWorkItemId !== null && Number(performanceWorkItemId.slice(-3)) > definitions.length) {
    throw new Error('AUDIT_SHARED_PROOF_PERFORMANCE_WORK_ITEM_ID is outside the seeded workload.');
  }
  const scope = {
    features: ['shared-runner-resilience'],
    definitions,
    targets: [targetId],
    knownLimits: ['frozen-synthetic-workload'],
  };
  const frozenDigest = SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST;
  const subjectCore = sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: { kind: 'fixture', value: frozenDigest },
    targets: [{ role: 'preview', origin }],
    mode: 'single-site',
    requestedAuthority: { qualifier: 'TARGETED', scope },
    revisions: {
      runner: runnerRevision,
      plugins: frozenDigest,
      targets: frozenDigest,
      configuration: frozenDigest,
    },
    environmentIdentity: frozenDigest,
    certificatePolicy: 'strict',
  });
  const descriptors = definitions.map((definitionId, index) => {
    const workItemId = `proof-${String(index + 1).padStart(3, '0')}`;
    const performance = workItemId === performanceWorkItemId;
    return sealWorkExecutionDescriptor({
      workItemId,
      subjectCoreDigest: subjectCore.digest,
      runnerRevision,
      mode: 'single-site',
      operation: 'playwright',
      definitionId,
      pluginId: null,
      caseId: `${definitionId}:shared-docker-resilience`,
      entrySpec: SHARED_DOCKER_RESILIENCE_SPEC,
      targetId,
      targetRole: 'preview',
      capability: performance ? 'performance:lighthouse' : 'browser:chromium',
      resourceClass: performance ? 'performance' : 'ordinary',
      origins: { candidate: origin, production: null },
      certificatePolicy: 'strict',
      route: null,
    });
  });
  const executionManifest = sealExecutionManifest({
    schemaVersion: 1,
    subjectCoreDigest: subjectCore.digest,
    workItems: descriptors.map((descriptor) => ({
      id: descriptor.workItemId,
      definitionId: descriptor.definitionId,
      targetId: descriptor.targetId,
      targetRole: descriptor.targetRole,
    })),
    oracleExecutions: descriptors.map((descriptor) => ({
      id: `oracle-${descriptor.workItemId}`,
      definitionId: descriptor.definitionId,
      requiredWorkItemIds: [descriptor.workItemId],
    })),
    contextWorkItemIds: [],
  });
  const finalSubject = sealFinalReleaseSubject({
    schemaVersion: 1,
    subjectCore,
    executionManifest,
    grantedAuthority: subjectCore.requestedAuthority,
    coverageBasis: {
      selectedDefinitions: definitions,
      selectedTargets: [targetId],
      excludedAsNotApplicable: [],
    },
    deploymentIdentityRecheck: subjectCore.deploymentIdentity,
  });
  await createParentRun(store, {
    runId,
    subjectCore,
    subjectCoreDigest: subjectCore.digest,
    runnerRevision,
    compilationState: 'sealed',
    executionManifest,
    finalSubject,
    workItems: descriptors.map((descriptor) => ({
      id: descriptor.workItemId,
      maxAttempts: 3,
      capability: descriptor.capability,
      resourceClass: descriptor.resourceClass,
      targetId: descriptor.targetId,
      specAffinity: descriptor.entrySpec,
      executionDescriptor: descriptor,
    })),
  });
  process.stdout.write(`${JSON.stringify({
    event: 'shared-resilience-fixture-seeded', runId, workItemCount,
    workloadDigest: frozenDigest,
    subjectCoreDigest: subjectCore.digest,
    executionManifestDigest: executionManifest.digest,
    finalSubjectDigest: finalSubject.digest,
  })}\n`);
} else if (action === 'seed-inventory-completed') {
  const [pluginRegistry, targetRegistry] = await Promise.all([
    readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const fixtureDigest = SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST;
  const deploymentIdentity = { kind: 'target-preflight-set', value: fixtureDigest };
  const launch = compileSharedLaunchPlan({
    intent: { schemaVersion: 1, runContract: {
      schemaVersion: 1,
      mode: 'single-site',
      url: SHARED_DOCKER_RESILIENCE_ORIGIN,
      deploymentRole: 'preview',
      certificatePolicy: 'strict',
      targetIds: [SHARED_DOCKER_RESILIENCE_TARGET_ID],
      scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['A11Y-001'], areas: [] },
    } },
    pluginRegistry,
    targetRegistry,
    runnerRevision: fixtureDigest,
    configurationRevision: fixtureDigest,
    environmentRevision: fixtureDigest,
    deploymentIdentity,
  });
  await createParentRun(store, { runId, ...launch.createParentRunInput });
  const coordinator = await acquireStoreCoordinator(store, { ownerId: 'proof-inventory-seeder', leaseMs: 100 });
  // The proof driver owns the only coordinator fence while staging the
  // completed inventory barrier. Use the normal claim API so the adoption is
  // indistinguishable from a real inventory worker publication.
  const claimed = await claimWorkItem(store, runId, coordinator, {
    workerId: 'proof-inventory-seeder', capabilities: ['inventory:http'], resourceClasses: ['ordinary'], leaseMs: 10_000,
  });
  const inventoryDocument = {
    schemaVersion: 1,
    kind: 'shared-single-site-inventory-result',
    workItemId: claimed.workItemId,
    executionDescriptorDigest: claimed.executionDescriptorDigest,
    deploymentIdentityRecheck: deploymentIdentity,
    preflight: { accepted: true },
    diagnostic: { inventory: {
      schemaVersion: 1,
      origin: SHARED_DOCKER_RESILIENCE_ORIGIN,
      routes: [{
        url: `${SHARED_DOCKER_RESILIENCE_ORIGIN}/`, path: '/', query: '', disposition: 'included',
        sources: [{ source: 'catalog', from: null, depth: 0 }],
      }],
      limitations: [], failures: [],
    } },
  };
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventoryDocument)}\n`);
  const inbox = await publishAttemptEvidence(store, runId, claimed, {
    outcome: 'completed_pass',
    executionDescriptorDigest: claimed.executionDescriptorDigest,
    artifacts: [{
      name: 'inventory/live-route-inventory.json', mediaType: 'application/json', sizeBytes: inventoryBytes.length,
      digest: `sha256:${createHash('sha256').update(inventoryBytes).digest('hex')}`,
      contentBase64: inventoryBytes.toString('base64'),
    }],
  });
  await adoptAttemptEvidence(store, runId, coordinator, inbox);
  process.stdout.write(`${JSON.stringify({ event: 'shared-resilience-inventory-staged', runId })}\n`);
} else if (action === 'stale-fence-probe') {
  const current = await readStoreCoordinator(store);
  if (current === null || current.epoch < 2) throw new Error('Recovered coordinator did not advance its fence.');
  let outcome = 'accepted';
  try {
    await heartbeatCoordinator(store, { ...current, epoch: current.epoch - 1 }, { leaseMs: 100 });
  } catch (error) {
    if (error?.code !== 'STALE_COORDINATOR') throw error;
    outcome = 'rejected';
  }
  process.stdout.write(`${JSON.stringify({ event: 'shared-resilience-stale-fence-probed', runId, outcome, currentEpoch: current.epoch })}\n`);
} else if (action === 'activate-authority') {
  const coordinator = await acquireStoreCoordinator(store, { ownerId: 'proof-authority-activator', leaseMs: 100 });
  const shadow = await readReleaseAuthoritySelector(store);
  const draining = await transitionReleaseAuthority(store, coordinator, {
    expectedSelectorDigest: shadow.digest, phase: 'DRAINING', buildIdentity,
  });
  const active = await transitionReleaseAuthority(store, coordinator, {
    expectedSelectorDigest: draining.digest, phase: 'ACTIVE', activationRevision: 1, buildIdentity,
  });
  process.stdout.write(`${JSON.stringify({ event: 'shared-resilience-authority-activated', runId, selector: active })}\n`);
} else if (action === 'read-failpoint') {
  const boundary = required('AUDIT_SHARED_CRASH_BOUNDARY');
  const sentinel = await readSharedResilienceCrashSentinel(boundary, {
    root: required('AUDIT_SHARED_CRASH_SENTINEL_ROOT'),
  });
  process.stdout.write(`${JSON.stringify({ event: 'shared-resilience-failpoint-read', runId, sentinel })}\n`);
} else if (action === 'provision-operator') {
  const credentialRoot = required('AUDIT_SHARED_CREDENTIAL_ROOT');
  const authority = await openScopedCredentialAuthority({ root: credentialRoot });
  const issued = await authority.createPrincipal({
    id: `proof-operator-${runId}`, kind: 'human', roles: ['operator'],
    projectIds: [process.env.AUDIT_SHARED_PROJECT_ID ?? 'default'], runIds: [runId],
  });
  const proofRoot = path.join(credentialRoot, '.resilience-proof');
  await mkdir(proofRoot, { recursive: true, mode: 0o700 });
  await writeFile(path.join(proofRoot, `${runId}.credential`), issued.credential, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ event: 'shared-resilience-operator-provisioned', runId })}\n`);
} else if (action === 'probe-portal') {
  const response = await fetch('http://portal:4173/healthz');
  if (response.status !== 200) throw new Error(`Portal health returned ${response.status}.`);
  process.stdout.write(`${JSON.stringify({ event: 'shared-resilience-portal-ready', runId })}\n`);
} else if (action === 'accept-mutation') {
  const credential = await readFile(path.join(
    required('AUDIT_SHARED_CREDENTIAL_ROOT'), '.resilience-proof', `${runId}.credential`,
  ), 'utf8');
  const response = await fetch(`http://portal:4173/api/control/v1/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'idempotency-key': 'resilience-cancel-0001' },
    body: JSON.stringify({ expectedRunRevision: 1, reason: 'Resilience proof mutation.' }),
  });
  const body = await response.json();
  if (response.status !== 202) throw new Error(`Mutation returned ${response.status}: ${JSON.stringify(body)}`);
  process.stdout.write(`${JSON.stringify({ event: 'shared-resilience-mutation-accepted', runId, operation: body.data })}\n`);
} else if (action === 'inspect-operation') {
  const operation = await getOperationById(store, runId, required('AUDIT_SHARED_PROOF_OPERATION_ID'));
  const histories = await readRunHistories(store, runId);
  process.stdout.write(`${JSON.stringify({
    event: 'shared-resilience-operation-inspected', runId, operation,
    acceptedCount: histories.operation.filter(({ type }) => type === 'operation-accepted').length,
    completedCount: histories.operation.filter(({ type, data }) => type === 'operation-completed' && data?.operationId === operation.operationId).length,
  })}\n`);
} else if (action === 'inspect') {
  const state = await readParentRun(store, runId);
  const workItems = [];
  const dynamicLogicalName = (logicalName) => (
    logicalName === 'work-item-rows'
    || logicalName === 'work-item-evidence-index'
    || logicalName.includes('error-context')
  );
  for (const item of Object.values(state.workItems).sort((left, right) => left.id.localeCompare(right.id))) {
    const canonicalAttempt = item.canonicalResult === null
      ? null
      : item.attempts.find((attempt) => attempt.attempt === item.canonicalResult.attempt);
    let evidence = null;
    if (canonicalAttempt?.artifacts.some(({ logicalName }) => logicalName === 'playwright/work-item-evidence-index.json')) {
      const index = await readAdoptedAttemptArtifactJson(store, runId, {
        workItemId: item.id,
        name: 'playwright/work-item-evidence-index.json',
      });
      evidence = {
        row: index.row,
        members: index.members.map(({ logicalName, purpose, mediaType, sizeBytes, contentDigest }) => ({
          logicalName,
          purpose,
          mediaType,
          sizeBytes,
          // work-item-rows intentionally contains Playwright's randomized
          // transport filenames. Compare its semantic membership, while all
          // substantive evidence retains byte-level content identity.
          contentDigest: dynamicLogicalName(logicalName) ? null : contentDigest,
        })),
      };
    }
    const adoptedArtifactManifest = canonicalAttempt?.artifacts.map((artifact, ordinal) => ({
      ordinal: ordinal + 1,
      logicalName: artifact.logicalName,
      purpose: artifact.purpose,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.sizeBytes,
      contentDigest: dynamicLogicalName(artifact.logicalName) ? null : artifact.digest,
      memberDigest: dynamicLogicalName(artifact.logicalName) ? null : artifact.memberDigest,
    })) ?? null;
    const normalizedCanonicalResult = item.canonicalResult === null ? null : {
      authoritative: item.canonicalResult.authoritative,
      outcome: item.canonicalResult.outcome,
      adoptedArtifactManifest,
    };
    workItems.push({
      id: item.id,
      capability: item.capability,
      resourceClass: item.resourceClass,
      state: item.state,
      outcome: item.canonicalResult?.outcome ?? null,
      authoritative: item.canonicalResult?.authoritative ?? null,
      evidence,
      canonicalResult: normalizedCanonicalResult === null ? null : {
        ...normalizedCanonicalResult,
        normalizedDigest: canonicalDigest(normalizedCanonicalResult),
      },
      canonicalSource: item.canonicalResult === null ? null : {
        attempt: item.canonicalResult.attempt,
        digest: item.canonicalResult.digest,
        evidenceDigests: item.canonicalResult.evidenceDigests,
      },
      activeLease: item.lease === null ? null : {
        workerId: item.lease.workerId,
        attempt: item.lease.attempt,
        epoch: item.lease.epoch,
        claimedAt: item.lease.claimedAt,
        expiresAt: item.lease.expiresAt,
      },
      attempts: item.attempts.map(({ attempt, outcome, reason, artifacts }) => ({
        attempt, outcome, reason, artifactCount: artifacts.length,
      })),
    });
  }
  const invariant = {
    subjectCoreDigest: state.subjectCoreDigest,
    executionManifestDigest: state.executionManifestDigest,
    finalSubjectDigest: state.finalSubjectDigest,
    workItems: workItems.map(({ attempts: _attempts, canonicalSource: _canonicalSource, activeLease: _activeLease, ...item }) => item),
  };
  process.stdout.write(`${JSON.stringify({
    event: 'shared-resilience-fixture-inspected',
    runId,
    volumeIdentity: store.manifest.volumeIdentity,
    terminal: workItems.every(({ state: itemState }) => ['completed_pass', 'completed_product_failure', 'incomplete', 'cancelled'].includes(itemState)),
    invariant,
    invariantDigest: canonicalDigest(invariant),
    workItems,
  })}\n`);
} else {
  throw new Error('AUDIT_SHARED_PROOF_ACTION is unsupported.');
}
