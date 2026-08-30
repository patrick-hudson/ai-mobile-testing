import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalDigest } from '../shared/canonical-contract.mjs';
import {
  PARENT_RUN_STORE_SCHEMA_VERSION,
  PARENT_RUN_WRITER_PROTOCOL,
  acquireStoreCoordinator,
  openParentRunStore,
  prequalifyReleaseAuthorityBuild,
  readReleaseAuthoritySelector,
  transitionReleaseAuthority,
} from './lib/parent-run-store.mjs';

const sourceBuild = 'build:prequalification-source';
const targetBuild = 'build:prequalification-target';
const marker = '42'.repeat(32);
let fixtureSequence = 0;

function transitionDigest(label) {
  return canonicalDigest({ test: 'parent-run-store-prequalification', label });
}

function expectCode(code, operation) {
  return assert.rejects(operation, (error) => error?.code === code);
}

async function activeFixture() {
  fixtureSequence += 1;
  const root = await mkdtemp(path.join(tmpdir(), 'parent-run-store-prequalification-'));
  const clock = () => Date.parse('2026-08-30T12:00:00.000Z') + fixtureSequence;
  const deploymentIdentity = `compose-project:prequalification-${fixtureSequence}`;
  const volumeIdentity = `named-volume:prequalification-${fixtureSequence}`;
  const store = await openParentRunStore({
    root,
    deploymentIdentity,
    volumeIdentity,
    storeMarker: marker,
    storeGeneration: 1,
    schemaFloor: PARENT_RUN_STORE_SCHEMA_VERSION,
    writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
    minimumWriterProtocol: PARENT_RUN_WRITER_PROTOCOL,
    buildIdentity: sourceBuild,
    prequalifiedRollbackBuilds: [sourceBuild],
    backupMarker: 'backup:prequalification',
    verifyStorage: false,
    clock,
  });
  const coordinator = await acquireStoreCoordinator(store, {
    ownerId: `prequalification-coordinator-${fixtureSequence}`,
    leaseMs: 60_000,
  });
  const shadow = await readReleaseAuthoritySelector(store);
  const draining = await transitionReleaseAuthority(store, coordinator, {
    expectedSelectorDigest: shadow.digest,
    phase: 'DRAINING',
    buildIdentity: sourceBuild,
  });
  const active = await transitionReleaseAuthority(store, coordinator, {
    expectedSelectorDigest: draining.digest,
    phase: 'ACTIVE',
    buildIdentity: sourceBuild,
    activationRevision: 1,
    activationCutoverDigest: transitionDigest('activation-cutover'),
    authorityTransitionDigest: transitionDigest('activation'),
  });
  return { root, store, coordinator, active, clock, deploymentIdentity, volumeIdentity };
}

function inputFor(store, selector, label = 'append-target') {
  return {
    expectedSelectorDigest: selector.digest,
    expectedManifestDigest: store.manifest.digest,
    targetBuildIdentity: targetBuild,
    expectedTargetSelectorRevision: selector.revision + 1,
    authorityTransitionDigest: transitionDigest(label),
  };
}

