import type { SharedLaunchOperation, SharedLaunchOperationStore } from './shared-launch-operation-store.mjs';
import type { ParentRunStore } from './parent-run-store.mjs';
export interface SharedLaunchService {
  projectId: string;
  accept(principal: any, request: { requestId: string; intent: any }): Promise<SharedLaunchOperation>;
  read(principal: any, operationId: string): Promise<SharedLaunchOperation>;
  materialize(operationId: string): Promise<SharedLaunchOperation>;
  recover(options?: { limit?: number; onError?: (error: SharedLaunchRecoveryError) => void }): Promise<{
    completed: readonly SharedLaunchOperation[];
    errors: readonly SharedLaunchRecoveryError[];
  }>;
}
export interface SharedLaunchRecoveryError { operationId: string; code: string; message: string }
export function createSharedLaunchService(input: {
  operationStore: SharedLaunchOperationStore;
  parentRunStore: ParentRunStore;
  projectId: string;
  compilePlan(intent: any): any | Promise<any>;
}): SharedLaunchService;
export function sharedLaunchOperationEquivalent(left: unknown, right: unknown): boolean;
