import { expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { CRISIS_ACTIONS, CRISIS_MEETING_FALLBACK } from './crisis-contract.js';
import { loggedGet } from './helpers.js';

interactionTest('[HOME-001] homepage exposes clear starting paths instead of a decorative shell', interactionEvidence('Activate a primary homepage starting path and show its intended guide destination loading successfully.', 'all-projects'), async ({ page, audit }) => {
  await audit.goto('/');
  await expect(page.locator('h1')).toContainText(/7-OH/i);
  await expect(page.locator('main')).toContainText(/withdrawal|quit|recovery/i);

  const startingPaths = await page.locator('main a[href^="/"]').evaluateAll((anchors) => anchors.map((node) => ({
    href: (node as HTMLAnchorElement).getAttribute('href') ?? '',
    label: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
  })).filter(({ label }) => /withdrawal|quit|medication|meeting|support|guide|calculator/i.test(label)));

  expect(startingPaths.length, 'The homepage should offer multiple concrete recovery paths').toBeGreaterThanOrEqual(2);
  expect(startingPaths.some(({ href }) => /start-here|resources|medications|other-tools/.test(href))).toBe(true);
  const chosen = startingPaths.find(({ href }) => href.startsWith('/') && /start-here|resources|medications|other-tools/.test(href));
  expect(chosen, 'At least one visible starting path must be an internal guide destination').toBeTruthy();
  if (chosen) {
    await audit.step('Activate a primary starting path', 'The chosen homepage action loads its intended guide page.', async () => {
      await page.locator(`main a[href="${chosen.href}"]`).first().click();
      await expect(page).toHaveURL(new RegExp(`${chosen.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`));
      await expect(page.locator('main h1')).toBeVisible();
    });
  }
  audit.observe('Actionable starting paths', startingPaths.length, 'At least 2');
  await audit.attachJson('homepage-starting-paths', startingPaths);
  await audit.assertRuntimeHealthy();
});

staticTest('[CRISIS-002] withdrawal fast path exposes exact urgent-help destinations', staticEvidence('Capture every reviewed crisis action, its exact destination, and the deterministic live-meeting fallback.', 'candidate-projects'), async ({ page, request, audit }) => {
  await audit.goto('/start-here/7-oh-withdrawal-help');
  await expect(page.locator('h1')).toContainText(/withdrawal|okay|help/i);
  await expect(page.locator('main')).toContainText(/help|support|withdrawal/i);

  for (const expected of CRISIS_ACTIONS) {
    const action = page.getByRole('link', { name: expected.name, exact: typeof expected.name === 'string' });
    await expect(action, `${String(expected.name)} must remain a visible crisis action`).toBeVisible();
    await expect(action, `${String(expected.name)} must retain its reviewed destination`).toHaveAttribute('href', expected.href);
  }

  const renderedMeeting = page.locator('main a[href]').filter({ hasText: /7-OH\/kratom meeting|Find the next live meeting/i }).first();
  await expect(renderedMeeting, 'The live-meeting action must remain visible after hydration').toBeVisible();
  const renderedMeetingHref = await renderedMeeting.getAttribute('href');
  expect(renderedMeetingHref, 'The live-meeting action must have a destination').toBeTruthy();
  if (renderedMeetingHref !== CRISIS_MEETING_FALLBACK) {
    expect(new URL(renderedMeetingHref!).protocol, 'A live external meeting must be HTTPS').toBe('https:');
    await expect(renderedMeeting).toHaveAttribute('target', '_blank');
    await expect(renderedMeeting).toHaveAttribute('rel', /\bnoopener\b.*\bnoreferrer\b|\bnoreferrer\b.*\bnoopener\b/);
  }

  const serverDocument = await loggedGet(request, audit, '/start-here/7-oh-withdrawal-help');
  const serverHtml = await serverDocument.text();
  expect(serverDocument.status(), 'The deterministic meeting fallback document must load').toBe(200);
  expect(serverHtml, 'The crisis page must retain an exact same-site meeting fallback before hydration').toContain(`href="${CRISIS_MEETING_FALLBACK}"`);

  const actions = await page.locator('main a[href]').evaluateAll((anchors) => anchors.map((node) => ({
    href: node.getAttribute('href'),
    label: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
  })));
  audit.observe('Reviewed urgent support actions', CRISIS_ACTIONS.length + 1, String(CRISIS_ACTIONS.length + 1));
  await audit.attachJson('urgent-support-actions', { contract: CRISIS_ACTIONS, renderedMeetingHref, actions });
  await audit.checkpoint('withdrawal-fast-path');
  await audit.assertRuntimeHealthy();
});

staticTest('[REL-001] primary page has no browser or first-party loading failures', staticEvidence('Capture the loaded primary page with its browser, request, response, and rendered-health evidence.', 'all-projects'), async ({ audit }) => {
  await audit.goto('/');
  const inspection = await audit.inspectPage();
  audit.observe('Document height', inspection.documentHeight);
  audit.observe('Broken images', inspection.brokenImages.length, '0');
  await audit.checkpoint('runtime-healthy-primary-page');
  await audit.assertRuntimeHealthy();
});
