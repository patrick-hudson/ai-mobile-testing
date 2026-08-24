import { expect, staticEvidence, staticTest } from '../../../fixtures/test.js';

staticTest('[ENV-001] enabled plugin-local runtime entry executes inside the reviewed harness', staticEvidence('Capture the rendered site-architecture page and plugin-local structured evidence proving this entry executed.', 'candidate-desktop-chromium'), async ({ page, audit }) => {
  await audit.goto('/about/site-architecture');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/architecture/i);
  const pluginEvidence = await page.locator('main').evaluate((main) => ({
    visibleCharacters: main.textContent?.replace(/\s+/g, ' ').trim().length ?? 0,
    links: [...main.querySelectorAll<HTMLAnchorElement>('a[href]')].map((anchor) => anchor.href),
    sections: main.querySelectorAll('section').length,
  }));
  expect(pluginEvidence.visibleCharacters).toBeGreaterThan(500);
  await audit.attachJson('plugin-local-runtime-evidence', pluginEvidence);
  audit.observe('Plugin-local spec path', 'plugins/platform-routes-content/tests/runtime.spec.ts');
  await audit.checkpoint('plugin-local-site-architecture');
  await audit.assertRuntimeHealthy();
});
