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

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  }));
  return results;
}

export function extractSitemapLocations(xml: string): string[] {
  const locations = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => match[1]!
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .trim());
  return [...new Set(locations)];
}

function reviveAstroValue(value: unknown): unknown {
  if (!Array.isArray(value)) {
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, reviveAstroValue(child)]));
  }
  if (value.length === 1 && value[0] === 0) return undefined;
  if (value.length === 2 && typeof value[0] === 'number') {
    const [tag, payload] = value;
    if (tag === 0) {
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return Object.fromEntries(Object.entries(payload).map(([key, child]) => [key, reviveAstroValue(child)]));
      }
      return payload;
    }
    if (tag === 1 && Array.isArray(payload)) return payload.map(reviveAstroValue);
    if (tag === 2 && typeof payload === 'string') return new RegExp(payload);
    if (tag === 3 && typeof payload === 'string') return new Date(payload);
    if (tag === 4 && Array.isArray(payload)) return new Map(payload.map(reviveAstroValue) as Array<[unknown, unknown]>);
    if (tag === 5 && Array.isArray(payload)) return new Set(payload.map(reviveAstroValue));
    if (tag === 6 && typeof payload === 'string') return BigInt(payload);
    if (tag === 7 && typeof payload === 'string') return new URL(payload);
    if (tag === 8 && Array.isArray(payload)) return new Uint8Array(payload as number[]);
    if (tag === 9 && Array.isArray(payload)) return new Uint16Array(payload as number[]);
    if (tag === 10 && Array.isArray(payload)) return new Uint32Array(payload as number[]);
    if (tag === 11 && (payload === 1 || payload === -1)) return payload * Number.POSITIVE_INFINITY;
  }
  return value.map(reviveAstroValue);
}

/** Read the immutable server-serialized input to a hydrated Astro component. */
export function decodeAstroSerializedProps(raw: string): Record<string, unknown> {
  return reviveAstroValue(JSON.parse(raw)) as Record<string, unknown>;
}

export async function readAstroComponentProp<T>(page: Page, componentName: string, propName: string): Promise<T> {
  const island = page.locator(`astro-island[component-url*="${componentName}"]`).first();
  const raw = await island.getAttribute('props');
  if (!raw) throw new Error(`Astro component ${componentName} did not expose serialized props.`);
  const decoded = decodeAstroSerializedProps(raw);
  if (!(propName in decoded)) throw new Error(`Astro component ${componentName} is missing prop ${propName}.`);
  return decoded[propName] as T;
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
  options: { timeoutMs?: number } = {},
): Promise<HtmlDestinationEvidence> {
  const timeout = options.timeoutMs ?? 8_000;
  const requested = new URL(url, audit.environmentBaseURL());
  const initial = await loggedGet(request, audit, requested.href, { maxRedirects: 0, timeout });
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

  const final = await loggedGet(request, audit, redirected.href, { maxRedirects: 0, timeout });
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
