import { defineConfig, devices } from '@playwright/test';

const artifactRoot = process.env.PORTAL_E2E_OUTPUT_DIR ?? './artifacts/portal-e2e';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  outputDir: `${artifactRoot}/raw`,
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  reporter: [
    ['list'],
    ['html', { outputFolder: `${artifactRoot}/playwright-html`, open: 'never' }],
    ['json', { outputFile: `${artifactRoot}/results.json` }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.PORTAL_E2E_BASE_URL ?? 'http://127.0.0.1:4183',
    storageState: process.env.PORTAL_E2E_STORAGE_STATE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: { args: ['--enable-precise-memory-info'] },
  },
});
