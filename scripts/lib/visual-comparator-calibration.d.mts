export interface VisualComparatorCalibrationBinding {
  schemaVersion: 1;
  kind: 'visual-comparator-calibration-binding';
  corpusRevision: string;
  corpusDigest: string;
  policyRevision: string;
  dependencies: { pixelmatch: string; pngjs: string };
  defectCases: number;
  acceptedNoiseCases: number;
  verificationDigest: string;
}

export const VISUAL_COMPARATOR_CALIBRATION_REVISION: string;
export const VISUAL_COMPARATOR_CALIBRATION_CORPUS_DIGEST: string;
export function verifyVisualComparatorCalibration(options?: {
  corpusDirectory?: string;
  revision?: string;
  currentRevision?: string;
}): Promise<Readonly<VisualComparatorCalibrationBinding>>;
export function verifyPublishedVisualComparatorCalibration(
  binding: unknown,
  options?: { currentRevision?: string },
): Promise<Readonly<VisualComparatorCalibrationBinding>>;
export function verifiedVisualComparisonDependencies(
  calibration: VisualComparatorCalibrationBinding,
): VisualComparisonDependencies;
export function visualComparatorCalibrationEqual(left: unknown, right: unknown): boolean;
import type { VisualComparisonDependencies } from '../compare-visual-baselines.mjs';
