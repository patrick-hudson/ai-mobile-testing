export type SiteHealthVerdict = 'INCOMPLETE' | 'FINDINGS' | 'HEALTHY';
export type CoverageStatus = 'COMPLETE' | 'GAPS' | 'UNKNOWN';

export interface SiteHealthInput {
  schemaVersion: 1;
  mode: 'single-site';
  url: string;
  deploymentRole: 'preview' | 'production';
  scope: { qualifier: 'FULL' | 'TARGETED'; selectedCoverage: string[]; omittedCoverage: string[] };
  coverage: { finalized: boolean; manifestIntegrity: boolean; gaps: string[]; limitations: string[] };
  pipeline: {
    executionStatus: 'queued' | 'starting' | 'running' | 'finalizing' | 'completed' | 'failed' | 'incomplete' | 'cancelled';
    integrityComplete: boolean;
    requiredEvidenceComplete: boolean;
    reason?: string | null;
    cancellationReason?: string | null;
  };
  evidenceAuthority: { status: 'authoritative' | 'non-authoritative'; reasons: string[] };
  findings: Array<{ id: string; severity: 'P0' | 'P1' | 'P2' | 'P3'; [key: string]: unknown }>;
  manual: { required: number; complete: number; failedOrBlocked: number };
  visualReview?: { items: Array<{ status: 'UNCHANGED' | 'CHANGED' | 'REVIEWED' | 'absent' | 'incompatible' | 'unavailable' }> };
}

export interface SiteHealthTruth {
  schemaVersion: 1;
  kind: 'single-site-health';
  mode: 'single-site';
  advisory: true;
  auditedUrl: string;
  deploymentRole: 'preview' | 'production';
  scope: SiteHealthInput['scope'];
  siteHealth: { verdict: SiteHealthVerdict; displayLabel: string; reason: string; findingCount: number };
  coverage: { status: CoverageStatus; gapCount: number; limitationCount: number; gaps: string[]; limitations: string[] };
  evidenceCompletion: { status: 'complete' | 'incomplete' };
  evidenceAuthority: SiteHealthInput['evidenceAuthority'];
  pipelineIntegrity: { status: 'complete' | 'incomplete'; executionStatus: SiteHealthInput['pipeline']['executionStatus']; reason: string | null; cancellationReason: string | null };
  manual: SiteHealthInput['manual'] & { outstanding: number; status: 'NOT_REQUIRED' | 'OUTSTANDING' | 'FAILED_OR_BLOCKED' | 'COMPLETE' };
  visualReview: { total: number; attentionRequired: number; byStatus: Record<string, number> };
  promotion: { authorized: false; effect: 'none'; statement: string };
}

export const SITE_HEALTH_SCHEMA_VERSION: 1;
export function parseSiteHealthInput(input: unknown): SiteHealthInput;
export function deriveSiteHealth(input: SiteHealthInput): SiteHealthTruth;
