import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseAuditedCandidateDeployment,
  parseReleaseArtifactManifest,
  sealAuditedCandidateDeployment,
} from '../shared/release-artifact-contract.mjs';
import { buildReleaseArtifactManifest, verifyReleaseArtifactManifest } from './lib/release-artifact.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'release-artifact-'));

try {
  const source = path.join(root, 'source');
  const copy = path.join(root, 'copy');
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await writeFile(path.join(source, 'index.html'), '<h1>release</h1>\n');
  await writeFile(path.join(source, 'assets', 'app.js'), 'console.log("release");\n');
  await chmod(path.join(source, 'assets', 'app.js'), 0o755);

  const first = await buildReleaseArtifactManifest(source);
  assert.equal(first.kind, 'release-artifact-manifest');
  assert.deepEqual(first.files.map(({ relativePath }) => relativePath), ['assets/app.js', 'index.html']);
  assert.equal(first.fileCount, 2);
  assert.equal(first.totalBytes, Buffer.byteLength('<h1>release</h1>\nconsole.log("release");\n'));
  assert.equal(parseReleaseArtifactManifest(first).digest, first.digest);

  await cp(source, copy, { recursive: true, preserveTimestamps: false });
  const copied = await buildReleaseArtifactManifest(copy);
  assert.equal(copied.digest, first.digest, 'directory location, creation order, timestamps, and modes are not release bytes');
  assert.deepEqual(await verifyReleaseArtifactManifest(copy, first), first);

  await writeFile(path.join(copy, 'assets', 'app.js'), 'console.log("changed");\n');
  await assert.rejects(
    verifyReleaseArtifactManifest(copy, first),
    (error) => error?.code === 'RELEASE_ARTIFACT_CHANGED',
    'a byte change must be rejected immediately before delivery',
  );

  const tampered = structuredClone(first);
  tampered.files[0].size += 1;
  assert.throws(() => parseReleaseArtifactManifest(tampered), /digest|bytes|size/iu);

  const linked = path.join(root, 'linked');
  await mkdir(linked);
  await symlink(path.join(source, 'index.html'), path.join(linked, 'index.html'));
  await assert.rejects(
    buildReleaseArtifactManifest(linked),
    (error) => error?.code === 'RELEASE_ARTIFACT_UNSAFE',
    'symlinked build content must never enter an immutable release manifest',
  );

  const empty = path.join(root, 'empty');
  await mkdir(empty);
  await assert.rejects(
    buildReleaseArtifactManifest(empty),
    (error) => error?.code === 'RELEASE_ARTIFACT_EMPTY',
  );
  await assert.rejects(
    buildReleaseArtifactManifest(source, { maximumFiles: 1 }),
    (error) => error?.code === 'RELEASE_ARTIFACT_LIMIT',
  );

  const candidate = sealAuditedCandidateDeployment({
    schemaVersion: 1,
    provider: 'cloudflare-pages',
    accountId: 'account-123',
    projectName: 'quitting7oh-org-beta',
    deploymentId: 'deployment-123',
    deploymentUrl: 'https://deployment-123.quitting7oh-org-beta.pages.dev',
    auditedOrigin: 'https://beta.quitting7oh-org.pages.dev',
    artifactManifestDigest: first.digest,
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    createdAt: '2026-08-29T20:00:00.000Z',
  });
  assert.equal(parseAuditedCandidateDeployment(candidate).digest, candidate.digest);
  assert.throws(() => parseAuditedCandidateDeployment({ ...candidate, auditedOrigin: 'https://quitting7oh.org' }), /digest|candidate/iu);

  const serialized = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(serialized.scripts['release-artifact:self-test'], /release-artifact-self-test/u);

  console.log('Release artifact self-test passed: deterministic exact-byte manifests, unsafe-entry rejection, pre-delivery recheck, and candidate deployment binding are enforced.');
} finally {
  await rm(root, { recursive: true, force: true });
}
