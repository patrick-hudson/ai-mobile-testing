import type { APIRequestContext, APIResponse, Page, TestInfo } from '@playwright/test';
import { parseAuditProjectMetadata, projectMetadata } from '../audit/environments.js';
import type { AuditProjectMetadata, DeploymentRole } from '../audit/types.js';
import type { AuditRun } from '../fixtures/test.js';

export function meta(testInfo: TestInfo) {
  return projectMetadata(testInfo.project.metadata);
}

export function auditMeta(testInfo: TestInfo): AuditProjectMetadata {
  return parseAuditProjectMetadata(testInfo.project.metadata);
}

/** True when the case should validate the reviewed current-site contract. */
export function usesReviewedSiteContract(testInfo: TestInfo): boolean {
  const metadata = auditMeta(testInfo);
  return metadata.mode === 'single-site' || metadata.environment === 'candidate';
}

export function auditDeploymentRole(testInfo: TestInfo): DeploymentRole {
  const metadata = auditMeta(testInfo);
  if (metadata.mode === 'single-site') return metadata.deploymentRole;
  return metadata.environment === 'candidate' ? 'preview' : 'production';
}

export function auditTargetTemplateId(testInfo: TestInfo): string {
  const metadata = auditMeta(testInfo);
  return metadata.mode === 'single-site' ? metadata.sourceComparativeTargetId : testInfo.project.name;
}

export function matchesAuditTargetTemplate(testInfo: TestInfo, sourceComparativeTargetId: string): boolean {
  return auditTargetTemplateId(testInfo) === sourceComparativeTargetId;
}

export function isChromiumAuditProject(testInfo: TestInfo): boolean {
  return auditTargetTemplateId(testInfo).includes('chromium');
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

export interface SkipLinkEntryEvidence {
  beforeScrollY: number;
  afterScrollY: number;
  hash: string;
  targetMatchesFragment: boolean;
  targetInViewport: boolean;
  targetRect: { top: number; right: number; bottom: number; left: number; width: number; height: number };
  focusWithinMain: boolean;
  focusedInViewport: boolean;
  focusedUnoccluded: boolean;
  focusedUsesFocusVisible: boolean;
  focusedRect: { top: number; right: number; bottom: number; left: number; width: number; height: number } | null;
  focusedElement: { tag: string; id: string; label: string; href: string | null };
}

/**
 * Activate an already-focused skip link and prove the browser's sequential-focus entry point.
 * A fragment target is allowed to be non-focusable: HTML uses it as the starting point for
 * the next Tab stop, which must land inside main rather than replaying repeated header controls.
 */
export async function activateSkipLinkAndEnterMain(
  page: Page,
  targetSelector = '#main-content',
): Promise<SkipLinkEntryEvidence> {
  const beforeScrollY = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Enter');
  await page.waitForFunction((selector) => {
    const target = document.querySelector(selector);
    return window.location.hash === selector && target?.matches(':target');
  }, targetSelector);
  await page.waitForFunction((selector) => {
    const target = document.querySelector(selector);
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }, targetSelector);

  const targetState = await page.locator(targetSelector).evaluate((target) => {
    const rect = target.getBoundingClientRect();
    return {
      hash: window.location.hash,
      targetMatchesFragment: target.matches(':target'),
      targetInViewport: rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth,
      targetRect: {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
    };
  });

  await page.keyboard.press('Tab');
  await page.waitForFunction((selector) => {
    const target = document.querySelector(selector);
    return Boolean(target && document.activeElement && target.contains(document.activeElement));
  }, targetSelector);
  const focusState = await page.locator(targetSelector).evaluate((target) => {
    const focused = document.activeElement as HTMLElement | null;
    const rect = focused?.getBoundingClientRect() ?? null;
    const focusedInViewport = Boolean(rect
      && rect.bottom > 0
      && rect.top < window.innerHeight
      && rect.right > 0
      && rect.left < window.innerWidth);
    const hitX = rect ? Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2)) : 0;
    const hitY = rect ? Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2)) : 0;
    const hit = rect && focusedInViewport ? document.elementFromPoint(hitX, hitY) : null;
    return {
      focusWithinMain: Boolean(focused && target.contains(focused)),
      focusedInViewport,
      focusedUnoccluded: Boolean(focused && hit && (focused.contains(hit) || hit.contains(focused))),
      focusedUsesFocusVisible: Boolean(focused?.matches(':focus-visible')),
      focusedRect: rect ? {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      } : null,
      focusedElement: {
        tag: focused?.tagName.toLowerCase() ?? 'none',
        id: focused?.id ?? '',
        label: focused?.getAttribute('aria-label')
          ?? focused?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160)
          ?? '',
        href: focused instanceof HTMLAnchorElement ? focused.href : null,
      },
    };
  });

  return {
    beforeScrollY,
    afterScrollY: await page.evaluate(() => window.scrollY),
    ...targetState,
    ...focusState,
  };
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

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

/** Extract one attribute from matching HTML start tags without executing the document. */
export function extractHtmlTagAttributes(html: string, tagName: string, attributeName: string): string[] {
  const tags = html.match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) ?? [];
  const attribute = new RegExp('\\b' + attributeName + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'=<>`]+))', 'i');
  return tags.flatMap((tag) => {
    const match = tag.match(attribute);
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    return value === undefined ? [] : [decodeHtmlAttribute(value.trim())];
  });
}

export function extractHtmlElementIds(html: string): string[] {
  const values = [...extractHtmlTagAttributes(html, '[a-z][a-z0-9:-]*', 'id'), ...extractHtmlTagAttributes(html, 'a', 'name')];
  return [...new Set(values.filter(Boolean))];
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
