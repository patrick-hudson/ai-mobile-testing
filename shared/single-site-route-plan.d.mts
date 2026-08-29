import type { LiveRouteInventoryDiagnostic } from './live-route-inventory.mjs';
import type { DefinitionCoverageManifest, CompilerPluginRegistry } from './run-compiler.mjs';

export interface SingleSiteRouteInventoryPlan {
  schemaVersion: 1;
  kind: 'single-site-route-inventory-plan';
  coverageManifestDigest: string;
  required: boolean;
  reason: string;
  reviewedRoutes: Array<{ auditId: string; path: string }>;
  entryPoints: string[];
  canonicalTargetId: string | null;
  planDigest: string;
}

export interface SingleSiteGenericRouteExecution {
  executionId: string;
  caseId: string;
  auditId: 'ENV-002';
  targetId: string;
  url: string;
  path: string;
  sources: Array<{ source: string; from: string | null; depth: number }>;
  productOracleVariant: 'generic-page-inspection-v1';
}

export interface SingleSiteRouteInventoryPublication {
  schemaVersion: 1;
  kind: 'single-site-route-inventory-publication';
  mode: 'single-site';
  jobId: string;
  attemptId: string;
  coverageManifestDigest: string;
  routePlanDigest: string;
  inventoryDigest: string;
  diagnostic: LiveRouteInventoryDiagnostic;
  reviewedFindings: Array<Record<string, unknown>>;
  genericExecutions: SingleSiteGenericRouteExecution[];
  coverageGaps: Array<Record<string, unknown>>;
  limitations: Array<Record<string, unknown>>;
  publicationDigest: string;
}

export interface SharedGenericRouteExecutionPublication {
  schemaVersion: 1;
  kind: 'shared-generic-route-execution-publication';
  mode: 'single-site';
  workItemId: string;
  subjectCoreDigest: string;
  executionDescriptorDigest: string;
  inventoryDigest: string;
  genericExecutions: [SingleSiteGenericRouteExecution];
  publicationDigest: string;
}

export const SINGLE_SITE_ROUTE_PLAN_SCHEMA_VERSION: 1;
export const GENERIC_ROUTE_AUDIT_ID: 'ENV-002';
export const GENERIC_ROUTE_ORACLE_REVISION: 'generic-page-inspection-v1';
export const SHARED_GENERIC_ROUTE_PUBLICATION_KIND: 'shared-generic-route-execution-publication';
export function sealSharedGenericRouteExecutionPublication(descriptor: import('./work-execution-descriptor.mjs').WorkExecutionDescriptor): SharedGenericRouteExecutionPublication;
export function verifySharedGenericRouteExecutionPublication(value: unknown, expected?: { executionDescriptorDigest?: string; publicationDigest?: string }): value is SharedGenericRouteExecutionPublication;
export function compileSingleSiteRouteInventoryPlan(input: {
  pluginRegistry: CompilerPluginRegistry;
  coverageManifest: DefinitionCoverageManifest;
}): SingleSiteRouteInventoryPlan;
export function verifySingleSiteRouteInventoryPlan(value: unknown): value is SingleSiteRouteInventoryPlan;
export function reconcileSingleSiteRouteInventory(input: {
  jobId: string;
  attemptId: string;
  coverageManifestDigest: string;
  plan: SingleSiteRouteInventoryPlan;
  diagnostic: LiveRouteInventoryDiagnostic;
}): SingleSiteRouteInventoryPublication;
export function verifySingleSiteRouteInventoryPublication(
  value: unknown,
  expected?: { jobId?: string; attemptId?: string; coverageManifestDigest?: string; routePlanDigest?: string },
): value is SingleSiteRouteInventoryPublication;
