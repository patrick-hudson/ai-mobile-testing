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
  extractHtmlTagAttributes,
  inspectHtmlDestination,
  loggedGet,
  mapWithConcurrency,
  type HtmlDestinationEvidence,
} from './helpers.js';

const ROUTE_REQUEST_TIMEOUT_MS = 10_000;

function normalizeRoutePath(pathname: string): string {
  return pathname === '/' ? pathname : pathname.replace(/\/+$/, '');
}

function extractCanonicalHrefs(html: string): string[] {
  return (html.match(/<link\b[^>]*>/gi) ?? []).flatMap((tag) => {
    const rel = extractHtmlTagAttributes(tag, 'link', 'rel')[0]?.toLowerCase().split(/\s+/) ?? [];
    const href = extractHtmlTagAttributes(tag, 'link', 'href')[0];
    return rel.includes('canonical') && href ? [href] : [];
  });
}

function extractCssReferences(css: string, sourceUrl: string): string[] {
  return [...css.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s]+))\s*\)/gi)].flatMap((match) => {
    const raw = match[1] ?? match[2] ?? match[3] ?? '';
    if (!raw || raw.startsWith('data:') || raw.startsWith('#')) return [];
    try {
      return [new URL(raw, sourceUrl).href];
    } catch {
      return [];
    }
  });
}

function extractFirstPartyAssetReferences(html: string, documentUrl: string): string[] {
  const raw: string[] = [];
  for (const [tag, attribute] of [['script', 'src'], ['img', 'src'], ['source', 'src'], ['video', 'src'], ['video', 'poster'], ['audio', 'src']] as const) {
    raw.push(...extractHtmlTagAttributes(html, tag, attribute));
  }
  for (const tag of ['img', 'source'] as const) {
    for (const srcset of extractHtmlTagAttributes(html, tag, 'srcset')) {
      raw.push(...srcset.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '').filter(Boolean));
    }
  }
  for (const linkTag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = extractHtmlTagAttributes(linkTag, 'link', 'rel')[0]?.toLowerCase().split(/\s+/) ?? [];
    if (!rel.some((token) => ['stylesheet', 'icon', 'manifest', 'preload', 'modulepreload'].includes(token))) continue;
    raw.push(...extractHtmlTagAttributes(linkTag, 'link', 'href'));
  }
  for (const style of extractHtmlTagAttributes(html, '[a-z][a-z0-9:-]*', 'style')) raw.push(...extractCssReferences(style, documentUrl));
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) raw.push(...extractCssReferences(match[1] ?? '', documentUrl));

  const expectedOrigin = new URL(documentUrl).origin;
  return [...new Set(raw.flatMap((value) => {
    if (!value || value.startsWith('data:') || value.startsWith('blob:') || value.startsWith('#')) return [];
    try {
      const resolved = new URL(value, documentUrl);
      return resolved.origin === expectedOrigin ? [resolved.href] : [];
    } catch {
      return [];
    }
  }))];
}

function expectedAssetContentType(assetUrl: string): RegExp | null {
  const pathname = new URL(assetUrl).pathname.toLowerCase();
  if (pathname.endsWith('.css')) return /^text\/css\b/i;
  if (/\.(?:m?js)$/.test(pathname)) return /javascript/i;
  if (/\.(?:png|jpe?g|gif|webp|avif|svg|ico)$/.test(pathname)) return /^image\//i;
  if (/\.(?:woff2?|ttf|otf|eot)$/.test(pathname)) return /^(?:font\/|application\/(?:font|x-font|octet-stream))/i;
  if (/\.(?:json|webmanifest)$/.test(pathname)) return /(?:application|text)\/(?:[^;]+\+)?json|application\/manifest\+json/i;
  if (/\.(?:mp4|webm|ogv)$/.test(pathname)) return /^video\//i;
  if (/\.(?:mp3|wav|ogg)$/.test(pathname)) return /^audio\//i;
  return null;
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

staticTest('[ENV-002] every declared candidate route serves HTML with its expected canonical', staticEvidence('Capture the complete route probe ledger and the sitemap after every declared route serves HTML with its exact public canonical.', 'candidate-desktop-chromium'), async ({ request, audit }) => {
  test.setTimeout(180_000);

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

  const routeEvidence = await mapWithConcurrency(CANDIDATE_HTML_ROUTES, 8, async (route) => {
    const requestedUrl = new URL(route.path, ENVIRONMENTS.candidate.baseURL).href;
    const response = await loggedGet(request, audit, requestedUrl, { timeout: ROUTE_REQUEST_TIMEOUT_MS });
    const contentType = response.headers()['content-type'] ?? '';
    const html = await response.text();
    const canonicalHrefs = extractCanonicalHrefs(html);
    expect(response.status(), `${route.path} must return HTTP 200`).toBe(200);
    expect(contentType, `${route.path} must serve HTML`).toContain('text/html');
    expect(canonicalHrefs, `${route.path} must expose exactly one canonical link`).toHaveLength(1);
    const canonical = new URL(canonicalHrefs[0]!, requestedUrl);
    expect(canonical.origin, `${route.path} canonical must announce the public origin`).toBe(ENVIRONMENTS.production.baseURL);
    expect(normalizeRoutePath(canonical.pathname), `${route.path} canonical must retain the reviewed route`).toBe(route.path);
    expect(canonical.search, `${route.path} canonical must not preserve a query`).toBe('');
    expect(canonical.hash, `${route.path} canonical must not preserve a fragment`).toBe('');
    return {
      path: route.path,
      kind: route.kind,
      requestedUrl,
      finalUrl: response.url(),
      status: response.status(),
      contentType,
      canonical: canonical.href,
    };
  });
  expect(routeEvidence, 'Every declared route must produce one successful canonical probe').toHaveLength(CANDIDATE_HTML_ROUTES.length);
  await audit.attachJson('candidate-route-http-canonical-ledger', routeEvidence);
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
    await search.clear();
    await expect(search).toHaveValue('');
    await expect(page.getByRole('option'), 'Clearing recovery search must remove the results layer before another destination is activated')
      .toHaveCount(0);
    const recoveryLink = page
      .getByRole('navigation', { name: 'Common destinations' })
      .getByRole('link', { name: 'Complete site map' });
    await recoveryLink.scrollIntoViewIfNeeded();
    await expect(recoveryLink).toBeVisible();
    await recoveryLink.click();
    await expect(page).toHaveURL(/\/sitemap\/?$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Site map/i);
  });
  audit.observe('Not-found status', response?.status() ?? null, '404');
  await audit.assertRuntimeHealthy();
});

