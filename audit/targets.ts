import { existsSync } from 'node:fs';
import { devices } from '@playwright/test';
import type { AuditEnvironment, AuditProjectMetadata } from './types.js';

export type AuditBrowserEngine = 'chromium' | 'firefox' | 'webkit';
export type AuditTargetFidelity = 'desktop-browser' | 'device-emulation';
export type AuditTargetCapability = 'msedge';
export const AUDIT_TARGET_REGISTRY_SCHEMA_VERSION = 1 as const;
export const GENERATED_AUDIT_TARGET_REGISTRY_PATH = 'audit/targets.generated.json';
export const AUDIT_SNAPSHOT_PATH_TEMPLATE = '{testFileDir}/__screenshots__/{arg}-{projectName}{ext}' as const;

export function auditSnapshotFileName(argument: string, projectName: string, extension = '.png'): string {
  return `${argument}-${projectName}${extension}`;
}

export interface AuditTargetDefinition {
  id: string;
  label: string;
  environment: AuditEnvironment;
  browserLabel: string;
  deviceClass: AuditProjectMetadata['deviceClass'];
  engine: AuditBrowserEngine;
  browserProduct: 'chromium' | 'firefox' | 'webkit' | 'microsoft-edge';
  deviceDescriptor: string;
  fidelity: AuditTargetFidelity;
  defaultEnabled: boolean;
  fullSweep: boolean;
  visual: boolean;
  requiredCapability?: AuditTargetCapability;
  userAgentSource?: 'browser-native';
  qualification: string;
}

export interface SingleSiteAuditTargetDefinition extends Omit<AuditTargetDefinition, 'environment'> {
  sourceComparativeTargetId: string;
}

export interface ProviderTargetDefinition {
  id: string;
  label: string;
  platform: 'ios' | 'android';
  browserProduct: 'mobile-safari' | 'chrome';
  versionPolicy: 'current' | 'previous';
  fidelity: 'real-device';
  runnable: false;
  providerCapability: {
    platformName: string;
    platformVersion: 'latest' | 'latest-1';
    browserName: string;
    realMobile: true;
  };
  qualification: string;
}

export interface AuditTargetCapabilities {
  msedge: {
    available: boolean;
    declared: boolean;
    executablePath: string | null;
    reason: string;
  };
}

export interface AuditTargetRegistryDocument {
  schemaVersion: typeof AUDIT_TARGET_REGISTRY_SCHEMA_VERSION;
  defaultTargetIds: readonly string[];
  localTargets: readonly AuditTargetDefinition[];
  singleSiteFullProfileTargetIds: readonly string[];
  singleSiteTargets: readonly SingleSiteAuditTargetDefinition[];
  providerTargets: readonly ProviderTargetDefinition[];
}

export const DEFAULT_AUDIT_TARGET_IDS = [
  'production-mobile-chromium',
  'candidate-mobile-chromium',
  'production-desktop-chromium',
  'candidate-desktop-chromium',
  'candidate-mobile-webkit',
  'candidate-tablet-webkit',
  'candidate-desktop-firefox',
] as const;

/**
 * Executable targets in the pinned Playwright container.
 *
 * Device descriptors reproduce viewport, input and user-agent characteristics;
 * they are not real phones, real operating systems, or vendor Safari/Chrome.
 */
