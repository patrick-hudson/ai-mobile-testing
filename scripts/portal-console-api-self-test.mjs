import assert from 'node:assert/strict';
import {
  CONSOLE_API_MAX_RESPONSE_BYTES,
  CONSOLE_API_PREFIX,
  CONSOLE_API_SCHEMA_VERSION,
  createConsoleApi,
} from '../portal/console-api.mjs';
import { createConsoleIndex, createConsoleReadBudget } from '../portal/console-index.mjs';

const NOW = '2026-08-26T12:00:00.000Z';

function sourceVector(revision = 'vector-1', complete = true) {
  return {
    schemaVersion: 1,
    vectorRevision: revision,
    indexRevision: revision.replace('vector', 'index'),
    complete,
    sources: [{ sourceId: 'fixture-source', revision, updatedAt: NOW, complete }],
  };
}

function work(recordsRead = 0, overrides = {}) {
  return {
    recordsRead,
    sourceFilesRead: 0,
    sourceBytesRead: 0,
    elapsedMs: 0,
    budgetExhausted: false,
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: 'comparative',
    runId: 'run-00000001',
    recordId: 'run',
    recordType: 'run',
    scopeKey: 'all',
    sourceId: 'fixture-source',
    sourceRevision: 'revision-1',
    sourceUpdatedAt: NOW,
    complete: true,
    sortKey: '0001',
    fields: { title: 'Fixture run', executionState: 'running', terminal: false },
    ...overrides,
  };
}

function pageResult(request, items, vector = sourceVector(), overrides = {}) {
  return {
    schemaVersion: 1,
    items,
    nextCursor: null,
    hasMore: false,
    omittedRecords: 0,
    cursorBinding: {
      mode: request.mode,
      scopeKey: request.scopeKey,
      normalizedFilterKey: request.normalizedFilterKey,
      sourceVectorRevision: vector.vectorRevision,
    },
    sourceVector: vector,
    complete: vector.complete && items.every((item) => item.complete),
    freshness: vector.complete ? 'current' : 'stale',
    limitations: [],
    work: work(items.length),
    ...overrides,
  };
}

function snapshotResult(value, vector = sourceVector(), overrides = {}) {
  return {
    schemaVersion: 1,
    value,
    sourceVector: vector,
    complete: vector.complete && value?.complete !== false,
    freshness: vector.complete ? 'current' : 'stale',
    limitations: [],
    work: work(value ? 1 : 0),
    ...overrides,
  };
}

const calls = [];
let capabilityCalls = 0;
const stableVector = sourceVector();
const stableAdapter = {
  sourceVector: () => stableVector,
  read: ({ identity, recordId }) => {
    calls.push({ operation: 'read', identity, recordId });
    return snapshotResult(record({ mode: identity.mode, runId: identity.runId }));
  },
  page: ({ request }) => {
    calls.push({ operation: 'page', request });
    return pageResult(request, [
      record(),
      record({ runId: 'run-00000002', recordId: 'run-2', sortKey: '0002', fields: { title: 'Queued fixture', executionState: 'queued', terminal: false } }),
    ]);
  },
};
const api = createConsoleApi({
  indexAdapter: stableAdapter,
  resolveCapabilities({ routeId, identities, authorization, signal, budget }) {
    capabilityCalls += 1;
    assert.equal(routeId, 'runs');
    assert.equal(signal.aborted, false);
    assert.equal(budget.maxSourceFiles, 0);
    assert.deepEqual(authorization, { authorized: true, actorId: 'operator' });
    assert.equal(identities.length, 2);
    return identities.map((identity) => ({
      identity,
      contextId: identity.mode === 'comparative' ? 'comparative-live' : 'single-site-live',
      authorityRevision: `authority-${capabilityCalls}`,
      actions: [
        'stop', 'cancel', 'purge', 'manualEvidence', 'rekick', 'riskAcknowledge',
        'riskResolve', 'visualDisposition', 'baseline', 'aiReview', 'settings',
      ].map((actionId) => ({
        actionId,
        supported: true,
        authorized: true,
        eligible: true,
        available: true,
        unavailableReason: null,
      })),
    }));
  },
});

