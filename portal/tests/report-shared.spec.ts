import { expect, test, type Page, type Route } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

type Mode = 'comparative' | 'single-site';
type Availability = 'LOADING' | 'PROVISIONAL' | 'AVAILABLE' | 'PARTIAL' | 'EMPTY' | 'UNAVAILABLE';

function publication(mode: Mode, runId: string, availability: Availability = 'PARTIAL', runRevision = 7) {
  return {
    runId,
    runRevision,
    decisionRevision: 3,
    riskRevision: 2,
    finalSubjectDigest: `sha256:${'b'.repeat(64)}`,
    previousEnvelopeDigest: `sha256:${'a'.repeat(64)}`,
    decision: {
      mode,
      label: 'FEATURE READY',
      code: 'FEATURE_READY',
      ready: true,
      grantedAuthority: 'TARGETED',
      certifiedScope: {
        features: ['navigation', 'search'],
        definitions: ['NAV-001', 'SEARCH-001'],
        targets: [mode === 'single-site' ? 'preview-desktop' : 'candidate-desktop'],
        limitations: ['Comparison-only checkout parity is not applicable in Single-site mode.'],
      },
      coverageBasis: ['Selected required executions completed.'],
      superseded: false,
    },
    riskRegister: {
      availability,
      risks: ['LOADING', 'EMPTY', 'UNAVAILABLE'].includes(availability) ? [] : [
        {
          identity: 'risk-manual-1', category: 'manual-check', severity: 'high', mode,
          reviewState: 'OPEN', releaseEffect: 'non-blocking', affectedScope: ['checkout'],
          explanation: 'Manual checkout remains outstanding.',
          recommendedAction: 'Review checkout on a physical device.', source: { kind: 'manual', id: 'manual-1' },
        },
        {
          identity: 'risk-certificate-1', category: 'certificate-bypass', severity: 'medium', mode,
          reviewState: 'OPEN', releaseEffect: 'non-blocking', affectedScope: ['preview-desktop'],
          explanation: 'Certificate validation bypass is enabled for this development target.',
          recommendedAction: 'Restore certificate validation before production use.', source: { kind: 'configuration', id: 'tls-policy' },
        },
        {
          identity: 'risk-visual-1', category: 'unreviewed-visual-change', severity: 'medium', mode,
          reviewState: 'PENDING_REVIEW', releaseEffect: 'non-blocking', affectedScope: ['navigation'],
          explanation: 'A deterministic comparison changed.',
          recommendedAction: 'Review the bounded visual evidence.', source: { kind: 'visual-review', id: 'oracle-visual-1' },
        },
      ],
    },
  };
}

async function routeSharedReport(page: Page, mode: Mode, runId: string, options: {
  availability?: Availability;
  initiallyAuthorized?: boolean;
  revisionMismatch?: boolean;
  denyPublication?: boolean;
} = {}) {
  let authorized = options.initiallyAuthorized ?? false;
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/control/v1/session' && request.method() === 'GET') {
      return route.fulfill({ status: authorized ? 200 : 401, json: authorized
        ? { schemaVersion: 1, data: { csrfToken: 'csrf-report', principal: { id: 'report-reviewer' } } }
        : { schemaVersion: 1, error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' } } });
    }
    if (url.pathname === '/api/control/v1/session' && request.method() === 'POST') {
      expect((await request.postDataJSON()).credential).toBe('scoped-report-credential');
      authorized = true;
      return route.fulfill({ json: { schemaVersion: 1, data: { csrfToken: 'csrf-report', principal: { id: 'report-reviewer' } } } });
    }
    const root = `/api/control/v1/runs/${runId}`;
    if (url.pathname === `${root}/publication`) {
      if (options.denyPublication) return route.fulfill({ status: 403, json: { error: { code: 'OBJECT_SCOPE_DENIED', message: 'This principal cannot view that run.' } } });
      return route.fulfill({ json: { schemaVersion: 1, data: publication(mode, runId, options.availability) } });
    }
    if (url.pathname === `${root}/executions`) return route.fulfill({ json: { schemaVersion: 1, data: {
      runId, runRevision: options.revisionMismatch ? 6 : 7,
      executions: [
        { id: 'work-active', state: 'leased', feature: 'navigation' },
        { id: 'work-incomplete', state: 'incomplete', feature: 'search' },
        { id: 'work-complete', state: 'completed_pass', feature: 'navigation', completedAt: '2026-08-29T14:00:00.000Z' },
      ],
      oracleExecutions: [{ id: 'oracle-visual-1' }],
    } } });
    if (url.pathname === `${root}/logs`) return route.fulfill({ json: { schemaVersion: 1, data: {
      runId, runRevision: 7, limit: 200, truncated: false,
      events: [{ kind: 'operation', state: 'recovering', executionId: 'work-incomplete' }],
      attemptLogs: [{ executionId: 'work-active', state: 'running', message: 'Bounded redacted log.' }],
    } } });
    if (url.pathname.startsWith('/api/runs/') || url.pathname.startsWith('/api/single-site/runs/')) {
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'No legacy report exists.' } } });
    }
    return route.fallback();
  });
}