export const LOCAL_AUDIT_TARGETS = [
  {
    id: 'production-mobile-chromium',
    label: 'Production · Pixel 5 descriptor · Chromium',
    environment: 'production',
    browserLabel: 'Chromium / Pixel 5 emulation (Android 11 UA)',
    deviceClass: 'mobile',
    engine: 'chromium',
    browserProduct: 'chromium',
    deviceDescriptor: 'Pixel 5',
    fidelity: 'device-emulation',
    defaultEnabled: true,
    fullSweep: true,
    visual: false,
    qualification: 'Docker-local Chromium using Playwright viewport, touch, scale, and Android user-agent emulation; not a physical Pixel.',
  },
  {
    id: 'candidate-mobile-chromium',
    label: 'Candidate · Pixel 5 descriptor · Chromium',
    environment: 'candidate',
    browserLabel: 'Chromium / Pixel 5 emulation (Android 11 UA)',
    deviceClass: 'mobile',
    engine: 'chromium',
    browserProduct: 'chromium',
    deviceDescriptor: 'Pixel 5',
    fidelity: 'device-emulation',
    defaultEnabled: true,
    fullSweep: true,
    visual: true,
    qualification: 'Docker-local Chromium using Playwright viewport, touch, scale, and Android user-agent emulation; not a physical Pixel.',
  },
  {
    id: 'production-desktop-chromium',
    label: 'Production · Desktop · Chromium',
    environment: 'production',
    browserLabel: 'Chromium / desktop',
    deviceClass: 'desktop',
    engine: 'chromium',
    browserProduct: 'chromium',
    deviceDescriptor: 'Desktop Chrome',
    fidelity: 'desktop-browser',
    defaultEnabled: true,
    fullSweep: false,
    visual: false,
    qualification: 'Docker-local Playwright Chromium at a fixed desktop viewport.',
  },
  {
    id: 'candidate-desktop-chromium',
    label: 'Candidate · Desktop · Chromium',
    environment: 'candidate',
    browserLabel: 'Chromium / desktop',
    deviceClass: 'desktop',
    engine: 'chromium',
    browserProduct: 'chromium',
    deviceDescriptor: 'Desktop Chrome',
    fidelity: 'desktop-browser',
    defaultEnabled: true,
    fullSweep: true,
    visual: true,
    qualification: 'Docker-local Playwright Chromium at a fixed desktop viewport.',
  },
  {
    id: 'candidate-mobile-webkit',
    label: 'Candidate · iPhone 13 descriptor · WebKit',
    environment: 'candidate',
    browserLabel: 'WebKit / iPhone 13 emulation (iOS 15 UA)',
    deviceClass: 'mobile',
    engine: 'webkit',
    browserProduct: 'webkit',
    deviceDescriptor: 'iPhone 13',
    fidelity: 'device-emulation',
    defaultEnabled: true,
    fullSweep: false,
    visual: true,
    qualification: 'Docker-local Playwright WebKit with an iPhone descriptor; not Mobile Safari, iOS, or physical iPhone hardware.',
  },
  {
    id: 'candidate-tablet-webkit',
    label: 'Candidate · iPad Mini descriptor · WebKit',
    environment: 'candidate',
    browserLabel: 'WebKit / iPad Mini emulation',
    deviceClass: 'tablet',
    engine: 'webkit',
    browserProduct: 'webkit',
    deviceDescriptor: 'iPad Mini',
    fidelity: 'device-emulation',
    defaultEnabled: true,
    fullSweep: false,
    visual: true,
    qualification: 'Docker-local Playwright WebKit with an iPad descriptor; not Mobile Safari, iPadOS, or physical iPad hardware.',
  },
  {
    id: 'candidate-desktop-firefox',
    label: 'Candidate · Desktop · Firefox',
    environment: 'candidate',
    browserLabel: 'Firefox / desktop',
    deviceClass: 'desktop',
    engine: 'firefox',
    browserProduct: 'firefox',
    deviceDescriptor: 'Desktop Firefox',
    fidelity: 'desktop-browser',
    defaultEnabled: true,
    fullSweep: false,
    visual: true,
    qualification: 'Docker-local Playwright Firefox at a fixed desktop viewport.',
  },
  {
    id: 'candidate-mobile-webkit-iphone-17-ios18',
    label: 'Candidate · iPhone 17 / iOS 18.7 UA · WebKit emulation',
    environment: 'candidate',
    browserLabel: 'WebKit / iPhone 17 emulation (iOS 18.7 UA)',
    deviceClass: 'mobile',
    engine: 'webkit',
    browserProduct: 'webkit',
    deviceDescriptor: 'iPhone 17',
    fidelity: 'device-emulation',
    defaultEnabled: false,
    fullSweep: false,
    visual: true,
    qualification: 'Docker-local Playwright WebKit using the iPhone 17 descriptor and iOS 18.7 user agent; not Mobile Safari, iOS, or physical hardware.',
  },
  {
    id: 'candidate-mobile-webkit-iphone-15-ios17',
    label: 'Candidate · iPhone 15 / iOS 17.5 UA · WebKit emulation',
    environment: 'candidate',
    browserLabel: 'WebKit / iPhone 15 emulation (iOS 17.5 UA)',
    deviceClass: 'mobile',
    engine: 'webkit',
    browserProduct: 'webkit',
    deviceDescriptor: 'iPhone 15',
    fidelity: 'device-emulation',
    defaultEnabled: false,
    fullSweep: false,
    visual: true,
    qualification: 'Docker-local Playwright WebKit using the iPhone 15 descriptor and iOS 17.5 user agent; not Mobile Safari, iOS, or physical hardware.',
  },
  {
    id: 'candidate-mobile-chromium-pixel-10-android16',
    label: 'Candidate · Pixel 10 / Android 16 UA · Chromium emulation',
    environment: 'candidate',
    browserLabel: 'Chromium / Pixel 10 emulation (Android 16 UA)',
    deviceClass: 'mobile',
    engine: 'chromium',
    browserProduct: 'chromium',
    deviceDescriptor: 'Pixel 10',
    fidelity: 'device-emulation',
    defaultEnabled: false,
    fullSweep: false,
    visual: true,
    qualification: 'Docker-local Playwright Chromium using the Pixel 10 descriptor and Android 16 user agent; not Chrome for Android or physical hardware.',
  },
  {
    id: 'candidate-mobile-chromium-pixel-8-android14',
    label: 'Candidate · Pixel 8 / Android 14 UA · Chromium emulation',
    environment: 'candidate',
    browserLabel: 'Chromium / Pixel 8 emulation (Android 14 UA)',
    deviceClass: 'mobile',
    engine: 'chromium',
    browserProduct: 'chromium',
    deviceDescriptor: 'Pixel 8',
    fidelity: 'device-emulation',
    defaultEnabled: false,
    fullSweep: false,
    visual: true,
    qualification: 'Docker-local Playwright Chromium using the Pixel 8 descriptor and Android 14 user agent; not Chrome for Android or physical hardware.',
  },
  {
    id: 'candidate-mobile-chromium-galaxy-s24-android14',
    label: 'Candidate · Galaxy S24 / Android 14 UA · Chromium emulation',
    environment: 'candidate',
    browserLabel: 'Chromium / Galaxy S24 emulation (Android 14 UA)',
    deviceClass: 'mobile',
    engine: 'chromium',
    browserProduct: 'chromium',
    deviceDescriptor: 'Galaxy S24',
    fidelity: 'device-emulation',
    defaultEnabled: false,
    fullSweep: false,
    visual: true,
    qualification: 'Docker-local Playwright Chromium using the Galaxy S24 descriptor and Android 14 user agent; not Samsung Internet, Chrome for Android, or physical hardware.',
  },
  {
    id: 'candidate-desktop-chromium-edge-compat',
    label: 'Candidate · Edge-compatible UA · Chromium (not branded Edge)',
    environment: 'candidate',
    browserLabel: 'Chromium / Edge-compatible desktop emulation',
    deviceClass: 'desktop',
    engine: 'chromium',
    browserProduct: 'chromium',
    deviceDescriptor: 'Desktop Edge',
    fidelity: 'desktop-browser',
    defaultEnabled: false,
    fullSweep: false,
    visual: true,
    qualification: 'Docker-local Playwright Chromium with the Edge desktop user agent and viewport; it is not the branded Microsoft Edge binary.',
  },
  {
    id: 'candidate-desktop-chromium-msedge',
    label: 'Candidate · Microsoft Edge · branded browser',
    environment: 'candidate',
    browserLabel: 'Microsoft Edge / desktop (branded binary)',
    deviceClass: 'desktop',
    engine: 'chromium',
    browserProduct: 'microsoft-edge',
    deviceDescriptor: 'Desktop Edge',
    fidelity: 'desktop-browser',
    defaultEnabled: false,
    fullSweep: false,
    visual: true,
    requiredCapability: 'msedge',
    userAgentSource: 'browser-native',
    qualification: 'The branded Microsoft Edge channel installed by the optional Docker build capability.',
  },
] as const satisfies readonly AuditTargetDefinition[];

