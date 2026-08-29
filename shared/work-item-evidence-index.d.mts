export type WorkItemEvidencePurpose = 'structured' | 'primary' | 'diagnostic';
export interface WorkItemEvidenceMember {
  schemaVersion: 1;
  kind: 'work-item-evidence-member';
  workItemId: string;
  executionDescriptorDigest: string;
  ordinal: number;
  logicalName: string;
  purpose: WorkItemEvidencePurpose;
  mediaType: string;
  sizeBytes: number;
  contentDigest: string;
  transportPath: string;
  memberDigest: string;
}
export interface WorkItemEvidenceIndex {
  schemaVersion: 1;
  kind: 'work-item-evidence-index';
  workItemId: string;
  executionDescriptorDigest: string;
  row: { caseId: string; definitionId: string; entrySpec: string; targetId: string; status: 'passed' | 'failed' | 'timedOut'; evidencePolicy: { mode: 'interaction-video' | 'static-screenshot' | 'structured-data'; rationale: string } };
  members: WorkItemEvidenceMember[];
  digest: string;
}
export const WORK_ITEM_EVIDENCE_PURPOSES: readonly WorkItemEvidencePurpose[];
export const MAX_WORK_ITEM_EVIDENCE_MEMBERS: 64;
export function sealWorkItemEvidenceMember(value: Omit<WorkItemEvidenceMember, 'schemaVersion' | 'kind' | 'memberDigest'>): WorkItemEvidenceMember;
export function sealWorkItemEvidenceIndex(value: { workItemId: string; executionDescriptorDigest: string; row: WorkItemEvidenceIndex['row']; members: Array<Omit<WorkItemEvidenceMember, 'schemaVersion' | 'kind' | 'workItemId' | 'executionDescriptorDigest' | 'memberDigest'>> }): WorkItemEvidenceIndex;
export function parseWorkItemEvidenceIndex(value: unknown): WorkItemEvidenceIndex;
