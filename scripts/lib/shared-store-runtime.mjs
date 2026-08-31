import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { openSharedAuthorityFloor } from './shared-authority-floor.mjs';

const HEX_MARKER = /^[a-f0-9]{64}$/;

export async function readTrustedStoreMarker(file, label = 'shared store marker') {
  if (typeof file !== 'string' || !file) throw new Error(`${label} file is required.`);
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 64 || stat.size > 65) throw new Error(`${label} must be a bounded regular file.`);
    const value = (await handle.readFile('utf8')).trim();
    if (!HEX_MARKER.test(value)) throw new Error(`${label} must contain 32 random bytes encoded as lowercase hex.`);
    return value;
  } finally {
    await handle?.close();
  }
}

export function sharedStoreBuildIdentity(environment = process.env) {
  const value = environment.AUDIT_SHARED_BUILD_IDENTITY ?? `build:${environment.AUDIT_IMAGE_TAG ?? 'local'}`;
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0')) {
    throw new Error('AUDIT_SHARED_BUILD_IDENTITY is invalid.');
  }
  return value;
}

export function sharedStoreRollbackBuilds(environment = process.env, buildIdentity = sharedStoreBuildIdentity(environment)) {
  const values = String(environment.AUDIT_SHARED_PREQUALIFIED_ROLLBACK_BUILDS ?? buildIdentity)
    .split(',').map((entry) => entry.trim()).filter(Boolean);
  if (values.length < 1 || values.length > 16 || values.some((entry) => entry.length > 256 || entry.includes('\0'))) {
    throw new Error('AUDIT_SHARED_PREQUALIFIED_ROLLBACK_BUILDS is invalid.');
  }
  return [...new Set(values)].sort();
}

export function sharedStoreGeneration(environment = process.env) {
  const value = Number(environment.AUDIT_SHARED_STORE_GENERATION ?? 1);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('AUDIT_SHARED_STORE_GENERATION is invalid.');
  return value;
}

function requiredAbsolute(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return value;
}

function optionalAbsolute(environment, name, fallback) {
  const value = environment[name] ?? fallback;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return value;
}

const SHARED_STORE_DIRECTORY_MODE = 0o2770;
const SHARED_STORE_FILE_MODE = 0o660;

function contained(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function createSharedStoreFilesystem({ root, filesystem = fs } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('Shared-store filesystem root must be an absolute path.');
  }
  const absoluteRoot = path.resolve(root);
  const sharedPath = (candidate) => {
    if (typeof candidate !== 'string') throw new Error('Shared-store filesystem paths must be strings.');
    const absolute = path.resolve(candidate);
    if (!contained(absoluteRoot, absolute)) throw new Error('Shared-store filesystem path escaped its canonical root.');
    return absolute;
  };
  const enforceDirectoryMode = async (candidate, mode) => {
    const handle = await filesystem.open(
      candidate,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      let metadata = await handle.stat();
      if (!metadata.isDirectory()) throw new Error('Shared-store directory mode target is not a directory.');
      if ((metadata.mode & 0o7777) !== mode) {
        await handle.chmod(mode);
        metadata = await handle.stat();
      }
      if ((metadata.mode & 0o7777) !== mode) {
        throw new Error('Shared-store directory does not retain the required cross-identity mode.');
      }
    } finally {
      await handle.close();
    }
  };
  const createdDirectoryChain = (created, target) => {
    if (typeof created !== 'string') return [target];
    const first = sharedPath(created);
    if (!contained(first, target)) throw new Error('Shared-store recursive mkdir returned an invalid created path.');
    const candidates = [];
    let current = target;
    while (true) {
      candidates.push(current);
      if (current === first) break;
      const parent = path.dirname(current);
      if (parent === current || !contained(first, parent)) {
        throw new Error('Shared-store recursive mkdir escaped its created directory chain.');
      }
      current = parent;
    }
    return candidates.reverse();
  };
  const mkdir = async (candidate, options) => {
    const absolute = sharedPath(candidate);
    const created = await filesystem.mkdir(absolute, options);
    if ((Number(options?.mode) & 0o7777) === SHARED_STORE_DIRECTORY_MODE) {
      for (const directory of createdDirectoryChain(created, absolute)) {
        await enforceDirectoryMode(directory, SHARED_STORE_DIRECTORY_MODE);
      }
    }
    return created;
  };
  const open = async (candidate, flags, mode) => {
    const sharedCreation = (Number(mode) & 0o777) === SHARED_STORE_FILE_MODE;
    const target = sharedCreation ? sharedPath(candidate) : candidate;
    const handle = await filesystem.open(target, flags, mode);
    if (sharedCreation) {
      try {
        await handle.chmod(SHARED_STORE_FILE_MODE);
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    }
    return handle;
  };
  return Object.freeze({ ...filesystem, mkdir, open });
}

export async function openSharedRuntimeAuthorityFloor(environment = process.env, options = {}) {
  const canonicalRoot = requiredAbsolute(environment, 'AUDIT_SHARED_STORE_ROOT');
  const floorRoot = requiredAbsolute(environment, 'AUDIT_SHARED_AUTHORITY_FLOOR_ROOT');
  const sharedRoot = path.dirname(canonicalRoot);
  const backupRoot = optionalAbsolute(environment, 'AUDIT_SHARED_BACKUP_ROOT', path.join(sharedRoot, 'backups'));
  const restoreRoot = optionalAbsolute(environment, 'AUDIT_SHARED_RESTORE_ROOT', path.join(sharedRoot, 'restores'));
  return openSharedAuthorityFloor({
    root: floorRoot,
    protectedRoots: [canonicalRoot, backupRoot, restoreRoot],
    filesystem: options.filesystem,
    verifyStorage: options.verifyStorage ?? false,
  });
}
