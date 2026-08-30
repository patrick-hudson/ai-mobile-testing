import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { access, mkdir, open, readFile, readdir, readlink, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial' });

const terminalStatuses = new Set([
  'passed',
  'not-ready',
  'review-required',
  'failed',
  'evidence-failed',
  'stopped',
  'spawn-failed',
]);

const targets = {
  productionUrl: 'https://quitting7oh.org',
  candidateUrl: 'https://beta.quitting7oh-org.pages.dev',
};

async function waitForTerminal(request: APIRequestContext, id: string, timeoutMs = 210_000): Promise<Record<string, any>> {
  const started = Date.now();
  let latest: Record<string, any> | null = null;
  while (Date.now() - started < timeoutMs) {
    const response = await request.get(`/api/runs/${encodeURIComponent(id)}`);
    expect(response.ok(), await response.text()).toBeTruthy();
    latest = await response.json();
    if (latest && terminalStatuses.has(String(latest.status))) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Run ${id} did not reach a terminal state. Last status: ${latest?.status ?? 'unknown'}`);
}

function runRequest(overrides: Record<string, unknown> = {}) {
  return {
    profile: 'release',
    targetIds: ['candidate-mobile-chromium'],
    pluginIds: [],
    areas: [],
    auditIds: ['ENV-001'],
    ...targets,
    candidateIgnoreHTTPSErrors: false,
    aiReview: false,
    aiModel: 'claude-sonnet-5',
    ...overrides,
  };
}

function runWorkspaceSummary(
  mode: 'comparative' | 'single-site',
  runId: string,
  {
    sourceRevision,
    executionState = 'running',
    activityState = 'collecting-evidence',
    terminal = false,
    finalizationStatus = mode === 'single-site' ? 'pending' : null,
  }: {
    sourceRevision: string;
    executionState?: string;
    activityState?: string;
    terminal?: boolean;
    finalizationStatus?: string | null;
  },
) {
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
        identity: { mode, runId },
        contextId: `${mode}-live`,
        authorityRevision: 'authority-1',
        actions: [],
      }],
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
        sourceRevision,
        sourceUpdatedAt: '2026-08-25T12:03:00.000Z',
        complete: true,
        sortKey: 'recent:1',
        fields: {
          executionState,
          activityState,
          phase: 'browser-checks',
          terminal,
          progressTotal: 1,
          progressCompleted: terminal ? 1 : 0,
          outcome: null,
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

async function countOpenPortalStyleDescriptors(pid: number) {
  const directory = `/proc/${pid}/fd`;
  const descriptors = await readdir(directory);
  const targets = await Promise.all(descriptors.map((descriptor) =>
    readlink(join(directory, descriptor)).catch(() => '')));
  return targets.filter((target) => target.endsWith('/portal/public/styles.css')).length;
}

function acceptedSingleSitePreview(runContract: Record<string, any>, digestCharacter = 'a') {
  const normalizedRunContract = {
    schemaVersion: runContract.schemaVersion,
    mode: runContract.mode,
    targetIds: [...runContract.targetIds],
    scope: {
      qualifier: runContract.scope.qualifier,
      pluginIds: [...runContract.scope.pluginIds],
      auditIds: [...runContract.scope.auditIds],
      areas: [...runContract.scope.areas],
    },
    url: runContract.url,
    deploymentRole: runContract.deploymentRole,
    certificatePolicy: runContract.certificatePolicy,
  };
  const coverage = {
    scope: {
      qualifier: runContract.scope.qualifier,
      requestedQualifier: runContract.scope.qualifier,
      filters: {
        pluginIds: runContract.scope.pluginIds,
        auditIds: runContract.scope.auditIds,
        areas: runContract.scope.areas,
      },
      selectedTargetIds: runContract.targetIds,
    },
    coverageStatus: 'COMPLETE',
    coverageGaps: [],
    omissions: { definitions: [], cases: [], targets: [] },
    outsideMode: [],
    counts: {
      selectedDefinitions: 1,
      executableCases: 1,
      plannedExecutions: runContract.targetIds.length,
      manualDefinitions: 0,
      coverageGaps: 0,
      omittedDefinitions: 0,
      outsideModeDefinitions: 0,
    },
  };
  return {
    schemaVersion: 1,
    mode: 'single-site',
    accepted: true,
    runContract: normalizedRunContract,
    previewDigest: `sha256:${digestCharacter.repeat(64)}`,
    coverage,
    preflight: { evidenceAuthority: { status: 'authoritative', reasons: [] }, issues: [] },
  };
}

function rejectedSingleSitePreview(message = 'The selected deployment role does not match this site.') {
  return {
    schemaVersion: 1,
    mode: 'single-site',
    accepted: false,
    preflight: {
      evidenceAuthority: { status: 'non-authoritative', reasons: ['preflight-rejected'] },
      issues: [{ code: 'PREFLIGHT_DEPLOYMENT_ROLE_MISMATCH', message, focusTarget: 'deploymentRole' }],
    },
  };
}

test('console-shell: direct entry, bounded history, and stale async requests preserve canonical safe state', async ({ page, request }) => {
  const fixtureResponse = await request.get('/console-shell-fixture.html');
  expect(fixtureResponse.status()).toBe(200);
  expect(fixtureResponse.headers()['content-security-policy']).toContain("script-src 'self'");
  const contractResponse = await request.get('/__e2e__/console-contracts.mjs');
  expect(contractResponse.status()).toBe(200);
  expect(contractResponse.headers()['content-type']).toContain('text/javascript');
  const portalBaseUrl = process.env.PORTAL_E2E_BASE_URL!;
  expect((await request.get(`${portalBaseUrl}/%2Fconsole-shell-fixture.html`)).status()).toBe(404);

  const externalRequests: string[] = [];
  const apiRequests: string[] = [];
  page.on('request', (event) => {
    const url = new URL(event.url());
    if (url.origin !== new URL(portalBaseUrl).origin) externalRequests.push(event.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname);
  });
  await page.goto('/console-shell-fixture.html?run=fixture-alpha&inspector=open&sort=risk&unknown=discard-me#unsafe');
  await expect(page.getByRole('heading', { name: 'Operations workspace' })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has('unknown')).toBe(false);
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.locator('#fixture-results')).toHaveAttribute('data-async-state', 'ready');
  await expect(page.locator('#fixture-results')).toContainText('fixture-alpha');

  await page.getByRole('link', { name: 'Shell fixture' }).click();
  await expect(page.getByRole('heading', { name: 'Operations workspace' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('?inspector=closed&mode=all&sort=recent');
  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBe('fixture-alpha');
  await expect(page.locator('#fixture-results')).toContainText('fixture-alpha');

  const historyLengthBeforePushes = await page.evaluate(() => history.length);
  // Dispatch both user-visible selections in the same browser task. Awaiting
  // two separate Playwright clicks lets a heavily loaded CI host finish the
  // synthetic alpha request between protocol round trips, which stops this
  // characterization from exercising supersession at all.
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('#fixture-alpha')?.click();
    document.querySelector<HTMLButtonElement>('#fixture-beta')?.click();
  });
  await expect(page.locator('#fixture-results')).toHaveAttribute('data-async-state', 'ready');
  await expect(page.locator('#fixture-results')).toContainText('fixture-beta');
  await expect(page.locator('#fixture-results')).not.toContainText('Needs review');
  await expect.poll(async () => Number(await page.locator('#fixture-abort-count').textContent())).toBeGreaterThan(0);

  await page.goBack();
  await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBe('fixture-alpha');
  await expect(page.locator('#fixture-results')).toContainText('fixture-alpha');
  await expect(page.locator('#fixture-alpha')).toBeFocused();
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBe('fixture-beta');
  await expect(page.locator('#fixture-results')).toContainText('fixture-beta');
  await expect(page.locator('#fixture-beta')).toBeFocused();
  for (let index = 0; index < 12; index += 1) {
    await page.locator(index % 2 === 0 ? '#fixture-alpha' : '#fixture-beta').click();
  }
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(historyLengthBeforePushes + 8);
  await page.reload();
  await expect(page.locator('#fixture-results')).toContainText('fixture-beta');

  await page.locator('#fixture-refresh-failure').click();
  await expect(page.locator('#fixture-results')).toHaveAttribute('data-async-state', 'stale');
  await expect(page.locator('#fixture-results')).toContainText('fixture-beta');
  await page.locator('[data-async-retry]').click();
  await expect(page.locator('#fixture-results')).toHaveAttribute('data-async-state', 'ready');

  for (const hostileSearch of [
    'run=fixture-alpha&run=fixture-beta',
    'cursor=unbound-cursor',
    'run=%252e%252e%252foutside',
    `q=sk-ant-${'a'.repeat(32)}`,
    '__proto__=polluted',
    `q=${'x'.repeat(4_200)}`,
  ]) {
    await page.goto(`/console-shell-fixture.html?${hostileSearch}`);
    await expect(page.getByRole('heading', { name: 'Operations workspace' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/console-shell-fixture.html');
    expect(page.url()).not.toContain('outside');
  }
  expect(externalRequests).toEqual([]);
  expect(apiRequests).toEqual([]);
});

test('console-shell: saved views discard hostile records atomically and survive storage denial in memory', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('audit-console.saved-views.v1', JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          schemaVersion: 1,
          id: 'valid-view',
          name: 'Valid review view',
          routeId: 'runs',
          parameters: { run: 'fixture-alpha', inspector: 'open', sort: 'recent', mode: 'all' },
          layout: { inspectorWidth: 336 },
          updatedAt: '2026-08-26T12:00:00.000Z',
        },
        JSON.parse('{"schemaVersion":1,"id":"hostile","name":"Hostile","routeId":"runs","parameters":{"__proto__":"polluted"},"layout":{},"updatedAt":"2026-08-26T12:00:00.000Z"}'),
        {
          schemaVersion: 0,
          id: 'stale-view',
          name: 'Stale view',
          routeId: 'runs',
          parameters: { run: 'fixture-beta' },
          layout: {},
          updatedAt: '2026-08-26T12:00:00.000Z',
        },
      ],
    }));
  });
  await page.goto('/console-shell-fixture.html?run=fixture-alpha');
  await expect(page.locator('#fixture-storage-status')).toHaveText('1 valid saved views loaded.');
  expect(await page.evaluate(() => ({} as Record<string, unknown>).polluted)).toBeUndefined();

  const portalBaseUrl = process.env.PORTAL_E2E_BASE_URL;
  const storageState = process.env.PORTAL_E2E_STORAGE_STATE;
  expect(portalBaseUrl).toBeTruthy();
  expect(storageState).toBeTruthy();
  const denied = await page.context().browser()!.newContext({
    baseURL: portalBaseUrl!,
    storageState: storageState!,
  });
  await denied.addInitScript(() => {
    for (const method of ['getItem', 'setItem', 'removeItem'] as const) {
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        value() { throw new DOMException('Storage denied by fixture.', 'SecurityError'); },
      });
    }
  });
  const deniedPage = await denied.newPage();
  await deniedPage.goto('/console-shell-fixture.html?run=fixture-beta');
  await deniedPage.locator('#fixture-save-view').click();
  await expect(deniedPage.locator('#fixture-storage-status')).toContainText('saved in memory');
  await deniedPage.locator('#fixture-alpha').click();
  await deniedPage.locator('#fixture-restore-view').click();
  await expect.poll(() => new URL(deniedPage.url()).searchParams.get('run')).toBe('fixture-beta');
  await expect(deniedPage.locator('#fixture-results')).toContainText('fixture-beta');
  await denied.close();
});

test('console-shell: connection loss freezes durable execution state until an authoritative update', async ({ page }) => {
  await page.goto('/console-shell-fixture.html?run=fixture-alpha');
  await page.locator('#fixture-connected').click();
  await page.locator('#fixture-server-update').click();
  await expect(page.locator('#fixture-execution')).toHaveText('Completed');
  await expect(page.locator('#fixture-activity')).toHaveText('Awaiting review');
  await expect(page.locator('#fixture-freshness')).toContainText('Current at');

  await page.locator('#fixture-reconnect').click();
  await expect(page.locator('#fixture-connection-detail')).toHaveText('reconnecting');
  await expect(page.locator('#fixture-freshness')).toContainText('durable values frozen');
  await expect(page.locator('#fixture-execution')).toHaveText('Completed');
  await expect(page.locator('#fixture-activity')).toHaveText('Awaiting review');
  await page.locator('#fixture-offline').click();
  await expect(page.locator('#fixture-connection-detail')).toHaveText('offline');
  await expect(page.locator('#fixture-execution')).toHaveText('Completed');
});

test('console-shell: keyboard focus, splitter, responsive layout, axe, and reduced motion remain usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/console-shell-fixture.html?run=fixture-alpha');
  await expect(page.locator('#fixture-results')).toHaveAttribute('data-async-state', 'ready');

  const summaryTab = page.getByRole('tab', { name: 'Summary' });
  const evidenceTab = page.getByRole('tab', { name: 'Evidence' });
  await summaryTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(evidenceTab).toBeFocused();
  await expect(summaryTab).toHaveAttribute('aria-selected', 'true');
  await expect(evidenceTab).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('Enter');
  await expect(evidenceTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Evidence' })).toContainText('bounded fixture adapter');

  await page.locator('#fixture-open-dialog').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Confirm fixture action' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Confirm fixture action' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#fixture-open-dialog')).toBeFocused();

  const separator = page.getByRole('separator', { name: 'Resize inspector' });
  await separator.focus();
  const widthBefore = Number(await separator.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', String(widthBefore + 16));
  const separatorBox = await separator.boundingBox();
  expect(separatorBox).toBeTruthy();
  await page.mouse.move(separatorBox!.x + (separatorBox!.width / 2), separatorBox!.y + 60);
  await page.mouse.down();
  await page.mouse.move(separatorBox!.x - 32, separatorBox!.y + 60);
  await page.mouse.up();
  const pointerWidth = Number(await separator.getAttribute('aria-valuenow'));
  expect(pointerWidth).toBeGreaterThan(widthBefore + 16);
  await page.reload();
  await expect(separator).toHaveAttribute('aria-valuenow', String(pointerWidth));

  for (const width of [1280, 1440, 1920, 480]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth })))
      .toEqual({ viewport: width, content: width });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#fixture-alpha').click();
  const animationDuration = await page.locator('[data-async-content]').evaluate((node) => Number.parseFloat(getComputedStyle(node).animationDuration));
  expect(animationDuration).toBeLessThanOrEqual(0.001);
  await expect(page.locator('[data-async-status]')).not.toHaveText('');

  const accessibility = await new AxeBuilder({ page }).include('#console-shell-fixture').analyze();
  expect(accessibility.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')).toEqual([]);
});

test('u4: Runs owns the bounded asynchronous run index after the root Overview cutover', async ({ page }) => {
  let releaseRuns!: () => void;
  const runsGate = new Promise<void>((resolve) => { releaseRuns = resolve; });
  let runsRequestUrl = '';
  await page.route('**/api/console/v1/runs?*', async (route) => {
    runsRequestUrl = route.request().url();
    await runsGate;
    return route.continue();
  });
  await page.goto('/runs.html');
  await expect(page.getByRole('heading', { name: 'Runs', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New audit' })).toHaveAttribute('href', '/new-audit.html');
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings.html');
  await expect(page.locator('#launch-form')).toHaveCount(0);
  await expect(page.locator('#anthropic-key-settings')).toHaveCount(0);
  await expect(page.locator('#runs-index')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#refresh-runs')).toHaveCount(0);
  releaseRuns();
  await expect(page.locator('#runs-index')).toHaveAttribute('aria-busy', 'false');
  expect(new URL(runsRequestUrl).pathname).toBe('/api/console/v1/runs');
  expect(new URL(runsRequestUrl).searchParams.get('limit')).toBe('50');
});

test('u5: New Audit owns the full launch catalog behind progressive advanced controls', async ({ page }) => {
  await page.goto('/new-audit.html');
  await expect(page.getByRole('heading', { name: 'Configure an audit' })).toBeVisible();
  await expect(page.locator('#catalog-summary')).toContainText('183 documented checks');
  await expect(page.locator('#advanced-audit-options')).not.toHaveAttribute('open', '');
  await expect(page.locator('#project-options input[name="targetId"]')).toHaveCount(18);
  await expect(page.locator('#project-options input[name="targetId"]:checked')).toHaveCount(7);
  await expect(page.locator('#project-options input[name="targetId"]:disabled')).toHaveCount(5);
  await expect(page.locator('#plugin-options input')).toHaveCount(5);
  await expect(page.locator('#audit-options input')).toHaveCount(183);
  await expect(page.locator('#launch-form')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('link[href="/styles.css"]')).toHaveCount(0);
});

test('u5: comparative launch submits the exact legacy contract then navigates without opening a modal', async ({ page }) => {
  const runId = 'u5-comparative-run';
  let submitted: Record<string, any> | null = null;
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    submitted = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { id: runId } });
  });

  await page.goto('/new-audit.html?mode=comparative');
  const targetIds = await page.locator('#project-options input[name="targetId"]:checked')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  const aiModel = await page.locator('#ai-model').inputValue();
  await page.locator('#launch-run').click();
  await page.waitForURL((url) => url.pathname === '/run.html' && url.searchParams.get('run') === runId);

  expect(submitted).toEqual({
    profile: 'smoke',
    targetIds,
    pluginIds: [],
    areas: [],
    auditIds: [],
    productionUrl: targets.productionUrl,
    candidateUrl: targets.candidateUrl,
    candidateIgnoreHTTPSErrors: false,
    aiReview: false,
    aiModel,
  });
  const runUrl = new URL(page.url());
  expect(runUrl.searchParams.get('mode')).toBe('comparative');
  expect(runUrl.searchParams.get('view')).toBe('overview');
  expect(runUrl.searchParams.get('inspector')).toBe('closed');
});

test('u5: Settings sections use bounded read-only runtime data and canonical section history', async ({ page }) => {
  let baselineReads = 0;
  let baselineMutations = 0;
  await page.route('**/api/single-site/visual-baselines?*', async (route) => {
    if (route.request().method() !== 'GET') {
      baselineMutations += 1;
      return route.fulfill({ status: 500, json: { error: 'Settings must not mutate baselines.' } });
    }
    baselineReads += 1;
    const url = new URL(route.request().url());
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('limit')).toBe('50');
    return route.fulfill({ json: { schemaVersion: 1, items: [], total: 0, offset: 0, limit: 50, storeRevision: 3, historyDigest: `sha256:${'a'.repeat(64)}` } });
  });

  await page.goto('/settings.html?section=test-catalog');
  await expect(page.locator('#settings-test-catalog')).toContainText('183');
  await expect(page.locator('#settings-test-catalog tbody tr')).toHaveCount(50);
  await page.getByRole('button', { name: 'Baselines' }).click();
  await expect(page).toHaveURL(/section=baselines/);
  await expect(page.locator('#settings-baselines')).toContainText(/read-only|No visual baseline records/i);
  expect(baselineReads).toBe(1);
  expect(baselineMutations).toBe(0);
  await page.getByRole('button', { name: 'Environments' }).click();
  await expect(page).toHaveURL(/section=environments/);
  await expect(page.locator('#settings-environments')).toContainText(targets.productionUrl);
  await expect(page.locator('#settings-environments')).toContainText(targets.candidateUrl);
  await page.goBack();
  await expect(page.locator('#settings-baselines')).toBeVisible();
  expect(baselineReads).toBe(1);
  await expect(page.locator('link[href="/styles.css"]')).toHaveCount(0);
});

test('u5: Settings reauthorizes inline, replaces a stale credential read, and restores focus', async ({ page }) => {
  let authorized = false;
  let keyReads = 0;
  let releaseFirstKeyRead = () => {};
  const firstKeyReadGate = new Promise<void>((resolve) => { releaseFirstKeyRead = resolve; });
  await page.route('**/api/control/v1/session', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ credential: 'settings-operator-credential' });
      authorized = true;
      await route.fulfill({ status: 200, json: { schemaVersion: 1, data: {
        principal: { id: 'settings-operator', roles: ['operator'] },
        csrfToken: 'settings-csrf',
        idleExpiresAt: '2026-08-30T23:30:00.000Z',
        absoluteExpiresAt: '2026-08-31T07:00:00.000Z',
      } } });
      return;
    }
    await route.fulfill({
      status: authorized ? 200 : 401,
      json: authorized
        ? { schemaVersion: 1, data: { principal: { id: 'settings-operator', roles: ['operator'] }, csrfToken: 'settings-csrf', idleExpiresAt: '2026-08-30T23:30:00.000Z', absoluteExpiresAt: '2026-08-31T07:00:00.000Z' } }
        : { schemaVersion: 1, error: { code: 'SESSION_EXPIRED', message: 'Browser session has expired.' } },
    });
  });
  await page.route('**/api/settings/anthropic-key', async (route) => {
    keyReads += 1;
    if (keyReads === 1) {
      await firstKeyReadGate;
      await route.fulfill({ status: 401, json: { error: 'Browser session has expired.', code: 'SESSION_EXPIRED' } }).catch(() => {});
      return;
    }
    releaseFirstKeyRead();
    await route.fulfill({ json: { configured: false, fingerprint: null, storageEnabled: true, unavailableReason: null } });
  });

  await page.goto('/settings.html?section=credentials');
  const banner = page.locator('[data-console-session-banner]');
  await expect(banner).toBeVisible();
  await expect(page.locator('#system-status')).toHaveText('Shared session expired');
  await expect(page.locator('#console-inspector')).toContainText('Expired — authorization required');
  await expect(page.locator('#console-inspector')).not.toContainText('Authenticated operator session');
  await banner.getByRole('button', { name: 'Authorize' }).click();
  await banner.getByLabel('Operator credential').fill('settings-operator-credential');
  await banner.getByRole('button', { name: 'Unlock console' }).click();
  await expect(page.locator('#anthropic-key-state')).toHaveText('Not configured');
  await expect(page.locator('#system-status')).toHaveText('Shared session active');
  await expect(page.locator('#console-inspector')).toContainText('Authenticated as settings-operator');
  await expect(banner).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeFocused();
  expect(keyReads).toBe(2);
});

test('u5: Settings exposes inline authorization when a later Baselines read expires', async ({ page }) => {
  await page.route('**/api/control/v1/session', (route) => route.fulfill({
    status: 200,
    json: { schemaVersion: 1, data: { principal: { id: 'settings-operator', roles: ['operator'] }, csrfToken: 'settings-csrf', idleExpiresAt: '2026-08-30T23:30:00.000Z', absoluteExpiresAt: '2026-08-31T07:00:00.000Z' } },
  }));
  await page.route('**/api/single-site/visual-baselines?*', (route) => route.fulfill({
    status: 401,
    json: { error: 'Browser session has expired.', code: 'SESSION_EXPIRED' },
  }));

  await page.goto('/settings.html?section=test-catalog');
  await page.getByRole('button', { name: 'Baselines' }).click();
  await expect(page.locator('[data-console-session-banner]')).toBeVisible();
  await expect(page.locator('[data-console-session-banner]')).toContainText('session expired');
});

test('aborted file responses release their owned descriptors immediately', async () => {
  test.skip(process.platform !== 'linux', 'Descriptor accounting uses the Linux process filesystem inside Docker.');
  const portalBaseUrl = process.env.PORTAL_E2E_BASE_URL;
  const portalPid = Number(process.env.PORTAL_E2E_SERVER_PID);
  expect(portalBaseUrl).toBeTruthy();
  expect(Number.isSafeInteger(portalPid) && portalPid > 0).toBeTruthy();
  const baseline = await countOpenPortalStyleDescriptors(portalPid);
  const controllers = Array.from({ length: 16 }, () => new AbortController());
  const requests = controllers.map((controller, index) => fetch(`${portalBaseUrl}/styles.css?abort-proof=${index}`, {
    headers: { 'x-portal-e2e-send-file-delay-ms': '500' },
    signal: controller.signal,
  }).catch(() => null));
  let opened = 0;
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && opened === 0) {
    opened = await countOpenPortalStyleDescriptors(portalPid);
    if (opened === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(opened, 'The failpoint must observe at least one descriptor before clients disconnect.').toBeGreaterThan(0);
  controllers.forEach((controller) => controller.abort());
  await Promise.allSettled(requests);
  const closeDeadline = Date.now() + 1_000;
  let remaining = await countOpenPortalStyleDescriptors(portalPid);
  while (Date.now() < closeDeadline && remaining !== baseline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    remaining = await countOpenPortalStyleDescriptors(portalPid);
  }
  expect(remaining, 'Every aborted response must close its descriptor without waiting for garbage collection.').toBe(baseline);
});

test('u5: single-site mode previews exact coverage and navigates an accepted job to the stable run route', async ({ page }) => {
  const previewDigest = `sha256:${'a'.repeat(64)}`;
  const runContract = {
    schemaVersion: 1,
    mode: 'single-site',
    url: targets.candidateUrl,
    deploymentRole: 'preview',
    certificatePolicy: 'strict',
    targetIds: [
      'single-site-mobile-chromium',
      'single-site-desktop-chromium',
      'single-site-mobile-webkit',
      'single-site-tablet-webkit',
      'single-site-desktop-firefox',
    ],
    scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
  };
  const coverage = {
    scope: {
      qualifier: 'FULL', requestedQualifier: 'FULL', filters: { pluginIds: [], auditIds: [], areas: [] },
      selectedTargetIds: runContract.targetIds,
    },
    coverageStatus: 'COMPLETE',
    coverageGaps: [],
    omissions: { definitions: [], cases: [], targets: [] },
    outsideMode: [{ definitionId: 'CONTENT-008' }],
    counts: {
      selectedDefinitions: 183, executableCases: 192, plannedExecutions: 385,
      manualDefinitions: 2, coverageGaps: 0, omittedDefinitions: 0, outsideModeDefinitions: 1,
    },
  };
  const preview = {
    schemaVersion: 1, mode: 'single-site', accepted: true, runContract, previewDigest, coverage,
    preflight: { evidenceAuthority: { status: 'authoritative', reasons: [] } },
  };
  const job = {
    schemaVersion: 1,
    id: 'job-aaaaaaaaaaaa-bbbbbbbbbbbb',
    mode: 'single-site', status: 'queued', activity: 'normal',
    createdAt: '2026-08-25T12:00:00.000Z', updatedAt: '2026-08-25T12:00:00.000Z',
    url: targets.candidateUrl, deploymentRole: 'preview', certificatePolicy: 'strict',
    scope: { qualifier: 'FULL', requestedQualifier: 'FULL', filters: coverage.scope.filters, selectedTargetIds: runContract.targetIds, omissions: coverage.omissions },
    coverage: { status: 'COMPLETE', counts: coverage.counts, gaps: [], outsideModeCount: 1 },
    evidenceAuthority: { authoritative: true, reasons: [] },
    attempt: { number: 0, id: null, fencingToken: 0, infrastructureRetriesUsed: 0, maxInfrastructureRetries: 1 },
    lease: null, result: null, cancellation: null,
    stageDeadlines: { inventory: '2030-01-01T00:05:00.000Z', browser: '2030-01-01T01:00:00.000Z', finalizer: '2030-01-01T01:30:00.000Z' },
    events: [{ at: '2026-08-25T12:00:00.000Z', executionState: 'queued', activityState: 'normal', message: 'Validated job envelope was durably queued.' }],
    publications: [],
  };
  let launched = false;
  await page.route('**/api/single-site/preflight', (route) => route.fulfill({ status: 200, json: preview }));
  await page.route('**/api/single-site/runs**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname === '/api/single-site/runs') {
      launched = true;
      return route.fulfill({ status: 201, json: { schemaVersion: 1, launched: true, idempotent: false, previewDigest, job } });
    }
    if (route.request().method() === 'GET' && url.pathname === '/api/single-site/runs') {
      return route.fulfill({ json: { schemaVersion: 1, jobs: launched ? [job] : [] } });
    }
    if (route.request().method() === 'GET' && url.pathname === `/api/single-site/runs/${job.id}`) {
      return route.fulfill({ json: job });
    }
    return route.fallback();
  });

  await page.goto('/new-audit.html?mode=single-site');
  await expect(page.locator('#comparative-sites')).toBeHidden();
  await expect(page.locator('#single-site-settings')).toBeVisible();
  const configuredSingleSiteTargetIds = await page.evaluate(async () => {
    const config = await fetch('/api/config').then((response) => response.json());
    return [...config.targets.singleSiteTargets, ...config.targets.providerTargets]
      .map((target: { id: string }) => target.id);
  });
  const renderedSingleSiteTargetIds = await page.locator('#project-options input[name="targetId"]')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  expect(renderedSingleSiteTargetIds).toEqual(configuredSingleSiteTargetIds);
  await expect(page.locator('#project-options input[name="targetId"]:checked')).toHaveCount(5);
  await expect(page.locator('#launch-run')).toBeDisabled();
  await page.getByRole('checkbox', { name: /confirm this is the intended deployment role/i }).check();
  await page.locator('#preview-single-site').click();
  await expect(page.locator('#single-site-preflight-status')).toContainText(/identity accepted/i);
  await expect(page.locator('#single-site-coverage')).toContainText('385');
  await expect(page.locator('#single-site-coverage')).toContainText(/authoritative/i);
  await expect(page.locator('#launch-run')).toBeEnabled();
  await page.locator('#launch-run').click();
  await page.waitForURL((url) => url.pathname === '/run.html' && url.searchParams.get('run') === job.id);
  const runUrl = new URL(page.url());
  expect(runUrl.searchParams.get('mode')).toBe('single-site');
  expect(runUrl.searchParams.get('run')).toBe(job.id);
  expect(runUrl.searchParams.get('view')).toBe('overview');
  expect(runUrl.searchParams.get('inspector')).toBe('closed');
});

test('u5: unauthorized new audits stay locked and can be unlocked without leaving the page', async ({ page }) => {
  const unlockToken = 'portal-browser-unlock-capability';
  let authorized = false;
  let preflightRequests = 0;
  let submittedUnlockToken = '';

  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    return route.fulfill({ response, json: { ...config, operator: { authorized } } });
  });
  await page.route('**/api/operator/session', async (route) => {
    submittedUnlockToken = String(route.request().postDataJSON()?.token ?? '');
    authorized = submittedUnlockToken === unlockToken;
    return route.fulfill({
      status: authorized ? 200 : 403,
      json: authorized
        ? { authorized: true }
        : { error: 'The operator unlock credential is invalid or expired.' },
    });
  });
  await page.route('**/api/single-site/preflight', async (route) => {
    preflightRequests += 1;
    const contract = route.request().postDataJSON();
    return route.fulfill({ status: 200, json: acceptedSingleSitePreview(contract) });
  });

  await page.goto('/new-audit.html?mode=single-site');
  await expect(page.locator('#system-status')).toHaveText('Operator authorization required');
  await expect(page.locator('#operator-access')).toBeVisible();
  await expect(page.locator('#preview-single-site')).toBeDisabled();
  await expect(page.locator('#launch-run')).toBeDisabled();
  expect(preflightRequests).toBe(0);

  await page.locator('#operator-unlock-token').fill(
    `http://127.0.0.1:4173/operator/bootstrap?token=${unlockToken}`,
  );
  await page.locator('#operator-unlock-submit').click();

  expect(submittedUnlockToken).toBe(unlockToken);
  await expect(page.locator('#operator-unlock-token')).toHaveValue('');
  await expect(page.locator('#operator-access')).toBeHidden();
  await expect(page.locator('#system-status')).toHaveText('Operator ready');
  await expect(page.locator('#preview-single-site')).toBeEnabled();

  await page.getByRole('checkbox', { name: /confirm this is the intended deployment role/i }).check();
  await page.locator('#preview-single-site').click();
  await expect(page.locator('#single-site-preflight-status')).toContainText(/identity accepted/i);
  expect(preflightRequests).toBe(1);
});

