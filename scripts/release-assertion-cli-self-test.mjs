import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'release-assertion-cli-'));
const credentialDirectory = path.join(root, 'credentials');
const outputDirectory = path.join(root, 'claim');
const credentialPath = path.join(credentialDirectory, 'delivery.token');
const claimPath = path.join(outputDirectory, 'promotion.claim');
const deliveryCredential = `amt.delivery.${'d'.repeat(40)}`;
const claimToken = `amtp.${'a'.repeat(32)}.${'s'.repeat(43)}`;
const subjectDigest = `sha256:${'b'.repeat(64)}`;
const executionDigest = `sha256:${'c'.repeat(64)}`;
let server;

try {
  await mkdir(credentialDirectory, { mode: 0o700 });
  await mkdir(outputDirectory, { mode: 0o700 });
  await writeFile(credentialPath, `${deliveryCredential}\n`, { mode: 0o600 });
  server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${deliveryCredential}`);
    assert.equal(request.headers['idempotency-key'], 'release-assertion-cli-0001');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      schemaVersion: 1,
      data: {
        token: claimToken,
        expiresAt: '2026-08-29T20:00:00.000Z',
        runId: 'run-cli',
        subjectDigest,
        authority: 'FULL',
        runRevision: 4,
        decisionRevision: 3,
        result: { decisionCode: 'RELEASE_READY', ready: true },
      },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const result = await run(process.execPath, [
    new URL('./assert-release-decision.mjs', import.meta.url).pathname,
    '--server', `http://127.0.0.1:${address.port}`,
    '--token-file', credentialPath,
    '--claim-token-file', claimPath,
    '--run', 'run-cli',
    '--project', 'project-cli',
    '--subject', subjectDigest,
    '--authority', 'FULL',
    '--execution-set-digest', executionDigest,
    '--run-revision', '4',
    '--decision-revision', '3',
    '--request-id', 'release-assertion-cli-0001',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(claimToken, 'u'), 'claim token must not enter stdout');
  assert.doesNotMatch(result.stderr, new RegExp(claimToken, 'u'), 'claim token must not enter stderr');
  const document = JSON.parse(result.stdout);
  assert.equal(document.data.token, undefined);
  assert.equal(document.data.claimTokenPath, claimPath);
  assert.equal((await readFile(claimPath, 'utf8')).trim(), claimToken);
  assert.equal((await stat(claimPath)).mode & 0o077, 0, 'claim output must be mode 0600');

  console.log('Release assertion CLI self-test passed: promotion claims are file-only and never enter retained output.');
} finally {
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  await rm(root, { recursive: true, force: true });
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
