import type { VisualComparisonDependencies } from '../compare-visual-baselines.ts';
import type { SingleSiteVisualComparisonPublication } from './single-site-visual-comparisons.mjs';

export function publishSingleSiteVisualComparisonsForTest(
  options: Parameters<typeof import('./single-site-visual-comparisons.mjs').publishSingleSiteVisualComparisons>[0],
  dependencies: VisualComparisonDependencies,
): Promise<SingleSiteVisualComparisonPublication>;

export function readSingleSiteVisualComparisonPublicationForTest(
  options: Parameters<typeof import('./single-site-visual-comparisons.mjs').readSingleSiteVisualComparisonPublication>[0],
  simulatedCurrentCalibrationRevision: string,
): Promise<SingleSiteVisualComparisonPublication>;
