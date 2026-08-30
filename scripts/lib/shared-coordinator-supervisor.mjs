import { assertPrincipalAuthorized, CONTROL_ACTIONS, ControlPlaneError } from '../../shared/control-plane-contract.mjs';
import {
  acquireStoreCoordinator,
  claimStoreWorkItem,
  heartbeatCoordinator,
  listParentRunIds,
  readAdoptedAttemptArtifactJson,
  reconcileStorePerformanceScheduler,
  recoverParentRun,
  requeueExpiredWork,
  requestStorePerformanceDrain,
  sealParentRunGraph,
  terminalizeParentRunCompilation,
} from './parent-run-store.mjs';
import {
  completeSingleSiteInventoryBarrier,
  compileCanonicalExecutionGraph,
} from '../../shared/execution-graph-compiler.mjs';
import { scheduleCanonicalWorkItems } from '../../shared/launch-plan-compiler.mjs';

const PROJECTION_PENDING_CODES = new Set([
  'PUBLICATION_UNAVAILABLE',
  'SEALED_MANIFEST_MISSING',
  'RELEASE_AUTHORITY_INACTIVE',
  // Projection inputs are intentionally assembled outside the canonical
  // mutation lock. A worker heartbeat can advance the mutation ledger before
  // the envelope is published; the next maintenance pass rebuilds it from the
  // new head instead of treating the optimistic race as run corruption.
  'PUBLICATION_LEDGER_MISMATCH',
]);

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
  pluginRegistry = null,
  targetRegistry = null,
  onEvent = () => {},
  afterInventorySeal = async () => {},
} = {}) {
  if (!store || !controlService || typeof ownerId !== 'string' || !ownerId
    || typeof projectId !== 'string' || !projectId || typeof onEvent !== 'function'
    || typeof afterInventorySeal !== 'function'
    || !Number.isSafeInteger(coordinatorLeaseMs) || coordinatorLeaseMs < 5_000 || coordinatorLeaseMs > 3_600_000
    || !Number.isSafeInteger(workLeaseMs) || workLeaseMs < 1_000 || workLeaseMs > 3_600_000
    || !Number.isSafeInteger(runLimit) || runLimit < 1 || runLimit > 10_000) {
    throw new TypeError('Shared coordinator supervisor options are invalid.');
  }
  let coordinator = null;
  let coordinatorAccess = Promise.resolve();
  let schedulingAccess = Promise.resolve();
  let maintenance = Promise.resolve();
  let cursor = 0;
  let latest = Object.freeze({
    state: 'starting', epoch: null, runCount: 0,
    performanceScheduler: Object.freeze({ phase: 'unknown', runId: null, workItemId: null }),
    errors: Object.freeze([]),
  });

  const schedulerSummary = (scheduler) => Object.freeze({
    phase: scheduler.phase,
    runId: scheduler.reservation?.runId ?? null,
    workItemId: scheduler.reservation?.workItemId ?? null,
  });

  async function sealCompletedInventory(runId, state, active) {
    if (state.compilationState !== 'pending') return false;
    const barriers = Object.values(state.workItems).filter(({ capability }) => capability === 'inventory:http');
    if (barriers.length !== 1 || barriers[0].state !== 'completed_pass') return false;
    if (!pluginRegistry || !targetRegistry || !state.subjectCore || !state.inventoryBarrierPlan) {
      fail('INVENTORY_COMPILER_UNAVAILABLE', 'The active coordinator lacks the pinned compiler inputs for a completed inventory barrier.');
    }
    const barrier = barriers[0];
    const artifact = await readAdoptedAttemptArtifactJson(store, runId, {
      workItemId: barrier.id,
      name: 'inventory/live-route-inventory.json',
    });
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
      || artifact.schemaVersion !== 1 || artifact.kind !== 'shared-single-site-inventory-result'
      || artifact.workItemId !== barrier.id
      || artifact.executionDescriptorDigest !== barrier.executionDescriptor?.digest
      || !artifact.deploymentIdentityRecheck || !artifact.diagnostic?.inventory
      || artifact.preflight?.accepted !== true) {
      fail('INVENTORY_RESULT_INVALID', 'The adopted inventory artifact is not bound to the completed compiler barrier.');
    }
    const completion = completeSingleSiteInventoryBarrier({
      subjectCore: state.subjectCore,
      barrier: state.inventoryBarrierPlan,
      attempt: barrier.canonicalResult.attempt,
      manualRekicks: barrier.manualRekicks,
      routeInventory: artifact.diagnostic.inventory,
      deploymentIdentityRecheck: artifact.deploymentIdentityRecheck,
    });
    const graph = compileCanonicalExecutionGraph({
      subjectCore: state.subjectCore,
      pluginRegistry,
      targetRegistry,
      inventoryCompletion: completion,
      deploymentIdentityRecheck: artifact.deploymentIdentityRecheck,
    });
    const workItems = scheduleCanonicalWorkItems({
      executionGraph: graph,
      subjectCore: state.subjectCore,
      runnerRevision: state.runnerRevision,
    });
    await sealParentRunGraph(store, runId, active, {
      subjectCore: state.subjectCore,
      executionManifest: graph.executionManifest,
      finalSubject: graph.finalSubject,
      inventoryWorkItemId: barrier.id,
      workItems,
    });
    await afterInventorySeal({ runId, graph, workItems });
    onEvent({ event: 'single-site-graph-sealed', runId, workItemCount: workItems.length, graphDigest: graph.digest });
    return true;
  }

  async function terminalizeExhaustedInventory(runId, state, active) {
    if (state.compilationState !== 'pending') return false;
    const barriers = Object.values(state.workItems).filter(({ capability }) => capability === 'inventory:http');
    if (barriers.length !== 1 || Object.keys(state.workItems).length !== 1
      || barriers[0].state !== 'incomplete') return false;
    await terminalizeParentRunCompilation(store, runId, active);
    onEvent({
      event: 'single-site-compilation-failed',
      runId,
      workItemId: barriers[0].id,
      attemptCount: barriers[0].attempts.length,
    });
    return true;
  }

  function coordinatorNeedsRenewal(active) {
    if (active === null) return true;
    const renewalWindowMs = Math.min(10_000, Math.max(1_000, Math.floor(coordinatorLeaseMs / 3)));
    return Date.parse(active.expiresAt) - store.clock() <= renewalWindowMs;
  }

  async function ensureCoordinatorUnlocked({ forceRenewal = false } = {}) {
    if (coordinator !== null) {
      if (!forceRenewal && !coordinatorNeedsRenewal(coordinator)) return coordinator;
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

  function ensureCoordinator(options) {
    const action = () => ensureCoordinatorUnlocked(options);
    const next = coordinatorAccess.then(action, action);
    coordinatorAccess = next.catch(() => undefined);
    return next;
  }

  async function requireCoordinator(options) {
    const active = await ensureCoordinator(options);
    if (active === null) fail('COORDINATOR_UNAVAILABLE', 'No active shared coordinator lease is available.');
    return active;
  }

  async function maintainOnce() {
    let active = await ensureCoordinator();
    if (active === null) {
      latest = Object.freeze({
        state: 'waiting-for-lease', epoch: null, runCount: 0,
        performanceScheduler: Object.freeze({ phase: 'unknown', runId: null, workItemId: null }),
        errors: Object.freeze([]),
      });
      return latest;
    }
    const runIds = await listParentRunIds(store, { limit: runLimit });
    const errors = [];
    let requeued = 0;
    let completedOperations = 0;
    let sealedGraphs = 0;
    let observedEpoch = active.epoch;
    const visitedRunIds = [];

    async function recoverPriorEpoch(activeCoordinator) {
      if (activeCoordinator.epoch === observedEpoch) return;
      for (const visitedRunId of visitedRunIds) {
        requeued += await requeueExpiredWork(store, visitedRunId, activeCoordinator);
      }
      observedEpoch = activeCoordinator.epoch;
    }

    for (const runId of runIds) {
      try {
        active = await requireCoordinator();
        await recoverPriorEpoch(active);
        visitedRunIds.push(runId);
        let state = await recoverParentRun(store, runId);
        if (state.authorityTombstone !== null) {
          const operations = await controlService.applyAcceptedOperations(active, runId);
          completedOperations += operations.filter(({ state: operationState }) => operationState === 'completed').length;
          continue;
        }
        const recoveredCount = await requeueExpiredWork(store, runId, active);
        requeued += recoveredCount;
        if (recoveredCount > 0) state = await recoverParentRun(store, runId);
        const terminalizedInventory = await terminalizeExhaustedInventory(runId, state, active);
        if (!terminalizedInventory && await sealCompletedInventory(runId, state, active)) {
          sealedGraphs += 1;
        }
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
    let performanceScheduler;
    try {
      active = await requireCoordinator();
      await recoverPriorEpoch(active);
      performanceScheduler = schedulerSummary(await reconcileStorePerformanceScheduler(store, active));
    } catch (error) {
      const failure = Object.freeze({
        runId: null,
        code: typeof error?.code === 'string' ? error.code : 'PERFORMANCE_SCHEDULER_MAINTENANCE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
      errors.push(failure);
      performanceScheduler = Object.freeze({ phase: 'unavailable', runId: null, workItemId: null });
      onEvent({ event: 'performance-scheduler-maintenance-failed', ...failure });
    }
    latest = Object.freeze({
      state: coordinator === null ? 'waiting-for-lease' : 'ready',
      epoch: coordinator?.epoch ?? null,
      runCount: runIds.length, requeued,
      completedOperations, sealedGraphs, performanceScheduler, errors: Object.freeze(errors),
    });
    return latest;
  }

  function maintain() {
    const next = maintenance.then(maintainOnce, maintainOnce);
    maintenance = next.catch(() => undefined);
    return next;
  }

  async function renewCoordinator() {
    return requireCoordinator({ forceRenewal: true });
  }

  function withSchedulingAccess(action) {
    const next = schedulingAccess.then(action, action);
    schedulingAccess = next.catch(() => undefined);
    return next;
  }

  async function claimUnlocked(principal, request = {}) {
    assertPrincipalAuthorized(principal, CONTROL_ACTIONS.WORK_CLAIM, { projectId });
    const scheduling = workerScheduling(principal, request);
    const active = await requireCoordinator();
    const discovered = await listParentRunIds(store, { limit: runLimit });
    const eligible = discovered.filter((runId) => principalCanAccessRun(principal, runId));
    if (eligible.length === 0) fail('NO_AUTHORIZED_RUN', 'Worker has no authorized parent run to claim.', 403);
    const ordered = eligible.map((_, index) => eligible[(cursor + index) % eligible.length]);
    const lease = await claimStoreWorkItem(store, active, {
      ...scheduling,
      runIds: ordered,
      leaseMs: workLeaseMs,
    });
    cursor = (eligible.indexOf(lease.runId) + 1) % eligible.length;
    onEvent({
      event: 'work-item-claimed', runId: lease.runId, workItemId: lease.workItemId,
      resourceClass: lease.resourceClass, workerId: scheduling.workerId,
    });
    return lease;
  }

  function claim(principal, request = {}) {
    return withSchedulingAccess(() => claimUnlocked(principal, request));
  }

  async function requestPerformanceDrainUnlocked(principal, request = {}) {
    assertPrincipalAuthorized(principal, CONTROL_ACTIONS.WORK_CLAIM, { projectId });
    const scheduling = workerScheduling(principal, request);
    if (scheduling.resourceClasses[0] !== 'performance'
      || !scheduling.capabilities.includes('performance:lighthouse')) {
      fail('WORKER_CAPABILITY_MISMATCH', 'Only a server-granted Lighthouse worker can request performance drain.', 403);
    }
    const active = await requireCoordinator();
    const discovered = await listParentRunIds(store, { limit: runLimit });
    const eligible = discovered.filter((runId) => principalCanAccessRun(principal, runId));
    if (eligible.length === 0) fail('NO_AUTHORIZED_RUN', 'Worker has no authorized parent run to drain.', 403);
    const ordered = eligible.map((_, index) => eligible[(cursor + index) % eligible.length]);
    const reservation = await requestStorePerformanceDrain(store, active, {
      ...scheduling,
      runIds: ordered,
      leaseMs: workLeaseMs,
    });
    cursor = (eligible.indexOf(reservation.runId) + 1) % eligible.length;
    onEvent({
      event: 'performance-drain-requested', runId: reservation.runId,
      workItemId: reservation.workItemId, workerId: scheduling.workerId,
    });
    return reservation;
  }
  function requestPerformanceDrain(principal, request = {}) {
    return withSchedulingAccess(() => requestPerformanceDrainUnlocked(principal, request));
  }

  return Object.freeze({
    maintain,
    renewCoordinator,
    claim,
    requestPerformanceDrain,
    status: () => latest,
    coordinator: () => coordinator,
    schedulingFor: workerScheduling,
  });
}
