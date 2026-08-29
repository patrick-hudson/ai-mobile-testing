import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import {
  canonicalDigest,
  canonicalJson,
  freezeContract,
  isRecord,
} from '../../shared/canonical-contract.mjs';
import { atomicWriteJson, fsyncDirectory, withDirectoryLock } from './atomic-filesystem.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TRUSTED_MARKER = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/u;
const RECEIPT_KIND = 'shared-store-backup-rehearsal-receipt';
const DEFAULT_LIMITS = Object.freeze({
  maximumEntries: 100_000,
  maximumFileBytes: 2 * 1_024 * 1_024 * 1_024,
  maximumTotalBytes: 16 * 1_024 * 1_024 * 1_024,
});
const MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'deploymentIdentity', 'volumeIdentity', 'volumeDriver',
  'storeMarkerDigest', 'storeGeneration', 'schemaFloor', 'currentWriterProtocol',
  'minimumWriterProtocol', 'coordinatorEpoch', 'activationEpoch', 'activationRevision',
  'createdAt', 'cutoverRevision', 'backupMarker', 'prequalifiedRollbackBuilds', 'digest',
]);
const SELECTOR_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'storeMarkerDigest', 'storeGeneration', 'phase',
  'activationEpoch', 'activationRevision', 'activatedAt', 'activeWriterProtocol',
  'minimumWriterProtocol', 'activeBuildIdentity', 'backupMarker',
  'prequalifiedRollbackBuilds', 'revision', 'previousDigest', 'updatedAt', 'digest',
]);
const EXPECTED_STORE_KEYS = Object.freeze([
  'deploymentIdentity', 'volumeIdentity', 'storeMarkerDigest', 'storeGeneration',
  'schemaVersion', 'schemaFloor', 'currentWriterProtocol', 'minimumWriterProtocol',
  'backupMarker',
]);
const SNAPSHOT_KEYS = Object.freeze([
  'rootMode', 'rootUid', 'rootGid', 'entryCount', 'fileCount', 'directoryCount',
  'totalBytes', 'entriesDigest', 'digest',
]);
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'rehearsalId', 'startedAt', 'completedAt', 'buildIdentity',
  'configurationDigest', 'expectedStoreDigest', 'manifestDigest', 'selectorDigest',
  'storeMarkerDigest', 'backupMarkerDigest', 'storeGeneration', 'storeSchemaVersion',
  'schemaFloor', 'writerProtocol', 'minimumWriterProtocol', 'activationEpoch',
  'activationRevision', 'cutoverRevision', 'sourceSnapshot', 'backupSnapshot',
  'restoreSnapshot', 'verification', 'digest',
]);
const VERIFICATION_KEYS = Object.freeze([
  'copyMode', 'sourceQuiesced', 'backupMatchesSource', 'restoreMatchesSource',
  'unsupportedEntriesRejected', 'isolatedPaths',
]);

export class SharedStoreBackupRehearsalError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SharedStoreBackupRehearsalError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new SharedStoreBackupRehearsalError(code, message, details);
}

function exactKeys(value, keys, label, code = 'BACKUP_RECEIPT_INVALID') {
  if (!isRecord(value) || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(code, `${label} has an invalid schema.`);
  }
}

function nonEmptyString(value, label, maximum = 512, code = 'BACKUP_BINDING_INVALID') {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0
    || value.length > maximum || value.includes('\0')) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function digest(value, label, code = 'BACKUP_BINDING_INVALID') {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(code, `${label} is invalid.`);
  return value;
}

