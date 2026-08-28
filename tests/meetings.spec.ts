import { test, expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { auditMeta, isChromiumAuditProject, usesReviewedSiteContract } from './helpers.js';
import type { Locator, Page } from '@playwright/test';

const NEXT_PATH = '/next-kratom-support-meeting';
const NA_PATH = '/virtual-na-meetings-now';
const SMART_PATH = '/virtual-smart-meetings-now';
const MEET_FILTER_TOTAL_TIMEOUT_MS = 180_000;
const MEET_FILTER_PREPARATION_BUDGET_MS = 120_000;
const KA_WEEKDAY_DISCUSSION_URL = 'https://us06web.zoom.us/j/85416304667?pwd=pkbSAebEMTzfj65ldpcbekavV2Yi0k.1';
const TIAWO_MAIN_ROOM_URL = 'https://meet.google.com/cza-tyjv-fun';

interface FeaturedOccurrenceOracle {
  heading: string;
  schedule: string;
  platform: string;
  joinUrl: string;
}

function featuredMeetingCard(page: Page, occurrence: FeaturedOccurrenceOracle): Locator {
  return page.getByRole('heading', { level: 2, name: occurrence.heading, exact: true }).locator('..');
}

async function expectFeaturedOccurrence(page: Page, occurrence: FeaturedOccurrenceOracle): Promise<Locator> {
  const card = featuredMeetingCard(page, occurrence);
  await expect(card).toHaveCount(1);
  await expect(card.getByText(occurrence.schedule, { exact: true })).toBeVisible();
  await expect(card.getByText(occurrence.platform, { exact: true })).toBeVisible();
  await expect(card.getByRole('link', { name: `Join in ${occurrence.platform}`, exact: true })).toHaveAttribute('href', occurrence.joinUrl);
  return card;
}

function currentSiteChromium(testInfo: Parameters<typeof auditMeta>[0]): boolean {
  return usesReviewedSiteContract(testInfo) && isChromiumAuditProject(testInfo);
}

async function waitForHydratedIsland(page: Page, control: Locator): Promise<void> {
  const island = page.locator('astro-island').filter({ has: control }).first();
  await expect(island).not.toHaveAttribute('ssr', '');
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

staticTest('[MEET-001] meeting cards cross pre-live, starting, live, and ended boundaries', staticEvidence('Capture the deterministic meeting state at each frozen time boundary with the complete state ledger.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One deterministic reviewed-site desktop time-state audit.');
  const states = [
    {
      at: '2026-08-24T13:50:00Z',
      expectedState: 'Starting soon',
      occurrence: { heading: 'Kratom Anonymous — Discussion', schedule: 'Today at 9:00 AM your time', platform: 'Zoom', joinUrl: KA_WEEKDAY_DISCUSSION_URL },
    },
    {
      at: '2026-08-24T14:02:00Z',
      expectedState: 'Meeting starting',
      occurrence: { heading: 'Kratom Anonymous — Discussion', schedule: 'Today at 9:00 AM your time', platform: 'Zoom', joinUrl: KA_WEEKDAY_DISCUSSION_URL },
    },
    {
      at: '2026-08-24T14:10:00Z',
      expectedState: 'Live now',
      occurrence: { heading: 'Kratom Anonymous — Discussion', schedule: 'Today at 9:00 AM your time', platform: 'Zoom', joinUrl: KA_WEEKDAY_DISCUSSION_URL },
    },
    {
      at: '2026-08-24T15:00:00Z',
      expectedState: 'Next up',
      occurrence: { heading: 'TIAWO — Midday', schedule: 'Today at 11:00 AM your time', platform: 'Google Meet', joinUrl: TIAWO_MAIN_ROOM_URL },
    },
  ] as const;

  for (const state of states) {
    await audit.step(`Freeze time at ${state.at}`, `The exact ${state.occurrence.heading} occurrence reads “${state.expectedState}”.`, async () => {
      await page.clock.setFixedTime(new Date(state.at));
      await audit.goto(NEXT_PATH);
      const card = await expectFeaturedOccurrence(page, state.occurrence);
      await expect(card.getByText(state.expectedState, { exact: true })).toBeVisible();
      if (state.expectedState === 'Next up') {
        const noSpecificMeeting = page.locator('aside[aria-labelledby="live-general-meetings-heading"]');
        await expect(noSpecificMeeting.getByRole('heading', { name: 'Need a meeting before the next 7-OH/kratom meeting?', exact: true })).toBeVisible();
        await expect(noSpecificMeeting.getByText('No KA or TIAWO meeting is live right now. These general recovery meetings are joinable now.', { exact: true })).toBeVisible();
      }
      audit.observe(`featured occurrence at ${state.at}`, JSON.stringify({
        state: state.expectedState,
        heading: state.occurrence.heading,
        schedule: state.occurrence.schedule,
        joinUrl: state.occurrence.joinUrl,
      }), 'Exact reviewed occurrence identity and state');
    });
  }

  await audit.checkpoint('meeting-after-end-transition');
  await audit.assertRuntimeHealthy();
});

staticTest('[MEET-002] the same occurrence is converted across representative timezones', staticEvidence('Capture the same meeting occurrence with its exact rendered labels across representative timezones.', 'candidate-desktop-chromium'), async ({ browser, page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One deterministic reviewed-site multi-timezone audit.');
  const occurrence: Omit<FeaturedOccurrenceOracle, 'schedule'> = {
    heading: 'TIAWO — Morning',
    platform: 'Google Meet',
    joinUrl: TIAWO_MAIN_ROOM_URL,
  };
  const cases = [
    { season: 'summer', fixed: '2026-08-24T11:30:00Z', utcStart: '2026-08-24T12:00:00Z', timezoneId: 'America/Chicago', display: 'Today at 7:00 AM' },
    { season: 'summer', fixed: '2026-08-24T11:30:00Z', utcStart: '2026-08-24T12:00:00Z', timezoneId: 'America/Los_Angeles', display: 'Today at 5:00 AM' },
    { season: 'summer', fixed: '2026-08-24T11:30:00Z', utcStart: '2026-08-24T12:00:00Z', timezoneId: 'Europe/London', display: 'Today at 1:00 PM' },
    { season: 'summer', fixed: '2026-08-24T11:30:00Z', utcStart: '2026-08-24T12:00:00Z', timezoneId: 'Asia/Kolkata', display: 'Today at 5:30 PM' },
    { season: 'winter', fixed: '2026-01-12T12:30:00Z', utcStart: '2026-01-12T13:00:00Z', timezoneId: 'America/Chicago', display: 'Today at 7:00 AM' },
    { season: 'winter', fixed: '2026-01-12T12:30:00Z', utcStart: '2026-01-12T13:00:00Z', timezoneId: 'America/Los_Angeles', display: 'Today at 5:00 AM' },
    { season: 'winter', fixed: '2026-01-12T12:30:00Z', utcStart: '2026-01-12T13:00:00Z', timezoneId: 'Europe/London', display: 'Today at 1:00 PM' },
    { season: 'winter', fixed: '2026-01-12T12:30:00Z', utcStart: '2026-01-12T13:00:00Z', timezoneId: 'Asia/Kolkata', display: 'Today at 6:30 PM' },
  ] as const;
  const observed: Record<string, string> = {};
  const projectContext = testInfo.project.use as {
    ignoreHTTPSErrors?: boolean;
    locale?: string;
    userAgent?: string;
  };

  for (const item of cases) {
    await audit.step(`Render in ${item.timezoneId} during ${item.season}`, `The exact TIAWO Morning occurrence at ${item.utcStart} displays as ${item.display}.`, async () => {
      const context = await browser.newContext({
        timezoneId: item.timezoneId,
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: projectContext.ignoreHTTPSErrors ?? false,
        ...(projectContext.locale ? { locale: projectContext.locale } : {}),
        ...(projectContext.userAgent ? { userAgent: projectContext.userAgent } : {}),
      });
      try {
        const localPage = await context.newPage();
        await localPage.clock.setFixedTime(new Date(item.fixed));
        await localPage.goto(`${audit.environmentBaseURL()}${NEXT_PATH}`, { waitUntil: 'load' });
        const reviewedOccurrence = { ...occurrence, schedule: `${item.display} your time` };
        const card = await expectFeaturedOccurrence(localPage, reviewedOccurrence);
        const text = await card.getByText(reviewedOccurrence.schedule, { exact: true }).innerText();
        const observationKey = `${item.season}:${item.timezoneId}`;
        observed[observationKey] = text;
        expect(text).toBe(reviewedOccurrence.schedule);
        if (item.season === 'summer' && item.timezoneId === 'America/Chicago') {
          const screenshot = testInfo.outputPath('meeting-timezone-reference.png');
          await card.screenshot({ path: screenshot });
          await testInfo.attach('meeting-timezone-reference', { path: screenshot, contentType: 'image/png' });
        }
      } finally {
        await context.close();
      }
    });
  }

  expect(cases, 'The timezone contract must retain four regions in both DST seasons').toHaveLength(8);
  expect(Object.keys(observed), 'Every seasonal timezone case must produce one exact rendered label').toEqual(cases.map(({ season, timezoneId }) => `${season}:${timezoneId}`));
  await audit.attachJson('timezone-conversions', {
    meeting: occurrence,
    occurrences: [...new Set(cases.map(({ utcStart }) => utcStart))],
    observed,
  });
  await page.clock.setFixedTime(new Date('2026-08-24T11:30:00Z'));
  await audit.goto(NEXT_PATH);
  await expectFeaturedOccurrence(page, { ...occurrence, schedule: 'Today at 7:00 AM your time' });
  await audit.checkpoint('meeting-timezone-central-reference');
});

interactionTest('[MEET-003] a joined room persists across pages and can be cleared', interactionEvidence('Join a featured room, navigate to meeting history, and clear it while showing persistence and removal.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium meeting-history audit.');
  await page.clock.setFixedTime(new Date('2026-08-24T13:30:00Z'));
  await audit.goto(NEXT_PATH);

  const reviewedHistory = [
    { provider: 'KA', meetingId: 'ka-weekday-10-discussion', name: 'Kratom Anonymous — Discussion', joinUrl: KA_WEEKDAY_DISCUSSION_URL },
    { provider: 'KQS', meetingId: 'kqs-daily-12-midday', name: 'TIAWO — Midday', joinUrl: TIAWO_MAIN_ROOM_URL },
  ] as const;

  const activateExternalJoin = async (join: Locator, expectedDestination: string): Promise<void> => {
    await expect(join).toHaveAttribute('href', expectedDestination);
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
  };

  await audit.step('Join two exact reviewed rooms', 'Each exact external destination opens and creates its own complete history identity.', async () => {
    const featuredCard = await expectFeaturedOccurrence(page, {
      heading: reviewedHistory[0].name,
      schedule: 'Today at 9:00 AM your time',
      platform: 'Zoom',
      joinUrl: reviewedHistory[0].joinUrl,
    });
    await activateExternalJoin(featuredCard.getByRole('link', { name: 'Join in Zoom', exact: true }), reviewedHistory[0].joinUrl);
    await activateExternalJoin(page.locator(`a[href="${reviewedHistory[1].joinUrl}"]`).filter({ hasText: /^Join$/ }).first(), reviewedHistory[1].joinUrl);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('quitting7oh:meeting-history:v1') ?? '[]'));
    expect(stored).toHaveLength(2);
    expect(stored.map(({ provider, meetingId, name, joinUrl }: { provider: string; meetingId: string; name: string; joinUrl: string }) =>
      ({ provider, meetingId, name, joinUrl })).sort((a: { meetingId: string }, b: { meetingId: string }) => a.meetingId.localeCompare(b.meetingId)))
      .toEqual([...reviewedHistory].sort((a, b) => a.meetingId.localeCompare(b.meetingId)));
  });

  await audit.step('Open another meeting page', 'The previously joined section shows both exact saved identities and destinations.', async () => {
    await audit.goto('/resources/meeting-schedules');
    const history = page.locator('section[aria-labelledby="previously-joined-title"]');
    await expect(history).toBeVisible();
    for (const entry of reviewedHistory) {
      await expect(history.locator(`a[href="${entry.joinUrl}"]`)).toHaveCount(1);
    }
  });

  await audit.step('Remove one exact history entry', 'An individual removal control deletes only Kratom Anonymous and leaves TIAWO intact.', async () => {
    const removal = page.getByRole('button', { name: `Remove ${reviewedHistory[0].name} from history`, exact: true });
    if (await removal.count() === 0) {
      audit.finding({
        severity: 'P1',
        title: 'Meeting history has no individual removal control',
        detail: `MEET-003 promises individual and full clearing, but the rendered history exposes only “Clear history”; ${reviewedHistory[0].name} cannot be removed without deleting ${reviewedHistory[1].name}.`,
        blocking: true,
      });
      audit.observe('individual removal controls', 0, 'One accessible removal control per saved meeting');
      return;
    }
    await removal.click();
    const history = page.locator('section[aria-labelledby="previously-joined-title"]');
    await expect(history.locator(`a[href="${reviewedHistory[0].joinUrl}"]`)).toHaveCount(0);
    await expect(history.locator(`a[href="${reviewedHistory[1].joinUrl}"]`)).toHaveCount(1);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('quitting7oh:meeting-history:v1') ?? '[]'));
    expect(stored.map(({ meetingId }: { meetingId: string }) => meetingId)).toEqual([reviewedHistory[1].meetingId]);
  });

  await audit.step('Clear all history', 'The full-clear control removes every remaining exact entry and the dedicated storage record.', async () => {
    await page.getByRole('button', { name: 'Clear history' }).click();
    await expect(page.getByRole('heading', { name: 'Previously joined' })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('quitting7oh:meeting-history:v1'))).toBeNull();
  });

  await audit.assertRuntimeHealthy();
});

