import type { VisualBaselineEvidence, VisualBaselineIdentity, VisualBaselineRecord } from '../shared/visual-baseline-contract.mjs';

export class VisualBaselineStoreError extends Error {
  code: string;
  details?: unknown;
}

export interface VisualBaselineStore {
  root: string;
  eventsDirectory: string;
  mediaDirectory: string;
  lockDirectory: string;
  clock: () => Date | number | string;
  nonce: () => string;
  lockRetries: number;
  lockRetryMilliseconds: number;
}

export interface VisualBaselineSnapshot {
  state: {
    schemaVersion: 1;
    storeRevision: number;
    historyDigest: string;
    baselines: Record<string, VisualBaselineRecord>;
    activeBySlot: Record<string, string>;
    idempotency: Record<string, { requestDigest: string; result: VisualBaselineMutationResult }>;
  };
  history: readonly unknown[];
}

export interface VisualBaselineMutationResult {
  baselineId: string;
  slotKey: string;
  identityKey?: string;
  mediaRemoved?: boolean;
  storeRevision: number;
  eventId: string;
  eventType: 'approved' | 'replaced' | 'revoked' | 'deleted';
}

export interface ApprovalInput {
  expectedStoreRevision: number;
  expectedActiveBaselineId?: string | null;
  identity: VisualBaselineIdentity;
  evidence: VisualBaselineEvidence;
  runArtifactRoot: string;
  actorId: string;
  reason: string;
  idempotencyKey: string;
}

export interface LifecycleInput {
  expectedStoreRevision: number;
  baselineId: string;
  actorId: string;
  reason: string;
  idempotencyKey: string;
}

export function openVisualBaselineStore(options: Partial<VisualBaselineStore> & { root: string }): Promise<VisualBaselineStore>;
export function readVisualBaselineStore(store: VisualBaselineStore): Promise<VisualBaselineSnapshot>;
export function withVisualBaselineMutationLock<T>(store: VisualBaselineStore, operation: () => Promise<T>): Promise<T>;
export function isVisualBaselineMutationLocked(store: VisualBaselineStore): Promise<boolean>;
export function approveVisualBaseline(store: VisualBaselineStore, input: ApprovalInput): Promise<VisualBaselineMutationResult>;
export function replaceVisualBaseline(store: VisualBaselineStore, input: ApprovalInput & { expectedActiveBaselineId: string }): Promise<VisualBaselineMutationResult>;
export function revokeVisualBaseline(store: VisualBaselineStore, input: LifecycleInput): Promise<VisualBaselineMutationResult>;
export function deleteVisualBaseline(store: VisualBaselineStore, input: LifecycleInput): Promise<VisualBaselineMutationResult>;
export function resolveVisualBaseline(store: VisualBaselineStore, identity: VisualBaselineIdentity): Promise<{
  status: 'absent' | 'incompatible' | 'unavailable' | 'compatible';
  reason: string;
  baseline: VisualBaselineRecord | null;
  compatibility: unknown;
  mediaPath?: string;
}>;
export function listVisualBaselineHistory(snapshot: VisualBaselineSnapshot, slotKey?: string | null): readonly VisualBaselineRecord[];
