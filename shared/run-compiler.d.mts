import type { SingleSiteRunContract } from './run-contract.mjs';

export interface DeploymentRevisionBinding {
  status: 'identified' | 'unavailable';
  value: string | null;
}

export interface CompilerPreflightBinding {
  schemaVersion: 1;
  url: string;
  deploymentRole: 'preview' | 'production';
  identityFingerprint: string;
  deploymentRevision: DeploymentRevisionBinding;
  evidenceAuthority: {
    status: 'authoritative' | 'non-authoritative';
    reasons: string[];
  };
}

export interface CompilerAuditDefinition {
  id: string;
  area: string;
  title: string;
  severity: string;
  expected: string;
  manual?: boolean;
  singleSiteClassification: 'standalone-compatible' | 'comparison-only' | 'standalone-required';
  standaloneOracle?: { id: string; expected: string };
  [key: string]: unknown;
}

export interface CompilerAuditCase {
  caseId: string;
  auditId: string;
  entrySpec: string;
  applicability: string;
  supportedProjects: string[];
  supportedModes: Array<'comparative' | 'single-site'>;
  oracleVariants: { comparative?: string; singleSite?: string };
}

export interface CompilerPluginRegistry {
  schemaVersion: 1;
  plugins: Array<{
    id: string;
    auditDefinitions: CompilerAuditDefinition[];
    auditCases: CompilerAuditCase[];
    [key: string]: unknown;
  }>;
}

export interface CompilerSingleSiteTarget {
  id: string;
  sourceComparativeTargetId: string;
  browserLabel: string;
  deviceClass: string;
  engine: string;
  browserProduct: string;
  deviceDescriptor: string;
  fidelity: string;
  visual: boolean;
  fullSweep: boolean;
  [key: string]: unknown;
}

export interface CompilerTargetRegistry {
  schemaVersion: 1;
  singleSiteFullProfileTargetIds: string[];
  singleSiteTargets: CompilerSingleSiteTarget[];
  [key: string]: unknown;
}

export interface DefinitionCoverageManifest {
  schemaVersion: 1;
  kind: 'definition-coverage-manifest';
  mode: 'single-site';
  deployment: {
    url: string;
    deploymentRole: 'preview' | 'production';
    certificatePolicy: 'strict' | 'preview-bypass';
    identityFingerprint: string;
    revision: DeploymentRevisionBinding;
    evidenceAuthority: CompilerPreflightBinding['evidenceAuthority'];
  };
  revisions: { runContract: string; pluginRegistry: string; targetRegistry: string; runner: string };
  scope: {
    requestedQualifier: 'FULL' | 'TARGETED';
    qualifier: 'FULL' | 'TARGETED';
    filters: { pluginIds: string[]; auditIds: string[]; areas: string[] };
    selectedTargetIds: string[];
    requiredFullProfileTargetIds: string[];
    allEligibleDefinitionsSelected: boolean;
    allEligibleCasesSelected: boolean;
    allRequiredTargetsSelected: boolean;
  };
  coverageStatus: 'COMPLETE' | 'GAPS';
  selectedTargets: Array<Record<string, unknown>>;
  selectedDefinitions: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
  coverageGaps: Array<Record<string, unknown>>;
  omissions: {
    definitions: Array<Record<string, unknown>>;
    cases: Array<Record<string, unknown>>;
    targets: Array<Record<string, unknown>>;
  };
  outsideMode: Array<Record<string, unknown>>;
  counts: Record<string, number>;
  manifestDigest: string;
}

export interface CompileDefinitionCoverageManifestInput {
  runContract: SingleSiteRunContract;
  pluginRegistry: CompilerPluginRegistry;
  targetRegistry: CompilerTargetRegistry;
  preflightBinding: CompilerPreflightBinding;
  runnerRevision: string;
}

export const DEFINITION_COVERAGE_MANIFEST_SCHEMA_VERSION: 1;
export function canonicalJson(value: unknown): string;
export function canonicalSha256(value: unknown): string;
export function compileDefinitionCoverageManifest(
  input: CompileDefinitionCoverageManifestInput,
): DefinitionCoverageManifest;
export function verifyDefinitionCoverageManifest(manifest: unknown): manifest is DefinitionCoverageManifest;
