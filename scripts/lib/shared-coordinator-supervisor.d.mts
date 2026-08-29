import type { CoordinatorFence, ParentRunStore, WorkLease } from './parent-run-store.mjs';
export interface SharedCoordinatorStatus {
  state: 'starting' | 'waiting-for-lease' | 'ready';
  epoch: number | null;
  runCount: number;
  requeued?: number;
  completedOperations?: number;
  sealedGraphs?: number;
  performanceScheduler: { phase: 'unknown' | 'unavailable' | 'idle' | 'draining' | 'running'; runId: string | null; workItemId: string | null };
  errors: readonly Array<{ runId: string | null; code: string; message: string }>;
}
export interface SharedCoordinatorSupervisor {
  maintain(): Promise<SharedCoordinatorStatus>;
  claim(principal: any, request?: any): Promise<WorkLease>;
  requestPerformanceDrain(principal: any, request?: any): Promise<{ workerId: string; runId: string; workItemId: string; coordinatorEpoch: number; requestedAt: string; expiresAt: string }>;
  status(): SharedCoordinatorStatus;
  coordinator(): CoordinatorFence | null;
  schedulingFor(principal: any, request?: any): { workerId: string; capabilities: readonly string[]; resourceClasses: readonly string[] };
}
export function createSharedCoordinatorSupervisor(input: {
  store: ParentRunStore;
  controlService: any;
  projectId?: string;
  ownerId: string;
  coordinatorLeaseMs?: number;
  workLeaseMs?: number;
  runLimit?: number;
  pluginRegistry?: unknown;
  targetRegistry?: unknown;
  onEvent?: (event: any) => void;
}): SharedCoordinatorSupervisor;