function canonicalTimestamp(value, label, code = 'BACKUP_RECEIPT_INVALID') {
  if (typeof value !== 'string') fail(code, `${label} is invalid.`);
  try {
    if (new Date(value).toISOString() !== value) fail(code, `${label} is invalid.`);
  } catch (error) {
    if (error instanceof SharedStoreBackupRehearsalError) throw error;
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function normalizeLimits(value = {}) {
  if (!isRecord(value)) fail('BACKUP_LIMIT_INVALID', 'Backup limits must be an object.');
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(DEFAULT_LIMITS, key));
  if (unknown.length > 0) fail('BACKUP_LIMIT_INVALID', `Unsupported backup limits: ${unknown.sort().join(', ')}.`);
  const limits = { ...DEFAULT_LIMITS, ...value };
  for (const [key, limit] of Object.entries(limits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) fail('BACKUP_LIMIT_INVALID', `${key} must be a positive safe integer.`);
  }
  if (limits.maximumFileBytes > limits.maximumTotalBytes) {
    fail('BACKUP_LIMIT_INVALID', 'maximumFileBytes cannot exceed maximumTotalBytes.');
  }
  return Object.freeze(limits);
}

function normalizeExpectedStore(value) {
  exactKeys(value, EXPECTED_STORE_KEYS, 'Expected store', 'BACKUP_BINDING_INVALID');
  const normalized = {
    deploymentIdentity: nonEmptyString(value.deploymentIdentity, 'expectedStore.deploymentIdentity'),
    volumeIdentity: nonEmptyString(value.volumeIdentity, 'expectedStore.volumeIdentity'),
    storeMarkerDigest: digest(value.storeMarkerDigest, 'expectedStore.storeMarkerDigest'),
    storeGeneration: value.storeGeneration,
    schemaVersion: value.schemaVersion,
    schemaFloor: value.schemaFloor,
    currentWriterProtocol: nonEmptyString(value.currentWriterProtocol, 'expectedStore.currentWriterProtocol'),
    minimumWriterProtocol: nonEmptyString(value.minimumWriterProtocol, 'expectedStore.minimumWriterProtocol'),
    backupMarker: nonEmptyString(value.backupMarker, 'expectedStore.backupMarker'),
  };
  if (!Number.isSafeInteger(normalized.storeGeneration) || normalized.storeGeneration < 1
    || !Number.isSafeInteger(normalized.schemaVersion) || normalized.schemaVersion < 1
    || !Number.isSafeInteger(normalized.schemaFloor) || normalized.schemaFloor < 1) {
    fail('BACKUP_BINDING_INVALID', 'Expected store generation and schema versions must be positive safe integers.');
  }
  return Object.freeze(normalized);
}

function manifestBody(value) {
  const { digest: ignored, ...body } = value;
  return body;
}

function validateManifest(value, expectedStore, { storeMarker, backupMarker, buildIdentity }) {
  exactKeys(value, MANIFEST_KEYS, 'Store manifest', 'BACKUP_STORE_INVALID');
  const body = manifestBody(value);
  if (value.schemaVersion !== expectedStore.schemaVersion || value.kind !== 'durable-parent-run-store'
    || value.deploymentIdentity !== expectedStore.deploymentIdentity
    || value.volumeIdentity !== expectedStore.volumeIdentity || value.volumeDriver !== 'local'
    || value.storeMarkerDigest !== expectedStore.storeMarkerDigest
    || value.storeGeneration !== expectedStore.storeGeneration || value.schemaFloor !== expectedStore.schemaFloor
    || value.currentWriterProtocol !== expectedStore.currentWriterProtocol
    || value.minimumWriterProtocol !== expectedStore.minimumWriterProtocol
    || !Number.isSafeInteger(value.coordinatorEpoch) || value.coordinatorEpoch < 0
    || ![0, 1].includes(value.activationEpoch)
    || (value.activationRevision !== null && (!Number.isSafeInteger(value.activationRevision) || value.activationRevision < 1))
    || (value.activationEpoch === 0 && value.activationRevision !== null)
    || (value.activationEpoch === 1 && value.activationRevision === null)
    || !Number.isSafeInteger(value.cutoverRevision) || value.cutoverRevision < 0
    || value.backupMarker !== expectedStore.backupMarker || value.backupMarker !== backupMarker
    || !Array.isArray(value.prequalifiedRollbackBuilds) || value.prequalifiedRollbackBuilds.length < 1
    || value.prequalifiedRollbackBuilds.some((entry) => typeof entry !== 'string' || !entry)
    || new Set(value.prequalifiedRollbackBuilds).size !== value.prequalifiedRollbackBuilds.length
    || !value.prequalifiedRollbackBuilds.includes(buildIdentity)
    || value.digest !== canonicalDigest(body)) {
    fail('BACKUP_BINDING_MISMATCH', 'Canonical store manifest does not match the expected cutover identity.');
  }
  canonicalTimestamp(value.createdAt, 'store manifest createdAt', 'BACKUP_STORE_INVALID');
  if (canonicalDigest({ storeMarker }) !== value.storeMarkerDigest) {
    fail('BACKUP_BINDING_MISMATCH', 'Trusted external store marker does not match the canonical store manifest.');
  }
  return value;
}

function selectorBody(value) {
  const { digest: ignored, ...body } = value;
  return body;
}

function validateSelector(value, manifest) {
  exactKeys(value, SELECTOR_KEYS, 'Release-authority selector', 'BACKUP_STORE_INVALID');
  const body = selectorBody(value);
  if (value.schemaVersion !== 1 || value.kind !== 'release-authority-selector'
    || value.storeMarkerDigest !== manifest.storeMarkerDigest
    || value.storeGeneration !== manifest.storeGeneration
    || !['SHADOW', 'DRAINING', 'ACTIVE', 'PROMOTION_DISABLED'].includes(value.phase)
    || value.activationEpoch !== manifest.activationEpoch || value.activationRevision !== manifest.activationRevision
    || value.minimumWriterProtocol !== manifest.minimumWriterProtocol
    || value.backupMarker !== manifest.backupMarker
    || canonicalJson(value.prequalifiedRollbackBuilds) !== canonicalJson(manifest.prequalifiedRollbackBuilds)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.previousDigest !== null && !DIGEST.test(value.previousDigest))
    || value.digest !== canonicalDigest(body)) {
    fail('BACKUP_BINDING_MISMATCH', 'Release-authority selector does not match the canonical store manifest.');
  }
  canonicalTimestamp(value.updatedAt, 'release-authority selector updatedAt', 'BACKUP_STORE_INVALID');
  const active = ['ACTIVE', 'PROMOTION_DISABLED'].includes(value.phase);
  if ((active && (value.activationEpoch !== 1 || value.activationRevision === null
    || value.activatedAt === null || value.activeWriterProtocol !== manifest.currentWriterProtocol
    || typeof value.activeBuildIdentity !== 'string' || value.activeBuildIdentity.length === 0))
    || (!active && (value.activationEpoch !== 0 || value.activationRevision !== null
      || value.activatedAt !== null || value.activeWriterProtocol !== null || value.activeBuildIdentity !== null))) {
    fail('BACKUP_BINDING_MISMATCH', 'Release-authority selector activation fields are inconsistent.');
  }
  if (value.activatedAt !== null) canonicalTimestamp(value.activatedAt, 'release-authority selector activatedAt', 'BACKUP_STORE_INVALID');
  return value;
}

