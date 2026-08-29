import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { compileSharedLaunchPlan } from '../shared/launch-plan-compiler.mjs';
import { openParentRunStore, recoverParentRun } from './lib/parent-run-store.mjs';
import { openSharedLaunchOperationStore } from './lib/shared-launch-operation-store.mjs';
import { createSharedLaunchService } from './lib/shared-launch-service.mjs';

const [pluginRegistry, targetRegistry] = await Promise.all([
  readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8').then(JSON.parse),
]);
const digest = (character) => `sha256:${character.repeat(64)}`;
const server = {
  pluginRegistry,
  targetRegistry,
  runnerRevision: digest('1'),
  configurationRevision: digest('2'),
  environmentRevision: digest('3'),
  deploymentIdentity: { kind: 'deployment', value: 'deploy-2026-08-29' },
};

function contract(mode, qualifier, overrides = {}) {
  const modeFields = mode === 'single-site'
    ? { url: 'https://candidate.example.test', deploymentRole: 'preview', certificatePolicy: 'strict' }
    : { productionUrl: 'https://production.example.test', candidateUrl: 'https://candidate.example.test' };
  return {
    schemaVersion: 1,
    mode,
    ...modeFields,
    targetIds: qualifier === 'TARGETED'
      ? (mode === 'single-site'
        ? ['single-site-mobile-chromium']
        : ['production-mobile-chromium', 'candidate-mobile-chromium'])
      : (mode === 'single-site'
        ? [...targetRegistry.singleSiteFullProfileTargetIds]
        : [...targetRegistry.defaultTargetIds]),
    scope: qualifier === 'FULL'
      ? { qualifier, pluginIds: [], auditIds: [], areas: [] }
      : { qualifier, pluginIds: [], auditIds: ['A11Y-001'], areas: [] },
    ...overrides,
  };
}

function compile(runContract) {
  return compileSharedLaunchPlan({ intent: { schemaVersion: 1, runContract }, ...server });
}

for (const mode of ['single-site', 'comparative']) {
  for (const qualifier of ['FULL', 'TARGETED']) {
    const plan = compile(contract(mode, qualifier));
    assert.equal(plan.subjectCore.mode, mode);
    assert.equal(plan.intentDigest, canonicalDigest({ schemaVersion: 1, runContract: contract(mode, qualifier) }));
    assert.equal(plan.subjectCore.requestedAuthority.qualifier, qualifier);
    assert(plan.subjectCore.requestedAuthority.scope.definitions.length > 0);
    assert(plan.subjectCore.requestedAuthority.scope.features.length > 0);
    assert.deepEqual(plan.subjectCore.requestedAuthority.scope.targets,
      [...contract(mode, qualifier).targetIds].sort());
    assert.equal(plan.digest, canonicalDigest(Object.fromEntries(
      Object.entries(plan).filter(([key]) => key !== 'digest'),
    )));
    assert(Object.isFrozen(plan));
  }
}

const singleFull = compile(contract('single-site', 'FULL'));
const manualDefinitionIds = new Set(pluginRegistry.plugins.flatMap(({ auditDefinitions }) => (
  auditDefinitions.filter(({ manual }) => manual === true).map(({ id }) => id
))));
assert(singleFull.subjectCore.requestedAuthority.scope.definitions.every((id) => !manualDefinitionIds.has(id)),
  'manual definitions must never enter automated authority');

const single = compile(contract('single-site', 'TARGETED'));
assert.equal(single.state, 'pending-inventory');
assert.equal(single.executionGraph, null);
assert.equal(single.createParentRunInput.compilationState, 'pending');
assert(!('runId' in single.createParentRunInput), 'the operation materializer, not the pure compiler, injects runId');
assert.equal(single.createParentRunInput.workItems.length, 1);
assert.equal(single.createParentRunInput.workItems[0].capability, 'inventory:http');
assert.equal(single.createParentRunInput.workItems[0].resourceClass, 'ordinary');
assert(single.createParentRunInput.workItems[0].maxAttempts >= 1
  && single.createParentRunInput.workItems[0].maxAttempts <= 10);

const comparative = compile(contract('comparative', 'TARGETED'));
assert.equal(comparative.state, 'sealed');
assert.equal(comparative.createParentRunInput.compilationState, 'sealed');
assert(!('runId' in comparative.createParentRunInput), 'equivalent launches in distinct operation namespaces must not collide');
assert.equal(comparative.createParentRunInput.executionManifest.digest,
  comparative.executionGraph.executionManifest.digest);
assert.equal(comparative.createParentRunInput.finalSubject.digest,
  comparative.executionGraph.finalSubject.digest);
assert.deepEqual(
  comparative.createParentRunInput.workItems.map(({ id }) => id).sort(),
  [...comparative.executionGraph.workItemPlans, ...comparative.executionGraph.contextPlans]
    .map(({ id }) => id).sort(),
);
assert(comparative.createParentRunInput.workItems.every(({ maxAttempts }) => (
  Number.isSafeInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 16
)));

const comparisonOnly = compile(contract('single-site', 'TARGETED', {
  scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['A11Y-001', 'ENV-003'], areas: [] },
}));
assert(!comparisonOnly.subjectCore.requestedAuthority.scope.definitions.includes('ENV-003'));
const comparativeComparisonOnly = compile(contract('comparative', 'TARGETED', {
  targetIds: ['production-mobile-chromium', 'candidate-desktop-chromium'],
  scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['A11Y-001', 'ENV-003'], areas: [] },
}));
assert(comparativeComparisonOnly.subjectCore.requestedAuthority.scope.definitions.includes('ENV-003'),
  'comparison-only definitions remain executable in Comparative mode');
