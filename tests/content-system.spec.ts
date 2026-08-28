import { ENVIRONMENTS, resolveEnvironmentPath } from '../audit/environments.js';
import {
  CANDIDATE_HTML_ROUTES,
  CRITICAL_CONTENT_CONTRACTS,
  DECLARED_ROUTE_VISUALS,
  REPRESENTATIVE_VISUAL_ROUTES,
  REVIEWED_HOME_LIVE_MEETING_INDEX,
  REVIEWED_HOME_SUPPORT_STATES,
} from '../audit/routes.js';
import { evaluateHomeSupportStateContract } from '../audit/page-oracles.js';
import { expect, interactionEvidence, interactionTest, staticEvidence, staticTest, structuredEvidence, structuredTest, test } from '../fixtures/test.js';
import { auditMeta, dismissSchedulingNotice, extractHtmlElementIds, extractHtmlTagAttributes, inspectHtmlDestination, loggedGet, mapWithConcurrency, matchesAuditTargetTemplate, pageHasHorizontalOverflow, waitForSettledUI } from './helpers.js';

const REPRESENTATIVE_DOCUMENTS = [
  '/',
  '/start-here/welcome',
  '/compounds/7-oh',
  '/resources/7-oh-taper-calculator',
  '/virtual-na-meetings-now',
  '/about/changelog',
] as const;

function candidateDesktopChromium(testInfo: Parameters<typeof auditMeta>[0]): boolean {
  return matchesAuditTargetTemplate(testInfo, 'candidate-desktop-chromium');
}

staticTest('[HOME-002] support-right-now panel exposes live, upcoming, and fallback help paths', staticEvidence('Capture each deterministic support state with exact clock semantics, labels, destinations, and tab-isolation metadata.', 'candidate-desktop-chromium'), async ({ page, request, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One candidate Chromium project validates the hydrated support panel.');
  await page.route('**/live-meeting-index.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(REVIEWED_HOME_LIVE_MEETING_INDEX),
  }));
  const evidence = [];
  for (const contract of REVIEWED_HOME_SUPPORT_STATES) {
    await page.clock.setFixedTime(new Date(contract.at));
    await audit.goto('/');
    const panel = page.locator('section[aria-labelledby="right-now-title"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Support right now', exact: true })).toBeVisible();
    await expect(panel.locator('a[href]'), `${contract.id} state must finish hydrating its exact reviewed action inventory`)
      .toHaveCount(contract.actions.length);
    const observed = await panel.evaluate((element, state) => ({
      id: state.id,
      at: state.at,
      textLines: (element as HTMLElement).innerText.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean),
      actions: [...element.querySelectorAll<HTMLAnchorElement>('a[href]')].map((anchor) => ({
        accessibleName: (anchor.getAttribute('aria-label') ?? anchor.innerText).replace(/\s+/g, ' ').trim(),
        href: anchor.getAttribute('href') ?? '',
        target: anchor.getAttribute('target'),
        rel: anchor.getAttribute('rel'),
      })),
    }), { id: contract.id, at: contract.at });
    expect(evaluateHomeSupportStateContract(contract, observed), `${contract.id} support state must equal its independent reviewed contract`).toEqual([]);
    evidence.push(observed);
    await audit.checkpoint(`support-right-now-${contract.id}`);
  }

  const destinations = [...new Set(REVIEWED_HOME_SUPPORT_STATES.flatMap(({ actions }) => actions.map(({ href }) => href)))];
  const destinationHealth = [];
  for (const destination of destinations) {
    const response = await loggedGet(request, audit, destination, { maxRedirects: 0, timeout: 15_000 });
    expect(response.status(), `${destination} must respond as an actionable support destination`).toBeGreaterThanOrEqual(200);
    expect(response.status(), `${destination} must not be a broken support destination`).toBeLessThan(400);
    destinationHealth.push({ destination, status: response.status(), location: response.headers().location ?? null });
  }
  expect(evidence.map(({ id }) => id), 'Fallback, upcoming, and live states must all produce evidence in reviewed order')
    .toEqual(REVIEWED_HOME_SUPPORT_STATES.map(({ id }) => id));
  await audit.attachJson('support-right-now-state-contract', { contract: REVIEWED_HOME_SUPPORT_STATES, evidence, destinationHealth });
  audit.observe('Deterministic support states', evidence.length, String(REVIEWED_HOME_SUPPORT_STATES.length));
  await audit.assertRuntimeHealthy();
});

