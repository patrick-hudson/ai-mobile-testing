import type { SingleSiteReportInput } from './site-health-report.mjs';
import type { VisualComparatorCalibrationBinding } from './visual-comparator-calibration.mjs';

export interface SingleSiteVisualComparisonPublication {
  schemaVersion: 1;
  kind: 'single-site-visual-comparison-publication';
  mode: 'single-site';
  runId: string;
  generatedAt: string;
  comparatorCalibration: VisualComparatorCalibrationBinding;
  publicationDigest: string;
  policyEffects: { deterministicHealth: 'none'; deterministicFindings: 'none'; promotion: 'none' };
  summary: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
}

export function collectSingleSiteVisualCaptures(
  playwrightResults: unknown,
  deterministicFindings?: unknown[],
): readonly Record<string, unknown>[];
export function publishSingleSiteVisualComparisons(options: {
  playwrightResults: unknown;
  deterministicFindings: unknown[];
  artifactRoot: string;
  baselineStore: unknown;
  outputDir: string;
  jobId: string;
  attemptId: string;
  finalizationDigest: string;
  reportRevision: string;
  generatedAt: string;
  runStatus: 'completed' | 'failed' | 'incomplete' | 'cancelled';
  evidenceComplete: boolean;
  evidenceAuthority: { status: 'authoritative' | 'non-authoritative'; reasons: string[] };
}): Promise<SingleSiteVisualComparisonPublication>;
export function readSingleSiteVisualComparisonPublication(options: {
  outputDir: string;
  jobId: string;
  attemptId: string;
  finalizationDigest: string;
  reportRevision: string;
}): Promise<SingleSiteVisualComparisonPublication>;
export function applyVisualComparisonsToSingleSiteReportInput(
  reportInput: SingleSiteReportInput,
  publication: SingleSiteVisualComparisonPublication,
): SingleSiteReportInput;
