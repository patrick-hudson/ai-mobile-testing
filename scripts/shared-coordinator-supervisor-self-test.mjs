import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSharedCoordinatorSupervisor } from './lib/shared-coordinator-supervisor.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import {
  adoptAttemptEvidence, createParentRun, openParentRunStore, publishAttemptEvidence, readParentRun,
} from './lib/parent-run-store.mjs';
import { compileSharedLaunchPlan } from '../shared/launch-plan-compiler.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-coordinator-supervisor-'));
const digest = (character) => `sha256:${character.repeat(64)}`;
try {
  const [pluginRegistry, targetRegistry] = await Promise.all([
    readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const store = await openParentRunStore({
    root,
    deploymentIdentity: 'supervisor-test',
    volumeIdentity: 'named-volume:supervisor-test',
    verifyStorage: false,
  });
  const supervisor = createSharedCoordinatorSupervisor({
    store,
    controlService: createSharedControlService({ store, projectId: 'project-1' }),
    projectId: 'project-1',
    ownerId: 'coordinator-supervisor-test',
    coordinatorLeaseMs: 60_000,
    workLeaseMs: 30_000,
    pluginRegistry,
    targetRegistry,
  });
  assert.deepEqual(await supervisor.maintain(), {
    state: 'ready', epoch: 1, runCount: 0, requeued: 0, completedOperations: 0, sealedGraphs: 0,
    performanceScheduler: { phase: 'idle', runId: null, workItemId: null }, errors: [],
  }, 'the store-wide coordinator must acquire before the first run exists');
  for (const [runId, suffix] of [['run-a', 'a'], ['run-b', 'b']]) {
    await createParentRun(store, {
      runId,
      subjectCoreDigest: digest(suffix),
      compilationState: 'pending',
      runnerRevision: 'runner-v1',
      workItems: [{
        id: `work-${suffix}`, maxAttempts: 3, capability: 'browser:chromium', resourceClass: 'ordinary',
        targetId: 'single-site-mobile-chromium', specAffinity: 'tests/accessibility.spec.ts',
      }],
    });
  }
  const worker = {
    id: 'worker-ordinary', kind: 'worker', roles: ['worker'], projectIds: ['project-1'], runIds: ['*'],
    workerGrant: { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] },
  };
  const first = await supervisor.claim(worker, {
    workerId: worker.id, capabilities: ['browser:chromium'], resourceClasses: ['ordinary'],
  });
  const second = await supervisor.claim(worker, {
    workerId: worker.id, capabilities: ['browser:chromium'], resourceClasses: ['ordinary'],
  });
  assert.deepEqual([first.runId, second.runId].sort(), ['run-a', 'run-b'],
    'one store-wide scheduler must fairly claim work from multiple portal-created runs');
  assert.equal((await supervisor.maintain()).runCount, 2);
  assert.throws(() => supervisor.schedulingFor({ ...worker, workerGrant: {
    capabilities: ['performance:lighthouse'], resourceClasses: ['performance'],
  } }, { capabilities: ['browser:chromium'], resourceClasses: ['ordinary'] }), /server-issued execution grant/i);
  await assert.rejects(supervisor.claim({ ...worker, id: 'worker-performance', workerGrant: {
    capabilities: ['performance:lighthouse'], resourceClasses: ['performance'],
  } }), (error) => error?.code === 'PERFORMANCE_DRAIN_REQUIRED');

  const deploymentIdentity = { kind: 'target-preflight-set', value: digest('9') };
  const launch = compileSharedLaunchPlan({
    intent: { schemaVersion: 1, runContract: {
      schemaVersion: 1,
      mode: 'single-site',
      url: 'https://candidate.example.test',
      deploymentRole: 'preview',
      certificatePolicy: 'strict',
      targetIds: ['single-site-mobile-chromium'],
      scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['A11Y-001'], areas: [] },
    } },
    pluginRegistry,
    targetRegistry,
    runnerRevision: digest('1'),
    configurationRevision: digest('2'),
    environmentRevision: digest('3'),
    deploymentIdentity,
  });
  await createParentRun(store, { runId: 'run-inventory', ...launch.createParentRunInput });
  const inventoryWorker = {
    ...worker,
    id: 'worker-inventory',
    workerGrant: { capabilities: ['inventory:http'], resourceClasses: ['ordinary'] },
  };
  const inventoryLease = await supervisor.claim(inventoryWorker);
  assert.equal(inventoryLease.runId, 'run-inventory');
  const inventoryDocument = {
    schemaVersion: 1,
    kind: 'shared-single-site-inventory-result',
    workItemId: inventoryLease.workItemId,
    executionDescriptorDigest: inventoryLease.executionDescriptorDigest,
    deploymentIdentityRecheck: deploymentIdentity,
    preflight: { accepted: true },
    diagnostic: {
      inventory: {
        schemaVersion: 1,
        origin: 'https://candidate.example.test',
        routes: [{
          url: 'https://candidate.example.test/', path: '/', query: '', disposition: 'included',
          sources: [{ source: 'catalog', from: null, depth: 0 }],
        }],
        limitations: [], failures: [],
      },
    },
  };
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventoryDocument)}\n`);
  const inbox = await publishAttemptEvidence(store, 'run-inventory', inventoryLease, {
    outcome: 'completed_pass',
    executionDescriptorDigest: inventoryLease.executionDescriptorDigest,
    artifacts: [{
      name: 'inventory/live-route-inventory.json',
      mediaType: 'application/json',
      sizeBytes: inventoryBytes.length,
      digest: `sha256:${createHash('sha256').update(inventoryBytes).digest('hex')}`,
      contentBase64: inventoryBytes.toString('base64'),
    }],
  });
  await adoptAttemptEvidence(store, 'run-inventory', supervisor.coordinator(), inbox);
  const sealed = await supervisor.maintain();
  assert.equal(sealed.sealedGraphs, 1);
  const sealedState = await readParentRun(store, 'run-inventory');
  assert.equal(sealedState.compilationState, 'sealed');
  assert(sealedState.finalSubjectDigest);
  assert(Object.values(sealedState.workItems).every(({ executionDescriptor }) => executionDescriptor?.digest),
    'inventory expansion must preserve a compiler-issued descriptor on every browser work item');
} finally {
  await rm(root, { recursive: true, force: true });
}
process.stdout.write('Shared coordinator supervisor self-test passed: store-wide startup, multi-run fairness, and server-issued worker grants are enforced.\n');