const bounded = await api.handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&scope=all&filter=state:running,state:queued&limit=999`,
  signal: new AbortController().signal,
  authorization: { authorized: true, actorId: 'operator' },
});
assert.equal(bounded.handled, true);
assert.equal(bounded.status, 200);
assert.equal(bounded.body.schemaVersion, CONSOLE_API_SCHEMA_VERSION);
assert.equal(bounded.body.apiVersion, 'v1');
assert.equal(bounded.body.routeId, 'runs');
assert.equal(bounded.body.query.limit, 100, 'Limits above the route maximum must clamp to 100.');
assert.deepEqual(bounded.body.query.filters, { state: ['queued', 'running'] });
assert.equal(bounded.body.data.items.length, 2);
assert.equal(bounded.body.capabilities.items.length, 2);
assert.deepEqual(
  bounded.body.capabilities.items[0].actions.map(({ actionId }) => actionId),
  [
    'stop', 'cancel', 'purge', 'manualEvidence', 'rekick', 'riskAcknowledge',
    'riskResolve', 'visualDisposition', 'baseline', 'aiReview', 'settings',
  ],
  'The complete live action contract must survive capability sanitization.',
);
assert.equal(capabilityCalls, 1);
assert.equal(calls[0].request.limit, 100);
assert.deepEqual(Object.keys(calls[0].request).sort(), ['cursor', 'limit', 'mode', 'normalizedFilterKey', 'orderBy', 'recordTypes', 'scopeKey']);
assert.equal(calls[0].request.orderBy, 'recent');
assert.equal('authorization' in calls[0].request, false, 'Authorization must never enter index reads.');
assert.equal(bounded.headers['Cache-Control'], 'no-store');
assert.equal(bounded.headers['X-Console-Schema-Version'], '1');
assert.equal(Number(bounded.headers['Content-Length']), Buffer.byteLength(JSON.stringify(bounded.body)));

const head = await api.handle({
  method: 'HEAD',
  url: `${CONSOLE_API_PREFIX}/runs?mode=comparative`,
  signal: new AbortController().signal,
  authorization: { authorized: true, actorId: 'operator' },
});
assert.equal(head.status, 200);
assert.equal(head.body, null);
assert(Number(head.headers['Content-Length']) > 0);
assert.equal(capabilityCalls, 2, 'Dynamic capability state must be resolved for every request, including HEAD.');

const routeAdapter = {
  sourceVector: () => stableVector,
  read: ({ identity }) => snapshotResult(record({ mode: identity.mode, runId: identity.runId })),
  page: ({ request }) => {
    const recordType = request.recordTypes[0];
    const fields = recordType === 'risk' ? { title: 'Risk fixture', severity: 'P0', blocking: true }
      : recordType === 'evidence' ? { title: 'Evidence fixture', status: 'available' }
        : recordType === 'metric' ? { title: 'Metric fixture', status: 'current' }
          : { title: 'Run fixture', executionState: 'running', terminal: false };
    return pageResult(request, [record({
      mode: request.mode,
      recordId: `${recordType}-1`,
      recordType,
      fields,
    })]);
  },
};
for (const [route, expectedId] of [
  [`${CONSOLE_API_PREFIX}/overview`, 'overview'],
  [`${CONSOLE_API_PREFIX}/attention?mode=comparative&severity=p0`, 'attention'],
  [`${CONSOLE_API_PREFIX}/evidence?mode=comparative&run=run-00000001`, 'evidence'],
  [`${CONSOLE_API_PREFIX}/metrics/provenance?mode=comparative&metric=metric-1`, 'metrics-provenance'],
]) {
  const response = await createConsoleApi({ indexAdapter: routeAdapter }).handle({ method: 'GET', url: route });
  assert.equal(response.status, 200, route);
  assert.equal(response.body.routeId, expectedId);
  assert(response.body.data.items.length > 0);
  assert.equal(response.body.query.limit, 50);
}

const queryRecords = [
  record({ runId: 'run-search-1', recordId: 'risk-checkout', recordType: 'risk', sortKey: 'risk:1', fields: { title: 'Checkout unavailable', detail: 'Payment action fails', severity: 'P0', attentionKind: 'finding', areas: ['core'], sourceTimestamp: '2026-08-26T11:00:00.000Z' } }),
  record({ runId: 'run-search-1', recordId: 'attention-manual', recordType: 'attention', sortKey: 'risk:2', fields: { title: 'Checkout manual review', severity: 'P2', attentionKind: 'manual-obligation', areas: ['core'], sourceTimestamp: '2026-08-26T10:00:00.000Z' } }),
  record({ runId: 'run-search-1', recordId: 'evidence-image', recordType: 'evidence', sortKey: 'evidence:1', fields: { title: 'Checkout screenshot', sourceKind: 'screenshot', status: 'available', areas: ['core'], sourceTimestamp: '2026-08-26T09:00:00.000Z' } }),
  record({ runId: 'run-short', recordId: 'run', recordType: 'run', sortKey: 'recent:1', fields: { title: 'Short run', durationMs: 1_000, updatedAt: '2026-08-26T11:00:00.000Z', terminal: true } }),
  record({ runId: 'run-long', recordId: 'run', recordType: 'run', sortKey: 'recent:2', fields: { title: 'Long run', durationMs: 60_000, updatedAt: '2026-08-26T10:00:00.000Z', terminal: true } }),
];
const queryAdapter = {
  sourceVector: () => stableVector,
  read: ({ identity }) => snapshotResult(queryRecords.find(({ mode, runId, recordId }) => mode === identity.mode && runId === identity.runId && recordId === 'run') ?? null),
  page: ({ request }) => pageResult(request, queryRecords.filter(({ mode, recordType }) => mode === request.mode && request.recordTypes.includes(recordType))),
};
const queryApi = createConsoleApi({ indexAdapter: queryAdapter });
const filteredFindings = await queryApi.handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/attention?mode=comparative&q=checkout%20unavailable&suite=core&kind=finding&sort=risk`,
});
assert.equal(filteredFindings.status, 200);
assert.deepEqual(filteredFindings.body.data.items.map(({ recordId }) => recordId), ['risk-checkout']);
assert.equal(filteredFindings.body.query.q, 'checkout unavailable');

