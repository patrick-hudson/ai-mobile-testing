import { expect, test, type Page, type Route } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { get, type ClientRequest, type IncomingMessage } from 'node:http';
import { join } from 'node:path';

type Mode = 'comparative' | 'single-site';

type HeldEventStream = {
  request: ClientRequest;
  response: IncomingMessage;
};

function holdEventStream(url: string): Promise<HeldEventStream> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Capacity fixture stream returned HTTP ${response.statusCode ?? 'unknown'}.`));
        return;
      }
      settled = true;
      resolve({ request, response });
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Capacity fixture stream timed out.')));
    request.once('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function action(actionId: string, available: boolean, unavailableReason: string | null = null) {
  return { actionId, supported: true, authorized: true, eligible: available, available, unavailableReason };
}

type SummaryOptions = {
  revision?: string;
  authorityRevision?: string;
  executionState?: string;
  activityState?: string;
  terminal?: boolean;
  finalizationStatus?: string | null;
  actions?: ReturnType<typeof action>[];
};

function summary(mode: Mode, runId: string, {
  revision = mode === 'single-site' ? 'state-1' : 'source-1',
  authorityRevision = 'authority-1',
  executionState = 'running',
  activityState = 'collecting-evidence',
  terminal = false,
  finalizationStatus = mode === 'single-site' ? (terminal ? 'complete' : 'pending') : null,
  actions = mode === 'comparative' ? [action('stop', !terminal), action('purge', terminal), action('manualEvidence', terminal)] : [action('cancel', !terminal), action('purge', terminal)],
}: SummaryOptions = {}) {
  return {
    schemaVersion: 1,
    apiVersion: 'v1',
    routeId: 'run-summary',
    complete: true,
    freshness: 'current',
    limitations: [],
    capabilities: {
      schemaVersion: 1,
      items: [{ schemaVersion: 1, identity: { mode, runId }, contextId: `${mode}-live`, authorityRevision, actions }],
    },
    data: {
      record: {
        schemaVersion: 1,
        mode,
        runId,
        recordId: 'run',
        recordType: 'run',
        scopeKey: 'all',
        sourceId: `${mode}-runs`,
        sourceRevision: revision,
        sourceUpdatedAt: '2026-08-26T12:00:00.000Z',
        complete: true,
        sortKey: 'recent:1',
        fields: {
          executionState,
          activityState,
          phase: terminal ? 'review-complete' : 'browser-checks',
          terminal,
          progressTotal: 10,
          progressCompleted: terminal ? 10 : 4,
          outcome: terminal ? (mode === 'comparative' ? 'not-ready' : 'findings') : null,
          coverageStatus: 'complete',
          evidenceAuthorityStatus: 'authoritative',
          pipelineIntegrityStatus: terminal ? 'complete' : 'running',
          finalizationStatus,
          scopeLabel: mode === 'comparative' ? 'Production → candidate' : 'Preview site',
          destinations: mode === 'comparative'
            ? [`/run.html?mode=comparative&run=${runId}`, `/report.html?run=${runId}`]
            : [`/run.html?mode=single-site&run=${runId}`, `/report.html?mode=single-site&run=${runId}`],
        },
      },
    },
  };
}

function comparativeDetail(runId: string, status = 'running') {
  const terminal = status !== 'running';
  return {
    id: runId,
    mode: 'comparative',
    sourceRevision: 'source-1',
    status,
    phase: terminal ? 'Review complete' : 'Executing browser checks',
    createdAt: '2026-08-26T11:59:00.000Z',
    startedAt: '2026-08-26T12:00:00.000Z',
    finishedAt: terminal ? '2026-08-26T12:01:00.000Z' : null,
    externalManaged: false,
    stopRequestedAt: null,
    options: { profile: 'release', projects: ['candidate-desktop-chromium'], auditIds: ['NAV-001'], productionUrl: 'https://quitting7oh.org', candidateUrl: 'https://beta.example.test' },
    progress: { total: 10, completed: terminal ? 10 : 4 },
    pipeline: { status: terminal ? 'completed' : 'running', reason: 'Fixture pipeline.' },
    release: { decision: terminal ? 'NOT_READY' : 'PENDING', reason: 'Fixture decision.' },
    command: ['docker', 'compose', 'run'],
    stages: {},
    purge: { eligible: terminal, confirmation: `PURGE ${runId}` },
  };
}

function singleSiteDetail(runId: string, revision: number, status = 'running') {
  const terminal = status === 'completed';
  return {
    schemaVersion: 1,
    id: runId,
    mode: 'single-site',
    revision,
    sourceRevision: `state-${revision}`,
    status,
    activity: terminal ? 'idle' : 'normal',
    createdAt: '2026-08-26T12:00:00.000Z',
    updatedAt: `2026-08-26T12:00:0${revision}.000Z`,
    deploymentRole: 'preview',
    scope: { qualifier: 'FULL', selectedTargetIds: ['single-site-desktop-chromium'] },
    coverage: { status: 'COMPLETE' },
    evidenceAuthority: { status: 'authoritative' },
    attempt: { number: 1 },
    finalization: { status: terminal ? 'complete' : 'pending' },
    links: { report: terminal ? `/report.html?mode=single-site&run=${runId}` : null },
    purge: { eligible: terminal, confirmation: `PURGE ${runId}` },
  };
}

async function installFakeEventSource(page: Page) {
  await page.addInitScript(() => {
    class FakeEventSource extends EventTarget {
      static instances: FakeEventSource[] = [];
      static CLOSED = 2;
      url: string;
      readyState = 0;
      closed = false;
      constructor(url: string) {
        super();
        this.url = url;
        FakeEventSource.instances.push(this);
        queueMicrotask(() => {
          if (this.closed) return;
          this.readyState = 1;
          this.dispatchEvent(new Event('open'));
        });
      }
      close() { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
      emit(type: string, data: unknown, id = '') {
        this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: String(id) }));
      }
    }
    (window as any).EventSource = FakeEventSource;
    (window as any).__fakeEventSources = FakeEventSource.instances;
  });
}

async function fulfillCommon(route: Route, mode: Mode, runId: string, values: {
  summary: () => Record<string, any>;
  detail: () => Record<string, any>;
  logs: () => Record<string, any>;
}) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === `/api/console/v1/runs/${mode}/${runId}`) return route.fulfill({ json: values.summary() });
  if (url.pathname === `${mode === 'single-site' ? '/api/single-site/runs' : '/api/runs'}/${runId}` && request.method() === 'GET') return route.fulfill({ json: values.detail() });
  if (url.pathname.endsWith(`/${runId}/logs`)) return route.fulfill({ json: values.logs() });
  if (url.pathname.endsWith(`/${runId}/artifacts`)) return route.fulfill({ json: { files: [], total: 0, nextOffset: 0, hasMore: false, totalComplete: true } });
  if (url.pathname === '/api/config') return route.fulfill({ json: { catalog: [] } });
  if (url.pathname.endsWith('/manual-evidence')) return route.fulfill({ json: { schemaVersion: 1, uploads: [], entries: [] } });
  return route.fallback();
}

test.describe('run-workspace', () => {
  for (const mode of ['comparative', 'single-site'] as const) {
    test(`shared ${mode} workspace authenticates in-page and presents revision-bound Product Risk with durable rekick`, async ({ page }) => {
      const runId = `shared-${mode}-run`;
      let authorized = false;
      let operationAccepted = false;
      const finalSubjectDigest = `sha256:${'b'.repeat(64)}`;
      const route = async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/control/v1/session' && request.method() === 'GET') {
          return route.fulfill({ status: authorized ? 200 : 401, json: authorized
            ? { schemaVersion: 1, data: { csrfToken: 'csrf-fixture', principal: { id: 'reviewer-1' } } }
            : { schemaVersion: 1, error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.' } } });
        }
        if (url.pathname === '/api/control/v1/session' && request.method() === 'POST') {
          expect((await request.postDataJSON()).credential).toBe('scoped-browser-credential');
          authorized = true;
          return route.fulfill({ json: { schemaVersion: 1, data: { csrfToken: 'csrf-fixture', principal: { id: 'reviewer-1' } } } });
        }
        const root = `/api/control/v1/runs/${runId}`;
        const revision = operationAccepted ? 8 : 7;
        if (url.pathname === `${root}/publication`) return route.fulfill({ json: { schemaVersion: 1, data: {
          runId, runRevision: revision, decisionRevision: 3, riskRevision: 2, finalSubjectDigest,
          decision: { mode, label: 'FEATURE READY', grantedAuthority: 'TARGETED', certifiedScope: {
            features: ['navigation'], definitions: ['NAV-001'], targets: ['desktop'], knownLimits: ['checkout-parity-deferred'],
          } },
          riskRegister: { availability: 'PARTIAL', risks: [
            {
              identity: 'risk-manual-1', category: 'manual-check', severity: 'high', mode,
              reviewState: 'OPEN', releaseEffect: 'non-blocking', explanation: 'Manual checkout remains outstanding.',
              recommendedAction: 'Review checkout on a physical device.', source: { kind: 'manual', id: 'manual-1' },
              scope: { features: ['checkout'], definitions: ['CHECKOUT-001'], targets: ['desktop'], knownLimits: [] },
              actor: { kind: 'service', id: 'runner-1' }, observedAt: '2026-08-29T14:00:00.000Z', updatedAt: '2026-08-29T14:01:00.000Z',
            },
            {
              identity: 'risk-visual-1', category: 'unreviewed-visual-change', severity: 'medium', mode,
              reviewState: 'PENDING_REVIEW', releaseEffect: 'non-blocking', explanation: 'A deterministic comparison changed.',
              recommendedAction: 'Review the bounded visual evidence.', source: { kind: 'visual-review', id: 'oracle-visual-1' },
              scope: { features: ['navigation'], definitions: ['NAV-001'], targets: ['desktop'], knownLimits: [] },
              actor: { kind: 'worker', id: 'visual-worker-1' }, observedAt: '2026-08-29T14:02:00.000Z', updatedAt: '2026-08-29T14:03:00.000Z',
            },
            ...Array.from({ length: 199 }, (_, index) => ({
              identity: `risk-resolved-${String(index).padStart(3, '0')}`, category: 'manual-check', severity: index === 198 ? 'critical' : 'low', mode,
              reviewState: 'RESOLVED', releaseEffect: 'non-blocking', explanation: `Resolved historical risk ${index}.`,
              recommendedAction: 'No action required.', source: { kind: 'manual', id: `resolved-${index}` },
              scope: { features: ['history'], definitions: ['HISTORY-001'], targets: ['desktop'], knownLimits: [] },
              actor: { kind: 'reviewer', id: 'reviewer-1' }, observedAt: '2026-08-28T14:00:00.000Z', updatedAt: '2026-08-28T15:00:00.000Z',
            })),
          ] },
        } } });
        if (url.pathname === `${root}/executions`) return route.fulfill({ json: { schemaVersion: 1, data: {
          runId, runRevision: revision, executions: operationAccepted ? [] : [{ id: 'work-incomplete', state: 'incomplete' }],
          oracleExecutions: [{ id: 'oracle-visual-1' }],
        } } });
        if (url.pathname === `${root}/logs`) return route.fulfill({ json: { schemaVersion: 1, data: { runId, runRevision: revision, limit: 200, truncated: false, events: [], attemptLogs: [] } } });
        if (url.pathname === `${root}/rekick` && request.method() === 'POST') {
          expect(request.headers()['x-audit-csrf']).toBe('csrf-fixture');
          expect(request.headers()['idempotency-key']).toBeTruthy();
          expect((await request.postDataJSON()).workItemIds).toEqual(['work-incomplete']);
          operationAccepted = true;
          return route.fulfill({ status: 202, json: { schemaVersion: 1, data: {
            operationId: 'a'.repeat(64), state: 'accepted', statusUrl: `${root}/operations/${'a'.repeat(64)}`,
          } } });
        }
        if (url.pathname === `${root}/operations/${'a'.repeat(64)}`) return route.fulfill({ json: { schemaVersion: 1, data: {
          operationId: 'a'.repeat(64), state: 'completed', outcome: { status: 'succeeded' },
        } } });
        if (url.pathname.startsWith('/api/console/v1/runs/')
          || url.pathname.startsWith('/api/runs/') || url.pathname.startsWith('/api/single-site/runs/')) {
          return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'No legacy projection exists.' } } });
        }
        return route.fallback();
      };
      await page.route('**/api/**', route);
      await page.goto(`/run.html?mode=${mode}&run=${runId}`);
      await expect(page.locator('#run-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
      await expect(page.locator('input[name="control-credential"]')).toHaveAttribute('type', 'password');
      await page.locator('input[name="control-credential"]').fill('scoped-browser-credential');
      await page.getByRole('button', { name: 'Authorize this browser session' }).click();
      await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible();
      await expect(page.locator('#run-product-risk')).toHaveAttribute('data-risk-availability', 'PARTIAL');
      await expect(page.locator('#run-product-risk')).toContainText('non-blocking');
      await expect(page.locator('#run-product-risk')).toContainText('Pipeline Integrity');
      await expect(page.locator('.run-risk-pagination')).toContainText('Showing 1–200 of 201 risks');
      await expect(page.locator('[data-risk-identity="risk-manual-1"]')).toContainText('manual:manual-1 · actor service:runner-1');
      await expect(page.locator('[data-risk-identity="risk-manual-1"]')).toContainText('2026-08-29T14:00:00.000Z');
      await expect(page.locator('[data-risk-identity="risk-resolved-197"]')).toHaveCount(0);
      await page.getByRole('button', { name: 'Next risks' }).click();
      await expect(page.locator('.run-risk-pagination')).toContainText('Showing 201–201 of 201 risks');
      await expect(page.locator('[data-risk-identity="risk-resolved-197"]')).toBeVisible();
      await page.getByRole('button', { name: 'Previous risks' }).click();
      await expect(page.getByRole('button', { name: 'Accept visual change' })).toBeVisible();
      await page.getByRole('button', { name: 'Rekick incomplete execution' }).click();
      await expect(page.locator('#run-inspector-source-revision')).toHaveText('shared-8');
      await expect(page.getByRole('button', { name: 'Rekick incomplete execution' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Product Risk' })).toBeFocused();
      await expect(page.locator('input[name="control-credential"]')).toHaveValue('');
    });
  }

  test('direct entry keeps authority fields separate, grouped navigation canonical, and terminal transport dormant', async ({ page }) => {
    const runId = 'run-workspace-terminal';
    await installFakeEventSource(page);
    await page.route('**/api/**', (route) => fulfillCommon(route, 'comparative', runId, {
      summary: () => summary('comparative', runId, { executionState: 'not-ready', activityState: 'idle', terminal: true }),
      detail: () => comparativeDetail(runId, 'not-ready'),
      logs: () => ({ log: '2026-08-26T12:00:00.000Z [playwright:stdout] terminal fixture', sequence: 8, bytes: 75, maxBytes: 262_144, truncated: false, sources: [] }),
    }));

    await page.goto(`/run.html?mode=comparative&run=${runId}&view=overview&unknown=discard#unsafe`);
    await expect(page.getByRole('heading', { name: 'Run workspace' })).toBeVisible();
    await expect(page.locator('#run-execution-state')).toHaveText('Not Ready');
    await expect(page.locator('#run-activity-state')).toHaveText('Idle');
    await expect(page.locator('#run-connection-state')).toHaveText('Closed');
    await expect(page.locator('#run-finalization')).toHaveText('Not applicable');
    await expect(page.locator('#run-evidence-authority')).toHaveText('Authoritative');
    await expect(page.locator('.run-shared-session')).toBeHidden();
    await expect(page.locator('#run-product-risk')).toBeHidden();
    expect(new URL(page.url()).searchParams.has('unknown')).toBe(false);
    expect(new URL(page.url()).hash).toBe('');
    expect(await page.locator('.run-view-group').allTextContents()).toEqual([
      'WorkspaceOverview', 'ReviewTestsFindingsEvidence', 'DiagnosticsTimelineLogs', 'OutcomeReport',
    ]);
    expect(await page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(0);

    await page.locator('[data-run-view-link="logs"]').click();
    await expect(page.locator('#run-log-list')).toContainText('terminal fixture');
    expect(new URL(page.url()).searchParams.get('view')).toBe('logs');
    await page.goBack();
    await expect(page.locator('[data-run-view-link="overview"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-run-view-link="logs"]')).toBeFocused();
    await expect(page.locator('[data-run-destination="report"]')).toHaveAttribute('href', `/report.html?run=${runId}`);

    await page.goForward();
    await page.locator('#run-log-search').fill('terminal');
    await page.locator('#run-log-search').press('Tab');
    await page.locator('#run-log-source-filter').selectOption('stdout');
    await page.locator('#run-log-stage-filter').selectOption('playwright');
    await expect(page.locator('#run-log-list')).toContainText('terminal fixture');
    await page.reload();
    await expect(page.locator('#run-log-search')).toHaveValue('terminal');
    await expect(page.locator('#run-log-source-filter')).toHaveValue('stdout');
    await expect(page.locator('#run-log-stage-filter')).toHaveValue('playwright');
    await page.goBack();
    await expect(page.locator('#run-log-stage-filter')).toHaveValue('all');
    await expect(page.locator('#run-log-source-filter')).toBeFocused();

    const accessibility = await new AxeBuilder({ page }).include('#run-workspace').analyze();
    expect(accessibility.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')).toEqual([]);
  });

  test('comparative replay, disconnect, overflow recovery, and a huge paused log remain bounded without changing durable state', async ({ page }) => {
    const runId = 'run-workspace-live';
    await installFakeEventSource(page);
    let logReads = 0;
    const hugeTail = Array.from({ length: 3_500 }, (_, index) => `2026-08-26T12:00:00.000Z [shard1:stdout] request ${index} returned HTTP 200`).join('\n');
    await page.route('**/api/**', (route) => fulfillCommon(route, 'comparative', runId, {
      summary: () => summary('comparative', runId),
      detail: () => comparativeDetail(runId),
      logs: () => {
        logReads += 1;
        return logReads === 1
          ? { log: '2026-08-26T12:00:00.000Z [playwright:stdout] initial', sequence: 5, bytes: 60, maxBytes: 262_144, truncated: false, sources: [] }
          : { log: hugeTail, sequence: 10, bytes: 260_000, maxBytes: 262_144, truncated: true, sources: [{ path: 'logs/runner.log', truncated: true }] };
      },
    }));
    await page.goto(`/run.html?mode=comparative&run=${runId}&view=logs`);
    await expect.poll(() => page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(1);
    await page.evaluate(() => {
      const source = (window as any).__fakeEventSources[0];
      source.emit('log', { timestamp: '2026-08-26T12:00:01.000Z', stage: 'shard1', channel: 'stdout', line: 'deduplicated live line' }, 6);
      source.emit('log', { timestamp: '2026-08-26T12:00:01.000Z', stage: 'shard1', channel: 'stdout', line: 'deduplicated live line' }, 6);
    });
    await expect(page.getByText('deduplicated live line')).toHaveCount(1);
    await page.locator('#run-log-pause').click();
    await page.evaluate(() => (window as any).__fakeEventSources[0].emit('log', { stage: 'shard1', channel: 'stderr', line: 'paused ffmpeg output' }, 7));
    await expect(page.locator('#run-log-window-status')).toContainText('Paused with 1 newer record');
    await expect(page.getByText('paused ffmpeg output')).toHaveCount(0);
    await page.locator('#run-log-pause').click();
    await expect(page.getByText('paused ffmpeg output')).toHaveCount(1);
    await page.locator('#run-log-pause').click();
    await page.evaluate(() => {
      const source = (window as any).__fakeEventSources[0];
      for (let index = 0; index < 1_000; index += 1) {
        source.emit('log', { stage: 'shard1', channel: 'stdout', line: `bounded paused delta ${index}` }, 100 + index);
      }
    });
    const pausedWindow = await page.evaluate(() => (window as any).__runWorkspaceDiagnostics.log);
    expect(pausedWindow.pendingRecords).toBeLessThanOrEqual(500);
    expect(pausedWindow.pendingBytes).toBeLessThanOrEqual(128 * 1_024);
    expect(pausedWindow.pendingDropped).toBeGreaterThan(0);
    await page.locator('#run-log-pause').click();

    await page.evaluate(() => (window as any).__fakeEventSources[0].emit('overflow', { dropped: 900, reloadLogs: true }, 8));
    await expect.poll(() => logReads).toBeGreaterThan(1);
    await expect.poll(() => page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(2);
    await expect.poll(() => page.evaluate(() => (window as any).__runWorkspaceDiagnostics.log.records)).toBeLessThanOrEqual(2_000);
    await expect(page.locator('#run-log-window-status')).toContainText('bounded tail');

    await page.evaluate(() => (window as any).__fakeEventSources[1].dispatchEvent(new Event('error')));
    await expect(page.locator('#run-connection-state')).toHaveText(/Reconnecting|Offline/);
    await expect(page.locator('#run-execution-state')).toHaveText('Running');
    const diagnostics = await page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport);
    expect(diagnostics.eventSources).toBe(0);
    expect(diagnostics.retryTimers).toBe(1);
    await expect.poll(() => logReads).toBeGreaterThan(2);
    await expect.poll(() => page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(3);
    await expect(page.locator('#run-connection-state')).toHaveText('Connected');
  });

  test('hidden and resumed comparative workspaces release the stream and pagehide returns every client owner to zero', async ({ page }) => {
    const runId = 'run-workspace-visibility';
    await installFakeEventSource(page);
    await page.route('**/api/**', (route) => fulfillCommon(route, 'comparative', runId, {
      summary: () => summary('comparative', runId),
      detail: () => comparativeDetail(runId),
      logs: () => ({ log: 'visibility fixture', sequence: 2, bytes: 18, maxBytes: 262_144, truncated: false, sources: [] }),
    }));
    await page.goto(`/run.html?mode=comparative&run=${runId}&view=overview`);
    await expect.poll(() => page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport.eventSources)).toBe(0);
    expect(await page.evaluate(() => (window as any).__fakeEventSources.every((entry: any) => entry.closed))).toBe(true);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(2);
    await expect(page.locator('#run-connection-state')).toHaveText('Connected');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    expect(await page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport)).toMatchObject({ eventSources: 0, retryTimers: 0 });
    expect(await page.evaluate(() => (window as any).__fakeEventSources.every((entry: any) => entry.closed))).toBe(true);
  });

  test('late events from a closed A transport cannot mutate the B identity or purge its evidence', async ({ page }) => {
    const firstRun = 'run-workspace-identity-a';
    const secondRun = 'run-workspace-identity-b';
    await installFakeEventSource(page);
    await page.route('**/api/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const runId = pathname.includes(secondRun) ? secondRun : firstRun;
      return fulfillCommon(route, 'comparative', runId, {
        summary: () => summary('comparative', runId),
        detail: () => comparativeDetail(runId),
        logs: () => ({ log: `${runId} retained log`, sequence: 1, bytes: 40, maxBytes: 262_144, truncated: false, sources: [] }),
      });
    });
    await page.goto(`/run.html?mode=comparative&run=${firstRun}&view=logs`);
    await expect.poll(() => page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(1);
    await page.evaluate((runId) => {
      history.pushState({}, '', `/run.html?mode=comparative&run=${runId}&view=logs`);
      dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    }, secondRun);
    await expect(page.locator('#run-id')).toHaveText(secondRun);
    await expect.poll(() => page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(2);
    await page.evaluate((runId) => {
      const old = (window as any).__fakeEventSources[0];
      const stale = { ...({} as any), id: runId, status: 'not-ready', phase: 'stale A phase', sourceRevision: 'source-1' };
      old.emit('snapshot', { manifest: stale }, 10);
      old.emit('stage', { manifest: stale }, 11);
      old.emit('status', { manifest: stale }, 12);
      old.emit('log', { channel: 'stderr', line: 'late A log must not appear' }, 13);
      old.emit('purged', { id: runId }, 14);
    }, firstRun);
    await expect(page.locator('#run-id')).toHaveText(secondRun);
    await expect(page.locator('#run-execution-state')).toHaveText('Running');
    await expect(page.locator('#run-log-list')).not.toContainText('late A log must not appear');
    await expect(page.getByRole('heading', { name: 'Run evidence purged' })).toHaveCount(0);
  });

  test('overlapping same-identity status refreshes are latest-started-wins', async ({ page }) => {
    const runId = 'run-workspace-latest-wins';
    await installFakeEventSource(page);
    let summaryReads = 0;
    let detailReads = 0;
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === `/api/console/v1/runs/comparative/${runId}`) {
        summaryReads += 1;
        const read = summaryReads;
        if (read === 2) await oldGate;
        const revision = read === 2 ? 'source-2' : read >= 3 ? 'source-3' : 'source-1';
        const value = summary('comparative', runId, { revision });
        value.data.record.fields.phase = read === 2 ? 'older-authority' : read >= 3 ? 'newer-authority' : 'browser-checks';
        return route.fulfill({ json: value });
      }
      if (url.pathname === `/api/runs/${runId}` && route.request().method() === 'GET') {
        detailReads += 1;
        const read = detailReads;
        if (read === 2) await oldGate;
        const revision = read === 2 ? 'source-2' : read >= 3 ? 'source-3' : 'source-1';
        return route.fulfill({ json: { ...comparativeDetail(runId), sourceRevision: revision, phase: read === 2 ? 'Older authority' : read >= 3 ? 'Newer authority' : 'Browser checks' } });
      }
      if (url.pathname.endsWith(`/${runId}/logs`)) return route.fulfill({ json: { log: '', sequence: 1, bytes: 0, maxBytes: 262_144, truncated: false, sources: [] } });
      return route.fallback();
    });
    await page.goto(`/run.html?mode=comparative&run=${runId}&view=overview`);
    await expect.poll(() => page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(1);
    await page.evaluate(() => {
      const source = (window as any).__fakeEventSources[0];
      source.emit('status', { status: 'running' }, 2);
      source.emit('status', { status: 'running' }, 3);
    });
    await expect.poll(() => Math.min(summaryReads, detailReads)).toBeGreaterThanOrEqual(3);
    await expect(page.locator('#run-phase')).toHaveText('Newer Authority');
    releaseOld();
    await page.waitForTimeout(100);
    await expect(page.locator('#run-phase')).toHaveText('Newer Authority');
  });

  test('mixed authority generations and incomplete fields remain explicit instead of synthesizing state', async ({ page }) => {
    const mismatchedRun = 'run-workspace-mixed-generation';
    await page.route('**/api/**', (route) => fulfillCommon(route, 'comparative', mismatchedRun, {
      summary: () => summary('comparative', mismatchedRun, { revision: 'source-old' }),
      detail: () => ({ ...comparativeDetail(mismatchedRun), sourceRevision: 'source-new' }),
      logs: () => ({ log: 'newer log', sequence: 4, bytes: 9, maxBytes: 262_144, truncated: false, sources: [] }),
    }));
    await page.goto(`/run.html?mode=comparative&run=${mismatchedRun}&view=overview`);
    await expect(page.getByRole('heading', { name: 'Run unavailable' })).toBeVisible();
    await expect(page.locator('#run-execution-state')).toHaveText('Unavailable');
    await expect(page.locator('#run-view-region')).toHaveAttribute('data-async-state', 'retryable-failure');

    const partialRun = 'run-workspace-partial-authority';
    await installFakeEventSource(page);
    await page.unroute('**/api/**');
    await page.route('**/api/**', (route) => fulfillCommon(route, 'comparative', partialRun, {
      summary: () => {
        const value: any = summary('comparative', partialRun, { terminal: false });
        value.complete = false;
        value.data.record.complete = false;
        value.data.record.sourceUpdatedAt = null;
        delete value.data.record.fields.progressCompleted;
        value.data.record.fields.terminal = false;
        return value;
      },
      detail: () => ({
        ...comparativeDetail(partialRun, 'not-ready'), sourceRevision: 'source-1', createdAt: null,
        startedAt: null, finishedAt: null, updatedAt: null, progress: { total: 10 },
      }),
      logs: () => ({ log: '', sequence: 4, bytes: 0, maxBytes: 262_144, truncated: false, sources: [] }),
    }));
    await page.goto(`/run.html?mode=comparative&run=${partialRun}&view=overview`);
    await expect(page.locator('#run-progress')).toHaveText('Unavailable');
    await expect(page.locator('#run-last-update')).toHaveText('Unavailable');
    await expect(page.locator('#run-view-region')).toHaveAttribute('data-async-state', 'partial');
    await expect.poll(() => page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(1);
  });

  test('Single-site polling rejects stale-summary/new-detail generations and uses no EventSource', async ({ page }) => {
    const runId = 'job-run-workspace-poll';
    await installFakeEventSource(page);
    let phase: 'initial' | 'mismatch' | 'settled' = 'initial';
    let detailReads = 0;
    await page.route('**/api/**', (route) => fulfillCommon(route, 'single-site', runId, {
      summary: () => summary('single-site', runId, phase === 'settled'
        ? { revision: 'state-5', authorityRevision: 'authority-5', executionState: 'completed', activityState: 'idle', terminal: true }
        : { revision: phase === 'initial' ? 'state-4' : 'state-5' }),
      detail: () => {
        detailReads += 1;
        if (detailReads > 1 && phase === 'initial') phase = 'mismatch';
        return phase === 'initial' ? singleSiteDetail(runId, 4) : singleSiteDetail(runId, 5, phase === 'settled' ? 'completed' : 'running');
      },
      logs: () => ({ log: '{"timestamp":"2026-08-26T12:00:00.000Z","event":"command-output","detail":{"channel":"stdout","line":"worker output"}}', sequence: phase === 'settled' ? 5 : 4, bytes: 130, maxBytes: 262_144, truncated: false, sources: [] }),
    }));
    await page.goto(`/run.html?mode=single-site&run=${runId}&view=overview`);
    await expect(page.locator('#run-execution-state')).toHaveText('Running');
    await expect.poll(() => phase).toBe('mismatch');
    await expect(page.locator('#run-execution-state')).toHaveText('Running');
    await expect(page.locator('#run-inspector-source-revision')).toHaveText('state-4');
    expect(await page.evaluate(() => (window as any).__fakeEventSources.length)).toBe(0);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport)).toMatchObject({ pollTimers: 0, inFlightPolls: 0 });
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    phase = 'settled';
    await expect(page.locator('#run-execution-state')).toHaveText('Completed', { timeout: 6_000 });
    await expect(page.locator('#run-finalization')).toHaveText('Complete');
    await expect(page.locator('#run-connection-state')).toHaveText('Closed');
    const diagnostics = await page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport);
    expect(diagnostics).toMatchObject({ eventSources: 0, pollTimers: 0, inFlightPolls: 0 });
  });

  test('terminal Single-site execution with pending finalization uses one bounded backoff timer', async ({ page }) => {
    const runId = 'job-run-workspace-finalizing';
    await page.route('**/api/**', (route) => fulfillCommon(route, 'single-site', runId, {
      summary: () => summary('single-site', runId, {
        revision: 'state-3', executionState: 'completed', activityState: 'idle', terminal: true, finalizationStatus: 'pending',
      }),
      detail: () => ({ ...singleSiteDetail(runId, 3), status: 'completed', finalization: { status: 'pending' } }),
      logs: () => ({ log: '', sequence: 3, bytes: 0, maxBytes: 262_144, truncated: false, sources: [] }),
    }));
    await page.goto(`/run.html?mode=single-site&run=${runId}&view=overview`);
    await expect(page.locator('#run-finalization')).toHaveText('Pending');
    await expect.poll(() => page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport)).toMatchObject({
      eventSources: 0,
      pollTimers: 1,
      inFlightPolls: 0,
      cadence: 'bounded-backoff',
    });
  });

  test('timeline keeps stage, shard, attempt, retry, and duration relationships in one bounded row', async ({ page }) => {
    const runId = 'run-workspace-timeline';
    let timelineQuery = '';
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === `/api/console/v1/runs/comparative/${runId}/timeline`) {
        timelineQuery = url.search;
        const pageNumber = Number(url.searchParams.get('cursor')?.replace('page-', '') ?? 0);
        const items = Array.from({ length: 50 }, (_, index) => ({
          recordId: pageNumber === 0 && index === 0 ? 'timeline-browser-2' : `timeline-${pageNumber}-${index}`,
          fields: {
            startedAt: '2026-08-26T12:00:01.000Z', sourceKind: 'stage', stageId: 'browser', shardId: '2',
            attemptNumber: 3, retryNumber: 1, status: 'completed-with-findings', durationMs: 1_234,
          },
        }));
        return route.fulfill({ json: {
          schemaVersion: 1,
          apiVersion: 'v1',
          routeId: 'run-timeline',
          complete: true,
          freshness: 'current',
          limitations: [],
          data: { items, nextCursor: pageNumber < 5 ? `page-${pageNumber + 1}` : null },
        } });
      }
      return fulfillCommon(route, 'comparative', runId, {
        summary: () => summary('comparative', runId, { executionState: 'not-ready', activityState: 'idle', terminal: true }),
        detail: () => comparativeDetail(runId, 'not-ready'),
        logs: () => ({ log: '', sequence: 2, bytes: 0, maxBytes: 262_144, truncated: false, sources: [] }),
      });
    });
    await page.goto(`/run.html?mode=comparative&run=${runId}&view=timeline&stage=browser&shard=2`);
    await expect(page.locator('[data-timeline-record="timeline-browser-2"]')).toContainText(
      'stage browser · shard 2 · attempt 3 · retry 1 · completed-with-findings · 1234 ms',
    );
    expect(timelineQuery).toContain('limit=50');
    expect(timelineQuery).toContain('stage=browser');
    expect(timelineQuery).toContain('shard=2');
    for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) await page.locator('[data-timeline-more]').click();
    await expect(page.locator('.run-timeline-list li')).toHaveCount(200);
    await expect(page.locator('.run-timeline-list')).toHaveAttribute('data-window-omitted', '100');
  });

  test('timeline discards a stale continuation and restarts from the null cursor', async ({ page }) => {
    const runId = 'run-workspace-stale-timeline';
    const cursors: Array<string | null> = [];
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === `/api/console/v1/runs/comparative/${runId}/timeline`) {
        const cursor = url.searchParams.get('cursor');
        cursors.push(cursor);
        if (cursor === 'stale-cursor') return route.fulfill({
          status: 409,
          json: { error: { code: 'CONSOLE_CURSOR_STALE', message: 'The source revision changed.' } },
        });
        const refreshed = cursors.length > 1;
        return route.fulfill({ json: {
          schemaVersion: 1, apiVersion: 'v1', routeId: 'run-timeline', complete: true,
          freshness: 'current', limitations: [],
          data: { items: [{ recordId: refreshed ? 'timeline-refreshed' : 'timeline-initial', fields: { sourceKind: 'status', status: refreshed ? 'refreshed' : 'initial' } }], nextCursor: refreshed ? null : 'stale-cursor' },
        } });
      }
      return fulfillCommon(route, 'comparative', runId, {
        summary: () => summary('comparative', runId, { executionState: 'not-ready', activityState: 'idle', terminal: true }),
        detail: () => comparativeDetail(runId, 'not-ready'),
        logs: () => ({ log: '', sequence: 2, bytes: 0, maxBytes: 262_144, truncated: false, sources: [] }),
      });
    });
    await page.goto(`/run.html?mode=comparative&run=${runId}&view=timeline`);
    await expect(page.locator('[data-timeline-record="timeline-initial"]')).toBeVisible();
    await page.locator('[data-timeline-more]').click();
    await expect(page.locator('[data-timeline-record="timeline-refreshed"]')).toBeVisible();
    await expect(page.locator('[data-timeline-record="timeline-initial"]')).toHaveCount(0);
    expect(cursors).toEqual([null, 'stale-cursor', null]);
  });

  for (const mode of ['comparative', 'single-site'] as const) {
    const actionId = mode === 'comparative' ? 'stop' : 'cancel';
    test(`immutable ${actionId} binding revalidates exact ${mode} authority and submits once`, async ({ page }) => {
      const runId = mode === 'comparative' ? 'run-workspace-stop' : 'job-run-workspace-cancel';
      await installFakeEventSource(page);
      let accepted = false;
      let rejectedOnce = mode === 'comparative';
      const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const endpoint = mode === 'comparative' ? `/api/runs/${runId}/stop` : `/api/single-site/runs/${runId}/cancel`;
        if (url.pathname === endpoint && request.method() === 'POST') {
          requests.push({ path: url.pathname, body: request.postDataJSON() });
          if (rejectedOnce) {
            rejectedOnce = false;
            return route.fulfill({ status: 401, json: { error: 'Operator authorization is required for this fixture.' } });
          }
          accepted = true;
          return route.fulfill({ status: mode === 'comparative' ? 200 : 202, json: { accepted: true } });
        }
        return fulfillCommon(route, mode, runId, {
          summary: () => summary(mode, runId, {
            revision: mode === 'single-site' ? (accepted ? 'state-2' : 'state-1') : (accepted ? 'source-2' : 'source-1'),
            authorityRevision: accepted ? 'authority-2' : 'authority-1',
            executionState: accepted ? (mode === 'comparative' ? 'stopping' : 'completed') : 'running',
            activityState: accepted ? 'idle' : 'collecting-evidence',
            terminal: mode === 'single-site' && accepted,
            actions: [action(actionId, !accepted)],
          }),
          detail: () => mode === 'comparative'
            ? { ...comparativeDetail(runId), sourceRevision: accepted ? 'source-2' : 'source-1', status: accepted ? 'stopping' : 'running', phase: accepted ? 'Stopping browser work' : 'Executing browser checks', stopRequestedAt: accepted ? '2026-08-26T12:01:00.000Z' : null }
            : singleSiteDetail(runId, accepted ? 2 : 1, accepted ? 'completed' : 'running'),
          logs: () => ({ log: '', sequence: accepted ? 2 : 1, bytes: 0, maxBytes: 262_144, truncated: false, sources: [] }),
        });
      });
      await page.goto(`/run.html?mode=${mode}&run=${runId}&view=overview`);
      await page.locator(`[data-run-action="${actionId}"]`).click();
      const frozen = await page.evaluate(() => (window as any).__runWorkspaceDiagnostics.action);
      expect(frozen).toMatchObject({
        bindingFrozen: true,
        bodyFrozen: true,
        binding: {
          actionId, mode, runId,
          sourceRevision: mode === 'comparative' ? 'source-1' : 'state-1',
          authorityRevision: 'authority-1',
        },
      });
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('[data-action-submit]')!;
        button.click();
        button.click();
      });
      await expect.poll(() => requests).toHaveLength(1);
      const expectedRequest = {
        path: mode === 'comparative' ? `/api/runs/${runId}/stop` : `/api/single-site/runs/${runId}/cancel`,
        body: mode === 'comparative' ? {} : { reason: 'Cancelled by the portal operator.' },
      };
      expect(requests[0]).toEqual(expectedRequest);
      if (mode === 'comparative') {
        await expect(page.locator('#run-action-message')).toContainText('Operator authorization is required');
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-run-action="stop"]')).toBeFocused();
        await page.locator('[data-run-action="stop"]').click();
        await page.locator('[data-action-submit]').click();
        await expect.poll(() => requests).toHaveLength(2);
        expect(requests[1]).toEqual(expectedRequest);
      }
      await expect(page.locator('#run-execution-state')).toHaveText(mode === 'comparative' ? 'Stopping' : 'Completed');
      await expect(page.locator(`[data-run-action="${actionId}"]`)).toBeFocused();
      await page.locator(`[data-run-action="${actionId}"]`).evaluate((button: HTMLButtonElement) => button.click());
      await expect(page.locator('#run-action-dialog')).not.toHaveAttribute('open', '');
      if (mode === 'comparative') {
        expect(await page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport.eventSources)).toBe(1);
      }
    });
  }

  test('comparative manual evidence freezes prose and file targets while evidence pagination stays bounded', async ({ page }) => {
    const runId = 'run-workspace-manual';
    let upload: { path: string; body: string } | null = null;
    let recoveredUpload: Record<string, unknown> | null = null;
    let attestation: Record<string, unknown> | null = null;
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === `/api/runs/${runId}/manual-uploads` && request.method() === 'POST') {
        upload = { path: `${url.pathname}${url.search}`, body: request.postData() ?? '' };
        recoveredUpload = {
          id: 'upload-fixture-1', auditId: url.searchParams.get('auditId'), name: url.searchParams.get('filename'),
          idempotencyKey: url.searchParams.get('idempotencyKey'),
        };
        return route.abort('connectionreset');
      }
      if (url.pathname === `/api/runs/${runId}/manual-evidence` && request.method() === 'POST') {
        attestation = request.postDataJSON();
        return route.fulfill({ status: 201, json: { accepted: true } });
      }
      if (url.pathname === `/api/runs/${runId}/manual-evidence`) return route.fulfill({ json: { schemaVersion: 1, uploads: recoveredUpload ? [recoveredUpload] : [], entries: [] } });
      if (url.pathname === `/api/runs/${runId}/artifacts`) {
        const offset = Number(url.searchParams.get('offset'));
        return route.fulfill({ json: offset === 0
          ? { files: [{ kind: 'screenshot', path: 'first.png', url: `/artifacts/${runId}/first.png` }], total: 2, offset: 0, nextOffset: 1, hasMore: true, totalComplete: false }
          : { files: [{ kind: 'video', path: 'second.webm', url: `/artifacts/${runId}/second.webm` }], total: 2, offset: 1, nextOffset: 2, hasMore: false, totalComplete: true } });
      }
      if (url.pathname === '/api/config') return route.fulfill({ json: { catalog: [{ id: 'DEVICE-001', title: 'Real device review', manual: true }] } });
      return fulfillCommon(route, 'comparative', runId, {
        summary: () => summary('comparative', runId, {
          executionState: 'not-ready', activityState: 'idle', terminal: true,
          actions: [action('manualEvidence', true)],
        }),
        detail: () => comparativeDetail(runId, 'not-ready'),
        logs: () => ({ log: '', sequence: 2, bytes: 0, maxBytes: 262_144, truncated: false, sources: [] }),
      });
    });
    await page.goto(`/run.html?mode=comparative&run=${runId}&view=evidence`);
    await expect(page.locator('.run-artifact-list')).toContainText('first.png');
    await page.locator('[data-artifact-more]').click();
    await expect(page.locator('.run-artifact-list')).toContainText('second.webm');

    await page.getByLabel('Manual audit').selectOption('DEVICE-001');
    await page.getByLabel('Outcome').selectOption('pass');
    await page.getByLabel('Reviewer').fill('Original Reviewer');
    await page.getByLabel('Device and browser').fill('iPhone 15 · Safari');
    await page.getByLabel('Detailed observations').fill('Original observations retained for the immutable attestation.');
    await page.getByLabel('Evidence files').setInputFiles({ name: 'proof.png', mimeType: 'image/png', buffer: Buffer.from('bound file bytes') });
    await page.getByLabel(/I performed this check on the named device/i).check();
    await page.getByRole('button', { name: 'Review manual attestation' }).click();
    await page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('.run-manual-form')!;
      const textInputs = form.querySelectorAll<HTMLInputElement>('input:not([type="file"])');
      textInputs[0]!.value = 'Changed Reviewer';
      textInputs[1]!.value = 'Changed device';
      form.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Changed observations should not cross the dialog boundary.';
      form.querySelector<HTMLSelectElement>('select')!.value = '';
      form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked = false;
    });
    await page.locator('[data-action-submit]').click();
    await expect.poll(() => attestation).not.toBeNull();
    const capturedUpload = upload as { path: string; body: string } | null;
    expect(capturedUpload?.body).toBe('bound file bytes');
    const uploadUrl = new URL(capturedUpload!.path, 'http://portal.test');
    expect(uploadUrl.pathname).toBe(`/api/runs/${runId}/manual-uploads`);
    expect(uploadUrl.searchParams.get('auditId')).toBe('DEVICE-001');
    expect(uploadUrl.searchParams.get('filename')).toBe('proof.png');
    expect(uploadUrl.searchParams.get('idempotencyKey')).toMatch(/^manual-[0-9a-f-]{36}$/);
    expect(attestation).toEqual({
      auditId: 'DEVICE-001',
      outcome: 'pass',
      reviewer: 'Original Reviewer',
      device: 'iPhone 15 · Safari',
      notes: 'Original observations retained for the immutable attestation.',
      confirmed: true,
      uploadIds: ['upload-fixture-1'],
    });
    await expect(page.locator('[data-run-action="manualEvidence"]')).toBeFocused();
  });

  test('immutable purge binding invalidates on revision change and lost response reconciles without retry', async ({ page }) => {
    const runId = 'run-workspace-purge';
    let revision = 'source-1';
    let authorityRevision = 'authority-1';
    let purged = false;
    let deleteRequests = 0;
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === `/api/console/v1/runs/comparative/${runId}`) {
        if (purged) return route.fulfill({ status: 410, json: { error: 'Run purged.' } });
        return route.fulfill({ json: summary('comparative', runId, { revision, authorityRevision, executionState: 'not-ready', activityState: 'idle', terminal: true }) });
      }
      if (url.pathname === `/api/runs/${runId}` && request.method() === 'GET') {
        if (purged) return route.fulfill({ status: 404, json: { error: 'Run not found.' } });
        return route.fulfill({ json: { ...comparativeDetail(runId, 'not-ready'), sourceRevision: revision } });
      }
      if (url.pathname === `/api/runs/${runId}` && request.method() === 'DELETE') {
        deleteRequests += 1;
        expect(request.postDataJSON()).toEqual({ confirmation: `PURGE ${runId}` });
        purged = true;
        return route.abort('connectionreset');
      }
      if (url.pathname.endsWith('/logs')) return route.fulfill({ json: { log: '', sequence: 3, bytes: 0, maxBytes: 262_144, truncated: false, sources: [] } });
      return route.fallback();
    });
    await page.goto(`/run.html?mode=comparative&run=${runId}&view=overview`);
    await page.locator('[data-run-action="purge"]').click();
    await page.locator('#run-action-confirmation').fill(`PURGE ${runId}`);
    revision = 'source-2';
    authorityRevision = 'authority-2';
    await page.locator('[data-action-submit]').click();
    await expect(page.locator('#run-action-message')).toContainText(/target or authority changed/i);
    expect(deleteRequests).toBe(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-run-action="purge"]')).toBeFocused();
    await page.locator('[data-run-action="purge"]').click();
    await page.locator('#run-action-confirmation').fill(`PURGE ${runId}`);
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-action-submit]')!;
      button.click();
      button.click();
    });
    await expect(page.getByRole('heading', { name: 'Run evidence purged' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Run workspace' })).toBeFocused();
    expect(deleteRequests).toBe(1);
    expect(page.url()).toContain(`run=${runId}`);
    await expect(page.locator('#run-actions')).toBeEmpty();
  });

  test('failed action revalidation is reported before mutation and is not misclassified as a lost response', async ({ page }) => {
    const runId = 'run-workspace-revalidation-failure';
    let failRevalidation = false;
    let deleteRequests = 0;
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === `/api/console/v1/runs/comparative/${runId}`) {
        if (failRevalidation) return route.abort('connectionreset');
        return route.fulfill({ json: summary('comparative', runId, { executionState: 'not-ready', activityState: 'idle', terminal: true }) });
      }
      if (url.pathname === `/api/runs/${runId}` && request.method() === 'GET') {
        return route.fulfill({ json: comparativeDetail(runId, 'not-ready') });
      }
      if (url.pathname === `/api/runs/${runId}` && request.method() === 'DELETE') {
        deleteRequests += 1;
        return route.fulfill({ status: 200, json: { purged: true } });
      }
      if (url.pathname.endsWith('/logs')) {
        return route.fulfill({ json: { log: '', sequence: 1, bytes: 0, maxBytes: 262_144, truncated: false, sources: [] } });
      }
      return route.fallback();
    });
    await page.goto(`/run.html?mode=comparative&run=${runId}&view=overview`);
    await page.locator('[data-run-action="purge"]').click();
    await expect(page.locator('#run-action-dialog')).toBeVisible();
    await page.locator('#run-action-confirmation').fill(`PURGE ${runId}`);
    failRevalidation = true;
    await page.locator('[data-action-submit]').click();
    await expect(page.locator('#run-action-message')).toContainText(/action was not sent.*could not be revalidated/i);
    await expect(page.locator('#run-action-message')).not.toContainText(/response was lost/i);
    expect(deleteRequests).toBe(0);
  });

  test('cross-tab purge invalidation terminally clears workspace transport, evidence, and actions', async ({ page }) => {
    const runId = 'run-workspace-cross-tab-purge';
    await installFakeEventSource(page);
    await page.route('**/api/**', (route) => fulfillCommon(route, 'comparative', runId, {
      summary: () => summary('comparative', runId),
      detail: () => comparativeDetail(runId),
      logs: () => ({ log: 'retained before purge', sequence: 2, bytes: 21, maxBytes: 262_144, truncated: false, sources: [] }),
    }));
    await page.goto(`/run.html?mode=comparative&run=${runId}&view=logs`);
    await expect.poll(() => page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport.eventSources)).toBe(1);
    await expect(page.locator('#run-log-list')).toContainText('retained before purge');
    await page.evaluate((id) => {
      const channel = new BroadcastChannel('quitting7oh-audit-console-invalidation-v1');
      channel.postMessage({ schemaVersion: 1, mode: 'comparative', runId: id, reason: 'purged', occurredAt: new Date().toISOString() });
      channel.close();
    }, runId);
    await expect(page.getByRole('heading', { name: 'Run evidence purged' })).toBeVisible();
    await expect(page.locator('#run-actions')).toBeEmpty();
    await expect(page.locator('#run-destinations')).toBeEmpty();
    await expect.poll(() => page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport.eventSources)).toBe(0);
    expect(await page.evaluate(() => (window as any).__fakeEventSources.every((source: any) => source.closed))).toBe(true);
  });

  test('server capacity refusal falls back cleanly and multi-tab stream counts return to baseline', async ({ request, context }) => {
    const response = await request.get('/__e2e__/run-workspace-diagnostics');
    expect(response.status()).toBe(200);
    const value = await response.json();
    expect(value).toMatchObject({
      schemaVersion: 1,
      runStreams: expect.any(Number),
      galleryStreams: expect.any(Number),
      heartbeats: expect.any(Number),
      totalStreams: expect.any(Number),
      capacity: { perRun: 8, server: 64 },
    });
    expect(JSON.stringify(value)).not.toMatch(/log|runId|credential|secret/i);

    const shardedRoot = process.env.PORTAL_E2E_SERVER_SHARDED_ARTIFACT_ROOT;
    expect(shardedRoot, 'The focused portal runner must provide its isolated sharded root.').toBeTruthy();
    const runId = `run-workspace-capacity-${Date.now()}`;
    const directory = join(shardedRoot!, runId);
    const logDirectory = join(directory, 'logs');
    const startedAt = new Date().toISOString();
    await mkdir(logDirectory, { recursive: true });
    await writeFile(join(logDirectory, 'coordinator.log'), [
      `${startedAt} [COORDINATOR] sharded-release-started ${JSON.stringify({ runId, shardTotal: 1, shardWorkers: '1', tlsPolicy: 'strict' })}`,
      `${startedAt} [COORDINATOR] command-started ${JSON.stringify({ label: 'SHARD 1/1', command: ['fixture', 'shard-1'] })}`,
      '',
    ].join('\n'));

    const tabs: Page[] = [];
    const heldStreams: HeldEventStream[] = [];
    try {
      await expect.poll(async () => (await request.get(`/api/runs/${runId}`)).status(), { timeout: 10_000 }).toBe(200);
      const baseline = await (await request.get('/__e2e__/run-workspace-diagnostics')).json();
      const rapid = await context.newPage();
      await rapid.goto('/');
      await rapid.evaluate((path) => { (window as any).__rapidSource = new EventSource(path); }, `/api/runs/${runId}/events?after=0`);
      await rapid.close();
      await expect.poll(async () => (await (await request.get('/__e2e__/run-workspace-diagnostics')).json()).totalStreams).toBe(baseline.totalStreams);

      const browserStreamCount = Math.min(2, value.capacity.perRun);
      for (let index = 0; index < browserStreamCount; index += 1) {
        const tab = await context.newPage();
        tabs.push(tab);
        await tab.goto('/');
        await tab.evaluate((path) => new Promise<void>((resolve, reject) => {
          const source = new EventSource(path);
          (window as any).__capacitySource = source;
          source.addEventListener('open', () => resolve(), { once: true });
          source.addEventListener('error', () => reject(new Error('Capacity fixture stream failed before opening.')), { once: true });
        }), `/api/runs/${runId}/events?after=0`);
      }
      const baseURL = process.env.PORTAL_E2E_BASE_URL;
      expect(baseURL, 'The focused portal runner must provide its base URL.').toBeTruthy();
      for (let index = browserStreamCount; index < value.capacity.perRun; index += 1) {
        heldStreams.push(await holdEventStream(`${baseURL}/api/runs/${runId}/events?after=0`));
      }
      await expect.poll(async () => (await (await request.get('/__e2e__/run-workspace-diagnostics')).json()).totalStreams)
        .toBe(baseline.totalStreams + value.capacity.perRun);
      const refused = await request.get(`/api/runs/${runId}/events?after=0`);
      expect(refused.status()).toBe(429);
      expect(await refused.text()).toContain('bounded snapshot');
      const refusedDiagnostics = await (await request.get('/__e2e__/run-workspace-diagnostics')).json();
      expect(refusedDiagnostics.refused).toBeGreaterThan(baseline.refused);
    } finally {
      await Promise.all(tabs.map((tab) => tab.close()));
      for (const stream of heldStreams) {
        stream.response.destroy();
        stream.request.destroy();
      }
      await expect.poll(async () => (await (await request.get('/__e2e__/run-workspace-diagnostics')).json()).totalStreams)
        .toBe(value.totalStreams);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
