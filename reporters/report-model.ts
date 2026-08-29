import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ALL_AUDIT_CATALOG, INSTALLED_PLUGIN_REGISTRY } from '../audit/definitions.js';
import {
  evidenceKindsForPolicy,
  parseAuditApplicabilityAnnotation,
  parseAuditStatusAnnotation,
  parseEvidencePolicyAnnotation,
} from '../audit/evidence-policy.js';
import type {
  AuditDefinition,
  AuditApplicability,
  AuditEnvironment,
  AuditEvidenceRecord,
  AuditFinding,
  AuditProjectMetadata,
} from '../audit/types.js';
import { targetMatchesAuditApplicability } from '../shared/target-applicability.mjs';
import { parsePublicationEnvelope } from '../shared/publication-envelope.mjs';
import type { PublicationEnvelope } from '../shared/publication-envelope.mjs';
import type { ReleaseDecision } from '../shared/release-decision.mjs';
import type { RiskRegister } from '../shared/risk-contract.mjs';
import {
  type SingleSiteReportInput,
  type SingleSiteReportSummary,
} from '../scripts/lib/site-health-report.mjs';
import { writeSingleSiteReportPublication } from '../scripts/lib/single-site-report-writer.mjs';
import type { GalleryArchiveDescriptor, GalleryCatalog } from '../shared/gallery-contract.mjs';
import {
  buildGalleryEvidenceModel,
  writeGalleryArchive,
  type NormalizedGalleryTest,
} from './gallery-model.js';

export type ChecklistStatus =
  | 'PASS'
  | 'FAIL'
  | 'FLAKY'
  | 'REVIEW'
  | 'INTENDED_CHANGE'
  | 'BLOCKED'
  | 'NOT_RUN'
  | 'MANUAL_REQUIRED';

export interface SharedReleaseReportProjection {
  subjectDigest: string;
  decision: ReleaseDecision;
  risks: RiskRegister;
  riskSummary: PublicationEnvelope['riskSummary'];
  revisions: { run: number; decision: number; risk: number };
}

export function projectSharedReleasePublication(value: unknown): SharedReleaseReportProjection {
  const envelope = parsePublicationEnvelope(value);
  return {
    subjectDigest: envelope.finalSubjectDigest,
    decision: envelope.decision,
    risks: envelope.riskRegister,
    riskSummary: envelope.riskSummary,
    revisions: {
      run: envelope.runRevision,
      decision: envelope.decisionRevision,
      risk: envelope.riskRevision,
    },
  };
}

export interface ReportAttachmentInput {
  name: string;
  contentType: string;
  path?: string;
  body?: Buffer;
  mediaValidation?: 'accepted' | 'rejected' | 'pending';
}

export interface ReportErrorInput {
  message?: string;
  stack?: string;
  snippet?: string;
  value?: string;
}

export interface ReportResultInput {
  status: string;
  expectedStatus?: string;
  duration: number;
  retry: number;
  startedAt?: string;
  errors: ReportErrorInput[];
  attachments: ReportAttachmentInput[];
  stdout: string[];
  stderr: string[];
}

export interface ReportTestInput {
  id: string;
  title: string;
  titlePath: string[];
  file: string;
  line?: number;
  column?: number;
  projectName: string;
  projectMetadata?: Partial<AuditProjectMetadata>;
  sourceShard?: { ordinal: number; total: number };
  tags?: string[];
  annotations?: Array<{ type: string; description?: string }>;
  results: ReportResultInput[];
}

export interface ReportProjectInput {
  id?: string;
  name: string;
  metadata?: Partial<AuditProjectMetadata>;
}

export interface ReportRunInput {
  status: string;
  startedAt?: string;
  durationMs?: number;
  source: 'playwright-reporter' | 'playwright-json';
  profile?: string;
  errors?: ReportErrorInput[];
  integrityFailures?: Array<{
    stage: string;
    reason: string;
    exitCode: number | null;
    signal: string | null;
    logPath: string | null;
  }>;
}

export interface ReportArtifact {
  name: string;
  kind: 'video' | 'screenshot' | 'trace' | 'axe' | 'network' | 'lighthouse' | 'json' | 'other';
  contentType: string;
  href: string | null;
  sourcePath: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  available: boolean;
  poster?: {
    name: string;
    contentType: 'image/jpeg';
    href: string;
    sourcePath: string;
    sizeBytes: number;
    sha256: string;
  };
  posterError?: string;
  error?: string;
}

export interface ReportExecution {
  id: string;
  sourceTestId: string;
  auditId: string;
  title: string;
  titlePath: string[];
  location: { file: string; line: number | null; column: number | null };
  project: string;
  environment: AuditEnvironment | 'unknown';
  coveredEnvironments: AuditEnvironment[];
  browser: string;
  deviceClass: AuditProjectMetadata['deviceClass'] | 'unknown';
  tlsPolicy: AuditProjectMetadata['tlsPolicy'] | 'unknown';
  status: ChecklistStatus;
  evidenceAuthority: 'authoritative' | 'withheld';
  reasonCodes: Array<
    | 'FLAKY_RETRY'
    | 'TLS_BYPASS'
    | 'MISSING_REQUIRED_EVIDENCE'
    | 'MISSING_EVIDENCE_POLICY'
    | 'EVIDENCE_POLICY_MISMATCH'
    | 'MISSING_ACTION_STEP'
    | 'FORBIDDEN_PRIMARY_MEDIA'
    | 'INVALID_STATUS_ANNOTATION'
  >;
  rawStatus: string;
  expectedStatus: string | null;
  retry: number;
  attempts: number;
  durationMs: number;
  startedAt: string | null;
  structuredEvidence: boolean;
  evidence: AuditEvidenceRecord | null;
  evidencePolicy: AuditDefinition['evidencePolicy'] | null;
  requiredEvidence: AuditDefinition['evidence'];
  errors: ReportErrorInput[];
  stdout: string[];
  stderr: string[];
  attemptHistory: Array<{
    attempt: number;
    retry: number;
    status: string;
    durationMs: number;
    startedAt: string | null;
    structuredEvidence: boolean;
    errors: ReportErrorInput[];
    artifacts: ReportArtifact[];
  }>;
  artifacts: ReportArtifact[];
  primaryArtifacts: ReportArtifact[];
  diagnosticArtifacts: ReportArtifact[];
  annotations: Array<{ type: string; description?: string }>;
  applicability: AuditApplicability | null;
  applicableToProject: boolean | null;
}

export interface AuditChecklistItem {
  id: string;
  definition: AuditDefinition;
  status: ChecklistStatus;
  reason: string;
  catalogued: boolean;
  manual: boolean;
  crossEnvironmentGate: boolean;
  executions: ReportExecution[];
  environmentStatus: {
    candidate: ChecklistStatus;
    production: ChecklistStatus;
    unknown: ChecklistStatus;
  };
  baseline: {
    hasIssues: boolean;
    issueCount: number;
    note: string;
  };
  coverage: {
    production: number;
    candidate: number;
    unknown: number;
    projects: string[];
    selectedProjects: string[];
    plannedApplicableProjects: string[];
    missingApplicableProjects: string[];
    selected: { production: number; candidate: number; unknown: number; total: number };
    applicable: { production: number; candidate: number; unknown: number; total: number };
    skipped: { production: number; candidate: number; unknown: number; total: number };
    missingApplicable: { production: number; candidate: number; unknown: number; total: number };
  };
  evidenceCounts: Record<ReportArtifact['kind'], number>;
  findings: AuditFinding[];
}

export interface AuditManifest {
  schemaVersion: 1;
  generatedAt: string;
  run: {
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    source: ReportRunInput['source'];
    profile: string;
    errors: ReportErrorInput[];
    integrityFailures: NonNullable<ReportRunInput['integrityFailures']>;
  };
  release: {
    ready: boolean;
    decision: 'READY' | 'NOT_READY' | 'UNAVAILABLE';
    blockingFailures: number;
    blockingIncomplete: number;
    baselineIssues: number;
    runIntegrityFailure: boolean;
    reason: string;
    decisionBasis: string;
    diagnosticCountsAuthoritative: boolean;
    authoritativeReleaseSource: 'checklist/manifest.json' | 'sharded-run.json';
  };
  summary: {
    total: number;
    catalogued: number;
    executed: number;
    structuredExecutions: number;
    artifacts: number;
    videos: number;
    usableInteractionVideos: number;
    diagnosticVideos: number;
    posters: number;
    byStatus: Record<ChecklistStatus, number>;
    byArea: Record<string, number>;
    bySeverity: Record<string, number>;
    baselineIssues: number;
  };
  audits: AuditChecklistItem[];
  unmappedTests: Array<{
    id: string;
    title: string;
    titlePath: string[];
    file: string;
    line: number | null;
    projectName: string;
    rawStatuses: string[];
  }>;
  warnings: string[];
}

interface PortalReportFinding {
  severity: AuditFinding['severity'];
  title: string;
  detail: string;
  blocking: boolean;
}

interface PortalReportAttentionItem {
  auditId: string;
  auditTitle: string;
  area: AuditDefinition['area'];
  auditStatus: ChecklistStatus;
  severity: AuditDefinition['severity'];
  releaseBlocking: boolean;
  scope: 'candidate' | 'cross-environment' | 'unknown';
  detail: string;
  errorContext: string | null;
  reasonCodes: ReportExecution['reasonCodes'];
  baselineNonGating: boolean;
  baselineNote: string | null;
  evidence: Array<{
    name: string;
    kind: ReportArtifact['kind'];
    href: string;
    sizeBytes: number | null;
    attempt: number;
    context: 'final-primary' | 'final-diagnostic';
  }>;
}

interface PortalReportAuditRow {
  id: string;
  area: AuditDefinition['area'];
  title: string;
  userPromise: string;
  severity: AuditDefinition['severity'];
  releaseBlocking: boolean;
  expected: string;
  requiredEvidence: AuditDefinition['evidence'];
  evidencePolicy: AuditDefinition['evidencePolicy'];
  status: ChecklistStatus;
  reason: string;
  manual: boolean;
  crossEnvironmentGate: boolean;
  environments: Array<AuditEnvironment | 'unknown'>;
  environmentStatus: AuditChecklistItem['environmentStatus'];
  baseline: AuditChecklistItem['baseline'];
  coverage: AuditChecklistItem['coverage'];
  evidenceCounts: AuditChecklistItem['evidenceCounts'];
  findingCount: number;
  findingPreview: PortalReportFinding[];
  executionCount: number;
}

