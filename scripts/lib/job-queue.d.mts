export const JOB_QUEUE_SCHEMA_VERSION: 1;
export const DEFAULT_HEARTBEAT_MS: number;
export const DEFAULT_LEASE_MS: number;
export const DEFAULT_MAX_INFRASTRUCTURE_RETRIES: number;
export const JOB_EXECUTION_STATES: readonly JobExecutionState[];
export const WORKER_ACTIVITY_STATES: readonly WorkerActivityState[];

export type JobExecutionState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'incomplete'
  | 'cancelled';

export type WorkerActivityState = 'normal' | 'stalled' | 'recovering';

export interface EvidenceAuthority {
  authoritative: boolean;
  reasons: string[];
}

export interface JobSubmission {
  idempotencyKey: string;
  runMode: 'single-site';
  inputDocumentDigest: string;
  runContractDigest: string;
  compiledManifestDigest: string;
  preflightDigest: string;
  identityFingerprint: string;
  revisionFingerprint: string | null;
  evidenceAuthority: EvidenceAuthority;
  registryRevision: string;
  targetSetRevision: string;
  runnerRevision: string;
  stageDeadlines: Record<string, string>;
}

export interface JobLease {
  workerId: string;
  attemptId: string;
  attemptNumber: number;
  fencingToken: number;
  heartbeatAt: string;
  expiresAt: string;
}

export interface JobClaim {
  schemaVersion: 1;
  jobId: string;
  workerId: string;
  attemptId: string;
  attemptNumber: number;
  fencingToken: number;
}

export interface JobEvent {
  sequence: number;
  type: string;
  at: string;
  executionState: JobExecutionState;
  activityState: WorkerActivityState;
  attemptNumber: number;
  attemptId: string | null;
  fencingToken: number;
  message: string;
}

export interface JobPublication {
  publicationId: string;
  relativePath: string;
  digest: string;
  attemptId: string;
  attemptNumber: number;
  fencingToken: number;
  publishedAt: string;
}

export interface JobEnvelope {
  schemaVersion: 1;
  jobId: string;
  idempotencyKeyDigest: string;
  submissionDigest: string;
  runMode: 'single-site';
  inputDocumentDigest: string;
  runContractDigest: string;
  compiledManifestDigest: string;
  preflightDigest: string;
  identityFingerprint: string;
  revisionFingerprint: string | null;
  evidenceAuthority: EvidenceAuthority;
  registryRevision: string;
  targetSetRevision: string;
  runnerRevision: string;
  stageDeadlines: Record<string, string>;
  submittedAt: string;
  updatedAt: string;
  executionState: JobExecutionState;
  activityState: WorkerActivityState;
  attemptNumber: number;
  attemptId: string | null;
  fencingToken: number;
  lease: JobLease | null;
  infrastructureRetriesUsed: number;
  maxInfrastructureRetries: number;
  result: null | {
    kind: 'passed' | 'findings' | 'infrastructure-failure' | 'failed' | 'incomplete';
    reason: string | null;
  };
  cancellation: null | { requestedAt: string; reason: string };
  sequence: number;
  events: JobEvent[];
  publications: JobPublication[];
}

export interface JobQueue {
  readonly root: string;
  readonly fs: typeof import('node:fs/promises');
  readonly clock: () => number | Date;
  readonly nonce: () => string;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly lockClock: () => number;
  readonly heartbeatMs: number;
  readonly leaseMs: number;
  readonly maxInfrastructureRetries: number;
  readonly lockRetryMs: number;
  readonly lockRetries: number;
  readonly lockStaleMs: number;
  readonly storage: QueueStorageSemantics | null;
}

export interface QueueStorageSemantics {
  filesystemType: string;
  atomicMkdir: true;
  atomicRename: true;
  fsync: true;
}

export class JobQueueError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown);
}

export function canonicalJson(value: unknown): string;
export function sha256(value: unknown): string;
export function assertSupportedFilesystemType(type: number | bigint): string;
export function assertJobEnvelope(value: unknown): JobEnvelope;

export function verifyQueueStorageSemantics(options: {
  root: string;
  filesystem?: typeof import('node:fs/promises');
  nonce?: () => string;
}): Promise<QueueStorageSemantics>;

export function openJobQueue(options: {
  root: string;
  filesystem?: typeof import('node:fs/promises');
  clock?: () => number | Date;
  nonce?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  lockClock?: () => number;
  heartbeatMs?: number;
  leaseMs?: number;
  maxInfrastructureRetries?: 0 | 1;
  lockRetryMs?: number;
  lockRetries?: number;
  lockStaleMs?: number;
  verifyStorage?: boolean;
}): Promise<JobQueue>;

export function submitJob(
  queue: JobQueue,
  submission: JobSubmission,
  options?: { inputDocument?: Record<string, unknown> },
): Promise<{ created: boolean; state: JobEnvelope }>;
export function readJobInput(queue: JobQueue, jobId: string): Promise<Record<string, unknown>>;
export function readJob(queue: JobQueue, jobId: string): Promise<JobEnvelope>;
export function listJobs(queue: JobQueue): Promise<JobEnvelope[]>;
export function listIndexedJobs(queue: JobQueue, options: {
  category: 'ready' | 'terminal';
  cursor?: string | null;
  limit?: number;
}): Promise<{ jobs: JobEnvelope[]; cursor: string; scannedMarkers: number }>;
export function claimJob(queue: JobQueue, jobId: string, workerId: string): Promise<JobClaim>;
export function heartbeatJob(
  queue: JobQueue,
  claim: JobClaim,
  options?: { activityState?: WorkerActivityState },
): Promise<JobClaim>;
export function transitionJob(
  queue: JobQueue,
  claim: JobClaim,
  executionState: 'running' | 'finalizing',
  options?: { activityState?: WorkerActivityState; message?: string | null },
): Promise<JobEnvelope>;
export function publishAttemptDocument(
  queue: JobQueue,
  claim: JobClaim,
  publication: { publicationId: string; relativePath: string; document: object | unknown[] },
): Promise<JobPublication>;
export function settleJobAttempt(
  queue: JobQueue,
  claim: JobClaim,
  settlement: {
    kind: 'success' | 'assertion-failure' | 'infrastructure-failure' | 'failed' | 'incomplete';
    reason?: string | null;
  },
): Promise<JobEnvelope>;
export function verifyJobCheckpoint(
  queue: JobQueue,
  claim: JobClaim,
  checkpoint: {
    identityFingerprint: string;
    revisionFingerprint: string | null;
    preflightDigest: string;
    compiledManifestDigest: string;
    registryRevision: string;
    targetSetRevision: string;
    runnerRevision: string;
  },
): Promise<JobEnvelope>;
export function cancelJob(queue: JobQueue, jobId: string, reason: string): Promise<JobEnvelope>;
