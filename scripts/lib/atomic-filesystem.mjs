import { randomBytes } from 'node:crypto';
import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { canonicalJson } from '../../shared/canonical-contract.mjs';

const UNSUPPORTED_FILESYSTEM_TYPES = new Map([
  [0x6969n, 'NFS'], [0x517bn, 'SMB'], [0xff534d42n, 'CIFS'], [0xc36400n, 'Ceph'],
  [0x5346414fn, 'AFS'], [0x73757245n, 'Coda'], [0x564cn, 'NCP'], [0x1021997n, '9P'],
  [0xbd00bd0n, 'Lustre'], [0x47504653n, 'GPFS'],
]);

export class AtomicFilesystemError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AtomicFilesystemError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new AtomicFilesystemError(code, message, details);
}

export function containedPath(root, ...parts) {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, ...parts);
  if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${path.sep}`)) {
    fail('ATOMIC_PATH_ESCAPE', 'Filesystem path escaped its configured root.');
  }
  return candidate;
}

export async function pathExists(filesystem, candidate) {
  try {
    await filesystem.lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function fsyncDirectory(filesystem, directory) {
  let handle;
  try {
    handle = await filesystem.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    fail('ATOMIC_FSYNC_UNSUPPORTED', `Directory fsync failed for ${directory}.`, { cause: error?.code ?? String(error) });
  } finally {
    await handle?.close();
  }
}

export async function ensureDirectory(filesystem, directory, { mode = 0o2770 } = {}) {
  await filesystem.mkdir(directory, { recursive: true, mode });
  const stat = await filesystem.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ATOMIC_PATH_INVALID', `${directory} must be a real directory.`);
}

export async function atomicWriteJson(storage, file, value, { exclusive = false, mode = 0o660 } = {}) {
  const directory = path.dirname(file);
  await ensureDirectory(storage.fs, directory);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${storage.nonce()}.tmp`);
  let handle;
  try {
    handle = await storage.fs.open(temporary, 'wx', mode);
    await handle.writeFile(`${canonicalJson(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    if (exclusive) {
      try {
        // link(2) is a same-filesystem, atomic no-clobber publication. Unlike
        // rename(2), it cannot overwrite a concurrent immutable winner.
        await storage.fs.link(temporary, file);
      } catch (error) {
        if (error?.code === 'EEXIST') fail('ATOMIC_ALREADY_EXISTS', `${file} already exists.`);
        throw error;
      }
      await storage.fs.unlink(temporary);
    } else {
      await storage.fs.rename(temporary, file);
    }
    await fsyncDirectory(storage.fs, directory);
  } finally {
    await handle?.close();
    await storage.fs.rm(temporary, { force: true });
  }
}

export async function readBoundedJson(storage, file, { label = 'document', maximumBytes = 4 * 1_048_576 } = {}) {
  let stat;
  try {
    stat = await storage.fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('ATOMIC_NOT_FOUND', `${label} was not found.`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    fail('ATOMIC_CORRUPT', `${label} must be a bounded regular file.`);
  }
  try {
    return JSON.parse(await storage.fs.readFile(file, 'utf8'));
  } catch (error) {
    fail('ATOMIC_CORRUPT', `${label} is not valid JSON.`, { cause: error?.message });
  }
}

export async function withDirectoryLock(storage, lockPath, operation, {
  retries = 2_000, retryMs = 2,
} = {}) {
  await ensureDirectory(storage.fs, path.dirname(lockPath));
  let holder = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const child = spawn('flock', ['-n', lockPath, 'sh', '-c', 'printf "LOCKED\\n"; IFS= read -r _'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const acquired = await new Promise((resolve, reject) => {
      let output = '';
      child.once('error', reject);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString('utf8');
        if (output.includes('LOCKED\n')) resolve(true);
      });
      child.once('exit', (code) => resolve(code === 0 && output.includes('LOCKED\n')));
    });
    if (acquired) {
      holder = child;
      break;
    }
    if (attempt === retries) fail('ATOMIC_LOCK_TIMEOUT', `Timed out acquiring OS lock ${lockPath}.`);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  try {
    return await operation();
  } finally {
    if (holder) {
      const exited = new Promise((resolve) => holder.once('exit', resolve));
      holder.stdin.end('\n');
      await exited;
    }
  }
}

export async function verifyLocalAtomicStorage(storage) {
  const stat = await storage.fs.lstat(storage.root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ATOMIC_STORAGE_UNSUPPORTED', 'Storage root must be a real directory.');
  const stats = await storage.fs.statfs(storage.root, { bigint: true });
  const type = BigInt.asUintN(64, typeof stats.type === 'bigint' ? stats.type : BigInt(stats.type));
  const unsupported = UNSUPPORTED_FILESYSTEM_TYPES.get(type);
  if (unsupported) fail('ATOMIC_STORAGE_UNSUPPORTED', `${unsupported} does not provide the required Docker local-volume contract.`);
  const probe = path.join(storage.root, `.atomic-probe-${process.pid}-${storage.nonce()}`);
  await storage.fs.mkdir(probe, { mode: 0o700 });
  try {
    const lock = path.join(probe, 'claim');
    const claims = await Promise.allSettled(Array.from({ length: 4 }, () => storage.fs.mkdir(lock)));
    if (claims.filter(({ status }) => status === 'fulfilled').length !== 1) {
      fail('ATOMIC_STORAGE_UNSUPPORTED', 'Storage lacks exclusive mkdir semantics.');
    }
    const source = path.join(probe, 'source.json');
    const destination = path.join(probe, 'destination.json');
    await atomicWriteJson(storage, source, { probe: true });
    await storage.fs.rename(source, destination);
    await fsyncDirectory(storage.fs, probe);
    if ((await readBoundedJson(storage, destination)).probe !== true) {
      fail('ATOMIC_STORAGE_UNSUPPORTED', 'Storage lacks atomic rename visibility.');
    }
  } finally {
    await storage.fs.rm(probe, { recursive: true, force: true });
    await fsyncDirectory(storage.fs, storage.root);
  }
  return { filesystemType: `0x${type.toString(16)}`, atomicMkdir: true, atomicRename: true, fsync: true };
}

export async function openAtomicStorage({ root, filesystem = nativeFs, nonce = () => randomBytes(8).toString('hex'), verify = true }) {
  const absoluteRoot = path.resolve(root);
  const storage = Object.freeze({ root: absoluteRoot, fs: filesystem, nonce });
  await ensureDirectory(filesystem, absoluteRoot);
  const semantics = verify ? await verifyLocalAtomicStorage(storage) : null;
  return Object.freeze({ ...storage, semantics });
}
