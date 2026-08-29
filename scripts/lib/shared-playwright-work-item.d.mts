import type { WorkExecutionDescriptor } from '../../shared/work-execution-descriptor.mjs';
export function validateSharedPlaywrightRows(document: unknown, descriptor: WorkExecutionDescriptor): {
  outcome: 'completed_pass' | 'completed_product_failure';
  rows: ReadonlyArray<{ row: number; title: string; projectName: string; caseId: string; entrySpec: string; status: string; retry: 0 }>;
};
