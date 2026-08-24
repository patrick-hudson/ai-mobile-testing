import {
  APPROVED_CANDIDATE_ADDITION_PATHS,
  ENVIRONMENTS,
  LEGACY_ROUTE_REDIRECTS,
  productionRouteDisposition,
  projectMetadata,
} from '../audit/environments.js';
import {
  CANDIDATE_HTML_ROUTES,
  CANDIDATE_PATHS,
  DATA_ENDPOINTS,
  EXPECTED_CATEGORY_COUNT,
  EXPECTED_HTML_ROUTE_COUNT,
  EXPECTED_PUBLISHED_DOCUMENT_COUNT,
} from '../audit/routes.js';
import {
  expect,
  interactionEvidence,
  interactionTest,
  staticEvidence,
  staticTest,
  structuredEvidence,
  structuredTest,
  test,
} from '../fixtures/test.js';
import {
  extractSitemapLocations,
  inspectHtmlDestination,
  loggedGet,
  mapWithConcurrency,
  type HtmlDestinationEvidence,
} from './helpers.js';

const ROUTE_REQUEST_TIMEOUT_MS = 10_000;

function normalizeRoutePath(pathname: string): string {
  return pathname === '/' ? pathname : pathname.replace(/\/+$/, '');
}

async function safeInspectHtmlDestination(
  request: Parameters<typeof inspectHtmlDestination>[0],
  audit: Parameters<typeof inspectHtmlDestination>[1],
  url: string,
): Promise<HtmlDestinationEvidence> {
  try {
    return await inspectHtmlDestination(request, audit, url, { timeoutMs: ROUTE_REQUEST_TIMEOUT_MS });
  } catch (error) {
    return {
      requestedUrl: url,
      initialStatus: 0,
      redirectLocation: null,
      finalUrl: url,
      finalStatus: null,
      contentType: null,
      valid: false,
      issue: `Request did not complete within the route deadline: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function discoverProductionSitemapPaths(
  request: Parameters<typeof loggedGet>[0],
  audit: Parameters<typeof loggedGet>[1],
): Promise<string[]> {
  const indexUrl = new URL('/sitemap-index.xml', ENVIRONMENTS.production.baseURL).href;
  const index = await loggedGet(request, audit, indexUrl, { timeout: ROUTE_REQUEST_TIMEOUT_MS });
  expect(index.status(), 'Production sitemap index must load').toBe(200);
  const indexText = await index.text();
  const indexLocations = extractSitemapLocations(indexText);
  expect(indexLocations.length, 'Production sitemap index must enumerate at least one location').toBeGreaterThan(0);

  const sitemapDocuments = /<sitemapindex[\s>]/i.test(indexText)
    ? await mapWithConcurrency(indexLocations, 4, async (location) => {
        const response = await loggedGet(request, audit, location, { timeout: ROUTE_REQUEST_TIMEOUT_MS });
        expect(response.status(), `Production child sitemap ${location} must load`).toBe(200);
        return response.text();
      })
    : [indexText];

  const expectedOrigin = new URL(ENVIRONMENTS.production.baseURL).origin;
  const discovered = sitemapDocuments
    .flatMap(extractSitemapLocations)
    .map((location) => new URL(location, expectedOrigin))
    .filter((location) => location.origin === expectedOrigin)
    .map((location) => normalizeRoutePath(location.pathname));
  return [...new Set(discovered)].sort();
}

staticTest('[ENV-001] configured origin serves a secure, meaningful HTML document', staticEvidence('Capture the secure homepage response, meaningful content, and final rendered state.', 'all-projects'), async ({ page, audit }) => {
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

staticTest('[ENV-002] static candidate route inventory is complete and internally consistent', staticEvidence('Capture the route inventory totals and the rendered sitemap that represents the published destinations.', 'full-sweep-projects'), async ({ audit }, testInfo) => {
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

structuredTest('[ENV-003] every production sitemap route has a reviewed candidate disposition', structuredEvidence('Retain the production-first route inventory, bounded response probes, migration dispositions, and candidate-only reconciliation.', 'candidate-desktop-chromium'), async ({ request, audit }, testInfo) => {
  test.skip(testInfo.project.name !== 'candidate-desktop-chromium', 'One candidate project validates the paired migration ledger.');
  test.setTimeout(150_000);
  const productionPaths = await discoverProductionSitemapPaths(request, audit);
  const candidatePaths = new Set(CANDIDATE_PATHS);
  const ledger = await mapWithConcurrency(productionPaths, 8, async (productionPath) => {
    const disposition = productionRouteDisposition(productionPath);
    const production = await safeInspectHtmlDestination(
      request,
      audit,
      new URL(productionPath, ENVIRONMENTS.production.baseURL).href,
    );
    if (disposition.disposition === 'approved-removal') {
      return { productionPath, disposition, production, candidate: null, issue: production.valid ? null : production.issue };
    }
    if (disposition.disposition !== 'mapped' || !candidatePaths.has(disposition.candidatePath)) {
      return {
        productionPath,
        disposition: { ...disposition, disposition: 'unreviewed' as const },
        production,
        candidate: null,
        issue: `Production route ${productionPath} has no reviewed candidate destination or removal.`,
      };
    }
    const candidate = await safeInspectHtmlDestination(
      request,
      audit,
      new URL(disposition.candidatePath, ENVIRONMENTS.candidate.baseURL).href,
    );
    return {
      productionPath,
      disposition,
      production,
      candidate,
      issue: !production.valid ? production.issue : !candidate.valid ? candidate.issue : null,
    };
  });

  const mappedCandidatePaths = new Set(ledger.flatMap(({ disposition }) =>
    disposition.disposition === 'mapped' ? [disposition.candidatePath] : []));
  const explicitlyReviewedLegacyDestinations = new Set<string>(LEGACY_ROUTE_REDIRECTS.map(({ candidatePath }) => candidatePath));
  const approvedAdditions = new Set<string>(APPROVED_CANDIDATE_ADDITION_PATHS);
  const unreconciledCandidate = CANDIDATE_PATHS.filter((path) =>
    !mappedCandidatePaths.has(path)
    && !explicitlyReviewedLegacyDestinations.has(path)
    && !approvedAdditions.has(path));
  const invalidApprovedAdditions = [...approvedAdditions].filter((path) => !candidatePaths.has(path));
  const additionProbes = await mapWithConcurrency(APPROVED_CANDIDATE_ADDITION_PATHS, 4, async (candidatePath) => ({
    candidatePath,
    evidence: await safeInspectHtmlDestination(
      request,
      audit,
      new URL(candidatePath, ENVIRONMENTS.candidate.baseURL).href,
    ),
  }));
  const additionProblems = additionProbes.filter(({ evidence }) => !evidence.valid);
  const problems = ledger.filter(({ issue }) => issue !== null);

  audit.observe('Production sitemap routes', productionPaths.length);
  audit.observe('Mapped production routes', ledger.filter(({ disposition }) => disposition.disposition === 'mapped').length);
  audit.observe('Approved production removals', ledger.filter(({ disposition }) => disposition.disposition === 'approved-removal').length);
  audit.observe('Approved candidate-only additions', APPROVED_CANDIDATE_ADDITION_PATHS.length);
  await audit.attachJson('network-production-candidate-mapping-ledger', {
    summary: {
      productionRoutes: productionPaths.length,
      mappedRoutes: ledger.filter(({ disposition }) => disposition.disposition === 'mapped').length,
      approvedRemovals: ledger.filter(({ disposition }) => disposition.disposition === 'approved-removal').length,
      problems: problems.length,
    },
    productionPaths,
    explicitlyReviewedLegacyDestinations: [...explicitlyReviewedLegacyDestinations].sort(),
    approvedCandidateAdditions: APPROVED_CANDIDATE_ADDITION_PATHS,
    unreconciledCandidate,
    invalidApprovedAdditions,
    additionProbes,
    diagnostics: [...problems, ...additionProblems],
    dispositions: ledger.map(({ productionPath, disposition, production, candidate, issue }) => ({
      productionPath,
      disposition,
      productionStatus: production.finalStatus ?? production.initialStatus,
      candidateStatus: candidate?.finalStatus ?? candidate?.initialStatus ?? null,
      issue,
    })),
  });
  expect.soft(problems, 'Every production route must have a reachable reviewed candidate disposition').toEqual([]);
  expect.soft(unreconciledCandidate, 'Every candidate route must map from production or be an explicit reviewed addition').toEqual([]);
  expect.soft(invalidApprovedAdditions, 'Approved additions must remain in the reviewed candidate inventory').toEqual([]);
  expect.soft(additionProblems, 'Every explicit candidate-only addition must be reachable').toEqual([]);
  audit.coverEnvironments('candidate', 'production');
});

structuredTest('[ENV-004] legacy aliases redirect once to a successful canonical page', structuredEvidence('Retain every redirect status, Location header, and final destination response without unrelated media.', 'candidate-chromium-projects'), async ({ request, audit }, testInfo) => {
  const metadata = projectMetadata(testInfo.project.metadata);
  test.skip(metadata.environment !== 'candidate' || !metadata.fullSweep, 'Redirect migration contracts run once against the candidate.');

  const results: Array<{ source: string; status: number; location: string; resolvedLocation: string; destinationStatus: number }> = [];

  for (const { sourcePath, expectedLocationPath } of LEGACY_ROUTE_REDIRECTS) {
    const sourceUrl = new URL(sourcePath, ENVIRONMENTS.candidate.baseURL);
    const first = await loggedGet(request, audit, sourceUrl.href, { maxRedirects: 0, timeout: ROUTE_REQUEST_TIMEOUT_MS });
    const location = first.headers().location ?? null;
    expect([301, 308], `${sourcePath} should be permanent`).toContain(first.status());
    expect(location, `${sourcePath} should include a Location header`).not.toBeNull();
    const resolvedLocation = new URL(location ?? '/', sourceUrl);
    const expectedLocation = new URL(expectedLocationPath, ENVIRONMENTS.candidate.baseURL);
    expect(resolvedLocation.href, `${sourcePath} must redirect to the exact approved origin, path, query, and fragment`).toBe(expectedLocation.href);

    const final = await loggedGet(request, audit, resolvedLocation.href, { maxRedirects: 0, timeout: ROUTE_REQUEST_TIMEOUT_MS });
    expect(final.status(), `${resolvedLocation.href} should not add another redirect`).toBe(200);
    expect(final.headers()['content-type']).toContain('text/html');
    results.push({ source: sourceUrl.href, status: first.status(), location: location!, resolvedLocation: resolvedLocation.href, destinationStatus: final.status() });
  }

  expect(LEGACY_ROUTE_REDIRECTS, 'The reviewed migration ledger must retain all seven legacy aliases').toHaveLength(7);
  expect(results.map(({ source }) => source), 'Every declared legacy alias must produce one redirect result').toEqual(
    LEGACY_ROUTE_REDIRECTS.map(({ sourcePath }) => new URL(sourcePath, ENVIRONMENTS.candidate.baseURL).href),
  );
  audit.observe('Legacy redirects checked', results.length);
  await audit.attachJson('redirect-chain-evidence', results);
});

staticTest('[ENV-005] environment indexing policy and canonical intent are explicit', staticEvidence('Capture the rendered page together with its robots, canonical, and social URL metadata.', 'all-projects'), async ({ page, audit }, testInfo) => {
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
  await audit.checkpoint('indexing-policy-page');
});

staticTest('[ENV-006] document security headers and hashed-asset caching are deployed', staticEvidence('Capture the rendered document alongside its security-header and immutable-asset response evidence.', 'all-projects'), async ({ page, request, audit }) => {
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
  await audit.checkpoint('secure-cached-document');
});

interactionTest('[ENV-007] unknown routes provide working search and recovery navigation', interactionEvidence('Open a deterministic missing URL, enter a useful query in the named combobox, and activate the complete site-map recovery link.', 'all-projects'), async ({ page, audit }) => {
  const missingPath = '/__visual-audit-not-found__';
  audit.expectResponseStatus(missingPath, 404);
  const response = await audit.step('Open an unknown URL', 'The server returns HTTP 404 with the custom recovery document.', async () =>
    page.goto(missingPath, { waitUntil: 'domcontentloaded' }));

  expect(response?.status(), 'A missing URL must not masquerade as a successful page').toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('That page isn’t here.');
  const recovery = page.getByRole('navigation', { name: 'Common destinations' });
  const recoveryDestinations = await recovery.locator('a[href]').evaluateAll((anchors) =>
    anchors.map((anchor) => (anchor as HTMLAnchorElement).getAttribute('href')));
  expect(recoveryDestinations.sort()).toEqual([
    '/',
    '/resources/meeting-schedules',
    '/sitemap',
    '/start-here/7-oh-withdrawal-help',
  ].sort());

  const search = page.getByRole('combobox', { name: 'Search all pages' });
  await audit.step('Search from the not-found page', 'A known medical query returns a labeled, usable destination.', async () => {
    await search.fill('clonidine');
    const result = page.getByRole('option').filter({ hasText: /Helper Medications/i }).first();
    await expect(result).toBeVisible();
    const expectedHelperPath = audit.environmentPath('/medications-supplements/helper-meds');
    expect(expectedHelperPath, 'Every audited environment must map the helper-medications recovery route').not.toBeNull();
    expect(await result.getAttribute('href'), 'The result must target the exact environment-specific clonidine section').toBe(`${expectedHelperPath}#clonidine`);
  });

  await audit.step('Use a recovery destination', 'Complete site map opens as a successful document.', async () => {
    await recovery.getByRole('link', { name: 'Complete site map' }).click();
    await expect(page).toHaveURL(/\/sitemap\/?$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Site map/i);
  });
  audit.observe('Not-found status', response?.status() ?? null, '404');
  await audit.assertRuntimeHealthy();
});

