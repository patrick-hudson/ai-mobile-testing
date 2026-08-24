export const GALLERY_SCHEMA_VERSION: 1;
export const GALLERY_CAPTURE_METADATA_CONTENT_TYPE: 'application/vnd.quitting7oh.gallery-capture+json';
export const GALLERY_CAPTURE_TEXT_LIMIT: number;
export const GALLERY_ARCHIVE_CHANNEL: 'quitting7oh-gallery-archive-v1';
export const GALLERY_DESCRIPTOR_MAX_BYTES: number;
export const GALLERY_QUERY_CHUNK_MAX_BYTES: number;
export const GALLERY_ITEM_DETAIL_MAX_BYTES: number;
export const GALLERY_QUERY_CHUNK_MAX_ROWS: number;
export const GALLERY_FLAG_REVIEWER_MAX_CHARS: number;
export const GALLERY_FLAG_TEXT_MAX_CHARS: number;
export const GALLERY_FLAG_IDEMPOTENCY_MAX_CHARS: number;
export const GALLERY_FLAG_MAX_EVENTS: number;
export const GALLERY_FLAG_HISTORY_MAX_BYTES: number;

export class GalleryFlagContractError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, message: string, statusCode?: number);
}

export type GalleryMediaKind = 'image' | 'video';
export type GalleryMemberRole = 'single' | 'baseline' | 'actual' | 'diff' | 'other' | 'unknown';
export type GalleryCaptureProvenance = 'producer' | 'legacy-inferred' | 'test-policy' | 'missing';

export interface GalleryCaptureMetadata {
  schemaVersion: 1;
  attachmentName: string;
  attachmentOccurrence: number;
  attachmentKey?: string;
  comparisonGroup?: string;
  memberRole?: Exclude<GalleryMemberRole, 'single' | 'unknown'>;
  capturedAt?: string;
  route?: string;
  observedState?: string;
  rationale?: string;
  viewport?: { width: number; height: number };
  derivativeOf?: string;
}

export interface GalleryCaptureContext {
  route: string | null;
  viewport: { width: number; height: number } | null;
  capturedAt: string | null;
  observedState: string | null;
  rationale: string | null;
  provenance: GalleryCaptureProvenance;
}

export interface GalleryAuditAssociation {
  id: string;
  title: string;
  expected: string;
  featureSuite: string;
  catalogOrdinal: number | null;
}

export interface GalleryPoster {
  name: string;
  href: string;
  contentType: 'image/jpeg';
  sizeBytes: number;
  sha256: string;
}

export interface GalleryMember {
  id: string;
  attachmentKey: string;
  name: string;
  role: GalleryMemberRole;
  contentType: string;
  blobId: string | null;
  available: boolean;
  error: string | null;
  poster: GalleryPoster | null;
}

export interface GalleryBlob {
  id: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  kind: GalleryMediaKind;
  href: string;
  storageLocations: string[];
}

export interface GalleryItem {
  id: string;
  kind: GalleryMediaKind;
  test: {
    id: string;
    title: string;
    titlePath: string[];
    file: string;
    line: number | null;
    column: number | null;
    technicalSuite: string;
  };
  attempt: {
    ordinal: number;
    retry: number;
    status: string;
    rawStatus?: string;
    statusSource?: 'reviewed-manifest' | 'release-integrity';
    reviewReasonCodes?: string[];
    expectedStatus: string | null;
    startedAt: string | null;
    durationMs: number;
  };
  project: {
    name: string;
    environment: 'production' | 'candidate' | 'unknown';
    browser: string;
    deviceClass: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  };
  auditAssociations: GalleryAuditAssociation[];
  members: GalleryMember[];
  comparison: { key: string; complete: boolean } | null;
  capture: GalleryCaptureContext;
  provenance: {
    sourceShard: { ordinal: number; total: number } | null;
  };
}

export interface GalleryCatalog {
  schemaVersion: 1;
  items: GalleryItem[];
  blobs: GalleryBlob[];
  primaryCounts: { total: number; images: number; videos: number };
}

export interface GalleryQuery {
  kinds?: string[];
  statuses?: string[];
  environments?: string[];
  featureSuites?: string[];
  technicalSuites?: string[];
  targets?: string[];
  flagStates?: string[];
  search?: string;
  group?: string;
  sort?: string;
}

export interface NormalizedGalleryQuery {
  kinds: GalleryMediaKind[];
  statuses: string[];
  environments: string[];
  featureSuites: string[];
  technicalSuites: string[];
  targets: string[];
  flagStates: string[];
  search: string;
  group: 'feature' | 'technical' | 'none';
  sort: 'attention' | 'feature' | 'technical' | 'audit' | 'capture-time';
}

export interface GalleryQueryIndexRow {
  id: string;
  testGroupId: string;
  kind: GalleryMediaKind;
  title: string;
  testLabel: string;
  testTitlePath: string[];
  projectName: string;
  status: string;
  environment: string;
  featureSuites: string[];
  primaryFeatureSuite: string | null;
  primaryAuditCatalogOrdinal: number | null;
  technicalSuite: string;
  targets: string[];
  flagState: 'open' | 'resolved' | 'dismissed' | 'unflagged';
  searchText: string;
  attempt: { ordinal: number; retry: number };
  captureTime: string | null;
  available: boolean;
  visualWarning: boolean;
  auditAssociations: Array<{ id: string; title: string; catalogOrdinal: number | null }>;
}

export interface GalleryItemDetailMedia {
  memberId: string;
  blobId: string | null;
  href: string | null;
  contentType: string;
  sizeBytes: number | null;
  sha256: string | null;
  available: boolean;
  poster: GalleryPoster | null;
}

