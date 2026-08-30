import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  initializeLegacyAuthorityFence,
  openLegacyAuthorityFence,
  openLegacyAuthorityFenceFromEnvironment,
} from './lib/legacy-authority-fence.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-cutover-reopen-fence-'));
let now = Date.parse('2026-08-29T21:00:00.000Z');
const clock = () => now;

async function expectCode(code, operation) {
  await assert.rejects(operation, (error) => error?.code === code);
}

try {
  await expectCode('LEGACY_AUTHORITY_UNAVAILABLE', () => openLegacyAuthorityFenceFromEnvironment({}));
  await expectCode('LEGACY_AUTHORITY_INPUT_INVALID', () => openLegacyAuthorityFenceFromEnvironment({
    AUDIT_LEGACY_AUTHORITY_FENCE_ROOT: 'relative/fence',
  }));
  const fenceRoot = path.join(root, 'legacy-authority');
  const fence = await initializeLegacyAuthorityFence({ root: fenceRoot, verifyStorage: false, clock });
  assert.equal((await openLegacyAuthorityFenceFromEnvironment({
    AUDIT_LEGACY_AUTHORITY_FENCE_ROOT: fenceRoot,
  })).root, fence.root);
  assert.equal((await fence.read()).state, 'OPEN');

  let externalFloor = {
    activationEpoch: 0,
    legacyPermanentlyRetired: false,
    digest: '0'.repeat(64),
  };
  const floorGuard = { read: async () => structuredClone(externalFloor) };
  const externallyGuardedFence = await openLegacyAuthorityFence({
    root: fenceRoot, verifyStorage: false, clock, authorityFloor: floorGuard,
  });
  assert.equal(await externallyGuardedFence.withAuthority('single-site-launch', async () => 'accepted'), 'accepted');
  externalFloor = {
    activationEpoch: 1,
    legacyPermanentlyRetired: true,
    digest: '1'.repeat(64),
  };
  await expectCode('LEGACY_AUTHORITY_PERMANENTLY_RETIRED', () => externallyGuardedFence.withAuthority(
    'single-site-launch', async () => 'must-not-launch-after-floor-advance',
  ));
  await expectCode('LEGACY_AUTHORITY_PERMANENTLY_RETIRED', () => openLegacyAuthorityFence({
    root: fenceRoot, verifyStorage: false, clock, authorityFloor: floorGuard,
  }));
  externalFloor = {
    activationEpoch: 0,
    legacyPermanentlyRetired: false,
    digest: '0'.repeat(64),
  };

  let launchEntered;
  const entered = new Promise((resolve) => { launchEntered = resolve; });
  let finishLaunch;
  const finish = new Promise((resolve) => { finishLaunch = resolve; });
  const launch = fence.withAuthority('comparative-launch', async () => {
    launchEntered();
    await finish;
  });
  await entered;
  const beforeClose = await fence.read();
  let closeSettled = false;
  const closing = fence.close(beforeClose.digest, 'cutover-fence-test').then((value) => {
    closeSettled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false, 'cutover close must serialize with legacy launch acceptance');
  finishLaunch();
  await launch;
  const closed = await closing;
  assert.equal(closed.state, 'CLOSED');
  await fence.withAuthority('single-site-finalization', async () => 'drained-terminal-publication');
  await expectCode('LEGACY_AUTHORITY_FENCED', () => fence.withAuthority(
    'single-site-launch', async () => 'must-not-launch',
  ));

  const frozen = await fence.freeze(closed.digest, 'cutover-fence-test');
  await expectCode('LEGACY_AUTHORITY_FENCED', () => fence.withAuthority(
    'single-site-finalization', async () => 'must-not-publish',
  ));
  const activated = await fence.activate(frozen.digest, 'cutover-fence-test', 1);
  assert.equal(activated.state, 'ACTIVATED');
  await expectCode('LEGACY_AUTHORITY_PERMANENTLY_RETIRED', () => fence.reopenPreActivation(
    activated.digest, 'cutover-fence-test',
  ));
  const reopened = await openLegacyAuthorityFence({ root: fenceRoot, verifyStorage: false, clock });
  assert.equal((await reopened.read()).state, 'ACTIVATED', 'activation must survive process restart');
  await expectCode('LEGACY_AUTHORITY_FENCED', () => reopened.withAuthority(
    'comparative-finalization', async () => 'must-not-publish',
  ));

  await writeFile(path.join(fenceRoot, 'legacy-authority-fence.json'), '{"partial":true}\n');
  await expectCode('LEGACY_AUTHORITY_UNAVAILABLE', () => openLegacyAuthorityFence({
    root: fenceRoot, verifyStorage: false, clock,
  }));

  process.stdout.write('Shared cutover reopen/fence self-test passed.\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
