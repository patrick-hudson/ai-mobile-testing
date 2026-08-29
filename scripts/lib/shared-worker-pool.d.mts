import type { CoordinatorFence, ParentRunStore, WorkLease } from './parent-run-store.mjs';

export class SharedWorkerPoolError extends Error { code: string; details?: unknown }
export interface SharedWorkerDescriptor { id: string; capabilities: string[]; resourceClasses: ['ordinary' | 'performance'] }
export interface ExecutionFailure { kind: string; trustedPlatformSignal?: boolean }
export interface AttemptArtifactUpload { name: string; mediaType: string; sizeBytes: number; digest: string; contentBase64: string }
export function classifyExecutionFailure(value?: ExecutionFailure): { outcome: 'completed_product_failure' | 'operational_failure'; reason: string; retryable: boolean };
export function runSharedWorkerPool(options: {
  store: ParentRunStore;
  runId: string;
  coordinator: CoordinatorFence;
  worker: SharedWorkerDescriptor;
  leaseMs?: number;
  maxClaims?: number;
  execute(lease: WorkLease, worker: SharedWorkerDescriptor): Promise<{ outcome: 'completed_pass' | 'completed_product_failure'; reason?: string | null; artifacts: AttemptArtifactUpload[] }>;
}): Promise<{ workerId: string; claimed: number; completed: number; productFailures: number; operationalRetries: number; adoptedWorkItemIds: readonly string[] }>;
