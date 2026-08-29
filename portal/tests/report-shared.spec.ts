import { expect, test, type Page, type Route } from '@playwright/test';
import { sharedPublicationFixture } from './shared-publication-fixture.js';

async function routeSharedReport(page: Page, runId: string, { failBootstrap = false, riskCount = 2, coreBound = false } = {}) {
  const { view } = sharedPublicationFixture('single-site', runId, 'PARTIAL');
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/control/v1/session') {
      return route.fulfill({ status: failBootstrap ? 503 : 200, json: failBootstrap
        ? { error: { code: 'CONTROL_UNAVAILABLE', message: 'Authority bootstrap failed.' } }
        : { schemaVersion: 1, data: { csrfToken: 'csrf-report', principal: { id: 'report-reviewer' } } } });
    }
    const root = `/api/control/v1/runs/${runId}`;
    if (url.pathname === `${root}/workspace`) {
      const risks = [...view.riskRegister.risks];
      const baseRisk = view.riskRegister.risks[0];
      if (!baseRisk && riskCount > 0) throw new Error('The shared report risk fixture requires a base risk.');
      while (risks.length < riskCount) {
        const index = risks.length;
        risks.push({
          ...baseRisk!, identity: `risk_report_${String(index).padStart(3, '0')}`,
          severity: index === 200 ? 'critical' : 'low', reviewState: 'RESOLVED',
          source: { kind: 'manual-obligation', id: `resolved-${index}` },
          actor: { id: 'historical-reviewer', kind: 'reviewer' }, updatedAt: '2026-08-29T15:00:00.000Z',
        });
      }
      const requestedScope = view.decision.certifiedScope;
      const decision = coreBound ? {
        ...view.decision,
        subjectStage: 'core', ready: false, code: 'NOT_READY_INCOMPLETE_EXECUTION',
        label: 'NOT READY — INCOMPLETE EXECUTION', grantedAuthority: null, certifiedScope: null,
        requestedAuthority: { qualifier: 'FULL', scope: requestedScope },
      } : view.decision;
      return route.fulfill({ json: { schemaVersion: 1, data: {
        schemaVersion: 1, snapshotToken: `sha256:${'a'.repeat(64)}`, stateRevision: 17,
        publication: {
          runId, runRevision: view.revisions.run, decisionRevision: view.revisions.decision,
          riskRevision: view.revisions.risk, subjectCoreDigest: `sha256:${'c'.repeat(64)}`,
          finalSubjectDigest: coreBound ? null : view.subjectDigest,
          decision, riskRegister: { ...view.riskRegister, risks },
        },
        executions: { runId, executions: [{ id: 'work-1', state: coreBound ? 'incomplete' : 'completed_pass', completedAt: '2026-08-29T14:05:00.000Z' }], oracleExecutions: [] },
        logs: { runId, limit: 200, truncated: false, events: [], attemptLogs: [] },
      } } });
    }
    return route.fallback();
  });
}

test.describe('shared live report authority', () => {
  test('renders canonical scope and provenance while paging 201 active-first risks', async ({ page }) => {
    const runId = 'shared-report-risk-pagination';
    await routeSharedReport(page, runId, { riskCount: 201 });
    await page.goto(`/report.html?mode=single-site&run=${runId}`);

    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible();
    await expect(page.locator('#report-certified-scope')).toContainText('Comparison-only checkout parity');
    await expect(page.locator('.report-risk-showing')).toHaveText('Showing 1–200 of 201 risks');
    await expect(page.locator('#report-risk-register tbody tr').first()).toContainText('Manual checkout remains outstanding');
    await expect(page.locator('#report-risk-register')).toContainText('manual-obligation:physical-device-review');
    await expect(page.locator('#report-risk-register')).toContainText('service:runner');
    await expect(page.locator('#report-risk-register')).toContainText('2026-08-29T14:00:00.000Z');
    await expect(page.locator('[data-risk-identity="risk_report_199"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Next risks' }).click();
    await expect(page.locator('.report-risk-showing')).toHaveText('Showing 201–201 of 201 risks');
    await expect(page.locator('[data-risk-identity="risk_report_199"]')).toBeVisible();
  });

  test('marks failed authority bootstrap unavailable rather than leaving a loading claim', async ({ page }) => {
    const runId = 'shared-report-bootstrap-failure';
    await routeSharedReport(page, runId, { failBootstrap: true });
    await page.goto(`/report.html?mode=single-site&run=${runId}`);
    await expect(page.locator('#report-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
    await expect(page.locator('#report-product-risk')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#report-risk-status')).toContainText('Authority bootstrap failed');
    await expect(page.locator('#report-risk-status')).not.toContainText('LOADING');
  });

  test('renders core-bound failure as not granted with requested scope', async ({ page }) => {
    const runId = 'shared-report-core-bound';
    await routeSharedReport(page, runId, { coreBound: true });
    await page.goto(`/report.html?mode=single-site&run=${runId}`);
    await expect(page.locator('.report-decision-code')).toContainText('authority not granted');
    await expect(page.locator('#report-certified-scope').getByRole('heading')).toHaveText('Requested scope');
    await expect(page.locator('#report-certified-scope')).toContainText('preview-desktop');
    await expect(page.locator('#report-certified-scope')).not.toContainText('Certified scope');
  });

  test('labels a legacy READY snapshot as non-authoritative evidence, never promotion authority', async ({ page }) => {
    const runId = 'legacy-ready-report';
    await page.route('**/api/**', async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/control/v1/session') return route.fulfill({ status: 404, json: { error: { message: 'Shared control API is not enabled.' } } });
      if (url.pathname === `/api/runs/${runId}`) return route.fulfill({ json: {
        id: runId, status: 'passed', createdAt: '2026-08-29T14:00:00.000Z', updatedAt: '2026-08-29T14:05:00.000Z',
        options: { profile: 'release', auditIds: [], projects: ['desktop'], productionUrl: 'https://example.test', candidateUrl: 'https://beta.example.test' },
        pipeline: { status: 'completed' }, release: { decision: 'READY', reason: 'Legacy checks passed.', decisionBasis: 'Legacy checklist.' }, reviewReasons: [],
      } });
      if (url.pathname === `/api/runs/${runId}/report`) return route.fulfill({ json: {
        generatedAt: '2026-08-29T14:05:00.000Z', release: { decision: 'READY' }, summary: { total: 0, executed: 0, byStatus: {}, bySeverity: {} },
        topFindings: [], topFindingCount: 0, topAttention: [], topAttentionCount: 0, manual: {}, artifacts: { total: 0 },
      } });
      if (url.pathname.endsWith('/report/audits')) return route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 25, hasMore: false, filters: {} } });
      if (url.pathname.endsWith('/artifacts')) return route.fulfill({ json: { files: [], total: 0, offset: 0, limit: 80, hasMore: false } });
      return route.fallback();
    });
    await page.goto(`/report.html?run=${runId}`);
    await expect(page.locator('#decision-badge')).toHaveText('Legacy READY result');
    await expect(page.locator('#decision-title')).toHaveText('The legacy checklist reported READY');
    await expect(page.locator('#decision-basis')).toContainText('cannot authorize promotion');
    await expect(page.getByText('Ready for release', { exact: true })).toHaveCount(0);
  });
});
