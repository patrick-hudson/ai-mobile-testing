export type WorkItemOutcome = 'completed_pass' | 'completed_product_failure' | 'operational_failure' | 'cancelled' | 'incomplete_unknown';
export interface ProductFailureSignature {
  schemaVersion: 1;
  kind: 'product-failure-signature';
  assertionIdentities: string[];
  findingIdentities: string[];
  digest: string;
}
export interface ExecutionManifest {
  schemaVersion: 1;
  kind: 'execution-manifest';
  subjectCoreDigest: string;
  workItems: Array<{ id: string; definitionId: string; targetId: string; targetRole: string }>;
  oracleExecutions: Array<{
    id: string;
    definitionId: string;
    productOracleVariant: string;
    baselinePolicy: 'not-applicable' | 'context-unless-candidate-regression-proven';
    requiredWorkItemIds: string[];
    workItemBindings: Array<{ workItemId: string; targetRole: string; comparisonKey: string }>;
  }>;
  contextWorkItemIds: string[];
  digest: string;
}
export interface WorkItemResult {
  schemaVersion: 1;
  kind: 'work-item-result';
  workItemId: string;
  subjectCoreDigest: string;
  attempt: number;
  authoritative: boolean;
  outcome: WorkItemOutcome;
  evidenceDigests: string[];
  productFailureSignature?: ProductFailureSignature | null;
  digest: string;
}
export interface OracleResult {
  schemaVersion: 1;
  kind: 'oracle-result';
  oracleExecutionId: string;
  definitionId: string;
  finalSubjectDigest: string;
  subjectCoreDigest: string;
  adoptedWorkItemIds: string[];
  workItemResultDigests: string[];
  productOracleVariant: string;
  baselinePolicy: 'not-applicable' | 'context-unless-candidate-regression-proven';
  workItemBindings: Array<{ workItemId: string; targetRole: string; comparisonKey: string }>;
  workItemOutcomes: Array<{ workItemId: string; outcome: WorkItemOutcome; productFailureSignature?: ProductFailureSignature | null }>;
  comparisonResults?: Array<{
    comparisonKey: string;
    candidateWorkItemId: string | null;
    productionWorkItemId: string | null;
    candidateProductFailureSignatureDigest: string | null;
    productionProductFailureSignatureDigest: string | null;
    classification: 'passed' | 'production-only' | 'reproduced-unchanged' | 'candidate-introduced' | 'candidate-worsened' | 'incomplete';
  }>;
  outcome: 'completed_pass' | 'completed_product_failure' | 'incomplete';
  digest: string;
}
export const WORK_ITEM_OUTCOMES: readonly WorkItemOutcome[];
export function sealProductFailureSignature(value: Omit<ProductFailureSignature, 'kind' | 'digest'>): Readonly<ProductFailureSignature>;
export function parseProductFailureSignature(value: unknown): Readonly<ProductFailureSignature>;
export function sealExecutionManifest(value: unknown): ExecutionManifest;
export function parseExecutionManifest(value: unknown): ExecutionManifest;
export function sealWorkItemResult(value: unknown): WorkItemResult;
export function parseWorkItemResult(value: unknown): WorkItemResult;
export function sealOracleResult(value: unknown): OracleResult;
export function parseOracleResult(value: unknown): OracleResult;