structuredTest('[ENV-008] static data endpoints expose usable, versioned contracts', structuredEvidence('Retain endpoint status, content type, schema, record totals, and asset response evidence without unrelated media.', 'all-projects'), async ({ request, audit }) => {
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

staticTest('[SEO-001] representative metadata is complete, consistent, and shareable', staticEvidence('Capture representative rendered pages and their title, canonical, Open Graph, and Twitter metadata.', 'all-projects'), async ({ page, audit }, testInfo) => {
  const metadata = projectMetadata(testInfo.project.metadata);
  const routes = ['/', '/start-here/welcome', '/resources/7-oh-taper-calculator', '/virtual-na-meetings-now'] as const;
  const evidence: Array<{
    candidatePath: string;
    mappedPath: string;
    environment: string;
    title: string;
    description: string;
    canonical: string;
    ogTitle: string;
    ogDescription: string;
    ogUrl: string;
    ogImage: string;
    twitterCard: string;
  }> = [];

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

  expect(routes, 'The metadata contract must retain all four representative routes').toHaveLength(4);
  const expectedRoutes = routes.filter((candidatePath) => audit.environmentPath(candidatePath) !== null);
  expect(expectedRoutes, 'Every representative metadata route must remain applicable in both audited environments').toHaveLength(4);
  expect(evidence.map(({ candidatePath }) => candidatePath), 'Every environment-applicable metadata route must produce one inspected record').toEqual(expectedRoutes);
  audit.observe('Metadata routes inspected', evidence.length, String(routes.length));
  await audit.attachJson('metadata-evidence', evidence);
  await audit.checkpoint('representative-metadata-page');
});

structuredTest('[SEO-002] XML sitemap contains every canonical candidate HTML route', structuredEvidence('Retain parsed sitemap locations, missing entries, duplicates, and response evidence without unrelated media.', 'candidate-chromium-projects'), async ({ request, audit }, testInfo) => {
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
