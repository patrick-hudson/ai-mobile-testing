import { expect, test, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeAuditReport } from '../../reporters/report-model.js';
import {
  ARCHIVE_BUNDLE_VERSION,
  ARCHIVE_RUNTIME_VERSION,
} from '../../reporters/archive-bundle.js';

async function expectNoSeriousAxeViolations(page: Page) {
  const analysis = await new AxeBuilder({ page }).analyze();
  const blocking = analysis.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test.describe.serial('archive-offline generated report', () => {
  let temporaryRoot: string;
  let reportDirectory: string;

  test.beforeAll(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'quitting7oh-archive-offline-'));
    reportDirectory = path.join(temporaryRoot, 'checklist');
    await writeAuditReport({
      outputDir: reportDirectory,
      tests: [],
      run: {
        status: 'passed',
        source: 'playwright-json',
        profile: 'archive-offline-self-test',
      },
      selectedProjects: [],
    });
  });

  test.afterAll(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  test('archive-offline report is fully usable from file URL with networking disabled', async ({ context, page }) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await context.route(/https?:\/\//, (route) => route.abort('internetdisconnected'));
    await context.setOffline(true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(pathToFileURL(path.join(reportDirectory, 'index.html')).href);

    await expect(page.getByRole('heading', { name: 'Long Build Checklist' })).toBeVisible();
    await expect(page.locator('#archive-runtime-fatal')).toBeHidden();
    await expect(page.locator('#result-count')).toContainText('audit checks');
    await expect(page.locator('#ai-review-state')).toContainText('No AI advisory is packaged');

    const embeddedBundle = await page.locator('#archive-bundle').evaluate((node) => JSON.parse(node.textContent ?? '{}'));
    expect(embeddedBundle).toMatchObject({
      bundleVersion: ARCHIVE_BUNDLE_VERSION,
      runtimeVersion: ARCHIVE_RUNTIME_VERSION,
      assetBase: `assets/archive-v${ARCHIVE_BUNDLE_VERSION}`,
    });

    await page.locator('#search').fill('__no_audit_should_match__');
    await expect(page.locator('#result-count')).toContainText('Showing 0 of');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('#result-count')).not.toContainText('Showing 0 of');
    await expectNoSeriousAxeViolations(page);
    await expect(page).toHaveScreenshot('archive-report-1440.png', { animations: 'disabled', fullPage: true, maxDiffPixelRatio: 0.002 });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Long Build Checklist' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await expectNoSeriousAxeViolations(page);
    await expect(page).toHaveScreenshot('archive-report-narrow.png', { animations: 'disabled', fullPage: true, maxDiffPixelRatio: 0.002 });

    expect(requests.filter((url) => /^https?:/.test(url))).toEqual([]);
  });

  test('archive-offline gallery opens its sealed revision without portal data or network access', async ({ context, page }) => {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await context.route(/https?:\/\//, (route) => route.abort('internetdisconnected'));
    await context.setOffline(true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(pathToFileURL(path.join(reportDirectory, 'gallery.html')).href);

    await expect(page.getByRole('heading', { name: 'Visual Evidence Gallery' })).toBeVisible();
    await expect(page.locator('#gallery-loading')).toBeHidden();
    await expect(page.locator('#gallery-fatal')).toBeHidden();
    await expect(page.locator('#gallery-workbench')).not.toBeEmpty();
    await expect(page.locator('.gallery-context')).toContainText('This run has no eligible visual evidence');
    await expect(page.locator('.gallery-context .gallery-loader')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Nearby visual evidence' })).toBeVisible();

    const loadedFiles = requests.map((url) => new URL(url)).filter(({ protocol }) => protocol === 'file:');
    expect(loadedFiles.length).toBeGreaterThan(1);
    for (const loaded of loadedFiles) {
      expect(decodeURIComponent(loaded.pathname).startsWith(`${reportDirectory}${path.sep}`)).toBe(true);
    }
    expect(requests.filter((url) => /^https?:/.test(url))).toEqual([]);
    await expectNoSeriousAxeViolations(page);
    await expect(page).toHaveScreenshot('archive-gallery-1440.png', { animations: 'disabled', fullPage: true, maxDiffPixelRatio: 0.002 });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator('#gallery-workbench')).not.toBeEmpty();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await expectNoSeriousAxeViolations(page);
    await expect(page).toHaveScreenshot('archive-gallery-narrow.png', { animations: 'disabled', fullPage: true, maxDiffPixelRatio: 0.002 });
  });

  test('archive-offline report fails closed when its embedded bundle contract is mismatched', async ({ context, page }) => {
    const reportPath = path.join(reportDirectory, 'index.html');
    const source = await readFile(reportPath, 'utf8');
    const mismatchedPath = path.join(reportDirectory, 'mismatched.html');
    const mismatched = source.replace(
      /(<script id="archive-bundle" type="application\/json">)([^<]+)(<\/script>)/,
      (_match, opening: string, encoded: string, closing: string) => {
        const contract = JSON.parse(encoded);
        contract.runtimeVersion += 1;
        return `${opening}${JSON.stringify(contract)}${closing}`;
      },
    );
    expect(mismatched).not.toEqual(source);
    await writeFile(mismatchedPath, mismatched, 'utf8');
    await context.setOffline(true);

    await page.goto(pathToFileURL(mismatchedPath).href);

    await expect(page.locator('#archive-runtime-fatal')).toBeVisible();
    await expect(page.locator('#archive-runtime-fatal-message')).toContainText(/archive bundle|does not match/i);
    await expect(page.locator('.masthead')).toBeHidden();
    await expect(page.locator('main')).toBeHidden();
  });
});
