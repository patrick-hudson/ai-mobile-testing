import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sealExecutionManifest } from '../shared/execution-contract.mjs';
import { sealFinalReleaseSubject, sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { resolveRunnerRevision, runnerRevisionDigest } from '../shared/runner-revision.mjs';
import { sealWorkExecutionDescriptor } from '../shared/work-execution-descriptor.mjs';
import {
  SHARED_DOCKER_RESILIENCE_CASES,
  SHARED_DOCKER_RESILIENCE_ORIGIN,
  SHARED_DOCKER_RESILIENCE_SPEC,
  SHARED_DOCKER_RESILIENCE_TARGET_ID,
  SHARED_DOCKER_RESILIENCE_WORKLOAD_DIGEST,
} from '../shared/shared-docker-resilience-contract.mjs';
import {
  createParentRun,
  openParentRunStore,
  readAdoptedAttemptArtifactJson,
  readParentRun,
} from './lib/parent-run-store.mjs';
import { readTrustedStoreMarker, sharedStoreBuildIdentity, sharedStoreGeneration, sharedStoreRollbackBuilds } from './lib/shared-store-runtime.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const action = required('AUDIT_SHARED_PROOF_ACTION');
const runId = required('AUDIT_SHARED_PROOF_RUN_ID');
const workItemCount = Number(process.env.AUDIT_SHARED_PROOF_WORK_ITEMS ?? 6);
if (!Number.isSafeInteger(workItemCount) || workItemCount < 2 || workItemCount > 8) {
  throw new Error('AUDIT_SHARED_PROOF_WORK_ITEMS must be an integer from 2 through 8.');
}
const storeMarker = await readTrustedStoreMarker(required('AUDIT_SHARED_STORE_MARKER_FILE'));
const backupMarker = await readTrustedStoreMarker(required('AUDIT_SHARED_BACKUP_MARKER_FILE'), 'shared backup marker');
const buildIdentity = sharedStoreBuildIdentity();
const store = await openParentRunStore({
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

if (action === 'seed') {
  const runnerRevision = runnerRevisionDigest(await resolveRunnerRevision({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  }));
  const targetId = SHARED_DOCKER_RESILIENCE_TARGET_ID;
  const origin = SHARED_DOCKER_RESILIENCE_ORIGIN;
  const definitions = SHARED_DOCKER_RESILIENCE_CASES.slice(0, workItemCount).map(({ auditId }) => auditId);
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
  const descriptors = definitions.map((definitionId, index) => sealWorkExecutionDescriptor({
    workItemId: `proof-${String(index + 1).padStart(3, '0')}`,
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
    capability: 'browser:chromium',
    resourceClass: 'ordinary',
    origins: { candidate: origin, production: null },
    certificatePolicy: 'strict',
    route: null,
  }));
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
    if (canonicalAttempt) {
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
  throw new Error('AUDIT_SHARED_PROOF_ACTION must be seed or inspect.');
}