const aliasedImage = await queryApi.handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/evidence?mode=comparative&kind=image&suite=core&sort=capture-time`,
});
assert.deepEqual(aliasedImage.body.data.items.map(({ recordId }) => recordId), ['evidence-image']);

const durationSorted = await queryApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&sort=duration` });
assert.deepEqual(durationSorted.body.data.items.map(({ runId }) => runId), ['run-long', 'run-short']);

const capabilityFailure = await createConsoleApi({
  indexAdapter: stableAdapter,
  resolveCapabilities() { throw new Error(`resolver saw ${`sk-ant-${'z'.repeat(32)}`}`); },
}).handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?mode=comparative` });
assert.equal(capabilityFailure.status, 503);
assert.equal(capabilityFailure.body.error.code, 'CONSOLE_CAPABILITIES_UNAVAILABLE');
assert(!JSON.stringify(capabilityFailure.body).includes('sk-ant-'));

for (const hostile of [
  'mode=comparative&mode=single-site',
  '__proto__=polluted',
  'authorization=Bearer-token-value',
  'filter=state%253Arunning',
  'unknown=value',
  'filter=constructor:polluted',
  `filter=state:${'x'.repeat(1_100)}`,
]) {
  const response = await api.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?${hostile}` });
  assert.equal(response.status, 400, hostile);
  const serialized = JSON.stringify(response.body);
  assert(!serialized.includes('Bearer-token-value'));
  assert(!serialized.includes('polluted'));
}

const minimumLimit = await createConsoleApi({ indexAdapter: stableAdapter }).handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&limit=0`,
});
assert.equal(minimumLimit.status, 200);
assert.equal(minimumLimit.body.query.limit, 1);

const cancelledController = new AbortController();
cancelledController.abort(new DOMException('Synthetic cancellation.', 'AbortError'));
let cancelledReads = 0;
const cancelledApi = createConsoleApi({
  indexAdapter: {
    sourceVector() { cancelledReads += 1; return stableVector; },
    read() { cancelledReads += 1; return snapshotResult(record()); },
    page({ request }) { cancelledReads += 1; return pageResult(request, []); },
  },
});
const cancelled = await cancelledApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/overview`, signal: cancelledController.signal });
assert.equal(cancelled.status, 499);
assert.equal(cancelled.body.error.code, 'CONSOLE_REQUEST_ABORTED');
assert.equal(cancelledReads, 0, 'Already-cancelled requests must not touch the index.');

