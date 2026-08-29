import type { CoordinatorFence, ParentRunStore } from './parent-run-store.mjs';
import type { LegacyAuthorityFence } from './legacy-authority-fence.mjs';

export class SharedCutoverError extends Error {
  code: string;
  details?: unknown;
}

export interface CutoverAdmissionGateDocument {
  schemaVersion: 1;
  kind: 'release-admission-gate';
  state: 'OPEN' | 'CLOSED';
  revision: number;
  cutoverId: string | null;
  previousDigest: string | null;
  updatedAt: string;
  digest: string;
}

export interface CutoverAdmissionGate {
  root: string;
  read(): Promise<CutoverAdmissionGateDocument>;
  withOpen<T>(operation: (gate: CutoverAdmissionGateDocument) => Promise<T> | T): Promise<T>;
  close(expectedDigest: string, cutoverId: string): Promise<CutoverAdmissionGateDocument>;
  open(expectedDigest: string, cutoverId: string): Promise<CutoverAdmissionGateDocument>;
}

export interface SharedCutoverInput {
  cutoverId: string;
  activationRevision: number;
  buildIdentity: string;
  rollbackBuildIdentity: string;
  expectedStore: {
    deploymentIdentity: string;
    volumeIdentity: string;
    storeMarkerDigest: string;
    storeGeneration: number;
    schemaVersion: number;
    schemaFloor: number;
    currentWriterProtocol: string;
    minimumWriterProtocol: string;
    backupMarker: string;
  };
  shadowReport: unknown;
  operatorReview: { reviewed: true; actorId: string; reviewedAt: string };
}

export interface CutoverDrainObservation {
  schemaVersion: 1;
  kind: 'release-cutover-drain-observation';
  cutoverId: string;
  observedAt: string;
  admissionGateDigest: string;
  activeLegacyAuthoritativeRunIds: string[];
  releaseChangingMutationIds: string[];
  unresolvedOperationIds: string[];
  unfencedLegacyLeaseIds: string[];
  canonicalWriterOwnerIds: string[];
  legacyHeadMarkers: string[];
  digest: string;
}

export function openCutoverAdmissionGate(options: {
  root: string;
  filesystem?: any;
  nonce?: () => string;
  verifyStorage?: boolean;
  clock?: () => number;
}): Promise<CutoverAdmissionGate>;

export function initializeCutoverAdmissionGate(options: {
  root: string;
  filesystem?: any;
  nonce?: () => string;
  verifyStorage?: boolean;
  clock?: () => number;
}): Promise<CutoverAdmissionGate>;

export function createCutoverAdmissionPolicy(options: {
  admissionGate: CutoverAdmissionGate;
}): {
  withLaunchAdmission<T>(requestId: string, operation: () => Promise<T>): Promise<T>;
  withPromotionAdmission<T>(requestId: string, operation: () => Promise<T>): Promise<T>;
  withMutationAdmission<T>(kind: string, requestId: string, operation: () => Promise<T>): Promise<T>;
};

export function captureSharedAuthorityDrainObservation(options: {
  store: ParentRunStore;
  coordinator: CoordinatorFence;
  admissionGate: CutoverAdmissionGate;
  legacyAuthorityFence?: LegacyAuthorityFence | null;
  launchOperationStore: any;
  cutoverId: string;
  legacyComparativeRoot: string;
  legacySingleSiteQueueRoot: string;
  clock?: () => number;
}): Promise<CutoverDrainObservation>;

export function prepareSharedAuthorityCutover(options: {
  store: ParentRunStore;
  coordinator: CoordinatorFence;
  admissionGate: CutoverAdmissionGate;
  legacyAuthorityFence?: LegacyAuthorityFence | null;
  reportDirectory: string;
  input: SharedCutoverInput;
  clock?: () => number;
  hooks?: { afterAdmissionClosed?(gate: CutoverAdmissionGateDocument): void | Promise<void>; afterDraining?(selector: any): void | Promise<void> };
}): Promise<any>;

export function activateSharedAuthorityCutover(options: {
  store: ParentRunStore;
  coordinator: CoordinatorFence;
  admissionGate: CutoverAdmissionGate;
  legacyAuthorityFence?: LegacyAuthorityFence | null;
  reportDirectory: string;
  input: SharedCutoverInput;
  drainObservation: CutoverDrainObservation;
  clock?: () => number;
  hooks?: { afterAuthorityActivated?(selector: any): void | Promise<void> };
}): Promise<any>;

export function rollbackSharedAuthorityBeforeActivation(options: {
  store: ParentRunStore;
  coordinator: CoordinatorFence;
  admissionGate: CutoverAdmissionGate;
  legacyAuthorityFence?: LegacyAuthorityFence | null;
  reportDirectory: string;
  cutoverId: string;
  buildIdentity: string;
  operatorReview: { reviewed: true; actorId: string; reviewedAt: string };
  clock?: () => number;
}): Promise<any>;

export function recordSharedCutoverCanary(options: {
  store: ParentRunStore;
  admissionGate: CutoverAdmissionGate;
  reportDirectory: string;
  cutoverId: string;
  mode: 'single-site' | 'comparative';
  runId: string;
  clock?: () => number;
}): Promise<any>;

export function reopenSharedAdmissionAfterCanaries(options: {
  store: ParentRunStore;
  admissionGate: CutoverAdmissionGate;
  reportDirectory: string;
  cutoverId: string;
  clock?: () => number;
}): Promise<any>;

export function setSharedPromotionAvailability(options: {
  store: ParentRunStore;
  coordinator: CoordinatorFence;
  phase: 'ACTIVE' | 'PROMOTION_DISABLED';
  buildIdentity: string;
}): Promise<any>;
