import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bracketedAuditIds, firstBracketedAuditId } from '../audit/audit-id.js';
import {
  AUDIT_APPLICABILITY_ANNOTATION,
  AUDIT_EVIDENCE_POLICY_ANNOTATION,
  AUDIT_STATUS_ANNOTATION,
  serializeEvidencePolicy,
} from '../audit/evidence-policy.js';
import type { AuditDefinition, AuditEvidenceRecord } from '../audit/types.js';
import type { GalleryCatalog } from '../shared/gallery-contract.mjs';
import {
  buildAuditManifest,
  buildAuditModels,
  projectReviewedExecutionTruth,
  writeAuditReport,
  type ReportTestInput,
} from '../reporters/report-model.js';

const definitions: AuditDefinition[] = [
  {
    id: 'A11Y-001',
    area: 'accessibility',
    title: 'Accessibility mapping regression',
    userPromise: 'Accessibility evidence is attached to its canonical audit.',
    severity: 'P0',
    releaseBlocking: true,
    expected: 'Digit-bearing audit prefixes are recognized.',
    evidence: ['json'],
    evidencePolicy: { mode: 'structured-data', rationale: 'Retain the canonical audit mapping as structured evidence.' },
    singleSiteClassification: 'standalone-compatible',
    standaloneOracle: { id: 'A11Y-001:standalone', expected: 'Digit-bearing audit prefixes are recognized.' },
  },
  {
    id: 'PAGE-HOME',
    area: 'routes',
    title: 'Home page audit mapping regression',
    userPromise: 'Generated route evidence is attached only to its bracketed audit ID.',
    severity: 'P1',
    releaseBlocking: true,
    expected: 'The page-audit filename does not create a synthetic audit.',
    evidence: ['json'],
    evidencePolicy: { mode: 'structured-data', rationale: 'Retain the generated page audit mapping as structured evidence.' },
    singleSiteClassification: 'standalone-compatible',
    standaloneOracle: { id: 'PAGE-HOME:standalone', expected: 'The page-audit filename does not create a synthetic audit.' },
  },
  {
    id: 'SHELL-006',
    area: 'responsive',
    title: 'Horizontal overflow mapping regression',
    userPromise: 'Prose near an audit ID does not become another audit.',
    severity: 'P1',
    releaseBlocking: true,
    expected: 'The phrase page-level does not create a synthetic audit.',
    evidence: ['json'],
    evidencePolicy: { mode: 'structured-data', rationale: 'Retain the horizontal-overflow mapping as structured evidence.' },
    singleSiteClassification: 'standalone-compatible',
    standaloneOracle: { id: 'SHELL-006:standalone', expected: 'The phrase page-level does not create a synthetic audit.' },
  },
  {
    id: 'ENV-003',
    area: 'routes',
    title: 'Paired route migration ledger',
    userPromise: 'One correlated ledger can prove both origin inventories were compared.',
    severity: 'P0',
    releaseBlocking: true,
    expected: 'Candidate and production are explicitly covered by one structured record.',
    evidence: ['json'],
    evidencePolicy: { mode: 'structured-data', rationale: 'Retain the paired origin route ledger as structured evidence.' },
    singleSiteClassification: 'comparison-only',
  },
];

function evidence(
  definition: AuditDefinition,
  overrides: Partial<AuditEvidenceRecord> = {},
): AuditEvidenceRecord {
  const timestamp = '2026-08-24T00:00:00.000Z';
  return {
    schemaVersion: 1,
    auditId: definition.id,
    definition,
    evidencePolicy: definition.evidencePolicy,
    environment: 'candidate',
    baseURL: 'https://candidate.example.test',
    project: 'candidate-self-test',
    browser: 'synthetic',
    viewport: { width: 390, height: 844 },
    timezone: 'UTC',
    startedAt: timestamp,
    finishedAt: timestamp,
    steps: [],
    observations: [],
    findings: [],
    pageInspections: [],
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    httpResponses: [],
    failedRequests: [],
    badResponses: [],
    ...overrides,
  };
}

interface ReportTestOptions {
  annotations?: Array<{ type: string; description?: string }>;
  applicability?: string;
  idSuffix?: string;
  projectName?: string;
  metadata?: ReportTestInput['projectMetadata'];
  record?: AuditEvidenceRecord;
  results?: ReportTestInput['results'];
}

function reportTest(
  definition: AuditDefinition,
  title: string,
  file: string,
  extraTitlePath: string[] = [],
  options: ReportTestOptions = {},
): ReportTestInput {
  const record = options.record ?? evidence(definition);
  return {
    id: `audit-id-self-test-${definition.id}${options.idSuffix ? `-${options.idSuffix}` : ''}`,
    title,
    titlePath: [file, ...extraTitlePath, title],
    file,
    projectName: options.projectName ?? 'candidate-self-test',
    projectMetadata: options.metadata ?? {
      environment: 'candidate',
      browserLabel: 'synthetic',
      deviceClass: 'mobile',
      fullSweep: false,
      visual: false,
      tlsPolicy: 'strict',
    },
    annotations: options.annotations ?? [
      { type: 'audit-id', description: definition.id },
      { type: AUDIT_EVIDENCE_POLICY_ANNOTATION, description: serializeEvidencePolicy(definition.evidencePolicy) },
      { type: AUDIT_APPLICABILITY_ANNOTATION, description: options.applicability ?? 'candidate-projects' },
    ],
    results: options.results ?? [{
      status: 'passed',
      expectedStatus: 'passed',
      duration: 1,
      retry: 0,
      errors: [],
      attachments: [{
        name: 'audit-result',
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(record)),
      }],
      stdout: [],
      stderr: [],
    }],
  };
}

