export type ShadowDimension =
  | 'EXECUTION_MEMBERSHIP'
  | 'RESULT_CLASSIFICATION'
  | 'RELEASE_AUTHORITY'
  | 'RISK_CLASSIFICATION'
  | 'SCOPE_MEMBERSHIP';

export interface ShadowValidationReport {
  schemaVersion: 1;
  kind: 'release-shadow-validation';
  purpose: 'diagnostic-only';
  generatedAt: string;
  matrixDigest: string;
  validationStatus: 'PASS' | 'BLOCKED';
  comparisons: Array<{
    caseId: string;
    title: string;
    governingRequirements: string[];
    dimensions: Array<{
      dimension: ShadowDimension;
      status: 'MATCH' | 'REVIEWED_DIFFERENCE' | 'UNEXPLAINED_DRIFT';
      legacyDigest: string;
      sharedDigest: string;
      reasonCode: string | null;
      governingRequirements: string[];
      reviewed: boolean;
    }>;
  }>;
  summary: {
    cases: number;
    dimensions: number;
    matches: number;
    reviewedDifferences: number;
    unexplainedDrift: number;
  };
  digest: string;
}

export const SHADOW_FORBIDDEN_AUTHORITY_FIELDS: readonly string[];
export function normalizeShadowSource(value: unknown, expectedKind?: 'legacy-shadow-source' | 'shared-shadow-source'): unknown;
export function normalizeLegacyShadowSource(value: unknown): unknown;
export function normalizeSharedShadowSource(value: unknown): unknown;
export function runShadowValidation(input: unknown): ShadowValidationReport;
export function parseShadowValidationReport(value: unknown): ShadowValidationReport;
