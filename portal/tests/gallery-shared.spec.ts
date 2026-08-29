import { expect, test, type Page, type Route } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { sharedPublicationFixture, type RiskAvailability, type SharedMode } from './shared-publication-fixture.js';

async function routeSharedGallery(page: Page, mode: SharedMode, runId: string, options: {
  availability?: RiskAvailability;
  initiallyAuthorized?: boolean;
  revisionMismatch?: boolean;
  denyPublication?: boolean;
  sharedDisabled?: boolean;
} = {}) {
  let authorized = options.initiallyAuthorized ?? false;
  const { view } = sharedPublicationFixture(mode, runId, options.availability ?? 'PARTIAL');
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/control/v1/session') {
      if (options.sharedDisabled) return route.fulfill({ status: 404, json: { error: { code: 'SHARED_CONTROL_DISABLED', message: 'Shared control is disabled.' } } });
      if (request.method() === 'POST') {
        expect((await request.postDataJSON()).credential).toBe('scoped-gallery-credential');
        authorized = true;
      }
      return route.fulfill({ status: authorized ? 200 : 401, json: authorized
        ? { schemaVersion: 1, data: { csrfToken: 'csrf-gallery', principal: { id: 'gallery-reviewer' } } }
        : { schemaVersion: 1, error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' } } });
    }
    const root = `/api/control/v1/runs/${runId}`;
    if (url.pathname === `${root}/publication`) {
      if (options.denyPublication) return route.fulfill({ status: 403, json: { error: { code: 'OBJECT_SCOPE_DENIED', message: 'This principal cannot view that run.' } } });
      return route.fulfill({ json: { schemaVersion: 1, data: {
        runId,
        runRevision: view.revisions.run,
        decisionRevision: view.revisions.decision,
        riskRevision: view.revisions.risk,
        finalSubjectDigest: view.subjectDigest,
        decision: view.decision,
        riskRegister: view.riskRegister,
      } } });
    }
    if (url.pathname === `${root}/executions`) return route.fulfill({ json: { schemaVersion: 1, data: {
      runId, runRevision: options.revisionMismatch ? view.revisions.run - 1 : view.revisions.run,
      executions: [
        { id: 'work-active', state: 'leased', feature: 'navigation' },
        { id: 'work-incomplete', state: 'incomplete', feature: 'search' },
        { id: 'work-complete', state: 'completed_pass', completedAt: '2026-08-29T14:05:00.000Z' },
      ],
      oracleExecutions: [{ id: 'oracle-navigation' }],
    } } });
    if (url.pathname === `${root}/logs`) return route.fulfill({ json: { schemaVersion: 1, data: {
      runId, runRevision: view.revisions.run, limit: 200, truncated: false,
      events: [{ kind: 'operation', state: 'recovering', executionId: 'work-incomplete' }],
      attemptLogs: [{ executionId: 'work-active', state: 'running', message: 'Bounded redacted log.' }],
    } } });
    const comparativeGallery = `/api/runs/${runId}/gallery`;
    const singleGallery = `/api/single-site/runs/${runId}/gallery`;
    if (url.pathname === comparativeGallery) return route.fulfill({ status: 404, json: { error: { code: 'GALLERY_NOT_FOUND', message: 'No legacy gallery exists.' } } });
    if (url.pathname === singleGallery) return route.fulfill({ status: 404, json: { error: { code: 'GALLERY_NOT_FOUND', message: 'No legacy gallery exists.' } } });
    return route.fallback();
  });
}