staticTest('[CONTENT-001] representative documents keep valid landmarks and heading order', staticEvidence('Capture representative document outlines with their landmarks, headings, descriptions, and canonical metadata.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'The complete route audit covers every page; this check validates representative outlines.');
  const evidence = [];
  for (const route of REPRESENTATIVE_DOCUMENTS) {
    await audit.goto(route);
    const structure = await page.evaluate(() => {
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((heading) => ({
        level: Number(heading.tagName.slice(1)),
        text: heading.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      }));
      const skippedLevels = headings.slice(1).filter((heading, index) => heading.level > (headings[index]?.level ?? 0) + 1);
      return {
        title: document.title,
        description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '',
        canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '',
        h1Count: headings.filter(({ level }) => level === 1).length,
        headings,
        skippedLevels,
        landmarks: {
          header: document.querySelectorAll('body > header').length,
          main: document.querySelectorAll('main').length,
          footer: document.querySelectorAll('body > footer').length,
          nav: document.querySelectorAll('nav').length,
        },
      };
    });
    expect(structure.h1Count, `${route} must have one H1`).toBe(1);
    expect(structure.skippedLevels, `${route} must not skip heading levels`).toEqual([]);
    expect(structure.landmarks.header, `${route} must retain one site header landmark`).toBe(1);
    expect(structure.landmarks.main, `${route} must have one main landmark`).toBe(1);
    expect(structure.landmarks.footer, `${route} must retain one site footer landmark`).toBe(1);
    expect(structure.landmarks.nav, `${route} must retain at least one navigation landmark`).toBeGreaterThan(0);
    expect(structure.description.length, `${route} needs a substantive description`).toBeGreaterThan(35);
    expect(structure.canonical, `${route} needs a canonical URL`).toMatch(/^https:\/\//);
    evidence.push({ route, ...structure });
    if (route === '/') await audit.checkpoint('representative-document-outline');
  }
  expect(REPRESENTATIVE_DOCUMENTS, 'The representative document contract must retain all six reviewed routes').toHaveLength(6);
  expect(evidence.map(({ route }) => route), 'Every declared representative document must produce one inspected record').toEqual([...REPRESENTATIVE_DOCUMENTS]);
  await audit.attachJson('document-structure-ledger', evidence);
  audit.observe('Representative outlines inspected', evidence.length, String(REPRESENTATIVE_DOCUMENTS.length));
});

structuredTest('[CONTENT-003] every published candidate route resolves without a broken internal destination', structuredEvidence('Retain both server-rendered and post-hydration internal destinations with redirect disposition, status, fragment, and content-type evidence.', 'candidate-desktop-chromium'), async ({ context, request, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One candidate project performs the complete internal destination crawl.');
  test.setTimeout(300_000);
  const metadata = auditMeta(testInfo);
  const activeBaseURL = audit.environmentBaseURL();
  const candidateOrigin = new URL(activeBaseURL).origin;
  const productionOrigin = new URL(ENVIRONMENTS.production.baseURL).origin;
  const allowedInternalOrigins = new Set(metadata.mode === 'single-site'
    ? [candidateOrigin]
    : [candidateOrigin, productionOrigin]);
  const sourceDocuments = await mapWithConcurrency(CANDIDATE_HTML_ROUTES, 8, async (route) => {
    const url = new URL(route.path, activeBaseURL).href;
    const response = await loggedGet(request, audit, url, { timeout: 10_000 });
    const contentType = response.headers()['content-type'] ?? '';
    const html = await response.text();
    return {
      path: route.path,
      kind: route.kind,
      url,
      status: response.status(),
      contentType,
      html,
      hrefs: extractHtmlTagAttributes(html, 'a', 'href'),
    };
  });
  const badSources = sourceDocuments.filter(({ status, contentType }) => status !== 200 || !contentType.includes('text/html'));
  expect(badSources, 'Every source document must load before its rendered anchor contract can be trusted').toEqual([]);

  const malformed: Array<{ sourcePath: string; href: string; issue: string }> = [];
  const hydratedSourceDocuments = await mapWithConcurrency(CANDIDATE_HTML_ROUTES, 4, async (route) => {
    const hydratedPage = await context.newPage();
    try {
      const url = new URL(route.path, activeBaseURL).href;
      const response = await hydratedPage.goto(url, { waitUntil: 'load', timeout: 15_000 });
      await hydratedPage.evaluate(async () => {
        for (const ratio of [0.25, 0.5, 0.75, 1]) {
          window.scrollTo({ top: document.documentElement.scrollHeight * ratio, behavior: 'instant' });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
      await hydratedPage.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('astro-island[ssr]')].every((island) => {
        const strategy = island.getAttribute('client');
        if (strategy !== 'media') return false;
        try {
          const query = (JSON.parse(island.getAttribute('opts') ?? '{}') as { value?: unknown }).value;
          return typeof query === 'string' && !window.matchMedia(query).matches;
        } catch {
          return false;
        }
      }), undefined, { timeout: 10_000 });
      await waitForSettledUI(hydratedPage);
      const applicableUnhydratedIslands = await hydratedPage.locator('astro-island[ssr]').evaluateAll((islands) => islands.filter((island) => {
        const strategy = island.getAttribute('client');
        if (strategy !== 'media') return true;
        try {
          const query = (JSON.parse(island.getAttribute('opts') ?? '{}') as { value?: unknown }).value;
          return typeof query !== 'string' || window.matchMedia(query).matches;
        } catch {
          return true;
        }
      }).length);
      return {
        path: route.path,
        kind: route.kind,
        url: hydratedPage.url(),
        status: response?.status() ?? null,
        applicableUnhydratedIslands,
        hrefs: await hydratedPage.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) =>
          (anchor as HTMLAnchorElement).getAttribute('href') ?? '')),
      };
    } finally {
      await hydratedPage.close();
    }
  });
  const badHydratedSources = hydratedSourceDocuments.filter(({ status, applicableUnhydratedIslands }) => status !== 200 || applicableUnhydratedIslands !== 0);
  expect(badHydratedSources, 'Every route must hydrate successfully before client-rewritten destinations can be trusted').toEqual([]);

  const referencesFrom = (sources: Array<{ path: string; url: string; hrefs: string[] }>, source: 'server' | 'hydrated') => sources.flatMap((document) => document.hrefs.flatMap((href) => {
    if (/^(?:mailto|tel|sms):/i.test(href)) return [];
    if (/^(?:javascript|data):/i.test(href)) {
      malformed.push({ sourcePath: document.path, href, issue: `Executable or embedded URLs are not valid ${source} navigation destinations.` });
      return [];
    }
    try {
      const destination = new URL(href, document.url);
      if (!['http:', 'https:'].includes(destination.protocol)) return [];
      if (!allowedInternalOrigins.has(destination.origin)) return [];
      const fragment = destination.hash ? decodeURIComponent(destination.hash.slice(1)) : '';
      destination.hash = '';
      return [{ source, sourcePath: document.path, renderedHref: href, destination: destination.href, fragment }];
    } catch (error) {
      malformed.push({ sourcePath: document.path, href, issue: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }));
  const serverInternalReferences = referencesFrom(sourceDocuments, 'server');
  const hydratedInternalReferences = referencesFrom(hydratedSourceDocuments, 'hydrated');
  const internalReferences = [...serverInternalReferences, ...hydratedInternalReferences];
  expect(internalReferences.length, 'The crawl must inspect rendered anchors, not merely replay the route registry').toBeGreaterThan(CANDIDATE_HTML_ROUTES.length * 3);
  expect(hydratedInternalReferences.length, 'Post-hydration extraction must retain a non-trivial client-visible link graph').toBeGreaterThan(CANDIDATE_HTML_ROUTES.length * 3);

  const uniqueDestinations = [...new Set(internalReferences.map(({ destination }) => destination))];
  const results = await mapWithConcurrency(uniqueDestinations, 8, async (destination) => ({
    destination,
    ...await inspectHtmlDestination(request, audit, destination, { timeoutMs: 10_000 }),
  }));
  const resultByDestination = new Map(results.map((result) => [result.destination, result]));
  const broken = internalReferences.filter(({ destination }) => !resultByDestination.get(destination)?.valid);

  const fragmentDocuments = new Map<string, Promise<{ finalUrl: string; ids: Set<string> }>>();
  const fragmentChecks = await mapWithConcurrency(internalReferences.filter(({ fragment }) => fragment !== ''), 8, async (reference) => {
    let document = fragmentDocuments.get(reference.destination);
    if (!document) {
      document = (async () => {
        const inspected = resultByDestination.get(reference.destination);
        if (!inspected?.valid) return { finalUrl: inspected?.finalUrl ?? reference.destination, ids: new Set<string>() };
        const response = await loggedGet(request, audit, inspected.finalUrl, { timeout: 10_000 });
        return { finalUrl: response.url(), ids: new Set(extractHtmlElementIds(await response.text())) };
      })();
      fragmentDocuments.set(reference.destination, document);
    }
    const resolved = await document;
    return { ...reference, finalUrl: resolved.finalUrl, exists: resolved.ids.has(reference.fragment) };
  });
  const missingFragments = fragmentChecks.filter(({ exists }) => !exists);

  audit.observe('Rendered internal anchor references', internalReferences.length);
  audit.observe('Unique internal destinations crawled', results.length);
  audit.observe('Fragment targets checked', fragmentChecks.length);
  await audit.attachJson('network-internal-link-ledger', {
    sources: sourceDocuments.map(({ html: _html, ...source }) => source),
    hydratedSources: hydratedSourceDocuments,
    serverInternalReferences,
    hydratedInternalReferences,
    internalReferences,
    results,
    fragmentChecks,
    malformed,
    broken,
    missingFragments,
  });
  expect(malformed, 'Rendered anchors must contain parseable, non-executable URLs').toEqual([]);
  expect(broken, 'Every rendered internal anchor destination must serve HTML directly or through a canonical trailing-slash redirect').toEqual([]);
  expect(missingFragments, 'Every rendered internal fragment must identify an existing id or legacy named anchor').toEqual([]);
});

staticTest('[CONTENT-004] internal and external links follow tab-isolation policy', staticEvidence('Capture representative rendered link sets with their target and rel isolation attributes.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'The full page audit checks every route; this check summarizes link policy across templates.');
  const evidence = [];
  for (const route of REPRESENTATIVE_DOCUMENTS) {
    await audit.goto(route);
    const links = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((node) => {
      const anchor = node as HTMLAnchorElement;
      const target = new URL(anchor.href, location.href);
      return {
        text: anchor.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? '',
        href: anchor.href,
        externalWeb: /^https?:$/.test(target.protocol) && target.origin !== location.origin,
        target: anchor.target || null,
        rel: anchor.rel.split(/\s+/).filter(Boolean),
      };
    }));
    evidence.push({ route, links });
  }
  const links = evidence.flatMap(({ route, links }) => links.map((link) => ({ route, ...link })));
  const unsafeExternal = links.filter(({ externalWeb, target, rel }) => externalWeb && (target !== '_blank' || !rel.includes('noopener') || !rel.includes('noreferrer')));
  const internalNewTabs = links.filter(({ externalWeb, target }) => !externalWeb && target === '_blank');
  await audit.attachJson('external-link-policy-ledger', { links, unsafeExternal, internalNewTabs });
  audit.observe('Links inspected across templates', links.length);
  expect(unsafeExternal, 'External links must use isolated new tabs').toEqual([]);
  expect(internalNewTabs, 'Internal navigation should stay in the current tab').toEqual([]);
  await audit.checkpoint('reviewed-link-policy-page');
});

staticTest('[CONTENT-005] images and diagrams remain loaded, labeled, and viewport-safe in both themes', staticEvidence('Capture reference images and diagrams in both visual themes with load, label, and viewport geometry.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One resizable Chromium project validates the visual reference assets.');
  expect(DECLARED_ROUTE_VISUALS.length, 'At least one reviewed route visual contract is required').toBeGreaterThan(0);
  const evidence: unknown[] = [];
  for (const contract of DECLARED_ROUTE_VISUALS) {
    await page.setViewportSize({ width: 390, height: 844 });
    await audit.goto(contract.path);
    expect(contract.items.length, `${contract.path} must declare every release-relevant visual`).toBeGreaterThan(0);
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((nextTheme) => {
        document.documentElement.classList.toggle('dark', nextTheme === 'dark');
        document.documentElement.dataset.themeMode = nextTheme;
      }, theme);
      const inspectedItems = [];
      for (const item of contract.items) {
        const locator = page.locator(item.selector);
        await expect(locator, `${contract.path}: ${item.name} must not disappear in ${theme} mode`).toHaveCount(item.exactCount);
        for (let index = 0; index < item.exactCount; index += 1) {
          const visual = locator.nth(index);
          await visual.scrollIntoViewIfNeeded();
          if (item.kind === 'img' || item.kind === 'picture') {
            const image = item.kind === 'picture' ? visual.locator('img') : visual;
            await expect.poll(async () => image.evaluate((node) => {
              const rendered = node as HTMLImageElement;
              return rendered.complete && rendered.naturalWidth > 0 && rendered.naturalHeight > 0;
            }), {
              message: `${contract.path} ${item.name} #${index + 1} must load after entering the viewport`,
              timeout: 8_000,
            }).toBe(true);
          }
        }
        const nodes = await locator.evaluateAll((elements, visualKind) => elements.map((element) => {
          const box = element.getBoundingClientRect();
          const image = visualKind === 'picture'
            ? element.querySelector('img')
            : element instanceof HTMLImageElement ? element : null;
          const svg = element instanceof SVGElement ? element : null;
          const title = element.querySelector('title')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          return {
            tag: element.tagName.toLowerCase(),
            box: box.toJSON(),
            viewportWidth: document.documentElement.clientWidth,
            textCharacters: element.textContent?.replace(/\s+/g, ' ').trim().length ?? 0,
            ariaHidden: element.getAttribute('aria-hidden'),
            accessibleLabel: element.getAttribute('aria-label') ?? title,
            image: image ? {
              src: image.currentSrc || image.src,
              alt: image.getAttribute('alt'),
              complete: image.complete,
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
            } : null,
            svg: svg ? {
              viewBox: svg.getAttribute('viewBox'),
              width: svg.getAttribute('width'),
              height: svg.getAttribute('height'),
            } : null,
          };
        }), item.kind);
        for (const [index, node] of nodes.entries()) {
          expect(node.box.width, `${contract.path} ${item.name} #${index + 1} must render with width`).toBeGreaterThan(0);
          expect(node.box.height, `${contract.path} ${item.name} #${index + 1} must render with height`).toBeGreaterThan(0);
          expect(node.box.left, `${contract.path} ${item.name} #${index + 1} must not clip left`).toBeGreaterThanOrEqual(-1);
          expect(node.box.right, `${contract.path} ${item.name} #${index + 1} must not clip right`).toBeLessThanOrEqual(node.viewportWidth + 1);
          if (item.kind === 'img' || item.kind === 'picture') {
            expect(node.image, `${contract.path} ${item.name} #${index + 1} must contain an image`).not.toBeNull();
            expect(node.image?.complete, `${contract.path} ${item.name} #${index + 1} must finish loading`).toBe(true);
            expect(node.image?.naturalWidth ?? 0, `${contract.path} ${item.name} #${index + 1} needs intrinsic width`).toBeGreaterThan(0);
            expect(node.image?.naturalHeight ?? 0, `${contract.path} ${item.name} #${index + 1} needs intrinsic height`).toBeGreaterThan(0);
            expect(node.image?.alt, `${contract.path} ${item.name} #${index + 1} must declare alt text`).not.toBeNull();
          } else if (item.kind === 'svg') {
            expect(node.svg, `${contract.path} ${item.name} #${index + 1} must remain an SVG`).not.toBeNull();
            expect(Boolean(node.svg?.viewBox || (node.svg?.width && node.svg.height)), `${contract.path} ${item.name} #${index + 1} needs intrinsic SVG geometry`).toBe(true);
            expect(node.ariaHidden === 'true' || node.accessibleLabel.length > 0, `${contract.path} ${item.name} #${index + 1} must be decorative or labeled`).toBe(true);
          } else {
            expect(node.textCharacters, `${contract.path} ${item.name} #${index + 1} must contain meaningful diagram content`).toBeGreaterThan(20);
          }
        }
        inspectedItems.push({ ...item, nodes });
      }
      evidence.push({ route: contract.path, theme, items: inspectedItems });
      await audit.checkpoint(`declared-visual-${contract.path.replace(/^\/+|\/+$/g, '').replaceAll('/', '-')}-${theme}`);
    }
  }
  await audit.attachJson('declared-route-visual-contract-ledger', evidence);
  audit.observe('Declared visual/theme combinations inspected', evidence.length, String(DECLARED_ROUTE_VISUALS.length * 2));
});

