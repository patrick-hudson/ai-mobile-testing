import { readFileSync } from 'node:fs';
import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { ENVIRONMENTS } from './audit/environments.js';
import { assertCandidateCertificateBypassAllowed, chromiumNetskopeTrustArgument } from './audit/tls.js';
import type { AuditProjectMetadata } from './audit/types.js';

const ci = Boolean(process.env.CI);
const artifactRoot = process.env.AUDIT_ARTIFACT_DIR ?? './artifacts';
const excludePerformance = binaryEnvironmentFlag('AUDIT_EXCLUDE_PERFORMANCE', false);
const candidateIgnoreHTTPSErrorsRequested = binaryEnvironmentFlag('CANDIDATE_IGNORE_HTTPS_ERRORS', false);
const candidateIgnoreHTTPSErrors = candidateIgnoreHTTPSErrorsRequested
  ? assertCandidateCertificateBypassAllowed(ENVIRONMENTS.candidate.baseURL, ENVIRONMENTS.production.baseURL)
  : false;
const chromiumCorporateTrust = {
  launchOptions: { args: [chromiumNetskopeTrustArgument()] },
};
const firefoxCorporateTrust = {
  launchOptions: {
    ...(process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH }
      : {}),
    firefoxUserPrefs: { 'security.enterprise_roots.enabled': true },
  },
};
const pluginRegistry = JSON.parse(readFileSync(new URL('./audit/plugins.generated.json', import.meta.url), 'utf8')) as {
  plugins: Array<{ entrySpecs: string[] }>;
};
const enabledPluginSpecs = [...new Set(pluginRegistry.plugins.flatMap(({ entrySpecs }) => entrySpecs)
  .filter((entry) => entry.startsWith('plugins/')))].map((entry) => `**/${entry}`);
const blobShardRun = Boolean(process.env.PLAYWRIGHT_BLOB_OUTPUT_FILE);
const reporters: ReporterDescription[] = blobShardRun
  ? [
      ['blob'],
      ['./reporters/live-gallery-reporter.ts', { outputDir: artifactRoot }],
    ]
  : [
      ['list'],
      ['./reporters/live-gallery-reporter.ts', { outputDir: artifactRoot }],
      ['./reporters/checklist-reporter.ts', { outputDir: `${artifactRoot}/checklist` }],
      ['html', { outputFolder: `${artifactRoot}/playwright-html`, open: 'never' }],
      ['json', { outputFile: `${artifactRoot}/results.json` }],
    ];

function metadata(
  environment: AuditProjectMetadata['environment'],
  browserLabel: string,
  deviceClass: AuditProjectMetadata['deviceClass'],
  fullSweep: boolean,
  visual: boolean,
): AuditProjectMetadata {
  return {
    environment,
    browserLabel,
    deviceClass,
    fullSweep,
    visual,
    tlsPolicy: environment === 'candidate' && candidateIgnoreHTTPSErrors
      ? 'ignored-for-development'
      : 'strict',
  };
}

function binaryEnvironmentFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${name} must be exactly 0 or 1.`);
}

console.log(`[AUDIT_CONFIG] TLS policy: Netskope CA + pinned Chromium SPKI trusted; candidate certificate errors ${candidateIgnoreHTTPSErrors ? 'ignored for development' : 'enforced'}; production certificate errors enforced.`);

export default defineConfig({
  testDir: '.',
  testMatch: ['**/tests/**/*.spec.ts', ...enabledPluginSpecs],
  testIgnore: [
    '**/node_modules/**',
    '**/plugins/_template/**',
    '**/portal/tests/**',
    ...(excludePerformance ? ['**/tests/performance.spec.ts'] : []),
  ],
  outputDir: `${artifactRoot}/raw`,
  snapshotPathTemplate: '{testFileDir}/__screenshots__/{arg}-{projectName}{ext}',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: process.env.AUDIT_WORKERS ? Number(process.env.AUDIT_WORKERS) : ci ? 4 : 3,
  timeout: 60_000,
  expect: {
    timeout: 12_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.0025,
      scale: 'css',
    },
  },
  reporter: reporters,
  use: {
    actionTimeout: 12_000,
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: false,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'production-mobile-chromium',
      metadata: metadata('production', 'Chromium / Pixel 5', 'mobile', true, false),
      use: { ...devices['Pixel 5'], ...chromiumCorporateTrust, baseURL: ENVIRONMENTS.production.baseURL },
    },
    {
      name: 'candidate-mobile-chromium',
      metadata: metadata('candidate', 'Chromium / Pixel 5', 'mobile', true, true),
      use: { ...devices['Pixel 5'], ...chromiumCorporateTrust, baseURL: ENVIRONMENTS.candidate.baseURL, ignoreHTTPSErrors: candidateIgnoreHTTPSErrors },
    },
    {
      name: 'production-desktop-chromium',
      metadata: metadata('production', 'Chromium / desktop', 'desktop', false, false),
      use: {
        ...devices['Desktop Chrome'],
        ...chromiumCorporateTrust,
        baseURL: ENVIRONMENTS.production.baseURL,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'candidate-desktop-chromium',
      metadata: metadata('candidate', 'Chromium / desktop', 'desktop', true, true),
      use: {
        ...devices['Desktop Chrome'],
        ...chromiumCorporateTrust,
        baseURL: ENVIRONMENTS.candidate.baseURL,
        ignoreHTTPSErrors: candidateIgnoreHTTPSErrors,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'candidate-mobile-webkit',
      metadata: metadata('candidate', 'WebKit / iPhone 13', 'mobile', false, true),
      use: { ...devices['iPhone 13'], baseURL: ENVIRONMENTS.candidate.baseURL, ignoreHTTPSErrors: candidateIgnoreHTTPSErrors },
    },
    {
      name: 'candidate-tablet-webkit',
      metadata: metadata('candidate', 'WebKit / iPad Mini', 'tablet', false, true),
      use: { ...devices['iPad Mini'], baseURL: ENVIRONMENTS.candidate.baseURL, ignoreHTTPSErrors: candidateIgnoreHTTPSErrors },
    },
    {
      name: 'candidate-desktop-firefox',
      metadata: metadata('candidate', 'Firefox / desktop', 'desktop', false, true),
      use: {
        ...devices['Desktop Firefox'],
        baseURL: ENVIRONMENTS.candidate.baseURL,
        ...firefoxCorporateTrust,
        ignoreHTTPSErrors: candidateIgnoreHTTPSErrors,
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
