export type AuditRunMode = 'comparative' | 'single-site';
export type StoredAuditRunMode = AuditRunMode | 'comparative-legacy';
export type DeploymentRole = 'preview' | 'production';
export type AuditScopeQualifier = 'FULL' | 'TARGETED';
export type SingleSiteCertificatePolicy = 'strict' | 'preview-bypass';

export interface AuditScopeSelection {
  qualifier: AuditScopeQualifier;
  pluginIds: string[];
  auditIds: string[];
  areas: string[];
}

export interface ComparativeRunContract {
  schemaVersion: 1;
  mode: 'comparative';
  productionUrl: string;
  candidateUrl: string;
  targetIds: string[];
  scope: AuditScopeSelection;
}

export interface SingleSiteRunContract {
  schemaVersion: 1;
  mode: 'single-site';
  url: string;
  deploymentRole: DeploymentRole;
  certificatePolicy: SingleSiteCertificatePolicy;
  targetIds: string[];
  scope: AuditScopeSelection;
}

export type AuditRunContract = ComparativeRunContract | SingleSiteRunContract;
export type StoredAuditRunContract = AuditRunContract | (Record<string, unknown> & {
  mode: 'comparative-legacy';
  productionUrl: string;
  candidateUrl: string;
});

export const AUDIT_RUN_CONTRACT_SCHEMA_VERSION: 1;
export function parseRunContract(value: unknown): AuditRunContract;
export function parseStoredRunContract(value: unknown): StoredAuditRunContract;
