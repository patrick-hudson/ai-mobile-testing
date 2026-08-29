export interface SharedLaunchOperationStore { root: string; clock(): number }
export interface SharedLaunchOperation {
  schemaVersion: 1;
  kind: 'shared-launch-operation';
  operationId: string;
  projectId: string;
  actor: { id: string; kind: 'human' | 'service' };
  requestId: string;
  requestDigest: string;
  intent: { schemaVersion: 1; runContract: unknown };
  state: 'accepted' | 'running' | 'completed';
  runId: string | null;
  outcome: unknown | null;
  acceptedAt: string;
  updatedAt: string;
}
export class SharedLaunchOperationError extends Error { code: string; statusCode: number }
export const SHARED_LAUNCH_OPERATION_SCHEMA_VERSION: 1;
export function openSharedLaunchOperationStore(options: { root: string; clock?: () => number; verifyStorage?: boolean }): Promise<SharedLaunchOperationStore>;
export function acceptSharedLaunchOperation(store: SharedLaunchOperationStore, input: {
  principal: { id: string; kind: 'human' | 'service' };
  projectId: string;
  requestId: string;
  intent: SharedLaunchOperation['intent'];
}): Promise<SharedLaunchOperation>;
export function getSharedLaunchOperation(store: SharedLaunchOperationStore, operationId: string): Promise<SharedLaunchOperation>;
