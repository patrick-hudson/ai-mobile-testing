import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INSTALLED_PLUGIN_REGISTRY, mergeAuditDefinitionCatalog } from '../audit/definitions.js';
import { PAGE_AUDIT_ENTRY_SPEC, pageAuditFamilyMembers } from '../audit/page-audit-family.js';
import {
  createPluginRegistry,
  validatePluginRegistryDocument,
  type InstalledPlugin,
} from '../audit/plugins.js';
import type { AuditDefinition } from '../audit/types.js';
import { LOCAL_AUDIT_TARGETS } from '../audit/targets.js';
import { applicableTargetIds } from '../shared/target-applicability.mjs';
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
  singleSiteClassification: 'standalone-compatible',
  standaloneOracle: {
    id: 'PLUGIN-P0-MANUAL-001:standalone',
    expected: 'A named reviewer records supported-device evidence for the audited deployment.',
  },
  manual: true,
} satisfies AuditDefinition;
const portalFixtureTargets = [{
  id: 'candidate-mobile-chromium',
  environment: 'candidate',
  deviceClass: 'mobile',
  engine: 'chromium',
  fullSweep: true,
}] as const;

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
    auditFamilies: [],
    entrySpecs: ['tests/smoke.spec.ts'],
    supportedProjects: ['candidate-mobile-chromium'],
  },
  resolvedAuditDefinitions: [inlineGate],
  resolvedAuditCases: [],
};

const routePlugin = INSTALLED_PLUGIN_REGISTRY.plugins.find(({ id }) => id === 'platform-routes-content');
assert(routePlugin, 'The platform route plugin must be installed.');
const generatedPageAudits = routePlugin.auditDefinitions.filter(({ id }) => id.startsWith('PAGE-'));
const familyMembers = pageAuditFamilyMembers();
assert(generatedPageAudits.length >= 50, 'The route family must expose every published page as a first-class portal audit.');
assert.deepEqual(
  generatedPageAudits.map(({ id }) => id).sort(),
  familyMembers.map(({ definition }) => definition.id).sort(),
  'The generated PAGE definition registry must equal the reviewed route family exactly.',
);
const pageCases = routePlugin.auditCases.filter(({ auditId }) => auditId.startsWith('PAGE-'));
const caseCounts = new Map<string, number>();
for (const { auditId } of pageCases) caseCounts.set(auditId, (caseCounts.get(auditId) ?? 0) + 1);
assert.deepEqual(
  [...caseCounts].filter(([, count]) => count !== 1),
  [],
  'Every generated PAGE definition must have exactly one executable case.',
);
assert.deepEqual(
  pageCases
    .map(({ auditId, entrySpec, applicability, supportedProjects }) => ({
      auditId,
      entrySpec,
      applicability,
      supportedProjects,
    }))
    .sort((left, right) => left.auditId.localeCompare(right.auditId)),
  familyMembers
    .map(({ definition, applicability }) => ({
      auditId: definition.id,
      entrySpec: PAGE_AUDIT_ENTRY_SPEC,
      applicability,
      supportedProjects: applicableTargetIds(applicability, LOCAL_AUDIT_TARGETS),
    }))
    .sort((left, right) => left.auditId.localeCompare(right.auditId)),
  'PAGE executable cases must equal the route-specific family expansion, including candidate-only applicability.',
);
assert(
  pageCases.some(({ applicability }) => applicability === 'candidate-full-sweep-projects'),
  'At least one reviewed candidate-only route must prove that production is not advertised and silently skipped.',
);

const missingPageCase = structuredClone(INSTALLED_PLUGIN_REGISTRY);
const missingCasePlugin = missingPageCase.plugins.find(({ id }) => id === 'platform-routes-content');
assert(missingCasePlugin);
const removedPageCase = missingCasePlugin.auditCases.findIndex(({ auditId }) => auditId.startsWith('PAGE-'));
assert.notEqual(removedPageCase, -1);
missingCasePlugin.auditCases.splice(removedPageCase, 1);
assert.throws(
  () => validatePluginRegistryDocument(missingPageCase),
  /PAGE cases must contain exactly one route-specific executable case|omit automated audits/i,
  'Deleting one generated PAGE case must fail the exact family registry gate.',
);

const duplicatePageCase = structuredClone(INSTALLED_PLUGIN_REGISTRY);
const duplicateCasePlugin = duplicatePageCase.plugins.find(({ id }) => id === 'platform-routes-content');
assert(duplicateCasePlugin);
const firstPageCase = duplicateCasePlugin.auditCases.find(({ auditId }) => auditId.startsWith('PAGE-'));
assert(firstPageCase);
duplicateCasePlugin.auditCases.push(structuredClone(firstPageCase));
assert.throws(
  () => validatePluginRegistryDocument(duplicatePageCase),
  /duplicate executable cases/i,
  'Duplicating a PAGE case must fail instead of being silently deduplicated.',
);

