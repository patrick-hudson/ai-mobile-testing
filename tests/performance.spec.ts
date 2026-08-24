import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import { projectMetadata } from '../audit/environments.js';
import { REPRESENTATIVE_PERFORMANCE_ROUTES } from '../audit/routes.js';
import { candidateCertificateBypassApplies, chromiumNetskopeTrustArgument } from '../audit/tls.js';
import { expect, staticEvidence, staticTest, test } from '../fixtures/test.js';

interface LayoutShiftRecord {
  value: number;
  startTime: number;
  sources: string[];
}

interface PaintRecord {
  startTime: number;
  size: number;
  element: string | null;
}

interface LighthouseResult {
  categories?: { performance?: { score?: number | null } };
  audits?: Record<string, { numericValue?: number; displayValue?: string; score?: number | null }>;
  finalUrl?: string;
  fetchTime?: string;
  lighthouseVersion?: string;
  runWarnings?: unknown[];
}

const LIGHTHOUSE_BUDGETS = {
  performanceScore: 0.7,
  firstContentfulPaintMs: 2_500,
  largestContentfulPaintMs: 4_000,
  totalBlockingTimeMs: 600,
  cumulativeLayoutShift: 0.1,
};

function safeRouteName(route: string): string {
  return route === '/' ? 'home' : route.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

async function runLighthouse(
  url: string,
  deviceClass: 'mobile' | 'tablet' | 'desktop',
  outputPrefix: string,
): Promise<{ result: LighthouseResult; command: string[]; durationMs: number; stdout: string; stderr: string }> {
  await mkdir(path.dirname(outputPrefix), { recursive: true });
  const chromeFlags = [
    '--headless',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    chromiumNetskopeTrustArgument(),
  ];
  if (candidateCertificateBypassApplies(url)) chromeFlags.push('--ignore-certificate-errors');
  const args = [
    path.resolve('node_modules/lighthouse/cli/index.js'),
    url,
    '--output=json',
    '--output=html',
    `--output-path=${outputPrefix}`,
    '--only-categories=performance',
    '--max-wait-for-load=45000',
    '--disable-full-page-screenshot',
    '--verbose',
    `--chrome-flags=${chromeFlags.join(' ')}`,
  ];
  if (deviceClass === 'desktop') args.push('--preset=desktop');
  const command = [process.execPath, ...args];

  const startedAt = Date.now();
  process.stdout.write(`${new Date().toISOString()} [AUDIT_LIGHTHOUSE_COMMAND] ${JSON.stringify(command)}\n`);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, CHROME_PATH: chromium.executablePath() },
    shell: false,
    stdio: 'pipe',
  });
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const rendered = chunk.toString();
    stdout += rendered;
    process.stdout.write(`[LIGHTHOUSE stdout] ${rendered}`);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const rendered = chunk.toString();
    stderr += rendered;
    process.stderr.write(`[LIGHTHOUSE stderr] ${rendered}`);
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const durationMs = Date.now() - startedAt;
  process.stdout.write(`${new Date().toISOString()} [AUDIT_LIGHTHOUSE_FINISH] ${JSON.stringify({ url, durationMs, ...outcome })}\n`);
  if (outcome.code !== 0) {
    throw new Error(`Lighthouse exited ${outcome.code ?? 'without a code'}${outcome.signal ? ` (${outcome.signal})` : ''}.`);
  }

  const reportPath = `${outputPrefix}.report.json`;
  const result = JSON.parse(await readFile(reportPath, 'utf8')) as LighthouseResult;
  return { result, command, durationMs, stdout, stderr };
}

