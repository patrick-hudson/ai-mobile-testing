import assert from 'node:assert/strict';
import {
  DEFAULT_ROUTE_INVENTORY_LIMITS,
  buildRouteInventory,
} from '../shared/route-inventory.mjs';

assert.deepEqual(DEFAULT_ROUTE_INVENTORY_LIMITS, {
  maxRoutes: 500,
  maxDepth: 4,
  maxConcurrency: 8,
  maxHtmlBytes: 50 * 1024 * 1024,
  maxDurationMs: 60_000,
  maxQueryVariantsPerPath: 3,
  maxQueryParameters: 12,
});

const origin = 'https://beta.example.test';
const allowExactPublicOrigin = async ({ url: value, origin: expectedOrigin }) => ({
  allowed: new URL(value).origin === expectedOrigin,
  ...((new URL(value).origin === expectedOrigin) ? {} : { code: 'cross-origin', detail: 'Synthetic exact-origin policy rejection.' }),
});
const adapters = {
  catalog: ['/guide#catalog-fragment', '/', '/missing'],
  'deployment-manifest': {
    candidates: ['/guide', '/from-manifest', '/search?b=2&a=1', '/download/report.pdf'],
    limitations: [{ code: 'route-type-unenumerable', detail: 'The manifest cannot enumerate client-generated searches.' }],
  },
  sitemap: async () => {
    throw new Error('synthetic sitemap outage');
  },
  'rendered-navigation': [
    '/from-navigation',
    { url: '/submit', method: 'POST', discoveryKind: 'form' },
    'mailto:help@example.test',
    'https://127.0.0.1/private',
    'https://attacker.example/escape',
  ],
};

const pages = new Map([
  [origin, {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<main>root</main>',
    links: [
      '/guide#crawl-fragment',
      '/deep',
      '/search?b=2&a=1',
      '/search?a=2',
      '/search?a=3',
      '/api/private',
      '/logout',
      '/app.js',
      'https://169.254.169.254/latest/meta-data',
    ],
    forms: [{ url: '/danger', method: 'POST' }],
  }],
  [`${origin}/deep`, {
    status: 200,
    contentType: 'text/html',
    body: '<a>deep</a>',
    links: ['/redirecting', '/broken', '/image'],
  }],
  [`${origin}/guide`, { status: 200, contentType: 'text/html', body: '<main>guide</main>', links: [] }],
  [`${origin}/search?a=1&b=2`, { status: 200, contentType: 'text/html', body: '<main>search</main>', links: [] }],
  [`${origin}/search?a=2`, { status: 200, contentType: 'text/html', body: '<main>search two</main>', links: [] }],
  [`${origin}/redirecting`, { status: 302, contentType: 'text/html', body: '', redirectUrl: '/final', links: [] }],
  [`${origin}/final`, { status: 200, contentType: 'text/html', body: '<main>final</main>', links: [] }],
  [`${origin}/image`, { status: 200, contentType: 'image/png', bodyBytes: 40, links: [] }],
]);

let activeFetches = 0;
let observedConcurrency = 0;
const fetchPage = async ({ url }) => {
  activeFetches += 1;
  observedConcurrency = Math.max(observedConcurrency, activeFetches);
  await Promise.resolve();
  activeFetches -= 1;
  if (url.endsWith('/broken')) throw new Error('synthetic connection reset');
  const page = pages.get(url);
  if (!page) return { status: 404, contentType: 'text/html', body: 'missing', links: [] };
  return structuredClone(page);
};

const options = {
  origin,
  adapters,
  entryPoints: ['/'],
  fetchPage,
  urlPolicy: allowExactPublicOrigin,
  now: () => 0,
  limits: {
    maxRoutes: 50,
    maxDepth: 4,
    maxConcurrency: 2,
    maxHtmlBytes: 10_000,
    maxDurationMs: 5_000,
    maxQueryVariantsPerPath: 2,
    maxQueryParameters: 4,
  },
};

const first = await buildRouteInventory(options);
const second = await buildRouteInventory({
  ...options,
  adapters: {
    ...adapters,
    catalog: [...adapters.catalog].reverse(),
    'rendered-navigation': [...adapters['rendered-navigation']].reverse(),
  },
});
assert.deepEqual(second, first, 'Adapter and discovery ordering must not change the frozen manifest.');
assert.equal(first.schemaVersion, 1);
assert.equal(first.origin, origin);
assert.deepEqual(first.sources.map(({ source }) => source), [
  'catalog', 'deployment-manifest', 'sitemap', 'rendered-navigation', 'crawl',
]);
assert.deepEqual(
  first.sources.find(({ source }) => source === 'sitemap'),
  { source: 'sitemap', candidatesObserved: 0, includedContributions: 0, exclusions: 0, failures: 1, limitations: 1 },
  'A failed source must remain explicit even when it contributes no route.',
);
assert.equal(observedConcurrency, 2, 'The fixture must exercise parallel fetching without exceeding the configured concurrency ceiling.');

