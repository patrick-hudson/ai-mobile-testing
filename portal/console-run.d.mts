export type ConsoleAuditMode = 'comparative' | 'single-site';

export interface ConsoleTimelineRecord {
  schemaVersion: 1;
  identity: string;
  mode: ConsoleAuditMode;
  runId: string;
  kind: 'stage' | 'shard' | 'attempt' | 'retry' | 'event' | 'publication' | 'deadline';
  stageId: string | null;
  shardId: string | null;
  attempt: number | null;
  retry: number | null;
  sequence: number | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  sourceRevision: string | null;
}

export interface ConsoleTimelinePage {
  schemaVersion: 1;
  items: readonly ConsoleTimelineRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  omittedRecords: number;
  binding: string;
}

export const CONSOLE_TIMELINE_MAX_PAGE_SIZE: 100;
export function projectComparativeTimeline(runId: string, document: unknown, options?: { sourceRevision?: string | null }): ConsoleTimelineRecord[];
export function projectSingleSiteTimeline(runId: string, document: unknown, options?: { sourceRevision?: string | null }): ConsoleTimelineRecord[];
export function buildConsoleTimelinePage(records: readonly unknown[], options?: { limit?: number; cursor?: string | null; binding?: string }): ConsoleTimelinePage;
export function buildConsoleRunSummary(run: unknown, options?: { limitations?: readonly string[] }): Readonly<Record<string, unknown>>;
