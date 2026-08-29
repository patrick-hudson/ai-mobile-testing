import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import {
  canonicalPlaywrightSelection,
  compileCanonicalExecutionGraph,
  compileIncompleteWorkRekick,
  compileSingleSiteInventoryBarrier,
  completeSingleSiteInventoryBarrier,
  nextSingleSiteInventoryAttempt,
} from '../shared/execution-graph-compiler.mjs';
import { compileDefinitionCoverageManifest } from '../shared/run-compiler.mjs';

const DIGEST = (character) => `sha256:${character.repeat(64)}`;
const candidateOrigin = 'https://beta.example.test';
const productionOrigin = 'https://example.test';

const pluginRegistry = {
  schemaVersion: 1,
  plugins: [{
    id: 'core',
    version: '1.0.0',
    auditDefinitions: [
      { id: 'NAV-001', area: 'navigation', title: 'Navigation works', severity: 'P0', manual: false, singleSiteClassification: 'standalone-compatible', expected: 'Navigation works.' },
      { id: 'ENV-002', area: 'environment', title: 'Inventoried routes work', severity: 'P0', manual: false, singleSiteClassification: 'standalone-compatible', expected: 'Every discovered route renders valid HTML.' },
      { id: 'ENV-003', area: 'environment', title: 'Migration parity', severity: 'P1', manual: false, singleSiteClassification: 'comparison-only', expected: 'Candidate preserves production mappings.' },
      { id: 'MANUAL-001', area: 'accessibility', title: 'Human screen reader review', severity: 'P1', manual: true, singleSiteClassification: 'standalone-compatible', expected: 'A human reviews announcements.' },
    ],
    auditCases: [
      {
        caseId: 'NAV-001:standalone', auditId: 'NAV-001', entrySpec: 'tests/navigation.spec.ts', applicability: 'all',
        supportedModes: ['single-site'], supportedProjects: ['candidate-mobile'],
        oracleVariants: { singleSite: 'NAV-001:standalone' },
      },
      {
        caseId: 'ENV-002:standalone', auditId: 'ENV-002', entrySpec: 'tests/contracts.spec.ts', applicability: 'all',
        supportedModes: ['single-site'], supportedProjects: ['candidate-mobile'],
        oracleVariants: { singleSite: 'ENV-002:standalone' },
      },
      {
        caseId: 'NAV-001:comparative', auditId: 'NAV-001', entrySpec: 'tests/navigation.spec.ts', applicability: 'all',
        supportedModes: ['comparative'], supportedProjects: ['production-mobile', 'candidate-mobile'],
        oracleVariants: { comparative: 'NAV-001:comparative' },
      },
      {
        caseId: 'ENV-003:comparative', auditId: 'ENV-003', entrySpec: 'tests/contracts.spec.ts', applicability: 'all',
        supportedModes: ['comparative'], supportedProjects: ['production-mobile', 'candidate-mobile'],
        oracleVariants: { comparative: 'ENV-003:comparative' },
      },
      {
        caseId: 'ENV-003:production-context', auditId: 'ENV-003', entrySpec: 'tests/contracts.spec.ts', applicability: 'production',
        supportedModes: ['comparative'], supportedProjects: ['production-mobile'],
        oracleVariants: { comparative: 'ENV-003:production-context' },
      },
    ],
  }],
};

const targetRegistry = {
  schemaVersion: 1,
  defaultTargetIds: ['production-mobile', 'candidate-mobile'],
  localTargets: [
    { id: 'production-mobile', environment: 'production', engine: 'chromium', browserProduct: 'chromium', deviceClass: 'mobile' },
    { id: 'candidate-mobile', environment: 'candidate', engine: 'chromium', browserProduct: 'chromium', deviceClass: 'mobile' },
  ],
  singleSiteFullProfileTargetIds: ['single-mobile', 'single-desktop'],
  singleSiteTargets: [
    { id: 'single-mobile', sourceComparativeTargetId: 'candidate-mobile', engine: 'chromium', browserProduct: 'chromium', deviceClass: 'mobile' },
    { id: 'single-desktop', sourceComparativeTargetId: 'candidate-mobile', engine: 'chromium', browserProduct: 'chromium', deviceClass: 'desktop' },
  ],
};

