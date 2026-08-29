import type { CertifiedScope } from './release-subject.mjs';
export type ReleaseDecisionCode = 'RELEASE_READY' | 'FEATURE_READY' | 'NOT_READY_TEST_FAILURE' | 'NOT_READY_INCOMPLETE_EXECUTION';
export interface ReleaseDecision {
  schemaVersion: 1;
  kind: 'release-decision';
  runId: string;
  decisionRevision: number;
  subjectDigest: string;
  executionManifestDigest: string;
  mode: 'single-site' | 'comparative';
  grantedAuthority: 'FULL' | 'TARGETED';
  certifiedScope: CertifiedScope;
  coverageBasis: { selectedDefinitions: string[]; selectedTargets: string[]; excludedAsNotApplicable: string[] };
  code: ReleaseDecisionCode;
  label: string;
  ready: boolean;
  blockingReasons: Array<{ class: 'product-failure' | 'incomplete-execution' | 'operational-incident'; executionId: string; detail: string }>;
  superseded: boolean;
  exitCode: 0 | 1;
  digest: string;
}
export const RELEASE_DECISION_CODES: readonly ReleaseDecisionCode[];
export function deriveReleaseDecision(value: unknown): ReleaseDecision;
export function parseReleaseDecision(value: unknown): ReleaseDecision;
export function assertConsumableReleaseDecision(value: unknown, expected: {
  expectedSubjectDigest: string;
  expectedAuthority: 'FULL' | 'TARGETED';
  currentDecisionRevision: number;
}): ReleaseDecision;
