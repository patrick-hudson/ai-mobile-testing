import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalDigest } from '../shared/canonical-contract.mjs';
import { createParentRun, openParentRunStore } from './lib/parent-run-store.mjs';
import { createSharedStoreFilesystem } from './lib/shared-store-runtime.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-store-runtime-permissions-'));
const previousUmask = process.umask(0o027);
try {
  await chmod(root, 0o2770);
  const rootStat = await stat(root);
  const filesystem = createSharedStoreFilesystem({ root });
  const privateProbe = path.join(root, '.private-probe');
  await filesystem.mkdir(privateProbe, { mode: 0o700 });
  const privateHandle = await filesystem.open(path.join(privateProbe, 'private.json'), 'wx', 0o600);
  await privateHandle.close();
  assert.equal((await stat(privateProbe)).mode & 0o777, 0o700,
    'non-shared directories must retain their explicitly private mode');
  assert.equal((await stat(path.join(privateProbe, 'private.json'))).mode & 0o777, 0o600,
    'non-shared files must retain their explicitly private mode');
  const stableSharedDirectory = path.join(root, 'stable-shared-directory');
  await filesystem.mkdir(stableSharedDirectory, { recursive: true, mode: 0o2770 });
  const stableCtimeBefore = (await stat(stableSharedDirectory, { bigint: true })).ctimeNs;
  await filesystem.mkdir(stableSharedDirectory, { recursive: true, mode: 0o2770 });
  const stableCtimeAfter = (await stat(stableSharedDirectory, { bigint: true })).ctimeNs;
  assert.equal(stableCtimeAfter, stableCtimeBefore,
    'ensuring an already-correct shared directory must not mutate its ctime');
  await assert.rejects(
    filesystem.mkdir(path.join(root, '..', 'shared-store-runtime-escape'), { recursive: true, mode: 0o2770 }),
    /escaped its canonical root/u,
  );
  const store = await openParentRunStore({
    root,
    filesystem,
    deploymentIdentity: 'compose-project:portal-permission-proof',
    volumeIdentity: 'named-volume:portal-permission-proof',
    volumeDriver: 'local',
    clock: () => Date.parse('2026-08-30T00:00:00.000Z'),
    verifyStorage: false,
  });
  await createParentRun(store, {
    runId: 'run-portal-created',
    subjectCoreDigest: canonicalDigest({ fixture: 'portal-created-shared-run' }),
    workItems: [{ id: 'work-portal-created', maxAttempts: 1 }],
  });

  const sharedDirectories = [
    'runs',
    'runs/run-portal-created',
    'runs/run-portal-created/inboxes',
    'runs/run-portal-created/publications',
    'runs/run-portal-created/ledgers',
    'runs/run-portal-created/ledgers/decision',
    'runs/run-portal-created/ledgers/risk',
    'runs/run-portal-created/ledgers/mutation',
    'runs/run-portal-created/ledgers/operation',
  ];
  for (const relative of sharedDirectories) {
    const metadata = await stat(path.join(root, relative));
    assert.equal(metadata.mode & 0o7777, 0o2770,
      `${relative} must remain group-writable and setgid despite the portal's restrictive umask`);
    assert.equal(metadata.gid, rootStat.gid,
      `${relative} must inherit the canonical volume group used by the coordinator`);
  }

  const sharedFiles = [
    'store-manifest.json',
    'performance-scheduler.json',
    'release-authority-selector.json',
    'runs/run-portal-created/state.json',
    'runs/run-portal-created/ledgers/mutation/000000000001.json',
  ];
  for (const relative of sharedFiles) {
    const metadata = await stat(path.join(root, relative));
    assert.equal(metadata.mode & 0o777, 0o660,
      `${relative} must remain group-writable despite the portal's restrictive umask`);
    assert.equal(metadata.gid, rootStat.gid,
      `${relative} must inherit the canonical volume group used by the coordinator`);
  }
} finally {
  process.umask(previousUmask);
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('Shared-store runtime self-test passed: root-supervised portal writes preserve the canonical group-write and setgid contract under a restrictive umask.\n');