let vectorCall = 0;
let currentVector = sourceVector('vector-a');
const movingVectors = [
  sourceVector('vector-a'),
  sourceVector('vector-b'),
  sourceVector('vector-b'),
  sourceVector('vector-c'),
];
const staleApi = createConsoleApi({
  indexAdapter: {
    sourceVector() {
      currentVector = movingVectors[Math.min(vectorCall, movingVectors.length - 1)];
      vectorCall += 1;
      return currentVector;
    },
    read: () => snapshotResult(record(), currentVector),
    page: ({ request }) => pageResult(request, [record()], currentVector),
  },
});
const stale = await staleApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?mode=comparative` });
assert.equal(stale.status, 200);
assert.equal(stale.body.complete, false);
assert.equal(stale.body.freshness, 'stale');
assert.equal(stale.body.work.assemblyAttempts, 2, 'A changed vector must retry assembly exactly once.');
assert(stale.body.limitations.some(({ code }) => code === 'source-stale'));

let retryVectorCall = 0;
let retryCurrentVector = sourceVector('vector-retry-a');
const retryVectors = [
  sourceVector('vector-retry-a'), sourceVector('vector-retry-b'),
  sourceVector('vector-retry-b'), sourceVector('vector-retry-c'),
];
const isolatedRetryBudget = await createConsoleApi({
  budget: createConsoleReadBudget({ maxRecords: 1, maxSourceFiles: 0, maxSourceBytes: 0, maxElapsedMs: 1_000 }),
  indexAdapter: {
    sourceVector() {
      retryCurrentVector = retryVectors[Math.min(retryVectorCall++, retryVectors.length - 1)];
      return retryCurrentVector;
    },
    read: () => snapshotResult(record(), retryCurrentVector),
    page: ({ request }) => pageResult(request, [record()], retryCurrentVector),
  },
}).handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?mode=comparative` });
assert.equal(isolatedRetryBudget.status, 200, 'The stability retry must receive a fresh per-attempt read budget.');
assert.equal(isolatedRetryBudget.body.work.assemblyAttempts, 2);
assert.equal(isolatedRetryBudget.body.work.recordsRead, 2, 'Reported work must merge both bounded attempts.');

const hostileSecret = `sk-ant-${'s'.repeat(32)}`;
const hostileRecord = record({
  runId: 'run-00000003',
  recordId: 'run-3',
  sortKey: '0003',
  fields: { title: hostileSecret },
});
const hostileAdapter = {
  sourceVector: () => stableVector,
  read: () => snapshotResult(hostileRecord),
  page: ({ request }) => pageResult(request, [record(), hostileRecord]),
};
const hostileResponse = await createConsoleApi({ indexAdapter: hostileAdapter }).handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/runs?mode=comparative`,
});
assert.equal(hostileResponse.status, 200);
assert.equal(hostileResponse.body.data.items.length, 1);
assert.equal(hostileResponse.body.complete, false);
assert(hostileResponse.body.limitations.some(({ code }) => code === 'source-malformed'));
assert(!JSON.stringify(hostileResponse.body).includes(hostileSecret));

const largeRecords = Array.from({ length: 100 }, (_, index) => record({
  runId: `run-${String(index).padStart(8, '0')}`,
  recordId: `run-${index}`,
  sortKey: String(index).padStart(4, '0'),
  fields: {
    title: `Large fixture ${index}`,
    detail: 'd'.repeat(2_048),
    limitations: Array.from({ length: 20 }, (__, item) => `limitation-${index}-${item}-${'x'.repeat(300)}`),
  },
}));
const largeApi = createConsoleApi({
  indexAdapter: {
    sourceVector: () => stableVector,
    read: () => snapshotResult(largeRecords[0]),
    page: ({ request }) => pageResult(request, largeRecords),
  },
});
const large = await largeApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&limit=100` });
assert.equal(large.status, 200);
assert(Buffer.byteLength(JSON.stringify(large.body)) <= CONSOLE_API_MAX_RESPONSE_BYTES);
assert(large.body.data.items.length > 0 && large.body.data.items.length < 100);
assert.equal(large.body.data.hasMore, true);
assert(large.body.limitations.some(({ sourceId, code }) => sourceId === 'console-api' && code === 'budget-exhausted'));

