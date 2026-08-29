import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSharedCoordinatorSupervisor } from './lib/shared-coordinator-supervisor.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import { createParentRun, openParentRunStore } from './lib/parent-run-store.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-coordinator-supervisor-'));
const digest = (character) => `sha256:${character.repeat(64)}`;
try {
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
  });
  assert.deepEqual(await supervisor.maintain(), {
    state: 'ready', epoch: 1, runCount: 0, requeued: 0, completedOperations: 0, errors: [],
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
  } }), (error) => error?.code === 'GLOBAL_PERFORMANCE_SCHEDULER_PENDING');
} finally {
  await rm(root, { recursive: true, force: true });
}
process.stdout.write('Shared coordinator supervisor self-test passed: store-wide startup, multi-run fairness, and server-issued worker grants are enforced.\n');
