import { expect, interactionEvidence, interactionTest, staticEvidence, staticTest } from '../fixtures/test.js';
import { parseAuditProjectMetadata } from '../audit/environments.js';
import { REPRESENTATIVE_RUNTIME_ROUTES, REVIEWED_HOME_PRIMARY_ACTIONS } from '../audit/routes.js';
import { CRISIS_ACTIONS, CRISIS_MEETING_FALLBACK } from './crisis-contract.js';
import { loggedGet } from './helpers.js';

interactionTest('[HOME-001] homepage exposes clear starting paths instead of a decorative shell', interactionEvidence('Activate a primary homepage starting path and show its intended guide destination loading successfully.', 'all-projects'), async ({ page, audit }, testInfo) => {
  await audit.goto('/');
  const project = parseAuditProjectMetadata(testInfo.project.metadata);
  const siteContract = project.mode === 'comparative'
    ? project.environment
    : project.deploymentRole === 'preview' ? 'candidate' : 'production';
  const contract = REVIEWED_HOME_PRIMARY_ACTIONS[siteContract];
  await expect(page.locator('main h1')).toHaveText(siteContract === 'candidate'
    ? 'Help quitting 7-OH'
    : 'A calm reference for getting off 7-OH and kratom synthetics.');

  const renderedActions = [];
  for (const action of contract) {
    const link = page.getByRole('link', { name: action.label, exact: true });
    await expect(link, `${siteContract} must expose the reviewed primary action ${action.label}`).toBeVisible();
    await expect(link).toHaveAttribute('href', action.path);
    renderedActions.push({
      path: await link.getAttribute('href'),
      label: (await link.innerText()).replace(/\s+/g, ' ').trim(),
    });
  }
  await audit.attachJson('homepage-primary-action-contract', {
    mode: project.mode,
    ...(project.mode === 'comparative'
      ? { environment: project.environment }
      : { deploymentRole: project.deploymentRole }),
    contract: siteContract,
    reviewedActions: contract,
    renderedActions,
  });

  for (const action of contract) {
    await audit.step(`Activate ${action.label}`, `The reviewed ${siteContract} action loads ${action.path} with its exact destination identity.`, async () => {
      const link = page.getByRole('link', { name: action.label, exact: true });
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${action.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`));
      await expect(page.locator('main h1:visible')).toHaveText(action.expectedH1);
      // Let destination islands finish importing before replacing the
      // document; otherwise mobile Chromium can leave aborted module requests
      // in the runtime ledger and obscure the actual navigation assertion.
      await page.waitForTimeout(1_000);
      await page.goBack({ waitUntil: 'load' });
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('link', { name: action.label, exact: true })).toBeVisible();
      await page.waitForTimeout(500);
    });
  }
  audit.observe('Reviewed primary actions', renderedActions.length, String(contract.length));
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

staticTest('[REL-001] representative reader journeys have no browser or first-party loading failures', staticEvidence('Capture the final reviewed route after every representative shell, guide, calculator, and meeting route produces clean browser and network evidence.', 'all-projects'), async ({ page, audit }) => {
  const runtimeLedger = [];

  for (const candidatePath of REPRESENTATIVE_RUNTIME_ROUTES) {
    const mappedPath = audit.environmentPath(candidatePath);
    expect(mappedPath, `${candidatePath} must retain an environment mapping for the runtime matrix`).not.toBeNull();
    await audit.goto(candidatePath);
    await expect(page.locator('main'), `${candidatePath} must retain rendered primary content`).toBeVisible();
    await expect(page.locator('main h1:visible'), `${candidatePath} must retain one visible page identity`).toHaveCount(1);
    const inspection = await audit.inspectPage();
    expect(inspection.brokenImages, `${candidatePath} must not contain a failed image request`).toEqual([]);
    await audit.assertRuntimeHealthy();
    runtimeLedger.push({ candidatePath, mappedPath, inspection });
  }

  expect(runtimeLedger.map(({ candidatePath }) => candidatePath), 'Every reviewed runtime surface must execute').toEqual([...REPRESENTATIVE_RUNTIME_ROUTES]);
  audit.observe('Reviewed runtime routes', runtimeLedger.length, String(REPRESENTATIVE_RUNTIME_ROUTES.length));
  await audit.attachJson('representative-runtime-health-ledger', runtimeLedger);
  await audit.checkpoint('runtime-healthy-representative-matrix');
});
