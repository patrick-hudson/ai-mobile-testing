import {
  APPROVED_CANDIDATE_ADDITION_PATHS,
  ENVIRONMENTS,
  LEGACY_ROUTE_REDIRECTS,
  productionRouteDisposition,
  resolveEnvironmentPath,
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
  auditDeploymentRole,
  auditMeta,
  extractHtmlTagAttributes,
  inspectHtmlDestination,
  loggedGet,
  mapWithConcurrency,
  matchesAuditTargetTemplate,
  usesReviewedSiteContract,
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

function extractMetaContents(html: string, attribute: 'name' | 'property', expectedValue: string): string[] {
  return (html.match(/<meta\b[^>]*>/gi) ?? []).flatMap((tag) => {
    const value = extractHtmlTagAttributes(tag, 'meta', attribute)[0]?.toLowerCase();
    const content = extractHtmlTagAttributes(tag, 'meta', 'content')[0];
    return value === expectedValue.toLowerCase() && content ? [content] : [];
  });
}

function extractDocumentTitle(html: string): string {
  const raw = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
  return raw.replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|quot|apos|lt|gt|nbsp));/gi, (_match, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' } as const)[named?.toLowerCase() as 'amp'] ?? _match;
  });
}

function sortedKeys(value: unknown): string[] {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
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
    const requestedUrl = new URL(route.path, audit.environmentBaseURL()).href;
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
  const metadata = auditMeta(testInfo);
  test.skip(!usesReviewedSiteContract(testInfo) || !metadata.fullSweep, 'Redirect contracts run once against the reviewed site.');
  const activeBaseURL = audit.environmentBaseURL();

  const results: Array<{ source: string; status: number; location: string; resolvedLocation: string; destinationStatus: number }> = [];

  for (const { sourcePath, expectedLocationPath } of LEGACY_ROUTE_REDIRECTS) {
    const sourceUrl = new URL(sourcePath, activeBaseURL);
    const first = await loggedGet(request, audit, sourceUrl.href, { maxRedirects: 0, timeout: ROUTE_REQUEST_TIMEOUT_MS });
    const location = first.headers().location ?? null;
    expect([301, 308], `${sourcePath} should be permanent`).toContain(first.status());
    expect(location, `${sourcePath} should include a Location header`).not.toBeNull();
    const resolvedLocation = new URL(location ?? '/', sourceUrl);
    const expectedLocation = new URL(expectedLocationPath, activeBaseURL);
    expect(resolvedLocation.href, `${sourcePath} must redirect to the exact approved origin, path, query, and fragment`).toBe(expectedLocation.href);

    const final = await loggedGet(request, audit, resolvedLocation.href, { maxRedirects: 0, timeout: ROUTE_REQUEST_TIMEOUT_MS });
    expect(final.status(), `${resolvedLocation.href} should not add another redirect`).toBe(200);
    expect(final.headers()['content-type']).toContain('text/html');
    results.push({ source: sourceUrl.href, status: first.status(), location: location!, resolvedLocation: resolvedLocation.href, destinationStatus: final.status() });
  }

  expect(LEGACY_ROUTE_REDIRECTS, 'The reviewed migration ledger must retain all seven legacy aliases').toHaveLength(7);
  expect(results.map(({ source }) => source), 'Every declared legacy alias must produce one redirect result').toEqual(
    LEGACY_ROUTE_REDIRECTS.map(({ sourcePath }) => new URL(sourcePath, activeBaseURL).href),
  );
  audit.observe('Legacy redirects checked', results.length);
  await audit.attachJson('redirect-chain-evidence', results);
});

