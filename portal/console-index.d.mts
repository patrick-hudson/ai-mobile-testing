import type {
  ConsoleBoundedPage,
  ConsoleBoundedSnapshot,
  ConsoleReadBudget,
  ConsoleReadWork,
  ConsoleRunIdentity,
  ConsoleSourceVector,
} from './console-read-ports.mjs';

export const CONSOLE_INDEX_SCHEMA_VERSION: 1;
export const CONSOLE_INDEX_MAX_PAGE_SIZE: 100;
export const CONSOLE_INDEX_MAX_REPLACEMENT_BATCH_RECORDS: 100;
export const CONSOLE_INDEX_MAX_REPLACEMENT_RECORDS: 10_000;
export const CONSOLE_INDEX_ORDERINGS: readonly [
  'index', 'attention', 'recent', 'newest', 'capture-time', 'oldest',
  'duration', 'suite', 'risk', 'sequence', 'source',
];
export const DEFAULT_CONSOLE_INDEX_BUDGET: Readonly<ConsoleReadBudget>;
export const CONSOLE_INDEX_RECORD_TYPES: readonly ConsoleIndexRecordType[];
export const CONSOLE_INDEX_FIELD_NAMES: readonly ConsoleIndexFieldName[];

export type ConsoleIndexMode = 'comparative' | 'single-site';
export type ConsoleIndexRecordType =
  | 'run'
  | 'risk'
  | 'trust'
  | 'attention'
  | 'evidence'
  | 'metric'
  | 'timeline'
  | 'provenance';

export type ConsoleIndexFieldName =
  | 'title' | 'subtitle' | 'detail' | 'status' | 'phase' | 'outcome' | 'authority'
  | 'qualifier' | 'profile' | 'productionOrigin' | 'candidateOrigin' | 'auditedOrigin'
  | 'deploymentRole' | 'certificatePolicy' | 'targetSetKey' | 'scopeLabel'
  | 'createdAt' | 'startedAt' | 'finishedAt' | 'updatedAt' | 'sourceKind' | 'sourceTimestamp'
  | 'sourceRecordId' | 'sourceRecordType' | 'publicationRevision' | 'finalizationRevision'
  | 'severity' | 'blocking' | 'attentionKind' | 'novelty' | 'affectedScope' | 'unresolvedAt'
  | 'auditId' | 'evidenceId' | 'targetId' | 'stageId' | 'shardId'
  | 'executionState' | 'activityState' | 'finalizationStatus' | 'coverageStatus'
  | 'evidenceCompletionStatus' | 'evidenceAuthorityStatus' | 'pipelineIntegrityStatus'
  | 'manualStatus' | 'visualStatus' | 'mediaQualityState'
  | 'progressTotal' | 'progressCompleted' | 'progressPassed' | 'progressFailed'
  | 'progressFlaky' | 'progressSkipped' | 'findingCount' | 'blockingFailures'
  | 'blockingIncomplete' | 'baselineIssues' | 'manualRequired' | 'manualComplete'
  | 'manualOutstanding' | 'manualFailedOrBlocked' | 'visualTotal' | 'visualAttentionRequired'
  | 'attemptNumber' | 'retryNumber' | 'durationMs' | 'sequence' | 'terminal'
  | 'publicationBlocked' | 'deadlineExceeded' | 'targetIds' | 'pluginIds' | 'auditIds'
  | 'areas' | 'reasonCodes' | 'destinations' | 'limitations';

export type ConsoleIndexFieldScalar = string | number | boolean | null;

/**
 * A flattened, display-neutral record. Arbitrary nested payloads are intentionally
 * unsupported so credentials, commands, paths, logs, eligibility, and unchecked
 * evidence cannot enter the disposable global index.
 */
export interface ConsoleIndexRecord {
  schemaVersion: 1;
  mode: ConsoleIndexMode;
  runId: string;
  recordId: string;
  recordType: ConsoleIndexRecordType;
  scopeKey: string;
  sourceId: string;
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
  complete: boolean;
  /** Ascending stable sort tuple precomputed by the owning pure projection. */
  sortKey: string;
  fields: Readonly<Partial<Record<ConsoleIndexFieldName, ConsoleIndexFieldScalar | readonly ConsoleIndexFieldScalar[]>>>;
}

