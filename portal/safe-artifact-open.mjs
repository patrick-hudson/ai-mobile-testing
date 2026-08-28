import { constants as fsConstants } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SAFE_OPEN_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EINVAL']);

export async function openContainedArtifactFile(
  fsOperations,
  root,
  requestedPath,
  {
    requireDescriptorContainment = false,
    descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : null,
    beforeOpenComponent = null,
  } = {},
) {
  const segments = artifactSegments(requestedPath);
  if (descriptorRoot) {
    try {
      return await openWithPinnedDescriptors(
        fsOperations,
        resolve(root),
        segments,
        descriptorRoot,
        beforeOpenComponent,
      );
    } catch (error) {
      if (!SAFE_OPEN_ERRORS.has(error?.code) || requireDescriptorContainment) throw error;
    }
  }
  if (requireDescriptorContainment) {
    throw new Error('Race-safe artifact containment is unavailable on this platform.');
  }
  return openWithCanonicalFallback(fsOperations, resolve(root), segments);
}

async function openWithPinnedDescriptors(fsOperations, root, requestedSegments, descriptorRoot, beforeOpenComponent) {
  const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0);
  const fileFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let current = await fsOperations.open(root, directoryFlags);
  let relativeSegments = [];
  try {
    const rootStat = await current.stat();
    if (!rootStat.isDirectory()) throw unsafeArtifact('Artifact root is not a real directory.');
    const segments = requestedSegments.length === 0 ? ['index.html'] : [...requestedSegments];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      await beforeOpenComponent?.({ index, segment, parentFileDescriptor: current.fd });
      const candidate = `${descriptorRoot}/${current.fd}/${segment}`;
      const next = await fsOperations.open(candidate, fileFlags);
      let details;
      try {
        details = await next.stat();
      } catch (error) {
        await closeQuietly(next);
        throw error;
      }
      relativeSegments.push(segment);
      if (details.isDirectory()) {
        if (index !== segments.length - 1) {
          try {
            await current.close();
          } catch (error) {
            await closeQuietly(next);
            throw error;
          }
          current = next;
          continue;
        }
        let indexHandle;
        try {
          await beforeOpenComponent?.({ index: index + 1, segment: 'index.html', parentFileDescriptor: next.fd });
          indexHandle = await fsOperations.open(`${descriptorRoot}/${next.fd}/index.html`, fileFlags);
          const indexStat = await indexHandle.stat();
          if (!indexStat.isFile() || indexStat.nlink > 1) {
            throw unsafeArtifact('Artifact index is not a safe regular file.');
          }
          await closeQuietly(next);
          await closeQuietly(current);
          current = null;
          return artifactHandle(indexHandle, indexStat, root, [...relativeSegments, 'index.html']);
        } catch (error) {
          await closeQuietly(indexHandle);
          await closeQuietly(next);
          throw error;
        }
      }
      if (index !== segments.length - 1 || !details.isFile() || details.nlink > 1) {
        await closeQuietly(next);
        throw unsafeArtifact('Artifact path is not a safe regular file.');
      }
      try {
        await current.close();
      } catch (error) {
        await closeQuietly(next);
        throw error;
      }
      current = null;
      return artifactHandle(next, details, root, relativeSegments);
    }
    throw unsafeArtifact('Artifact path is incomplete.');
  } catch (error) {
    await current?.close().catch(() => undefined);
    throw error;
  }
}

async function closeQuietly(handle) {
  await handle?.close().catch(() => undefined);
}

async function openWithCanonicalFallback(fsOperations, root, segments) {
  let path = join(root, ...segments);
  let details = await fsOperations.stat(path);
  if (details.isDirectory()) {
    path = join(path, 'index.html');
    details = await fsOperations.stat(path);
  }
  const [realRoot, realPath] = await Promise.all([fsOperations.realpath(root), fsOperations.realpath(path)]);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {
    throw unsafeArtifact('Artifact path resolves outside its run root.');
  }
  const handle = await fsOperations.open(realPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.nlink > 1) {
      throw unsafeArtifact('Artifact path is not a safe regular file.');
    }
    return {
      handle,
      stat: openedStat,
      path: realPath,
      relativePath: relative(realRoot, realPath).split(sep).join('/'),
      raceSafe: false,
    };
  } catch (error) {
    await closeQuietly(handle);
    throw error;
  }
}

function artifactHandle(handle, stat, root, segments) {
  return {
    handle,
    stat,
    path: join(root, ...segments),
    relativePath: segments.join('/'),
    raceSafe: true,
  };
}

function artifactSegments(requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.includes('\0')) throw unsafeArtifact('Artifact path is invalid.');
  const normalized = requestedPath.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (normalized === '') return [];
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw unsafeArtifact('Artifact path escapes its run root.');
  }
  return segments;
}

function unsafeArtifact(message) {
  const error = new Error(message);
  error.code = 'UNSAFE_ARTIFACT_PATH';
  return error;
}
