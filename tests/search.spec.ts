import { test, expect, interactionEvidence, interactionTest } from '../fixtures/test.js';
import { REVIEWED_CLONIDINE_SEARCH_RESULT } from '../audit/routes.js';
import { auditMeta, isChromiumAuditProject, loggedGet, usesReviewedSiteContract } from './helpers.js';

async function readySearchInput(page: import('@playwright/test').Page) {
  const input = page.getByRole('combobox', { name: 'Search all pages' }).first();
  await expect(page.locator('astro-island').filter({ has: input })).not.toHaveAttribute('ssr', '');
  return input;
}

interactionTest('[SEARCH-001] header search opens by pointer and keyboard shortcut', interactionEvidence('Open and close header search with pointer and keyboard controls and show focus moving predictably.', 'candidate-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!usesReviewedSiteContract(testInfo), 'Reviewed-site redesign interaction.');
  await audit.goto('/compounds/7-oh');
  const headerSearch = page.getByRole('link', { name: 'Search the guide' });
  await expect(page.locator('astro-island').filter({ has: headerSearch })).not.toHaveAttribute('ssr', '');

  await audit.step('Open and close search from the header', 'Pointer activation focuses the dialog input; Escape closes it and restores the exact trigger.', async () => {
    await headerSearch.click();
    await expect(page.getByRole('dialog', { name: 'Search quitting7oh.org' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Search all pages' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search quitting7oh.org' })).toBeHidden();
    await expect(headerSearch).toBeFocused();
  });

  await audit.step('Open and close search with the keyboard shortcut', 'Cmd/Ctrl+K opens the same focused dialog; Escape closes it and restores the search trigger.', async () => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await expect(page.getByRole('dialog', { name: 'Search quitting7oh.org' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Search all pages' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search quitting7oh.org' })).toBeHidden();
    await expect(headerSearch).toBeFocused();
  });
  await audit.assertRuntimeHealthy();
});

interactionTest('[SEARCH-002] known medical query returns a relevant destination', interactionEvidence('Enter a known medical query and show the relevant result, excerpt, and category appearing.', 'candidate-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!usesReviewedSiteContract(testInfo), 'Reviewed-site search contract.');
  await audit.goto('/search');
  const input = await readySearchInput(page);

  await audit.step('Search for clonidine', 'Helper Medications appears as a relevant result.', async () => {
    await expect(input, 'The reviewed search journey must begin from a visibly empty query').toHaveValue('');
    // Give recorded evidence a stable initial-state window before the action.
    // This is intentional review pacing: the video quality gate samples at 4 fps.
    await page.waitForTimeout(1_000);
    await input.pressSequentially(REVIEWED_CLONIDINE_SEARCH_RESULT.query, { delay: 80 });
    const result = page.locator(`a[role="option"][href="${REVIEWED_CLONIDINE_SEARCH_RESULT.href}"]`);
    await expect(result).toBeVisible();
    await expect(result.locator('.eyebrow'), 'The result must expose its reviewed category and result type').toHaveText(REVIEWED_CLONIDINE_SEARCH_RESULT.eyebrow);
    await expect(result.locator('.block.font-bold'), 'The result title must identify the reviewed destination').toHaveText(REVIEWED_CLONIDINE_SEARCH_RESULT.title);
    await expect(result.locator('mark'), 'The known query term must be visibly highlighted').toHaveText(REVIEWED_CLONIDINE_SEARCH_RESULT.highlight);
    await expect(result, 'The result must retain a substantive reviewed excerpt, not just title text')
      .toContainText(REVIEWED_CLONIDINE_SEARCH_RESULT.excerptPrefix);
    await expect(page.getByRole('status')).toContainText(/page.*matched/i);
    await result.scrollIntoViewIfNeeded();
    await expect(result, 'The named result must be visible in the recorded final response').toBeInViewport({ ratio: 0.75 });
    // Preserve the asserted response long enough to be legible in the review video.
    await page.waitForTimeout(1_000);
    await audit.attachJson('clonidine-search-result-contract', {
      contract: REVIEWED_CLONIDINE_SEARCH_RESULT,
      renderedText: (await result.innerText()).replace(/\s+/g, ' ').trim(),
      renderedHtml: await result.innerHTML(),
    });
  });
  const resultCount = await page.getByRole('option').count();
  audit.observe('visible result count', resultCount, 'At least one result');
  expect(resultCount).toBeGreaterThan(0);
  await audit.assertRuntimeHealthy();
});