assert.equal(firstBracketedAuditId('[A11Y-001] scan'), 'A11Y-001');
assert.deepEqual(bracketedAuditIds('tests/page-audit.spec.ts page-level'), []);
assert.deepEqual(bracketedAuditIds('[PAGE-HOME] and [SHELL-006]'), ['PAGE-HOME', 'SHELL-006']);

const root = await mkdtemp(path.join(tmpdir(), 'audit-id-self-test-'));
try {
  const tests = [
    reportTest(definitions[0]!, '[A11Y-001] automated WCAG scan', 'tests/accessibility.spec.ts'),
    reportTest(definitions[1]!, '[PAGE-HOME] home route renders', 'tests/page-audit.spec.ts'),
    reportTest(
      definitions[2]!,
      '[SHELL-006] representative pages have no page-level horizontal overflow',
      'tests/shell-content.spec.ts',
      ['page-level layout checks'],
    ),
  ];
  const manifest = await buildAuditManifest({
    outputDir: path.join(root, 'checklist'),
    tests,
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: definitions,
  });

  assert.deepEqual(manifest.audits.map(({ id }) => id), ['A11Y-001', 'PAGE-HOME', 'SHELL-006', 'ENV-003']);
  assert.equal(manifest.audits.find(({ id }) => id === 'A11Y-001')?.executions[0]?.structuredEvidence, true);
  assert.equal(manifest.audits.find(({ id }) => id === 'A11Y-001')?.executions[0]?.auditId, 'A11Y-001');
  assert.equal(manifest.audits.some(({ id }) => id === 'UNMAPPED'), false);
  assert.equal(manifest.audits.some(({ id }) => id === 'PAGE-AUDIT'), false);
  assert.equal(manifest.audits.some(({ id }) => id === 'PAGE-LEVEL'), false);
  assert.deepEqual(manifest.unmappedTests, []);

  const knownExecution = manifest.audits.find(({ id }) => id === 'A11Y-001')?.executions[0];
  assert(knownExecution);
  const mixedAssociationCatalog: GalleryCatalog = {
    schemaVersion: 1,
    items: [{
      id: 'mixed-known-unknown-association',
      kind: 'image',
      test: {
        id: knownExecution.sourceTestId,
        title: knownExecution.title,
        titlePath: knownExecution.titlePath,
        file: knownExecution.location.file,
        line: knownExecution.location.line,
        column: knownExecution.location.column,
        technicalSuite: 'assertion-integrity',
      },
      attempt: {
        ordinal: 1,
        retry: 0,
        status: 'passed',
        expectedStatus: 'passed',
        startedAt: null,
        durationMs: 1,
      },
      project: {
        name: knownExecution.project,
        environment: knownExecution.environment,
        browser: knownExecution.browser,
        deviceClass: knownExecution.deviceClass,
      },
      auditAssociations: [{
        id: 'A11Y-001',
        title: definitions[0]!.title,
        expected: definitions[0]!.expected,
        featureSuite: definitions[0]!.area,
        catalogOrdinal: 0,
      }, {
        id: 'TYPO-999',
        title: 'Unknown association',
        expected: 'This association must not be accepted.',
        featureSuite: 'unmapped',
        catalogOrdinal: null,
      }],
      members: [],
      comparison: null,
      capture: {
        route: null,
        viewport: null,
        capturedAt: null,
        observedState: null,
        rationale: null,
        provenance: 'missing',
      },
      provenance: { sourceShard: null },
    }],
    blobs: [],
    primaryCounts: { total: 1, images: 1, videos: 0 },
  };
  projectReviewedExecutionTruth(mixedAssociationCatalog, [knownExecution]);
  assert.equal(mixedAssociationCatalog.items[0]?.attempt.status, 'REVIEW');
  assert.equal(mixedAssociationCatalog.items[0]?.attempt.statusSource, 'release-integrity');
  assert.deepEqual(mixedAssociationCatalog.items[0]?.attempt.reviewReasonCodes, ['UNKNOWN_AUDIT_ID']);

  const proseCannotControlStatus = reportTest(
    definitions[0]!,
    '[A11Y-001] blocked storage remains usable',
    'tests/status-regression.spec.ts',
    [],
    {
      annotations: [
        { type: 'audit-id', description: 'A11Y-001' },
        { type: 'note', description: 'The browser blocks storage by design.' },
        { type: AUDIT_EVIDENCE_POLICY_ANNOTATION, description: serializeEvidencePolicy(definitions[0]!.evidencePolicy) },
      ],
    },
  );
  const exactBlocked = reportTest(
    definitions[1]!,
    '[PAGE-HOME] explicit review blocker',
    'tests/status-regression.spec.ts',
    [],
    {
      annotations: [
        { type: 'audit-id', description: 'PAGE-HOME' },
        { type: AUDIT_STATUS_ANNOTATION, description: 'BLOCKED' },
        { type: AUDIT_EVIDENCE_POLICY_ANNOTATION, description: serializeEvidencePolicy(definitions[1]!.evidencePolicy) },
      ],
    },
  );
  const failedCannotBeWaived = reportTest(
    definitions[2]!,
    '[SHELL-006] failed result wins over review annotation',
    'tests/status-regression.spec.ts',
    [],
    {
      annotations: [
        { type: 'audit-id', description: 'SHELL-006' },
        { type: AUDIT_STATUS_ANNOTATION, description: 'REVIEW' },
        { type: AUDIT_EVIDENCE_POLICY_ANNOTATION, description: serializeEvidencePolicy(definitions[2]!.evidencePolicy) },
      ],
      results: [{
        status: 'failed',
        expectedStatus: 'passed',
        duration: 1,
        retry: 0,
        errors: [{ message: 'Synthetic failure' }],
        attachments: [{
          name: 'audit-result',
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify(evidence(definitions[2]!))),
        }],
        stdout: [],
        stderr: [],
      }],
    },
  );
  const statusManifest = await buildAuditManifest({
    outputDir: path.join(root, 'status-checklist'),
    tests: [proseCannotControlStatus, exactBlocked, failedCannotBeWaived],
    run: { status: 'failed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: definitions.slice(0, 3),
  });
  assert.equal(statusManifest.audits.find(({ id }) => id === 'A11Y-001')?.status, 'PASS');
  assert.equal(statusManifest.audits.find(({ id }) => id === 'PAGE-HOME')?.status, 'BLOCKED');
  assert.equal(statusManifest.audits.find(({ id }) => id === 'SHELL-006')?.status, 'FAIL');

  const attentionReportDirectory = path.join(root, 'attention-report');
  const candidateAttentionRecord = evidence(definitions[0]!);
  const productionAttentionRecord = evidence(definitions[0]!, {
    environment: 'production',
    baseURL: 'https://production.example.test',
    project: 'production-self-test',
  });
  await writeAuditReport({
    outputDir: attentionReportDirectory,
    tests: [
      reportTest(definitions[0]!, '[A11Y-001] candidate assertion failure', 'tests/attention.spec.ts', [], {
        idSuffix: 'candidate-attention',
        record: candidateAttentionRecord,
        applicability: 'candidate-projects',
        results: [{
          status: 'failed', expectedStatus: 'passed', duration: 1, retry: 0,
          errors: [{ message: 'Error: Stale first-attempt assertion must not drive final attention' }],
          attachments: [{
            name: 'stale-first-attempt-axe', contentType: 'application/json', body: Buffer.from('{"attempt":1}'),
          }],
          stdout: [], stderr: [],
        }, {
          status: 'failed', expectedStatus: 'passed', duration: 1, retry: 1,
          errors: [{ message: 'Error: Candidate contrast assertion failed\n+   "candidate button has insufficient contrast",\n    at tests/attention.spec.ts:42:7' }],
          attachments: [{
            name: 'audit-result', contentType: 'application/json',
            body: Buffer.from(JSON.stringify(candidateAttentionRecord)),
          }, {
            name: 'final-attempt-axe-page-scan', contentType: 'application/json', body: Buffer.from('{"violations":[]}'),
          }],
          stdout: [], stderr: [],
        }],
      }),
      reportTest(definitions[0]!, '[A11Y-001] production baseline failure', 'tests/attention.spec.ts', [], {
        idSuffix: 'production-attention',
        projectName: 'production-self-test',
        record: productionAttentionRecord,
        applicability: 'production-projects',
        metadata: {
          environment: 'production', browserLabel: 'synthetic', deviceClass: 'desktop',
          fullSweep: false, visual: false, tlsPolicy: 'strict',
        },
        results: [{
          status: 'failed', expectedStatus: 'passed', duration: 1, retry: 0,
          errors: [{ message: 'Error: Production-only assertion must remain baseline context' }],
          attachments: [{
            name: 'audit-result', contentType: 'application/json',
            body: Buffer.from(JSON.stringify(productionAttentionRecord)),
          }],
          stdout: [], stderr: [],
        }],
      }),
    ],
    run: { status: 'failed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  const attentionSummary = JSON.parse(await readFile(
    path.join(attentionReportDirectory, 'data', 'summary.json'),
    'utf8',
  )) as {
    topFindingCount: number;
    topAttentionCount: number;
    topAttention: Array<{
      auditId: string;
      scope: string;
      errorContext: string | null;
      baselineNonGating: boolean;
      baselineNote: string | null;
      evidence: Array<{ name: string; href: string; attempt: number; context: string }>;
    }>;
  };
  assert.equal(attentionSummary.topFindingCount, 0);
  assert.equal(attentionSummary.topAttentionCount, 1);
  assert.equal(attentionSummary.topAttention[0]?.auditId, 'A11Y-001');
  assert.equal(attentionSummary.topAttention[0]?.scope, 'candidate');
  assert.match(attentionSummary.topAttention[0]?.errorContext ?? '', /Candidate contrast assertion failed/);
  assert.doesNotMatch(attentionSummary.topAttention[0]?.errorContext ?? '', /Production-only/);
  assert.equal(attentionSummary.topAttention[0]?.baselineNonGating, true);
  assert.match(attentionSummary.topAttention[0]?.baselineNote ?? '', /baseline context.*do not veto/i);
  assert(attentionSummary.topAttention[0]?.evidence.length,
    'The fallback must include a bounded link to available candidate evidence.');
  assert(attentionSummary.topAttention[0]!.evidence.some(({ name, attempt, context }) => (
    name === 'final-attempt-axe-page-scan' && attempt === 2 && context === 'final-primary'
  )), 'Attention evidence must identify the final attempt and its primary-evidence context.');
  assert(attentionSummary.topAttention[0]!.evidence.every(({ name }) => name !== 'stale-first-attempt-axe'),
    'Earlier retry artifacts must not be linked beside the final assertion context.');
  assert(attentionSummary.topAttention[0]!.evidence.every(({ href }) => (
    !href.startsWith('/') && !href.includes('..') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)
  )), 'Fallback evidence links must remain relative paths inside the checklist publication.');

  const manualDefinition: AuditDefinition = {
    ...definitions[0]!,
    id: 'DEVICE-001',
    title: 'Physical iPhone acceptance',
    manual: true,
  };
  const incompleteReportDirectory = path.join(root, 'incomplete-attention-report');
  await writeAuditReport({
    outputDir: incompleteReportDirectory,
    tests: [],
    run: { status: 'failed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[1]!, manualDefinition],
    selectedProjects: [{
      name: 'candidate-mobile-chromium',
      metadata: {
        environment: 'candidate', browserLabel: 'synthetic', deviceClass: 'mobile',
        fullSweep: true, visual: false, tlsPolicy: 'strict',
      },
    }],
  });
  const incompleteSummary = JSON.parse(await readFile(
    path.join(incompleteReportDirectory, 'data', 'summary.json'),
    'utf8',
  )) as {
    topAttentionCount: number;
    topAttention: Array<{ auditId: string; auditStatus: string; scope: string; detail: string; evidence: unknown[] }>;
  };
  assert.equal(incompleteSummary.topAttentionCount, 2);
  assert.deepEqual(
    incompleteSummary.topAttention.map(({ auditId, auditStatus }) => ({ auditId, auditStatus })),
    [
      { auditId: 'PAGE-HOME', auditStatus: 'NOT_RUN' },
      { auditId: 'DEVICE-001', auditStatus: 'MANUAL_REQUIRED' },
    ],
    'Both automated coverage gaps and outstanding manual acceptance must be actionable attention outcomes.',
  );
  assert.equal(incompleteSummary.topAttention[0]?.scope, 'candidate');
  assert.match(incompleteSummary.topAttention[0]?.detail ?? '', /no matching automated execution|emitted no completed execution/i);
  assert.equal(incompleteSummary.topAttention[1]?.evidence.length, 0);

  const blockingFindingRecord = evidence(definitions[0]!, {
    findings: [{
      severity: 'P0',
      title: 'Unapproved clinical policy',
      detail: 'A named clinical owner must approve this rule before release.',
      blocking: true,
    }],
  });
  const productionBaselineFindingRecord = evidence(definitions[0]!, {
    environment: 'production',
    baseURL: 'https://production.example.test',
    project: 'production-self-test',
    findings: [{
      severity: 'P1',
      title: 'Production baseline visual defect',
      detail: 'This synthetic defect is baseline context and must not be presented as a candidate release blocker.',
      blocking: true,
    }],
  });
  const blockingFindingReportDirectory = path.join(root, 'blocking-finding-checklist');
  const blockingFindingManifest = await writeAuditReport({
    outputDir: blockingFindingReportDirectory,
    tests: [
      reportTest(
        definitions[0]!,
        '[A11Y-001] structured release blocker',
        'tests/blocking-finding.spec.ts',
        [],
        { record: blockingFindingRecord },
      ),
      reportTest(
        definitions[0]!,
        '[A11Y-001] production baseline structured finding',
        'tests/blocking-finding.spec.ts',
        [],
        {
          idSuffix: 'production-baseline-finding',
          projectName: 'production-self-test',
          record: productionBaselineFindingRecord,
          applicability: 'production-projects',
          metadata: {
            environment: 'production', browserLabel: 'synthetic', deviceClass: 'desktop',
            fullSweep: false, visual: false, tlsPolicy: 'strict',
          },
        },
      ),
    ],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  assert.equal(blockingFindingManifest.audits[0]?.status, 'FAIL',
    'A passing Playwright result with a structured blocking finding must fail its checklist audit.');
  assert.equal(blockingFindingManifest.release.ready, false,
    'A structured P0 blocker must withhold release authority.');
  const blockingFindingSummary = JSON.parse(await readFile(
    path.join(blockingFindingReportDirectory, 'data', 'summary.json'),
    'utf8',
  )) as {
    topFindingCount: number;
    topAttentionCount: number;
    topFindings: Array<{
      title: string;
      environment: string;
      scope: string;
      baselineNonGating: boolean;
      releaseBlocking: boolean;
    }>;
  };
  assert.equal(blockingFindingSummary.topFindingCount, 2,
    'The portal summary must publish the candidate blocker and labeled production context.');
  assert.equal(blockingFindingSummary.topAttentionCount, 0,
    'A structured blocker must not be duplicated as a generic attention outcome.');
  const candidateFinding = blockingFindingSummary.topFindings.find(({ title }) => title === 'Unapproved clinical policy');
  const productionFinding = blockingFindingSummary.topFindings.find(({ title }) => title === 'Production baseline visual defect');
  assert(candidateFinding);
  assert.equal(candidateFinding.environment, 'candidate');
  assert.equal(candidateFinding.scope, 'candidate');
  assert.equal(candidateFinding.baselineNonGating, false);
  assert.equal(candidateFinding.releaseBlocking, true);
  assert(productionFinding);
  assert.equal(productionFinding.environment, 'production');
  assert.equal(productionFinding.scope, 'production-baseline');
  assert.equal(productionFinding.baselineNonGating, true);
  assert.equal(productionFinding.releaseBlocking, false,
    'Production-only findings must remain visible without masquerading as candidate release blockers.');

  const pairedDefinition = definitions[3]!;
  const pairedRecord = evidence(pairedDefinition, { coveredEnvironments: ['candidate', 'production'] });
  const pairedManifest = await buildAuditManifest({
    outputDir: path.join(root, 'paired-checklist'),
    tests: [reportTest(
      pairedDefinition,
      '[ENV-003] compare both origins in one route ledger',
      'tests/contracts.spec.ts',
      [],
      { record: pairedRecord },
    )],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [pairedDefinition],
  });
  const pairedAudit = pairedManifest.audits[0]!;
  assert.equal(pairedAudit.status, 'PASS');
  assert.equal(pairedAudit.environmentStatus.candidate, 'PASS');
  assert.equal(pairedAudit.environmentStatus.production, 'PASS');
  assert.equal(pairedAudit.coverage.candidate, 1);
  assert.equal(pairedAudit.coverage.production, 1);

  const unknownDefinition = { ...definitions[0]!, id: 'TYPO-999' };
  const unknownManifest = await buildAuditManifest({
    outputDir: path.join(root, 'unknown-checklist'),
    tests: [reportTest(
      unknownDefinition,
      '[TYPO-999] this audit is absent from the catalog',
      'tests/typo.spec.ts',
    )],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  assert.equal(unknownManifest.release.ready, false);
  assert.equal(unknownManifest.release.runIntegrityFailure, true);
  assert.equal(unknownManifest.audits.some(({ id }) => id === 'TYPO-999'), false);
  assert.equal(unknownManifest.unmappedTests.length, 1);

  const pipelineFailureManifest = await buildAuditManifest({
    outputDir: path.join(root, 'pipeline-failure-checklist'),
    tests: [reportTest(
      definitions[0]!,
      '[A11Y-001] passing evidence cannot erase a terminated shard',
      'tests/accessibility.spec.ts',
    )],
    run: {
      status: 'failed',
      source: 'playwright-json',
      profile: 'self-test',
      errors: [{ message: 'Pipeline integrity failure in SHARD 1/8: terminated by SIGTERM.' }],
      integrityFailures: [{
        stage: 'SHARD 1/8',
        reason: 'SHARD 1/8 was terminated by SIGTERM.',
        exitCode: 143,
        signal: 'SIGTERM',
        logPath: 'logs/shard-1-of-8.log',
      }],
    },
    definitionCatalog: [definitions[0]!],
  });
  assert.equal(pipelineFailureManifest.release.decision, 'UNAVAILABLE');
  assert.equal(pipelineFailureManifest.release.ready, false);
  assert.equal(pipelineFailureManifest.release.runIntegrityFailure, true);
  assert.equal(pipelineFailureManifest.release.blockingFailures, 0);
  assert.equal(pipelineFailureManifest.release.diagnosticCountsAuthoritative, false);
  assert.equal(pipelineFailureManifest.release.authoritativeReleaseSource, 'sharded-run.json');
  assert.equal(pipelineFailureManifest.run.integrityFailures.length, 1);
  assert.match(pipelineFailureManifest.release.decisionBasis, /diagnostic.*sharded-run\.json/i);
  assert.match(pipelineFailureManifest.warnings.join('\n'), /counts.*diagnostic only/i);

  const productionSkipped = reportTest(
    definitions[0]!,
    '[A11Y-001] production selection is skipped',
    'tests/accessibility.spec.ts',
    [],
    {
      metadata: {
        environment: 'production',
        browserLabel: 'synthetic',
        deviceClass: 'desktop',
        fullSweep: false,
        visual: false,
        tlsPolicy: 'strict',
      },
      results: [{
        status: 'skipped',
        expectedStatus: 'skipped',
        duration: 0,
        retry: 0,
        errors: [],
        attachments: [],
        stdout: [],
        stderr: [],
      }],
    },
  );
  const coverageManifest = await buildAuditManifest({
    outputDir: path.join(root, 'coverage-checklist'),
    tests: [proseCannotControlStatus, productionSkipped],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  const coverage = coverageManifest.audits[0]!.coverage;
  assert.equal(coverage.production, 0);
  assert.equal(coverage.selected.production, 1);
  assert.equal(coverage.skipped.production, 1);
  assert.match(coverageManifest.audits[0]!.baseline.note, /not tested/i);

  const applicableCandidateSkip = reportTest(
    definitions[0]!,
    '[A11Y-001] applicable Edge execution is skipped',
    'tests/accessibility.spec.ts',
    [],
    {
      idSuffix: 'edge-skip',
      projectName: 'candidate-desktop-chromium-edge-compat',
      applicability: 'candidate-desktop-chromium',
      metadata: {
        environment: 'candidate',
        browserLabel: 'Chromium / Edge-compatible desktop emulation',
        deviceClass: 'desktop',
        fullSweep: false,
        visual: true,
        tlsPolicy: 'strict',
      },
      results: [{
        status: 'skipped',
        expectedStatus: 'skipped',
        duration: 0,
        retry: 0,
        errors: [],
        attachments: [],
        stdout: [],
        stderr: [],
      }],
    },
  );
  const applicableCandidatePass = reportTest(
    definitions[0]!,
    '[A11Y-001] canonical Chromium execution passes',
    'tests/accessibility.spec.ts',
    [],
    {
      idSuffix: 'chrome-pass',
      projectName: 'candidate-desktop-chromium',
      applicability: 'candidate-desktop-chromium',
      metadata: {
        environment: 'candidate',
        browserLabel: 'Chromium / desktop',
        deviceClass: 'desktop',
        fullSweep: true,
        visual: true,
        tlsPolicy: 'strict',
      },
    },
  );
  const applicableGapManifest = await buildAuditManifest({
    outputDir: path.join(root, 'applicable-gap-checklist'),
    tests: [applicableCandidatePass, applicableCandidateSkip],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  const applicableGapAudit = applicableGapManifest.audits[0]!;
  assert.equal(applicableGapAudit.status, 'NOT_RUN', 'An applicable skipped target must prevent a PASS aggregate.');
  assert.equal(applicableGapAudit.coverage.missingApplicable.candidate, 1);
  assert.equal(applicableGapManifest.release.blockingIncomplete, 1);
  assert.equal(applicableGapManifest.release.ready, false);

  const selectedCandidateProjects = [{
    name: 'candidate-desktop-chromium',
    metadata: {
      environment: 'candidate' as const,
      browserLabel: 'Chromium / desktop',
      deviceClass: 'desktop' as const,
      fullSweep: true,
      visual: true,
      tlsPolicy: 'strict' as const,
    },
  }, {
    name: 'candidate-desktop-chromium-edge-compat',
    metadata: {
      environment: 'candidate' as const,
      browserLabel: 'Chromium / Edge-compatible desktop emulation',
      deviceClass: 'desktop' as const,
      fullSweep: false,
      visual: true,
      tlsPolicy: 'strict' as const,
    },
  }];
  const completelyMissingManifest = await buildAuditManifest({
    outputDir: path.join(root, 'completely-missing-project-checklist'),
    tests: [applicableCandidatePass],
    selectedProjects: selectedCandidateProjects,
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  const completelyMissingAudit = completelyMissingManifest.audits[0]!;
  assert.equal(
    completelyMissingAudit.status,
    'NOT_RUN',
    'A selected applicable project that emits no test row must prevent a PASS aggregate.',
  );
  assert.deepEqual(completelyMissingAudit.coverage.plannedApplicableProjects, [
    'candidate-desktop-chromium',
    'candidate-desktop-chromium-edge-compat',
  ]);
  assert.deepEqual(completelyMissingAudit.coverage.missingApplicableProjects, [
    'candidate-desktop-chromium-edge-compat',
  ]);
  assert.equal(completelyMissingAudit.coverage.missingApplicable.candidate, 1);
  assert.equal(completelyMissingManifest.release.blockingIncomplete, 1);
  assert.equal(completelyMissingManifest.release.ready, false);

  const authoritativeSelectionManifest = await buildAuditManifest({
    outputDir: path.join(root, 'authoritative-project-selection-checklist'),
    tests: [applicableCandidatePass, {
      ...applicableCandidateSkip,
      id: 'manual-evidence-row-outside-playwright-selection',
      projectName: 'manual · physical phone',
      projectMetadata: {
        environment: 'candidate',
        browserLabel: 'physical phone',
        deviceClass: 'mobile',
        fullSweep: false,
        visual: true,
        tlsPolicy: 'strict',
      },
    }],
    selectedProjects: [selectedCandidateProjects[0]!],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  assert.deepEqual(
    authoritativeSelectionManifest.audits[0]!.coverage.selectedProjects,
    ['candidate-desktop-chromium'],
    'Explicit Playwright project metadata must be authoritative; report-only/manual rows cannot expand the matrix.',
  );
  assert.deepEqual(authoritativeSelectionManifest.audits[0]!.coverage.missingApplicableProjects, []);

  const flakyRecord = evidence(definitions[0]!);
  const flakyTest = reportTest(
    definitions[0]!,
    '[A11Y-001] retry and development TLS retain both facts',
    'tests/tls-regression.spec.ts',
    [],
    {
      metadata: {
        environment: 'candidate',
        browserLabel: 'synthetic',
        deviceClass: 'mobile',
        fullSweep: false,
        visual: false,
        tlsPolicy: 'ignored-for-development',
      },
      results: [{
        status: 'failed',
        expectedStatus: 'passed',
        duration: 1,
        retry: 0,
        errors: [{ message: 'Transient synthetic failure' }],
        attachments: [],
        stdout: [],
        stderr: [],
      }, {
        status: 'passed',
        expectedStatus: 'passed',
        duration: 1,
        retry: 1,
        errors: [],
        attachments: [{
          name: 'audit-result',
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify(flakyRecord)),
        }],
        stdout: [],
        stderr: [],
      }],
    },
  );
  const flakyManifest = await buildAuditManifest({
    outputDir: path.join(root, 'flaky-tls-checklist'),
    tests: [flakyTest],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  const flakyExecution = flakyManifest.audits[0]!.executions[0]!;
  assert.equal(flakyExecution.status, 'FLAKY');
  assert.equal(flakyExecution.evidenceAuthority, 'withheld');
  assert.deepEqual(flakyExecution.reasonCodes.sort(), ['FLAKY_RETRY', 'TLS_BYPASS']);
  assert.equal(flakyManifest.audits[0]!.status, 'FLAKY');

  const lateRuntimeRecord = evidence(definitions[0]!, {
    pageErrors: ['Late hydration failed after the visible assertion.'],
  });
  const lateRuntimeManifest = await buildAuditManifest({
    outputDir: path.join(root, 'late-runtime-checklist'),
    tests: [reportTest(
      definitions[0]!,
      '[A11Y-001] late runtime failure cannot remain passed',
      'tests/runtime-regression.spec.ts',
      [],
      { record: lateRuntimeRecord },
    )],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  assert.equal(lateRuntimeManifest.audits[0]!.status, 'FAIL');
  assert.equal(lateRuntimeManifest.audits[0]!.executions[0]!.rawStatus, 'passed');

  const matchedExpectedRuntimeRecord = evidence(definitions[0]!, {
    runtimeExpectations: [{
      kind: 'response-status',
      target: 'https://candidate.example.test/__missing__',
      expected: 404,
      matched: true,
    }],
  });
  const expectedRuntimeManifest = await buildAuditManifest({
    outputDir: path.join(root, 'expected-runtime-checklist'),
    tests: [reportTest(
      definitions[0]!,
      '[A11Y-001] matched expected runtime event remains evidence',
      'tests/runtime-regression.spec.ts',
      [],
      { record: matchedExpectedRuntimeRecord },
    )],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  assert.equal(expectedRuntimeManifest.audits[0]!.status, 'PASS');

  const telemetryReportDirectory = path.join(root, 'telemetry-report');
  const telemetryMessage = `Expected Cloudflare RUM diagnostic ${'<script>not executable</script>'.repeat(40)}`;
  const telemetryRecord = evidence(definitions[0]!, {
    thirdPartyTelemetryDiagnostics: [{
      provider: 'cloudflare-rum',
      surface: 'console-error',
      message: telemetryMessage,
      sourceUrl: 'https://cloudflareinsights.com/cdn-cgi/rum',
      status: null,
    }],
  });
  const telemetryManifest = await writeAuditReport({
    outputDir: telemetryReportDirectory,
    tests: [reportTest(
      definitions[0]!,
      '[A11Y-001] classified telemetry remains visible without becoming a runtime defect',
      'tests/runtime-regression.spec.ts',
      [],
      { record: telemetryRecord },
    )],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  assert.equal(telemetryManifest.audits[0]!.status, 'PASS');
  const telemetryDetail = JSON.parse(await readFile(
    path.join(telemetryReportDirectory, 'data', 'audits', 'A11Y-001.json'),
    'utf8',
  )) as {
    executions: Array<{ evidence: {
      totals: { thirdPartyTelemetryDiagnostics: number };
      thirdPartyTelemetryDiagnostics: Array<{ message: string; provider: string; sourceUrl: string | null; status: number | null }>;
    } }>;
  };
  const portalTelemetry = telemetryDetail.executions[0]!.evidence.thirdPartyTelemetryDiagnostics;
  assert.equal(telemetryDetail.executions[0]!.evidence.totals.thirdPartyTelemetryDiagnostics, 1);
  assert.equal(portalTelemetry.length, 1);
  assert.equal(portalTelemetry[0]!.provider, 'cloudflare-rum');
  assert.equal(portalTelemetry[0]!.sourceUrl, 'https://cloudflareinsights.com/cdn-cgi/rum');
  assert.equal(portalTelemetry[0]!.status, null);
  assert(portalTelemetry[0]!.message.length <= 700, 'Portal telemetry messages must remain byte-safe and bounded for large runs');

  const analyticsNearMissRecord = evidence(definitions[0]!, {
    consoleErrors: ['Application says Cookie “_ga” has been rejected for invalid domain.'],
  });
  const analyticsNearMissManifest = await buildAuditManifest({
    outputDir: path.join(root, 'analytics-near-miss-checklist'),
    tests: [reportTest(
      definitions[0]!,
      '[A11Y-001] analytics-shaped application errors remain release failures',
      'tests/runtime-regression.spec.ts',
      [],
      { record: analyticsNearMissRecord },
    )],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [definitions[0]!],
  });
  assert.equal(analyticsNearMissManifest.audits[0]!.status, 'FAIL');

  const interactionDefinition: AuditDefinition = {
    ...definitions[0]!,
    id: 'ACTION-001',
    title: 'Interaction video integrity',
    evidence: ['video', 'json'],
    evidencePolicy: {
      mode: 'interaction-video',
      rationale: 'Show the action and its visible response in one reviewable clip.',
    },
  };
  const missingVideoManifest = await buildAuditManifest({
    outputDir: path.join(root, 'smoke-video-checklist'),
    tests: [reportTest(
      interactionDefinition,
      '[ACTION-001] successful smoke interaction needs video',
      'tests/smoke.spec.ts',
    )],
    run: { status: 'passed', source: 'playwright-json', profile: 'smoke' },
    definitionCatalog: [interactionDefinition],
  });
  const missingVideo = missingVideoManifest.audits[0]!.executions[0]!;
  assert.equal(missingVideo.status, 'PASS');
  assert.equal(missingVideo.evidenceAuthority, 'withheld');
  assert.equal(missingVideo.reasonCodes.includes('MISSING_REQUIRED_EVIDENCE'), true);
  assert.equal(missingVideoManifest.audits[0]!.status, 'REVIEW');

  const staticDefinition: AuditDefinition = {
    ...definitions[0]!,
    id: 'STATIC-001',
    title: 'Static evidence integrity',
    evidence: ['screenshot', 'json'],
    evidencePolicy: {
      mode: 'static-screenshot',
      rationale: 'Capture a named visible state that directly supports the assertion.',
    },
  };
  const staticRecord = evidence(staticDefinition);
  const forbiddenMediaTest = reportTest(
    staticDefinition,
    '[STATIC-001] generic and wrong-mode media are rejected',
    'tests/static.spec.ts',
    [],
    {
      results: [{
        status: 'passed',
        expectedStatus: 'passed',
        duration: 1,
        retry: 0,
        errors: [],
        attachments: [{
          name: 'audit-result',
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify(staticRecord)),
        }, {
          name: 'screenshot',
          contentType: 'image/png',
          body: Buffer.from('generic diagnostic screenshot'),
        }, {
          name: 'video',
          contentType: 'video/webm',
          body: Buffer.from('wrong mode video'),
        }],
        stdout: [],
        stderr: [],
      }],
    },
  );
  const forbiddenMediaModels = await buildAuditModels({
    outputDir: path.join(root, 'forbidden-media-checklist'),
    tests: [forbiddenMediaTest],
    run: { status: 'passed', source: 'playwright-json', profile: 'self-test' },
    definitionCatalog: [staticDefinition],
  });
  const forbiddenMediaManifest = forbiddenMediaModels.manifest;
  const forbiddenMedia = forbiddenMediaManifest.audits[0]!.executions[0]!;
  assert.equal(forbiddenMedia.evidenceAuthority, 'withheld');
  assert.equal(forbiddenMedia.reasonCodes.includes('FORBIDDEN_PRIMARY_MEDIA'), true);
  assert.equal(forbiddenMedia.reasonCodes.includes('MISSING_REQUIRED_EVIDENCE'), true);
  assert.equal(forbiddenMedia.primaryArtifacts.some(({ kind }) => kind === 'screenshot' || kind === 'video'), false);
  assert.equal(forbiddenMedia.diagnosticArtifacts.filter(({ kind }) => kind === 'screenshot' || kind === 'video').length, 2);
  for (const item of forbiddenMediaModels.galleryCatalog.items) {
    const attempt = item.attempt as typeof item.attempt & {
      rawStatus: string;
      statusSource: string;
      reviewReasonCodes: string[];
    };
    assert.equal(attempt.rawStatus, 'passed');
    assert.equal(attempt.status, 'REVIEW');
    assert.equal(attempt.statusSource, 'reviewed-manifest');
    assert.equal(attempt.reviewReasonCodes.includes('FORBIDDEN_PRIMARY_MEDIA'), true);
    assert(attempt.reviewReasonCodes.length <= 12);
    assert(attempt.reviewReasonCodes.every((code) => code.length <= 120));
  }
  console.log('Report audit ID self-test passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