staticTest('[ENV-005] environment indexing policy and canonical intent are explicit', staticEvidence('Capture the rendered page together with its robots, canonical, and social URL metadata.', 'all-projects'), async ({ page, request, audit }, testInfo) => {
  const deploymentRole = auditDeploymentRole(testInfo);
  await audit.goto('/start-here/welcome');
  const inspection = await audit.inspectPage();
  const canonical = inspection.canonical ? new URL(inspection.canonical) : null;
  const robots = (inspection.robots ?? '').toLowerCase();

  audit.observe('Robots policy', inspection.robots, deploymentRole === 'preview' ? 'Contains noindex' : 'Allows index');
  audit.observe('Canonical URL', inspection.canonical);
  await audit.attachJson('indexing-evidence', { deploymentRole, robots, canonical });

  expect(canonical, 'A canonical URL is required').not.toBeNull();
  expect(canonical?.origin, 'Canonical URLs announce the eventual public origin').toBe(ENVIRONMENTS.production.baseURL);
  expect(canonical?.pathname.replace(/\/$/, ''), 'Canonical path identifies this content').toBe('/start-here/welcome');
  if (deploymentRole === 'preview') {
    expect(robots, 'The beta must not compete with production in search results').toContain('noindex');
  } else {
    expect(robots).toContain('index');
    expect(robots).not.toContain('noindex');
  }
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', inspection.canonical ?? '');

  if (matchesAuditTargetTemplate(testInfo, 'candidate-desktop-chromium')) {
    test.setTimeout(180_000);
    const betaRouteLedger = await mapWithConcurrency(CANDIDATE_HTML_ROUTES, 8, async (route) => {
      const requestedUrl = new URL(route.path, audit.environmentBaseURL()).href;
      const response = await loggedGet(request, audit, requestedUrl, { timeout: ROUTE_REQUEST_TIMEOUT_MS });
      const html = await response.text();
      const robotContents = extractMetaContents(html, 'name', 'robots');
      const canonicalHrefs = extractCanonicalHrefs(html);
      const issues: string[] = [];
      if (response.status() !== 200) issues.push(`expected HTTP 200, received ${response.status()}`);
      if (!(response.headers()['content-type'] ?? '').includes('text/html')) issues.push('response is not HTML');
      if (robotContents.length !== 1) issues.push(`expected exactly one robots policy, found ${robotContents.length}`);
      const robotTokens = (robotContents[0] ?? '').toLowerCase().split(/[\s,]+/);
      if (deploymentRole === 'preview' && !robotTokens.includes('noindex')) issues.push('preview robots policy does not include noindex');
      if (deploymentRole === 'production' && (!robotTokens.includes('index') || robotTokens.includes('noindex'))) issues.push('production robots policy does not allow indexing');
      if (canonicalHrefs.length !== 1) issues.push(`expected exactly one canonical, found ${canonicalHrefs.length}`);
      if (canonicalHrefs[0]) {
        const routeCanonical = new URL(canonicalHrefs[0], requestedUrl);
        if (routeCanonical.origin !== ENVIRONMENTS.production.baseURL) issues.push(`canonical origin is ${routeCanonical.origin}`);
        if (normalizeRoutePath(routeCanonical.pathname) !== route.path) issues.push(`canonical path is ${routeCanonical.pathname}`);
        if (routeCanonical.search || routeCanonical.hash) issues.push('canonical contains a query or fragment');
      }
      return {
        path: route.path,
        status: response.status(),
        contentType: response.headers()['content-type'] ?? '',
        robots: robotContents,
        canonicals: canonicalHrefs,
        issues,
      };
    });
    const betaIndexingProblems = betaRouteLedger.filter(({ issues }) => issues.length > 0);
    expect(betaRouteLedger, 'Every reviewed beta route must produce an indexing-policy record').toHaveLength(CANDIDATE_HTML_ROUTES.length);
    expect(betaIndexingProblems, 'Every reviewed route must retain role-correct indexing with one exact production canonical').toEqual([]);
    audit.observe('Reviewed indexing routes checked', betaRouteLedger.length, String(CANDIDATE_HTML_ROUTES.length));
    await audit.attachJson('reviewed-route-indexing-ledger', betaRouteLedger);
  }
  await audit.checkpoint('indexing-policy-page');
});