staticTest('[CONTENT-006] dense reference and tool layouts remain usable across widths', staticEvidence('Capture dense reference and tool layouts at narrow, tablet, and desktop widths with overflow geometry.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One resizable Chromium project probes narrow, tablet, and desktop geometry.');
  const routeContracts = [
    {
      route: '/resources/7-oh-taper-calculator',
      surfaces: [
        { name: 'per-dose control', selector: 'main #per-dose', exactCount: 1 },
        { name: 'summary cards', selector: 'main .grid.gap-2.sm\\:grid-cols-3 > div', exactCount: 3 },
        { name: 'schedule chart', selector: 'main .recharts-surface', exactCount: 1 },
        { name: 'schedule scroller', selector: 'main .taper-schedule-scroll', exactCount: 1 },
        { name: 'schedule table', selector: 'main table.taper-schedule-table', exactCount: 1 },
      ],
    },
    {
      route: '/pharmacology/chemical-structures',
      surfaces: [
        { name: 'reviewed structure figures', selector: 'main figure img[src^="/images/structures/"]', exactCount: 12 },
        { name: 'diagram-limit callout', selector: 'main blockquote', exactCount: 1 },
      ],
    },
    {
      route: '/virtual-na-meetings-now',
      surfaces: [
        { name: 'meeting search', selector: 'main input[aria-label="Search meetings"]', exactCount: 1 },
        { name: 'filter card', selector: 'main .field-card:has(input[aria-label="Search meetings"])', exactCount: 1 },
        { name: 'live pane', selector: 'main h2:text-is("Live now")', exactCount: 1 },
        { name: 'starting-soon pane', selector: 'main h2:text-is("Starting soon")', exactCount: 1 },
      ],
    },
    {
      route: '/about/changelog',
      surfaces: [
        { name: 'changelog article', selector: 'main article.prose-recovery', exactCount: 1 },
        { name: 'changelog release sections', selector: 'main article h2', minimumCount: 10 },
      ],
    },
  ] as const;
  const widths = [320, 768, 1440] as const;
  const evidence = [];
  for (const contract of routeContracts) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await audit.goto(contract.route);
      await waitForSettledUI(page);
      const overflow = await pageHasHorizontalOverflow(page);
      expect(overflow, `${contract.route} must not create page-level overflow at ${width}px`).toBe(0);
      const surfaces = [];
      for (const surface of contract.surfaces) {
        const locator = page.locator(surface.selector);
        if ('exactCount' in surface) {
          await expect(locator, `${contract.route} must retain exactly ${surface.exactCount} ${surface.name} at ${width}px`).toHaveCount(surface.exactCount);
        } else {
          await expect.poll(() => locator.count(), {
            message: `${contract.route} must retain at least ${surface.minimumCount} ${surface.name} at ${width}px`,
          }).toBeGreaterThanOrEqual(surface.minimumCount);
        }
        const count = await locator.count();
        const geometry = await locator.evaluateAll((nodes) => nodes.map((node) => {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return { box: box.toJSON(), display: style.display, visibility: style.visibility };
        }));
        expect(geometry.every(({ box, display, visibility }) => box.width > 0 && box.height > 0 && display !== 'none' && visibility !== 'hidden'), `${contract.route} ${surface.name} must remain visibly rendered at ${width}px`).toBe(true);
        surfaces.push({ ...surface, count, geometry });
      }
      evidence.push({ route: contract.route, width, overflow, surfaces });
    }
  }
  const expectedCoverage = routeContracts.flatMap(({ route }) => widths.map((width) => ({ route, width })));
  expect(expectedCoverage, 'The responsive matrix must retain four routes at three reviewed widths').toHaveLength(12);
  expect(evidence.map(({ route, width }) => ({ route, width })), 'Every declared route/width pair must produce one inspected record').toEqual(expectedCoverage);
  await audit.attachJson('wide-reference-responsive-ledger', evidence);
  await audit.checkpoint('wide-reference-desktop');
});

