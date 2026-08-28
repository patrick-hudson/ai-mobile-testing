import { expect, test, type Page, type Route } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

const desktopWidths = [1280, 1440, 1920] as const;
const liveViewports = [
  { width: 1280, height: 900 },
  { width: 1440, height: 900 },
  { width: 1920, height: 900 },
  { width: 480, height: 900 },
] as const;

type ConsoleRouteId = 'overview' | 'runs';
type ConsoleRecordType = 'run' | 'risk' | 'trust';

function consoleRecord(
  recordType: ConsoleRecordType,
  recordId: string,
  fields: Record<string, unknown>,
  { mode = 'comparative', runId = recordType === 'run' ? recordId : 'visual-run-terminal' } = {},
) {
  return {
    schemaVersion: 1,
    mode,
    runId,
    recordId: recordType === 'run' ? 'run' : recordId,
    recordType,
    scopeKey: 'release',
    sourceId: `${mode}-visual-fixture`,
    sourceRevision: 'visual-revision-1',
    sourceUpdatedAt: '2026-08-26T12:00:00.000Z',
    complete: true,
    sortKey: `2026-08-26T12:00:00.000Z:${recordId}`,
    fields: {
      title: recordId,
      updatedAt: '2026-08-26T12:00:00.000Z',
      sourceTimestamp: '2026-08-26T12:00:00.000Z',
      destinations: [`/run.html?mode=${mode}&run=${runId}&view=overview`],
      ...fields,
    },
  };
}

function consoleResponse(routeId: ConsoleRouteId, items: ReturnType<typeof consoleRecord>[]) {
  return {
    schemaVersion: 1,
    apiVersion: 'v1',
    routeId,
    query: {
      mode: 'all', scopeKey: 'all', sort: routeId === 'runs' ? 'recent' : 'attention',
      filters: {}, limit: 50, normalizedFilterKey: '{}',
    },
    sourceVector: {
      schemaVersion: 1,
      vectorRevision: 'visual-vector-1',
      indexRevision: 'visual-index-1',
      complete: true,
      sources: [{
        sourceId: 'visual-fixture', revision: 'visual-revision-1',
        updatedAt: '2026-08-26T12:00:00.000Z', complete: true,
      }],
    },
    complete: true,
    freshness: 'current',
    limitations: [],
    work: {
      recordsRead: items.length, sourceFilesRead: 0, sourceBytesRead: 0,
      elapsedMs: 1, budgetExhausted: false, indexReads: 1, assemblyAttempts: 1,
    },
    capabilities: { schemaVersion: 1, items: [] },
    data: { items, nextCursor: null, hasMore: false, omittedRecords: 0, cursorBinding: {} },
  };
}

async function fulfillConsoleIndex(route: Route, items: ReturnType<typeof consoleRecord>[]) {
  const pathname = new URL(route.request().url()).pathname;
  const routeId: ConsoleRouteId = pathname.endsWith('/runs') ? 'runs' : 'overview';
  await route.fulfill({ json: consoleResponse(routeId, items) });
}

function action(actionId: string, available: boolean) {
  return { actionId, supported: true, authorized: true, eligible: available, available, unavailableReason: null };
}

function runSummary(runId: string) {
  return {
    schemaVersion: 1,
    apiVersion: 'v1',
    routeId: 'run-summary',
    complete: true,
    freshness: 'current',
    limitations: [],
    capabilities: {
      schemaVersion: 1,
      items: [{
        schemaVersion: 1,
        identity: { mode: 'comparative', runId },
        contextId: 'comparative-live',
        authorityRevision: 'visual-authority-1',
        actions: [action('stop', false), action('purge', true), action('manualEvidence', true)],
      }],
    },
    data: {
      record: consoleRecord('run', runId, {
        executionState: 'not-ready',
        activityState: 'idle',
        phase: 'review-complete',
        terminal: true,
        progressTotal: 183,
        progressCompleted: 181,
        outcome: 'not-ready',
        coverageStatus: 'complete',
        evidenceAuthorityStatus: 'authoritative',
        pipelineIntegrityStatus: 'complete',
        finalizationStatus: null,
        scopeLabel: 'Production → candidate · Release',
        destinations: [
          `/run.html?mode=comparative&run=${runId}&view=overview`,
          `/report.html?run=${runId}`,
          `/gallery.html?mode=comparative&run=${runId}&from=runs`,
        ],
      }),
    },
  };
}

