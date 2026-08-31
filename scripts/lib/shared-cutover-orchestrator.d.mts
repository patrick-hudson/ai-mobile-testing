import type { CoordinatorFence, ParentRunStore } from './parent-run-store.mjs';
import type { LegacyAuthorityFence } from './legacy-authority-fence.mjs';
import type { SharedStoreBackupRehearsalReceipt } from './shared-store-backup-rehearsal.mjs';
import type { SharedAuthorityFloor } from './shared-authority-floor.mjs';

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
  withState<T>(operation: (gate: CutoverAdmissionGateDocument) => Promise<T> | T): Promise<T>;
  withOpen<T>(operation: (gate: CutoverAdmissionGateDocument) => Promise<T> | T): Promise<T>;
  close(expectedDigest: string, cutoverId: string): Promise<CutoverAdmissionGateDocument>;
  closeWithTransaction(
    expectedDigest: string,
    cutoverId: string,
    transaction: (
      gate: CutoverAdmissionGateDocument,
      commit: () => Promise<CutoverAdmissionGateDocument>,
    ) => void | Promise<void>,
  ): Promise<CutoverAdmissionGateDocument>;
  open(expectedDigest: string, cutoverId: string): Promise<CutoverAdmissionGateDocument>;
  transferClosed(
    expectedDigest: string,
    fromCutoverId: string,
    toCutoverId: string,
    transaction: (
      gate: CutoverAdmissionGateDocument,
      commit: () => Promise<CutoverAdmissionGateDocument>,
    ) => void | Promise<void>,
  ): Promise<CutoverAdmissionGateDocument>;
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
  backupRehearsalReceipt: SharedStoreBackupRehearsalReceipt;
  backupRoot: string;
  restoreRoot: string;
  operatorReview: {
    reviewed: true;
    actorId: string;
    reviewedAt: string;
    shadowValidationDigest: string;
    shadowMatrixDigest: string;
    buildIdentity: string;
    expectedStoreDigest: string;
    configurationDigest: string;
    backupRehearsalReceiptDigest: string;
  };
}

export function sharedCutoverConfigurationDigest(input: Pick<SharedCutoverInput,
  'cutoverId' | 'activationRevision' | 'buildIdentity' | 'rollbackBuildIdentity' | 'expectedStore'
>): string;

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
  store?: ParentRunStore | null;
}): {
  withLaunchAdmission<T>(requestId: string, operation: () => Promise<T>): Promise<T>;
  withLaunchAdmission<T>(requestId: string, intent: unknown, operation: () => Promise<T>): Promise<T>;
  withPromotionAdmission<T>(requestId: string, operation: () => Promise<T>): Promise<T>;
  withMutationAdmission<T>(kind: string, requestId: string, operation: () => Promise<T>): Promise<T>;
  withMutationAdmission<T>(kind: string, requestId: string, context: { runId: string }, operation: () => Promise<T>): Promise<T>;
};

export function authorizeSharedCutoverCanaryLaunch(options: {
  store: ParentRunStore;
  admissionGate: CutoverAdmissionGate;
  reportDirectory: string;
  cutoverId: string;
  mode: 'single-site' | 'comparative';
  requestId: string;
  actor: { id: string; kind: 'human' | 'service' };
  intent: unknown;
  supersedeReason?: string | null;
  probeTargetIdentity?: (intent: unknown) => Promise<unknown> | unknown;
  clock?: () => number;
  hooks?: { afterSupersessionFence?(fence: any): void | Promise<void> };
}): Promise<any>;

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
  probeTargetIdentity?: (state: unknown) => Promise<unknown> | unknown;
  readCanaryEvidence?: (store: ParentRunStore, runId: string, options?: {
    probeTargetIdentity?: (state: unknown) => Promise<unknown> | unknown;
  }) => Promise<unknown> | unknown;
  clock?: () => number;
}): Promise<any>;

export function reopenSharedAdmissionAfterCanaries(options: {
  store: ParentRunStore;
  admissionGate: CutoverAdmissionGate;
  reportDirectory: string;
  cutoverId: string;
  probeTargetIdentity?: (state: unknown) => Promise<unknown> | unknown;
  readCanaryEvidence?: (store: ParentRunStore, runId: string, options?: {
    probeTargetIdentity?: (state: unknown) => Promise<unknown> | unknown;
  }) => Promise<unknown> | unknown;
  clock?: () => number;
}): Promise<any>;

export function setSharedPromotionAvailability(options: {
  store: ParentRunStore;
  coordinator: CoordinatorFence;
  phase: 'ACTIVE' | 'PROMOTION_DISABLED';
  buildIdentity: string;
  reportDirectory?: string | null;
  cutoverId?: string | null;
  healthCanaries?: { 'single-site': string; comparative: string } | null;
  probeTargetIdentity?: (state: unknown) => Promise<unknown> | unknown;
  readCanaryEvidence?: (store: ParentRunStore, runId: string, options?: {
    probeTargetIdentity?: (state: unknown) => Promise<unknown> | unknown;
  }) => Promise<unknown> | unknown;
  transitionWithPublicationFence?: (store: ParentRunStore, coordinator: CoordinatorFence, input: unknown) => Promise<unknown>;
  clock?: () => number;
}): Promise<any>;

