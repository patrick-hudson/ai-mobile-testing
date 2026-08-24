import { readFileSync } from 'node:fs';
import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { ENVIRONMENTS } from './audit/environments.js';
import { resolveAuditTargetSelection, type AuditTargetDefinition } from './audit/targets.js';
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
const selectedTargets = resolveAuditTargetSelection(process.env.AUDIT_TARGET_IDS);
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

function metadata(target: AuditTargetDefinition): AuditProjectMetadata {
  return {
    environment: target.environment,
    browserLabel: target.browserLabel,
    deviceClass: target.deviceClass,
    fullSweep: target.fullSweep,
    visual: target.visual,
    tlsPolicy: target.environment === 'candidate' && candidateIgnoreHTTPSErrors
      ? 'ignored-for-development'
      : 'strict',
  };
}

function projectForTarget(target: AuditTargetDefinition) {
  const trust = target.engine === 'chromium'
    ? chromiumCorporateTrust
    : target.engine === 'firefox'
      ? firefoxCorporateTrust
      : {};
  const descriptor = devices[target.deviceDescriptor];
  if (!descriptor) throw new Error(`Audit target ${target.id} references unavailable Playwright device descriptor ${target.deviceDescriptor}.`);
  const deviceOptions = target.userAgentSource === 'browser-native'
    ? Object.fromEntries(Object.entries(descriptor).filter(([key]) => key !== 'userAgent'))
    : descriptor;
  return {
    name: target.id,
    metadata: metadata(target),
    use: {
      ...deviceOptions,
      ...trust,
      baseURL: ENVIRONMENTS[target.environment].baseURL,
      ignoreHTTPSErrors: target.environment === 'candidate' ? candidateIgnoreHTTPSErrors : false,
      ...(target.deviceClass === 'desktop' ? { viewport: { width: 1440, height: 900 } } : {}),
      ...(target.browserProduct === 'microsoft-edge' ? { channel: 'msedge' } : {}),
    },
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
console.log(`[AUDIT_CONFIG] Targets: ${selectedTargets.map(({ id, fidelity, browserProduct }) => `${id} (${browserProduct}; ${fidelity})`).join(', ')}.`);

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
  projects: selectedTargets.map(projectForTarget),
});
