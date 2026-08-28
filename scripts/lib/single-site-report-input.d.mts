import type { JobEnvelope } from './job-queue.mjs';
import type { SingleSiteReportInput } from './site-health-report.mjs';

export interface SingleSiteWorkerResultInput {
  schemaVersion: 1;
  kind: 'single-site-worker-result';
  jobId: string;
  attemptId: string;
  attemptNumber: number;
  fencingToken: number;
  classification: 'success' | 'assertion-failure' | 'infrastructure-failure' | 'failed' | 'incomplete';
  freshEvidence: null | {
    fresh: boolean;
    reason: string | null;
    relativePath: string;
    bytes: number;
    digest: string | null;
  };
  [key: string]: unknown;
}

export interface BuildSingleSiteReportInputOptions {
  workerInput: Record<string, unknown>;
  terminalState: JobEnvelope;
  workerResult?: SingleSiteWorkerResultInput | null;
  /** Parsed JSON document corresponding exactly to playwrightResultsBytes. */
  playwrightResults?: unknown;
  /** Raw results.json bytes, required to bind the parsed document to the worker digest. */
  playwrightResultsBytes?: string | Uint8Array | null;
  /** Parsed processed copy produced by a digest-bound media stage. */
  processedPlaywrightResults?: unknown;
  /** Raw bytes for processedPlaywrightResults. */
  processedPlaywrightResultsBytes?: string | Uint8Array | null;
  /** Immutable media-stage manifest binding sealed input and processed output. */
  mediaStage?: Record<string, unknown> | null;
  /** Current attempt's immutable, queue-bound live route inventory publication. */
  routeInventoryPublication?: Record<string, unknown> | null;
  generatedAt: string;
  pageSize?: number;
}

export const MAX_SINGLE_SITE_PLAYWRIGHT_RESULTS_BYTES: number;
export const MAX_SINGLE_SITE_REPORT_EXECUTIONS: number;
export function buildSingleSiteReportInput(options: BuildSingleSiteReportInputOptions): SingleSiteReportInput;
