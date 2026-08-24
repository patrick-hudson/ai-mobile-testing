import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bracketedAuditIds, firstBracketedAuditId } from '../audit/audit-id.js';
import { AUDIT_EVIDENCE_POLICY_ANNOTATION, serializeEvidencePolicy } from '../audit/evidence-policy.js';
import type { AuditDefinition, AuditEvidenceRecord } from '../audit/types.js';
import { buildAuditManifest, type ReportTestInput } from '../reporters/report-model.js';

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
  },
];

function evidence(definition: AuditDefinition): AuditEvidenceRecord {
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
  };
}

function reportTest(
  definition: AuditDefinition,
  title: string,
  file: string,
  extraTitlePath: string[] = [],
): ReportTestInput {
  const record = evidence(definition);
  return {
    id: `audit-id-self-test-${definition.id}`,
    title,
    titlePath: [file, ...extraTitlePath, title],
    file,
    projectName: 'candidate-self-test',
    projectMetadata: {
      environment: 'candidate',
      browserLabel: 'synthetic',
      deviceClass: 'mobile',
      fullSweep: false,
      visual: false,
      tlsPolicy: 'strict',
    },
    annotations: [
      { type: 'audit-id', description: definition.id },
      { type: AUDIT_EVIDENCE_POLICY_ANNOTATION, description: serializeEvidencePolicy(definition.evidencePolicy) },
    ],
    results: [{
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

  assert.deepEqual(manifest.audits.map(({ id }) => id), ['A11Y-001', 'PAGE-HOME', 'SHELL-006']);
  assert.equal(manifest.audits.find(({ id }) => id === 'A11Y-001')?.executions[0]?.structuredEvidence, true);
  assert.equal(manifest.audits.find(({ id }) => id === 'A11Y-001')?.executions[0]?.auditId, 'A11Y-001');
  assert.equal(manifest.audits.some(({ id }) => id === 'UNMAPPED'), false);
  assert.equal(manifest.audits.some(({ id }) => id === 'PAGE-AUDIT'), false);
  assert.equal(manifest.audits.some(({ id }) => id === 'PAGE-LEVEL'), false);
  assert.deepEqual(manifest.unmappedTests, []);
  console.log('Report audit ID self-test passed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