const unsafeFailureApi = createConsoleApi({
  indexAdapter: {
    sourceVector: () => stableVector,
    read() { throw new Error(`failed with ${hostileSecret}`); },
    page() { throw new Error(`failed with ${hostileSecret}`); },
  },
});
const safeFailure = await unsafeFailureApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?mode=comparative` });
assert.equal(safeFailure.status, 503);
assert.equal(safeFailure.body.error.code, 'CONSOLE_INDEX_UNAVAILABLE');
assert(!JSON.stringify(safeFailure.body).includes(hostileSecret));

const sourceWorkApi = createConsoleApi({
  indexAdapter: {
    sourceVector: () => stableVector,
    read: () => snapshotResult(record(), stableVector, { work: work(1, { sourceFilesRead: 1 }) }),
    page: ({ request }) => pageResult(request, [], stableVector, { work: work(0, { sourceFilesRead: 1 }) }),
  },
});
const sourceWork = await sourceWorkApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?mode=comparative` });
assert.equal(sourceWork.status, 503);
assert.equal(sourceWork.body.error.code, 'CONSOLE_READ_BUDGET_EXCEEDED');

const index = createConsoleIndex({
  clock: () => new Date(NOW),
  sources: [{ sourceId: 'fixture-source', revision: 'revision-1', updatedAt: NOW, complete: true }],
});
for (const item of [
  record(),
  record({ recordId: 'timeline-1', recordType: 'timeline', sortKey: '0002', fields: { stageId: 'browser', status: 'running', sequence: 1 } }),
  record({ runId: 'run-00000002', recordId: 'run', sortKey: '0003', fields: { title: 'Second run', executionState: 'queued', terminal: false } }),
]) index.upsert(item);
const realApi = createConsoleApi({ index });
const summary = await realApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs/comparative/run-00000001` });
assert.equal(summary.status, 200);
assert.equal(summary.body.data.record.runId, 'run-00000001');
const timeline = await realApi.handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/runs/comparative/run-00000001/timeline?scope=all&kind=timeline&limit=50`,
});
assert.equal(timeline.status, 200);
assert.equal(timeline.body.data.items.length, 1);
assert.equal(timeline.body.data.items[0].recordType, 'timeline');

for (let item = 0; item < 450; item += 1) {
  index.upsert(record({
    runId: `run-unrelated-${String(item).padStart(4, '0')}`,
    recordId: `timeline-${item}`,
    recordType: 'timeline',
    sortKey: `timeline:${String(item).padStart(4, '0')}`,
    fields: { stageId: 'browser', status: 'completed', sequence: 0 },
  }));
}
const partitionedTimeline = await realApi.handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/runs/comparative/run-00000001/timeline?scope=all&kind=timeline&limit=50`,
});
assert.equal(partitionedTimeline.status, 200);
assert.deepEqual(partitionedTimeline.body.data.items.map(({ runId }) => runId), ['run-00000001']);
assert.equal(partitionedTimeline.body.work.recordsRead, 1,
  'Run timeline reads must partition by run before spending the 400-record API budget.');

const firstPage = await realApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&scope=all&limit=1` });
assert.equal(firstPage.status, 200);
assert.equal(firstPage.body.data.hasMore, true);
assert(firstPage.body.data.nextCursor);
const continuedPage = await realApi.handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&scope=all&limit=1&cursor=${firstPage.body.data.nextCursor}`,
});
assert.equal(continuedPage.status, 200);
assert.equal(continuedPage.body.data.items.length, 1);
assert.notEqual(continuedPage.body.data.items[0].runId, firstPage.body.data.items[0].runId);
const mismatchedCursor = await realApi.handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&scope=all&state=running&limit=1&cursor=${firstPage.body.data.nextCursor}`,
});
assert.equal(mismatchedCursor.status, 409);
assert.equal(mismatchedCursor.body.error.code, 'CONSOLE_CURSOR_STALE');
assert(!JSON.stringify(mismatchedCursor.body).includes(firstPage.body.data.nextCursor));

const purgeToken = index.beginPurge({ mode: 'comparative', runId: 'run-00000001' });
index.commitPurge(purgeToken);
const purgedSummary = await realApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs/comparative/run-00000001` });
assert.equal(purgedSummary.status, 410);
assert.equal(purgedSummary.body.error.code, 'CONSOLE_RUN_PURGED');
const afterPurge = await realApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&scope=all` });
assert(afterPurge.body.data.items.every(({ runId }) => runId !== 'run-00000001'));