const PORTAL_REPORT_MAX_TEXT = 1_200;
const PORTAL_REPORT_MAX_DETAIL_BYTES = 480 * 1024;
const PORTAL_REPORT_MAX_EXECUTIONS = 40;
const PORTAL_REPORT_MAX_ARTIFACTS = 16;
const PORTAL_REPORT_MAX_EVIDENCE_ITEMS = 16;

export interface GenerateReportOptions {
  /** Omitted only for legacy comparative callers. */
  mode?: 'comparative';
  outputDir: string;
  tests: ReportTestInput[];
  run: ReportRunInput;
  cwd?: string;
  definitionCatalog?: readonly AuditDefinition[];
  /** Complete resolved Playwright project selection, including projects that emitted no test rows. */
  selectedProjects?: readonly ReportProjectInput[];
}

const STATUS_ORDER: ChecklistStatus[] = [
  'FAIL',
  'BLOCKED',
  'FLAKY',
  'REVIEW',
  'MANUAL_REQUIRED',
  'NOT_RUN',
  'INTENDED_CHANGE',
  'PASS',
];

const REGISTRY_APPLICABILITY_BY_AUDIT = new Map<string, Set<AuditApplicability>>();
for (const auditCase of INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ auditCases }) => auditCases)) {
  const values = REGISTRY_APPLICABILITY_BY_AUDIT.get(auditCase.auditId) ?? new Set<AuditApplicability>();
  values.add(auditCase.applicability);
  REGISTRY_APPLICABILITY_BY_AUDIT.set(auditCase.auditId, values);
}

function reportProjectEngine(projectName: string): string {
  if (projectName.includes('webkit')) return 'webkit';
  if (projectName.includes('firefox')) return 'firefox';
  if (projectName.includes('chromium') || projectName.includes('msedge')) return 'chromium';
  return 'unknown';
}

function comparativeMetadataEnvironment(
  metadata: Partial<AuditProjectMetadata> | undefined,
): AuditEnvironment | undefined {
  if (!metadata || !('environment' in metadata)) return undefined;
  return metadata.environment === 'candidate' || metadata.environment === 'production'
    ? metadata.environment
    : undefined;
}

