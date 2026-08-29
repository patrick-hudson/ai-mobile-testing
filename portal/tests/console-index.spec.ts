import { expect, test, type Page, type Route } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

type RouteId = 'overview' | 'runs' | 'attention' | 'evidence';

function record(recordType: 'run' | 'risk' | 'attention' | 'evidence' | 'trust' | 'metric', id: string, fields: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    mode: 'comparative',
    runId: recordType === 'run' ? id : 'run-1',
    recordId: recordType === 'run' ? 'run' : id,
    recordType,
    scopeKey: 'release',
    sourceId: 'fixture-source',
    sourceRevision: 'revision-1',
    sourceUpdatedAt: '2026-08-26T12:00:00.000Z',
    complete: true,
    sortKey: `2026-08-26T12:00:00.000Z:${id}`,
    fields: {
      title: id,
      updatedAt: '2026-08-26T12:00:00.000Z',
      sourceTimestamp: '2026-08-26T12:00:00.000Z',
      destinations: [`/run.html?mode=comparative&run=${recordType === 'run' ? id : 'run-1'}`],
      ...fields,
    },
  };
}

function response(routeId: RouteId, items: ReturnType<typeof record>[], { complete = true, cursor = null as string | null } = {}) {
  return {
    schemaVersion: 1,
    apiVersion: 'v1',
    routeId,
    query: { mode: 'all', scopeKey: 'all', sort: routeId === 'runs' ? 'recent' : 'attention', filters: {}, limit: 50, normalizedFilterKey: '{}' },
    sourceVector: {
      schemaVersion: 1,
      vectorRevision: 'vector-1',
      indexRevision: 'index-1',
      complete,
      sources: [{ sourceId: 'fixture-source', revision: 'revision-1', updatedAt: '2026-08-26T12:00:00.000Z', complete }],
    },
    complete,
    freshness: complete ? 'current' : 'stale',
    limitations: complete ? [] : [{ sourceId: 'fixture-source', code: 'source-stale' }],
    work: { recordsRead: items.length, sourceFilesRead: 0, sourceBytesRead: 0, elapsedMs: 1, budgetExhausted: false, indexReads: 1, assemblyAttempts: 1 },
    capabilities: { schemaVersion: 1, items: [] },
    data: { items, nextCursor: cursor, hasMore: cursor !== null, omittedRecords: 0, cursorBinding: {} },
  };
}

async function fulfillIndex(route: Route, factory: (routeId: RouteId, url: URL) => ReturnType<typeof response>) {
  const url = new URL(route.request().url());
  const routeId: RouteId = url.pathname.endsWith('/overview') ? 'overview'
    : url.pathname.endsWith('/runs') ? 'runs'
      : url.pathname.endsWith('/attention') ? 'attention' : 'evidence';
  await route.fulfill({ status: 200, json: factory(routeId, url) });
}

