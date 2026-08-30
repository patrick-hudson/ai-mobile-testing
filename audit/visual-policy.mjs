import { parseTimestamp, VISUAL_COMPARISON_POLICY_REVISION } from '../shared/visual-baseline-contract.mjs';

export const VISUAL_COMPARISON_POLICY = Object.freeze({
  schemaVersion: 1,
  revision: VISUAL_COMPARISON_POLICY_REVISION,
  algorithm: 'pixelmatch',
  maximumDifferingPixelRatio: 0.0025,
  includeAA: false,
  threshold: 0.1,
  alpha: 0.1,
  diffColor: [255, 0, 0],
  aaColor: [255, 255, 0],
  dependencies: Object.freeze({ pixelmatch: '7.1.0', pngjs: '7.0.0' }),
});

const NO_EFFECT = Object.freeze({
  deterministicHealth: 'none',
  deterministicFindings: 'none',
  promotion: 'none',
});

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
  return value;
}

function explanation(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim() || value.length > 1_200) {
    throw new TypeError(`${label} must be a non-empty string of at most 1200 characters.`);
  }
  return value;
}

function actorId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new TypeError('reviewerId is invalid.');
  }
  return value;
}

export function classifyVisualDifference(input) {
  const differingPixels = count(input.differingPixels, 'differingPixels');
  const totalPixels = count(input.totalPixels, 'totalPixels');
  if (totalPixels < 1 || differingPixels > totalPixels) {
    throw new TypeError('Visual comparison pixel counts are inconsistent.');
  }
  const differingPixelRatio = differingPixels / totalPixels;
  const status = differingPixelRatio <= VISUAL_COMPARISON_POLICY.maximumDifferingPixelRatio
    ? 'UNCHANGED'
    : 'CHANGED';
  return Object.freeze({
    schemaVersion: 1,
    policyRevision: VISUAL_COMPARISON_POLICY.revision,
    status,
    comparisonStatus: status,
    differingPixels,
    totalPixels,
    differingPixelRatio,
    reason: status === 'UNCHANGED'
      ? `Pixel difference ratio ${differingPixelRatio} is within the ${VISUAL_COMPARISON_POLICY.maximumDifferingPixelRatio} reviewed tolerance.`
      : `Pixel difference ratio ${differingPixelRatio} exceeds the ${VISUAL_COMPARISON_POLICY.maximumDifferingPixelRatio} reviewed tolerance.`,
    review: null,
    effects: NO_EFFECT,
  });
}

export function visualComparisonUnavailable(status, reason) {
  return Object.freeze({
    schemaVersion: 1,
    policyRevision: VISUAL_COMPARISON_POLICY.revision,
    status,
    comparisonStatus: null,
    differingPixels: null,
    totalPixels: null,
    differingPixelRatio: null,
    reason: explanation(reason, 'visual comparison reason'),
    review: null,
    effects: NO_EFFECT,
  });
}

export function reviewVisualComparison(comparison, input) {
  if (!comparison || !['CHANGED', 'UNCHANGED'].includes(comparison.status)
    || !comparison.comparisonStatus || comparison.review !== null) {
    throw new TypeError('Only an unreviewed compatible pixel comparison may receive a human disposition.');
  }
  return Object.freeze({
    ...comparison,
    status: 'REVIEWED',
    review: {
      reviewerId: actorId(input.reviewerId),
      disposition: explanation(input.disposition, 'visual review disposition'),
      reviewedAt: parseTimestamp(input.reviewedAt, 'visual review reviewedAt'),
    },
    effects: NO_EFFECT,
  });
}
