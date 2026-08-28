import assert from 'node:assert/strict';
import {
  DEFAULT_LIVE_ROUTE_INVENTORY_LIMITS,
  buildLiveRouteInventory,
  parseInertHtmlNavigation,
} from '../shared/live-route-inventory.mjs';

assert.deepEqual(DEFAULT_LIVE_ROUTE_INVENTORY_LIMITS, {
  maxSitemaps: 24,
  maxSitemapDepth: 4,
  maxSitemapBytes: 10 * 1024 * 1024,
});

const origin = 'https://beta.example.test';
const publicAddress = '93.184.216.34';

function response(statusCode, body = '', headers = {}) {
  return {
    statusCode,
    headers,
    body,
    remoteAddress: publicAddress,
  };
}

function html(body, statusCode = 200) {
  return response(statusCode, body, { 'content-type': 'text/html; charset=utf-8' });
}

function xml(body, statusCode = 200) {
  return response(statusCode, body, { 'content-type': 'application/xml' });
}

const pages = new Map([
  [`${origin}/robots.txt`, response(200, [
    'User-agent: *',
    `Sitemap: ${origin}/sitemap-index.xml`,
    `Sitemap: ${origin}/direct.xml`,
    'Sitemap: https://off-origin.example/escape.xml',
    'Sitemap: http://%',
  ].join('\n'), { 'content-type': 'text/plain' })],
  [`${origin}/sitemap-index.xml`, xml(`<?xml version="1.0"?>
    <sitemapindex>
      <sitemap><loc>${origin}/nested.xml</loc></sitemap>
      <sitemap><loc>${origin}/malformed.xml</loc></sitemap>
      <sitemap><loc>https://off-origin.example/nested.xml</loc></sitemap>
      <sitemap><loc>http://%</loc></sitemap>
    </sitemapindex>`)],
  [`${origin}/direct.xml`, xml(`<urlset>
    <url><loc>${origin}/from-direct?a=1&amp;b=2</loc></url>
    <url><loc>https://off-origin.example/page</loc></url>
    <url><loc>http://%</loc></url>
  </urlset>`)],
  [`${origin}/nested.xml`, xml(`<urlset>
    <url><loc>${origin}/from-nested</loc></url>
    <url><loc>${origin}/redirect-start</loc></url>
  </urlset>`)],
  [`${origin}/malformed.xml`, xml('<html><not-a-sitemap /></html>')],
  [`${origin}/`, html(`<main>
    <a href="/from-root">Root link</a>
    <a href="/download.pdf" download>Download</a>
    <a href="https://off-origin.example/navigation">Off origin</a>
    <form action="/submit" method="post"></form>
    <script>window.fake = '<a href="/script-ghost">ghost</a>';</script>
  </main>`)],
  [`${origin}/catalog`, html('<main>catalog</main>')],
  [`${origin}/from-direct?a=1&b=2`, html('<main>direct</main>')],
  [`${origin}/from-nested`, html('<main>nested</main>')],
  [`${origin}/from-root`, html('<main>root navigation destination</main>')],
  [`${origin}/redirect-start`, response(301, '', { location: '/redirected' })],
  [`${origin}/redirect-cross`, response(302, '', { location: 'https://off-origin.example/redirected' })],
  [`${origin}/redirected`, html('<a href="/after-redirect">After redirect</a>')],
  [`${origin}/after-redirect`, html('<main>after redirect</main>')],
]);

const requestedUrls = [];
const lookedUpHosts = [];
const outbound = {
  lookup: async (hostname) => {
    lookedUpHosts.push(hostname);
    return [{ address: publicAddress, family: 4 }];
  },
  transport: async (request) => {
    requestedUrls.push(request.url.href);
    assert.equal(request.url.origin, origin, 'The pinned transport must never receive an off-origin URL.');
    return structuredClone(pages.get(request.url.href) ?? html('not found', 404));
  },
  timeoutMs: 5_000,
  maxBodyBytes: 512_000,
  maxRedirects: 4,
};

