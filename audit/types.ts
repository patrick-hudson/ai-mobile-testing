export type AuditEnvironment = 'production' | 'candidate';

export type AuditSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export type AuditEvidenceMode = 'interaction-video' | 'static-screenshot' | 'structured-data';

export type AuditApplicability =
  | 'all-projects'
  | 'full-sweep-projects'
  | 'candidate-projects'
  | 'production-projects'
  | 'candidate-non-tablet-projects'
  | 'candidate-chromium-projects'
  | 'production-chromium-projects'
  | 'candidate-desktop-projects'
  | 'candidate-desktop-chromium'
  | 'candidate-mobile-projects'
  | 'candidate-mobile-chromium'
  | 'production-mobile-chromium'
  | 'production-desktop-chromium'
  | 'candidate-mobile-webkit'
  | 'candidate-tablet-webkit'
  | 'candidate-desktop-firefox';

export interface AuditEvidencePolicy {
  mode: AuditEvidenceMode;
  rationale: string;
}

export type AuditStatusOverride = 'REVIEW' | 'INTENDED_CHANGE' | 'BLOCKED';

export interface AuditStatusWaiver {
  status: 'INTENDED_CHANGE';
  auditId: string;
  reason: string;
  approvedBy: string;
}

export interface AuditRuntimeExpectation {
  kind: 'response-status' | 'request-failure' | 'page-error' | 'console-error';
  target: string;
  expected: string | number;
  matched: boolean;
}

export interface AuditThirdPartyTelemetryDiagnostic {
  provider: 'cloudflare-rum' | 'google-analytics';
  surface: 'console-error' | 'page-error' | 'http-response';
  message: string;
  sourceUrl: string | null;
  status: number | null;
}

export type AuditArea =
  | 'environment'
  | 'routes'
  | 'shell'
  | 'navigation'
  | 'responsive'
  | 'theme'
  | 'search'
  | 'homepage'
  | 'crisis'
  | 'content'
  | 'calculators'
  | 'sows'
  | 'meetings'
  | 'accessibility'
  | 'reliability'
  | 'performance'
  | 'seo';

export interface AuditDefinition {
  id: string;
  area: AuditArea;
  title: string;
  userPromise: string;
  severity: AuditSeverity;
  releaseBlocking: boolean;
  expected: string;
  evidence: Array<'video' | 'screenshot' | 'trace' | 'json' | 'axe' | 'network' | 'lighthouse'>;
  evidencePolicy: AuditEvidencePolicy;
  manual?: boolean;
}

export interface AuditObservation {
  label: string;
  value: string | number | boolean | null;
  expected?: string;
  timestamp: string;
}

export interface AuditFinding {
  severity: AuditSeverity;
  title: string;
  detail: string;
  blocking: boolean;
}

export interface AuditStepRecord {
  name: string;
  expected: string;
  kind?: 'interaction' | 'runtime-health';
  startedAt: string;
  finishedAt: string;
  status: 'passed' | 'failed';
  detail?: string;
}

export interface PageInspection {
  url: string;
  title: string;
  h1Count: number;
  horizontalOverflowPx: number;
  brokenImages: string[];
  documentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  canonical: string | null;
  robots: string | null;
  description: string | null;
  themeMode: string | null;
}

export interface AuditEvidenceRecord {
  schemaVersion: 1;
  auditId: string;
  definition: AuditDefinition | null;
  evidencePolicy: AuditEvidencePolicy;
  environment: AuditEnvironment;
  coveredEnvironments?: AuditEnvironment[];
  baseURL: string;
  project: string;
  browser: string;
  viewport: { width: number; height: number } | null;
  timezone: string;
  startedAt: string;
  finishedAt: string;
  steps: AuditStepRecord[];
  observations: AuditObservation[];
  findings: AuditFinding[];
  pageInspections: PageInspection[];
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  httpResponses: Array<{
    url: string;
    method: string;
    resourceType: string;
    status: number;
    contentType: string | null;
    fromServiceWorker: boolean;
    firstParty: boolean;
  }>;
  failedRequests: Array<{ url: string; reason: string }>;
  badResponses: Array<{ url: string; status: number }>;
  runtimeExpectations?: AuditRuntimeExpectation[];
  thirdPartyTelemetryDiagnostics?: AuditThirdPartyTelemetryDiagnostic[];
}

export interface AuditProjectMetadata {
  environment: AuditEnvironment;
  browserLabel: string;
  deviceClass: 'mobile' | 'tablet' | 'desktop';
  fullSweep: boolean;
  visual: boolean;
  tlsPolicy: 'strict' | 'ignored-for-development';
}
