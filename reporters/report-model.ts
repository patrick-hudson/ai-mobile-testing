import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_AUDIT_CATALOG } from '../audit/definitions.js';
import {
  evidenceKindsForPolicy,
  parseAuditStatusAnnotation,
  parseEvidencePolicyAnnotation,
} from '../audit/evidence-policy.js';
import type {
  AuditDefinition,
  AuditEnvironment,
  AuditEvidenceRecord,
  AuditFinding,
  AuditProjectMetadata,
} from '../audit/types.js';
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
    selected: { production: number; candidate: number; unknown: number; total: number };
    applicable: { production: number; candidate: number; unknown: number; total: number };
    skipped: { production: number; candidate: number; unknown: number; total: number };
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
  outputDir: string;
  tests: ReportTestInput[];
  run: ReportRunInput;
  cwd?: string;
  definitionCatalog?: readonly AuditDefinition[];
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

      const environment = record?.environment ?? test.projectMetadata?.environment ?? 'unknown';
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

export async function buildAuditModels(options: GenerateReportOptions): Promise<AuditReportModels> {
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

  const catalogOrder = new Map(definitionCatalog.map((definition, index) => [definition.id, index]));
  const catalogIds = new Set(definitionCatalog.map(({ id }) => id));
  const audits = [...definitions.values()]
    .map((definition): AuditChecklistItem => {
      const executions = byAuditId.get(definition.id) ?? [];
      const candidateExecutions = executions.filter((execution) => execution.coveredEnvironments.includes('candidate'));
      const productionExecutions = executions.filter((execution) => execution.coveredEnvironments.includes('production'));
      const unknownExecutions = executions.filter((execution) => execution.coveredEnvironments.length === 0);
      const crossEnvironmentGate = CROSS_ENVIRONMENT_GATES.has(definition.id);
      const releaseExecutions = crossEnvironmentGate ? executions : [...candidateExecutions, ...unknownExecutions];
      let aggregate = aggregateStatus(definition, releaseExecutions);
      const candidateAggregate = aggregateStatus(definition, candidateExecutions);
      const productionAggregate = aggregateStatus(definition, productionExecutions);
      const unknownAggregate = aggregateStatus(definition, unknownExecutions);
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
          selectedProjects: [...new Set(executions.map((execution) => execution.project))].sort(),
          selected: selectedCoverage,
          applicable: applicableCoverage,
          skipped: skippedCoverage,
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
      videos: allExecutions.reduce(
        (count, execution) => count + execution.artifacts.filter((artifact) => artifact.kind === 'video' && artifact.available).length,
        0,
      ),
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
  const assetsDir = path.join(outputDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  const sourceAssets = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
  await Promise.all([
    copyFile(path.join(sourceAssets, 'report.css'), path.join(assetsDir, 'report.css')),
    copyFile(path.join(sourceAssets, 'report.js'), path.join(assetsDir, 'report.js')),
  ]);
  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outputDir, 'index.html'), reportHtml(manifest, galleryDescriptor), 'utf8');
  await writePortalReportData(outputDir, manifest);
  return manifest;
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
  const auditDir = path.join(dataDir, 'audits');
  await mkdir(auditDir, { recursive: true });
  const rows = manifest.audits.map(portalAuditRow);
  const manualAudits = rows.filter(({ manual }) => manual);
  const topFindings = manifest.audits
    .flatMap((audit) => audit.findings.map((finding) => ({
      auditId: audit.id,
      auditTitle: portalText(audit.definition.title, 400),
      area: audit.definition.area,
      auditStatus: audit.status,
      releaseBlocking: audit.definition.releaseBlocking,
      ...portalFinding(finding),
    })))
    .sort((left, right) => Number(right.blocking) - Number(left.blocking)
      || ['P0', 'P1', 'P2', 'P3'].indexOf(left.severity) - ['P0', 'P1', 'P2', 'P3'].indexOf(right.severity))
    .slice(0, 20);
  const aiReview = await portalAiReview(outputDir);
  const summary = {
    schemaVersion: 1,
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
  await Promise.all([
    writeFile(path.join(dataDir, 'summary.json'), `${JSON.stringify(summary)}\n`, 'utf8'),
    writeFile(path.join(dataDir, 'audits.json'), `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: manifest.generatedAt,
      items: rows,
    })}\n`, 'utf8'),
    ...manifest.audits.map((audit) => writeFile(
      path.join(auditDir, `${safeSegment(audit.id)}.json`),
      `${JSON.stringify(portalAuditDetail(audit))}\n`,
      'utf8',
    )),
  ]);
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Quitting7OH release audit</title>
  <link rel="stylesheet" href="assets/report.css">
</head>
<body>
  <a class="skip-link" href="#audit-list">Skip to audit results</a>
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
  <script id="audit-manifest" type="application/json">${inlineJson(manifest)}</script>
  <script id="gallery-archive-head" type="application/json">${inlineJson(galleryDescriptor)}</script>
  <script src="assets/report.js"></script>
</body>
</html>`;
}

export function resolveReportOutputDir(configuredOutputDir?: string): string {
  return process.env.AUDIT_OUTPUT_DIR || configuredOutputDir || './artifacts/checklist';
}

export { STATUS_ORDER };
