import type { ConsoleIndexRecord } from './console-index.mjs';

export function normalizedRunToConsoleIndexRecord(run: unknown, options?: { sourceId?: string }): ConsoleIndexRecord;
export function sharedPublicationToConsoleIndexRecord(input: {
  publication: unknown;
  parentRun: Record<string, unknown>;
  observedAt?: string;
  coordinator?: Record<string, unknown> | null;
}): ConsoleIndexRecord;
export function sharedParentRunToConsoleIndexRecord(input: {
  publication?: unknown | null;
  parentRun: Record<string, unknown>;
  observedAt?: string;
  coordinator?: Record<string, unknown> | null;
}): ConsoleIndexRecord;
export function timelineToConsoleIndexRecord(timeline: unknown, options: {
  sourceId: string;
  scopeKey: string;
  sourceUpdatedAt?: string | null;
  complete?: boolean;
}): ConsoleIndexRecord;
export function consoleIndexRecordToNormalizedRun(record: ConsoleIndexRecord): Readonly<Record<string, unknown>>;
export function productRiskToConsoleIndexRecord(risk: unknown, scopeKey: string, options?: {
  sourceId?: string;
  sourceRevision?: string | null;
  title?: string;
}): ConsoleIndexRecord;
export function consoleIndexRecordToProductRiskInput(record: ConsoleIndexRecord, options?: {
  now?: string | number | Date;
  hasComparablePredecessor?: boolean;
}): Readonly<Record<string, unknown>>;
