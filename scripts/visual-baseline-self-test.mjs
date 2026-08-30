import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compareVisualBaselineIdentity,
  parseVisualBaselineEvidence,
  parseVisualBaselineIdentity,
  visualBaselineDigest,
  visualBaselineSlotKey,
} from '../shared/visual-baseline-contract.mjs';
import {
  VisualBaselineStoreError,
  approveVisualBaseline,
  deleteVisualBaseline,
  isVisualBaselineMutationLocked,
  listVisualBaselineHistory,
  openVisualBaselineStore,
  readVisualBaselineStore,
  replaceVisualBaseline,
  resolveVisualBaseline,
  revokeVisualBaseline,
  withVisualBaselineMutationLock,
} from '../portal/visual-baselines.mjs';
import {
  VISUAL_COMPARISON_POLICY,
  classifyVisualDifference,
  reviewVisualComparison,
  visualComparisonUnavailable,
} from '../audit/visual-policy.mjs';
import {
  VisualComparisonDependencyError,
  compareVisualBaselineFiles,
  compareVisualImageBuffers,
  loadVisualComparisonDependencies,
} from './compare-visual-baselines.mjs';

function digestCharacter(character) {
  return `sha256:${character.repeat(64)}`;
}

function identity(overrides = {}) {
  const base = {
    schemaVersion: 1,
    mode: 'single-site',
    deploymentRole: 'preview',
    route: '/guide?b=2&a=1',
    targetId: 'single-site-desktop-chromium',
    viewport: { width: 1280, height: 720 },
    theme: 'light',
    auditId: 'VISUAL-001',
    auditDefinitionDigest: digestCharacter('c'),
    capturePoint: 'loaded-page',
    browser: { engine: 'chromium', product: 'Chromium', version: '140.0', build: 'build-1' },
    rendering: {
      devicePixelRatio: 1,
      captureContractRevision: 'capture-v1',
      runnerImageDigest: digestCharacter('a'),
      fontPackDigest: digestCharacter('b'),
    },
  };
  return parseVisualBaselineIdentity({ ...base, ...overrides });
}

function evidence(bytes, path = 'visual/capture.png', overrides = {}) {
  return parseVisualBaselineEvidence({
    runId: 'run-001',
    artifactRelativePath: path,
    artifactSha256: visualBaselineDigest(bytes),
    artifactBytes: bytes.length,
    contentType: 'image/png',
    runStatus: 'completed',
    evidenceComplete: true,
    evidenceAuthority: { status: 'authoritative', reasons: [] },
    findingStatus: 'clear',
    findingWaiver: null,
    ...overrides,
  });
}

function mutation(base, changes = {}) {
  return {
    expectedStoreRevision: 0,
    identity: identity(),
    evidence: base.evidence,
    runArtifactRoot: base.runRoot,
    actorId: 'reviewer-1',
    reason: 'Reviewed source evidence and approved this named capture point.',
    idempotencyKey: 'approve-001',
    ...changes,
  };
}

function expectStoreCode(code) {
  return (error) => error instanceof VisualBaselineStoreError && error.code === code;
}

function fakeImage(width, height, changedPixels = []) {
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data[pixel * 4] = 20;
    data[pixel * 4 + 1] = 30;
    data[pixel * 4 + 2] = 40;
    data[pixel * 4 + 3] = 255;
  }
  for (const pixel of changedPixels) data[pixel * 4] = 240;
  return Buffer.from(JSON.stringify({ width, height, data: [...data] }));
}

const fakeDependencies = {
  decodePng(bytes) {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return { width: value.width, height: value.height, data: Uint8Array.from(value.data) };
  },
  encodePng(image) {
    return Buffer.from(JSON.stringify({ width: image.width, height: image.height, data: [...image.data] }));
  },
  pixelmatch(left, right, output, width, height) {
    let changed = 0;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      const differs = left[offset] !== right[offset]
        || left[offset + 1] !== right[offset + 1]
        || left[offset + 2] !== right[offset + 2]
        || left[offset + 3] !== right[offset + 3];
      output.set(differs ? [255, 0, 0, 255] : [0, 0, 0, 0], offset);
      if (differs) changed += 1;
    }
    return changed;
  },
};

