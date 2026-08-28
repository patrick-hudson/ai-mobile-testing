import { test, expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { evaluateCategoryIndexContract } from '../audit/page-oracles.js';
import { REVIEWED_FOOTER_ACTIONS, START_HERE_CATEGORY_INDEX_CONTRACT } from '../audit/routes.js';
import { activateSkipLinkAndEnterMain, auditMeta, isChromiumAuditProject, loggedGet, pageHasHorizontalOverflow, usesReviewedSiteContract } from './helpers.js';
import { CRISIS_ACTIONS } from './crisis-contract.js';

function currentSiteChromium(testInfo: Parameters<typeof auditMeta>[0]): boolean {
  return usesReviewedSiteContract(testInfo) && isChromiumAuditProject(testInfo);
}

interactionTest('[SHELL-001] scheduling announcement links, dismisses, and stays dismissed', interactionEvidence('Dismiss the scheduling notice, reload the page, and show that the dated dismissal persists.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium shell audit.');
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

interactionTest('[SHELL-003] skip link is first, visible on focus, and enters main content', interactionEvidence('Press Tab and Enter, prove the main fragment is targeted and visible, then show the next Tab entering main content.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium keyboard audit.');
  await audit.goto('/start-here/welcome');
  await audit.step('Activate the first keyboard control', 'Skip to content becomes visible, targets main, and makes its first control the next sequential focus stop.', async () => {
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    const skipEntry = await activateSkipLinkAndEnterMain(page);
    await audit.attachJson('skip-link-entry-evidence', skipEntry);
    expect(skipEntry.hash).toBe('#main-content');
    expect(skipEntry.targetMatchesFragment).toBe(true);
    expect(skipEntry.targetInViewport).toBe(true);
    expect(skipEntry.focusWithinMain).toBe(true);
    expect(skipEntry.focusedInViewport).toBe(true);
    expect(skipEntry.focusedUnoccluded).toBe(true);
    expect(skipEntry.focusedUsesFocusVisible).toBe(true);
  });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  await audit.attachJson('axe-skip-link-state', axe);
  expect(axe.violations, 'Skip-link page state must have no automated WCAG A/AA violations').toEqual([]);
});

staticTest('[SHELL-004] footer exposes urgent, site, and safe external destinations', staticEvidence('Capture the footer with exact reviewed labels, destinations, destination health, and external tab isolation.', 'candidate-desktop-chromium'), async ({ page, request, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One reviewed-site desktop footer audit.');
  await audit.goto('/');
  const footer = page.locator('footer');
  await footer.scrollIntoViewIfNeeded();

  await audit.step('Inspect footer destinations', 'Urgent help, sitemap, project, and community destinations are present.', async () => {
    const rendered = [];
    for (const expected of REVIEWED_FOOTER_ACTIONS) {
      const link = footer.getByRole('link', { name: expected.label, exact: true });
      await expect(link, `${expected.label} must retain its exact reviewed footer label`).toBeVisible();
      await expect(link).toHaveAttribute('href', expected.href);
      if (expected.target === null) await expect(link).not.toHaveAttribute('target', /.+/);
      else await expect(link).toHaveAttribute('target', expected.target);
      if (expected.rel === null) await expect(link).not.toHaveAttribute('rel', /.+/);
      else await expect(link).toHaveAttribute('rel', expected.rel);
      rendered.push({
        label: (await link.innerText()).replace(/\s+/g, ' ').trim(),
        href: await link.getAttribute('href'),
        target: await link.getAttribute('target'),
        rel: await link.getAttribute('rel'),
      });
    }
    const destinationHealth = [];
    for (const href of [...new Set(REVIEWED_FOOTER_ACTIONS.filter(({ href }) => href.startsWith('/')).map(({ href }) => href))]) {
      const response = await loggedGet(request, audit, href);
      expect(response.status(), `${href} must remain a working footer destination`).toBe(200);
      destinationHealth.push({ href, status: response.status(), finalUrl: response.url() });
    }
    const external = footer.locator('a[href^="http"]');
    const attributes = await external.evaluateAll((anchors) => anchors.map((node) => ({
      href: (node as HTMLAnchorElement).href,
      target: node.getAttribute('target'),
      rel: node.getAttribute('rel'),
    })));
    expect(attributes.length).toBeGreaterThanOrEqual(REVIEWED_FOOTER_ACTIONS.filter(({ target }) => target === '_blank').length);
    expect(attributes.every(({ target, rel }) => target === '_blank' && rel?.includes('noopener') && rel.includes('noreferrer'))).toBe(true);
    await audit.attachJson('footer-destination-contract', { contract: REVIEWED_FOOTER_ACTIONS, rendered, destinationHealth, external: attributes });
  });
  await audit.checkpoint('footer-destinations');
});

interactionTest('[SHELL-005] back-to-top appears on long content and returns immediately with reduced motion', interactionEvidence('Scroll the changelog, activate Back to top, and show the reduced-motion response returning to zero.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium long-page audit.');
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

staticTest('[SHELL-006] representative pages have no page-level horizontal overflow', staticEvidence('Capture representative mobile page geometry with the complete page-level overflow matrix.', 'candidate-mobile-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'mobile', 'Reviewed-site mobile overflow audit.');
  const paths = ['/', '/start-here/welcome', '/resources/7-oh-taper-calculator', '/virtual-na-meetings-now', '/about/changelog'];
  const observations: Array<{ path: string; overflowPx: number }> = [];
  for (const path of paths) {
    await audit.goto(path);
    const overflowPx = await pageHasHorizontalOverflow(page);
    observations.push({ path, overflowPx });
    expect(overflowPx, `${path} should not create page-level horizontal scrolling`).toBeLessThanOrEqual(1);
  }
  expect(paths, 'The mobile overflow contract must retain all five representative pages').toHaveLength(5);
  expect(observations.map(({ path }) => path), 'Every declared page must produce one overflow observation').toEqual(paths);
  await audit.attachJson('horizontal-overflow-matrix', observations);
  await audit.checkpoint('mobile-overflow-reviewed-page');
});

interactionTest('[NAV-006] heading permalink copies a precise section without moving the reader', interactionEvidence('Activate a heading permalink and show its hash, clipboard confirmation, and stable scroll position.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium section-sharing audit.');
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
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One reviewed-site desktop pagination audit.');
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

staticTest('[NAV-008] category landing enumerates valid guide destinations', staticEvidence('Capture the category landing page with its complete unique published-destination ledger.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One reviewed-site desktop category audit.');
  await audit.goto(START_HERE_CATEGORY_INDEX_CONTRACT.path);
  const evidence = await page.locator('main').evaluate((main) => {
    const groups = [...main.querySelectorAll(':scope section > ul[role="list"]')];
    const reportedCountText = [...main.querySelectorAll(':scope > header p')]
      .map((paragraph) => paragraph.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .find((text) => /^\d+ pages?$/.test(text)) ?? '';
    return {
      reportedPageCount: Number.isFinite(Number.parseInt(reportedCountText, 10))
        ? Number.parseInt(reportedCountText, 10)
        : null,
      groupCount: groups.length,
      items: groups.flatMap((group) => [...group.querySelectorAll(':scope > li')].map((item) => {
        const anchor = item.querySelector<HTMLAnchorElement>(':scope > a[href]');
        const box = item.getBoundingClientRect();
        const style = getComputedStyle(item);
        return {
          path: anchor ? new URL(anchor.href, window.location.href).pathname : '',
          title: item.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          lastUpdated: item.querySelector('time')?.getAttribute('datetime') ?? '',
          summary: item.querySelector(':scope > a > p')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          visible: box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        };
      })),
    };
  });
  const issues = evaluateCategoryIndexContract(START_HERE_CATEGORY_INDEX_CONTRACT, evidence);
  await audit.attachJson('category-destinations', {
    contract: START_HERE_CATEGORY_INDEX_CONTRACT,
    evidence,
    issues,
  });
  await audit.step('Verify the reviewed category index', 'The exact card order, metadata, grouping, count, and destinations agree with the reviewed inventory.', async () => {
    expect(issues, 'Arbitrary healthy routes cannot substitute for the reviewed category cards and metadata').toEqual([]);
    const responses = await Promise.all(evidence.items.map(({ path }) => loggedGet(page.request, audit, path)));
    expect(responses.every((response) => response.status() === 200)).toBe(true);
  });
  await audit.checkpoint('category-destination-directory');
});

interactionTest('[THEME-002] system mode follows live operating-system appearance changes', interactionEvidence('Choose system appearance, change the emulated device scheme, and show the page following it live.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'Reviewed-site desktop system-theme audit.');
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
});

staticTest('[HOME-003] homepage directory reaches every guide category', staticEvidence('Capture the homepage guide directory with all ten configured category destinations visible.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One reviewed-site desktop homepage directory audit.');
  await audit.goto('/');
  const expected = ['/start-here', '/for-you', '/for-loved-ones', '/mat-suboxone', '/medications-supplements', '/post-acute', '/compounds', '/pharmacology', '/resources', '/about'] as const;
  await audit.step('Find every category', 'All ten configured category destinations appear on the homepage.', async () => {
    for (const href of expected) await expect(page.locator(`main a[href="${href}"]`).first()).toBeVisible();
  });
  const discovered = [...new Set(await page.locator('main a[href]').evaluateAll((anchors) =>
    anchors.map((anchor) => (anchor as HTMLAnchorElement).getAttribute('href')).filter((href): href is string => href !== null)))];
  expect(expected, 'The reviewed homepage directory must retain ten guide categories').toHaveLength(10);
  expect(discovered.filter((href) => expected.includes(href as (typeof expected)[number])).sort(), 'The homepage must expose every reviewed guide category').toEqual([...expected].sort());
  audit.observe('homepage categories', expected.length, '10');
  await audit.checkpoint('homepage-guide-directory');
});

staticTest('[HOME-004] Discord failure leaves a usable community path', staticEvidence('Capture the degraded community card after a simulated Discord failure with its usable invite link.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One reviewed-site desktop dependency audit.');
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

staticTest('[CRISIS-001] crisis fast path keeps urgent actions above unnecessary chrome', staticEvidence('Capture the mobile crisis first viewport with urgent actions visible and nonessential navigation absent.', 'candidate-mobile-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'mobile', 'Reviewed-site mobile crisis-layout audit.');
  await audit.goto('/start-here/7-oh-withdrawal-help');
  await audit.step('Inspect focused crisis layout', 'The first urgent actions are visible without sidebar or guide-drawer chrome.', async () => {
    await expect(page.getByRole('button', { name: 'Open guide navigation' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Guide index' })).toHaveCount(0);
    await expect(page.locator('footer')).toHaveCount(0);
    const discord = page.getByRole('link', { name: 'Open Discord #sos', exact: true });
    const meeting = page.locator('main a[href]').filter({ hasText: /7-OH\/kratom meeting|Find the next live meeting/i }).first();
    for (const urgent of [discord, meeting]) {
      await expect(urgent).toBeVisible();
      const geometry = await urgent.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
      });
      expect(geometry.top, 'An immediate human-help action must begin in the first viewport').toBeGreaterThanOrEqual(0);
      expect(geometry.bottom, 'An immediate human-help action must be fully visible in the first viewport').toBeLessThanOrEqual(geometry.viewportHeight);
      expect(geometry.height, 'An immediate action must meet a 44px touch target').toBeGreaterThanOrEqual(44);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
    }
  });

  const actionEvidence = [];
  for (const expected of CRISIS_ACTIONS) {
    const action = page.getByRole('link', { name: expected.name, exact: typeof expected.name === 'string' });
    await expect(action, `${String(expected.name)} must remain rendered and usable`).toBeVisible();
    await expect(action).toHaveAttribute('href', expected.href);
    const geometry = await action.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height, left: box.left, right: box.right, viewportWidth: innerWidth };
    });
    expect(geometry.height, `${String(expected.name)} must meet a 44px touch target`).toBeGreaterThanOrEqual(44);
    expect(geometry.width, `${String(expected.name)} must have a usable touch width`).toBeGreaterThanOrEqual(44);
    expect(geometry.left, `${String(expected.name)} must not clip off the left edge`).toBeGreaterThanOrEqual(0);
    expect(geometry.right, `${String(expected.name)} must not clip off the right edge`).toBeLessThanOrEqual(geometry.viewportWidth);
    actionEvidence.push({ name: String(expected.name), href: expected.href, geometry });
  }
  await audit.attachJson('crisis-action-geometry', actionEvidence);
  await audit.checkpoint('crisis-first-viewport');
  await audit.assertRuntimeHealthy();
});

interactionTest('[SHARE-001] quickstart copy produces a useful Reddit starter block', interactionEvidence('Activate Reddit starter copy and show the clipboard block and accessible confirmation responding.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium sharing audit.');
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

interactionTest('[REL-002] blocked local storage does not break current-page controls', interactionEvidence('Use theme, sidebar, calculator, and meeting controls with storage blocked and show their current-page responses surviving.', 'candidate-desktop-chromium'), async ({ page, context, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One reviewed-site desktop privacy-mode audit.');
  await page.addInitScript(() => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      Object.defineProperty(Storage.prototype, method, { value: () => { throw new DOMException('Blocked for audit', 'SecurityError'); } });
    }
  });
  await audit.goto('/start-here/what-is-7-oh');

  await audit.step('Use theme and sidebar with blocked storage', 'Both controls apply in memory and remain reversible without persistence.', async () => {
    const storageFailures = await page.evaluate(() => (['getItem', 'setItem', 'removeItem'] as const).map((method) => {
      try {
        if (method === 'getItem') localStorage.getItem('audit-probe');
        else if (method === 'setItem') localStorage.setItem('audit-probe', 'value');
        else localStorage.removeItem('audit-probe');
        return { method, name: null };
      } catch (error) {
        return { method, name: error instanceof DOMException ? error.name : String(error) };
      }
    }));
    expect(storageFailures, 'The privacy-mode canary must prove all local-storage operations are blocked').toEqual([
      { method: 'getItem', name: 'SecurityError' },
      { method: 'setItem', name: 'SecurityError' },
      { method: 'removeItem', name: 'SecurityError' },
    ]);
    await page.getByRole('button', { name: /^Appearance:/ }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    const collapse = page.getByRole('button', { name: 'Collapse guide navigation' });
    await collapse.click();
    const expand = page.getByRole('button', { name: 'Expand guide navigation' });
    await expect(expand).toBeVisible();
    await expand.click();
    await expect(collapse).toBeVisible();
  });

  await audit.goto('/resources/7-oh-taper-calculator');
  await audit.step('Use the calculator with blocked storage', 'Editing calculator state still updates the exact current-page result.', async () => {
    const dose = page.getByLabel('Per-dose amount (mg)', { exact: true });
    await dose.fill('20');
    await dose.blur();
    await expect(page.getByText('Total daily: 80 mg (20 × 4)', { exact: true })).toBeVisible();
  });

  await page.clock.setFixedTime(new Date('2026-08-24T13:30:00Z'));
  await audit.goto('/next-kratom-support-meeting');
  await audit.step('Open a meeting with blocked storage', 'The exact rendered meeting destination still opens even though history cannot be persisted.', async () => {
    const expectedMeeting = {
      name: 'Kratom Anonymous — Discussion',
      platform: 'Zoom',
      destination: 'https://us06web.zoom.us/j/85416304667?pwd=pkbSAebEMTzfj65ldpcbekavV2Yi0k.1',
    } as const;
    const card = page.getByRole('heading', { level: 2, name: expectedMeeting.name, exact: true }).locator('..');
    await expect(card.getByText(expectedMeeting.platform, { exact: true })).toBeVisible();
    const join = card.getByRole('link', { name: `Join in ${expectedMeeting.platform}`, exact: true });
    await expect(join).toHaveAttribute('href', expectedMeeting.destination);
    const destination = expectedMeeting.destination;
    await context.route(destination, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Storage-blocked meeting</title><h1>Meeting request completed</h1>',
    }));
    let popup: import('@playwright/test').Page | null = null;
    try {
      [popup] = await Promise.all([page.waitForEvent('popup'), join.click()]);
      if (!popup) throw new Error('Blocked-storage meeting action did not open its destination.');
      await expect(popup).toHaveURL(destination);
      await expect(popup.getByRole('heading', { name: 'Meeting request completed' })).toBeVisible();
      await audit.holdSecondaryPageOutcome(popup, 'storage-blocked meeting destination');
    } finally {
      if (popup && !popup.isClosed()) await popup.close();
      await context.unroute(destination);
    }
  });
  await audit.assertRuntimeHealthy();
});

staticTest('[REL-003] blocked analytics, community, and meeting dependencies degrade locally', staticEvidence('Capture explicit community and meeting degradation while urgent first-party content and exact recovery paths remain usable.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One reviewed-site desktop third-party failure audit.');
  await page.route(/google-analytics|googletagmanager|discord\.com/, (route) => route.abort('failed'));
  await audit.goto('/');
  await audit.step('Use core content during analytics and community failures', 'Primary recovery remains available and the Discord surface settles to its exact invite instead of hanging.', async () => {
    await expect(page.locator('h1')).toContainText(/7-OH/);
    await expect(page.getByRole('link', { name: /Withdrawal quickstart/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /meeting/i }).first()).toBeVisible();
    await expect(page.getByLabel('Loading Discord widget')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Discord/ }).first()).toHaveAttribute('href', 'https://discord.gg/quitting7oh');
  });

  await page.route('**/live-meeting-index.json', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'simulated meeting dependency outage' }),
  }));
  audit.expectResponseStatus('/live-meeting-index.json', 503);
  await audit.goto('/next-kratom-support-meeting');
  await audit.step('Use meeting recovery during an index outage', 'The spinner settles to explicit failure copy and both reviewed directories remain usable.', async () => {
    await expect(page.getByText('Checking live NA and SMART meetings…')).toHaveCount(0);
    const fallback = page.locator('aside[aria-labelledby="live-general-meetings-heading"]');
    await expect(fallback.locator('p[aria-live="polite"]')).toContainText(/could not|unavailable|failed|try again|problem loading/i);
    const recoveryPaths = await fallback.getByRole('link', { name: /^Browse all/ }).evaluateAll((links) =>
      links.map((link) => (link as HTMLAnchorElement).getAttribute('href')).sort());
    expect(recoveryPaths).toEqual(['/virtual-na-meetings-now', '/virtual-smart-meetings-now'].sort());
  });
  await audit.checkpoint('meeting-dependency-failure-recovery');
  await audit.assertRuntimeHealthy();
});
import { AxeBuilder } from '@axe-core/playwright';