const overviewIndex = createConsoleIndex({
  clock: () => new Date(NOW),
  sources: [{ sourceId: 'fixture-source', revision: 'revision-1', updatedAt: NOW, complete: true }],
});
const comparableRunFields = {
  executionState: 'completed',
  activityState: 'normal',
  terminal: true,
  finalizationStatus: 'complete',
  coverageStatus: 'complete',
  evidenceAuthorityStatus: 'authoritative',
  pipelineIntegrityStatus: 'complete',
  productionOrigin: 'https://production.example',
  candidateOrigin: 'https://candidate.example',
  profile: 'release',
  targetSetKey: 'desktop-chromium',
};
for (const item of [
  record({ runId: 'overview-previous', recordId: 'run', sortKey: 'recent:2', fields: { ...comparableRunFields, title: 'Previous', finishedAt: '2026-08-26T10:00:00.000Z', updatedAt: '2026-08-26T10:00:00.000Z' } }),
  record({ runId: 'overview-current', recordId: 'run', sortKey: 'recent:1', fields: { ...comparableRunFields, title: 'Current', outcome: 'review', finishedAt: '2026-08-26T11:00:00.000Z', updatedAt: '2026-08-26T11:00:00.000Z' } }),
  record({ runId: 'overview-active', recordId: 'run', sortKey: 'recent:0', fields: { ...comparableRunFields, title: 'Active', executionState: 'running', activityState: 'normal', terminal: false, finishedAt: null, startedAt: '2026-08-26T11:30:00.000Z', updatedAt: NOW, progressCompleted: 12, progressTotal: 40, findingCount: 2, phase: 'browser' } }),
  record({ runId: 'overview-previous', recordId: 'risk:historical', recordType: 'risk', sortKey: 'risk:0000', fields: { title: 'Historical P0 must not leak', severity: 'P0', blocking: true, attentionKind: 'finding', novelty: 'new', affectedScope: 99, sourceRecordId: 'historical', sourceTimestamp: '2026-08-26T10:00:00.000Z', destinations: ['/findings.html?mode=comparative&record=historical'] } }),
  record({ runId: 'overview-current', recordId: 'risk:current', recordType: 'risk', sortKey: 'risk:0001', fields: { title: 'Current P1 defect', severity: 'P1', blocking: true, attentionKind: 'finding', novelty: 'new', affectedScope: 3, sourceRecordId: 'current', sourceTimestamp: '2026-08-26T11:00:00.000Z', destinations: ['/findings.html?mode=comparative&record=current'] } }),
  ...['coverage', 'evidence-completion', 'evidence', 'pipeline', 'manual', 'finalization'].map((id) => record({
    runId: 'overview-current', recordId: `trust:${id}`, recordType: 'trust', sortKey: `trust:${id}`,
    fields: { title: id, status: id === 'pipeline' ? 'failed' : 'complete', sourceTimestamp: '2026-08-26T11:00:00.000Z' },
  })),
  record({ runId: 'overview-current', recordId: 'metric:duration', recordType: 'metric', sortKey: 'metric:2', fields: { title: 'Run duration', subtitle: 'Current comparative publication', durationMs: 60_000, detail: 'Window: immutable publication generation. Formula: run.durationMs', sourceTimestamp: '2026-08-26T11:00:00.000Z' } }),
]) overviewIndex.upsert(item);
const projectedOverview = await createConsoleApi({ index: overviewIndex }).handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/overview?mode=comparative&scope=all&sort=attention&limit=100`,
});
assert.equal(projectedOverview.status, 200);
assert.equal(projectedOverview.body.data.overview.schemaVersion, 1);
assert.equal(projectedOverview.body.data.overview.latestTerminalRun.runId, 'overview-current');
assert.equal(projectedOverview.body.data.overview.comparablePredecessor.available, true);
assert.equal(projectedOverview.body.data.overview.comparablePredecessor.record.runId, 'overview-previous');
assert.deepEqual(projectedOverview.body.data.overview.productRisk.items.map(({ recordId }) => recordId), ['risk:current']);
assert(!projectedOverview.body.data.items.some(({ recordId }) => recordId === 'risk:historical'));
assert(projectedOverview.body.data.overview.runTrust.facts.some(({ recordId }) => recordId === 'trust:pipeline'));
assert(projectedOverview.body.data.overview.activeRuns.items.some(({ runId }) => runId === 'overview-active'));
assert.deepEqual(projectedOverview.body.data.overview.statistics.map(({ recordId }) => recordId), ['metric:duration']);
const projectedKeys = new Set(projectedOverview.body.data.items.map(({ mode, runId, recordId }) => `${mode}:${runId}:${recordId}`));
for (const reference of [
  ...projectedOverview.body.data.overview.productRisk.items,
  ...projectedOverview.body.data.overview.runTrust.facts,
  ...projectedOverview.body.data.overview.activeRuns.items,
  ...projectedOverview.body.data.overview.statistics,
  projectedOverview.body.data.overview.latestTerminalRun,
  projectedOverview.body.data.overview.comparablePredecessor.record,
]) assert(projectedKeys.has(`${reference.mode}:${reference.runId}:${reference.recordId}`), 'Every Overview reference must resolve inside the bounded item set.');

const incompleteOverviewIndex = createConsoleIndex({
  clock: () => new Date(NOW),
  sources: [{ sourceId: 'fixture-source', revision: 'revision-incomplete', updatedAt: NOW, complete: false }],
});
for (const item of overviewIndex.page({
  mode: 'comparative', scopeKey: 'all', normalizedFilterKey: 'copy', cursor: null,
  limit: 100, recordTypes: ['run', 'risk', 'trust', 'attention', 'metric', 'timeline', 'provenance'],
}).items) incompleteOverviewIndex.upsert(item, { sourceComplete: false });
const incompleteOverview = await createConsoleApi({ index: incompleteOverviewIndex }).handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/overview?mode=comparative&scope=all&sort=attention&limit=100`,
});
assert.equal(incompleteOverview.status, 200);
assert.equal(incompleteOverview.body.data.overview.comparablePredecessor.available, false,
  'An incomplete run-history index must never publish a predecessor claim.');
