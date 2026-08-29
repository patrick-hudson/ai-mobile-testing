export type RiskSourceProducer = 'visual' | 'baseline' | 'evidence-pipeline';
export type RiskSourceProducerStatus = 'COMPLETE' | 'NOT_APPLICABLE' | 'UNAVAILABLE';

export interface RiskSourceObservation {
  producer: RiskSourceProducer;
  category: 'unreviewed-visual-change' | 'production-baseline-defect' | 'evidence-pipeline-limitation';
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: { kind: 'visual-result' | 'baseline-result' | 'evidence-pipeline'; id: string };
  explanation: string;
  recommendedAction: string;
  reviewState: 'PENDING_REVIEW' | 'OPEN';
  observedAt: string;
}

export interface RiskSourceObservationSet {
  schemaVersion: 1;
  kind: 'risk-source-observation-set';
  runId: string;
  workItemId: string;
  subjectCoreDigest: string;
  attempt: number;
  workerId: string;
  producerStates: Array<{ producer: RiskSourceProducer; status: RiskSourceProducerStatus }>;
  observations: RiskSourceObservation[];
  digest: string;
}

export interface CompileRiskInputs {
  schemaVersion: 1;
  kind: 'sealed-compile-risk-inputs';
  subjectCoreDigest: string;
  manualObligations: Array<{
    id: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    explanation: string;
    recommendedAction: string;
  }>;
  digest: string;
}

export const RISK_SOURCE_PRODUCERS: readonly RiskSourceProducer[];
export const RISK_SOURCE_PRODUCER_STATES: readonly RiskSourceProducerStatus[];
export function sealRiskSourceObservationSet(value: Omit<RiskSourceObservationSet, 'kind' | 'digest'>): RiskSourceObservationSet;
export function parseRiskSourceObservationSet(value: unknown): RiskSourceObservationSet;
export function sealCompileRiskInputs(value: Omit<CompileRiskInputs, 'kind' | 'digest'>): CompileRiskInputs;
export function parseCompileRiskInputs(value: unknown): CompileRiskInputs;
