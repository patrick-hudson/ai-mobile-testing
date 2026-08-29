import type { WorkExecutionDescriptor } from '../../shared/work-execution-descriptor.mjs';
export function validateSharedPlaywrightRows(document: unknown, descriptor: WorkExecutionDescriptor): {
  outcome: 'completed_pass' | 'completed_product_failure';
  rows: ReadonlyArray<{ row: number; title: string; projectName: string; caseId: string; entrySpec: string; status: string; retry: 0; evidencePolicy: { mode: 'interaction-video' | 'static-screenshot' | 'structured-data'; rationale: string }; attachments: ReadonlyArray<{ name: string; contentType: string; path: string | null; body: string | null }> }>;
};
export function collectSharedPlaywrightArtifacts(input: { document: unknown; descriptor: WorkExecutionDescriptor; artifactRoot: string; evidenceRoot: string }): Promise<{
  outcome: 'completed_pass' | 'completed_product_failure';
  rows: ReadonlyArray<{ row: number; title: string; projectName: string; caseId: string; entrySpec: string; status: string; retry: 0; evidencePolicy: { mode: 'interaction-video' | 'static-screenshot' | 'structured-data'; rationale: string }; attachments: ReadonlyArray<{ name: string; contentType: string; path: string }> }>;
  artifacts: ReadonlyArray<{ path: string; mediaType: string }>;
}>;