function subject({ mode, definitions, targets, features, knownLimits = [], certificatePolicy = 'strict' }) {
  return sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: { kind: 'build', value: 'build-123' },
    targets: mode === 'single-site'
      ? [{ role: 'audited', origin: candidateOrigin }]
      : [{ role: 'candidate', origin: candidateOrigin }, { role: 'production', origin: productionOrigin }],
    mode,
    requestedAuthority: { qualifier: 'TARGETED', scope: { features, definitions, targets, knownLimits } },
    revisions: { runner: DIGEST('1'), plugins: canonicalDigest(pluginRegistry), targets: canonicalDigest(targetRegistry), configuration: DIGEST('2') },
    environmentIdentity: DIGEST('3'),
    certificatePolicy,
  });
}

const inventory = {
  schemaVersion: 1,
  origin: candidateOrigin,
  routes: [{ url: candidateOrigin, path: '/', query: '', disposition: 'included', sources: [{ source: 'catalog', from: null, depth: 0 }] }],
  limitations: [], failures: [],
};

const singleCore = subject({ mode: 'single-site', definitions: ['NAV-001'], targets: ['single-mobile'], features: ['navigation'] });
const singleBarrier = compileSingleSiteInventoryBarrier({ subjectCore: singleCore, pluginRegistry, targetRegistry, maxAttempts: 2 });
assert.equal(singleBarrier.workItem.capability, 'route-inventory');
assert.equal(nextSingleSiteInventoryAttempt({ subjectCore: singleCore, barrier: singleBarrier, failedAttempt: 1 }).attempt, 2);
const singleInventoryCompletion = completeSingleSiteInventoryBarrier({
  subjectCore: singleCore,
  barrier: singleBarrier,
  attempt: 2,
  routeInventory: inventory,
  deploymentIdentityRecheck: singleCore.deploymentIdentity,
});
const single = compileCanonicalExecutionGraph({
  subjectCore: singleCore,
  pluginRegistry,
  targetRegistry,
  inventoryCompletion: singleInventoryCompletion,
  deploymentIdentityRecheck: singleCore.deploymentIdentity,
});
assert.equal(single.mode, 'single-site');
assert.equal(single.executionManifest.workItems.length, 1);
assert.equal(single.executionManifest.oracleExecutions.length, 1);
assert.equal(single.workItemPlans[0].inventoryDigest, canonicalDigest(inventory));
assert.deepEqual(single.coverageBasis.excludedAsNotApplicable, ['ENV-003']);
assert.equal(single.finalSubject.digest, single.finalSubjectDigest);
assert.deepEqual(single.finalSubject.grantedAuthority, singleCore.requestedAuthority);
assert.deepEqual(compileCanonicalExecutionGraph({
  subjectCore: singleCore, pluginRegistry, targetRegistry, routeInventory: inventory,
  inventoryCompletion: singleInventoryCompletion,
  deploymentIdentityRecheck: singleCore.deploymentIdentity,
}), single, 'Compilation must be deterministic and independent of scheduling topology.');
assert.throws(
  () => nextSingleSiteInventoryAttempt({ subjectCore: singleCore, barrier: singleBarrier, failedAttempt: 1, sealedGraph: single }),
  (error) => error?.code === 'INVENTORY_ALREADY_SEALED',
  'Inventory may retry only before the graph is sealed.',
);
const rekick = compileIncompleteWorkRekick({ graph: single, incompleteWorkItemIds: [single.workItemPlans[0].id] });
assert.equal(rekick.executionManifestDigest, single.executionManifest.digest);
assert.equal(rekick.inventoryDigest, single.inventory.inventoryDigest);
assert.equal(rekick.workItemPlans[0].id, single.workItemPlans[0].id, 'Incomplete-only repacking must retain canonical work identity.');
assert.deepEqual(canonicalPlaywrightSelection(single), {
  mode: 'single-site',
  caseIds: ['NAV-001:standalone'],
  targetIds: ['single-mobile'],
  executionIds: [single.workItemPlans[0].id],
  authoritativeExecutionIds: [single.workItemPlans[0].id],
  contextExecutionIds: [],
});

