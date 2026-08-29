export interface WorkExecutionDescriptor {
  schemaVersion: 1;
  kind: 'shared-work-execution-descriptor';
  workItemId: string;
  subjectCoreDigest: string;
  runnerRevision: string;
  mode: 'single-site' | 'comparative';
  operation: 'inventory' | 'playwright';
  definitionId: string;
  pluginId: string | null;
  caseId: string | null;
  entrySpec: string | null;
  targetId: string;
  targetRole: string;
  capability: string;
  resourceClass: 'ordinary' | 'performance';
  origins: { candidate: string; production: string | null };
  certificatePolicy: string;
  route: null | { inventoryDigest: string; url: string; path: string };
  digest: string;
}
export function sealWorkExecutionDescriptor(input: Omit<WorkExecutionDescriptor, 'schemaVersion' | 'kind' | 'digest'>): WorkExecutionDescriptor;
export function parseWorkExecutionDescriptor(value: unknown): WorkExecutionDescriptor;
