import { AxeBuilder } from '@axe-core/playwright';
import { REPRESENTATIVE_A11Y_ROUTES } from '../audit/routes.js';
import { expect, interactionEvidence, interactionTest, staticEvidence, staticTest, test, type AuditRun } from '../fixtures/test.js';

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
  staticTest(`[A11Y-001] automated WCAG scan of ${candidatePath}`, staticEvidence(`Capture the rendered ${candidatePath} state with its automated WCAG violation and incomplete-result evidence.`, 'full-sweep-projects'), async ({ page, audit }) => {
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

interactionTest('[A11Y-002] keyboard path skips navigation and completes search-dialog lifecycle', interactionEvidence('Use only the keyboard to activate skip navigation, open and search, then close the dialog with restored focus.', 'candidate-chromium-projects'), async ({ page, audit }) => {
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
  await audit.step('Complete the keyboard-only skip and search journey', 'Focus enters main content, operates search, and returns to the search trigger after Escape.', async () => {
    await page.keyboard.press('Tab');
    await recordFocus('Tab from document start');
    await expect(skipLink).toBeVisible();
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
    await recordFocus('Activate skip link');

    await page.keyboard.press('Control+K');
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox', { name: 'Search all pages' });
    await expect(input).toBeFocused();
    await input.fill('withdrawal sleep');
    await expect(dialog.getByRole('listbox', { name: 'Search results' })).toBeVisible();
    await expect(dialog.getByRole('option').first()).toBeVisible();
    await recordFocus('Open search and enter a useful query');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel('Search the guide')).toBeFocused();
    await recordFocus('Close search with Escape');
  });

  audit.observe('Keyboard checkpoints', focusJourney.length, '4');
  await audit.attachJson('keyboard-focus-journey', focusJourney);
});

staticTest('[A11Y-005] reduced-motion preference disables decorative animation without removing status text', staticEvidence('Capture the reduced-motion rendered state with computed animation values and equivalent status text.', 'candidate-chromium-projects'), async ({ page, audit }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await audit.goto('/');
  const animatedElements = await page.locator('[class*="animate-"]').evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    return {
      className: node.getAttribute('class'),
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      text: node.textContent?.trim() ?? '',
    };
  }));
  const activeAnimations = animatedElements.filter(({ animationName }) => animationName !== 'none');
  const meetingAction = page.getByRole('link', { name: /meeting/i }).first();

  expect(activeAnimations, 'Decorative animation classes must honor prefers-reduced-motion').toEqual([]);
  await expect(meetingAction).toContainText(/meeting/i);
  audit.observe('Decorative animations still active', activeAnimations.length, '0');
  await audit.attachJson('reduced-motion-evidence', { animatedElements, activeAnimations });
  await audit.checkpoint('reduced-motion-homepage');
});
