import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { canonicalDigest, canonicalJson } from '../shared/canonical-contract.mjs';
import {
  parseSharedStoreBackupRehearsalReceipt,
  rehearseSharedStoreBackup,
  verifySharedStoreBackupRehearsal,
} from './lib/shared-store-backup-rehearsal.mjs';

const marker = 'ab'.repeat(32);
const backupMarker = 'cd'.repeat(32);
const buildIdentity = 'build:backup-rehearsal-test';
const configurationDigest = canonicalDigest({ fixture: 'backup-rehearsal-configuration' });
const deploymentIdentity = 'compose-project:backup-rehearsal-test';
const volumeIdentity = 'named-volume:backup-rehearsal-test';

function seal(body) {
  return { ...body, digest: canonicalDigest(body) };
}

function storeDocuments({ active = false } = {}) {
  const activationRevision = active ? 41 : null;
  const activationCutoverDigest = active ? canonicalDigest({ cutover: 'backup-rehearsal-active' }) : null;
  const authorityTransitionDigest = active ? canonicalDigest({ transition: 'backup-rehearsal-active' }) : null;
  const manifest = seal({
    schemaVersion: 2,
    kind: 'durable-parent-run-store',
    deploymentIdentity,
    volumeIdentity,
    volumeDriver: 'local',
    storeMarkerDigest: canonicalDigest({ storeMarker: marker }),
    storeGeneration: 7,
    schemaFloor: 2,
    currentWriterProtocol: 'single-coordinator-global-performance-v2',
    minimumWriterProtocol: 'single-coordinator-global-performance-v2',
    coordinatorEpoch: 11,
    activationEpoch: active ? 1 : 0,
    activationRevision,
    createdAt: '2026-08-29T18:00:00.000Z',
    cutoverRevision: 41,
    backupMarker,
    prequalifiedRollbackBuilds: [buildIdentity],
  });
  const selector = seal({
    schemaVersion: 1,
    kind: 'release-authority-selector',
    storeMarkerDigest: manifest.storeMarkerDigest,
    storeGeneration: manifest.storeGeneration,
    phase: active ? 'ACTIVE' : 'DRAINING',
    activationEpoch: active ? 1 : 0,
    activationRevision,
    activatedAt: active ? '2026-08-29T18:05:00.000Z' : null,
    activeWriterProtocol: active ? manifest.currentWriterProtocol : null,
    minimumWriterProtocol: manifest.minimumWriterProtocol,
    activeBuildIdentity: active ? buildIdentity : null,
    authorityTransitionDigest,
    activationCutoverDigest,
    backupMarker,
    prequalifiedRollbackBuilds: [buildIdentity],
    revision: 3,
    previousDigest: canonicalDigest({ selector: 'shadow' }),
    updatedAt: '2026-08-29T18:10:00.000Z',
  });
  return { manifest, selector };
}

function expectedStore(manifest) {
  return {
    deploymentIdentity,
    volumeIdentity,
    storeMarkerDigest: manifest.storeMarkerDigest,
    storeGeneration: 7,
    schemaVersion: 2,
    schemaFloor: 2,
    currentWriterProtocol: 'single-coordinator-global-performance-v2',
    minimumWriterProtocol: 'single-coordinator-global-performance-v2',
    backupMarker,
  };
}

async function createFixture(base, name = 'store', documents = storeDocuments()) {
  const sourceRoot = path.join(base, name);
  const { manifest, selector } = documents;
  await mkdir(path.join(sourceRoot, 'runs', 'run-001', 'evidence', 'empty'), { recursive: true });
  await writeFile(path.join(sourceRoot, '.coordinator-mutation-lock'), '');
  await writeFile(path.join(sourceRoot, 'store-manifest.json'), `${canonicalJson(manifest)}\n`);
  await writeFile(path.join(sourceRoot, 'release-authority-selector.json'), `${canonicalJson(selector)}\n`);
  await writeFile(path.join(sourceRoot, 'runs', 'run-001', 'state.json'), `${canonicalJson({ schemaVersion: 1, state: 'sealed' })}\n`);
  await writeFile(path.join(sourceRoot, 'runs', 'run-001', 'evidence', 'capture.bin'), Buffer.from([0, 1, 2, 3, 255]));
  return { sourceRoot, manifest, selector };
}

function paths(base, suffix) {
  return {
    backupRoot: path.join(base, `backup-${suffix}`),
    restoreRoot: path.join(base, `restore-${suffix}`),
    receiptPath: path.join(base, `receipt-${suffix}.json`),
  };
}

function options(fixture, destinations, suffix = 'happy') {
  return {
    rehearsalId: `backup-rehearsal-${suffix}`,
    sourceRoot: fixture.sourceRoot,
    ...destinations,
    storeMarker: marker,
    backupMarker,
    buildIdentity,
    configurationDigest,
    expectedStore: expectedStore(fixture.manifest),
    clock: (() => {
      let now = Date.parse('2026-08-29T19:00:00.000Z');
      return () => (now += 1_000);
    })(),
    limits: { maximumEntries: 64, maximumFileBytes: 1_048_576, maximumTotalBytes: 4_194_304 },
  };
}

