import type { WorkLease } from './parent-run-store.mjs';

export class SharedWorkLeaseFencedError extends Error {
  code: 'SHARED_WORK_LEASE_FENCED';
}

export function sharedWorkHeartbeatInterval(leaseDurationMs: number): number;

export function maintainSharedWorkerLease<T>(options: {
  lease: WorkLease;
  intervalMs: number;
  heartbeat(lease: WorkLease, signal: AbortSignal): Promise<WorkLease>;
  execute(context: { signal: AbortSignal; lease: WorkLease }): Promise<T>;
  waitForHeartbeat?(intervalMs: number, signal: AbortSignal): Promise<void>;
  retryHeartbeat?(error: unknown, lease: WorkLease): boolean;
  retryDelayMs?: number;
  maxHeartbeatRetries?: number;
  expirySafetyMs?: number;
  now?(): number;
}): Promise<{ value: T; lease: WorkLease }>;
