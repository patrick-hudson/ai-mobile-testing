import assert from 'node:assert/strict';
import { createConsoleIndex } from '../portal/console-index.mjs';
import {
  consoleIndexRecordToNormalizedRun,
  consoleIndexRecordToProductRiskInput,
  normalizedRunToConsoleIndexRecord,
  productRiskToConsoleIndexRecord,
  timelineToConsoleIndexRecord,
} from '../portal/console-index-records.mjs';
import { createProductRiskRecord } from '../portal/console-risk.mjs';
import { buildConsoleRunSummary, projectComparativeTimeline } from '../portal/console-run.mjs';

const field = (raw) => ({ raw, label: raw === null ? 'Unavailable' : String(raw), availability: raw === null ? 'unavailable' : 'available' });
const run = {
  schemaVersion: 1,
  mode: 'comparative',
  identity: { mode: 'comparative', runId: 'run-123', key: 'comparative:run-123' },
  source: { type: 'comparative-run-v1', identity: 'run-123', revision: 'manifest-4', updatedAt: '2026-08-26T05:00:00.000Z', completeness: 'complete', freshness: 'current' },
  title: 'Production → beta',
  lifecycle: { execution: field('failed'), activity: field(null), phase: field('finished'), terminal: true },
  authority: { outcome: field('not-ready'), coverage: field('complete'), evidence: field('authoritative'), pipeline: field('completed'), finalization: field(null) },
  scope: {
    deployment: { productionOrigin: 'https://quitting7oh.org', candidateOrigin: 'https://beta.quitting7oh-org.pages.dev', origin: null, role: field(null) },
    profile: field('release'), qualifier: field('full'),
    filters: { pluginIds: ['routes'], auditIds: ['NAV-001'], areas: ['navigation'] }, targetIds: ['desktop-chromium'],
    comparability: { deploymentKey: '["prod","beta"]', profileKey: 'release', scopeKey: 'full', targetSetKey: '["desktop-chromium"]', complete: true },
  },
  timestamps: { createdAt: '2026-08-26T04:00:00.000Z', startedAt: '2026-08-26T04:01:00.000Z', updatedAt: '2026-08-26T05:00:00.000Z', finishedAt: '2026-08-26T05:00:00.000Z' },
  progress: { total: 10, completed: 10, passed: 8, failed: 2, flaky: 0, skipped: 0, command: 'secret' },
  destinations: { workspace: '/run.html?mode=comparative&run=run-123', report: '/report.html?run=run-123', attacker: 'https://attacker.test' },
  limitations: [{ code: 'gallery-partial', field: 'authority.evidence' }],
};

const indexRecord = normalizedRunToConsoleIndexRecord(run, { sourceId: 'comparative-runs' });
assert.equal(indexRecord.recordType, 'run');
assert.match(indexRecord.scopeKey, /^scope_[a-f0-9]{24}$/);
assert.equal(indexRecord.fields.executionState, 'failed');
assert.equal(indexRecord.fields.progressFailed, 2);
assert.equal(indexRecord.fields.destinations.length, 2);
assert.equal(JSON.stringify(indexRecord).includes('command'), false);
assert.equal(JSON.stringify(indexRecord).includes('attacker.test'), false);

const index = createConsoleIndex({ sources: [{ sourceId: 'comparative-runs', revision: 'manifest-4', updatedAt: '2026-08-26T05:00:00.000Z', complete: true }] });
assert.equal(index.upsert(indexRecord).committed, true);
const [timeline] = projectComparativeTimeline('run-123', {
  stages: [{ stageId: 'playwright', status: 'failed', startedAt: '2026-08-26T04:01:00.000Z', finishedAt: '2026-08-26T04:02:00.000Z' }],
}, { sourceRevision: 'manifest-4' });
const timelineRecord = timelineToConsoleIndexRecord(timeline, {
  sourceId: 'comparative-runs',
  scopeKey: indexRecord.scopeKey,
  sourceUpdatedAt: '2026-08-26T05:00:00.000Z',
  complete: true,
});
assert.equal(timelineRecord.recordType, 'timeline');
assert.equal(timelineRecord.fields.stageId, 'playwright');
assert.equal(timelineRecord.fields.durationMs, 60_000);
assert.equal(index.upsert(timelineRecord).committed, true);
assert.equal(index.page({
  mode: 'comparative',
  scopeKey: indexRecord.scopeKey,
  normalizedFilterKey: 'timeline',
  cursor: null,
  limit: 10,
  recordTypes: ['timeline'],
}).items.length, 1);
const restored = consoleIndexRecordToNormalizedRun(index.read({ mode: 'comparative', runId: 'run-123' }).value);
const summary = buildConsoleRunSummary(restored);
assert.equal(summary.lifecycle.execution.raw, 'failed');
assert.equal(summary.authority.evidence.raw, 'authoritative');
assert.equal(summary.scope.targetCount, 1);
assert(summary.destinations.workspace);

const risk = createProductRiskRecord({
  identity: 'finding-1', runIdentity: { mode: 'comparative', runId: 'run-123' }, sourceType: 'finding',
  severity: 'P0', blockingIntent: true, novelty: 'new', affectedScope: 3, unresolvedSince: '2026-08-26T04:00:00.000Z',
  sourceIdentity: 'finding-1', sourceTimestamp: '2026-08-26T05:00:00.000Z', sourceComplete: true,
  href: '/findings.html?record=finding-1',
}, { hasComparablePredecessor: true, now: '2026-08-26T05:00:00.000Z' });
const riskRecord = productRiskToConsoleIndexRecord(risk, 'full', { sourceRevision: 'report-4' });
assert.match(riskRecord.scopeKey, /^scope_[a-f0-9]{24}$/);
assert.equal(index.upsert(riskRecord).committed, true);
const restoredRisk = consoleIndexRecordToProductRiskInput(riskRecord, { hasComparablePredecessor: true, now: '2026-08-26T05:00:00.000Z' });
assert.equal(restoredRisk.identity, 'finding-1');
assert.equal(restoredRisk.factors.severity.raw, 'P0');
assert.equal('score' in restoredRisk, false);

const reviewRecord = {
  ...riskRecord,
  recordId: 'attention:visual-1',
  recordType: 'attention',
  fields: {
    ...riskRecord.fields,
    attentionKind: 'visual-review',
    affectedScope: undefined,
    areas: ['navigation', 'theme'],
    reasonCodes: ['visual-review', 'changed'],
  },
};
delete reviewRecord.fields.affectedScope;
const restoredReview = consoleIndexRecordToProductRiskInput(reviewRecord, { now: '2026-08-26T05:00:00.000Z' });
assert.equal(restoredReview.sourceType, 'visual-review');
assert.equal(restoredReview.factors.affectedScope.raw, 2);
assert.deepEqual(restoredReview.categories, ['changed', 'visual-review']);

assert.throws(() => consoleIndexRecordToProductRiskInput({
  ...reviewRecord,
  recordId: 'attention:infra-1',
  fields: { ...reviewRecord.fields, attentionKind: 'incomplete-execution' },
}), /not a Product Risk authority/u);

console.log('Portal console index record adapter self-test passed.');
