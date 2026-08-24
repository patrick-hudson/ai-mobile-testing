import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mergeAuditDefinitionCatalog } from '../audit/definitions.js';
import {
  createPluginRegistry,
  validatePluginRegistryDocument,
  type InstalledPlugin,
} from '../audit/plugins.js';
import type { AuditDefinition } from '../audit/types.js';
import { validatePortalPluginRegistryDocument, mergePortalCatalog } from '../portal/plugin-registry.mjs';
import { buildAuditManifest } from '../reporters/report-model.js';

const inlineGate = {
  id: 'PLUGIN-P0-MANUAL-001',
  area: 'accessibility',
  title: 'Plugin P0 manual release gate',
  userPromise: 'A reviewer must explicitly accept the plugin-owned critical experience.',
  severity: 'P0',
  releaseBlocking: true,
  expected: 'A named reviewer records supported-device evidence before release.',
  evidence: ['video', 'json'],
  evidencePolicy: {
    mode: 'interaction-video',
    rationale: 'Complete the physical-device journey and retain its observable action and response sequence.',
  },
  manual: true,
} satisfies AuditDefinition;

const installedPlugin: InstalledPlugin = {
  directory: 'metadata-safety-fixture',
  manifestPath: 'plugins/metadata-safety-fixture/plugin.json',
  manifest: {
    schemaVersion: 1,
    id: 'metadata-safety-fixture',
    version: '1.0.0',
    name: 'Metadata safety fixture',
    description: 'Proves inline release gating survives every metadata boundary.',
    enabled: true,
    tags: ['safety'],
    auditDefinitions: [inlineGate],
    entrySpecs: ['tests/smoke.spec.ts'],
    supportedProjects: ['candidate-mobile-chromium'],
  },
  resolvedAuditDefinitions: [inlineGate],
};

const generated = createPluginRegistry([installedPlugin]);
const validated = validatePluginRegistryDocument(generated);
assert.deepEqual(validated.plugins[0]?.auditDefinitions[0], inlineGate, 'generated registry dropped inline metadata');

const fixtureCatalog = mergeAuditDefinitionCatalog([], validated);
assert.deepEqual(fixtureCatalog[0], inlineGate, 'fixture definition resolver changed inline metadata');

const portalPlugins = validatePortalPluginRegistryDocument(generated, {
  coreDefinitions: [],
  projectIds: new Set(['candidate-mobile-chromium']),
  resolveEntrySpec: () => true,
});
const portalCatalog = mergePortalCatalog([], portalPlugins);
assert.deepEqual(portalCatalog[0], inlineGate, 'portal changed inline metadata');

const downgraded = structuredClone(generated) as unknown as { plugins: Array<{ auditDefinitions: Array<Record<string, unknown>> }> };
delete downgraded.plugins[0]?.auditDefinitions[0]?.releaseBlocking;
assert.throws(
  () => validatePortalPluginRegistryDocument(downgraded, {
    coreDefinitions: [],
    projectIds: new Set(['candidate-mobile-chromium']),
    resolveEntrySpec: () => true,
  }),
  /incomplete or invalid full audit definition/,
  'portal accepted a registry that dropped releaseBlocking',
);

const temporary = await mkdtemp(path.join(tmpdir(), 'plugin-metadata-safety-'));
try {
  const report = await buildAuditManifest({
    outputDir: temporary,
    definitionCatalog: fixtureCatalog,
    tests: [],
    run: { status: 'passed', source: 'playwright-reporter', profile: 'release' },
  });
  const gate = report.audits.find(({ id }) => id === inlineGate.id);
  assert.equal(gate?.definition.severity, 'P0');
  assert.equal(gate?.definition.releaseBlocking, true);
  assert.equal(gate?.manual, true);
  assert.equal(gate?.status, 'MANUAL_REQUIRED');
  assert.equal(report.release.ready, false);
  assert.equal(report.release.blockingIncomplete, 1);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write('Plugin metadata safety passed: registry, fixture resolution, portal validation, and report gating retain inline P0/manual truth.\n');