function runDetail(runId: string) {
  return {
    id: runId,
    mode: 'comparative',
    sourceRevision: 'visual-revision-1',
    status: 'not-ready',
    phase: 'Review complete',
    createdAt: '2026-08-26T11:57:00.000Z',
    startedAt: '2026-08-26T12:00:00.000Z',
    finishedAt: '2026-08-26T12:02:00.000Z',
    externalManaged: false,
    stopRequestedAt: null,
    options: {
      profile: 'release',
      projects: ['candidate-desktop-chromium'],
      auditIds: [],
      productionUrl: 'https://quitting7oh.org',
      candidateUrl: 'https://beta.quitting7oh-org.pages.dev',
    },
    progress: { total: 183, completed: 181 },
    pipeline: { status: 'completed', reason: 'All deterministic evidence inputs were finalized.' },
    release: { decision: 'NOT_READY', reason: 'Two release-blocking findings need review.' },
    command: ['docker', 'compose', 'run', '--rm', 'audit-release'],
    stages: {},
    purge: { eligible: true, confirmation: `PURGE ${runId}` },
  };
}

const visualConfig = {
  catalog: [
    { id: 'NAV-001', title: 'Primary navigation focus and page position', area: 'navigation', severity: 'P0', releaseBlocking: true },
    { id: 'ENV-007', title: 'Custom not-found recovery page', area: 'environment', severity: 'P1', releaseBlocking: true },
    { id: 'A11Y-004', title: 'Accessible names for interactive controls', area: 'accessibility', severity: 'P0', releaseBlocking: true },
    { id: 'RESP-003', title: 'Narrow viewport layout fallback', area: 'responsive', severity: 'P1', releaseBlocking: true },
    { id: 'PERF-002', title: 'Bounded initial route readiness', area: 'performance', severity: 'P1', releaseBlocking: false },
    { id: 'MEDIA-006', title: 'Reviewable screenshot and video evidence', area: 'evidence', severity: 'P2', releaseBlocking: false },
  ],
  plugins: [{
    id: 'core-release',
    name: 'Core release checks',
    description: 'Navigation, accessibility, responsive, and release-critical coverage.',
    auditDefinitions: ['NAV-001', 'ENV-007', 'A11Y-004', 'RESP-003'],
  }, {
    id: 'evidence-quality',
    name: 'Evidence quality',
    description: 'Performance and retained evidence checks.',
    auditDefinitions: ['PERF-002', 'MEDIA-006'],
  }],
  projects: [],
  targets: {
    localTargets: [
      { id: 'candidate-desktop-chromium', label: 'Desktop Chromium', available: true, defaultSelected: true, fidelity: 'browser', qualification: 'release-qualified' },
      { id: 'candidate-mobile-webkit', label: 'Mobile WebKit', available: true, defaultSelected: true, fidelity: 'device-emulation', qualification: 'release-qualified' },
      { id: 'candidate-tablet-webkit', label: 'Tablet WebKit', available: true, defaultSelected: false, fidelity: 'device-emulation', qualification: 'review coverage' },
    ],
    singleSiteTargets: [
      { id: 'single-site-desktop-chromium', label: 'Desktop Chromium', available: true, defaultSelected: true, fidelity: 'browser', qualification: 'site-health qualified' },
    ],
    providerTargets: [
      { id: 'provider-ios-safari', label: 'Real iPhone Safari', available: false, defaultSelected: false, fidelity: 'real-device', qualification: 'planning only', unavailableReason: 'Provider adapter is not configured.' },
    ],
    defaultTargetIds: ['candidate-desktop-chromium', 'candidate-mobile-webkit'],
    singleSiteFullProfileTargetIds: ['single-site-desktop-chromium'],
  },
  defaults: {
    productionUrl: 'https://quitting7oh.org',
    candidateUrl: 'https://beta.quitting7oh-org.pages.dev',
    singleSiteUrl: 'https://beta.quitting7oh-org.pages.dev',
    profile: 'smoke',
    candidateIgnoreHTTPSErrors: false,
    singleSiteDeploymentRole: 'preview',
    singleSiteCertificatePolicy: 'strict',
  },
  modes: ['comparative', 'single-site'],
  singleSite: {
    previewTlsBypassConfigured: false,
    queue: { available: true, filesystemType: '0xef53' },
  },
  limits: { maxConcurrentRuns: 1 },
  operator: { authorized: true },
  aiReview: { available: true, dryRun: true, defaultModel: 'claude-sonnet-5' },
};

