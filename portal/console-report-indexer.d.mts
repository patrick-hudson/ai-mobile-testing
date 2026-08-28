import type {
  ConsoleIndex,
  ConsoleIndexReplacementToken,
} from './console-index.mjs';
import type {
  ReportProjectionBatchOptions,
  ReportProjectionIdentity,
} from './console-report-projection.mjs';
import type { ReportPublication } from './report-publication.mjs';

export interface ConsoleReportProjectionTask {
  schemaVersion: 1;
  index: ConsoleIndex;
  publication: ReportPublication;
  identity: Readonly<ReportProjectionIdentity>;
  scopeKey: string;
  token: Readonly<ConsoleIndexReplacementToken> | null;
  cursor: string | null;
  limitations: Set<string>;
  status: 'pending' | 'committed' | 'rejected' | 'cancelled' | 'failed';
  reason: string | null;
  batches: number;
  recordsProjected: number;
  removedRecords?: number;
  complete: boolean;
}

export function createConsoleReportProjectionTask(input: {
  index: ConsoleIndex;
  publication: ReportPublication;
  identity: ReportProjectionIdentity;
  scopeKey: string;
  maximumRecords?: number;
}): ConsoleReportProjectionTask;

export function runConsoleReportProjectionTaskSlice(
  task: ConsoleReportProjectionTask,
  options?: ReportProjectionBatchOptions & { signal?: AbortSignal },
): Promise<ConsoleReportProjectionTask>;

export function cancelConsoleReportProjectionTask(task: ConsoleReportProjectionTask): boolean;
