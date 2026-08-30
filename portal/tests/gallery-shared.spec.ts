import { expect, test, type Page, type Route } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { sharedPublicationFixture, type RiskAvailability, type SharedMode } from './shared-publication-fixture.js';
// @ts-expect-error shared-control-client is the browser-native module exercised by this portal test.
import { createSharedWorkspacePoller } from '../public/shared-control-client.js';

async function routeSharedGallery(page: Page, mode: SharedMode, runId: string, options: {
  availability?: RiskAvailability;
  initiallyAuthorized?: boolean;
  revisionMismatch?: boolean;
  denyPublication?: boolean;
  sharedDisabled?: boolean;
  sessionRestoreDelayMs?: number;
  transientPublicationFailures?: number;
  rejectLogin?: boolean;
  riskCount?: number;
} = {}) {
  let authorized = options.initiallyAuthorized ?? false;
  let publicationFailures = options.transientPublicationFailures ?? 0;
  const { view } = sharedPublicationFixture(mode, runId, options.availability ?? 'PARTIAL');
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/control/v1/session') {
      if (options.sharedDisabled) return route.fulfill({ status: 404, json: { error: { code: 'SHARED_CONTROL_DISABLED', message: 'Shared control is disabled.' } } });
      if (request.method() === 'POST') {
        expect((await request.postDataJSON()).credential).toBe('scoped-gallery-credential');
        if (options.rejectLogin) return route.fulfill({ status: 401, json: {
          schemaVersion: 1, error: { code: 'AUTHENTICATION_REJECTED', message: 'Credential rejected.' },
        } });
        authorized = true;
      } else if (options.sessionRestoreDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.sessionRestoreDelayMs));
      }
      return route.fulfill({ status: authorized ? 200 : 401, json: authorized
        ? { schemaVersion: 1, data: { csrfToken: 'csrf-gallery', principal: { id: 'gallery-reviewer' } } }
        : { schemaVersion: 1, error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' } } });
    }
    const root = `/api/control/v1/runs/${runId}`;
    if (url.pathname === `${root}/workspace`) {
      if (publicationFailures > 0) {
        publicationFailures -= 1;
        return route.fulfill({ status: 503, json: { error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'The publication reader is restarting.' } } });
      }
      if (options.denyPublication) return route.fulfill({ status: 403, json: { error: { code: 'OBJECT_SCOPE_DENIED', message: 'This principal cannot view that run.' } } });
      if (options.revisionMismatch) return route.fulfill({ status: 409, json: { error: { code: 'SHARED_CONTROL_REVISION_RACE', message: 'The run changed while loading one coherent revision.' } } });
      const expandedRisks = [...view.riskRegister.risks];
      const baseRisk = view.riskRegister.risks[0];
      if (!baseRisk && (options.riskCount ?? 0) > 0) throw new Error('The shared gallery risk fixture requires a base risk.');
      while (expandedRisks.length < (options.riskCount ?? expandedRisks.length)) {
        const index = expandedRisks.length;
        expandedRisks.push({
          ...baseRisk!, identity: `risk_resolved_${String(index).padStart(3, '0')}`,
          severity: index === 200 ? 'critical' : 'low', reviewState: 'RESOLVED',
          source: { kind: 'manual-obligation', id: `resolved-${index}` },
          actor: { id: 'historical-reviewer', kind: 'reviewer' }, updatedAt: '2026-08-29T15:00:00.000Z',
        });
      }
      return route.fulfill({ json: { schemaVersion: 1, data: {
        schemaVersion: 1,
        snapshotToken: `sha256:${'a'.repeat(64)}`,
        stateRevision: view.revisions.run,
        publication: {
          runId,
          runRevision: view.revisions.run,
          decisionRevision: view.revisions.decision,
          riskRevision: view.revisions.risk,
          finalSubjectDigest: view.subjectDigest,
          decision: view.decision,
          riskRegister: { ...view.riskRegister, risks: expandedRisks },
        },
        executions: {
          runId,
          runRevision: view.revisions.run,
          executions: [
            { id: 'work-active', state: 'leased', feature: 'navigation' },
            { id: 'work-incomplete', state: 'incomplete', feature: 'search' },
            { id: 'work-complete', state: 'completed_pass', completedAt: '2026-08-29T14:05:00.000Z' },
          ],
          oracleExecutions: [{ id: 'oracle-navigation' }],
        },
        logs: {
          runId,
          runRevision: view.revisions.run,
          limit: 200,
          truncated: false,
          events: [{ kind: 'operation', state: 'recovering', executionId: 'work-incomplete' }],
          attemptLogs: [{ executionId: 'work-active', state: 'running', message: 'Bounded redacted log.' }],
        },
      } } });
    }
    const comparativeGallery = `/api/runs/${runId}/gallery`;
    const singleGallery = `/api/single-site/runs/${runId}/gallery`;
    if (url.pathname === comparativeGallery) return route.fulfill({ status: 404, json: { error: { code: 'GALLERY_NOT_FOUND', message: 'No legacy gallery exists.' } } });
    if (url.pathname === singleGallery) return route.fulfill({ status: 404, json: { error: { code: 'GALLERY_NOT_FOUND', message: 'No legacy gallery exists.' } } });
    return route.fallback();
  });
}

