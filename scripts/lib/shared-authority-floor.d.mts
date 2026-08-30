export class SharedAuthorityFloorError extends Error {
  code: string;
  details?: unknown;
  statusCode: number;
}

export interface SharedAuthorityFloorDocument {
  schemaVersion: 1;
  kind: 'shared-release-authority-floor';
  revision: number;
  storeMarkerDigest: string;
  minimumStoreGeneration: number;
  minimumSelectorRevision: number;
  activeBuildIdentity: string | null;
  authorityTransitionDigest: string | null;
  activationEpoch: 0 | 1;
  legacyPermanentlyRetired: boolean;
  activationRevision: number | null;
  activationCutoverDigest: string | null;
  previousDigest: string | null;
  updatedAt: string;
  digest: string;
}

export interface SharedAuthorityFloorInitial {
  storeMarkerDigest: string;
  minimumStoreGeneration: number;
  minimumSelectorRevision: number;
  activeBuildIdentity: string | null;
  authorityTransitionDigest: string | null;
  activationEpoch: 0 | 1;
  legacyPermanentlyRetired: boolean;
  activationRevision: number | null;
  activationCutoverDigest: string | null;
}

export interface SharedAuthorityFloorState {
  manifest: {
    storeMarkerDigest: string;
    storeGeneration: number;
    activationEpoch: 0 | 1;
    activationRevision: number | null;
  };
  selector: {
    storeMarkerDigest: string;
    storeGeneration: number;
    activationEpoch: 0 | 1;
    activationRevision: number | null;
    revision: number;
    activeBuildIdentity: string | null;
    phase: string;
    activationCutoverDigest: string | null;
    authorityTransitionDigest: string | null;
  };
  legacyFence: { state: string; activationEpoch: 0 | 1 };
}

export interface SharedAuthorityRestoreForwardPlan {
  schemaVersion: 1;
  kind: 'shared-authority-restore-forward-plan';
  planId: string;
  createdAt: string;
  basedOnFloorDigest: string;
  storeMarkerDigest: string;
  previousMinimumStoreGeneration: number;
  restoredStoreGeneration: number;
  nextStoreGeneration: number;
  previousMinimumSelectorRevision: number;
  restoredSelectorRevision: number;
  nextSelectorRevision: number;
  activeBuildIdentity: string;
  previousAuthorityTransitionDigest: string;
  nextAuthorityTransitionDigest: string;
  activationEpoch: 1;
  activationRevision: number;
  activationCutoverDigest: string;
  requiredSelectorPhase: 'PROMOTION_DISABLED';
  requiredLegacyFenceState: 'ACTIVATED';
  invalidatesPriorReleaseBindings: true;
  requiresNewAuthoritativeRuns: true;
  digest: string;
}

export interface SharedAuthorityRestoreForwardReceipt {
  schemaVersion: 1;
  kind: 'shared-authority-restore-forward-receipt';
  planId: string;
  planDigest: string;
  completedAt: string;
  previousFloorDigest: string;
  resultingFloorDigest: string;
  storeMarkerDigest: string;
  previousMinimumStoreGeneration: number;
  minimumStoreGeneration: number;
  previousMinimumSelectorRevision: number;
  minimumSelectorRevision: number;
  activeBuildIdentity: string;
  previousAuthorityTransitionDigest: string;
  authorityTransitionDigest: string;
  activationEpoch: 1;
  activationRevision: number;
  activationCutoverDigest: string;
  authorityStateDigest: string;
  selectorPhase: 'PROMOTION_DISABLED';
  legacyFenceState: 'ACTIVATED';
  invalidatesPriorReleaseBindings: true;
  requiresNewAuthoritativeRuns: true;
  digest: string;
}

export interface SharedAuthorityFloor {
  root: string;
  read(): Promise<SharedAuthorityFloorDocument>;
  compareAndAdvance(expectedDigest: string, update: Partial<SharedAuthorityFloorInitial>): Promise<SharedAuthorityFloorDocument>;
  assertAuthorityState(state: SharedAuthorityFloorState): Promise<SharedAuthorityFloorDocument>;
  planRestoreForward(input: {
    expectedDigest: string;
    planId: string;
    restoredStoreGeneration: number;
    restoredSelectorRevision: number;
  }): Promise<SharedAuthorityRestoreForwardPlan>;
  completeRestoreForward(input: {
    plan: unknown;
    expectedFloorDigest: string;
    state: SharedAuthorityFloorState;
  }): Promise<SharedAuthorityRestoreForwardReceipt>;
}

export interface SharedAuthorityFloorOptions {
  root: string;
  protectedRoots: string[];
  filesystem?: any;
  nonce?: () => string;
  verifyStorage?: boolean;
  clock?: () => number;
}

export function parseSharedAuthorityFloor(value: unknown): SharedAuthorityFloorDocument;
export function parseSharedAuthorityRestoreReceipt(value: unknown): SharedAuthorityRestoreForwardReceipt;
export function initializeSharedAuthorityFloor(
  options: SharedAuthorityFloorOptions & { initial: SharedAuthorityFloorInitial },
): Promise<SharedAuthorityFloor>;
export function openSharedAuthorityFloor(options: SharedAuthorityFloorOptions): Promise<SharedAuthorityFloor>;