assert.throws(() => compile(contract('single-site', 'TARGETED', {
  scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['ENV-003'], areas: [] },
})), /no executable|zero executable|empty/i);

assert.throws(() => compile(contract('single-site', 'FULL', {
  targetIds: targetRegistry.singleSiteFullProfileTargetIds.slice(1),
})), /FULL.*target|target.*FULL/i);
assert.throws(() => compile(contract('single-site', 'TARGETED', { targetIds: [] })), /targetIds.*at least one/i);
assert.throws(() => compile(contract('comparative', 'TARGETED', {
  targetIds: ['candidate-mobile-webkit'],
  scope: { qualifier: 'TARGETED', pluginIds: [], auditIds: ['ENV-003'], areas: [] },
})), /no executable|empty|scope|candidate.*production/i);
assert.throws(() => compile(contract('comparative', 'TARGETED', {
  targetIds: ['candidate-mobile-chromium'],
})), /candidate.*production|production.*candidate/i,
'Comparative authority cannot silently degrade into a candidate-only audit.');

assert.deepEqual(compile(contract('comparative', 'TARGETED')), compile(contract('comparative', 'TARGETED')),
  'identical server state and intent must compile byte-for-byte deterministically');
assert.throws(() => compileSharedLaunchPlan({
  intent: { schemaVersion: 1, runContract: contract('comparative', 'TARGETED'), runId: 'caller-run' }, ...server,
}), /intent|unsupported|runId/i);
assert.throws(() => compileSharedLaunchPlan({
  intent: { schemaVersion: 1, runContract: contract('comparative', 'TARGETED') }, ...server,
  subjectCore: comparative.subjectCore,
}), /unsupported|subjectCore/i);
assert.throws(() => compileSharedLaunchPlan({
  intent: { schemaVersion: 1, runContract: contract('comparative', 'TARGETED') }, ...server,
  runId: 'caller-run', workItems: [],
}), /unsupported|runId|workItems/i);

const integrationRoot = await mkdtemp(path.join(tmpdir(), 'shared-launch-plan-integration-'));
try {
  const parentRunStore = await openParentRunStore({
    root: path.join(integrationRoot, 'parent-runs'),
    deploymentIdentity: 'launch-plan-self-test',
    volumeIdentity: 'named-volume:launch-plan-self-test',
    verifyStorage: false,
  });
  const operationStore = await openSharedLaunchOperationStore({
    root: path.join(integrationRoot, 'launch-operations'),
  });
  let compileCalls = 0;
  const service = createSharedLaunchService({
    operationStore,
    parentRunStore,
    projectId: 'project-1',
    compilePlan: async (intent) => {
      compileCalls += 1;
      return compileSharedLaunchPlan({ intent, ...server });
    },
  });
  const operator = {
    id: 'launch-operator', kind: 'human', roles: ['operator'],
    projectIds: ['project-1'], runIds: ['*'],
  };
  const singleOperation = await service.accept(operator, {
    requestId: 'single-launch-0001',
    intent: { schemaVersion: 1, runContract: contract('single-site', 'TARGETED') },
  });
  assert.match(singleOperation.runId, /^run-[a-f0-9]{32}$/u);
  const singleCompleted = await service.materialize(singleOperation.operationId);
  assert.equal(singleCompleted.outcome.status, 'succeeded');
  const singleParent = await recoverParentRun(parentRunStore, singleOperation.runId);
  assert.equal(singleParent.compilationState, 'pending');
  assert.deepEqual(Object.values(singleParent.workItems).map(({ capability }) => capability), ['inventory:http']);

  const comparativeOperation = await service.accept(operator, {
    requestId: 'comparative-launch-0001',
    intent: { schemaVersion: 1, runContract: contract('comparative', 'TARGETED') },
  });
  const comparativeCompleted = await service.materialize(comparativeOperation.operationId);
  assert.equal(comparativeCompleted.outcome.status, 'succeeded');
  const comparativeParent = await recoverParentRun(parentRunStore, comparativeOperation.runId);
  assert.equal(comparativeParent.compilationState, 'sealed');
  assert.equal(comparativeParent.executionManifestDigest, comparative.executionGraph.executionManifest.digest);
  assert.deepEqual(
    Object.keys(comparativeParent.workItems).sort(),
    comparative.executionGraph.executionManifest.workItems.map(({ id }) => id).sort(),
  );
  assert.equal((await service.accept(operator, {
    requestId: 'comparative-launch-0001',
    intent: { schemaVersion: 1, runContract: contract('comparative', 'TARGETED') },
  })).operationId, comparativeOperation.operationId);
  assert.equal(compileCalls, 2, 'accepted launch retries must reuse their pinned plan without recompilation');
  const pendingOperation = await service.accept(operator, {
    requestId: 'single-launch-recovery-0001',
    intent: { schemaVersion: 1, runContract: contract('single-site', 'TARGETED') },
  });
  const corruptOperationId = '0'.repeat(64);
  await writeFile(path.join(operationStore.root, 'operations', `${corruptOperationId}.json`), '{not-json\n', 'utf8');
  const recovered = await service.recover();
  assert.equal(recovered.completed.length, 1,
    'a corrupt durable operation must not strand later valid launch materialization');
  assert.equal(recovered.completed[0].operationId, pendingOperation.operationId);
  assert.equal(recovered.errors.length, 1);
  assert.equal(recovered.errors[0].operationId, corruptOperationId);
  assert.equal((await service.recover()).completed.length, 0, 'completed materializations must not be replayed');
} finally {
  await rm(integrationRoot, { recursive: true, force: true });
}

process.stdout.write('Shared launch-plan compiler self-test passed.\n');
