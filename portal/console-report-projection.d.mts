import type { ConsoleIndexRecord, ConsoleIndexMode } from './console-index.mjs';
import type { ReportPublication } from './report-publication.mjs';

export const CONSOLE_REPORT_PROJECTION_SCHEMA_VERSION: 1;
export const CONSOLE_REPORT_PROJECTION_LIMITS: Readonly<{
  maximumBatchRecords: 100;
  maximumDocumentsPerBatch: 4;
  maximumSourceBytesPerBatch: number;
  maximumDocumentBytes: number;
  maximumProjectedRecordsPerDocument: 2_000;
  maximumMetricsPerPublication: 6;
}>;

export interface ReportProjectionIdentity {
  mode: ConsoleIndexMode;
  runId: string;
}

export interface ReportProjectionCheckpoint {
  schemaVersion: 1;
  mode: ConsoleIndexMode;
  runId: string;
  scopeKey: string;
  publicationRevision: string;
  publicationDigest: string;
  documentIndex: number;
  recordOffset: number;
  incomplete: boolean;
}

export interface ReportProjectionWork {
  sourceFilesRead: number;
  sourceBytesRead: number;
  documentsVisited: number;
  recordsProjected: number;
  budgetExhausted: boolean;
}

export interface ReportProjectionBatch {
  schemaVersion: 1;
  identity: Readonly<ReportProjectionIdentity>;
  sourceId: string;
  sourceRevision: string;
  sourceUpdatedAt: string;
  generation: Readonly<{
    key: string;
    publicationDigest: string;
    /** Atomically evict the prior report-publication generation before applying this batch. */
    resetPreviousGeneration: boolean;
    /** Stable across replay of the same checkpoint, making at-least-once application duplicate-safe. */
    batchId: string;
  }>;
  records: readonly Readonly<ConsoleIndexRecord>[];
  checkpoint: Readonly<ReportProjectionCheckpoint> | null;
  cursor: string | null;
  done: boolean;
  complete: boolean;
  limitations: readonly string[];
  work: Readonly<ReportProjectionWork>;
}

export interface ReportProjectionBatchInput {
  /** Must come from loadComparativeReportPublication/loadSingleSiteReportPublication. */
  publication: ReportPublication;
  identity: ReportProjectionIdentity;
  /** The owning run index supplies this; the projector hashes non-indexed scope keys. */
  scopeKey: string;
  cursor?: string | null;
}

export interface ReportProjectionBatchOptions {
  limit?: number;
  maximumDocuments?: number;
  maximumSourceBytes?: number;
  maximumDocumentBytes?: number;
}

export interface PublishedReportDocumentProjectionInput {
  publication: ReportPublication;
  identity: ReportProjectionIdentity;
  scopeKey: string;
  relativePath: string;
  document: unknown;
  /** Required for a Single-site page; use parseSingleSiteReportSummary on the pinned summary. */
  singleSiteSummary?: unknown;
}

export interface PublishedReportDocumentProjection {
  schemaVersion: 1;
  records: readonly Readonly<ConsoleIndexRecord>[];
  limitations: readonly string[];
  complete: boolean;
}

export function encodeReportProjectionCheckpoint(value: ReportProjectionCheckpoint): string;
export function decodeReportProjectionCheckpoint(value: string): Readonly<ReportProjectionCheckpoint>;
export function reportArtifactDestination(
  mode: ConsoleIndexMode,
  runId: string,
  href: string,
): string | null;
export function projectPublishedReportDocument(
  input: PublishedReportDocumentProjectionInput,
): Readonly<PublishedReportDocumentProjection>;
export function projectReportPublicationBatch(
  input: ReportProjectionBatchInput,
  options?: ReportProjectionBatchOptions,
): Promise<Readonly<ReportProjectionBatch>>;
