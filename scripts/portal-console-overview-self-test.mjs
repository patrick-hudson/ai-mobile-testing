import assert from 'node:assert/strict';
import { buildConsoleOverview, buildConsoleRunsPage, CONSOLE_OVERVIEW_LIMITS } from '../portal/console-overview.mjs';

function status(raw, label = raw) {
  return { raw, label, availability: raw === null ? 'unavailable' : 'available' };
}

function run({ mode, id, terminal, finishedAt, scope = 'full', evidence = 'authoritative', completeness = 'complete', freshness = 'current' }) {
  return {
    schemaVersion: 1,
    mode,
    identity: { mode, runId: id, key: `${mode}:${id}` },
    title: id,
    source: { type: `${mode}-run-v1`, identity: id, revision: `${id}-r1`, updatedAt: finishedAt ?? '2026-08-26T00:00:00Z', completeness, freshness },
    lifecycle: { execution: status(terminal ? 'completed' : 'running'), activity: status('normal'), phase: status(terminal ? 'finished' : 'browser'), terminal },
    authority: { outcome: status(terminal ? 'review' : null), coverage: status('complete'), evidence: status(evidence), pipeline: status(terminal ? 'completed' : 'running'), finalization: status(terminal ? 'completed' : 'pending') },
    scope: {
      qualifier: scope,
      profile: 'release',
      deployment: mode === 'comparative' ? 'prod→beta' : 'beta',
      targetIds: ['desktop'],
      comparability: { scopeKey: scope, deploymentKey: mode === 'comparative' ? 'prod-beta' : 'beta', profileKey: 'release', targetSetKey: 'desktop', complete: true },
    },
    timestamps: { createdAt: '2026-08-26T00:00:00Z', startedAt: '2026-08-26T00:00:01Z', updatedAt: finishedAt ?? '2026-08-26T00:00:02Z', finishedAt },
    limitations: completeness === 'complete' ? [] : ['report publication pending'],
  };
}

const current = run({ mode: 'comparative', id: 'run-current', terminal: true, finishedAt: '2026-08-26T03:00:00Z', evidence: 'partial' });
const predecessor = run({ mode: 'comparative', id: 'run-previous', terminal: true, finishedAt: '2026-08-26T02:00:00Z' });
const singleSite = run({ mode: 'single-site', id: 'job-1', terminal: true, finishedAt: '2026-08-26T02:30:00Z' });
const active = run({ mode: 'comparative', id: 'run-active', terminal: false, finishedAt: null });

const attention = [
  {
    identity: 'visual-1', runIdentity: { mode: 'comparative', runId: 'run-current' }, sourceType: 'visual-review',
    severity: 'P1', blocking: false, novelty: 'new', affectedScope: 5, unresolvedAt: '2026-08-25T00:00:00Z',
    source: { identity: 'gitem-1', timestamp: '2026-08-26T03:00:00Z', complete: true, href: '/gallery.html?run=run-current&item=gitem-1' },
    hasComparablePredecessor: true,
  },
  {
    identity: 'finding-1', runIdentity: { mode: 'comparative', runId: 'run-current' }, sourceType: 'finding',
    severity: 'P0', blocking: true, novelty: 'new', affectedScope: 1, unresolvedAt: '2026-08-26T01:00:00Z',
    source: { identity: 'finding-1', timestamp: '2026-08-26T03:00:00Z', complete: true, href: '/findings.html?record=finding-1' },
    hasComparablePredecessor: true,
  },
  {
    identity: 'hostile', runIdentity: { mode: 'comparative', runId: 'run-current' }, sourceType: 'finding',
    severity: 'P0', blocking: true, source: { identity: 'x', timestamp: 'bad', complete: true, href: 'https://attacker.test/' },
  },
];

const overview = buildConsoleOverview({
  mode: 'comparative', scopeKey: 'full', runs: [active, current, predecessor, singleSite], attention,
  statistics: [
    { id: 'queue-depth', label: 'Queue depth', value: 1, population: 'Comparative runs', window: 'Current', freshness: 'current', sourceIdentity: 'run-index', sourceTimestamp: '2026-08-26T03:00:00Z', drilldown: '/runs.html?state=queued' },
    { id: 'fake-zero', label: 'Fake zero', value: 0 },
  ],
  sourceVectorRevision: 'vector-4',
}, { now: '2026-08-26T04:00:00Z' });

assert.equal(overview.scope.mode, 'comparative');
assert.equal(overview.latestTerminalRun.identity.runId, 'run-current');
assert.equal(overview.comparablePredecessor.available, true);
assert.equal(overview.comparablePredecessor.predecessor.identity.runId, 'run-previous');
assert.notEqual(overview.latestTerminalRun.identity.runId, overview.comparablePredecessor.predecessor.identity.runId);
assert.equal(overview.activeRuns.total, 1);
assert.equal(overview.productRisk.total, 2);
assert.equal(overview.productRisk.items[0].identity, 'finding-1');
assert.equal('score' in overview.productRisk.items[0], false);
assert.equal(overview.runTrust.facts.find(({ id }) => id === 'evidence').conclusionSupport, 'limited');
assert.equal(overview.statistics.length, 1);
assert.equal(overview.statistics[0].population, 'Comparative runs');
assert.equal(overview.provenance.sourceVectorRevision, 'vector-4');
assert.equal(JSON.stringify(overview).includes('attacker.test'), false);

const mixed = buildConsoleOverview({ mode: 'all', runs: [current, singleSite] });
assert.equal(mixed.latestTerminalRun.identity.runId, 'run-current');
assert.equal(mixed.comparablePredecessor.available, false, 'Mixed audit modes must never become predecessor candidates.');

const firstRun = buildConsoleOverview({ mode: 'single-site', runs: [singleSite], attention: [] });
assert.equal(firstRun.comparablePredecessor.available, false);
assert.match(firstRun.productRisk.state.reason, /without a valid Comparable Predecessor/i);

const partial = buildConsoleOverview({
  mode: 'single-site',
  runs: [run({ mode: 'single-site', id: 'job-partial', terminal: true, finishedAt: '2026-08-26T03:00:00Z', completeness: 'partial' })],
  limitations: ['single-site report backfill pending'],
});
assert.equal(partial.state.state, 'partial');
assert.deepEqual(partial.state.limitations, ['single-site report backfill pending']);

const runsPage = buildConsoleRunsPage([current, predecessor, active, singleSite], { mode: 'comparative', scopeKey: 'full', limit: 2 });
assert.equal(runsPage.items.length, 2);
assert.equal(runsPage.total, 3);
assert.equal(runsPage.hasMore, true);
assert(CONSOLE_OVERVIEW_LIMITS.maximumStatistics <= 6);

console.log('Portal console overview projection self-test passed.');