export function prepareSharedAuthorityBuildHandoff(options: {
  store: ParentRunStore;
  coordinator: CoordinatorFence;
  admissionGate: CutoverAdmissionGate;
  legacyAuthorityFence: LegacyAuthorityFence;
  authorityFloor: SharedAuthorityFloor;
  reportDirectory: string;
  handoffId: string;
  targetBuildIdentity: string;
  adoptClosedAdmissionFromCutoverId?: string | null;
  operatorReview: { reviewed: true; actorId: string; reviewedAt: string };
  clock?: () => number;
  hooks?: {
    afterAdmissionIntentPersisted?(intent: any): void | Promise<void>;
    beforeAdmissionTransferCommit?(selector: any): void | Promise<void>;
    afterAdmissionTransferred?(gate: CutoverAdmissionGateDocument): void | Promise<void>;
    afterAdmissionClosed?(gate: CutoverAdmissionGateDocument): void | Promise<void>;
  };
}): Promise<any>;

export function prequalifySharedAuthorityBuild(options: {
  store: ParentRunStore;
  coordinator: CoordinatorFence;
  legacyAuthorityFence: LegacyAuthorityFence;
  authorityFloor: SharedAuthorityFloor;
  reportDirectory: string;
  prequalificationId: string;
  targetBuildIdentity: string;
  compatibilityProof: {
    schemaVersion: 1;
    kind: 'shared-build-compatibility-proof';
    targetBuildIdentity: string;
    runnerRevision: string;
    imageDigest: string;
    validationDigest: string;
    generatedAt: string;
    digest: string;
  };
  operatorReview: { reviewed: true; actorId: string; reviewedAt: string };
  clock?: () => number;
  hooks?: {
    afterIntentPersisted?(intent: any): void | Promise<void>;
    afterManifestCommitted?(manifest: any): void | Promise<void>;
    afterSelectorCommitted?(selector: any): void | Promise<void>;
    afterAuthorityFloorAdvanced?(floor: any): void | Promise<void>;
  };
}): Promise<any>;

export function beginSharedAuthorityBuildHandoff(options: {
  store: ParentRunStore;
  coordinator: CoordinatorFence;
  admissionGate: CutoverAdmissionGate;
  legacyAuthorityFence: LegacyAuthorityFence;
  reportDirectory: string;
  handoffId: string;
  drainObservation: CutoverDrainObservation;
  clock?: () => number;
  hooks?: { afterPendingSelector?(selector: any): void | Promise<void> };
}): Promise<any>;

export function authorizeSharedBuildHandoffCanaryLaunch(options: {
  store: ParentRunStore;
  admissionGate: CutoverAdmissionGate;
  reportDirectory: string;
  handoffId: string;
  mode: 'single-site' | 'comparative';
  runId: string;
  requestId: string;
  actor: { id: string; kind: 'human' | 'service' };
  intent: unknown;
  supersedeReason?: string | null;
  probeTargetIdentity?: (intent: unknown) => Promise<unknown> | unknown;
  clock?: () => number;
}): Promise<any>;

export function recordSharedBuildHandoffCanary(options: {
  store: ParentRunStore;
  admissionGate: CutoverAdmissionGate;
  reportDirectory: string;
  handoffId: string;
  mode: 'single-site' | 'comparative';
  runId: string;
  probeTargetIdentity?: (state: unknown) => Promise<unknown> | unknown;
  readCanaryEvidence?: (store: ParentRunStore, runId: string, options?: {
    probeTargetIdentity?: (state: unknown) => Promise<unknown> | unknown;
  }) => Promise<unknown> | unknown;
  clock?: () => number;
}): Promise<any>;

export function completeSharedAuthorityBuildHandoff(options: {
  store: ParentRunStore;
  coordinator: CoordinatorFence;
  admissionGate: CutoverAdmissionGate;
  legacyAuthorityFence: LegacyAuthorityFence;
  authorityFloor: SharedAuthorityFloor;
  reportDirectory: string;
  handoffId: string;
  probeTargetIdentity: (state: unknown) => Promise<unknown> | unknown;
  readCanaryEvidence?: (store: ParentRunStore, runId: string, options?: {
    probeTargetIdentity?: (state: unknown) => Promise<unknown> | unknown;
  }) => Promise<unknown> | unknown;
  clock?: () => number;
  hooks?: {
    afterCommitIntentPersisted?(intent: any): void | Promise<void>;
    afterAuthorityFloorAdvanced?(floor: any): void | Promise<void>;
    afterAuthorityCommitted?(selector: any): void | Promise<void>;
    afterAdmissionOpened?(gate: CutoverAdmissionGateDocument): void | Promise<void>;
  };
}): Promise<any>;
