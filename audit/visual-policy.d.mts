import {
  VISUAL_COMPARISON_POLICY_REVISION,
  type VisualReviewStatus,
} from '../shared/visual-baseline-contract.mjs';

export const VISUAL_COMPARISON_POLICY: Readonly<{
  schemaVersion: 1;
  revision: typeof VISUAL_COMPARISON_POLICY_REVISION;
  algorithm: 'pixelmatch';
  maximumDifferingPixelRatio: number;
  includeAA: false;
  threshold: number;
  alpha: number;
  diffColor: readonly [255, 0, 0];
  aaColor: readonly [255, 255, 0];
  dependencies: Readonly<{ pixelmatch: '7.1.0'; pngjs: '7.0.0' }>;
}>;

export interface VisualPolicyEffects {
  deterministicHealth: 'none';
  deterministicFindings: 'none';
  promotion: 'none';
}

export interface VisualComparisonResult {
  schemaVersion: 1;
  policyRevision: typeof VISUAL_COMPARISON_POLICY.revision;
  status: VisualReviewStatus;
  comparisonStatus: 'UNCHANGED' | 'CHANGED' | null;
  differingPixels: number | null;
  totalPixels: number | null;
  differingPixelRatio: number | null;
  reason: string;
  review: null | { reviewerId: string; disposition: string; reviewedAt: string };
  effects: VisualPolicyEffects;
}

export function classifyVisualDifference(input: {
  differingPixels: number;
  totalPixels: number;
}): VisualComparisonResult;

export function visualComparisonUnavailable(
  status: 'absent' | 'incompatible' | 'unavailable',
  reason: string,
): VisualComparisonResult;

export function reviewVisualComparison(
  comparison: VisualComparisonResult,
  input: { reviewerId: string; disposition: string; reviewedAt: string },
): VisualComparisonResult;
