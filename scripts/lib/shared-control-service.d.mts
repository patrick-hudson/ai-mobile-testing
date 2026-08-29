import type { ControlPrincipal } from '../../shared/control-plane-contract.mjs';
import type { ParentRunStore } from './parent-run-store.mjs';
export declare const CONTROL_OPERATION_KINDS: Readonly<Record<string, string>>;
export interface SharedControlService {
  projectId: string;
  readRun(principal: ControlPrincipal, runId: string): Promise<any>;
  readPublication(principal: ControlPrincipal, runId: string): Promise<any>;
  withPublicationFence(principal: ControlPrincipal, runId: string, callback: (publication: any) => any): Promise<any>;
  withReleaseAssertionFence(principal: ControlPrincipal, runId: string, callback: (publication: any, authorityContext: any) => any): Promise<any>;
  readExecutions(principal: ControlPrincipal, runId: string): Promise<any>;
  readLogs(principal: ControlPrincipal, runId: string, options?: { limit?: number }): Promise<any>;
  acceptMutation(principal: ControlPrincipal, runId: string, input: any): Promise<any>;
  readOperation(principal: ControlPrincipal, runId: string, input: any): Promise<any>;
  readOperationById(principal: ControlPrincipal, runId: string, operationId: string): Promise<any>;
  applyAcceptedOperations(coordinator: any, runId: string, handlers?: Record<string, Function>): Promise<any[]>;
  publishCurrentProjection(coordinator: any, runId: string): Promise<any>;
}
export declare function createSharedControlService(options: { store: ParentRunStore; projectId?: string }): SharedControlService;
