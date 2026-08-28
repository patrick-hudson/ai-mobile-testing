import { isAbsolute, relative, resolve, sep } from 'node:path';

export async function assertNoNestedMountPoints(fsOperations, root, mountInfoPath = '/proc/self/mountinfo') {
  const realRoot = await fsOperations.realpath(root);
  let source;
  try {
    source = await fsOperations.readFile(mountInfoPath, 'utf8');
  } catch (error) {
    const unavailable = new Error('Purge refused because this platform cannot prove that the run contains no nested mount points.', { cause: error });
    unavailable.code = 'MOUNT_BOUNDARY_UNAVAILABLE';
    throw unavailable;
  }
  for (const mountPoint of parseMountInfoMountPoints(source)) {
    const candidate = relative(realRoot, resolve(mountPoint));
    if (candidate === '' || (candidate !== '..' && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate))) {
      const error = new Error(`Purge refused because the run contains mounted filesystem content at ${mountPoint}.`);
      error.code = 'NESTED_MOUNT_POINT';
      throw error;
    }
  }
}

export function parseMountInfoMountPoints(source) {
  const mounts = [];
  for (const line of String(source).split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split(' ');
    if (fields.length < 6 || !fields.includes('-')) continue;
    mounts.push(decodeMountInfoPath(fields[4]));
  }
  return mounts;
}

function decodeMountInfoPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}
