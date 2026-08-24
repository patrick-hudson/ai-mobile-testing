import { test, expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { meta } from './helpers.js';
import type { Locator, Page } from '@playwright/test';

const NEXT_PATH = '/next-kratom-support-meeting';
const NA_PATH = '/virtual-na-meetings-now';
const SMART_PATH = '/virtual-smart-meetings-now';

function candidateChromium(testInfo: Parameters<typeof meta>[0]): boolean {
  return meta(testInfo).environment === 'candidate' && testInfo.project.name.includes('chromium');
}

async function waitForHydratedIsland(page: Page, control: Locator): Promise<void> {
  const island = page.locator('astro-island').filter({ has: control }).first();
  await expect(island).not.toHaveAttribute('ssr', '');
}

staticTest('[MEET-001] meeting cards cross pre-live, starting, live, and ended boundaries', staticEvidence('Capture the deterministic meeting state at each frozen time boundary with the complete state ledger.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One deterministic candidate desktop time-state audit.');
  const states = [
    { at: '2026-08-24T13:50:00Z', expected: 'Starting soon' },
    { at: '2026-08-24T14:02:00Z', expected: 'Meeting starting' },
    { at: '2026-08-24T14:10:00Z', expected: 'Live now' },
    { at: '2026-08-24T15:00:00Z', expected: 'Next up' },
  ] as const;

  for (const state of states) {
    await audit.step(`Freeze time at ${state.at}`, `The featured meeting state reads “${state.expected}”.`, async () => {
      await page.clock.setFixedTime(new Date(state.at));
      await audit.goto(NEXT_PATH);
      await expect(page.getByText(state.expected, { exact: true }).first()).toBeVisible();
      audit.observe(`state at ${state.at}`, state.expected, state.expected);
    });
  }

  await audit.checkpoint('meeting-after-end-transition');
  await audit.assertRuntimeHealthy();
});

staticTest('[MEET-002] the same occurrence is converted across representative timezones', staticEvidence('Capture the same meeting occurrence with its exact rendered labels across representative timezones.'), async ({ browser, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One deterministic multi-timezone audit.');
  const fixed = new Date('2026-08-24T12:30:00Z');
  const cases = [
    { timezoneId: 'America/Chicago', display: 'Today at 7:00 AM' },
    { timezoneId: 'America/Los_Angeles', display: 'Today at 5:00 AM' },
    { timezoneId: 'Europe/London', display: 'Today at 1:00 PM' },
    { timezoneId: 'Asia/Kolkata', display: 'Today at 5:30 PM' },
  ];
  const observed: Record<string, string> = {};

  for (const item of cases) {
    await audit.step(`Render in ${item.timezoneId}`, `The 8:00 AM Eastern meeting displays as ${item.display}.`, async () => {
      const context = await browser.newContext({ timezoneId: item.timezoneId, viewport: { width: 1280, height: 800 } });
      const localPage = await context.newPage();
      await localPage.clock.setFixedTime(fixed);
      await localPage.goto(`${audit.environmentBaseURL()}${NEXT_PATH}`, { waitUntil: 'load' });
      const text = await localPage.getByText(new RegExp(`^${item.display.replaceAll(' ', '\\s')} your time$`)).first().innerText();
      observed[item.timezoneId] = text;
      expect(text).toBe(`${item.display} your time`);
      if (item.timezoneId === 'America/Chicago') {
        const screenshot = testInfo.outputPath('meeting-timezone-reference.png');
        await localPage.screenshot({ path: screenshot, fullPage: false });
        await testInfo.attach('meeting-timezone-reference', { path: screenshot, contentType: 'image/png' });
      }
      await context.close();
    });
  }

  await audit.attachJson('timezone-conversions', { occurrence: '2026-08-24T12:00:00Z', observed });
});

interactionTest('[MEET-003] a joined room persists across pages and can be cleared', interactionEvidence('Join a featured room, navigate to meeting history, and clear it while showing persistence and removal.', 'candidate-chromium-projects'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium meeting-history audit.');
  await page.clock.setFixedTime(new Date('2026-08-24T13:30:00Z'));
  await audit.goto(NEXT_PATH);

  await audit.step('Join the featured room', 'The external destination opens and the interaction is recorded locally.', async () => {
    const popupPromise = page.waitForEvent('popup');
    const join = page.getByRole('link', { name: /Join in/ }).first();
    const expectedDestination = await join.getAttribute('href');
    expect(expectedDestination).toMatch(/^https:\/\//);
    await join.click();
    const popup = await popupPromise;
    await popup.waitForURL((url) => url.protocol === 'https:');
    audit.observe('opened meeting destination', popup.url(), expectedDestination!);
    await audit.holdSecondaryPageOutcome(popup, 'external meeting destination');
    await popup.close();
  });

  await audit.step('Open another meeting page', 'The previously joined section shows the same saved room.', async () => {
    await audit.goto('/resources/meeting-schedules');
    await expect(page.getByRole('heading', { name: 'Previously joined' })).toBeVisible();
    await expect(page.getByText(/Kratom Anonymous|TIAWO/).first()).toBeVisible();
  });

  await audit.step('Clear history', 'The saved-room section disappears and storage no longer contains meeting records.', async () => {
    await page.getByRole('button', { name: 'Clear history' }).click();
    await expect(page.getByRole('heading', { name: 'Previously joined' })).toHaveCount(0);
    const historyKeys = await page.evaluate(() => Object.keys(localStorage).filter((key) => /meeting/i.test(key)));
    expect(historyKeys).toHaveLength(0);
  });

  await audit.checkpoint('meeting-history-cleared');
  await audit.assertRuntimeHealthy();
});

interactionTest('[MEET-004] NA search, type, access, and platform filters combine and clear', interactionEvidence('Combine NA meeting search and filter controls, then clear them and show the result list returning.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop NA directory audit.');
  await page.clock.setFixedTime(new Date('2026-08-24T12:30:00Z'));
  await audit.goto(NA_PATH);
  const search = page.getByLabel('Search meetings');
  await waitForHydratedIsland(page, search);

  await audit.step('Combine independent filters', 'Type, access, platform, and text search are simultaneously active.', async () => {
    await page.getByRole('button', { name: 'Newcomer', exact: true }).click();
    await page.getByRole('button', { name: /^open$/i }).click();
    await page.getByRole('button', { name: /^Zoom \(/ }).click();
    await search.fill('no-meeting-can-match-this-audit-query');
    await expect(page.getByText('Nothing in this window matches your filters.').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  });

  await audit.step('Clear all filters', 'The search field and filter state reset and meeting cards return.', async () => {
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(search).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Join/ }).first()).toBeVisible();
  });

  await audit.checkpoint('na-filters-cleared', { fullPage: true });
  await audit.assertRuntimeHealthy();
});