test('u5: single-site URL suggestions require explicit role reconfirmation without changing scope or targets', async ({ page }) => {
  await page.goto('/new-audit.html?mode=single-site');
  const roleConfirmation = page.getByRole('checkbox', { name: /confirm this is the intended deployment role/i });
  const previewRole = page.locator('input[name="singleSiteRole"][value="preview"]');
  const productionRole = page.locator('input[name="singleSiteRole"][value="production"]');

  await page.locator('#advanced-audit-options').evaluate((details: HTMLDetailsElement) => { details.open = true; });
  await page.getByRole('radio', { name: /target selected audit areas or ids/i }).check();
  await page.locator('#plugin-options input[name="pluginId"]').first().check();
  await page.locator('#project-options input[name="targetId"]:checked').first().uncheck();
  const selectedTargets = await page.locator('#project-options input[name="targetId"]:checked')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  const selectedPlugins = await page.locator('#plugin-options input[name="pluginId"]:checked')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));

  await page.locator('#single-site-url').fill('https://beta.example.test/review');
  await expect(previewRole).toBeChecked();
  await expect(page.locator('#single-site-role-suggestion')).toContainText(/suggested role: preview/i);
  await expect(roleConfirmation).not.toBeChecked();
  await roleConfirmation.check();

  await page.locator('#single-site-url').fill(`${targets.productionUrl}/about/`);
  await expect(productionRole).toBeChecked();
  await expect(page.locator('#single-site-role-suggestion')).toContainText(/suggested role: production/i);
  await expect(roleConfirmation).not.toBeChecked();
  await expect(page.locator('#preview-single-site')).toBeEnabled();

  await roleConfirmation.check();
  await previewRole.check();
  await expect(roleConfirmation).not.toBeChecked();
  await expect(page.locator('#single-site-role-suggestion')).toContainText(/current selection is preview/i);
  expect(await page.locator('#project-options input[name="targetId"]:checked')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(selectedTargets);
  expect(await page.locator('#plugin-options input[name="pluginId"]:checked')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(selectedPlugins);
});

