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
