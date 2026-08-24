import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { ENVIRONMENTS, projectMetadata, resolveEnvironmentPath } from '../audit/environments.js';
import { REPRESENTATIVE_VISUAL_ROUTES } from '../audit/routes.js';
import { expect, staticEvidence, staticTest, test } from '../fixtures/test.js';

const FIXED_TIME = new Date('2026-08-17T15:00:00-05:00');
const LONG_PAGE_SEGMENTS = [
  { fraction: 0.25, suffix: 'segment-25' },
  { fraction: 0.5, suffix: 'segment-50' },
  { fraction: 0.75, suffix: 'segment-75' },
  { fraction: 1, suffix: 'bottom' },
] as const;

async function waitForStableDocumentHeight(page: Page): Promise<void> {
  let previousHeight = -1;
  let stableSamples = 0;
  for (let sample = 0; sample < 8; sample += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const currentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    stableSamples = currentHeight === previousHeight ? stableSamples + 1 : 0;
    previousHeight = currentHeight;
    if (stableSamples >= 2) return;
  }
}

async function scrollToDocumentFraction(page: Page, fraction: number): Promise<void> {
  await page.evaluate((position) => {
    const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, Math.round(maximum * position));
  }, fraction);
  await page.waitForTimeout(150);
}

for (const visualRoute of REPRESENTATIVE_VISUAL_ROUTES) {
  staticTest(`[CONTENT-002] candidate visual baseline for ${visualRoute.label}`, staticEvidence(`Capture paired production and candidate screenshots for the ${visualRoute.label} visual baseline in light and dark themes.`), async ({ browser, page, audit }, testInfo) => {
    test.setTimeout(240_000);
    const metadata = projectMetadata(testInfo.project.metadata);
    test.skip(metadata.environment !== 'candidate' || !metadata.visual, 'Visual baselines are candidate-only; production is an outcome reference, not a pixel reference.');
    const capturesPairedProduction = testInfo.project.name === 'candidate-mobile-chromium'
      || testInfo.project.name === 'candidate-desktop-chromium';

    await page.clock.install({ time: FIXED_TIME });
    await page.addInitScript(() => {
      localStorage.setItem('scheduling-banner-dismissed-2026-08', '1');
      localStorage.removeItem('meeting-join-history-v1');
    });
    await page.route('https://discord.com/api/guilds/**', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ presence_count: 321 }),
    }));

    await audit.goto(visualRoute.path);
    await waitForStableDocumentHeight(page);
    const mask = page.locator('[data-visual-dynamic], [aria-label$="members online"]');

    const geometry = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      const h1 = document.querySelector('h1');
      const h1Box = h1?.getBoundingClientRect() ?? null;
      const clippedControls = [...document.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]')]
        .filter((element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || box.width === 0 || box.height === 0) return false;
          if (box.bottom < 0 || box.top > window.innerHeight) return false;
          return box.left < -1 || box.right > viewportWidth + 1;
        })
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          label: element.getAttribute('aria-label') ?? element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 100) ?? '',
          box: element.getBoundingClientRect().toJSON(),
        }));
      return {
        viewportWidth,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        h1: h1Box?.toJSON() ?? null,
        clippedControls,
      };
    });

    expect(geometry.documentWidth - geometry.viewportWidth, 'Representative templates must not overflow the page').toBeLessThanOrEqual(1);
    expect(geometry.h1, 'A visible page title anchors the screenshot').not.toBeNull();
    expect(geometry.clippedControls, 'Visible interactive controls must fit in the viewport').toEqual([]);
    await audit.attachJson('visual-geometry-evidence', { ...visualRoute, fixedTime: FIXED_TIME.toISOString(), geometry });
    const fullPageScreenshot = geometry.documentHeight <= 30_000;
    audit.observe('Baseline capture mode', fullPageScreenshot ? 'full-page' : 'five viewport segments across the full document');

    await page.evaluate(() => {
      localStorage.setItem('theme', 'light');
      document.documentElement.classList.remove('dark');
      document.documentElement.dataset.themeMode = 'light';
      document.documentElement.style.colorScheme = 'light';
    });
    const candidateLightPath = testInfo.outputPath(`${visualRoute.label}-candidate-light.png`);
    await page.screenshot({ path: candidateLightPath, fullPage: fullPageScreenshot, mask: [mask], maskColor: '#777777', animations: 'disabled', caret: 'hide', scale: 'css', timeout: 90_000 });
    const comparisonGroup = `${visualRoute.label}-light-production-vs-candidate`;
    await audit.attachVisual('paired-candidate-light', { path: candidateLightPath, contentType: 'image/png' }, {
      attachmentKey: `${comparisonGroup}-actual`,
      comparisonGroup,
      memberRole: 'actual',
      route: visualRoute.path,
      observedState: `The candidate ${visualRoute.label} route is rendered in the light theme.`,
      rationale: `Compare the redesigned ${visualRoute.label} route with its production baseline.`,
      capturedAt: FIXED_TIME.toISOString(),
    });
    if (!fullPageScreenshot) {
      for (const segment of LONG_PAGE_SEGMENTS) {
        await scrollToDocumentFraction(page, segment.fraction);
        const candidateSegmentPath = testInfo.outputPath(`${visualRoute.label}-candidate-light-${segment.suffix}.png`);
        await page.screenshot({ path: candidateSegmentPath, fullPage: false, mask: [mask], maskColor: '#777777', animations: 'disabled', caret: 'hide', scale: 'css', timeout: 90_000 });
        await audit.attachVisual(`paired-candidate-light-${segment.suffix}`, { path: candidateSegmentPath, contentType: 'image/png' }, {
          attachmentKey: `${comparisonGroup}-actual-${segment.suffix}`,
          route: visualRoute.path,
          observedState: `The ${segment.suffix} viewport segment of the candidate ${visualRoute.label} route is visible in the light theme.`,
          rationale: `Inspect long-page layout behavior at the ${segment.suffix} position.`,
          capturedAt: FIXED_TIME.toISOString(),
        });
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    }

    const productionPath = resolveEnvironmentPath('production', visualRoute.path);
    if (productionPath !== null && capturesPairedProduction) {
      const productionPage = await browser.newPage({ viewport: page.viewportSize() ?? { width: 1440, height: 900 } });
      await productionPage.clock.install({ time: FIXED_TIME });
      await productionPage.addInitScript(() => {
        localStorage.setItem('scheduling-banner-dismissed-2026-08', '1');
        localStorage.setItem('theme', 'light');
      });
      await productionPage.route('https://discord.com/api/guilds/**', async (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ presence_count: 321 }),
      }));
      await productionPage.goto(new URL(productionPath, ENVIRONMENTS.production.baseURL).href, { waitUntil: 'domcontentloaded' });
      await productionPage.evaluate(async () => {
        if ('fonts' in document) await document.fonts.ready;
      });
      const productionLightPath = testInfo.outputPath(`${visualRoute.label}-production-light.png`);
      await productionPage.screenshot({ path: productionLightPath, fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css', timeout: 90_000 });
      await audit.attachVisual('paired-production-light', { path: productionLightPath, contentType: 'image/png' }, {
        attachmentKey: `${comparisonGroup}-baseline`,
        comparisonGroup,
        memberRole: 'baseline',
        route: productionPath,
        observedState: `The production ${visualRoute.label} route is rendered in the light theme.`,
        rationale: `Provide the production baseline for the redesigned ${visualRoute.label} route.`,
        capturedAt: FIXED_TIME.toISOString(),
      });

      const productionData = (await readFile(productionLightPath)).toString('base64');
      const candidateData = (await readFile(candidateLightPath)).toString('base64');
      const visualWidth = page.viewportSize()?.width ?? 1440;
      const comparisonWidth = Math.min(1600, visualWidth * 2);
      const differenceWidth = Math.max(180, Math.min(600, Math.floor(visualWidth / 2)));
      const comparisonPage = await browser.newPage({ viewport: { width: comparisonWidth, height: 900 } });
      await comparisonPage.setContent(`<!doctype html><html><head><style>
        *{box-sizing:border-box}body{margin:0;background:#111;color:#fff;font:16px system-ui}main{display:grid;grid-template-columns:1fr 1fr;align-items:start;gap:2px}figure{margin:0;background:#222}figcaption{position:sticky;top:0;z-index:2;padding:12px 16px;background:#111;font-weight:700}img{display:block;width:100%;height:auto}.diff{display:grid}.diff img{grid-area:1/1;width:100%}.diff img+img{mix-blend-mode:difference}</style></head><body><main><figure><figcaption>Production baseline · ${visualRoute.path}</figcaption><img src="data:image/png;base64,${productionData}"></figure><figure><figcaption>Beta candidate · ${visualRoute.path}</figcaption><img src="data:image/png;base64,${candidateData}"></figure></main></body></html>`);
      const sideBySidePath = testInfo.outputPath(`${visualRoute.label}-production-vs-candidate.png`);
      await comparisonPage.screenshot({ path: sideBySidePath, fullPage: true, scale: 'css', timeout: 90_000 });
      await audit.attachVisual('paired-production-vs-candidate', { path: sideBySidePath, contentType: 'image/png' }, {
        attachmentKey: `${comparisonGroup}-side-by-side`,
        comparisonGroup,
        memberRole: 'other',
        route: visualRoute.path,
        observedState: `Production and candidate ${visualRoute.label} captures are visible side by side.`,
        rationale: `Make layout and content differences easy to inspect without switching media.`,
        capturedAt: FIXED_TIME.toISOString(),
      });
      await comparisonPage.setContent(`<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;background:#000}.diff{display:grid;width:${differenceWidth}px}.diff img{grid-area:1/1;width:100%;height:auto}.diff img+img{mix-blend-mode:difference}</style></head><body><div class="diff"><img src="data:image/png;base64,${productionData}"><img src="data:image/png;base64,${candidateData}"></div></body></html>`);
      const differencePath = testInfo.outputPath(`${visualRoute.label}-difference-overlay.png`);
      await comparisonPage.screenshot({ path: differencePath, fullPage: true, scale: 'css', timeout: 90_000 });
      await audit.attachVisual('paired-difference-overlay', { path: differencePath, contentType: 'image/png' }, {
        attachmentKey: `${comparisonGroup}-diff`,
        comparisonGroup,
        memberRole: 'diff',
        route: visualRoute.path,
        observedState: `The visual difference overlay for ${visualRoute.label} is visible.`,
        rationale: `Highlight pixel-level differences between production and the candidate redesign.`,
        capturedAt: FIXED_TIME.toISOString(),
      });
      await comparisonPage.close();
      await productionPage.close();
      audit.observe('Production comparison path', productionPath);
      audit.observe('Paired visual artifacts', 4, 'production, candidate, side-by-side, and difference overlay');
    } else if (productionPath === null) {
      audit.finding({ severity: 'P2', title: 'No production visual counterpart', detail: `${visualRoute.path} is a candidate-only destination.`, blocking: false });
    } else {
      audit.observe('Production comparison coverage', 'Paired mobile and desktop Chromium visual projects own the production comparison artifact.');
    }
    await expect(page).toHaveScreenshot(`${visualRoute.label}-light.png`, {
      fullPage: fullPageScreenshot,
      mask: [mask],
      maskColor: '#777777',
      timeout: 90_000,
    });
    if (!fullPageScreenshot) {
      for (const segment of LONG_PAGE_SEGMENTS) {
        await scrollToDocumentFraction(page, segment.fraction);
        await expect(page).toHaveScreenshot(`${visualRoute.label}-light-${segment.suffix}.png`, {
          fullPage: false,
          mask: [mask],
          maskColor: '#777777',
          timeout: 90_000,
        });
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    }

    await page.evaluate(() => {
      localStorage.setItem('theme', 'dark');
      document.documentElement.classList.add('dark');
      document.documentElement.dataset.themeMode = 'dark';
      document.documentElement.style.colorScheme = 'dark';
    });
    await expect(page).toHaveScreenshot(`${visualRoute.label}-dark.png`, {
      fullPage: fullPageScreenshot,
      mask: [mask],
      maskColor: '#777777',
      timeout: 90_000,
    });
    if (!fullPageScreenshot) {
      for (const segment of LONG_PAGE_SEGMENTS) {
        await scrollToDocumentFraction(page, segment.fraction);
        await expect(page).toHaveScreenshot(`${visualRoute.label}-dark-${segment.suffix}.png`, {
          fullPage: false,
          mask: [mask],
          maskColor: '#777777',
          timeout: 90_000,
        });
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    }

    audit.observe('Baseline route', visualRoute.path);
    audit.observe('Frozen browser time', FIXED_TIME.toISOString());
    audit.observe('Themes captured', 2, '2');
    audit.observe('Long-page viewport samples per theme', fullPageScreenshot ? 1 : LONG_PAGE_SEGMENTS.length + 1, fullPageScreenshot ? '1' : '5');
    await audit.checkpoint(`${visualRoute.label}-dark-checkpoint`, { fullPage: false });
    await audit.assertRuntimeHealthy();
  });
}
