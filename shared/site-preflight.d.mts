import type { OriginBoundFetchOptions, OutboundHopEvidence } from './outbound-url-policy.mjs';

export type SiteDeploymentRole = 'preview' | 'production';
export type SiteCertificatePolicy = 'strict' | 'preview-bypass';

export interface SitePreflightInput {
  url: string;
  deploymentRole: SiteDeploymentRole;
  certificatePolicy?: SiteCertificatePolicy;
}

export interface SitePreflightMarkerEvidence {
  id: string;
  probe: 'root' | 'manifest' | 'sentinel';
  expected: string;
  observed: string | null;
  passed: boolean;
}

export interface SitePreflightProbeEvidence {
  id: 'root' | 'manifest' | 'sentinel';
  requestedUrl: string;
  finalUrl: string | null;
  statusCode: number | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  hops: readonly OutboundHopEvidence[];
  error: Readonly<{ code: string; message: string; details: Readonly<Record<string, unknown>> }> | null;
}

export interface DeploymentRevisionEvidence {
  status: 'verified' | 'unavailable';
  source: 'explicit-build-id' | 'asset-manifest-validators' | null;
  fingerprint: string | null;
  signals: readonly Readonly<Record<string, unknown>>[];
  limitation: string | null;
}

export interface SitePreflightIssue {
  code: string;
  message: string;
  focusTarget: 'url' | 'deploymentRole';
  details: Readonly<Record<string, unknown>>;
}

export interface SitePreflightResult {
  schemaVersion: 1;
  accepted: boolean;
  checkedAt: string;
  origin: string | null;
  deploymentRole: SiteDeploymentRole | null;
  certificatePolicy: SiteCertificatePolicy;
  identityFingerprint: string | null;
  deploymentRevision: DeploymentRevisionEvidence;
  evidenceAuthority: Readonly<{
    status: 'authoritative' | 'non-authoritative';
    reasons: readonly string[];
  }>;
  markers: readonly SitePreflightMarkerEvidence[];
  probes: readonly SitePreflightProbeEvidence[];
  issues: readonly SitePreflightIssue[];
  preflightDigest: string | null;
}

export interface SitePreflightOptions extends Omit<OriginBoundFetchOptions, 'origin' | 'deploymentRole' | 'certificatePolicy'> {
  now?: () => Date;
}

export const SITE_PREFLIGHT_SCHEMA_VERSION: 1;
export const QUITTING7OH_IDENTITY_CONTRACT_REVISION: 'quitting7oh-identity-v1';
export const QUITTING7OH_SENTINEL_PATH: '/start-here/welcome';
export function preflightQuitting7ohSite(input: SitePreflightInput, options?: SitePreflightOptions): Promise<SitePreflightResult>;
export const previewSitePreflight: typeof preflightQuitting7ohSite;