const SINGLE_SITE_SOURCE_TARGET_IDS = [
  'candidate-mobile-chromium',
  'candidate-desktop-chromium',
  'candidate-mobile-webkit',
  'candidate-tablet-webkit',
  'candidate-desktop-firefox',
  'candidate-mobile-webkit-iphone-17-ios18',
  'candidate-mobile-webkit-iphone-15-ios17',
  'candidate-mobile-chromium-pixel-10-android16',
  'candidate-mobile-chromium-pixel-8-android14',
  'candidate-mobile-chromium-galaxy-s24-android14',
  'candidate-desktop-chromium-edge-compat',
  'candidate-desktop-chromium-msedge',
] as const;

function singleSiteTargetFrom(sourceId: (typeof SINGLE_SITE_SOURCE_TARGET_IDS)[number]): SingleSiteAuditTargetDefinition {
  const source = LOCAL_AUDIT_TARGETS.find(({ id }) => id === sourceId);
  if (!source) throw new Error(`Single-site target source ${sourceId} is missing.`);
  const { environment: _environment, ...portable } = source;
  return {
    ...portable,
    id: `single-site-${source.id.slice('candidate-'.length)}`,
    label: portable.label.replace(/^Candidate · /, 'Single site · '),
    sourceComparativeTargetId: source.id,
  };
}

