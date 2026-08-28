import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConsoleIndex } from '../portal/console-index.mjs';
import {
  createConsoleReportProjectionTask,
  runConsoleReportProjectionTaskSlice,
} from '../portal/console-report-indexer.mjs';
import {
  CONSOLE_REPORT_PROJECTION_LIMITS,
  decodeReportProjectionCheckpoint,
  projectReportPublicationBatch,
  reportArtifactDestination,
} from '../portal/console-report-projection.mjs';
import {
  loadComparativeReportPublication,
  loadSingleSiteReportPublication,
} from '../portal/report-publication.mjs';
import { buildSingleSiteReportDocuments } from './lib/site-health-report.mjs';

const comparativeRevision = '11111111111111111111111111111111';
const comparativeRevisionTwo = '22222222222222222222222222222222';
const singleSiteRevision = '33333333333333333333333333333333';
const generatedAt = '2026-08-26T15:00:00.000Z';

assert.equal(
  reportArtifactDestination('comparative', 'run-projection-1', 'attachments/interaction.webm'),
  '/artifacts/run-projection-1/checklist/attachments/interaction.webm',
);
assert.equal(
  reportArtifactDestination('single-site', 'job-projection-1', 'browser/output image.png'),
  '/single-site-artifacts/job-projection-1/browser/output%20image.png',
  'Single-site evidence must resolve only through its attempt-contained artifact route.',
);
assert.equal(reportArtifactDestination('single-site', 'job-projection-1', '../escape.webm'), null);

async function writePublication(root, { revision, generated, mode, documents }) {
  const revisionDirectory = path.join(root, 'checklist', 'data', 'revisions', revision);
  await mkdir(revisionDirectory, { recursive: true });
  const sources = new Map([...documents].map(([relativePath, document]) => [relativePath, `${JSON.stringify(document)}\n`]));
  for (const [relativePath, source] of sources) {
    const destination = path.join(revisionDirectory, ...relativePath.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source, 'utf8');
  }
  const publication = {
    schemaVersion: 1,
    ...(mode === 'single-site' ? { kind: 'single-site-report-publication', mode } : {}),
    publicationRevision: revision,
    generatedAt: generated,
    files: Object.fromEntries([...sources].map(([relativePath, source]) => [relativePath, {
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
    }])),
  };
  const pointer = `${JSON.stringify(publication)}\n`;
  await writeFile(path.join(revisionDirectory, 'publication.json'), pointer, 'utf8');
  await mkdir(path.join(root, 'checklist', 'data'), { recursive: true });
  await writeFile(path.join(root, 'checklist', 'data', 'current.json'), pointer, 'utf8');
}