interactionTest('[SEARCH-003] search keyboard navigation opens the active result', interactionEvidence('Enter a query, move through results with ArrowDown, and show Enter opening the active destination.', 'candidate-non-tablet-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!usesReviewedSiteContract(testInfo) || auditMeta(testInfo).deviceClass === 'tablet', 'Primary reviewed-site keyboard audit.');
  await audit.goto('/');
  const input = await readySearchInput(page);
  await input.fill('vitamin c');
  await expect(page.getByRole('option').first()).toBeVisible();

  await audit.step('Move and open with the keyboard', 'ArrowDown changes selection and Enter opens that destination.', async () => {
    const activeBefore = await input.getAttribute('aria-activedescendant');
    await input.press('ArrowDown');
    const active = await input.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(active, 'ArrowDown must change the active descendant rather than leave a preselected result unchanged').not.toBe(activeBefore);
    const activeOption = page.locator(`[id="${active}"]`);
    await expect(activeOption).toHaveAttribute('aria-selected', 'true');
    const activeHref = await activeOption.getAttribute('href');
    expect(activeHref, 'The active option must expose a concrete destination').toBeTruthy();
    const expectedDestination = new URL(activeHref!, page.url());
    const expectedRequestDestination = new URL(expectedDestination);
    expectedRequestDestination.hash = '';
    const sourceUrl = page.url();
    const navigationRequestPromise = page.waitForRequest((request) =>
      request.isNavigationRequest()
      && request.frame() === page.mainFrame()
      && request.url() !== sourceUrl);
    const navigationResponsePromise = page.waitForNavigation({ waitUntil: 'load' });
    const [, navigationRequest, navigationResponse] = await Promise.all([
      input.press('Enter'),
      navigationRequestPromise,
      navigationResponsePromise,
    ]);
    expect(navigationRequest.url(), 'Enter must initiate the active option’s exact network destination (URL fragments remain browser-local)').toBe(expectedRequestDestination.href);
    expect(navigationResponse, 'The selected destination must complete a document navigation').not.toBeNull();
    expect(navigationResponse?.status(), 'The selected destination must resolve successfully').toBe(200);

    const expectedCanonicalDestination = new URL(expectedDestination);
    if (expectedCanonicalDestination.pathname !== '/' && !expectedCanonicalDestination.pathname.endsWith('/')) {
      expectedCanonicalDestination.pathname += '/';
    }
    expect(page.url(), 'The final page must be the exact canonical form of the active option').toBe(expectedCanonicalDestination.href);
    audit.observe('active search destination', expectedDestination.href, `Changed from ${String(activeBefore)}; canonical final URL: ${expectedCanonicalDestination.href}`);
  });
  await audit.assertRuntimeHealthy();
});

interactionTest('[SEARCH-004] search page filters persist in the URL', interactionEvidence('Enter a broad query, apply filters, and show the narrowed result set and URL parameters updating.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!usesReviewedSiteContract(testInfo) || !isChromiumAuditProject(testInfo), 'Reviewed-site search-filter audit.');
  await audit.goto('/search');
  const input = await readySearchInput(page);
  await input.fill('withdrawal');
  const results = page.getByRole('listbox', { name: 'Search results' });
  await expect(results).toBeVisible();
  const unfilteredHrefs = await results.getByRole('option').evaluateAll((options) => options.map((option) =>
    (option as HTMLAnchorElement).getAttribute('href') ?? ''));
  expect(unfilteredHrefs.length, 'The broad query must establish a non-empty unfiltered control set').toBeGreaterThan(0);

  let filteredEvidence: Array<{ href: string; eyebrow: string }> = [];
  await audit.step('Apply explicit topic and type filters', 'Start Here and Guide narrow every rendered result and persist exact URL parameters.', async () => {
    await page.getByLabel('Topic').selectOption('start-here');
    await page.getByLabel('Result type').selectOption('Guide');
    await expect(page.getByLabel('Topic')).toHaveValue('start-here');
    await expect(page.getByLabel('Result type')).toHaveValue('Guide');
    await expect.poll(() => {
      const url = new URL(page.url());
      return {
        query: url.searchParams.get('q'),
        topic: url.searchParams.get('topic'),
        type: url.searchParams.get('type'),
      };
    }).toEqual({ query: 'withdrawal', topic: 'start-here', type: 'Guide' });
    await expect(results.getByRole('option').first()).toBeVisible();
    filteredEvidence = await results.getByRole('option').evaluateAll((options) => options.map((option) => ({
      href: (option as HTMLAnchorElement).getAttribute('href') ?? '',
      eyebrow: option.querySelector('.eyebrow')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    })));
    expect(filteredEvidence.length, 'The explicit filter vector must retain useful results').toBeGreaterThan(0);
    expect(filteredEvidence.length, 'The explicit filter vector must narrow the broad result set').toBeLessThan(unfilteredHrefs.length);
    expect(filteredEvidence.every(({ href }) => href.startsWith('/start-here/')), 'Every result must belong to the selected Start Here topic').toBe(true);
    expect(filteredEvidence.every(({ eyebrow }) => eyebrow === 'Start Here · Guide'), 'Every result must expose the selected Guide type and topic').toBe(true);
    expect(filteredEvidence.some(({ href }) => href === '/start-here/7-oh-withdrawal-guide'), 'The independently reviewed withdrawal guide must remain in the narrowed result set').toBe(true);
  });
  await page.reload({ waitUntil: 'load' });
  await readySearchInput(page);
  await expect(page.getByLabel('Topic')).toHaveValue('start-here');
  await expect(page.getByLabel('Result type')).toHaveValue('Guide');
  await expect(results.getByRole('option').first()).toBeVisible();
  const reloadedEvidence = await results.getByRole('option').evaluateAll((options) => options.map((option) => ({
    href: (option as HTMLAnchorElement).getAttribute('href') ?? '',
    eyebrow: option.querySelector('.eyebrow')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  })));
  expect(reloadedEvidence, 'Reload must preserve the exact filtered result semantics, not only the controls').toEqual(filteredEvidence);
  await audit.attachJson('search-filter-evidence', { unfilteredHrefs, filteredEvidence, reloadedEvidence });
  await audit.assertRuntimeHealthy();
});

