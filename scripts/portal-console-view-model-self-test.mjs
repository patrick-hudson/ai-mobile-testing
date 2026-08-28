import assert from 'node:assert/strict';
import {
  consoleRunIdentityKey,
  normalizeComparativeConsoleRecord,
  normalizeConsoleAuthorityRecord,
  normalizeSingleSiteConsoleRecord,
} from '../portal/console-view-model.mjs';

const comparativeAuthority = {
  mode: 'comparative',
  sourceType: 'comparative-manifest',
  sourceIdentity: 'run-comparative-001',
  sourceRevision: 'manifest:abc123',
  sourceUpdatedAt: '2026-08-26T12:05:00.000Z',
  document: {
    id: 'run-comparative-001',
    status: 'review-required',
    phase: 'Evidence pipeline complete',
    createdAt: '2026-08-26T12:00:00.000Z',
    startedAt: '2026-08-26T12:01:00.000Z',
    finishedAt: '2026-08-26T12:05:00.000Z',
    options: {
      profile: 'release',
      productionUrl: 'https://example.com',
      candidateUrl: 'https://beta.example.com',
      targetIds: ['webkit-mobile', 'chromium-desktop'],
      pluginIds: ['plugin-b', 'plugin-a'],
      auditIds: ['NAV-002', 'NAV-001'],
      areas: ['navigation'],
    },
    progress: { total: 12, completed: 12, passed: 10, failed: 1, flaky: 1, skipped: 0 },
    pipeline: { status: 'completed' },
    release: { decision: 'READY' },
    ignoredHostileObject: { secret: 'sk-ant-do-not-copy-this-secret' },
  },
};

const comparative = normalizeComparativeConsoleRecord(comparativeAuthority, {
  completeness: 'complete',
  freshness: 'current',
});
assert.equal(comparative.mode, 'comparative');
assert.equal(comparative.identity.runId, 'run-comparative-001');
assert.equal(comparative.identity.key, 'comparative:run-comparative-001');
assert.equal(comparative.lifecycle.execution.raw, 'review-required', 'Authoritative state must not be renamed.');
assert.equal(comparative.lifecycle.execution.label, 'Review required');
assert.equal(comparative.lifecycle.activity.availability, 'unavailable');
assert.equal(comparative.lifecycle.terminal, true);
assert.equal(comparative.authority.outcome.raw, 'READY');
assert.equal(comparative.authority.pipeline.raw, 'completed');
assert.equal(comparative.authority.coverage.availability, 'unknown');
assert.equal(comparative.source.completeness, 'complete');
assert.equal(comparative.source.freshness, 'current');
assert.equal(comparative.scope.deployment.productionOrigin, 'https://example.com');
assert.equal(comparative.scope.deployment.candidateOrigin, 'https://beta.example.com');
assert.deepEqual(comparative.scope.targetIds, ['chromium-desktop', 'webkit-mobile']);
assert.deepEqual(comparative.scope.filters.pluginIds, ['plugin-a', 'plugin-b']);
assert.deepEqual(comparative.scope.filters.auditIds, ['NAV-001', 'NAV-002']);
assert.equal(comparative.scope.comparability.complete, true);
assert.equal(comparative.destinations.workspace, '/run.html?mode=comparative&run=run-comparative-001');
assert.equal(JSON.stringify(comparative).includes('ignoredHostileObject'), false, 'Unknown document fields must not be projected.');
assert.equal(JSON.stringify(comparative).includes('do-not-copy'), false, 'Unknown secret-like values must not be projected.');
assert(Object.isFrozen(comparative));
assert(Object.isFrozen(comparative.scope.filters.auditIds));

const archive = normalizeConsoleAuthorityRecord(comparativeAuthority, {
  contextId: 'sealed-archive',
  completeness: 'complete',
  freshness: 'current',
});
assert.equal(archive.mode, 'comparative', 'Archive context must not replace source audit mode.');
assert.deepEqual(archive.context, { id: 'sealed-archive', runtime: 'sealed-archive' });
assert.throws(() => normalizeConsoleAuthorityRecord(comparativeAuthority, {
  contextId: 'single-site-live',
}), /does not match/i);

const singleSiteAuthority = {
  mode: 'single-site',
  sourceType: 'single-site-job',
  sourceIdentity: 'job-single-site-001',
  sourceRevision: 'queue:17',
  sourceUpdatedAt: '2026-08-26T13:04:00.000Z',
  document: {
    state: {
      jobId: 'job-single-site-001',
      executionState: 'incomplete',
      activityState: 'recovering',
      submittedAt: '2026-08-26T13:00:00.000Z',
      updatedAt: '2026-08-26T13:04:00.000Z',
      result: { kind: 'findings' },
      evidenceAuthority: { authoritative: false, reasons: ['revision-unavailable'] },
      attemptNumber: 2,
      infrastructureRetriesUsed: 1,
      links: {
        report: '/report.html?mode=single-site&run=job-single-site-001',
        gallery: '/gallery.html?mode=single-site&run=job-single-site-001',
      },
    },
    input: {
      runContract: {
        mode: 'single-site',
        url: 'https://preview.example.com',
        deploymentRole: 'preview',
        targetIds: ['webkit-mobile', 'chromium-desktop'],
        scope: {
          qualifier: 'TARGETED',
          pluginIds: [],
          auditIds: ['CONTENT-001'],
          areas: ['content'],
        },
      },
    },
    finalization: { status: 'incomplete' },
  },
};