const routeCore = subject({ mode: 'single-site', definitions: ['ENV-002'], targets: ['single-mobile'], features: ['environment'] });
const routeBarrier = compileSingleSiteInventoryBarrier({ subjectCore: routeCore, pluginRegistry, targetRegistry });
const routeGraph = compileCanonicalExecutionGraph({
  subjectCore: routeCore,
  pluginRegistry,
  targetRegistry,
  inventoryCompletion: completeSingleSiteInventoryBarrier({
    subjectCore: routeCore,
    barrier: routeBarrier,
    attempt: 1,
    routeInventory: {
      ...inventory,
      routes: [...inventory.routes, {
        url: `${candidateOrigin}/discovered`, path: '/discovered', query: '', disposition: 'included',
        sources: [{ source: 'crawl', from: candidateOrigin, depth: 1 }],
      }],
    },
    deploymentIdentityRecheck: routeCore.deploymentIdentity,
  }),
  deploymentIdentityRecheck: routeCore.deploymentIdentity,
});
assert(routeGraph.workItemPlans.some(({ caseId, routeUrl }) => caseId.startsWith('GENERIC-ROUTE-') && routeUrl === `${candidateOrigin}/discovered`));

const comparativeCore = subject({
  mode: 'comparative', definitions: ['ENV-003'], targets: ['production-mobile', 'candidate-mobile'], features: ['environment'],
});
const comparative = compileCanonicalExecutionGraph({
  subjectCore: comparativeCore,
  pluginRegistry,
  targetRegistry,
  deploymentIdentityRecheck: comparativeCore.deploymentIdentity,
});
assert.equal(comparative.executionManifest.oracleExecutions.length, 1);
assert.deepEqual(
  comparative.executionManifest.oracleExecutions[0].requiredWorkItemIds,
  comparative.executionManifest.workItems.map(({ id }) => id),
  'A Comparative oracle must remain incomplete until its declared candidate/production tuple is adopted.',
);
assert.deepEqual([...new Set(comparative.executionManifest.workItems.map(({ targetRole }) => targetRole))].sort(), ['candidate', 'production']);
assert.equal(comparative.oraclePlans[0].baselinePolicy, 'context-unless-candidate-regression-proven');
assert.equal(comparative.contextPlans.length, 1);
assert.equal(comparative.contextPlans[0].targetRole, 'production');
assert.equal(comparative.contextPlans[0].authority, 'non-blocking-production-baseline-context');
const comparativeSelection = canonicalPlaywrightSelection(comparative);
assert(comparativeSelection.caseIds.includes('ENV-003:production-context'), 'Production-only baseline context must still be scheduled.');
assert.deepEqual(comparativeSelection.contextExecutionIds, comparative.contextPlans.map(({ id }) => id));
assert.throws(
  () => compileCanonicalExecutionGraph({
    subjectCore: subject({ mode: 'comparative', definitions: ['ENV-003'], targets: ['production-mobile'], features: ['environment'] }),
    pluginRegistry, targetRegistry, deploymentIdentityRecheck: comparativeCore.deploymentIdentity,
  }),
  (error) => ['EMPTY_EXECUTION_MANIFEST', 'AUTHORITY_SCOPE_MISMATCH'].includes(error?.code),
  'Production-only evidence must never seal a Comparative Product Oracle.',
);

