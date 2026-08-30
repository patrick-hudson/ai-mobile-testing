import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalDigest, canonicalJson } from '../shared/canonical-contract.mjs';
import {
  initializeSharedAuthorityFloor,
  openSharedAuthorityFloor,
  parseSharedAuthorityFloor,
  parseSharedAuthorityRestoreReceipt,
} from './lib/shared-authority-floor.mjs';

const markerDigest = canonicalDigest({ storeMarker: 'external-authority-floor-fixture' });
const cutoverDigest = canonicalDigest({ cutover: 'shared-activation-0041' });
const buildA = 'build:shared-authority-a';
const buildB = 'build:shared-authority-b';
const transitionA = canonicalDigest({ transition: 'shared-activation-a' });
const transitionB = canonicalDigest({ transition: 'shared-handoff-a-to-b' });
let now = Date.parse('2026-08-29T20:00:00.000Z');
const clock = () => (now += 1_000);

function initialFloor() {
  return {
    storeMarkerDigest: markerDigest,
    minimumStoreGeneration: 8,
    minimumSelectorRevision: 5,
    activeBuildIdentity: buildA,
    authorityTransitionDigest: transitionA,
    activationEpoch: 1,
    legacyPermanentlyRetired: true,
    activationRevision: 41,
    activationCutoverDigest: cutoverDigest,
  };
}

function state(storeGeneration, phase = 'ACTIVE', {
  selectorRevision = 5,
  activeBuildIdentity = buildA,
  authorityTransitionDigest = transitionA,
} = {}) {
  const manifest = {
    storeMarkerDigest: markerDigest,
    storeGeneration,
    activationEpoch: 1,
    activationRevision: 41,
  };
  const selector = {
    storeMarkerDigest: markerDigest,
    storeGeneration,
    activationEpoch: 1,
    activationRevision: 41,
    revision: selectorRevision,
    activeBuildIdentity,
    phase,
  };
  const legacyFence = {
    state: 'ACTIVATED',
    activationEpoch: 1,
  };
  return {
    manifest, selector, legacyFence,
    activationCutoverDigest: cutoverDigest,
    authorityTransitionDigest,
  };
}

function expectCode(code, operation) {
  return assert.rejects(operation, (error) => error?.code === code);
}

