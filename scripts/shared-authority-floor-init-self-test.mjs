import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalDigest, canonicalJson } from '../shared/canonical-contract.mjs';
import { initializeSharedAuthorityFloorFromEnvironment } from './init-shared-authority-floor.mjs';
import { openSharedAuthorityFloor } from './lib/shared-authority-floor.mjs';

const marker = 'ab'.repeat(32);

function seal(body) {
  return { ...body, digest: canonicalDigest(body) };
}

async function fixture(base, name) {
  const root = path.join(base, name);
  const canonicalRoot = path.join(root, 'canonical');
  const floorRoot = path.join(root, 'authority-floor');
  const trustRoot = path.join(root, 'trust');
  const markerFile = path.join(trustRoot, 'store-marker');
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(trustRoot, { recursive: true });
  await writeFile(markerFile, `${marker}\n`, { mode: 0o600 });
  await chmod(markerFile, 0o600);
  return {
    root,
    canonicalRoot,
    floorRoot,
    markerFile,
    environment: {
      AUDIT_SHARED_AUTHORITY_FLOOR_ROOT: floorRoot,
      AUDIT_SHARED_STORE_ROOT: canonicalRoot,
      AUDIT_SHARED_STORE_MARKER_FILE: markerFile,
      AUDIT_SHARED_STORE_GENERATION: '7',
      AUDIT_SHARED_BACKUP_ROOT: path.join(root, 'backup'),
      AUDIT_SHARED_RESTORE_ROOT: path.join(root, 'restore'),
      AUDIT_SHARED_AUTHORITY_FLOOR_VERIFY_STORAGE: '0',
    },
  };
}

