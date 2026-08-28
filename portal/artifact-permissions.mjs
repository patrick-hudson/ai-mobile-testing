import { isAbsolute, join, relative, sep } from 'node:path';

export const PORTABLE_SEALED_DIRECTORY_MODE = 0o550;
export const PORTABLE_SEALED_FILE_MODE = 0o440;
export const PORTABLE_SUPERVISOR_DIRECTORY_MODE = 0o750;
export const PORTABLE_SUPERVISOR_FILE_MODE = 0o640;

export function ownershipTransitionUnavailable(error) {
  return error?.code === 'EPERM'
    || error?.code === 'EACCES'
    || error?.code === 'ENOSYS'
    || error?.code === 'ENOTSUP'
    || error?.code === 'EOPNOTSUPP';
}

export async function prepareRunnerArtifactDirectory(fsOperations, directory, identity) {
  if (!identity.active) return 'portal-process';
  const details = await fsOperations.lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('The artifact run path must be a real directory.');
  }
  if (details.uid === identity.uid && details.gid === identity.gid) {
    await fsOperations.chmod(directory, 0o770);
    return 'owner-group';
  }
  try {
    await fsOperations.chown(directory, identity.uid, identity.gid);
    await fsOperations.chmod(directory, 0o770);
    return 'owner-group';
  } catch (error) {
    if (!ownershipTransitionUnavailable(error)) throw error;
    const current = await fsOperations.lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.gid !== identity.gid) {
      throw new Error(
        `Artifact storage cannot be delegated safely to ${identity.user ?? 'the Playwright runner'}: `
        + 'ownership changes are unavailable and the bind mount does not use the isolated worker group. '
        + 'Use the Docker-managed artifact volume or a host directory owned by the configured portal runner group.',
        { cause: error },
      );
    }
    // A same-group bind mount (notably Docker Desktop) needs no world-write
    // escape hatch. All pipeline identities share this isolated artifact group.
    await fsOperations.chmod(directory, 0o770);
    return 'portable-bind';
  }
}

export async function withPortableArtifactWriteWindow(
  fsOperations,
  root,
  {
    active,
    writablePaths = [],
    recursiveWritablePaths = [],
    sealPaths = [],
    removeSealSymlinks = false,
  },
  operation,
) {
  if (!active) return operation();
  const writable = uniqueContainedPaths(root, writablePaths);
  const recursiveWritable = uniqueContainedPaths(root, recursiveWritablePaths);
  const seal = uniqueContainedPaths(root, sealPaths);
  let operationError;
  let result;
  await assertRealDirectory(fsOperations, root, 'Portable artifact root');
  await fsOperations.chmod(root, PORTABLE_SUPERVISOR_DIRECTORY_MODE);
  try {
    for (const path of writable) await makeExistingPathSupervisorWritable(fsOperations, path);
    for (const path of recursiveWritable) await makeExistingPathSupervisorWritable(fsOperations, path, true);
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  let sealingError;
  try {
    for (const path of seal) await sealExistingPortablePath(fsOperations, path, true, { removeSymlinks: removeSealSymlinks });
    for (const path of [...recursiveWritable].reverse()) {
      await sealExistingPortablePath(fsOperations, path, true, { removeSymlinks: removeSealSymlinks });
    }
    for (const path of [...writable].reverse()) await sealExistingPortablePath(fsOperations, path, false);
  } catch (error) {
    sealingError = error;
  }
  try {
    await fsOperations.chmod(root, PORTABLE_SEALED_DIRECTORY_MODE);
  } catch (error) {
    sealingError ??= error;
  }
  if (operationError && sealingError) {
    throw new AggregateError([operationError, sealingError], 'Artifact mutation failed and the portable bind mount could not be resealed.');
  }
  if (sealingError) throw sealingError;
  if (operationError) throw operationError;
  return result;
}

export async function sealExistingPortablePath(
  fsOperations,
  path,
  recursive = true,
  { removeSymlinks = false } = {},
) {
  let details;
  try {
    details = await fsOperations.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
    throw error;
  }
  if (details.isSymbolicLink()) {
    if (removeSymlinks) {
      await fsOperations.unlink(path);
      return;
    }
    throw new Error(`Portable artifact sealing rejected a symbolic link: ${path}`);
  }
  if (details.isDirectory()) {
    if (recursive) {
      const entries = await fsOperations.readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        await sealExistingPortablePath(fsOperations, join(path, entry.name), true, { removeSymlinks });
      }
    }
    await fsOperations.chmod(path, PORTABLE_SEALED_DIRECTORY_MODE);
    return;
  }
  if (!details.isFile()) throw new Error(`Portable artifact sealing rejected a non-regular entry: ${path}`);
  if (details.nlink > 1) throw new Error(`Portable artifact sealing rejected a hard-linked file: ${path}`);
  await fsOperations.chmod(path, PORTABLE_SEALED_FILE_MODE);
}

