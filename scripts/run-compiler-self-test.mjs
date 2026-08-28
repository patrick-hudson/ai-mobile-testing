import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canonicalSha256,
  compileDefinitionCoverageManifest,
  verifyDefinitionCoverageManifest,
} from '../shared/run-compiler.mjs';
import { parseRunContract } from '../shared/run-contract.mjs';

const pluginRegistry = JSON.parse(await readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8'));
const targetRegistry = JSON.parse(await readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8'));
const betaUrl = 'https://beta.quitting7oh-org.pages.dev';
const runnerRevision = 'runner-image:sha256:self-test';
const preflightBinding = {
  schemaVersion: 1,
  url: betaUrl,
  deploymentRole: 'preview',
  identityFingerprint: 'identity:quitting7oh:self-test',
  deploymentRevision: { status: 'identified', value: 'deployment:beta:self-test' },
  evidenceAuthority: { status: 'authoritative', reasons: [] },
};

function contract(scope, targetIds = targetRegistry.singleSiteFullProfileTargetIds) {
  return parseRunContract({
    schemaVersion: 1,
    mode: 'single-site',
    url: betaUrl,
    deploymentRole: 'preview',
    certificatePolicy: 'strict',
    targetIds,
    scope,
  });
}

function compile(overrides = {}) {
  return compileDefinitionCoverageManifest({
    runContract: contract({ qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] }),
    pluginRegistry,
    targetRegistry,
    preflightBinding,
    runnerRevision,
    ...overrides,
  });
}

const full = compile();
const repeated = compile();
assert.deepEqual(repeated, full, 'Compilation must be deterministic for identical immutable inputs.');
assert.equal(verifyDefinitionCoverageManifest(full), true, 'Manifest digest must authenticate the canonical body.');
assert.equal(full.manifestDigest, canonicalSha256((({ manifestDigest: _digest, ...body }) => body)(full)));
assert.equal(JSON.stringify(full).includes('generatedAt'), false, 'Definition coverage must not contain wall-clock timestamps.');
assert.equal(full.scope.qualifier, 'FULL');
assert.equal(full.scope.allEligibleDefinitionsSelected, true);
assert.equal(full.scope.allEligibleCasesSelected, true);
assert.equal(full.scope.allRequiredTargetsSelected, true);
assert.equal(full.coverageStatus, 'COMPLETE');
assert.equal(full.revisions.runner, runnerRevision);
assert.equal(full.deployment.revision.value, preflightBinding.deploymentRevision.value);
assert.equal(full.deployment.certificatePolicy, 'strict');
assert.match(full.revisions.runContract, /^sha256:[a-f0-9]{64}$/);
assert.match(full.revisions.pluginRegistry, /^sha256:[a-f0-9]{64}$/);
assert.match(full.revisions.targetRegistry, /^sha256:[a-f0-9]{64}$/);

assert.deepEqual(
  full.outsideMode.map(({ auditId }) => auditId),
  ['CONTENT-008', 'ENV-003'],
  'Comparison-only definitions must be retained only as outside-mode metadata.',
);
assert.equal(full.executions.some(({ auditId }) => auditId === 'ENV-003' || auditId === 'CONTENT-008'), false);

const contentDefinition = full.selectedDefinitions.find(({ auditId }) => auditId === 'CONTENT-002');
assert(contentDefinition, 'CONTENT-002 must remain selected in a full Single-site audit.');
assert.deepEqual(
  contentDefinition.selectedCaseIds,
  ['CONTENT-002:tests/visual-regression.spec.ts:candidate-chromium-projects:single-site:CONTENT-002:standalone-content-primitives'],
  'CONTENT-002 must select its standalone Product Oracle case only.',
);
const contentExecutions = full.executions.filter(({ auditId }) => auditId === 'CONTENT-002');
assert(contentExecutions.length > 0, 'CONTENT-002 standalone case must produce planned executions.');
assert(contentExecutions.every(({ caseId, productOracleVariant }) => (
  caseId.includes(':single-site:') && productOracleVariant === 'CONTENT-002:standalone-content-primitives'
)));
assert.equal(
  full.executions.some(({ caseId }) => caseId === 'CONTENT-002:tests/visual-regression.spec.ts:candidate-projects'),
  false,
  'The paired production/candidate CONTENT-002 case must never be instantiated in Single-site mode.',
);

const manualDefinition = full.selectedDefinitions.find(({ auditId }) => auditId === 'A11Y-003');
assert.equal(manualDefinition?.manual, true, 'Manual metadata must survive coverage compilation.');
assert.deepEqual(manualDefinition?.executionIds, [], 'Manual work must not be manufactured into browser executions.');

const missingStandaloneRegistry = structuredClone(pluginRegistry);
const routePlugin = missingStandaloneRegistry.plugins.find(({ id }) => id === 'platform-routes-content');
routePlugin.auditCases = routePlugin.auditCases.filter(({ caseId }) => !caseId.includes('CONTENT-002:standalone-content-primitives'));
const withGap = compile({ pluginRegistry: missingStandaloneRegistry });
assert.equal(withGap.coverageStatus, 'GAPS');
assert.deepEqual(withGap.coverageGaps.map(({ auditId }) => auditId), ['CONTENT-002']);
assert.equal(withGap.executions.some(({ auditId }) => auditId === 'CONTENT-002'), false);

const targeted = compile({
  runContract: contract(
    { qualifier: 'TARGETED', pluginIds: [], auditIds: ['HOME-001'], areas: [] },
    ['single-site-mobile-chromium'],
  ),
});
assert.equal(targeted.scope.qualifier, 'TARGETED');
assert.equal(targeted.coverageStatus, 'COMPLETE');
assert.deepEqual(targeted.selectedDefinitions.map(({ auditId }) => auditId), ['HOME-001']);
assert(targeted.omissions.definitions.some(({ auditId }) => auditId === 'CONTENT-002'));
assert.equal(targeted.coverageGaps.some(({ auditId }) => auditId === 'CONTENT-002'), false, 'Operator omissions are not Coverage Gaps.');
assert(targeted.omissions.targets.some(({ disposition }) => disposition === 'operator-omitted-required-target'));

const combinedFilterUnion = compile({
  runContract: contract({
    qualifier: 'TARGETED',
    pluginIds: [],
    auditIds: ['HOME-001'],
    areas: ['search'],
  }),
});
assert(combinedFilterUnion.selectedDefinitions.some(({ auditId }) => auditId === 'HOME-001'));
assert(combinedFilterUnion.selectedDefinitions.some(({ area }) => area === 'search'));

const requestedFullMissingTarget = compile({
  runContract: contract(
    { qualifier: 'FULL', pluginIds: [], auditIds: [], areas: [] },
    targetRegistry.singleSiteFullProfileTargetIds.slice(0, -1),
  ),
});
assert.equal(requestedFullMissingTarget.scope.requestedQualifier, 'FULL');
assert.equal(requestedFullMissingTarget.scope.qualifier, 'TARGETED', 'FULL must be derived, not trusted from launch input.');
assert.equal(requestedFullMissingTarget.scope.allRequiredTargetsSelected, false);

const unavailableRevision = compile({
  preflightBinding: {
    ...preflightBinding,
    deploymentRevision: { status: 'unavailable', value: null },
    evidenceAuthority: { status: 'non-authoritative', reasons: ['deployment-revision-unavailable'] },
  },
});
assert.deepEqual(unavailableRevision.deployment.revision, { status: 'unavailable', value: null });
assert.equal(unavailableRevision.deployment.evidenceAuthority.status, 'non-authoritative');

assert.throws(
  () => compile({
    runContract: contract({ qualifier: 'TARGETED', pluginIds: [], auditIds: ['ENV-003'], areas: [] }),
  }),
  /zero executable cases.*comparison-only: ENV-003/,
  'A comparison-only selection must be rejected before a run is queued.',
);
assert.throws(
  () => compile({ preflightBinding: { ...preflightBinding, url: 'https://quitting7oh.org' } }),
  /must match the parsed run contract exactly/,
);
assert.throws(() => compile({ runnerRevision: '' }), /runnerRevision/);
assert.throws(
  () => compile({
    runContract: contract({ qualifier: 'TARGETED', pluginIds: [], auditIds: ['UNKNOWN-001'], areas: [] }),
  }),
  /unknown audits/,
);

const tampered = structuredClone(full);
tampered.counts.plannedExecutions += 1;
assert.equal(verifyDefinitionCoverageManifest(tampered), false, 'Canonical digest must reject manifest mutation.');

process.stdout.write(
  `Run compiler self-test passed (${full.counts.selectedDefinitions} selected definitions, `
  + `${full.counts.executableCases} executable cases, ${full.counts.plannedExecutions} planned executions).\n`,
);
