import type { WorkExecutionDescriptor } from '../../shared/work-execution-descriptor.mjs';
import type { ProductFailureSignature } from '../../shared/execution-contract.mjs';
export function readContainedPlaywrightAttachment(
  candidate: string,
  realArtifactRoot: string,
  options?: { afterOpen?: () => void | Promise<void> },
): Promise<Readonly<{ bytes: Buffer; realCandidate: string }>>;
export function validateSharedPlaywrightRows(document: unknown, descriptor: WorkExecutionDescriptor): {
  outcome: 'completed_pass' | 'completed_product_failure';
  rows: ReadonlyArray<{ row: number; title: string; projectName: string; caseId: string; entrySpec: string; status: string; retry: 0; evidencePolicy: { mode: 'interaction-video' | 'static-screenshot' | 'structured-data'; rationale: string }; attachments: ReadonlyArray<{ name: string; contentType: string; path: string | null; body: string | null }> }>;
  failureAssertionIdentities: ReadonlyArray<string>;
  failureIdentityComplete: boolean;
};
export function collectSharedPlaywrightArtifacts(input: { document: unknown; descriptor: WorkExecutionDescriptor; artifactRoot: string; evidenceRoot: string }): Promise<{
  outcome: 'completed_pass' | 'completed_product_failure';
  rows: ReadonlyArray<{ row: number; title: string; projectName: string; caseId: string; entrySpec: string; status: string; retry: 0; evidencePolicy: { mode: 'interaction-video' | 'static-screenshot' | 'structured-data'; rationale: string }; attachments: ReadonlyArray<{ name: string; contentType: string; path: string }> }>;
  artifacts: ReadonlyArray<{ path: string; mediaType: string; logicalName: string; purpose: 'structured' | 'primary' | 'diagnostic'; sizeBytes: number; contentDigest: string }>;
  visualRiskSource: Readonly<{
    status: 'COMPLETE' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
    observedAt: string | null;
    changedItems: ReadonlyArray<Readonly<{ id: string; comparison: Readonly<Record<string, unknown>> }>>;
  }>;
  productFailureSignature: ProductFailureSignature | null;
}>;
