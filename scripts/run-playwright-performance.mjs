import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = containedArtifactPath(process.env.AUDIT_ARTIFACT_DIR, 'AUDIT_ARTIFACT_DIR');
const blobFile = containedArtifactPath(process.env.PLAYWRIGHT_BLOB_OUTPUT_FILE, 'PLAYWRIGHT_BLOB_OUTPUT_FILE');
await Promise.all([fs.mkdir(artifactRoot, { recursive: true }), fs.mkdir(dirname(blobFile), { recursive: true })]);

const executable = join(repositoryRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
const args = ['test', 'tests/performance.spec.ts', '--workers=1', '--reporter=blob'];
const command = ['playwright', ...args];
const label = 'PERFORMANCE';
const startedAt = new Date().toISOString();

log('isolated-performance-started', {
  command,
  artifactRoot,
  blobFile,
  workers: 1,
  isolation: 'dedicated-container-after-functional-shards',
  tlsPolicy: process.env.CANDIDATE_IGNORE_HTTPS_ERRORS === '1' ? 'candidate-development-bypass' : 'strict',
});

const started = performance.now();
const result = await run(executable, args, {
  ...process.env,
  AUDIT_PROFILE: 'release',
  AUDIT_WORKERS: '1',
  AUDIT_EXCLUDE_PERFORMANCE: '0',
  AUDIT_ARTIFACT_DIR: artifactRoot,
  PLAYWRIGHT_BLOB_OUTPUT_FILE: blobFile,
});
const durationMs = Math.round(performance.now() - started);

log('command-finished', {
  command,
  startedAt,
  finishedAt: new Date().toISOString(),
  durationMs,
  exitCode: result.exitCode,
  signal: result.signal,
});
process.exitCode = result.exitCode ?? 1;

function run(commandPath, commandArgs, environment) {
  return new Promise((resolveRun) => {
    let settled = false;
    const child = spawn(commandPath, commandArgs, {
      cwd: repositoryRoot,
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    relay(child.stdout, 'stdout');
    relay(child.stderr, 'stderr');
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      log('spawn-error', { message: error.message });
      resolveRun({ exitCode: 127, signal: null });
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolveRun({ exitCode, signal });
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  });
}

function relay(stream, channel) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) process.stdout.write(`${new Date().toISOString()} [${label}][${channel}] ${line}\n`);
  });
  stream.on('end', () => {
    if (buffer) process.stdout.write(`${new Date().toISOString()} [${label}][${channel}] ${buffer}\n`);
  });
}

function log(event, detail) {
  process.stdout.write(`${new Date().toISOString()} [${label}] ${event} ${JSON.stringify(detail)}\n`);
}

function containedArtifactPath(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  const artifactBase = resolve('/work/artifacts');
  const resolved = resolve(value);
  if (resolved !== artifactBase && !resolved.startsWith(`${artifactBase}${sep}`)) {
    throw new Error(`${name} must remain beneath /work/artifacts.`);
  }
  return resolved;
}
