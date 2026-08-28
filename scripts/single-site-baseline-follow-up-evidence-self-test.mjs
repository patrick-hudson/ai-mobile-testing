import assert from 'node:assert/strict';
import {
  buildSingleSiteBaselineFollowUpEvidence,
  validateSingleSiteBaselineFollowUpEvidence,
} from './single-site-baseline-follow-up-evidence.mjs';
import {
  visualBaselineDigest,
  visualBaselineIdentityKey,
  visualBaselineSlotKey,
} from '../shared/visual-baseline-contract.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const identity = {
  schemaVersion: 1,
  mode: 'single-site',
  deploymentRole: 'preview',
  route: '/',
  targetId: 'single-site-desktop-chromium',
  viewport: { width: 1440, height: 900 },
  theme: 'light',
  auditId: 'CONTENT-001',
  auditDefinitionDigest: digest('1'),
  capturePoint: 'content-main',
  browser: { engine: 'chromium', product: 'chromium', version: '140', build: 'fixture' },
  rendering: {
    devicePixelRatio: 1,
    captureContractRevision: 'single-site-static-checkpoint-v1',
    runnerImageDigest: digest('2'),
    fontPackDigest: digest('3'),
    fingerprint: visualBaselineDigest({
      devicePixelRatio: 1,
      captureContractRevision: 'single-site-static-checkpoint-v1',
      runnerImageDigest: digest('2'),
      fontPackDigest: digest('3'),
    }),
  },
};
const identityKey = visualBaselineIdentityKey(identity);
const slotKey = visualBaselineSlotKey(identity);
const currentSourceSha = digest('4');
const currentFollowUpSha = digest('5');
const baselineId = 'vb-fixture';
const sourceReceipt = {
  scenario: 'smoke', receiptDigest: 'a'.repeat(64),
  run: { jobId: 'job-source', origin: 'https://beta.example.test', deploymentRole: 'preview', certificatePolicy: 'strict' },
  revisions: { runnerRevision: 'image:sha256:' + '6'.repeat(64) },
  finalization: { status: 'complete' },
  report: { revision: '1'.repeat(32) },
  gallery: { exportRevision: 'export_1111111111111111' },
  visual: { publicationDigest: digest('7'), eligibilityManifestDigest: digest('8') },
};
const followUpReceipt = {
  scenario: 'baseline-follow-up', receiptDigest: 'b'.repeat(64),
  run: { jobId: 'job-follow-up', origin: sourceReceipt.run.origin, deploymentRole: 'preview', certificatePolicy: 'strict' },
  revisions: { runnerRevision: sourceReceipt.revisions.runnerRevision },
  finalization: { status: 'complete' },
  report: { revision: '2'.repeat(32) },
  gallery: { exportRevision: 'export_2222222222222222' },
  visual: { publicationDigest: digest('9'), eligibilityManifestDigest: digest('a') },
};
const sourceVisual = {
  publicationDigest: sourceReceipt.visual.publicationDigest,
  items: [{ itemId: '1'.repeat(32), identity, identityKey, slotKey, current: { sha256: currentSourceSha } }],
};
const sourceEvidence = {
  runId: sourceReceipt.run.jobId,
  artifactRelativePath: 'raw/content.png',
  artifactSha256: currentSourceSha,
  artifactBytes: 12,
  contentType: 'image/png',
  runStatus: 'completed',
  evidenceComplete: true,
  evidenceAuthority: { status: 'authoritative', reasons: [] },
  findingStatus: 'clear',
  findingWaiver: null,
};
const sourceEligibility = {
  manifestDigest: sourceReceipt.visual.eligibilityManifestDigest,
  items: [{
    evidenceId: digest('b'), identity, identityKey, slotKey, evidence: sourceEvidence,
    requiresFindingWaiver: false, eligible: true, ineligibilityReasons: [],
  }],
};
const comparison = {
  schemaVersion: 1,
  policyRevision: 'visual-policy-v1',
  status: 'CHANGED',
  comparisonStatus: 'different',
  differingPixels: 10,
  totalPixels: 100,
  differingPixelRatio: 0.1,
  reason: 'fixture change',
  review: null,
  effects: { deterministicHealth: 'none', deterministicFindings: 'none', promotion: 'none' },
};
const followUpItem = {
  itemId: '2'.repeat(32), identity, identityKey, slotKey,
  current: { sha256: currentFollowUpSha },
  baseline: { baselineId, identityKey, slotKey, approvedAt: '2026-08-25T12:05:00.000Z', mediaSha256: currentSourceSha },
  comparison,
  diff: { sha256: digest('c'), bytes: 4, relativePath: 'diffs/item.png' },
};
const followUpVisual = { publicationDigest: followUpReceipt.visual.publicationDigest, items: [followUpItem] };
const baselineRecord = {
  schemaVersion: 1, baselineId, slotKey, identityKey, identity, state: 'active', source: sourceEvidence,
  media: { relativePath: `media/${baselineId}.png`, sha256: currentSourceSha, bytes: 12, available: true },
  approvedBy: 'portal-operator', approvedAt: '2026-08-25T12:05:00.000Z',
  replacedBy: null, revokedAt: null, deletedAt: null, deletionReason: null,
};
const baselineEvent = {
  schemaVersion: 1, sequence: 1, eventId: 'baseline-event', type: 'approved',
  at: baselineRecord.approvedAt, actorId: 'portal-operator', reason: 'reviewed beta reference',
  idempotencyKey: 'baseline-idempotency', requestDigest: digest('d'), previousDigest: digest('0'),
  payload: { record: baselineRecord },
  result: { baselineId, slotKey, identityKey, storeRevision: 1, eventId: 'baseline-event', eventType: 'approved' },
  eventDigest: digest('e'),
};
const baselineSnapshot = {
  state: { storeRevision: 1, historyDigest: baselineEvent.eventDigest, baselines: { [baselineId]: baselineRecord } },
  history: [baselineEvent],
};
const reviewBinding = {
  jobId: followUpReceipt.run.jobId,
  galleryItemId: 'gitem_0000000000000001',
  reportRevision: followUpReceipt.report.revision,
  galleryExportRevision: followUpReceipt.gallery.exportRevision,
  visualPublicationDigest: followUpReceipt.visual.publicationDigest,
  visualComparisonItemId: followUpItem.itemId,
  identityKey,
  slotKey,
  comparisonDigest: visualBaselineDigest(comparison),
  baselineId,
  baselineMediaSha256: currentSourceSha,
  currentMediaSha256: currentFollowUpSha,
  diffSha256: followUpItem.diff.sha256,
};
const reviewEvent = {
  eventId: 'review-event', eventDigest: digest('f'), binding: reviewBinding,
};
const reviewRecord = {
  reviewKey: digest('1'), status: 'REVIEWED', disposition: 'accepted-change', rationale: 'Expected redesign.',
  actorId: 'portal-operator', reviewedAt: '2026-08-25T12:10:00.000Z', reviewRevision: 1,
  eventId: reviewEvent.eventId, binding: reviewBinding,
};
const reviewSnapshot = {
  state: { reviewRevision: 1, historyDigest: reviewEvent.eventDigest, reviews: { [reviewRecord.reviewKey]: reviewRecord } },
  history: [reviewEvent],
};
const inputs = {
  generatedAt: '2026-08-25T12:15:00.000Z', sourceReceipt, followUpReceipt, sourceVisual,
  sourceEligibility, followUpVisual, baselineSnapshot, reviewSnapshot,
  verifiedBaselineMedia: { [baselineId]: { sha256: currentSourceSha, bytes: 12 } },
};
const document = buildSingleSiteBaselineFollowUpEvidence(inputs);
assert.equal(validateSingleSiteBaselineFollowUpEvidence(document), document);
assert.equal(document.proofs[0].followUp.status, 'REVIEWED');
assert.equal(document.proofs[0].review.disposition, 'accepted-change');
assert.equal(document.baselineStore.historyDigest, baselineEvent.eventDigest);
assert.deepEqual(document.proofs[0].baseline.record, baselineRecord);
assert.equal(document.proofs[0].baseline.recordDigest, visualBaselineDigest(baselineRecord));

