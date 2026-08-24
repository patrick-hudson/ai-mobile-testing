import { expect, test, type APIRequestContext } from '@playwright/test';
import { access, mkdir, open, readFile, readdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
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

test('portal renders the complete launch surface and asynchronous loading state', async ({ page }) => {
  await page.route('**/api/runs', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 400));
    return route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /release audit/i })).toBeVisible();
  await expect(page.locator('#catalog-summary')).toContainText('81 documented checks');
  await expect(page.locator('#project-options input[name="targetId"]')).toHaveCount(18);
  await expect(page.locator('#project-options input[name="targetId"]:checked')).toHaveCount(7);
  await expect(page.locator('#project-options input[name="targetId"]:disabled')).toHaveCount(5);
  await expect(page.locator('#plugin-options input')).toHaveCount(5);
  await expect(page.locator('#audit-options input')).toHaveCount(81);
  await expect(page.locator('#runs-panel')).toHaveAttribute('aria-busy', 'false');
  const refreshedRuns = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/runs';
  });
  await page.locator('#refresh-runs').click();
  await expect(page.locator('#runs-panel')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#refresh-runs')).toBeDisabled();
  await expect(page.locator('#refresh-runs')).toHaveText('Refreshing…');
  await refreshedRuns;
  await expect(page.locator('#runs-panel')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#refresh-runs')).toBeEnabled();
  await expect(page.locator('#refresh-runs')).toHaveText('Refresh');
});