const temporaryRoot = await fs.mkdtemp(join(tmpdir(), 'visual-baseline-self-test-'));
try {
  let nonceNumber = 0;
  let clockNumber = 0;
  const baselineRoot = join(temporaryRoot, 'baseline-store');
  const runRoot = join(temporaryRoot, 'runs', 'run-001');
  await fs.mkdir(join(runRoot, 'visual'), { recursive: true });
  const firstBytes = Buffer.from('synthetic-png-evidence-one');
  await fs.writeFile(join(runRoot, 'visual', 'capture.png'), firstBytes);
  const base = { runRoot, evidence: evidence(firstBytes) };
  assert.throws(() => parseVisualBaselineEvidence({
    ...base.evidence,
    evidenceAuthority: { status: 'non-authoritative', reasons: ['Preview certificate verification was bypassed.'] },
  }), /not eligible/);
  assert.throws(() => parseVisualBaselineEvidence({ ...base.evidence, evidenceComplete: false }), /complete evidence/);
  assert.throws(() => parseVisualBaselineEvidence({ ...base.evidence, artifactRelativePath: '../escape.png' }), /contained relative path/);
  const store = await openVisualBaselineStore({
    root: baselineRoot,
    clock: () => new Date(Date.UTC(2026, 7, 25, 12, 0, clockNumber++)),
    nonce: () => `n${String(++nonceNumber).padStart(8, '0')}`,
    lockRetries: 100,
    lockRetryMilliseconds: 2,
  });

  const empty = await readVisualBaselineStore(store);
  assert.equal(empty.state.storeRevision, 0);
  assert.equal((await resolveVisualBaseline(store, identity())).status, 'absent');

  const approvalInput = mutation(base);
  const approved = await approveVisualBaseline(store, approvalInput);
  assert.equal(approved.storeRevision, 1);
  assert.equal(approved.eventType, 'approved');
  const approvedAgain = await approveVisualBaseline(store, approvalInput);
  assert.deepEqual(approvedAgain, approved, 'an exact idempotent retry must return its original result');
  assert.equal((await readVisualBaselineStore(store)).state.storeRevision, 1);

  await assert.rejects(
    approveVisualBaseline(store, { ...approvalInput, reason: 'Different request under a reused key.' }),
    expectStoreCode('BASELINE_IDEMPOTENCY_CONFLICT'),
  );
  await assert.rejects(
    approveVisualBaseline(store, mutation(base, { idempotencyKey: 'approve-active', expectedStoreRevision: 1 })),
    expectStoreCode('BASELINE_ACTIVE_EXISTS'),
  );

  const compatible = await resolveVisualBaseline(store, identity());
  assert.equal(compatible.status, 'compatible');
  assert.equal(compatible.baseline.baselineId, approved.baselineId);
  const copiedBytes = await fs.readFile(compatible.mediaPath);
  assert.deepEqual(copiedBytes, firstBytes);
  await fs.unlink(join(runRoot, 'visual', 'capture.png'));
  assert.equal((await resolveVisualBaseline(store, identity())).status, 'compatible', 'baseline bytes must survive source-run purge');

  const changedBrowser = identity({ browser: { engine: 'chromium', product: 'Chromium', version: '141.0', build: 'build-2' } });
  const incompatible = await resolveVisualBaseline(store, changedBrowser);
  assert.equal(incompatible.status, 'incompatible');
  assert.deepEqual(incompatible.compatibility.differences, ['browser-build']);
  assert.equal(incompatible.compatibility.environmentChangeOnly, true);
  assert.equal((await resolveVisualBaseline(store, identity({ route: '/different' }))).status, 'absent');

  const identityFields = [
    ['deploymentRole', identity({ deploymentRole: 'production' })],
    ['route', identity({ route: '/other' })],
    ['targetId', identity({ targetId: 'single-site-mobile-webkit' })],
    ['viewport', identity({ viewport: { width: 390, height: 844 } })],
    ['theme', identity({ theme: 'dark' })],
    ['auditId', identity({ auditId: 'VISUAL-002' })],
    ['auditDefinitionDigest', identity({ auditDefinitionDigest: digestCharacter('d') })],
    ['capturePoint', identity({ capturePoint: 'after-menu-open' })],
    ['browser-build', changedBrowser],
    ['rendering-fingerprint', identity({ rendering: {
      devicePixelRatio: 2,
      captureContractRevision: 'capture-v1',
      runnerImageDigest: digestCharacter('a'),
      fontPackDigest: digestCharacter('b'),
    } })],
  ];
  for (const [field, variant] of identityFields) {
    assert.ok(compareVisualBaselineIdentity(identity(), variant).differences.includes(field), `${field} must participate in compatibility`);
  }

  // Two writers observe revision 1; the shared lock serializes them and CAS permits exactly one.
  const raceRoot = join(temporaryRoot, 'runs', 'race');
  await fs.mkdir(raceRoot, { recursive: true });
  const raceBytes = Buffer.from('race-png');
  await fs.writeFile(join(raceRoot, 'a.png'), raceBytes);
  await fs.writeFile(join(raceRoot, 'b.png'), raceBytes);
  const raceInputs = ['/race-a', '/race-b'].map((route, index) => mutation(
    { runRoot: raceRoot, evidence: evidence(raceBytes, `${index === 0 ? 'a' : 'b'}.png`) },
    {
      expectedStoreRevision: 1,
      identity: identity({ route }),
      runArtifactRoot: raceRoot,
      evidence: evidence(raceBytes, `${index === 0 ? 'a' : 'b'}.png`),
      idempotencyKey: `race-${index}`,
    },
  ));
  const raced = await Promise.allSettled(raceInputs.map((input) => approveVisualBaseline(store, input)));
  assert.equal(raced.filter(({ status }) => status === 'fulfilled').length, 1);
  const raceFailure = raced.find(({ status }) => status === 'rejected');
  assert.equal(raceFailure.reason.code, 'BASELINE_CAS_CONFLICT');
  assert.equal((await readVisualBaselineStore(store)).state.storeRevision, 2);

  const secondBytes = Buffer.from('synthetic-png-evidence-two');
  await fs.writeFile(join(runRoot, 'visual', 'replacement.png'), secondBytes);
  const replaced = await replaceVisualBaseline(store, mutation(
    { runRoot, evidence: evidence(secondBytes, 'visual/replacement.png') },
    {
      expectedStoreRevision: 2,
      expectedActiveBaselineId: approved.baselineId,
      evidence: evidence(secondBytes, 'visual/replacement.png'),
      idempotencyKey: 'replace-001',
      reason: 'Explicitly replacing the reviewed capture with newer approved evidence.',
    },
  ));
  assert.equal(replaced.storeRevision, 3);
  let snapshot = await readVisualBaselineStore(store);
  assert.equal(snapshot.state.baselines[approved.baselineId].state, 'replaced');
  assert.equal(snapshot.state.baselines[approved.baselineId].replacedBy, replaced.baselineId);
  assert.equal(snapshot.state.baselines[replaced.baselineId].state, 'active');
  assert.equal((await fs.readFile(join(store.root, snapshot.state.baselines[approved.baselineId].media.relativePath))).toString(), firstBytes.toString());
  await assert.rejects(
    replaceVisualBaseline(store, mutation(base, {
      expectedStoreRevision: 2,
      expectedActiveBaselineId: approved.baselineId,
      idempotencyKey: 'replace-stale',
    })),
    expectStoreCode('BASELINE_CAS_CONFLICT'),
  );

  const revoked = await revokeVisualBaseline(store, {
    expectedStoreRevision: 3,
    baselineId: replaced.baselineId,
    actorId: 'reviewer-2',
    reason: 'Explicitly revoked after human review.',
    idempotencyKey: 'revoke-001',
  });
  assert.equal(revoked.storeRevision, 4);
  assert.equal((await resolveVisualBaseline(store, identity())).status, 'absent');
  assert.deepEqual(await revokeVisualBaseline(store, {
    expectedStoreRevision: 3,
    baselineId: replaced.baselineId,
    actorId: 'reviewer-2',
    reason: 'Explicitly revoked after human review.',
    idempotencyKey: 'revoke-001',
  }), revoked);

  assert.throws(() => evidence(firstBytes, 'visual/capture.png', {
    findingStatus: 'unresolved', findingWaiver: null,
  }), /explicit human waiver/);
  await fs.writeFile(join(runRoot, 'visual', 'waived.png'), firstBytes);
  const waivedEvidence = {
    ...evidence(firstBytes, 'visual/waived.png'),
    findingStatus: 'unresolved',
    findingWaiver: null,
  };
  const waivedIdentity = identity({ route: '/waived' });
  const waived = await approveVisualBaseline(store, mutation({ runRoot, evidence: waivedEvidence }, {
    expectedStoreRevision: 4,
    identity: waivedIdentity,
    evidence: waivedEvidence,
    idempotencyKey: 'approve-waived',
    findingWaiverReason: 'Known visual Finding explicitly accepted for this baseline only.',
  }));
  assert.equal(waived.storeRevision, 5);
  const waivedRecord = (await readVisualBaselineStore(store)).state.baselines[waived.baselineId];
  assert.equal(waivedRecord.source.findingStatus, 'unresolved');
  assert.equal(waivedRecord.source.findingWaiver.actorId, 'reviewer-1');
  assert.equal(waivedRecord.source.findingWaiver.reason, 'Known visual Finding explicitly accepted for this baseline only.');
  assert.match(waivedRecord.source.findingWaiver.at, /^2026-08-25T12:00:/);
  assert.deepEqual(await approveVisualBaseline(store, mutation({ runRoot, evidence: waivedEvidence }, {
    expectedStoreRevision: 4,
    identity: waivedIdentity,
    evidence: waivedEvidence,
    idempotencyKey: 'approve-waived',
    findingWaiverReason: 'Known visual Finding explicitly accepted for this baseline only.',
  })), waived, 'a server-stamped Finding waiver must retain idempotent retry semantics');

  const deletedOld = await deleteVisualBaseline(store, {
    expectedStoreRevision: 5,
    baselineId: approved.baselineId,
    actorId: 'reviewer-4',
    reason: 'Explicit retention deletion; provenance must remain tombstoned.',
    idempotencyKey: 'delete-old',
  });
  assert.equal(deletedOld.mediaRemoved, true);
  snapshot = await readVisualBaselineStore(store);
  const tombstone = snapshot.state.baselines[approved.baselineId];
  assert.equal(tombstone.state, 'deleted');
  assert.equal(tombstone.media.available, false);
  assert.equal(tombstone.source.runId, 'run-001');
  assert.equal(tombstone.source.artifactSha256, visualBaselineDigest(firstBytes));
  await assert.rejects(fs.access(join(store.root, tombstone.media.relativePath)));
  assert.equal(listVisualBaselineHistory(snapshot, tombstone.slotKey).length, 2);

  const deletedActive = await deleteVisualBaseline(store, {
    expectedStoreRevision: 6,
    baselineId: waived.baselineId,
    actorId: 'reviewer-4',
    reason: 'Explicitly deleting the active waived baseline and retaining its tombstone.',
    idempotencyKey: 'delete-active',
  });
  assert.equal(deletedActive.storeRevision, 7);
  assert.equal((await resolveVisualBaseline(store, waivedIdentity)).status, 'absent');

  // state.json is only a materialized cache; append-only events remain authoritative.
  await fs.writeFile(join(store.root, 'state.json'), '{"tampered":true}\n');
  assert.equal((await readVisualBaselineStore(store)).state.storeRevision, 7);

  await fs.mkdir(store.lockDirectory);
  assert.equal(await isVisualBaselineMutationLocked(store), true);
  await assert.rejects(
    withVisualBaselineMutationLock({ ...store, lockRetries: 2 }, async () => undefined),
    expectStoreCode('BASELINE_MUTATION_LOCKED'),
  );
  await fs.rm(store.lockDirectory, { recursive: true });
  assert.equal(await isVisualBaselineMutationLocked(store), false);

  // A source symlink and a store rooted inside run artifacts are both rejected before copying.
  const targetBytes = Buffer.from('symlink-target');
  await fs.writeFile(join(runRoot, 'visual', 'target.png'), targetBytes);
  await fs.symlink('target.png', join(runRoot, 'visual', 'link.png'));
  await assert.rejects(
    approveVisualBaseline(store, mutation({ runRoot, evidence: evidence(targetBytes, 'visual/link.png') }, {
      expectedStoreRevision: 7,
      identity: identity({ route: '/unsafe-link' }),
      evidence: evidence(targetBytes, 'visual/link.png'),
      idempotencyKey: 'unsafe-link',
    })),
    expectStoreCode('BASELINE_PATH_UNSAFE'),
  );
  await assert.rejects(
    approveVisualBaseline(store, mutation({ runRoot: temporaryRoot, evidence: evidence(targetBytes, 'runs/run-001/visual/target.png') }, {
      expectedStoreRevision: 7,
      identity: identity({ route: '/overlap' }),
      runArtifactRoot: temporaryRoot,
      evidence: evidence(targetBytes, 'runs/run-001/visual/target.png'),
      idempotencyKey: 'unsafe-overlap',
    })),
    expectStoreCode('BASELINE_PATH_UNSAFE'),
  );
  assert.equal((await readVisualBaselineStore(store)).state.storeRevision, 7);

  const symlinkRootTarget = join(temporaryRoot, 'symlink-root-target');
  await fs.mkdir(symlinkRootTarget);
  const symlinkRoot = join(temporaryRoot, 'symlink-root');
  await fs.symlink(symlinkRootTarget, symlinkRoot);
  await assert.rejects(openVisualBaselineStore({ root: symlinkRoot }), expectStoreCode('BASELINE_PATH_UNSAFE'));

  const unsafeMediaRoot = join(temporaryRoot, 'unsafe-media-copy');
  await fs.cp(store.root, unsafeMediaRoot, { recursive: true });
  const unsafeMediaStore = await openVisualBaselineStore({ root: unsafeMediaRoot });
  const unsafeMediaSnapshot = await readVisualBaselineStore(unsafeMediaStore);
  const activeRecord = Object.values(unsafeMediaSnapshot.state.baselines).find(({ state }) => state === 'active');
  assert.ok(activeRecord, 'the CAS race winner supplies an active record for unsafe-media testing');
  const unsafeMediaPath = join(unsafeMediaStore.root, activeRecord.media.relativePath);
  await fs.unlink(unsafeMediaPath);
  await fs.symlink(join(runRoot, 'visual', 'target.png'), unsafeMediaPath);
  assert.equal((await resolveVisualBaseline(unsafeMediaStore, activeRecord.identity)).status, 'unavailable');

  // Copy and corrupt one immutable event: replay must fail closed on the digest chain.
  const corruptedRoot = join(temporaryRoot, 'corrupted-copy');
  await fs.cp(store.root, corruptedRoot, { recursive: true });
  const corruptedStore = await openVisualBaselineStore({ root: corruptedRoot });
  const firstEventName = (await fs.readdir(corruptedStore.eventsDirectory)).sort()[0];
  const firstEventPath = join(corruptedStore.eventsDirectory, firstEventName);
  const firstEvent = JSON.parse(await fs.readFile(firstEventPath, 'utf8'));
  firstEvent.reason = 'tampered reason';
  await fs.writeFile(firstEventPath, JSON.stringify(firstEvent));
  await assert.rejects(readVisualBaselineStore(corruptedStore), expectStoreCode('BASELINE_HISTORY_CORRUPT'));

  const atTolerance = classifyVisualDifference({ differingPixels: 1, totalPixels: 400 });
  assert.equal(atTolerance.status, 'UNCHANGED');
  const overTolerance = classifyVisualDifference({ differingPixels: 2, totalPixels: 400 });
  assert.equal(overTolerance.status, 'CHANGED');
  const reviewed = reviewVisualComparison(overTolerance, {
    reviewerId: 'reviewer-visual',
    disposition: 'Expected redesign change accepted after evidence review.',
    reviewedAt: '2026-08-25T14:00:00.000Z',
  });
  assert.equal(reviewed.status, 'REVIEWED');
  assert.equal(reviewed.comparisonStatus, 'CHANGED');
  for (const result of [
    atTolerance,
    overTolerance,
    reviewed,
    visualComparisonUnavailable('absent', 'No baseline exists.'),
    visualComparisonUnavailable('incompatible', 'Browser fingerprint changed.'),
    visualComparisonUnavailable('unavailable', 'Media cannot be read.'),
  ]) {
    assert.deepEqual(result.effects, { deterministicHealth: 'none', deterministicFindings: 'none', promotion: 'none' });
  }

  const baselineImage = fakeImage(20, 20);
  const onePixel = fakeImage(20, 20, [0]);
  const twoPixels = fakeImage(20, 20, [0, 1]);
  assert.equal(compareVisualImageBuffers(baselineImage, onePixel, fakeDependencies).comparison.status, 'UNCHANGED');
  assert.equal(compareVisualImageBuffers(baselineImage, twoPixels, fakeDependencies).comparison.status, 'CHANGED');
  assert.equal(compareVisualImageBuffers(fakeImage(2, 2), fakeImage(3, 2), fakeDependencies).dimensionChanged, true);

  const comparisonRevisionBefore = (await readVisualBaselineStore(store)).state.storeRevision;
  const currentPath = join(temporaryRoot, 'current-fake.png');
  const baselinePath = join(temporaryRoot, 'baseline-fake.png');
  await fs.writeFile(currentPath, twoPixels);
  await fs.writeFile(baselinePath, baselineImage);
  const fileComparison = await compareVisualBaselineFiles({ baselinePath, currentPath, dependencies: fakeDependencies });
  assert.equal(fileComparison.comparison.status, 'CHANGED');
  assert.equal((await readVisualBaselineStore(store)).state.storeRevision, comparisonRevisionBefore, 'comparison must never auto-promote');

  try {
    const installedDependencies = await loadVisualComparisonDependencies();
    assert.equal(typeof installedDependencies.pixelmatch, 'function');
  } catch (error) {
    assert.ok(error instanceof VisualComparisonDependencyError);
    assert.match(error.message, /pixelmatch@7\.1\.0/);
    assert.match(error.message, /pngjs@7\.0\.0/);
    const missingDependencies = await compareVisualBaselineFiles({ baselinePath, currentPath });
    assert.equal(missingDependencies.comparison.status, 'unavailable');
    assert.match(missingDependencies.error, /pixelmatch@7\.1\.0/);
  }

  assert.equal(VISUAL_COMPARISON_POLICY.maximumDifferingPixelRatio, 0.0025);
  assert.deepEqual(VISUAL_COMPARISON_POLICY.dependencies, { pixelmatch: '7.1.0', pngjs: '7.0.0' });
  assert.equal(createHash('sha256').update(firstBytes).digest('hex'), base.evidence.artifactSha256.slice('sha256:'.length));

  process.stdout.write('visual baseline self-test passed\n');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