assert.throws(
  () => compileCanonicalExecutionGraph({
    subjectCore: subject({ mode: 'single-site', definitions: ['ENV-003'], targets: ['single-mobile'], features: ['environment'] }),
    pluginRegistry, targetRegistry, inventoryCompletion: completeSingleSiteInventoryBarrier({
      subjectCore: subject({ mode: 'single-site', definitions: ['ENV-003'], targets: ['single-mobile'], features: ['environment'] }),
      barrier: compileSingleSiteInventoryBarrier({
        subjectCore: subject({ mode: 'single-site', definitions: ['ENV-003'], targets: ['single-mobile'], features: ['environment'] }),
        pluginRegistry, targetRegistry,
      }),
      attempt: 1, routeInventory: inventory, deploymentIdentityRecheck: singleCore.deploymentIdentity,
    }), deploymentIdentityRecheck: singleCore.deploymentIdentity,
  }),
  (error) => error?.code === 'NOT_APPLICABLE_DEFINITION',
);
assert.throws(
  () => {
    const wrongFeatureCore = subject({ mode: 'single-site', definitions: ['NAV-001'], targets: ['single-mobile'], features: ['wrong-feature'] });
    const wrongFeatureBarrier = compileSingleSiteInventoryBarrier({ subjectCore: wrongFeatureCore, pluginRegistry, targetRegistry });
    return compileCanonicalExecutionGraph({
      subjectCore: wrongFeatureCore,
      pluginRegistry,
      targetRegistry,
      inventoryCompletion: completeSingleSiteInventoryBarrier({
        subjectCore: wrongFeatureCore, barrier: wrongFeatureBarrier, attempt: 1,
        routeInventory: inventory, deploymentIdentityRecheck: wrongFeatureCore.deploymentIdentity,
      }),
      deploymentIdentityRecheck: wrongFeatureCore.deploymentIdentity,
    });
  },
  (error) => error?.code === 'AUTHORITY_SCOPE_MISMATCH',
);
assert.throws(
  () => compileCanonicalExecutionGraph({
    subjectCore: singleCore, pluginRegistry, targetRegistry,
    inventoryCompletion: completeSingleSiteInventoryBarrier({
      subjectCore: singleCore, barrier: singleBarrier, attempt: 1,
      routeInventory: { ...inventory, origin: productionOrigin }, deploymentIdentityRecheck: singleCore.deploymentIdentity,
    }), deploymentIdentityRecheck: singleCore.deploymentIdentity,
  }),
  (error) => error?.code === 'INVENTORY_BINDING_MISMATCH',
);

