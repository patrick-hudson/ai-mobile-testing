import type { AttemptArtifactUpload } from './shared-worker-pool.mjs';
import type { WorkLease } from './parent-run-store.mjs';
import type { ProductFailureSignature } from '../../shared/execution-contract.mjs';
export const MAX_WORKER_ARTIFACTS: 64;
export const MAX_WORKER_ARTIFACT_BYTES: number;
export const MAX_WORKER_EVIDENCE_BYTES: number;
export function collectSharedWorkerEvidence(
  evidenceRoot: string,
  completion: { code: number | null; signal?: NodeJS.Signals | null },
  lease: WorkLease,
): Promise<{
  outcome: 'completed_pass' | 'completed_product_failure';
  reason: string | null;
  executionDescriptorDigest: string | null;
  productFailureSignature: ProductFailureSignature | null;
  artifacts: AttemptArtifactUpload[];
}>;
export function collectSharedWorkerAttempt(
  evidenceRoot: string,
  completion: { code: number | null; signal?: NodeJS.Signals | null },
  lease: WorkLease,
): Promise<{
  result: {
    outcome: 'completed_pass' | 'completed_product_failure' | 'operational_failure';
    reason: string | null;
    executionDescriptorDigest: string | null;
    productFailureSignature?: ProductFailureSignature | null;
    artifacts: AttemptArtifactUpload[];
  };
  retryable: boolean;
  runtimeSignal?: NodeJS.Signals | null;
  logEvent: 'command-completed' | 'product-failure' | 'operational-recovery';
  logMessage: string;
}>;
