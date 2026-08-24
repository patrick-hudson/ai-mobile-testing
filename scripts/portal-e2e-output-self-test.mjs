import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetPortalE2EOutput } from './lib/portal-e2e-output.mjs';

const root = await mkdtemp(join(tmpdir(), 'portal-e2e-output-self-test-'));
try {
  const output = join(root, 'artifacts', 'portal-e2e');
  const sibling = join(root, 'artifacts', 'keep.txt');
  await mkdir(join(output, 'raw', 'old-run'), { recursive: true });
  await writeFile(join(output, 'gallery-scale-metrics.json'), '{"stale":true}\n');
  await writeFile(join(output, 'raw', 'old-run', 'video.webm'), 'stale video');
  await writeFile(sibling, 'preserve sibling');

  await resetPortalE2EOutput({ repositoryRoot: root, outputRoot: output });
  assert.equal(await readFile(sibling, 'utf8'), 'preserve sibling');
  await assert.rejects(readFile(join(output, 'gallery-scale-metrics.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(output, 'raw', 'old-run', 'video.webm')), { code: 'ENOENT' });

  await assert.rejects(resetPortalE2EOutput({ repositoryRoot: root, outputRoot: root }), /unsafe portal E2E output path/);
  await assert.rejects(
    resetPortalE2EOutput({ repositoryRoot: root, outputRoot: join(root, 'artifacts') }),
    /unsafe portal E2E output path/,
  );

  const linkedTarget = join(root, 'linked-target');
  const linkedOutput = join(root, 'linked-parent', 'portal-e2e');
  await mkdir(linkedTarget, { recursive: true });
  await symlink(linkedTarget, join(root, 'linked-parent'));
  await assert.rejects(
    resetPortalE2EOutput({ repositoryRoot: root, outputRoot: linkedOutput }),
    /linked parent/,
  );

  console.log('Portal E2E output self-test passed: only the exact portal-e2e directory is cleared and linked/broad targets are rejected.');
} finally {
  await rm(root, { recursive: true, force: true });
}
