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
  planDigest: string;
  compiledPlan: any;
  state: 'accepted' | 'running' | 'completed';
  runId: string;
  outcome: unknown | null;
  acceptedAt: string;
  updatedAt: string;
}
export class SharedLaunchOperationError extends Error { code: string; statusCode: number }
export const SHARED_LAUNCH_OPERATION_SCHEMA_VERSION: 1;
export function sharedLaunchOperationIdentity(input: {
  principal: { id: string; kind: 'human' | 'service' };
  projectId: string;
  requestId: string;
}): Readonly<{ actor: Readonly<{ id: string; kind: 'human' | 'service' }>; operationId: string; runId: string }>;
export function openSharedLaunchOperationStore(options: {
  root: string; clock?: () => number; verifyStorage?: boolean; requireExisting?: boolean;
}): Promise<SharedLaunchOperationStore>;
export function acceptSharedLaunchOperation(store: SharedLaunchOperationStore, input: {
  principal: { id: string; kind: 'human' | 'service' };
  projectId: string;
  requestId: string;
  intent: SharedLaunchOperation['intent'];
  compiledPlan: any;
}): Promise<SharedLaunchOperation>;
export function getSharedLaunchOperation(store: SharedLaunchOperationStore, operationId: string): Promise<SharedLaunchOperation>;
export function findSharedLaunchOperation(store: SharedLaunchOperationStore, input: {
  principal: { id: string; kind: 'human' | 'service' };
  projectId: string;
  requestId: string;
  intent: SharedLaunchOperation['intent'];
}): Promise<SharedLaunchOperation | null>;
export function completeSharedLaunchOperation(store: SharedLaunchOperationStore, operationId: string, outcome: any): Promise<SharedLaunchOperation>;
export interface SharedLaunchRecoveryError { operationId: string; code: string; message: string }
export function listRecoverableSharedLaunchOperations(store: SharedLaunchOperationStore, options?: { limit?: number }): Promise<{
  operations: readonly SharedLaunchOperation[];
  errors: readonly SharedLaunchRecoveryError[];
}>;