test('reviewer report has bounded loading, empty, and terminal error states without fetching raw evidence', async ({ page }) => {
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
  await expect(page.locator('#top-findings')).toContainText(/no structured findings/i);
  await expect(page.locator('#audit-list')).toContainText(/no checks match/i);
  expect(requestedUrls.some((url) => url.endsWith('/checklist/manifest.json'))).toBeFalsy();
  expect(requestedUrls.some((url) => url.includes('/logs'))).toBeFalsy();
  expect(requestedUrls.some((url) => url.includes('revision=11111111111111111111111111111111'))).toBeTruthy();

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

  await page.route('**/api/runs/missing-report-demo', (route) => route.fulfill({ json: { ...run, id: 'missing-report-demo' } }));
  await page.route('**/api/runs/missing-report-demo/report', (route) => route.fulfill({ status: 404, json: { error: 'Compact report not found.' } }));
  await page.goto('/report.html?run=missing-report-demo');
  await expect(page.locator('#report-error-title')).toHaveText('No reviewer report is available');
  await expect(page.locator('#report-error-message')).toContainText(/finished without a compact reviewer report/i);
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
    summary: { total: 81, executed: 81, structuredExecutions: 81, artifacts: 81, videos: 10, posters: 10, baselineIssues: 0, byStatus: { PASS: 81 }, bySeverity: { P0: 81 } },
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

test('credential vault UI saves, reloads, fingerprints, and deletes without returning plaintext', async ({ page }) => {
  const syntheticKey = ['sk', 'ant', 'portal-e2e', '0'.repeat(40)].join('-');
  await page.goto('/');
  await page.locator('#anthropic-key-input').fill(syntheticKey);
  await page.locator('#save-anthropic-key').click();
  await expect(page.locator('#anthropic-key-message')).toContainText(/saved/i);
  await expect(page.locator('#anthropic-key-input')).toHaveValue('');

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

  await page.reload();
  await expect(page.locator('#anthropic-key-state')).toContainText(/configured/i);
  await page.locator('#delete-anthropic-key').click();
  await page.locator('#delete-anthropic-key').click();
  await expect(page.locator('#anthropic-key-message')).toContainText(/deleted/i);
  expect(await (await page.request.get('/api/settings/anthropic-key')).json()).toMatchObject({
    configured: false, fingerprint: null, storageEnabled: true, unavailableReason: null,
  });
});

test('mutation security and production certificate guards fail closed', async ({ request, playwright }) => {
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
  expect(await blockedTls.text()).toContain('cannot be used for the production origin');
});

test('targeted portal run streams verbose evidence and cannot report a false release pass', async ({ page, request, playwright }) => {
  await page.goto('/');
  const portalBaseUrl = process.env.PORTAL_E2E_BASE_URL;
  if (!portalBaseUrl) throw new Error('PORTAL_E2E_BASE_URL is required for portal acceptance tests.');
  const syntheticKey = ['sk', 'ant', 'isolated-stage', '7'.repeat(40)].join('-');
  const savedCredential = await request.put('/api/settings/anthropic-key', { data: { apiKey: syntheticKey } });
  expect(savedCredential.status(), await savedCredential.text()).toBe(200);
  const parallelRequest = await playwright.request.newContext({ baseURL: portalBaseUrl });
  const launchAttempts = await Promise.all([
    request.post('/api/runs', { data: runRequest({ auditIds: ['SEARCH-001'], aiReview: true }) }),
    parallelRequest.post('/api/runs', { data: runRequest({ auditIds: ['SEARCH-001'], aiReview: true }) }),
  ]);
  expect(launchAttempts.map((response) => response.status()).sort()).toEqual([202, 409]);
  const launch = launchAttempts.find((response) => response.status() === 202)!;
  const started = await launch.json();
  await page.reload();
  await expect(page.locator(`a.run-gallery-link[aria-label*="${started.id}"]`)).toHaveAttribute(
    'href', `/gallery.html?run=${started.id}&from=runs`,
  );
  await page.locator('#run-list .run-card-button').first().click();
  await expect(page.locator('#live-log')).toContainText(/Command started:/, { timeout: 60_000 });
  await expect(page.locator('#live-log')).toContainText(/AUDIT_(HTTP|STEP|TEST)/, { timeout: 120_000 });

  const finished = await waitForTerminal(request, started.id);
  expect(finished.pipeline).toMatchObject({ completed: true, status: 'completed' });
  expect(finished.release.decision).toBe('NOT_READY');
  expect(finished.status).toBe('not-ready');
  expect(finished.stages.aiReview).toMatchObject({ status: 'completed' });
  expect(finished.reviewReasons.join(' ')).toMatch(/selected scope|cannot certify|targeted|manual|not ready|incomplete/i);
  const finalLogResponse = await request.get(`/api/runs/${encodeURIComponent(started.id)}/logs?maxBytes=1048576`);
  expect(finalLogResponse.ok()).toBeTruthy();
  const finalLog = (await finalLogResponse.json()).log as string;
  expect(finalLog).toContain('Execution identity: aiworker');
  expect(finalLog).toContain('Execution identity: reportworker');
  expect(finalLog).toContain('Privately staged checklist published atomically.');
  expect(finalLog).not.toContain(syntheticKey);
  const aiReview = await request.get(`/artifacts/${encodeURIComponent(started.id)}/ai-review/review.json`);
  const aiReviewBody = await aiReview.text();
  expect(aiReview.status(), aiReviewBody).toBe(200);
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
  expect(artifacts.some(({ kind }) => kind === 'checklist')).toBeTruthy();
  const boundedArtifactPage = await (await request.get(`/api/runs/${encodeURIComponent(started.id)}/artifacts?offset=0&limit=500`)).json();
  const boundedArtifactPaths = boundedArtifactPage.files.map(({ path }: { path: string }) => path);
  expect(boundedArtifactPaths.some((path: string) => path.includes('.playwright-artifacts-'))).toBeFalsy();
  expect(boundedArtifactPaths.some((path: string) => path.endsWith('.DS_Store'))).toBeFalsy();
  expect(boundedArtifactPaths.some((path: string) => path.endsWith('unvalidated-helper-video.webm'))).toBeFalsy();
  const video = artifacts.find(({ kind }) => kind === 'video');
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

  await page.reload();
  await page.locator('#run-list .run-card-button').first().click();
  await expect(page.locator('#dialog-status')).toContainText(/review|required|not ready/i);
  await expect(page.locator('#open-run-report')).toBeVisible();
  await expect(page.locator('#open-run-gallery')).toHaveAttribute('href', `/gallery.html?run=${started.id}&from=runs`);
  await expect(page.locator('#open-checklist')).toBeVisible();
  await expect(page.locator('#open-checklist')).toHaveAttribute('download', `${started.id}-complete-checklist.json`);
  await expect(page.locator('#open-checklist')).toHaveAttribute('href', /\/checklist\/manifest\.json$/);
  await expect(page.locator('#load-more-artifacts')).toBeVisible();
  await page.locator('#load-more-artifacts').click();
  await expect(page.locator('#artifact-status')).toContainText(/files indexed|of \d+ files/);

  const reportRequests: string[] = [];
  page.on('request', (request) => reportRequests.push(request.url()));
  await page.goto(`/report.html?run=${encodeURIComponent(started.id)}`);
  await expect(page.locator('#visual-gallery-link')).toHaveAttribute('href', `/gallery.html?run=${started.id}&from=report`);
  await expect(page.locator('#decision-title')).toContainText(/not ready/i);
  await expect(page.locator('#metric-grid')).toContainText('Structured executions');
  await expect(page.locator('#audit-result-count')).toContainText(/matching checks/i);
  expect(reportRequests.some((url) => url.endsWith('/checklist/manifest.json'))).toBeFalsy();
  expect(reportRequests.some((url) => url.includes('/logs'))).toBeFalsy();
  await page.locator('#filter-query').fill('SEARCH-001');
  await expect(page.locator('#audit-result-count')).toContainText('1–1 of 1 matching checks');
  const searchAudit = page.locator('.report-audit-card').filter({ hasText: 'SEARCH-001' });
  await searchAudit.locator('.audit-summary-button').click();
  const expandedAudit = page.locator('.audit-detail:not([hidden])');
  await expect(expandedAudit).toContainText(/expected behavior/i);
  await expect(expandedAudit).toContainText(/evidence policy/i);
  await expandedAudit.locator('.execution-card summary').first().click();
  const expandedExecution = expandedAudit.locator('.execution-card[open] .execution-body');
  await expect(expandedExecution).toContainText(/HTTP responses/i);
  await expect(expandedExecution.locator('video')).toHaveAttribute('preload', 'metadata');
  await expect(expandedExecution).toContainText(/interaction video/i);
  await page.locator('#load-log').click();
  await expect(page.locator('#report-log')).toContainText(/Command started:/);
  expect(reportRequests.filter((url) => url.includes('/logs?maxBytes=65536')).length).toBe(1);

  const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const validPngUpload = await request.post(`/api/runs/${started.id}/manual-uploads?auditId=DEVICE-001&filename=valid-pixel.png`, {
    headers: { 'Content-Type': 'image/png' }, data: validPng,
  });
  expect(validPngUpload.status(), await validPngUpload.text()).toBe(201);
  const retainedWebm = await readFile(join(artifactRoot, started.id, ...video!.path.split('/')));
  const validWebmUpload = await request.post(`/api/runs/${started.id}/manual-uploads?auditId=DEVICE-001&filename=retained-interaction.webm`, {
    headers: { 'Content-Type': 'video/webm' }, data: retainedWebm,
  });
  expect(validWebmUpload.status(), await validWebmUpload.text()).toBe(201);

  const fakePng = Buffer.alloc(8 * 1024 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fakePng);
  const invalidUploads = await Promise.all([
    request.post(`/api/runs/${started.id}/manual-uploads?auditId=DEVICE-001&filename=fake-one.png`, {
      headers: { 'Content-Type': 'image/png' }, data: fakePng,
    }),
    parallelRequest.post(`/api/runs/${started.id}/manual-uploads?auditId=DEVICE-001&filename=fake-two.png`, {
      headers: { 'Content-Type': 'image/png' }, data: fakePng,
    }),
  ]);
  expect(invalidUploads.map((response) => response.status()).sort()).toEqual([409, 422]);
  const manualUploadDirectory = join(artifactRoot, started.id, 'manual-evidence', 'DEVICE-001');
  const retainedUploads = await readdir(manualUploadDirectory).catch(() => []);
  expect(retainedUploads).toHaveLength(2);
  expect(retainedUploads.some((name) => name.includes('fake-') || name.endsWith('.uploading'))).toBeFalsy();

  const attestation = {
    auditId: 'DEVICE-001', outcome: 'blocked', reviewer: 'Portal E2E', device: 'Synthetic concurrency fixture',
    notes: 'Concurrent attestation fixture verifies that one checklist rebuild owns the run mutation lock.',
    uploadIds: [], confirmed: true,
  };
  const attestations = await Promise.all([
    request.post(`/api/runs/${started.id}/manual-evidence`, { data: attestation }),
    parallelRequest.post(`/api/runs/${started.id}/manual-evidence`, { data: attestation }),
  ]);
  expect(attestations.map((response) => response.status()).sort()).toEqual([201, 409]);
  await parallelRequest.dispose();
});

test('active work can be stopped and purge closes both live event streams', async ({ page, request }) => {
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

  await page.goto('/');
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

  await page.goto('/');
  await expect(page.locator('#run-list')).toContainText('External sharded release');
  await page.locator('#run-list .run-card-button').first().click();
  await expect(page.locator('#dialog-status')).toContainText(id);
  await expect(page.locator('#purge-run')).toBeVisible();

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

  await page.locator('#purge-run').click();
  await expect(page.locator('#purge-confirmation')).toBeVisible();
  await expect(page.locator('#confirm-purge')).toBeDisabled();
  await page.locator('#purge-confirmation-input').fill(id);
  await expect(page.locator('#confirm-purge')).toBeDisabled();
  await page.locator('#purge-confirmation-input').fill(`PURGE ${id}`);
  await expect(page.locator('#confirm-purge')).toBeEnabled();
  await page.locator('#confirm-purge').click();
  await expect(page.locator('#run-dialog')).not.toBeVisible();
  await expect(page.locator('#runs-status')).toContainText(/removed|deleted/i);
  expect((await request.get(`/api/runs/${encodeURIComponent(id)}`)).status()).toBe(404);
  expect(await access(directory).then(() => true, () => false)).toBe(false);
});