const base = await mkdtemp(path.join(tmpdir(), 'shared-authority-floor-init-'));
try {
  const fresh = await fixture(base, 'fresh');
  const event = await initializeSharedAuthorityFloorFromEnvironment(fresh.environment);
  assert.equal(event.event, 'shared-authority-floor-ready');
  assert.equal(event.created, true);
  assert.equal(event.minimumStoreGeneration, 7);
  assert.equal(event.minimumSelectorRevision, 1);
  assert.equal(event.activationEpoch, 0);
  assert.equal(event.activeBuildIdentity, null);
  assert.doesNotMatch(JSON.stringify(event), new RegExp(marker, 'u'), 'trusted raw marker must never enter logs');
  const floor = await openSharedAuthorityFloor({
    root: fresh.floorRoot,
    protectedRoots: [fresh.canonicalRoot, fresh.environment.AUDIT_SHARED_BACKUP_ROOT, fresh.environment.AUDIT_SHARED_RESTORE_ROOT],
    verifyStorage: false,
  });
  assert.equal((await floor.read()).storeMarkerDigest, canonicalDigest({ storeMarker: marker }));

  const reopened = await initializeSharedAuthorityFloorFromEnvironment(fresh.environment);
  assert.equal(reopened.created, false);
  await unlink(path.join(fresh.floorRoot, 'authority-floor.json'));
  const recoveredFirstRevision = await initializeSharedAuthorityFloorFromEnvironment(fresh.environment);
  assert.equal(recoveredFirstRevision.created, true,
    'initialization must recover when revision one exists but the head write was interrupted');
  assert.equal((await floor.read()).revision, 1);
  const staleFloorSelectorFile = path.join(fresh.canonicalRoot, 'release-authority-selector.json');
  await writeFile(staleFloorSelectorFile, `${canonicalJson(seal({
    schemaVersion: 1,
    kind: 'release-authority-selector',
    phase: 'ACTIVE',
    activationEpoch: 1,
    activationRevision: 41,
    activeBuildIdentity: 'build:active-with-stale-floor',
  }))}\n`);
  await assert.rejects(
    initializeSharedAuthorityFloorFromEnvironment(fresh.environment),
    /reviewed bootstrap|active canonical authority/u,
  );
  await unlink(staleFloorSelectorFile);

  const wrongMarker = await fixture(base, 'wrong-marker');
  await initializeSharedAuthorityFloorFromEnvironment(wrongMarker.environment);
  await writeFile(wrongMarker.markerFile, `${'cd'.repeat(32)}\n`, { mode: 0o600 });
  await assert.rejects(
    initializeSharedAuthorityFloorFromEnvironment(wrongMarker.environment),
    /store marker/u,
  );

  const nested = await fixture(base, 'nested');
  await assert.rejects(initializeSharedAuthorityFloorFromEnvironment({
    ...nested.environment, AUDIT_SHARED_AUTHORITY_FLOOR_ROOT: path.join(nested.canonicalRoot, 'authority-floor'),
  }), /must not overlap/u);

  const activeSelector = await fixture(base, 'active-selector');
  const selector = seal({
    schemaVersion: 1,
    kind: 'release-authority-selector',
    phase: 'ACTIVE',
    activationEpoch: 1,
    activationRevision: 41,
    activeBuildIdentity: 'build:already-active',
  });
  await writeFile(
    path.join(activeSelector.canonicalRoot, 'release-authority-selector.json'),
    `${canonicalJson(selector)}\n`,
  );
  await assert.rejects(
    initializeSharedAuthorityFloorFromEnvironment(activeSelector.environment),
    /reviewed bootstrap|active canonical authority/u,
  );

  const activatedLegacy = await fixture(base, 'activated-legacy');
  await mkdir(path.join(activatedLegacy.canonicalRoot, 'legacy-authority'), { recursive: true });
  const legacyFence = seal({
    schemaVersion: 1,
    kind: 'legacy-release-authority-fence',
    state: 'ACTIVATED',
    revision: 4,
    cutoverId: 'cutover-existing',
    activationEpoch: 1,
    previousDigest: canonicalDigest({ previous: 'legacy' }),
    updatedAt: '2026-08-29T21:00:00.000Z',
  });
  await writeFile(
    path.join(activatedLegacy.canonicalRoot, 'legacy-authority', 'legacy-authority-fence.json'),
    `${canonicalJson(legacyFence)}\n`,
  );
  await assert.rejects(
    initializeSharedAuthorityFloorFromEnvironment(activatedLegacy.environment),
    /reviewed bootstrap|legacy authority is permanently retired/u,
  );

  const shadowSelector = await fixture(base, 'shadow-selector');
  await writeFile(path.join(shadowSelector.canonicalRoot, 'release-authority-selector.json'), `${canonicalJson(seal({
    schemaVersion: 1,
    kind: 'release-authority-selector',
    phase: 'SHADOW',
    activationEpoch: 0,
    activationRevision: null,
    activeBuildIdentity: null,
  }))}\n`);
  assert.equal(
    (await initializeSharedAuthorityFloorFromEnvironment(shadowSelector.environment)).created,
    true,
    'verified preactivation SHADOW may initialize the floor',
  );

  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const initScript = await readFile(new URL('../docker/init-single-site-volumes.sh', import.meta.url), 'utf8');
  function serviceBlock(name) {
    return compose.match(new RegExp(`\\n  ${name}:[\\s\\S]*?(?=\\n  [a-z][a-z0-9-]+:|\\nvolumes:)`, 'u'))?.[0] ?? '';
  }
  assert.match(serviceBlock('single-site-volume-init'), /shared-authority-floor:\/var\/lib\/ai-mobile-testing\/shared\/authority-floor(?!:ro)/u);
  assert.match(serviceBlock('single-site-volume-init'), /AUDIT_SHARED_AUTHORITY_FLOOR_ROOT: \/var\/lib\/ai-mobile-testing\/shared\/authority-floor/u);
  for (const service of ['portal', 'single-site-finalizer', 'audit-release', 'audit-release-merge']) {
    const block = serviceBlock(service);
    assert.match(block, /shared-authority-floor:\/var\/lib\/ai-mobile-testing\/shared\/authority-floor:ro/u, `${service} gets only read access to the external floor`);
    assert.match(block, /AUDIT_SHARED_AUTHORITY_FLOOR_ROOT: \/var\/lib\/ai-mobile-testing\/shared\/authority-floor/u);
  }
  const coordinator = serviceBlock('shared-coordinator');
  assert.match(coordinator, /shared-authority-floor:\/var\/lib\/ai-mobile-testing\/shared\/authority-floor(?!:ro)/u,
    'the singleton coordinator owns future monotonic authority-floor transitions');
  const proof = serviceBlock('shared-resilience-driver');
  assert.match(proof, /shared-authority-floor:\/var\/lib\/ai-mobile-testing\/shared\/authority-floor:ro/u);
  assert.match(initScript, /node scripts\/init-shared-authority-floor\.mjs/u);
  assert.match(compose, /\n  shared-authority-floor:\s*$/mu);
  assert.doesNotMatch(serviceBlock('shared-worker-ordinary-a'), /shared-authority-floor/u);
  assert.doesNotMatch(serviceBlock('shared-worker-ordinary-b'), /shared-authority-floor/u);
} finally {
  await rm(base, { recursive: true, force: true });
}

console.log('shared authority floor trusted init self-test passed');
