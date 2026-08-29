export type AuditMode = 'single-site' | 'comparative';
export type AuthorityQualifier = 'FULL' | 'TARGETED';
export interface CertifiedScope {
  features: string[];
  definitions: string[];
  targets: string[];
  knownLimits: string[];
}
export interface ReleaseAuthority { qualifier: AuthorityQualifier; scope: CertifiedScope }
export interface ReleaseSubjectCore {
  schemaVersion: 1;
  kind: 'release-subject-core';
  deploymentIdentity: { kind: string; value: string };
  targets: Array<{ role: string; origin: string }>;
  mode: AuditMode;
  requestedAuthority: ReleaseAuthority;
  revisions: { runner: string; plugins: string; targets: string; configuration: string };
  environmentIdentity: string;
  certificatePolicy: string;
  digest: string;
}
export interface FinalReleaseSubject {
  schemaVersion: 1;
  kind: 'final-release-subject';
  subjectCoreDigest: string;
  executionManifestDigest: string;
  mode: AuditMode;
  deploymentIdentity: { kind: string; value: string };
  targets: Array<{ role: string; origin: string }>;
  grantedAuthority: ReleaseAuthority;
  coverageBasis: { selectedDefinitions: string[]; selectedTargets: string[]; excludedAsNotApplicable: string[] };
  digest: string;
}
export const AUDIT_MODES: readonly AuditMode[];
export const AUTHORITY_QUALIFIERS: readonly AuthorityQualifier[];
export function parseCertifiedScope(value: unknown): CertifiedScope;
export function parseAuthority(value: unknown, label?: string): ReleaseAuthority;
export function parseCoverageBasis(value: unknown): { selectedDefinitions: string[]; selectedTargets: string[]; excludedAsNotApplicable: string[] };
export function sealReleaseSubjectCore(value: unknown): ReleaseSubjectCore;
export function parseReleaseSubjectCore(value: unknown): ReleaseSubjectCore;
export function sealFinalReleaseSubject(value: unknown): FinalReleaseSubject;
export function parseFinalReleaseSubject(value: unknown): FinalReleaseSubject;