test('u5: single-site rejection creates no job, focuses the resolving role, and retries with preserved selections', async ({ page }) => {
  const preflightContracts: Record<string, any>[] = [];
  let launchRequests = 0;
  await page.route('**/api/single-site/preflight', async (route) => {
    const contract = route.request().postDataJSON();
    preflightContracts.push(contract);
    if (preflightContracts.length === 1) {
      return route.fulfill({ status: 422, json: rejectedSingleSitePreview() });
    }
    return route.fulfill({ status: 200, json: acceptedSingleSitePreview(contract) });
  });
  await page.route('**/api/single-site/runs**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname === '/api/single-site/runs') {
      launchRequests += 1;
      return route.fulfill({ status: 500, json: { error: 'A run must not be created in this journey.' } });
    }
    if (route.request().method() === 'GET' && url.pathname === '/api/single-site/runs') {
      return route.fulfill({ json: { schemaVersion: 1, jobs: [] } });
    }
    return route.fallback();
  });

  await page.goto('/new-audit.html?mode=single-site');
  await page.locator('#advanced-audit-options').evaluate((details: HTMLDetailsElement) => { details.open = true; });
  await page.getByRole('radio', { name: /target selected audit areas or ids/i }).check();
  await page.locator('#plugin-options input[name="pluginId"]').first().check();
  await page.locator('#project-options input[name="targetId"]:checked').first().uncheck();
  const expectedTargets = await page.locator('#project-options input[name="targetId"]:checked')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  const expectedPlugin = await page.locator('#plugin-options input[name="pluginId"]:checked').first().inputValue();

  await page.locator('input[name="singleSiteRole"][value="production"]').check();
  await page.getByRole('checkbox', { name: /confirm this is the intended deployment role/i }).check();
  await page.locator('#preview-single-site').click();
  await expect(page.locator('#single-site-coverage-badge')).toHaveText('Rejected');
  await expect(page.locator('input[name="singleSiteRole"][value="production"]')).toBeFocused();
  await expect(page.locator('#launch-run')).toBeDisabled();
  expect(launchRequests).toBe(0);

  await page.locator('input[name="singleSiteRole"][value="preview"]').check();
  await expect(page.getByRole('checkbox', { name: /confirm this is the intended deployment role/i })).not.toBeChecked();
  await page.getByRole('checkbox', { name: /confirm this is the intended deployment role/i }).check();
  await page.locator('#preview-single-site').click();
  await expect(page.locator('#single-site-preflight-status')).toContainText(/identity accepted/i);
  await expect(page.locator('#launch-run')).toBeEnabled();
  expect(preflightContracts).toHaveLength(2);
  expect(preflightContracts[0]!.scope).toEqual(preflightContracts[1]!.scope);
  expect(preflightContracts[1]!.scope).toEqual({ qualifier: 'TARGETED', pluginIds: [expectedPlugin], auditIds: [], areas: [] });
  expect(preflightContracts[1]!.targetIds).toEqual(expectedTargets);
  expect(launchRequests).toBe(0);
});

test('u5: single-site preflight aborts and rejects stale or contract-mismatched responses', async ({ page }) => {
  test.setTimeout(40_000);
  let preflightRequests = 0;
  await page.route('**/api/single-site/preflight', async (route) => {
    preflightRequests += 1;
    const contract = route.request().postDataJSON();
    if (preflightRequests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return route.fulfill({ status: 200, json: acceptedSingleSitePreview(contract, 'a') });
    }
    if (preflightRequests === 2) {
      return route.fulfill({ status: 200, json: acceptedSingleSitePreview({ ...contract, url: 'https://mismatched.example.test' }, 'b') });
    }
    return route.fulfill({ status: 200, json: acceptedSingleSitePreview(contract, 'c') });
  });

  await page.goto('/new-audit.html?mode=single-site');
  await page.getByRole('checkbox', { name: /confirm this is the intended deployment role/i }).check();
  const siteUrl = page.locator('#single-site-url');
  const originalUrl = await siteUrl.inputValue();
  await page.locator('#preview-single-site').click();
  await expect.poll(() => preflightRequests).toBe(1);
  await siteUrl.fill('https://changed-preview.example.test');
  await expect(page.locator('#single-site-coverage')).toBeHidden();
  await expect(page.locator('#launch-run')).toBeDisabled();

  await siteUrl.fill(originalUrl);
  await page.getByRole('checkbox', { name: /confirm this is the intended deployment role/i }).check();
  await page.locator('#preview-single-site').click();
  await expect(page.locator('#single-site-preflight-status')).toContainText(/did not match the submitted launch contract/i);
  await expect(page.locator('#launch-run')).toBeDisabled();

  await page.locator('#preview-single-site').click();
  await expect(page.locator('#single-site-preflight-status')).toContainText(/identity accepted/i);
  await expect(page.locator('#launch-run')).toBeEnabled();
  expect(preflightRequests).toBe(3);
});

test('u5: single-site launch revalidates stale accepted and newly rejected preflights with bounded focus', async ({ page }) => {
  const initialPreviewDigest = `sha256:${'a'.repeat(64)}`;
  const launchBodies: Record<string, any>[] = [];
  await page.route('**/api/single-site/preflight', async (route) => {
    const contract = route.request().postDataJSON();
    return route.fulfill({ status: 200, json: acceptedSingleSitePreview(contract, 'a') });
  });
  await page.route('**/api/single-site/runs**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === '/api/single-site/runs') {
      return route.fulfill({ json: { schemaVersion: 1, jobs: [] } });
    }
    if (route.request().method() !== 'POST' || url.pathname !== '/api/single-site/runs') return route.fallback();
    const body = route.request().postDataJSON();
    launchBodies.push(body);
    if (launchBodies.length === 1) {
      return route.fulfill({
        status: 409,
        json: { schemaVersion: 1, launched: false, reason: 'preview-stale', refreshedPreview: acceptedSingleSitePreview(body.runContract, 'b') },
      });
    }
    return route.fulfill({
      status: 422,
      json: { schemaVersion: 1, launched: false, reason: 'preflight-rejected', refreshedPreview: rejectedSingleSitePreview() },
    });
  });

  await page.goto('/new-audit.html?mode=single-site');
  await page.getByRole('checkbox', { name: /confirm this is the intended deployment role/i }).check();
  const expectedTargets = await page.locator('#project-options input[name="targetId"]:checked')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  await page.locator('#preview-single-site').click();
  await expect(page.locator('#launch-run')).toBeEnabled();

  await page.locator('#launch-run').click();
  await expect(page.locator('#form-message')).toContainText(/refreshed coverage is shown/i);
  await expect(page.locator('#launch-run')).toBeEnabled();
  await expect(page.locator('#single-site-coverage-title')).toBeFocused();
  expect(launchBodies[0]!.previewDigest).toBe(initialPreviewDigest);

  await page.locator('#launch-run').click();
  await expect(page.locator('#form-message')).toContainText(/no run was created/i);
  await expect(page.locator('#launch-run')).toBeDisabled();
  await expect(page.locator('input[name="singleSiteRole"][value="preview"]')).toBeFocused();
  expect(launchBodies).toHaveLength(2);
  expect(launchBodies[1]!.previewDigest).toBe(`sha256:${'b'.repeat(64)}`);
  expect(launchBodies[1]!.runContract.targetIds).toEqual(expectedTargets);
});

test('u5: single-site launch reuses one idempotency key after a lost response for an unchanged frozen request', async ({ page }) => {
  const runId = 'job-u5retry000001-u5retry000001';
  const launchBodies: Record<string, any>[] = [];
  await page.route('**/api/single-site/preflight', async (route) => {
    const contract = route.request().postDataJSON();
    return route.fulfill({ status: 200, json: acceptedSingleSitePreview(contract) });
  });
  await page.route('**/api/single-site/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    launchBodies.push(route.request().postDataJSON());
    if (launchBodies.length === 1) return route.abort('connectionfailed');
    return route.fulfill({ status: 201, json: { schemaVersion: 1, launched: true, idempotent: true, job: { id: runId } } });
  });

  await page.goto('/new-audit.html?mode=single-site');
  await page.getByRole('checkbox', { name: /confirm this is the intended deployment role/i }).check();
  await page.locator('#preview-single-site').click();
  await expect(page.locator('#launch-run')).toBeEnabled();
  await page.locator('#launch-run').click();
  await expect.poll(() => launchBodies.length).toBe(1);
  await expect(page.locator('#launch-run')).toBeEnabled();
  await page.locator('#launch-run').click();
  await page.waitForURL((url) => url.pathname === '/run.html' && url.searchParams.get('run') === runId);
  expect(launchBodies).toHaveLength(2);
  expect(launchBodies[0]!.idempotencyKey).toMatch(/^portal-[0-9a-f-]{36}$/);
  expect(launchBodies[1]!.idempotencyKey).toBe(launchBodies[0]!.idempotencyKey);
  expect(launchBodies[1]!.runContract).toEqual(launchBodies[0]!.runContract);
  expect(launchBodies[1]!.previewDigest).toBe(launchBodies[0]!.previewDigest);
});

