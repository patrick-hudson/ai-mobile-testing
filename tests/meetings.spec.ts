import { test, expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { meta, readAstroComponentProp } from './helpers.js';
import type { Locator, Page } from '@playwright/test';

const NEXT_PATH = '/next-kratom-support-meeting';
const NA_PATH = '/virtual-na-meetings-now';
const SMART_PATH = '/virtual-smart-meetings-now';
const MEET_FILTER_TOTAL_TIMEOUT_MS = 180_000;
const MEET_FILTER_PREPARATION_BUDGET_MS = 120_000;

function candidateChromium(testInfo: Parameters<typeof meta>[0]): boolean {
  return meta(testInfo).environment === 'candidate' && testInfo.project.name.includes('chromium');
}

async function waitForHydratedIsland(page: Page, control: Locator): Promise<void> {
  const island = page.locator('astro-island').filter({ has: control }).first();
  await expect(island).not.toHaveAttribute('ssr', '');
}

interface NaMeetingOracle {
  id: string;
  name: string;
  formatTags: string[];
  closed: 'Open' | 'Closed';
  platform: string;
  joinUrl: string;
}

interface NaMeetingBundleOracle {
  meetings: NaMeetingOracle[];
}

interface SmartMeetingOracle {
  id: string;
  name: string;
  program: string;
  audiences: string[];
  languages: string[];
  pathminderUrl: string;
  detailUrl: string;
}

interface SmartMeetingBundleOracle {
  meetings: SmartMeetingOracle[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function visibleMeetingDestinations(page: Page): Promise<string[]> {
  return page.locator('li.field-card').evaluateAll((cards) => cards
    .map((card) => card.querySelector<HTMLAnchorElement>('a[href]')?.href ?? '')
    .filter(Boolean)
    .sort());
}

async function expectExactMeetingDestinations(page: Page, expected: readonly string[]): Promise<void> {
  await expect.poll(() => visibleMeetingDestinations(page)).toEqual([...expected].sort());
}

async function filterButtonValues(row: Locator): Promise<string[]> {
  return row.getByRole('button').evaluateAll((buttons) => buttons.map((button) =>
    (button.textContent ?? '').replace(/\s*\([\d,]+\)\s*$/, '').replace(/\s+/g, ' ').trim(),
  ).filter(Boolean));
}

staticTest('[MEET-001] meeting cards cross pre-live, starting, live, and ended boundaries', staticEvidence('Capture the deterministic meeting state at each frozen time boundary with the complete state ledger.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
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

staticTest('[MEET-002] the same occurrence is converted across representative timezones', staticEvidence('Capture the same meeting occurrence with its exact rendered labels across representative timezones.', 'candidate-desktop-chromium'), async ({ browser, page, audit }, testInfo) => {
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

  expect(cases, 'The timezone contract must retain all four reviewed regions').toHaveLength(4);
  expect(Object.keys(observed), 'Every timezone case must produce one exact rendered label').toEqual(cases.map(({ timezoneId }) => timezoneId));
  await audit.attachJson('timezone-conversions', { occurrence: '2026-08-24T12:00:00Z', observed });
  await page.clock.setFixedTime(fixed);
  await audit.goto(NEXT_PATH);
  await audit.checkpoint('meeting-timezone-central-reference');
});

interactionTest('[MEET-003] a joined room persists across pages and can be cleared', interactionEvidence('Join a featured room, navigate to meeting history, and clear it while showing persistence and removal.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo), 'Candidate Chromium meeting-history audit.');
  await page.clock.setFixedTime(new Date('2026-08-24T13:30:00Z'));
  await audit.goto(NEXT_PATH);

  await audit.step('Join the featured room', 'The external destination opens and the interaction is recorded locally.', async () => {
    const join = page.getByRole('link', { name: /Join in/ }).first();
    const expectedDestination = await join.getAttribute('href');
    expect(expectedDestination).toMatch(/^https:\/\//);
    if (!expectedDestination) throw new Error('Featured meeting join action has no destination.');
    let capturedDestination: string | null = null;
    const routeMatcher = (url: URL) => url.href === expectedDestination;
    await context.route(routeMatcher, async (route) => {
      expect(route.request().isNavigationRequest(), 'The join action must initiate a document navigation').toBe(true);
      capturedDestination = route.request().url();
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Meeting destination captured</title><h1>External meeting destination requested</h1>',
      });
    });

    let popup: Page | null = null;
    try {
      const popupPromise = page.waitForEvent('popup');
      [popup] = await Promise.all([popupPromise, join.click()]);
      await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      expect(capturedDestination, 'The popup navigation request must exactly match the rendered meeting link').toBe(expectedDestination);
      expect(popup.url(), 'The popup must retain the exact requested meeting destination').toBe(expectedDestination);
      await expect(popup.getByRole('heading', { name: 'External meeting destination requested' })).toBeVisible();
      audit.observe('opened meeting destination', capturedDestination, expectedDestination);
      await audit.holdSecondaryPageOutcome(popup, 'external meeting destination request');
    } finally {
      if (popup && !popup.isClosed()) await popup.close();
      await context.unroute(routeMatcher);
    }
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

  await audit.assertRuntimeHealthy();
});

interactionTest('[MEET-004] NA search, type, access, and platform filters combine and clear', interactionEvidence('Combine NA meeting search and filter controls, then clear them and show the result list returning.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop NA directory audit.');
  testInfo.setTimeout(MEET_FILTER_TOTAL_TIMEOUT_MS);
  const preparationStartedAt = Date.now();
  await page.clock.setFixedTime(new Date('2026-08-24T12:30:00Z'));
  await audit.goto(NA_PATH);
  const search = page.getByLabel('Search meetings');
  await waitForHydratedIsland(page, search);
  const baseline = await visibleMeetingDestinations(page);
  expect(baseline.length, 'Frozen NA window must contain enough records to expose no-op filters').toBeGreaterThan(1);
  const bundle = await readAstroComponentProp<NaMeetingBundleOracle>(page, 'VirtualNaMeetings', 'bundle');
  const tagChips = [
    ['Newcomer', 'Newcomer'],
    ['Discussion', 'Discussion'],
    ['Speaker', 'Speaker'],
    ['JFT Study', 'Just For Today Study'],
    ['Basic Text Study', 'Basic Text Study'],
    ['Step Study', 'Step Study'],
    ['Literature Study', 'Literature Study'],
  ] as const;
  const platformRow = page.getByText('Platform:', { exact: true }).locator('..');
  const visiblePlatforms = await filterButtonValues(platformRow);
  const target = bundle.meetings.find((meeting) =>
    baseline.includes(meeting.joinUrl)
    && bundle.meetings.filter(({ name }) => name === meeting.name).length === 1
    && tagChips.some(([, tag]) => meeting.formatTags.includes(tag))
    && visiblePlatforms.includes(meeting.platform)
    && visiblePlatforms.some((platform) => platform !== meeting.platform));
  expect(target, 'Frozen NA data needs one uniquely searchable visible record covering type, access, and platform controls').toBeDefined();
  if (!target) throw new Error('No deterministic NA filter oracle record is available.');
  const expected = [target.joinUrl];
  const correctTag = tagChips.find(([, tag]) => target.formatTags.includes(tag));
  const wrongTag = tagChips.find(([, tag]) => !target.formatTags.includes(tag));
  const wrongPlatform = visiblePlatforms.find((platform) => platform !== target.platform);
  expect(correctTag, 'Oracle record must expose one visible meeting-type chip').toBeDefined();
  expect(wrongTag, 'Oracle record needs a nonmatching meeting-type control').toBeDefined();
  expect(wrongPlatform, 'Oracle record needs a nonmatching platform control').toBeDefined();
  if (!correctTag || !wrongTag || !wrongPlatform) throw new Error('NA control oracle is incomplete.');
  const preparationDurationMs = Date.now() - preparationStartedAt;
  audit.observe(
    'NA filter oracle preparation duration (ms)',
    preparationDurationMs,
    `< ${MEET_FILTER_PREPARATION_BUDGET_MS}ms, leaving a dedicated interaction budget`,
  );
  expect(
    preparationDurationMs,
    'Meeting-data hydration and deterministic oracle preparation must leave the reserved interaction window intact',
  ).toBeLessThan(MEET_FILTER_PREPARATION_BUDGET_MS);

  await audit.step('Prove each NA filter changes an exact nonempty result set', 'Search isolates one reviewed record; every wrong control removes it and every matching control restores exactly it.', async () => {
    await search.fill(target.name);
    await expectExactMeetingDestinations(page, expected);

    await page.getByRole('button', { name: wrongTag[0], exact: true }).click();
    await expectExactMeetingDestinations(page, []);
    await page.getByRole('button', { name: wrongTag[0], exact: true }).click();
    await page.getByRole('button', { name: correctTag[0], exact: true }).click();
    await expectExactMeetingDestinations(page, expected);

    await page.getByRole('button', { name: target.closed === 'Open' ? /^closed$/i : /^open$/i }).click();
    await expectExactMeetingDestinations(page, []);
    await page.getByRole('button', { name: new RegExp(`^${target.closed}$`, 'i') }).click();
    await expectExactMeetingDestinations(page, expected);

    await platformRow.getByRole('button', { name: new RegExp(`^${escapeRegExp(wrongPlatform)}\\s*\\(`) }).click();
    await expectExactMeetingDestinations(page, []);
    await platformRow.getByRole('button', { name: new RegExp(`^${escapeRegExp(wrongPlatform)}\\s*\\(`) }).click();
    await platformRow.getByRole('button', { name: new RegExp(`^${escapeRegExp(target.platform)}\\s*\\(`) }).click();
    await expectExactMeetingDestinations(page, expected);
  });

  await audit.step('Clear all NA filters', 'The exact original frozen result set returns, including every destination and no extras.', async () => {
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(search).toHaveValue('');
    await expectExactMeetingDestinations(page, baseline);
  });

  await audit.attachJson('na-filter-oracle', { target, correctTag, wrongTag, wrongPlatform, expected, baseline });
  await audit.assertRuntimeHealthy();
});

interactionTest('[MEET-005] SMART program, audience, language, and search filters combine and clear', interactionEvidence('Combine SMART meeting search and filter controls, then clear them and show usable results returning.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop SMART directory audit.');
  await page.clock.setFixedTime(new Date('2026-08-24T12:30:00Z'));
  await audit.goto(SMART_PATH);
  const search = page.getByLabel('Search meetings');
  await waitForHydratedIsland(page, search);
  const baseline = await visibleMeetingDestinations(page);
  expect(baseline.length, 'Frozen SMART window must contain enough records to expose no-op filters').toBeGreaterThan(1);
  const bundle = await readAstroComponentProp<SmartMeetingBundleOracle>(page, 'VirtualSmartMeetings', 'bundle');
  const programRow = page.getByText('Program:', { exact: true }).locator('..');
  const audienceRow = page.getByText('Audience:', { exact: true }).locator('..');
  const languageRow = page.getByText('Language:', { exact: true }).locator('..');
  const [programs, audiences, languages] = await Promise.all([
    filterButtonValues(programRow),
    filterButtonValues(audienceRow),
    filterButtonValues(languageRow),
  ]);
  const destinationFor = (meeting: SmartMeetingOracle) =>
    baseline.find((href) => href === meeting.pathminderUrl || href === meeting.detailUrl);
  const target = bundle.meetings.find((meeting) =>
    Boolean(destinationFor(meeting))
    && bundle.meetings.filter(({ name }) => name === meeting.name).length === 1
    && programs.includes(meeting.program)
    && meeting.audiences.some((audience) => audiences.includes(audience))
    && meeting.languages.some((language) => languages.includes(language))
    && programs.some((program) => program !== meeting.program)
    && audiences.some((audience) => !meeting.audiences.includes(audience))
    && languages.some((language) => !meeting.languages.includes(language)));
  expect(target, 'Frozen SMART data needs one uniquely searchable record represented by every visible filter group').toBeDefined();
  if (!target) throw new Error('No deterministic SMART filter oracle record is available; review filter values against the data contract.');
  const targetDestination = destinationFor(target);
  const correctAudience = target.audiences.find((audience) => audiences.includes(audience));
  const correctLanguage = target.languages.find((language) => languages.includes(language));
  const wrongProgram = programs.find((program) => program !== target.program);
  const wrongAudience = audiences.find((audience) => !target.audiences.includes(audience));
  const wrongLanguage = languages.find((language) => !target.languages.includes(language));
  expect(targetDestination).toBeDefined();
  expect(correctAudience).toBeDefined();
  expect(correctLanguage).toBeDefined();
  expect(wrongProgram).toBeDefined();
  expect(wrongAudience).toBeDefined();
  expect(wrongLanguage).toBeDefined();
  if (!targetDestination || !correctAudience || !correctLanguage || !wrongProgram || !wrongAudience || !wrongLanguage) {
    throw new Error('SMART control oracle is incomplete.');
  }
  const expected = [targetDestination];
  const countedButton = (row: Locator, value: string) => row.getByRole('button', {
    name: new RegExp(`^${escapeRegExp(value)}\\s*\\(`),
  });

  await audit.step('Prove each SMART filter changes an exact nonempty result set', 'Search isolates one reviewed record; every wrong control removes it and every matching control restores exactly it.', async () => {
    await search.fill(target.name);
    await expectExactMeetingDestinations(page, expected);

    await countedButton(programRow, wrongProgram).click();
    await expectExactMeetingDestinations(page, []);
    await countedButton(programRow, wrongProgram).click();
    await countedButton(programRow, target.program).click();
    await expectExactMeetingDestinations(page, expected);

    await countedButton(audienceRow, wrongAudience).click();
    await expectExactMeetingDestinations(page, []);
    await countedButton(audienceRow, wrongAudience).click();
    await countedButton(audienceRow, correctAudience).click();
    await expectExactMeetingDestinations(page, expected);

    await countedButton(languageRow, wrongLanguage).click();
    await expectExactMeetingDestinations(page, []);
    await countedButton(languageRow, wrongLanguage).click();
    await countedButton(languageRow, correctLanguage).click();
    await expectExactMeetingDestinations(page, expected);
  });

  await audit.step('Clear all SMART filters', 'The exact original frozen result set returns, including every destination and no extras.', async () => {
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(search).toHaveValue('');
    await expectExactMeetingDestinations(page, baseline);
  });

  await audit.attachJson('smart-filter-oracle', {
    target,
    targetDestination,
    controls: { programs, audiences, languages, wrongProgram, wrongAudience, wrongLanguage },
    expected,
    baseline,
  });
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

  await audit.assertRuntimeHealthy();
});

staticTest('[MEET-007] a failed live-meeting index becomes an explicit usable fallback', staticEvidence('Capture the explicit meeting-data failure state with both usable directory recovery links.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!candidateChromium(testInfo) || meta(testInfo).deviceClass !== 'desktop', 'One candidate desktop dependency-failure audit.');
  await page.clock.setFixedTime(new Date('2026-08-24T15:30:00Z'));
  const emptyIndex = JSON.stringify({
    generatedAt: '2026-08-24T15:30:00.000Z',
    featuredNa: null,
    na: [],
    smart: [],
  });
  const scenarios = [
    { name: 'transport-abort', kind: 'failure' as const },
    { name: 'server-500', kind: 'failure' as const },
    { name: 'malformed-json', kind: 'failure' as const },
    { name: 'valid-empty-index', kind: 'empty' as const },
  ];
  const ledger: Array<{ name: string; kind: 'failure' | 'empty'; message: string; recoveryPaths: Array<string | null> }> = [];

  for (const scenario of scenarios) {
    await page.unroute('**/live-meeting-index.json');
    if (scenario.name === 'transport-abort') {
      audit.expectRequestFailure('/live-meeting-index.json');
      await page.route('**/live-meeting-index.json', (route) => route.abort('failed'));
    } else if (scenario.name === 'server-500') {
      audit.expectResponseStatus('/live-meeting-index.json', 500);
      await page.route('**/live-meeting-index.json', (route) => route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'simulated dependency failure' }),
      }));
    } else if (scenario.name === 'malformed-json') {
      await page.route('**/live-meeting-index.json', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{not-json',
      }));
    } else {
      await page.route('**/live-meeting-index.json', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: emptyIndex,
      }));
    }

    await audit.goto(NEXT_PATH);
    await expect(page.getByText('Checking live NA and SMART meetings…')).toHaveCount(0);
    const fallback = page.locator('aside[aria-labelledby="live-general-meetings-heading"]');
    const message = await fallback.locator('p[aria-live="polite"]').innerText();
    const recoveryPaths = await fallback.getByRole('link', { name: /^Browse all/ }).evaluateAll((links) =>
      links.map((link) => (link as HTMLAnchorElement).getAttribute('href')));
    expect(recoveryPaths.sort(), `${scenario.name} must retain both recovery directories`).toEqual([
      '/virtual-na-meetings-now',
      '/virtual-smart-meetings-now',
    ].sort());
    ledger.push({ ...scenario, message, recoveryPaths });
    await audit.checkpoint(`meeting-index-${scenario.name}`);
  }

  expect(scenarios, 'The dependency contract must retain abort, HTTP, malformed, and valid-empty scenarios').toHaveLength(4);
  expect(ledger.map(({ name, kind }) => ({ name, kind })), 'Every declared dependency outcome must produce one inspected record').toEqual(
    scenarios.map(({ name, kind }) => ({ name, kind })),
  );
  await audit.attachJson('meeting-index-outcome-ledger', ledger);
  const errorLanguage = /could not|unavailable|failed|try again|problem loading/i;
  for (const outcome of ledger) {
    if (outcome.kind === 'failure') {
      expect.soft(outcome.message, `${outcome.name} must not masquerade as a valid empty schedule`).toMatch(errorLanguage);
      expect.soft(outcome.message, `${outcome.name} needs different copy from a successful empty index`).not.toBe('No additional live meeting is listed at this moment.');
    } else {
      expect.soft(outcome.message, 'A valid empty index should retain the truthful no-meetings state').toBe('No additional live meeting is listed at this moment.');
      expect.soft(outcome.message, 'A valid empty index is not a dependency error').not.toMatch(errorLanguage);
    }
  }
  audit.observe('Dependency outcomes distinguished', ledger.filter(({ kind, message }) =>
    kind === 'empty' ? message === 'No additional live meeting is listed at this moment.' : errorLanguage.test(message)).length, String(scenarios.length));
});
