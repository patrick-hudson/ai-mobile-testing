import { canonicalJson } from '../../shared/canonical-contract.mjs';
import { assertPrincipalAuthorized, CONTROL_ACTIONS, ControlPlaneError } from '../../shared/control-plane-contract.mjs';
import { createParentRun, recoverParentRun } from './parent-run-store.mjs';
import {
  acceptSharedLaunchOperation,
  completeSharedLaunchOperation,
  findSharedLaunchOperation,
  getSharedLaunchOperation,
  listRecoverableSharedLaunchOperations,
  sharedLaunchOperationIdentity,
} from './shared-launch-operation-store.mjs';

function fail(code, message, statusCode = 500) {
  throw new ControlPlaneError(code, message, statusCode);
}

function immutableRunMatchesPlan(state, operation) {
  const input = operation.compiledPlan.createParentRunInput;
  if (state.runId !== operation.runId
    || state.subjectCoreDigest !== input.subjectCoreDigest
    || state.runnerRevision !== input.runnerRevision) return false;
  if (operation.compiledPlan.state === 'sealed') {
    return state.compilationState === 'sealed'
      && state.executionManifestDigest === input.executionManifestDigest
      && state.finalSubjectDigest === input.finalSubjectDigest;
  }
  const barrierId = input.workItems[0]?.id;
  return typeof barrierId === 'string'
    && (state.workItems[barrierId]?.capability === 'inventory:http'
      || state.compilationBarrier?.id === barrierId);
}

export function createSharedLaunchService({
  operationStore, parentRunStore, projectId, compilePlan,
} = {}) {
  if (!operationStore || !parentRunStore || typeof projectId !== 'string' || !projectId
    || typeof compilePlan !== 'function') {
    throw new TypeError('Shared launch service requires operation store, parent-run store, project, and compiler.');
  }

  async function accept(principal, { requestId, intent } = {}) {
    assertPrincipalAuthorized(principal, CONTROL_ACTIONS.RUN_LAUNCH, { projectId });
    const launchIdentity = sharedLaunchOperationIdentity({ principal, projectId, requestId });
    if (!Array.isArray(principal.runIds)
      || (!principal.runIds.includes('*') && !principal.runIds.includes(launchIdentity.runId))) {
      fail('AUTHORIZATION_DENIED', 'Launching a server-derived run requires project-wide or exact derived-run scope.', 403);
    }
    const existing = await findSharedLaunchOperation(operationStore, {
      principal, projectId, requestId, intent,
    });
    if (existing) return existing;
    const compiledPlan = await compilePlan(intent);
    return acceptSharedLaunchOperation(operationStore, {
      principal, projectId, requestId, intent, compiledPlan,
    });
  }

  async function read(principal, operationId) {
    const operation = await getSharedLaunchOperation(operationStore, operationId);
    assertPrincipalAuthorized(principal, CONTROL_ACTIONS.OPERATION_READ, {
      projectId: operation.projectId,
      runId: operation.runId,
    });
    if (operation.projectId !== projectId) fail('AUTHORIZATION_DENIED', 'Launch operation belongs to another project.', 403);
    return operation;
  }

  async function materialize(operationId) {
    const operation = await getSharedLaunchOperation(operationStore, operationId);
    if (operation.projectId !== projectId) fail('AUTHORIZATION_DENIED', 'Launch operation belongs to another project.', 403);
    if (operation.state === 'completed') return operation;
    const createInput = {
      ...structuredClone(operation.compiledPlan.createParentRunInput),
      runId: operation.runId,
    };
    let state;
    try {
      state = await createParentRun(parentRunStore, createInput);
    } catch (error) {
      if (error?.code !== 'RUN_ALREADY_EXISTS') throw error;
      state = await recoverParentRun(parentRunStore, operation.runId);
    }
    if (!immutableRunMatchesPlan(state, operation)) {
      return completeSharedLaunchOperation(operationStore, operationId, {
        status: 'failed',
        code: 'LAUNCH_RUN_MISMATCH',
        message: 'Reserved run identity exists with different immutable launch bindings.',
      });
    }
    return completeSharedLaunchOperation(operationStore, operationId, {
      status: 'succeeded',
      runId: operation.runId,
      subjectCoreDigest: state.subjectCoreDigest,
      executionManifestDigest: state.executionManifestDigest,
      compilationState: state.compilationState,
    });
  }

  async function recover({ limit, onError = () => {} } = {}) {
    if (typeof onError !== 'function') throw new TypeError('Shared launch recovery onError must be a function.');
    const listed = await listRecoverableSharedLaunchOperations(operationStore, limit === undefined ? {} : { limit });
    const completed = [];
    const errors = [...listed.errors];
    for (const error of listed.errors) onError(error);
    for (const operation of listed.operations) {
      try {
        completed.push(await materialize(operation.operationId));
      } catch (error) {
        const failure = Object.freeze({
          operationId: operation.operationId,
          code: typeof error?.code === 'string' ? error.code : 'LAUNCH_MATERIALIZATION_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
        errors.push(failure);
        onError(failure);
      }
    }
    return Object.freeze({ completed: Object.freeze(completed), errors: Object.freeze(errors) });
  }

  return Object.freeze({ projectId, accept, read, materialize, recover });
}

export function sharedLaunchOperationEquivalent(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