const guide = first.routes.find(({ path, query }) => path === '/guide' && query === '');
assert(guide, 'The shared guide route must be inventoried.');
assert.deepEqual(
  guide.sources.map(({ source }) => source),
  ['catalog', 'deployment-manifest', 'crawl'],
  'Deduplication must preserve stable attribution from every contributing source.',
);
assert(first.routes.some(({ url }) => url === `${origin}/search?a=1&b=2`), 'Query pairs must normalize deterministically.');
assert(first.routes.some(({ url }) => url === `${origin}/final`), 'Same-origin redirects must contribute their target route.');
assert(first.redirects.some(({ from, to, accepted }) => from.endsWith('/redirecting') && to.endsWith('/final') && accepted));
assert(first.responses.some(({ url, status }) => url.endsWith('/redirecting') && status === 302));
assert(first.routes.find(({ path }) => path === '/image')?.disposition === 'non-html');
assert(first.routes.find(({ path }) => path === '/broken')?.disposition === 'fetch-failed');
assert(first.routes.find(({ path }) => path === '/missing')?.disposition === 'unreachable', 'Every reviewed route must be directly probed so a missing page remains explicit response evidence.');
assert(first.responses.some(({ url, status }) => url.endsWith('/missing') && status === 404));

for (const code of [
  'download',
  'form-submit',
  'non-http',
  'loopback-address',
  'metadata-address',
  'cross-origin',
  'api-path',
  'logout-path',
  'asset',
  'query-variant-limit',
  'non-html-response',
]) {
  assert(first.exclusions.some((entry) => entry.code === code), `Expected a retained ${code} exclusion.`);
}
assert(first.failures.some(({ code, source }) => code === 'adapter-error' && source === 'sitemap'));
assert(first.failures.some(({ code, url }) => code === 'fetch-error' && url?.endsWith('/broken')));
assert(first.limitations.some(({ code, source }) => code === 'source-unavailable' && source === 'sitemap'));
assert(first.limitations.some(({ code }) => code === 'route-type-unenumerable'));
assert(first.bounds.find(({ code }) => code === 'query-variants')?.exhausted);

const manifestKeys = new Set();
const collectKeys = (value) => {
  if (Array.isArray(value)) return value.forEach(collectKeys);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    manifestKeys.add(key.toLowerCase());
    collectKeys(child);
  }
};
collectKeys(first);
assert(!manifestKeys.has('productoracle'));
assert(!manifestKeys.has('expected'), 'Inventory evidence must not invent expected product behavior.');
assert(!manifestKeys.has('finding') && !manifestKeys.has('findings'), 'Inventory evidence must not derive product Findings.');

const bounded = await buildRouteInventory({
  origin,
  adapters: { catalog: ['/a', '/b', '/c'] },
  entryPoints: ['/a'],
  fetchPage: async ({ url }) => ({
    status: 200,
    contentType: 'text/html',
    bodyBytes: 11,
    links: url.endsWith('/a') ? ['/level-one'] : [],
  }),
  urlPolicy: allowExactPublicOrigin,
  limits: {
    maxRoutes: 2,
    maxDepth: 1,
    maxConcurrency: 1,
    maxHtmlBytes: 10,
    maxDurationMs: 1_000,
    maxQueryVariantsPerPath: 1,
    maxQueryParameters: 1,
  },
});
assert(bounded.bounds.find(({ code }) => code === 'route-count')?.exhausted);
assert(bounded.bounds.find(({ code }) => code === 'html-bytes')?.exhausted);
assert(bounded.exclusions.some(({ code }) => code === 'route-limit'));
assert(bounded.exclusions.some(({ code }) => code === 'html-byte-limit'));

const depthBounded = await buildRouteInventory({
  origin,
  adapters: {},
  entryPoints: ['/'],
  fetchPage: async ({ url }) => ({
    status: 200,
    contentType: 'text/html',
    body: '<main>bounded depth</main>',
    links: url === origin ? ['/level-one'] : ['/level-two'],
  }),
  urlPolicy: allowExactPublicOrigin,
  now: () => 0,
  limits: {
    maxRoutes: 10,
    maxDepth: 1,
    maxConcurrency: 1,
    maxHtmlBytes: 1_000,
    maxDurationMs: 1_000,
    maxQueryVariantsPerPath: 1,
    maxQueryParameters: 1,
  },
});
assert(depthBounded.bounds.find(({ code }) => code === 'crawl-depth')?.exhausted);
assert(depthBounded.exclusions.some(({ code, url, from }) => (
  code === 'depth-limit' && url === '/level-two' && from === `${origin}/level-one`
)), 'Depth exhaustion must retain both the refused candidate and its discovery source.');

let clockReads = 0;
const durationBounded = await buildRouteInventory({
  origin,
  adapters: {},
  entryPoints: ['/'],
  fetchPage: async () => {
    throw new Error('The duration gate must stop before fetching.');
  },
  urlPolicy: allowExactPublicOrigin,
  now: () => (clockReads++ === 0 ? 0 : 2_000),
  limits: {
    maxRoutes: 10,
    maxDepth: 1,
    maxConcurrency: 1,
    maxHtmlBytes: 1_000,
    maxDurationMs: 1_000,
    maxQueryVariantsPerPath: 1,
    maxQueryParameters: 1,
  },
});
assert(durationBounded.bounds.find(({ code }) => code === 'duration')?.exhausted);
assert.equal(durationBounded.responses.length, 0);

await assert.rejects(
  buildRouteInventory({ origin: 'http://127.0.0.1', adapters: {}, entryPoints: [] }),
  /must not use a loopback, private, link-local, or metadata address/,
);

await assert.rejects(
  buildRouteInventory({ origin, adapters: {}, fetchPage: async () => ({ status: 200 }) }),
  /requires an injected outbound URL policy/,
);

process.stdout.write('Route inventory self-test passed: deterministic source union, safe exclusions, bounded crawling, response evidence, and oracle separation are enforced.\n');