const withoutReview = buildSingleSiteBaselineFollowUpEvidence({ ...inputs, reviewSnapshot: null });
assert.equal(withoutReview.proofs[0].followUp.status, 'CHANGED', 'REVIEWED is optional for an otherwise valid changed comparison');
assert.equal(withoutReview.proofs[0].review, null);

const unchangedInputs = structuredClone(inputs);
unchangedInputs.reviewSnapshot = null;
unchangedInputs.followUpVisual.items[0].current.sha256 = currentSourceSha;
unchangedInputs.followUpVisual.items[0].comparison = {
  ...unchangedInputs.followUpVisual.items[0].comparison,
  status: 'UNCHANGED',
  comparisonStatus: 'same',
  differingPixels: 0,
  differingPixelRatio: 0,
  reason: 'fixture match',
};
unchangedInputs.followUpVisual.items[0].diff = null;
const unchanged = buildSingleSiteBaselineFollowUpEvidence(unchangedInputs);
assert.equal(unchanged.proofs[0].followUp.status, 'UNCHANGED');
assert.equal(unchanged.proofs[0].followUp.currentSha256, unchanged.proofs[0].followUp.baselineSha256);
assert.equal(unchanged.proofs[0].followUp.diffSha256, null);
assert.equal(unchanged.proofs[0].review, null);

