import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
import {
  acquireCoordinator,
  adoptAttemptEvidence,
  claimWorkItem,
  createParentRun,
  openParentRunStore,
  publishAttemptEvidence,
  readParentRun,
  requestPerformanceDrain,
  sealParentRunGraph,
} from './lib/parent-run-store.mjs';

const DIGEST = (character) => `sha256:${character.repeat(64)}`;
const DURABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
      { id: 'PERF-001', area: 'performance', title: 'Performance budget', severity: 'P1', manual: false, singleSiteClassification: 'standalone-compatible', expected: 'Performance remains within budget.' },
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
      {
        caseId: 'PERF-001:standalone', auditId: 'PERF-001', entrySpec: 'tests/performance.spec.ts', applicability: 'all',
        supportedModes: ['single-site'], supportedProjects: ['candidate-mobile'],
        oracleVariants: { singleSite: 'PERF-001:standalone' },
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
    { id: 'single-firefox', sourceComparativeTargetId: 'candidate-mobile', engine: 'firefox', browserProduct: 'firefox', deviceClass: 'desktop' },
    { id: 'single-webkit', sourceComparativeTargetId: 'candidate-mobile', engine: 'webkit', browserProduct: 'webkit', deviceClass: 'mobile' },
    { id: 'single-edge', sourceComparativeTargetId: 'candidate-mobile', engine: 'chromium', browserProduct: 'msedge', deviceClass: 'desktop', requiredCapability: 'msedge' },
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
assert.equal(singleBarrier.workItem.capability, 'inventory:http');
assert.equal(singleBarrier.workItem.resourceClass, 'ordinary');
assert.match(singleBarrier.workItem.id, DURABLE_ID);
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
assert.deepEqual(single.executionManifest.contextWorkItemIds, []);
assert.equal(single.workItemPlans[0].capability, 'browser:chromium');
assert.equal(single.workItemPlans[0].resourceClass, 'ordinary');
assert.match(single.workItemPlans[0].id, DURABLE_ID);
assert.match(single.oraclePlans[0].id, DURABLE_ID);
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
  comparative.workItemPlans.map(({ id }) => id),
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
assert.deepEqual(comparative.executionManifest.contextWorkItemIds, comparative.contextPlans.map(({ id }) => id));
assert.deepEqual(
  comparative.executionManifest.workItems.map(({ id }) => id),
  [...comparative.workItemPlans, ...comparative.contextPlans].map(({ id }) => id).sort(),
  'Every scheduled context item must be sealed into the durable execution manifest.',
);
assert(comparative.contextPlans.every(({ id }) => !comparative.oraclePlans.some(({ requiredWorkItemIds }) => requiredWorkItemIds.includes(id))),
  'Context work must remain outside Product Oracle authority.');

const browserMatrixCore = subject({
  mode: 'single-site', definitions: ['NAV-001'],
  targets: ['single-mobile', 'single-firefox', 'single-webkit', 'single-edge'], features: ['navigation'],
});
const browserMatrixBarrier = compileSingleSiteInventoryBarrier({ subjectCore: browserMatrixCore, pluginRegistry, targetRegistry });
const browserMatrix = compileCanonicalExecutionGraph({
  subjectCore: browserMatrixCore,
  pluginRegistry,
  targetRegistry,
  inventoryCompletion: completeSingleSiteInventoryBarrier({
    subjectCore: browserMatrixCore,
    barrier: browserMatrixBarrier,
    attempt: 1,
    routeInventory: inventory,
    deploymentIdentityRecheck: browserMatrixCore.deploymentIdentity,
  }),
  deploymentIdentityRecheck: browserMatrixCore.deploymentIdentity,
});
assert.deepEqual(Object.fromEntries(browserMatrix.workItemPlans.map(({ targetId, capability, resourceClass }) => (
  [targetId, { capability, resourceClass }]
))), {
  'single-edge': { capability: 'browser:msedge', resourceClass: 'ordinary' },
  'single-firefox': { capability: 'browser:firefox', resourceClass: 'ordinary' },
  'single-mobile': { capability: 'browser:chromium', resourceClass: 'ordinary' },
  'single-webkit': { capability: 'browser:webkit', resourceClass: 'ordinary' },
});

const performanceCore = subject({ mode: 'single-site', definitions: ['PERF-001'], targets: ['single-mobile'], features: ['performance'] });
const performanceBarrier = compileSingleSiteInventoryBarrier({ subjectCore: performanceCore, pluginRegistry, targetRegistry });
const performanceGraph = compileCanonicalExecutionGraph({
  subjectCore: performanceCore,
  pluginRegistry,
  targetRegistry,
  inventoryCompletion: completeSingleSiteInventoryBarrier({
    subjectCore: performanceCore,
    barrier: performanceBarrier,
    attempt: 1,
    routeInventory: inventory,
    deploymentIdentityRecheck: performanceCore.deploymentIdentity,
  }),
  deploymentIdentityRecheck: performanceCore.deploymentIdentity,
});
assert.equal(performanceGraph.workItemPlans[0].capability, 'performance:lighthouse');
assert.equal(performanceGraph.workItemPlans[0].resourceClass, 'performance');

function durableWorkItems(graph) {
  return [...graph.workItemPlans, ...graph.contextPlans].map((plan) => ({
    id: plan.id,
    maxAttempts: 2,
    capability: plan.capability,
    resourceClass: plan.resourceClass,
    targetId: plan.targetId,
    specAffinity: plan.entrySpec,
  }));
}

const durableRoot = await mkdtemp(path.join(tmpdir(), 'canonical-graph-store-'));
try {
  const store = await openParentRunStore({
    root: durableRoot,
    deploymentIdentity: 'compose-project:canonical-graph',
    volumeIdentity: 'named-volume:canonical-graph',
    volumeDriver: 'local',
    verifyStorage: false,
  });
  await assert.rejects(
    () => createParentRun(store, {
      runId: 'missing-context-run',
      subjectCore: comparativeCore,
      executionManifest: comparative.executionManifest,
      finalSubject: comparative.finalSubject,
      compilationState: 'sealed',
      runnerRevision: 'runner-fixture',
      workItems: durableWorkItems(comparative).filter(({ id }) => id !== comparative.contextPlans[0].id),
    }),
    (error) => error?.code === 'SEALED_MANIFEST_MISMATCH',
    'A sealed run cannot omit scheduled contextual work from its durable queue.',
  );
  await createParentRun(store, {
    runId: 'browser-matrix-run',
    subjectCore: browserMatrixCore,
    compilationState: 'pending',
    runnerRevision: 'runner-fixture',
    workItems: [{
      ...browserMatrixBarrier.workItem,
      maxAttempts: browserMatrixBarrier.maxAttempts,
      specAffinity: 'scripts/probe-single-site.mjs',
    }],
  });
  for (const [runId, graph, subjectCore] of [
    ['comparative-context-run', comparative, comparativeCore],
    ['performance-run', performanceGraph, performanceCore],
  ]) {
    await createParentRun(store, {
      runId,
      subjectCore,
      executionManifest: graph.executionManifest,
      finalSubject: graph.finalSubject,
      compilationState: 'sealed',
      runnerRevision: 'runner-fixture',
      workItems: durableWorkItems(graph),
    });
  }
  const coordinator = await acquireCoordinator(store, 'browser-matrix-run', { ownerId: 'compiler-test', leaseMs: 60_000 });
  await assert.rejects(
    () => sealParentRunGraph(store, 'browser-matrix-run', coordinator, {
      executionManifest: browserMatrix.executionManifest,
      finalSubject: browserMatrix.finalSubject,
      inventoryWorkItemId: browserMatrixBarrier.workItem.id,
      workItems: durableWorkItems(browserMatrix),
    }),
    (error) => error?.code === 'INVENTORY_BARRIER_INCOMPLETE',
    'The final graph must not seal before its inventory barrier succeeds.',
  );
  const inventoryLease = await claimWorkItem(store, 'browser-matrix-run', coordinator, {
    workerId: 'inventory-worker', capabilities: ['inventory:http'], resourceClasses: ['ordinary'], leaseMs: 10_000,
  });
  assert.equal(inventoryLease.workItemId, browserMatrixBarrier.workItem.id);
  const inventoryInbox = await publishAttemptEvidence(store, 'browser-matrix-run', inventoryLease, {
    outcome: 'completed_pass', reason: null, artifacts: [],
  });
  await adoptAttemptEvidence(store, 'browser-matrix-run', coordinator, inventoryInbox);
  const expanded = await sealParentRunGraph(store, 'browser-matrix-run', coordinator, {
    executionManifest: browserMatrix.executionManifest,
    finalSubject: browserMatrix.finalSubject,
    inventoryWorkItemId: browserMatrixBarrier.workItem.id,
    workItems: durableWorkItems(browserMatrix),
  });
  assert.equal(expanded.compilationState, 'sealed');
  assert.equal(expanded.compilationBarrier.id, browserMatrixBarrier.workItem.id);
  assert.deepEqual(Object.keys(expanded.workItems).sort(), browserMatrix.executionManifest.workItems.map(({ id }) => id));
  assert.equal((await readParentRun(store, 'browser-matrix-run')).compilationBarrier.canonicalResult.outcome, 'completed_pass',
    'Restart recovery must retain the completed inventory attempt after graph expansion.');

  for (const plan of browserMatrix.workItemPlans) {
    const lease = await claimWorkItem(store, 'browser-matrix-run', coordinator, {
      workerId: `worker-${plan.targetId}`,
      workItemId: plan.id,
      capabilities: [plan.capability],
      resourceClasses: [plan.resourceClass],
      leaseMs: 10_000,
    });
    assert.equal(lease.capability, plan.capability);
    const inbox = await publishAttemptEvidence(store, 'browser-matrix-run', lease, {
      outcome: 'completed_pass', reason: null, artifacts: [],
    });
    await adoptAttemptEvidence(store, 'browser-matrix-run', coordinator, inbox);
  }
  await sealParentRunGraph(store, 'comparative-context-run', coordinator, {
    executionManifest: comparative.executionManifest,
    finalSubject: comparative.finalSubject,
  });
  const contextLease = await claimWorkItem(store, 'comparative-context-run', coordinator, {
    workerId: 'context-worker',
    workItemId: comparative.contextPlans[0].id,
    capabilities: [comparative.contextPlans[0].capability],
    resourceClasses: [comparative.contextPlans[0].resourceClass],
    leaseMs: 10_000,
  });
  assert.equal(contextLease.workItemId, comparative.contextPlans[0].id);
  const contextInbox = await publishAttemptEvidence(store, 'comparative-context-run', contextLease, {
    outcome: 'completed_pass', reason: null, artifacts: [],
  });
  const adoptedContext = await adoptAttemptEvidence(store, 'comparative-context-run', coordinator, contextInbox);
  assert.equal(adoptedContext.canonicalResult.authoritative, false,
    'Context evidence must remain outside canonical Product Oracle authority.');

  await requestPerformanceDrain(store, 'performance-run', coordinator, { workerId: 'performance-worker' });
  const performanceLease = await claimWorkItem(store, 'performance-run', coordinator, {
    workerId: 'performance-worker', capabilities: ['performance:lighthouse'], resourceClasses: ['performance'], leaseMs: 10_000,
  });
  assert.equal(performanceLease.workItemId, performanceGraph.workItemPlans[0].id);
} finally {
  await rm(durableRoot, { recursive: true, force: true });
}
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
for (const plan of [...actualGraph.workItemPlans, ...actualGraph.oraclePlans]) assert.match(plan.id, DURABLE_ID);
assert(actualGraph.workItemPlans.every(({ capability, resourceClass }) => (
  /^(?:browser:(?:chromium|firefox|webkit|msedge)|performance:lighthouse)$/.test(capability)
  && ['ordinary', 'performance'].includes(resourceClass)
)), 'Every real Single-site work item must use a durable worker scheduling class.');

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
for (const plan of [...actualComparativeGraph.workItemPlans, ...actualComparativeGraph.contextPlans, ...actualComparativeGraph.oraclePlans]) {
  assert.match(plan.id, DURABLE_ID);
}
assert.deepEqual(
  actualComparativeGraph.executionManifest.workItems.map(({ id }) => id),
  [...actualComparativeGraph.workItemPlans, ...actualComparativeGraph.contextPlans].map(({ id }) => id).sort(),
  'The real Comparative manifest must seal every scheduled authoritative and contextual execution.',
);

process.stdout.write('Canonical graph compiler self-test passed: Single-site inventory and Comparative paired Product Oracles share one sealed graph contract.\n');