export const SINGLE_SITE_LOCAL_AUDIT_TARGETS = SINGLE_SITE_SOURCE_TARGET_IDS
  .map(singleSiteTargetFrom) as readonly SingleSiteAuditTargetDefinition[];

export const SINGLE_SITE_FULL_PROFILE_TARGET_IDS = SINGLE_SITE_LOCAL_AUDIT_TARGETS
  .filter(({ defaultEnabled }) => defaultEnabled)
  .map(({ id }) => id);

/**
 * Provider-ready capability metadata only. These rows are deliberately not
 * accepted by AUDIT_TARGET_IDS until a provider adapter supplies sessions,
 * credentials, artifact transfer, and release-evidence provenance.
 */
export const PROVIDER_TARGET_CATALOG = [
  {
    id: 'provider-real-ios-safari-current',
    label: 'Real iPhone · current iOS · Mobile Safari',
    platform: 'ios',
    browserProduct: 'mobile-safari',
    versionPolicy: 'current',
    fidelity: 'real-device',
    runnable: false,
    providerCapability: {
      platformName: 'iOS',
      platformVersion: 'latest',
      browserName: 'Safari',
      realMobile: true,
    },
    qualification: 'Requires an installed cloud/device-lab adapter and provider credentials; no local emulation may satisfy this row.',
  },
  {
    id: 'provider-real-ios-safari-previous',
    label: 'Real iPhone · previous iOS · Mobile Safari',
    platform: 'ios',
    browserProduct: 'mobile-safari',
    versionPolicy: 'previous',
    fidelity: 'real-device',
    runnable: false,
    providerCapability: {
      platformName: 'iOS',
      platformVersion: 'latest-1',
      browserName: 'Safari',
      realMobile: true,
    },
    qualification: 'Requires an installed cloud/device-lab adapter and provider credentials; no local emulation may satisfy this row.',
  },
  {
    id: 'provider-real-android-chrome-current',
    label: 'Real Android phone · current Android · Chrome',
    platform: 'android',
    browserProduct: 'chrome',
    versionPolicy: 'current',
    fidelity: 'real-device',
    runnable: false,
    providerCapability: {
      platformName: 'Android',
      platformVersion: 'latest',
      browserName: 'Chrome',
      realMobile: true,
    },
    qualification: 'Requires an installed cloud/device-lab adapter and provider credentials; no local emulation may satisfy this row.',
  },
  {
    id: 'provider-real-android-chrome-previous',
    label: 'Real Android phone · previous Android · Chrome',
    platform: 'android',
    browserProduct: 'chrome',
    versionPolicy: 'previous',
    fidelity: 'real-device',
    runnable: false,
    providerCapability: {
      platformName: 'Android',
      platformVersion: 'latest-1',
      browserName: 'Chrome',
      realMobile: true,
    },
    qualification: 'Requires an installed cloud/device-lab adapter and provider credentials; no local emulation may satisfy this row.',
  },
] as const satisfies readonly ProviderTargetDefinition[];

