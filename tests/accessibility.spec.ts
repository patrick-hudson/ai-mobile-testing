import { AxeBuilder } from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { REPRESENTATIVE_A11Y_ROUTES } from '../audit/routes.js';
import { expect, interactionEvidence, interactionTest, staticEvidence, staticTest, test, type AuditRun } from '../fixtures/test.js';
import { activateSkipLinkAndEnterMain } from './helpers.js';

const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'] as const;

/** Exact Axe rule IDs reviewed as acceptable incomplete results. Empty means fail closed to human review, never silent pass. */
const AXE_INCOMPLETE_ALLOWLIST: ReadonlyMap<string, string> = new Map();

interface AxeReviewEntry {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl?: string;
  nodes: Array<{ target: unknown; html: string; failureSummary?: string | null }>;
}

async function tabUntilFocused(page: Page, target: Locator, maximumTabs = 200): Promise<number> {
  for (let count = 0; count <= maximumTabs; count += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return count;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Keyboard focus did not reach ${await target.evaluate((element) => element.outerHTML.slice(0, 240))} after ${maximumTabs} Tab presses.`);
}

async function focusAppearance(target: Locator): Promise<string> {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.boxShadow, style.borderColor, style.backgroundColor].join('|');
  });
}

async function assertKeyboardFocusVisible(target: Locator, unfocusedAppearance: string): Promise<void> {
  await expect(target).toBeFocused();
  expect(await target.evaluate((element) => element.matches(':focus-visible')), 'Keyboard focus must use the focus-visible state').toBe(true);
  expect(await focusAppearance(target), 'Keyboard focus must change a visible outline, ring, border, or background').not.toBe(unfocusedAppearance);
}

function surfaceIncompleteResults(
  audit: AuditRun,
  entries: readonly AxeReviewEntry[],
  context: string,
): AxeReviewEntry[] {
  const review = entries.filter(({ id }) => !AXE_INCOMPLETE_ALLOWLIST.has(id));
  for (const item of review) {
    audit.finding({
      severity: 'P2',
      title: `Axe manual review: ${item.id} in ${context}`,
      detail: `${item.help}; ${item.nodes.length} node(s) require human determination.${item.helpUrl ? ` ${item.helpUrl}` : ''}`,
      blocking: false,
    });
  }
  return review;
}

for (const candidatePath of REPRESENTATIVE_A11Y_ROUTES) {
  staticTest(`[A11Y-001] automated WCAG scan of ${candidatePath}`, staticEvidence(`Capture the rendered ${candidatePath} state with its automated WCAG violation and incomplete-result evidence.`, 'full-sweep-projects', candidatePath), async ({ page, audit }) => {
    test.skip(audit.environmentPath(candidatePath) === null, 'No production-baseline equivalent exists.');

    await audit.goto(candidatePath);
    const results = await audit.step(
      'Run WCAG A and AA rules',
      'The rendered page has no detectable WCAG A/AA violations.',
      async () => new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]).analyze(),
    );

    const violations = results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      helpUrl: violation.helpUrl,
      description: violation.description,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        html: node.html,
        failureSummary: node.failureSummary,
      })),
    }));

    for (const violation of violations) {
      audit.finding({
        severity: violation.impact === 'critical' || violation.impact === 'serious' ? 'P0' : 'P1',
        title: `${violation.id}: ${violation.help}`,
        detail: `${violation.nodes.length} affected node(s). ${violation.helpUrl}`,
        blocking: true,
      });
    }
    const incompleteReview = surfaceIncompleteResults(audit, results.incomplete, candidatePath);
    audit.observe('Axe rules evaluated', results.passes.length + results.violations.length + results.incomplete.length);
    audit.observe('WCAG violations', violations.length, '0');
    audit.observe('Needs-manual-review results', results.incomplete.length);
    audit.observe('Non-allowlisted incomplete results', incompleteReview.length, 'Review every entry');
    await audit.attachJson('axe-results', {
      testEngine: results.testEngine,
      testEnvironment: results.testEnvironment,
      url: results.url,
      violations,
      incomplete: results.incomplete,
      incompleteReview,
      incompleteAllowlist: [...AXE_INCOMPLETE_ALLOWLIST].map(([id, reason]) => ({ id, reason })),
      tags: WCAG_AA_TAGS,
      inapplicableRuleCount: results.inapplicable.length,
      passedRuleCount: results.passes.length,
    });
    await audit.checkpoint(violations.length > 0 ? 'axe-violation-page' : 'axe-reviewed-page');
    expect(violations, 'Every violation includes selectors and remediation evidence in axe-results.json').toEqual([]);
  });
}

interactionTest('[A11Y-001] opened search dialog has a valid accessible tree', interactionEvidence('Open the search dialog and show its focused interactive state while the accessible tree is scanned.', 'candidate-chromium-projects'), async ({ page, audit }) => {
  await audit.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Search quitting7oh.org' });
  await audit.step('Open the search dialog', 'The accessible dialog appears with keyboard focus in its search input.', async () => {
    await page.getByLabel('Search the guide').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Search all pages' })).toBeFocused();
  });
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').withTags([...WCAG_AA_TAGS]).analyze();
  const incompleteReview = surfaceIncompleteResults(audit, results.incomplete, 'opened search dialog');
  await audit.attachJson('open-dialog-axe-results', {
    ...results,
    incompleteReview,
    incompleteAllowlist: [...AXE_INCOMPLETE_ALLOWLIST].map(([id, reason]) => ({ id, reason })),
    tags: WCAG_AA_TAGS,
  });
  audit.observe('Open-dialog violations', results.violations.length, '0');
  audit.observe('Open-dialog incomplete results requiring review', incompleteReview.length, 'Review every entry');
  expect(results.violations).toEqual([]);
});

interactionTest('[A11Y-002] keyboard-only critical journeys expose logical and visible focus', interactionEvidence('Use only the keyboard for navigation, search, calculator input, disclosure expansion, and meeting filters while showing every response and focus state.', 'candidate-chromium-projects'), async ({ page, audit }) => {
  test.setTimeout(150_000);
  await audit.goto('/start-here/welcome');
  const focusJourney: Array<{ action: string; element: string; label: string }> = [];
  const recordFocus = async (action: string) => {
    focusJourney.push(await page.evaluate((performedAction) => {
      const focused = document.activeElement;
      return {
        action: performedAction,
        element: focused?.tagName.toLowerCase() ?? 'none',
        label: focused?.getAttribute('aria-label') ?? focused?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? '',
      };
    }, action));
  };

  const skipLink = page.getByRole('link', { name: 'Skip to content' });
  const dialog = page.getByRole('dialog', { name: 'Search quitting7oh.org' });
  await audit.step('Complete the keyboard-only skip and search journey', 'Focus enters main content, selects the reviewed result, and Enter opens its exact destination.', async () => {
    await page.keyboard.press('Tab');
    await recordFocus('Tab from document start');
    await expect(skipLink).toBeVisible();
    await expect(skipLink).toBeFocused();
    const skipEntry = await activateSkipLinkAndEnterMain(page);
    await audit.attachJson('skip-link-entry-evidence', skipEntry);
    expect(skipEntry.hash).toBe('#main-content');
    expect(skipEntry.targetMatchesFragment).toBe(true);
    expect(skipEntry.targetInViewport).toBe(true);
    expect(skipEntry.focusWithinMain).toBe(true);
    expect(skipEntry.focusedInViewport).toBe(true);
    expect(skipEntry.focusedUnoccluded).toBe(true);
    expect(skipEntry.focusedUsesFocusVisible).toBe(true);
    await recordFocus('Tab into main content after activating skip link');

    await page.keyboard.press('Control+K');
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox', { name: 'Search all pages' });
    await expect(input).toBeFocused();
    await page.keyboard.type('clonidine');
    await expect(dialog.getByRole('listbox', { name: 'Search results' })).toBeVisible();
    const helperResult = dialog.getByRole('option', { name: /helper medications.*clonidine/i }).first();
    await expect(helperResult).toHaveAttribute('href', '/medications-supplements/helper-meds#clonidine');
    const optionCount = await dialog.getByRole('option').count();
    let activeId: string | null = null;
    let activeHref: string | null = null;
    for (let index = 0; index < optionCount; index += 1) {
      await page.keyboard.press('ArrowDown');
      activeId = await input.getAttribute('aria-activedescendant');
      activeHref = activeId ? await page.locator(`[id="${activeId}"]`).getAttribute('href') : null;
      if (activeHref === '/medications-supplements/helper-meds#clonidine') break;
    }
    expect(activeId, 'ArrowDown must identify an active search option').toBeTruthy();
    expect(activeHref, 'Keyboard selection must reach the exact reviewed helper-medications result').toBe('/medications-supplements/helper-meds#clonidine');
    const activeResult = page.locator(`[id="${activeId}"]`);
    await expect(activeResult).toHaveAttribute('href', '/medications-supplements/helper-meds#clonidine');
    await expect(activeResult).toHaveAttribute('aria-selected', 'true');
    await recordFocus('Select the reviewed search result');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load' }),
      page.keyboard.press('Enter'),
    ]);
    await expect(page).toHaveURL(/\/medications-supplements\/helper-meds\/?#clonidine$/);
    await expect(page.locator('main h1:visible')).toHaveText('Helper Medications');
    await expect(page.locator('#clonidine')).toBeVisible();
    await recordFocus('Open the reviewed search destination');
  });

  await audit.step('Operate guide navigation by keyboard', 'The device-appropriate guide control opens or changes navigation state and Escape/Enter restores it.', async () => {
    await audit.goto('/start-here/what-is-7-oh');
    const mobileOpener = page.getByRole('button', { name: 'Open guide navigation' });
    if (await mobileOpener.isVisible()) {
      const before = await focusAppearance(mobileOpener);
      await tabUntilFocused(page, mobileOpener);
      await assertKeyboardFocusVisible(mobileOpener, before);
      await recordFocus('Reach mobile guide opener');
      await page.keyboard.press('Enter');
      const guide = page.getByRole('dialog', { name: 'Guide navigation' });
      await expect(guide).toBeVisible();
      expect(await guide.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      const welcome = guide.locator('a[href="/start-here/welcome"]');
      const linkBefore = await focusAppearance(welcome);
      await tabUntilFocused(page, welcome);
      await assertKeyboardFocusVisible(welcome, linkBefore);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/start-here\/welcome\/?$/);
      await expect(page.locator('main h1:visible')).toHaveText('Welcome');
    } else {
      const collapse = page.getByRole('button', { name: 'Collapse guide navigation' });
      const before = await focusAppearance(collapse);
      await tabUntilFocused(page, collapse);
      await assertKeyboardFocusVisible(collapse, before);
      await recordFocus('Reach desktop guide control');
      await page.keyboard.press('Enter');
      const expand = page.getByRole('button', { name: 'Expand guide navigation' });
      await expect(expand).toBeVisible();
      await expect(expand).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(collapse).toBeVisible();
      await expect(collapse).toBeFocused();
      const navigation = page.getByRole('complementary', { name: 'Guide navigation' });
      const welcome = navigation.locator('a[href="/start-here/welcome"]');
      const linkBefore = await focusAppearance(welcome);
      await tabUntilFocused(page, welcome);
      await assertKeyboardFocusVisible(welcome, linkBefore);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/start-here\/welcome\/?$/);
      await expect(page.locator('main h1:visible')).toHaveText('Welcome');
    }
    await recordFocus('Complete guide navigation response');
  });

  await audit.step('Edit the taper calculator by keyboard', 'Tab reaches the dose input, its visible focus appears, and typed arithmetic updates the exact daily total.', async () => {
    await audit.goto('/resources/7-oh-taper-calculator');
    const dose = page.getByLabel('Per-dose amount (mg)', { exact: true });
    const before = await focusAppearance(dose);
    await tabUntilFocused(page, dose);
    await assertKeyboardFocusVisible(dose, before);
    await recordFocus('Reach calculator dose');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('20');
    await page.keyboard.press('Tab');
    await expect(page.getByText('80 mg', { exact: true }).first()).toBeVisible();
    await recordFocus('Update calculator total');
  });

  await audit.step('Expand a disclosure by keyboard', 'Tab reaches the summary, visible focus appears, and Enter reveals the exact schedule content.', async () => {
    await audit.goto('/start-here/7-oh-withdrawal-quickstart');
    const summary = page.locator('summary').filter({ hasText: 'Exact liposomal vitamin C schedule' });
    const before = await focusAppearance(summary);
    await tabUntilFocused(page, summary);
    await assertKeyboardFocusVisible(summary, before);
    await recordFocus('Reach vitamin C disclosure');
    await page.keyboard.press('Enter');
    await expect(page.locator('details').filter({ has: summary })).toHaveAttribute('open', '');
    await expect(page.getByText(/Days 1 to 2: 2 grams per day/)).toBeVisible();
    await recordFocus('Expand vitamin C disclosure');
  });

  await audit.step('Filter meetings by keyboard', 'Tab reaches the meeting search, visible focus appears, and an impossible query produces explicit empty-state feedback.', async () => {
    await audit.goto('/virtual-na-meetings-now');
    const meetingSearch = page.getByRole('searchbox', { name: 'Search meetings' });
    await expect(meetingSearch).toBeVisible();
    const before = await focusAppearance(meetingSearch);
    await tabUntilFocused(page, meetingSearch);
    await assertKeyboardFocusVisible(meetingSearch, before);
    await recordFocus('Reach meeting filter');
    await page.keyboard.type('zzzz-no-meeting-audit');
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    expect(await page.getByText('Nothing in this window matches your filters.', { exact: true }).count(), 'The filter must visibly update at least one meeting pane').toBeGreaterThan(0);
    await recordFocus('Apply meeting filter');
  });

  audit.observe('Keyboard checkpoints', focusJourney.length, '12');
  expect(focusJourney, 'Every critical keyboard task must contribute two recorded focus/response checkpoints').toHaveLength(12);
  await audit.attachJson('keyboard-focus-journey', focusJourney);
  await audit.assertRuntimeHealthy();
});

staticTest('[A11Y-005] reduced-motion preference disables decorative animation without removing status text', staticEvidence('Capture the reduced-motion rendered state with a complete computed motion ledger and exact non-color meeting status semantics.', 'candidate-chromium-projects'), async ({ page, audit }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.setFixedTime(new Date('2026-08-24T14:10:00Z'));
  await audit.goto('/');
  const supportPanel = page.locator('section[aria-labelledby="right-now-title"]');
  const liveStatus = supportPanel.locator('[aria-live="polite"]').filter({ hasText: 'Live now · 7-OH / kratom' });
  await expect(supportPanel.locator('xpath=ancestor::astro-island[1]'), 'The support panel must hydrate before computed motion is inspected').not.toHaveAttribute('ssr', '');
  await expect(liveStatus, 'Meeting state must expose one exact polite live-status announcement').toHaveCount(1);
  await expect(liveStatus, 'Meeting state must remain expressed in exact text rather than success color alone').toHaveText('Live now · 7-OH / kratom');
  await expect(supportPanel.getByRole('link', { name: 'Join live', exact: true })).toBeVisible();
  const motionLedger = await page.locator('body *').evaluateAll((nodes) => {
    const ACTIVE_MOTION_THRESHOLD_SECONDS = 0.001;
    const seconds = (value: string) => value.split(',').map((part) => {
      const token = part.trim();
      const amount = Number.parseFloat(token);
      return Number.isFinite(amount) ? (token.endsWith('ms') ? amount / 1_000 : amount) : 0;
    });
    const repeated = <T>(values: T[], index: number, fallback: T) => values.length > 0 ? values[index % values.length]! : fallback;
    return nodes.flatMap((node) => {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || box.width <= 0 || box.height <= 0) return [];
      const animationNames = style.animationName.split(',').map((name) => name.trim());
      const animationDurations = seconds(style.animationDuration);
      const animationIterations = style.animationIterationCount.split(',').map((value) => value.trim());
      const animationPlayStates = style.animationPlayState.split(',').map((value) => value.trim());
      const animationActive = animationNames.some((name, index) => name !== 'none'
        && repeated(animationDurations, index, 0) > ACTIVE_MOTION_THRESHOLD_SECONDS
        && repeated(animationIterations, index, '1') !== '0'
        && repeated(animationPlayStates, index, 'running') !== 'paused');
      const motionProperties = style.transitionProperty.split(',').map((property) => property.trim());
      const transitionDurations = seconds(style.transitionDuration);
      const transitionActive = motionProperties.some((property, index) =>
        /^(?:all|transform|translate|scale|rotate|opacity|top|right|bottom|left|width|height|max-width|max-height)$/i.test(property)
        && repeated(transitionDurations, index, 0) > ACTIVE_MOTION_THRESHOLD_SECONDS);
      if (!animationActive && !transitionActive) return [];
      return [{
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        className: element.getAttribute('class'),
        text: element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? '',
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationIterationCount: style.animationIterationCount,
        animationPlayState: style.animationPlayState,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        animationActive,
        transitionActive,
      }];
    });
  });
  const activeAnimations = motionLedger.filter(({ animationActive }) => animationActive);
  const activeMotionTransitions = motionLedger.filter(({ transitionActive }) => transitionActive);

  expect(activeAnimations, 'Every computed decorative animation must honor prefers-reduced-motion, regardless of class name').toEqual([]);
  expect(activeMotionTransitions, 'Transform, opacity, position, and size transitions must be removed under prefers-reduced-motion').toEqual([]);
  audit.observe('Computed animations still active', activeAnimations.length, '0');
  audit.observe('Computed motion transitions still active', activeMotionTransitions.length, '0');
  await audit.attachJson('reduced-motion-evidence', { motionLedger, activeAnimations, activeMotionTransitions, statusText: await liveStatus.innerText() });
  await audit.checkpoint('reduced-motion-homepage');
});
