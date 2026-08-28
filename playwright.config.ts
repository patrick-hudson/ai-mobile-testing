import { readFileSync } from 'node:fs';
import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import {
  parseSelectedSingleSiteCaseIds,
  selectedAuditCaseGrep,
  type ExecutableAuditCaseRegistry,
} from './audit/execution-selection.js';
import { ENVIRONMENTS } from './audit/environments.js';
import {
  AUDIT_SNAPSHOT_PATH_TEMPLATE,
  resolveAuditTargetSelection,
  resolveSingleSiteTargetSelection,
  type AuditTargetDefinition,
  type SingleSiteAuditTargetDefinition,
} from './audit/targets.js';
import {
  assertCandidateCertificateBypassAllowed,
  chromiumNetskopeTrustArgument,
  parsePreviewTlsBypassAllowlist,
  resolveAuditTlsPolicy,
} from './audit/tls.js';
import type { AuditProjectMetadata } from './audit/types.js';
import { parseRunContract, type SingleSiteRunContract } from './shared/run-contract.mjs';
import {
  verifySingleSiteRouteInventoryPublication,
  type SingleSiteRouteInventoryPublication,
} from './shared/single-site-route-plan.mjs';

const ci = Boolean(process.env.CI);
const artifactRoot = process.env.AUDIT_ARTIFACT_DIR ?? './artifacts';
const excludePerformance = binaryEnvironmentFlag('AUDIT_EXCLUDE_PERFORMANCE', false);
const runMode = auditRunMode(process.env.AUDIT_RUN_MODE);
const candidateIgnoreHTTPSErrorsRequested = binaryEnvironmentFlag('CANDIDATE_IGNORE_HTTPS_ERRORS', false);
if (runMode === 'single-site' && candidateIgnoreHTTPSErrorsRequested) {
  throw new Error('CANDIDATE_IGNORE_HTTPS_ERRORS belongs to comparative mode; use the Single-site certificate policy instead.');
}
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
  plugins: Array<ExecutableAuditCaseRegistry['plugins'][number] & { entrySpecs: string[] }>;
} & ExecutableAuditCaseRegistry;
const selectedSingleSiteTargets = runMode === 'single-site'
  ? resolveSingleSiteTargetSelection(process.env.AUDIT_TARGET_IDS)
  : null;
const selectedComparativeTargets = runMode === 'comparative'
  ? resolveAuditTargetSelection(process.env.AUDIT_TARGET_IDS)
  : null;
const singleSiteContract = runMode === 'single-site'
  ? singleSiteRunContract(selectedSingleSiteTargets!)
  : null;
const singleSiteTls = singleSiteContract
  ? resolveAuditTlsPolicy(singleSiteContract, {
      previewBypassOrigins: parsePreviewTlsBypassAllowlist(process.env.AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST),
    })
  : null;
const selectedSingleSiteCaseIds = runMode === 'single-site'
  ? parseSelectedSingleSiteCaseIds(
      process.env.AUDIT_SINGLE_SITE_CASE_IDS,
      pluginRegistry,
      selectedSingleSiteTargets!.map(({ sourceComparativeTargetId }) => sourceComparativeTargetId),
    )
  : [];
const selectedSingleSiteCases = runMode === 'single-site'
  ? pluginRegistry.plugins.flatMap(({ auditCases }) => auditCases)
      .filter(({ caseId }) => selectedSingleSiteCaseIds.includes(caseId))
  : [];
const singleSiteRouteInventory = runMode === 'single-site'
  ? loadSingleSiteRouteInventory(process.env.AUDIT_SINGLE_SITE_ROUTE_INVENTORY)
  : null;
const genericRouteExecutions = singleSiteRouteInventory?.genericExecutions ?? [];
const executionTargets = runMode === 'single-site'
  ? selectedSingleSiteTargets!.filter((target) => (
      selectedSingleSiteCases.some((auditCase) => auditCase.supportedProjects.includes(target.sourceComparativeTargetId))
      || genericRouteExecutions.some(({ targetId }) => targetId === target.id)
    ))
  : selectedComparativeTargets!;
const enabledPluginSpecs = [...new Set(pluginRegistry.plugins.flatMap(({ entrySpecs }) => entrySpecs)
  .filter((entry) => entry.startsWith('plugins/')))].map((entry) => `**/${entry}`);
