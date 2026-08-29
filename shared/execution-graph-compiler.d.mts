import type { ExecutionManifest } from './execution-contract.mjs';
import type { FinalReleaseSubject, ReleaseSubjectCore } from './release-subject.mjs';

export interface CanonicalWorkItemPlan {
  id: string;
  definitionId: string;
  pluginId: string;
  caseId: string;
  entrySpec: string;
  applicability: string;
  targetId: string;
  targetRole: string;
  capability: string;
  productOracleVariant: string;
  productOracleExpected: string;
  inventoryDigest: string | null;
  routeUrl?: string;
  routePath?: string;
  routeSources?: Array<{ source: string; from: string | null; depth: number }>;
}

export interface CanonicalOraclePlan {
  id: string;
  definitionId: string;
  productOracleVariant: string;
  requiredWorkItemIds: string[];
  baselinePolicy: 'not-applicable' | 'context-unless-candidate-regression-proven';
}

export interface CanonicalExecutionGraph {
  schemaVersion: 1;
  kind: 'canonical-execution-graph';
  mode: 'single-site' | 'comparative';
  subjectCoreDigest: string;
  inventory: null | { schemaVersion: 1; kind: 'route-inventory-binding'; inventoryDigest: string; origin: string; includedRouteCount: number };
  workItemPlans: CanonicalWorkItemPlan[];
  oraclePlans: CanonicalOraclePlan[];
  contextPlans: Array<CanonicalWorkItemPlan & { authority: 'non-blocking-production-baseline-context' }>;
  executionManifest: ExecutionManifest;
  coverageBasis: { selectedDefinitions: string[]; selectedTargets: string[]; excludedAsNotApplicable: string[] };
  finalSubject: FinalReleaseSubject;
  finalSubjectDigest: string;
  digest: string;
}

export function compileCanonicalExecutionGraph(input: {
  subjectCore: ReleaseSubjectCore;
  pluginRegistry: unknown;
  targetRegistry: unknown;
  inventoryCompletion?: unknown;
  deploymentIdentityRecheck: { kind: string; value: string };
}): CanonicalExecutionGraph;
export function compileSingleSiteInventoryBarrier(input: { subjectCore: ReleaseSubjectCore; pluginRegistry: unknown; targetRegistry: unknown; maxAttempts?: number }): unknown;
export function nextSingleSiteInventoryAttempt(input: { subjectCore: ReleaseSubjectCore; barrier: unknown; failedAttempt: number; sealedGraph?: CanonicalExecutionGraph | null }): unknown;
export function completeSingleSiteInventoryBarrier(input: { subjectCore: ReleaseSubjectCore; barrier: unknown; attempt: number; routeInventory: unknown; deploymentIdentityRecheck: { kind: string; value: string } }): unknown;
export function canonicalPlaywrightSelection(graph: CanonicalExecutionGraph): {
  mode: 'single-site' | 'comparative';
  caseIds: string[];
  targetIds: string[];
  executionIds: string[];
  authoritativeExecutionIds: string[];
  contextExecutionIds: string[];
};
export function parseCanonicalExecutionGraph(value: unknown): CanonicalExecutionGraph;
export function compileIncompleteWorkRekick(input: { graph: CanonicalExecutionGraph; incompleteWorkItemIds: string[] }): unknown;
