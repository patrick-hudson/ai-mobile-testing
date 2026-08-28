export type SingleSiteAiReviewState = 'pending' | 'running' | 'completed' | 'failed' | 'unavailable';

export interface SingleSiteAiReviewStatus {
  schemaVersion: 1;
  kind: 'single-site-ai-advisory-status';
  jobId: string;
  state: SingleSiteAiReviewState;
  stateRevision: number;
  requestId: string;
  attempt: number;
  optIn: boolean;
  model: string;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  reportRevision: string;
  reportPublicationDigest: string;
  inputDigest: string | null;
  output: null | {
    publicationRelativePath: string;
    publicationDigest: string;
    reviewSha256: string;
    reviewStatus: string;
    findingCount: number;
    advisory: true;
    gating: false;
  };
  error: null | { code: string; message: string };
  retryable: boolean;
  statusDigest: string;
}

export interface SingleSiteAiReviewSupervisor {
  readonly root: string;
  readonly aiWorkerIdentity: { active: boolean; uid?: number | null; gid?: number | null };
}

export class SingleSiteAiReviewError extends Error {
  readonly code: string;
  readonly details: unknown;
}

export function openSingleSiteAiReviewSupervisor(options: {
  root: string;
  aiWorkerIdentity: { active: boolean; uid?: number | null; gid?: number | null; user?: string; home?: string };
  timeoutMs?: number;
  maxReportInputBytes?: number;
  /** Store advisory state inside <root>/<jobId>/<name> so run purge removes it atomically. */
  nestedJobSubdirectory?: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<SingleSiteAiReviewSupervisor>;

export function requestSingleSiteAiReview(supervisor: SingleSiteAiReviewSupervisor, request: {
  jobId: string;
  requestId: string;
  expectedStateRevision: number;
  optIn: boolean;
  model: string;
  /** Runtime-only secret written once to the isolated child stdin; never persisted. */
  apiKey: string | null;
  reportDirectory: string;
  reportRevision: string;
  reportPublicationDigest: string;
}): Promise<SingleSiteAiReviewStatus>;

export function readSingleSiteAiReview(
  supervisor: SingleSiteAiReviewSupervisor,
  jobId: string,
): Promise<SingleSiteAiReviewStatus | null>;

export function waitForSingleSiteAiReview(
  supervisor: SingleSiteAiReviewSupervisor,
  jobId: string,
): Promise<SingleSiteAiReviewStatus | null>;

export function readSingleSiteAiReviewResult(
  supervisor: SingleSiteAiReviewSupervisor,
  jobId: string,
): Promise<{
  schemaVersion: 1;
  mode: 'single-site';
  advisory: true;
  gating: false;
  status: SingleSiteAiReviewStatus;
  publication: Record<string, unknown>;
  review: Record<string, unknown>;
  inventory: Record<string, unknown>;
}>;

export function recoverSingleSiteAiReviews(
  supervisor: SingleSiteAiReviewSupervisor,
): Promise<Array<Record<string, unknown>>>;

export function fenceSingleSiteAiReviewForPurge(
  supervisor: SingleSiteAiReviewSupervisor,
  jobId: string,
): Promise<Readonly<{ jobId: string; fenced: true; activeDrained: boolean }>>;

export function releaseSingleSiteAiReviewPurgeFence(
  supervisor: SingleSiteAiReviewSupervisor,
  jobId: string,
): void;
