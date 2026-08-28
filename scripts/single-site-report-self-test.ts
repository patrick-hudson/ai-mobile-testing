import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildAuditManifest,
  writeSingleSiteAuditReport,
} from '../reporters/report-model.js';
import {
  buildSingleSiteReportDocuments,
  parseSingleSiteReportSummary,
  type SingleSiteReportAuditInput,
  type SingleSiteReportInput,
} from './lib/site-health-report.mjs';
import {
  loadComparativeReportPublication,
  loadReportPublication,
  loadSingleSiteReportPublication,
  readPublishedReportJson,
  validateCompleteReportPublication,
} from '../portal/report-publication.mjs';

const revision = '1234567890abcdef1234567890abcdef';
const generatedAt = '2026-08-25T12:00:00.000Z';
const url = 'https://beta.quitting7oh-org.pages.dev';

function audit(index: number, findingCount = 0): SingleSiteReportAuditInput {
  return {
    id: `AUDIT-${String(index).padStart(4, '0')}`,
    title: `Bounded audit ${index}`,
    area: index % 2 === 0 ? 'Navigation' : 'Content',
    status: findingCount > 0 ? 'FAIL' : 'PASS',
    findingCount,
    evidenceStatus: 'complete',
    artifactCount: 2,
    manual: false,
    visualStatus: index % 9 === 0 ? 'CHANGED' : 'UNCHANGED',
    detail: `Deterministic standalone Product Oracle result for audit ${index}.`,
  };
}

function reportInput(overrides: Partial<SingleSiteReportInput> = {}): SingleSiteReportInput {
  const selectedCoverage = Array.from({ length: 123 }, (_, index) => `SELECTED-${String(index).padStart(4, '0')}`);
  const omittedCoverage = Array.from({ length: 37 }, (_, index) => `OMITTED-${String(index).padStart(4, '0')}`);
  const audits = Array.from({ length: 121 }, (_, index) => audit(index + 1, index === 0 ? 1 : 0));
  const base: SingleSiteReportInput = {
    schemaVersion: 1,
    mode: 'single-site',
    generatedAt,
    pageSize: 25,
    health: {
      schemaVersion: 1,
      mode: 'single-site',
      url,
      deploymentRole: 'preview',
      scope: { qualifier: 'TARGETED', selectedCoverage, omittedCoverage },
      coverage: {
        finalized: true,
        manifestIntegrity: true,
        gaps: ['GENERIC-001 has no reviewed route Product Oracle.'],
        limitations: ['Browser-rendered navigation enumeration was unavailable.'],
      },
      pipeline: {
        executionStatus: 'completed',
        integrityComplete: true,
        requiredEvidenceComplete: true,
        reason: 'Every required stage completed under the current fencing token.',
      },
      evidenceAuthority: {
        status: 'non-authoritative',
        reasons: ['development-certificate-bypass'],
      },
      findings: [{ id: 'finding-1', severity: 'P1' }],
      manual: { required: 3, complete: 1, failedOrBlocked: 0 },
      visualReview: {
        items: [{ status: 'UNCHANGED' }, { status: 'CHANGED' }, { status: 'unavailable' }],
      },
    },
    audits,
    outsideMode: Array.from({ length: 31 }, (_, index) => ({
      auditId: `PAIRED-${String(index + 1).padStart(4, '0')}`,
      title: `Comparison-only contract ${index + 1}`,
      reason: 'comparison-only' as const,
    })),
  };
  return { ...base, ...overrides };
}

