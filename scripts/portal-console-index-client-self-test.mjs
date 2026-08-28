import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createConsoleIndexClient, ConsoleIndexClientError, unsupportedConsoleQuery } from '../portal/public/console-index-client.js';

const record = Object.freeze({
  schemaVersion: 1,
  mode: 'comparative',
  runId: 'run-1',
  recordId: 'run',
  recordType: 'run',
  scopeKey: 'release',
  sourceId: 'comparative-manifest',
  sourceRevision: 'revision-1',
  sourceUpdatedAt: '2026-08-26T12:00:00.000Z',
  complete: true,
  sortKey: '2026-08-26T12:00:00.000Z',
  fields: { title: 'Release audit', executionState: 'completed', terminal: true, destinations: ['/run.html?mode=comparative&run=run-1'] },
});

function body({ routeId = 'runs', items = [record], hasMore = true, nextCursor = 'cursor_1', complete = true } = {}) {
  return {
    schemaVersion: 1,
    apiVersion: 'v1',
    routeId,
    query: { mode: 'comparative', scopeKey: 'release', sort: 'recent', filters: {}, limit: 50, normalizedFilterKey: '{}' },
    sourceVector: {
      schemaVersion: 1, vectorRevision: 'vector-1', indexRevision: 'index-1', complete,
      sources: [{ sourceId: 'comparative-manifest', revision: 'revision-1', updatedAt: '2026-08-26T12:00:00.000Z', complete }],
    },
    complete,
    freshness: complete ? 'current' : 'stale',
    limitations: complete ? [] : [{ sourceId: 'single-site-queue', code: 'source-stale' }],
    work: { recordsRead: items.length, sourceFilesRead: 0, sourceBytesRead: 0, elapsedMs: 1, budgetExhausted: false, indexReads: 1, assemblyAttempts: 1 },
    capabilities: { schemaVersion: 1, items: [{
      schemaVersion: 1, identity: { mode: 'comparative', runId: 'run-1' }, contextId: 'comparative-live', authorityRevision: 'revision-1',
      actions: [{ actionId: 'purge', supported: true, authorized: null, eligible: true, available: false, unavailableReason: 'Authorization is required.' }],
    }] },
    data: { items, nextCursor, hasMore, omittedRecords: 0, cursorBinding: {} },
  };
}

