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
import { sharedPublicationFixture } from './shared-publication-fixture.js';

async function expectNoSeriousAxeViolations(page: Page) {
  const analysis = await new AxeBuilder({ page }).analyze();
  const blocking = analysis.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

function mutateEmbeddedJson(source: string, id: string, mutate: (value: any) => void): string {
  const expression = new RegExp(`(<script id="${id}" type="application/json">)([^<]+)(</script>)`);
  return source.replace(expression, (_match, opening: string, encoded: string, closing: string) => {
    const value = JSON.parse(encoded);
    mutate(value);
    return `${opening}${JSON.stringify(value)}${closing}`;
  });
}

test.describe.serial('archive-offline generated report', () => {
  let temporaryRoot: string;
  let reportDirectory: string;
  const publication = sharedPublicationFixture('comparative', 'archive-shared-release');
  const authorityBinding = {
    runId: publication.view.publication.runId,
    mode: publication.view.decision.mode,
    finalSubjectDigest: publication.view.subjectDigest as `sha256:${string}`,
    runRevision: publication.view.revisions.run,
    publicationDigest: publication.view.publication.envelopeDigest as `sha256:${string}`,
  } as const;

  test.beforeAll(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), 'quitting7oh-archive-offline-'));
    reportDirectory = path.join(temporaryRoot, 'checklist');
    await writeAuditReport({
      outputDir: reportDirectory,
      releasePublicationEnvelope: publication.envelope,
      releasePublicationBinding: authorityBinding,
      tests: [],
      run: {
        status: 'passed',
        source: 'playwright-json',
        profile: 'archive-offline-self-test',
      },
      selectedProjects: [],
    });
  });

  test('new archive exports reject mismatched or stale shared publication authority', async () => {
    const cases = [
      ['wrong run', { ...authorityBinding, runId: 'another-run' }, /run/i],
      ['wrong mode', { ...authorityBinding, mode: 'single-site' as const }, /mode/i],
      ['wrong subject', { ...authorityBinding, finalSubjectDigest: `sha256:${'f'.repeat(64)}` as const }, /subject/i],
      ['stale head', { ...authorityBinding, runRevision: authorityBinding.runRevision + 1 }, /revision|stale/i],
      ['wrong publication', { ...authorityBinding, publicationDigest: `sha256:${'e'.repeat(64)}` as const }, /publication|stale/i],
    ] as const;
    for (const [name, releasePublicationBinding, message] of cases) {
      await expect(writeAuditReport({
        outputDir: path.join(temporaryRoot, `rejected-${name.replaceAll(' ', '-')}`),
        releasePublicationEnvelope: publication.envelope,
        releasePublicationBinding,
        tests: [],
        run: { status: 'passed', source: 'playwright-json', profile: 'archive-authority-rejection' },
        selectedProjects: [],
      }), name).rejects.toThrow(message);
    }
    await expect(writeAuditReport({
      outputDir: path.join(temporaryRoot, 'rejected-superseded-during-export'),
      releasePublicationEnvelope: publication.envelope,
      releasePublicationBinding: authorityBinding,
      releasePublicationVerifier: async () => { throw new Error('Shared publication head is stale.'); },
      tests: [],
      run: { status: 'passed', source: 'playwright-json', profile: 'archive-authority-rejection' },
      selectedProjects: [],
    })).rejects.toThrow(/stale/i);
  });

  test('large mixed-lifecycle Risk Registers are active-first and truthfully paged', async ({ page }) => {
    const large = sharedPublicationFixture('comparative', 'archive-large-risk-register', 'AVAILABLE', 9, 205);
    const outputDir = path.join(temporaryRoot, 'large-risk-register');
    await writeAuditReport({
      outputDir,
      releasePublicationEnvelope: large.envelope,
      releasePublicationBinding: {
        runId: large.view.publication.runId,
        mode: 'comparative',
        finalSubjectDigest: large.view.subjectDigest as `sha256:${string}`,
        runRevision: large.view.revisions.run,
        publicationDigest: large.view.publication.envelopeDigest as `sha256:${string}`,
      },
      tests: [],
      run: { status: 'passed', source: 'playwright-json', profile: 'archive-risk-scale' },
      selectedProjects: [],
    });
    await page.goto(pathToFileURL(path.join(outputDir, 'index.html')).href);
    await expect(page.locator('#archive-risk-page-status')).toHaveText('Showing 1–50 of 205 risks');
    await expect(page.locator('#archive-risk-register tbody tr')).toHaveCount(50);
    await expect(page.locator('#archive-risk-register tbody tr').first()).toContainText(/OPEN|ACKNOWLEDGED/i);
    const next = page.getByRole('button', { name: 'Next risks' });
    await next.focus();
    await next.press('Enter');
    await expect(page.locator('#archive-risk-page-status')).toHaveText('Showing 51–100 of 205 risks');
    await expect(next).toBeFocused();
    await page.getByRole('button', { name: 'Last risk page' }).click();
    await expect(page.locator('#archive-risk-page-status')).toHaveText('Showing 201–205 of 205 risks');
    await expect(page.locator('#archive-risk-register tbody tr')).toHaveCount(5);
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
    await expect(page.getByRole('heading', { name: 'Product Risk' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible();
    await expect(page.locator('#archive-product-risk')).toHaveAttribute('data-risk-availability', 'PARTIAL');
    await expect(page.locator('#archive-authority-revisions')).toContainText('Run revision 7');
    await expect(page.locator('#archive-risk-register')).toContainText('Manual checkout remains outstanding');
    await expect(page.locator('#archive-risk-register')).toContainText('Certificate validation bypass');
    await expect(page.locator('#archive-product-risk').evaluate((node) => Boolean(node.compareDocumentPosition(document.querySelector('.gallery-callout')!) & Node.DOCUMENT_POSITION_FOLLOWING))).resolves.toBe(true);

    const embeddedBundle = await page.locator('#archive-bundle').evaluate((node) => JSON.parse(node.textContent ?? '{}'));
    expect(embeddedBundle).toMatchObject({
      bundleVersion: ARCHIVE_BUNDLE_VERSION,
      runtimeVersion: ARCHIVE_RUNTIME_VERSION,
      assetBase: `assets/archive-v${ARCHIVE_BUNDLE_VERSION}`,
    });
    const embeddedPublication = await page.locator('#shared-release-publication').evaluate((node) => JSON.parse(node.textContent ?? '{}'));
    expect(embeddedPublication).toMatchObject({
      publication: { runId: 'archive-shared-release', envelopeDigest: publication.view.publication.envelopeDigest },
      revisions: publication.view.revisions,
      decision: { certifiedScope: publication.view.decision.certifiedScope },
      riskRegister: { availability: 'PARTIAL' },
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
    await expect(page.getByRole('heading', { name: 'Product Risk' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'FEATURE READY' })).toBeVisible();
    await expect(page.locator('#archive-product-risk')).toHaveAttribute('data-risk-availability', 'PARTIAL');
    await expect(page.locator('#archive-authority-revisions')).toContainText('Run revision 7');
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

  test('missing release-authority asset becomes unavailable instead of remaining loading', async ({ page }) => {
    const reportPath = path.join(reportDirectory, 'index.html');
    const source = await readFile(reportPath, 'utf8');
    const missingPath = path.join(reportDirectory, 'missing-release-authority.html');
    await writeFile(missingPath, source.replace('/release-authority.js', '/missing-release-authority.js'), 'utf8');
    await page.goto(pathToFileURL(missingPath).href);
    await expect(page.locator('#archive-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
    await expect(page.locator('#archive-product-risk')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#archive-risk-status')).toContainText('UNAVAILABLE');
    await expect(page.locator('#archive-runtime-fatal')).toBeHidden();
  });

  test('decision, risk, and revision tampering fail the embedded publication digest closed', async ({ context, page }) => {
    const reportPath = path.join(reportDirectory, 'index.html');
    const source = await readFile(reportPath, 'utf8');
    await context.setOffline(true);
    const mutations = [
      ['decision', (value: any) => { value.decision.label = 'TAMPERED READY'; }],
      ['risk', (value: any) => { value.riskRegister.risks[0].explanation = 'Tampered risk explanation.'; }],
      ['revision', (value: any) => { value.revisions.run += 1; }],
    ] as const;
    for (const [name, mutate] of mutations) {
      const invalidPath = path.join(reportDirectory, `invalid-release-${name}.html`);
      const invalid = mutateEmbeddedJson(source, 'shared-release-publication', mutate);
      expect(invalid).not.toEqual(source);
      await writeFile(invalidPath, invalid, 'utf8');
      await page.goto(pathToFileURL(invalidPath).href);
      await expect(page.locator('#archive-runtime-fatal')).toBeHidden();
      await expect(page.locator('#archive-product-risk')).toHaveAttribute('data-risk-availability', 'UNAVAILABLE');
      await expect(page.locator('#archive-risk-status')).toContainText('digest check');
      await expect(page.locator('#release-decision')).toContainText('RELEASE AUTHORITY UNAVAILABLE');
      await expect(page.locator('#release-decision')).not.toContainText('TAMPERED READY');
      await expect(page.locator('#audit-list')).toBeVisible();
    }
  });
});
