import {
  __testOnlyPublishSingleSiteVisualComparisons,
  __testOnlyReadSingleSiteVisualComparisonPublication,
} from './single-site-visual-comparisons.mjs';

export function publishSingleSiteVisualComparisonsForTest(options, dependencies) {
  return __testOnlyPublishSingleSiteVisualComparisons(options, dependencies);
}

export function readSingleSiteVisualComparisonPublicationForTest(options, simulatedCurrentCalibrationRevision) {
  return __testOnlyReadSingleSiteVisualComparisonPublication(options, simulatedCurrentCalibrationRevision);
}