interactionTest('[CONTENT-007] long references scroll without lockups and retain navigation', interactionEvidence('Scroll progressively through each long reference and show the page and navigation remaining responsive.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One candidate Chromium project exercises long documents.');
  const routes = ['/about/changelog', '/start-here/7-oh-withdrawal-guide', '/compounds/7-oh'] as const;
  const evidence = [];
  for (const route of routes) {
    await audit.goto(route);
    await dismissSchedulingNotice(page);
    const result = await audit.step(`Scroll through ${route}`, 'Progressive scrolling reaches the lower document while page navigation remains responsive.', async () => page.evaluate(async () => {
        const started = performance.now();
        const height = document.documentElement.scrollHeight;
        for (const ratio of [0.2, 0.4, 0.6, 0.8, 1]) {
          window.scrollTo({ top: height * ratio, behavior: 'instant' });
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return {
          elapsedMs: performance.now() - started,
          height,
          finalScrollY: window.scrollY,
          mainVisible: Boolean(document.querySelector('main')),
          navigationLinks: document.querySelectorAll('nav a[href]').length,
        };
      }));
    expect(result.height, `${route} should exercise a genuinely long page`).toBeGreaterThan(2_000);
    expect(result.elapsedMs, `${route} should remain responsive during progressive scrolling`).toBeLessThan(2_000);
    expect(result.finalScrollY, `${route} should reach the lower document`).toBeGreaterThan(500);
    expect(result.mainVisible, `${route} must retain its primary content landmark`).toBe(true);
    expect(result.navigationLinks, `${route} should retain navigation`).toBeGreaterThan(0);
    evidence.push({ route, ...result });
  }
  expect(routes, 'The long-page contract must retain all three reviewed references').toHaveLength(3);
  expect(evidence.map(({ route }) => route), 'Every declared long reference must complete the scroll exercise').toEqual([...routes]);
  await audit.attachJson('long-page-stability-ledger', evidence);
  audit.observe('Long references exercised', evidence.length, String(routes.length));
});