async function verifySuccessfulAppendAndReplay() {
  const fixture = await activeFixture();
  try {
    const beforeManifest = structuredClone(fixture.store.manifest);
    const input = inputFor(fixture.store, fixture.active);
    const next = await prequalifyReleaseAuthorityBuild(fixture.store, fixture.coordinator, input);
    assert.deepEqual(next.prequalifiedRollbackBuilds, [sourceBuild, targetBuild].sort());
    assert.deepEqual(fixture.store.manifest.prequalifiedRollbackBuilds, next.prequalifiedRollbackBuilds);
    assert.equal(next.previousDigest, fixture.active.digest);
    assert.equal(next.revision, fixture.active.revision + 1);
    assert.equal(next.authorityTransitionDigest, input.authorityTransitionDigest);
    for (const key of [
      'phase', 'activationEpoch', 'activationRevision', 'activatedAt', 'activeWriterProtocol',
      'minimumWriterProtocol', 'activeBuildIdentity', 'activationCutoverDigest', 'backupMarker',
      'storeGeneration', 'storeMarkerDigest',
    ]) assert.deepEqual(next[key], fixture.active[key], `${key} must retain its durable identity`);
    for (const key of Object.keys(beforeManifest)) {
      if (!['prequalifiedRollbackBuilds', 'digest'].includes(key)) {
        assert.deepEqual(fixture.store.manifest[key], beforeManifest[key], `${key} must be preserved`);
      }
    }
    assert.equal((await prequalifyReleaseAuthorityBuild(fixture.store, fixture.coordinator, input)).digest, next.digest,
      'an exact replay must be idempotent');
    await expectCode('AUTHORITY_PREQUALIFICATION_TARGET_CONFLICT', () => prequalifyReleaseAuthorityBuild(
      fixture.store,
      fixture.coordinator,
      { ...input, authorityTransitionDigest: transitionDigest('conflicting-replay') },
    ));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function verifyRejections() {
  const fixture = await activeFixture();
  try {
    const input = inputFor(fixture.store, fixture.active);
    await expectCode('AUTHORITY_PREQUALIFICATION_TARGET_INVALID', () => prequalifyReleaseAuthorityBuild(
      fixture.store, fixture.coordinator, { ...input, targetBuildIdentity: sourceBuild },
    ));
    await expectCode('AUTHORITY_SELECTOR_CONFLICT', () => prequalifyReleaseAuthorityBuild(
      fixture.store, fixture.coordinator, { ...input, expectedSelectorDigest: transitionDigest('stale-selector') },
    ));
    await expectCode('STORE_MANIFEST_CONFLICT', () => prequalifyReleaseAuthorityBuild(
      fixture.store, fixture.coordinator, { ...input, expectedManifestDigest: transitionDigest('stale-manifest') },
    ));
    await expectCode('AUTHORITY_PREQUALIFICATION_REVISION_INVALID', () => prequalifyReleaseAuthorityBuild(
      fixture.store, fixture.coordinator, { ...input, expectedTargetSelectorRevision: fixture.active.revision + 2 },
    ));
    await expectCode('AUTHORITY_PREQUALIFICATION_INVALID', () => prequalifyReleaseAuthorityBuild(
      fixture.store, fixture.coordinator, { ...input, authorityTransitionDigest: 'not-sha256' },
    ));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function verifyCrashRecovery(hook) {
  const fixture = await activeFixture();
  try {
    const input = inputFor(fixture.store, fixture.active, `crash-${hook}`);
    await assert.rejects(prequalifyReleaseAuthorityBuild(fixture.store, fixture.coordinator, {
      ...input,
      hooks: { [hook]: () => { throw new Error(`synthetic ${hook} crash`); } },
    }), new RegExp(`synthetic ${hook} crash`, 'u'));
    const reopened = await openParentRunStore({
      root: fixture.root,
      deploymentIdentity: fixture.deploymentIdentity,
      volumeIdentity: fixture.volumeIdentity,
      storeMarker: marker,
      expectedStoreGeneration: 2,
      writerProtocol: PARENT_RUN_WRITER_PROTOCOL,
      buildIdentity: sourceBuild,
      verifyStorage: false,
      clock: fixture.clock,
    });
    const recovered = await readReleaseAuthoritySelector(reopened);
    assert.deepEqual(recovered.prequalifiedRollbackBuilds, [sourceBuild, targetBuild].sort());
    assert.deepEqual(reopened.manifest.prequalifiedRollbackBuilds, recovered.prequalifiedRollbackBuilds);
    assert.equal(recovered.authorityTransitionDigest, input.authorityTransitionDigest);
    await assert.rejects(readFile(
      path.join(fixture.root, 'release-authority-build-prequalification-intent.json'),
      'utf8',
    ), (error) => error?.code === 'ENOENT');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function verifyCorruptIntentFailsClosed() {
  const fixture = await activeFixture();
  try {
    const input = inputFor(fixture.store, fixture.active, 'corrupt-intent');
    await assert.rejects(prequalifyReleaseAuthorityBuild(fixture.store, fixture.coordinator, {
      ...input,
      hooks: { afterIntent: () => { throw new Error('leave intent'); } },
    }), /leave intent/u);
    const intentPath = path.join(fixture.root, 'release-authority-build-prequalification-intent.json');
    const intent = JSON.parse(await readFile(intentPath, 'utf8'));
    intent.targetBuildIdentity = 'build:tampered';
    await writeFile(intentPath, `${JSON.stringify(intent)}\n`);
    await expectCode('AUTHORITY_PREQUALIFICATION_INTENT_INVALID', () => readReleaseAuthoritySelector(fixture.store));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

await verifySuccessfulAppendAndReplay();
await verifyRejections();
for (const hook of ['afterIntent', 'afterManifest', 'afterSelector']) await verifyCrashRecovery(hook);
await verifyCorruptIntentFailsClosed();

console.log('Parent-run store build-prequalification self-test passed: append-only identity, exact replay, conflicts, and manifest-first crash recovery fail closed.');