test('characterization: direct Single-site workspace retains canonical mode and run ownership', async ({ page }) => {
  test.setTimeout(60_000);
  const runId = 'job-purgeui000001-purgeui000001';
  const confirmation = `PURGE ${runId}`;
  const job = {
    schemaVersion: 1,
    id: runId,
    mode: 'single-site',
    revision: 2,
    sourceRevision: 'state-2',
    status: 'completed',
    activity: 'normal',
    createdAt: '2026-08-25T12:00:00.000Z',
    updatedAt: '2026-08-25T12:05:00.000Z',
    url: targets.candidateUrl,
    deploymentRole: 'preview',
    certificatePolicy: 'strict',
    scope: {
      qualifier: 'FULL', requestedQualifier: 'FULL', filters: { pluginIds: [], auditIds: [], areas: [] },
      selectedTargetIds: ['single-site-mobile-chromium'], omissions: { definitions: [], cases: [], targets: [] },
    },
    coverage: {
      status: 'COMPLETE',
      counts: { selectedDefinitions: 1, executableCases: 1, plannedExecutions: 1, manualDefinitions: 0, coverageGaps: 0, omittedDefinitions: 0, outsideModeDefinitions: 0 },
      gaps: [], outsideModeCount: 0,
    },
    evidenceAuthority: { authoritative: true, reasons: [] },
    attempt: { number: 1, id: 'attempt-purge-ui', fencingToken: 1, infrastructureRetriesUsed: 0, maxInfrastructureRetries: 1 },
    lease: null,
    result: { kind: 'passed', classification: 'success', reason: 'Fixture completed.' },
    cancellation: null,
    finalization: { status: 'complete' },
    stageDeadlines: { inventory: '2026-08-25T12:01:00.000Z', browser: '2026-08-25T12:04:00.000Z', finalizer: '2026-08-25T12:05:00.000Z' },
    events: [{ at: '2026-08-25T12:05:00.000Z', executionState: 'completed', activityState: 'normal', message: 'Final report published.' }],
    publications: [],
    links: { self: `/api/single-site/runs/${runId}`, cancel: `/api/single-site/runs/${runId}/cancel`, report: `/report.html?mode=single-site&run=${runId}` },
    purge: { eligible: true, confirmation, baselineBytesPreserved: true },
  };
  const activeJob = {
    ...job,
    revision: 1,
    sourceRevision: 'state-1',
    status: 'running',
    updatedAt: '2026-08-25T12:03:00.000Z',
    result: null,
    finalization: { status: 'pending' },
    events: [{ at: '2026-08-25T12:03:00.000Z', executionState: 'running', activityState: 'normal', message: 'Browser worker is active.' }],
    purge: { ...job.purge, eligible: false },
  };
  let purged = false;
  let cancelled = false;
  let detailRequests = 0;
  const cancelRequests: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const purgeRequests: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  let releasePurge!: () => void;
  const purgeGate = new Promise<void>((resolve) => { releasePurge = resolve; });
  await page.route(`**/api/console/v1/runs/single-site/${runId}`, (route) => route.fulfill({
    json: runWorkspaceSummary('single-site', runId, { sourceRevision: 'state-1' }),
  }));
  await page.route('**/api/single-site/runs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/single-site/runs' && request.method() === 'GET') {
      return route.fulfill({ json: { schemaVersion: 1, jobs: purged ? [] : [cancelled ? job : activeJob] } });
    }
    if (url.pathname === `/api/single-site/runs/${runId}/cancel` && request.method() === 'POST') {
      cancelRequests.push({ pathname: url.pathname, body: request.postDataJSON() });
      cancelled = true;
      return route.fulfill({ status: 202, json: job });
    }
    if (url.pathname === `/api/single-site/runs/${runId}` && request.method() === 'DELETE') {
      purgeRequests.push({ pathname: url.pathname, body: request.postDataJSON() });
      if (purgeRequests.length === 1) {
        return route.fulfill({ status: 401, json: { error: 'Operator authorization is required for this fixture.' } });
      }
      await purgeGate;
      purged = true;
      return route.fulfill({ json: {
        jobId: runId, purged: true, terminalState: 'completed', filesRemoved: 14,
        logicalBytesRemoved: 95_833_292, physicalBytesRemoved: null, baselineBytesPreserved: true,
      } });
    }
    if (url.pathname.endsWith('/logs')) return route.fulfill({ json: { log: 'Browser worker is active.', sequence: 1, truncated: false, bytes: 25, sources: [] } });
    if (url.pathname.endsWith('/artifacts')) return route.fulfill({ json: { files: [], total: 0, offset: 0, limit: 80, hasMore: false } });
    if (url.pathname === `/api/single-site/runs/${runId}` && request.method() === 'GET') {
      detailRequests += 1;
      return route.fulfill({ json: cancelled ? job : activeJob });
    }
    return route.fallback();
  });

  await page.goto(`/run.html?mode=single-site&run=${encodeURIComponent(runId)}&view=overview`);
  await page.waitForURL((url) => url.pathname === '/run.html' && url.searchParams.get('mode') === 'single-site' && url.searchParams.get('run') === runId);
  expect(new URL(page.url()).searchParams.get('view')).toBe('overview');
  await expect(page.getByRole('heading', { name: 'Run workspace' })).toBeVisible();
  await expect(page.locator('#run-mode')).toHaveText('Single Site');
  await expect(page.locator('#run-id')).toHaveText(runId);
  await expect(page.locator('#run-view-region')).toHaveAttribute('data-async-state', 'ready');
  await expect.poll(() => detailRequests).toBeGreaterThan(1);
  await expect.poll(() => page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport.polls)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).__runWorkspaceDiagnostics.transport.eventSources)).toBe(0);
  expect(cancelRequests).toEqual([]);
  expect(purgeRequests).toEqual([]);
  releasePurge();
});

test('characterization: direct comparative workspace owns its live transport without mutating run state', async ({ page }) => {
  test.setTimeout(30_000);
  const runId = 'comparative-purge-routing-fixture';
  const confirmation = `PURGE ${runId}`;
  const run = {
    id: runId, mode: 'comparative', sourceRevision: 'source-1', status: 'running', phase: 'Executing browser checks',
    createdAt: '2026-08-25T12:00:00.000Z', startedAt: '2026-08-25T12:00:00.000Z', finishedAt: null,
    externalManaged: false, stopRequestedAt: null, exitCode: 1, signal: null,
    options: {
      profile: 'release', auditIds: ['ENV-001'], pluginIds: [], projects: ['candidate-mobile-chromium'],
      productionUrl: targets.productionUrl, candidateUrl: targets.candidateUrl, candidateIgnoreHTTPSErrors: false,
    },
    progress: { completed: 0, total: 1 },
    pipeline: { status: 'running', reason: 'Fixture evidence is being collected.' },
    release: { decision: 'PENDING', reason: 'Fixture work is active.', decisionBasis: 'Fixture evidence.' },
    reviewReasons: [], command: ['docker', 'compose', 'run'], stages: {},
    purge: { eligible: true, confirmation },
  };
  let purged = false;
  let deletePath: string | null = null;
  let eventRequests = 0;
  await page.route(`**/api/console/v1/runs/comparative/${runId}`, (route) => route.fulfill({
    json: runWorkspaceSummary('comparative', runId, { sourceRevision: run.sourceRevision }),
  }));
  await page.route('**/api/runs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/runs' && request.method() === 'GET') {
      return route.fulfill({ json: { runs: purged ? [] : [run] } });
    }
    if (url.pathname === `/api/runs/${runId}` && request.method() === 'DELETE') {
      deletePath = url.pathname;
      expect(request.postDataJSON()).toEqual({ confirmation });
      purged = true;
      return route.fulfill({ json: { id: runId, purged: true, filesRemoved: 2, logicalBytesRemoved: 1_024 } });
    }
    if (url.pathname === `/api/runs/${runId}/events`) {
      eventRequests += 1;
      return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic stream interruption.' });
    }
    if (url.pathname.endsWith('/logs')) return route.fulfill({ json: { log: 'Fixture complete.', sequence: 0 } });
    if (url.pathname.endsWith('/artifacts')) return route.fulfill({ json: { files: [], total: 0, offset: 0, limit: 80, hasMore: false } });
    if (url.pathname.endsWith('/manual-evidence')) return route.fulfill({ json: { attestations: [] } });
    if (url.pathname === `/api/runs/${runId}` && request.method() === 'GET') return route.fulfill({ json: run });
    return route.fallback();
  });

  await page.goto(`/run.html?mode=comparative&run=${encodeURIComponent(runId)}&view=overview`);
  await page.waitForURL((url) => url.pathname === '/run.html' && url.searchParams.get('mode') === 'comparative' && url.searchParams.get('run') === runId);
  expect(new URL(page.url()).searchParams.get('view')).toBe('overview');
  await expect(page.getByRole('heading', { name: 'Run workspace' })).toBeVisible();
  await expect(page.locator('#run-mode')).toHaveText('Comparative');
  await expect(page.locator('#run-id')).toHaveText(runId);
  await expect(page.locator('#run-view-region')).toHaveAttribute('data-async-state', 'ready');
  await expect.poll(() => eventRequests).toBeGreaterThan(0);
  expect(deletePath).toBeNull();
});