function resolvedSelectedProjects(options: GenerateReportOptions): ReportProjectInput[] {
  if (options.selectedProjects !== undefined) {
    return [...options.selectedProjects].sort((left, right) => left.name.localeCompare(right.name));
  }
  const projects = new Map<string, ReportProjectInput>();
  for (const test of options.tests) {
    projects.set(test.projectName, {
      name: test.projectName,
      metadata: { ...(test.projectMetadata ?? {}) },
    });
  }
  return [...projects.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function projectMatchesApplicability(project: ReportProjectInput, applicability: AuditApplicability): boolean {
  const metadata = project.metadata;
  const environment = comparativeMetadataEnvironment(metadata);
  if (!environment || !metadata?.deviceClass) return false;
  return targetMatchesAuditApplicability(applicability, {
    // Applicability IDs are public project names. Playwright JSON's optional
    // internal project ID is only useful while resolving result rows.
    id: project.name,
    environment,
    deviceClass: metadata.deviceClass,
    engine: reportProjectEngine(project.name),
    fullSweep: metadata.fullSweep === true,
  });
}

function withMissingApplicableProjects(
  aggregate: { status: ChecklistStatus; reason: string },
  projects: readonly ReportProjectInput[],
): { status: ChecklistStatus; reason: string } {
  if (projects.length === 0 || ['FAIL', 'BLOCKED', 'FLAKY', 'REVIEW'].includes(aggregate.status)) return aggregate;
  return {
    status: 'NOT_RUN',
    reason: `${projects.length} selected applicable project${projects.length === 1 ? '' : 's'} emitted no completed execution for this audit: ${projects.map(({ name }) => name).join(', ')}.`,
  };
}

type ReviewedGalleryAttempt = GalleryCatalog['items'][number]['attempt'] & {
  rawStatus: string;
  statusSource: 'reviewed-manifest' | 'release-integrity';
  reviewReasonCodes: string[];
};

function executionReviewedStatus(execution: ReportExecution): ChecklistStatus {
  if (
    execution.evidenceAuthority === 'withheld'
    && ['PASS', 'INTENDED_CHANGE'].includes(execution.status)
  ) return 'REVIEW';
  return execution.status;
}

function worstReviewedStatus(executions: ReportExecution[]): ChecklistStatus {
  return executions
    .map(executionReviewedStatus)
    .sort((left, right) => STATUS_ORDER.indexOf(left) - STATUS_ORDER.indexOf(right))[0] ?? 'REVIEW';
}

/**
 * Sealed archives use reviewed checklist truth. The live reporter deliberately
 * bypasses this projection and remains a provisional view of raw Playwright state.
 */
export function projectReviewedExecutionTruth(
  catalog: GalleryCatalog,
  executions: readonly ReportExecution[],
): GalleryCatalog {
  for (const item of catalog.items) {
    const auditIds = new Set(item.auditAssociations.map(({ id }) => id));
    const unknownAuditIds = item.auditAssociations
      .filter(({ catalogOrdinal }) => catalogOrdinal === null)
      .map(({ id }) => id);
    const matches = executions.filter((execution) => (
      execution.sourceTestId === item.test.id
      && execution.project === item.project.name
      && auditIds.has(execution.auditId)
    ));
    const matchedAuditIds = new Set(matches.map(({ auditId }) => auditId));
    const uncoveredKnownAuditIds = item.auditAssociations
      .filter(({ catalogOrdinal, id }) => catalogOrdinal !== null && !matchedAuditIds.has(id))
      .map(({ id }) => id);
    const rawStatus = item.attempt.status;
    if (matches.length === 0 || unknownAuditIds.length > 0 || uncoveredKnownAuditIds.length > 0) {
      const integrityReasons = [
        ...(auditIds.size === 0 ? ['UNMAPPED_TEST'] : []),
        ...(unknownAuditIds.length > 0 ? ['UNKNOWN_AUDIT_ID'] : []),
        ...(uncoveredKnownAuditIds.length > 0 ? ['UNCOVERED_AUDIT_ASSOCIATION'] : []),
      ];
      item.attempt = {
        ...item.attempt,
        rawStatus,
        status: 'REVIEW',
        statusSource: 'release-integrity',
        reviewReasonCodes: integrityReasons.length > 0 ? integrityReasons : ['UNKNOWN_AUDIT_ID'],
      } as ReviewedGalleryAttempt;
      continue;
    }
    const reviewedStatus = worstReviewedStatus(matches);
    const reasonCodes = [...new Set(matches.flatMap((execution) => [
      ...execution.reasonCodes,
      ...(execution.status === 'FAIL' ? ['ASSERTION_FAIL'] : []),
      ...(execution.status === 'BLOCKED' ? ['EXPLICIT_BLOCKER'] : []),
      ...(execution.status === 'REVIEW' && execution.reasonCodes.length === 0 ? ['HUMAN_REVIEW'] : []),
    ]))]
      .map((value) => value.replace(/[^A-Z0-9_:-]+/gi, '_').slice(0, 120))
      .filter(Boolean)
      .slice(0, 12);
    item.attempt = {
      ...item.attempt,
      rawStatus,
      status: reviewedStatus,
      statusSource: 'reviewed-manifest',
      reviewReasonCodes: reasonCodes,
    } as ReviewedGalleryAttempt;
  }
  return catalog;
}

// These contracts explicitly require evidence from both origins. Other rows
// assess the candidate for release while retaining production failures as
// visible baseline context. This prevents a redesign that fixes an existing
// production defect from being vetoed by that same baseline defect.
const CROSS_ENVIRONMENT_GATES = new Set(['ENV-001', 'ENV-003', 'ENV-005', 'CONTENT-008']);

function safeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return cleaned || 'item';
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function recordHasUnexpectedRuntimeFailure(record: AuditEvidenceRecord): boolean {
  return record.pageErrors.length > 0
    || record.consoleErrors.length > 0
    || record.failedRequests.length > 0
    || record.badResponses.length > 0
    || (record.runtimeExpectations ?? []).some(({ matched }) => !matched);
}

function executionStatus(
  result: ReportResultInput,
  record: AuditEvidenceRecord | null,
  statusOverride: ChecklistStatus | null,
): ChecklistStatus {
  if (result.status === 'skipped' || result.status === 'interrupted') return 'NOT_RUN';
  if (result.status === 'timedOut' || result.status === 'failed') return 'FAIL';
  if (result.status !== 'passed') return 'REVIEW';
  if (record?.findings.some((finding) => finding.blocking)) return 'FAIL';
  if (record?.steps.some((step) => step.status === 'failed')) return 'FAIL';
  if (record && recordHasUnexpectedRuntimeFailure(record)) return 'FAIL';
  if (statusOverride) return statusOverride;
  if (!record) return 'REVIEW';
  if (record.findings.length > 0) return 'REVIEW';
  return 'PASS';
}

function aggregateStatus(definition: AuditDefinition, executions: ReportExecution[]): { status: ChecklistStatus; reason: string } {
  if (executions.length === 0) {
    if (definition.manual) return { status: 'MANUAL_REQUIRED', reason: 'This catalog entry requires human acceptance evidence.' };
    return { status: 'NOT_RUN', reason: 'No matching automated execution was recorded.' };
  }

  const applicableExecutions = executions.filter((execution) => execution.status !== 'NOT_RUN');
  if (applicableExecutions.length === 0) {
    return { status: 'NOT_RUN', reason: 'Every matched execution was skipped or interrupted.' };
  }
  const statuses = new Set(applicableExecutions.map((execution) => execution.status));
  const hadFailedRetry = applicableExecutions.some((execution) => execution.attempts > 1 && execution.status === 'PASS');
  if (statuses.has('FAIL')) return { status: 'FAIL', reason: 'At least one execution failed or reported a blocking finding.' };
  if (statuses.has('BLOCKED')) return { status: 'BLOCKED', reason: 'At least one execution is explicitly blocked.' };
  if (hadFailedRetry || statuses.has('FLAKY')) return { status: 'FLAKY', reason: 'A passing execution required a retry.' };
  if (applicableExecutions.some((execution) => execution.evidenceAuthority === 'withheld')) {
    return { status: 'REVIEW', reason: 'The observed behavior passed, but one or more evidence-integrity conditions withhold release authority.' };
  }
  if (statuses.has('REVIEW')) return { status: 'REVIEW', reason: 'Evidence or non-blocking findings require human review.' };
  if (statuses.has('INTENDED_CHANGE')) {
    return { status: 'INTENDED_CHANGE', reason: 'The result is marked as an intentional, reviewable redesign difference.' };
  }
  return { status: 'PASS', reason: 'All recorded executions passed with structured audit evidence and no findings.' };
}

function emptyEvidenceCounts(): Record<ReportArtifact['kind'], number> {
  return { video: 0, screenshot: 0, trace: 0, axe: 0, network: 0, lighthouse: 0, json: 0, other: 0 };
}

function latestResult(test: ReportTestInput): ReportResultInput | null {
  if (test.results.length === 0) return null;
  return test.results[test.results.length - 1] ?? null;
}

function failedEarlierAttempt(test: ReportTestInput): boolean {
  if (test.results.length < 2) return false;
  return test.results.slice(0, -1).some((result) => result.status !== 'passed' && result.status !== 'skipped');
}

async function buildExecutions(
  tests: NormalizedGalleryTest[],
  warnings: string[],
  definitionCatalog: readonly AuditDefinition[],
): Promise<{ byAuditId: Map<string, ReportExecution[]>; definitions: Map<string, AuditDefinition>; unmapped: ReportTestInput[] }> {
  const byAuditId = new Map<string, ReportExecution[]>();
  const definitions = new Map<string, AuditDefinition>(definitionCatalog.map((definition) => [definition.id, definition]));
  const unmapped: ReportTestInput[] = [];
  const unmappedKeys = new Set<string>();
  const markUnmapped = (test: ReportTestInput): void => {
    const key = `${test.id}\u0000${test.projectName}`;
    if (unmappedKeys.has(key)) return;
    unmappedKeys.add(key);
    unmapped.push(test);
  };

  for (const normalizedTest of tests) {
    const test = normalizedTest.source;
    const result = latestResult(test);
    if (!result) {
      const declaredAuditIds = normalizedTest.auditIds;
      if (declaredAuditIds.length === 0) {
        markUnmapped(test);
      } else {
        for (const auditId of declaredAuditIds) {
          if (!definitions.has(auditId)) markUnmapped(test);
        }
      }
      continue;
    }
    const recordsByAttempt = normalizedTest.attempts.map((attempt) => attempt.evidenceRecords);
    const records = normalizedTest.evidenceRecords;
    const auditIds = normalizedTest.auditIds;
    if (auditIds.length === 0) {
      markUnmapped(test);
      continue;
    }

    for (const auditId of auditIds) {
      if (!definitions.has(auditId)) {
        markUnmapped(test);
        warnings.push(`${auditId} / ${test.projectName}: executed audit ID is absent from the authoritative definition catalog.`);
        continue;
      }
      const latestAttemptRecords = recordsByAttempt[recordsByAttempt.length - 1] ?? [];
      const record = latestAttemptRecords.find((candidate) => candidate.auditId === auditId) ?? null;

      const environment = record?.environment ?? comparativeMetadataEnvironment(test.projectMetadata) ?? 'unknown';
      const coveredEnvironments = [...new Set(
        (record?.coveredEnvironments ?? (environment === 'unknown' ? [] : [environment]))
          .filter((candidate): candidate is AuditEnvironment => candidate === 'candidate' || candidate === 'production'),
      )].sort();
      const attemptHistory = normalizedTest.attempts.map((attempt, attemptIndex) => {
        return {
          attempt: attemptIndex + 1,
          retry: attempt.result.retry,
          status: attempt.result.status,
          durationMs: attempt.result.duration,
          startedAt: attempt.result.startedAt ?? null,
          structuredEvidence: recordsByAttempt[attemptIndex]?.some((candidate) => candidate.auditId === auditId) ?? false,
          errors: attempt.result.errors,
          artifacts: attempt.artifacts,
        };
      });
      const artifacts = attemptHistory.flatMap((attempt) => attempt.artifacts);
      const finalArtifacts = attemptHistory.at(-1)?.artifacts ?? [];
      for (const artifact of artifacts) {
        if (!artifact.available) warnings.push(`${auditId}: could not copy ${artifact.name}: ${artifact.error ?? 'unknown error'}`);
        if (artifact.posterError) warnings.push(`${auditId}: could not copy poster for ${artifact.name}: ${artifact.posterError}`);
      }

      let statusOverride: ChecklistStatus | null = null;
      let invalidStatusAnnotation: string | null = null;
      try {
        statusOverride = parseAuditStatusAnnotation(test.annotations, auditId);
      } catch (error) {
        invalidStatusAnnotation = error instanceof Error ? error.message : String(error);
      }
      let status = executionStatus(result, record, statusOverride);
      if (status === 'PASS' && failedEarlierAttempt(test)) status = 'FLAKY';
      const definition = definitions.get(auditId)!;
      const evidencePolicy = parseEvidencePolicyAnnotation(test.annotations);
      const applicability = parseAuditApplicabilityAnnotation(test.annotations);
      const projectMetadata = test.projectMetadata;
      const projectEnvironment = comparativeMetadataEnvironment(projectMetadata);
      const applicableToProject = applicability && projectEnvironment
        ? targetMatchesAuditApplicability(applicability, {
            id: test.projectName,
            environment: projectEnvironment,
            deviceClass: projectMetadata?.deviceClass ?? 'desktop',
            engine: reportProjectEngine(test.projectName),
            fullSweep: projectMetadata?.fullSweep === true,
          })
        : null;
      const requiredEvidence = evidencePolicy
        ? evidenceKindsForPolicy(definition.evidence, evidencePolicy)
        : definition.evidence;
      const purposefulScreenshot = (artifact: ReportArtifact): boolean => (
        artifact.kind === 'screenshot'
        && artifact.available
        && artifact.name !== 'screenshot'
        && !/automatic[-_ ]static[-_ ]evidence/i.test(artifact.name)
      );
      const permittedPrimaryMedia = (artifact: ReportArtifact): boolean => {
        if (!evidencePolicy) return false;
        if (evidencePolicy.mode === 'interaction-video') return artifact.kind === 'video' && artifact.available;
        if (evidencePolicy.mode === 'static-screenshot') return purposefulScreenshot(artifact);
        return false;
      };
      const isMedia = (artifact: ReportArtifact): boolean => artifact.kind === 'video' || artifact.kind === 'screenshot';
      const primaryArtifacts = finalArtifacts.filter((artifact) => (
        !isMedia(artifact) || (result.status === 'passed' && permittedPrimaryMedia(artifact))
      ));
      const diagnosticArtifacts = artifacts.filter((artifact) => !primaryArtifacts.includes(artifact));
      const reasonCodes: ReportExecution['reasonCodes'] = [];
      let evidenceAuthority: ReportExecution['evidenceAuthority'] = 'authoritative';
      const withholdAuthority = (code: ReportExecution['reasonCodes'][number], warning: string): void => {
        evidenceAuthority = 'withheld';
        if (!reasonCodes.includes(code)) reasonCodes.push(code);
        warnings.push(warning);
      };
      if (status !== 'NOT_RUN') {
        const availableKinds = new Set(primaryArtifacts.filter((artifact) => artifact.available).map((artifact) => artifact.kind));
        const missingKinds = requiredEvidence.filter((kind) => !availableKinds.has(kind));
        if (missingKinds.length > 0) {
          withholdAuthority(
            'MISSING_REQUIRED_EVIDENCE',
            `${auditId} / ${test.projectName}: missing required ${missingKinds.join(', ')} evidence from the final attempt.`,
          );
        }
      }
      if (status !== 'NOT_RUN' && !evidencePolicy) {
        withholdAuthority(
          'MISSING_EVIDENCE_POLICY',
          `${auditId} / ${test.projectName}: missing or invalid explicit audit-evidence-policy annotation.`,
        );
      }
      if (status !== 'NOT_RUN' && record?.evidencePolicy && evidencePolicy
        && (record.evidencePolicy.mode !== evidencePolicy.mode || record.evidencePolicy.rationale !== evidencePolicy.rationale)) {
        withholdAuthority(
          'EVIDENCE_POLICY_MISMATCH',
          `${auditId} / ${test.projectName}: structured evidence policy does not match its test declaration.`,
        );
      }
      if (
        status !== 'NOT_RUN'
        && evidencePolicy?.mode === 'interaction-video'
        && record
        && !record.steps.some((step) => (
          step.kind === 'interaction'
          || (step.kind === undefined && step.name !== 'Inspect browser runtime health')
        ))
      ) {
        withholdAuthority(
          'MISSING_ACTION_STEP',
          `${auditId} / ${test.projectName}: interaction evidence has no recorded user action/response step.`,
        );
      }
      const forbiddenPrimaryMedia = result.status === 'passed'
        ? finalArtifacts.filter((artifact) => isMedia(artifact) && !permittedPrimaryMedia(artifact))
        : [];
      if (forbiddenPrimaryMedia.length > 0) {
        withholdAuthority(
          'FORBIDDEN_PRIMARY_MEDIA',
          `${auditId} / ${test.projectName}: ${forbiddenPrimaryMedia.map(({ name }) => name).join(', ')} violate the ${evidencePolicy?.mode ?? 'undeclared'} primary-media policy.`,
        );
      }
      if (invalidStatusAnnotation) {
        withholdAuthority(
          'INVALID_STATUS_ANNOTATION',
          `${auditId} / ${test.projectName}: ${invalidStatusAnnotation}`,
        );
      }
      const tlsPolicy = test.projectMetadata?.tlsPolicy ?? 'unknown';
      if (status !== 'NOT_RUN' && coveredEnvironments.includes('candidate') && tlsPolicy === 'ignored-for-development') {
        withholdAuthority(
          'TLS_BYPASS',
          `${auditId} / ${test.projectName}: candidate certificate verification was bypassed for development; this evidence cannot make the release READY.`,
        );
      }
      if (status === 'FLAKY') reasonCodes.push('FLAKY_RETRY');
      const execution: ReportExecution = {
        id: `${safeSegment(auditId)}-${stableId(`${test.id}:${test.projectName}`)}`,
        sourceTestId: test.id,
        auditId,
        title: test.title,
        titlePath: test.titlePath,
        location: { file: test.file, line: test.line ?? null, column: test.column ?? null },
        project: test.projectName,
        environment,
        coveredEnvironments,
        browser: record?.browser ?? test.projectMetadata?.browserLabel ?? test.projectName,
        deviceClass: test.projectMetadata?.deviceClass ?? 'unknown',
        tlsPolicy,
        status,
        evidenceAuthority,
        reasonCodes,
        rawStatus: result.status,
        expectedStatus: result.expectedStatus ?? null,
        retry: result.retry,
        attempts: test.results.length,
        durationMs: result.duration,
        startedAt: result.startedAt ?? null,
        structuredEvidence: Boolean(record),
        evidence: record,
        evidencePolicy,
        requiredEvidence,
        errors: result.errors,
        stdout: result.stdout,
        stderr: result.stderr,
        attemptHistory,
        artifacts,
        primaryArtifacts,
        diagnosticArtifacts,
        annotations: test.annotations ?? [],
        applicability,
        applicableToProject,
      };
      const existing = byAuditId.get(auditId) ?? [];
      existing.push(execution);
      byAuditId.set(auditId, existing);
    }
  }

  return { byAuditId, definitions, unmapped };
}

function statusCounts(): Record<ChecklistStatus, number> {
  return {
    PASS: 0,
    FAIL: 0,
    FLAKY: 0,
    REVIEW: 0,
    INTENDED_CHANGE: 0,
    BLOCKED: 0,
    NOT_RUN: 0,
    MANUAL_REQUIRED: 0,
  };
}

export interface AuditReportModels {
  manifest: AuditManifest;
  galleryCatalog: GalleryCatalog;
}

function assertComparativeReportInput(options: GenerateReportOptions): void {
  if ((options as GenerateReportOptions & { mode?: unknown }).mode !== undefined && options.mode !== 'comparative') {
    throw new Error('Single-site data cannot be passed to the comparative release report builder.');
  }
  const singleSiteProjects = [
    ...options.tests.map(({ projectName, projectMetadata }) => ({ name: projectName, metadata: projectMetadata })),
    ...(options.selectedProjects ?? []).map(({ name, metadata }) => ({ name, metadata })),
  ].filter(({ metadata }) => metadata?.mode === 'single-site');
  if (singleSiteProjects.length > 0) {
    const names = [...new Set(singleSiteProjects.map(({ name }) => name))].sort();
    throw new Error(
      `Single-site project data cannot be passed to the comparative release report builder: ${names.join(', ')}. `
      + 'Finalize it with writeSingleSiteAuditReport and frozen Site Health input instead.',
    );
  }
}

export async function buildAuditModels(options: GenerateReportOptions): Promise<AuditReportModels> {
  assertComparativeReportInput(options);
  const outputDir = path.resolve(options.cwd ?? process.cwd(), options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const warnings: string[] = [];
  const definitionCatalog = options.definitionCatalog ?? ALL_AUDIT_CATALOG;
  const evidenceModel = await buildGalleryEvidenceModel({
    ...options,
    outputDir,
    definitionCatalog,
    warnings,
  });
  const { byAuditId, definitions, unmapped } = await buildExecutions(
    evidenceModel.tests,
    warnings,
    definitionCatalog,
  );
  const selectedProjects = resolvedSelectedProjects(options);

  const catalogOrder = new Map(definitionCatalog.map((definition, index) => [definition.id, index]));
  const catalogIds = new Set(definitionCatalog.map(({ id }) => id));
  const audits = [...definitions.values()]
    .map((definition): AuditChecklistItem => {
      const executions = byAuditId.get(definition.id) ?? [];
      const plannedApplicabilities = new Set<AuditApplicability>([
        ...(REGISTRY_APPLICABILITY_BY_AUDIT.get(definition.id) ?? []),
        ...executions.flatMap(({ applicability }) => applicability ? [applicability] : []),
      ]);
      const plannedApplicableProjects = selectedProjects.filter((project) => (
        [...plannedApplicabilities].some((applicability) => projectMatchesApplicability(project, applicability))
      ));
      const missingApplicableProjects = plannedApplicableProjects.filter((project) => !executions.some((execution) => (
        execution.project === project.name
        && execution.status !== 'NOT_RUN'
        && execution.applicableToProject !== false
      )));
      const candidateExecutions = executions.filter((execution) => execution.coveredEnvironments.includes('candidate'));
      const productionExecutions = executions.filter((execution) => execution.coveredEnvironments.includes('production'));
      const unknownExecutions = executions.filter((execution) => execution.coveredEnvironments.length === 0);
      const crossEnvironmentGate = CROSS_ENVIRONMENT_GATES.has(definition.id);
      const releaseExecutions = crossEnvironmentGate ? executions : [...candidateExecutions, ...unknownExecutions];
      const releaseMissingProjects = missingApplicableProjects.filter(({ metadata }) => (
        crossEnvironmentGate || comparativeMetadataEnvironment(metadata) !== 'production'
      ));
      let aggregate = withMissingApplicableProjects(aggregateStatus(definition, releaseExecutions), releaseMissingProjects);
      const candidateAggregate = withMissingApplicableProjects(
        aggregateStatus(definition, candidateExecutions),
        missingApplicableProjects.filter(({ metadata }) => comparativeMetadataEnvironment(metadata) === 'candidate'),
      );
      const productionAggregate = withMissingApplicableProjects(
        aggregateStatus(definition, productionExecutions),
        missingApplicableProjects.filter(({ metadata }) => comparativeMetadataEnvironment(metadata) === 'production'),
      );
      const unknownAggregate = withMissingApplicableProjects(
        aggregateStatus(definition, unknownExecutions),
        missingApplicableProjects.filter(({ metadata }) => !comparativeMetadataEnvironment(metadata)),
      );
      if (
        crossEnvironmentGate
        && !['FAIL', 'BLOCKED', 'FLAKY', 'REVIEW'].includes(aggregate.status)
        && (
          ['NOT_RUN', 'MANUAL_REQUIRED'].includes(candidateAggregate.status)
          || ['NOT_RUN', 'MANUAL_REQUIRED'].includes(productionAggregate.status)
        )
      ) {
        aggregate = {
          status: 'NOT_RUN',
          reason: 'This cross-environment contract is incomplete until both production and candidate have applicable evidence.',
        };
      }
      const baselineIssueExecutions = productionExecutions.filter((execution) =>
        execution.status !== 'NOT_RUN'
        && (
          ['FAIL', 'BLOCKED', 'FLAKY', 'REVIEW'].includes(execution.status)
          || execution.evidenceAuthority === 'withheld'
        ));
      const baselineHasIssues = baselineIssueExecutions.length > 0;
      const evidenceCounts = emptyEvidenceCounts();
      for (const execution of executions) {
        for (const artifact of execution.primaryArtifacts) {
          if (artifact.available) evidenceCounts[artifact.kind] += 1;
        }
      }
      const applicableExecutions = executions.filter((execution) => execution.status !== 'NOT_RUN');
      const skippedExecutions = executions.filter((execution) => execution.status === 'NOT_RUN');
      const countEnvironment = (
        collection: ReportExecution[],
        environment: AuditEnvironment | 'unknown',
      ): number => collection.filter((execution) => (
        environment === 'unknown'
          ? execution.coveredEnvironments.length === 0
          : execution.coveredEnvironments.includes(environment)
      )).length;
      const coverageCounts = (collection: ReportExecution[]) => ({
        production: countEnvironment(collection, 'production'),
        candidate: countEnvironment(collection, 'candidate'),
        unknown: countEnvironment(collection, 'unknown'),
        total: collection.length,
      });
      const selectedCoverage = coverageCounts(executions);
      const applicableCoverage = coverageCounts(applicableExecutions);
      const skippedCoverage = coverageCounts(skippedExecutions);
      const missingApplicableCoverage = {
        production: missingApplicableProjects.filter(({ metadata }) => comparativeMetadataEnvironment(metadata) === 'production').length,
        candidate: missingApplicableProjects.filter(({ metadata }) => comparativeMetadataEnvironment(metadata) === 'candidate').length,
        unknown: missingApplicableProjects.filter(({ metadata }) => !comparativeMetadataEnvironment(metadata)).length,
        total: missingApplicableProjects.length,
      };
      return {
        id: definition.id,
        definition,
        status: aggregate.status,
        reason: !crossEnvironmentGate && baselineHasIssues
          ? `${aggregate.reason} ${baselineIssueExecutions.length} production-baseline execution${baselineIssueExecutions.length === 1 ? '' : 's'} also need attention; they remain visible as comparison context and do not gate this candidate check.`
          : aggregate.reason,
        catalogued: catalogIds.has(definition.id),
        manual: definition.manual ?? false,
        crossEnvironmentGate,
        executions,
        environmentStatus: {
          candidate: candidateAggregate.status,
          production: productionAggregate.status,
          unknown: unknownAggregate.status,
        },
        baseline: {
          hasIssues: baselineHasIssues,
          issueCount: baselineIssueExecutions.length,
          note: crossEnvironmentGate
            ? 'Production evidence is part of this explicit cross-environment release contract.'
            : baselineHasIssues
              ? 'Production issues are preserved as baseline context but do not veto a candidate that fixes them.'
              : applicableCoverage.production === 0
                ? 'Production baseline was not tested for this check.'
                : 'The tested production baseline recorded no issue for this check.',
        },
        coverage: {
          production: applicableCoverage.production,
          candidate: applicableCoverage.candidate,
          unknown: applicableCoverage.unknown,
          projects: [...new Set(applicableExecutions.map((execution) => execution.project))].sort(),
          selectedProjects: selectedProjects.map(({ name }) => name),
          plannedApplicableProjects: plannedApplicableProjects.map(({ name }) => name),
          missingApplicableProjects: missingApplicableProjects.map(({ name }) => name),
          selected: selectedCoverage,
          applicable: applicableCoverage,
          skipped: skippedCoverage,
          missingApplicable: missingApplicableCoverage,
        },
        evidenceCounts,
        findings: executions.flatMap((execution) => execution.evidence?.findings ?? []),
      };
    })
    .sort((left, right) => {
      const leftCatalog = catalogOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightCatalog = catalogOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftCatalog !== rightCatalog) return leftCatalog - rightCatalog;
      return left.id.localeCompare(right.id);
    });

  const byStatus = statusCounts();
  const byArea: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const item of audits) {
    byStatus[item.status] += 1;
    byArea[item.definition.area] = (byArea[item.definition.area] ?? 0) + 1;
    bySeverity[item.definition.severity] = (bySeverity[item.definition.severity] ?? 0) + 1;
  }
  const allExecutions = audits.flatMap((item) => item.executions);
  const availableVideoArtifacts = allExecutions.flatMap((execution) => (
    execution.artifacts
      .filter((artifact) => artifact.kind === 'video' && artifact.available)
      .map((artifact) => ({ execution, artifact }))
  ));
  const usableInteractionVideos = availableVideoArtifacts.filter(({ execution, artifact }) => (
    execution.evidenceAuthority === 'authoritative'
    && execution.evidencePolicy?.mode === 'interaction-video'
    && execution.primaryArtifacts.includes(artifact)
  )).length;
  const diagnosticVideos = availableVideoArtifacts.length - usableInteractionVideos;
  const blockingFailures = audits.filter(
    (item) => item.definition.releaseBlocking && ['FAIL', 'BLOCKED', 'FLAKY', 'REVIEW'].includes(item.status),
  ).length;
  const blockingIncomplete = audits.filter(
    (item) => item.definition.releaseBlocking && ['NOT_RUN', 'MANUAL_REQUIRED'].includes(item.status),
  ).length;
  const baselineIssues = audits.filter((item) => item.baseline.hasIssues).length;
  const unknownAuditPresent = unmapped.length > 0;
  const knownTerminalFailure = allExecutions.some((execution) => ['failed', 'timedOut'].includes(execution.rawStatus));
  const unexplainedRunFailure = options.run.status !== 'passed' && !knownTerminalFailure;
  const pipelineIntegrityFailures = options.run.integrityFailures ?? [];
  const runIntegrityFailure = unknownAuditPresent
    || allExecutions.length === 0
    || (options.run.errors?.length ?? 0) > 0
    || pipelineIntegrityFailures.length > 0
    || unexplainedRunFailure;
  const diagnosticOnly = pipelineIntegrityFailures.length > 0;
  const ready = !diagnosticOnly && blockingFailures === 0 && blockingIncomplete === 0 && !runIntegrityFailure;
  const generatedAt = new Date().toISOString();
  const startedAt = options.run.startedAt ?? null;
  const finishedAt = startedAt && options.run.durationMs != null
    ? new Date(new Date(startedAt).getTime() + options.run.durationMs).toISOString()
    : generatedAt;
  if (diagnosticOnly) {
    warnings.push(
      `Pipeline integrity failed in ${pipelineIntegrityFailures.map(({ stage }) => stage).join(', ')}. Audit counts in this checklist are diagnostic only; sharded-run.json remains the authoritative external release truth.`,
    );
  }

  const manifest: AuditManifest = {
    schemaVersion: 1,
    generatedAt,
    run: {
      status: options.run.status,
      startedAt,
      finishedAt,
      durationMs: options.run.durationMs ?? null,
      source: options.run.source,
      profile: options.run.profile ?? process.env.AUDIT_PROFILE ?? 'release',
      errors: options.run.errors ?? [],
      integrityFailures: pipelineIntegrityFailures,
    },
    release: {
      ready,
      decision: diagnosticOnly ? 'UNAVAILABLE' : ready ? 'READY' : 'NOT_READY',
      blockingFailures,
      blockingIncomplete,
      baselineIssues,
      runIntegrityFailure,
      reason: diagnosticOnly
        ? `No authoritative release decision is available because the evidence pipeline failed in ${pipelineIntegrityFailures.map(({ stage }) => stage).join(', ')}. The ${blockingFailures} blocking-failure and ${blockingIncomplete} incomplete-audit counts remain visible for diagnosis only.`
        : ready
        ? 'Every release-blocking audit has complete passing evidence.'
        : `${blockingFailures} blocking audit${blockingFailures === 1 ? '' : 's'} failed or need review; ${blockingIncomplete} blocking audit${blockingIncomplete === 1 ? '' : 's'} remain incomplete.${runIntegrityFailure ? ' The run also has an infrastructure or unknown-audit integrity failure.' : ''}`,
      decisionBasis: diagnosticOnly
        ? 'This generated checklist is diagnostic and cannot authorize release. sharded-run.json is the authoritative external lifecycle truth; it must report a completed pipeline and a validated READY or NOT_READY checklist decision. Diagnostic audit counts cannot override a coordinator termination, deadline, or required media-stage failure.'
        : 'Release gating uses applicable candidate and environment-unknown executions. Production failures are non-gating baseline context except for ENV-001, ENV-003, ENV-005, and CONTENT-008, whose contracts explicitly compare environments or declare paired-origin coverage. Skipped selections do not count as tested. Development TLS bypass withholds evidence authority without erasing the observed functional status. Unknown executed audit IDs fail run integrity.',
      diagnosticCountsAuthoritative: !diagnosticOnly,
      authoritativeReleaseSource: diagnosticOnly ? 'sharded-run.json' : 'checklist/manifest.json',
    },
    summary: {
      total: audits.length,
      catalogued: audits.filter((item) => item.catalogued).length,
      executed: audits.filter((item) => item.executions.some((execution) => execution.status !== 'NOT_RUN')).length,
      structuredExecutions: allExecutions.filter((execution) => execution.structuredEvidence).length,
      artifacts: allExecutions.reduce(
        (count, execution) => count + execution.artifacts.length + execution.artifacts.filter(({ poster }) => Boolean(poster)).length,
        0,
      ),
      // `videos` is retained for portal schema compatibility and represents all available clips.
      videos: availableVideoArtifacts.length,
      usableInteractionVideos,
      diagnosticVideos,
      posters: allExecutions.reduce(
        (count, execution) => count + execution.artifacts.filter(({ poster }) => Boolean(poster)).length,
        0,
      ),
      byStatus,
      byArea,
      bySeverity,
      baselineIssues,
    },
    audits,
    unmappedTests: unmapped.map((test) => ({
      id: test.id,
      title: test.title,
      titlePath: test.titlePath,
      file: test.file,
      line: test.line ?? null,
      projectName: test.projectName,
      rawStatuses: test.results.map((result) => result.status),
    })),
    warnings,
  };
  const galleryCatalog = projectReviewedExecutionTruth(evidenceModel.catalog, allExecutions);
  return { manifest, galleryCatalog };
}

export async function buildAuditManifest(options: GenerateReportOptions): Promise<AuditManifest> {
  return (await buildAuditModels(options)).manifest;
}

export async function writeAuditReport(options: GenerateReportOptions): Promise<AuditManifest> {
  const outputDir = path.resolve(options.cwd ?? process.cwd(), options.outputDir);
  const { manifest, galleryCatalog } = await buildAuditModels({ ...options, outputDir });
  const galleryDescriptor = await writeGalleryArchive({
    outputDir,
    catalog: galleryCatalog,
    exportedAt: manifest.generatedAt,
  });
  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outputDir, 'index.html'), reportHtml(manifest, galleryDescriptor), 'utf8');
  await writePortalReportData(outputDir, manifest);
  return manifest;
}

