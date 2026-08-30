import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createConsoleIndexClient, ConsoleIndexClientError, unsupportedConsoleQuery } from '../portal/public/console-index-client.js';
import {
  createConsoleIndexRefreshController,
  overviewRefreshInterval,
  runListRefreshInterval,
} from '../portal/public/console-index-refresh.js';

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
  const actionIds = [
    'stop', 'cancel', 'purge', 'manualEvidence', 'rekick', 'riskAcknowledge',
    'riskResolve', 'visualDisposition', 'baseline', 'aiReview', 'settings',
  ];
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
      actions: actionIds.map((actionId) => ({
        actionId, supported: true, authorized: null, eligible: true, available: false, unavailableReason: 'Authorization is required.',
      })),
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
assert.equal(first.capabilities.items[0].actions.length, 11,
  'The browser client must accept the complete action contract emitted by the console API.');

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

const unknownCapabilityAction = structuredClone(body({ hasMore: false, nextCursor: null }));
unknownCapabilityAction.capabilities.items[0].actions = [{
  actionId: 'inventedAction', supported: true, authorized: true, eligible: true, available: true, unavailableReason: null,
}];
await assert.rejects(
  () => createConsoleIndexClient({ fetch: async () => jsonResponse(unknownCapabilityAction) }).runs({}),
  (error) => error instanceof ConsoleIndexClientError && error.code === 'CONSOLE_RESPONSE_INVALID',
  'The browser client must reject capability actions outside the shared console contract.',
);

const stale = createConsoleIndexClient({
  fetch: async () => jsonResponse({ schemaVersion: 1, error: { code: 'CONSOLE_CURSOR_STALE', message: 'The console cursor no longer matches this query or source revision.' } }, { status: 409 }),
});
await assert.rejects(() => stale.runs({}, { cursor: 'cursor_1' }), (error) => error.code === 'CONSOLE_CURSOR_STALE' && error.retryable === true);

const expiredSharedSession = createConsoleIndexClient({
  fetch: async () => jsonResponse({ error: 'Browser session has expired.', code: 'SESSION_EXPIRED' }, { status: 401 }),
});
await assert.rejects(
  () => expiredSharedSession.findings({}),
  (error) => error instanceof ConsoleIndexClientError
    && error.code === 'SESSION_EXPIRED'
    && error.message === 'Browser session has expired.'
    && error.status === 401,
  'Shared read authorization errors must preserve their top-level code and message.',
);

const evidenceSource = await readFile(new URL('../portal/public/evidence.js', import.meta.url), 'utf8');
const sessionBannerSource = await readFile(new URL('../portal/public/console-session-banner.js', import.meta.url), 'utf8');
const composeSource = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const credentialLookupCommand = "docker compose exec -T portal sh -c 'cat /var/lib/ai-mobile-testing/shared/credentials/local-cutover-operator.credential'";
assert(sessionBannerSource.includes(`credentialCommand.textContent = ${JSON.stringify(credentialLookupCommand)};`),
  'The inline session prompt must retain the complete scoped Docker credential lookup command.');
assert.match(composeSource, /shared-control-identities:\/var\/lib\/ai-mobile-testing\/shared\/credentials/u,
  'The portal must mount the shared identity volume at the path named by the prompt.');
assert.match(composeSource, /AUDIT_SHARED_PORTAL_OPERATOR_CREDENTIAL_FILE: \/var\/lib\/ai-mobile-testing\/shared\/credentials\/local-cutover-operator\.credential/u,
  'Identity provisioning must write the operator credential to the file named by the prompt.');
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

const refreshTimers = new Map();
const refreshListeners = new Map();
let refreshTimerSequence = 0;
let refreshHidden = false;
let refreshCalls = 0;
const refreshDocument = {
  get hidden() { return refreshHidden; },
  addEventListener(name, listener) { refreshListeners.set(name, listener); },
  removeEventListener(name, listener) {
    if (refreshListeners.get(name) === listener) refreshListeners.delete(name);
  },
};
const refreshController = createConsoleIndexRefreshController({
  document: refreshDocument,
  refresh: async () => { refreshCalls += 1; },
  intervalFor: (result) => overviewRefreshInterval(result?.page),
  setTimer(callback, milliseconds) {
    const id = ++refreshTimerSequence;
    refreshTimers.set(id, { callback, milliseconds });
    return id;
  },
  clearTimer(id) { refreshTimers.delete(id); },
});
refreshController.accept({ page: { overview: { activeRuns: { total: 7 } } } });
assert.deepEqual([...refreshTimers.values()].map(({ milliseconds }) => milliseconds), [5_000],
  'An Overview containing active runs must reconcile on the active cadence.');
refreshController.pause();
assert.equal(refreshTimers.size, 0, 'Authorization loss must cancel scheduled console refreshes.');
refreshListeners.get('visibilitychange')();
await Promise.resolve();
assert.equal(refreshCalls, 0, 'A paused console must not retry protected reads on visibility changes.');
refreshController.resume();
refreshController.accept({ page: { overview: { activeRuns: { total: 7 } } } });
assert.deepEqual([...refreshTimers.values()].map(({ milliseconds }) => milliseconds), [5_000],
  'A reauthorized console must resume its normal refresh cadence.');
refreshHidden = true;
refreshListeners.get('visibilitychange')();
assert.equal(refreshTimers.size, 0, 'Hidden console pages must not retain background polling timers.');
refreshHidden = false;
refreshListeners.get('visibilitychange')();
await Promise.resolve();
assert.equal(refreshCalls, 1, 'A visible console page must immediately reconcile after being hidden.');
refreshController.accept({ page: { overview: { activeRuns: { total: 0 } } } });
assert.deepEqual([...refreshTimers.values()].map(({ milliseconds }) => milliseconds), [30_000],
  'An idle Overview must continue bounded reconciliation on the slower cadence.');
assert.equal(runListRefreshInterval({ items: [{ fields: { terminal: false } }] }), 5_000,
  'A Runs page containing nonterminal work must reconcile on the active cadence.');
assert.equal(runListRefreshInterval({ items: [{ fields: { terminal: true } }] }), 30_000,
  'A terminal-only Runs page must reconcile on the idle cadence.');
const scheduled = [...refreshTimers.values()][0];
refreshTimers.clear();
scheduled.callback();
await Promise.resolve();
assert.equal(refreshCalls, 2, 'The scheduled refresh must execute exactly once.');
refreshController.destroy();
assert.equal(refreshTimers.size, 0);
assert.equal(refreshListeners.has('visibilitychange'), false);

console.log('Portal bounded console index client self-test passed.');
