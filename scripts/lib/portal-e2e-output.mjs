import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export async function resetPortalE2EOutput({ repositoryRoot, outputRoot }) {
  const workspace = resolve(repositoryRoot);
  const target = resolve(outputRoot);
  if (target === workspace || dirname(target) === target || basename(target) !== 'portal-e2e') {
    throw new Error(`Refusing to clear unsafe portal E2E output path: ${target}`);
  }
  const workspaceRelative = relative(workspace, target);
  if (workspaceRelative === '..' || workspaceRelative.startsWith(`..${sep}`)) {
    throw new Error(`Refusing to clear portal E2E output outside the workspace: ${target}`);
  }

  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const [realWorkspace, realParent] = await Promise.all([realpath(workspace), realpath(parent)]);
  if (join(realParent, basename(target)) !== join(realWorkspace, workspaceRelative)) {
    throw new Error(`Refusing to clear portal E2E output through a linked parent: ${target}`);
  }

  const existing = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to clear a linked portal E2E output directory: ${target}`);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`Portal E2E output exists but is not a directory: ${target}`);
  }

  // Docker Desktop's bind-mounted filesystem can briefly report ENOTEMPTY while
  // it settles directory removals from a just-stopped test container. Node only
  // retries those transient recursive-removal failures when maxRetries is set.
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await mkdir(target, { recursive: false, mode: 0o700 });
  return target;
}