const MSEDGE_EXECUTABLE_CANDIDATES = [
  '/opt/microsoft/msedge/msedge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
] as const;

export function detectAuditTargetCapabilities(
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
): AuditTargetCapabilities {
  const rawFlag = environment.AUDIT_MSEDGE_AVAILABLE;
  if (rawFlag !== undefined && rawFlag !== '0' && rawFlag !== '1') {
    throw new Error('AUDIT_MSEDGE_AVAILABLE must be exactly 0 or 1.');
  }
  const declared = rawFlag === '1';
  const executablePath = MSEDGE_EXECUTABLE_CANDIDATES.find((candidate) => pathExists(candidate)) ?? null;
  const available = declared && executablePath !== null;
  return {
    msedge: {
      available,
      declared,
      executablePath,
      reason: available
        ? `Branded Microsoft Edge capability verified at ${executablePath}.`
        : !declared
          ? 'Branded Microsoft Edge was not enabled when the Docker image was built.'
          : 'AUDIT_MSEDGE_AVAILABLE=1 but no branded Microsoft Edge executable was found.',
    },
  };
}

export function validateAuditTargetCatalog(
  localTargets: readonly AuditTargetDefinition[] = LOCAL_AUDIT_TARGETS,
  providerTargets: readonly ProviderTargetDefinition[] = PROVIDER_TARGET_CATALOG,
  singleSiteTargets: readonly SingleSiteAuditTargetDefinition[] = SINGLE_SITE_LOCAL_AUDIT_TARGETS,
): void {
  const issues: string[] = [];
  const allIds = [
    ...localTargets.map(({ id }) => id),
    ...singleSiteTargets.map(({ id }) => id),
    ...providerTargets.map(({ id }) => id),
  ];
  for (const duplicate of duplicateValues(allIds)) issues.push(`Duplicate target ID: ${duplicate}.`);

  for (const target of localTargets) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(target.id)) issues.push(`Invalid local target ID: ${target.id}.`);
    if (!target.label.trim() || !target.browserLabel.trim() || !target.qualification.trim()) issues.push(`${target.id} must have non-empty reviewer labels and qualification.`);
    if (!target.id.startsWith(`${target.environment}-`)) issues.push(`${target.id} does not match its ${target.environment} environment.`);
    const descriptor = devices[target.deviceDescriptor];
    if (!descriptor) issues.push(`${target.id} references missing Playwright device descriptor "${target.deviceDescriptor}".`);
    else if (descriptor.defaultBrowserType !== target.engine) issues.push(`${target.id} uses ${target.engine} with a ${descriptor.defaultBrowserType} device descriptor.`);
    if (target.environment === 'production' && target.visual) issues.push(`${target.id} cannot mark production baseline output as candidate visual evidence.`);
    if (target.defaultEnabled && target.requiredCapability) issues.push(`${target.id} cannot be default-enabled while requiring ${target.requiredCapability}.`);
    if (target.browserProduct === 'microsoft-edge' && target.requiredCapability !== 'msedge') issues.push(`${target.id} must require the msedge capability.`);
    if (target.browserProduct === 'microsoft-edge' && target.userAgentSource !== 'browser-native') issues.push(`${target.id} must preserve the branded browser's native user agent.`);
    if (target.browserProduct !== 'microsoft-edge' && target.userAgentSource === 'browser-native') issues.push(`${target.id} cannot request a native user agent for a descriptor-emulation target.`);
    if (target.requiredCapability === 'msedge' && target.browserProduct !== 'microsoft-edge') issues.push(`${target.id} requires msedge but is not labeled Microsoft Edge.`);
    if (target.browserProduct === 'firefox' && target.engine !== 'firefox') issues.push(`${target.id} labels Firefox but does not use the Firefox engine.`);
    if (target.browserProduct === 'webkit' && target.engine !== 'webkit') issues.push(`${target.id} labels WebKit but does not use the WebKit engine.`);
    if ((target.browserProduct === 'chromium' || target.browserProduct === 'microsoft-edge') && target.engine !== 'chromium') {
      issues.push(`${target.id} labels a Chromium-family product but does not use the Chromium engine.`);
    }
    if (target.fidelity === 'device-emulation' && !target.qualification.toLowerCase().includes('not')) {
      issues.push(`${target.id} must state that device emulation is not a real device/browser platform.`);
    }
  }

  const configuredDefaults = localTargets.filter(({ defaultEnabled }) => defaultEnabled).map(({ id }) => id);
  if (!sameOrderedValues(configuredDefaults, DEFAULT_AUDIT_TARGET_IDS)) {
    issues.push(`Default target order must remain exactly: ${DEFAULT_AUDIT_TARGET_IDS.join(', ')}.`);
  }

  const comparativeById = new Map(localTargets.map((target) => [target.id, target]));
  for (const target of singleSiteTargets) {
    if (!target.id.startsWith('single-site-')) issues.push(`${target.id} must use the neutral single-site prefix.`);
    const source = comparativeById.get(target.sourceComparativeTargetId);
    if (!source || source.environment !== 'candidate') {
      issues.push(`${target.id} must reference an existing candidate target template.`);
      continue;
    }
    const comparable = {
      browserLabel: target.browserLabel,
      deviceClass: target.deviceClass,
      engine: target.engine,
      browserProduct: target.browserProduct,
      deviceDescriptor: target.deviceDescriptor,
      fidelity: target.fidelity,
      defaultEnabled: target.defaultEnabled,
      fullSweep: target.fullSweep,
      visual: target.visual,
      requiredCapability: target.requiredCapability,
      userAgentSource: target.userAgentSource,
      qualification: target.qualification,
    };
    const sourceComparable = {
      browserLabel: source.browserLabel,
      deviceClass: source.deviceClass,
      engine: source.engine,
      browserProduct: source.browserProduct,
      deviceDescriptor: source.deviceDescriptor,
      fidelity: source.fidelity,
      defaultEnabled: source.defaultEnabled,
      fullSweep: source.fullSweep,
      visual: source.visual,
      requiredCapability: source.requiredCapability,
      userAgentSource: source.userAgentSource,
      qualification: source.qualification,
    };
    if (JSON.stringify(comparable) !== JSON.stringify(sourceComparable)) {
      issues.push(`${target.id} drifted from its comparative browser/device template.`);
    }
  }
  const configuredSingleSiteDefaults = singleSiteTargets.filter(({ defaultEnabled }) => defaultEnabled).map(({ id }) => id);
  if (!sameOrderedValues(configuredSingleSiteDefaults, SINGLE_SITE_FULL_PROFILE_TARGET_IDS)) {
    issues.push(`Single-site full profile order must remain exactly: ${SINGLE_SITE_FULL_PROFILE_TARGET_IDS.join(', ')}.`);
  }

  for (const target of providerTargets) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(target.id)) issues.push(`Invalid provider target ID: ${target.id}.`);
    if (target.runnable !== false || target.fidelity !== 'real-device') issues.push(`${target.id} must remain non-runnable real-device metadata.`);
    if (!target.qualification.toLowerCase().includes('requires')) issues.push(`${target.id} must explain its provider requirement.`);
    if (target.platform === 'ios' && target.browserProduct !== 'mobile-safari') issues.push(`${target.id} must map real iOS metadata to Mobile Safari.`);
    if (target.platform === 'android' && target.browserProduct !== 'chrome') issues.push(`${target.id} must map real Android metadata to Chrome.`);
    if (target.providerCapability.realMobile !== true) issues.push(`${target.id} must request a real mobile provider session.`);
  }

  if (issues.length > 0) throw new Error(`Invalid audit target catalog:\n- ${issues.join('\n- ')}`);
}