const selectedSingleSiteSpecs = [
  ...new Set(selectedSingleSiteCases.map(({ entrySpec }) => `**/${entrySpec}`)),
  ...(genericRouteExecutions.length ? ['**/tests/single-site-generic-route.spec.ts'] : []),
];
const blobShardRun = Boolean(process.env.PLAYWRIGHT_BLOB_OUTPUT_FILE);
const reporters: ReporterDescription[] = blobShardRun
  ? [
      ['blob'],
      ['./reporters/live-gallery-reporter.ts', { outputDir: artifactRoot }],
    ]
  : runMode === 'single-site'
    ? [
        ['list'],
        ['./reporters/live-gallery-reporter.ts', { outputDir: artifactRoot }],
        ['html', { outputFolder: `${artifactRoot}/playwright-html`, open: 'never' }],
        ['json', { outputFile: `${artifactRoot}/results.json` }],
      ]
    : [
        ['list'],
        ['./reporters/live-gallery-reporter.ts', { outputDir: artifactRoot }],
        ['./reporters/checklist-reporter.ts', { outputDir: `${artifactRoot}/checklist` }],
        ['html', { outputFolder: `${artifactRoot}/playwright-html`, open: 'never' }],
        ['json', { outputFile: `${artifactRoot}/results.json` }],
      ];

function comparativeMetadata(target: AuditTargetDefinition): AuditProjectMetadata {
  const baseURL = ENVIRONMENTS[target.environment].baseURL;
  return {
    mode: 'comparative',
    environment: target.environment,
    baseURL,
    browserLabel: target.browserLabel,
    deviceClass: target.deviceClass,
    fullSweep: target.fullSweep,
    visual: target.visual,
    tlsPolicy: target.environment === 'candidate' && candidateIgnoreHTTPSErrors
      ? 'ignored-for-development'
      : 'strict',
    evidenceAuthority: target.environment === 'candidate' && candidateIgnoreHTTPSErrors
      ? { status: 'non-authoritative', reasons: ['development-certificate-bypass'] }
      : { status: 'authoritative', reasons: [] },
  };
}

function singleSiteMetadata(target: SingleSiteAuditTargetDefinition): AuditProjectMetadata {
  if (!singleSiteContract || !singleSiteTls) throw new Error('Single-site metadata requires a validated Single-site run contract.');
  return {
    mode: 'single-site',
    deploymentRole: singleSiteContract.deploymentRole,
    sourceComparativeTargetId: target.sourceComparativeTargetId,
    baseURL: singleSiteContract.url,
    browserLabel: target.browserLabel,
    deviceClass: target.deviceClass,
    fullSweep: target.fullSweep,
    visual: target.visual,
    tlsPolicy: singleSiteTls.certificatePolicy,
    evidenceAuthority: singleSiteTls.evidenceAuthority,
  };
}

function projectForTarget(target: AuditTargetDefinition | SingleSiteAuditTargetDefinition) {
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
    ...(runMode === 'single-site'
      ? {
          grep: selectedAuditCaseGrep([
            ...selectedSingleSiteCases
              .filter((auditCase) => auditCase.supportedProjects.includes(
                (target as SingleSiteAuditTargetDefinition).sourceComparativeTargetId,
              ))
              .map(({ caseId }) => caseId),
            ...genericRouteExecutions
              .filter(({ targetId }) => targetId === target.id)
              .map(({ caseId }) => caseId),
          ]),
        }
      : {}),
    metadata: runMode === 'single-site'
      ? singleSiteMetadata(target as SingleSiteAuditTargetDefinition)
      : comparativeMetadata(target as AuditTargetDefinition),
    use: {
      ...deviceOptions,
      ...trust,
      baseURL: runMode === 'single-site'
        ? singleSiteContract!.url
        : ENVIRONMENTS[(target as AuditTargetDefinition).environment].baseURL,
      ignoreHTTPSErrors: runMode === 'single-site'
        ? singleSiteTls!.browserIgnoreHTTPSErrors
        : (target as AuditTargetDefinition).environment === 'candidate' && candidateIgnoreHTTPSErrors,
      ...(runMode === 'single-site' ? { proxy: { server: singleSiteEgressProxy() } } : {}),
      ...(target.deviceClass === 'desktop' ? { viewport: { width: 1440, height: 900 } } : {}),
      ...(target.browserProduct === 'microsoft-edge' ? { channel: 'msedge' } : {}),
    },
  };
}

