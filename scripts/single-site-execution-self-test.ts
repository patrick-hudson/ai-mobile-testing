import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  auditCaseTag,
  parseSelectedSingleSiteCaseIds,
  resolveDeclaredSingleSiteCaseId,
  selectedAuditCaseGrep,
  type ExecutableAuditCaseRegistry,
} from '../audit/execution-selection.js';

const registry = JSON.parse(
  readFileSync(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8'),
) as ExecutableAuditCaseRegistry;
const target = 'candidate-desktop-chromium';
const homeCase = 'HOME-001:tests/smoke.spec.ts:all-projects';
const contentCase = 'CONTENT-002:tests/visual-regression.spec.ts:candidate-chromium-projects:single-site:CONTENT-002:standalone-content-primitives';
const a11yWelcomeCase = 'A11Y-001:tests/accessibility.spec.ts:full-sweep-projects:case:%2Fstart-here%2Fwelcome';

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

const grep = selectedAuditCaseGrep([homeCase, contentCase]);
assert(grep.test(`test title ${auditCaseTag(homeCase)}`));
assert(grep.test(`test title ${auditCaseTag(contentCase)}`));
assert(!grep.test(`test title ${auditCaseTag('NAV-005:tests/navigation.spec.ts:candidate-chromium-projects')}`));

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