interactionTest('[MEET-004] NA search, type, access, and platform filters combine and clear', interactionEvidence('Combine NA meeting search and filter controls, then clear them and show the result list returning.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One reviewed-site desktop NA directory audit.');
  testInfo.setTimeout(MEET_FILTER_TOTAL_TIMEOUT_MS);
  const preparationStartedAt = Date.now();
  await page.clock.setFixedTime(new Date('2026-08-24T12:30:00Z'));
  await audit.goto(NA_PATH);
  const search = page.getByLabel('Search meetings');
  await waitForHydratedIsland(page, search);
  const baseline = await visibleMeetingDestinations(page);
  expect(baseline.length, 'Frozen NA window must contain enough records to expose no-op filters').toBeGreaterThan(1);
  const target = {
    name: 'Voices or Choices Group',
    closed: 'Open',
    platform: 'Zoom',
    joinUrl: 'https://zoom.us/j/429250064?pwd=740835',
    correctTag: 'JFT Study',
    wrongTag: 'Basic Text Study',
    wrongPlatform: 'Phone Call',
  } as const;
  const platformRow = page.getByText('Platform:', { exact: true }).locator('..');
  expect(baseline, 'The independent reviewed NA fixture must be present in the frozen visible window').toContain(target.joinUrl);
  const expected = [target.joinUrl];
  await expect(page.getByRole('button', { name: target.correctTag, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: target.wrongTag, exact: true })).toBeVisible();
  await expect(platformRow.getByRole('button', { name: new RegExp(`^${target.platform}\\s*\\(`) })).toBeVisible();
  await expect(platformRow.getByRole('button', { name: new RegExp(`^${target.wrongPlatform}\\s*\\(`) })).toBeVisible();
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

    await page.getByRole('button', { name: target.wrongTag, exact: true }).click();
    await expectExactMeetingDestinations(page, []);
    await page.getByRole('button', { name: target.wrongTag, exact: true }).click();
    await page.getByRole('button', { name: target.correctTag, exact: true }).click();
    await expectExactMeetingDestinations(page, expected);

    await page.getByRole('button', { name: target.closed === 'Open' ? /^closed$/i : /^open$/i }).click();
    await expectExactMeetingDestinations(page, []);
    await page.getByRole('button', { name: new RegExp(`^${target.closed}$`, 'i') }).click();
    await expectExactMeetingDestinations(page, expected);

    await platformRow.getByRole('button', { name: new RegExp(`^${escapeRegExp(target.wrongPlatform)}\\s*\\(`) }).click();
    await expectExactMeetingDestinations(page, []);
    await platformRow.getByRole('button', { name: new RegExp(`^${escapeRegExp(target.wrongPlatform)}\\s*\\(`) }).click();
    await platformRow.getByRole('button', { name: new RegExp(`^${escapeRegExp(target.platform)}\\s*\\(`) }).click();
    await expectExactMeetingDestinations(page, expected);
  });

  await audit.step('Clear all NA filters', 'The exact original frozen result set returns, including every destination and no extras.', async () => {
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(search).toHaveValue('');
    await expectExactMeetingDestinations(page, baseline);
  });

  await audit.attachJson('na-filter-oracle', { oracle: 'Independent reviewed fixture constant; no candidate bundle metadata is read to choose expectations.', target, expected, baseline });
  await audit.assertRuntimeHealthy();
});

