import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { devices } from '@playwright/test';
import {
  DEFAULT_AUDIT_TARGET_IDS,
  LOCAL_AUDIT_TARGETS,
  PROVIDER_TARGET_CATALOG,
  auditTargetRegistryDocument,
  detectAuditTargetCapabilities,
  resolveAuditTargetSelection,
  validateAuditTargetCatalog,
  type AuditTargetCapabilities,
  type AuditTargetDefinition,
} from '../audit/targets.js';
import { applicableTargetIds } from '../shared/target-applicability.mjs';

const unavailableCapabilities: AuditTargetCapabilities = {
  msedge: {
    available: false,
    declared: false,
    executablePath: null,
    reason: 'self-test capability is disabled',
  },
};
const availableCapabilities: AuditTargetCapabilities = {
  msedge: {
    available: true,
    declared: true,
    executablePath: '/opt/microsoft/msedge/msedge',
    reason: 'self-test capability is available',
  },
};

validateAuditTargetCatalog();
assert.deepEqual(
  JSON.parse(readFileSync(new URL('../audit/targets.generated.json', import.meta.url), 'utf8')),
  auditTargetRegistryDocument(),
  'The browser-safe generated target registry must match the executable registry exactly.',
);
assert.deepEqual(
  resolveAuditTargetSelection(undefined, unavailableCapabilities).map(({ id }) => id),
  [...DEFAULT_AUDIT_TARGET_IDS],
  'An unset target override must preserve the seven-project release matrix exactly.',
);
assert.deepEqual(
  resolveAuditTargetSelection('', unavailableCapabilities).map(({ id }) => id),
  [...DEFAULT_AUDIT_TARGET_IDS],
  'Compose may forward an empty target variable; it must retain the established defaults.',
);

const optInIds = LOCAL_AUDIT_TARGETS.filter(({ defaultEnabled }) => !defaultEnabled).map(({ id }) => id);
assert.ok(optInIds.length >= 7, 'Popular opt-in browser/device coverage must be present.');
assert.ok(optInIds.every((id) => !DEFAULT_AUDIT_TARGET_IDS.includes(id as never)), 'Opt-in targets must not inflate the default matrix.');
assert.ok(LOCAL_AUDIT_TARGETS.every(({ deviceDescriptor }) => devices[deviceDescriptor]), 'Every local target must use a shipped Playwright descriptor.');
assert.ok(PROVIDER_TARGET_CATALOG.every(({ runnable, fidelity }) => runnable === false && fidelity === 'real-device'), 'Real-device rows must remain metadata-only.');

const representative = resolveAuditTargetSelection(
  'candidate-mobile-webkit-iphone-17-ios18,candidate-mobile-chromium-pixel-10-android16,candidate-mobile-chromium-galaxy-s24-android14,candidate-desktop-chromium-edge-compat',
  unavailableCapabilities,
);
assert.deepEqual(
  representative.map(({ deviceDescriptor }) => deviceDescriptor),
  ['iPhone 17', 'Pixel 10', 'Galaxy S24', 'Desktop Edge'],
);
assert.match(devices['iPhone 17'].userAgent, /iPhone OS 18_7/, 'The iOS 18 target label must agree with the pinned descriptor UA.');
assert.match(devices['iPhone 15'].userAgent, /iPhone OS 17_5/, 'The iOS 17 target label must agree with the pinned descriptor UA.');
assert.match(devices['Pixel 10'].userAgent, /Android 16/, 'The Android 16 target label must agree with the pinned descriptor UA.');
assert.match(devices['Pixel 8'].userAgent, /Android 14/, 'The Android 14 Pixel target label must agree with the pinned descriptor UA.');
assert.match(devices['Galaxy S24'].userAgent, /Android 14/, 'The Android 14 Galaxy target label must agree with the pinned descriptor UA.');
assert.deepEqual(
  applicableTargetIds('candidate-mobile-chromium', LOCAL_AUDIT_TARGETS),
  [
    'candidate-mobile-chromium',
    'candidate-mobile-chromium-pixel-10-android16',
    'candidate-mobile-chromium-pixel-8-android14',
    'candidate-mobile-chromium-galaxy-s24-android14',
  ],
  'Historical mobile Chromium applicability must include every matching Android emulation.',
);
assert.deepEqual(
  applicableTargetIds('candidate-desktop-chromium', LOCAL_AUDIT_TARGETS),
  [
    'candidate-desktop-chromium',
    'candidate-desktop-chromium-edge-compat',
    'candidate-desktop-chromium-msedge',
  ],
  'Historical desktop Chromium applicability must include Edge-compatible and branded Edge opt-ins.',
);

assert.throws(
  () => resolveAuditTargetSelection('does-not-exist', unavailableCapabilities),
  /Unknown AUDIT_TARGET_IDS value/,
  'Unknown target IDs must fail before Playwright starts.',
);
assert.throws(
  () => resolveAuditTargetSelection('candidate-mobile-chromium,candidate-mobile-chromium', unavailableCapabilities),
  /duplicate target IDs/,
  'Duplicate target requests must fail rather than conceal an operator mistake.',
);
assert.throws(
  () => resolveAuditTargetSelection('provider-real-ios-safari-current', unavailableCapabilities),
  /provider metadata, not a runnable target/,
  'A local emulation must never masquerade as real-device evidence.',
);
assert.throws(
  () => resolveAuditTargetSelection('candidate-desktop-chromium-msedge', unavailableCapabilities),
  /unavailable.*INSTALL_MSEDGE=1/s,
  'Branded Edge must fail closed when the image capability is absent.',
);
assert.equal(
  resolveAuditTargetSelection('candidate-desktop-chromium-msedge', availableCapabilities)[0]?.browserProduct,
  'microsoft-edge',
  'The branded Edge target must resolve only with a verified capability.',
);

assert.deepEqual(
  detectAuditTargetCapabilities({ AUDIT_MSEDGE_AVAILABLE: '1' }, (path) => path === '/opt/microsoft/msedge/msedge'),
  {
    msedge: {
      available: true,
      declared: true,
      executablePath: '/opt/microsoft/msedge/msedge',
      reason: 'Branded Microsoft Edge capability verified at /opt/microsoft/msedge/msedge.',
    },
  },
);
assert.equal(
  detectAuditTargetCapabilities({ AUDIT_MSEDGE_AVAILABLE: '1' }, () => false).msedge.available,
  false,
  'A build flag without an executable must not authorize branded Edge.',
);
assert.throws(
  () => detectAuditTargetCapabilities({ AUDIT_MSEDGE_AVAILABLE: 'yes' }, () => true),
  /must be exactly 0 or 1/,
);

const duplicateCatalog = [
  ...LOCAL_AUDIT_TARGETS,
  { ...LOCAL_AUDIT_TARGETS[0] },
] as unknown as AuditTargetDefinition[];
assert.throws(
  () => validateAuditTargetCatalog(duplicateCatalog, PROVIDER_TARGET_CATALOG),
  /Duplicate target ID/,
  'Registry extensions must reject duplicate IDs.',
);

console.log(`Target registry self-test passed (${DEFAULT_AUDIT_TARGET_IDS.length} defaults, ${optInIds.length} opt-ins, ${PROVIDER_TARGET_CATALOG.length} provider metadata rows).`);
