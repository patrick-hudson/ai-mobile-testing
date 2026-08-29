import type { AnyReleaseDecision } from './release-decision.mjs';
import type { RiskRegister } from './risk-contract.mjs';
export interface PublicationEnvelope {
  schemaVersion: 1;
  kind: 'release-publication-envelope';
  runId: string;
  runRevision: number;
  decisionRevision: number;
  riskRevision: number;
  ledgerSequences: { observations: number; decisions: number; risks: number };
  previousEnvelopeDigest: string | null;
  subjectCoreDigest?: string;
  finalSubjectDigest: string | null;
  decision: AnyReleaseDecision;
  riskRegister: RiskRegister;
  riskSummary: { availability: string; total: number; active: number; bySeverity: Record<string, number>; digest: string };
  digest: string;
}
export function appendPublicationEnvelope(previous: PublicationEnvelope | null, value: unknown): PublicationEnvelope;
export function parsePublicationEnvelope(value: unknown): PublicationEnvelope;
export function verifyPublicationChain(values: unknown): readonly PublicationEnvelope[];