async function readJsonNoFollow(file, label, maximumBytes = 1_048_576) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > maximumBytes) {
      fail('BACKUP_STORE_INVALID', `${label} must be a bounded regular file.`);
    }
    try {
      return JSON.parse(await handle.readFile('utf8'));
    } catch (error) {
      fail('BACKUP_STORE_INVALID', `${label} is not valid JSON.`, { cause: error?.message });
    }
  } catch (error) {
    if (error?.code === 'ELOOP') fail('BACKUP_UNSUPPORTED_ENTRY', `${label} must not be a symbolic link.`);
    if (error?.code === 'ENOENT') fail('BACKUP_STORE_INVALID', `${label} is missing.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096
    || value.includes('\\') || value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value)
    || path.posix.isAbsolute(value)) {
    fail('BACKUP_PATH_INVALID', 'Store entry path is invalid or non-portable.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    fail('BACKUP_PATH_INVALID', 'Store entry path may not traverse outside its root.');
  }
  return value;
}

async function hashOpenFile(handle, maximumFileBytes) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(128 * 1_024);
  let total = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximumFileBytes) fail('BACKUP_LIMIT_EXCEEDED', 'Store file exceeds the configured byte bound.');
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { sizeBytes: total, contentDigest: `sha256:${hash.digest('hex')}` };
}

async function inspectRegularFile(file, relativePath, limits) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      fail('BACKUP_UNSUPPORTED_ENTRY', `Store file ${relativePath} is not an independent regular file.`);
    }
    if (before.size > BigInt(limits.maximumFileBytes)) {
      fail('BACKUP_LIMIT_EXCEEDED', `Store file ${relativePath} exceeds the configured byte bound.`);
    }
    const hashed = await hashOpenFile(handle, limits.maximumFileBytes);
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || BigInt(hashed.sizeBytes) !== after.size) {
      fail('BACKUP_SOURCE_CHANGED', `Store file ${relativePath} changed while it was inspected.`);
    }
    return {
      path: relativePath,
      type: 'file',
      mode: Number(after.mode & 0o7777n),
      uid: Number(after.uid),
      gid: Number(after.gid),
      sizeBytes: hashed.sizeBytes,
      contentDigest: hashed.contentDigest,
    };
  } catch (error) {
    if (error?.code === 'ELOOP') fail('BACKUP_UNSUPPORTED_ENTRY', `Store file ${relativePath} is a symbolic link.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function sealSnapshot(entries, rootIdentity) {
  const fileEntries = entries.filter(({ type }) => type === 'file');
  const directoryEntries = entries.filter(({ type }) => type === 'directory');
  const body = {
    rootMode: rootIdentity.mode,
    rootUid: rootIdentity.uid,
    rootGid: rootIdentity.gid,
    entryCount: entries.length,
    fileCount: fileEntries.length,
    directoryCount: directoryEntries.length,
    totalBytes: fileEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    entriesDigest: canonicalDigest(entries),
  };
  return Object.freeze({ ...body, digest: canonicalDigest(body) });
}

async function inspectTree(root, limits) {
  const rootStat = await fs.lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('BACKUP_UNSUPPORTED_ENTRY', 'Snapshot root must be a real directory.');
  }
  const entries = [];
  async function visit(directory, relativeDirectory = '') {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = safeRelativePath(relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name);
      const candidate = path.join(directory, child.name);
      const metadata = await fs.lstat(candidate, { bigint: true });
      if (metadata.isSymbolicLink()) fail('BACKUP_UNSUPPORTED_ENTRY', `Store entry ${relativePath} is a symbolic link.`);
      if (metadata.isDirectory()) {
        entries.push({
          path: relativePath,
          type: 'directory',
          mode: Number(metadata.mode & 0o7777n),
          uid: Number(metadata.uid),
          gid: Number(metadata.gid),
        });
        if (entries.length > limits.maximumEntries) fail('BACKUP_LIMIT_EXCEEDED', 'Store exceeds the configured entry bound.');
        await visit(candidate, relativePath);
      } else if (metadata.isFile()) {
        entries.push(await inspectRegularFile(candidate, relativePath, limits));
        if (entries.length > limits.maximumEntries) fail('BACKUP_LIMIT_EXCEEDED', 'Store exceeds the configured entry bound.');
      } else {
        fail('BACKUP_UNSUPPORTED_ENTRY', `Store entry ${relativePath} has an unsupported filesystem shape.`);
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const snapshot = sealSnapshot(entries, {
    mode: Number(rootStat.mode & 0o7777n),
    uid: Number(rootStat.uid),
    gid: Number(rootStat.gid),
  });
  if (snapshot.totalBytes > limits.maximumTotalBytes) fail('BACKUP_LIMIT_EXCEEDED', 'Store exceeds the configured total byte bound.');
  return { entries, snapshot };
}

async function copyFile(source, destination, expected) {
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await fs.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const sourceStat = await sourceHandle.stat({ bigint: true });
    if (!sourceStat.isFile() || sourceStat.nlink !== 1n || Number(sourceStat.mode & 0o7777n) !== expected.mode
      || sourceStat.size !== BigInt(expected.sizeBytes)) {
      fail('BACKUP_SOURCE_CHANGED', `Store file ${expected.path} changed before it could be copied.`);
    }
    destinationHandle = await fs.open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, expected.mode);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(128 * 1_024);
    let total = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const bytes = buffer.subarray(0, bytesRead);
      await destinationHandle.write(bytes);
      hash.update(bytes);
      total += bytesRead;
    }
    const contentDigest = `sha256:${hash.digest('hex')}`;
    if (total !== expected.sizeBytes || contentDigest !== expected.contentDigest) {
      fail('BACKUP_SOURCE_CHANGED', `Store file ${expected.path} changed while it was copied.`);
    }
    const after = await sourceHandle.stat({ bigint: true });
    if (after.dev !== sourceStat.dev || after.ino !== sourceStat.ino || after.size !== sourceStat.size
      || after.mtimeNs !== sourceStat.mtimeNs || after.ctimeNs !== sourceStat.ctimeNs) {
      fail('BACKUP_SOURCE_CHANGED', `Store file ${expected.path} changed while it was copied.`);
    }
    await destinationHandle.chmod(expected.mode);
    await destinationHandle.sync();
  } finally {
    await sourceHandle?.close();
    await destinationHandle?.close();
  }
}

