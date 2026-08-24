import { test, expect, interactionEvidence, interactionTest } from '../fixtures/test.js';
import { meta, dismissSchedulingNotice } from './helpers.js';

interactionTest('[NAV-001] mobile guide drawer traps focus and closes by every supported method', interactionEvidence('Open the guide drawer, cycle focus, and close it by Escape, close button, and backdrop while showing focus and scroll restoration.', 'candidate-mobile-projects'), async ({ page, audit }, testInfo) => {
  const project = meta(testInfo);
  test.skip(project.environment !== 'candidate' || project.deviceClass !== 'mobile', 'Candidate mobile interaction audit.');

  await audit.goto('/start-here/what-is-7-oh');
  await dismissSchedulingNotice(page);
  await page.evaluate(() => window.scrollTo(0, 420));
  const initialScroll = await page.evaluate(() => window.scrollY);
  const opener = page.getByRole('button', { name: 'Open guide navigation' });
  const dialog = page.getByRole('dialog', { name: 'Guide navigation' });

  const assertClosedAndRestored = async () => {
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - initialScroll)).toBeLessThanOrEqual(2);
  };

  const openDrawer = async () => {
    await opener.click();
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Guide index' })).toBeVisible();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement)), 'Opening the modal must place focus inside it').toBe(true);
  };

  await audit.step('Open the guide drawer', 'A modal guide index opens and receives focus.', async () => {
    await opener.focus();
    await openDrawer();
  });

  await audit.step('Cycle focus in both directions', 'Tab and Shift+Tab remain trapped and wrap to the same starting control.', async () => {
    const focusableCount = await dialog.locator('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').evaluateAll((elements) => elements.filter((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }).length);
    expect(focusableCount, 'The open guide must expose multiple keyboard destinations').toBeGreaterThan(2);
    await page.evaluate(() => document.activeElement?.setAttribute('data-audit-focus-origin', 'true'));
    for (let index = 0; index < focusableCount; index += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `Tab ${index + 1} must remain in the modal`).toBe(true);
    }
    await expect(dialog.locator('[data-audit-focus-origin="true"]')).toBeFocused();
    for (let index = 0; index < focusableCount; index += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `Shift+Tab ${index + 1} must remain in the modal`).toBe(true);
    }
    await expect(dialog.locator('[data-audit-focus-origin="true"]')).toBeFocused();
  });

  await audit.step('Expand a category', 'The category pages appear inside the drawer.', async () => {
    await page.getByRole('button', { name: /expand post-acute/i }).click();
    await expect(page.getByRole('link', { name: /sleep recovery/i })).toBeVisible();
  });
  const axe = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  await audit.attachJson('axe-mobile-guide-drawer', axe);
  expect(axe.violations, 'The open guide drawer must have no automated WCAG A/AA violations').toEqual([]);

  await audit.step('Close with Escape', 'The drawer closes, focus returns, and page scroll is preserved.', async () => {
    await page.keyboard.press('Escape');
    await assertClosedAndRestored();
  });

  await audit.step('Close with the named close control', 'The visible close button dismisses the drawer and restores the opener and reading position.', async () => {
    await openDrawer();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await assertClosedAndRestored();
  });

  await audit.step('Close with the backdrop', 'Activating the unobscured backdrop dismisses the drawer and restores the opener and reading position.', async () => {
    await openDrawer();
    const overlay = page.locator('[data-slot="sheet-overlay"]');
    const box = await overlay.boundingBox();
    expect(box, 'The drawer backdrop must have measurable geometry').not.toBeNull();
    await overlay.click({ position: { x: Math.max(1, box!.width - 4), y: Math.max(1, box!.height / 2) } });
    await assertClosedAndRestored();
  });
  await audit.inspectPage();
  await audit.assertRuntimeHealthy();
});

