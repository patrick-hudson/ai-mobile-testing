import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertSharedGalleryInventoryBudget,
  classifySharedGalleryGroupMembers,
  consumeSharedGalleryStructuredBudget,
  openSharedSingleSiteGallery,
  sharedSingleSiteGalleryHead,
} from '../portal/shared-single-site-gallery.mjs';
import { sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import {
  acquireCoordinator,
  appendMutationAuditEvent,
  createParentRun,
  openParentRunStore,
  readParentRun,
} from './lib/parent-run-store.mjs';

const member = (memberRole, id) => ({ id, metadata: { memberRole } });
const baselineOnly = classifySharedGalleryGroupMembers([member('baseline', 'baseline')]);
assert.equal(baselineOnly.current, null);
assert.equal(baselineOnly.representative.id, 'baseline');
assert.match(baselineOnly.reasons.join(' '), /baseline media but no actual\/single current/u);

const diffOnly = classifySharedGalleryGroupMembers([member('diff', 'diff')]);
assert.equal(diffOnly.current, null);
assert.equal(diffOnly.diff.id, 'diff');
assert.match(diffOnly.reasons.join(' '), /difference media but no actual\/single current/u);

const duplicateCurrent = classifySharedGalleryGroupMembers([
  member('actual', 'actual'), member('single', 'single'), member('diff', 'diff'),
]);
assert.equal(duplicateCurrent.current, null);
assert.deepEqual(duplicateCurrent.counts, { current: 2, baseline: 0, diff: 1, other: 0 });
assert.match(duplicateCurrent.reasons.join(' '), /exactly one is required/u);

const complete = classifySharedGalleryGroupMembers([
  member('actual', 'actual'), member('baseline', 'baseline'), member('diff', 'diff'),
]);
assert.equal(complete.valid, true);
assert.equal(complete.current.id, 'actual');
assert.equal(complete.diff.id, 'diff');

assert.throws(() => assertSharedGalleryInventoryBudget({ workItems: 1, descriptors: 50_001 }),
  (error) => error?.code === 'SINGLE_SITE_GALLERY_ITEM_TOO_LARGE' && error?.statusCode === 413);
assert.throws(() => consumeSharedGalleryStructuredBudget({
  structuredDocumentsRead: 0,
  structuredJsonBytesRead: 0,
}, 32 * 1_048_576 + 1),
(error) => error?.code === 'SINGLE_SITE_GALLERY_STRUCTURED_BUDGET_EXCEEDED' && error?.statusCode === 413);
assert.throws(() => consumeSharedGalleryStructuredBudget({
  structuredDocumentsRead: 20_000,
  structuredJsonBytesRead: 0,
}, 1),
(error) => error?.code === 'SINGLE_SITE_GALLERY_STRUCTURED_BUDGET_EXCEEDED' && error?.statusCode === 413);

const root = await mkdtemp(path.join(tmpdir(), 'shared-gallery-hardening-'));
try {
  const openStore = (label) => openParentRunStore({
    root: path.join(root, label),
    deploymentIdentity: 'shared-gallery-hardening-self-test',
    volumeIdentity: 'named-volume:shared-gallery-hardening-self-test:' + label,
    storeMarker: '81'.repeat(32),
    backupMarker: 'backup:shared-gallery-hardening-self-test:' + label,
    verifyStorage: false,
  });
  const retryStore = await openStore('retry');
  const rejectStore = await openStore('reject');
  const subjectCore = sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: { kind: 'build', value: 'shared-gallery-hardening-self-test' },
    targets: [{ role: 'audited', origin: 'https://beta.example.test' }],
    mode: 'single-site',
    requestedAuthority: {
      qualifier: 'FULL',
      scope: { features: ['site'], definitions: ['SITE-001'], targets: ['audited-desktop'], knownLimits: [] },
    },
    revisions: {
      runner: `sha256:${'1'.repeat(64)}`,
      plugins: `sha256:${'2'.repeat(64)}`,
      targets: `sha256:${'3'.repeat(64)}`,
      configuration: `sha256:${'4'.repeat(64)}`,
    },
    environmentIdentity: `sha256:${'5'.repeat(64)}`,
    certificatePolicy: 'strict',
  });
  const createRun = async (store, runId) => {
    await createParentRun(store, {
      runId,
      subjectCore,
      workItems: [{
        id: `work-${runId}`,
        maxAttempts: 1,
        capability: 'browser:chromium',
        resourceClass: 'ordinary',
        targetId: 'audited-desktop',
      }],
    });
    return acquireCoordinator(store, runId, { ownerId: `coordinator-${runId}`, leaseMs: 60_000 });
  };
  const mutate = (store, runId, coordinator, sequence) => appendMutationAuditEvent(store, runId, coordinator, {
    type: 'gallery-snapshot-race-observed',
    actor: { kind: 'service', id: 'gallery-hardening-self-test' },
    data: { sequence },
  });

  const retryRun = 'gallery-race-retry';
  const retryCoordinator = await createRun(retryStore, retryRun);
  const retrySnapshot = await openSharedSingleSiteGallery({
    store: retryStore,
    runId: retryRun,
    snapshotHooks: {
      beforeRevisionConfirmation: async ({ snapshotAttempt }) => {
        if (snapshotAttempt === 1) await mutate(retryStore, retryRun, retryCoordinator, snapshotAttempt);
      },
    },
  });
  const retryHead = sharedSingleSiteGalleryHead(retrySnapshot);
  assert.equal(retryHead.sourceWork.snapshotAttempts, 2,
    'a run revision race retries from a fresh canonical parent-state snapshot');
  assert.equal(retryHead.sourceWork.inventorySource, 'revision-pinned-parent-state');
  assert.equal(retryHead.sourceWork.galleryInventoryPagesRead, 0,
    'the gallery no longer performs repeated offset scans over mutable artifact pages');
  assert.equal(retryHead.sharedAuthority.stateRevision, (await readParentRun(retryStore, retryRun)).runRevision);

  const rejectRun = 'gallery-race-reject';
  const rejectCoordinator = await createRun(rejectStore, rejectRun);
  await assert.rejects(() => openSharedSingleSiteGallery({
    store: rejectStore,
    runId: rejectRun,
    snapshotHooks: {
      beforeRevisionConfirmation: ({ snapshotAttempt }) => mutate(rejectStore, rejectRun, rejectCoordinator, snapshotAttempt),
    },
  }), (error) => error?.code === 'SINGLE_SITE_GALLERY_REVISION_STALE' && error?.statusCode === 409);

  console.log('Shared Single-site gallery hardening self-test passed: revision retry/reject, bounded scans, and exact current-member classification.');
} finally {
  await rm(root, { recursive: true, force: true });
}
