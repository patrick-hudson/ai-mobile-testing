import type { WorkLease } from './parent-run-store.mjs';

export class SharedWorkLeaseFencedError extends Error {
  code: 'SHARED_WORK_LEASE_FENCED';
}

export function maintainSharedWorkerLease<T>(options: {
  lease: WorkLease;
  intervalMs: number;
  heartbeat(lease: WorkLease): Promise<WorkLease>;
  execute(context: { signal: AbortSignal; lease: WorkLease }): Promise<T>;
  waitForHeartbeat?(intervalMs: number, signal: AbortSignal): Promise<void>;
}): Promise<{ value: T; lease: WorkLease }>;
