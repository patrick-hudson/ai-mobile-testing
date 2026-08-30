#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalDigest, isRecord } from '../shared/canonical-contract.mjs';
import {
  initializeSharedAuthorityFloor,
  openSharedAuthorityFloor,
} from './lib/shared-authority-floor.mjs';

const MARKER = /^[a-f0-9]{64}$/u;

function requiredAbsolute(environment, key) {
  const value = environment[key];
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path.`);
  }
  return path.resolve(value);
}

function positiveInteger(environment, key) {
  const value = environment[key];
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${key} must be a positive safe integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${key} must be a positive safe integer.`);
  return parsed;
}

function optionalAbsolute(environment, key, fallback) {
  const value = environment[key];
  if (value === undefined || value === '') return path.resolve(fallback);
  if (!path.isAbsolute(value)) throw new Error(`${key} must be an absolute path.`);
  return path.resolve(value);
}

function booleanFlag(environment, key, fallback) {
  const value = environment[key];
  if (value === undefined || value === '') return fallback;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${key} must be 0 or 1.`);
}

async function exists(file) {
  try {
    const metadata = await lstat(file);
    return metadata;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readBoundedRegularFile(file, label, maximumBytes = 64 * 1_024) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > maximumBytes) {
      throw new Error(`${label} must be a bounded regular file.`);
    }
    return await handle.readFile('utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`${label} must not be a symbolic link.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readTrustedMarker(file) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== 65 || (metadata.mode & 0o777) !== 0o600) {
      throw new Error('Trusted shared-store marker must be a regular mode-0600 64-byte marker file.');
    }
    const marker = (await handle.readFile('utf8')).trim();
    if (!MARKER.test(marker)) throw new Error('Trusted shared-store marker is invalid.');
    return marker;
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('Trusted shared-store marker must not be a symbolic link.');
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readSealedJsonIfPresent(file, label, expectedKind) {
  if (!await exists(file)) return null;
  let value;
  try {
    value = JSON.parse(await readBoundedRegularFile(file, label));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`);
    throw error;
  }
  if (!isRecord(value) || value.kind !== expectedKind || value.schemaVersion !== 1
    || typeof value.digest !== 'string') throw new Error(`${label} is corrupt or unsupported.`);
  const { digest, ...body } = value;
  if (digest !== canonicalDigest(body)) throw new Error(`${label} seal is invalid.`);
  return value;
}

async function inspectCanonicalAuthority(canonicalRoot) {
  const selector = await readSealedJsonIfPresent(
    path.join(canonicalRoot, 'release-authority-selector.json'),
    'Canonical release-authority selector',
    'release-authority-selector',
  );
  const legacyFence = await readSealedJsonIfPresent(
    path.join(canonicalRoot, 'legacy-authority', 'legacy-authority-fence.json'),
    'Legacy release-authority fence',
    'legacy-release-authority-fence',
  );
  const selectorIsSafePreactivation = selector === null
    || (selector.phase === 'SHADOW' && selector.activationEpoch === 0
      && selector.activationRevision === null && selector.activeBuildIdentity === null);
  if (!selectorIsSafePreactivation) {
    throw new Error('External authority floor is missing or preactivation while active canonical authority exists; an explicit reviewed bootstrap/migration is required.');
  }
  if (legacyFence?.state === 'ACTIVATED' || legacyFence?.activationEpoch === 1) {
    throw new Error('External authority floor is missing while legacy authority is permanently retired; an explicit reviewed bootstrap/migration is required.');
  }
  return { selector, legacyFence };
}

export async function initializeSharedAuthorityFloorFromEnvironment(environment) {
  const floorRoot = requiredAbsolute(environment, 'AUDIT_SHARED_AUTHORITY_FLOOR_ROOT');
  const canonicalRoot = requiredAbsolute(environment, 'AUDIT_SHARED_STORE_ROOT');
  const markerFile = requiredAbsolute(environment, 'AUDIT_SHARED_STORE_MARKER_FILE');
  const backupRoot = optionalAbsolute(
    environment, 'AUDIT_SHARED_BACKUP_ROOT', path.join(path.dirname(canonicalRoot), 'backups'),
  );
  const restoreRoot = optionalAbsolute(
    environment, 'AUDIT_SHARED_RESTORE_ROOT', path.join(path.dirname(canonicalRoot), 'restores'),
  );
  const storeGeneration = positiveInteger(environment, 'AUDIT_SHARED_STORE_GENERATION');
  const verifyStorage = booleanFlag(environment, 'AUDIT_SHARED_AUTHORITY_FLOOR_VERIFY_STORAGE', true);
  const marker = await readTrustedMarker(markerFile);
  const storeMarkerDigest = canonicalDigest({ storeMarker: marker });
  const headFile = path.join(floorRoot, 'authority-floor.json');
  const created = !await exists(headFile);
  const protectedRoots = [canonicalRoot, backupRoot, restoreRoot];

  let floor;
  if (created) {
    await inspectCanonicalAuthority(canonicalRoot);
    floor = await initializeSharedAuthorityFloor({
      root: floorRoot,
      protectedRoots,
      verifyStorage,
      initial: {
        storeMarkerDigest,
        minimumStoreGeneration: storeGeneration,
        minimumSelectorRevision: 1,
        activeBuildIdentity: null,
        authorityTransitionDigest: null,
        activationEpoch: 0,
        legacyPermanentlyRetired: false,
        activationRevision: null,
        activationCutoverDigest: null,
      },
    });
  } else {
    floor = await openSharedAuthorityFloor({ root: floorRoot, protectedRoots, verifyStorage });
  }
  const document = await floor.read();
  if (document.storeMarkerDigest !== storeMarkerDigest) {
    throw new Error('External authority floor store marker does not match the trusted deployment marker.');
  }
  if (document.minimumStoreGeneration < storeGeneration) {
    throw new Error('External authority floor is below the configured store generation; reviewed repair-forward is required.');
  }
  if (document.activationEpoch === 0) await inspectCanonicalAuthority(canonicalRoot);
  return Object.freeze({
    event: 'shared-authority-floor-ready',
    created,
    revision: document.revision,
    minimumStoreGeneration: document.minimumStoreGeneration,
    minimumSelectorRevision: document.minimumSelectorRevision,
    activationEpoch: document.activationEpoch,
    activeBuildIdentity: document.activeBuildIdentity,
    digest: document.digest,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(await initializeSharedAuthorityFloorFromEnvironment(process.env))}\n`);
  } catch (error) {
    process.stderr.write(`[SHARED_AUTHORITY_FLOOR_INIT] ${error?.message ?? String(error)}\n`);
    process.exitCode = 2;
  }
}
