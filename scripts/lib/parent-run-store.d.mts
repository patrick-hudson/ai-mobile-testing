import type { PublicationEnvelope } from '../../shared/publication-envelope.mjs';
import type { WorkExecutionDescriptor } from '../../shared/work-execution-descriptor.mjs';
export class ParentRunStoreError extends Error { code: string; details?: unknown }
export const PARENT_RUN_STORE_SCHEMA_VERSION: 2;
export const PARENT_RUN_WRITER_PROTOCOL: 'single-coordinator-global-performance-v2';
export const RELEASE_AUTHORITY_PHASES: readonly ['SHADOW', 'DRAINING', 'ACTIVE', 'PROMOTION_DISABLED'];
export const MAX_ATTEMPT_ARTIFACTS: 64;
export const MAX_ATTEMPT_ARTIFACT_BYTES: number;
export const MAX_ATTEMPT_EVIDENCE_BYTES: number;
export const MAX_DISCOVERED_PARENT_RUNS: 2048;
export const ARTIFACT_READ_LEASE_MS: number;
export interface ParentRunStore { root: string; clock(): number; manifest: any; buildIdentity: string }
export interface CoordinatorFence { ownerId: string; epoch: number; token: string; acquiredAt: string; expiresAt: string }
export interface ReleaseAuthorityBinding { storeMarkerDigest: string; storeGeneration: number; activationEpoch: 0 | 1; writerProtocol: string; digest: string }
export interface ReleaseAuthorityContext { selector: any; binding: ReleaseAuthorityBinding }
export interface WorkLease { runId: string; workItemId: string; workerId: string; attempt: number; epoch: number; token: string; claimedAt: string; expiresAt: string; subjectCoreDigest: string; runnerRevision: string; capability: string; resourceClass: 'ordinary' | 'performance'; targetId: string; specAffinity: string | null; executionDescriptor: WorkExecutionDescriptor | null; executionDescriptorDigest: string | null; diagnosticExecutionId?: string }
export interface WorkHeartbeatReceipt { relativePath: string; digest: string; workItemId: string; leaseToken: string }
export interface StorePerformanceReservation { workerId: string; runId: string; workItemId: string; diagnosticExecutionId: string | null; coordinatorEpoch: number; requestedAt: string; expiresAt: string; attempt?: number; leaseToken?: string; acquiredAt?: string }
export interface StorePerformanceScheduler { schemaVersion: 1; kind: 'store-performance-scheduler'; revision: number; phase: 'idle' | 'draining' | 'running'; reservation: StorePerformanceReservation | null; updatedAt: string; digest: string }
export function openParentRunStore(options: any): Promise<ParentRunStore>;
export function createParentRun(store: ParentRunStore, input: any): Promise<any>;
export function recoverParentRun(store: ParentRunStore, runId: string): Promise<any>;
export function readParentRun(store: ParentRunStore, runId: string): Promise<any>;
export function parentRunExists(store: ParentRunStore, runId: string): Promise<boolean>;
export function listParentRunIds(store: ParentRunStore, options?: { limit?: number }): Promise<string[]>;
export function sealParentRunGraph(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: {
  subjectCore?: unknown;
  executionManifest: unknown;
  finalSubject: unknown;
  inventoryWorkItemId?: string;
  workItems?: Array<{ id: string; maxAttempts: number; capability?: string; resourceClass?: 'ordinary' | 'performance'; targetId?: string; specAffinity?: string | null; executionDescriptor?: WorkExecutionDescriptor | null }>;
}): Promise<any>;
export function terminalizeParentRunCompilation(store: ParentRunStore, runId: string, coordinator: CoordinatorFence): Promise<any>;
export function acquireCoordinator(store: ParentRunStore, runId: string, input: { ownerId: string; leaseMs: number }): Promise<CoordinatorFence>;
export function takeOverCoordinator(store: ParentRunStore, runId: string, input: { ownerId: string; leaseMs: number }): Promise<CoordinatorFence>;
export function acquireStoreCoordinator(store: ParentRunStore, input: { ownerId: string; leaseMs: number }): Promise<CoordinatorFence>;
export function takeOverStoreCoordinator(store: ParentRunStore, input: { ownerId: string; leaseMs: number }): Promise<CoordinatorFence>;
export function readStoreCoordinator(store: ParentRunStore): Promise<(CoordinatorFence & { digest: string }) | null>;
export function readReleaseAuthoritySelector(store: ParentRunStore): Promise<any>;
export function readReleaseAuthorityContext(store: ParentRunStore, options?: { requireActive?: boolean }): Promise<any>;
export function transitionReleaseAuthority(store: ParentRunStore, coordinator: CoordinatorFence, input: {
  expectedSelectorDigest: string; phase: 'SHADOW' | 'DRAINING' | 'ACTIVE' | 'PROMOTION_DISABLED';
  buildIdentity: string; activationRevision?: number;
  hooks?: { beforeCommit?(selector: any): void | Promise<void>; afterActivationIntent?(selector: any): void | Promise<void>; afterActivationFence?(selector: any): void | Promise<void>; afterCommit?(selector: any): void | Promise<void> };
}): Promise<any>;
export function heartbeatCoordinator(store: ParentRunStore, coordinator: CoordinatorFence, input: { leaseMs: number }): Promise<CoordinatorFence>;
export function requestPerformanceDrain(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: { workerId: string; leaseMs?: number }): Promise<StorePerformanceReservation>;
export function requestStorePerformanceDrain(store: ParentRunStore, coordinator: CoordinatorFence, input: { workerId: string; capabilities: string[]; resourceClasses: Array<'performance'>; runIds: string[]; leaseMs?: number }): Promise<StorePerformanceReservation>;
export function readStorePerformanceScheduler(store: ParentRunStore): Promise<StorePerformanceScheduler>;
export function reconcileStorePerformanceScheduler(store: ParentRunStore, coordinator: CoordinatorFence): Promise<StorePerformanceScheduler>;
export function claimStoreWorkItem(store: ParentRunStore, coordinator: CoordinatorFence, input: { workerId: string; runIds: string[]; workItemId?: string; capabilities?: string[]; resourceClasses?: Array<'ordinary' | 'performance'>; leaseMs: number }): Promise<WorkLease>;
export function claimWorkItem(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: { workerId: string; workItemId?: string; capabilities?: string[]; resourceClasses?: Array<'ordinary' | 'performance'>; leaseMs: number }): Promise<WorkLease>;
export function heartbeatWorkItem(store: ParentRunStore, runId: string, lease: WorkLease, options?: { leaseMs?: number }): Promise<WorkHeartbeatReceipt>;
export function adoptWorkHeartbeat(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, receipt: WorkHeartbeatReceipt): Promise<WorkLease>;
export function requeueExpiredWork(store: ParentRunStore, runId: string, coordinator: CoordinatorFence): Promise<number>;
export function publishAttemptEvidence(store: ParentRunStore, runId: string, lease: WorkLease, result: any): Promise<any>;
export function createAttemptEvidenceUploadIntent(store: ParentRunStore, runId: string, lease: WorkLease, result: any): Promise<any>;
export function uploadAttemptEvidenceArtifact(store: ParentRunStore, runId: string, binding: {
  workItemId: string; workerId: string; attempt: number; leaseToken: string; intentDigest: string; ordinal: number;
  contentLength: number; mediaType: string;
}, chunks: AsyncIterable<Uint8Array>): Promise<any>;
export function finalizeAttemptEvidenceUpload(store: ParentRunStore, runId: string, binding: {
  workItemId: string; workerId: string; attempt: number; leaseToken: string; intentDigest: string;
}): Promise<any>;
export function appendAttemptLog(store: ParentRunStore, runId: string, lease: WorkLease, entry: { sequence: number; level: 'debug' | 'info' | 'warn' | 'error'; message: string }): Promise<any>;
export function adoptAttemptEvidence(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, inbox: any): Promise<any>;
export function readAdoptedAttemptArtifactJson(store: ParentRunStore, runId: string, input: { workItemId: string; name: string; diagnosticExecutionId?: string; maximumBytes?: number }): Promise<any>;
export interface AdoptedAttemptArtifactDescriptor {
  runId: string; workItemId: string; attempt: number; authoritative: boolean; diagnosticExecutionId: string | null; completedAt: string;
  name: string; logicalName: string; purpose: 'structured' | 'primary' | 'diagnostic';
  mediaType: string; sizeBytes: number; digest: string; memberDigest: string; artifactKey: string;
}
export function listAdoptedAttemptArtifacts(store: ParentRunStore, runId: string, options?: { offset?: number; limit?: number }): Promise<{
  runId: string; files: AdoptedAttemptArtifactDescriptor[]; total: number; knownTotal: number;
  totalComplete: boolean; offset: number; limit: number; nextOffset: number; hasMore: boolean;
}>;
export function openAdoptedAttemptArtifact(store: ParentRunStore, runId: string, input: { workItemId: string; artifactKey: string }): Promise<{
  descriptor: AdoptedAttemptArtifactDescriptor;
  opened: { handle: any; stat: any; path: string; relativePath: string; integrityFingerprint: string; transferLease: { token: string; renew(): Promise<void>; release(): Promise<void> } };
}>;
export function cancelParentRun(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function acceptOperation(store: ParentRunStore, runId: string, request: any): Promise<any>;
export function getOperation(store: ParentRunStore, runId: string, idempotencyKey: string): Promise<any>;
export function getOperationById(store: ParentRunStore, runId: string, operationId: string): Promise<any>;
export function listPendingOperations(store: ParentRunStore, runId: string, options?: { limit?: number }): Promise<any[]>;
export function rekickIncompleteWork(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function applyRekickOperation(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, operationId: string, input?: { observedDeploymentIdentity?: { kind: string; value: string } | null; failureReason?: string | null }): Promise<any>;
export function applyDiagnosticRerunOperation(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, operationId: string, input?: { observedDeploymentIdentity?: { kind: string; value: string } | null; failureReason?: string | null }): Promise<any>;
export function completeOperation(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, operationId: string, outcome: any): Promise<any>;
export function appendRiskLifecycleEvent(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function appendMutationAuditEvent(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function tombstoneParentRunAuthority(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function purgeParentRunEvidence(store: ParentRunStore, runId: string): Promise<any>;
export function readRunHistories(store: ParentRunStore, runId: string): Promise<Record<string, any[]>>;
export function readBoundedAttemptLogs(store: ParentRunStore, runId: string, options?: { limit?: number }): Promise<{ entries: any[]; truncated: boolean }>;
export function readParentRunWorkspaceSnapshot(store: ParentRunStore, runId: string, options?: { logLimit?: number }): Promise<any>;
export function publishCurrentEnvelope(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, envelope: PublicationEnvelope, hooks?: { afterEnvelopePersist?(envelope: PublicationEnvelope): void | Promise<void>; afterDecisionPersist?(envelope: PublicationEnvelope): void | Promise<void> }): Promise<PublicationEnvelope>;
export function readCurrentEnvelope(store: ParentRunStore, runId: string): Promise<PublicationEnvelope>;
export function withCurrentEnvelopeFence<T>(store: ParentRunStore, runId: string, callback: (envelope: PublicationEnvelope, authority: ReleaseAuthorityContext) => T | Promise<T>): Promise<T>;
