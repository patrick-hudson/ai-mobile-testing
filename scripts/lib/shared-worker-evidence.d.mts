import type { AttemptArtifactUpload } from './shared-worker-pool.mjs';
export const MAX_WORKER_ARTIFACTS: 64;
export const MAX_WORKER_ARTIFACT_BYTES: number;
export const MAX_WORKER_EVIDENCE_BYTES: number;
export function collectSharedWorkerEvidence(evidenceRoot: string, completion: { code: number | null; signal?: NodeJS.Signals | null }): Promise<{
  outcome: 'completed_pass' | 'completed_product_failure';
  reason: string | null;
  artifacts: AttemptArtifactUpload[];
}>;