interactionTest('[SEARCH-005] no-result state offers a usable recovery path', interactionEvidence('Enter one absent index token, show the no-result guidance, then replace it with a known treatment and show useful results.', 'candidate-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!usesReviewedSiteContract(testInfo), 'Reviewed-site no-result audit.');
  await audit.goto('/search');
  const input = await readySearchInput(page);
  await audit.step('Search for an absent index token', 'The page replaces results with recovery guidance instead of matching unrelated OR-combined words.', async () => {
    await input.fill('qzxvplmwrtyknfdh');
    await expect(page.getByText(/no pages matched/i)).toBeVisible();
    await expect(page.getByText(/try a medicine name/i)).toBeVisible();
  });
  await audit.step('Recover with a known treatment query', 'Replacing the absent token with clonidine exposes named, navigable results.', async () => {
    await input.fill('clonidine');
    const results = page.getByRole('listbox', { name: 'Search results' });
    await expect(results).toBeVisible();
    const helperMedications = results.getByRole('option', { name: /helper medications/i }).first();
    await expect(helperMedications).toBeVisible();
    await expect(helperMedications).toHaveAttribute('href', REVIEWED_CLONIDINE_SEARCH_RESULT.href);
    await helperMedications.focus();
    await expect(helperMedications).toBeFocused();
    await page.keyboard.press('Enter');
    const expectedDestination = new URL(REVIEWED_CLONIDINE_SEARCH_RESULT.href, page.url());
    expectedDestination.pathname = `${expectedDestination.pathname.replace(/\/$/, '')}/`;
    await expect(page).toHaveURL(expectedDestination.href);
    await expect(page.locator(REVIEWED_CLONIDINE_SEARCH_RESULT.href.slice(REVIEWED_CLONIDINE_SEARCH_RESULT.href.indexOf('#')))).toBeVisible();
  });
  await audit.assertRuntimeHealthy();
});

interactionTest('[SEARCH-006] failed search index exposes the sitemap fallback', interactionEvidence('Open search and enter a query while the index fails, then show the stopped spinner and activate the exact sitemap recovery destination.', 'candidate-chromium-projects'), async ({ page, request, audit }, testInfo) => {
  test.skip(!usesReviewedSiteContract(testInfo) || !isChromiumAuditProject(testInfo), 'Reviewed-site failure-injection audit.');
  await page.route('**/search-index.json', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{not-valid-json',
  }));
  await audit.goto('/search');
  const input = await readySearchInput(page);
  await audit.step('Search while the index payload is invalid', 'The spinner stops and the page exposes a working sitemap fallback.', async () => {
    await input.fill('clonidine');
    await expect(page.getByText(/search could not load/i)).toBeVisible();
    await expect(page.locator('[aria-busy="true"], .animate-spin')).toHaveCount(0);
    const fallback = page.getByRole('link', { name: 'complete site map', exact: true });
    await expect(fallback).toHaveAttribute('href', '/sitemap');
    const response = await loggedGet(request, audit, '/sitemap');
    expect(response.status(), 'The independently requested sitemap fallback must serve usable HTML').toBe(200);
    expect(response.headers()['content-type'] ?? '').toContain('text/html');
    await fallback.click();
    await expect(page).toHaveURL(/\/sitemap\/?$/);
    await expect(page.locator('main h1:visible')).toHaveText('Site map');
  });
  await audit.assertRuntimeHealthy();
});
