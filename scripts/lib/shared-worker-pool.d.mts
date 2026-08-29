import type { CoordinatorFence, ParentRunStore, WorkLease } from './parent-run-store.mjs';
import type { ProductFailureSignature } from '../../shared/execution-contract.mjs';

export class SharedWorkerPoolError extends Error { code: string; details?: unknown }
export interface SharedWorkerDescriptor { id: string; capabilities: string[]; resourceClasses: ['ordinary' | 'performance'] }
export interface AttemptArtifactUpload { name: string; mediaType: string; sizeBytes: number; digest: string; logicalName: string; purpose: 'structured' | 'primary' | 'diagnostic'; memberDigest: string; contentBase64: string }
export { classifyExecutionFailure } from './shared-worker-failure.mjs';
export function runSharedWorkerPool(options: {
  store: ParentRunStore;
  runId: string;
  coordinator: CoordinatorFence;
  worker: SharedWorkerDescriptor;
  leaseMs?: number;
  maxClaims?: number;
  execute(lease: WorkLease, worker: SharedWorkerDescriptor): Promise<{ outcome: 'completed_pass' | 'completed_product_failure'; reason?: string | null; productFailureSignature?: ProductFailureSignature | null; artifacts: AttemptArtifactUpload[] }>;
}): Promise<{ workerId: string; claimed: number; completed: number; productFailures: number; operationalRetries: number; adoptedWorkItemIds: readonly string[] }>;
