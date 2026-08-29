import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCloudflarePagesProvider } from './lib/cloudflare-pages-provider.mjs';
import { buildReleaseArtifactManifest } from './lib/release-artifact.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'cloudflare-pages-provider-'));
const token = `cloudflare-token-${'s'.repeat(40)}`;

try {
  const artifactRoot = path.join(root, 'site');
  const invocationPath = path.join(root, 'invocation.json');
  const fakeWrangler = new URL('./fixtures/fake-wrangler.mjs', import.meta.url).pathname;
  await mkdir(artifactRoot);
  await writeFile(path.join(artifactRoot, 'index.html'), '<h1>provider</h1>\n');
  const directVersion = spawnSync(process.execPath, [fakeWrangler, '--version'], { encoding: 'utf8' });
  assert.equal(directVersion.status, 0, directVersion.stderr);
  assert.equal(directVersion.stdout.trim(), '4.127.1', JSON.stringify({ stdout: directVersion.stdout, stderr: directVersion.stderr, signal: directVersion.signal }));
  const artifactManifest = await buildReleaseArtifactManifest(artifactRoot);
  const input = {
    artifactRoot,
    artifactManifest,
    production: { accountId: 'account-123', projectName: 'quitting7oh-org', branch: 'main' },
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    requestId: 'exact-promotion-provider-0001',
    subjectDigest: `sha256:${'1'.repeat(64)}`,
    publicationDigest: `sha256:${'2'.repeat(64)}`,
  };
  const provider = createCloudflarePagesProvider({
    wranglerModulePath: fakeWrangler,
    expectedWranglerVersion: '4.127.1',
    apiToken: token,
    accountId: 'account-123',
    environment: { FAKE_WRANGLER_INVOCATION: invocationPath },
  });
  await provider.prepare(input);
  const receipt = await provider.deploy(input);
  assert.equal(receipt.deploymentId, 'production-deployment-123');
  assert.equal(receipt.deploymentUrl, 'https://production-deployment-123.quitting7oh-org.pages.dev');
  assert.equal(receipt.artifactManifestDigest, artifactManifest.digest);
  const invocation = JSON.parse(await readFile(invocationPath, 'utf8'));
  assert.deepEqual(invocation.argv, [
    'pages', 'deploy', artifactRoot,
    '--project-name=quitting7oh-org', '--branch=main',
    '--commit-hash=0123456789abcdef0123456789abcdef01234567',
    '--commit-message=AMT exact exact-promotion-provider-0001',
    '--commit-dirty=false', '--no-bundle', '--install-skills=false',
  ]);
  assert.equal(invocation.hasToken, true);
  assert.equal(invocation.accountId, 'account-123');
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(token, 'u'));

  const wrongVersion = createCloudflarePagesProvider({
    wranglerModulePath: fakeWrangler, expectedWranglerVersion: '4.126.0', apiToken: token, accountId: 'account-123',
  });
  await assert.rejects(wrongVersion.prepare(input), (error) => error?.code === 'CLOUDFLARE_WRANGLER_VERSION_MISMATCH');

  await writeFile(path.join(artifactRoot, '.env'), 'SECRET=bad\n');
  const unsafeManifest = await buildReleaseArtifactManifest(artifactRoot);
  await assert.rejects(provider.prepare({ ...input, artifactManifest: unsafeManifest }),
    (error) => error?.code === 'CLOUDFLARE_ARTIFACT_UNSAFE');

  console.log('Cloudflare Pages provider self-test passed: pinned Wrangler direct upload, exact-byte recheck, bounded output, and secret-path rejection are enforced.');
} finally {
  await rm(root, { recursive: true, force: true });
}