async function copySnapshot(sourceRoot, destinationRoot, entries, rootMode) {
  await fs.chmod(destinationRoot, rootMode);
  const directories = entries.filter(({ type }) => type === 'directory');
  for (const entry of directories) {
    const destination = path.join(destinationRoot, ...entry.path.split('/'));
    await fs.mkdir(destination, { mode: entry.mode });
    await fs.chmod(destination, entry.mode);
  }
  for (const entry of entries.filter(({ type }) => type === 'file')) {
    await copyFile(
      path.join(sourceRoot, ...entry.path.split('/')),
      path.join(destinationRoot, ...entry.path.split('/')),
      entry,
    );
  }
  for (const entry of [...directories].sort((left, right) => right.path.split('/').length - left.path.split('/').length)) {
    await fsyncDirectory(fs, path.join(destinationRoot, ...entry.path.split('/')));
  }
  await fsyncDirectory(fs, destinationRoot);
}

function snapshotsEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

async function requireRealDirectory(candidate, label) {
  const resolved = path.resolve(candidate);
  let real;
  try {
    real = await fs.realpath(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('BACKUP_PATH_INVALID', `${label} does not exist.`);
    throw error;
  }
  const stat = await fs.lstat(resolved);
  if (real !== resolved || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail('BACKUP_PATH_INVALID', `${label} must be a real directory without symbolic-link traversal.`);
  }
  return resolved;
}

async function requireAbsentDestination(candidate, label) {
  const resolved = path.resolve(candidate);
  const parent = await requireRealDirectory(path.dirname(resolved), `${label} parent`);
  if (path.dirname(resolved) !== parent) fail('BACKUP_PATH_INVALID', `${label} parent is invalid.`);
  try {
    await fs.lstat(resolved);
    fail('BACKUP_PATH_INVALID', `${label} must not already exist.`);
  } catch (error) {
    if (error instanceof SharedStoreBackupRehearsalError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  return resolved;
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function requireIsolated(paths) {
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const left = paths[leftIndex];
      const right = paths[rightIndex];
      if (overlaps(left.path, right.path) || overlaps(right.path, left.path)) {
        fail('BACKUP_PATH_NOT_ISOLATED', `${left.label} and ${right.label} must be isolated paths.`);
      }
    }
  }
}

function parseSnapshot(value, label) {
  exactKeys(value, SNAPSHOT_KEYS, label);
  const body = {
    rootMode: value.rootMode,
    rootUid: value.rootUid,
    rootGid: value.rootGid,
    entryCount: value.entryCount,
    fileCount: value.fileCount,
    directoryCount: value.directoryCount,
    totalBytes: value.totalBytes,
    entriesDigest: value.entriesDigest,
  };
  if (!Number.isSafeInteger(body.rootMode) || body.rootMode < 0 || body.rootMode > 0o7777
    || !Number.isSafeInteger(body.rootUid) || body.rootUid < 0
    || !Number.isSafeInteger(body.rootGid) || body.rootGid < 0
    || ![body.entryCount, body.fileCount, body.directoryCount, body.totalBytes]
    .every((entry) => Number.isSafeInteger(entry) && entry >= 0)
    || body.entryCount !== body.fileCount + body.directoryCount || body.fileCount < 2
    || body.totalBytes < 1 || !DIGEST.test(body.entriesDigest)
    || value.digest !== canonicalDigest(body)) {
    fail('BACKUP_RECEIPT_INVALID', `${label} is invalid.`);
  }
  return Object.freeze({ ...body, digest: value.digest });
}

function receiptBody(value) {
  const { digest: ignored, ...body } = value;
  return body;
}

export function parseSharedStoreBackupRehearsalReceipt(value, expected = {}) {
  exactKeys(value, RECEIPT_KEYS, 'Backup rehearsal receipt');
  if (value.schemaVersion !== 1 || value.kind !== RECEIPT_KIND || !SAFE_ID.test(value.rehearsalId ?? '')
    || nonEmptyString(value.buildIdentity, 'receipt.buildIdentity', 256, 'BACKUP_RECEIPT_INVALID') !== value.buildIdentity
    || !DIGEST.test(value.configurationDigest) || !DIGEST.test(value.expectedStoreDigest)
    || !DIGEST.test(value.manifestDigest) || !DIGEST.test(value.selectorDigest)
    || !DIGEST.test(value.storeMarkerDigest) || !DIGEST.test(value.backupMarkerDigest)
    || !Number.isSafeInteger(value.storeGeneration) || value.storeGeneration < 1
    || !Number.isSafeInteger(value.storeSchemaVersion) || value.storeSchemaVersion < 1
    || !Number.isSafeInteger(value.schemaFloor) || value.schemaFloor < 1
    || typeof value.writerProtocol !== 'string' || !value.writerProtocol
    || typeof value.minimumWriterProtocol !== 'string' || !value.minimumWriterProtocol
    || ![0, 1].includes(value.activationEpoch)
    || (value.activationRevision !== null && (!Number.isSafeInteger(value.activationRevision) || value.activationRevision < 1))
    || (value.activationEpoch === 0 && value.activationRevision !== null)
    || (value.activationEpoch === 1 && value.activationRevision === null)
    || !Number.isSafeInteger(value.cutoverRevision) || value.cutoverRevision < 0) {
    fail('BACKUP_RECEIPT_INVALID', 'Backup rehearsal receipt identity is invalid.');
  }
  canonicalTimestamp(value.startedAt, 'receipt.startedAt');
  canonicalTimestamp(value.completedAt, 'receipt.completedAt');
  if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
    fail('BACKUP_RECEIPT_INVALID', 'Backup rehearsal completedAt predates startedAt.');
  }
  const sourceSnapshot = parseSnapshot(value.sourceSnapshot, 'Source snapshot');
  const backupSnapshot = parseSnapshot(value.backupSnapshot, 'Backup snapshot');
  const restoreSnapshot = parseSnapshot(value.restoreSnapshot, 'Restore snapshot');
  if (!snapshotsEqual(sourceSnapshot, backupSnapshot) || !snapshotsEqual(sourceSnapshot, restoreSnapshot)) {
    fail('BACKUP_RECEIPT_INVALID', 'Backup and restore snapshots do not exactly match the canonical source snapshot.');
  }
  exactKeys(value.verification, VERIFICATION_KEYS, 'Backup verification');
  if (value.verification.copyMode !== 'quiesced-byte-for-byte'
    || value.verification.sourceQuiesced !== true || value.verification.backupMatchesSource !== true
    || value.verification.restoreMatchesSource !== true || value.verification.unsupportedEntriesRejected !== true
    || value.verification.isolatedPaths !== true) {
    fail('BACKUP_RECEIPT_INVALID', 'Backup rehearsal verification is incomplete.');
  }
  if (value.digest !== canonicalDigest(receiptBody(value))) {
    fail('BACKUP_RECEIPT_INVALID', 'Backup rehearsal receipt seal is invalid.');
  }

  if (expected.expectedStore !== undefined) {
    const normalized = normalizeExpectedStore(expected.expectedStore);
    if (value.expectedStoreDigest !== canonicalDigest(normalized)
      || value.storeMarkerDigest !== normalized.storeMarkerDigest
      || value.storeGeneration !== normalized.storeGeneration
      || value.storeSchemaVersion !== normalized.schemaVersion
      || value.schemaFloor !== normalized.schemaFloor
      || value.writerProtocol !== normalized.currentWriterProtocol
      || value.minimumWriterProtocol !== normalized.minimumWriterProtocol) {
      fail('BACKUP_BINDING_MISMATCH', 'Backup receipt does not match the expected canonical store identity.');
    }
  }
  if (expected.buildIdentity !== undefined && value.buildIdentity !== expected.buildIdentity) {
    fail('BACKUP_BINDING_MISMATCH', 'Backup receipt build identity is stale or mismatched.');
  }
  if (expected.configurationDigest !== undefined && value.configurationDigest !== expected.configurationDigest) {
    fail('BACKUP_BINDING_MISMATCH', 'Backup receipt cutover configuration is stale or mismatched.');
  }
  if (expected.backupMarker !== undefined
    && value.backupMarkerDigest !== canonicalDigest({ backupMarker: expected.backupMarker })) {
    fail('BACKUP_BINDING_MISMATCH', 'Backup receipt trusted backup marker is stale or mismatched.');
  }
  if (expected.manifestDigest !== undefined && value.manifestDigest !== expected.manifestDigest) {
    fail('BACKUP_BINDING_MISMATCH', 'Backup receipt store manifest is stale or mismatched.');
  }
  if (expected.selectorDigest !== undefined && value.selectorDigest !== expected.selectorDigest) {
    fail('BACKUP_BINDING_MISMATCH', 'Backup receipt authority selector is stale or mismatched.');
  }
  if (expected.notBefore !== undefined) {
    const notBefore = canonicalTimestamp(expected.notBefore, 'expected.notBefore', 'BACKUP_BINDING_INVALID');
    if (Date.parse(value.completedAt) < Date.parse(notBefore)) {
      fail('BACKUP_BINDING_MISMATCH', 'Backup receipt predates the required rehearsal boundary.');
    }
  }
  if (expected.maximumAgeMs !== undefined) {
    if (!Number.isSafeInteger(expected.maximumAgeMs) || expected.maximumAgeMs < 0) {
      fail('BACKUP_BINDING_INVALID', 'expected.maximumAgeMs is invalid.');
    }
    const now = expected.now ?? Date.now();
    if (!Number.isFinite(now) || now - Date.parse(value.completedAt) > expected.maximumAgeMs
      || Date.parse(value.completedAt) > now) {
      fail('BACKUP_BINDING_MISMATCH', 'Backup receipt is stale or from the future.');
    }
  }
  return freezeContract(structuredClone(value));
}

export async function rehearseSharedStoreBackup(options = {}) {
  if (!SAFE_ID.test(options.rehearsalId ?? '')) fail('BACKUP_BINDING_INVALID', 'rehearsalId is invalid.');
  const storeMarker = options.storeMarker;
  const backupMarker = options.backupMarker;
  if (typeof storeMarker !== 'string' || !TRUSTED_MARKER.test(storeMarker)
    || typeof backupMarker !== 'string' || !TRUSTED_MARKER.test(backupMarker)) {
    fail('BACKUP_BINDING_INVALID', 'Trusted store and backup markers must be 32 random bytes encoded as lowercase hex.');
  }
  const buildIdentity = nonEmptyString(options.buildIdentity, 'buildIdentity', 256);
  const configurationDigest = digest(options.configurationDigest, 'configurationDigest');
  const expectedStore = normalizeExpectedStore(options.expectedStore);
  if (expectedStore.backupMarker !== backupMarker) {
    fail('BACKUP_BINDING_MISMATCH', 'Expected store backup marker does not match the trusted external backup marker.');
  }
  const limits = normalizeLimits(options.limits);
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') fail('BACKUP_BINDING_INVALID', 'clock must be a function.');

  const sourceRoot = await requireRealDirectory(options.sourceRoot, 'sourceRoot');
  const backupRoot = await requireAbsentDestination(options.backupRoot, 'backupRoot');
  const restoreRoot = await requireAbsentDestination(options.restoreRoot, 'restoreRoot');
  const receiptPath = await requireAbsentDestination(options.receiptPath, 'receiptPath');
  requireIsolated([
    { label: 'sourceRoot', path: sourceRoot },
    { label: 'backupRoot', path: backupRoot },
    { label: 'restoreRoot', path: restoreRoot },
    { label: 'receiptPath', path: receiptPath },
  ]);

  const lockPath = path.join(sourceRoot, '.coordinator-mutation-lock');
  const lockStat = await fs.lstat(lockPath).catch((error) => {
    if (error?.code === 'ENOENT') fail('BACKUP_QUIESCE_UNAVAILABLE', 'Canonical coordinator mutation lock is missing.');
    throw error;
  });
  if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
    fail('BACKUP_QUIESCE_UNAVAILABLE', 'Canonical coordinator mutation lock must be a regular file.');
  }

  let backupCreated = false;
  let restoreCreated = false;
  let receiptCreated = false;
  const startedAt = new Date(clock()).toISOString();
  try {
    await fs.mkdir(backupRoot, { mode: 0o700 });
    backupCreated = true;
    await fs.mkdir(restoreRoot, { mode: 0o700 });
    restoreCreated = true;
    const storage = { root: sourceRoot, fs, nonce: () => `${process.pid}-${Date.now()}` };
    const result = await withDirectoryLock(storage, lockPath, async () => {
      const manifest = validateManifest(
        await readJsonNoFollow(path.join(sourceRoot, 'store-manifest.json'), 'store manifest'),
        expectedStore,
        { storeMarker, backupMarker, buildIdentity },
      );
      const selector = validateSelector(
        await readJsonNoFollow(path.join(sourceRoot, 'release-authority-selector.json'), 'release-authority selector'),
        manifest,
      );
      const source = await inspectTree(sourceRoot, limits);
      await copySnapshot(sourceRoot, backupRoot, source.entries, source.snapshot.rootMode);
      const backup = await inspectTree(backupRoot, limits);
      if (!snapshotsEqual(source.snapshot, backup.snapshot)) {
        fail('BACKUP_SNAPSHOT_MISMATCH', 'Backup snapshot does not exactly match the canonical source snapshot.');
      }
      await copySnapshot(backupRoot, restoreRoot, backup.entries, backup.snapshot.rootMode);
      const restored = await inspectTree(restoreRoot, limits);
      if (!snapshotsEqual(source.snapshot, restored.snapshot)) {
        fail('BACKUP_SNAPSHOT_MISMATCH', 'Restored snapshot does not exactly match the canonical source snapshot.');
      }
      const sourceAfter = await inspectTree(sourceRoot, limits);
      if (!snapshotsEqual(source.snapshot, sourceAfter.snapshot)) {
        fail('BACKUP_SOURCE_CHANGED', 'Canonical source changed during the quiesced backup rehearsal.');
      }
      const manifestAfter = await readJsonNoFollow(path.join(sourceRoot, 'store-manifest.json'), 'store manifest');
      const selectorAfter = await readJsonNoFollow(path.join(sourceRoot, 'release-authority-selector.json'), 'release-authority selector');
      if (manifestAfter.digest !== manifest.digest || selectorAfter.digest !== selector.digest) {
        fail('BACKUP_SOURCE_CHANGED', 'Canonical store identity changed during the backup rehearsal.');
      }
      return { manifest, selector, source: source.snapshot, backup: backup.snapshot, restored: restored.snapshot };
    });

    const completedAt = new Date(clock()).toISOString();
    const body = {
      schemaVersion: 1,
      kind: RECEIPT_KIND,
      rehearsalId: options.rehearsalId,
      startedAt,
      completedAt,
      buildIdentity,
      configurationDigest,
      expectedStoreDigest: canonicalDigest(expectedStore),
      manifestDigest: result.manifest.digest,
      selectorDigest: result.selector.digest,
      storeMarkerDigest: result.manifest.storeMarkerDigest,
      backupMarkerDigest: canonicalDigest({ backupMarker }),
      storeGeneration: result.manifest.storeGeneration,
      storeSchemaVersion: result.manifest.schemaVersion,
      schemaFloor: result.manifest.schemaFloor,
      writerProtocol: result.manifest.currentWriterProtocol,
      minimumWriterProtocol: result.manifest.minimumWriterProtocol,
      activationEpoch: result.manifest.activationEpoch,
      activationRevision: result.manifest.activationRevision,
      cutoverRevision: result.manifest.cutoverRevision,
      sourceSnapshot: result.source,
      backupSnapshot: result.backup,
      restoreSnapshot: result.restored,
      verification: {
        copyMode: 'quiesced-byte-for-byte',
        sourceQuiesced: true,
        backupMatchesSource: true,
        restoreMatchesSource: true,
        unsupportedEntriesRejected: true,
        isolatedPaths: true,
      },
    };
    const receipt = parseSharedStoreBackupRehearsalReceipt({ ...body, digest: canonicalDigest(body) }, {
      expectedStore,
      buildIdentity,
      configurationDigest,
      backupMarker,
      manifestDigest: result.manifest.digest,
      selectorDigest: result.selector.digest,
    });
    await atomicWriteJson(
      { fs, nonce: () => `${process.pid}-${Date.now()}` },
      receiptPath,
      receipt,
      { exclusive: true, mode: 0o600 },
    );
    receiptCreated = true;
    const persisted = await readJsonNoFollow(receiptPath, 'backup rehearsal receipt');
    if (canonicalJson(persisted) !== canonicalJson(receipt)) {
      fail('BACKUP_RECEIPT_INVALID', 'Persisted backup rehearsal receipt does not match its durable write.');
    }
    return receipt;
  } catch (error) {
    if (receiptCreated) await fs.rm(receiptPath, { force: true });
    if (backupCreated) await fs.rm(backupRoot, { recursive: true, force: true });
    if (restoreCreated) await fs.rm(restoreRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function verifySharedStoreBackupRehearsal(options = {}) {
  const expected = {};
  for (const key of [
    'expectedStore', 'buildIdentity', 'configurationDigest', 'backupMarker', 'manifestDigest',
    'selectorDigest', 'notBefore', 'maximumAgeMs', 'now',
  ]) {
    if (options[key] !== undefined) expected[key] = options[key];
  }
  const receipt = parseSharedStoreBackupRehearsalReceipt(options.receipt, expected);
  const limits = normalizeLimits(options.limits);
  const backupRoot = await requireRealDirectory(options.backupRoot, 'backupRoot');
  const restoreRoot = await requireRealDirectory(options.restoreRoot, 'restoreRoot');
  requireIsolated([
    { label: 'backupRoot', path: backupRoot },
    { label: 'restoreRoot', path: restoreRoot },
  ]);
  const backup = (await inspectTree(backupRoot, limits)).snapshot;
  const restored = (await inspectTree(restoreRoot, limits)).snapshot;
  if (!snapshotsEqual(backup, receipt.backupSnapshot) || !snapshotsEqual(restored, receipt.restoreSnapshot)
    || !snapshotsEqual(backup, restored)) {
    fail('BACKUP_SNAPSHOT_MISMATCH', 'Live backup or restored content no longer matches the sealed rehearsal receipt.');
  }
  return receipt;
}
