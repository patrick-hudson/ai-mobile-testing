import { test, expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { loggedGet, meta, pageHasHorizontalOverflow } from './helpers.js';

function candidateChromium(testInfo: Parameters<typeof meta>[0]): boolean {
  return meta(testInfo).environment === 'candidate' && testInfo.project.name.includes('chromium');
}

interactionTest('[SHELL-001] scheduling announcement links, dismisses, and stays dismissed', interactionEvidence('Dismiss the scheduling notice, reload the page, and show that the dated dismissal persists.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium shell audit.');
  await audit.goto('/');
  const banner = page.getByRole('complementary', { name: 'Federal scheduling status' });

  await audit.step('Inspect the scheduling notice', 'The notice exposes current status and links to the detailed ban page.', async () => {
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('link')).toHaveAttribute('href', '/compounds/7-oh-ban');
    await expect(banner).toContainText(/DEA has not banned 7-OH/i);
  });
  await audit.step('Dismiss and reload', 'Dismissal hides the banner and persists for this dated notice.', async () => {
    await page.getByRole('button', { name: 'Dismiss announcement' }).click();
    await expect(banner).toBeHidden();
    await page.reload({ waitUntil: 'load' });
    await expect(banner).toBeHidden();
  });
  await audit.assertRuntimeHealthy();
});

interactionTest('[SHELL-003] skip link is first, visible on focus, and targets main content', interactionEvidence('Press Tab and Enter and show the skip link becoming visible before focus moves to main content.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium keyboard audit.');
  await audit.goto('/start-here/welcome');
  await audit.step('Activate the first keyboard control', 'Skip to content becomes visible and moves focus to main.', async () => {
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  await audit.attachJson('axe-skip-link-state', axe);
  expect(axe.violations, 'Skip-link page state must have no automated WCAG A/AA violations').toEqual([]);
  await audit.checkpoint('skip-link-activated');
});

staticTest('[SHELL-004] footer exposes urgent, site, and safe external destinations', staticEvidence('Capture the footer with all urgent, site, community, and safely isolated external destinations.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop footer audit.');
  await audit.goto('/');
  const footer = page.locator('footer');
  await footer.scrollIntoViewIfNeeded();

  await audit.step('Inspect footer destinations', 'Urgent help, sitemap, project, and community destinations are present.', async () => {
    for (const name of ['Crisis and urgent help', 'Withdrawal help', 'Next support meeting', 'Site map', 'Changelog', 'Discord', 'GitHub']) {
      await expect(footer.getByRole('link', { name: new RegExp(name) })).toBeVisible();
    }
    const external = footer.locator('a[href^="http"]');
    const attributes = await external.evaluateAll((anchors) => anchors.map((node) => ({
      href: (node as HTMLAnchorElement).href,
      target: node.getAttribute('target'),
      rel: node.getAttribute('rel'),
    })));
    expect(attributes.length).toBeGreaterThan(2);
    expect(attributes.every(({ target, rel }) => target === '_blank' && rel?.includes('noopener') && rel.includes('noreferrer'))).toBe(true);
    await audit.attachJson('footer-external-links', attributes);
  });
  await audit.checkpoint('footer-destinations');
});

interactionTest('[SHELL-005] back-to-top appears on long content and returns immediately with reduced motion', interactionEvidence('Scroll the changelog, activate Back to top, and show the reduced-motion response returning to zero.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium long-page audit.');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await audit.goto('/about/changelog');
  await page.evaluate(() => window.scrollTo(0, 1_200));

  await audit.step('Use back to top', 'The control appears after scrolling and returns to the top.', async () => {
    const button = page.getByRole('button', { name: 'Back to top' });
    await expect(button).toBeVisible();
    await button.click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });
  await audit.assertRuntimeHealthy();
});

staticTest('[SHELL-006] representative pages have no page-level horizontal overflow', staticEvidence('Capture representative mobile page geometry with the complete page-level overflow matrix.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'mobile', 'Candidate mobile overflow audit.');
  const paths = ['/', '/start-here/welcome', '/resources/7-oh-taper-calculator', '/virtual-na-meetings-now', '/about/changelog'];
  const observations: Array<{ path: string; overflowPx: number }> = [];
  for (const path of paths) {
    await audit.goto(path);
    const overflowPx = await pageHasHorizontalOverflow(page);
    observations.push({ path, overflowPx });
    expect(overflowPx, `${path} should not create page-level horizontal scrolling`).toBeLessThanOrEqual(1);
  }
  await audit.attachJson('horizontal-overflow-matrix', observations);
});