export function resolveAuditTargetSelection(
  rawTargetIds: string | undefined,
  capabilities: AuditTargetCapabilities = detectAuditTargetCapabilities(),
): AuditTargetDefinition[] {
  validateAuditTargetCatalog();
  const requestedIds = rawTargetIds === undefined || rawTargetIds.trim() === ''
    ? [...DEFAULT_AUDIT_TARGET_IDS]
    : rawTargetIds.split(',').map((value) => value.trim()).filter(Boolean);
  if (requestedIds.length === 0) throw new Error('AUDIT_TARGET_IDS must select at least one target.');

  const duplicates = duplicateValues(requestedIds);
  if (duplicates.length > 0) throw new Error(`AUDIT_TARGET_IDS contains duplicate target IDs: ${duplicates.join(', ')}.`);

  const localById = new Map<string, AuditTargetDefinition>(
    LOCAL_AUDIT_TARGETS.map((target) => [target.id, target]),
  );
  const providerById = new Map<string, ProviderTargetDefinition>(
    PROVIDER_TARGET_CATALOG.map((target) => [target.id, target]),
  );
  const selected: AuditTargetDefinition[] = [];
  for (const id of requestedIds) {
    const providerTarget = providerById.get(id);
    if (providerTarget) {
      throw new Error(
        `${id} is real-device provider metadata, not a runnable target. Install a provider adapter that supplies device sessions, credentials, artifacts, and provenance before selecting it.`,
      );
    }
    const target = localById.get(id);
    if (!target) {
      throw new Error(`Unknown AUDIT_TARGET_IDS value "${id}". Valid Docker-local targets: ${LOCAL_AUDIT_TARGETS.map(({ id: targetId }) => targetId).join(', ')}.`);
    }
    if (target.requiredCapability && !capabilities[target.requiredCapability].available) {
      throw new Error(
        `${id} is unavailable: ${capabilities[target.requiredCapability].reason} Rebuild with INSTALL_MSEDGE=1 and do not substitute Edge-compatible Chromium evidence.`,
      );
    }
    selected.push(target);
  }
  return selected;
}