const options = {
  origin,
  catalogRoutes: ['/catalog', '/redirect-cross', '/redirect-start'],
  outbound,
  routeInventoryLimits: {
    maxRoutes: 100,
    maxDepth: 4,
    maxConcurrency: 3,
    maxHtmlBytes: 2_000_000,
    maxDurationMs: 10_000,
    maxQueryVariantsPerPath: 3,
    maxQueryParameters: 12,
  },
  now: () => 0,
};

const first = await buildLiveRouteInventory(options);
const second = await buildLiveRouteInventory({
  ...options,
  catalogRoutes: [...options.catalogRoutes].reverse(),
});

assert.deepEqual(second, first, 'Live route diagnostics must be deterministic across caller catalog ordering.');
assert.equal(first.schemaVersion, 1);
assert.equal(first.kind, 'live-route-inventory-diagnostic');
assert.deepEqual(first.capabilities, {
  scriptExecution: false,
  browserRendering: false,
  formSubmission: false,
  productOracleDerivation: false,
  findingDerivation: false,
});

assert.equal(first.sources.catalog.candidateCount, 3);
assert.deepEqual(first.sources.deploymentManifest, { supplied: false, candidateCount: 0 });
assert(first.limitations.some(({ source, code, detail }) => (
  source === 'deployment-manifest'
  && code === 'source-unavailable'
  && detail.includes('No deployment route manifest')
)));
assert(first.limitations.some(({ source, code, detail }) => (
  source === 'static-navigation'
  && code === 'not-browser-rendered'
  && detail.includes('JavaScript was not executed')
)));
assert.equal(first.sources.navigation.mode, 'static-root-html');
assert.equal(first.sources.navigation.browserRendered, false);

assert(first.sources.sitemap.documents.some(({ requestedUrl, kind }) => (
  requestedUrl.endsWith('/sitemap-index.xml') && kind === 'sitemap-index'
)));
assert(first.sources.sitemap.documents.some(({ requestedUrl, kind }) => (
  requestedUrl.endsWith('/direct.xml') && kind === 'url-set'
)));
assert(first.sources.sitemap.documents.some(({ requestedUrl, depth, kind }) => (
  requestedUrl.endsWith('/nested.xml') && depth === 1 && kind === 'url-set'
)));
assert(first.failures.some(({ code, url }) => code === 'sitemap-malformed' && url?.endsWith('/malformed.xml')));
assert(first.exclusions.some(({ code, source }) => code === 'cross-origin' && source === 'robots'));
assert(first.exclusions.some(({ code, source }) => code === 'cross-origin' && source === 'sitemap'));
assert(first.exclusions.some(({ code }) => code === 'invalid-url'));
assert(!requestedUrls.some((url) => url.startsWith('https://off-origin.example')));
assert(!lookedUpHosts.includes('off-origin.example'));

for (const expectedUrl of [
  `${origin}/catalog`,
  `${origin}/from-direct?a=1&b=2`,
  `${origin}/from-nested`,
  `${origin}/from-root`,
  `${origin}/redirect-start`,
  `${origin}/redirected`,
  `${origin}/after-redirect`,
]) {
  assert(first.inventory.routes.some(({ url }) => url === expectedUrl), `Expected inventoried route ${expectedUrl}.`);
}
assert(!first.inventory.routes.some(({ url }) => url.endsWith('/script-ghost')), 'Script text must never contribute routes.');
assert(first.inventory.exclusions.some(({ code, url }) => code === 'form-submit' && url === `${origin}/submit`));
assert(first.inventory.exclusions.some(({ code }) => code === 'download'));
assert(first.inventory.exclusions.some(({ code }) => code === 'cross-origin'));

