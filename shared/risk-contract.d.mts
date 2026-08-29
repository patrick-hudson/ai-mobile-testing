import type { AuditMode, CertifiedScope } from './release-subject.mjs';
export type RiskAvailability = 'LOADING' | 'PROVISIONAL' | 'AVAILABLE' | 'PARTIAL' | 'EMPTY' | 'UNAVAILABLE';
export type RiskReviewState = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'SUPERSEDED' | 'PENDING_REVIEW' | 'ACCEPTED' | 'DEFECT_CONFIRMED';
export interface RiskRecord {
  schemaVersion: 1;
  identity: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  mode: AuditMode;
  scope: CertifiedScope;
  source: { kind: string; id: string };
  explanation: string;
  recommendedAction: string;
  reviewState: RiskReviewState;
  releaseEffect: 'non-blocking';
  actor: { id: string; kind: string };
  observedAt: string;
  updatedAt: string;
}
export interface RiskRegister { schemaVersion: 1; availability: RiskAvailability; risks: RiskRecord[] }
export const RISK_AVAILABILITY_STATES: readonly RiskAvailability[];
export const RISK_REVIEW_STATES: readonly RiskReviewState[];
export function riskIdentity(value: unknown): string;
export function parseRisk(value: unknown): RiskRecord;
export function parseRiskRegister(value: unknown): RiskRegister;
export function summarizeRiskRegister(value: unknown): {
  availability: RiskAvailability;
  total: number;
  active: number;
  bySeverity: Record<'critical' | 'high' | 'medium' | 'low', number>;
  digest: string;
};
