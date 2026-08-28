import type { VisualBaselineIdentity } from '../shared/visual-baseline-contract.mjs';

export class SingleSiteGalleryError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown);
}

export interface SingleSiteGalleryBindings {
  jobId: string;
  attemptId: string;
  status: 'complete' | 'incomplete';
  executionState: string;
  finalizationDigest: string;
  reportRevision: string;
  reportPublicationDigest: string;
  visualPublicationDigest: string;
  visualEligibilityManifestDigest: string;
  galleryPublicationDigest: string;
  galleryExportRevision: string;
  galleryIndexDigest: string;
}

export interface SingleSiteGallerySnapshot {
  readonly schemaVersion: 1;
  readonly mode: 'single-site';
  readonly jobId: string;
  readonly publicationRevision: string;
  readonly galleryExportRevision: string;
  readonly baselineStoreRevision: number;
  readonly reviewRevision: number;
}

export interface SingleSiteGallerySourceWork {
  reportDocumentsRead: number;
  galleryDetailReads: number;
  galleryInventoryRowsRead: number;
  galleryFullInventoryLoaded: boolean;
}

export interface SingleSiteGalleryAuditContext {
  auditId: string;
  title: string;
  area: string;
  status: string;
  findingCount: number | null;
  evidenceStatus: string;
  severity: string;
  coverageReasons: string[];
}

export interface SingleSiteGalleryItem {
  schemaVersion: 1;
  mode: 'single-site';
  itemId: string;
  kind: 'image' | 'video';
  title: string;
  suite: string;
  auditId: string;
  auditIds: string[];
  auditTitle: string;
  caseId: string;
  caseIdSource: 'digest-bound-gallery-index' | 'unknown';
  targetId: string;
  route: string;
  capturePoint: string;
  theme: string;
  severity: string;
  severitySource: 'audit-catalog' | 'unknown-default';
  audits: SingleSiteGalleryAuditContext[];
  findingCount: number;
  findingCountScope: 'exact-visual-execution' | 'associated-audits' | 'unknown';
  findingStatus: 'clear' | 'unresolved';
  coverageGap: boolean;
  coverageStatus: 'covered' | 'gap';
  coverageReasons: string[];
  visualReviewStatus: string;
  comparison: Record<string, unknown>;
  visualComparisonItemId: string | null;
  identity: VisualBaselineIdentity | null;
  identityKey: string | null;
  slotKey: string | null;
  evidenceId: string | null;
  evidence: Record<string, unknown> | null;
  eligible: boolean;
  ineligibilityReasons: string[];
  current: { bytes: number | null; sha256: string | null; contentType: string } | null;
  baseline: Record<string, unknown> | null;
  diff: { bytes: number; sha256: string } | null;
  staleComparisonWithheld: boolean;
  attentionRequired: boolean;
  urls: { current: string | null; baseline: string | null; diff: string | null; poster: null };
  testContext: Record<string, unknown>;
}

export interface SingleSiteGalleryDependencies {
  loadGallerySnapshot?: (...args: any[]) => Promise<any>;
  readGalleryItem?: (...args: any[]) => Promise<any>;
  loadReportPublication?: (...args: any[]) => Promise<any>;
  readPublishedReportJson?: (...args: any[]) => Promise<any>;
  readVisualPublication?: (...args: any[]) => Promise<any>;
  readBaselineStore?: (...args: any[]) => Promise<any>;
  readReviewStore?: (...args: any[]) => Promise<any>;
  loadReportContext?: (...args: any[]) => Promise<any>;
}

export function openSingleSiteGallery(options: {
  finalizationRoot: string;
  jobId: string;
  attemptId: string;
  bindings: SingleSiteGalleryBindings;
  baselineStore: unknown;
  reviewStore?: unknown;
  reportRunDirectory?: string;
  visualDirectory?: string;
  reportPublication?: Record<string, unknown>;
  auditCatalog?: readonly Record<string, unknown>[];
  mutationAuthorized?: boolean;
  dependencies?: SingleSiteGalleryDependencies;
  signal?: AbortSignal;
}): Promise<SingleSiteGallerySnapshot>;

export function singleSiteGalleryHead(snapshot: SingleSiteGallerySnapshot): Record<string, unknown>;

export function pageSingleSiteGalleryItems(snapshot: SingleSiteGallerySnapshot, options?: {
  offset?: number;
  limit?: number;
  revision?: string;
  baselineStoreRevision?: number;
  reviewRevision?: number;
  anchorItemId?: string | null;
  scope?: 'attention' | 'all';
  kind?: '' | 'image' | 'video';
  suite?: string;
  finding?: '' | 'all' | 'finding' | 'clear';
  coverage?: '' | 'all' | 'gap' | 'covered';
  visual?: '' | 'all' | 'CHANGED' | 'UNCHANGED' | 'REVIEWED' | 'absent' | 'incompatible' | 'unavailable';
  query?: string;
  signal?: AbortSignal;
}): Promise<{
  schemaVersion: 1;
  mode: 'single-site';
  publicationRevision: string;
  baselineStoreRevision: number;
  reviewRevision: number;
  items: SingleSiteGalleryItem[];
  total: number;
  filteredTotal: number | null;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number;
  hasPrevious: boolean;
  previousOffset: number;
  queuePosition: null | {
    itemId: string;
    sourceOrdinal: number;
    sourceTotal: number;
    pageOrdinal: number;
  };
  anchorExcluded: boolean;
  scan: { offset: number; nextOffset: number; rows: number; complete: boolean };
  sourceWork: SingleSiteGallerySourceWork;
}>;

export function readSingleSiteGalleryItem(snapshot: SingleSiteGallerySnapshot, itemId: string, options?: {
  revision?: string;
  baselineStoreRevision?: number;
  reviewRevision?: number;
  signal?: AbortSignal;
}): Promise<{ item: SingleSiteGalleryItem; sourceWork: SingleSiteGallerySourceWork }>;

export function reviewSingleSiteGalleryItem(
  snapshot: SingleSiteGallerySnapshot,
  itemId: string,
  input: {
    expectedReviewRevision: number;
    expectedBaselineStoreRevision: number;
    disposition: 'accepted-change' | 'known-defect';
    rationale: string;
    idempotencyKey: string;
    confirmation: string;
  },
): Promise<{
  schemaVersion: 1;
  mode: 'single-site';
  jobId: string;
  itemId: string;
  baselineStoreRevision: number;
  reviewRevision: number;
  status: 'REVIEWED';
  disposition: 'accepted-change' | 'known-defect';
  eventId: string;
  reviewKey: string;
  idempotent: boolean;
  policyEffects: {
    deterministicFindings: 'none';
    siteHealth: 'none';
    coverage: 'none';
    immutableRunPublication: 'none';
  };
}>;

export interface SingleSiteGalleryMediaDescriptor {
  contentType: string;
  bytes: number;
  sha256: string;
  etag: string;
  /** Server-only streaming path. This property is intentionally non-enumerable. */
  readonly absolutePath: string;
  /** Verified server-only descriptor. Non-enumerable; the streaming caller must close the handle. */
  readonly opened: {
    handle: import('node:fs/promises').FileHandle;
    stat: import('node:fs').Stats;
  };
}

export function resolveSingleSiteGalleryMedia(
  snapshot: SingleSiteGallerySnapshot,
  itemId: string,
  view: 'current' | 'diff',
  options?: { signal?: AbortSignal },
): Promise<SingleSiteGalleryMediaDescriptor>;