export interface WriteSingleSiteAuditReportOptions {
  outputDir: string;
  input: SingleSiteReportInput;
  cwd?: string;
  /** Test-only deterministic revision injection; production callers should omit it. */
  publicationRevision?: string;
}

/**
 * Finalizer-facing publication API for Single-site Audit. It intentionally
 * accepts already-frozen Site Health input instead of interpreting Playwright
 * rows as comparative candidate/release evidence.
 */
export async function writeSingleSiteAuditReport(
  options: WriteSingleSiteAuditReportOptions,
): Promise<SingleSiteReportSummary> {
  const outputDir = path.resolve(options.cwd ?? process.cwd(), options.outputDir);
  return writeSingleSiteReportPublication({
    outputDir,
    input: options.input,
    ...(options.publicationRevision ? { publicationRevision: options.publicationRevision } : {}),
  });
}

function portalText(value: unknown, maximum = PORTAL_REPORT_MAX_TEXT): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function portalFinding(finding: AuditFinding): PortalReportFinding {
  return {
    severity: finding.severity,
    title: portalText(finding.title, 300),
    detail: portalText(finding.detail),
    blocking: finding.blocking,
  };
}

const PORTAL_ATTENTION_STATUSES = new Set<ChecklistStatus>([
  'FAIL',
  'BLOCKED',
  'FLAKY',
  'REVIEW',
  'NOT_RUN',
  'MANUAL_REQUIRED',
]);
const PORTAL_ATTENTION_STATUS_ORDER: ChecklistStatus[] = [
  'FAIL',
  'BLOCKED',
  'FLAKY',
  'REVIEW',
  'NOT_RUN',
  'MANUAL_REQUIRED',
];

