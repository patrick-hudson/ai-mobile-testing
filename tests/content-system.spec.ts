import { ENVIRONMENTS, resolveEnvironmentPath } from '../audit/environments.js';
import { CANDIDATE_HTML_ROUTES, REPRESENTATIVE_VISUAL_ROUTES } from '../audit/routes.js';
import { expect, interactionEvidence, interactionTest, staticEvidence, staticTest, structuredEvidence, structuredTest, test } from '../fixtures/test.js';
import { dismissSchedulingNotice, inspectHtmlDestination, loggedGet, meta, pageHasHorizontalOverflow, waitForSettledUI } from './helpers.js';

const REPRESENTATIVE_DOCUMENTS = [
  '/',
  '/start-here/welcome',
  '/compounds/7-oh',
  '/resources/7-oh-taper-calculator',
  '/virtual-na-meetings-now',
  '/about/changelog',
] as const;

function candidateDesktopChromium(testInfo: Parameters<typeof meta>[0]): boolean {
  return testInfo.project.name === 'candidate-desktop-chromium';
}

staticTest('[HOME-002] support-right-now panel exposes live, upcoming, and fallback help paths', staticEvidence('Capture the hydrated support panel, its current state labels, and every urgent-help destination.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One candidate Chromium project validates the hydrated support panel.');
  await audit.goto('/');
  const panel = page.locator('section[aria-labelledby="right-now-title"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Support right now' })).toBeVisible();
  await expect(panel.getByRole('link', { name: /Discord/i })).toHaveAttribute('href', 'https://discord.gg/quitting7oh');
  await expect(panel.getByRole('link', { name: /active withdrawal/i })).toHaveAttribute('href', '/start-here/7-oh-withdrawal-help');
  await expect(panel.getByRole('link', { name: /meeting/i }).first()).toBeVisible();
  await expect(panel.getByRole('link', { name: /Browse NA|Join|Full schedule|All 7-OH/i }).first()).toBeVisible();
  const links = await panel.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => ({
    text: anchor.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    href: (anchor as HTMLAnchorElement).href,
    target: anchor.getAttribute('target'),
    rel: anchor.getAttribute('rel'),
  })));
  audit.observe('Support actions', links.length, 'At least four distinct routes to immediate or peer support');
  await audit.attachJson('support-right-now-state', { text: await panel.innerText(), links });
  await audit.checkpoint('support-right-now');
  expect(links.length).toBeGreaterThanOrEqual(4);
  await audit.assertRuntimeHealthy();
});

staticTest('[CONTENT-001] representative documents keep valid landmarks and heading order', staticEvidence('Capture representative document outlines with their landmarks, headings, descriptions, and canonical metadata.'), async ({ page, audit }, testInfo) => {
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
          header: document.querySelectorAll('body > header, header').length,
          main: document.querySelectorAll('main').length,
          footer: document.querySelectorAll('body > footer, footer').length,
          nav: document.querySelectorAll('nav').length,
        },
      };
    });
    expect(structure.h1Count, `${route} must have one H1`).toBe(1);
    expect(structure.skippedLevels, `${route} must not skip heading levels`).toEqual([]);
    expect(structure.landmarks.main, `${route} must have one main landmark`).toBe(1);
    expect(structure.description.length, `${route} needs a substantive description`).toBeGreaterThan(35);
    expect(structure.canonical, `${route} needs a canonical URL`).toMatch(/^https:\/\//);
    evidence.push({ route, ...structure });
  }
  await audit.attachJson('document-structure-ledger', evidence);
  audit.observe('Representative outlines inspected', evidence.length, String(REPRESENTATIVE_DOCUMENTS.length));
});