function comparativeDocuments(revision, generated = generatedAt) {
  const finding = {
    auditId: 'NAV-001',
    auditTitle: 'Navigation history',
    area: 'navigation',
    severity: 'P0',
    blocking: true,
    releaseBlocking: true,
    title: 'Back navigation loses the selected record',
    detail: 'The selected finding is no longer visible after browser history restoration.',
    environment: 'candidate',
    coveredEnvironments: ['candidate'],
  };
  const attention = {
    auditId: 'DEVICE-001',
    auditTitle: 'Real device acceptance',
    area: 'responsive',
    auditStatus: 'MANUAL_REQUIRED',
    severity: 'P1',
    releaseBlocking: true,
    scope: 'candidate',
    detail: 'A physical-device review remains outstanding.',
    reasonCodes: ['manual-required'],
    evidence: [{
      name: 'interaction.webm',
      kind: 'video',
      href: 'attachments/interaction.webm',
      sizeBytes: 120,
      attempt: 2,
      context: 'final-primary',
    }],
  };
  const auditRow = {
    id: 'NAV-001',
    area: 'navigation',
    title: 'Navigation history',
    severity: 'P0',
    releaseBlocking: true,
    status: 'FAIL',
    reason: 'The current candidate failed the navigation contract.',
    manual: false,
    baseline: { hasIssues: false, issueCount: 0, note: 'No baseline issue.' },
    evidenceCounts: { video: 1, screenshot: 2, trace: 0, axe: 0, network: 0, lighthouse: 0, json: 0, other: 0 },
    findingCount: 1,
    findingPreview: [finding],
    executionCount: 1,
  };
  return new Map([
    ['summary.json', {
      schemaVersion: 1,
      publicationRevision: revision,
      generatedAt: generated,
      run: { status: 'failed', durationMs: 12_345 },
      release: {
        decision: 'NOT_READY',
        reason: 'A release-blocking Product Finding is present.',
        decisionBasis: 'Published checklist authority.',
        runIntegrityFailure: false,
        authoritativeReleaseSource: 'checklist/manifest.json',
      },
      summary: { total: 2, artifacts: 3, baselineIssues: 0, byStatus: { FLAKY: 0 } },
      manualEvidence: { required: 1, complete: 0, outstanding: 1, failedOrBlocked: 0 },
      topFindings: [finding],
      topFindingCount: 1,
      topAttention: [attention],
      topAttentionCount: 1,
      warnings: [],
    }],
    ['audits.json', {
      schemaVersion: 1,
      publicationRevision: revision,
      generatedAt: generated,
      items: [auditRow],
    }],
    ['audits/NAV-001.json', {
      schemaVersion: 1,
      publicationRevision: revision,
      generatedAt: generated,
      ...auditRow,
      executionReturned: 1,
      executionsTruncated: false,
      findings: [finding],
      findingsTruncated: false,
      executions: [{
        id: 'nav-execution-1',
        title: 'Navigation history execution',
        project: 'candidate-desktop-chromium',
        status: 'FAIL',
        rawStatus: 'failed',
        evidenceAuthority: 'authoritative',
        reasonCodes: ['assertion-failure'],
        retry: 1,
        durationMs: 12_345,
        startedAt: '2026-08-26T14:59:00.000Z',
        attemptHistory: [
          { attempt: 1, retry: 0, status: 'failed' },
          { attempt: 2, retry: 1, status: 'failed' },
        ],
        artifacts: [
          { name: 'interaction.webm', kind: 'video', href: 'attachments/interaction.webm', available: true },
          { name: 'missing.png', kind: 'screenshot', href: 'attachments/missing.png', available: false, missing: true, error: 'The declared screenshot was missing.' },
          { name: 'orphan.png', kind: 'screenshot', href: 'attachments/orphan.png', available: true, orphan: true },
        ],
        evidence: {
          steps: [{ name: 'Use browser Back', expected: 'The same selected record remains visible.', status: 'failed', detail: 'Selection was lost.' }],
        },
      }],
    }],
  ]);
}

function singleSiteInput() {
  return {
    schemaVersion: 1,
    mode: 'single-site',
    generatedAt,
    pageSize: 10,
    health: {
      schemaVersion: 1,
      mode: 'single-site',
      url: 'https://preview.example.test',
      deploymentRole: 'preview',
      scope: { qualifier: 'TARGETED', selectedCoverage: ['NAV-001'], omittedCoverage: ['SEARCH-001'] },
      coverage: { finalized: true, manifestIntegrity: true, gaps: ['SEARCH-001 has no selected standalone oracle.'], limitations: [] },
      pipeline: { executionStatus: 'completed', integrityComplete: true, requiredEvidenceComplete: true, reason: 'The bounded worker publication completed.', cancellationReason: null },
      evidenceAuthority: { status: 'authoritative', reasons: [] },
      findings: [{ id: 'single-finding-1', severity: 'P1' }],
      manual: { required: 1, complete: 0, failedOrBlocked: 0 },
      visualReview: { items: [{ status: 'CHANGED' }] },
    },
    audits: [{
      id: 'NAV-001',
      title: 'Navigation history',
      area: 'navigation',
      status: 'FAIL',
      findingCount: 1,
      evidenceStatus: 'complete',
      artifactCount: 2,
      manual: false,
      visualStatus: 'CHANGED',
      detail: 'One deterministic standalone Product Oracle finding was published.',
    }],
    outsideMode: [],
  };
}