interactionTest('[MEET-005] SMART program, audience, language, and search filters combine and clear', interactionEvidence('Combine SMART meeting search and filter controls, then clear them and show usable results returning.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop SMART directory audit.');
  await page.clock.setFixedTime(new Date('2026-08-24T12:30:00Z'));
  await audit.goto(SMART_PATH);
  const search = page.getByLabel('Search meetings');
  await waitForHydratedIsland(page, search);

  await audit.step('Apply a program and impossible text query', 'The directory presents an explicit empty state, never an indefinite spinner.', async () => {
    await page.getByRole('button', { name: /^4-Point Recovery \(/ }).click();
    const adults = page.getByRole('button', { name: /^Adults \(/ });
    if (await adults.count()) await adults.click();
    const english = page.getByRole('button', { name: /^English \(/ });
    if (await english.count()) await english.click();
    await search.fill('no-smart-meeting-can-match-this-audit-query');
    await expect(page.getByText('Nothing in this window matches your filters.').first()).toBeVisible();
  });

  await audit.step('Clear all filters', 'All filter inputs reset and usable meeting actions return.', async () => {
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(search).toHaveValue('');
    await expect(page.getByRole('link', { name: /Join/ }).first()).toBeVisible();
  });

  await audit.checkpoint('smart-filters-cleared', { fullPage: true });
  await audit.assertRuntimeHealthy();
});

interactionTest('[MEET-006] meeting copy text agrees with the displayed join destination', interactionEvidence('Activate meeting copy and show the clipboard text matching the visible name, schedule, and join URL.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium meeting copy audit.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.setFixedTime(new Date('2026-08-24T12:30:00Z'));
  await audit.goto(NA_PATH);
  await waitForHydratedIsland(page, page.getByLabel('Search meetings'));

  await audit.step('Copy the featured 24/7 room', 'Clipboard includes its visible name, availability, platform, and exact join URL.', async () => {
    const card = page.getByText('Always available', { exact: true }).locator('..').locator('..');
    const join = card.getByRole('link', { name: 'Join the 24/7 room' });
    const expectedUrl = await join.getAttribute('href');
    await card.getByRole('button', { name: 'Copy meeting details to clipboard' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('NA Meeting:');
    expect(copied).toContain('24/7 — join any time');
    expect(copied).toContain(expectedUrl);
    audit.observe('copied join URL', expectedUrl, 'Displayed href');
  });

  await audit.checkpoint('meeting-copy-confirmation');
  await audit.assertRuntimeHealthy();
});

staticTest('[MEET-007] a failed live-meeting index becomes an explicit usable fallback', staticEvidence('Capture the explicit meeting-data failure state with both usable directory recovery links.'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop dependency-failure audit.');
  await page.clock.setFixedTime(new Date('2026-08-24T15:30:00Z'));
  let interceptedRequests = 0;
  await page.route('**/live-meeting-index.json', (route) => {
    interceptedRequests += 1;
    return route.abort('failed');
  });
  await audit.goto(NEXT_PATH);

  await audit.step('Wait for dependency failure handling', 'Loading resolves to a truthful empty state with both directory links.', async () => {
    await expect(page.getByText('Checking live NA and SMART meetings…')).toHaveCount(0);
    await expect(page.getByText('No additional live meeting is listed at this moment.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse all NA meetings' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse all SMART meetings' })).toBeVisible();
    expect(interceptedRequests).toBeGreaterThan(0);
  });

  audit.observe('dependency', '/live-meeting-index.json', 'Simulated transport failure');
  await audit.checkpoint('meeting-index-failure-fallback');
});
