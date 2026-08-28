import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseVisualBaselineEvidence,
  parseVisualBaselineIdentity,
  visualBaselineDigest,
  visualBaselineIdentityKey,
  visualBaselineSlotKey,
} from '../shared/visual-baseline-contract.mjs';
import {
  approveVisualBaseline,
  openVisualBaselineStore,
  readVisualBaselineStore,
  revokeVisualBaseline,
} from '../portal/visual-baselines.mjs';
import {
  VisualReviewStoreError,
  openVisualReviewStore,
  readVisualReviewStore,
  resolveVisualReview,
  reviewVisualComparison,
} from '../portal/visual-review-dispositions.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;

function identity() {
  return parseVisualBaselineIdentity({
    schemaVersion: 1,
    mode: 'single-site',
    deploymentRole: 'preview',
    route: '/guide',
    targetId: 'single-site-desktop-chromium',
    viewport: { width: 1280, height: 720 },
    theme: 'light',
    auditId: 'VISUAL-001',
    auditDefinitionDigest: digest('c'),
    capturePoint: 'loaded-page',
    browser: { engine: 'chromium', product: 'Chromium', version: '140.0', build: 'build-1' },
    rendering: {
      devicePixelRatio: 1,
      captureContractRevision: 'capture-v1',
      runnerImageDigest: digest('a'),
      fontPackDigest: digest('b'),
    },
  });
}

function expectCode(code) {
  return (error) => error instanceof VisualReviewStoreError && error.code === code;
}

const root = await fs.mkdtemp(join(tmpdir(), 'single-site-visual-review-'));
try {
  const runRoot = join(root, 'sealed-run');
  const sourceRelative = 'visual/current.png';
  const sourceFile = join(runRoot, sourceRelative);
  const sourceBytes = Buffer.from('sealed-current-image');
  await fs.mkdir(join(runRoot, 'visual'), { recursive: true });
  await fs.writeFile(sourceFile, sourceBytes);
  const sealedBefore = visualBaselineDigest(await fs.readFile(sourceFile));
  let baselineNonce = 0;
  const baselineStore = await openVisualBaselineStore({
    root: join(root, 'baselines'),
    clock: () => new Date('2026-08-25T12:00:00.000Z'),
    nonce: () => `baseline-${++baselineNonce}`,
    lockRetries: 20,
    lockRetryMilliseconds: 1,
  });
  const visualIdentity = identity();
  const evidence = parseVisualBaselineEvidence({
    runId: 'source-run',
    artifactRelativePath: sourceRelative,
    artifactSha256: visualBaselineDigest(sourceBytes),
    artifactBytes: sourceBytes.length,
    contentType: 'image/png',
    runStatus: 'completed',
    evidenceComplete: true,
    evidenceAuthority: { status: 'authoritative', reasons: [] },
    findingStatus: 'clear',
    findingWaiver: null,
  });
  const approved = await approveVisualBaseline(baselineStore, {
    expectedStoreRevision: 0,
    identity: visualIdentity,
    evidence,
    runArtifactRoot: runRoot,
    actorId: 'reviewer',
    reason: 'Approve the exact visual baseline for review testing.',
    idempotencyKey: 'approve-review-baseline',
  });

  let reviewNonce = 0;
  const reviewStore = await openVisualReviewStore({
    root: join(root, 'review-dispositions'),
    clock: () => new Date('2026-08-25T12:05:00.000Z'),
    nonce: () => `review-${++reviewNonce}`,
  });
  const binding = {
    jobId: 'single-site-run',
    galleryItemId: 'gitem_0123456789abcdef',
    reportRevision: '1'.repeat(32),
    galleryExportRevision: 'export_0123456789abcdef',
    visualPublicationDigest: digest('2'),
    visualComparisonItemId: '3'.repeat(32),
    identityKey: visualBaselineIdentityKey(visualIdentity),
    slotKey: visualBaselineSlotKey(visualIdentity),
    comparisonDigest: digest('4'),
    baselineId: approved.baselineId,
    baselineMediaSha256: evidence.artifactSha256,
    currentMediaSha256: digest('5'),
    diffSha256: digest('6'),
  };
  const request = {
    expectedReviewRevision: 0,
    expectedBaselineStoreRevision: 1,
    binding,
    actorId: 'portal-operator',
    rationale: 'The redesign difference is intentional and has been reviewed against the exact baseline.',
    disposition: 'accepted-change',
    idempotencyKey: 'review-visual-0001',
  };
  const first = await reviewVisualComparison(reviewStore, baselineStore, request);
  assert.equal(first.status, 'REVIEWED');
  assert.equal(first.reviewRevision, 1);
  assert.equal(first.idempotent, false);
  const repeated = await reviewVisualComparison(reviewStore, baselineStore, request);
  assert.deepEqual(repeated, { ...first, idempotent: true });

  const snapshot = await readVisualReviewStore(reviewStore);
  assert.equal(snapshot.state.reviewRevision, 1);
  assert.equal(snapshot.history.length, 1);
  const record = resolveVisualReview(snapshot, binding);
  assert.equal(record.actorId, 'portal-operator');
  assert.equal(record.reviewedAt, '2026-08-25T12:05:00.000Z');
  assert.equal(record.rationale, request.rationale);
  assert.equal(record.disposition, 'accepted-change');
  assert.equal(resolveVisualReview(snapshot, { ...binding, diffSha256: digest('7') }), null);
  assert.equal(visualBaselineDigest(await fs.readFile(sourceFile)), sealedBefore, 'review mutation changed sealed run bytes');

  await assert.rejects(
    reviewVisualComparison(reviewStore, baselineStore, { ...request, rationale: 'A conflicting retry rationale.' }),
    expectCode('VISUAL_REVIEW_IDEMPOTENCY_CONFLICT'),
  );
  await assert.rejects(
    reviewVisualComparison(reviewStore, baselineStore, {
      ...request,
      expectedReviewRevision: 1,
      idempotencyKey: 'review-visual-0002',
    }),
    expectCode('VISUAL_REVIEW_ALREADY_RECORDED'),
  );

  await revokeVisualBaseline(baselineStore, {
    expectedStoreRevision: 1,
    baselineId: approved.baselineId,
    actorId: 'portal-operator',
    reason: 'Revoke the source baseline to test stale-review rejection.',
    idempotencyKey: 'revoke-review-baseline',
  });
  const baselineRevision = (await readVisualBaselineStore(baselineStore)).state.storeRevision;
  await assert.rejects(
    reviewVisualComparison(reviewStore, baselineStore, {
      ...request,
      expectedReviewRevision: 1,
      expectedBaselineStoreRevision: baselineRevision,
      binding: { ...binding, galleryItemId: 'gitem_fedcba9876543210', visualComparisonItemId: '8'.repeat(32) },
      disposition: 'known-defect',
      idempotencyKey: 'review-stale-baseline',
    }),
    expectCode('VISUAL_REVIEW_BASELINE_STALE'),
  );

  const eventFile = join(reviewStore.eventsDirectory, (await fs.readdir(reviewStore.eventsDirectory))[0]);
  const event = JSON.parse(await fs.readFile(eventFile, 'utf8'));
  event.rationale = 'Tampered rationale that no longer matches the event digest.';
  await fs.writeFile(eventFile, `${JSON.stringify(event)}\n`);
  await assert.rejects(readVisualReviewStore(reviewStore), expectCode('VISUAL_REVIEW_HISTORY_CORRUPT'));
  console.log('Single-site visual review self-test passed.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
