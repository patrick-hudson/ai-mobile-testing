import { projectMetadata } from '../audit/environments.js';
import { expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';

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

staticTest('[CRISIS-002] withdrawal fast path exposes urgent human-help destinations', staticEvidence('Capture the withdrawal fast path with its visible human-help actions and exact destinations.', 'all-projects'), async ({ page, audit }, testInfo) => {
  const metadata = projectMetadata(testInfo.project.metadata);
  await audit.goto('/start-here/7-oh-withdrawal-help');
  await expect(page.locator('h1')).toContainText(/withdrawal|okay|help/i);
  await expect(page.locator('main')).toContainText(/help|support|withdrawal/i);

  const actions = await page.locator('main a[href]').evaluateAll((anchors) => anchors.map((node) => ({
    href: (node as HTMLAnchorElement).href,
    label: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
  })));
  const supportActions = actions.filter(({ href, label }) => /discord|meeting|988|full guide|withdrawal guide/i.test(`${href} ${label}`));
  expect(supportActions.length, 'The fast path must lead to concrete human or clinical support').toBeGreaterThanOrEqual(2);

  if (metadata.environment === 'candidate') {
    expect(actions.some(({ href }) => href === 'tel:988'), 'The redesigned fast path must provide a direct 988 action').toBe(true);
    expect(actions.some(({ href }) => /discord\.gg/.test(href)), 'Peer support must remain immediately reachable').toBe(true);
  }

  audit.observe('Urgent support actions', supportActions.length, 'At least 2');
  await audit.attachJson('urgent-support-actions', supportActions);
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
