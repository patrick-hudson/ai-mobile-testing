import type { ExecutionManifest, OracleResult } from './execution-contract.mjs';
import type { PublicationEnvelope } from './publication-envelope.mjs';
import type { ReleaseDecision } from './release-decision.mjs';
import type { FinalReleaseSubject } from './release-subject.mjs';
import type { RiskAvailability, RiskRecord, RiskRegister } from './risk-contract.mjs';

export type VisualDispositionValue = 'ACCEPTED' | 'DEFECT_CONFIRMED';
export interface VisualDispositionRecord {
  schemaVersion: 1; kind: 'visual-disposition'; reviewRevision: number; runId: string;
  mode: 'single-site' | 'comparative'; subjectDigest: string; executionId: string; riskIdentity: string;
  disposition: VisualDispositionValue; actor: { id: string; kind: string }; rationale: string; at: string;
  supersedes: string | null; previousDigest: string | null; digest: string;
}
export interface SharedReleaseView {
  schemaVersion: 1; subjectDigest: string; decision: ReleaseDecision; riskRegister: RiskRegister;
  decisionRevision: number; riskRevision: number; visualDispositionRevision: number;
}
export interface PublicationView {
  schemaVersion: 1; subjectDigest: string; decision: ReleaseDecision; riskRegister: RiskRegister;
  riskSummary: PublicationEnvelope['riskSummary']; revisions: { run: number; decision: number; risk: number };
  releaseTruth: Record<string, unknown>;
}
export function parseVisualDispositionHistory(values: unknown): readonly VisualDispositionRecord[];
export function appendVisualDisposition(history: unknown, input: {
  schemaVersion: 1; expectedReviewRevision: number; runId: string; mode: 'single-site' | 'comparative';
  subjectDigest: string; executionId: string; riskIdentity: string; disposition: VisualDispositionValue;
  actor: { id: string; kind: string }; rationale: string; at: string;
}): readonly VisualDispositionRecord[];
export function projectSharedReleaseView(input: {
  schemaVersion: 1; runId: string; baseDecisionRevision: number; baseRiskRevision: number;
  finalSubject: FinalReleaseSubject; executionManifest: ExecutionManifest; oracleResults: OracleResult[];
  riskAvailability: RiskAvailability; riskSources: RiskRecord[]; riskLifecycleEvents: unknown[];
  visualDispositions: VisualDispositionRecord[];
}): SharedReleaseView;
export function projectPublicationView(value: unknown): PublicationView;
