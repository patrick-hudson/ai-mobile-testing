import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { ALL_AUDIT_BY_ID } from '../audit/definitions.js';
import { expect, inventoriedStaticTest, staticEvidence, test } from '../fixtures/test.js';
import {
  GENERIC_ROUTE_AUDIT_ID,
  verifySharedGenericRouteExecutionPublication,
  verifySingleSiteRouteInventoryPublication,
  type SharedGenericRouteExecutionPublication,
  type SingleSiteRouteInventoryPublication,
} from '../shared/single-site-route-plan.mjs';

function loadPublication(): SingleSiteRouteInventoryPublication | SharedGenericRouteExecutionPublication | null {
  if (process.env.AUDIT_RUN_MODE !== 'single-site') return null;
  const publicationPath = process.env.AUDIT_SINGLE_SITE_ROUTE_INVENTORY;
  if (!publicationPath) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(publicationPath, 'utf8'));
  } catch (error) {
    throw new Error(`Generic route inventory could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sharedDescriptorDigest = process.env.AUDIT_SHARED_EXECUTION_DESCRIPTOR_DIGEST;
  const sharedPublicationDigest = process.env.AUDIT_SHARED_GENERIC_ROUTE_PUBLICATION_DIGEST;
  if (!verifySingleSiteRouteInventoryPublication(parsed)
    && !(typeof sharedDescriptorDigest === 'string' && typeof sharedPublicationDigest === 'string'
      && verifySharedGenericRouteExecutionPublication(parsed, {
        executionDescriptorDigest: sharedDescriptorDigest,
        publicationDigest: sharedPublicationDigest,
      }))) {
    throw new Error('Generic route inventory failed its digest and schema validation.');
  }
  return parsed;
}

const publication = loadPublication();
const definition = ALL_AUDIT_BY_ID.get(GENERIC_ROUTE_AUDIT_ID);
if (publication?.genericExecutions.length && !definition) {
  throw new Error(`Generic route audit definition ${GENERIC_ROUTE_AUDIT_ID} is unavailable.`);
}

for (const execution of publication?.genericExecutions ?? []) {
  inventoriedStaticTest(`[${GENERIC_ROUTE_AUDIT_ID}] generic inspection of ${execution.path}`, staticEvidence(`Capture a source-attributed generic inspection of the newly inventoried route ${execution.path}.`, 'all-projects'), execution.caseId, async ({ page, audit }, testInfo) => {
      test.skip(testInfo.project.name !== execution.targetId, 'The frozen inventory assigns generic inspection to one canonical target.');
      audit.setDefinition(definition!);

      const expected = new URL(execution.url);
      const response = await page.goto(execution.url, { waitUntil: 'domcontentloaded' });
      await page.evaluate(async () => {
        if ('fonts' in document) await document.fonts.ready;
      });
      const actual = new URL(page.url());
      const inspection = await audit.inspectPage();
      const main = page.locator('main:visible');
      const visibleH1 = page.locator('h1:visible');
      const documentLanguage = await page.locator('html').getAttribute('lang');
      const mainCharacters = (await main.innerText()).replace(/\s+/g, ' ').trim().length;
      const linkEvidence = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((node) => {
        const anchor = node as HTMLAnchorElement;
        let url: URL;
        try { url = new URL(anchor.href, window.location.href); } catch { return { href: anchor.getAttribute('href') ?? '', invalid: true, missingFragment: false, unsafeNewTab: false }; }
        const ownDocument = url.origin === window.location.origin && url.pathname === window.location.pathname;
        let missingFragment = false;
        if (ownDocument && url.hash) {
          try { missingFragment = document.getElementById(decodeURIComponent(url.hash.slice(1))) === null; } catch { missingFragment = true; }
        }
        const rel = new Set((anchor.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean));
        return {
          href: anchor.getAttribute('href') ?? '',
          invalid: !anchor.getAttribute('href') || /^javascript:/i.test(anchor.getAttribute('href') ?? ''),
          missingFragment,
          unsafeNewTab: anchor.target === '_blank' && (!rel.has('noopener') || (url.origin !== window.location.origin && !rel.has('noreferrer'))),
        };
      }));
      const accessibility = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();

      expect(response, 'The inventoried route must retain a navigation response').not.toBeNull();
      expect(response?.status(), 'The inventoried route must return HTTP 200').toBe(200);
      expect(response?.headers()['content-type'], 'The inventoried route must serve HTML').toContain('text/html');
      expect(actual.origin, 'The inventoried route must remain on the audited origin').toBe(expected.origin);
      expect(`${actual.pathname}${actual.search}`, 'The browser must render the exact frozen route identity').toBe(`${expected.pathname}${expected.search}`);
      expect(documentLanguage?.trim(), 'The document must declare a language').toBeTruthy();
      await expect(main, 'The route must expose visible primary content').toHaveCount(1);
      await expect(visibleH1, 'The route must expose exactly one visible page identity').toHaveCount(1);
      await expect(visibleH1).not.toHaveText(/^\s*$/);
      expect(mainCharacters, 'Primary content must not be an empty shell').toBeGreaterThan(120);
      expect(inspection.title.trim().length, 'The route title must identify the destination').toBeGreaterThan(8);
      expect(inspection.description?.trim().length ?? 0, 'The route must include a useful meta description').toBeGreaterThan(35);
      expect(inspection.brokenImages, 'Rendered images must load').toEqual([]);
      expect(inspection.horizontalOverflowPx, 'The route must not require page-level sideways scrolling').toBeLessThanOrEqual(1);
      expect(linkEvidence.filter(({ invalid }) => invalid), 'Links must have usable destinations').toEqual([]);
      expect(linkEvidence.filter(({ missingFragment }) => missingFragment), 'Same-page fragments must resolve').toEqual([]);
      expect(linkEvidence.filter(({ unsafeNewTab }) => unsafeNewTab), 'New tabs must be isolated').toEqual([]);
      expect(accessibility.violations, 'The generic route must have no automated WCAG A/AA violations').toEqual([]);

      audit.observe('Frozen inventory route', execution.url);
      audit.observe('Inventory source contributions', execution.sources.length, '> 0');
      audit.observe('Primary content characters', mainCharacters, '> 120');
      audit.observe('Automated accessibility violations', accessibility.violations.length, '0');
      await audit.attachJson('generic-route-inspection', { execution, inspection, linkEvidence, accessibility });
      await audit.checkpoint(`generic-route-${execution.caseId.toLowerCase()}`);
      await audit.assertRuntimeHealthy();
  });
}
