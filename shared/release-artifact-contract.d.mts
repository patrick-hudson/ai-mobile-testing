export interface ReleaseArtifactFile {
  relativePath: string;
  size: number;
  digest: string;
}
export interface ReleaseArtifactManifest {
  schemaVersion: 1;
  kind: 'release-artifact-manifest';
  files: ReleaseArtifactFile[];
  fileCount: number;
  totalBytes: number;
  digest: string;
}
export interface AuditedCandidateDeployment {
  schemaVersion: 1;
  kind: 'audited-candidate-deployment';
  provider: 'cloudflare-pages';
  accountId: string;
  projectName: string;
  deploymentId: string;
  deploymentUrl: string;
  auditedOrigin: string;
  artifactManifestDigest: string;
  sourceRevision: string;
  createdAt: string;
  digest: string;
}
export function sealReleaseArtifactManifest(value: { schemaVersion: 1; files: ReleaseArtifactFile[] }): ReleaseArtifactManifest;
export function parseReleaseArtifactManifest(value: unknown): ReleaseArtifactManifest;
export function sealAuditedCandidateDeployment(value: Omit<AuditedCandidateDeployment, 'kind' | 'digest'>): AuditedCandidateDeployment;
export function parseAuditedCandidateDeployment(value: unknown): AuditedCandidateDeployment;