export interface ConsoleIndexCommitToken extends ConsoleRunIdentity {
  schemaVersion: 1;
  generation: number;
  sourceId: string;
  sourceRevision: string | null;
  watermarkRevision: string | null;
}

export interface ConsoleIndexPurgeToken extends ConsoleRunIdentity {
  schemaVersion: 1;
  generation: number;
  sourceId: string;
  sourceRevision: string | null;
  updatedAt: string;
  status: 'pending' | 'committed';
}

export interface ConsoleIndexReplacementToken extends ConsoleRunIdentity {
  schemaVersion: 1;
  generation: number;
  sourceId: string;
  sourceRevision: string | null;
  sourceUpdatedAt: string;
  maximumRecords: number;
}

export interface ConsoleIndexBackfillState {
  schemaVersion: 1;
  sourceId: string;
  revision: string | null;
  updatedAt: string | null;
  cursor: string | null;
  complete: boolean;
  limitation: 'source-unavailable' | 'source-malformed' | 'source-stale' | 'budget-exhausted'
    | 'incomplete-publication' | 'purged' | 'permission-denied' | 'unsupported' | null;
  budget: Readonly<ConsoleReadBudget>;
  work: Readonly<ConsoleReadWork>;
}

export interface ConsoleIndexCursor {
  schemaVersion: 1;
  mode: ConsoleIndexMode;
  scopeKey: string;
  normalizedFilterKey: string;
  vectorRevision: string;
  indexRevision: string;
  lastKey: string;
}

export interface ConsoleIndexPageRequest {
  mode: ConsoleIndexMode;
  scopeKey: string;
  normalizedFilterKey: string;
  cursor: string | null;
  limit: number;
  recordTypes: readonly ConsoleIndexRecordType[];
  runId?: string;
  orderBy?: 'index' | 'attention' | 'recent' | 'newest' | 'capture-time' | 'oldest'
    | 'duration' | 'suite' | 'risk' | 'sequence' | 'source';
}

export class ConsoleIndexError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, message: string, statusCode?: number);
}

export function createConsoleReadBudget(overrides?: Partial<ConsoleReadBudget>): Readonly<ConsoleReadBudget>;
export function createConsoleReadWork(value?: Partial<ConsoleReadWork>): Readonly<ConsoleReadWork>;
export function consumeConsoleReadWork(
  work: ConsoleReadWork,
  budget: ConsoleReadBudget,
  delta: Partial<Omit<ConsoleReadWork, 'budgetExhausted'>>,
): Readonly<{ accepted: boolean; work: Readonly<ConsoleReadWork> }>;
export function encodeConsoleIndexCursor(value: ConsoleIndexCursor): string;
export function decodeConsoleIndexCursor(value: string): Readonly<ConsoleIndexCursor>;
export function consoleIndexOrderKey(record: ConsoleIndexRecord, ordering?: ConsoleIndexPageRequest['orderBy']): string;

