import { test, expect, interactionEvidence, interactionTest } from '../fixtures/test.js';
import { REVIEWED_GUIDE_CATEGORIES } from '../audit/routes.js';
import { auditMeta, dismissSchedulingNotice, isChromiumAuditProject, loggedGet, usesReviewedSiteContract } from './helpers.js';

interactionTest('[NAV-001] mobile guide drawer traps focus and closes by every supported method', interactionEvidence('Open the guide drawer, cycle focus, and close it by Escape, close button, and backdrop while showing focus and scroll restoration.', 'candidate-mobile-projects'), async ({ page, audit }, testInfo) => {
  const project = auditMeta(testInfo);
  test.skip(!usesReviewedSiteContract(testInfo) || project.deviceClass !== 'mobile', 'Reviewed-site mobile interaction audit.');

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

  await audit.step('Cycle focus in both directions', 'Tab moves between distinct controls and wraps from each modal boundary without escaping.', async () => {
    const focusables = await dialog.locator('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').evaluateAll((elements) => elements.flatMap((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (box.width <= 0 || box.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return [];
      return [{
        tag: element.tagName.toLowerCase(),
        label: element.getAttribute('aria-label') ?? element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 100) ?? '',
      }];
    }).map((entry, index) => ({ ...entry, index })));
    await dialog.locator('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').evaluateAll((elements) => {
      let visibleIndex = 0;
      for (const element of elements) {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (box.width <= 0 || box.height <= 0 || style.visibility === 'hidden' || style.display === 'none') continue;
        element.setAttribute('data-audit-focus-index', String(visibleIndex));
        visibleIndex += 1;
      }
    });
    await audit.attachJson('mobile-guide-focusable-ledger', focusables);
    expect(focusables.length, 'The open guide must expose multiple keyboard destinations').toBeGreaterThan(2);

    const first = dialog.locator('[data-audit-focus-index="0"]');
    const lastIndex = focusables.length - 1;
    const last = dialog.locator(`[data-audit-focus-index="${lastIndex}"]`);
    const readFocus = () => dialog.evaluate((element) => {
      const focused = document.activeElement;
      return {
        insideDialog: Boolean(focused && element.contains(focused)),
        index: focused?.getAttribute('data-audit-focus-index') ?? null,
        tag: focused?.tagName.toLowerCase() ?? 'none',
        label: focused?.getAttribute('aria-label') ?? focused?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 100) ?? '',
      };
    });

    await first.focus();
    const origin = await readFocus();
    await page.keyboard.press('Tab');
    const next = await readFocus();
    await last.focus();
    await page.keyboard.press('Tab');
    const forwardWrap = await readFocus();
    await first.focus();
    await page.keyboard.press('Shift+Tab');
    const reverseWrap = await readFocus();
    const focusCycle = { origin, next, forwardWrap, reverseWrap, lastIndex };
    await audit.attachJson('mobile-guide-focus-cycle', focusCycle);

    expect(origin).toMatchObject({ insideDialog: true, index: '0' });
    expect(next.insideDialog).toBe(true);
    expect(next.index).not.toBe(origin.index);
    expect(forwardWrap).toMatchObject({ insideDialog: true, index: '0' });
    expect(reverseWrap).toMatchObject({ insideDialog: true, index: String(lastIndex) });
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
  const project = auditMeta(testInfo);
  test.skip(!usesReviewedSiteContract(testInfo) || project.deviceClass !== 'mobile' || !isChromiumAuditProject(testInfo), 'Reviewed-site mobile Chromium category audit.');
  await audit.goto('/post-acute/sleep-recovery');
  await dismissSchedulingNotice(page);
  const navigation = page.getByRole('navigation', { name: 'Guide index' });
  const current = navigation.getByRole('link', { name: /sleep recovery/i });
  await audit.step('Open, collapse, and expand the current category', 'The drawer identifies the current page and restores its sibling links after expansion.', async () => {
    await page.getByRole('button', { name: 'Open guide navigation' }).click();
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current).toHaveAttribute('href', '/post-acute/sleep-recovery');
    const collapse = navigation.getByRole('button', { name: /collapse post-acute/i });
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await collapse.click();
    await expect(navigation.getByRole('button', { name: /expand post-acute/i })).toHaveAttribute('aria-expanded', 'false');
    await expect(current).toBeHidden();
    await navigation.getByRole('button', { name: /expand post-acute/i }).click();
    await expect(current).toBeVisible();
    const sibling = navigation.getByRole('link', { name: /dopamine recovery/i });
    await expect(sibling).toBeVisible();
    await expect(sibling).toHaveAttribute('href', '/post-acute/dopamine-recovery');
  });
  const categories = await navigation.locator('section > div > a[href]').evaluateAll((links) => links.map((link) => ({
    label: link.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    href: link.getAttribute('href'),
  })));
  audit.observe('Mobile categories exposed', categories.length, '10');
  const expectedCategories = REVIEWED_GUIDE_CATEGORIES.map(({ path: href, label }) => ({ label, href }));
  const responses = await Promise.all(expectedCategories.map(({ href }) => loggedGet(page.request, audit, href)));
  await audit.attachJson('mobile-category-ledger', { expected: expectedCategories, rendered: categories });
  expect(categories, 'The drawer must expose the exact reviewed category labels, order, and destinations').toEqual(expectedCategories);
  expect(responses.every((response) => response.status() === 200), 'Every reviewed category destination must load').toBe(true);
  await audit.assertRuntimeHealthy();
});