const unchangedWithDiffInputs = structuredClone(unchangedInputs);
unchangedWithDiffInputs.followUpVisual.items[0].current.sha256 = currentFollowUpSha;
unchangedWithDiffInputs.followUpVisual.items[0].diff = {
  sha256: digest('2'), bytes: 4, relativePath: 'diffs/unchanged-within-tolerance.png',
};
unchangedWithDiffInputs.followUpVisual.items[0].comparison.differingPixels = 1;
unchangedWithDiffInputs.followUpVisual.items[0].comparison.differingPixelRatio = 0.001;
unchangedWithDiffInputs.followUpVisual.items[0].comparison.reason = 'fixture difference remains within tolerance';
const unchangedWithDiff = buildSingleSiteBaselineFollowUpEvidence(unchangedWithDiffInputs);
assert.equal(unchangedWithDiff.proofs[0].followUp.status, 'UNCHANGED');
assert.equal(unchangedWithDiff.proofs[0].followUp.diffSha256, digest('2'));

const mismatch = (change, pattern) => {
  const value = structuredClone(inputs);
  change(value);
  assert.throws(() => buildSingleSiteBaselineFollowUpEvidence(value), pattern);
};
mismatch((value) => { value.followUpReceipt.run.origin = 'https://other.example.test'; }, /compatible baseline proof/);
mismatch((value) => { value.sourceEligibility.items[0].evidence.artifactSha256 = digest('9'); }, /Source visual item|eligible source evidence/);
mismatch((value) => { value.verifiedBaselineMedia[baselineId].sha256 = digest('9'); }, /independently verified/);
mismatch((value) => { value.followUpVisual.items[0].baseline.mediaSha256 = digest('9'); }, /compatible comparison/);
mismatch((value) => {
  value.followUpVisual.items[0].identity = { ...value.followUpVisual.items[0].identity, route: '/different' };
}, /compatible comparison/);
mismatch((value) => {
  value.baselineSnapshot.history[0].payload.record = structuredClone(value.baselineSnapshot.history[0].payload.record);
  value.baselineSnapshot.history[0].payload.record.media.sha256 = digest('9');
}, /approval event disagrees/);
mismatch((value) => { value.baselineSnapshot.state.historyDigest = digest('9'); }, /history digest are inconsistent/);
mismatch((value) => { value.reviewSnapshot.state.reviews[reviewRecord.reviewKey].binding.currentMediaSha256 = digest('9'); }, /REVIEWED disposition disagrees/);
const digestTamper = structuredClone(document);
digestTamper.proofs[0].followUp.status = 'UNCHANGED';
assert.throws(() => validateSingleSiteBaselineFollowUpEvidence(digestTamper), /digest is invalid/);

process.stdout.write('Single-site baseline follow-up evidence self-test passed.\n');
