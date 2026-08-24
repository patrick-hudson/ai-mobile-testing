import type { APIRequestContext, APIResponse, Page, TestInfo } from '@playwright/test';
import { projectMetadata } from '../audit/environments.js';
import type { AuditRun } from '../fixtures/test.js';

export function meta(testInfo: TestInfo) {
  return projectMetadata(testInfo.project.metadata);
}

export function isCandidate(testInfo: TestInfo): boolean {
  return meta(testInfo).environment === 'candidate';
}

export function isPrimary(testInfo: TestInfo): boolean {
  return testInfo.project.name === 'candidate-mobile-chromium' || testInfo.project.name === 'candidate-desktop-chromium';
}

export async function dismissSchedulingNotice(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /dismiss announcement/i });
  if (await button.isVisible().catch(() => false)) await button.click();
}

export async function waitForSettledUI(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if ('fonts' in document) await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

export async function pageHasHorizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

export async function loggedGet(
  request: APIRequestContext,
  audit: AuditRun,
  url: string,
  options: Parameters<APIRequestContext['get']>[1] = {},
): Promise<APIResponse> {
  const startedAt = Date.now();
  if (process.env.AUDIT_VERBOSE === '1') {
    process.stdout.write(`${new Date().toISOString()} [AUDIT_HTTP_REQUEST] ${JSON.stringify({ method: 'GET', url })}\n`);
  }
  const response = await request.get(url, options);
  audit.recordApiResponse(response, 'GET', Date.now() - startedAt);
  return response;
}

export interface HtmlDestinationEvidence {
  requestedUrl: string;
  initialStatus: number;
  redirectLocation: string | null;
  finalUrl: string;
  finalStatus: number | null;
  contentType: string | null;
  valid: boolean;
  issue: string | null;
}

export async function inspectHtmlDestination(
  request: APIRequestContext,
  audit: AuditRun,
  url: string,
): Promise<HtmlDestinationEvidence> {
  const requested = new URL(url, audit.environmentBaseURL());
  const initial = await loggedGet(request, audit, requested.href, { maxRedirects: 0 });
  const initialContentType = initial.headers()['content-type'] ?? null;
  if (initial.status() === 200) {
    const valid = Boolean(initialContentType?.includes('text/html'));
    return {
      requestedUrl: requested.href,
      initialStatus: initial.status(),
      redirectLocation: null,
      finalUrl: requested.href,
      finalStatus: initial.status(),
      contentType: initialContentType,
      valid,
      issue: valid ? null : 'The destination did not return HTML.',
    };
  }

  const redirectLocation = initial.headers().location ?? null;
  if (![301, 308].includes(initial.status()) || !redirectLocation) {
    return {
      requestedUrl: requested.href,
      initialStatus: initial.status(),
      redirectLocation,
      finalUrl: requested.href,
      finalStatus: null,
      contentType: initialContentType,
      valid: false,
      issue: 'The destination returned neither HTML nor a permanent canonical redirect.',
    };
  }

  const redirected = new URL(redirectLocation, requested);
  const sameCanonicalPath = redirected.origin === requested.origin
    && redirected.pathname.replace(/\/$/, '') === requested.pathname.replace(/\/$/, '')
    && redirected.search === requested.search
    && redirected.hash === '';
  if (!sameCanonicalPath) {
    return {
      requestedUrl: requested.href,
      initialStatus: initial.status(),
      redirectLocation,
      finalUrl: redirected.href,
      finalStatus: null,
      contentType: null,
      valid: false,
      issue: 'The redirect is not a same-origin canonical trailing-slash redirect.',
    };
  }

  const final = await loggedGet(request, audit, redirected.href, { maxRedirects: 0 });
  const contentType = final.headers()['content-type'] ?? null;
  const valid = final.status() === 200 && Boolean(contentType?.includes('text/html'));
  return {
    requestedUrl: requested.href,
    initialStatus: initial.status(),
    redirectLocation,
    finalUrl: redirected.href,
    finalStatus: final.status(),
    contentType,
    valid,
    issue: valid ? null : 'The canonical redirect destination did not return HTTP 200 HTML.',
  };
}