structuredTest('[CONTENT-003] every published candidate route resolves without a broken internal destination', structuredEvidence('Retain every resolved internal destination, redirect disposition, status, and content type without unrelated media.'), async ({ request, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One candidate project performs the complete internal destination crawl.');
  const results = [];
  for (const route of CANDIDATE_HTML_ROUTES) {
    results.push({ path: route.path, kind: route.kind, ...await inspectHtmlDestination(request, audit, route.path) });
  }
  const broken = results.filter(({ valid }) => !valid);
  audit.observe('Published internal destinations crawled', results.length, String(CANDIDATE_HTML_ROUTES.length));
  await audit.attachJson('network-internal-link-ledger', { results, broken });
  expect(broken, 'Every destination in the reviewed route inventory must serve HTML directly').toEqual([]);
});

staticTest('[CONTENT-004] internal and external links follow tab-isolation policy', staticEvidence('Capture representative rendered link sets with their target and rel isolation attributes.'), async ({ page, audit }, testInfo) => {
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
});

staticTest('[CONTENT-005] images and diagrams remain loaded, labeled, and viewport-safe in both themes', staticEvidence('Capture reference images and diagrams in both visual themes with load, label, and viewport geometry.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One resizable Chromium project validates the visual reference assets.');
  const routes = ['/brand', '/compounds/chemical-structures', '/about/site-architecture'] as const;
  const evidence = [];
  for (const route of routes) {
    await page.setViewportSize({ width: 390, height: 844 });
    await audit.goto(route);
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((nextTheme) => {
        document.documentElement.classList.toggle('dark', nextTheme === 'dark');
        document.documentElement.dataset.themeMode = nextTheme;
      }, theme);
      const images = await page.locator('img').evaluateAll((nodes) => nodes.map((node) => ({
        src: (node as HTMLImageElement).currentSrc || (node as HTMLImageElement).src,
        alt: node.getAttribute('alt'),
        naturalWidth: (node as HTMLImageElement).naturalWidth,
        box: node.getBoundingClientRect().toJSON(),
        viewportWidth: document.documentElement.clientWidth,
      })));
      const broken = images.filter(({ naturalWidth }) => naturalWidth === 0);
      const unlabeled = images.filter(({ alt }) => alt === null);
      const clipped = images.filter(({ box, viewportWidth }) => box.left < -1 || box.right > viewportWidth + 1);
      expect(broken, `${route} ${theme} images must load`).toEqual([]);
      expect(unlabeled, `${route} ${theme} images must declare alt text`).toEqual([]);
      expect(clipped, `${route} ${theme} images must fit their viewport`).toEqual([]);
      evidence.push({ route, theme, images, broken, unlabeled, clipped });
    }
  }
  await audit.attachJson('image-theme-ledger', evidence);
  audit.observe('Image/theme combinations inspected', evidence.length, String(routes.length * 2));
  await audit.checkpoint('reference-images-dark');
});

staticTest('[CONTENT-006] dense reference and tool layouts remain usable across widths', staticEvidence('Capture dense reference and tool layouts at narrow, tablet, and desktop widths with overflow geometry.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One resizable Chromium project probes narrow, tablet, and desktop geometry.');
  const routes = ['/resources/7-oh-taper-calculator', '/compounds/chemical-structures', '/virtual-na-meetings-now', '/about/changelog'] as const;
  const widths = [320, 768, 1440] as const;
  const evidence = [];
  for (const route of routes) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await audit.goto(route);
      await waitForSettledUI(page);
      const overflow = await pageHasHorizontalOverflow(page);
      const controls = await page.locator('main button:visible, main input:visible, main select:visible, main a[href]:visible').count();
      evidence.push({ route, width, overflow, controls });
      expect(overflow, `${route} must not create page-level overflow at ${width}px`).toBe(0);
      expect(controls, `${route} must retain a usable action at ${width}px`).toBeGreaterThan(0);
    }
  }
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
    expect(result.navigationLinks, `${route} should retain navigation`).toBeGreaterThan(0);
    evidence.push({ route, ...result });
  }
  await audit.attachJson('long-page-stability-ledger', evidence);
  audit.observe('Long references exercised', evidence.length, String(routes.length));
});

