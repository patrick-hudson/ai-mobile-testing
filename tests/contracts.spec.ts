import { ENVIRONMENTS, projectMetadata } from '../audit/environments.js';
import { resolveEnvironmentPath } from '../audit/environments.js';
import {
  CANDIDATE_HTML_ROUTES,
  CANDIDATE_PATHS,
  DATA_ENDPOINTS,
  EXPECTED_CATEGORY_COUNT,
  EXPECTED_HTML_ROUTE_COUNT,
  EXPECTED_PUBLISHED_DOCUMENT_COUNT,
} from '../audit/routes.js';
import { expect, staticEvidence, staticTest, structuredEvidence, structuredTest, test } from '../fixtures/test.js';
import { inspectHtmlDestination, loggedGet } from './helpers.js';

staticTest('[ENV-001] configured origin serves a secure, meaningful HTML document', staticEvidence('Capture the secure homepage response, meaningful content, and final rendered state.'), async ({ page, audit }) => {
  const response = await audit.step('Open the configured origin', 'HTTPS returns a successful HTML homepage.', async () => {
    const navigation = await page.goto('/', { waitUntil: 'domcontentloaded' });
    return navigation;
  });

  expect(new URL(page.url()).protocol).toBe('https:');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('main')).toContainText(/7-OH|withdrawal|quitting/i);
  audit.observe('Final origin', new URL(page.url()).origin);
  audit.observe('HTTP status', response?.status() ?? null, '200');
  await audit.checkpoint('environment-homepage');
  await audit.assertRuntimeHealthy();
});

staticTest('[ENV-002] static candidate route inventory is complete and internally consistent', staticEvidence('Capture the route inventory totals and the rendered sitemap that represents the published destinations.'), async ({ audit }, testInfo) => {
  const metadata = projectMetadata(testInfo.project.metadata);
  test.skip(!metadata.fullSweep, 'Inventory validation belongs to full-sweep projects.');

  const paths = CANDIDATE_HTML_ROUTES.map(({ path }) => path);
  const duplicatePaths = paths.filter((path, index) => paths.indexOf(path) !== index);
  const contentCount = CANDIDATE_HTML_ROUTES.filter(({ kind }) => ['article', 'calculator', 'crisis', 'meeting'].includes(kind)).length - 3;
  const categoryCount = CANDIDATE_HTML_ROUTES.filter(({ kind }) => kind === 'category').length;

  audit.observe('Published document routes', contentCount, String(EXPECTED_PUBLISHED_DOCUMENT_COUNT));
  audit.observe('Category routes', categoryCount, String(EXPECTED_CATEGORY_COUNT));
  audit.observe('All HTML routes', paths.length, String(EXPECTED_HTML_ROUTE_COUNT));
  await audit.attachJson('candidate-route-inventory', CANDIDATE_HTML_ROUTES);

  expect(duplicatePaths, 'A route must appear exactly once').toEqual([]);
  expect(contentCount).toBe(EXPECTED_PUBLISHED_DOCUMENT_COUNT);
  expect(categoryCount).toBe(EXPECTED_CATEGORY_COUNT);
  expect(paths).toHaveLength(EXPECTED_HTML_ROUTE_COUNT);
  expect(paths.every((path) => path.startsWith('/') && (path === '/' || !path.endsWith('/')))).toBe(true);
  await audit.goto('/sitemap');
  await audit.checkpoint('candidate-route-inventory-sitemap');
});

structuredTest('[ENV-003] every candidate destination has an explicit production mapping or approved addition', structuredEvidence('Retain the paired production-to-candidate response and disposition ledger without unrelated media.'), async ({ request, audit }, testInfo) => {
  test.skip(testInfo.project.name !== 'candidate-desktop-chromium', 'One candidate project validates the paired migration ledger.');
  const ledger = [];
  for (const route of CANDIDATE_HTML_ROUTES) {
    const productionPath = resolveEnvironmentPath('production', route.path);
    const candidateResponse = await inspectHtmlDestination(request, audit, new URL(route.path, ENVIRONMENTS.candidate.baseURL).href);
    const productionResponse = productionPath === null
      ? null
      : await inspectHtmlDestination(request, audit, new URL(productionPath, ENVIRONMENTS.production.baseURL).href);
    ledger.push({
      candidatePath: route.path,
      productionPath,
      candidate: candidateResponse,
      production: productionResponse,
      disposition: productionPath === null ? 'approved-candidate-addition' : 'mapped',
    });
  }
  const brokenCandidate = ledger.filter(({ candidate }) => !candidate.valid);
  const brokenProductionMapping = ledger.filter(({ productionPath, production }) => productionPath !== null && !production?.valid);
  audit.observe('Mapped production routes', ledger.filter(({ disposition }) => disposition === 'mapped').length);
  audit.observe('Approved candidate additions', ledger.filter(({ disposition }) => disposition === 'approved-candidate-addition').length);
  await audit.attachJson('network-production-candidate-mapping-ledger', { ledger, brokenCandidate, brokenProductionMapping });
  expect(brokenCandidate, 'Every mapped candidate destination must exist').toEqual([]);
  expect(brokenProductionMapping, 'Every declared production counterpart must still be inspectable').toEqual([]);
});