export interface GalleryItemDetail {
  schemaVersion: 1;
  item: GalleryItem;
  media: GalleryItemDetailMedia[];
  availability: {
    state: 'available' | 'tombstone';
    retryable: boolean;
    message: string | null;
  };
}

export interface GalleryArchiveChunkReference {
  href: string;
  rows: number;
  bytes: number;
}

export interface GalleryArchiveDescriptor {
  schemaVersion: 1;
  phase: 'sealed';
  contentRevision: string;
  flagRevision: string;
  orderRevision: string;
  exportRevision: string;
  exportedAt: string;
  primaryCounts: GalleryCatalog['primaryCounts'];
  facets: {
    kinds: string[];
    statuses: string[];
    environments: string[];
    featureSuites: string[];
    technicalSuites: string[];
    targets: string[];
    flagStates: string[];
  };
  query: {
    rows: number;
    maxRowsPerChunk: number;
    maxBytesPerChunk: number;
    chunks: GalleryArchiveChunkReference[];
  };
  itemDetails: {
    count: number;
    hrefPrefix: string;
    hrefSuffix: string;
    maxBytes: number;
  };
  raw: {
    rows: number;
    maxRowsPerChunk: number;
    maxBytesPerChunk: number;
    chunks: GalleryArchiveChunkReference[];
  };
  flags: { href: string; throughEvent: number };
  integrity: { href: string; documentCount: number };
}

export type GalleryFlagAction = 'opened' | 'resolved' | 'dismissed' | 'reopened';
export type GalleryFlagState = 'open' | 'resolved' | 'dismissed';

export interface GalleryFlagIdentitySnapshot {
  testId: string;
  title?: string;
  project?: string;
  attempt?: number;
  auditIds?: string[];
}

export interface GalleryFlagEvent {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  flagId: string;
  previousEventId: string | null;
  action: GalleryFlagAction;
  itemId: string;
  identity: GalleryFlagIdentitySnapshot;
  reviewer: string;
  note: string | null;
  justification: string | null;
  timestamp: string;
  idempotencyKey: string;
  requestFingerprint: string;
  expectedFlagRevision: string;
}

export interface GalleryFlagHistory {
  schemaVersion: 1;
  throughEvent: number;
  events: GalleryFlagEvent[];
}

export interface GalleryFlagProjection {
  flagId: string;
  itemId: string;
  testId: string;
  identity: GalleryFlagIdentitySnapshot;
  state: GalleryFlagState;
  reviewer: string;
  note: string | null;
  justification: string | null;
  openedAt: string;
  updatedAt: string;
  lastEventId: string;
  throughEvent: number;
}

export interface GalleryFlagTransition {
  action: 'open' | 'resolve' | 'dismiss' | 'reopen';
  flagId?: string;
  itemId?: string;
  identity?: GalleryFlagIdentitySnapshot;
  reviewer: string;
  note?: string;
  justification?: string;
  idempotencyKey: string;
  expectedFlagRevision: string;
  timestamp: string;
  eventId: string;
}

export function stableGalleryString(value: unknown): string;
export function stableGalleryKey(value: unknown): string;
export function deriveGalleryItemId(identity: {
  sourceTestId: string;
  project: string;
  attempt: number;
  retry: number;
  attachmentKey: string;
}): string;
export function deriveGalleryMemberId(itemId: string, attachmentKey: string): string;
export function deriveGalleryTestGroupId(identity: {
  sourceTestId: string;
  project: string;
  attempt: number;
  retry: number;
}): string;
export function primaryGalleryAuditAssociation(
  associations: GalleryAuditAssociation[],
): GalleryAuditAssociation | null;
export function normalizeGalleryRoute(value: unknown): string | null;
export function boundedGalleryText(value: unknown, maximum?: number): string | null;
export function normalizeGalleryQuery(query?: GalleryQuery): NormalizedGalleryQuery;
export function galleryQueryRowMatches(row: GalleryQueryIndexRow, query?: GalleryQuery): boolean;
export function compareGalleryQueryRows(left: GalleryQueryIndexRow, right: GalleryQueryIndexRow, query?: GalleryQuery): number;
export function queryGalleryArchiveRows(rows: GalleryQueryIndexRow[], query?: GalleryQuery): GalleryQueryIndexRow[];
export function galleryItemHref(descriptor: GalleryArchiveDescriptor, itemId: string): string;
export function assertGalleryArchiveDescriptor(value: unknown): GalleryArchiveDescriptor;
export function compareGalleryAuditOrder(left: GalleryItem, right: GalleryItem): number;
export function assertGalleryCatalog(value: unknown): GalleryCatalog;
export function assertGalleryQueryRow(value: unknown): GalleryQueryIndexRow;
export function assertGalleryItemDetail(value: unknown): GalleryItemDetail;
export function emptyGalleryFlagHistory(): GalleryFlagHistory;
export function assertGalleryFlagHistory(value: unknown): GalleryFlagHistory;
export function galleryFlagRevision(history: GalleryFlagHistory): string;
export function galleryFlagSnapshot(history: GalleryFlagHistory): {
  schemaVersion: 1;
  throughEvent: number;
  flagRevision: string;
  flags: GalleryFlagProjection[];
  events: GalleryFlagEvent[];
};
export function projectGalleryFlags(events: unknown[], throughEvent?: number | null): GalleryFlagProjection[];
export function applyGalleryFlagTransition(history: GalleryFlagHistory, transition: GalleryFlagTransition): {
  history: GalleryFlagHistory;
  event: GalleryFlagEvent;
  flagRevision: string;
  idempotent: boolean;
};
