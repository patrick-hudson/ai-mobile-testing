import assert from 'node:assert/strict';
import { normalizeConsoleAuthorityRecord } from '../portal/console-view-model.mjs';
import {
  buildComparablePredecessorKey,
  compareProductRisk,
  createProductRiskRecord,
  selectComparablePredecessor,
  sortProductRisk,
} from '../portal/console-risk.mjs';

function comparativeRun(id, overrides = {}) {
  const finishedAt = Object.hasOwn(overrides, 'finishedAt')
    ? overrides.finishedAt
    : '2026-08-26T12:00:00.000Z';
  const options = {
    profile: 'release',
    productionUrl: 'https://example.com',
    candidateUrl: 'https://beta.example.com',
    targetIds: ['chromium-desktop', 'webkit-mobile'],
    auditIds: ['NAV-001'],
    areas: ['navigation'],
    pluginIds: [],
    ...(overrides.options ?? {}),
  };
  return normalizeConsoleAuthorityRecord({
    mode: 'comparative',
    sourceType: 'comparative-manifest',
    sourceIdentity: id,
    sourceRevision: `manifest:${id}`,
    sourceUpdatedAt: overrides.updatedAt ?? finishedAt ?? '2026-08-26T12:00:00.000Z',
    document: {
      id,
      status: overrides.status ?? 'passed',
      createdAt: overrides.createdAt ?? '2026-08-26T11:00:00.000Z',
      finishedAt,
      options,
      pipeline: { status: overrides.pipelineStatus ?? 'completed' },
      release: { decision: overrides.decision ?? 'READY' },
    },
  }, {
    completeness: overrides.completeness ?? 'complete',
    freshness: overrides.freshness ?? 'current',
  });
}

function singleSiteRun(id, overrides = {}) {
  return normalizeConsoleAuthorityRecord({
    mode: 'single-site',
    sourceType: 'single-site-job',
    sourceIdentity: id,
    sourceRevision: `queue:${id}`,
    sourceUpdatedAt: overrides.finishedAt ?? '2026-08-26T12:00:00.000Z',
    document: {
      state: {
        jobId: id,
        executionState: overrides.status ?? 'completed',
        activityState: 'normal',
        submittedAt: '2026-08-26T11:00:00.000Z',
        finishedAt: overrides.finishedAt ?? '2026-08-26T12:00:00.000Z',
        result: { kind: 'passed' },
      },
      input: {
        runContract: {
          mode: 'single-site',
          url: 'https://example.com',
          deploymentRole: 'production',
          targetIds: ['chromium-desktop'],
          scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
        },
      },
      finalization: { status: overrides.finalization ?? 'complete' },
    },
  }, {
    completeness: overrides.completeness ?? 'complete',
    freshness: overrides.freshness ?? 'current',
  });
}

const current = comparativeRun('run-current-001', {
  createdAt: '2026-08-26T15:00:00.000Z',
  finishedAt: '2026-08-26T16:00:00.000Z',
});
const predecessor = comparativeRun('run-predecessor-001', {
  createdAt: '2026-08-25T14:00:00.000Z',
  finishedAt: '2026-08-25T15:00:00.000Z',
});
const older = comparativeRun('run-predecessor-older', {
  createdAt: '2026-08-24T14:00:00.000Z',
  finishedAt: '2026-08-24T15:00:00.000Z',
});

const comparableKey = buildComparablePredecessorKey(current);
assert.equal(comparableKey.eligible, true);
assert.equal(typeof comparableKey.key, 'string');
assert.deepEqual(Object.keys(comparableKey.factors), ['mode', 'deployment', 'profile', 'scope', 'targetSet']);
assert.equal(comparableKey.factors.mode.value, 'comparative');
assert.equal(comparableKey.reasons.length, 0);

const selected = selectComparablePredecessor(current, [older, predecessor]);
assert.equal(selected.available, true);
assert.equal(selected.predecessor.identity.runId, 'run-predecessor-001');
assert.equal(selected.reason, 'matched');

const incompatibleLater = comparativeRun('run-incompatible-later', {
  finishedAt: '2026-08-26T14:00:00.000Z',
  options: { targetIds: ['firefox-desktop'] },
});
const mixedMode = singleSiteRun('job-mixed-mode-001', { finishedAt: '2026-08-26T14:30:00.000Z' });
const stillSelected = selectComparablePredecessor(current, [older, predecessor, incompatibleLater, mixedMode]);
assert.equal(stillSelected.predecessor.identity.runId, 'run-predecessor-001');

for (const ineligible of [
  comparativeRun('run-active-001', { status: 'running', finishedAt: null }),
  comparativeRun('run-partial-001', { completeness: 'partial' }),
  comparativeRun('run-stale-001', { freshness: 'stale' }),
]) {
  assert.equal(buildComparablePredecessorKey(ineligible).eligible, false);
  assert.equal(selectComparablePredecessor(current, [ineligible]).available, false);
}
const incompleteFinalization = singleSiteRun('job-incomplete-finalization', { finalization: 'incomplete' });
assert.equal(buildComparablePredecessorKey(incompleteFinalization).eligible, false);
assert(buildComparablePredecessorKey(incompleteFinalization).reasons.includes('finalization-is-incomplete'));
const singleCurrent = singleSiteRun('job-current-001', { finishedAt: '2026-08-26T15:00:00.000Z' });
const singlePredecessor = singleSiteRun('job-predecessor-001', { finishedAt: '2026-08-25T15:00:00.000Z' });
assert.equal(selectComparablePredecessor(singleCurrent, [singlePredecessor]).predecessor.identity.runId, 'job-predecessor-001');