test.describe('shared live gallery authority', () => {
  test('starts comparative evidence loading without waiting for session restoration', async ({ page }) => {
    const runId = 'shared-gallery-independent-evidence';
    let galleryRequestedAt = 0;
    let restoreFinishedAt = 0;
    await routeSharedGallery(page, 'comparative', runId, { sessionRestoreDelayMs: 1_500 });
    await page.route(`**/api/runs/${runId}/gallery`, async (route) => {
      galleryRequestedAt = Date.now();
      await route.fulfill({ status: 404, json: { error: { code: 'GALLERY_NOT_FOUND', message: 'No legacy gallery exists.' } } });
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/control/v1/session') restoreFinishedAt = Date.now();
    });

    await page.goto(`/gallery.html?mode=comparative&run=${runId}`);
    await expect.poll(() => galleryRequestedAt).toBeGreaterThan(0);
    expect(restoreFinishedAt).toBe(0);
  });

  test('keeps the latest login attempt when a slower restore finishes afterward', async ({ page }) => {
    const runId = 'shared-gallery-auth-race';
    await routeSharedGallery(page, 'comparative', runId, { sessionRestoreDelayMs: 800 });
    await page.goto(`/gallery.html?mode=comparative&run=${runId}`);
    await page.locator('input[name="gallery-control-credential"]').fill('scoped-gallery-credential');
    await page.getByRole('button', { name: 'Authorize gallery access' }).click();
    await expect(page.locator('#gallery-shared-session-status')).toContainText('authorized');
    await page.waitForTimeout(1_000);
    await expect(page.locator('#gallery-shared-session-status')).toContainText('authorized');
  });

  test('rejected gallery login clears the secret and returns focus to the credential field', async ({ page }) => {
    const runId = 'shared-gallery-rejected-login';
    await routeSharedGallery(page, 'comparative', runId, { rejectLogin: true });
    await page.goto(`/gallery.html?mode=comparative&run=${runId}`);
    const credential = page.locator('input[name="gallery-control-credential"]');
    await credential.fill('scoped-gallery-credential');
    await page.getByRole('button', { name: 'Authorize gallery access' }).click();
    await expect(page.locator('#gallery-shared-session-status')).toContainText('Credential rejected');
    await expect(credential).toHaveValue('');
    await expect(credential).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.innerHTML.includes('scoped-gallery-credential'))).toBe(false);
    await expect(page.locator('#gallery-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
  });

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
      if (mode === 'single-site') await expect(page.locator('#gallery-certified-scope')).toContainText('Comparison-only checkout parity');
      await expect(page.locator('#gallery-risk-register')).toContainText('Manual checkout remains outstanding');
      await expect(page.locator('#gallery-risk-register')).toContainText('manual-obligation:physical-device-review');
      await expect(page.locator('#gallery-risk-register')).toContainText('service:runner');
      await expect(page.locator('#gallery-risk-register')).toContainText('2026-08-29T14:00:00.000Z');
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

  test('pages 201 risks, reports the visible range truthfully, and keeps active risks ahead of resolved critical history', async ({ page }) => {
    const runId = 'shared-gallery-risk-pagination';
    await routeSharedGallery(page, 'comparative', runId, { initiallyAuthorized: true, riskCount: 201 });
    await page.goto(`/gallery.html?mode=comparative&run=${runId}`);
    await expect(page.locator('.gallery-risk-showing')).toHaveText('Showing 1–200 of 201 risks');
    await expect(page.locator('#gallery-risk-register tbody tr').first()).toContainText('Manual checkout remains outstanding');
    await expect(page.locator('[data-risk-identity="risk_resolved_199"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Next risks' }).click();
    await expect(page.locator('.gallery-risk-showing')).toHaveText('Showing 201–201 of 201 risks');
    await expect(page.locator('[data-risk-identity="risk_resolved_199"]')).toBeVisible();
  });

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

  test('recovers automatically after a transient shared-publication failure', async ({ page }) => {
    const runId = 'shared-gallery-transient-retry';
    await routeSharedGallery(page, 'comparative', runId, {
      initiallyAuthorized: true,
      transientPublicationFailures: 1,
    });
    await page.goto(`/gallery.html?mode=comparative&run=${runId}`);
    await expect(page.locator('#gallery-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible({ timeout: 8_000 });
  });

  test('pauses shared polling while hidden and preserves the unchanged authority DOM, focus, and scroll', async ({ page }) => {
    const runId = 'shared-gallery-visibility';
    let workspaceReads = 0;
    await routeSharedGallery(page, 'comparative', runId, { initiallyAuthorized: true });
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith(`/api/control/v1/runs/${runId}/`)) workspaceReads += 1;
    });
    await page.goto(`/gallery.html?mode=comparative&run=${runId}`);
    const action = page.getByRole('link', { name: 'Open recovery and review controls' });
    await expect(action).toBeVisible();
    await action.focus();
    await page.locator('#gallery-risk-register').evaluate((node) => {
      node.setAttribute('data-stability-probe', 'preserve-me');
      node.scrollTop = 17;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const readsBeforeHiddenWait = workspaceReads;
    await page.waitForTimeout(5_500);
    expect(workspaceReads).toBe(readsBeforeHiddenWait);
    await expect(action).toBeFocused();

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => workspaceReads).toBeGreaterThan(readsBeforeHiddenWait);
    await expect(page.locator('#gallery-risk-register')).toHaveAttribute('data-stability-probe', 'preserve-me');
    await expect(action).toBeFocused();
  });

  test('purge invalidation aborts an authority read and cannot resurrect the gallery', async ({ page }) => {
    const runId = 'shared-gallery-purge-race';
    await routeSharedGallery(page, 'single-site', runId, {
      initiallyAuthorized: true,
      sessionRestoreDelayMs: 500,
    });
    await page.goto(`/gallery.html?mode=single-site&run=${runId}`);
    await page.evaluate(({ runId: id }) => window.dispatchEvent(new CustomEvent('audit-console:run-invalidated', {
      detail: { schemaVersion: 1, mode: 'single-site', runId: id, reason: 'purged', occurredAt: new Date().toISOString() },
    })), { runId });
    await expect(page.locator('#gallery-fatal-title')).toContainText('purged');
    await page.waitForTimeout(800);
    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toHaveCount(0);
    await expect(page.locator('#gallery-fatal-title')).toContainText('purged');
  });

  test('pagehide aborts pending authorization and authority work', async ({ page }) => {
    const runId = 'shared-gallery-pagehide-race';
    await routeSharedGallery(page, 'comparative', runId, {
      initiallyAuthorized: true,
      sessionRestoreDelayMs: 500,
    });
    await page.goto(`/gallery.html?mode=comparative&run=${runId}`);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.waitForTimeout(800);
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

test('shared workspace poller keeps terminal snapshots fresh with a slower cadence and marks async failure unavailable', async () => {
  const timers: Array<{ delay: number; callback: () => void }> = [];
  const unavailable: string[] = [];
  const poller = createSharedWorkspacePoller({
    load: async () => { throw new Error('archive publication could not be rendered'); },
    onSnapshot() { throw new Error('unexpected snapshot'); },
    onUnavailable(error: Error) { unavailable.push(error.message); },
    isTerminal: () => true,
    setTimer(callback: () => void, delay: number) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
    activeRefreshMs: 5_000,
    terminalRefreshMs: 30_000,
  });
  await poller.refresh();
  expect(unavailable).toEqual(['archive publication could not be rendered']);

  poller.destroy();
  const terminalTimers: Array<{ delay: number; callback: () => void }> = [];
  const terminalPoller = createSharedWorkspacePoller({
    load: async () => ({ publication: { runRevision: 7, decisionRevision: 3, riskRevision: 2, finalSubjectDigest: 'subject' } }),
    onSnapshot() {},
    onUnavailable() {},
    isTerminal: () => true,
    setTimer(callback: () => void, delay: number) {
      terminalTimers.push({ callback, delay });
      return terminalTimers.length;
    },
    clearTimer() {},
    activeRefreshMs: 5_000,
    terminalRefreshMs: 30_000,
  });
  await terminalPoller.refresh();
  expect(terminalTimers.at(-1)?.delay).toBe(30_000);
  terminalPoller.destroy();
});