function conciseAssertionError(executions: readonly ReportExecution[]): string | null {
  const raw = executions.flatMap(({ errors }) => errors)
    .map(({ message, snippet, value }) => message ?? snippet ?? value ?? '')
    .find((value) => value.trim().length > 0);
  if (!raw) return null;
  const lines = raw
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replaceAll('\r', '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const headline = lines[0]?.replace(/^Error:\s*/, '') ?? '';
  const specificMessage = lines
    .map((line) => line.match(/^\+\s+"(?:message|failureSummary)":\s+"([^"]{4,300})/)?.[1] ?? null)
    .find((line): line is string => Boolean(line));
  const standaloneDetail = lines
    .map((line) => line.match(/^\+\s+"([^"]{4,300})"[,]?$/)?.[1] ?? null)
    .find((line): line is string => Boolean(line && /\s/.test(line) && !/^[.#\[<{]/.test(line)));
  const specific = specificMessage ?? standaloneDetail;
  const location = lines
    .map((line) => line.match(/(?:at\s+)?([^\s()]+\.(?:spec|test)\.[cm]?[jt]s:\d+(?::\d+)?)/)?.[1] ?? null)
    .find((line): line is string => Boolean(line));
  const parts = [...new Set([headline, specific, location].filter((value): value is string => Boolean(value)))];
  return parts.length > 0 ? portalText(parts.join(' · '), 700) : null;
}

function safeAttentionArtifact(
  artifact: ReportArtifact,
  attempt: number,
  context: PortalReportAttentionItem['evidence'][number]['context'],
): PortalReportAttentionItem['evidence'][number] | null {
  if (!artifact.available || !artifact.href || artifact.href.includes('\\')) return null;
  const segments = artifact.href.split('/');
  if (artifact.href.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(artifact.href)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return {
    name: portalText(artifact.name, 300),
    kind: artifact.kind,
    href: artifact.href,
    sizeBytes: artifact.sizeBytes,
    attempt,
    context,
  };
}

function portalAttentionItem(audit: AuditChecklistItem): PortalReportAttentionItem {
  const relevantEnvironments = audit.crossEnvironmentGate
    ? new Set<ReportExecution['environment']>(['candidate', 'production', 'unknown'])
    : new Set<ReportExecution['environment']>(['candidate', 'unknown']);
  const executions = audit.executions.filter((execution) => (
    relevantEnvironments.has(execution.environment)
    && (PORTAL_ATTENTION_STATUSES.has(execution.status) || execution.evidenceAuthority === 'withheld')
  ));
  const scope: PortalReportAttentionItem['scope'] = audit.crossEnvironmentGate
    ? 'cross-environment'
    : executions.some(({ environment }) => environment === 'candidate')
      || audit.coverage.missingApplicable.candidate > 0
      ? 'candidate'
      : 'unknown';
  const evidenceRank: Record<ReportArtifact['kind'], number> = {
    screenshot: 0,
    axe: 1,
    video: 2,
    trace: 3,
    json: 4,
    network: 5,
    lighthouse: 6,
    other: 7,
  };
  const rankedEvidence = [...new Map(executions
    .flatMap((execution) => {
      const finalAttempt = execution.attemptHistory.at(-1);
      if (!finalAttempt) return [];
      return finalAttempt.artifacts.map((artifact) => safeAttentionArtifact(
        artifact,
        finalAttempt.attempt,
        execution.primaryArtifacts.includes(artifact) ? 'final-primary' : 'final-diagnostic',
      ));
    })
    .filter((artifact): artifact is PortalReportAttentionItem['evidence'][number] => artifact !== null)
    .sort((left, right) => Number(left.context === 'final-diagnostic') - Number(right.context === 'final-diagnostic')
      || evidenceRank[left.kind] - evidenceRank[right.kind])
    .map((artifact) => [artifact.href, artifact])).values()];
  const evidence: PortalReportAttentionItem['evidence'] = [];
  const evidenceKinds = new Set<ReportArtifact['kind']>();
  for (const artifact of rankedEvidence) {
    if (evidenceKinds.has(artifact.kind)) continue;
    evidence.push(artifact);
    evidenceKinds.add(artifact.kind);
    if (evidence.length === 3) break;
  }
  const baselineNonGating = audit.baseline.hasIssues && !audit.crossEnvironmentGate;
  const detail = baselineNonGating
    ? audit.reason.replace(/\s+\d+ production-baseline execution[\s\S]*$/, '')
    : audit.reason;
  return {
    auditId: audit.id,
    auditTitle: portalText(audit.definition.title, 400),
    area: audit.definition.area,
    auditStatus: audit.status,
    severity: audit.definition.severity,
    releaseBlocking: audit.definition.releaseBlocking,
    scope,
    detail: portalText(detail),
    errorContext: conciseAssertionError(executions),
    reasonCodes: [...new Set(executions.flatMap(({ reasonCodes }) => reasonCodes))].slice(0, 12),
    baselineNonGating,
    baselineNote: baselineNonGating ? portalText(audit.baseline.note, 800) : null,
    evidence,
  };
}

function portalAuditRow(audit: AuditChecklistItem): PortalReportAuditRow {
  return {
    id: audit.id,
    area: audit.definition.area,
    title: portalText(audit.definition.title, 400),
    userPromise: portalText(audit.definition.userPromise),
    severity: audit.definition.severity,
    releaseBlocking: audit.definition.releaseBlocking,
    expected: portalText(audit.definition.expected),
    requiredEvidence: audit.definition.evidence,
    evidencePolicy: {
      mode: audit.definition.evidencePolicy.mode,
      rationale: portalText(audit.definition.evidencePolicy.rationale, 1_200),
    },
    status: audit.status,
    reason: portalText(audit.reason),
    manual: audit.manual,
    crossEnvironmentGate: audit.crossEnvironmentGate,
    environments: [
      ...(audit.coverage.candidate > 0 ? ['candidate' as const] : []),
      ...(audit.coverage.production > 0 ? ['production' as const] : []),
      ...(audit.coverage.unknown > 0 ? ['unknown' as const] : []),
    ],
    environmentStatus: audit.environmentStatus,
    baseline: {
      ...audit.baseline,
      note: portalText(audit.baseline.note),
    },
    coverage: {
      ...audit.coverage,
      projects: audit.coverage.projects.slice(0, 40).map((project) => portalText(project, 180)),
      selectedProjects: audit.coverage.selectedProjects.slice(0, 40).map((project) => portalText(project, 180)),
    },
    evidenceCounts: audit.evidenceCounts,
    findingCount: audit.findings.length,
    findingPreview: audit.findings.slice(0, 3).map(portalFinding),
    executionCount: audit.executions.length,
  };
}

function portalArtifact(artifact: ReportArtifact): Record<string, unknown> {
  const extended = artifact as ReportArtifact & { rationale?: unknown; evidenceRationale?: unknown };
  const rationale = extended.rationale ?? extended.evidenceRationale;
  return {
    name: portalText(artifact.name, 300),
    kind: artifact.kind,
    contentType: portalText(artifact.contentType, 120),
    href: artifact.href,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    available: artifact.available,
    ...(rationale ? { rationale: portalText(rationale, 800) } : {}),
    ...(artifact.poster ? {
      poster: {
        name: portalText(artifact.poster.name, 300),
        contentType: artifact.poster.contentType,
        href: artifact.poster.href,
        sizeBytes: artifact.poster.sizeBytes,
        sha256: artifact.poster.sha256,
      },
    } : {}),
    ...(artifact.posterError ? { posterError: portalText(artifact.posterError, 600) } : {}),
    ...(artifact.error ? { error: portalText(artifact.error, 600) } : {}),
  };
}

function portalEvidence(record: AuditEvidenceRecord | null): Record<string, unknown> | null {
  if (!record) return null;
  const evidencePolicy = record.evidencePolicy ?? record.definition?.evidencePolicy ?? {
    mode: 'static-screenshot',
    rationale: 'Legacy evidence did not record a capture rationale.',
  };
  const httpStatusCounts: Record<string, number> = {};
  for (const response of record.httpResponses) {
    const status = String(response.status);
    httpStatusCounts[status] = (httpStatusCounts[status] ?? 0) + 1;
  }
  return {
    environment: record.environment,
    coveredEnvironments: record.coveredEnvironments ?? [record.environment],
    evidencePolicy: {
      mode: evidencePolicy.mode,
      rationale: portalText(evidencePolicy.rationale, 1_200),
    },
    baseURL: portalText(record.baseURL, 600),
    viewport: record.viewport,
    timezone: portalText(record.timezone, 100),
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    totals: {
      steps: record.steps.length,
      observations: record.observations.length,
      findings: record.findings.length,
      pageInspections: record.pageInspections.length,
      consoleErrors: record.consoleErrors.length,
      consoleWarnings: record.consoleWarnings.length,
      pageErrors: record.pageErrors.length,
      httpResponses: record.httpResponses.length,
      failedRequests: record.failedRequests.length,
      badResponses: record.badResponses.length,
      thirdPartyTelemetryDiagnostics: record.thirdPartyTelemetryDiagnostics?.length ?? 0,
    },
    steps: record.steps.slice(0, PORTAL_REPORT_MAX_EVIDENCE_ITEMS).map((step) => ({
      name: portalText(step.name, 500),
      expected: portalText(step.expected),
      kind: step.kind ?? 'legacy',
      status: step.status,
      ...(step.detail ? { detail: portalText(step.detail) } : {}),
    })),
    observations: record.observations.slice(0, PORTAL_REPORT_MAX_EVIDENCE_ITEMS).map((observation) => ({
      label: portalText(observation.label, 300),
      value: portalText(observation.value),
      ...(observation.expected ? { expected: portalText(observation.expected) } : {}),
    })),
    findings: record.findings.slice(0, PORTAL_REPORT_MAX_EVIDENCE_ITEMS).map(portalFinding),
    pageInspections: record.pageInspections.slice(0, 8).map((inspection) => ({
      url: portalText(inspection.url, 700),
      title: portalText(inspection.title, 300),
      h1Count: inspection.h1Count,
      horizontalOverflowPx: inspection.horizontalOverflowPx,
      horizontalOverflowCandidateCount: inspection.horizontalOverflowCandidateCount ?? inspection.horizontalOverflowElements?.length ?? 0,
      horizontalOverflowTruncated: inspection.horizontalOverflowTruncated ?? false,
      horizontalOverflowElements: (inspection.horizontalOverflowElements ?? []).slice(0, 20).map((element) => ({
        selector: portalText(element.selector, 700),
        selectorMatchCount: element.selectorMatchCount,
        tagName: portalText(element.tagName, 80),
        text: portalText(element.text, 200),
        left: element.left,
        right: element.right,
        width: element.width,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: portalText(element.overflowX, 80),
        outsideLeftPx: element.outsideLeftPx,
        outsideRightPx: element.outsideRightPx,
        intrinsicOverflowPx: element.intrinsicOverflowPx,
        reasons: element.reasons,
        nearestScrollOwner: element.nearestScrollOwner ? {
          selector: portalText(element.nearestScrollOwner.selector, 700),
          left: element.nearestScrollOwner.left,
          right: element.nearestScrollOwner.right,
          clientWidth: element.nearestScrollOwner.clientWidth,
          scrollWidth: element.nearestScrollOwner.scrollWidth,
          overflowX: portalText(element.nearestScrollOwner.overflowX, 80),
        } : null,
      })),
      brokenImageCount: inspection.brokenImages.length,
      documentHeight: inspection.documentHeight,
      viewportWidth: inspection.viewportWidth,
      viewportHeight: inspection.viewportHeight,
      canonical: inspection.canonical ? portalText(inspection.canonical, 700) : null,
      description: inspection.description ? portalText(inspection.description, 500) : null,
      themeMode: inspection.themeMode,
    })),
    consoleErrors: record.consoleErrors.slice(0, 8).map((value) => portalText(value, 700)),
    consoleWarnings: record.consoleWarnings.slice(0, 8).map((value) => portalText(value, 700)),
    pageErrors: record.pageErrors.slice(0, 8).map((value) => portalText(value, 700)),
    thirdPartyTelemetryDiagnostics: (record.thirdPartyTelemetryDiagnostics ?? [])
      .slice(0, PORTAL_REPORT_MAX_EVIDENCE_ITEMS)
      .map((diagnostic) => ({
        provider: portalText(diagnostic.provider, 80),
        surface: portalText(diagnostic.surface, 80),
        message: portalText(diagnostic.message, 700),
        sourceUrl: diagnostic.sourceUrl ? portalText(diagnostic.sourceUrl, 700) : null,
        status: typeof diagnostic.status === 'number' && Number.isFinite(diagnostic.status)
          ? diagnostic.status
          : null,
      })),
    http: {
      statusCounts: httpStatusCounts,
      failedRequests: record.failedRequests.slice(0, 8).map((request) => ({
        url: portalText(request.url, 700),
        reason: portalText(request.reason, 500),
      })),
      badResponses: record.badResponses.slice(0, 8).map((response) => ({
        url: portalText(response.url, 700),
        status: response.status,
      })),
    },
    runtimeExpectations: (record.runtimeExpectations ?? []).slice(0, PORTAL_REPORT_MAX_EVIDENCE_ITEMS).map((expectation) => ({
      kind: expectation.kind,
      target: portalText(expectation.target, 700),
      expected: portalText(expectation.expected, 500),
      matched: expectation.matched,
    })),
  };
}

function portalExecution(execution: ReportExecution): Record<string, unknown> {
  return {
    id: execution.id,
    sourceTestId: portalText(execution.sourceTestId, 300),
    title: portalText(execution.title, 500),
    titlePath: execution.titlePath.slice(-6).map((part) => portalText(part, 300)),
    location: execution.location,
    project: portalText(execution.project, 240),
    environment: execution.environment,
    coveredEnvironments: execution.coveredEnvironments,
    browser: portalText(execution.browser, 160),
    deviceClass: execution.deviceClass,
    tlsPolicy: execution.tlsPolicy,
    status: execution.status,
    evidenceAuthority: execution.evidenceAuthority,
    reasonCodes: execution.reasonCodes,
    rawStatus: execution.rawStatus,
    expectedStatus: execution.expectedStatus,
    retry: execution.retry,
    attempts: execution.attempts,
    durationMs: execution.durationMs,
    startedAt: execution.startedAt,
    structuredEvidence: execution.structuredEvidence,
    evidencePolicy: execution.evidencePolicy,
    requiredEvidence: execution.requiredEvidence,
    errors: execution.errors.slice(0, 4).map((error) => ({
      ...(error.message ? { message: portalText(error.message, 900) } : {}),
      ...(error.snippet ? { snippet: portalText(error.snippet, 900) } : {}),
      ...(error.value ? { value: portalText(error.value, 500) } : {}),
    })),
    attemptHistory: execution.attemptHistory.slice(0, 6).map((attempt) => ({
      attempt: attempt.attempt,
      retry: attempt.retry,
      status: attempt.status,
      durationMs: attempt.durationMs,
      startedAt: attempt.startedAt,
      structuredEvidence: attempt.structuredEvidence,
      artifactCount: attempt.artifacts.length,
      errorCount: attempt.errors.length,
    })),
    artifactCount: execution.artifacts.length,
    primaryArtifactCount: execution.primaryArtifacts.length,
    diagnosticArtifactCount: execution.diagnosticArtifacts.length,
    artifacts: execution.artifacts.slice(0, PORTAL_REPORT_MAX_ARTIFACTS).map(portalArtifact),
    annotations: execution.annotations.slice(0, 10).map((annotation) => ({
      type: portalText(annotation.type, 120),
      ...(annotation.description ? { description: portalText(annotation.description, 600) } : {}),
    })),
    applicability: execution.applicability,
    applicableToProject: execution.applicableToProject,
    evidence: portalEvidence(execution.evidence),
  };
}

function portalAuditDetail(audit: AuditChecklistItem): Record<string, unknown> {
  const base = {
    schemaVersion: 1,
    ...portalAuditRow(audit),
    executionCount: audit.executions.length,
    executionReturned: Math.min(audit.executions.length, PORTAL_REPORT_MAX_EXECUTIONS),
    executionsTruncated: audit.executions.length > PORTAL_REPORT_MAX_EXECUTIONS,
    findings: audit.findings.slice(0, 40).map(portalFinding),
    findingsTruncated: audit.findings.length > 40,
    executions: audit.executions.slice(0, PORTAL_REPORT_MAX_EXECUTIONS).map(portalExecution),
  };
  const serialized = JSON.stringify(base);
  if (Buffer.byteLength(serialized) <= PORTAL_REPORT_MAX_DETAIL_BYTES) return base;
  const compacted = {
    ...base,
    executionReturned: Math.min(audit.executions.length, 10),
    executionsTruncated: audit.executions.length > 10,
    detailCompacted: true,
    executions: audit.executions.slice(0, 10).map((execution) => ({
      ...portalExecution(execution),
      artifacts: execution.artifacts.slice(0, 6).map(portalArtifact),
      evidence: execution.evidence ? {
        totals: portalEvidence(execution.evidence)?.totals,
        findings: execution.evidence.findings.slice(0, 6).map(portalFinding),
        observations: execution.evidence.observations.slice(0, 6).map((observation) => ({
          label: portalText(observation.label, 300),
          value: portalText(observation.value, 600),
        })),
      } : null,
    })),
  };
  if (Buffer.byteLength(JSON.stringify(compacted)) <= PORTAL_REPORT_MAX_DETAIL_BYTES) return compacted;
  const minimal = {
    schemaVersion: 1,
    ...portalAuditRow(audit),
    executionCount: audit.executions.length,
    executionReturned: Math.min(audit.executions.length, 3),
    executionsTruncated: audit.executions.length > 3,
    detailCompacted: true,
    findings: audit.findings.slice(0, 8).map(portalFinding),
    findingsTruncated: audit.findings.length > 8,
    executions: audit.executions.slice(0, 3).map((execution) => ({
      id: execution.id,
      title: portalText(execution.title, 500),
      project: portalText(execution.project, 240),
      environment: execution.environment,
      browser: portalText(execution.browser, 160),
      deviceClass: execution.deviceClass,
      tlsPolicy: execution.tlsPolicy,
      status: execution.status,
      rawStatus: execution.rawStatus,
      expectedStatus: execution.expectedStatus,
      retry: execution.retry,
      attempts: execution.attempts,
      durationMs: execution.durationMs,
      startedAt: execution.startedAt,
      structuredEvidence: execution.structuredEvidence,
      artifactCount: execution.artifacts.length,
      artifacts: execution.artifacts.slice(0, 4).map(portalArtifact),
      evidence: execution.evidence ? {
        totals: portalEvidence(execution.evidence)?.totals,
        findings: execution.evidence.findings.slice(0, 3).map(portalFinding),
      } : null,
    })),
  };
  if (Buffer.byteLength(JSON.stringify(minimal)) <= PORTAL_REPORT_MAX_DETAIL_BYTES) return minimal;
  return {
    schemaVersion: 1,
    id: audit.id,
    area: audit.definition.area,
    title: portalText(audit.definition.title, 400),
    severity: audit.definition.severity,
    releaseBlocking: audit.definition.releaseBlocking,
    status: audit.status,
    reason: portalText(audit.reason),
    executionCount: audit.executions.length,
    executionReturned: 0,
    executionsTruncated: audit.executions.length > 0,
    detailCompacted: true,
    detailUnavailableReason: 'The bounded detail record was reduced to preserve portal responsiveness. Download the raw checklist data for offline analysis.',
    findings: [],
    findingsTruncated: audit.findings.length > 0,
    executions: [],
  };
}

async function portalAiReview(outputDir: string): Promise<Record<string, unknown> | null> {
  const reviewPath = path.join(path.dirname(outputDir), 'ai-review', 'review.json');
  try {
    const details = await stat(reviewPath);
    if (!details.isFile() || details.size > 256 * 1024) {
      return { status: 'unavailable', reason: 'The AI review exceeded the safe report-summary limit.' };
    }
    const document = JSON.parse(await readFile(reviewPath, 'utf8')) as Record<string, any>;
    const review = document.review && typeof document.review === 'object' ? document.review : {};
    const api = document.api && typeof document.api === 'object' ? document.api : {};
    const usage = api.usage && typeof api.usage === 'object' ? api.usage : null;
    const findings = Array.isArray(review.findings) ? review.findings : [];
    const coverageGaps = Array.isArray(review.coverageGaps) ? review.coverageGaps : [];
    const questions = Array.isArray(review.questionsForHumanReviewer) ? review.questionsForHumanReviewer : [];
    return {
      status: portalText(document.status, 80),
      generatedAt: portalText(document.generatedAt, 80),
      model: portalText(document.model, 160),
      advisory: document.advisory === true,
      gating: document.gating === true,
      executiveSummary: portalText(review.executiveSummary, 2_400),
      releaseRecommendation: portalText(review.releaseRecommendation, 1_600),
      findingCount: findings.length,
      findings: findings.slice(0, 10).map((finding: Record<string, unknown>) => ({
        id: portalText(finding.id, 160),
        title: portalText(finding.title, 400),
        summary: portalText(finding.summary, 1_000),
        severity: portalText(finding.severity, 40),
        confidence: typeof finding.confidence === 'number' ? finding.confidence : null,
        recommendation: portalText(finding.recommendation, 1_000),
        relatedAuditIds: Array.isArray(finding.relatedAuditIds)
          ? finding.relatedAuditIds.slice(0, 12).map((value: unknown) => portalText(value, 160))
          : [],
      })),
      coverageGapCount: coverageGaps.length,
      coverageGaps: coverageGaps.slice(0, 12).map((value: unknown) => portalText(value, 600)),
      questionCount: questions.length,
      questionsForHumanReviewer: questions.slice(0, 12).map((value: unknown) => portalText(value, 600)),
      api: {
        status: portalText(api.status, 80),
        attempted: api.attempted === true,
        httpStatus: typeof api.httpStatus === 'number' ? api.httpStatus : null,
        latencyMs: typeof api.latencyMs === 'number' ? api.latencyMs : null,
        usage: usage ? {
          inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : null,
          outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : null,
          totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : null,
        } : null,
      },
      error: document.error ? portalText(document.error, 1_000) : null,
      notice: portalText(document.notice, 800),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { status: 'unavailable', reason: portalText(error instanceof Error ? error.message : error, 600) };
  }
}

async function writePortalReportData(outputDir: string, manifest: AuditManifest): Promise<void> {
  const dataDir = path.join(outputDir, 'data');
  const rows = manifest.audits.map(portalAuditRow);
  const manualAudits = rows.filter(({ manual }) => manual);
  const topFindings = manifest.audits
    .flatMap((audit) => audit.executions.flatMap((execution) => {
      const coversCandidate = execution.coveredEnvironments.includes('candidate');
      const coversProduction = execution.coveredEnvironments.includes('production');
      const productionBaselineOnly = coversProduction && !coversCandidate && !audit.crossEnvironmentGate;
      const scope = audit.crossEnvironmentGate
        ? 'cross-environment'
        : productionBaselineOnly
          ? 'production-baseline'
          : coversCandidate
            ? 'candidate'
            : 'unknown';
      return (execution.evidence?.findings ?? []).map((finding) => ({
        auditId: audit.id,
        auditTitle: portalText(audit.definition.title, 400),
        area: audit.definition.area,
        auditStatus: audit.status,
        environment: execution.environment,
        coveredEnvironments: execution.coveredEnvironments,
        sourceProject: portalText(execution.project, 300),
        scope,
        baselineNonGating: productionBaselineOnly,
        releaseBlocking: audit.definition.releaseBlocking && !productionBaselineOnly,
        ...portalFinding(finding),
      }));
    }))
    .sort((left, right) => Number(right.releaseBlocking) - Number(left.releaseBlocking)
      || Number(right.blocking) - Number(left.blocking)
      || ['P0', 'P1', 'P2', 'P3'].indexOf(left.severity) - ['P0', 'P1', 'P2', 'P3'].indexOf(right.severity))
    .slice(0, 20);
  const attentionItems = manifest.audits
    .filter((audit) => audit.findings.length === 0 && PORTAL_ATTENTION_STATUSES.has(audit.status))
    .sort((left, right) => PORTAL_ATTENTION_STATUS_ORDER.indexOf(left.status) - PORTAL_ATTENTION_STATUS_ORDER.indexOf(right.status)
      || ['P0', 'P1', 'P2', 'P3'].indexOf(left.definition.severity) - ['P0', 'P1', 'P2', 'P3'].indexOf(right.definition.severity)
      || left.id.localeCompare(right.id));
  const aiReview = await portalAiReview(outputDir);
  const publicationRevision = randomUUID().replaceAll('-', '');
  const summary = {
    schemaVersion: 1,
    publicationRevision,
    generatedAt: manifest.generatedAt,
    run: manifest.run,
    release: manifest.release,
    summary: manifest.summary,
    manualEvidence: {
      required: manualAudits.length,
      complete: manualAudits.filter(({ status }) => !['MANUAL_REQUIRED', 'NOT_RUN'].includes(status)).length,
      outstanding: manualAudits.filter(({ status }) => ['MANUAL_REQUIRED', 'NOT_RUN'].includes(status)).length,
      failedOrBlocked: manualAudits.filter(({ status }) => ['FAIL', 'BLOCKED'].includes(status)).length,
      byStatus: Object.fromEntries(manualAudits.map(({ status }) => status).map((status) => [
        status,
        manualAudits.filter((audit) => audit.status === status).length,
      ])),
    },
    topFindings,
    topFindingCount: manifest.audits.reduce((count, audit) => count + audit.findings.length, 0),
    topAttention: attentionItems.slice(0, 20).map(portalAttentionItem),
    topAttentionCount: attentionItems.length,
    filters: {
      statuses: [...new Set(rows.map(({ status }) => status))].sort(),
      severities: [...new Set(rows.map(({ severity }) => severity))].sort(),
      areas: [...new Set(rows.map(({ area }) => area))].sort(),
      environments: ['candidate', 'production', 'unknown'],
    },
    aiReview,
    warnings: manifest.warnings.slice(0, 20).map((warning) => portalText(warning, 800)),
    warningCount: manifest.warnings.length,
    unmappedTestCount: manifest.unmappedTests.length,
  };
  const auditIndex = {
    schemaVersion: 1,
    publicationRevision,
    generatedAt: manifest.generatedAt,
    items: rows,
  };
  const auditDetails = new Map(manifest.audits.map((audit) => [
    `${safeSegment(audit.id)}.json`,
    {
      publicationRevision,
      generatedAt: manifest.generatedAt,
      ...portalAuditDetail(audit),
    },
  ]));
  const revisionDir = path.join(dataDir, 'revisions', publicationRevision);
  const revisionAuditDir = path.join(revisionDir, 'audits');
  await mkdir(revisionAuditDir, { recursive: true });
  const documents = new Map<string, string>([
    ['summary.json', `${JSON.stringify(summary)}\n`],
    ['audits.json', `${JSON.stringify(auditIndex)}\n`],
    ...[...auditDetails].map(([name, detail]) => [`audits/${name}`, `${JSON.stringify(detail)}\n`] as const),
  ]);
  await Promise.all([
    ...[...documents].map(([relativePath, source]) => writeFile(path.join(revisionDir, relativePath), source, 'utf8')),
  ]);
  const publication = {
    schemaVersion: 1,
    publicationRevision,
    generatedAt: manifest.generatedAt,
    files: Object.fromEntries([...documents].map(([relativePath, source]) => [relativePath, {
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
    }])),
  };
  const publicationSource = `${JSON.stringify(publication)}\n`;
  await writeFile(path.join(revisionDir, 'publication.json'), publicationSource, 'utf8');

  // Keep the original compact paths as compatibility mirrors for exported
  // checklists. Portal release authority never reads these mutable aliases;
  // it pins the immutable revision selected by current.json below.
  const auditDir = path.join(dataDir, 'audits');
  await mkdir(auditDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dataDir, 'summary.json'), documents.get('summary.json')!, 'utf8'),
    writeFile(path.join(dataDir, 'audits.json'), documents.get('audits.json')!, 'utf8'),
    ...[...auditDetails].map(([name]) => writeFile(
      path.join(auditDir, name),
      documents.get(`audits/${name}`)!,
      'utf8',
    )),
  ]);

  // The pointer is the only authoritative publication switch. Every file in
  // the new immutable revision exists and is hashed before this atomic rename.
  const temporaryPointer = path.join(dataDir, `.current-${publicationRevision}.tmp`);
  await writeFile(temporaryPointer, publicationSource, { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPointer, path.join(dataDir, 'current.json'));
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function reportHtml(manifest: AuditManifest, galleryDescriptor: GalleryArchiveDescriptor): string {
  const bundle = galleryDescriptor.archiveBundle;
  if (!bundle) throw new Error('Generated report requires a pinned archive runtime bundle.');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Quitting7OH release audit</title>
  <link rel="stylesheet" href="${bundle.assetBase}/report.css">
</head>
<body>
  <a class="skip-link" href="#audit-list">Skip to audit results</a>
  <section id="archive-runtime-fatal" hidden role="alert">
    <h1>This sealed report cannot open</h1>
    <p id="archive-runtime-fatal-message"></p>
  </section>
  <header class="masthead">
    <div>
      <p class="eyebrow">Quitting7OH release evidence</p>
      <h1>Long Build Checklist</h1>
      <p id="run-context" class="run-context"></p>
    </div>
    <div id="release-decision" class="release-decision"></div>
  </header>
  <main>
    <section class="gallery-callout" aria-labelledby="visual-gallery-heading">
      <div>
        <p class="eyebrow">Review without link-by-link hunting</p>
        <h2 id="visual-gallery-heading">Visual Evidence Gallery</h2>
        <p>Inspect ${galleryDescriptor.primaryCounts.total} logical screenshots and interaction videos in one keyboard-friendly, read-only snapshot.</p>
      </div>
      <a class="gallery-callout-link" href="gallery.html">Open Visual Gallery</a>
    </section>
    <section aria-labelledby="summary-heading">
      <h2 id="summary-heading" class="visually-hidden">Run summary</h2>
      <div id="summary" class="summary-grid"></div>
    </section>
    <section class="controls" aria-label="Filter audit checklist">
      <label class="search-control">Search <input id="search" type="search" placeholder="ID, title, promise, finding…"></label>
      <label>Status <select id="status-filter"><option value="">All statuses</option></select></label>
      <label>Area <select id="area-filter"><option value="">All areas</option></select></label>
      <label>Severity <select id="severity-filter"><option value="">All severities</option></select></label>
      <label>Environment <select id="environment-filter"><option value="">All environments</option><option value="candidate">Candidate</option><option value="production">Production</option><option value="unknown">Unknown</option></select></label>
      <label class="toggle"><input id="blocking-only" type="checkbox"> Release-blocking only</label>
      <label class="toggle"><input id="baseline-only" type="checkbox"> Baseline issues only</label>
      <button id="expand-visible" type="button">Expand visible</button>
      <button id="clear-filters" type="button">Clear filters</button>
    </section>
    <p id="result-count" class="result-count" role="status"></p>
    <section id="audit-list" class="audit-list" aria-label="Audit checklist results"></section>
    <section id="ai-review-summary" class="ai-review-summary" aria-labelledby="ai-review-heading">
      <h2 id="ai-review-heading">AI evidence review</h2>
      <p><strong>Advisory and non-gating.</strong> AI findings never change this checklist's release decision until a human verifies them.</p>
      <p id="ai-review-state">Checking for an optional AI review…</p>
    </section>
    <section id="run-diagnostics" class="run-diagnostics" aria-labelledby="diagnostics-heading"></section>
  </main>
  <script id="archive-bundle" type="application/json">${inlineJson(bundle)}</script>
  <script id="audit-manifest" type="application/json">${inlineJson(manifest)}</script>
  <script id="gallery-archive-head" type="application/json">${inlineJson(galleryDescriptor)}</script>
  <script src="${bundle.assetBase}/archive-runtime.js"></script>
  <script src="${bundle.assetBase}/report.js"></script>
</body>
</html>`;
}

export function resolveReportOutputDir(configuredOutputDir?: string): string {
  return process.env.AUDIT_OUTPUT_DIR || configuredOutputDir || './artifacts/checklist';
}

export { STATUS_ORDER };
