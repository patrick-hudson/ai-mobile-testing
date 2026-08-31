import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  auditCaseTag,
  parseSelectedSingleSiteCaseIds,
  resolveDeclaredAuditCaseId,
  resolveDeclaredSingleSiteCaseId,
  selectedAuditCaseGrep,
  type ExecutableAuditCaseRegistry,
} from '../audit/execution-selection.js';
import { sharedWorkItemPlaywrightArguments } from './execute-shared-work-item.mjs';

const registry = JSON.parse(
  readFileSync(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8'),
) as ExecutableAuditCaseRegistry;
const target = 'candidate-desktop-chromium';
const homeCase = 'HOME-001:tests/smoke.spec.ts:all-projects';
const contentCase = 'CONTENT-002:tests/visual-regression.spec.ts:candidate-chromium-projects:single-site:CONTENT-002:standalone-content-primitives';
const a11yWelcomeCase = 'A11Y-001:tests/accessibility.spec.ts:full-sweep-projects:case:%2Fstart-here%2Fwelcome';
const performanceHomeCase = 'PERF-001:tests/performance.spec.ts:full-sweep-projects:case:%2F';
const performanceWelcomeCase = 'PERF-001:tests/performance.spec.ts:full-sweep-projects:case:%2Fstart-here%2Fwelcome';

assert.deepEqual(
  parseSelectedSingleSiteCaseIds(JSON.stringify([homeCase, contentCase]), registry, [target]),
  [homeCase, contentCase],
);
assert.equal(resolveDeclaredSingleSiteCaseId(registry, {
  auditId: 'HOME-001',
  applicability: 'all-projects',
}), homeCase);
assert.equal(resolveDeclaredSingleSiteCaseId(registry, {
  auditId: 'CONTENT-002',
  applicability: 'candidate-chromium-projects',
  oracleVariant: 'CONTENT-002:standalone-content-primitives',
}), contentCase);
assert.equal(resolveDeclaredSingleSiteCaseId(registry, {
  auditId: 'A11Y-001',
  applicability: 'full-sweep-projects',
  caseVariant: '/start-here/welcome',
}), a11yWelcomeCase, 'A parameterized runtime row must bind to its exact compiled route case.');
assert.throws(
  () => resolveDeclaredSingleSiteCaseId(registry, {
    auditId: 'A11Y-001',
    applicability: 'full-sweep-projects',
  }),
  /maps to 7 executable cases/,
  'Omitting a required route variant must fail closed instead of selecting an arbitrary case.',
);
assert.equal(resolveDeclaredSingleSiteCaseId(registry, {
  auditId: 'A11Y-001',
  applicability: 'full-sweep-projects',
  caseVariant: '/plausible-but-unreviewed-route',
}), null, 'An unreviewed route mutation must not resolve to an executable case.');
assert.equal(resolveDeclaredSingleSiteCaseId(registry, {
  auditId: 'ENV-003',
  applicability: 'candidate-desktop-chromium',
}), null, 'Comparison-only cases must not register in a Single-site Playwright suite.');
assert.equal(resolveDeclaredAuditCaseId(registry, {
  mode: 'comparative',
  auditId: 'ENV-003',
  applicability: 'candidate-desktop-chromium',
}), 'ENV-003:tests/contracts.spec.ts:candidate-desktop-chromium',
'Comparison-only cases must receive the same compiler-selectable identity in Comparative mode.');

const grep = selectedAuditCaseGrep([homeCase, contentCase]);
assert(grep.test(`test title ${auditCaseTag(homeCase)}`));
assert(grep.test(`test title ${auditCaseTag(contentCase)}`));
assert(!grep.test(`test title ${auditCaseTag('NAV-005:tests/navigation.spec.ts:candidate-chromium-projects')}`));

const homePerformanceGrep = selectedAuditCaseGrep([performanceHomeCase]);
assert(homePerformanceGrep.test(`test title ${auditCaseTag(performanceHomeCase)}`));
assert(!homePerformanceGrep.test(`test title ${auditCaseTag(performanceWelcomeCase)}`),
  'A route case tag must not select a longer base64url tag that shares its encoded prefix.');

const welcomePerformanceGrep = selectedAuditCaseGrep([performanceWelcomeCase]);
assert(welcomePerformanceGrep.test(`test title ${auditCaseTag(performanceWelcomeCase)}`),
  'An explicitly selected longer route tag must remain selectable.');
assert(!welcomePerformanceGrep.test(`test title ${auditCaseTag(performanceHomeCase)}`));

const combinedPerformanceGrep = selectedAuditCaseGrep([performanceHomeCase, performanceWelcomeCase]);
assert(combinedPerformanceGrep.test(`test title ${auditCaseTag(performanceHomeCase)}`));
assert(combinedPerformanceGrep.test(`test title ${auditCaseTag(performanceWelcomeCase)}`));

const workerArguments = sharedWorkItemPlaywrightArguments({
  entrySpec: 'tests/performance.spec.ts',
  targetId: 'single-site-mobile-chromium',
  caseId: performanceHomeCase,
});
const workerGrepArgument = workerArguments.find((argument) => argument.startsWith('--grep='));
assert(workerGrepArgument, 'The fixed shared worker command must include an exact case grep.');
const workerGrep = new RegExp(workerGrepArgument.slice('--grep='.length));
assert(workerGrep.test(`test title ${auditCaseTag(performanceHomeCase)}`));
assert(!workerGrep.test(`test title ${auditCaseTag(performanceWelcomeCase)}`),
  'The production shared-worker command must not broaden the home route into every performance route.');
assert.throws(
  () => parseSelectedSingleSiteCaseIds(JSON.stringify(['ENV-003:tests/contracts.spec.ts:candidate-desktop-chromium']), registry, [target]),
  /not executable in Single-site mode/,
);
assert.throws(
  () => parseSelectedSingleSiteCaseIds(JSON.stringify([contentCase]), registry, ['candidate-tablet-webkit']),
  /no execution on the selected neutral browser targets/,
);
assert.throws(
  () => parseSelectedSingleSiteCaseIds(JSON.stringify([homeCase, homeCase]), registry, [target]),
  /must not contain duplicates/,
);
assert.throws(
  () => parseSelectedSingleSiteCaseIds(undefined, registry, [target]),
  /compiled Definition Coverage Manifest/,
);

process.stdout.write('Single-site execution adapter self-test passed: compiled cases and neutral targets filter exactly and fail closed.\n');