staticTest('[ENV-006] document security headers and hashed-asset caching are deployed', staticEvidence('Capture the rendered document alongside its security-header and immutable-asset response evidence.', 'all-projects'), async ({ page, request, audit }) => {
  const documentResponse = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(documentResponse).not.toBeNull();
  const headers = documentResponse?.headers() ?? {};
  const requiredHeaders = {
    'strict-transport-security': /(?:^|;)\s*max-age=\d+(?:;|$)/i,
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
  const hstsMaxAge = Number.parseInt(
    headers['strict-transport-security']?.match(/(?:^|;)\s*max-age=(\d+)(?:;|$)/i)?.[1] ?? '',
    10,
  );
  expect(hstsMaxAge, 'HSTS must remain active for at least one year; max-age=0 disables transport protection').toBeGreaterThanOrEqual(31_536_000);

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
  await audit.attachJson('header-evidence', { document: headerEvidence, hstsMaxAge, hashedAsset, cacheControl });
  await audit.checkpoint('secure-cached-document');
});

interactionTest('[ENV-007] unknown routes provide working search and recovery navigation', interactionEvidence('Open a deterministic missing URL, enter a useful query in the named combobox, and activate the complete site-map recovery link.', 'all-projects'), async ({ page, audit }) => {
  const missingPath = '/__visual-audit-not-found__';
  // Begin from a real, rendered page so the navigation video establishes the
  // user's starting context before showing the unknown-route response. Starting
  // a browser context at about:blank produced a truthful failure but useless
  // white lead-in on fast responses.
  await audit.goto('/');
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
  const REVIEWED_SEARCH_RECORD_COUNT = 88;

  for (const endpoint of DATA_ENDPOINTS) {
    const response = await loggedGet(request, audit, endpoint.path);
    expect(response.status(), `${endpoint.name} must load`).toBe(200);
    expect(response.headers()['content-type'], `${endpoint.name} must be JSON`).toContain('application/json');
    const payload = await response.json() as Record<string, unknown>;

    if (endpoint.path === '/search-index.json') {
      const issues: string[] = [];
      const expectedRootKeys = ['index', 'pageCount', 'recordCount', 'version'];
      if (JSON.stringify(sortedKeys(payload)) !== JSON.stringify(expectedRootKeys)) issues.push(`root keys are ${sortedKeys(payload).join(', ')}`);
      if (payload.version !== 1) issues.push(`version is ${String(payload.version)}`);
      if (payload.pageCount !== REVIEWED_SEARCH_RECORD_COUNT) issues.push(`pageCount is ${String(payload.pageCount)}`);
      if (payload.recordCount !== REVIEWED_SEARCH_RECORD_COUNT) issues.push(`recordCount is ${String(payload.recordCount)}`);

      const serialized = payload.index as Record<string, unknown> | null;
      const expectedIndexKeys = [
        'averageFieldLength', 'dirtCount', 'documentCount', 'documentIds', 'fieldIds',
        'fieldLength', 'index', 'nextId', 'serializationVersion', 'storedFields',
      ].sort();
      if (JSON.stringify(sortedKeys(serialized)) !== JSON.stringify(expectedIndexKeys)) issues.push(`serialized index keys are ${sortedKeys(serialized).join(', ')}`);
      if (serialized?.serializationVersion !== 2) issues.push(`serializationVersion is ${String(serialized?.serializationVersion)}`);
      if (serialized?.documentCount !== REVIEWED_SEARCH_RECORD_COUNT) issues.push(`documentCount is ${String(serialized?.documentCount)}`);
      if (serialized?.nextId !== REVIEWED_SEARCH_RECORD_COUNT) issues.push(`nextId is ${String(serialized?.nextId)}`);
      if (serialized?.dirtCount !== 0) issues.push(`dirtCount is ${String(serialized?.dirtCount)}`);
      const expectedFieldIds = { title: 0, section: 1, description: 2, aliases: 3, content: 4 };
      if (JSON.stringify(serialized?.fieldIds) !== JSON.stringify(expectedFieldIds)) issues.push('fieldIds no longer match the reviewed search fields');
      if (!Array.isArray(serialized?.averageFieldLength) || serialized.averageFieldLength.length !== 5 || serialized.averageFieldLength.some((value) => typeof value !== 'number' || value <= 0)) {
        issues.push('averageFieldLength must contain five positive numeric field averages');
      }
      if (!Array.isArray(serialized?.index) || serialized.index.length === 0) issues.push('serialized token index is empty or malformed');

      const documentIds = serialized?.documentIds as Record<string, unknown> | undefined;
      const fieldLength = serialized?.fieldLength as Record<string, unknown> | undefined;
      const storedFields = serialized?.storedFields as Record<string, unknown> | undefined;
      for (const [name, value] of [['documentIds', documentIds], ['fieldLength', fieldLength], ['storedFields', storedFields]] as const) {
        if (!value || sortedKeys(value).length !== REVIEWED_SEARCH_RECORD_COUNT) issues.push(`${name} must contain ${REVIEWED_SEARCH_RECORD_COUNT} records`);
      }

      const records = Object.values(storedFields ?? {});
      const searchIds = new Set<string>();
      const expectedRecordKeys = ['category', 'categoryLabel', 'excerpt', 'id', 'pageUrl', 'priority', 'section', 'sections', 'title', 'type', 'url'];
      records.forEach((entry, index) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          issues.push(`storedFields[${index}] is not an object`);
          return;
        }
        const record = entry as Record<string, unknown>;
        if (JSON.stringify(sortedKeys(record)) !== JSON.stringify(expectedRecordKeys)) issues.push(`storedFields[${index}] has unexpected keys`);
        for (const field of ['id', 'pageUrl', 'url', 'title', 'section', 'excerpt', 'category', 'categoryLabel', 'type']) {
          if (typeof record[field] !== 'string') issues.push(`storedFields[${index}].${field} is not a string`);
        }
        if (typeof record.id === 'string') {
          if (searchIds.has(record.id)) issues.push(`duplicate search record id ${record.id}`);
          searchIds.add(record.id);
        }
        if (typeof record.pageUrl === 'string' && !record.pageUrl.startsWith('/')) issues.push(`storedFields[${index}].pageUrl is not internal`);
        if (typeof record.url === 'string' && !record.url.startsWith('/')) issues.push(`storedFields[${index}].url is not internal`);
        if (typeof record.priority !== 'number' || !Number.isFinite(record.priority)) issues.push(`storedFields[${index}].priority is not numeric`);
        if (!Array.isArray(record.sections)) {
          issues.push(`storedFields[${index}].sections is not an array`);
        } else {
          record.sections.forEach((entrySection, sectionIndex) => {
            const section = entrySection as Record<string, unknown>;
            if (JSON.stringify(sortedKeys(section)) !== JSON.stringify(['excerpt', 'title', 'url'])) issues.push(`storedFields[${index}].sections[${sectionIndex}] has unexpected keys`);
            if (typeof section.title !== 'string' || typeof section.excerpt !== 'string' || typeof section.url !== 'string' || !section.url.startsWith('/')) {
              issues.push(`storedFields[${index}].sections[${sectionIndex}] has invalid content`);
            }
          });
        }
      });
      Object.entries(fieldLength ?? {}).forEach(([documentId, lengths]) => {
        if (!Array.isArray(lengths) || lengths.length !== 5 || lengths.some((value) => !Number.isInteger(value) || value < 0)) issues.push(`fieldLength[${documentId}] must contain five non-negative integers`);
      });
      const helperRecord = records.find((entry) => (entry as Record<string, unknown>).id === 'page:medications-supplements/helper-meds') as Record<string, unknown> | undefined;
      const clonidineSection = (helperRecord?.sections as Array<Record<string, unknown>> | undefined)?.find((section) => section.title === 'Clonidine');
      if (helperRecord?.title !== 'Helper Medications' || helperRecord.pageUrl !== '/medications-supplements/helper-meds') issues.push('reviewed Helper Medications page record is missing');
      if (clonidineSection?.url !== '/medications-supplements/helper-meds#clonidine' || typeof clonidineSection.excerpt !== 'string' || !/withdrawal/i.test(clonidineSection.excerpt)) {
        issues.push('reviewed Clonidine section record is missing or malformed');
      }

      expect(issues, 'Every search document and serialized index field must satisfy the reviewed schema and content contract').toEqual([]);
      endpointEvidence[endpoint.path] = {
        rootKeys: sortedKeys(payload),
        version: payload.version,
        pageCount: payload.pageCount,
        recordCount: payload.recordCount,
        indexKeys: sortedKeys(serialized),
        fieldIds: serialized?.fieldIds,
        helperRecord,
        issues,
      };
    } else {
      const issues: string[] = [];
      if (JSON.stringify(sortedKeys(payload)) !== JSON.stringify(['featuredNa', 'generatedAt', 'na', 'smart'])) issues.push(`root keys are ${sortedKeys(payload).join(', ')}`);
      if (typeof payload.generatedAt !== 'string' || Number.isNaN(Date.parse(payload.generatedAt))) issues.push('generatedAt is not a parseable timestamp');
      const na = Array.isArray(payload.na) ? payload.na : [];
      const smart = Array.isArray(payload.smart) ? payload.smart : [];
      if (na.length === 0) issues.push('NA meeting array is empty or missing');
      if (smart.length === 0) issues.push('SMART meeting array is empty or missing');

      const validateNaMeeting = (entry: unknown, label: string, requireAlwaysAvailable: boolean) => {
        const meeting = entry as Record<string, unknown>;
        const expectedKeys = requireAlwaysAvailable
          ? ['alwaysAvailable', 'day', 'hour', 'id', 'joinUrl', 'minute', 'name', 'platform', 'provider', 'timezone']
          : ['day', 'hour', 'id', 'joinUrl', 'minute', 'name', 'platform', 'provider', 'timezone'];
        if (JSON.stringify(sortedKeys(meeting)) !== JSON.stringify(expectedKeys)) issues.push(`${label} has unexpected keys`);
        if (meeting.provider !== 'NA') issues.push(`${label}.provider must be NA`);
        for (const field of ['id', 'name', 'platform', 'timezone']) if (typeof meeting[field] !== 'string' || meeting[field].length === 0) issues.push(`${label}.${field} must be a non-empty string`);
        if (typeof meeting.joinUrl !== 'string' || !/^https:\/\//.test(meeting.joinUrl)) issues.push(`${label}.joinUrl must be HTTPS`);
        if (!Number.isInteger(meeting.day) || Number(meeting.day) < 0 || Number(meeting.day) > 6) issues.push(`${label}.day must be 0–6`);
        if (!Number.isInteger(meeting.hour) || Number(meeting.hour) < 0 || Number(meeting.hour) > 23) issues.push(`${label}.hour must be 0–23`);
        if (!Number.isInteger(meeting.minute) || Number(meeting.minute) < 0 || Number(meeting.minute) > 59) issues.push(`${label}.minute must be 0–59`);
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: String(meeting.timezone) }).format(0);
        } catch {
          issues.push(`${label}.timezone is not recognized`);
        }
        if (requireAlwaysAvailable && meeting.alwaysAvailable !== true) issues.push(`${label}.alwaysAvailable must be true`);
      };
      na.forEach((meeting, index) => validateNaMeeting(meeting, `na[${index}]`, false));

      smart.forEach((entry, index) => {
        const meeting = entry as Record<string, unknown>;
        const label = `smart[${index}]`;
        if (JSON.stringify(sortedKeys(meeting)) !== JSON.stringify(['id', 'joinUrl', 'name', 'platform', 'provider', 'utcStart'])) issues.push(`${label} has unexpected keys`);
        if (meeting.provider !== 'SMART') issues.push(`${label}.provider must be SMART`);
        if (meeting.platform !== 'SMART Online') issues.push(`${label}.platform must be SMART Online`);
        for (const field of ['id', 'name']) if (typeof meeting[field] !== 'string' || meeting[field].length === 0) issues.push(`${label}.${field} must be a non-empty string`);
        if (typeof meeting.joinUrl !== 'string' || !/^https:\/\//.test(meeting.joinUrl)) issues.push(`${label}.joinUrl must be HTTPS`);
        if (typeof meeting.utcStart !== 'string' || Number.isNaN(Date.parse(meeting.utcStart))) issues.push(`${label}.utcStart must be parseable`);
      });
      if (payload.featuredNa === null || payload.featuredNa === undefined) issues.push('featuredNa fallback is missing');
      else validateNaMeeting(payload.featuredNa, 'featuredNa', true);

      expect(issues, 'Every meeting record must satisfy the provider-specific reviewed schema and content contract').toEqual([]);
      endpointEvidence[endpoint.path] = {
        rootKeys: sortedKeys(payload),
        generatedAt: payload.generatedAt,
        naCount: na.length,
        smartCount: smart.length,
        featuredNa: payload.featuredNa,
        naSample: na.slice(0, 3),
        smartSample: smart.slice(0, 3),
        issues,
      };
    }
  }

  const routeDocuments = await mapWithConcurrency(CANDIDATE_HTML_ROUTES, 8, async (route) => {
    const url = new URL(route.path, audit.environmentBaseURL()).href;
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

staticTest('[SEO-001] canonical route metadata is complete, consistent, and shareable', staticEvidence('Capture every canonical route across both environments with its title, canonical, Open Graph, and Twitter metadata, plus rendered reference pages.', 'all-projects'), async ({ page, request, audit }, testInfo) => {
  const metadata = auditMeta(testInfo);
  const deploymentRole = auditDeploymentRole(testInfo);
  const routes = ['/', '/start-here/welcome', '/resources/7-oh-taper-calculator', '/virtual-na-meetings-now'] as const;
  const evidence: Array<{
    candidatePath: string;
    mappedPath: string;
    deploymentRole: string;
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
    evidence.push({ candidatePath, mappedPath, deploymentRole, ...values });
  }

  expect(routes, 'The metadata contract must retain all four representative routes').toHaveLength(4);
  const expectedRoutes = routes.filter((candidatePath) => audit.environmentPath(candidatePath) !== null);
  expect(expectedRoutes, 'Every representative metadata route must remain applicable in both audited environments').toHaveLength(4);
  expect(evidence.map(({ candidatePath }) => candidatePath), 'Every environment-applicable metadata route must produce one inspected record').toEqual(expectedRoutes);
  audit.observe('Metadata routes inspected', evidence.length, String(routes.length));
  await audit.attachJson('metadata-evidence', evidence);

  if (matchesAuditTargetTemplate(testInfo, 'candidate-desktop-chromium')) {
    test.setTimeout(300_000);
    const reviewedInventory = metadata.mode === 'single-site'
      ? CANDIDATE_HTML_ROUTES.map((route) => ({
          deploymentRole,
          candidatePath: route.path,
          path: route.path,
          baseURL: audit.environmentBaseURL(),
        }))
      : (['candidate', 'production'] as const).flatMap((environment) =>
          CANDIDATE_HTML_ROUTES.flatMap((route) => {
            const mappedPath = environment === 'candidate' ? route.path : resolveEnvironmentPath('production', route.path);
            return mappedPath === null ? [] : [{
              deploymentRole: environment === 'candidate' ? 'preview' as const : 'production' as const,
              candidatePath: route.path,
              path: mappedPath,
              baseURL: ENVIRONMENTS[environment].baseURL,
            }];
          }));
    const fullMetadataLedger = await mapWithConcurrency(reviewedInventory, 8, async (entry) => {
      const requestedUrl = new URL(entry.path, entry.baseURL).href;
      const response = await loggedGet(request, audit, requestedUrl, { timeout: ROUTE_REQUEST_TIMEOUT_MS });
      const html = await response.text();
      const titles = (html.match(/<title\b[^>]*>[\s\S]*?<\/title>/gi) ?? []).map(extractDocumentTitle);
      const descriptions = extractMetaContents(html, 'name', 'description');
      const robotPolicies = extractMetaContents(html, 'name', 'robots');
      const canonicals = extractCanonicalHrefs(html);
      const ogSiteNames = extractMetaContents(html, 'property', 'og:site_name');
      const ogTitles = extractMetaContents(html, 'property', 'og:title');
      const ogDescriptions = extractMetaContents(html, 'property', 'og:description');
      const ogTypes = extractMetaContents(html, 'property', 'og:type');
      const ogUrls = extractMetaContents(html, 'property', 'og:url');
      const ogImages = extractMetaContents(html, 'property', 'og:image');
      const twitterCards = extractMetaContents(html, 'name', 'twitter:card');
      const twitterTitles = extractMetaContents(html, 'name', 'twitter:title');
      const twitterDescriptions = extractMetaContents(html, 'name', 'twitter:description');
      const twitterImages = extractMetaContents(html, 'name', 'twitter:image');
      const issues: string[] = [];
      if (response.status() !== 200) issues.push(`expected HTTP 200, received ${response.status()}`);
      if (!(response.headers()['content-type'] ?? '').includes('text/html')) issues.push('response is not HTML');
      for (const [name, values] of [
        ['title', titles], ['description', descriptions], ['robots', robotPolicies], ['canonical', canonicals],
        ['og:site_name', ogSiteNames], ['og:title', ogTitles], ['og:description', ogDescriptions], ['og:type', ogTypes],
        ['og:url', ogUrls], ['og:image', ogImages], ['twitter:card', twitterCards], ['twitter:title', twitterTitles],
        ['twitter:description', twitterDescriptions], ['twitter:image', twitterImages],
      ] as const) if (values.length !== 1) issues.push(`expected exactly one ${name}, found ${values.length}`);
      const title = titles[0] ?? '';
      const description = descriptions[0] ?? '';
      if (title.length <= 8) issues.push('title is not meaningful');
      if (description.length <= 35) issues.push('description is not meaningful');
      if ((ogTitles[0] ?? '') !== title) issues.push('og:title differs from title');
      if ((ogDescriptions[0] ?? '') !== description) issues.push('og:description differs from description');
      if ((ogSiteNames[0] ?? '') !== 'quitting7oh.org') issues.push('og:site_name is not quitting7oh.org');
      if ((ogTypes[0] ?? '') !== 'website') issues.push('og:type is not website');
      if ((ogUrls[0] ?? '') !== (canonicals[0] ?? '')) issues.push('og:url differs from canonical');
      if ((twitterCards[0] ?? '') !== 'summary_large_image') issues.push('twitter:card is not summary_large_image');
      if (!/^https:\/\/.+\.(?:png|jpe?g|webp)$/i.test(ogImages[0] ?? '')) issues.push('og:image is not an absolute supported image URL');
      if ((twitterTitles[0] ?? '') !== title) issues.push('twitter:title differs from title');
      if ((twitterDescriptions[0] ?? '') !== description) issues.push('twitter:description differs from description');
      if ((twitterImages[0] ?? '') !== (ogImages[0] ?? '')) issues.push('twitter:image differs from og:image');
      const robotTokens = (robotPolicies[0] ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
      if (entry.deploymentRole === 'preview' && !robotTokens.includes('noindex')) issues.push('preview robots policy does not include noindex');
      if (entry.deploymentRole === 'production' && (!robotTokens.includes('index') || robotTokens.includes('noindex'))) issues.push('production robots policy does not allow indexing');
      if (canonicals[0]) {
        const canonicalUrl = new URL(canonicals[0], requestedUrl);
        if (canonicalUrl.origin !== ENVIRONMENTS.production.baseURL) issues.push(`canonical origin is ${canonicalUrl.origin}`);
        if (normalizeRoutePath(canonicalUrl.pathname) !== normalizeRoutePath(entry.path)) issues.push(`canonical path is ${canonicalUrl.pathname}`);
        if (canonicalUrl.search || canonicalUrl.hash) issues.push('canonical contains a query or fragment');
      }
      return {
        ...entry,
        requestedUrl,
        status: response.status(),
        contentType: response.headers()['content-type'] ?? '',
        title,
        description,
        robots: robotPolicies[0] ?? '',
        canonical: canonicals[0] ?? '',
        ogSiteName: ogSiteNames[0] ?? '',
        ogTitle: ogTitles[0] ?? '',
        ogDescription: ogDescriptions[0] ?? '',
        ogType: ogTypes[0] ?? '',
        ogUrl: ogUrls[0] ?? '',
        ogImage: ogImages[0] ?? '',
        twitterCard: twitterCards[0] ?? '',
        twitterTitle: twitterTitles[0] ?? '',
        twitterDescription: twitterDescriptions[0] ?? '',
        twitterImage: twitterImages[0] ?? '',
        issues,
      };
    });
    const metadataProblems = fullMetadataLedger.filter(({ issues }) => issues.length > 0);
    expect(fullMetadataLedger, 'Every applicable reviewed route must produce one metadata record').toHaveLength(reviewedInventory.length);
    expect(metadataProblems, 'Every canonical route must satisfy the full reviewed metadata contract').toEqual([]);
    audit.observe('Full metadata routes inspected', fullMetadataLedger.length, String(reviewedInventory.length));
    await audit.attachJson('full-canonical-route-metadata-ledger', fullMetadataLedger);
    if (metadata.mode === 'comparative') audit.coverEnvironments('candidate', 'production');
  }
  await audit.checkpoint('representative-metadata-page');
});

structuredTest('[SEO-002] XML sitemap contains every canonical candidate HTML route', structuredEvidence('Retain parsed sitemap locations, missing entries, duplicates, and response evidence without unrelated media.', 'candidate-chromium-projects'), async ({ request, audit }, testInfo) => {
  const metadata = auditMeta(testInfo);
  test.skip(!usesReviewedSiteContract(testInfo) || !metadata.fullSweep, 'The canonical sitemap contract runs once against the reviewed site.');
  test.setTimeout(300_000);

  const index = await loggedGet(request, audit, '/sitemap-index.xml');
  expect(index.status()).toBe(200);
  expect(index.headers()['content-type']).toMatch(/xml/);
  const indexText = await index.text();
  const childLocations = [...indexText.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).filter((value): value is string => Boolean(value));
  expect(childLocations.length, 'The sitemap index should reference at least one sitemap').toBeGreaterThan(0);

  const locations: string[] = [];
  for (const location of childLocations) {
    expect(new URL(location).origin, `Sitemap document ${location} must announce the public origin`).toBe(ENVIRONMENTS.production.baseURL);
    const childPath = new URL(location).pathname;
    const child = await loggedGet(request, audit, childPath);
    expect(child.status(), `${childPath} must load`).toBe(200);
    locations.push(...[...(await child.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).filter((value): value is string => Boolean(value)));
  }

  const sitemapPathList = locations.map((location) => normalizeRoutePath(new URL(location).pathname));
  const sitemapPaths = new Set(sitemapPathList);
  const expectedPaths = CANDIDATE_PATHS.map((path) => path.replace(/\/$/, '') || '/');
  const missing = expectedPaths.filter((path) => !sitemapPaths.has(path));
  const unexpected = [...sitemapPaths].filter((path) => !expectedPaths.includes(path as typeof expectedPaths[number]));
  const duplicateLocations = locations.filter((location, indexInList) => locations.indexOf(location) !== indexInList);
  const duplicatePaths = sitemapPathList.filter((path, indexInList) => sitemapPathList.indexOf(path) !== indexInList);
  const malformedLocations = locations.flatMap((location) => {
    const parsed = new URL(location);
    return parsed.origin === ENVIRONMENTS.production.baseURL && parsed.search === '' && parsed.hash === ''
      ? []
      : [{ location, origin: parsed.origin, search: parsed.search, hash: parsed.hash }];
  });
  const legacyAliasesInSitemap = LEGACY_ROUTE_REDIRECTS.filter(({ sourcePath }) => sitemapPaths.has(normalizeRoutePath(sourcePath)));
  const locationLedger = await mapWithConcurrency(locations, 8, async (location) => {
    const requestedLocation = metadata.mode === 'single-site'
      ? new URL(new URL(location).pathname, audit.environmentBaseURL()).href
      : location;
    const response = await loggedGet(request, audit, requestedLocation, { timeout: ROUTE_REQUEST_TIMEOUT_MS });
    const html = await response.text();
    const canonicals = extractCanonicalHrefs(html);
    const issues: string[] = [];
    if (response.status() !== 200) issues.push(`expected HTTP 200, received ${response.status()}`);
    if (!(response.headers()['content-type'] ?? '').includes('text/html')) issues.push('response is not HTML');
    if (canonicals.length !== 1) issues.push(`expected exactly one canonical, found ${canonicals.length}`);
    if (canonicals[0]) {
      const canonical = new URL(canonicals[0], location);
      const sitemapUrl = new URL(location);
      if (canonical.origin !== ENVIRONMENTS.production.baseURL) issues.push(`canonical origin is ${canonical.origin}`);
      if (normalizeRoutePath(canonical.pathname) !== normalizeRoutePath(sitemapUrl.pathname)) issues.push(`canonical path is ${canonical.pathname}`);
      if (canonical.search || canonical.hash) issues.push('canonical contains a query or fragment');
    }
    return {
      location,
      requestedLocation,
      status: response.status(),
      contentType: response.headers()['content-type'] ?? '',
      canonical: canonicals[0] ?? '',
      issues,
    };
  });
  const locationProblems = locationLedger.filter(({ issues }) => issues.length > 0);

  audit.observe('Sitemap URLs', sitemapPaths.size, String(CANDIDATE_PATHS.length));
  await audit.attachJson('sitemap-evidence', {
    childLocations,
    sitemapPaths: [...sitemapPaths].sort(),
    expectedPaths: [...expectedPaths].sort(),
    missing,
    unexpected,
    duplicateLocations,
    duplicatePaths,
    malformedLocations,
    legacyAliasesInSitemap,
    locationLedger,
  });
  expect(missing, 'Every candidate HTML route must be discoverable in the XML sitemap').toEqual([]);
  expect(unexpected, 'The XML sitemap must not silently add routes outside the reviewed canonical inventory').toEqual([]);
  expect(duplicateLocations, 'Canonical sitemap entries must not be duplicated').toEqual([]);
  expect(duplicatePaths, 'Canonical route paths must not be duplicated through URL spelling variants').toEqual([]);
  expect(malformedLocations, 'Sitemap locations must use the exact public origin without query strings or fragments').toEqual([]);
  expect(legacyAliasesInSitemap, 'No reviewed legacy alias belongs in the canonical sitemap').toEqual([]);
  expect(locationProblems, 'Every sitemap location must return HTML 200 with one matching production canonical').toEqual([]);
});