const singleSite = normalizeSingleSiteConsoleRecord(singleSiteAuthority, {
  completeness: 'partial',
  freshness: 'stale',
});
assert.equal(singleSite.mode, 'single-site');
assert.equal(singleSite.context.id, 'single-site-live');
assert.equal(singleSite.lifecycle.execution.raw, 'incomplete');
assert.equal(singleSite.lifecycle.activity.raw, 'recovering');
assert.equal(singleSite.lifecycle.terminal, true);
assert.equal(singleSite.timestamps.finishedAt, '2026-08-26T13:04:00.000Z', 'A terminal queue revision supplies its authoritative completion boundary.');
assert.equal(singleSite.authority.outcome.raw, 'findings');
assert.equal(singleSite.authority.evidence.raw, false, 'Authoritative boolean must remain raw.');
assert.equal(singleSite.authority.evidence.label, 'Non-authoritative');
assert.equal(singleSite.authority.finalization.raw, 'incomplete');
assert.equal(singleSite.scope.deployment.role.raw, 'preview');
assert.equal(singleSite.scope.profile.availability, 'unavailable');
assert.equal(singleSite.scope.comparability.profileKey, 'not-applicable');
assert.equal(singleSite.scope.comparability.complete, true);
assert.equal(singleSite.source.completeness, 'partial');
assert.equal(singleSite.source.freshness, 'stale');
assert.equal(singleSite.progress.attemptNumber, 2);
assert.equal(singleSite.progress.infrastructureRetriesUsed, 1);

const hostile = normalizeComparativeConsoleRecord({
  ...comparativeAuthority,
  sourceRevision: 'authorization: Bearer secret-token-value',
  document: {
    ...comparativeAuthority.document,
    status: `running\u0000${'x'.repeat(400)}`,
    options: {
      ...comparativeAuthority.document.options,
      candidateUrl: 'https://user:password@beta.example.com',
      targetIds: [...Array.from({ length: 80 }, (_, index) => `target-${index}`), 'sk-ant-secret-value-123456789'],
    },
    links: { report: '/report.html?api_key=plain-text-secret' },
  },
}, { completeness: 'complete', freshness: 'current' });
assert.equal(hostile.lifecycle.execution.raw, null);
assert.equal(hostile.lifecycle.execution.availability, 'unavailable');
assert.equal(hostile.scope.deployment.candidateOrigin, null);
assert.equal(hostile.scope.targetIds.length, 64);
assert.equal(hostile.source.revision, null);
assert.equal(hostile.source.completeness, 'partial', 'Withheld/truncated fields must prevent a complete claim.');
assert(hostile.limitations.some(({ code, field }) => code === 'list-truncated' && field === 'scope.targetIds'));
assert(hostile.limitations.some(({ code, field }) => code === 'unsafe-field-withheld' && field === 'lifecycle.execution'));
const hostileJson = JSON.stringify(hostile);
assert.equal(hostileJson.includes('secret-token-value'), false);
assert.equal(hostileJson.includes('plain-text-secret'), false);
assert(hostileJson.length < 20_000, 'Hostile input must produce a bounded projection.');

const unknown = normalizeSingleSiteConsoleRecord({
  mode: 'single-site',
  sourceType: 'single-site-job',
  sourceIdentity: 'job-unknown-001',
  sourceRevision: null,
  sourceUpdatedAt: null,
  document: { jobId: 'job-unknown-001' },
});
assert.equal(unknown.lifecycle.execution.availability, 'unknown');
assert.equal(unknown.authority.finalization.availability, 'unknown');
assert.equal(unknown.source.completeness, 'unknown');
assert.equal(unknown.source.freshness, 'unknown');
assert.equal(unknown.scope.comparability.complete, false);

assert.equal(consoleRunIdentityKey({ mode: 'single-site', runId: 'job-unknown-001' }), 'single-site:job-unknown-001');
assert.throws(() => consoleRunIdentityKey({ mode: 'archive', runId: 'job-unknown-001' }), /mode/i);
assert.throws(() => normalizeConsoleAuthorityRecord({
  mode: 'comparative',
  sourceType: 'manifest',
  sourceIdentity: '../escape',
  sourceRevision: null,
  sourceUpdatedAt: null,
  document: {},
}), /sourceIdentity/i);

console.log('Portal console view-model self-test passed.');
