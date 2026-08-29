export type VisualReviewDisposition = 'accepted-change' | 'known-defect';
export {
  appendVisualDisposition as appendScopedVisualDisposition,
  parseVisualDispositionHistory as parseScopedVisualDispositionHistory,
} from '../shared/release-projection.mjs';

export interface VisualReviewBinding {
  jobId: string;
  galleryItemId: string;
  reportRevision: string;
  galleryExportRevision: string;
  visualPublicationDigest: string;
  visualComparisonItemId: string;
  identityKey: string;
  slotKey: string;
  comparisonDigest: string;
  baselineId: string;
  baselineMediaSha256: string;
  currentMediaSha256: string;
  diffSha256: string;
}

export interface VisualReviewRecord {
  reviewKey: string;
  status: 'REVIEWED';
  disposition: VisualReviewDisposition;
  rationale: string;
  actorId: string;
  reviewedAt: string;
  reviewRevision: number;
  eventId: string;
  binding: VisualReviewBinding;
}

export interface VisualReviewStore {
  readonly root: string;
  readonly eventsDirectory: string;
  readonly clock: () => Date | string;
  readonly nonce: () => string;
}

export interface VisualReviewSnapshot {
  state: {
    reviewRevision: number;
    historyDigest: string;
    reviews: Record<string, VisualReviewRecord>;
    idempotency: Record<string, { requestDigest: string; result: Record<string, unknown> }>;
  };
  history: readonly Record<string, unknown>[];
  bytes: number;
}

export class VisualReviewStoreError extends Error {
  code: string;
  details?: unknown;
}

export function openVisualReviewStore(options: {
  root: string;
  clock?: () => Date | string;
  nonce?: () => string;
}): Promise<VisualReviewStore>;
export function readVisualReviewStore(store: VisualReviewStore): Promise<VisualReviewSnapshot>;
export function visualReviewBindingKey(binding: VisualReviewBinding): string;
export function resolveVisualReview(snapshot: VisualReviewSnapshot, binding: VisualReviewBinding): VisualReviewRecord | null;
export function reviewVisualComparison(
  store: VisualReviewStore,
  baselineStore: unknown,
  input: {
    expectedReviewRevision: number;
    expectedBaselineStoreRevision: number;
    binding: VisualReviewBinding;
    actorId: string;
    rationale: string;
    disposition: VisualReviewDisposition;
    idempotencyKey: string;
  },
): Promise<{
  reviewRevision: number;
  eventId: string;
  reviewKey: string;
  status: 'REVIEWED';
  disposition: VisualReviewDisposition;
  idempotent: boolean;
}>;
