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
export interface CoreBoundIncompleteReleaseDecision {
  schemaVersion: 1;
  kind: 'release-decision';
  subjectStage: 'core';
  runId: string;
  decisionRevision: number;
  subjectDigest: string;
  compilationFailureDigest: string;
  executionManifestDigest: null;
  mode: 'single-site' | 'comparative';
  requestedAuthority: { qualifier: 'FULL' | 'TARGETED'; scope: CertifiedScope };
  grantedAuthority: null;
  certifiedScope: null;
  coverageBasis: null;
  code: 'NOT_READY_INCOMPLETE_EXECUTION';
  label: string;
  ready: false;
  blockingReasons: Array<{ class: 'incomplete-execution'; executionId: string; detail: string }>;
  superseded: false;
  exitCode: 1;
  digest: string;
}
export type AnyReleaseDecision = ReleaseDecision | CoreBoundIncompleteReleaseDecision;
export const RELEASE_DECISION_CODES: readonly ReleaseDecisionCode[];
export function deriveReleaseDecision(value: unknown): ReleaseDecision;
export function deriveCompilationFailureDecision(value: unknown): CoreBoundIncompleteReleaseDecision;
export function parseReleaseDecision(value: unknown): AnyReleaseDecision;
export function assertConsumableReleaseDecision(value: unknown, expected: {
  expectedSubjectDigest: string;
  expectedAuthority: 'FULL' | 'TARGETED';
  currentDecisionRevision: number;
}): ReleaseDecision;
