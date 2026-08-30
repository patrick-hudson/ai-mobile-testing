import type { ControlPrincipal } from '../../shared/control-plane-contract.mjs';

export const PROMOTION_CLAIM_SCHEMA_VERSION: 2;

export interface PromotionClaimStore {
  root: string;
  clock(): number;
  master: Buffer;
  storage: unknown;
}

export interface PromotionAuthoritySelector {
  phase: 'ACTIVE';
  activationEpoch: 1;
  revision: number;
  activeBuildIdentity: string;
  digest: string;
  [key: string]: unknown;
}

export interface PromotionAuthorityBinding {
  storeMarkerDigest: string;
  storeGeneration: number;
  activationEpoch: 1;
  writerProtocol: string;
  digest: string;
}

export interface PromotionAuthorityContext {
  selector: PromotionAuthoritySelector;
  binding: PromotionAuthorityBinding;
}

export interface PromotionClaimAuthorityBinding {
  storeMarkerDigest: string;
  storeGeneration: number;
  activationEpoch: 1;
  writerProtocol: string;
  selectorDigest: string;
  selectorRevision: number;
  activeBuildIdentity: string;
}

export interface PromotionClaimResult {
  token: string;
  expiresAt: string;
  runId: string;
  subjectDigest: string;
  authority: string;
  runRevision: number;
  decisionRevision: number;
  authorityBinding: PromotionClaimAuthorityBinding;
}

export interface PromotionConsumptionResult {
  consumed: true;
  claimId: string;
  runId: string;
  subjectDigest: string;
  publicationDigest: string;
  consumedAt: string;
  receiptDigest: string;
}

export function openPromotionClaimStore(options: {
  root: string;
  clock?: () => number;
}): Promise<PromotionClaimStore>;

export function issuePromotionClaim(store: PromotionClaimStore, input: {
  principal: ControlPrincipal;
  publication: any;
  authorityContext: PromotionAuthorityContext;
  expected: {
    projectId: string;
    subjectDigest: string;
    authority: string;
    executionSetDigest: string;
    runRevision: number;
    decisionRevision: number;
  };
  ttlMs?: number;
  requestId?: string | null;
}): Promise<PromotionClaimResult>;

export function consumePromotionClaim(store: PromotionClaimStore, token: string, input: {
  principal: ControlPrincipal;
  requestId: string;
  expectedSubjectDigest: string;
  withCurrentPublication: (callback: (publication: any, authorityContext: PromotionAuthorityContext) => Promise<any>) => Promise<any>;
}): Promise<PromotionConsumptionResult>;