interactionTest('[MEET-005] SMART program, audience, language, and search filters combine and clear', interactionEvidence('Combine SMART meeting search and filter controls, then clear them and show usable results returning.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One reviewed-site desktop SMART directory audit.');
  await page.clock.setFixedTime(new Date('2026-08-24T12:30:00Z'));
  await audit.goto(SMART_PATH);
  const search = page.getByLabel('Search meetings');
  await waitForHydratedIsland(page, search);
  const baseline = await visibleMeetingDestinations(page);
  expect(baseline.length, 'Frozen SMART window must contain enough records to expose no-op filters').toBeGreaterThan(1);
  const target = {
    name: '4-Point Recovery — Meagan S.',
    targetDestination: 'https://meetings.smartrecovery.org/meetings/9125/',
    program: '4-Point Recovery',
    audience: 'LGBTQIA+',
    language: 'English',
    wrongProgram: 'Family & Friends',
    wrongAudience: 'Women',
    wrongLanguage: 'Spanish',
  } as const;
  expect(baseline, 'The independent reviewed SMART fixture must be present in the frozen visible window').toContain(target.targetDestination);
  const programRow = page.getByText('Program:', { exact: true }).locator('..');
  const audienceRow = page.getByText('Audience:', { exact: true }).locator('..');
  const languageRow = page.getByText('Language:', { exact: true }).locator('..');
  const expected = [target.targetDestination];
  const countedButton = (row: Locator, value: string) => row.getByRole('button', {
    name: new RegExp(`^${escapeRegExp(value)}\\s*\\(`),
  });

  if (await countedButton(audienceRow, 'Adults').count() === 0) {
    audit.finding({
      severity: 'P1',
      title: 'SMART’s primary Adults audience cannot be selected',
      detail: 'The reviewed feed labels 380 meetings as “Adults”, but the audience controls offer “Adults Welcome”; the mismatched value hides the chip and prevents readers from selecting the dominant audience.',
      blocking: true,
    });
    audit.observe('Adults audience control', 0, 'One selectable Adults audience control with a nonzero count');
  }

  await audit.step('Prove each SMART filter changes an exact nonempty result set', 'Search isolates one reviewed record; every wrong control removes it and every matching control restores exactly it.', async () => {
    await search.fill(target.name);
    await expectExactMeetingDestinations(page, expected);

    await countedButton(programRow, target.wrongProgram).click();
    await expectExactMeetingDestinations(page, []);
    await countedButton(programRow, target.wrongProgram).click();
    await countedButton(programRow, target.program).click();
    await expectExactMeetingDestinations(page, expected);

    await countedButton(audienceRow, target.wrongAudience).click();
    await expectExactMeetingDestinations(page, []);
    await countedButton(audienceRow, target.wrongAudience).click();
    await countedButton(audienceRow, target.audience).click();
    await expectExactMeetingDestinations(page, expected);

    await countedButton(languageRow, target.wrongLanguage).click();
    await expectExactMeetingDestinations(page, []);
    await countedButton(languageRow, target.wrongLanguage).click();
    await countedButton(languageRow, target.language).click();
    await expectExactMeetingDestinations(page, expected);
  });

  await audit.step('Clear all SMART filters', 'The exact original frozen result set returns, including every destination and no extras.', async () => {
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(search).toHaveValue('');
    await expectExactMeetingDestinations(page, baseline);
  });

  await audit.attachJson('smart-filter-oracle', {
    oracle: 'Independent reviewed fixture constant; no candidate bundle metadata is read to choose expectations.',
    target,
    expected,
    baseline,
  });
  await audit.assertRuntimeHealthy();
});