function singleSiteEgressProxy(): string {
  const value = process.env.AUDIT_SINGLE_SITE_EGRESS_PROXY;
  if (!value) throw new Error('Single-site execution requires the worker-owned browser egress proxy.');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('AUDIT_SINGLE_SITE_EGRESS_PROXY must be a valid loopback HTTP URL.'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.port) {
    throw new Error('AUDIT_SINGLE_SITE_EGRESS_PROXY must be an exact credential-free loopback HTTP origin with an explicit port.');
  }
  return parsed.origin;
}

function loadSingleSiteRouteInventory(value: string | undefined): SingleSiteRouteInventoryPublication | null {
  if (value === undefined || value === '') return null;
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(value, 'utf8'));
  } catch (error) {
    throw new Error(`AUDIT_SINGLE_SITE_ROUTE_INVENTORY could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!verifySingleSiteRouteInventoryPublication(document)) {
    throw new Error('AUDIT_SINGLE_SITE_ROUTE_INVENTORY does not contain a valid digest-bound route inventory publication.');
  }
  const expectedTarget = process.env.AUDIT_SINGLE_SITE_GENERIC_TARGET_ID;
  if (document.genericExecutions.length > 0
    && (!expectedTarget || document.genericExecutions.some(({ targetId }) => targetId !== expectedTarget))) {
    throw new Error('Generic route executions do not match the worker-selected canonical target.');
  }
  return document;
}

function auditRunMode(value: string | undefined): 'comparative' | 'single-site' {
  if (value === undefined || value === '' || value === 'comparative') return 'comparative';
  if (value === 'single-site') return 'single-site';
  throw new Error('AUDIT_RUN_MODE must be exactly comparative or single-site.');
}

function singleSiteRunContract(
  targets: readonly SingleSiteAuditTargetDefinition[],
): SingleSiteRunContract {
  const deploymentRole = process.env.AUDIT_SINGLE_SITE_ROLE;
  const certificatePolicy = process.env.AUDIT_SINGLE_SITE_CERTIFICATE_POLICY ?? 'strict';
  return parseRunContract({
    schemaVersion: 1,
    mode: 'single-site',
    url: process.env.AUDIT_SINGLE_SITE_URL,
    deploymentRole,
    certificatePolicy,
    targetIds: targets.map(({ id }) => id),
    scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
  }) as SingleSiteRunContract;
}

function binaryEnvironmentFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${name} must be exactly 0 or 1.`);
}

console.log(runMode === 'single-site'
  ? `[AUDIT_CONFIG] Mode: Single-site; Netskope CA + pinned Chromium SPKI trusted; certificate policy ${singleSiteTls!.certificatePolicy}; evidence ${singleSiteTls!.evidenceAuthority.status}.`
  : `[AUDIT_CONFIG] Mode: comparative; Netskope CA + pinned Chromium SPKI trusted; candidate certificate errors ${candidateIgnoreHTTPSErrors ? 'ignored for development' : 'enforced'}; production certificate errors enforced.`);
console.log(`[AUDIT_CONFIG] Targets: ${executionTargets.map(({ id, fidelity, browserProduct }) => `${id} (${browserProduct}; ${fidelity})`).join(', ')}.`);
if (runMode === 'single-site') {
  console.log(`[AUDIT_CONFIG] Exact compiled cases: ${selectedSingleSiteCaseIds.length}; generic inventoried routes: ${genericRouteExecutions.length}.`);
}

export default defineConfig({
  testDir: '.',
  // This config deliberately spans root tests plus plugin-owned specs. Keep
  // discovery out of ignored evidence trees before Playwright attempts to
  // traverse their per-worker ownership boundaries.
  respectGitIgnore: true,
  testMatch: runMode === 'single-site'
    ? selectedSingleSiteSpecs
    : ['**/tests/**/*.spec.ts', ...enabledPluginSpecs],
  testIgnore: [
    '**/node_modules/**',
    '**/artifacts/**',
    '**/blob-report/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/plugins/_template/**',
    '**/portal/tests/**',
    ...(excludePerformance ? ['**/tests/performance.spec.ts'] : []),
  ],
  outputDir: `${artifactRoot}/raw`,
  snapshotPathTemplate: AUDIT_SNAPSHOT_PATH_TEMPLATE,
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
  projects: executionTargets.map(projectForTarget),
});