export interface ConsoleIndex {
  upsert(record: ConsoleIndexRecord, options?: { sourceComplete?: boolean; authorityRank?: number }): Readonly<{
    committed: boolean;
    reason: 'purged' | 'lower-authority' | null;
    record?: Readonly<ConsoleIndexRecord>;
  }>;
  /** Capture this before asynchronous authority work and pass it to commitAsync after the await. */
  capture(identity: ConsoleRunIdentity, sourceId: string, sourceRevision?: string | null): ConsoleIndexCommitToken;
  commitAsync(token: ConsoleIndexCommitToken, record: ConsoleIndexRecord, options?: { sourceComplete?: boolean }): Readonly<{
    committed: boolean;
    reason: 'stale-capture' | 'purged' | null;
    record?: Readonly<ConsoleIndexRecord>;
  }>;
  /** Explicit aggregate watermark; report record publication revisions never mutate it implicitly. */
  setSourceWatermark(sourceId: string, value: {
    revision: string | null;
    updatedAt: string | null;
    complete: boolean;
    limitation: ConsoleIndexBackfillState['limitation'];
  }): Readonly<{
    sourceId: string;
    revision: string | null;
    updatedAt: string | null;
    complete: boolean;
    limitation: ConsoleIndexBackfillState['limitation'];
  }>;
  beginReplacement(identity: ConsoleRunIdentity, options: {
    sourceId: string;
    sourceRevision: string | null;
    sourceUpdatedAt: string;
    maximumRecords: number;
  }): Readonly<{
    accepted: boolean;
    reason: 'purged' | null;
    token: Readonly<ConsoleIndexReplacementToken> | null;
  }>;
  stageReplacement(token: ConsoleIndexReplacementToken, records: readonly ConsoleIndexRecord[]): Readonly<{
    accepted: boolean;
    reason: 'stale-capture' | null;
    stagedRecords: number;
  }>;
  commitReplacement(token: ConsoleIndexReplacementToken, options: { complete: true }): Readonly<{
    committed: boolean;
    reason: 'stale-capture' | null;
    removed?: number;
    records: readonly Readonly<ConsoleIndexRecord>[];
  }>;
  abortReplacement(token: ConsoleIndexReplacementToken): boolean;
  /** O(1) lifecycle invalidation for one record ID; defaults to the run record. */
  invalidate(identity: ConsoleRunIdentity, recordId?: string): boolean;
  beginBackfill(sourceId: string, options?: {
    revision?: string | null;
    updatedAt?: string | null;
    cursor?: string | null;
    budget?: ConsoleReadBudget;
  }): ConsoleIndexBackfillState;
  updateBackfill(sourceId: string, value: {
    revision: string | null;
    updatedAt: string | null;
    cursor: string | null;
    complete: boolean;
    limitation: ConsoleIndexBackfillState['limitation'];
    work: ConsoleReadWork;
  }): ConsoleIndexBackfillState;
  backfillState(sourceId: string): ConsoleIndexBackfillState | null;
  sourceVector(): ConsoleSourceVector;
  read(identity: ConsoleRunIdentity, recordId?: string): ConsoleBoundedSnapshot<ConsoleIndexRecord>;
  /** Reads only the in-memory index; source file and source byte work are always zero. */
  page(request: ConsoleIndexPageRequest): ConsoleBoundedPage<ConsoleIndexRecord>;
  /** Installs the destructive cache barrier and evicts every record for the run immediately. */
  beginPurge(identity: ConsoleRunIdentity, options?: {
    sourceId?: string;
    sourceRevision?: string | null;
    updatedAt?: string;
  }): ConsoleIndexPurgeToken;
  /** Must complete before the successful destructive HTTP response is sent. */
  commitPurge(token: ConsoleIndexPurgeToken, options?: {
    sourceRevision?: string | null;
    updatedAt?: string;
  }): ConsoleIndexPurgeToken;
  /** May be called only with a fresh, bounded authoritative reread after a pre-quarantine failure. */
  abortPurge(token: ConsoleIndexPurgeToken, records: readonly ConsoleIndexRecord[], options?: {
    sourceComplete?: boolean;
  }): Readonly<{ restored: true; records: readonly Readonly<ConsoleIndexRecord>[] }>;
  diagnostics(): Readonly<{
    schemaVersion: 1;
    indexRevision: string;
    records: number;
    recordsByMode: Readonly<Record<ConsoleIndexMode, number>>;
    sources: number;
    incompleteSources: number;
    backfills: number;
    pendingPurges: number;
    tombstones: number;
    replacements: number;
    cacheEntries: number;
    pageSorts: number;
    lastPageRecordsExamined: number;
  }>;
  /** Disposes all derived state. It never touches authority stores. */
  clear(): void;
}

export function createConsoleIndex(options?: {
  clock?: () => number | Date;
  sources?: readonly {
    sourceId: string;
    revision: string | null;
    updatedAt: string | null;
    complete: boolean;
  }[];
}): ConsoleIndex;