test.describe('shared live report authority', () => {
  for (const mode of ['comparative', 'single-site'] as const) {
    test(`${mode} authenticates and renders the revision-bound Product Risk report when legacy routes are absent`, async ({ page }) => {
      const runId = `shared-report-${mode}`;
      await routeSharedReport(page, mode, runId);
      await page.goto(`/report.html?mode=${mode}&run=${runId}`);

      await expect(page.locator('#report-shared-session')).toBeVisible();
      await expect(page.locator('input[name="report-control-credential"]')).toHaveAttribute('type', 'password');
      await page.locator('input[name="report-control-credential"]').fill('scoped-report-credential');
      await page.getByRole('button', { name: 'Authorize report access' }).click();

      await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible();
      await expect(page.locator('#report-product-risk')).toHaveAttribute('data-risk-availability', 'PARTIAL');
      await expect(page.locator('#report-product-risk')).toContainText('non-blocking');
      await expect(page.locator('#report-certified-scope')).toContainText('navigation');
      await expect(page.locator('#report-authority-revisions')).toContainText('Decision revision 3');
      await expect(page.locator('#report-authority-revisions')).toContainText('Run revision 7');
      await expect(page.getByRole('columnheader', { name: 'Recommended action' })).toBeVisible();
      await expect(page.locator('#report-risk-register')).toContainText('Certificate validation bypass');
      await expect(page.locator('#report-risk-register tbody tr')).toHaveText([
        /Manual check.*Manual checkout remains outstanding/is,
        /Unreviewed visual change.*A deterministic comparison changed/is,
        /Certificate bypass.*Certificate validation bypass is enabled/is,
      ]);
      await expect(page.locator('#report-recovery-state')).toContainText('work-incomplete');
      await expect(page.locator('#report-execution-state')).toContainText('work-active');
      await expect(page.locator('#report-pipeline-integrity')).toContainText('Available');
      await expect(page.locator('#report-site-health')).toContainText('separate');
      await expect(page.getByRole('link', { name: 'Open recovery controls' })).toHaveAttribute('href', `/run.html?mode=${mode}&run=${runId}&view=overview`);
      await expect(page.getByRole('heading', { name: 'Product Risk' })).toBeFocused();
      await expect(page.locator('input[name="report-control-credential"]')).toHaveValue('');
      expect(await page.evaluate(() => document.documentElement.innerHTML.includes('scoped-report-credential'))).toBe(false);
      expect(await page.locator('#report-product-risk').evaluate((node) => Boolean(node.compareDocumentPosition(document.querySelector('#report-pipeline-integrity')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

      if (mode === 'single-site') {
        await expect(page.locator('#report-certified-scope')).toContainText(/comparison-only.*not applicable/i);
        await expect(page.locator('#report-certified-scope')).not.toContainText(/failure|coverage gap/i);
      }
      const accessibility = await new AxeBuilder({ page }).include('#report-content').analyze();
      expect(accessibility.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')).toEqual([]);
    });
  }

  for (const availability of ['LOADING', 'PROVISIONAL', 'AVAILABLE', 'PARTIAL', 'EMPTY', 'UNAVAILABLE'] as const) {
    test(`announces ${availability} risk availability without conflating unavailable data with empty`, async ({ page }) => {
      const runId = `risk-${availability.toLowerCase()}`;
      await routeSharedReport(page, 'comparative', runId, { initiallyAuthorized: true, availability });
      await page.goto(`/report.html?mode=comparative&run=${runId}`);
      await expect(page.locator('#report-product-risk')).toHaveAttribute('data-risk-availability', availability);
      await expect(page.locator('#report-risk-status')).toContainText(availability === 'EMPTY' ? /complete.*no active product risks/i : new RegExp(availability, 'i'));
      if (availability !== 'EMPTY') await expect(page.locator('#report-risk-status')).not.toContainText(/no (active )?product risks/i);
    });
  }

  test('fails closed on a revision race and never renders stale authority', async ({ page }) => {
    const runId = 'shared-report-revision-race';
    await routeSharedReport(page, 'comparative', runId, { initiallyAuthorized: true, revisionMismatch: true });
    await page.goto(`/report.html?mode=comparative&run=${runId}`);
    await expect(page.locator('#report-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
    await expect(page.locator('#report-risk-status')).toContainText(/coherent revision|changed while loading/i);
    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toHaveCount(0);
  });

  test('object authorization failure does not fall back to legacy release authority or expose credentials', async ({ page }) => {
    const runId = 'shared-report-denied';
    await routeSharedReport(page, 'comparative', runId, { initiallyAuthorized: true, denyPublication: true });
    await page.goto(`/report.html?mode=comparative&run=${runId}`);
    await expect(page.locator('#report-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
    await expect(page.locator('#report-risk-status')).toContainText(/cannot view that run/i);
    await expect(page.locator('body')).not.toContainText('scoped-report-credential');
    await expect(page.getByText(/ready for release/i)).toHaveCount(0);
  });

  test('shared session infrastructure failure cannot fall back to a stale legacy ready report', async ({ page }) => {
    const runId = 'shared-report-session-outage';
    let legacyReads = 0;
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/control/v1/session') {
        return route.fulfill({ status: 503, json: { error: 'Shared control store is temporarily unavailable.' } });
      }
      if (url.pathname === `/api/runs/${runId}` || url.pathname === `/api/runs/${runId}/report`) {
        legacyReads += 1;
        return route.fulfill({ json: { release: { decision: 'RELEASE_READY' } } });
      }
      return route.fallback();
    });
    await page.goto(`/report.html?mode=comparative&run=${runId}`);
    await expect(page.locator('#report-content')).toHaveAttribute('data-authority', 'shared');
    await expect(page.locator('#report-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
    await expect(page.locator('#report-risk-status')).toContainText(/temporarily unavailable/i);
    await expect(page.getByText(/RELEASE READY|ready for release/i)).toHaveCount(0);
    expect(legacyReads).toBe(0);
  });

  test('active shared report refreshes only when a coherent newer revision publishes', async ({ page }) => {
    const runId = 'shared-report-live-refresh';
    let revision = 7;
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/control/v1/session') {
        return route.fulfill({ json: { schemaVersion: 1, data: { csrfToken: 'csrf-live', principal: { id: 'viewer-live' } } } });
      }
      const root = `/api/control/v1/runs/${runId}`;
      if (url.pathname === `${root}/publication`) {
        return route.fulfill({ json: { schemaVersion: 1, data: publication('comparative', runId, 'AVAILABLE', revision) } });
      }
      if (url.pathname === `${root}/executions`) {
        return route.fulfill({ json: { schemaVersion: 1, data: {
          runId, runRevision: revision,
          executions: [{ id: 'work-live', state: revision === 7 ? 'leased' : 'completed_pass', completedAt: revision === 8 ? '2026-08-29T15:00:00.000Z' : undefined }],
          oracleExecutions: [],
        } } });
      }
      if (url.pathname === `${root}/logs`) {
        return route.fulfill({ json: { schemaVersion: 1, data: { runId, runRevision: revision, limit: 200, truncated: false, events: [], attemptLogs: [] } } });
      }
      return route.fallback();
    });
    await page.goto(`/report.html?mode=comparative&run=${runId}`);
    await expect(page.locator('#report-authority-revisions')).toContainText('Run revision 7');
    revision = 8;
    await expect(page.locator('#report-authority-revisions')).toContainText('Run revision 8', { timeout: 8_000 });
    await expect(page.locator('#report-execution-state')).toContainText('0 active');
  });

  test('keeps a historical compact report readable when shared control is disabled at the narrow regression viewport', async ({ page }) => {
    const runId = 'legacy-report-shared-disabled';
    await page.setViewportSize({ width: 480, height: 900 });
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/control/v1/session') return route.fulfill({ status: 404, json: { error: { code: 'SHARED_CONTROL_DISABLED', message: 'Shared control is disabled.' } } });
      if (url.pathname === `/api/runs/${runId}`) return route.fulfill({ json: {
        id: runId, status: 'not-ready', startedAt: '2026-08-29T14:00:00.000Z', finishedAt: '2026-08-29T14:01:00.000Z',
        options: { profile: 'release', auditIds: [], productionUrl: 'https://production.example.test', candidateUrl: 'https://candidate.example.test' },
        pipeline: { status: 'completed', reason: 'Historical pipeline.' },
        release: { decision: 'NOT_READY', reason: 'Historical test failure.', decisionBasis: 'Legacy compact evidence only.' },
      } });
      if (url.pathname === `/api/runs/${runId}/report`) return route.fulfill({ json: {
        publicationRevision: '1'.repeat(32), generatedAt: '2026-08-29T14:01:00.000Z',
        run: { profile: 'release', startedAt: '2026-08-29T14:00:00.000Z', finishedAt: '2026-08-29T14:01:00.000Z', durationMs: 60_000 },
        release: { decision: 'NOT_READY', reason: 'Historical test failure.', decisionBasis: 'Legacy compact evidence only.' },
        summary: { total: 1, executed: 1, byStatus: { FAIL: 1 }, bySeverity: { P1: 1 } },
        manualEvidence: { outstanding: 0, failedOrBlocked: 0 }, topFindings: [], filters: {},
      } });
      if (url.pathname.endsWith('/report/audits')) return route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 25, hasMore: false, filters: {} } });
      if (url.pathname.endsWith('/artifacts')) return route.fulfill({ json: { files: [], total: 0, offset: 0, limit: 80, hasMore: false } });
      return route.fallback();
    });
    await page.goto(`/report.html?mode=comparative&run=${runId}`);
    await expect(page.locator('#decision-title')).toContainText(/not ready/i);
    await expect(page.locator('#report-product-risk')).toBeHidden();
    await expect(page.locator('#report-shared-session')).toBeHidden();
    await expect(page.locator('#report-content')).toHaveAttribute('data-authority', 'legacy');
    await expect(page.locator('body')).not.toContainText(/FEATURE READY|RELEASE READY/);
  });
});
