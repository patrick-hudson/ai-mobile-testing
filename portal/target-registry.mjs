import { existsSync, readFileSync } from 'node:fs';

export { applicableTargetIds } from '../shared/target-applicability.mjs';

const TARGET_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENVIRONMENTS = new Set(['production', 'candidate']);
const DEVICE_CLASSES = new Set(['mobile', 'tablet', 'desktop']);
const ENGINES = new Set(['chromium', 'firefox', 'webkit']);
const FIDELITIES = new Set(['desktop-browser', 'device-emulation']);
const MSEDGE_PATHS = ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];

function text(value, maximum = 2_000) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

export function validatePortalTargetRegistryDocument(document, environment = process.env, pathExists = existsSync) {
  if (!document || typeof document !== 'object' || document.schemaVersion !== 1
    || !Array.isArray(document.defaultTargetIds) || !Array.isArray(document.localTargets)
    || !Array.isArray(document.providerTargets)) {
    throw new Error('Generated audit target registry has an unsupported schema.');
  }
  const ids = new Set();
  const msedgeDeclared = environment.AUDIT_MSEDGE_AVAILABLE === '1';
  if (environment.AUDIT_MSEDGE_AVAILABLE !== undefined && !['0', '1'].includes(environment.AUDIT_MSEDGE_AVAILABLE)) {
    throw new Error('AUDIT_MSEDGE_AVAILABLE must be exactly 0 or 1.');
  }
  const msedgePath = MSEDGE_PATHS.find((candidate) => pathExists(candidate)) ?? null;
  const localTargets = document.localTargets.map((value) => {
    if (!value || typeof value !== 'object' || !TARGET_ID.test(value.id ?? '') || ids.has(value.id)
      || !text(value.label, 200) || !text(value.browserLabel, 300) || !text(value.qualification)
      || !ENVIRONMENTS.has(value.environment) || !DEVICE_CLASSES.has(value.deviceClass)
      || !ENGINES.has(value.engine) || !FIDELITIES.has(value.fidelity)
      || typeof value.defaultEnabled !== 'boolean' || typeof value.fullSweep !== 'boolean'
      || typeof value.visual !== 'boolean') {
      throw new Error('Generated audit target registry contains an invalid local target.');
    }
    ids.add(value.id);
    const capabilityAvailable = value.requiredCapability !== 'msedge' || (msedgeDeclared && Boolean(msedgePath));
    const unavailableReason = capabilityAvailable ? null
      : value.requiredCapability === 'msedge'
        ? !msedgeDeclared
          ? 'Branded Microsoft Edge was not enabled in this container image.'
          : 'Microsoft Edge was declared but its executable is unavailable.'
        : 'This Docker-local target requires an unavailable capability.';
    return {
      ...structuredClone(value),
      runnable: true,
      available: capabilityAvailable,
      defaultSelected: document.defaultTargetIds.includes(value.id),
      unavailableReason,
    };
  });
  if (new Set(document.defaultTargetIds).size !== document.defaultTargetIds.length
    || document.defaultTargetIds.some((id) => !localTargets.some((target) => target.id === id && target.available))) {
    throw new Error('Generated audit target registry has invalid default target IDs.');
  }
  const rawSingleSiteTargets = document.singleSiteTargets ?? [];
  const rawSingleSiteFullProfileTargetIds = document.singleSiteFullProfileTargetIds ?? [];
  if (!Array.isArray(rawSingleSiteTargets) || !Array.isArray(rawSingleSiteFullProfileTargetIds)) {
    throw new Error('Generated audit target registry has invalid Single-site target metadata.');
  }
  const singleSiteTargets = rawSingleSiteTargets.map((value) => {
    if (!value || typeof value !== 'object' || !TARGET_ID.test(value.id ?? '') || ids.has(value.id)
      || !value.id.startsWith('single-site-') || !text(value.sourceComparativeTargetId, 200)
      || !text(value.label, 200) || !text(value.browserLabel, 300) || !text(value.qualification)
      || !DEVICE_CLASSES.has(value.deviceClass) || !ENGINES.has(value.engine) || !FIDELITIES.has(value.fidelity)
      || typeof value.defaultEnabled !== 'boolean' || typeof value.fullSweep !== 'boolean'
      || typeof value.visual !== 'boolean' || 'environment' in value) {
      throw new Error('Generated audit target registry contains an invalid neutral Single-site target.');
    }
    const source = localTargets.find(({ id }) => id === value.sourceComparativeTargetId);
    if (!source || source.environment !== 'candidate') {
      throw new Error('Generated Single-site target references an invalid comparative template.');
    }
    ids.add(value.id);
    const capabilityAvailable = value.requiredCapability !== 'msedge' || (msedgeDeclared && Boolean(msedgePath));
    return {
      ...structuredClone(value),
      runnable: true,
      available: capabilityAvailable,
      defaultSelected: rawSingleSiteFullProfileTargetIds.includes(value.id),
      unavailableReason: capabilityAvailable ? null : 'This Docker-local target requires an unavailable capability.',
    };
  });
  if (new Set(rawSingleSiteFullProfileTargetIds).size !== rawSingleSiteFullProfileTargetIds.length
    || rawSingleSiteFullProfileTargetIds.some((id) => !singleSiteTargets.some((target) => target.id === id && target.available))) {
    throw new Error('Generated audit target registry has invalid Single-site full profile IDs.');
  }
  const providerTargets = document.providerTargets.map((value) => {
    if (!value || typeof value !== 'object' || !TARGET_ID.test(value.id ?? '') || ids.has(value.id)
      || value.runnable !== false || value.fidelity !== 'real-device'
      || !text(value.label, 200) || !text(value.qualification)) {
      throw new Error('Generated audit target registry contains an invalid provider-only target.');
    }
    ids.add(value.id);
    return {
      ...structuredClone(value),
      available: false,
      defaultSelected: false,
      unavailableReason: value.qualification,
    };
  });
  return {
    schemaVersion: 1,
    defaultTargetIds: [...document.defaultTargetIds],
    localTargets,
    singleSiteFullProfileTargetIds: [...rawSingleSiteFullProfileTargetIds],
    singleSiteTargets,
    providerTargets,
  };
}

export function loadPortalTargetRegistry(path, environment = process.env, pathExists = existsSync) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  return validatePortalTargetRegistryDocument(document, environment, pathExists);
}