staticTest('[CONTENT-008] production-to-candidate content parity ledger protects critical recovery paths', staticEvidence('Capture the paired production and candidate content ledger for critical headings and recovery actions.'), async ({ browser, audit }, testInfo) => {
  test.skip(!candidateDesktopChromium(testInfo), 'One candidate project produces the paired content ledger.');
  const routes = ['/', '/start-here/welcome', '/compounds/7-oh', '/resources/7-oh-taper-calculator', '/virtual-na-meetings-now'] as const;
  const candidate = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const production = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const ledger = [];
  for (const route of routes) {
    const productionPath = resolveEnvironmentPath('production', route);
    expect(productionPath, `${route} needs an approved production counterpart`).not.toBeNull();
    if (productionPath === null) continue;
    await Promise.all([
      candidate.goto(new URL(route, ENVIRONMENTS.candidate.baseURL).href, { waitUntil: 'load' }),
      production.goto(new URL(productionPath, ENVIRONMENTS.production.baseURL).href, { waitUntil: 'load' }),
    ]);
    const inspect = (page: typeof candidate) => page.evaluate(() => ({
      h1: document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      headings: [...document.querySelectorAll('main h2, main h3')].map((heading) => heading.textContent?.replace(/\s+/g, ' ').trim() ?? '').filter(Boolean),
      mainCharacters: document.querySelector('main')?.textContent?.replace(/\s+/g, ' ').trim().length ?? 0,
      internalActions: [...document.querySelectorAll<HTMLAnchorElement>('main a[href^="/"]')].map((anchor) => anchor.getAttribute('href')).filter(Boolean),
    }));
    const [candidateValues, productionValues] = await Promise.all([inspect(candidate), inspect(production)]);
    const normalizedCandidateHeadings = new Set(candidateValues.headings.map((heading) => heading.toLowerCase()));
    const missingProductionHeadings = productionValues.headings.filter((heading) => !normalizedCandidateHeadings.has(heading.toLowerCase()));
    const characterRatio = productionValues.mainCharacters > 0 ? candidateValues.mainCharacters / productionValues.mainCharacters : null;
    ledger.push({ route, productionPath, candidate: candidateValues, production: productionValues, characterRatio, missingProductionHeadings });
    expect(candidateValues.h1, `${route} candidate H1 must remain present`).not.toBe('');
    expect(productionValues.h1, `${productionPath} production H1 must be available for comparison`).not.toBe('');
    expect(characterRatio ?? 0, `${route} candidate content must retain at least 60% of baseline text volume`).toBeGreaterThanOrEqual(0.6);
    expect(candidateValues.internalActions.length, `${route} must retain internal next actions`).toBeGreaterThan(0);
  }
  const home = ledger.find(({ route }) => route === '/');
  expect(home?.candidate.internalActions).toContain('/start-here/7-oh-withdrawal-help');
  expect(home?.candidate.internalActions.some((href) => href?.includes('meeting'))).toBe(true);
  await audit.attachJson('production-candidate-content-parity-ledger', ledger);
  audit.observe('Paired critical routes compared', ledger.length, String(routes.length));
  audit.observe('Candidate-only or renamed baseline headings', ledger.reduce((sum, item) => sum + item.missingProductionHeadings.length, 0), 'Review as intentional redesign differences');
  const candidateShot = testInfo.outputPath('content-parity-candidate.png');
  const productionShot = testInfo.outputPath('content-parity-production.png');
  await candidate.screenshot({ path: candidateShot, fullPage: false });
  await production.screenshot({ path: productionShot, fullPage: false });
  await testInfo.attach('content-parity-candidate', { path: candidateShot, contentType: 'image/png' });
  await testInfo.attach('content-parity-production', { path: productionShot, contentType: 'image/png' });
  await candidate.close();
  await production.close();
});
