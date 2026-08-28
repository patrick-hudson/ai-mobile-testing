import type { ConsoleAuditMode, ConsoleNormalizedRun, ConsoleRunIdentityModel } from './console-view-model.mjs';

export interface ConsoleComparabilityFactor {
  name: string;
  value: string | null;
  available: boolean;
  reason: string;
}

export interface ConsoleComparablePredecessorKey {
  schemaVersion: 1;
  eligible: boolean;
  key: string | null;
  factors: {
    mode: ConsoleComparabilityFactor;
    deployment: ConsoleComparabilityFactor;
    profile: ConsoleComparabilityFactor;
    scope: ConsoleComparabilityFactor;
    targetSet: ConsoleComparabilityFactor;
  };
  reasons: readonly string[];
}

export interface ConsoleComparablePredecessorSelection {
  schemaVersion: 1;
  available: boolean;
  currentRunId: string;
  predecessor: ConsoleNormalizedRun | null;
  key: string | null;
  reason: 'matched' | 'current-run-ineligible' | 'no-compatible-history';
  limitations: readonly string[];
}

export type ProductRiskSourceType = 'finding' | 'visual-review' | 'manual-obligation';
export type ProductRiskAvailability = 'known' | 'unknown' | 'unavailable';

export interface ProductRiskInput {
  identity: string;
  runIdentity: {
    mode: ConsoleAuditMode;
    runId: string;
    key?: string;
  };
  sourceType: ProductRiskSourceType;
  categories?: readonly string[];
  sourceIdentity?: string;
  sourceTimestamp?: string | null;
  sourceComplete?: boolean;
  href?: string | null;
  severity?: string | null;
  blockingIntent?: boolean | 'blocking' | 'non-blocking' | null;
  novelty?: string | null;
  affectedScope?: number | null;
  unresolvedSince?: string | null;
}

export interface ProductRiskFactor<T> {
  raw: T | null;
  availability: ProductRiskAvailability;
  reason: string;
  precedence?: number;
}

export interface ProductRiskRecord {
  schemaVersion: 1;
  identity: string;
  runIdentity: ConsoleRunIdentityModel;
  sourceType: ProductRiskSourceType;
  categories: readonly string[];
  source: {
    identity: string;
    timestamp: string | null;
    complete: boolean;
    href: string | null;
  };
  factors: {
    severity: ProductRiskFactor<string> & { precedence: number };
    blockingIntent: ProductRiskFactor<boolean | 'blocking' | 'non-blocking'> & { precedence: number };
    sourceAuthority: ProductRiskFactor<ProductRiskSourceType> & { precedence: number };
    novelty: ProductRiskFactor<string> & { precedence: number; comparablePredecessor: boolean };
    affectedScope: ProductRiskFactor<number>;
    unresolvedAge: {
      since: string | null;
      ageMs: number | null;
      availability: ProductRiskAvailability;
      reason: string;
    };
    stableIdentity: ProductRiskFactor<string>;
  };
  tuple: readonly {
    name: 'severity' | 'blocking-intent' | 'source-authority' | 'novelty' | 'affected-scope' | 'unresolved-age' | 'stable-identity';
    value: string | number | boolean | null;
    availability: ProductRiskAvailability;
    reason: string;
  }[];
  reasons: readonly string[];
}

export function buildComparablePredecessorKey(run: ConsoleNormalizedRun): ConsoleComparablePredecessorKey;
export function selectComparablePredecessor(
  currentRun: ConsoleNormalizedRun,
  candidates: readonly ConsoleNormalizedRun[],
): ConsoleComparablePredecessorSelection;
export function createProductRiskRecord(
  input: ProductRiskInput,
  options?: { hasComparablePredecessor?: boolean; now?: string | number | Date },
): ProductRiskRecord;
export function compareProductRisk(left: ProductRiskRecord, right: ProductRiskRecord): number;
export function sortProductRisk(records: readonly ProductRiskRecord[]): readonly ProductRiskRecord[];