interactionTest('[NAV-002] mobile categories expose their pages and current location', interactionEvidence('Open the mobile guide and collapse then expand a category while showing current-page state and links.', 'candidate-mobile-chromium'), async ({ page, audit }, testInfo) => {
  const project = meta(testInfo);
  test.skip(project.environment !== 'candidate' || project.deviceClass !== 'mobile' || !testInfo.project.name.includes('chromium'), 'Candidate mobile Chromium category audit.');
  await audit.goto('/post-acute/sleep-recovery');
  await dismissSchedulingNotice(page);
  const navigation = page.getByRole('navigation', { name: 'Guide index' });
  const current = navigation.getByRole('link', { name: /sleep recovery/i });
  await audit.step('Open, collapse, and expand the current category', 'The drawer identifies the current page and restores its sibling links after expansion.', async () => {
    await page.getByRole('button', { name: 'Open guide navigation' }).click();
    await expect(current).toHaveAttribute('aria-current', 'page');
    const collapse = navigation.getByRole('button', { name: /collapse post-acute/i });
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await collapse.click();
    await expect(navigation.getByRole('button', { name: /expand post-acute/i })).toHaveAttribute('aria-expanded', 'false');
    await expect(current).toBeHidden();
    await navigation.getByRole('button', { name: /expand post-acute/i }).click();
    await expect(current).toBeVisible();
    await expect(navigation.getByRole('link', { name: /dopamine recovery/i })).toBeVisible();
  });
  const categories = await navigation.locator('section > div > a[href]').evaluateAll((links) => links.map((link) => ({
    label: link.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    href: link.getAttribute('href'),
  })));
  audit.observe('Mobile categories exposed', categories.length, '10');
  await audit.attachJson('mobile-category-ledger', categories);
  expect(categories.length).toBe(10);
  await audit.assertRuntimeHealthy();
});

interactionTest('[NAV-003] desktop sidebar collapse persists without moving the article', interactionEvidence('Collapse, reload, and expand the sidebar and show persisted state without losing the reading position.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  const project = meta(testInfo);
  test.skip(project.environment !== 'candidate' || project.deviceClass !== 'desktop' || !testInfo.project.name.includes('chromium'), 'Candidate desktop Chromium audit.');

  await audit.goto('/start-here/what-is-7-oh');
  await dismissSchedulingNotice(page);
  await page.evaluate(() => window.scrollTo(0, 650));
  const before = await page.evaluate(() => window.scrollY);

  await audit.step('Collapse the sidebar', 'The rail collapses without changing reading position.', async () => {
    await page.getByRole('button', { name: 'Collapse guide navigation' }).click();
    await expect(page.getByRole('button', { name: 'Expand guide navigation' })).toBeVisible();
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThanOrEqual(2);
  });

  await audit.step('Reload the page', 'The collapsed state survives the reload.', async () => {
    await page.reload({ waitUntil: 'load' });
    await expect(page.getByRole('button', { name: 'Expand guide navigation' })).toBeVisible();
  });

  await audit.step('Expand the sidebar', 'Expanded navigation returns and persistence is cleared.', async () => {
    await page.getByRole('button', { name: 'Expand guide navigation' }).click();
    await expect(page.getByRole('button', { name: 'Collapse guide navigation' })).toBeVisible();
  });
  await audit.assertRuntimeHealthy();
});

interactionTest('[NAV-004] breadcrumb share copies the current canonical path', interactionEvidence('Activate breadcrumb sharing and show the current canonical page URL reaching the clipboard.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(meta(testInfo).environment !== 'candidate' || !testInfo.project.name.includes('chromium'), 'Candidate clipboard audit.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await audit.goto('/compounds/7-oh');

  await audit.step('Copy the page link', 'Clipboard contains the candidate origin and current path.', async () => {
    await page.getByRole('button', { name: 'Copy a link to this page' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(`${new URL(page.url()).origin}/compounds/7-oh`);
  });
  await audit.observe('clipboard URL', await page.evaluate(() => navigator.clipboard.readText()), 'Current environment URL');
  await audit.assertRuntimeHealthy();
});

interactionTest('[NAV-005] table of contents aligns and tracks document sections', interactionEvidence('Activate a table-of-contents link and show its hash and heading alignment below sticky chrome.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(meta(testInfo).environment !== 'candidate' || !testInfo.project.name.includes('chromium'), 'Candidate TOC audit.');
  await audit.goto('/compounds/7-oh');
  await dismissSchedulingNotice(page);

  const toc = page.getByRole('navigation', { name: 'Table of contents' }).first();
  const link = toc.getByRole('link').first();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^#/);
  await audit.step('Choose the first section', 'The URL hash changes and the heading clears sticky chrome.', async () => {
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    const top = await page.locator(href!).evaluate((element) => element.getBoundingClientRect().top);
    expect(top).toBeGreaterThanOrEqual(80);
    expect(top).toBeLessThan(180);
  });
  await audit.assertRuntimeHealthy();
});
import { AxeBuilder } from '@axe-core/playwright';
