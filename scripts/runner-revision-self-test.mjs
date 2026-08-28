import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveRunnerRevision,
  resolveRunnerRevision,
  runnerRevisionDigest,
} from '../shared/runner-revision.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const first = await deriveRunnerRevision(repositoryRoot);
const second = await deriveRunnerRevision(repositoryRoot);
assert.equal(first, second);
assert.match(first, /^workspace:sha256:[a-f0-9]{64}$/);
const imageRevision = `image:sha256:${'a'.repeat(64)}`;
assert.equal(runnerRevisionDigest(imageRevision), `sha256:${'a'.repeat(64)}`);
assert.equal(runnerRevisionDigest(first), first.slice('workspace:'.length));
for (const invalid of [
  `sha256:${'a'.repeat(64)}`,
  `image:workspace:sha256:${'a'.repeat(64)}`,
  `image:sha256:${'a'.repeat(64)}:workspace`,
  `image:sha256:${'A'.repeat(64)}`,
  ` image:sha256:${'a'.repeat(64)}`,
  `image:sha256:${'a'.repeat(64)} `,
  'image:sha256:latest',
  '',
  null,
  undefined,
]) {
  assert.throws(() => runnerRevisionDigest(invalid), /workspace or image SHA-256 revision/);
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-revision-'));
try {
  const embeddedPath = path.join(temporaryRoot, 'revision');
  const embedded = first.replace('workspace:', 'image:');
  await fs.writeFile(embeddedPath, `${embedded}\n`);
  assert.equal(await resolveRunnerRevision({ root: repositoryRoot, environment: {}, embeddedPath }), embedded);
  assert.equal(await resolveRunnerRevision({
    root: repositoryRoot,
    environment: { AUDIT_RUNNER_REVISION: first },
    embeddedPath,
  }), first);
  await assert.rejects(
    resolveRunnerRevision({ root: repositoryRoot, environment: { AUDIT_RUNNER_REVISION: 'latest' }, embeddedPath }),
    /SHA-256 revision/,
  );
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write('Runner revision self-test passed: canonical workspace/image identities normalize to visual digests and malformed or mixed identities fail closed.\n');
