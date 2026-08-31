import { expect, test, type Page, type Route } from '@playwright/test';
import { sharedPublicationFixture } from './shared-publication-fixture.js';

async function routeSharedReport(page: Page, runId: string, {
  failBootstrap = false,
  riskCount = 2,
  coreBound = false,
  failures = [] as ReturnType<typeof sharedFailureFixture>[],
  failFailureDetail = false,
  failureDelayMs = 0,
  workspaceRevisions = [17],
  staleFailureOffsets = [] as number[],
} = {}) {
  const { view } = sharedPublicationFixture('single-site', runId, 'PARTIAL');
  let workspaceReads = 0;
  const staleOffsets = new Set(staleFailureOffsets);
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
      const stateRevision = workspaceRevisions[Math.min(workspaceReads, workspaceRevisions.length - 1)];
      workspaceReads += 1;
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
        schemaVersion: 1, snapshotToken: `sha256:${String(stateRevision).padStart(64, '0')}`, stateRevision,
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
    if (url.pathname === `/api/single-site/runs/${runId}/report/failures`) {
      if (failureDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, failureDelayMs));
      if (failFailureDetail) return route.fulfill({ status: 503, json: { error: 'Canonical failure projection is temporarily unavailable.' } });
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const expectedStateRevision = Number(url.searchParams.get('expectedStateRevision'));
      if (staleOffsets.delete(offset)) return route.fulfill({ status: 409, json: {
        code: 'SINGLE_SITE_REPORT_REVISION_STALE',
        error: `Canonical failure detail moved from run revision ${expectedStateRevision}.`,
      } });
      const items = failures.slice(offset, offset + limit);
      return route.fulfill({ json: {
        schemaVersion: 1,
        mode: 'single-site',
        runId,
        stateRevision: expectedStateRevision,
        total: failures.length,
        offset,
        limit,
        nextOffset: offset + items.length,
        previousOffset: Math.max(0, offset - limit),
        hasMore: offset + items.length < failures.length,
        hasPrevious: offset > 0,
        items,
        source: { authority: 'canonical-shared-parent-run', bounded: true, rawLogsIncluded: false },
      } });
    }
    return route.fallback();
  });
}

function sharedFailureFixture(index = 1, runId = 'shared-report-failures') {
  const suffix = String(index).padStart(2, '0');
  return {
    workItemId: `work-performance-${suffix}`,
    auditId: 'PERF-001',
    auditTitle: 'Browser resource budget',
    severity: 'P1',
    caseId: `PERF-001:case:%2Fstart-here%2Fwelcome-${suffix}`,
    targetId: 'candidate-mobile-chromium',
    targetRole: 'preview',
    state: 'completed_product_failure',
    releaseEffect: 'blocking',
    url: `https://beta.example.test/start-here/welcome-${suffix}`,
    assertionMessage: `Error: Request count budget ${index}\nExpected: <= 90\nReceived: ${100 + index}`,
    assertionTruncated: false,
    assertionIdentities: [`assertion-performance-${suffix}`],
    findingIdentities: [],
    findings: [{ severity: 'P1', title: 'Request budget exceeded', detail: `${100 + index} first-party requests exceeded the 90-request budget.`, blocking: true }],
    findingCount: 1,
    findingsShown: 1,
    findingsOmitted: 0,
    findingsTruncated: false,
    failedSteps: [],
    evidencePolicy: { mode: 'structured-data', rationale: 'Retain bounded browser timing and Lighthouse evidence.' },
    evidence: [{
      name: 'browser-performance-evidence',
      mediaType: 'application/json',
      purpose: 'structured',
      bytes: 2048,
      url: `/artifacts/${encodeURIComponent(runId)}/work-items/work-performance-${suffix}/${encodeURIComponent(`sha256:${'a'.repeat(64)}`)}`,
    }],
    galleryUrl: `/gallery.html?mode=single-site&run=${encodeURIComponent(runId)}&from=report&review=all&q=${encodeURIComponent(`PERF-001:case:%2Fstart-here%2Fwelcome-${suffix}`)}`,
    detailAvailability: 'complete',
    detailLimitations: [],
  };
}