const root = await mkdtemp(path.join(tmpdir(), 'shared-store-backup-rehearsal-'));
try {
  const fixture = await createFixture(root, 'happy-store');
  const destinations = paths(root, 'happy');
  const receipt = await rehearseSharedStoreBackup(options(fixture, destinations));
  assert.equal(receipt.kind, 'shared-store-backup-rehearsal-receipt');
  assert.equal(receipt.sourceSnapshot.digest, receipt.backupSnapshot.digest);
  assert.equal(receipt.sourceSnapshot.digest, receipt.restoreSnapshot.digest);
  assert.equal(receipt.sourceSnapshot.fileCount, 5);
  assert.equal(receipt.sourceSnapshot.directoryCount, 4);
  assert.equal(receipt.sourceSnapshot.rootMode, receipt.restoreSnapshot.rootMode);
  assert.equal(receipt.storeMarkerDigest, fixture.manifest.storeMarkerDigest);
  assert.equal(receipt.manifestDigest, fixture.manifest.digest);
  assert.equal(receipt.selectorDigest, fixture.selector.digest);
  assert.equal(receipt.expectedStoreDigest, canonicalDigest(expectedStore(fixture.manifest)));
  assert.equal(receipt.buildIdentity, buildIdentity);
  assert.equal(receipt.configurationDigest, configurationDigest);
  assert.deepEqual(
    await readFile(path.join(destinations.restoreRoot, 'runs', 'run-001', 'evidence', 'capture.bin')),
    Buffer.from([0, 1, 2, 3, 255]),
  );

  const persisted = JSON.parse(await readFile(destinations.receiptPath, 'utf8'));
  assert.deepEqual(persisted, receipt, 'The fsync-backed receipt must be the returned sealed receipt.');
  assert.equal(parseSharedStoreBackupRehearsalReceipt(receipt, {
    expectedStore: expectedStore(fixture.manifest),
    buildIdentity,
    configurationDigest,
    backupMarker,
  }).digest, receipt.digest);
  assert.equal((await verifySharedStoreBackupRehearsal({
    receipt,
    backupRoot: destinations.backupRoot,
    restoreRoot: destinations.restoreRoot,
    expectedStore: expectedStore(fixture.manifest),
    buildIdentity,
    configurationDigest,
    backupMarker,
    limits: options(fixture, destinations).limits,
  })).digest, receipt.digest);

  const activeFixture = await createFixture(root, 'active-store', storeDocuments({ active: true }));
  const activeDestinations = paths(root, 'active');
  const activeReceipt = await rehearseSharedStoreBackup(options(activeFixture, activeDestinations, 'active'));
  assert.equal(activeReceipt.activationEpoch, 1,
    'post-activation handoff backups must preserve activated authority');
  assert.equal(activeReceipt.selectorDigest, activeFixture.selector.digest,
    'the backup receipt must bind the selector carrying cutover and transition identities');
  const tamperedActiveSelector = structuredClone(activeFixture.selector);
  tamperedActiveSelector.authorityTransitionDigest = canonicalDigest({ transition: 'tampered' });
  await writeFile(
    path.join(activeFixture.sourceRoot, 'release-authority-selector.json'),
    `${canonicalJson(tamperedActiveSelector)}\n`,
  );
  await assert.rejects(
    rehearseSharedStoreBackup(options(activeFixture, paths(root, 'active-tampered'), 'active-tampered')),
    (error) => error?.code === 'BACKUP_BINDING_MISMATCH',
    'tampering with the selector transition identity must invalidate backup qualification',
  );

  const tamperedReceipt = structuredClone(receipt);
  tamperedReceipt.configurationDigest = canonicalDigest({ fixture: 'tampered' });
  assert.throws(
    () => parseSharedStoreBackupRehearsalReceipt(tamperedReceipt),
    (error) => error?.code === 'BACKUP_RECEIPT_INVALID',
    'Receipt tampering must fail its seal.',
  );
  assert.throws(
    () => parseSharedStoreBackupRehearsalReceipt(receipt, { buildIdentity: 'build:stale' }),
    (error) => error?.code === 'BACKUP_BINDING_MISMATCH',
    'A receipt from another build must not qualify cutover.',
  );
  assert.throws(
    () => parseSharedStoreBackupRehearsalReceipt(receipt, {
      configurationDigest: canonicalDigest({ fixture: 'stale-configuration' }),
    }),
    (error) => error?.code === 'BACKUP_BINDING_MISMATCH',
    'A receipt for another cutover configuration must not qualify.',
  );
  assert.throws(
    () => parseSharedStoreBackupRehearsalReceipt(receipt, {
      notBefore: '2026-08-29T19:00:03.000Z',
    }),
    (error) => error?.code === 'BACKUP_BINDING_MISMATCH',
    'A rehearsal predating the required drain boundary must not qualify.',
  );
  assert.throws(
    () => parseSharedStoreBackupRehearsalReceipt(receipt, {
      maximumAgeMs: 1_000,
      now: Date.parse('2026-08-29T19:00:04.000Z'),
    }),
    (error) => error?.code === 'BACKUP_BINDING_MISMATCH',
    'An expired rehearsal receipt must not qualify.',
  );
  assert.throws(
    () => parseSharedStoreBackupRehearsalReceipt(receipt, {
      expectedStore: { ...expectedStore(fixture.manifest), storeGeneration: 6 },
    }),
    (error) => error?.code === 'BACKUP_BINDING_MISMATCH',
    'A restored-stale generation must not qualify cutover.',
  );
  assert.throws(
    () => parseSharedStoreBackupRehearsalReceipt({ backupMarker }),
    (error) => error?.code === 'BACKUP_RECEIPT_INVALID',
    'A marker-only claim is not a rehearsal receipt.',
  );

  await writeFile(path.join(destinations.backupRoot, 'runs', 'run-001', 'state.json'), '{}\n');
  await assert.rejects(
    verifySharedStoreBackupRehearsal({ receipt, backupRoot: destinations.backupRoot, restoreRoot: destinations.restoreRoot }),
    (error) => error?.code === 'BACKUP_SNAPSHOT_MISMATCH',
    'Backup bytes changed after rehearsal must invalidate live verification.',
  );

  const incompleteFixture = await createFixture(root, 'incomplete-store');
  const incompleteDestinations = paths(root, 'incomplete');
  const incompleteReceipt = await rehearseSharedStoreBackup(options(incompleteFixture, incompleteDestinations, 'incomplete'));
  await unlink(path.join(incompleteDestinations.restoreRoot, 'runs', 'run-001', 'state.json'));
  await assert.rejects(
    verifySharedStoreBackupRehearsal({
      receipt: incompleteReceipt,
      backupRoot: incompleteDestinations.backupRoot,
      restoreRoot: incompleteDestinations.restoreRoot,
    }),
    (error) => error?.code === 'BACKUP_SNAPSHOT_MISMATCH',
    'An incomplete restore must fail verification.',
  );

  const wrongMarkerFixture = await createFixture(root, 'wrong-marker-store');
  await assert.rejects(
    rehearseSharedStoreBackup({
      ...options(wrongMarkerFixture, paths(root, 'wrong-marker'), 'wrong-marker'),
      storeMarker: 'ef'.repeat(32),
    }),
    (error) => error?.code === 'BACKUP_BINDING_MISMATCH',
    'The trusted external store marker must match the canonical manifest.',
  );

  const symlinkFixture = await createFixture(root, 'symlink-store');
  await symlink('state.json', path.join(symlinkFixture.sourceRoot, 'runs', 'run-001', 'state-link.json'));
  await assert.rejects(
    rehearseSharedStoreBackup(options(symlinkFixture, paths(root, 'symlink'), 'symlink')),
    (error) => error?.code === 'BACKUP_UNSUPPORTED_ENTRY',
    'Symlinks must never be followed into a store backup.',
  );

  const hardlinkFixture = await createFixture(root, 'hardlink-store');
  await link(
    path.join(hardlinkFixture.sourceRoot, 'runs', 'run-001', 'state.json'),
    path.join(hardlinkFixture.sourceRoot, 'runs', 'run-001', 'state-hardlink.json'),
  );
  await assert.rejects(
    rehearseSharedStoreBackup(options(hardlinkFixture, paths(root, 'hardlink'), 'hardlink')),
    (error) => error?.code === 'BACKUP_UNSUPPORTED_ENTRY',
    'Hard-linked store files must be rejected instead of silently changing shape.',
  );

  const traversalFixture = await createFixture(root, 'traversal-store');
  await writeFile(path.join(traversalFixture.sourceRoot, 'runs', 'bad\\portable-path'), 'bad');
  await assert.rejects(
    rehearseSharedStoreBackup(options(traversalFixture, paths(root, 'traversal'), 'traversal')),
    (error) => error?.code === 'BACKUP_PATH_INVALID',
    'Non-portable or traversal-capable entry names must be rejected.',
  );

  const overlapFixture = await createFixture(root, 'overlap-store');
  await assert.rejects(
    rehearseSharedStoreBackup(options(overlapFixture, {
      backupRoot: path.join(overlapFixture.sourceRoot, 'backup'),
      restoreRoot: path.join(root, 'overlap-restore'),
      receiptPath: path.join(root, 'overlap-receipt.json'),
    }, 'overlap')),
    (error) => error?.code === 'BACKUP_PATH_NOT_ISOLATED',
    'Backup and restore workspaces must be isolated from the canonical store.',
  );

  process.stdout.write('Shared-store backup rehearsal self-test passed: real quiesced copy/restore, identity binding, durable receipt sealing, tamper detection, and unsupported filesystem shapes fail closed.\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
