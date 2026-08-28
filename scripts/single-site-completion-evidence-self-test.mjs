import assert from 'node:assert/strict';
import { sha256 } from './lib/job-queue.mjs';
import {
  buildSingleSiteCompletionEvidence,
  validateSingleSiteCompletionEvidence,
} from './single-site-completion-evidence.mjs';

const generatedAt = '2026-08-25T12:00:00.000Z';
const document = buildSingleSiteCompletionEvidence({
  generatedAt,
  runs: [{
    jobId: 'job-fixture',
    scenario: 'smoke',
    receiptDigest: 'a'.repeat(64),
    receipt: { receiptDigest: 'a'.repeat(64) },
    coverage: { selectedDefinitions: 4, executableCases: 4, plannedExecutions: 8 },
    verified: { report: {}, gallery: {}, media: {}, visual: {} },
  }],
});
assert.equal(validateSingleSiteCompletionEvidence(document), document);
assert.equal(document.advisory, true);
assert.deepEqual(document.promotion, { authorized: false, blocking: false, effect: 'none' });
assert.match(document.completionEvidenceDigest, /^[a-f0-9]{64}$/);
const tampered = structuredClone(document);
tampered.runs[0].coverage.plannedExecutions = 9;
assert.throws(() => validateSingleSiteCompletionEvidence(tampered), /digest is invalid/);
const rehashedPromotionForgery = structuredClone(document);
rehashedPromotionForgery.promotion.authorized = true;
delete rehashedPromotionForgery.completionEvidenceDigest;
rehashedPromotionForgery.completionEvidenceDigest = sha256(rehashedPromotionForgery);
assert.throws(() => validateSingleSiteCompletionEvidence(rehashedPromotionForgery), /top-level claims/);

process.stdout.write('Single-site completion evidence self-test passed.\n');