structuredTest('[ENV-004] legacy aliases redirect once to a successful canonical page', structuredEvidence('Retain every redirect status, Location header, and final destination response without unrelated media.'), async ({ request, audit }, testInfo) => {
  const metadata = projectMetadata(testInfo.project.metadata);
  test.skip(metadata.environment !== 'candidate' || !metadata.fullSweep, 'Redirect migration contracts run once against the candidate.');

  const redirects = [
    ['/other-tools', '/medications-supplements/'],
    ['/other-tools/helper-meds-info', '/medications-supplements/helper-meds/'],
    ['/start-here/withdrawal-help', '/start-here/7-oh-withdrawal-help/'],
    ['/post-acute/what-is-paws', '/post-acute/paws-post-acute-withdrawal/'],
    ['/mat-suboxone/suboxone-cows', '/mat-suboxone/sows-cows-induction-guide/'],
    ['/about/for-fly', '/about/acknowledgments/'],
  ] as const;
  const results: Array<{ source: string; status: number; location: string | null; destinationStatus: number }> = [];

  for (const [source, destination] of redirects) {
    const first = await loggedGet(request, audit, source, { maxRedirects: 0 });
    const location = first.headers().location ?? null;
    expect([301, 308], `${source} should be permanent`).toContain(first.status());
    expect(location, `${source} should include a Location header`).not.toBeNull();
    expect(new URL(location ?? '/', ENVIRONMENTS.candidate.baseURL).pathname, `${source} should point directly to its approved destination`).toBe(destination);

    const final = await loggedGet(request, audit, destination, { maxRedirects: 0 });
    expect(final.status(), `${destination} should not add another redirect`).toBe(200);
    expect(final.headers()['content-type']).toContain('text/html');
    results.push({ source, status: first.status(), location, destinationStatus: final.status() });
  }

  audit.observe('Legacy redirects checked', results.length);
  await audit.attachJson('redirect-chain-evidence', results);
});

staticTest('[ENV-005] environment indexing policy and canonical intent are explicit', staticEvidence('Capture the rendered page together with its robots, canonical, and social URL metadata.'), async ({ page, audit }, testInfo) => {
  const metadata = projectMetadata(testInfo.project.metadata);
  await audit.goto('/start-here/welcome');
  const inspection = await audit.inspectPage();
  const canonical = inspection.canonical ? new URL(inspection.canonical) : null;
  const robots = (inspection.robots ?? '').toLowerCase();

  audit.observe('Robots policy', inspection.robots, metadata.environment === 'candidate' ? 'Contains noindex' : 'Allows index');
  audit.observe('Canonical URL', inspection.canonical);
  await audit.attachJson('indexing-evidence', { environment: metadata.environment, robots, canonical });

  expect(canonical, 'A canonical URL is required').not.toBeNull();
  expect(canonical?.origin, 'Canonical URLs announce the eventual public origin').toBe(ENVIRONMENTS.production.baseURL);
  expect(canonical?.pathname.replace(/\/$/, ''), 'Canonical path identifies this content').toBe('/start-here/welcome');
  if (metadata.environment === 'candidate') {
    expect(robots, 'The beta must not compete with production in search results').toContain('noindex');
  } else {
    expect(robots).toContain('index');
    expect(robots).not.toContain('noindex');
  }
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', inspection.canonical ?? '');
});