structuredTest('[ENV-008] all referenced first-party assets and data endpoints expose usable contracts', structuredEvidence('Retain every route-discovered first-party asset plus endpoint status, content type, schema, and byte evidence without unrelated media.', 'candidate-desktop-chromium'), async ({ request, audit }) => {
  test.setTimeout(180_000);
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

  const routeDocuments = await mapWithConcurrency(CANDIDATE_HTML_ROUTES, 8, async (route) => {
    const url = new URL(route.path, ENVIRONMENTS.candidate.baseURL).href;
    const response = await loggedGet(request, audit, url, { timeout: ROUTE_REQUEST_TIMEOUT_MS });
    const contentType = response.headers()['content-type'] ?? '';
    const html = await response.text();
    expect(response.status(), `${route.path} must load before its assets can be enumerated`).toBe(200);
    expect(contentType, `${route.path} must serve an HTML asset graph`).toContain('text/html');
    return { path: route.path, url: response.url(), assets: extractFirstPartyAssetReferences(html, response.url()) };
  });
  const htmlAssets = [...new Set(routeDocuments.flatMap(({ assets }) => assets))];
  expect(htmlAssets.length, 'The route crawl must discover a non-trivial first-party asset graph').toBeGreaterThan(10);

  const firstPass = await mapWithConcurrency(htmlAssets, 8, async (assetUrl) => {
    const response = await loggedGet(request, audit, assetUrl, { timeout: ROUTE_REQUEST_TIMEOUT_MS });
    const contentType = response.headers()['content-type'] ?? '';
    const body = await response.body();
    const expectedContentType = expectedAssetContentType(response.url());
    expect(response.status(), `${assetUrl} must load`).toBe(200);
    expect(body.byteLength, `${assetUrl} must not be empty`).toBeGreaterThan(0);
    if (expectedContentType) expect(contentType, `${assetUrl} must use the content type implied by its extension`).toMatch(expectedContentType);
    const cssReferences = contentType.includes('text/css')
      ? extractCssReferences(body.toString('utf8'), response.url()).filter((url) => new URL(url).origin === new URL(response.url()).origin)
      : [];
    return { assetUrl, finalUrl: response.url(), status: response.status(), contentType, bytes: body.byteLength, cssReferences };
  });
  const nestedCssAssets = [...new Set(firstPass.flatMap(({ cssReferences }) => cssReferences).filter((url) => !htmlAssets.includes(url)))];
  const secondPass = await mapWithConcurrency(nestedCssAssets, 8, async (assetUrl) => {
    const response = await loggedGet(request, audit, assetUrl, { timeout: ROUTE_REQUEST_TIMEOUT_MS });
    const contentType = response.headers()['content-type'] ?? '';
    const body = await response.body();
    const expectedContentType = expectedAssetContentType(response.url());
    expect(response.status(), `${assetUrl} referenced by CSS must load`).toBe(200);
    expect(body.byteLength, `${assetUrl} referenced by CSS must not be empty`).toBeGreaterThan(0);
    if (expectedContentType) expect(contentType, `${assetUrl} must use the content type implied by its extension`).toMatch(expectedContentType);
    return { assetUrl, finalUrl: response.url(), status: response.status(), contentType, bytes: body.byteLength };
  });

  audit.observe('Data endpoints checked', DATA_ENDPOINTS.length);
  audit.observe('First-party assets checked', firstPass.length + secondPass.length);
  await audit.attachJson('endpoint-contract-evidence', endpointEvidence);
  await audit.attachJson('first-party-asset-contract-evidence', { routeDocuments, firstPass, nestedCssAssets: secondPass });
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