const base = await mkdtemp(path.join(tmpdir(), 'shared-authority-floor-'));
try {
  const canonicalStoreRoot = path.join(base, 'canonical-store');
  const backupRoot = path.join(base, 'backup');
  const floorRoot = path.join(base, 'external-floor');
  const floor = await initializeSharedAuthorityFloor({
    root: floorRoot,
    protectedRoots: [canonicalStoreRoot, backupRoot],
    initial: initialFloor(),
    verifyStorage: false,
    clock,
  });
  const first = await floor.read();
  assert.equal(first.revision, 1);
  assert.equal(first.minimumStoreGeneration, 8);
  assert.equal(first.minimumSelectorRevision, 5);
  assert.equal(first.activeBuildIdentity, buildA);
  assert.equal(first.legacyPermanentlyRetired, true);
  assert.equal(parseSharedAuthorityFloor(first).digest, first.digest);
  assert.equal((await floor.assertAuthorityState(state(8))).digest, first.digest);

  await expectCode('AUTHORITY_FLOOR_STALE_STORE', () => floor.assertAuthorityState(state(7)));
  await expectCode('AUTHORITY_FLOOR_MARKER_MISMATCH', () => floor.assertAuthorityState({
    ...state(8),
    manifest: { ...state(8).manifest, storeMarkerDigest: canonicalDigest({ marker: 'wrong' }) },
  }));
  await expectCode('AUTHORITY_FLOOR_STALE_ACTIVATION', () => floor.assertAuthorityState({
    ...state(8),
    selector: { ...state(8).selector, activationEpoch: 0, activationRevision: null, phase: 'SHADOW' },
  }));
  await expectCode('AUTHORITY_FLOOR_LEGACY_RESTORED', () => floor.assertAuthorityState({
    ...state(8), legacyFence: { state: 'OPEN', activationEpoch: 0 },
  }));
  await expectCode('AUTHORITY_FLOOR_CUTOVER_MISMATCH', () => floor.assertAuthorityState({
    ...state(8), activationCutoverDigest: canonicalDigest({ cutover: 'wrong' }),
  }));

  const tampered = JSON.parse(await readFile(path.join(floorRoot, 'authority-floor.json'), 'utf8'));
  tampered.minimumStoreGeneration = 1;
  await writeFile(path.join(floorRoot, 'authority-floor.json'), `${canonicalJson(tampered)}\n`);
  await expectCode('AUTHORITY_FLOOR_CORRUPT', () => floor.read());
  await writeFile(path.join(floorRoot, 'authority-floor.json'), `${canonicalJson(first)}\n`);

  const winners = await Promise.allSettled([
    floor.compareAndAdvance(first.digest, { minimumStoreGeneration: 9 }),
    floor.compareAndAdvance(first.digest, { minimumStoreGeneration: 10 }),
  ]);
  assert.equal(winners.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(winners.filter(({ status, reason }) => status === 'rejected'
    && reason?.code === 'AUTHORITY_FLOOR_CONFLICT').length, 1);
  const advanced = await floor.read();
  assert.ok([9, 10].includes(advanced.minimumStoreGeneration));
  await expectCode('AUTHORITY_FLOOR_REGRESSION', () => floor.compareAndAdvance(advanced.digest, {
    minimumStoreGeneration: advanced.minimumStoreGeneration - 1,
  }));
  await expectCode('AUTHORITY_FLOOR_REGRESSION', () => floor.compareAndAdvance(advanced.digest, {
    legacyPermanentlyRetired: false,
  }));
  await expectCode('AUTHORITY_FLOOR_REGRESSION', () => floor.compareAndAdvance(advanced.digest, {
    activeBuildIdentity: buildB,
    authorityTransitionDigest: transitionB,
  }));
  await expectCode('AUTHORITY_FLOOR_MARKER_MISMATCH', () => floor.compareAndAdvance(advanced.digest, {
    storeMarkerDigest: canonicalDigest({ marker: 'replacement' }),
  }));

  const previousHead = first;
  await writeFile(path.join(floorRoot, 'authority-floor.json'), `${canonicalJson(previousHead)}\n`);
  await expectCode('AUTHORITY_FLOOR_ROLLBACK_DETECTED', () => floor.read());
  await writeFile(path.join(floorRoot, 'authority-floor.json'), `${canonicalJson(advanced)}\n`);
  const revisionFile = path.join(floorRoot, 'revisions', `${String(advanced.revision).padStart(16, '0')}.json`);
  const journalRevision = JSON.parse(await readFile(revisionFile, 'utf8'));
  await writeFile(revisionFile, `${canonicalJson({ ...journalRevision, minimumStoreGeneration: 1 })}\n`);
  await expectCode('AUTHORITY_FLOOR_CORRUPT', () => floor.read());
  await writeFile(revisionFile, `${canonicalJson(journalRevision)}\n`);

  const handoff = await floor.compareAndAdvance(advanced.digest, {
    minimumSelectorRevision: advanced.minimumSelectorRevision + 1,
    activeBuildIdentity: buildB,
    authorityTransitionDigest: transitionB,
  });
  assert.equal(handoff.activeBuildIdentity, buildB);
  assert.equal(handoff.minimumSelectorRevision, 6);
  await expectCode('AUTHORITY_FLOOR_STALE_SELECTOR', () => floor.assertAuthorityState(
    state(handoff.minimumStoreGeneration),
  ));
  await expectCode('AUTHORITY_FLOOR_OWNER_MISMATCH', () => floor.assertAuthorityState(
    state(handoff.minimumStoreGeneration, 'ACTIVE', {
      selectorRevision: handoff.minimumSelectorRevision,
      activeBuildIdentity: buildA,
      authorityTransitionDigest: transitionB,
    }),
  ));
  await expectCode('AUTHORITY_FLOOR_TRANSITION_MISMATCH', () => floor.assertAuthorityState(
    state(handoff.minimumStoreGeneration, 'ACTIVE', {
      selectorRevision: handoff.minimumSelectorRevision,
      activeBuildIdentity: buildB,
      authorityTransitionDigest: transitionA,
    }),
  ));
  assert.equal((await floor.assertAuthorityState(state(handoff.minimumStoreGeneration, 'ACTIVE', {
    selectorRevision: handoff.minimumSelectorRevision,
    activeBuildIdentity: buildB,
    authorityTransitionDigest: transitionB,
  }))).digest, handoff.digest);

  const plan = await floor.planRestoreForward({
    expectedDigest: handoff.digest,
    planId: 'restore-forward-0001',
    restoredStoreGeneration: 6,
    restoredSelectorRevision: 4,
  });
  assert.equal(plan.nextStoreGeneration, handoff.minimumStoreGeneration + 1);
  assert.equal(plan.nextSelectorRevision, handoff.minimumSelectorRevision + 1);
  assert.equal(plan.activeBuildIdentity, buildB);
  assert.notEqual(plan.nextAuthorityTransitionDigest, transitionB);
  assert.equal(plan.requiredSelectorPhase, 'PROMOTION_DISABLED');
  assert.equal(plan.requiredLegacyFenceState, 'ACTIVATED');
  assert.equal(plan.invalidatesPriorReleaseBindings, true);
  assert.equal(plan.requiresNewAuthoritativeRuns, true);
  assert.equal((await floor.planRestoreForward({
    expectedDigest: handoff.digest,
    planId: 'restore-forward-0001',
    restoredStoreGeneration: 6,
    restoredSelectorRevision: 4,
  })).digest, plan.digest, 'restore planning must be idempotent by plan identifier');
  const repairedState = state(plan.nextStoreGeneration, 'PROMOTION_DISABLED', {
    selectorRevision: plan.nextSelectorRevision,
    activeBuildIdentity: plan.activeBuildIdentity,
    authorityTransitionDigest: plan.nextAuthorityTransitionDigest,
  });

  await expectCode('AUTHORITY_RESTORE_STATE_INVALID', () => floor.completeRestoreForward({
    plan,
    expectedFloorDigest: handoff.digest,
    state: { ...repairedState, selector: { ...repairedState.selector, phase: 'ACTIVE' } },
  }));
  await expectCode('AUTHORITY_RESTORE_STATE_INVALID', () => floor.completeRestoreForward({
    plan,
    expectedFloorDigest: handoff.digest,
    state: { ...repairedState, legacyFence: { state: 'OPEN', activationEpoch: 0 } },
  }));
  const receipt = await floor.completeRestoreForward({
    plan,
    expectedFloorDigest: handoff.digest,
    state: repairedState,
  });
  assert.equal(receipt.previousMinimumStoreGeneration, handoff.minimumStoreGeneration);
  assert.equal(receipt.minimumStoreGeneration, plan.nextStoreGeneration);
  assert.equal(receipt.previousMinimumSelectorRevision, handoff.minimumSelectorRevision);
  assert.equal(receipt.minimumSelectorRevision, plan.nextSelectorRevision);
  assert.equal(receipt.activeBuildIdentity, buildB);
  assert.equal(receipt.authorityTransitionDigest, plan.nextAuthorityTransitionDigest);
  assert.equal(receipt.selectorPhase, 'PROMOTION_DISABLED');
  assert.equal(receipt.legacyFenceState, 'ACTIVATED');
  assert.equal(receipt.invalidatesPriorReleaseBindings, true);
  assert.equal(receipt.requiresNewAuthoritativeRuns, true);
  assert.equal(parseSharedAuthorityRestoreReceipt(receipt).digest, receipt.digest);
  assert.equal((await floor.completeRestoreForward({
    plan,
    expectedFloorDigest: handoff.digest,
    state: repairedState,
  })).digest, receipt.digest, 'restore completion must be restart-safe and idempotent');
  const restoredFloor = await floor.read();
  assert.equal(restoredFloor.minimumStoreGeneration, plan.nextStoreGeneration);
  assert.equal(restoredFloor.minimumSelectorRevision, plan.nextSelectorRevision);
  await expectCode('AUTHORITY_FLOOR_STALE_STORE', () => floor.assertAuthorityState(state(handoff.minimumStoreGeneration)));

  const persistedReceipt = JSON.parse(await readFile(
    path.join(floorRoot, 'restore-receipts', `${plan.planId}.json`), 'utf8',
  ));
  assert.deepEqual(persistedReceipt, receipt);
  const tamperedReceipt = structuredClone(receipt);
  tamperedReceipt.requiresNewAuthoritativeRuns = false;
  assert.throws(
    () => parseSharedAuthorityRestoreReceipt(tamperedReceipt),
    (error) => error?.code === 'AUTHORITY_RESTORE_RECEIPT_INVALID',
  );

  const reopened = await openSharedAuthorityFloor({
    root: floorRoot,
    protectedRoots: [canonicalStoreRoot, backupRoot],
    verifyStorage: false,
    clock,
  });
  assert.equal((await reopened.read()).digest, restoredFloor.digest);

  await expectCode('AUTHORITY_FLOOR_NOT_EXTERNAL', () => initializeSharedAuthorityFloor({
    root: path.join(backupRoot, 'floor'),
    protectedRoots: [backupRoot],
    initial: initialFloor(),
    verifyStorage: false,
    clock,
  }));
} finally {
  await rm(base, { recursive: true, force: true });
}

console.log('shared authority floor self-test passed');
