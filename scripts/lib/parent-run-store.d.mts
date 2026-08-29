import type { PublicationEnvelope } from '../../shared/publication-envelope.mjs';
import type { WorkExecutionDescriptor } from '../../shared/work-execution-descriptor.mjs';
export class ParentRunStoreError extends Error { code: string; details?: unknown }
export const PARENT_RUN_STORE_SCHEMA_VERSION: 1;
export const PARENT_RUN_WRITER_PROTOCOL: 'single-coordinator-fenced-v1';
export const MAX_ATTEMPT_ARTIFACTS: 64;
export const MAX_ATTEMPT_ARTIFACT_BYTES: number;
export const MAX_ATTEMPT_EVIDENCE_BYTES: number;
export interface ParentRunStore { root: string; clock(): number; manifest: any }
export interface CoordinatorFence { ownerId: string; epoch: number; token: string; acquiredAt: string; expiresAt: string }
export interface WorkLease { runId: string; workItemId: string; workerId: string; attempt: number; epoch: number; token: string; claimedAt: string; expiresAt: string; subjectCoreDigest: string; runnerRevision: string; capability: string; resourceClass: 'ordinary' | 'performance'; targetId: string; specAffinity: string | null; executionDescriptor: WorkExecutionDescriptor | null; executionDescriptorDigest: string | null }
export interface WorkHeartbeatReceipt { relativePath: string; digest: string; workItemId: string; leaseToken: string }
export function openParentRunStore(options: any): Promise<ParentRunStore>;
export function createParentRun(store: ParentRunStore, input: any): Promise<any>;
export function recoverParentRun(store: ParentRunStore, runId: string): Promise<any>;
export function readParentRun(store: ParentRunStore, runId: string): Promise<any>;
export function listParentRunIds(store: ParentRunStore, options?: { limit?: number }): Promise<string[]>;
export function sealParentRunGraph(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: {
  subjectCore?: unknown;
  executionManifest: unknown;
  finalSubject: unknown;
  inventoryWorkItemId?: string;
  workItems?: Array<{ id: string; maxAttempts: number; capability?: string; resourceClass?: 'ordinary' | 'performance'; targetId?: string; specAffinity?: string | null; executionDescriptor?: WorkExecutionDescriptor | null }>;
}): Promise<any>;
export function acquireCoordinator(store: ParentRunStore, runId: string, input: { ownerId: string; leaseMs: number }): Promise<CoordinatorFence>;
export function takeOverCoordinator(store: ParentRunStore, runId: string, input: { ownerId: string; leaseMs: number }): Promise<CoordinatorFence>;
export function acquireStoreCoordinator(store: ParentRunStore, input: { ownerId: string; leaseMs: number }): Promise<CoordinatorFence>;
export function takeOverStoreCoordinator(store: ParentRunStore, input: { ownerId: string; leaseMs: number }): Promise<CoordinatorFence>;
export function heartbeatCoordinator(store: ParentRunStore, coordinator: CoordinatorFence, input: { leaseMs: number }): Promise<CoordinatorFence>;
export function requestPerformanceDrain(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: { workerId: string; leaseMs?: number }): Promise<{ workerId: string; requestedAt: string; expiresAt: string; coordinatorEpoch: number }>;
export function claimWorkItem(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: { workerId: string; workItemId?: string; capabilities?: string[]; resourceClasses?: Array<'ordinary' | 'performance'>; leaseMs: number }): Promise<WorkLease>;
export function heartbeatWorkItem(store: ParentRunStore, runId: string, lease: WorkLease, options?: { leaseMs?: number }): Promise<WorkHeartbeatReceipt>;
export function adoptWorkHeartbeat(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, receipt: WorkHeartbeatReceipt): Promise<WorkLease>;
export function requeueExpiredWork(store: ParentRunStore, runId: string, coordinator: CoordinatorFence): Promise<number>;
export function publishAttemptEvidence(store: ParentRunStore, runId: string, lease: WorkLease, result: any): Promise<any>;
export function appendAttemptLog(store: ParentRunStore, runId: string, lease: WorkLease, entry: { sequence: number; level: 'debug' | 'info' | 'warn' | 'error'; message: string }): Promise<any>;
export function adoptAttemptEvidence(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, inbox: any): Promise<any>;
export function readAdoptedAttemptArtifactJson(store: ParentRunStore, runId: string, input: { workItemId: string; name: string; maximumBytes?: number }): Promise<any>;
export function cancelParentRun(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function acceptOperation(store: ParentRunStore, runId: string, request: any): Promise<any>;
export function getOperation(store: ParentRunStore, runId: string, idempotencyKey: string): Promise<any>;
export function getOperationById(store: ParentRunStore, runId: string, operationId: string): Promise<any>;
export function listAcceptedOperations(store: ParentRunStore, runId: string, options?: { limit?: number }): Promise<any[]>;
export function rekickIncompleteWork(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function completeOperation(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, operationId: string, outcome: any): Promise<any>;
export function appendRiskLifecycleEvent(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function appendMutationAuditEvent(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function tombstoneParentRunAuthority(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function purgeParentRunEvidence(store: ParentRunStore, runId: string): Promise<any>;
export function readRunHistories(store: ParentRunStore, runId: string): Promise<Record<string, any[]>>;
export function readBoundedAttemptLogs(store: ParentRunStore, runId: string, options?: { limit?: number }): Promise<{ entries: any[]; truncated: boolean }>;
export function publishCurrentEnvelope(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, envelope: PublicationEnvelope, hooks?: { afterEnvelopePersist?(envelope: PublicationEnvelope): void | Promise<void>; afterDecisionPersist?(envelope: PublicationEnvelope): void | Promise<void> }): Promise<PublicationEnvelope>;
export function readCurrentEnvelope(store: ParentRunStore, runId: string): Promise<PublicationEnvelope>;
export function withCurrentEnvelopeFence<T>(store: ParentRunStore, runId: string, callback: (envelope: PublicationEnvelope) => T | Promise<T>): Promise<T>;