async function collect(publication, identity, scopeKey, options = {}) {
  const records = new Map();
  const batches = [];
  const limitations = new Set();
  let cursor = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const batch = await projectReportPublicationBatch({ publication, identity, scopeKey, cursor }, options);
    batches.push(batch);
    for (const record of batch.records) records.set(record.recordId, record);
    for (const limitation of batch.limitations) limitations.add(limitation);
    if (batch.done) return { records: [...records.values()], batches, limitations: [...limitations], final: batch };
    assert(batch.cursor, 'An incomplete projection must expose a resumable cursor.');
    cursor = batch.cursor;
  }
  throw new Error('Projection did not complete within its deterministic guard.');
}

async function drainProjectionTask(task, options = {}) {
  for (let guard = 0; guard < 100 && task.status === 'pending'; guard += 1) {
    await runConsoleReportProjectionTaskSlice(task, options);
  }
  assert.notEqual(task.status, 'pending', 'Projection maintenance must finish within its deterministic guard.');
  return task;
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'console-report-projection-'));
try {
  const comparativeRoot = path.join(temporaryRoot, 'comparative');
  await writePublication(comparativeRoot, {
    revision: comparativeRevision,
    generated: generatedAt,
    mode: 'comparative',
    documents: comparativeDocuments(comparativeRevision),
  });
  const comparative = await loadComparativeReportPublication(comparativeRoot);
  const identity = { mode: 'comparative', runId: 'run-projection-1' };
  const batchOptions = { limit: 3, maximumDocuments: 1, maximumSourceBytes: 1024 * 1024 };
  const first = await projectReportPublicationBatch({ publication: comparative, identity, scopeKey: 'release-full' }, batchOptions);
  const repeated = await projectReportPublicationBatch({ publication: comparative, identity, scopeKey: 'release-full' }, batchOptions);
  assert.deepEqual(repeated, first, 'Replaying one checkpoint must produce the same batch and batch ID.');
  assert.equal(first.generation.resetPreviousGeneration, true);
  assert(first.records.length <= 3);
  assert(first.work.sourceFilesRead <= 1);
  assert(first.work.sourceBytesRead <= 1024 * 1024);
  assert(first.cursor);
  assert.deepEqual(decodeReportProjectionCheckpoint(first.cursor), first.checkpoint);
  assert.throws(
    () => decodeReportProjectionCheckpoint(`${first.cursor.slice(0, -1)}x`),
    /checkpoint/i,
  );

  const projected = await collect(comparative, identity, 'release-full', batchOptions);
  assert(projected.batches.every((batch) => batch.records.length <= 3));
  assert(projected.batches.every((batch) => batch.work.sourceFilesRead <= 1));
  assert.equal(projected.final.done, true);
  assert.equal(projected.final.cursor, null);
  const index = createConsoleIndex();
  const comparativeTask = createConsoleReportProjectionTask({
    index,
    publication: comparative,
    identity,
    scopeKey: 'release-full',
  });
  await drainProjectionTask(comparativeTask, batchOptions);
  assert.equal(comparativeTask.status, 'committed');
  assert.equal(comparativeTask.recordsProjected, projected.records.length);
  const indexedTypes = new Set(index.page({
    mode: 'comparative',
    scopeKey: 'all',
    normalizedFilterKey: 'projection-proof',
    cursor: null,
    limit: 100,
    recordTypes: ['run', 'risk', 'trust', 'attention', 'evidence', 'metric', 'timeline', 'provenance'],
  }).items.map(({ recordType }) => recordType));
  for (const expectedType of ['risk', 'trust', 'evidence', 'metric']) {
    assert(indexedTypes.has(expectedType), `Completed report projection must publish a real ${expectedType} record.`);
  }

  const risks = projected.records.filter(({ recordType }) => recordType === 'risk');
  assert.equal(risks.length, 1, 'Summary, index, and detail copies of one Finding must retain one stable record ID.');
  assert.equal(risks[0].fields.severity, 'P0');
  assert.equal(risks[0].fields.blocking, true);
  assert.equal(risks[0].fields.novelty, null, 'A report projection cannot synthesize Comparable Predecessor novelty.');
  assert.equal('score' in risks[0].fields, false);
  const evidence = projected.records.filter(({ recordType }) => recordType === 'evidence');
  assert(evidence.some(({ fields }) => fields.sourceKind === 'video' && fields.status === 'available'));
  assert(evidence.some(({ fields }) => fields.destinations?.includes(
    '/artifacts/run-projection-1/checklist/attachments/interaction.webm',
  )));
  assert(evidence.some(({ fields }) => fields.status === 'missing'));
  assert(evidence.some(({ fields }) => fields.status === 'orphan'));
  assert(evidence.every(({ fields }) => fields.attemptNumber === undefined || fields.attemptNumber === null), 'Detail artifacts without an attempt binding must not inherit the latest attempt.');
  const attemptProvenance = projected.records.find(({ fields }) => fields.sourceRecordType === 'artifact-attempt');
  assert.equal(attemptProvenance?.fields.attemptNumber, 2);
  assert(projected.records.some(({ fields }) => fields.sourceRecordType === 'step' && fields.title === 'Use browser Back'));
  assert(projected.records.some(({ fields }) => fields.sourceRecordType === 'execution'
    && fields.attemptNumber === 2 && fields.retryNumber === 1));
  assert(projected.records.filter(({ recordType }) => recordType === 'metric').length <= 6);
  assert.equal(JSON.stringify(projected.records).includes('password='), false);

  const comparativeRootTwo = path.join(temporaryRoot, 'comparative-two');
  const generatedTwo = '2026-08-26T16:00:00.000Z';
  await writePublication(comparativeRootTwo, {
    revision: comparativeRevisionTwo,
    generated: generatedTwo,
    mode: 'comparative',
    documents: comparativeDocuments(comparativeRevisionTwo, generatedTwo),
  });
  const comparativeTwo = await loadComparativeReportPublication(comparativeRootTwo);
  const generationTwo = await projectReportPublicationBatch({ publication: comparativeTwo, identity, scopeKey: 'release-full' }, batchOptions);
  assert.equal(generationTwo.generation.resetPreviousGeneration, true);
  assert.notEqual(generationTwo.generation.key, first.generation.key);
  const projectedTwo = await collect(comparativeTwo, identity, 'release-full', batchOptions);
  assert.equal(projectedTwo.records.find(({ recordType }) => recordType === 'risk')?.recordId, risks[0].recordId,
    'Stable record IDs let an atomic generation replacement remove stale rows without duplicating surviving authority.');
  await assert.rejects(
    projectReportPublicationBatch({ publication: comparativeTwo, identity, scopeKey: 'release-full', cursor: first.cursor }, batchOptions),
    /does not match this publication generation/,
  );

  const singleRoot = path.join(temporaryRoot, 'single-site');
  const singleDocuments = buildSingleSiteReportDocuments(singleSiteInput(), {
    publicationRevision: singleSiteRevision,
  }).documents;
  await writePublication(singleRoot, {
    revision: singleSiteRevision,
    generated: generatedAt,
    mode: 'single-site',
    documents: singleDocuments,
  });
  const single = await loadSingleSiteReportPublication(singleRoot);
  const singleSummaryBytes = single.files['summary.json'].bytes;
  const firstSingleDetailPath = Object.keys(single.files).filter((relativePath) => relativePath !== 'summary.json').sort()[0];
  const singleAuditIndexBytes = single.files[firstSingleDetailPath].bytes;
  const summaryOnly = await projectReportPublicationBatch({
    publication: single,
    identity: { mode: 'single-site', runId: 'job-projection-zero-progress' },
    scopeKey: 'targeted-mobile',
  }, { limit: 100, maximumDocuments: 1, maximumSourceBytes: CONSOLE_REPORT_PROJECTION_LIMITS.maximumSourceBytesPerBatch });
  assert(summaryOnly.cursor, 'The summary-only slice must leave a checkpoint for the next valid document.');
  const combinationTooLarge = await projectReportPublicationBatch({
    publication: single,
    identity: { mode: 'single-site', runId: 'job-projection-zero-progress' },
    scopeKey: 'targeted-mobile',
    cursor: summaryOnly.cursor,
  }, {
    limit: 100,
    maximumDocuments: 1,
    maximumDocumentBytes: Math.max(singleSummaryBytes, singleAuditIndexBytes),
    maximumSourceBytes: singleSummaryBytes + singleAuditIndexBytes - 1,
  });
  assert.notEqual(combinationTooLarge.cursor, summaryOnly.cursor,
    'A valid document that cannot share the batch with its summary must never repeat the same checkpoint.');
  assert(combinationTooLarge.limitations.includes('source-document-too-large'));
  assert.equal(combinationTooLarge.complete, false);
  const singleProjected = await collect(single, { mode: 'single-site', runId: 'job-projection-1' }, 'targeted-mobile', {
    limit: 4,
    maximumDocuments: 1,
    maximumSourceBytes: CONSOLE_REPORT_PROJECTION_LIMITS.maximumSourceBytesPerBatch,
  });
  const singleIndex = createConsoleIndex();
  const singleTask = createConsoleReportProjectionTask({
    index: singleIndex,
    publication: single,
    identity: { mode: 'single-site', runId: 'job-projection-1' },
    scopeKey: 'targeted-mobile',
  });
  await drainProjectionTask(singleTask, {
    limit: 4,
    maximumDocuments: 1,
    maximumSourceBytes: CONSOLE_REPORT_PROJECTION_LIMITS.maximumSourceBytesPerBatch,
  });
  assert.equal(singleTask.status, 'committed');
  assert.equal(singleProjected.records.some(({ recordType }) => recordType === 'risk'), false,
    'Single-site audit pages do not publish canonical finding severity/blocking identity and must not become ranked Product Risk.');
  const singleAttention = singleProjected.records.find(({ recordType }) => recordType === 'attention');
  assert.equal(singleAttention?.fields.attentionKind, 'finding-summary');
  assert.equal(singleAttention?.fields.severity, null);
  assert.equal(singleAttention?.fields.blocking, null);
  assert(singleProjected.limitations.includes('single-site-finding-severity-and-identity-unavailable'));
  assert(singleProjected.records.some(({ recordType, fields }) => recordType === 'evidence'
    && fields.auditId === 'NAV-001' && fields.status === 'complete' && fields.visualStatus === 'CHANGED'));
  assert(singleProjected.records.some(({ recordType, fields }) => recordType === 'trust'
    && fields.sourceKind === 'coverage-detail' && fields.status === 'gap'));
  assert.equal(singleProjected.final.complete, false, 'Missing Single-site ranking authority must remain explicitly incomplete.');

  const purgeIndex = createConsoleIndex();
  const purgeIdentity = { mode: 'comparative', runId: 'run-projection-purge' };
  const purgeTask = createConsoleReportProjectionTask({
    index: purgeIndex,
    publication: comparative,
    identity: purgeIdentity,
    scopeKey: 'release-full',
  });
  await runConsoleReportProjectionTaskSlice(purgeTask, batchOptions);
  assert.equal(purgeTask.status, 'pending');
  purgeIndex.beginPurge(purgeIdentity, {
    sourceId: 'comparative-report-publication',
    sourceRevision: comparativeRevision,
    updatedAt: generatedAt,
  });
  await runConsoleReportProjectionTaskSlice(purgeTask, batchOptions);
  assert.equal(purgeTask.status, 'rejected');
  assert.equal(purgeTask.reason, 'stale-capture');
  assert.equal(purgeIndex.diagnostics().records, 0, 'Purge must block all late staged report records.');

  const cancelledIndex = createConsoleIndex();
  const cancelledTask = createConsoleReportProjectionTask({
    index: cancelledIndex,
    publication: comparative,
    identity: { mode: 'comparative', runId: 'run-projection-cancelled' },
    scopeKey: 'release-full',
  });
  const cancelled = new AbortController();
  cancelled.abort(new DOMException('Maintenance stopped.', 'AbortError'));
  await assert.rejects(
    runConsoleReportProjectionTaskSlice(cancelledTask, { ...batchOptions, signal: cancelled.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(cancelledTask.status, 'cancelled');
  assert.equal(cancelledIndex.diagnostics().replacements, 0,
    'Cancellation must discard staged report state without changing the visible index.');

  console.log('Portal console report publication projection self-test passed.');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