staticTest('[ENV-006] document security headers and hashed-asset caching are deployed', staticEvidence('Capture the rendered document alongside its security-header and immutable-asset response evidence.'), async ({ page, request, audit }) => {
  const documentResponse = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(documentResponse).not.toBeNull();
  const headers = documentResponse?.headers() ?? {};
  const requiredHeaders = {
    'strict-transport-security': /max-age=/i,
    'x-content-type-options': /^nosniff$/i,
    'x-frame-options': /^(deny|sameorigin)$/i,
    'referrer-policy': /strict-origin|no-referrer/i,
    'permissions-policy': /.+/,
  } as const;
  const headerEvidence: Record<string, string | null> = {};

  for (const [name, expected] of Object.entries(requiredHeaders)) {
    const value = headers[name] ?? null;
    headerEvidence[name] = value;
    expect(value, `${name} must be present`).toMatch(expected);
  }

  const hashedAsset = await page.locator('script[src*="/_astro/"], link[href*="/_astro/"]').first().evaluate((node) =>
    node instanceof HTMLLinkElement ? node.href : (node as HTMLScriptElement).src,
  );
  const assetResponse = await loggedGet(request, audit, hashedAsset);
  const cacheControl = assetResponse.headers()['cache-control'] ?? '';
  expect(assetResponse.status()).toBe(200);
  expect(cacheControl).toContain('max-age=31536000');
  expect(cacheControl).toContain('immutable');

  audit.observe('Hashed asset inspected', hashedAsset);
  audit.observe('Hashed asset cache-control', cacheControl);
  await audit.attachJson('header-evidence', { document: headerEvidence, hashedAsset, cacheControl });
});

staticTest('[ENV-007] unknown routes return a useful not-found document', staticEvidence('Capture the complete not-found state, recovery search, and usable destination links.'), async ({ page, audit }) => {
  const missingPath = `/__audit_missing_${Date.now()}__`;
  const response = await page.goto(missingPath, { waitUntil: 'domcontentloaded' });

  expect(response?.status(), 'A missing URL must not masquerade as a successful page').toBe(404);
  await expect(page.locator('h1')).toContainText(/not|isn.t here/i);
  await expect(page.locator('main')).toContainText(/search/i);
  expect(await page.locator('main a[href]').count(), 'The error page should provide recovery destinations').toBeGreaterThanOrEqual(2);
  const searchInputs = await page.locator('main input[type="search"], main [role="searchbox"]').count();
  expect(searchInputs, 'The error page should offer site search').toBeGreaterThanOrEqual(1);

  audit.observe('Not-found status', response?.status() ?? null, '404');
  await audit.checkpoint('useful-not-found-page');
});

structuredTest('[ENV-008] static data endpoints expose usable, versioned contracts', structuredEvidence('Retain endpoint status, content type, schema, record totals, and asset response evidence without unrelated media.'), async ({ request, audit }) => {
  const endpointEvidence: Record<string, unknown> = {};

  for (const endpoint of DATA_ENDPOINTS) {
    const response = await loggedGet(request, audit, endpoint.path);
    expect(response.status(), `${endpoint.name} must load`).toBe(200);
    expect(response.headers()['content-type'], `${endpoint.name} must be JSON`).toContain('application/json');
    const payload = await response.json() as Record<string, unknown>;
    endpointEvidence[endpoint.path] = payload;

    if (endpoint.path === '/search-index.json') {
      expect(payload.version, 'Search index schema is versioned').toBe(1);
      expect(payload.pageCount, 'Search indexes enough destinations to be useful').toBeGreaterThanOrEqual(80);
      expect(payload.recordCount).toBe(payload.pageCount);
      expect(payload.index).toBeTruthy();
    } else {
      expect(Number.isNaN(Date.parse(String(payload.generatedAt))), 'Meeting generation timestamp is parseable').toBe(false);
      expect(Array.isArray(payload.na), 'NA meetings are an array').toBe(true);
      expect(Array.isArray(payload.smart), 'SMART meetings are an array').toBe(true);
      expect((payload.na as unknown[]).length, 'The meeting index contains usable NA records').toBeGreaterThan(0);
      expect((payload.smart as unknown[]).length, 'The meeting index contains usable SMART records').toBeGreaterThan(0);
    }
  }

  const manifest = await loggedGet(request, audit, '/favicons/stone/site.webmanifest');
  const socialCard = await loggedGet(request, audit, '/og-image.png');
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toMatch(/manifest\+json|application\/json/);
  expect(socialCard.status()).toBe(200);
  expect(socialCard.headers()['content-type']).toContain('image/png');
  expect((await socialCard.body()).byteLength, 'The social card should not be an empty placeholder').toBeGreaterThan(10_000);

  audit.observe('Data endpoints checked', DATA_ENDPOINTS.length);
  await audit.attachJson('endpoint-contract-evidence', endpointEvidence);
});

