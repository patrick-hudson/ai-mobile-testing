import { test, expect, interactionEvidence, interactionTest } from '../fixtures/test.js';
import { meta } from './helpers.js';

async function readySearchInput(page: import('@playwright/test').Page) {
  const input = page.getByRole('combobox', { name: 'Search all pages' }).first();
  await expect(page.locator('astro-island').filter({ has: input })).not.toHaveAttribute('ssr', '');
  return input;
}

interactionTest('[SEARCH-001] header search opens by pointer and keyboard shortcut', interactionEvidence('Open and close header search with pointer and keyboard controls and show focus moving predictably.', 'candidate-projects'), async ({ page, audit }, testInfo) => {
  test.skip(meta(testInfo).environment !== 'candidate', 'Candidate redesign interaction.');
  await audit.goto('/compounds/7-oh');
  const headerSearch = page.getByRole('link', { name: 'Search the guide' });
  await expect(page.locator('astro-island').filter({ has: headerSearch })).not.toHaveAttribute('ssr', '');

  await audit.step('Open search from the header', 'A focused search dialog opens.', async () => {
    await headerSearch.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Search all pages' })).toBeFocused();
  });
  await audit.checkpoint('search-dialog-empty');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  await audit.step('Open search with the keyboard shortcut', 'Cmd/Ctrl+K opens the same focused dialog.', async () => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Search all pages' })).toBeFocused();
  });
  await audit.assertRuntimeHealthy();
});

interactionTest('[SEARCH-002] known medical query returns a relevant destination', interactionEvidence('Enter a known medical query and show the relevant result, excerpt, and category appearing.', 'candidate-projects'), async ({ page, audit }, testInfo) => {
  test.skip(meta(testInfo).environment !== 'candidate', 'Candidate search contract.');
  await audit.goto('/search');
  const input = await readySearchInput(page);

  await audit.step('Search for clonidine', 'Helper Medications appears as a relevant result.', async () => {
    await input.fill('clonidine');
    await expect(page.getByRole('link', { name: /helper medications/i }).first()).toBeVisible();
    await expect(page.getByRole('status')).toContainText(/page.*matched/i);
  });
  const resultCount = await page.getByRole('option').count();
  audit.observe('visible result count', resultCount, 'At least one result');
  expect(resultCount).toBeGreaterThan(0);
  await audit.checkpoint('search-results-clonidine');
  await audit.assertRuntimeHealthy();
});

interactionTest('[SEARCH-003] search keyboard navigation opens the active result', interactionEvidence('Enter a query, move through results with ArrowDown, and show Enter opening the active destination.', 'candidate-non-tablet-projects'), async ({ page, audit }, testInfo) => {
  test.skip(meta(testInfo).environment !== 'candidate' || meta(testInfo).deviceClass === 'tablet', 'Primary candidate keyboard audit.');
  await audit.goto('/');
  const input = await readySearchInput(page);
  await input.fill('vitamin c');
  await expect(page.getByRole('option').first()).toBeVisible();

  await audit.step('Move and open with the keyboard', 'ArrowDown changes selection and Enter opens that destination.', async () => {
    await input.press('ArrowDown');
    const active = await input.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    await Promise.all([
      page.waitForURL((url) => url.pathname !== '/'),
      input.press('Enter'),
    ]);
    expect(new URL(page.url()).pathname).not.toBe('/');
  });
  await audit.assertRuntimeHealthy();
});

interactionTest('[SEARCH-004] search page filters persist in the URL', interactionEvidence('Enter a broad query, apply filters, and show the narrowed result set and URL parameters updating.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(meta(testInfo).environment !== 'candidate' || !testInfo.project.name.includes('chromium'), 'Candidate search-filter audit.');
  await audit.goto('/search');
  const input = await readySearchInput(page);
  await input.fill('withdrawal');

  await audit.step('Apply topic and type filters', 'Both filters update results and URL parameters.', async () => {
    await page.getByLabel('Topic').selectOption('start-here');
    const type = page.getByLabel('Result type');
    const options = await type.locator('option').allTextContents();
    const chosen = options.find((option) => option !== 'All types');
    expect(chosen).toBeTruthy();
    await type.selectOption({ label: chosen! });
    await expect(page).toHaveURL(/q=withdrawal/);
    await expect(page).toHaveURL(/topic=start-here/);
    await expect(page).toHaveURL(/type=/);
  });
  await page.reload({ waitUntil: 'load' });
  await expect(page.getByLabel('Topic')).toHaveValue('start-here');
  await audit.assertRuntimeHealthy();
});

interactionTest('[SEARCH-005] no-result state offers a usable recovery path', interactionEvidence('Enter an impossible query and show the no-result guidance and usable suggested searches.', 'candidate-projects'), async ({ page, audit }, testInfo) => {
  test.skip(meta(testInfo).environment !== 'candidate', 'Candidate no-result audit.');
  await audit.goto('/search');
  const input = await readySearchInput(page);
  await audit.step('Search for an impossible medicine', 'The page replaces results with recovery guidance and suggested search terms.', async () => {
    await input.fill('zzzz-no-such-medication-zzzz');
    await expect(page.getByText(/no pages matched/i)).toBeVisible();
    await expect(page.getByText(/try a medicine name/i)).toBeVisible();
  });
  await audit.checkpoint('search-no-results');
  await audit.assertRuntimeHealthy();
});

interactionTest('[SEARCH-006] failed search index exposes the sitemap fallback', interactionEvidence('Open search and enter a query while the index fails, then show the fallback and stopped spinner.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(meta(testInfo).environment !== 'candidate' || !testInfo.project.name.includes('chromium'), 'Candidate failure-injection audit.');
  await page.route('**/search-index.json', (route) => route.abort('failed'));
  await audit.goto('/search');
  const input = await readySearchInput(page);
  await audit.step('Search while the index request is blocked', 'The spinner stops and the page exposes a working sitemap fallback.', async () => {
    await input.fill('clonidine');
    await expect(page.getByText(/search could not load/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /complete site map/i })).toHaveAttribute('href', '/sitemap');
  });
  await audit.checkpoint('search-index-failure');
});