interactionTest('[NAV-006] heading permalink copies a precise section without moving the reader', interactionEvidence('Activate a heading permalink and show its hash, clipboard confirmation, and stable scroll position.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium section-sharing audit.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await audit.goto('/compounds/7-oh');
  const anchor = page.getByRole('link', { name: 'Copy link to this section' }).first();
  await anchor.scrollIntoViewIfNeeded();
  const initial = await page.evaluate(() => window.scrollY);

  await audit.step('Copy a heading permalink', 'The hash and clipboard identify the heading while scroll stays stable.', async () => {
    const href = await anchor.getAttribute('href');
    await anchor.click();
    await expect(page).toHaveURL(new RegExp(`${href!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - initial)).toBeLessThan(3);
    await expect(page.locator('#copy-announce')).toHaveText('Link copied to clipboard');
  });
});

interactionTest('[NAV-007] previous and next controls follow the published guide sequence', interactionEvidence('Activate both previous and next reading controls and show their distinct published guide pages loading.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop pagination audit.');
  await audit.goto('/start-here/what-is-7-oh');
  await audit.step('Inspect sequential reading links', 'Previous and next destinations are different valid published pages.', async () => {
    const previous = page.getByRole('link', { name: /Previous/ }).last();
    const next = page.getByRole('link', { name: /Next/ }).last();
    const previousHref = await previous.getAttribute('href');
    const nextHref = await next.getAttribute('href');
    expect(previousHref).toMatch(/^\//);
    expect(nextHref).toMatch(/^\//);
    expect(previousHref).not.toBe(nextHref);
    const [previousResponse, nextResponse] = await Promise.all([
      loggedGet(page.request, audit, previousHref!), loggedGet(page.request, audit, nextHref!),
    ]);
    expect(previousResponse.status()).toBe(200);
    expect(nextResponse.status()).toBe(200);
    audit.observe('previous path', previousHref);
    audit.observe('next path', nextHref);

    await previous.click();
    await expect(page).toHaveURL(new RegExp(`${previousHref!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`));
    await expect(page.locator('main h1')).toBeVisible();
    await page.goBack({ waitUntil: 'domcontentloaded' });
    const restoredNext = page.getByRole('link', { name: /Next/ }).last();
    await restoredNext.click();
    await expect(page).toHaveURL(new RegExp(`${nextHref!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`));
    await expect(page.locator('main h1')).toBeVisible();
  });
});

staticTest('[NAV-008] category landing enumerates valid guide destinations', staticEvidence('Capture the category landing page with its complete unique published-destination ledger.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop category audit.');
  await audit.goto('/start-here');
  const links = page.locator('main a[href^="/start-here/"]');
  await audit.step('Collect category destinations', 'The category contains multiple unique published guide links.', async () => {
    const hrefs = await links.evaluateAll((anchors) => anchors.map((node) => (node as HTMLAnchorElement).getAttribute('href')).filter(Boolean));
    expect(new Set(hrefs).size).toBeGreaterThanOrEqual(8);
    const responses = await Promise.all([...new Set(hrefs)].map((href) => loggedGet(page.request, audit, href!)));
    expect(responses.every((response) => response.status() === 200)).toBe(true);
    await audit.attachJson('category-destinations', hrefs);
  });
});

interactionTest('[THEME-002] system mode follows live operating-system appearance changes', interactionEvidence('Choose system appearance, change the emulated device scheme, and show the page following it live.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'Candidate desktop system-theme audit.');
  await page.emulateMedia({ colorScheme: 'light' });
  await audit.goto('/');
  await page.getByRole('button', { name: /^Appearance:/ }).click();
  await page.getByRole('menuitemradio', { name: 'Use device setting' }).click();

  await audit.step('Change the emulated system scheme', 'System mode updates live while retaining system as the selected mode.', async () => {
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'system');
  });
  await audit.checkpoint('system-dark-theme');
});

staticTest('[HOME-003] homepage directory reaches every guide category', staticEvidence('Capture the homepage guide directory with all ten configured category destinations visible.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop homepage directory audit.');
  await audit.goto('/');
  const expected = ['/start-here', '/for-you', '/for-loved-ones', '/mat-suboxone', '/medications-supplements', '/post-acute', '/compounds', '/pharmacology', '/resources', '/about'];
  await audit.step('Find every category', 'All ten configured category destinations appear on the homepage.', async () => {
    for (const href of expected) await expect(page.locator(`main a[href="${href}"]`).first()).toBeVisible();
  });
  audit.observe('homepage categories', expected.length, '10');
});

staticTest('[HOME-004] Discord failure leaves a usable community path', staticEvidence('Capture the degraded community card after a simulated Discord failure with its usable invite link.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop dependency audit.');
  await page.route('https://discord.com/api/guilds/**', (route) => route.abort('failed'));
  await audit.goto('/');
  await audit.step('Inspect degraded community card', 'No spinner remains and the Discord invite is still usable.', async () => {
    await expect(page.getByLabel('Loading Discord widget')).toHaveCount(0);
    const discord = page.getByRole('link', { name: /Discord/ }).first();
    await expect(discord).toHaveAttribute('href', 'https://discord.gg/quitting7oh');
    await expect(discord).toBeVisible();
  });
  await audit.checkpoint('discord-failure-fallback');
});

staticTest('[CRISIS-001] crisis fast path keeps urgent actions above unnecessary chrome', staticEvidence('Capture the mobile crisis first viewport with urgent actions visible and nonessential navigation absent.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'mobile', 'Candidate mobile crisis-layout audit.');
  await audit.goto('/start-here/7-oh-withdrawal-help');
  await audit.step('Inspect focused crisis layout', 'The first urgent actions are visible without sidebar or guide-drawer chrome.', async () => {
    await expect(page.getByRole('button', { name: 'Open guide navigation' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Guide index' })).toHaveCount(0);
    const visibleActionCount = await page.locator('main a[href]').evaluateAll((anchors) => anchors.filter((anchor) => {
      const box = anchor.getBoundingClientRect();
      return box.top >= 0 && box.top < window.innerHeight && box.height >= 40;
    }).length);
    expect(visibleActionCount).toBeGreaterThanOrEqual(2);
  });
  await audit.checkpoint('crisis-first-viewport');
});

interactionTest('[SHARE-001] quickstart copy produces a useful Reddit starter block', interactionEvidence('Activate Reddit starter copy and show the clipboard block and accessible confirmation responding.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium sharing audit.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await audit.goto('/start-here/7-oh-withdrawal-quickstart');
  await audit.step('Copy starter links', 'Clipboard contains multiple absolute quitting7oh destinations and confirmation is announced.', async () => {
    await page.getByRole('button', { name: 'Copy Reddit starter links' }).click();
    await expect(page.getByRole('button', { name: 'Reddit links copied' })).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.match(/https:\/\/quitting7oh\.org\//g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    await expect(page.getByText('Reddit starter links copied to clipboard.')).toBeVisible();
    audit.observe('copied characters', text.length, 'Detailed share block');
  });
});

interactionTest('[REL-002] blocked local storage does not break current-page controls', interactionEvidence('Use theme and calculator controls with storage blocked and show their current-page responses surviving.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop privacy-mode audit.');
  await page.addInitScript(() => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      Object.defineProperty(Storage.prototype, method, { value: () => { throw new DOMException('Blocked for audit', 'SecurityError'); } });
    }
  });
  await audit.goto('/resources/7-oh-taper-calculator');

  await audit.step('Use theme and calculator with blocked storage', 'Controls apply in memory and no unhandled runtime error occurs.', async () => {
    await page.getByRole('button', { name: /^Appearance:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    const dose = page.getByLabel('Per-dose amount (mg)', { exact: true });
    await dose.fill('20');
    await dose.blur();
    await expect(page.getByText('80 mg', { exact: true }).first()).toBeVisible();
  });
  await audit.assertRuntimeHealthy();
});

staticTest('[REL-003] blocked analytics and community dependencies do not block urgent content', staticEvidence('Capture the page with third-party dependencies blocked and urgent first-party content still visible.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop third-party failure audit.');
  await page.route(/google-analytics|googletagmanager|discord\.com/, (route) => route.abort('failed'));
  await audit.goto('/');
  await audit.step('Use core content during third-party failures', 'Primary recovery and meeting links remain visible and operable.', async () => {
    await expect(page.locator('h1')).toContainText(/7-OH/);
    await expect(page.getByRole('link', { name: /Withdrawal quickstart/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /meeting/i }).first()).toBeVisible();
  });
  await audit.checkpoint('third-party-failure-home');
});
import { AxeBuilder } from '@axe-core/playwright';