export function resolveSingleSiteTargetSelection(
  rawTargetIds: string | undefined,
  capabilities: AuditTargetCapabilities = detectAuditTargetCapabilities(),
): SingleSiteAuditTargetDefinition[] {
  validateAuditTargetCatalog();
  const requestedIds = rawTargetIds === undefined || rawTargetIds.trim() === ''
    ? [...SINGLE_SITE_FULL_PROFILE_TARGET_IDS]
    : rawTargetIds.split(',').map((value) => value.trim()).filter(Boolean);
  if (requestedIds.length === 0) throw new Error('Single-site target selection must contain at least one target.');
  const duplicates = duplicateValues(requestedIds);
  if (duplicates.length > 0) throw new Error(`Single-site target selection contains duplicates: ${duplicates.join(', ')}.`);
  const byId = new Map(SINGLE_SITE_LOCAL_AUDIT_TARGETS.map((target) => [target.id, target]));
  return requestedIds.map((id) => {
    const target = byId.get(id);
    if (!target) throw new Error(`Unknown Single-site target "${id}".`);
    if (target.requiredCapability && !capabilities[target.requiredCapability].available) {
      throw new Error(`${id} is unavailable: ${capabilities[target.requiredCapability].reason}`);
    }
    return target;
  });
}

export function auditTargetRegistryDocument(): AuditTargetRegistryDocument {
  return {
    schemaVersion: AUDIT_TARGET_REGISTRY_SCHEMA_VERSION,
    defaultTargetIds: DEFAULT_AUDIT_TARGET_IDS,
    localTargets: LOCAL_AUDIT_TARGETS,
    singleSiteFullProfileTargetIds: SINGLE_SITE_FULL_PROFILE_TARGET_IDS,
    singleSiteTargets: SINGLE_SITE_LOCAL_AUDIT_TARGETS,
    providerTargets: PROVIDER_TARGET_CATALOG,
  };
}

function duplicateValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

validateAuditTargetCatalog();