export async function removeValidatedArtifactTree(fsOperations, root, removeOptions = {}) {
  await validateArtifactTreeForDeletion(fsOperations, root, true);
  let removalError;
  try {
    // Recursive removal needs write permission on every containing directory,
    // not on the files themselves. Leaving files untouched means a hard-linked
    // file is unlinked locally without chmod mutating the inode retained by an
    // outside reference. Symbolic links are never followed.
    await makeArtifactDirectoriesDeletable(fsOperations, root, true);
    await fsOperations.rm(root, {
      recursive: true,
      force: false,
      maxRetries: 2,
      retryDelay: 100,
      ...removeOptions,
    });
    return;
  } catch (error) {
    removalError = error;
  }

  let resealError;
  try {
    await resealRemainingArtifactDirectories(fsOperations, root);
  } catch (error) {
    resealError = error;
  }
  if (resealError) {
    throw new AggregateError(
      [removalError, resealError],
      'Artifact deletion failed and its remaining directory tree could not be resealed.',
    );
  }
  throw removalError;
}

async function validateArtifactTreeForDeletion(fsOperations, path, root = false) {
  const details = await fsOperations.lstat(path);
  if (details.isSymbolicLink()) {
    if (root) throw new Error('Artifact deletion root must be a real directory.');
    return;
  }
  if (root && !details.isDirectory()) throw new Error('Artifact deletion root must be a real directory.');
  if (details.isDirectory()) {
    const entries = await fsOperations.readdir(path, { withFileTypes: true });
    for (const entry of entries) await validateArtifactTreeForDeletion(fsOperations, join(path, entry.name));
    return;
  }
  if (!details.isFile()) throw new Error(`Artifact deletion rejected a non-regular entry: ${path}`);
}

async function makeArtifactDirectoriesDeletable(fsOperations, path, root = false) {
  const details = await fsOperations.lstat(path);
  if (details.isSymbolicLink()) {
    if (root) throw new Error('Artifact deletion root became a symbolic link.');
    return;
  }
  if (!details.isDirectory()) {
    if (!details.isFile()) throw new Error(`Artifact deletion rejected a non-regular entry: ${path}`);
    return;
  }
  const entries = await fsOperations.readdir(path, { withFileTypes: true });
  for (const entry of entries) await makeArtifactDirectoriesDeletable(fsOperations, join(path, entry.name));
  await fsOperations.chmod(path, PORTABLE_SUPERVISOR_DIRECTORY_MODE);
}

async function resealRemainingArtifactDirectories(fsOperations, path) {
  let details;
  try {
    details = await fsOperations.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory()) return;
  const entries = await fsOperations.readdir(path, { withFileTypes: true });
  for (const entry of entries) await resealRemainingArtifactDirectories(fsOperations, join(path, entry.name));
  await fsOperations.chmod(path, PORTABLE_SEALED_DIRECTORY_MODE);
}

async function makeExistingPathSupervisorWritable(fsOperations, path, recursive = false, nested = false) {
  let details;
  try {
    details = await fsOperations.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
    throw error;
  }
  if (details.isSymbolicLink()) {
    if (recursive && nested) return;
    throw new Error(`Portable artifact mutation rejected a symbolic link: ${path}`);
  }
  if (details.isDirectory()) {
    if (recursive) {
      const entries = await fsOperations.readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        await makeExistingPathSupervisorWritable(fsOperations, join(path, entry.name), true, true);
      }
    }
    await fsOperations.chmod(path, PORTABLE_SUPERVISOR_DIRECTORY_MODE);
    return;
  }
  if (!details.isFile() || details.nlink > 1) {
    throw new Error(`Portable artifact mutation rejected an unsafe entry: ${path}`);
  }
  await fsOperations.chmod(path, PORTABLE_SUPERVISOR_FILE_MODE);
}

async function assertRealDirectory(fsOperations, path, label) {
  const details = await fsOperations.lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

function uniqueContainedPaths(root, paths) {
  const unique = new Set();
  for (const path of paths) {
    const candidate = relative(root, path);
    if (candidate === '' || candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
      throw new Error(`Artifact permission path escapes its run root: ${path}`);
    }
    unique.add(path);
  }
  return [...unique].sort((left, right) => left.length - right.length || left.localeCompare(right));
}
