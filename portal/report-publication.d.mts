export interface ReportPublicationFileRecord {
  bytes: number;
  sha256: string;
}

export interface ReportPublication {
  runDirectory: string;
  dataDirectory: string;
  revisionDirectory: string;
  publicationRevision: string;
  generatedAt: string;
  mode: 'single-site' | 'comparative-legacy';
  kind: string;
  files: Record<string, ReportPublicationFileRecord>;
  publicationDigest: string;
}

export interface ReportPublicationReadOptions {
  maximumPointerBytes?: number;
  maximumSummaryBytes?: number;
  maximumAuditIndexBytes?: number;
  maximumAuditDetailBytes?: number;
  maximumPageBytes?: number;
}
export function loadSharedReleasePublication(
  storeRoot: string,
  runId: string,
  options?: { filesystem?: typeof import('node:fs/promises'); verifyStorage?: boolean },
): Promise<import('../shared/publication-envelope.mjs').PublicationEnvelope>;

export function loadReportPublication(
  runDirectory: string,
  requestedRevision?: string | null,
  options?: ReportPublicationReadOptions,
): Promise<ReportPublication>;
export function loadComparativeReportPublication(
  runDirectory: string,
  requestedRevision?: string | null,
  options?: ReportPublicationReadOptions,
): Promise<ReportPublication & { mode: 'comparative-legacy' }>;
export function loadSingleSiteReportPublication(
  runDirectory: string,
  requestedRevision?: string | null,
  options?: ReportPublicationReadOptions,
): Promise<ReportPublication & { mode: 'single-site' }>;
export function readPublishedReportFile(
  publication: ReportPublication,
  relativePath: string,
  maximumBytes: number,
): Promise<{ buffer: Buffer; bytes: number; mtimeMs: number; sha256: string; path: string }>;
export function readPublishedReportJson(
  publication: ReportPublication,
  relativePath: string,
  maximumBytes: number,
): Promise<{ document: any; buffer: Buffer; bytes: number; mtimeMs: number; sha256: string; path: string }>;
export function validateCompleteReportPublication(
  runDirectory: string,
  options?: ReportPublicationReadOptions,
): Promise<{ problems: string[]; publication: ReportPublication | null; summary: any; audits: any }>;