test.describe('shared live gallery authority', () => {
  for (const mode of ['comparative', 'single-site'] as const) {
    test(`${mode} shows Product Risk and the exact shared publication even without a legacy gallery`, async ({ page }) => {
      const runId = `shared-gallery-${mode}`;
      await routeSharedGallery(page, mode, runId);
      await page.goto(`/gallery.html?mode=${mode}&run=${runId}`);

      await expect(page.locator('#gallery-shared-session')).toBeVisible();
      await expect(page.locator('input[name="gallery-control-credential"]')).toHaveAttribute('type', 'password');
      await page.locator('input[name="gallery-control-credential"]').fill('scoped-gallery-credential');
      await page.getByRole('button', { name: 'Authorize gallery access' }).click();

      await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible();
      await expect(page.locator('#gallery-product-risk')).toHaveAttribute('data-risk-availability', 'PARTIAL');
      await expect(page.locator('#gallery-authority-revisions')).toContainText('Run revision 7');
      await expect(page.locator('#gallery-certified-scope')).toContainText('navigation');
      await expect(page.locator('#gallery-risk-register')).toContainText('Manual checkout remains outstanding');
      await expect(page.locator('#gallery-risk-register')).toContainText('Certificate validation bypass');
      await expect(page.locator('#gallery-recovery-state')).toContainText('work-incomplete');
      await expect(page.getByRole('link', { name: 'Open recovery and review controls' })).toHaveAttribute('href', `/run.html?mode=${mode}&run=${runId}&view=overview`);
      await expect(page.getByRole('heading', { name: 'Product Risk' })).toBeFocused();
      await expect(page.locator('input[name="gallery-control-credential"]')).toHaveValue('');
      expect(await page.evaluate(() => document.documentElement.innerHTML.includes('scoped-gallery-credential'))).toBe(false);
      await expect(page.locator('#gallery-fatal')).toBeHidden();
      await expect(page.locator('#gallery-connection')).toHaveText('Evidence unavailable');
      await expect(page.locator('#gallery-lifecycle')).toContainText('No legacy gallery exists');

      const accessibility = await new AxeBuilder({ page }).include('#gallery-product-risk').analyze();
      expect(accessibility.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')).toEqual([]);
    });
  }

  for (const availability of ['LOADING', 'PROVISIONAL', 'AVAILABLE', 'PARTIAL', 'EMPTY', 'UNAVAILABLE'] as const) {
    test(`distinguishes ${availability} from an available empty Risk Register`, async ({ page }) => {
      const runId = `gallery-risk-${availability.toLowerCase()}`;
      await routeSharedGallery(page, 'comparative', runId, { initiallyAuthorized: true, availability });
      await page.goto(`/gallery.html?mode=comparative&run=${runId}`);
      await expect(page.locator('#gallery-product-risk')).toHaveAttribute('data-risk-availability', availability);
      await expect(page.locator('#gallery-risk-status')).toContainText(availability === 'EMPTY' ? /complete.*no active product risks/i : new RegExp(availability, 'i'));
      if (availability !== 'EMPTY') await expect(page.locator('#gallery-risk-status')).not.toContainText(/no (active )?product risks/i);
    });
  }

  test('fails closed on a revision race and object authorization denial', async ({ page }) => {
    const runId = 'shared-gallery-revision-race';
    await routeSharedGallery(page, 'comparative', runId, { initiallyAuthorized: true, revisionMismatch: true });
    await page.goto(`/gallery.html?mode=comparative&run=${runId}`);
    await expect(page.locator('#gallery-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
    await expect(page.locator('#gallery-risk-status')).toContainText(/coherent revision|changed while loading/i);
    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toHaveCount(0);

    const deniedId = 'shared-gallery-object-denied';
    await routeSharedGallery(page, 'comparative', deniedId, { initiallyAuthorized: true, denyPublication: true });
    await page.goto(`/gallery.html?mode=comparative&run=${deniedId}`);
    await expect(page.locator('#gallery-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
    await expect(page.locator('#gallery-risk-status')).toContainText(/cannot view that run/i);
    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toHaveCount(0);
  });

  test('keeps historical gallery evidence readable when shared control is disabled', async ({ page }) => {
    const runId = 'legacy-gallery-shared-disabled';
    await routeSharedGallery(page, 'comparative', runId, { sharedDisabled: true });
    await page.goto(`/gallery.html?mode=comparative&run=${runId}`);
    await expect(page.locator('#gallery-product-risk')).toBeHidden();
    await expect(page.locator('#gallery-shared-session')).toBeHidden();
    await expect(page.locator('#gallery-fatal')).toBeVisible();
    await expect(page.locator('#gallery-fatal-title')).toContainText('could not be loaded');
  });
});