test.describe('bounded console index surfaces', () => {
  test('new URL filters abort and supersede an older index response', async ({ page }) => {
    let releaseSlow: () => void = () => undefined;
    let reads = 0;
    await page.route('**/api/console/v1/runs?*', async (route) => {
      reads += 1;
      const url = new URL(route.request().url());
      if (url.searchParams.get('mode') === 'all') {
        await new Promise<void>((resolve) => { releaseSlow = resolve; });
        await route.fulfill({ status: 200, json: response('runs', [record('run', 'slow-run')]) }).catch(() => undefined);
        return;
      }
      await route.fulfill({ status: 200, json: response('runs', [record('run', 'current-run')]) });
    });
    await page.goto('/runs.html');
    await expect.poll(() => reads).toBe(1);
    await page.getByLabel('Audit mode').selectOption('comparative');
    await expect(page.getByRole('button', { name: 'current-run' })).toBeVisible();
    releaseSlow();
    await expect(page.getByRole('button', { name: 'slow-run' })).toHaveCount(0);
    expect(reads).toBe(2);
  });

  test('refresh failure keeps sourced rows visible and reports stale data', async ({ page }) => {
    let reads = 0;
    await page.route('**/api/console/v1/runs?*', async (route) => {
      reads += 1;
      if (reads === 1) {
        await route.fulfill({ status: 200, json: response('runs', [record('run', 'retained-run')]) });
        return;
      }
      await route.fulfill({
        status: 503,
        json: { error: { code: 'CONSOLE_SOURCE_BUSY', message: 'The source is rebuilding.' } },
      });
    });
    await page.goto('/runs.html');
    await expect(page.getByRole('button', { name: 'retained-run' })).toBeVisible();
    await page.getByLabel('Audit mode').selectOption('comparative');
    await expect(page.locator('#runs-index')).toHaveAttribute('data-async-state', 'stale');
    await expect(page.locator('#runs-index')).toContainText('Showing the last known data');
    await expect(page.getByRole('button', { name: 'retained-run' })).toBeVisible();
    await expect(page.locator('#runs-index [data-async-retry]')).toBeVisible();
    expect(reads).toBe(2);
  });

  test('Runs automatically reconciles an active lifecycle row with current authority', async ({ page }) => {
    let reads = 0;
    await page.route('**/api/console/v1/runs?*', async (route) => {
      reads += 1;
      await route.fulfill({
        status: 200,
        json: response('runs', reads === 1 ? [record('run', 'stale-active-run', {
          executionState: 'running', activityState: 'unavailable', phase: 'browser', terminal: false,
        })] : []),
      });
    });

    await page.goto('/runs.html');
    await expect(page.getByRole('button', { name: 'stale-active-run' })).toBeVisible();
    await expect.poll(() => reads, { timeout: 7_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByRole('button', { name: 'stale-active-run' })).toHaveCount(0);
    await expect(page.locator('#runs-index')).toContainText('No indexed runs match these filters.');
  });

  test('stale continuation cursor restarts from the first bounded page', async ({ page }) => {
    const apiUrls: string[] = [];
    let reads = 0;
    await page.route('**/api/console/v1/runs?*', async (route) => {
      reads += 1;
      const url = new URL(route.request().url());
      apiUrls.push(url.toString());
      if (reads === 1) {
        await route.fulfill({ status: 200, json: response('runs', [record('run', 'first-page')], { cursor: 'cursor_1' }) });
        return;
      }
      if (reads === 2) {
        await route.fulfill({
          status: 409,
          json: { error: { code: 'CONSOLE_CURSOR_STALE', message: 'The index revision changed.' } },
        });
        return;
      }
      await route.fulfill({ status: 200, json: response('runs', [record('run', 'restarted-page')]) });
    });
    await page.goto('/runs.html');
    await page.getByRole('button', { name: 'Load next page' }).click();
    await expect(page.getByRole('button', { name: 'restarted-page' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'first-page' })).toHaveCount(0);
    expect(apiUrls).toHaveLength(3);
    expect(new URL(apiUrls[0]!).searchParams.has('cursor')).toBe(false);
    expect(new URL(apiUrls[1]!).searchParams.get('cursor')).toBe('cursor_1');
    expect(new URL(apiUrls[2]!).searchParams.has('cursor')).toBe(false);
  });

  test('permission failures remain distinct from retryable transport failures', async ({ page }) => {
    await page.route('**/api/console/v1/runs?*', (route) => route.fulfill({
      status: 403,
      json: { error: { code: 'CONSOLE_PERMISSION_REQUIRED', message: 'Operator access is required.' } },
    }));
    await page.goto('/runs.html');
    await expect(page.locator('#runs-index')).toHaveAttribute('data-async-state', 'permission-denied');
    await expect(page.locator('#runs-index')).toContainText('Permission is required');
    await expect(page.locator('#runs-index [data-async-retry]')).toBeHidden();
  });

  test('Runs canonicalizes URL state, keeps selection addressable, and replaces bounded pages', async ({ page }) => {
    const apiUrls: string[] = [];
    await page.route('**/api/console/v1/**', (route) => fulfillIndex(route, (routeId, url) => {
      apiUrls.push(url.toString());
      return url.searchParams.has('cursor')
        ? response(routeId, [record('run', 'run-2', { executionState: 'completed', phase: 'review', outcome: 'ready', terminal: true })])
        : response(routeId, [record('run', 'run-1', { executionState: 'running', phase: 'browser', terminal: false })], { cursor: 'cursor_1' });
    }));
    await page.goto('/runs.html?mode=comparative&run=excluded-run&inspector=open&unknown=discard#unsafe');
    await expect(page.getByRole('heading', { name: 'Runs', exact: true, level: 1 })).toBeVisible();
    expect(new URL(page.url()).searchParams.has('unknown')).toBe(false);
    expect(new URL(page.url()).hash).toBe('');
    await expect(page.getByRole('heading', { name: 'Selection outside this page' })).toBeVisible();
    await page.getByRole('button', { name: 'run-1' }).click();
    expect(new URL(page.url()).searchParams.get('run')).toBe('run-1');
    await expect(page.locator('#console-inspector')).toContainText('Pipeline integrity');
    await page.getByRole('button', { name: 'Load next page' }).click();
    await expect(page.getByRole('button', { name: 'run-2' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'run-1' })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);
    expect(apiUrls).toHaveLength(2);
    expect(new URL(apiUrls[0]!).searchParams.has('cursor')).toBe(false);
    expect(new URL(apiUrls[1]!).searchParams.get('cursor')).toBe('cursor_1');
  });

  test('global text and suite filters execute through one bounded API request', async ({ page }) => {
    let reads = 0;
    let requestedUrl = '';
    await page.route('**/api/console/v1/**', (route) => {
      reads += 1;
      requestedUrl = route.request().url();
      return fulfillIndex(route, (routeId) => response(routeId, [record('risk', 'login-risk', { title: 'Login failure', attentionKind: 'finding', areas: ['core'] })]));
    });
    await page.goto('/findings.html?q=login&suite=core&sort=risk');
    await expect(page.getByRole('button', { name: 'Login failure' })).toBeVisible();
    expect(reads).toBe(1);
    expect(new URL(requestedUrl).searchParams.get('q')).toBe('login');
    expect(new URL(requestedUrl).searchParams.get('suite')).toBe('core');
    expect(new URL(page.url()).searchParams.get('q')).toBe('login');
  });

  test('Evidence requests only the selected contained media and preserves metadata context', async ({ page }) => {
    let mediaRequests = 0;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await page.route('**/artifacts/**', async (route) => {
      mediaRequests += 1;
      await route.fulfill({ status: 200, contentType: 'image/png', body: png });
    });
    await page.route('**/api/console/v1/**', (route) => fulfillIndex(route, (routeId) => response(routeId, [
      record('evidence', 'evidence-1', { sourceKind: 'screenshot', evidenceId: 'evidence-1', stageId: 'browser', attemptNumber: 1, mediaQualityState: 'available', destinations: ['/artifacts/run-1/checklist/evidence-1.png'] }),
      record('evidence', 'evidence-2', { sourceKind: 'screenshot', evidenceId: 'evidence-2', stageId: 'accessibility', attemptNumber: 1, mediaQualityState: 'attention', destinations: ['/artifacts/another-run/checklist/evidence-2.png'] }),
    ])));
    await page.goto('/evidence.html');
    await expect(page.getByRole('button', { name: 'evidence-1' })).toBeVisible();
    await expect(page.locator('img, video, iframe')).toHaveCount(0);
    expect(mediaRequests).toBe(0);
    await page.getByRole('button', { name: 'evidence-1' }).click();
    await expect(page.locator('.evidence-selected-media img')).toHaveAttribute('src', '/artifacts/run-1/checklist/evidence-1.png');
    await expect.poll(() => mediaRequests).toBe(1);
    expect(new URL(page.url()).searchParams.get('item')).toBe('evidence-1');
    await page.getByRole('button', { name: 'evidence-2' }).click();
    await expect(page.locator('.evidence-selected-media')).toContainText('unavailable');
    await expect(page.locator('.evidence-selected-media img, .evidence-selected-media video')).toHaveCount(0);
    expect(mediaRequests).toBe(1);
  });

  test('purge invalidation removes retained rows, URL selection, and selected media before refresh settles', async ({ page }) => {
    let reads = 0;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    await page.route('**/artifacts/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
    await page.route('**/api/console/v1/evidence?*', (route) => {
      reads += 1;
      return fulfillIndex(route, (routeId) => response(routeId, reads === 1 ? [
        record('evidence', 'purge-evidence', { sourceKind: 'screenshot', evidenceId: 'purge-evidence', status: 'available', destinations: ['/artifacts/run-1/checklist/purge.png'] }),
      ] : []));
    });
    await page.goto('/evidence.html?mode=comparative');
    await page.getByRole('button', { name: 'purge-evidence' }).click();
    await expect(page.locator('.evidence-selected-media img')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('audit-console:run-invalidated', { detail: {
      schemaVersion: 1, mode: 'comparative', runId: 'run-1', reason: 'purged', occurredAt: new Date().toISOString(),
    } })));
    await expect(page.locator('.evidence-selected-media img, .evidence-selected-media video')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'purge-evidence' })).toHaveCount(0);
    await expect.poll(() => reads).toBe(2);
    expect(new URL(page.url()).searchParams.has('item')).toBe(false);
    expect(new URL(page.url()).searchParams.get('inspector')).not.toBe('open');
  });

  test('dense Overview keeps Product Risk dominant and all four primary regions in the initial desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const denseItems = [
      ...Array.from({ length: 12 }, (_, index) => record('risk', `risk-${index}`, { title: `Risk ${index}`, severity: index === 0 ? 'P0' : 'P2', blocking: index < 2, attentionKind: 'finding', novelty: 'new', affectedScope: index + 1, unresolvedAt: '2026-08-25T12:00:00.000Z' })),
      ...['coverage', 'evidence', 'pipeline', 'finalization', 'manual', 'freshness'].map((name) => ({ ...record('trust', `trust-${name}`, { title: name, status: name === 'pipeline' ? 'failed' : 'complete' }), runId: 'run-terminal' })),
      record('run', 'run-active', { executionState: 'running', activityState: 'normal', phase: 'browser', terminal: false, startedAt: '2026-08-26T11:00:00.000Z', progressCompleted: 14, progressTotal: 40, findingCount: 2, scopeLabel: 'release' }),
      record('run', 'run-terminal', { executionState: 'completed', terminal: true, outcome: 'ready', finishedAt: '2026-08-26T12:00:00.000Z', coverageStatus: 'complete', evidenceAuthorityStatus: 'authoritative', pipelineIntegrityStatus: 'complete', finalizationStatus: 'complete' }),
    ];
    await page.route('**/api/console/v1/**', (route) => fulfillIndex(route, (routeId) => response(routeId, denseItems)));
    await page.goto('/?mode=comparative');
    await expect(page.getByRole('heading', { name: 'Product Risk' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Run Trust' })).toBeVisible();
    const boxes = await page.locator('#overview-risk, #overview-trust').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
    expect(boxes[0].width).toBeGreaterThan(boxes[1].width);
    const initialRegions = await page.locator('#overview-risk, #overview-trust, #overview-active-runs, #overview-latest').evaluateAll((nodes) => nodes.map((node) => {
      const bounds = node.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, width: bounds.width };
    }));
    for (const bounds of initialRegions) {
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(900);
      expect(bounds.width).toBeGreaterThan(250);
    }
    const accessibility = await new AxeBuilder({ page }).include('#overview-console').analyze();
    expect(accessibility.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')).toEqual([]);
  });

  test('Overview no-attention wording is factual rather than a pass verdict', async ({ page }) => {
    await page.route('**/api/console/v1/**', (route) => fulfillIndex(route, (routeId) => response(routeId, [
      record('run', 'run-active', { executionState: 'running', activityState: 'normal', terminal: false }),
      record('run', 'run-terminal', { executionState: 'completed', terminal: true, outcome: 'ready', finishedAt: '2026-08-26T12:00:00.000Z' }),
    ])));
    await page.goto('/?mode=comparative');
    await expect(page.locator('#overview-risk')).toContainText('not a pass verdict');
    await expect(page.locator('#overview-active-runs')).toContainText('run-active');
    await expect(page.locator('#overview-latest')).toContainText('run-terminal');
  });

  test('Overview presents a P0 queue item and pipeline failure as separate sourced facts', async ({ page }) => {
    await page.route('**/api/console/v1/**', (route) => fulfillIndex(route, (routeId) => response(routeId, [
      record('risk', 'risk-p0', { title: 'Checkout unavailable', severity: 'P0', blocking: true, novelty: 'new', affectedScope: 'checkout' }),
      record('run', 'run-terminal', { terminal: true, finishedAt: '2026-08-26T12:00:00.000Z' }),
      { ...record('trust', 'trust-pipeline', { title: 'Pipeline integrity', status: 'failed', pipelineIntegrityStatus: 'failed' }), runId: 'run-terminal' },
      { ...record('trust', 'trust-finalization', { title: 'Finalization', status: 'incomplete', finalizationStatus: 'incomplete' }), runId: 'run-terminal' },
    ])));
    await page.goto('/?mode=comparative');
    await expect(page.locator('#overview-risk')).toContainText('Checkout unavailable');
    await expect(page.locator('#overview-risk')).toContainText('P0 · blocking · new · checkout');
    await expect(page.locator('#overview-trust')).toContainText('failed · conclusion unavailable');
    await expect(page.locator('#overview-trust')).toContainText('incomplete · limited conclusion');
  });
});
