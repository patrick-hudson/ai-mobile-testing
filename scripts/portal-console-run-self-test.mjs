import assert from 'node:assert/strict';
import {
  CONSOLE_TIMELINE_MAX_PAGE_SIZE,
  buildConsoleRunSummary,
  buildConsoleTimelinePage,
  projectComparativeTimeline,
  projectSingleSiteTimeline,
} from '../portal/console-run.mjs';

const comparative = projectComparativeTimeline('run-1', {
  stages: [
    { stageId: 'inventory', status: 'passed', startedAt: '2026-08-26T00:00:00Z', finishedAt: '2026-08-26T00:00:01Z' },
    { stageId: 'shard2', status: 'failed', startedAt: '2026-08-26T00:00:02Z', finishedAt: '2026-08-26T00:00:08Z', attempt: 1, retry: 0 },
    { stageId: '../../hostile', status: 'passed', command: 'cat secret.env' },
  ],
}, { sourceRevision: 'manifest-4' });
assert.equal(comparative.length, 2);
assert.equal(comparative[1].kind, 'shard');
assert.equal(comparative[1].durationMs, 6_000);
assert.equal('command' in comparative[1], false);

const singleSite = projectSingleSiteTimeline('job-1', {
  events: [
    { sequence: 1, type: 'submitted', at: '2026-08-26T00:00:00Z', executionState: 'queued', attemptNumber: 0, message: 'secret' },
    { sequence: 2, type: 'claimed', at: '2026-08-26T00:00:01Z', executionState: 'running', attemptNumber: 1, attemptId: 'attempt-1' },
    { sequence: 3, type: 'retry-scheduled', at: '2026-08-26T00:00:02Z', executionState: 'queued', attemptNumber: 1 },
  ],
  stageDeadlines: { inventory: '2026-08-26T00:05:00Z', browser: '2026-08-26T00:15:00Z', attacker: '2026-08-26T00:20:00Z' },
  publications: [{ publicationId: 'report', sequence: 4, publishedAt: '2026-08-26T00:00:03Z', relativePath: '../../secret' }],
});
assert.equal(singleSite.filter(({ kind }) => kind === 'deadline').length, 2);
assert(singleSite.some(({ kind }) => kind === 'attempt'));
assert(singleSite.some(({ kind }) => kind === 'retry'));
assert(singleSite.some(({ kind }) => kind === 'publication'));
assert.equal(singleSite.some((entry) => 'message' in entry || 'relativePath' in entry), false);

const first = buildConsoleTimelinePage(singleSite, { limit: 2, binding: 'job-1:vector-2:all' });
assert.equal(first.items.length, 2);
assert(first.nextCursor);
const second = buildConsoleTimelinePage(singleSite, { limit: 2, cursor: first.nextCursor, binding: 'job-1:vector-2:all' });
assert.equal(second.items.length, 2);
assert.notEqual(second.items[0].identity, first.items[0].identity);
assert.throws(() => buildConsoleTimelinePage(singleSite, { cursor: first.nextCursor, binding: 'different' }), /does not match/i);
assert.throws(() => buildConsoleTimelinePage(singleSite, { cursor: 'not-a-cursor', binding: 'job-1' }), /invalid/i);
assert.equal(buildConsoleTimelinePage(singleSite, { limit: 1_000 }).items.length, Math.min(CONSOLE_TIMELINE_MAX_PAGE_SIZE, singleSite.length));

const summary = buildConsoleRunSummary({
  schemaVersion: 1,
  mode: 'single-site',
  identity: { mode: 'single-site', runId: 'job-1' },
  title: 'Beta site audit',
  source: { type: 'single-site-job-v1', identity: 'job-1', revision: 'seq-3', updatedAt: '2026-08-26T00:00:03Z', completeness: 'partial', freshness: 'current' },
  lifecycle: {
    execution: { raw: 'running', label: 'Running', availability: 'available' },
    activity: { raw: 'normal', label: 'Normal', availability: 'available' },
    phase: { raw: null, label: 'Unavailable', availability: 'unavailable' },
    terminal: false,
  },
  authority: {
    outcome: { raw: null, label: 'Unavailable', availability: 'unavailable' },
    coverage: { raw: 'complete', label: 'Complete', availability: 'available' },
    evidence: { raw: 'partial', label: 'Partial', availability: 'available' },
    pipeline: { raw: 'running', label: 'Running', availability: 'available' },
    finalization: { raw: 'pending', label: 'Pending', availability: 'available' },
  },
  scope: { qualifier: 'full', profile: 'release', deployment: 'beta', targetIds: ['desktop', 'mobile'] },
  progress: { total: 10, completed: 4, command: 'cat secret.env' },
  destinations: { report: '/report.html?mode=single-site&run=job-1', leak: '/secrets', gallery: 'https://attacker.test/' },
  timestamps: { createdAt: '2026-08-26T00:00:00Z', startedAt: '2026-08-26T00:00:01Z', updatedAt: '2026-08-26T00:00:03Z' },
  limitations: ['gallery backfill pending'],
});
assert.equal(summary.identity.key, 'single-site:job-1');
assert.equal(summary.lifecycle.execution.raw, 'running');
assert.equal(summary.authority.evidence.raw, 'partial');
assert.deepEqual(summary.limitations, ['gallery backfill pending']);
assert.deepEqual(summary.progress, { total: 10, completed: 4 });
assert.equal('leak' in summary.destinations, false);
assert.equal('gallery' in summary.destinations, false);
assert.equal(JSON.stringify(summary).includes('secret'), false);

console.log('Portal console run projection self-test passed.');