function jsonResponse(document, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(document), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const calls = [];
const client = createConsoleIndexClient({
  fetch: async (url, options) => {
    calls.push({ url, options });
    const pathname = new URL(url, 'http://console.local').pathname;
    const routeId = pathname.endsWith('/attention') ? 'attention'
      : pathname.endsWith('/evidence') ? 'evidence'
        : pathname.endsWith('/overview') ? 'overview' : 'runs';
    return jsonResponse(body({ routeId }));
  },
});
const controller = new AbortController();
const first = await client.runs({ mode: 'comparative', scope: 'release', q: 'release audit', state: ['running', 'queued'], sort: 'risk', limit: 500 }, { signal: controller.signal });
assert.equal(calls.length, 1, 'A page read must never auto-follow its continuation cursor.');
assert.equal(calls[0].options.signal, controller.signal, 'The caller AbortSignal must reach fetch.');
const firstUrl = new URL(calls[0].url, 'http://console.local');
assert.equal(firstUrl.pathname, '/api/console/v1/runs');
assert.equal(firstUrl.searchParams.get('limit'), '100', 'Page size must clamp to the API maximum.');
assert.equal(firstUrl.searchParams.get('state'), 'running,queued');
assert.equal(firstUrl.searchParams.get('q'), 'release audit');
assert.equal(firstUrl.searchParams.get('sort'), 'risk');
assert.equal(firstUrl.searchParams.has('cursor'), false, 'Cursors are continuation state, never initial URL state.');
assert.equal(first.items.length, 1);
assert.equal(first.hasMore, true);
assert.equal(Object.isFrozen(first.items), true);

await client.runs({ mode: 'comparative', scope: 'release', sort: 'recent' }, { cursor: first.nextCursor });
assert.equal(new URL(calls[1].url, 'http://console.local').searchParams.get('cursor'), 'cursor_1', 'Only an explicit continuation request may carry a cursor.');

assert.deepEqual(unsupportedConsoleQuery('runs', { q: 'login', sort: 'risk' }), []);
assert.deepEqual(unsupportedConsoleQuery('findings', { suite: ['core'] }), []);
assert.deepEqual(unsupportedConsoleQuery('evidence', { q: 'trace', suite: ['release'] }), []);

await client.findings({ q: 'checkout regression', suite: ['checkout'], kind: ['finding'], sort: 'newest' });
const findingsUrl = new URL(calls.at(-1).url, 'http://console.local');
assert.equal(findingsUrl.searchParams.get('q'), 'checkout regression');
assert.equal(findingsUrl.searchParams.get('suite'), 'checkout');
assert.equal(findingsUrl.searchParams.get('kind'), 'finding');

const overviewDocument = structuredClone(body({ routeId: 'overview', hasMore: false, nextCursor: null }));
overviewDocument.data.overview = {
  schemaVersion: 1,
  productRisk: { items: [], total: 0, hasMore: false, state: { state: 'empty-success', reason: 'No indexed Product Risk records.' } },
  runTrust: { runIdentity: { mode: 'comparative', runId: 'run-1' }, facts: [], state: { state: 'partial', reason: 'Trust facts are not projected in this fixture.' } },
  activeRuns: { items: [], total: 0, hasMore: false },
  latestTerminalRun: { mode: 'comparative', runId: 'run-1', recordId: 'run' },
  comparablePredecessor: { available: false, record: null, reason: 'no-compatible-history', historyComplete: false },
  statistics: [],
  provenance: { sourceVectorRevision: 'vector-1', completeness: 'complete', limitations: [] },
};
const overviewClient = createConsoleIndexClient({ fetch: async () => jsonResponse(overviewDocument) });
const overview = await overviewClient.overview({ mode: 'comparative', scope: 'release', sort: 'attention' });
assert.equal(overview.overview.latestTerminalRun.runId, 'run-1');
assert.equal(overview.overview.comparablePredecessor.historyComplete, false);
const invalidOverview = structuredClone(overviewDocument);
invalidOverview.data.overview.latestTerminalRun = { mode: 'comparative', runId: 'outside-page', recordId: 'run' };
await assert.rejects(
  () => createConsoleIndexClient({ fetch: async () => jsonResponse(invalidOverview) }).overview({}),
  (error) => error instanceof ConsoleIndexClientError && error.code === 'CONSOLE_RESPONSE_INVALID',
  'Overview references must resolve inside the bounded response item set.',
);

const oversized = createConsoleIndexClient({
  maximumResponseBytes: 4_096,
  fetch: async () => jsonResponse(body(), { headers: { 'content-length': '4097' } }),
});
await assert.rejects(() => oversized.runs({}), (error) => error instanceof ConsoleIndexClientError && error.code === 'CONSOLE_RESPONSE_LIMIT');

const hostile = structuredClone(body({ hasMore: false, nextCursor: null }));
hostile.data.items[0].fields.detail = 'Authorization: Bearer abcdefghijklmnop';
const hostileClient = createConsoleIndexClient({ fetch: async () => jsonResponse(hostile) });
await assert.rejects(() => hostileClient.runs({}), (error) => error instanceof ConsoleIndexClientError && error.code === 'CONSOLE_RESPONSE_INVALID');

const stale = createConsoleIndexClient({
  fetch: async () => jsonResponse({ schemaVersion: 1, error: { code: 'CONSOLE_CURSOR_STALE', message: 'The console cursor no longer matches this query or source revision.' } }, { status: 409 }),
});
await assert.rejects(() => stale.runs({}, { cursor: 'cursor_1' }), (error) => error.code === 'CONSOLE_CURSOR_STALE' && error.retryable === true);

const evidenceSource = await readFile(new URL('../portal/public/evidence.js', import.meta.url), 'utf8');
assert.equal(/\bfetch\s*\(/u.test(evidenceSource), false, 'Evidence must not bypass the shared bounded index client.');
assert.match(evidenceSource, /createElement\(['"]img['"]\)/u, 'The selected inspector must support screenshot evidence.');
assert.match(evidenceSource, /createElement\(['"]video['"]\)/u, 'The selected inspector must support interaction-video evidence.');
assert.match(evidenceSource, /preload\s*=\s*['"]metadata['"]/u, 'Selected video must use bounded metadata preloading.');
assert.match(evidenceSource, /expectedPrefix/u, 'Media must be constrained to the selected run artifact namespace.');

for (const page of ['overview', 'runs', 'findings', 'evidence']) {
  const assetName = page === 'overview' ? 'index.html' : `${page}.html`;
  const html = await readFile(new URL(`../portal/public/${assetName}`, import.meta.url), 'utf8');
  assert.match(html, new RegExp(`id=["']${page}-console["']`, 'u'));
  assert.match(html, /aria-live=["']polite["']/u);
  assert.match(html, new RegExp(`src=["']/${page}\\.js["']`, 'u'));
}

console.log('Portal bounded console index client self-test passed.');
