import type { PublicationEnvelope } from '../../shared/publication-envelope.mjs';
export class ParentRunStoreError extends Error { code: string; details?: unknown }
export const PARENT_RUN_STORE_SCHEMA_VERSION: 1;
export const PARENT_RUN_WRITER_PROTOCOL: 'single-coordinator-fenced-v1';
export interface ParentRunStore { root: string; clock(): number; manifest: any }
export interface CoordinatorFence { ownerId: string; epoch: number; token: string; acquiredAt: string; expiresAt: string }
export interface WorkLease { runId: string; workItemId: string; workerId: string; attempt: number; epoch: number; token: string; claimedAt: string; expiresAt: string }
export function openParentRunStore(options: any): Promise<ParentRunStore>;
export function createParentRun(store: ParentRunStore, input: any): Promise<any>;
export function recoverParentRun(store: ParentRunStore, runId: string): Promise<any>;
export function readParentRun(store: ParentRunStore, runId: string): Promise<any>;
export function sealParentRunGraph(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function acquireCoordinator(store: ParentRunStore, runId: string, input: { ownerId: string; leaseMs: number }): Promise<CoordinatorFence>;
export function takeOverCoordinator(store: ParentRunStore, runId: string, input: { ownerId: string; leaseMs: number }): Promise<CoordinatorFence>;
export function heartbeatCoordinator(store: ParentRunStore, coordinator: CoordinatorFence, input: { leaseMs: number }): Promise<CoordinatorFence>;
export function claimWorkItem(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: { workerId: string; workItemId?: string; leaseMs: number }): Promise<WorkLease>;
export function heartbeatWorkItem(store: ParentRunStore, runId: string, lease: WorkLease, options?: { leaseMs?: number }): Promise<WorkLease>;
export function adoptWorkHeartbeat(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, receipt: any): Promise<WorkLease>;
export function requeueExpiredWork(store: ParentRunStore, runId: string, coordinator: CoordinatorFence): Promise<number>;
export function publishAttemptEvidence(store: ParentRunStore, runId: string, lease: WorkLease, result: any): Promise<any>;
export function appendAttemptLog(store: ParentRunStore, runId: string, lease: WorkLease, entry: { sequence: number; level: 'debug' | 'info' | 'warn' | 'error'; message: string }): Promise<any>;
export function adoptAttemptEvidence(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, inbox: any): Promise<any>;
export function cancelParentRun(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function acceptOperation(store: ParentRunStore, runId: string, request: any): Promise<any>;
export function getOperation(store: ParentRunStore, runId: string, idempotencyKey: string): Promise<any>;
export function completeOperation(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, operationId: string, outcome: any): Promise<any>;
export function appendRiskLifecycleEvent(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function appendMutationAuditEvent(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, input: any): Promise<any>;
export function readRunHistories(store: ParentRunStore, runId: string): Promise<Record<string, any[]>>;
export function publishCurrentEnvelope(store: ParentRunStore, runId: string, coordinator: CoordinatorFence, envelope: PublicationEnvelope, hooks?: { afterEnvelopePersist?(envelope: PublicationEnvelope): void | Promise<void>; afterDecisionPersist?(envelope: PublicationEnvelope): void | Promise<void> }): Promise<PublicationEnvelope>;
export function readCurrentEnvelope(store: ParentRunStore, runId: string): Promise<PublicationEnvelope>;
