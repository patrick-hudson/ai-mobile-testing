import type {
  ConsoleActionId,
  ConsoleCapabilityContract,
  ConsoleContextId,
} from './console-contracts.mjs';

export interface ConsoleReadBudget {
  maxRecords: number;
  maxSourceFiles: number;
  maxSourceBytes: number;
  maxElapsedMs: number;
}

export interface ConsoleReadContext {
  signal: AbortSignal;
  budget: ConsoleReadBudget;
}

export interface ConsoleReadWork {
  recordsRead: number;
  sourceFilesRead: number;
  sourceBytesRead: number;
  elapsedMs: number;
  budgetExhausted: boolean;
}

export interface ConsoleSourceWatermark {
  sourceId: string;
  revision: string | null;
  updatedAt: string | null;
  complete: boolean;
}

export interface ConsoleSourceVector {
  schemaVersion: 1;
  vectorRevision: string;
  indexRevision: string | null;
  complete: boolean;
  sources: readonly ConsoleSourceWatermark[];
}

export type ConsoleReadLimitationCode =
  | 'source-unavailable'
  | 'source-malformed'
  | 'source-stale'
  | 'budget-exhausted'
  | 'incomplete-publication'
  | 'purged'
  | 'permission-denied'
  | 'unsupported';

export interface ConsoleReadLimitation {
  sourceId: string;
  code: ConsoleReadLimitationCode;
}

export interface ConsoleBoundedSnapshot<T> {
  schemaVersion: 1;
  value: T | null;
  sourceVector: ConsoleSourceVector;
  complete: boolean;
  freshness: 'current' | 'stale' | 'unknown';
  limitations: readonly ConsoleReadLimitation[];
  work: ConsoleReadWork;
}

export interface ConsoleBoundedPage<T> {
  schemaVersion: 1;
  items: readonly T[];
  nextCursor: string | null;
  hasMore: boolean;
  omittedRecords: number;
  cursorBinding: Readonly<{
    mode: 'comparative' | 'single-site';
    scopeKey: string;
    normalizedFilterKey: string;
    sourceVectorRevision: string;
  }>;
  sourceVector: ConsoleSourceVector;
  complete: boolean;
  freshness: 'current' | 'stale' | 'unknown';
  limitations: readonly ConsoleReadLimitation[];
  work: ConsoleReadWork;
}

export interface ConsoleAuthorityRecord {
  mode: 'comparative' | 'single-site';
  sourceType: string;
  sourceIdentity: string;
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
  document: unknown;
}

export interface ConsoleRunIdentity {
  mode: 'comparative' | 'single-site';
  runId: string;
}

export interface ConsoleAuthorityPageRequest {
  cursor: string | null;
  limit: number;
  scopeKey: string;
  normalizedFilterKey: string;
}

export interface ConsoleDynamicActionEligibility {
  actionId: ConsoleActionId;
  supported: boolean;
  authorized: boolean;
  eligible: boolean;
  unavailableReason: string | null;
  authorityRevision: string;
}

export interface ConsoleCapabilitySnapshot {
  contextId: ConsoleContextId;
  capabilities: ConsoleCapabilityContract;
  authorityRevision: string;
  actions: readonly ConsoleDynamicActionEligibility[];
}

export interface ConsoleLogWindowRequest {
  cursor: string | null;
  maximumBytes: number;
  source: string | null;
  stage: string | null;
  search: string | null;
}

export interface ConsoleAuthorityReadPorts {
  listComparativeRuns(request: ConsoleAuthorityPageRequest, context: ConsoleReadContext): Promise<ConsoleBoundedPage<ConsoleAuthorityRecord>>;
  listSingleSiteRuns(request: ConsoleAuthorityPageRequest, context: ConsoleReadContext): Promise<ConsoleBoundedPage<ConsoleAuthorityRecord>>;
  readRun(identity: ConsoleRunIdentity, context: ConsoleReadContext): Promise<ConsoleBoundedSnapshot<ConsoleAuthorityRecord>>;
  readFinalization(identity: ConsoleRunIdentity, context: ConsoleReadContext): Promise<ConsoleBoundedSnapshot<ConsoleAuthorityRecord>>;
  readReportSummary(identity: ConsoleRunIdentity, context: ConsoleReadContext): Promise<ConsoleBoundedSnapshot<ConsoleAuthorityRecord>>;
  readReportPage(identity: ConsoleRunIdentity, request: ConsoleAuthorityPageRequest, context: ConsoleReadContext): Promise<ConsoleBoundedPage<ConsoleAuthorityRecord>>;
  readGalleryHead(identity: ConsoleRunIdentity, context: ConsoleReadContext): Promise<ConsoleBoundedSnapshot<ConsoleAuthorityRecord>>;
  readGalleryPage(identity: ConsoleRunIdentity, request: ConsoleAuthorityPageRequest, context: ConsoleReadContext): Promise<ConsoleBoundedPage<ConsoleAuthorityRecord>>;
  readTimelineInputs(identity: ConsoleRunIdentity, request: ConsoleAuthorityPageRequest, context: ConsoleReadContext): Promise<ConsoleBoundedPage<ConsoleAuthorityRecord>>;
  readLogWindow(identity: ConsoleRunIdentity, request: ConsoleLogWindowRequest, context: ConsoleReadContext): Promise<ConsoleBoundedSnapshot<ConsoleAuthorityRecord>>;
  readCapabilities(identity: ConsoleRunIdentity, context: ConsoleReadContext): Promise<ConsoleBoundedSnapshot<ConsoleCapabilitySnapshot>>;
  readSourceVector(context: ConsoleReadContext): Promise<ConsoleBoundedSnapshot<ConsoleSourceVector>>;
}
