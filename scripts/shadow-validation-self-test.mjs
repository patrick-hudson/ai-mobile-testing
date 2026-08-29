import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applySharedReleaseEligibility } from '../portal/release-eligibility.mjs';
import { assertConsumableReleaseDecision } from '../shared/release-decision.mjs';
import { parsePublicationEnvelope } from '../shared/publication-envelope.mjs';
import {
  SHADOW_ACCEPTANCE_CASE_IDS,
  SHADOW_CORRUPTION_CASE_IDS,
  buildPreRegisteredShadowMatrix,
} from '../shared/shadow-validation-fixtures.mjs';
import {
  SHADOW_FORBIDDEN_AUTHORITY_FIELDS,
  parseShadowValidationReport,
  runShadowValidation,
} from '../shared/shadow-validation.mjs';
import { parseChecklistRelease } from './lib/release-truth.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedAt = '2026-08-29T12:00:00.000Z';
const matrix = buildPreRegisteredShadowMatrix();

assert.deepEqual(
  SHADOW_ACCEPTANCE_CASE_IDS,
  Array.from({ length: 16 }, (_, index) => `AE${index + 1}`),
  'the acceptance matrix must remain explicitly pre-registered as AE1-AE16',
);
assert.deepEqual(
  new Set(matrix.cases.map(({ caseId }) => caseId).filter((caseId) => caseId.startsWith('AE'))),
  new Set(SHADOW_ACCEPTANCE_CASE_IDS),
);
assert.deepEqual(
  new Set(matrix.cases.map(({ caseId }) => caseId).filter((caseId) => caseId.startsWith('CR'))),
  new Set(SHADOW_CORRUPTION_CASE_IDS),
  'the corruption/recovery cases must all be exercised',
);

const report = runShadowValidation({ ...matrix, generatedAt });
assert.equal(report.kind, 'release-shadow-validation');
assert.equal(report.purpose, 'diagnostic-only');
assert.equal(report.validationStatus, 'PASS');
assert.equal(report.summary.unexplainedDrift, 0);
assert(report.summary.reviewedDifferences > 0, 'known migration differences must remain explicit, not normalized away');
assert.equal(parseShadowValidationReport(report).digest, report.digest);

const serialized = JSON.stringify(report);
for (const forbidden of SHADOW_FORBIDDEN_AUTHORITY_FIELDS) {
  assert(!new RegExp(`"${forbidden}"\\s*:`, 'u').test(serialized), `shadow output must not contain authority field ${forbidden}`);
}
assert(!serialized.includes('run-volatile-a'));
assert(!serialized.includes('raw-byte-digest-a'));

const volatileMatrix = structuredClone(matrix);
for (const entry of volatileMatrix.cases) {
  entry.legacy.volatileMetadata = { runId: 'run-volatile-a', rawByteDigest: 'raw-byte-digest-a' };
  entry.shared.volatileMetadata = { runId: 'run-volatile-b', rawByteDigest: 'raw-byte-digest-b' };
}
assert.equal(
  runShadowValidation({ ...volatileMatrix, generatedAt }).digest,
  report.digest,
  'volatile IDs and byte digests must not affect semantic shadow truth',
);

const driftMatrix = structuredClone(matrix);
const driftCase = driftMatrix.cases.find(({ caseId }) => caseId === 'AE1');
driftCase.shared.results[0].classification = 'COMPLETED_PRODUCT_FAILURE';
driftCase.shared.outcomeCode = 'NOT_READY_TEST_FAILURE';
const drift = runShadowValidation({ ...driftMatrix, generatedAt });
assert.equal(drift.validationStatus, 'BLOCKED');
assert.equal(drift.summary.unexplainedDrift, 2, 'classification and release outcome drift must both remain visible');
assert(drift.comparisons.find(({ caseId }) => caseId === 'AE1').dimensions.some(({ status }) => status === 'UNEXPLAINED_DRIFT'));

const unreviewedMatrix = structuredClone(matrix);
unreviewedMatrix.intentionalDifferences[0].reviewed = false;
assert.throws(() => runShadowValidation({ ...unreviewedMatrix, generatedAt }), /reviewed/iu);

const forged = structuredClone(report);
forged.currentHead = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
assert.throws(() => parseShadowValidationReport(forged), /unsupported|forbidden|authority/iu);
const corrupted = structuredClone(report);
corrupted.summary.unexplainedDrift = 99;
assert.throws(() => parseShadowValidationReport(corrupted), /corrupt|digest|summary/iu);

assert.throws(() => parsePublicationEnvelope(report), /unsupported|invalid/iu);
assert.throws(() => parseChecklistRelease(report, 'shadow-validation.json'), /unsupported|invalid|missing release truth/iu);
assert.throws(() => applySharedReleaseEligibility({}, report, 'shadow'), /unsupported|invalid/iu);
assert.throws(() => assertConsumableReleaseDecision(report, {
  expectedSubjectDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  expectedAuthority: 'FULL',
  currentDecisionRevision: 1,
}), /unsupported|invalid/iu);

const cliSource = await readFile(join(repositoryRoot, 'scripts/run-shadow-validation.mjs'), 'utf8');
assert.match(cliSource, /artifacts\/shadow-validation/u);
assert.match(cliSource, /realpath\(root\)/u);
assert.match(cliSource, /pathFromRoot\.startsWith/u);
assert.match(cliSource, /process\.exitCode\s*=\s*report\.validationStatus\s*===\s*'PASS'\s*\?\s*0\s*:\s*2/u);

const compose = await readFile(join(repositoryRoot, 'docker-compose.yml'), 'utf8');
const service = compose.match(/^  shadow-validation:\n[\s\S]*?(?=^  shared-worker-ordinary-a:)/mu)?.[0] ?? '';
assert.match(service, /profiles:\s*\[shadow-validation\]/u);
assert.match(service, /network_mode:\s*["']none["']/u);
assert.match(service, /read_only:\s*true/u);
assert.match(service, /user:\s*"\$\{AUDIT_HOST_UID:-1000\}:\$\{AUDIT_HOST_GID:-1000\}"/u);
assert.match(service, /cap_drop:\s*\[ALL\]/u);
assert.match(service, /no-new-privileges:true/u);
assert.match(service, /\.\/artifacts\/shadow-validation:\/work\/artifacts\/shadow-validation/u);
assert.doesNotMatch(service, /shared-parent-runs|credential|secret|certs|PRODUCTION_URL|CANDIDATE_URL/u);

console.log('Shadow validation self-test passed: AE1-AE16 and the corruption/recovery matrix are semantic, reviewed, fail-closed, and structurally non-authoritative.');