staticTest('[SEO-001] representative metadata is complete, consistent, and shareable', staticEvidence('Capture representative rendered pages and their title, canonical, Open Graph, and Twitter metadata.'), async ({ page, audit }, testInfo) => {
  const metadata = projectMetadata(testInfo.project.metadata);
  const routes = ['/', '/start-here/welcome', '/resources/7-oh-taper-calculator', '/virtual-na-meetings-now'];
  const evidence: unknown[] = [];

  for (const candidatePath of routes) {
    const mappedPath = audit.environmentPath(candidatePath);
    if (mappedPath === null) continue;
    await audit.goto(candidatePath);
    const values = await page.evaluate(() => ({
      title: document.title,
      description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '',
      canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '',
      ogTitle: document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? '',
      ogDescription: document.querySelector<HTMLMetaElement>('meta[property="og:description"]')?.content ?? '',
      ogUrl: document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content ?? '',
      ogImage: document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ?? '',
      twitterCard: document.querySelector<HTMLMetaElement>('meta[name="twitter:card"]')?.content ?? '',
    }));
    expect(values.title.length).toBeGreaterThan(8);
    expect(values.description.length).toBeGreaterThan(35);
    expect(values.canonical).toMatch(/^https:\/\//);
    const canonical = new URL(values.canonical);
    expect(values.ogTitle).toBe(values.title);
    expect(values.ogDescription).toBe(values.description);
    expect(values.ogUrl).toBe(values.canonical);
    expect(values.ogImage).toMatch(/^https:\/\/.+\.(png|jpe?g|webp)$/i);
    expect(values.twitterCard).toBe('summary_large_image');
    expect(canonical.origin).toBe(ENVIRONMENTS.production.baseURL);
    expect(canonical.pathname.replace(/\/$/, '') || '/').toBe(mappedPath.replace(/\/$/, '') || '/');
    evidence.push({ candidatePath, mappedPath, environment: metadata.environment, ...values });
  }

  audit.observe('Metadata routes inspected', evidence.length, String(routes.length));
  await audit.attachJson('metadata-evidence', evidence);
});

structuredTest('[SEO-002] XML sitemap contains every canonical candidate HTML route', structuredEvidence('Retain parsed sitemap locations, missing entries, duplicates, and response evidence without unrelated media.'), async ({ request, audit }, testInfo) => {
  const metadata = projectMetadata(testInfo.project.metadata);
  test.skip(metadata.environment !== 'candidate' || !metadata.fullSweep, 'The canonical sitemap contract runs once against the candidate.');

  const index = await loggedGet(request, audit, '/sitemap-index.xml');
  expect(index.status()).toBe(200);
  expect(index.headers()['content-type']).toMatch(/xml/);
  const indexText = await index.text();
  const childLocations = [...indexText.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).filter((value): value is string => Boolean(value));
  expect(childLocations.length, 'The sitemap index should reference at least one sitemap').toBeGreaterThan(0);

  const locations: string[] = [];
  for (const location of childLocations) {
    const childPath = new URL(location).pathname;
    const child = await loggedGet(request, audit, childPath);
    expect(child.status(), `${childPath} must load`).toBe(200);
    locations.push(...[...(await child.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).filter((value): value is string => Boolean(value)));
  }

  const sitemapPaths = new Set(locations.map((location) => new URL(location).pathname.replace(/\/$/, '') || '/'));
  const expectedPaths = CANDIDATE_PATHS.map((path) => path.replace(/\/$/, '') || '/');
  const missing = expectedPaths.filter((path) => !sitemapPaths.has(path));
  const duplicateLocations = locations.filter((location, indexInList) => locations.indexOf(location) !== indexInList);

  audit.observe('Sitemap URLs', sitemapPaths.size, String(CANDIDATE_PATHS.length));
  await audit.attachJson('sitemap-evidence', { childLocations, sitemapPaths: [...sitemapPaths].sort(), missing, duplicateLocations });
  expect(missing, 'Every candidate HTML route must be discoverable in the XML sitemap').toEqual([]);
  expect(duplicateLocations, 'Canonical sitemap entries must not be duplicated').toEqual([]);
  expect([...sitemapPaths].some((path) => path.includes('/other-tools')), 'Legacy aliases do not belong in the sitemap').toBe(false);
});
