import type { SiteHealthInput } from './site-health.mjs';

export interface SingleSiteReportAuditInput {
  id: string;
  title: string;
  area: string;
  status: 'PASS' | 'FAIL' | 'FLAKY' | 'REVIEW' | 'BLOCKED' | 'NOT_RUN' | 'MANUAL_REQUIRED' | 'INTENDED_CHANGE';
  findingCount: number;
  evidenceStatus: 'complete' | 'incomplete';
  artifactCount: number;
  manual: boolean;
  visualStatus: 'UNCHANGED' | 'CHANGED' | 'REVIEWED' | 'absent' | 'incompatible' | 'unavailable' | 'not-applicable';
  detail: string;
}

export interface SingleSiteOutsideModeInput {
  auditId: string;
  title: string;
  reason: 'comparison-only';
}

export interface SingleSiteReportInput {
  schemaVersion: 1;
  mode: 'single-site';
  generatedAt: string;
  health: SiteHealthInput;
  audits: SingleSiteReportAuditInput[];
  outsideMode: SingleSiteOutsideModeInput[];
  pageSize?: number;
}

export interface SingleSitePageDescriptor<T = unknown> {
  total: number;
  pageSize: number;
  pageCount: number;
  pathTemplate: string;
  preview: T[];
}

export interface SingleSiteReportSummary {
  schemaVersion: 1;
  mode: 'single-site';
  publicationRevision: string;
  generatedAt: string;
  kind: 'single-site-report-summary';
  advisory: true;
  auditedUrl: string;
  deploymentRole: 'preview' | 'production';
  scope: {
    qualifier: 'FULL' | 'TARGETED';
    selected: SingleSitePageDescriptor<string>;
    omitted: SingleSitePageDescriptor<string>;
    outsideMode: SingleSitePageDescriptor<SingleSiteOutsideModeInput>;
  };
  siteHealth: { verdict: 'INCOMPLETE' | 'FINDINGS' | 'HEALTHY'; displayLabel: string; reason: string; findingCount: number };
  coverage: {
    status: 'COMPLETE' | 'GAPS' | 'UNKNOWN';
    gapCount: number;
    limitationCount: number;
    pages: Omit<SingleSitePageDescriptor, 'preview'>;
    preview: Array<{ kind: 'gap' | 'limitation'; detail: string }>;
  };
  evidenceCompletion: { status: 'complete' | 'incomplete' };
  evidenceAuthority: { status: 'authoritative' | 'non-authoritative'; reasons: string[] };
  findings: { count: number };
  manual: Record<string, unknown>;
  visualReview: Record<string, unknown>;
  lifecycle: { executionStatus: string };
  pipelineIntegrity: Record<string, unknown>;
  promotion: { authorized: false; effect: 'none'; statement: string };
  auditPages: Omit<SingleSitePageDescriptor, 'preview'>;
}

export const SINGLE_SITE_REPORT_SCHEMA_VERSION: 1;
export const DEFAULT_SINGLE_SITE_REPORT_PAGE_SIZE: 50;
export const MIN_SINGLE_SITE_REPORT_PAGE_SIZE: 10;
export const MAX_SINGLE_SITE_REPORT_PAGE_SIZE: 100;
export const MAX_SINGLE_SITE_REPORT_ITEMS: 10000;
export function buildSingleSiteReportDocuments(
  input: SingleSiteReportInput,
  publication: { publicationRevision: string },
): { summary: SingleSiteReportSummary; documents: Map<string, object> };
export function parseSingleSiteReportSummary(value: unknown): SingleSiteReportSummary;
export function expectedSingleSiteReportPaths(summary: unknown): string[];
export function parseSingleSiteReportPage(value: unknown, relativePath: string, summary: SingleSiteReportSummary): object;