test('characterization: direct Single-site report links retain mode, run, and gallery review context', async ({ page }) => {
  const runId = 'single-site-report-gallery-fixture';
  const run = {
    id: runId, mode: 'single-site', status: 'completed', createdAt: '2026-08-25T12:00:00.000Z', updatedAt: '2026-08-25T12:04:00.000Z',
    url: targets.candidateUrl, scope: { qualifier: 'FULL' },
    finalization: { status: 'complete' },
    aiReview: {
      optedIn: true, model: 'claude-test-model', state: 'unavailable',
      status: {
        state: 'unavailable', stateRevision: 2, retryable: true,
        error: { code: 'credential-unavailable', message: 'The runtime credential was unavailable.' },
      },
    },
  };
  const report = {
    schemaVersion: 1, mode: 'single-site', publicationRevision: '11111111111111111111111111111111',
    generatedAt: '2026-08-25T12:04:00.000Z', auditedUrl: targets.candidateUrl,
    siteHealth: { verdict: 'FINDINGS', displayLabel: 'Findings', reason: 'Two deterministic findings need review.' },
    promotion: { statement: 'This advisory Site Health verdict cannot authorize or block promotion.' },
    coverage: { status: 'COMPLETE', gapCount: 0, limitationCount: 0 },
    evidenceCompletion: { status: 'COMPLETE' }, evidenceAuthority: { status: 'authoritative' }, pipelineIntegrity: { status: 'complete' },
    scope: { qualifier: 'FULL', selected: { total: 10 }, omitted: { total: 0 }, outsideMode: { total: 1 } },
    auditPages: { total: 10 }, findings: { count: 2 }, manual: { status: 'complete', required: 0, complete: 0, outstanding: 0, failedOrBlocked: 0 },
    visualReview: { total: 5, attentionRequired: 2 },
  };
  let retryBody: Record<string, unknown> | null = null;
  let releaseRetry!: () => void;
  const retryResponse = new Promise<void>((resolve) => { releaseRetry = resolve; });
  await page.route(`**/api/single-site/runs/${runId}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/ai-review') && route.request().method() === 'POST') {
      retryBody = route.request().postDataJSON();
      await retryResponse;
      return route.fulfill({ json: { ...run.aiReview.status, state: 'pending', stateRevision: 3, error: null, retryable: false } });
    }
    if (url.pathname.endsWith('/ai-review')) return route.fulfill({ json: {
      schemaVersion: 1, mode: 'single-site', advisory: true, gating: false,
      optedIn: true, model: 'claude-test-model', state: 'unavailable',
      unavailableReason: run.aiReview.status.error.message, status: run.aiReview.status, result: null,
    } });
    if (url.pathname.endsWith('/report/audits')) return route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 25, hasMore: false, filters: {} } });
    if (url.pathname.endsWith('/artifacts')) return route.fulfill({ json: { files: [], total: 0, offset: 0, limit: 80, hasMore: false } });
    if (url.pathname.endsWith('/report')) return route.fulfill({ json: report });
    return route.fulfill({ json: run });
  });

  await page.goto(`/report.html?mode=single-site&run=${runId}`);
  expect(new URL(page.url()).searchParams.get('mode')).toBe('single-site');
  expect(new URL(page.url()).searchParams.get('run')).toBe(runId);
  await expect(page.locator('#visual-gallery-link')).toHaveAttribute('href', `/gallery.html?mode=single-site&run=${runId}&from=report`);
  await expect(page.getByRole('link', { name: 'Review 2 visual attention items' })).toHaveAttribute('href', `/gallery.html?mode=single-site&run=${runId}&from=report`);
  await expect(page.getByRole('link', { name: 'Browse all visual evidence' })).toHaveAttribute('href', `/gallery.html?mode=single-site&run=${runId}&from=report&review=all`);
  await expect(page.locator('#decision-basis')).toContainText(/cannot authorize or block promotion/i);
  await expect(page.locator('#report-trust-facts')).toContainText('Evidence Authority');
  await expect(page.locator('#report-trust-facts')).toContainText('Pipeline Integrity');
  await expect(page.locator('#report-trust-facts')).toContainText('Publication');
  await expect(page.locator('#ai-summary')).toContainText(/runtime credential was unavailable/i);
  await expect(page.locator('#ai-summary')).toContainText(/cannot change deterministic findings/i);
  const retry = page.locator('#ai-review-retry');
  await expect(retry).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await retry.click();
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => retryBody).toEqual({
    expectedStateRevision: 2,
    confirmation: `RETRY AI ${runId}`,
  });
  releaseRetry();
  await expect(page.locator('#report-announcer')).toContainText(/retry is queued/i);
});

test('characterization: direct comparative report uses bounded loading and logs without fetching raw evidence', async ({ page }) => {
  const requestedUrls: string[] = [];
  page.on('request', (request) => requestedUrls.push(request.url()));
  const run = {
    id: 'ui-state-demo',
    status: 'not-ready',
    startedAt: '2026-08-24T12:00:00.000Z',
    finishedAt: '2026-08-24T12:01:00.000Z',
    options: { profile: 'release', auditIds: [], productionUrl: targets.productionUrl, candidateUrl: targets.candidateUrl },
    pipeline: { status: 'completed', completed: true, reason: 'Synthetic UI state fixture.' },
    release: { decision: 'NOT_READY', reason: 'No checks were executed.', decisionBasis: 'Synthetic UI state fixture.' },
    reviewReasons: ['the selected scope is not a complete release matrix', 'portal execution is review evidence only'],
  };
  const report = {
    schemaVersion: 1,
    publicationRevision: '11111111111111111111111111111111',
    generatedAt: '2026-08-24T12:01:00.000Z',
    run: { profile: 'release', startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: 60_000 },
    release: { ready: false, decision: 'NOT_READY', blockingFailures: 0, blockingIncomplete: 1, baselineIssues: 0, reason: 'No checks were executed.', decisionBasis: 'Synthetic UI state fixture.' },
    summary: { total: 1, executed: 0, structuredExecutions: 0, artifacts: 0, videos: 0, posters: 0, baselineIssues: 0, byStatus: { NOT_RUN: 1 }, bySeverity: { P0: 1 } },
    manualEvidence: { required: 0, complete: 0, outstanding: 0, failedOrBlocked: 0, byStatus: {} },
    topFindings: [], topFindingCount: 0,
    filters: { statuses: ['NOT_RUN'], severities: ['P0'], areas: ['environment'], environments: ['candidate', 'production'] },
    aiReview: null,
  };
  await page.route('**/api/runs/ui-state-demo', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.fulfill({ json: run });
  });
  await page.route('**/api/runs/ui-state-demo/report', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.fulfill({ json: report });
  });
  await page.route('**/api/runs/ui-state-demo/report/audits?*', (route) => route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 25, nextOffset: 0, hasMore: false, filters: report.filters } }));
  await page.route('**/api/runs/ui-state-demo/artifacts?*', (route) => route.fulfill({ json: { files: [], total: 0, knownTotal: 0, totalComplete: true, offset: 0, limit: 80, nextOffset: 0, hasMore: false } }));

  await page.goto('/report.html?run=ui-state-demo', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#report-loading')).toBeVisible();
  await expect(page.locator('#decision-title')).toContainText(/not ready/i);
  await expect(page.locator('#decision-badge')).toHaveText('Do not release');
  await expect(page.locator('#decision-summary')).toContainText(/additional review requirements/i);
  await expect(page.locator('#report-trust-facts')).toContainText('Release decision');
  await expect(page.locator('#report-trust-facts')).toContainText('Evidence Authority');
  await expect(page.locator('#report-trust-facts')).toContainText('Manual acceptance');
  await expect(page.locator('#top-findings')).toContainText(/no structured findings/i);
  await expect(page.locator('#audit-list')).toContainText(/no checks match/i);
  await expect(page.locator('#visual-gallery-link')).toHaveAttribute('href', '/gallery.html?run=ui-state-demo&from=report');
  expect(requestedUrls.some((url) => url.endsWith('/checklist/manifest.json'))).toBeFalsy();
  expect(requestedUrls.some((url) => url.includes('/logs'))).toBeFalsy();
  expect(requestedUrls.some((url) => url.includes('revision=11111111111111111111111111111111'))).toBeTruthy();

  await page.route('**/api/runs/ui-state-demo/report', (route) => route.fulfill({
    status: 503,
    json: { error: 'Synthetic publication refresh interruption.' },
  }));
  await page.locator('#refresh-report').click();
  await expect(page.locator('#report-connection')).toContainText('showing last known report');
  await expect(page.locator('#decision-title')).toContainText(/not ready/i);
  await expect(page.locator('#report-content')).toBeVisible();

  await page.route('**/api/runs/ui-state-demo/logs?*', (route) => route.fulfill({
    json: {
      log: 'bounded redacted output', bytes: 23, truncated: false,
      sources: [{ path: 'logs/runner.log', size: 10_000 }],
    },
  }));
  await page.locator('#load-log').click();
  await expect(page.locator('#report-log')).toContainText('bounded redacted output');
  await expect(page.locator('#log-links')).toContainText(/redacted source/i);
  await expect(page.locator('#log-links a')).toHaveCount(0);
  expect(requestedUrls.some((value) => {
    const url = new URL(value);
    return url.pathname === '/api/runs/ui-state-demo/logs' && url.searchParams.get('maxBytes') === '65536';
  })).toBeTruthy();

  const partialId = 'partial-counts-report-demo';
  await page.route(`**/api/runs/${partialId}`, (route) => route.fulfill({ json: { ...run, id: partialId } }));
  await page.route(`**/api/runs/${partialId}/report`, (route) => route.fulfill({ json: {
    ...report,
    publicationRevision: '33333333333333333333333333333333',
    summary: { ...report.summary, total: null, executed: null, artifacts: null, structuredExecutions: null, baselineIssues: null },
    release: { ...report.release, blockingFailures: null, blockingIncomplete: null },
    manualEvidence: null,
  } }));
  await page.route(`**/api/runs/${partialId}/report/audits?*`, (route) => route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 25, nextOffset: 0, hasMore: false, filters: report.filters } }));
  await page.route(`**/api/runs/${partialId}/artifacts?*`, (route) => route.fulfill({ json: { files: [], total: 0, knownTotal: 0, totalComplete: true, offset: 0, limit: 80, nextOffset: 0, hasMore: false } }));
  await page.goto(`/report.html?run=${partialId}`);
  await expect(page.locator('#report-trust-facts > div').filter({ hasText: 'Coverage' }).locator('strong')).toHaveText('Unavailable');
  await expect(page.locator('#report-trust-facts > div').filter({ hasText: 'Manual acceptance' }).locator('strong')).toHaveText('Unavailable');
  await expect(page.locator('.metric-card').filter({ hasText: 'Documented checks' }).locator('strong')).toHaveText('Unavailable');
  await expect(page.locator('.metric-card').filter({ hasText: 'Release blockers' }).locator('strong')).toHaveText('Unavailable');

  await page.route('**/api/runs/missing-report-demo', (route) => route.fulfill({ json: { ...run, id: 'missing-report-demo' } }));
  await page.route('**/api/runs/missing-report-demo/report', (route) => route.fulfill({ status: 404, json: { error: 'Compact report not found.' } }));
  await page.goto('/report.html?run=missing-report-demo');
  await expect(page.locator('#report-error-title')).toHaveText('No reviewer report is available');
  await expect(page.locator('#report-error-message')).toContainText(/finished without a compact reviewer report/i);
});

test('reviewer report falls back to actionable failed, review, and incomplete outcomes without treating baseline as candidate gating', async ({ page }) => {
  const runId = 'attention-fallback-demo';
  const run = {
    id: runId,
    status: 'not-ready',
    startedAt: '2026-08-25T01:38:00.000Z',
    finishedAt: '2026-08-25T01:40:00.000Z',
    options: { profile: 'release', auditIds: ['PAGE-BRAND', 'ENV-007'], productionUrl: targets.productionUrl, candidateUrl: targets.candidateUrl },
    pipeline: { status: 'completed', completed: true, reason: 'Synthetic attention fixture.' },
    release: { decision: 'NOT_READY', reason: 'Two checks need attention.', decisionBasis: 'Synthetic checklist truth.' },
    reviewReasons: [],
  };
  const report = {
    schemaVersion: 1,
    publicationRevision: '22222222222222222222222222222222',
    generatedAt: run.finishedAt,
    run: { profile: 'release', startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: 120_000 },
    release: { ready: false, decision: 'NOT_READY', blockingFailures: 2, blockingIncomplete: 2, baselineIssues: 1, reason: 'Four checks need attention.', decisionBasis: 'Synthetic checklist truth.' },
    summary: { total: 4, executed: 2, structuredExecutions: 4, artifacts: 4, videos: 0, posters: 0, baselineIssues: 1, byStatus: { FAIL: 1, REVIEW: 1, NOT_RUN: 1, MANUAL_REQUIRED: 1 }, bySeverity: { P0: 2, P1: 2 } },
    manualEvidence: { required: 1, complete: 0, outstanding: 1, failedOrBlocked: 0, byStatus: { MANUAL_REQUIRED: 1 } },
    topFindings: [],
    topFindingCount: 0,
    topAttentionCount: 4,
    topAttention: [{
      auditId: 'PAGE-BRAND', auditTitle: 'Page audit: /brand', area: 'routes', auditStatus: 'FAIL', severity: 'P1', releaseBlocking: true,
      scope: 'candidate', detail: 'At least one candidate execution failed.',
      errorContext: 'Every published page must pass the automated WCAG A/AA scan · tests/page-audit.spec.ts:276',
      reasonCodes: ['MISSING_REQUIRED_EVIDENCE'], baselineNonGating: true,
      baselineNote: 'Production issues are preserved as baseline context but do not veto a candidate that fixes them.',
      evidence: [{ name: 'axe-page-scan', kind: 'axe', href: 'evidence/source/candidate/axe-page-scan.json', sizeBytes: 512, attempt: 2, context: 'final-primary' }],
    }, {
      auditId: 'ENV-007', auditTitle: 'Custom not-found recovery page', area: 'environment', auditStatus: 'REVIEW', severity: 'P0', releaseBlocking: true,
      scope: 'candidate', detail: 'Candidate evidence authority is withheld until strict TLS verification succeeds.',
      errorContext: null, reasonCodes: ['TLS_BYPASS'], baselineNonGating: false, baselineNote: null, evidence: [],
    }, {
      auditId: 'PAGE-HOME', auditTitle: 'Page audit: /', area: 'routes', auditStatus: 'NOT_RUN', severity: 'P1', releaseBlocking: true,
      scope: 'candidate', detail: 'The selected candidate project emitted no completed execution.',
      errorContext: null, reasonCodes: [], baselineNonGating: false, baselineNote: null, evidence: [],
    }, {
      auditId: 'DEVICE-001', auditTitle: 'Real iPhone Safari acceptance', area: 'responsive', auditStatus: 'MANUAL_REQUIRED', severity: 'P0', releaseBlocking: true,
      scope: 'unknown', detail: 'This catalog entry requires human acceptance evidence.',
      errorContext: null, reasonCodes: [], baselineNonGating: false, baselineNote: null, evidence: [],
    }],
    filters: { statuses: ['FAIL', 'REVIEW', 'NOT_RUN', 'MANUAL_REQUIRED'], severities: ['P0', 'P1'], areas: ['environment', 'responsive', 'routes'], environments: ['candidate', 'production'] },
    aiReview: null,
  };
  await page.route(`**/api/runs/${runId}`, (route) => route.fulfill({ json: run }));
  await page.route(`**/api/runs/${runId}/report`, (route) => route.fulfill({ json: report }));
  await page.route(`**/api/runs/${runId}/report/audits?*`, (route) => route.fulfill({
    json: { items: [], total: 0, offset: 0, limit: 25, nextOffset: 0, hasMore: false, filters: report.filters },
  }));
  await page.route(`**/api/runs/${runId}/artifacts?*`, (route) => route.fulfill({
    json: { files: [], total: 0, knownTotal: 0, totalComplete: true, offset: 0, limit: 80, nextOffset: 0, hasMore: false },
  }));

  await page.goto(`/report.html?run=${runId}`);
  await expect(page.locator('#finding-total')).toHaveText('4 attention outcomes');
  await expect(page.locator('#top-findings .finding-card')).toHaveCount(4);
  await expect(page.locator('#top-findings')).toContainText('Every published page must pass the automated WCAG A/AA scan');
  await expect(page.locator('#top-findings')).toContainText('The selected candidate project emitted no completed execution.');
  await expect(page.locator('#top-findings')).toContainText('This catalog entry requires human acceptance evidence.');
  await expect(page.locator('#top-findings')).toContainText('Final attempt 2 · primary');
  await expect(page.locator('#top-findings')).toContainText(/comparison only; not part of this candidate gate/i);
  await expect(page.locator('#top-findings')).not.toContainText(/no findings recorded|no structured findings/i);
  const evidence = page.locator('#top-findings .evidence-link-list a');
  await expect(evidence).toHaveCount(1);
  await expect(evidence).toHaveAttribute('href', `/artifacts/${runId}/checklist/evidence/source/candidate/axe-page-scan.json`);

  const combinedRunId = 'combined-finding-attention-demo';
  const combinedReport = {
    ...report,
    publicationRevision: '33333333333333333333333333333333',
    topFindings: [{
      auditId: 'CALC-007', auditTitle: 'SR-17 simple-protocol dose conversion', area: 'calculators', auditStatus: 'FAIL',
      severity: 'P0', releaseBlocking: true, title: 'SR-17 half-quarter tie policy is not clinically approved',
      detail: 'A named clinical owner must approve the 18.75 to 25 conversion before release.', blocking: true,
      sourceProject: 'candidate-mobile-chromium', environment: 'candidate', scope: 'candidate', baselineNonGating: false,
    }],
    topFindingCount: 1,
  };
  await page.route(`**/api/runs/${combinedRunId}`, (route) => route.fulfill({ json: { ...run, id: combinedRunId } }));
  await page.route(`**/api/runs/${combinedRunId}/report`, (route) => route.fulfill({ json: combinedReport }));
  await page.route(`**/api/runs/${combinedRunId}/report/audits?*`, (route) => route.fulfill({
    json: { items: [], total: 0, offset: 0, limit: 25, nextOffset: 0, hasMore: false, filters: report.filters },
  }));
  await page.route(`**/api/runs/${combinedRunId}/artifacts?*`, (route) => route.fulfill({
    json: { files: [], total: 0, knownTotal: 0, totalComplete: true, offset: 0, limit: 80, nextOffset: 0, hasMore: false },
  }));

  await page.goto(`/report.html?run=${combinedRunId}`);
  await expect(page.locator('#finding-total')).toHaveText('1 structured finding · 4 other attention outcomes');
  await expect(page.locator('#top-findings .finding-card')).toHaveCount(5);
  await expect(page.locator('#top-findings')).toContainText('Observed on Candidate Mobile Chromium · release-blocking execution');
  await expect(page.locator('#top-findings')).toContainText('SR-17 half-quarter tie policy is not clinically approved');
  await expect(page.locator('#top-findings')).toContainText('The selected candidate project emitted no completed execution.');
});

test('reviewer report never presents a READY checklist as release authority when review is required', async ({ page }) => {
  const run = {
    id: 'ready-review-demo',
    status: 'review-required',
    startedAt: '2026-08-24T12:00:00.000Z',
    finishedAt: '2026-08-24T12:01:00.000Z',
    options: { profile: 'release', auditIds: [], productionUrl: targets.productionUrl, candidateUrl: targets.candidateUrl },
    pipeline: { status: 'completed', completed: true, reason: 'Synthetic portal pipeline complete.' },
    release: { decision: 'READY', reason: 'Every checklist row passed.', decisionBasis: 'Synthetic checklist truth.' },
    reviewReasons: ['this portal-launched single-container run is review evidence only; final signoff requires a new-ID sharded release run with isolated performance provenance'],
  };
  const report = {
    schemaVersion: 1,
    generatedAt: run.finishedAt,
    run: { profile: 'release', startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: 60_000 },
    release: { ready: true, decision: 'READY', blockingFailures: 0, blockingIncomplete: 0, baselineIssues: 0, reason: 'Every checklist row passed.', decisionBasis: 'Synthetic checklist truth.' },
    summary: { total: 183, executed: 183, structuredExecutions: 183, artifacts: 183, videos: 10, posters: 10, baselineIssues: 0, byStatus: { PASS: 183 }, bySeverity: { P0: 183 } },
    manualEvidence: { required: 0, complete: 0, outstanding: 0, failedOrBlocked: 0, byStatus: {} },
    topFindings: [], topFindingCount: 0,
    filters: { statuses: ['PASS'], severities: ['P0'], areas: ['environment'], environments: ['candidate', 'production'] },
    aiReview: null,
  };
  await page.route('**/api/runs/ready-review-demo', (route) => route.fulfill({ json: run }));
  await page.route('**/api/runs/ready-review-demo/report', (route) => route.fulfill({ json: report }));
  await page.route('**/api/runs/ready-review-demo/report/audits?*', (route) => route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 25, nextOffset: 0, hasMore: false, filters: report.filters } }));
  await page.route('**/api/runs/ready-review-demo/artifacts?*', (route) => route.fulfill({ json: { files: [], total: 0, knownTotal: 0, totalComplete: true, offset: 0, limit: 80, nextOffset: 0, hasMore: false } }));
  await page.goto('/report.html?run=ready-review-demo');
  await expect(page.locator('#decision-badge')).toHaveText('Review required');
  await expect(page.locator('#decision-title')).toContainText(/checklist passed.*signoff is withheld/i);
  await expect(page.locator('#decision-summary')).toContainText(/new-ID sharded release run/i);
  await expect(page.locator('#decision-title')).not.toContainText('ready for release');

  const failedRun = {
    ...run,
    id: 'stale-ready-report-demo',
    status: 'evidence-failed',
    pipeline: { status: 'failed', completed: false, reason: 'Final evidence persistence failed.' },
    release: { decision: 'UNAVAILABLE', reason: 'No durable terminal evidence exists.', decisionBasis: 'Terminal lifecycle truth.' },
    reviewReasons: [],
  };
  await page.route('**/api/runs/stale-ready-report-demo', (route) => route.fulfill({ json: failedRun }));
  await page.route('**/api/runs/stale-ready-report-demo/report', (route) => route.fulfill({ json: report }));
  await page.route('**/api/runs/stale-ready-report-demo/report/audits?*', (route) => route.fulfill({ json: { items: [], total: 0, offset: 0, limit: 25, nextOffset: 0, hasMore: false, filters: report.filters } }));
  await page.route('**/api/runs/stale-ready-report-demo/artifacts?*', (route) => route.fulfill({ json: { files: [], total: 0, knownTotal: 0, totalComplete: true, offset: 0, limit: 80, nextOffset: 0, hasMore: false } }));
  await page.goto('/report.html?run=stale-ready-report-demo');
  await expect(page.locator('#decision-badge')).toHaveText('Decision unavailable');
  await expect(page.locator('#decision-title')).not.toContainText('ready for release');
  await expect(page.locator('#decision-summary')).toContainText(/no durable terminal evidence/i);
});

test('u5: Settings credential vault clears plaintext and returns only non-secret metadata', async ({ page }) => {
  const initialCapability = await (await page.request.get('/api/settings/anthropic-key')).json();
  test.skip(initialCapability.storageEnabled !== true, 'The host-run portal intentionally disables credential storage without isolated worker identities.');
  const syntheticKey = ['sk', 'ant', 'portal-e2e', '0'.repeat(40)].join('-');
  await page.goto('/settings.html?section=credentials');
  await page.locator('#anthropic-key-input').fill(syntheticKey);
  const saveResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'PUT' && url.pathname === '/api/settings/anthropic-key';
  });
  await page.locator('#save-anthropic-key').click();
  await expect(page.locator('#anthropic-key-input')).toHaveValue('');
  const saveResponse = await saveResponsePromise;
  await expect(page.locator('#anthropic-key-message')).toContainText(/saved/i);
  expect(saveResponse.url()).not.toContain(syntheticKey);
  expect(await saveResponse.text()).not.toContain(syntheticKey);

  const browserResidue = await page.evaluate(() => ({
    href: window.location.href,
    documentText: document.body.innerText,
    documentMarkup: document.documentElement.outerHTML,
    localStorage: Object.entries(window.localStorage),
    sessionStorage: Object.entries(window.sessionStorage),
    resourceUrls: performance.getEntriesByType('resource').map((entry) => entry.name),
  }));
  expect(JSON.stringify(browserResidue)).not.toContain(syntheticKey);

  const stateResponse = await page.request.get('/api/settings/anthropic-key');
  expect(stateResponse.ok()).toBeTruthy();
  const state = await stateResponse.json();
  expect(state).toMatchObject({
    configured: true,
    fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{12}$/),
    storageEnabled: true,
    unavailableReason: null,
  });
  expect(JSON.stringify(state)).not.toContain(syntheticKey);
  expect(await (await page.request.get('/api/config')).text()).not.toContain(syntheticKey);

  await page.reload();
  await expect(page.locator('#anthropic-key-state')).toContainText(/configured/i);
  await page.locator('#delete-anthropic-key').click();
  await expect(page.locator('#delete-anthropic-key')).toHaveText('Confirm delete');
  await page.getByRole('button', { name: 'Test Catalog' }).click();
  await page.getByRole('button', { name: 'Credentials' }).click();
  await expect(page.locator('#delete-anthropic-key')).toHaveText('Delete key');
  await page.locator('#delete-anthropic-key').click();
  const deleteResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'DELETE' && url.pathname === '/api/settings/anthropic-key';
  });
  await page.locator('#delete-anthropic-key').click();
  const deleteResponse = await deleteResponsePromise;
  await expect(page.locator('#anthropic-key-message')).toContainText(/deleted/i);
  expect(await deleteResponse.text()).not.toContain(syntheticKey);
  expect(await (await page.request.get('/api/settings/anthropic-key')).json()).toMatchObject({
    configured: false, fingerprint: null, storageEnabled: true, unavailableReason: null,
  });
});

test('u5: Settings reconciles a lost credential save response without repeating the secret mutation', async ({ page }) => {
  const syntheticKey = ['sk', 'ant', 'lost-response', '8'.repeat(40)].join('-');
  let configured = false;
  let putRequests = 0;
  await page.route('**/api/settings/anthropic-key', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: {
        configured,
        fingerprint: configured ? 'sha256:123456789abc' : null,
        storageEnabled: true,
        unavailableReason: null,
      } });
    }
    if (route.request().method() === 'PUT') {
      putRequests += 1;
      expect(route.request().postDataJSON()).toEqual({ apiKey: syntheticKey });
      configured = true;
      return route.abort('connectionfailed');
    }
    return route.fallback();
  });

  await page.goto('/settings.html?section=credentials');
  await expect(page.locator('#anthropic-key-state')).toHaveText('Not configured');
  await page.locator('#anthropic-key-input').fill(syntheticKey);
  await page.locator('#save-anthropic-key').click();
  await expect(page.locator('#anthropic-key-input')).toHaveValue('');
  await expect(page.locator('#anthropic-key-message')).toContainText(/response was lost.*configured.*without repeating/i);
  await expect(page.locator('#anthropic-key-state')).toContainText(/configured/i);
  expect(putRequests).toBe(1);
  expect(await page.locator('body').innerText()).not.toContain(syntheticKey);
  expect(await page.evaluate(() => JSON.stringify({
    localStorage: Object.entries(localStorage),
    sessionStorage: Object.entries(sessionStorage),
  }))).not.toContain(syntheticKey);
});

test('characterization: mutation security and production certificate guards fail closed', async ({ request, playwright }) => {
  const portalBaseUrl = process.env.PORTAL_E2E_BASE_URL;
  if (!portalBaseUrl) throw new Error('PORTAL_E2E_BASE_URL is required for portal acceptance tests.');
  const crossOrigin = await playwright.request.newContext({
    baseURL: portalBaseUrl,
    extraHTTPHeaders: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
  });
  const blockedOrigin = await crossOrigin.post('/api/runs', { data: runRequest() });
  expect(blockedOrigin.status()).toBe(403);
  await crossOrigin.dispose();
  const sandboxed = await playwright.request.newContext({
    baseURL: portalBaseUrl,
    extraHTTPHeaders: { Origin: 'null', 'Content-Type': 'application/json' },
  });
  expect((await sandboxed.delete('/api/settings/anthropic-key', { data: {} })).status()).toBe(403);
  await sandboxed.dispose();

  const rebound = await playwright.request.newContext({
    baseURL: portalBaseUrl,
    extraHTTPHeaders: { Host: 'attacker.invalid', Origin: 'http://attacker.invalid' },
  });
  const blockedRunId = 'blocked-run-0001';
  const reboundResponses = await Promise.all([
    rebound.get('/api/settings/anthropic-key'),
    rebound.post('/api/runs', { data: runRequest() }),
    rebound.put('/api/settings/anthropic-key', { data: { apiKey: 'sk-ant-untrusted-host-fixture-0000000000000000' } }),
    rebound.post(`/api/runs/${blockedRunId}/stop`, { data: {} }),
    rebound.delete(`/api/runs/${blockedRunId}`, { data: { confirmation: `PURGE ${blockedRunId}` } }),
    rebound.post(`/api/runs/${blockedRunId}/manual-evidence`, { data: { confirmed: true } }),
    rebound.post(`/api/runs/${blockedRunId}/manual-uploads?auditId=DEVICE-001&filename=fake.png`, {
      headers: { 'Content-Type': 'image/png' },
      data: Buffer.from('not an image'),
    }),
  ]);
  expect(reboundResponses.map((response) => response.status())).toEqual(Array(reboundResponses.length).fill(403));
  await rebound.dispose();

  const reboundWithoutOrigin = await playwright.request.newContext({
    baseURL: portalBaseUrl,
    extraHTTPHeaders: { Host: 'attacker.invalid' },
  });
  expect((await reboundWithoutOrigin.get('/healthz')).status()).toBe(403);
  expect((await reboundWithoutOrigin.post('/api/runs', { data: runRequest() })).status()).toBe(403);
  await reboundWithoutOrigin.dispose();

  for (const failure of ['stream', 'persist', 'spawn']) {
    const failedInitialization = await request.post('/api/runs', {
      headers: { 'x-portal-e2e-launch-failure': failure },
      data: runRequest(),
    });
    expect(failedInitialization.status()).toBe(500);
    const runList = await (await request.get('/api/runs')).json();
    const failedRun = runList.runs.find((run: Record<string, unknown>) => run.status === 'spawn-failed'
      && run.phase === 'Run initialization failed before launch');
    expect(failedRun, `${failure} initialization failure must be retained as a terminal record`).toBeTruthy();
    const purgedFailure = await request.delete(`/api/runs/${encodeURIComponent(failedRun.id)}`, {
      data: { confirmation: `PURGE ${failedRun.id}` },
    });
    expect(purgedFailure.status(), await purgedFailure.text()).toBe(200);
  }

  const blockedTls = await request.post('/api/runs', {
    data: runRequest({ candidateUrl: targets.productionUrl, candidateIgnoreHTTPSErrors: true }),
  });
  expect(blockedTls.status()).toBe(400);
  expect(await blockedTls.text()).toContain('cannot restrict it to one exact origin');
  const blockedDevelopmentTls = await request.post('/api/runs', {
    data: runRequest({ candidateIgnoreHTTPSErrors: true }),
  });
  expect(blockedDevelopmentTls.status()).toBe(400);
  expect(await blockedDevelopmentTls.text()).toContain('cannot restrict it to one exact origin');
});

test('characterization: retired comparative publication fails closed without leaking credentials or unsafe uploads', async ({ page, request, playwright }) => {
  await page.goto('/runs.html');
  const portalBaseUrl = process.env.PORTAL_E2E_BASE_URL;
  if (!portalBaseUrl) throw new Error('PORTAL_E2E_BASE_URL is required for portal acceptance tests.');
  const syntheticKey = ['sk', 'ant', 'isolated-stage', '7'.repeat(40)].join('-');
  const savedCredential = await request.put('/api/settings/anthropic-key', { data: { apiKey: syntheticKey } });
  expect(savedCredential.status(), await savedCredential.text()).toBe(200);
  const parallelRequest = await playwright.request.newContext({
    baseURL: portalBaseUrl,
    extraHTTPHeaders: { 'X-Portal-Operator-Token': process.env.PORTAL_E2E_OPERATOR_TOKEN ?? '' },
  });
  const launchAttempts = await Promise.all([
    request.post('/api/runs', { data: runRequest({ auditIds: ['SEARCH-001'], aiReview: true }) }),
    parallelRequest.post('/api/runs', { data: runRequest({ auditIds: ['SEARCH-001'], aiReview: true }) }),
  ]);
  expect(launchAttempts.map((response) => response.status()).sort()).toEqual([202, 409]);
  const launch = launchAttempts.find((response) => response.status() === 202)!;
  const started = await launch.json();
  await page.goto(`/run.html?mode=comparative&run=${encodeURIComponent(started.id)}&view=logs`);
  await expect(page.locator('[data-run-destination="gallery"]')).toHaveAttribute(
    'href', `/gallery.html?mode=comparative&run=${started.id}&from=runs`,
  );
  expect(new URL(page.url()).searchParams.get('view')).toBe('logs');
  await expect(page.locator('#run-log-list')).toContainText(/Command started:/, { timeout: 60_000 });
  await expect(page.locator('#run-log-list')).toContainText(/AUDIT_(HTTP|STEP|TEST)/, { timeout: 120_000 });

  const finished = await waitForTerminal(request, started.id);
  expect(finished.pipeline).toMatchObject({ completed: false, status: 'failed' });
  expect(finished.release.decision).not.toBe('READY');
  expect(['failed', 'evidence-failed']).toContain(finished.status);
  expect(finished.stages.aiReview).toMatchObject({ status: 'failed' });
  expect(finished.stages.reportRebuild).toMatchObject({ status: 'failed' });
  const finalLogResponse = await request.get(`/api/runs/${encodeURIComponent(started.id)}/logs?maxBytes=1048576`);
  expect(finalLogResponse.ok()).toBeTruthy();
  const finalLog = (await finalLogResponse.json()).log as string;
  expect(finalLog).toContain('Execution identity: aiworker');
  expect(finalLog).toContain('Execution identity: reportworker');
  expect(finalLog).toContain('Comparative archive publication requires AUDIT_SHARED_STORE_ROOT');
  expect(finalLog).toContain('Comparative report rebuild requires AUDIT_SHARED_STORE_ROOT');
  expect(finalLog).not.toContain(syntheticKey);
  const aiReview = await request.get(`/artifacts/${encodeURIComponent(started.id)}/ai-review/review.json`);
  const aiReviewBody = await aiReview.text();
  expect(aiReview.status(), aiReviewBody).toBe(404);
  expect(aiReviewBody).not.toContain(syntheticKey);
  const deletedCredential = await request.delete('/api/settings/anthropic-key', { data: {} });
  expect(deletedCredential.status(), await deletedCredential.text()).toBe(200);

  const serverArtifactRoot = process.env.PORTAL_E2E_SERVER_ARTIFACT_ROOT;
  expect(serverArtifactRoot, 'The isolated portal test root must be provided by the Docker runner').toBeTruthy();
  const paginationFixture = join(serverArtifactRoot!, started.id, 'pagination-fixture');
  await mkdir(paginationFixture, { recursive: true });
  await Promise.all(Array.from({ length: 170 }, (_, index) =>
    writeFile(join(paginationFixture, `evidence-${String(index).padStart(3, '0')}.txt`), `fixture ${index}\n`)));
  const transientArtifactDirectory = join(serverArtifactRoot!, started.id, 'raw', '.playwright-artifacts-99');
  await mkdir(transientArtifactDirectory, { recursive: true });
  await writeFile(join(transientArtifactDirectory, 'page@recording.webm'), 'in-progress recording');
  await writeFile(join(serverArtifactRoot!, started.id, 'raw', 'unvalidated-helper-video.webm'), 'about:blank helper recording');
  await writeFile(join(serverArtifactRoot!, started.id, '.DS_Store'), 'Finder metadata');
  await new Promise((resolve) => setTimeout(resolve, 2_100));

  const artifactsResponse = await request.get(`/api/runs/${encodeURIComponent(started.id)}/artifacts`);
  expect(artifactsResponse.ok()).toBeTruthy();
  const artifactPage = await artifactsResponse.json();
  const artifacts = artifactPage.files as Array<{ kind: string; path: string; url: string }>;
  expect(artifacts.length).toBeLessThanOrEqual(150);
  expect(artifactPage.total).toBeGreaterThan(150);
  expect(artifactPage.hasMore).toBeTruthy();
  const secondPage = await (await request.get(`/api/runs/${encodeURIComponent(started.id)}/artifacts?offset=${artifactPage.nextOffset}&limit=150`)).json();
  expect(secondPage.files.length).toBeGreaterThan(0);
  expect(secondPage.offset).toBe(artifactPage.nextOffset);
  expect(artifacts.some(({ kind }) => kind === 'checklist')).toBeFalsy();
  const boundedArtifactPage = await (await request.get(`/api/runs/${encodeURIComponent(started.id)}/artifacts?offset=0&limit=500`)).json();
  const boundedArtifactPaths = boundedArtifactPage.files.map(({ path }: { path: string }) => path);
  expect(boundedArtifactPaths.some((path: string) => path.includes('.playwright-artifacts-'))).toBeFalsy();
  expect(boundedArtifactPaths.some((path: string) => path.endsWith('.DS_Store'))).toBeFalsy();
  expect(boundedArtifactPaths.some((path: string) => path.endsWith('unvalidated-helper-video.webm'))).toBeFalsy();
  const video = boundedArtifactPage.files.find(({ kind }: { kind: string }) => kind === 'video');
  expect(video, 'Release-profile portal acceptance must produce a playable video').toBeTruthy();
  const range = await request.get(video!.url, { headers: { Range: 'bytes=0-1023' } });
  expect(range.status()).toBe(206);
  expect(range.headers()['content-range']).toMatch(/^bytes 0-1023\//);

  const artifactRoot = process.env.PORTAL_E2E_SERVER_ARTIFACT_ROOT!;
  const outsideArtifact = join(artifactRoot, 'outside-run-secret.txt');
  const unsafeArtifact = join(artifactRoot, started.id, 'unsafe-artifact.txt');
  await writeFile(outsideArtifact, 'must not be served');
  await symlink(outsideArtifact, unsafeArtifact);
  expect((await request.get(`/artifacts/${started.id}/unsafe-artifact.txt`)).status()).toBe(404);
  await unlink(unsafeArtifact);
  await unlink(outsideArtifact);
  const disappearingArtifact = join(artifactRoot, started.id, 'disappearing-artifact.txt');
  await writeFile(disappearingArtifact, 'short lived');
  await unlink(disappearingArtifact);
  expect((await request.get(`/artifacts/${started.id}/disappearing-artifact.txt`)).status()).toBe(404);

  await page.goto(`/run.html?mode=comparative&run=${encodeURIComponent(started.id)}&view=evidence`);
  await expect(page.locator('#run-execution-state')).toContainText(/failed/i);
  await expect(page.locator('[data-run-destination="report"]')).toHaveAttribute('href', `/report.html?run=${started.id}`);
  await expect(page.locator('[data-run-destination="gallery"]')).toHaveAttribute('href', `/gallery.html?mode=comparative&run=${started.id}&from=runs`);
  expect(new URL(page.url()).searchParams.get('view')).toBe('evidence');
  await expect(page.locator('.run-artifact-list')).toContainText(/results\.json|video\.webm/);
  await expect(page.locator('[data-artifact-more]')).toBeVisible();
  const firstArtifactCount = await page.locator('.run-artifact-list li').count();
  await page.locator('[data-artifact-more]').click();
  await expect.poll(() => page.locator('.run-artifact-list li').count()).toBeGreaterThan(firstArtifactCount);

  const report = await request.get(`/api/runs/${encodeURIComponent(started.id)}/report`);
  expect([404, 409]).toContain(report.status());

  const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const unauthorizedUpload = await playwright.request.newContext({
    baseURL: portalBaseUrl,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Origin: portalBaseUrl },
  });
  const unauthorizedUploadResponse = await unauthorizedUpload.post(`/api/runs/${started.id}/manual-uploads?auditId=DEVICE-001&filename=unauthorized.png&idempotencyKey=manual-00000000-0000-4000-8000-000000000000`, {
    headers: { 'Content-Type': 'image/png' }, data: validPng,
  });
  expect(unauthorizedUploadResponse.status()).toBe(401);
  expect(await access(join(artifactRoot, started.id, 'manual-evidence')).then(() => true, () => false)).toBe(false);
  await unauthorizedUpload.dispose();
  const validPngUpload = await request.post(`/api/runs/${started.id}/manual-uploads?auditId=DEVICE-001&filename=valid-pixel.png&idempotencyKey=manual-00000000-0000-4000-8000-000000000001`, {
    headers: { 'Content-Type': 'image/png' }, data: validPng,
  });
  const validPngUploadBody = await validPngUpload.text();
  expect(validPngUpload.status(), validPngUploadBody).toBe(201);
  const validPngIdentity = JSON.parse(validPngUploadBody).id;
  const pngDirectory = join(artifactRoot, started.id, 'manual-evidence', 'DEVICE-001');
  const filesAfterFirstPng = await readdir(pngDirectory);
  const repeatedPngUpload = await request.post(`/api/runs/${started.id}/manual-uploads?auditId=DEVICE-001&filename=valid-pixel.png&idempotencyKey=manual-00000000-0000-4000-8000-000000000001`, {
    headers: { 'Content-Type': 'image/png' }, data: validPng,
  });
  const repeatedPngBody = await repeatedPngUpload.text();
  expect(repeatedPngUpload.status(), repeatedPngBody).toBe(200);
  expect(JSON.parse(repeatedPngBody)).toMatchObject({ id: validPngIdentity, replayed: true });
  expect(await readdir(pngDirectory)).toEqual(filesAfterFirstPng);
  const retainedWebm = await readFile(join(artifactRoot, started.id, ...video!.path.split('/')));
  const validWebmUpload = await request.post(`/api/runs/${started.id}/manual-uploads?auditId=DEVICE-001&filename=retained-interaction.webm&idempotencyKey=manual-00000000-0000-4000-8000-000000000002`, {
    headers: { 'Content-Type': 'video/webm' }, data: retainedWebm,
  });
  expect(validWebmUpload.status(), await validWebmUpload.text()).toBe(201);

  const fakePng = Buffer.alloc(8 * 1024 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fakePng);
  const invalidUploads = await Promise.all([
    request.post(`/api/runs/${started.id}/manual-uploads?auditId=DEVICE-001&filename=fake-one.png&idempotencyKey=manual-00000000-0000-4000-8000-000000000003`, {
      headers: { 'Content-Type': 'image/png' }, data: fakePng,
    }),
    parallelRequest.post(`/api/runs/${started.id}/manual-uploads?auditId=DEVICE-001&filename=fake-two.png&idempotencyKey=manual-00000000-0000-4000-8000-000000000004`, {
      headers: { 'Content-Type': 'image/png' }, data: fakePng,
    }),
  ]);
  expect(invalidUploads.map((response) => response.status()).sort()).toEqual([409, 422]);
  const manualUploadDirectory = join(artifactRoot, started.id, 'manual-evidence', 'DEVICE-001');
  const retainedUploads = await readdir(manualUploadDirectory).catch(() => []);
  expect(retainedUploads).toHaveLength(2);
  expect(retainedUploads.some((name) => name.includes('fake-') || name.endsWith('.uploading'))).toBeFalsy();

  await parallelRequest.dispose();
});

test('characterization: comparative stop and purge retain their endpoints and close both live streams', async ({ page, request }) => {
  const launch = await request.post('/api/runs', {
    data: runRequest({ auditIds: ['CONTENT-002'], targetIds: ['candidate-desktop-chromium'] }),
  });
  expect(launch.status(), await launch.text()).toBe(202);
  const started = await launch.json();
  expect(started.purge).toMatchObject({ eligible: false, confirmation: `PURGE ${started.id}` });
  const activePurge = await request.delete(`/api/runs/${encodeURIComponent(started.id)}`, {
    data: { confirmation: `PURGE ${started.id}` },
  });
  expect(activePurge.status()).toBe(409);
  expect(await activePurge.text()).toContain('Active runs cannot be purged');
  const stop = await request.post(`/api/runs/${encodeURIComponent(started.id)}/stop`, { data: {} });
  expect([202, 409]).toContain(stop.status());
  const finished = await waitForTerminal(request, started.id);
  expect(['stopped', 'review-required']).toContain(finished.status);
  expect(finished.release.decision).not.toBe('READY');
  expect(finished.purge).toMatchObject({ eligible: true, confirmation: `PURGE ${started.id}` });

  const wrongConfirmation = await request.delete(`/api/runs/${encodeURIComponent(started.id)}`, {
    data: { confirmation: started.id },
  });
  expect(wrongConfirmation.status()).toBe(400);
  expect(await wrongConfirmation.text()).toContain(`PURGE ${started.id}`);

  await page.goto('/runs.html');
  await page.evaluate(async (id) => {
    const testWindow = window as any;
    testWindow.__purgeStreamEvents = { run: [], gallery: [] };
    const connect = (kind: 'run' | 'gallery', path: string) => new Promise<void>((resolve) => {
      const source = new EventSource(path);
      testWindow.__purgeStreamSources ??= [];
      testWindow.__purgeStreamSources.push(source);
      source.addEventListener('snapshot', () => resolve());
      source.addEventListener('purged', () => testWindow.__purgeStreamEvents[kind].push('purged'));
    });
    await Promise.all([
      connect('run', `/api/runs/${encodeURIComponent(id)}/events`),
      connect('gallery', `/api/runs/${encodeURIComponent(id)}/gallery/events`),
    ]);
  }, started.id);

  const purged = await request.delete(`/api/runs/${encodeURIComponent(started.id)}`, {
    data: { confirmation: `PURGE ${started.id}` },
  });
  expect(purged.status(), await purged.text()).toBe(200);
  const reclaimed = await purged.json();
  expect(reclaimed).toMatchObject({
    id: started.id,
    purged: true,
    source: 'portal-managed',
    filesRemoved: expect.any(Number),
    logicalBytesRemoved: expect.any(Number),
  });
  expect(reclaimed.filesRemoved).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__purgeStreamEvents)).toEqual({ run: ['purged'], gallery: ['purged'] });
  await page.evaluate(() => (window as any).__purgeStreamSources?.forEach((source: EventSource) => source.close()));
  expect((await request.get(`/api/runs/${encodeURIComponent(started.id)}`)).status()).toBe(404);
  const portalRunPath = join(process.env.PORTAL_E2E_SERVER_ARTIFACT_ROOT!, started.id);
  expect(await access(portalRunPath).then(() => true, () => false)).toBe(false);
});

test('externally launched shards are discovered while active and retained with logs and artifacts', async ({ page, request }) => {
  const shardedRoot = process.env.PORTAL_E2E_SERVER_SHARDED_ARTIFACT_ROOT;
  expect(shardedRoot, 'The isolated external-shard root must be provided by the Docker runner').toBeTruthy();
  const id = `external-sharded-${Date.now()}`;
  const directory = join(shardedRoot!, id);
  const logDirectory = join(directory, 'logs');
  await mkdir(join(directory, 'checklist'), { recursive: true });
  await mkdir(logDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  await writeFile(join(logDirectory, 'coordinator.log'), [
    `${startedAt} [COORDINATOR] sharded-release-started ${JSON.stringify({ runId: id, shardTotal: 2, shardWorkers: '1', tlsPolicy: 'strict' })}`,
    `${startedAt} [COORDINATOR] command-started ${JSON.stringify({ label: 'BUILD', command: ['docker', 'compose', 'build'] })}`,
    `${startedAt} [COORDINATOR] command-finished ${JSON.stringify({ label: 'BUILD', command: ['docker', 'compose', 'build'], startedAt, finishedAt: startedAt, durationMs: 1, exitCode: 0, signal: null })}`,
    `${startedAt} [COORDINATOR] command-started ${JSON.stringify({ label: 'SHARD 1/2', command: ['docker', 'compose', 'run', 'shard-1'] })}`,
    `${startedAt} [COORDINATOR] command-started ${JSON.stringify({ label: 'SHARD 2/2', command: ['docker', 'compose', 'run', 'shard-2'] })}`,
    '',
  ].join('\n'));
  await writeFile(join(logDirectory, 'shard-1-of-2.log'), `${startedAt} [SHARD 1/2][stdout] Running 10 tests using 1 worker, shard 1 of 2\n`);
  await writeFile(join(logDirectory, 'shard-2-of-2.log'), `${startedAt} [SHARD 2/2][stdout] Running 9 tests using 1 worker, shard 2 of 2\n`);

  await expect.poll(async () => {
    const response = await request.get(`/api/runs/${encodeURIComponent(id)}`);
    return response.ok() ? (await response.json()).status : null;
  }, { timeout: 10_000 }).toBe('running');
  const active = await (await request.get(`/api/runs/${encodeURIComponent(id)}`)).json();
  expect(active).toMatchObject({
    externalManaged: true,
    source: 'external-sharded',
    status: 'running',
    progress: { total: 19 },
    stages: {
      build: { status: 'completed' },
      browserShards: { status: 'running' },
      shard1: { status: 'running' },
      shard2: { status: 'running' },
    },
  });
  const logs = await (await request.get(`/api/runs/${encodeURIComponent(id)}/logs`)).json();
  expect(logs.log).toContain('command-started');
  expect(logs.log).toContain('Running 10 tests');
  expect((await request.post(`/api/runs/${encodeURIComponent(id)}/stop`, { data: {} })).status()).toBe(409);

  const temporarilyMissingDirectory = `${shardedRoot}-temporarily-missing-${id}`;
  await rename(directory, temporarilyMissingDirectory);
  await expect.poll(async () => {
    const response = await request.get(`/api/runs/${encodeURIComponent(id)}`);
    return response.ok() ? await response.json() : null;
  }, { timeout: 10_000 }).toMatchObject({
    status: 'evidence-failed',
    pipeline: { status: 'failed', completed: false, reason: expect.stringContaining('disappeared') },
    release: { decision: 'UNAVAILABLE' },
    lifecycleDiagnostics: {
      source: 'external-artifact-directory',
      derivedStatus: 'pipeline-failed',
    },
  });
  await rename(temporarilyMissingDirectory, directory);
  await expect.poll(async () => {
    const response = await request.get(`/api/runs/${encodeURIComponent(id)}`);
    return response.ok() ? (await response.json()).status : null;
  }, { timeout: 10_000 }).toBe('running');

  const finishedAt = new Date().toISOString();
  const release = {
    decision: 'NOT_READY',
    ready: false,
    reason: 'Synthetic blocking finding for external discovery acceptance.',
    decisionBasis: 'Focused portal regression fixture.',
    blockingFailures: 1,
    blockingIncomplete: 0,
    baselineIssues: 0,
    runIntegrityFailure: false,
    source: 'checklist/manifest.json',
    evaluatedAt: finishedAt,
  };
  const lifecycleFixture = {
    schemaVersion: 2,
    runId: id,
    startedAt,
    finishedAt,
    shardTotal: 2,
    shardWorkers: 1,
    productionUrl: targets.productionUrl,
    candidateUrl: targets.candidateUrl,
    candidateIgnoreHTTPSErrors: false,
    build: { label: 'BUILD', command: ['docker', 'compose', 'build'], startedAt, finishedAt, durationMs: 1, exitCode: 0, signal: null },
    shards: [1, 2].map((index) => ({ index, label: `SHARD ${index}/2`, command: ['docker', 'compose', 'run', `shard-${index}`], startedAt, finishedAt, durationMs: 2, exitCode: index === 1 ? 1 : 0, signal: null })),
    performance: { label: 'PERFORMANCE', command: ['docker', 'compose', 'run', 'performance'], startedAt, finishedAt, durationMs: 2, exitCode: 0, signal: null },
    merge: { label: 'MERGE', command: ['docker', 'compose', 'run', 'merge'], startedAt, finishedAt, durationMs: 3, exitCode: 1, signal: null },
    mergePipeline: { status: 'completed', completed: true, reason: 'Synthetic merge evidence completed.', finishedAt },
  };
  await writeFile(join(directory, 'sharded-run.json'), `${JSON.stringify({
    ...lifecycleFixture,
    pipeline: { status: 'running', completed: false, reason: 'Synthetic contradictory lifecycle.', finishedAt: null },
    release,
    status: 'ready',
  }, null, 2)}\n`);
  await expect.poll(async () => {
    const response = await request.get(`/api/runs/${encodeURIComponent(id)}`);
    return response.ok() ? await response.json() : null;
  }, { timeout: 10_000 }).toMatchObject({
    status: 'evidence-failed',
    pipeline: { status: 'failed', completed: false, reason: expect.stringContaining('inconsistent') },
    release: { decision: 'NOT_READY' },
    lifecycleDiagnostics: {
      source: 'sharded-run.json',
      reportedStatus: 'ready',
      reportedReleaseDecision: 'NOT_READY',
      derivedStatus: 'pipeline-failed',
    },
  });

  const contradictoryReadyRelease = {
    ...release,
    decision: 'READY',
    ready: false,
    blockingFailures: 1,
    blockingIncomplete: 0,
    runIntegrityFailure: true,
    reason: 'Synthetic malformed READY release truth.',
  };
  await writeFile(join(directory, 'sharded-run.json'), `${JSON.stringify({
    ...lifecycleFixture,
    pipeline: { status: 'completed', completed: true, reason: 'Synthetic completed pipeline with malformed release.', finishedAt },
    release: contradictoryReadyRelease,
    status: 'ready',
  }, null, 2)}\n`);
  await expect.poll(async () => {
    const response = await request.get(`/api/runs/${encodeURIComponent(id)}`);
    return response.ok() ? await response.json() : null;
  }, { timeout: 10_000 }).toMatchObject({
    status: 'evidence-failed',
    pipeline: { status: 'failed', completed: false, reason: expect.stringContaining('release truth is invalid') },
    release: { decision: 'UNAVAILABLE' },
    lifecycleDiagnostics: {
      source: 'sharded-run.json',
      reportedStatus: 'ready',
      reportedReleaseDecision: 'READY',
      reportedRelease: { ready: false, blockingFailures: 1, runIntegrityFailure: true },
      releaseValidationError: expect.stringContaining('contradicts'),
      derivedStatus: 'pipeline-failed',
    },
  });

  await writeFile(join(directory, 'sharded-run.json'), `${JSON.stringify({
    ...lifecycleFixture,
    pipeline: { status: 'completed', completed: true, reason: 'Synthetic external pipeline completed.', finishedAt },
    release,
    status: 'not-ready',
  }, null, 2)}\n`);
  await writeFile(join(directory, 'checklist', 'index.html'), '<!doctype html><title>External checklist</title>');
  await writeFile(join(directory, 'checklist', 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, generatedAt: finishedAt, release })}\n`);
  await writeFile(join(directory, 'results.json'), '{"suites":[]}\n');
  await mkdir(join(directory, 'checklist', 'data', 'audits'), { recursive: true });
  const reportPublicationRevision = 'abcdef0123456789abcdef0123456789';
  const compactSummary = {
    schemaVersion: 1,
    publicationRevision: reportPublicationRevision,
    generatedAt: finishedAt,
    release,
    summary: { total: 2, byStatus: { PASS: 1, MANUAL_REQUIRED: 1 } },
  };
  const compactAudits = {
    schemaVersion: 1,
    publicationRevision: reportPublicationRevision,
    generatedAt: finishedAt,
    items: [
      { id: 'ENV-001', title: 'Environment availability', status: 'PASS', severity: 'P0', area: 'environment', environments: ['candidate'], releaseBlocking: true, manual: false },
      { id: 'DEVICE-001', title: 'Real iPhone acceptance', status: 'MANUAL_REQUIRED', severity: 'P0', area: 'responsive', environments: ['candidate'], releaseBlocking: true, manual: true },
    ],
  };
  const compactDocuments = new Map([
    ['summary.json', `${JSON.stringify(compactSummary)}\n`],
    ['audits.json', `${JSON.stringify(compactAudits)}\n`],
    ['audits/ENV-001.json', `${JSON.stringify({ schemaVersion: 1, publicationRevision: reportPublicationRevision, generatedAt: finishedAt, id: 'ENV-001', title: 'Environment availability', status: 'PASS', evidence: [] })}\n`],
    ['audits/DEVICE-001.json', `${JSON.stringify({ schemaVersion: 1, publicationRevision: reportPublicationRevision, generatedAt: finishedAt, id: 'DEVICE-001', title: 'Real iPhone acceptance', status: 'MANUAL_REQUIRED', evidence: [] })}\n`],
  ]);
  const compactRevisionDirectory = join(directory, 'checklist', 'data', 'revisions', reportPublicationRevision);
  await mkdir(join(compactRevisionDirectory, 'audits'), { recursive: true });
  await Promise.all([...compactDocuments].flatMap(([path, source]) => [
    writeFile(join(compactRevisionDirectory, path), source),
    writeFile(join(directory, 'checklist', 'data', path), source),
  ]));
  const compactPublication = `${JSON.stringify({
    schemaVersion: 1,
    publicationRevision: reportPublicationRevision,
    generatedAt: finishedAt,
    files: Object.fromEntries([...compactDocuments].map(([path, source]) => [path, {
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
    }])),
  })}\n`;
  await Promise.all([
    writeFile(join(compactRevisionDirectory, 'publication.json'), compactPublication),
    writeFile(join(directory, 'checklist', 'data', 'current.json'), compactPublication),
  ]);

  const mergeLog = await open(join(logDirectory, 'merge.log'), 'w');
  const sparseLogBytes = 32 * 1024 * 1024;
  await mergeLog.truncate(sparseLogBytes);
  const unicodeSuffix = Buffer.from(`\n${finishedAt} [MERGE][stdout] bounded tail remains readable ✅\n`, 'utf8');
  await mergeLog.write(unicodeSuffix, 0, unicodeSuffix.length, sparseLogBytes);
  await mergeLog.close();
  const largeVideo = await open(join(directory, 'large-evidence.webm'), 'w');
  await largeVideo.truncate(64 * 1024 * 1024);
  await largeVideo.close();
  const zeroBlock = Buffer.alloc(1024 * 1024);
  const largeVideoHash = createHash('sha256');
  for (let block = 0; block < 64; block += 1) largeVideoHash.update(zeroBlock);
  await writeFile(join(directory, 'large-evidence-poster.jpg'), 'synthetic poster');
  await writeFile(join(directory, 'video-manifest.json'), `${JSON.stringify({
    schemaVersion: 2,
    videoCount: 1,
    processedCount: 1,
    usableInteractionVideoCount: 1,
    diagnosticVideoCount: 0,
    failedCount: 0,
    unavailableCount: 0,
    retention: { integrityErrors: [] },
    videos: [{
      video: 'large-evidence.webm',
      bytes: 64 * 1024 * 1024,
      sha256: largeVideoHash.digest('hex'),
      evidenceRole: 'usable-interaction',
      poster: 'large-evidence-poster.jpg',
      posterBytes: Buffer.byteLength('synthetic poster'),
      processingStatus: 'created',
    }],
  })}\n`);

  let completed: Record<string, any> | null = null;
  let completionResponse = '';
  const completionStarted = Date.now();
  while (Date.now() - completionStarted < 10_000) {
    const response = await request.get(`/api/runs/${encodeURIComponent(id)}`);
    completionResponse = await response.text();
    completed = response.ok() ? JSON.parse(completionResponse) : null;
    if (completed?.status === 'not-ready') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(completed?.status, `External lifecycle did not settle. Last response: ${completionResponse}`).toBe('not-ready');
  expect(completed).toMatchObject({
    externalManaged: true,
    status: 'not-ready',
    pipeline: { completed: true, status: 'completed' },
    release: { decision: 'NOT_READY' },
    stages: {
      performanceIsolation: { status: 'completed', exitCode: 0 },
      merge: { status: 'completed', exitCode: 1 },
    },
  });

  const logStarted = Date.now();
  const boundedLogsResponse = await request.get(`/api/runs/${encodeURIComponent(id)}/logs?maxBytes=65536`);
  expect(boundedLogsResponse.ok()).toBeTruthy();
  expect(Date.now() - logStarted).toBeLessThan(5_000);
  const boundedLogs = await boundedLogsResponse.json();
  expect(boundedLogs).toMatchObject({ maxBytes: 65_536, truncated: true });
  expect(boundedLogs.bytes).toBeLessThanOrEqual(65_536);
  expect(boundedLogs.log).toContain('bounded tail remains readable ✅');
  expect(boundedLogs.log).not.toContain('�');
  expect(Number(boundedLogsResponse.headers()['content-length'])).toBeLessThan(80_000);

  const reportSummary = await (await request.get(`/api/runs/${encodeURIComponent(id)}/report`)).json();
  expect(reportSummary.release.decision).toBe('NOT_READY');
  expect(reportSummary.publicationRevision).toBe(reportPublicationRevision);
  const manualAudits = await (await request.get(`/api/runs/${encodeURIComponent(id)}/report/audits?manual=true&limit=25&revision=${reportPublicationRevision}`)).json();
  expect(manualAudits).toMatchObject({ publicationRevision: reportPublicationRevision, total: 1, hasMore: false, filters: { manual: true } });
  expect(manualAudits.items[0].id).toBe('DEVICE-001');
  const auditDetail = await (await request.get(`/api/runs/${encodeURIComponent(id)}/report/audits/ENV-001?revision=${reportPublicationRevision}`)).json();
  expect(auditDetail).toMatchObject({ publicationRevision: reportPublicationRevision, id: 'ENV-001', status: 'PASS' });
  expect((await request.get(`/api/runs/${encodeURIComponent(id)}/report/audits?revision=wrong`)).status()).toBe(400);

  const artifacts = await (await request.get(`/api/runs/${encodeURIComponent(id)}/artifacts`)).json();
  const checklist = artifacts.files.find((file: { kind: string }) => file.kind === 'checklist');
  expect(checklist).toBeTruthy();
  expect((await request.get(checklist.url)).status()).toBe(200);
  const video = artifacts.files.find((file: { path: string }) => file.path === 'large-evidence.webm');
  expect(video).toMatchObject({ bytes: 64 * 1024 * 1024, kind: 'video' });
  const videoRange = await request.get(video.url, { headers: { Range: 'bytes=0-1023' } });
  expect(videoRange.status()).toBe(206);
  expect(videoRange.headers()['content-length']).toBe('1024');

  await page.goto(`/runs.html?inspector=open&mode=comparative&run=${encodeURIComponent(id)}`);
  const comparativeTitle = `${new URL(targets.productionUrl).host} → ${new URL(targets.candidateUrl).host}`;
  await expect(page.getByRole('heading', { name: comparativeTitle })).toBeVisible();
  const workspace = page.getByRole('link', { name: 'Open run workspace' });
  await expect(workspace).toHaveAttribute('href', `/run.html?mode=comparative&run=${id}&view=overview`);
  await workspace.click();
  await expect(page.locator('#run-id')).toHaveText(id);
  await expect(page.locator('[data-run-action="purge"]')).toBeVisible();
  await page.locator('[data-run-view-link="timeline"]').click();
  const findingShard = page.locator('.run-timeline-list li').filter({ hasText: /shard1|shard 1/i });
  await expect(findingShard).toContainText(/completed/i);

  const heldDirectory = join(shardedRoot!, `.${id}.held`);
  await rename(directory, heldDirectory);
  await symlink(heldDirectory, directory, 'dir');
  const symlinkPurge = await request.delete(`/api/runs/${encodeURIComponent(id)}`, {
    data: { confirmation: `PURGE ${id}` },
  });
  expect(symlinkPurge.status()).toBe(409);
  expect(await symlinkPurge.text()).toContain('not a real directory');
  expect(await access(join(heldDirectory, 'sharded-run.json')).then(() => true, () => false)).toBe(true);
  await unlink(directory);
  await rename(heldDirectory, directory);

  await page.locator('[data-run-action="purge"]').click();
  await expect(page.locator('#run-action-dialog')).toBeVisible();
  await expect(page.locator('[data-action-submit]')).toBeDisabled();
  await page.locator('#run-action-confirmation').fill(id);
  await expect(page.locator('[data-action-submit]')).toBeDisabled();
  await page.locator('#run-action-confirmation').fill(`PURGE ${id}`);
  await expect(page.locator('[data-action-submit]')).toBeEnabled();
  await page.locator('[data-action-submit]').click();
  await expect(page.getByRole('heading', { name: 'Run evidence purged' })).toBeVisible();
  expect((await request.get(`/api/runs/${encodeURIComponent(id)}`)).status()).toBe(404);
  expect(await access(directory).then(() => true, () => false)).toBe(false);
});