const missingClassification = structuredClone(INSTALLED_PLUGIN_REGISTRY) as unknown as {
  plugins: Array<{ auditDefinitions: Array<{ singleSiteClassification?: string }> }>;
};
delete missingClassification.plugins[0]!.auditDefinitions[0]!.singleSiteClassification;
assert.throws(
  () => validatePluginRegistryDocument(missingClassification),
  /singleSiteClassification/i,
  'Every generated definition must declare its Single-site classification.',
);

const missingStandaloneOracle = structuredClone(INSTALLED_PLUGIN_REGISTRY) as unknown as {
  plugins: Array<{ auditDefinitions: Array<{ singleSiteClassification: string; standaloneOracle?: unknown }> }>;
};
const compatibleDefinition = missingStandaloneOracle.plugins
  .flatMap(({ auditDefinitions }) => auditDefinitions)
  .find(({ singleSiteClassification }) => singleSiteClassification === 'standalone-compatible');
assert(compatibleDefinition);
delete compatibleDefinition.standaloneOracle;
assert.throws(
  () => validatePluginRegistryDocument(missingStandaloneOracle),
  /standaloneOracle/i,
  'Standalone-compatible definitions must retain a named Product Oracle.',
);

const missingSupportedModes = structuredClone(INSTALLED_PLUGIN_REGISTRY) as unknown as {
  plugins: Array<{ auditCases: Array<{ supportedModes?: string[] }> }>;
};
delete missingSupportedModes.plugins.find(({ auditCases }) => auditCases.length > 0)!.auditCases[0]!.supportedModes;
assert.throws(
  () => validatePluginRegistryDocument(missingSupportedModes),
  /supportedModes/i,
  'Every executable case must declare its supported run modes.',
);

const missingComparativeOracle = structuredClone(INSTALLED_PLUGIN_REGISTRY) as unknown as {
  plugins: Array<{ auditCases: Array<{ oracleVariants: { comparative?: string } }> }>;
};
delete missingComparativeOracle.plugins.find(({ auditCases }) => auditCases.length > 0)!.auditCases[0]!.oracleVariants.comparative;
assert.throws(
  () => validatePluginRegistryDocument(missingComparativeOracle),
  /comparative Product Oracle/i,
  'Every executable case must retain its comparative Product Oracle variant.',
);

const strippedSingleSiteCoverage = structuredClone(INSTALLED_PLUGIN_REGISTRY);
const compatibleOwner = strippedSingleSiteCoverage.plugins.find(({ auditDefinitions, auditCases }) => (
  auditDefinitions.some(({ id, manual, singleSiteClassification }) => !manual
    && singleSiteClassification === 'standalone-compatible'
    && auditCases.some((auditCase) => auditCase.auditId === id))
));
assert(compatibleOwner);
const compatibleAuditId = compatibleOwner.auditDefinitions.find(({ id, manual, singleSiteClassification }) => !manual
  && singleSiteClassification === 'standalone-compatible'
  && compatibleOwner.auditCases.some((auditCase) => auditCase.auditId === id))!.id;
for (const auditCase of compatibleOwner.auditCases.filter(({ auditId }) => auditId === compatibleAuditId)) {
  auditCase.supportedModes = ['comparative'];
  auditCase.oracleVariants = { comparative: auditCase.oracleVariants.comparative ?? `${compatibleAuditId}:comparative` };
}
assert.throws(
  () => validatePluginRegistryDocument(strippedSingleSiteCoverage),
  /omit Single-site cases for standalone-compatible audits/i,
  'A standalone-compatible automated definition must not silently lose all Single-site executable coverage.',
);

const installedDefinitions = new Map(INSTALLED_PLUGIN_REGISTRY.plugins
  .flatMap(({ auditDefinitions }) => auditDefinitions)
  .map((definition) => [definition.id, definition]));
for (const auditCase of INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ auditCases }) => auditCases)) {
  const definition = installedDefinitions.get(auditCase.auditId);
  assert(definition, `Missing definition for executable case ${auditCase.caseId}.`);
  if (definition.singleSiteClassification === 'standalone-compatible') {
    assert(auditCase.supportedModes.includes('single-site'), `${auditCase.caseId} dropped Single-site support.`);
    assert.equal(auditCase.oracleVariants.singleSite, definition.standaloneOracle?.id);
  } else if (definition.singleSiteClassification === 'comparison-only') {
    assert(!auditCase.supportedModes.includes('single-site'), `${auditCase.caseId} falsely advertises Single-site support.`);
    assert.equal(auditCase.oracleVariants.singleSite, undefined);
  }
}
const content002 = installedDefinitions.get('CONTENT-002');
assert.equal(content002?.singleSiteClassification, 'standalone-required');
const content002Cases = INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ auditCases }) => auditCases)
  .filter(({ auditId }) => auditId === 'CONTENT-002');