const productionFinding = buildSingleSiteReportDocuments({
  ...reportInput(),
  health: {
    ...reportInput().health,
    deploymentRole: 'production',
    scope: { qualifier: 'FULL', selectedCoverage: ['AUDIT-0001'], omittedCoverage: [] },
    evidenceAuthority: { status: 'authoritative', reasons: [] },
  },
  audits: [audit(1, 1)],
  outsideMode: [],
}, { publicationRevision: revision }).summary;
assert.equal(productionFinding.deploymentRole, 'production');
assert.equal(productionFinding.siteHealth.verdict, 'FINDINGS');
assert.equal(productionFinding.promotion.effect, 'none');
assert(!('release' in productionFinding));

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-report-'));
try {
  const runDirectory = path.join(temporaryRoot, 'single-site-run');
  const outputDir = path.join(runDirectory, 'checklist');
  const written = await writeSingleSiteAuditReport({
    outputDir,
    input: reportInput(),
    publicationRevision: revision,
  });
  assert.equal(written.siteHealth.verdict, 'FINDINGS');
  assert.equal(written.siteHealth.displayLabel, 'FINDINGS · TARGETED · NON-AUTHORITATIVE');
  assert.equal(written.auditedUrl, url);
  assert.equal(written.deploymentRole, 'preview');
  assert.equal(written.scope.selected.total, 123);
  assert.equal(written.scope.omitted.total, 37);
  assert.equal(written.scope.outsideMode.total, 31);
  assert.equal(written.coverage.status, 'GAPS');
  assert.equal(written.evidenceCompletion.status, 'complete');
  assert.equal(written.evidenceAuthority.status, 'non-authoritative');
  assert.equal(written.findings.count, 1);
  assert.equal(written.manual.status, 'OUTSTANDING');
  assert.equal(written.visualReview.attentionRequired, 1);
  assert.equal(written.lifecycle.executionStatus, 'completed');
  assert.equal(written.pipelineIntegrity.status, 'complete');
  assert.deepEqual(written.promotion, {
    authorized: false,
    effect: 'none',
    statement: 'Site Health is advisory and does not authorize or block promotion.',
  });

  const publication = await loadSingleSiteReportPublication(runDirectory);
  assert.equal(publication.mode, 'single-site');
  assert.equal(publication.kind, 'single-site-report-publication');
  assert(!publication.files['audits.json'], 'Single-site details must remain paged instead of monolithic.');
  assert.equal(Object.keys(publication.files).filter((entry) => entry.startsWith('audits/page-')).length, 5);
  assert(Object.values(publication.files).every(({ bytes }) => bytes <= 512 * 1024));
  const validation = await validateCompleteReportPublication(runDirectory);
  assert.deepEqual(validation.problems, []);
  assert.equal(validation.summary?.scope.selected.total, 123);
  const currentPointerPath = path.join(outputDir, 'data', 'current.json');
  await fs.unlink(currentPointerPath);
  await fs.writeFile(path.join(outputDir, 'data', `.current-${revision}.tmp`), 'stale pre-restart temp\n');
  const repeated = await writeSingleSiteAuditReport({
    outputDir,
    input: reportInput(),
    publicationRevision: revision,
  });
  assert.deepEqual(repeated, written, 'an exact report-publication retry must reuse its immutable revision');
  assert.deepEqual((await validateCompleteReportPublication(runDirectory)).problems, []);
  await assert.rejects(
    writeSingleSiteAuditReport({
      outputDir,
      input: reportInput({ generatedAt: '2026-08-25T12:01:00.000Z' }),
      publicationRevision: revision,
    }),
    /conflicts with immutable file/,
  );

  const firstAuditPage = (await readPublishedReportJson(
    publication,
    'audits/page-000001.json',
    512 * 1024,
  )).document;
  assert.equal(firstAuditPage.items.length, 25);
  assert.equal(firstAuditPage.total, 121);
  await assert.rejects(
    loadComparativeReportPublication(runDirectory),
    /cannot be read as a comparative release report/,
  );

  assert.throws(() => parseSingleSiteReportSummary({
    ...written,
    siteHealth: { ...written.siteHealth, displayLabel: 'FINDINGS' },
  }), /scope\/authority qualified/);

  const legacyRun = path.join(temporaryRoot, 'legacy-run');
  const legacyRevision = 'abcdefabcdefabcdefabcdefabcdefab';
  const legacyGeneratedAt = '2026-08-24T10:00:00.000Z';
  const legacyRevisionDir = path.join(legacyRun, 'checklist', 'data', 'revisions', legacyRevision);
  await fs.mkdir(path.join(legacyRevisionDir, 'audits'), { recursive: true });
  const legacyDocuments = new Map([
    ['summary.json', `${JSON.stringify({
      schemaVersion: 1,
      publicationRevision: legacyRevision,
      generatedAt: legacyGeneratedAt,
      summary: { total: 1 },
      release: { decision: 'READY' },
    })}\n`],
    ['audits.json', `${JSON.stringify({
      schemaVersion: 1,
      publicationRevision: legacyRevision,
      generatedAt: legacyGeneratedAt,
      items: [{ id: 'HOME-001' }],
    })}\n`],
    ['audits/HOME-001.json', `${JSON.stringify({
      schemaVersion: 1,
      publicationRevision: legacyRevision,
      generatedAt: legacyGeneratedAt,
      id: 'HOME-001',
    })}\n`],
  ]);
  for (const [relativePath, source] of legacyDocuments) {
    await fs.writeFile(path.join(legacyRevisionDir, relativePath), source, 'utf8');
  }
  const legacyPointer = `${JSON.stringify({
    schemaVersion: 1,
    publicationRevision: legacyRevision,
    generatedAt: legacyGeneratedAt,
    files: Object.fromEntries([...legacyDocuments].map(([relativePath, source]) => [relativePath, {
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
    }])),
  })}\n`;
  await fs.writeFile(path.join(legacyRevisionDir, 'publication.json'), legacyPointer, 'utf8');
  await fs.mkdir(path.join(legacyRun, 'checklist', 'data'), { recursive: true });
  await fs.writeFile(path.join(legacyRun, 'checklist', 'data', 'current.json'), legacyPointer, 'utf8');
  const legacyPublication = await loadComparativeReportPublication(legacyRun);
  assert.equal(legacyPublication.mode, 'comparative-legacy');
  assert.deepEqual((await validateCompleteReportPublication(legacyRun)).problems, []);
  await assert.rejects(
    loadSingleSiteReportPublication(legacyRun),
    /cannot be read as a Single-site Site Health report/,
  );

  await assert.rejects(
    buildAuditManifest({
      outputDir: path.join(temporaryRoot, 'must-not-write'),
      tests: [{
        id: 'single-site-test',
        title: 'single site must not become comparative',
        titlePath: ['single site must not become comparative'],
        file: 'tests/example.spec.ts',
        projectName: 'single-site-mobile-chromium',
        projectMetadata: {
          mode: 'single-site',
          deploymentRole: 'preview',
          sourceComparativeTargetId: 'candidate-mobile-chromium',
          baseURL: url,
          browserLabel: 'Chromium',
          deviceClass: 'mobile',
          fullSweep: true,
          visual: true,
          tlsPolicy: 'strict',
          evidenceAuthority: { status: 'authoritative', reasons: [] },
        },
        results: [],
      }],
      selectedProjects: [],
      run: { status: 'passed', source: 'playwright-json' },
      definitionCatalog: [],
    }),
    /cannot be passed to the comparative release report builder/,
  );
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write('Single-site compact report self-test passed: mode isolation, advisory truth, bounded pages, immutable publication, and comparative legacy compatibility are enforced.\n');