const actualPluginRegistry = JSON.parse(await readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8'));
const actualTargetRegistry = JSON.parse(await readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8'));
const actualTargetIds = actualTargetRegistry.singleSiteFullProfileTargetIds;
const legacyCoverage = compileDefinitionCoverageManifest({
  runContract: {
    schemaVersion: 1, mode: 'single-site', url: candidateOrigin, deploymentRole: 'preview', certificatePolicy: 'strict',
    targetIds: actualTargetIds, scope: { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
  },
  pluginRegistry: actualPluginRegistry,
  targetRegistry: actualTargetRegistry,
  preflightBinding: {
    schemaVersion: 1, url: candidateOrigin, deploymentRole: 'preview', identityFingerprint: 'fixture-identity',
    deploymentRevision: { status: 'identified', value: 'build-123' },
    evidenceAuthority: { status: 'authoritative', reasons: [] },
  },
  runnerRevision: 'runner-image:sha256:fixture',
});
const actualDefinitions = legacyCoverage.selectedDefinitions.filter(({ manual }) => !manual);
const actualCore = sealReleaseSubjectCore({
  schemaVersion: 1,
  deploymentIdentity: { kind: 'build', value: 'build-123' },
  targets: [{ role: 'audited', origin: candidateOrigin }],
  mode: 'single-site',
  requestedAuthority: {
    qualifier: 'FULL',
    scope: {
      features: [...new Set(actualDefinitions.map(({ area }) => area))].sort(),
      definitions: actualDefinitions.map(({ auditId }) => auditId).sort(),
      targets: [...actualTargetIds].sort(),
      knownLimits: [],
    },
  },
  revisions: {
    runner: DIGEST('4'), plugins: canonicalDigest(actualPluginRegistry), targets: canonicalDigest(actualTargetRegistry), configuration: DIGEST('5'),
  },
  environmentIdentity: DIGEST('6'),
  certificatePolicy: 'strict',
});
const actualGraph = compileCanonicalExecutionGraph({
  subjectCore: actualCore,
  pluginRegistry: actualPluginRegistry,
  targetRegistry: actualTargetRegistry,
  inventoryCompletion: completeSingleSiteInventoryBarrier({
    subjectCore: actualCore,
    barrier: compileSingleSiteInventoryBarrier({ subjectCore: actualCore, pluginRegistry: actualPluginRegistry, targetRegistry: actualTargetRegistry }),
    attempt: 1,
    routeInventory: inventory,
    deploymentIdentityRecheck: actualCore.deploymentIdentity,
  }),
  deploymentIdentityRecheck: actualCore.deploymentIdentity,
});
assert.deepEqual(
  actualGraph.workItemPlans.map(({ caseId, targetId }) => `${caseId}@${targetId}`).sort(),
  legacyCoverage.executions.map(({ caseId, targetId }) => `${caseId}@${targetId}`).sort(),
  'The canonical graph must preserve every existing Single-site executable Product Oracle membership.',
);

const comparativeTargetIds = actualTargetRegistry.defaultTargetIds;
const comparativeDefinitions = actualPluginRegistry.plugins.flatMap(({ auditDefinitions, auditCases }) => auditDefinitions
  .filter(({ manual }) => !manual)
  .filter((definition) => auditCases.some((auditCase) => auditCase.auditId === definition.id
    && auditCase.supportedModes.includes('comparative')
    && comparativeTargetIds.some((targetId) => auditCase.supportedProjects.includes(targetId)))));
const actualComparativeCore = sealReleaseSubjectCore({
  schemaVersion: 1,
  deploymentIdentity: { kind: 'build', value: 'build-123' },
  targets: [{ role: 'candidate', origin: candidateOrigin }, { role: 'production', origin: productionOrigin }],
  mode: 'comparative',
  requestedAuthority: {
    qualifier: 'FULL',
    scope: {
      features: [...new Set(comparativeDefinitions.map(({ area }) => area))].sort(),
      definitions: comparativeDefinitions.map(({ id }) => id).sort(),
      targets: [...comparativeTargetIds].sort(),
      knownLimits: [],
    },
  },
  revisions: {
    runner: DIGEST('7'), plugins: canonicalDigest(actualPluginRegistry), targets: canonicalDigest(actualTargetRegistry), configuration: DIGEST('8'),
  },
  environmentIdentity: DIGEST('9'),
  certificatePolicy: 'strict',
});
const actualComparativeGraph = compileCanonicalExecutionGraph({
  subjectCore: actualComparativeCore,
  pluginRegistry: actualPluginRegistry,
  targetRegistry: actualTargetRegistry,
  deploymentIdentityRecheck: actualComparativeCore.deploymentIdentity,
});
const actualWorkById = new Map(actualComparativeGraph.workItemPlans.map((plan) => [plan.id, plan]));
assert(actualComparativeGraph.oraclePlans.every(({ requiredWorkItemIds }) => (
  requiredWorkItemIds.some((id) => actualWorkById.get(id)?.targetRole === 'candidate')
)), 'Every real Comparative Product Oracle must contain candidate evidence.');

process.stdout.write('Canonical graph compiler self-test passed: Single-site inventory and Comparative paired Product Oracles share one sealed graph contract.\n');