interactionTest('[MEET-006] meeting copy text agrees with the displayed join destination', interactionEvidence('Activate meeting copy and show the clipboard text matching the visible name, schedule, and join URL.', 'candidate-chromium-projects'), async ({ page, context, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo), 'Reviewed-site Chromium meeting copy audit.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.setFixedTime(new Date('2026-08-24T12:30:00Z'));
  await audit.goto(NA_PATH);
  await waitForHydratedIsland(page, page.getByLabel('Search meetings'));

  const featured = {
    name: 'NA 24/7 Online Meeting',
    schedule: '24/7 — join any time',
    platform: 'Zoom',
    room: '558 544 927',
    passcode: '247247',
    joinUrl: 'https://us02web.zoom.us/j/558544927?pwd=247247',
    copy: 'NA Meeting: NA 24/7 Online Meeting\nFormat Varies, It Works Study, Step/Tradition · Closed\n24/7 — join any time\nZoom · Room 558 544 927 · Passcode 247247\nhttps://us02web.zoom.us/j/558544927?pwd=247247',
  } as const;
  const phone = {
    name: "It's Another Way Monday Group",
    schedule: 'Mondays at 6:30 PM (your local time)',
    displayedTime: '6:30 PM',
    platform: 'Phone Call',
    room: '(425) 436-6321',
    accessCode: '4831484',
    joinUrl: 'tel:+14254366321',
    copy: "NA Meeting: It's Another Way Monday Group\nFormat Varies, Just For Today Study, Literature Study, Phone Meeting · Open\nMondays at 6:30 PM (your local time)\nPhone Call · Room (425) 436-6321 · Access code 4831484\ntel:+14254366321",
  } as const;

  await audit.step('Copy and open the featured 24/7 room', 'The exact featured card agrees on name, schedule, platform, copy payload, and the external navigation request.', async () => {
    const card = page.getByRole('heading', { level: 2, name: featured.name, exact: true }).locator('..');
    await expect(card).toHaveCount(1);
    await expect(card.getByText(featured.schedule, { exact: true })).toBeVisible();
    await expect(card.getByText(featured.platform, { exact: true })).toBeVisible();
    await expect(card.getByText(`Room ${featured.room}`, { exact: true })).toBeVisible();
    await expect(card.getByText(`Passcode ${featured.passcode}`, { exact: true })).toBeVisible();
    const join = card.getByRole('link', { name: 'Join the 24/7 room' });
    await expect(join).toHaveAttribute('href', featured.joinUrl);
    await card.getByRole('button', { name: 'Copy meeting details to clipboard' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied, 'Featured copy must exactly reproduce every displayed connection detail').toBe(featured.copy);

    let capturedDestination: string | null = null;
    const routeMatcher = (url: URL) => url.href === featured.joinUrl;
    await context.route(routeMatcher, async (route) => {
      expect(route.request().isNavigationRequest(), 'The external join action must initiate document navigation').toBe(true);
      capturedDestination = route.request().url();
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>NA room captured</title><h1>Exact NA room requested</h1>' });
    });
    let popup: Page | null = null;
    try {
      [popup] = await Promise.all([page.waitForEvent('popup'), join.click()]);
      await popup.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      expect(capturedDestination).toBe(featured.joinUrl);
      expect(popup.url()).toBe(featured.joinUrl);
      await expect(popup.getByRole('heading', { name: 'Exact NA room requested', exact: true })).toBeVisible();
      await audit.holdSecondaryPageOutcome(popup, 'exact featured NA external destination');
    } finally {
      if (popup && !popup.isClosed()) await popup.close();
      await context.unroute(routeMatcher);
    }
    audit.observe('featured copy and action', JSON.stringify({ copied, capturedDestination }), JSON.stringify(featured));
  });

  await audit.step('Copy and activate a reviewed phone meeting', 'The exact phone card agrees on name, local schedule, platform, access code, copy payload, and trusted tel action.', async () => {
    const search = page.getByLabel('Search meetings');
    await search.fill(phone.name);
    const card = page.getByText(phone.name, { exact: true }).locator('xpath=ancestor::li[contains(@class,"field-card")][1]');
    await expect(card).toHaveCount(1);
    await expect(card.getByText(phone.displayedTime, { exact: true })).toBeVisible();
    await expect(card).toContainText(phone.platform);
    await expect(card).toContainText(`Room ${phone.room}`);
    await expect(card.getByText(`Access code: ${phone.accessCode}`, { exact: true })).toBeVisible();
    const call = card.getByRole('link', { name: `Call ${phone.room}`, exact: true });
    await expect(call).toHaveAttribute('href', phone.joinUrl);

    await card.getByRole('button', { name: 'Copy meeting details to clipboard' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied, 'Phone copy must exactly reproduce the visible schedule and connection details').toBe(phone.copy);

    await page.evaluate(() => {
      delete (window as Window & { __auditPhoneActivation?: { href: string; trusted: boolean } }).__auditPhoneActivation;
      document.addEventListener('click', (event) => {
        const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="tel:"]');
        if (!anchor) return;
        (window as Window & { __auditPhoneActivation?: { href: string; trusted: boolean } }).__auditPhoneActivation = {
          href: anchor.href,
          trusted: event.isTrusted,
        };
      }, { capture: true, once: true });
    });
    await call.click();
    const activation = await page.evaluate(() =>
      (window as Window & { __auditPhoneActivation?: { href: string; trusted: boolean } }).__auditPhoneActivation);
    expect(activation, 'The rendered phone control must receive a trusted browser click').toEqual({ href: phone.joinUrl, trusted: true });
    expect(phone.schedule).toContain(phone.displayedTime);
    audit.observe('phone copy and action', JSON.stringify({ copied, activation }), JSON.stringify(phone));
  });

  await audit.assertRuntimeHealthy();
});

staticTest('[MEET-007] a failed live-meeting index becomes an explicit usable fallback', staticEvidence('Capture the explicit meeting-data failure state with both usable directory recovery links.', 'candidate-desktop-chromium'), async ({ page, audit }, testInfo) => {
  test.skip(!currentSiteChromium(testInfo) || auditMeta(testInfo).deviceClass !== 'desktop', 'One reviewed-site desktop dependency-failure audit.');
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