staticTest('[CONTENT-008] production-to-candidate content parity ledger protects critical recovery paths', staticEvidence('Capture the paired production and candidate content ledger for critical headings and recovery actions.', 'candidate-desktop-chromium'), async ({ browser, page: candidate, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One candidate project produces the paired content ledger.');
  const production = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
  const normalizeHeading = (value: string) => normalize(value).replace(/\s*\([\d,]+\)$/, ' (#)');
  const ledger: Array<{
    contract: (typeof CRITICAL_CONTENT_CONTRACTS)[number];
    productionPath: string | null;
    candidateStatus: number | null;
    productionStatus: number | null;
    candidate: { headings: string[]; mainText: string; internalActions: string[] };
    production: { headings: string[]; mainText: string; internalActions: string[] };
    missingRequiredHeadings: string[];
    missingWarnings: string[];
    missingDestinations: string[];
    missingProductionHeadings: string[];
    unexpectedMissingProductionHeadings: string[];
    staleApprovedDifferences: string[];
  }> = [];
  try {
    for (const contract of CRITICAL_CONTENT_CONTRACTS) {
      const productionPath = resolveEnvironmentPath('production', contract.path);
      const [candidateResponse, productionResponse] = await Promise.all([
        candidate.goto(new URL(contract.path, ENVIRONMENTS.candidate.baseURL).href, { waitUntil: 'load' }),
        productionPath === null ? null : production.goto(new URL(productionPath, ENVIRONMENTS.production.baseURL).href, { waitUntil: 'load' }),
      ]);
      const inspect = (page: typeof candidate) => page.evaluate(() => ({
        headings: [...document.querySelectorAll('main h1, main h2, main h3')]
          .map((heading) => heading.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          .filter(Boolean),
        mainText: document.querySelector('main')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        internalActions: [...document.querySelectorAll<HTMLAnchorElement>('main a[href]')]
          .map((anchor) => {
            const destination = new URL(anchor.href, location.href);
            return destination.origin === location.origin ? destination.pathname.replace(/\/$/, '') || '/' : null;
          })
          .filter((path): path is string => path !== null),
      }));
      const [candidateValues, productionValues] = await Promise.all([
        inspect(candidate),
        productionPath === null ? { headings: [], mainText: '', internalActions: [] } : inspect(production),
      ]);
      const candidateHeadings = new Set(candidateValues.headings.map(normalizeHeading));
      const candidateText = normalize(candidateValues.mainText);
      const candidateDestinations = new Set(candidateValues.internalActions);
      const missingRequiredHeadings = contract.requiredHeadings.filter((heading) => !candidateHeadings.has(normalizeHeading(heading)));
      const missingWarnings = contract.requiredWarningFragments.filter((warning) => !candidateText.includes(normalize(warning)));
      const missingDestinations = contract.requiredCandidateDestinations.filter((path) => !candidateDestinations.has(path));
      const missingProductionHeadings = productionValues.headings.filter((heading) => !candidateHeadings.has(normalizeHeading(heading)));
      const approved = new Set(contract.approvedMissingProductionHeadings.map(normalizeHeading));
      const actualMissing = new Set(missingProductionHeadings.map(normalizeHeading));
      const unexpectedMissingProductionHeadings = missingProductionHeadings.filter((heading) => !approved.has(normalizeHeading(heading)));
      const staleApprovedDifferences = contract.approvedMissingProductionHeadings.filter((heading) => !actualMissing.has(normalizeHeading(heading)));
      const entry = {
        contract,
        productionPath,
        candidateStatus: candidateResponse?.status() ?? null,
        productionStatus: productionResponse?.status() ?? null,
        candidate: candidateValues,
        production: productionValues,
        missingRequiredHeadings,
        missingWarnings,
        missingDestinations,
        missingProductionHeadings,
        unexpectedMissingProductionHeadings,
        staleApprovedDifferences,
      };
      ledger.push(entry);

      const hasReviewIssue = candidateResponse?.status() !== 200
        || productionResponse?.status() !== 200
        || missingRequiredHeadings.length > 0
        || missingWarnings.length > 0
        || missingDestinations.length > 0
        || unexpectedMissingProductionHeadings.length > 0
        || staleApprovedDifferences.length > 0;
      if (hasReviewIssue || contract.path === '/') {
        const slug = contract.path === '/' ? 'home' : contract.path.replace(/^\/+|\/+$/g, '').replaceAll('/', '-');
        const candidateShot = testInfo.outputPath(`content-contract-${slug}-candidate.png`);
        const productionShot = testInfo.outputPath(`content-contract-${slug}-production.png`);
        await Promise.all([
          candidate.screenshot({ path: candidateShot, fullPage: false }),
          production.screenshot({ path: productionShot, fullPage: false }),
        ]);
        await Promise.all([
          testInfo.attach(`content-contract-${slug}-candidate`, { path: candidateShot, contentType: 'image/png' }),
          testInfo.attach(`content-contract-${slug}-production`, { path: productionShot, contentType: 'image/png' }),
        ]);
      }
    }
  } finally {
    await production.close();
  }
  await audit.attachJson('production-candidate-content-parity-ledger', ledger);
  audit.observe('Paired critical routes compared', ledger.length, String(CRITICAL_CONTENT_CONTRACTS.length));
  audit.observe('Unknown production-heading omissions', ledger.reduce((sum, item) => sum + item.unexpectedMissingProductionHeadings.length, 0), '0 unless explicitly reviewed');
  expect.soft(ledger.length, 'Every critical content contract must be evaluated').toBe(CRITICAL_CONTENT_CONTRACTS.length);
  for (const entry of ledger) {
    expect.soft(entry.productionPath, `${entry.contract.path} needs an approved production counterpart`).not.toBeNull();
    expect.soft(entry.candidateStatus, `${entry.contract.path} candidate must return 200`).toBe(200);
    expect.soft(entry.productionStatus, `${entry.productionPath ?? entry.contract.path} production must return 200`).toBe(200);
    expect.soft(entry.missingRequiredHeadings, `${entry.contract.path} must retain every release-critical heading`).toEqual([]);
    expect.soft(entry.missingWarnings, `${entry.contract.path} must retain every release-critical warning`).toEqual([]);
    expect.soft(entry.missingDestinations, `${entry.contract.path} must retain every release-critical CTA destination`).toEqual([]);
    expect.soft(entry.unexpectedMissingProductionHeadings, `${entry.contract.path} removed production headings require exact reviewed ledger entries`).toEqual([]);
    expect.soft(entry.staleApprovedDifferences, `${entry.contract.path} reviewed-difference entries must describe a current omission`).toEqual([]);
  }
  await audit.checkpoint('critical-content-contract-candidate-reference');
  audit.coverEnvironments('candidate', 'production');
});