const activeCurrent = comparativeRun('run-active-current', { status: 'running', finishedAt: null });
const noChangeClaims = selectComparablePredecessor(activeCurrent, [predecessor]);
assert.equal(noChangeClaims.available, false);
assert.equal(noChangeClaims.reason, 'current-run-ineligible');

function risk(identity, overrides = {}, options = {}) {
  return createProductRiskRecord({
    identity,
    runIdentity: { mode: 'comparative', runId: 'run-current-001' },
    sourceType: 'finding',
    categories: [],
    sourceIdentity: `source-${identity}`,
    sourceTimestamp: '2026-08-26T15:30:00.000Z',
    sourceComplete: true,
    href: `/findings.html?record=${identity}`,
    severity: 'P1',
    blockingIntent: true,
    novelty: 'new',
    affectedScope: 1,
    unresolvedSince: '2026-08-26T12:00:00.000Z',
    ...overrides,
  }, { hasComparablePredecessor: true, now: '2026-08-26T16:00:00.000Z', ...options });
}

const p0 = risk('risk-p0', { severity: 'P0' });
const p1 = risk('risk-p1', { severity: 'P1' });
assert(compareProductRisk(p0, p1) < 0, 'Severity must be the first factor.');

const blocking = risk('risk-blocking', { blockingIntent: true });
const nonBlocking = risk('risk-non-blocking', { blockingIntent: false });
assert(compareProductRisk(blocking, nonBlocking) < 0, 'Blocking intent must follow severity.');

const finding = risk('risk-finding');
const visual = risk('risk-visual', { sourceType: 'visual-review' });
const manual = risk('risk-manual', { sourceType: 'manual-obligation' });
assert(compareProductRisk(finding, visual) < 0);
assert(compareProductRisk(visual, manual) < 0);
assert.equal(visual.factors.sourceAuthority.raw, 'visual-review');

const novel = risk('risk-novel', { novelty: 'new' });
const persistent = risk('risk-persistent', { novelty: 'persistent' });
assert(compareProductRisk(novel, persistent) < 0);
const noPredecessorNovel = risk('risk-no-predecessor-a', { novelty: 'new' }, { hasComparablePredecessor: false });
const noPredecessorExisting = risk('risk-no-predecessor-b', { novelty: 'existing' }, { hasComparablePredecessor: false });
assert.equal(noPredecessorNovel.factors.novelty.raw, null);
assert.equal(noPredecessorNovel.factors.novelty.availability, 'unavailable');
assert.match(noPredecessorNovel.factors.novelty.reason, /no Comparable Predecessor/i);
assert(compareProductRisk(noPredecessorNovel, noPredecessorExisting) < 0, 'Without a predecessor, novelty must be neutral and identity breaks the tie.');

const broad = risk('risk-broad', { affectedScope: 20 });
const narrow = risk('risk-narrow', { affectedScope: 2 });
assert(compareProductRisk(broad, narrow) < 0, 'Larger affected scope must lead after earlier factors tie.');
const olderRisk = risk('risk-older', { unresolvedSince: '2026-08-20T12:00:00.000Z' });
const newerRisk = risk('risk-newer', { unresolvedSince: '2026-08-25T12:00:00.000Z' });
assert(compareProductRisk(olderRisk, newerRisk) < 0, 'Older unresolved records must lead after earlier factors tie.');

const stableA = risk('risk-a');
const stableB = risk('risk-b');
assert(compareProductRisk(stableA, stableB) < 0);
const ordered = sortProductRisk([manual, stableB, p1, stableA, visual, p0]);
const reordered = sortProductRisk([visual, stableA, p0, manual, stableB, p1]);
assert.deepEqual(ordered.map(({ identity }) => identity), reordered.map(({ identity }) => identity));
assert.equal(ordered[0].identity, 'risk-p0');

assert.deepEqual(p0.tuple.map(({ name }) => name), [
  'severity', 'blocking-intent', 'source-authority', 'novelty', 'affected-scope', 'unresolved-age', 'stable-identity',
]);
assert.equal('score' in p0, false);
assert.equal('score' in p0.factors, false);
assert.equal(p0.reasons.length, 7);
assert.equal(p0.source.complete, true);
assert(Object.isFrozen(p0));
assert(Object.isFrozen(p0.tuple));

const hostile = createProductRiskRecord({
  identity: 'risk-hostile',
  runIdentity: { mode: 'comparative', runId: 'run-current-001' },
  sourceType: 'finding',
  sourceIdentity: 'source-risk-hostile',
  href: '/findings.html?authorization=Bearer-secret-token-value',
  severity: 'authorization: Bearer secret-token-value',
  novelty: 'sk-ant-secret-value-123456789',
  affectedScope: Number.MAX_SAFE_INTEGER,
  unresolvedSince: 'not-a-date',
}, { hasComparablePredecessor: true });
assert.equal(hostile.source.href, null);
assert.equal(hostile.factors.severity.raw, null);
assert.equal(hostile.factors.novelty.raw, null);
assert.equal(hostile.factors.affectedScope.raw, null);
assert.equal(JSON.stringify(hostile).includes('secret-token-value'), false);
assert(JSON.stringify(hostile).length < 10_000);
assert.throws(() => risk('../escape'), /identity/i);
assert.throws(() => createProductRiskRecord({
  identity: 'risk-many-categories',
  runIdentity: { mode: 'comparative', runId: 'run-current-001' },
  sourceType: 'finding',
  categories: Array.from({ length: 17 }, (_, index) => `category-${index}`),
}), /categories/i);

console.log('Portal console risk self-test passed.');