assert(content002Cases.some(({ supportedModes }) => supportedModes.includes('comparative')),
  'CONTENT-002 must retain its paired comparative executable case.');
assert(content002Cases.some(({ supportedModes, oracleVariants }) => (
  supportedModes.length === 1
  && supportedModes[0] === 'single-site'
  && oracleVariants.singleSite === 'CONTENT-002:standalone-content-primitives'
)), 'CONTENT-002 must retain its independent standalone Product Oracle case.');
assert(content002Cases.some(({ supportedModes, oracleVariants }) => (
  supportedModes.length === 1
  && supportedModes[0] === 'comparative'
  && oracleVariants.singleSite === undefined
)), 'CONTENT-002 paired visual case must remain excluded from Single-site compilation metadata.');

const changedPageDefinition = structuredClone(INSTALLED_PLUGIN_REGISTRY);
const changedDefinitionPlugin = changedPageDefinition.plugins.find(({ id }) => id === 'platform-routes-content');
assert(changedDefinitionPlugin);
const firstPageDefinition = changedDefinitionPlugin.auditDefinitions.find(({ id }) => id.startsWith('PAGE-'));
assert(firstPageDefinition);
firstPageDefinition.expected = `${firstPageDefinition.expected} weakened`;
assert.throws(
  () => validatePluginRegistryDocument(changedPageDefinition),
  /PAGE definitions must equal the reviewed candidate-html-routes family exactly/i,
  'Changing generated PAGE metadata must fail the exact family registry gate.',
);

const generated = createPluginRegistry([installedPlugin]);
const validated = validatePluginRegistryDocument(generated);
assert.deepEqual(validated.plugins[0]?.auditDefinitions[0], inlineGate, 'generated registry dropped inline metadata');

const nonBlockingP0 = structuredClone(generated) as unknown as {
  plugins: Array<{ auditDefinitions: Array<{ severity: string; releaseBlocking: boolean }> }>;
};
nonBlockingP0.plugins[0]!.auditDefinitions[0]!.releaseBlocking = false;
assert.throws(
  () => validatePluginRegistryDocument(nonBlockingP0),
  /releaseBlocking must be true for P0 and P1|non-blocking P0/i,
  'A plugin must never downgrade P0/P1 release authority.',
);

const automatedWithoutCase = structuredClone(generated) as unknown as {
  plugins: Array<{ auditDefinitions: Array<{ manual?: boolean }>; auditCases: unknown[] }>;
};
delete automatedWithoutCase.plugins[0]!.auditDefinitions[0]!.manual;
assert.throws(
  () => validatePluginRegistryDocument(automatedWithoutCase),
  /auditCases must cover every automated audit|omit automated audits/i,
  'An automated plugin audit with zero executable cases must fail closed.',
);

const fixtureCatalog = mergeAuditDefinitionCatalog([], validated);
assert.deepEqual(fixtureCatalog[0], inlineGate, 'fixture definition resolver changed inline metadata');

const portalPlugins = validatePortalPluginRegistryDocument(generated, {
  coreDefinitions: [],
  projectIds: new Set(['candidate-mobile-chromium']),
  localTargets: portalFixtureTargets,
  resolveEntrySpec: () => true,
});
const portalCatalog = mergePortalCatalog([], portalPlugins);
assert.deepEqual(portalCatalog[0], inlineGate, 'portal changed inline metadata');

const fullPortalPlugins = validatePortalPluginRegistryDocument(INSTALLED_PLUGIN_REGISTRY, {
  coreDefinitions: [],
  projectIds: new Set(LOCAL_AUDIT_TARGETS.map(({ id }) => id)),
  localTargets: LOCAL_AUDIT_TARGETS,
  resolveEntrySpec: () => true,
});
assert.deepEqual(
  fullPortalPlugins.flatMap(({ auditCases }) => auditCases),
  INSTALLED_PLUGIN_REGISTRY.plugins.flatMap(({ auditCases }) => auditCases),
  'portal changed executable case identity, supported modes, or Product Oracle variants',
);

const downgraded = structuredClone(generated) as unknown as { plugins: Array<{ auditDefinitions: Array<Record<string, unknown>> }> };
delete downgraded.plugins[0]?.auditDefinitions[0]?.releaseBlocking;
assert.throws(
  () => validatePortalPluginRegistryDocument(downgraded, {
    coreDefinitions: [],
    projectIds: new Set(['candidate-mobile-chromium']),
    localTargets: portalFixtureTargets,
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