interactionTest('[NAV-003] desktop sidebar collapse persists without moving the article', interactionEvidence('Collapse, reload, and expand the sidebar and show persisted state without losing the reading position.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  const project = auditMeta(testInfo);
  test.skip(!usesReviewedSiteContract(testInfo) || project.deviceClass !== 'desktop' || !isChromiumAuditProject(testInfo), 'Reviewed-site desktop Chromium audit.');

  await audit.goto('/start-here/what-is-7-oh');
  await dismissSchedulingNotice(page);
  await page.evaluate(() => window.scrollTo(0, 650));
  const before = await page.locator('main article h2, main article h3').evaluateAll((headings) => {
    const visible = headings
      .map((heading) => ({ heading, box: heading.getBoundingClientRect() }))
      .filter(({ box }) => box.bottom > 80 && box.top < window.innerHeight);
    const selected = visible.sort((left, right) => Math.abs(left.box.top - 140) - Math.abs(right.box.top - 140))[0];
    if (!selected) throw new Error('No visible article heading can anchor the sidebar-collapse reading position.');
    selected.heading.setAttribute('data-audit-reading-anchor', 'true');
    return {
      id: selected.heading.id,
      text: selected.heading.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      top: selected.box.top,
      bottom: selected.box.bottom,
      inViewport: true,
      scrollY: window.scrollY,
    };
  });

  await audit.step('Collapse the sidebar', 'The rail collapses without changing reading position.', async () => {
    await page.getByRole('button', { name: 'Collapse guide navigation' }).click();
    await expect(page.getByRole('button', { name: 'Expand guide navigation' })).toBeVisible();
    const after = await page.locator('[data-audit-reading-anchor="true"]').evaluate((heading) => {
      const box = heading.getBoundingClientRect();
      return {
        id: heading.id,
        text: heading.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        top: box.top,
        bottom: box.bottom,
        inViewport: box.bottom > 80 && box.top < window.innerHeight,
        scrollY: window.scrollY,
      };
    });
    await audit.attachJson('desktop-sidebar-reading-anchor', { before, after, maximumTopMovementPx: 48 });
    expect(after.id).toBe(before.id);
    expect(after.inViewport).toBe(true);
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(48);
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
  test.skip(!usesReviewedSiteContract(testInfo) || !isChromiumAuditProject(testInfo), 'Reviewed-site clipboard audit.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await audit.goto('/compounds/7-oh');

  await audit.step('Use the reviewed parent breadcrumb', 'The Compounds crumb targets the exact parent category and loads its reviewed heading.', async () => {
    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText('7-OH (7-Hydroxymitragynine)');
    const parent = breadcrumb.getByRole('link', { name: 'Compounds', exact: true });
    await expect(parent).toHaveAttribute('href', '/compounds');
    await parent.click();
    await expect(page).toHaveURL(/\/compounds\/?$/);
    await expect(page.locator('main h1:visible')).toHaveText('Compounds');
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/compounds\/7-oh\/?$/);
  });

  await audit.step('Copy the page link', 'Clipboard contains the candidate origin and current path, and the copy response is announced.', async () => {
    await page.getByRole('button', { name: 'Copy a link to this page' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(`${new URL(page.url()).origin}/compounds/7-oh`);
    await expect(page.locator('#copy-announce')).toHaveText('Page link copied to clipboard');
  });
  await audit.observe('clipboard URL', await page.evaluate(() => navigator.clipboard.readText()), 'Current environment URL');
  await audit.assertRuntimeHealthy();
});

interactionTest('[NAV-005] table of contents aligns and tracks document sections', interactionEvidence('Activate a table-of-contents link and show its hash and heading alignment below sticky chrome.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!usesReviewedSiteContract(testInfo) || !isChromiumAuditProject(testInfo), 'Reviewed-site TOC audit.');
  await audit.goto('/compounds/7-oh');
  await dismissSchedulingNotice(page);

  const toc = page.getByRole('navigation', { name: 'Table of contents' }).first();
  const link = toc.getByRole('link').first();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^#/);
  await audit.step('Choose the first section', 'The URL hash changes and the heading clears sticky chrome.', async () => {
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    const alignmentSamples = [];
    for (let sample = 0; sample < 40; sample += 1) {
      const state = await page.locator(href!).evaluate((element) => ({
        top: element.getBoundingClientRect().top,
        hash: window.location.hash,
      }));
      const active = await link.getAttribute('aria-current');
      alignmentSamples.push({ elapsedMs: sample * 100, ...state, active });
      if (state.top >= 80 && state.top < 180 && active === 'location') break;
      await page.waitForTimeout(100);
    }
    await audit.attachJson('toc-smooth-scroll-alignment', { href, samples: alignmentSamples });
    const settled = alignmentSamples.at(-1)!;
    expect(settled.hash).toBe(href);
    expect(settled.top).toBeGreaterThanOrEqual(80);
    expect(settled.top).toBeLessThan(180);
    expect(settled.active).toBe('location');
  });
  await audit.assertRuntimeHealthy();
});
import { AxeBuilder } from '@axe-core/playwright';
