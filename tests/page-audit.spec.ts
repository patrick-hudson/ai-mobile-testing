import { pageAuditDefinition } from '../audit/catalog.js';
import { ENVIRONMENTS, parseAuditProjectMetadata } from '../audit/environments.js';
import { evaluateRouteContract, normalizedPathname } from '../audit/page-oracles.js';
import { pageAuditApplicability } from '../audit/page-audit-family.js';
import { CANDIDATE_HTML_ROUTES } from '../audit/routes.js';
import { expect, staticEvidence, staticTest, test } from '../fixtures/test.js';

interface LinkEvidence {
  href: string;
  resolvedHref: string;
  text: string;
  external: boolean;
  externalWeb: boolean;
  target: string | null;
  rel: string[];
  fragmentExists: boolean | null;
}

for (const route of CANDIDATE_HTML_ROUTES) {
  const definition = pageAuditDefinition(route.path);
  const applicability = pageAuditApplicability(route.path);

  staticTest(`[${definition.id}] ${route.kind} route renders a complete, usable document`, staticEvidence(`Capture ${route.path} at representative scroll positions with its structure, links, network, and accessibility evidence.`, applicability), async ({ page, audit }, testInfo) => {
    audit.setDefinition(definition);
    const metadata = parseAuditProjectMetadata(testInfo.project.metadata);
    test.skip(!metadata.fullSweep, 'The complete route inventory runs only in full-sweep projects.');

    const resolvedPath = audit.environmentPath(route.path);
    test.skip(resolvedPath === null, 'This candidate page has no production-baseline equivalent.');
    if (resolvedPath === null) return;

    const response = await audit.step(
      `Open ${route.path}`,
      'The mapped route returns a successful HTML document and finishes loading.',
      async () => {
        const navigation = await page.goto(resolvedPath, { waitUntil: 'domcontentloaded' });
        await page.evaluate(async () => {
          if ('fonts' in document) await document.fonts.ready;
        });
        if (route.kind === 'search') {
          await expect(
            page.locator('main input[type="search"], main input[inputmode="search"], main input[role="searchbox"], main [role="search"] input').first(),
            'The client-rendered search control must hydrate before route semantics are inspected',
          ).toBeVisible();
        }
        if (route.kind === 'meeting') {
          await expect.poll(
            () => page.locator('main h2:visible, main h3:visible, main article:visible, main input:visible, main select:visible').count(),
            { message: 'The meeting surface must finish rendering a schedule, section, article, or control' },
          ).toBeGreaterThan(0);
        }
        return navigation;
      },
    );

    await audit.step('Verify the document response', 'The route is HTML, successful, and did not land on an error document.', async () => {
      expect(response, 'Navigation must produce an HTTP response').not.toBeNull();
      expect(response?.status(), 'Published pages must return HTTP 200').toBe(200);
      expect(response?.headers()['content-type'], 'Published pages must return HTML').toContain('text/html');
      await expect(page.locator('html')).toHaveAttribute('lang', /^en(?:-|$)/i);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(/page not found|application error|internal server error/i);
    });

    const inspection = await audit.step(
      'Inspect rendered structure and geometry',
      'One visible H1, complete metadata, loaded images, and no page-level horizontal overflow are present.',
      async () => audit.inspectPage(),
    );

    await audit.attachJson('page-geometry-evidence', {
      route,
      resolvedPath,
      inspection,
    });

    const routeIdentity = await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      };
      const main = document.querySelector('main');
      const mainHeadings = main ? [...main.querySelectorAll('h1')].filter(visible) : [];
      const visibleArticles = main ? [...main.querySelectorAll('article')].filter(visible) : [];
      const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null;
      const canonicalUrl = canonical ? new URL(canonical, window.location.href) : null;
      const textLength = (element: Element | null): number => (
        (element instanceof HTMLElement ? element.innerText : element?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .length
      );
      return {
        actualUrl: window.location.href,
        actualPathname: window.location.pathname,
        canonical,
        canonicalPathname: canonicalUrl?.pathname ?? null,
        canonicalOrigin: canonicalUrl?.origin ?? null,
        title: document.title.trim(),
        h1Text: (mainHeadings[0]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        mainH1Count: mainHeadings.length,
        mainCharacters: textLength(main),
        visibleArticleCount: visibleArticles.length,
        articleCharacters: Math.max(0, ...visibleArticles.map(textLength)),
        proseBlockLengths: main
          ? [...main.querySelectorAll('article p, article li, article blockquote')].filter(visible).map(textLength)
          : [],
        sectionHeadingCount: main ? [...main.querySelectorAll('h2, h3')].filter(visible).length : 0,
        mainInternalPaths: main
          ? [...main.querySelectorAll<HTMLAnchorElement>('a[href]')]
              .filter(visible)
              .map((anchor) => new URL(anchor.href, window.location.href))
              .filter((url) => url.origin === window.location.origin)
              .map((url) => url.pathname)
          : [],
        enabledFormControlCount: main
          ? [...main.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')]
              .filter((control) => visible(control) && !control.disabled && control.getAttribute('aria-disabled') !== 'true')
              .length
          : 0,
        searchInputs: main
          ? [...main.querySelectorAll<HTMLInputElement>('input[type="search"], input[inputmode="search"], input[role="searchbox"], [role="search"] input')]
              .filter(visible)
              .map((input) => {
                const labelledBy = (input.getAttribute('aria-labelledby') ?? '')
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((id) => document.getElementById(id)?.textContent ?? '')
                  .join(' ');
                return {
                  accessibleName: input.getAttribute('aria-label')
                    || labelledBy
                    || input.labels?.[0]?.textContent
                    || '',
                  disabled: input.disabled || input.getAttribute('aria-disabled') === 'true',
                };
              })
          : [],
        urgentLinkCount: main
          ? [...main.querySelectorAll<HTMLAnchorElement>('a[href]')]
              .filter(visible)
              .filter((anchor) => /^(?:tel:|sms:)/i.test(anchor.href)
                || /(?:988lifeline\.org|thehotline\.org|poison\.org|\/crisis-hotlines)/i.test(anchor.href))
              .length
          : 0,
      };
    });
    const expectedPathname = normalizedPathname(resolvedPath);
    const declaredRoutePaths = CANDIDATE_HTML_ROUTES
      .map(({ path }) => audit.environmentPath(path))
      .filter((path): path is string => path !== null);
    const expectedChildPaths = CANDIDATE_HTML_ROUTES
      .filter(({ path }) => path.startsWith(`${route.path}/`) && !path.slice(route.path.length + 1).includes('/'))
      .map(({ path }) => audit.environmentPath(path))
      .filter((path): path is string => path !== null);
    const routeContractIssues = evaluateRouteContract(route, routeIdentity, {
      environment: metadata.mode === 'single-site' ? 'candidate' : metadata.environment,
      expectedPathname,
      approvedCanonicalOrigins: [new URL(ENVIRONMENTS.production.baseURL).origin],
      expectedChildPaths,
      declaredRoutePaths,
    });
    const routeIdentityEvidence = {
      route,
      resolvedPath,
      expectedPathname,
      expectedChildPaths,
      approvedCanonicalOrigins: [new URL(ENVIRONMENTS.production.baseURL).origin],
      routeContractIssues,
      ...routeIdentity,
    };
    await audit.attachJson('route-identity-evidence', routeIdentityEvidence);

    await audit.step('Assert meaningful page semantics', 'The page is identified and contains substantive, visible content.', async () => {
      expect(inspection.title.trim().length, 'Document title should identify the page').toBeGreaterThan(8);
      expect(inspection.h1Count, 'Exactly one visible H1 should identify the page').toBe(1);
      expect(inspection.description?.trim().length ?? 0, 'Meta description should explain the destination').toBeGreaterThan(35);
      expect(inspection.brokenImages, 'Every rendered image must load').toEqual([]);
      expect(inspection.horizontalOverflowPx, 'The document must not require page-level sideways scrolling').toBeLessThanOrEqual(1);

      const h1 = page.locator('main h1:visible');
      await expect(h1).toHaveCount(1);
      await expect(h1).not.toHaveText(/^\s*$/);
      expect(routeContractIssues, 'Exact route identity and its kind-specific structure must match the reviewed contract').toEqual([]);
    });

    const linkEvidence = await audit.step(
      'Inspect navigation semantics',
      'Links use valid destinations, same-page fragments exist, and new tabs are isolated.',
      async () => page.locator('a[href]').evaluateAll((anchors): LinkEvidence[] => anchors.map((node) => {
        const anchor = node as HTMLAnchorElement;
        const url = new URL(anchor.href, window.location.href);
        const ownDocument = url.origin === window.location.origin && url.pathname === window.location.pathname;
        let fragmentId: string | null = null;
        if (ownDocument && url.hash) {
          try {
            fragmentId = decodeURIComponent(url.hash.slice(1));
          } catch {
            fragmentId = '__malformed_fragment__';
          }
        }
        return {
          href: anchor.getAttribute('href') ?? '',
          resolvedHref: url.href,
          text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
          external: url.origin !== window.location.origin,
          externalWeb: /^https?:$/.test(url.protocol) && url.origin !== window.location.origin,
          target: anchor.getAttribute('target'),
          rel: (anchor.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean),
          fragmentExists: fragmentId === null ? null : document.getElementById(fragmentId) !== null,
        };
      })),
    );

    const invalidLinks = linkEvidence.filter(({ href }) => href.trim() === '' || /^javascript:/i.test(href));
    const missingFragments = linkEvidence.filter(({ fragmentExists }) => fragmentExists === false);
    const unsafeNewTabs = linkEvidence.filter(({ target, rel }) => target === '_blank' && !rel.includes('noopener'));
    const unsafeExternalLinks = linkEvidence.filter(({ externalWeb, target, rel }) =>
      externalWeb && (target !== '_blank' || !rel.includes('noopener') || !rel.includes('noreferrer')),
    );
    const missingImageAlt = await page.locator('img:not([alt])').count();

    audit.observe('Route kind', route.kind);
    audit.observe('Resolved environment path', resolvedPath);
    audit.observe('Visible document characters', routeIdentity.mainCharacters, '> 120');
    audit.observe('Reviewed route H1', routeIdentity.h1Text, route.expectedH1);
    audit.observe('Reviewed route title', routeIdentity.title, route.expectedTitle);
    audit.observe('Route contract issues', routeContractIssues.length, '0');
    audit.observe('Horizontal overflow culprit candidates', inspection.horizontalOverflowCandidateCount, '0 when document overflow is 0');
    audit.observe('Horizontal overflow evidence truncated', inspection.horizontalOverflowTruncated, 'false');
    audit.observe('Links inspected', linkEvidence.length);
    audit.observe('Images missing alt attribute', missingImageAlt, '0');
    await audit.attachJson('page-content-evidence', {
      route,
      resolvedPath,
      inspection,
      linkSummary: {
        total: linkEvidence.length,
        internal: linkEvidence.filter(({ external }) => !external).length,
        external: linkEvidence.filter(({ external }) => external).length,
        invalidLinks,
        missingFragments,
        unsafeNewTabs,
        unsafeExternalLinks,
        links: linkEvidence,
      },
      headingOutline: await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((headings) =>
        headings.map((heading) => ({ level: Number(heading.tagName.slice(1)), text: heading.textContent?.trim() ?? '' })),
      ),
    });
    await audit.attachJson('network-response-evidence', {
      route: route.path,
      responses: audit.httpResponses,
      failedRequests: audit.failedRequests,
      badResponses: audit.badResponses,
    });

    const axeResults = await audit.step(
      'Scan rendered accessibility semantics',
      'The complete page has no automatically detectable WCAG A or AA violations.',
      async () => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze(),
    );
    await audit.attachJson('axe-page-scan', {
      route: route.path,
      violations: axeResults.violations,
      incomplete: axeResults.incomplete,
      passes: axeResults.passes.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.length })),
    });

    expect(invalidLinks, 'Empty and script URLs are not usable destinations').toEqual([]);
    expect(missingFragments, 'Same-page fragment links must identify an element').toEqual([]);
    expect(unsafeNewTabs, 'Links that open a tab must use noopener').toEqual([]);
    expect(unsafeExternalLinks, 'External web links must open safely in a new tab').toEqual([]);
    expect(missingImageAlt, 'Every image must declare its text alternative, including an explicit empty alternative when decorative').toBe(0);
    expect(axeResults.violations, 'Every published page must pass the automated WCAG A/AA scan').toEqual([]);

    const viewportEvidence = await page.evaluate(() => ({
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    }));
    const capturesReviewedViewport = metadata.mode === 'single-site' || metadata.environment === 'candidate';
    const samplesLongDocument = capturesReviewedViewport && viewportEvidence.documentHeight > viewportEvidence.viewportHeight * 1.5;
    const viewportSegments = samplesLongDocument
      ? [
          { label: 'top', fraction: 0 },
          { label: 'middle', fraction: 0.5 },
          { label: 'bottom', fraction: 1 },
        ]
      : [{ label: 'top', fraction: 0 }];
    for (const segment of viewportSegments) {
      await page.evaluate((fraction) => {
        const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        window.scrollTo(0, Math.round(maximum * fraction));
      }, segment.fraction);
      await page.waitForTimeout(100);
      await audit.checkpoint(`${definition.id}-rendered-${segment.label}`, { fullPage: false });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    audit.observe('Viewport evidence samples', viewportSegments.length, samplesLongDocument ? '3' : '1');
    await audit.attachJson('viewport-sampling-evidence', { ...viewportEvidence, segments: viewportSegments });
    await audit.assertRuntimeHealthy();
  });
}
import { AxeBuilder } from '@axe-core/playwright';