assert.equal(incompleteOverview.body.data.overview.comparablePredecessor.record, null);
assert.equal(incompleteOverview.body.data.overview.comparablePredecessor.reason, 'incomplete-run-history');
const incompleteRiskReferences = new Set(incompleteOverview.body.data.overview.productRisk.items
  .map(({ mode, runId, recordId }) => `${mode}:${runId}:${recordId}`));
assert(incompleteOverview.body.data.items
  .filter(({ mode, runId, recordId }) => incompleteRiskReferences.has(`${mode}:${runId}:${recordId}`))
  .every(({ fields }) => fields.novelty === null),
'Novelty must be withheld when predecessor history is incomplete.');

const sparseIndex = createConsoleIndex({
  clock: () => new Date(NOW),
  sources: [{ sourceId: 'fixture-source', revision: 'revision-1', updatedAt: NOW, complete: true }],
});
for (let item = 0; item < 250; item += 1) {
  sparseIndex.upsert(record({
    runId: `sparse-${String(item).padStart(4, '0')}`,
    recordId: 'run',
    sortKey: `recent:${String(item).padStart(4, '0')}`,
    fields: {
      title: item === 225 ? 'Rare searchable result' : `Ordinary run ${item}`,
      executionState: 'completed',
      terminal: true,
      durationMs: item,
    },
  }));
}
const sparseApi = createConsoleApi({ index: sparseIndex });
const sparse = await sparseApi.handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&q=rare%20searchable&sort=recent&limit=10`,
});
assert.equal(sparse.status, 200);
assert.deepEqual(sparse.body.data.items.map(({ runId }) => runId), ['sparse-0225'], 'Sparse filters must continue across bounded index pages.');
assert.equal(sparse.body.work.recordsRead, 250);

const durationFirst = await sparseApi.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&sort=duration&limit=1` });
assert.equal(durationFirst.body.data.items[0].runId, 'sparse-0249');
const durationSecond = await sparseApi.handle({
  method: 'GET',
  url: `${CONSOLE_API_PREFIX}/runs?mode=comparative&sort=duration&limit=1&cursor=${durationFirst.body.data.nextCursor}`,
});
assert.equal(durationSecond.body.data.items[0].runId, 'sparse-0248', 'Alternate-sort cursors must seek in the same ordering as the page.');

const methodMismatch = await api.handle({ method: 'POST', url: `${CONSOLE_API_PREFIX}/overview?authorization=do-not-parse` });
assert.equal(methodMismatch.handled, true);
assert.equal(methodMismatch.status, 405);
assert.equal(methodMismatch.headers.Allow, 'GET, HEAD');
const unknown = await api.handle({ method: 'GET', url: `${CONSOLE_API_PREFIX}/unknown` });
assert.deepEqual(unknown, { handled: false, status: 0, headers: {}, body: null });

console.log('Portal console API self-test passed.');