async function assertAccessibleVisual(
  page: Page,
  rootSelector: string,
  snapshotName: string,
  viewport: { readonly width: number; readonly height: number },
) {
  await expect(page.locator(rootSelector)).toBeVisible();
  await expect(page.locator(`${rootSelector} .console-navigation a`)).toHaveText([
    'Overview', 'Runs', 'Findings', 'Evidence', 'New audit', 'Settings',
  ]);
  await expect(page.locator(`${rootSelector} .console-navigation a[aria-current="page"]`)).toHaveCount(1);
  await page.evaluate(() => document.fonts.ready);
  const layout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(layout.document, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.body, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport + 1);
  const accessibility = await new AxeBuilder({ page }).include(rootSelector).analyze();
  const blocking = accessibility.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  await expect(page).toHaveScreenshot(`${snapshotName}-${viewport.width}.png`, {
    animations: 'disabled',
    fullPage: true,
    maxDiffPixelRatio: 0.002,
  });
}

test.describe('portal visual baselines', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-08-26T12:05:00.000Z'));
  });

  test('live report preserves the dense console hierarchy at desktop widths', async ({ page }) => {
    const runId = 'visual-report-fixture';
    const run = {
      id: runId,
      status: 'not-ready',
      startedAt: '2026-08-26T12:00:00.000Z',
      finishedAt: '2026-08-26T12:02:00.000Z',
      options: {
        profile: 'release',
        auditIds: [],
        productionUrl: 'https://quitting7oh.org',
        candidateUrl: 'https://beta.quitting7oh-org.pages.dev',
      },
      pipeline: { status: 'completed', completed: true, reason: 'All reporter inputs were finalized.' },
      release: { decision: 'NOT_READY', reason: 'Two release-blocking findings need review.', decisionBasis: 'Deterministic audit and evidence truth.' },
      reviewReasons: [],
    };
    const report = {
      schemaVersion: 1,
      publicationRevision: '44444444444444444444444444444444',
      generatedAt: run.finishedAt,
      run: { profile: 'release', startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: 120_000 },
      release: { ready: false, decision: 'NOT_READY', blockingFailures: 2, blockingIncomplete: 0, baselineIssues: 1, reason: run.release.reason, decisionBasis: run.release.decisionBasis },
      summary: {
        total: 183, executed: 181, structuredExecutions: 181, artifacts: 426, videos: 18,
        usableInteractionVideos: 18, diagnosticVideos: 4, posters: 18, baselineIssues: 1,
        byStatus: { PASS: 178, FAIL: 2, REVIEW: 1, NOT_RUN: 2 },
        bySeverity: { P0: 28, P1: 62, P2: 71, P3: 22 },
      },
      manualEvidence: { required: 3, complete: 2, outstanding: 1, failedOrBlocked: 0, byStatus: { PASS: 2, MANUAL_REQUIRED: 1 } },
      topFindings: [{
        auditId: 'NAV-001', auditTitle: 'Primary navigation focus and page position', area: 'navigation', auditStatus: 'FAIL',
        severity: 'P0', releaseBlocking: true, title: 'Keyboard focus is lost after route navigation',
        detail: 'The candidate route changes but focus remains on a detached navigation control.', blocking: true,
        sourceProject: 'candidate-desktop-chromium', environment: 'candidate', scope: 'candidate', baselineNonGating: false,
      }, {
        auditId: 'ENV-007', auditTitle: 'Custom not-found recovery page', area: 'environment', auditStatus: 'FAIL',
        severity: 'P1', releaseBlocking: true, title: 'Not-found recovery omits the primary navigation landmark',
        detail: 'The custom 404 page is visible, but the recovery route is not equivalent to the reviewed shell.', blocking: true,
        sourceProject: 'candidate-mobile-webkit', environment: 'candidate', scope: 'candidate', baselineNonGating: false,
      }],
      topFindingCount: 2,
      topAttention: [],
      topAttentionCount: 0,
      filters: { statuses: ['PASS', 'FAIL', 'REVIEW', 'NOT_RUN'], severities: ['P0', 'P1', 'P2', 'P3'], areas: ['navigation', 'environment'], environments: ['candidate', 'production'] },
      aiReview: null,
    };
    await page.route(`**/api/runs/${runId}`, (route) => route.fulfill({ json: run }));
    await page.route(`**/api/runs/${runId}/report`, (route) => route.fulfill({ json: report }));
    await page.route(`**/api/runs/${runId}/report/audits?*`, (route) => route.fulfill({
      json: {
        items: [{
          id: 'NAV-001', title: 'Primary navigation focus and page position', userPromise: 'Route changes preserve keyboard focus and scroll position.',
          status: 'FAIL', severity: 'P0', releaseBlocking: true, manual: false,
          environmentStatus: { candidate: 'FAIL', production: 'PASS' },
          reason: 'Candidate focus is detached after navigation.', evidenceCounts: { video: 1, screenshot: 1 },
        }],
        total: 183, offset: 0, limit: 25, nextOffset: 25, hasMore: true, filters: report.filters,
      },
    }));
    await page.route(`**/api/runs/${runId}/artifacts?*`, (route) => route.fulfill({
      json: { files: [], total: 426, knownTotal: 426, totalComplete: true, offset: 0, limit: 80, nextOffset: 0, hasMore: false },
    }));

    for (const viewport of liveViewports) {
      const { width } = viewport;
      await page.setViewportSize(viewport);
      await page.goto(`/report.html?mode=comparative&run=${runId}`);
      await expect(page.locator('#decision-title')).toContainText('not ready');
      await expect(page.locator('#report-main')).not.toHaveJSProperty('scrollWidth', 0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await assertAccessibleVisual(page, '#report-console', 'report-comparative', viewport);
    }
  });

  test('live gallery preserves bounded review context across desktop and narrow widths', async ({ page }) => {
    const runId = 'visual-single-site-gallery';
    const itemId = 'gitem_1111111111111111';
    const revision = '55555555555555555555555555555555';
    const galleryRoot = `/api/single-site/runs/${runId}/gallery`;
    const row = {
      itemId,
      title: 'Candidate navigation after the redesign',
      suite: 'Navigation',
      auditId: 'NAV-001',
      caseId: 'NAV-001.visual',
      targetId: 'single-site-desktop-chromium',
      severity: 'P0',
      kind: 'image',
      findingCount: 1,
      coverageGap: false,
      comparison: { status: 'CHANGED', reason: 'The navigation hierarchy differs from the approved rendering.' },
      identity: { route: '/', targetId: 'single-site-desktop-chromium', capturePoint: 'navigation-ready', theme: 'light' },
      eligible: false,
      ineligibilityReasons: ['A blocking deterministic finding must be resolved before baseline replacement.'],
      baseline: null,
    };
    const visualFixture = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
        <rect width="960" height="540" fill="#eef2f4"/>
        <rect width="210" height="540" fill="#202a31"/>
        <text x="28" y="48" font-family="system-ui" font-size="18" font-weight="700" fill="#eef2f4">AUDIT TARGET</text>
        <text x="250" y="72" font-family="system-ui" font-size="34" font-weight="700" fill="#182027">Candidate navigation</text>
        <rect x="250" y="112" width="650" height="1" fill="#929ca6"/>
        <rect x="250" y="148" width="440" height="42" fill="#ffffff" stroke="#929ca6"/>
        <text x="270" y="176" font-family="system-ui" font-size="18" fill="#182027">Navigation landmark under review</text>
        <text x="250" y="238" font-family="system-ui" font-size="18" fill="#59636e">Static screenshot evidence · candidate · desktop Chromium</text>
      </svg>
    `);

    await page.route('**/api/single-site/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === galleryRoot) return route.fulfill({ json: {
        schemaVersion: 1,
        mode: 'single-site',
        phase: 'sealed',
        publicationRevision: revision,
        lifecycle: { status: 'completed', terminal: true },
        baselineStoreRevision: 3,
        mutationCapability: { authorized: false },
        summary: { total: 1, images: 1, videos: 0 },
        maximumItems: 10_000,
      } });
      if (request.method() === 'GET' && url.pathname === `${galleryRoot}/items`) return route.fulfill({ json: {
        schemaVersion: 1,
        mode: 'single-site',
        publicationRevision: revision,
        baselineStoreRevision: 3,
        items: [row],
        total: 1,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: 1,
      } });
      if (request.method() === 'GET' && url.pathname === `${galleryRoot}/items/${itemId}`) return route.fulfill({ json: { item: {
        ...row,
        urls: { current: `${galleryRoot}/items/${itemId}/media/current`, baseline: null, diff: null, poster: null },
        testContext: {
          testId: 'tests/navigation.spec.ts::primary navigation',
          observed: 'The redesigned primary navigation rendered without the expected landmark association.',
        },
      } } });
      if (request.method() === 'GET' && url.pathname === `${galleryRoot}/items/${itemId}/media/current`) {
        return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: visualFixture });
      }
      if (request.method() === 'GET' && url.pathname === '/api/single-site/visual-baselines') {
        return route.fulfill({ json: { schemaVersion: 1, mode: 'single-site', storeRevision: 3, items: [], total: 0 } });
      }
      return route.fulfill({ status: 404, json: { error: 'Unhandled gallery visual fixture request.' } });
    });

    for (const viewport of liveViewports) {
      await page.setViewportSize(viewport);
      await page.goto(`/gallery.html?mode=single-site&run=${runId}`);
      await expect(page.locator('.single-site-gallery[data-gallery-controller="shared-core"]')).toHaveCount(1);
      await expect(page.getByRole('heading', { name: 'Candidate navigation after the redesign' })).toBeVisible();
      await expect(page.locator('.single-site-review-context')).toContainText('tests/navigation.spec.ts::primary navigation');
      await expect(page.locator('.single-site-media')).toBeVisible();
      await expect.poll(async () => page.locator('.single-site-media').evaluate(
        (image) => (image as HTMLImageElement).naturalWidth,
      )).toBeGreaterThan(0);
      await expect(page.locator('.single-site-review-context video')).toHaveCount(0);
      await assertAccessibleVisual(page, '#gallery-console', 'gallery-live', viewport);
    }
  });

  test('Overview preserves attention-first hierarchy across desktop and narrow widths', async ({ page }) => {
    const items = [
      consoleRecord('risk', 'visual-risk-navigation', {
        title: 'Keyboard focus is lost after route navigation', severity: 'P0', blocking: true,
        attentionKind: 'finding', novelty: 'new', affectedScope: 3, unresolvedAt: '2026-08-25T12:00:00.000Z',
      }),
      consoleRecord('risk', 'visual-risk-baseline', {
        title: 'Candidate header differs from the approved baseline', severity: 'P1', blocking: false,
        attentionKind: 'visual-review', novelty: 'changed', affectedScope: 2, unresolvedAt: '2026-08-25T14:00:00.000Z',
      }),
      consoleRecord('risk', 'visual-risk-manual', {
        title: 'Real-device recovery flow still needs signed evidence', severity: 'P1', blocking: false,
        attentionKind: 'manual-obligation', novelty: 'unknown', affectedScope: 1, unresolvedAt: '2026-08-25T16:00:00.000Z',
      }),
      ...[
        ['coverage', 'Coverage', 'complete'],
        ['evidence', 'Evidence authority', 'authoritative'],
        ['pipeline', 'Pipeline integrity', 'complete'],
        ['finalization', 'Finalization', 'complete'],
        ['manual', 'Manual acceptance', 'limited'],
        ['freshness', 'Freshness', 'current'],
      ].map(([id, title, status]) => consoleRecord('trust', `visual-trust-${id}`, { title, status })),
      consoleRecord('run', 'visual-run-active', {
        title: 'Candidate release audit', executionState: 'running', activityState: 'collecting-evidence',
        phase: 'browser-checks', terminal: false, startedAt: '2026-08-26T11:50:00.000Z',
        progressCompleted: 92, progressTotal: 183, findingCount: 2, scopeLabel: 'Production → candidate · Release',
      }),
      consoleRecord('run', 'visual-run-terminal', {
        title: 'Latest completed release audit', executionState: 'completed', activityState: 'idle',
        phase: 'review-complete', terminal: true, outcome: 'not-ready', finishedAt: '2026-08-26T12:00:00.000Z',
        coverageStatus: 'complete', evidenceAuthorityStatus: 'authoritative', pipelineIntegrityStatus: 'complete',
        finalizationStatus: 'complete', scopeLabel: 'Production → candidate · Release',
      }),
    ];
    await page.route('**/api/console/v1/**', (route) => fulfillConsoleIndex(route, items));

    for (const viewport of liveViewports) {
      await page.setViewportSize(viewport);
      await page.goto('/?mode=comparative');
      await expect(page.getByRole('heading', { name: 'Product Risk' })).toBeVisible();
      await expect(page.locator('#overview-active-runs')).toContainText('Candidate release audit');
      if (viewport.width >= 1280) {
        const tableLayout = await page.locator('.overview-active-scroll').evaluate((scroll) => {
          const cells = scroll.querySelectorAll('tbody tr:first-child td');
          const bounds = scroll.getBoundingClientRect();
          return {
            clientWidth: scroll.clientWidth,
            scrollWidth: scroll.scrollWidth,
            scopeRight: cells[7]?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
            actionsRight: cells[9]?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
            viewportRight: bounds.right,
          };
        });
        expect(tableLayout.scrollWidth, JSON.stringify(tableLayout)).toBeLessThanOrEqual(tableLayout.clientWidth + 1);
        expect(tableLayout.scopeRight, JSON.stringify(tableLayout)).toBeLessThanOrEqual(tableLayout.viewportRight + 1);
        expect(tableLayout.actionsRight, JSON.stringify(tableLayout)).toBeLessThanOrEqual(tableLayout.viewportRight + 1);
      }
      await assertAccessibleVisual(page, '#overview-console', 'overview', viewport);
      if (viewport.width === 480) {
        await page.getByRole('link', { name: 'Overview', exact: true }).focus();
        for (let index = 0; index < 5; index += 1) await page.keyboard.press('Tab');
        await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeFocused();
      }
    }
  });

  test('Runs preserves the dense table and selected-run inspector across desktop and narrow widths', async ({ page }) => {
    const items = [
      consoleRecord('run', 'visual-run-active', {
        title: 'Candidate release audit', executionState: 'running', activityState: 'collecting-evidence', phase: 'browser-checks',
        terminal: false, startedAt: '2026-08-26T11:50:00.000Z', progressCompleted: 92, progressTotal: 183,
        findingCount: 2, scopeLabel: 'Production → candidate · Release', pipelineIntegrityStatus: 'running',
      }),
      consoleRecord('run', 'visual-run-review', {
        title: 'Candidate release review', executionState: 'completed', activityState: 'idle', phase: 'review-complete',
        terminal: true, finishedAt: '2026-08-26T11:20:00.000Z', outcome: 'not-ready', progressCompleted: 181,
        progressTotal: 183, findingCount: 2, scopeLabel: 'Production → candidate · Release',
        coverageStatus: 'complete', evidenceAuthorityStatus: 'authoritative', pipelineIntegrityStatus: 'complete', finalizationStatus: 'complete',
      }),
      consoleRecord('run', 'visual-single-site', {
        title: 'Preview site-health audit', executionState: 'completed', activityState: 'idle', phase: 'finalization-complete',
        terminal: true, finishedAt: '2026-08-26T10:40:00.000Z', outcome: 'findings', progressCompleted: 48,
        progressTotal: 48, findingCount: 1, scopeLabel: 'Preview site · Full', coverageStatus: 'complete',
        evidenceAuthorityStatus: 'authoritative', pipelineIntegrityStatus: 'complete', finalizationStatus: 'complete',
      }, { mode: 'single-site' }),
    ];
    await page.route('**/api/console/v1/**', (route) => fulfillConsoleIndex(route, items));

    for (const viewport of liveViewports) {
      await page.setViewportSize(viewport);
      await page.goto('/runs.html?mode=all&run=visual-run-active&inspector=open');
      await expect(page.getByRole('heading', { name: 'Candidate release audit' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open run workspace' })).toBeVisible();
      await assertAccessibleVisual(page, '#runs-console', 'runs', viewport);
    }
  });

  test('stable run workspace preserves run identity and review navigation across desktop and narrow widths', async ({ page }) => {
    const runId = 'visual-run-workspace';
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === `/api/console/v1/runs/comparative/${runId}`) return route.fulfill({ json: runSummary(runId) });
      if (url.pathname === `/api/runs/${runId}`) return route.fulfill({ json: runDetail(runId) });
      if (url.pathname === `/api/runs/${runId}/logs`) return route.fulfill({ json: {
        log: '2026-08-26T12:02:00.000Z [playwright:stdout] deterministic visual fixture complete',
        sequence: 8, bytes: 88, maxBytes: 262_144, truncated: false, sources: [],
      } });
      return route.fallback();
    });

    for (const viewport of liveViewports) {
      await page.setViewportSize(viewport);
      await page.goto(`/run.html?mode=comparative&run=${runId}&view=overview`);
      await expect(page.locator('#run-view-region')).toHaveAttribute('data-async-state', 'ready');
      await expect(page.locator('#run-id')).toHaveText(runId);
      await assertAccessibleVisual(page, '#run-workspace', 'run-workspace', viewport);
    }
  });

  test('New Audit preserves progressive launch hierarchy across desktop and narrow widths', async ({ page }) => {
    await page.route('**/api/config', (route) => route.fulfill({ json: visualConfig }));

    for (const viewport of liveViewports) {
      await page.setViewportSize(viewport);
      await page.goto('/new-audit.html?mode=comparative');
      await expect(page.locator('#launch-form')).toHaveAttribute('aria-busy', 'false');
      await expect(page.getByRole('heading', { name: 'Configure an audit' })).toBeVisible();
      await assertAccessibleVisual(page, '#new-audit-console', 'new-audit', viewport);
    }
  });

  test('Settings preserves credential authority and guarded controls across desktop and narrow widths', async ({ page }) => {
    await page.route('**/api/settings/anthropic-key', (route) => route.fulfill({ json: {
      configured: true,
      fingerprint: 'sha256:visualfixture',
      storageEnabled: true,
      unavailableReason: null,
    } }));

    for (const viewport of liveViewports) {
      await page.setViewportSize(viewport);
      await page.goto('/settings.html?section=credentials');
      await expect(page.locator('#anthropic-key-settings')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('#anthropic-key-state')).toContainText('sha256:visualfixture');
      await assertAccessibleVisual(page, '#settings-console', 'settings', viewport);
    }
  });
});