const redirected = first.fetchEvidence.find(({ requestedUrl }) => requestedUrl.endsWith('/redirect-start'));
assert(redirected);
assert.equal(redirected.finalUrl, `${origin}/redirected`);
assert.equal(redirected.statusCode, 200);
assert(redirected.bodyBytes > 0);
assert.deepEqual(redirected.hops.map(({ statusCode }) => statusCode), [301, 200]);
assert.deepEqual(redirected.hops.map(({ location }) => location), ['/redirected', null]);
assert(redirected.hops.every(({ connectedAddress }) => connectedAddress === publicAddress));
assert(first.inventory.redirects.some(({ from, to, status, accepted }) => (
  from === `${origin}/redirect-start`
  && to === `${origin}/redirected`
  && status === 301
  && accepted
)));
const rejectedRedirect = first.fetchEvidence.find(({ requestedUrl }) => requestedUrl.endsWith('/redirect-cross'));
assert.equal(rejectedRedirect?.failure?.code, 'OUTBOUND_ORIGIN_DENIED');
assert.deepEqual(rejectedRedirect?.hops.map(({ statusCode }) => statusCode), [302]);
assert.equal(first.inventory.routes.find(({ url }) => url.endsWith('/redirect-cross'))?.disposition, 'fetch-failed');
const robotsEvidence = first.fetchEvidence.find(({ requestedUrl }) => requestedUrl.endsWith('/robots.txt'));
assert(robotsEvidence && robotsEvidence.statusCode === 200 && robotsEvidence.bodyBytes > 0);

const parsed = parseInertHtmlNavigation(`
  <base href="/docs/">
  <a href="/safe?a=1&amp;b=2" rel="next">safe</a>
  <a href="relative">relative</a>
  <form action="write" method="POST"></form>
  <template><a href="/template-ghost">ghost</a></template>
  <style>.x::after { content: '<a href="/style-ghost">'; }</style>
`, origin);
assert.deepEqual(parsed.map(({ url, discoveryKind }) => [url, discoveryKind]), [
  [`${origin}/docs/relative`, 'link'],
  [`${origin}/docs/write`, 'form'],
  [`${origin}/safe?a=1&b=2`, 'link'],
]);

const allKeys = new Set();
const collectKeys = (value) => {
  if (Array.isArray(value)) return value.forEach(collectKeys);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    allKeys.add(key.toLowerCase());
    collectKeys(child);
  }
};
collectKeys(first);
assert(!allKeys.has('productoracle') && !allKeys.has('productoracles'));
assert(!allKeys.has('finding') && !allKeys.has('findings'));
assert(!allKeys.has('expected'), 'Discovery evidence must not invent expected product behavior.');

const fallbackPages = new Map([
  [`${origin}/robots.txt`, response(200, 'User-agent: *', { 'content-type': 'text/plain' })],
  [`${origin}/sitemap.xml`, xml(`<urlset><url><loc>${origin}/fallback-direct</loc></url></urlset>`)],
  [`${origin}/`, html('<main>fallback root</main>')],
  [`${origin}/fallback-direct`, html('<main>fallback direct route</main>')],
]);
const fallback = await buildLiveRouteInventory({
  origin,
  catalogRoutes: [],
  deploymentRoutes: [],
  outbound: {
    lookup: async () => [{ address: publicAddress, family: 4 }],
    transport: async (request) => structuredClone(fallbackPages.get(request.url.href) ?? html('not found', 404)),
  },
  now: () => 0,
});
assert(fallback.sources.sitemap.documents.some(({ requestedUrl, kind }) => (
  requestedUrl === `${origin}/sitemap.xml` && kind === 'url-set'
)));
assert(fallback.inventory.routes.some(({ url }) => url === `${origin}/fallback-direct`));
assert.deepEqual(fallback.sources.deploymentManifest, { supplied: true, candidateCount: 0 });
assert(!fallback.limitations.some(({ source, detail }) => (
  source === 'deployment-manifest' && detail.includes('No deployment route manifest')
)));

await assert.rejects(
  buildLiveRouteInventory({ origin, outbound, catalogRoutes: undefined }),
  /catalogRoutes must be an injected array/,
);
await assert.rejects(
  buildLiveRouteInventory({ origin, outbound: { ...outbound, origin }, catalogRoutes: [] }),
  /outbound.origin must not be supplied/,
);

process.stdout.write('Live route inventory self-test passed: DNS-pinned acquisition, sitemap recursion, inert HTML discovery, redirect evidence, and explicit capability limitations are enforced.\n');
