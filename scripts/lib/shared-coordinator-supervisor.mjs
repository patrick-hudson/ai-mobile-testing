import { assertPrincipalAuthorized, CONTROL_ACTIONS, ControlPlaneError } from '../../shared/control-plane-contract.mjs';
import {
  acquireStoreCoordinator,
  claimWorkItem,
  heartbeatCoordinator,
  listParentRunIds,
  recoverParentRun,
  requeueExpiredWork,
} from './parent-run-store.mjs';

const CLAIM_SKIP_CODES = new Set(['NO_WORK_AVAILABLE', 'NO_COMPATIBLE_WORK']);
const PROJECTION_PENDING_CODES = new Set(['PUBLICATION_UNAVAILABLE', 'SEALED_MANIFEST_MISSING']);

function fail(code, message, statusCode = 503) {
  throw new ControlPlaneError(code, message, statusCode);
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function workerScheduling(principal, request = {}) {
  const grant = principal?.workerGrant;
  if (!grant || !Array.isArray(grant.capabilities) || !Array.isArray(grant.resourceClasses)
    || grant.capabilities.length === 0 || grant.resourceClasses.length !== 1) {
    fail('WORKER_GRANT_REQUIRED', 'Worker principal has no server-issued execution grant.', 403);
  }
  if ((request.workerId !== undefined && request.workerId !== principal.id)
    || (request.capabilities !== undefined && !sameStrings(request.capabilities, grant.capabilities))
    || (request.resourceClasses !== undefined && !sameStrings(request.resourceClasses, grant.resourceClasses))) {
    fail('WORKER_GRANT_MISMATCH', 'Worker claim does not match its server-issued execution grant.', 403);
  }
  return Object.freeze({
    workerId: principal.id,
    capabilities: Object.freeze([...grant.capabilities]),
    resourceClasses: Object.freeze([...grant.resourceClasses]),
  });
}

function principalCanAccessRun(principal, runId) {
  return Array.isArray(principal?.runIds) && (principal.runIds.includes('*') || principal.runIds.includes(runId));
}

export function createSharedCoordinatorSupervisor({
  store,
  controlService,
  projectId = 'default',
  ownerId,
  coordinatorLeaseMs = 60_000,
  workLeaseMs = 30_000,
  runLimit = 2_048,
  onEvent = () => {},
} = {}) {
  if (!store || !controlService || typeof ownerId !== 'string' || !ownerId
    || typeof projectId !== 'string' || !projectId || typeof onEvent !== 'function'
    || !Number.isSafeInteger(coordinatorLeaseMs) || coordinatorLeaseMs < 5_000 || coordinatorLeaseMs > 3_600_000
    || !Number.isSafeInteger(workLeaseMs) || workLeaseMs < 1_000 || workLeaseMs > 3_600_000
    || !Number.isSafeInteger(runLimit) || runLimit < 1 || runLimit > 10_000) {
    throw new TypeError('Shared coordinator supervisor options are invalid.');
  }
  let coordinator = null;
  let maintenance = Promise.resolve();
  let cursor = 0;
  let latest = Object.freeze({ state: 'starting', epoch: null, runCount: 0, errors: Object.freeze([]) });

  async function ensureCoordinator() {
    if (coordinator !== null) {
      try {
        coordinator = await heartbeatCoordinator(store, coordinator, { leaseMs: coordinatorLeaseMs });
        return coordinator;
      } catch (error) {
        if (error?.code !== 'STALE_COORDINATOR') throw error;
        coordinator = null;
      }
    }
    try {
      coordinator = await acquireStoreCoordinator(store, { ownerId, leaseMs: coordinatorLeaseMs });
      onEvent({ event: 'coordinator-acquired', epoch: coordinator.epoch });
      return coordinator;
    } catch (error) {
      if (error?.code !== 'COORDINATOR_LEASE_HELD') throw error;
      // A concurrent in-process maintenance/claim may have won the same
      // acquisition while this call was awaiting the durable lock.
      return coordinator;
    }
  }

  async function maintainOnce() {
    const active = await ensureCoordinator();
    if (active === null) {
      latest = Object.freeze({ state: 'waiting-for-lease', epoch: null, runCount: 0, errors: Object.freeze([]) });
      return latest;
    }
    const runIds = await listParentRunIds(store, { limit: runLimit });
    const errors = [];
    let requeued = 0;
    let completedOperations = 0;
    for (const runId of runIds) {
      try {
        const state = await recoverParentRun(store, runId);
        if (state.authorityTombstone !== null) continue;
        requeued += await requeueExpiredWork(store, runId, active);
        const operations = await controlService.applyAcceptedOperations(active, runId);
        completedOperations += operations.length;
        try {
          await controlService.publishCurrentProjection(active, runId);
        } catch (error) {
          if (!PROJECTION_PENDING_CODES.has(error?.code)) throw error;
        }
      } catch (error) {
        const failure = Object.freeze({
          runId,
          code: typeof error?.code === 'string' ? error.code : 'RUN_MAINTENANCE_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
        errors.push(failure);
        onEvent({ event: 'run-maintenance-failed', ...failure });
      }
    }
    latest = Object.freeze({
      state: 'ready', epoch: active.epoch, runCount: runIds.length, requeued,
      completedOperations, errors: Object.freeze(errors),
    });
    return latest;
  }

  function maintain() {
    const next = maintenance.then(maintainOnce, maintainOnce);
    maintenance = next.catch(() => undefined);
    return next;
  }

  async function claim(principal, request = {}) {
    assertPrincipalAuthorized(principal, CONTROL_ACTIONS.WORK_CLAIM, { projectId });
    const scheduling = workerScheduling(principal, request);
    if (scheduling.resourceClasses[0] === 'performance') {
      fail('GLOBAL_PERFORMANCE_SCHEDULER_PENDING',
        'Performance work remains fenced until the store-global exclusive resource scheduler is active.', 409);
    }
    const active = await ensureCoordinator();
    if (active === null) fail('COORDINATOR_UNAVAILABLE', 'No active shared coordinator lease is available.');
    const discovered = await listParentRunIds(store, { limit: runLimit });
    const eligible = discovered.filter((runId) => principalCanAccessRun(principal, runId));
    if (eligible.length === 0) fail('NO_AUTHORIZED_RUN', 'Worker has no authorized parent run to claim.', 403);
    const ordered = eligible.map((_, index) => eligible[(cursor + index) % eligible.length]);
    for (const runId of ordered) {
      try {
        const state = await recoverParentRun(store, runId);
        if (state.status !== 'active' || state.authorityTombstone !== null) continue;
        const lease = await claimWorkItem(store, runId, active, { ...scheduling, leaseMs: workLeaseMs });
        cursor = (eligible.indexOf(runId) + 1) % eligible.length;
        return lease;
      } catch (error) {
        if (['STORE_CORRUPT', 'RUN_NOT_FOUND'].includes(error?.code)) {
          onEvent({ event: 'run-claim-skipped', runId, code: error.code, message: error.message });
          continue;
        }
        if (!CLAIM_SKIP_CODES.has(error?.code) && error?.code !== 'RUN_CANCELLED') throw error;
      }
    }
    fail('NO_WORK_AVAILABLE', 'No compatible queued work is available across authorized runs.', 409);
  }

  return Object.freeze({
    maintain,
    claim,
    status: () => latest,
    coordinator: () => coordinator,
    schedulingFor: workerScheduling,
  });
}