async function installPerformanceObservers(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    type AuditWindow = Window & typeof globalThis & {
      __auditLayoutShifts: Array<{ value: number; startTime: number; sources: string[] }>;
      __auditLargestPaints: Array<{ startTime: number; size: number; element: string | null }>;
    };
    const state = window as AuditWindow;
    state.__auditLayoutShifts = [];
    state.__auditLargestPaints = [];

    if (PerformanceObserver.supportedEntryTypes.includes('layout-shift')) {
      new PerformanceObserver((list) => {
        for (const rawEntry of list.getEntries()) {
          const entry = rawEntry as PerformanceEntry & {
            value: number;
            hadRecentInput: boolean;
            sources?: Array<{ node?: Node | null }>;
          };
          if (entry.hadRecentInput) continue;
          state.__auditLayoutShifts.push({
            value: entry.value,
            startTime: entry.startTime,
            sources: (entry.sources ?? []).map(({ node }) => {
              if (!(node instanceof Element)) return node?.nodeName ?? 'unknown';
              const id = node.id ? `#${node.id}` : '';
              const classes = [...node.classList].slice(0, 3).map((name) => `.${name}`).join('');
              return `${node.tagName.toLowerCase()}${id}${classes}`;
            }),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    }

    if (PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint')) {
      new PerformanceObserver((list) => {
        for (const rawEntry of list.getEntries()) {
          const entry = rawEntry as PerformanceEntry & { size: number; element?: Element | null };
          state.__auditLargestPaints.push({
            startTime: entry.startTime,
            size: entry.size,
            element: entry.element
              ? `${entry.element.tagName.toLowerCase()}${entry.element.id ? `#${entry.element.id}` : ''}`
              : null,
          });
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    }
  });
}

for (const candidatePath of REPRESENTATIVE_PERFORMANCE_ROUTES) {
  staticTest(`[PERF-001] browser resource budget for ${candidatePath}`, staticEvidence(`Capture the final ${candidatePath} state with browser timing, transfer, and isolated Lighthouse evidence.`), async ({ page, audit }, testInfo) => {
    test.setTimeout(180_000);
    const metadata = projectMetadata(testInfo.project.metadata);
    test.skip(!metadata.fullSweep, 'Performance sampling runs on the representative full-sweep matrix.');
    test.skip(audit.environmentPath(candidatePath) === null, 'No production-baseline equivalent exists.');

    await installPerformanceObservers(page);
    await audit.goto(candidatePath);
    await page.waitForTimeout(500);

    const metrics = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const sameOrigin = resources.filter((resource) => new URL(resource.name).origin === window.location.origin);
      const rows = sameOrigin.map((resource) => ({
        url: resource.name,
        initiatorType: resource.initiatorType,
        durationMs: Math.round(resource.duration * 10) / 10,
        transferBytes: resource.transferSize,
        encodedBytes: resource.encodedBodySize,
        decodedBytes: resource.decodedBodySize,
      }));
      const bytes = (row: (typeof rows)[number]) => Math.max(row.transferBytes, row.encodedBytes);
      return {
        navigation: navigation ? {
          ttfbMs: navigation.responseStart,
          domContentLoadedMs: navigation.domContentLoadedEventEnd,
          loadMs: navigation.loadEventEnd,
          documentTransferBytes: navigation.transferSize,
          documentEncodedBytes: navigation.encodedBodySize,
        } : null,
        requestCount: rows.length + 1,
        transferredBytes: rows.reduce((sum, row) => sum + bytes(row), 0) + Math.max(navigation?.transferSize ?? 0, navigation?.encodedBodySize ?? 0),
        javascriptBytes: rows.filter((row) => row.initiatorType === 'script').reduce((sum, row) => sum + bytes(row), 0),
        stylesheetBytes: rows.filter((row) => row.initiatorType === 'css' || row.url.endsWith('.css')).reduce((sum, row) => sum + bytes(row), 0),
        imageBytes: rows.filter((row) => row.initiatorType === 'img').reduce((sum, row) => sum + bytes(row), 0),
        fontBytes: rows.filter((row) => /\.(?:woff2?|ttf|otf)(?:\?|$)/i.test(row.url)).reduce((sum, row) => sum + bytes(row), 0),
        slowestResources: [...rows].sort((left, right) => right.durationMs - left.durationMs).slice(0, 12),
        largestResources: [...rows].sort((left, right) => bytes(right) - bytes(left)).slice(0, 12),
        longTasks: performance.getEntriesByType('longtask').map((entry) => ({ startTime: entry.startTime, durationMs: entry.duration })),
      };
    });

    const budgets = {
      requestCount: 90,
      transferredBytes: 4_000_000,
      javascriptBytes: 1_500_000,
      documentEncodedBytes: 700_000,
      domContentLoadedMs: 8_000,
      loadMs: 12_000,
    };
    audit.observe('First-party requests', metrics.requestCount, `<= ${budgets.requestCount}`);
    audit.observe('First-party transferred bytes', metrics.transferredBytes, `<= ${budgets.transferredBytes}`);
    audit.observe('JavaScript bytes', metrics.javascriptBytes, `<= ${budgets.javascriptBytes}`);
    audit.observe('DOMContentLoaded ms', Math.round(metrics.navigation?.domContentLoadedMs ?? 0), `<= ${budgets.domContentLoadedMs}`);
    audit.observe('Load ms', Math.round(metrics.navigation?.loadMs ?? 0), `<= ${budgets.loadMs}`);
    await audit.attachJson('browser-performance-evidence', { path: candidatePath, budgets, metrics });

    expect(metrics.navigation, 'Navigation Timing must be available').not.toBeNull();
    expect(metrics.requestCount, 'Request count budget').toBeLessThanOrEqual(budgets.requestCount);
    expect(metrics.transferredBytes, 'Total first-party transfer budget').toBeLessThanOrEqual(budgets.transferredBytes);
    expect(metrics.javascriptBytes, 'JavaScript transfer budget').toBeLessThanOrEqual(budgets.javascriptBytes);
    expect(metrics.navigation?.documentEncodedBytes ?? Number.POSITIVE_INFINITY, 'HTML document-size budget').toBeLessThanOrEqual(budgets.documentEncodedBytes);
    expect(metrics.navigation?.domContentLoadedMs ?? Number.POSITIVE_INFINITY, 'DOMContentLoaded budget').toBeLessThanOrEqual(budgets.domContentLoadedMs);
    expect(metrics.navigation?.loadMs ?? Number.POSITIVE_INFINITY, 'Load-event budget').toBeLessThanOrEqual(budgets.loadMs);

    const targetUrl = page.url();
    const lighthousePrefix = testInfo.outputPath('lighthouse', safeRouteName(candidatePath));
    let lighthouse: Awaited<ReturnType<typeof runLighthouse>>;
    try {
      lighthouse = await runLighthouse(targetUrl, metadata.deviceClass, lighthousePrefix);
    } catch (error) {
      await audit.attachJson('lighthouse-command-failure', {
        targetUrl,
        chromePath: chromium.executablePath(),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const reportPath = `${lighthousePrefix}.report.json`;
    const htmlPath = `${lighthousePrefix}.report.html`;
    await testInfo.attach('lighthouse-report-json', { path: reportPath, contentType: 'application/json' });
    await testInfo.attach('lighthouse-report-html', { path: htmlPath, contentType: 'text/html' });

    const lighthouseMetrics = {
      performanceScore: lighthouse.result.categories?.performance?.score ?? null,
      firstContentfulPaintMs: lighthouse.result.audits?.['first-contentful-paint']?.numericValue ?? null,
      largestContentfulPaintMs: lighthouse.result.audits?.['largest-contentful-paint']?.numericValue ?? null,
      totalBlockingTimeMs: lighthouse.result.audits?.['total-blocking-time']?.numericValue ?? null,
      cumulativeLayoutShift: lighthouse.result.audits?.['cumulative-layout-shift']?.numericValue ?? null,
    };
    audit.observe('Lighthouse performance score', lighthouseMetrics.performanceScore, `>= ${LIGHTHOUSE_BUDGETS.performanceScore}`);
    audit.observe('Lighthouse first contentful paint ms', Math.round(lighthouseMetrics.firstContentfulPaintMs ?? 0), `<= ${LIGHTHOUSE_BUDGETS.firstContentfulPaintMs}`);
    audit.observe('Lighthouse largest contentful paint ms', Math.round(lighthouseMetrics.largestContentfulPaintMs ?? 0), `<= ${LIGHTHOUSE_BUDGETS.largestContentfulPaintMs}`);
    audit.observe('Lighthouse total blocking time ms', Math.round(lighthouseMetrics.totalBlockingTimeMs ?? 0), `<= ${LIGHTHOUSE_BUDGETS.totalBlockingTimeMs}`);
    audit.observe('Lighthouse cumulative layout shift', lighthouseMetrics.cumulativeLayoutShift, `<= ${LIGHTHOUSE_BUDGETS.cumulativeLayoutShift}`);
    await audit.attachJson('lighthouse-summary', {
      targetUrl,
      finalUrl: lighthouse.result.finalUrl,
      fetchTime: lighthouse.result.fetchTime,
      lighthouseVersion: lighthouse.result.lighthouseVersion,
      command: lighthouse.command,
      durationMs: lighthouse.durationMs,
      stdoutTail: lighthouse.stdout.slice(-4_000),
      stderrTail: lighthouse.stderr.slice(-8_000),
      runWarnings: lighthouse.result.runWarnings,
      budgets: LIGHTHOUSE_BUDGETS,
      metrics: lighthouseMetrics,
    });

    expect(lighthouseMetrics.performanceScore, 'Lighthouse produced a performance score').not.toBeNull();
    expect(lighthouseMetrics.performanceScore ?? 0, 'Lighthouse performance score budget').toBeGreaterThanOrEqual(LIGHTHOUSE_BUDGETS.performanceScore);
    expect(lighthouseMetrics.firstContentfulPaintMs ?? Number.POSITIVE_INFINITY, 'Lighthouse FCP budget').toBeLessThanOrEqual(LIGHTHOUSE_BUDGETS.firstContentfulPaintMs);
    expect(lighthouseMetrics.largestContentfulPaintMs ?? Number.POSITIVE_INFINITY, 'Lighthouse LCP budget').toBeLessThanOrEqual(LIGHTHOUSE_BUDGETS.largestContentfulPaintMs);
    expect(lighthouseMetrics.totalBlockingTimeMs ?? Number.POSITIVE_INFINITY, 'Lighthouse TBT budget').toBeLessThanOrEqual(LIGHTHOUSE_BUDGETS.totalBlockingTimeMs);
    expect(lighthouseMetrics.cumulativeLayoutShift ?? Number.POSITIVE_INFINITY, 'Lighthouse CLS budget').toBeLessThanOrEqual(LIGHTHOUSE_BUDGETS.cumulativeLayoutShift);
    await audit.assertRuntimeHealthy();
  });

  staticTest(`[PERF-002] layout stability evidence for ${candidatePath}`, staticEvidence(`Capture the post-hydration ${candidatePath} geometry with measured layout-shift records.`), async ({ page, audit }, testInfo) => {
    const metadata = projectMetadata(testInfo.project.metadata);
    test.skip(!metadata.fullSweep, 'Layout-shift sampling runs on the representative full-sweep matrix.');
    test.skip(audit.environmentPath(candidatePath) === null, 'No production-baseline equivalent exists.');

    await installPerformanceObservers(page);
    await audit.goto(candidatePath);
    await page.waitForTimeout(1_000);

    const evidence = await page.evaluate(() => {
      const state = window as typeof window & {
        __auditLayoutShifts: LayoutShiftRecord[];
        __auditLargestPaints: PaintRecord[];
      };
      const shifts = state.__auditLayoutShifts ?? [];
      const paints = state.__auditLargestPaints ?? [];
      return {
        cumulativeLayoutShift: shifts.reduce((total, shift) => total + shift.value, 0),
        shifts,
        largestContentfulPaint: paints.at(-1) ?? null,
        finalGeometry: {
          viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
          document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
          main: document.querySelector('main')?.getBoundingClientRect().toJSON() ?? null,
          h1: document.querySelector('h1')?.getBoundingClientRect().toJSON() ?? null,
        },
      };
    });

    const clsBudget = 0.1;
    audit.observe('Cumulative layout shift', Math.round(evidence.cumulativeLayoutShift * 10_000) / 10_000, `<= ${clsBudget}`);
    audit.observe('Observed layout-shift events', evidence.shifts.length);
    audit.observe('Largest contentful paint ms', Math.round(evidence.largestContentfulPaint?.startTime ?? 0));
    await audit.attachJson('layout-stability-evidence', { path: candidatePath, clsBudget, ...evidence });
    expect(evidence.cumulativeLayoutShift, 'Unexpected content movement after first render').toBeLessThanOrEqual(clsBudget);
    expect(evidence.finalGeometry.main, 'The primary content region remains rendered').not.toBeNull();
    expect(evidence.finalGeometry.h1, 'The page title remains rendered').not.toBeNull();
    await audit.checkpoint('post-hydration-layout');
  });
}