test.describe('shared live report authority', () => {
  test('loads bounded canonical product-failure detail without delaying the release decision', async ({ page }) => {
    const runId = 'shared-report-failures';
    await routeSharedReport(page, runId, {
      failures: [sharedFailureFixture(1, runId)],
      failureDelayMs: 350,
    });
    await page.goto(`/report.html?mode=single-site&run=${runId}`);

    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible();
    await expect(page.locator('#report-risk-register')).toBeVisible();
    await expect(page.locator('#report-product-failures')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.report-failure-loading')).toContainText('bounded page');

    const failure = page.locator('.report-failure-card');
    await expect(failure).toHaveCount(1);
    await expect(failure.getByRole('heading', { level: 4 })).toContainText('PERF-001 · Browser resource budget');
    await expect(failure).toContainText('PERF-001:case:%2Fstart-here%2Fwelcome-01');
    await expect(failure).toContainText('candidate-mobile-chromium');
    await expect(failure).toContainText('BLOCKING PRODUCT FAILURE');
    await expect(failure.locator('.report-failure-assertion')).toContainText('Request count budget 1');
    await expect(failure.locator('.report-failure-assertion')).toContainText('Received: 101');
    await expect(failure).toContainText('https://beta.example.test/start-here/welcome-01');
    await expect(failure).toContainText('Request budget exceeded');
    await expect(failure.getByRole('link', { name: 'Open matching gallery evidence' })).toHaveAttribute('href', /gallery\.html\?.*q=PERF-001/);
    await expect(failure.getByRole('link', { name: /browser-performance-evidence/ })).toHaveAttribute('href', /\/artifacts\/shared-report-failures\/work-items\/work-performance-01\/sha256%3A/);
    await expect(page.locator('#report-product-failures')).toHaveAttribute('aria-busy', 'false');
  });

  test('pages large failure sets asynchronously and keeps each response bounded', async ({ page }) => {
    const runId = 'shared-report-failure-pages';
    const failures = Array.from({ length: 21 }, (_, index) => sharedFailureFixture(index + 1, runId));
    await routeSharedReport(page, runId, { failures });
    await page.goto(`/report.html?mode=single-site&run=${runId}`);

    await expect(page.locator('.report-failure-card')).toHaveCount(20);
    await expect(page.locator('.report-failure-status')).toContainText('1–20 of 21');
    await page.getByRole('button', { name: 'Next failures' }).click();
    await expect(page.locator('.report-failure-status')).toContainText('21–21 of 21');
    await expect(page.locator('.report-failure-card')).toHaveCount(1);
    await expect(page.locator('.report-failure-card')).toContainText('welcome-21');
    await page.getByRole('button', { name: 'Previous failures' }).click();
    await expect(page.locator('.report-failure-card')).toHaveCount(20);
    await expect(page.locator('.report-failure-status')).toContainText('1–20 of 21');
  });

  test('reloads the whole report when the first failure page is stale', async ({ page }) => {
    const runId = 'shared-report-stale-first-page';
    await routeSharedReport(page, runId, {
      failures: [sharedFailureFixture(1, runId)],
      workspaceRevisions: [17, 18],
      staleFailureOffsets: [0],
    });
    await page.goto(`/report.html?mode=single-site&run=${runId}`);

    await expect(page.locator('.report-failure-status')).toContainText('run revision 18');
    await expect(page.locator('.report-failure-card')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible();
    await expect(page.locator('#report-risk-register')).toBeVisible();
  });

  test('reloads decision, risks, and page one together when revision changes between failure pages', async ({ page }) => {
    const runId = 'shared-report-stale-between-pages';
    const failures = Array.from({ length: 21 }, (_, index) => sharedFailureFixture(index + 1, runId));
    await routeSharedReport(page, runId, {
      failures,
      workspaceRevisions: [17, 18],
      staleFailureOffsets: [20],
    });
    await page.goto(`/report.html?mode=single-site&run=${runId}`);
    await expect(page.locator('.report-failure-status')).toContainText('1–20 of 21');

    await page.getByRole('button', { name: 'Next failures' }).click();
    await expect(page.locator('.report-failure-status')).toContainText('1–20 of 21 failures · run revision 18');
    await expect(page.locator('.report-failure-card')).toHaveCount(20);
    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible();
    await expect(page.locator('#report-risk-register')).toBeVisible();
  });

  test('labels bounded findings as showing N of total with the omitted count', async ({ page }) => {
    const runId = 'shared-report-truncated-findings';
    const failure = sharedFailureFixture(1, runId);
    failure.findings = Array.from({ length: 12 }, (_, index) => ({
      severity: 'P1', title: `Finding ${index + 1}`, detail: `Bounded finding detail ${index + 1}.`, blocking: true,
    }));
    failure.findingCount = 15;
    failure.findingsShown = 12;
    failure.findingsOmitted = 3;
    failure.findingsTruncated = true;
    await routeSharedReport(page, runId, { failures: [failure] });
    await page.goto(`/report.html?mode=single-site&run=${runId}`);

    const card = page.locator('.report-failure-card');
    await expect(card.getByRole('heading', { level: 5, name: 'Recorded findings · showing 12 of 15 (3 omitted)' })).toBeVisible();
    await expect(card.locator('.report-failure-findings li')).toHaveCount(12);
  });

  test('keeps decision and Risk Register usable when failed-assertion detail is unavailable', async ({ page }) => {
    const runId = 'shared-report-failure-unavailable';
    await routeSharedReport(page, runId, { failFailureDetail: true });
    await page.goto(`/report.html?mode=single-site&run=${runId}`);

    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible();
    await expect(page.locator('#report-risk-register')).toContainText('Manual checkout remains outstanding');
    await expect(page.locator('.report-failure-status')).toContainText('Failure detail unavailable');
    await expect(page.locator('.report-failure-unavailable')).toContainText('release decision and Risk Register remain available');
    await expect(page.locator('#report-product-risk')).toHaveAttribute('data-risk-availability', 'PARTIAL');
  });

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
