import { createServer } from 'node:net';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resetPortalE2EOutput } from './lib/portal-e2e-output.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(process.env.PORTAL_E2E_OUTPUT_DIR ?? join(repositoryRoot, 'artifacts', 'portal-e2e'));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'ai-mobile-testing-portal-e2e-'));
const port = await availablePort();
const baseURL = `http://127.0.0.1:${port}`;
await resetPortalE2EOutput({ repositoryRoot, outputRoot });
const invocation = {
  schemaVersion: 1,
  invocationId: randomUUID(),
  status: 'running',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  exitCode: null,
  signal: null,
};
const invocationPath = join(outputRoot, 'portal-e2e-run.json');
await writeFile(invocationPath, `${JSON.stringify(invocation, null, 2)}\n`, { mode: 0o600 });
const serverLog = createWriteStream(join(outputRoot, 'portal-server.log'), { flags: 'w', mode: 0o600 });
let portal;

try {
  const resourceProfile = await readContainerResourceProfile();
  const fastIteration = process.env.PORTAL_E2E_FAST_ITERATION === '1';
  const methodology = {
    schemaVersion: 1,
    canonical: process.env.PORTAL_E2E_CANONICAL_PROFILE === '1' && !fastIteration,
    diagnosticFastIteration: fastIteration,
    resourceProfile,
    cold: { warmups: fastIteration ? 0 : 5, measures: fastIteration ? 1 : 30, cache: 'fresh context; cache and storage empty' },
    warm: { warmups: fastIteration ? 0 : 10, measures: fastIteration ? 2 : 100 },
    thresholds: { coldP95Ms: 2_000, warmP95Ms: 200, maximumDomNodes: 500, maximumHeapGrowthBytes: 25 * 1024 * 1024 },
  };
  log('resource-profile', methodology);
  await writeFile(join(outputRoot, 'gallery-scale-methodology.json'), `${JSON.stringify(methodology, null, 2)}\n`, { mode: 0o600 });
  if (methodology.canonical && (resourceProfile.cpuCores !== 2 || resourceProfile.memoryBytes !== 4 * 1024 * 1024 * 1024)) {
    throw new Error(`Canonical portal benchmark needs exactly 2 CPUs and 4 GiB; detected ${JSON.stringify(resourceProfile)}.`);
  }
  log('server-command', { command: ['node', 'portal/server.mjs'], baseURL, temporaryRoot });
  portal = spawn(process.execPath, ['portal/server.mjs'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PORTAL_ARTIFACT_ROOT: join(temporaryRoot, 'runs'),
      PORTAL_SHARDED_ARTIFACT_ROOT: join(temporaryRoot, 'sharded'),
      PORTAL_SECRET_ROOT: join(temporaryRoot, 'secrets'),
      PORTAL_MAX_CONCURRENT_RUNS: '1',
      PORTAL_ALLOWED_HOSTS: 'shared-review.example.test',
      PORTAL_E2E_FAILURE_INJECTION: '1',
      AI_REVIEW_DRY_RUN: '1',
      CANDIDATE_IGNORE_HTTPS_ERRORS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipe(portal.stdout, 'portal:stdout');
  pipe(portal.stderr, 'portal:stderr');
  await waitForHealth(`${baseURL}/healthz`, portal);

  const playwrightCli = resolve(repositoryRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  const args = [playwrightCli, 'test', '--config=portal/playwright.portal.config.ts'];
  if (process.env.PORTAL_E2E_GREP) args.push(`--grep=${process.env.PORTAL_E2E_GREP}`);
  log('test-command', { command: ['node', ...args] });
  const testProcess = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PORTAL_E2E_BASE_URL: baseURL,
      PORTAL_E2E_OUTPUT_DIR: outputRoot,
      PORTAL_E2E_SERVER_ARTIFACT_ROOT: join(temporaryRoot, 'runs'),
      PORTAL_E2E_SERVER_SHARDED_ARTIFACT_ROOT: join(temporaryRoot, 'sharded'),
    },
    stdio: 'inherit',
  });
  const [exitCode, signal] = await once(testProcess, 'exit');
  log('test-finished', { exitCode, signal });
  process.exitCode = typeof exitCode === 'number' ? exitCode : 1;
  Object.assign(invocation, {
    status: process.exitCode === 0 ? 'passed' : 'failed',
    finishedAt: new Date().toISOString(),
    exitCode: process.exitCode,
    signal,
  });
  await writeFile(invocationPath, `${JSON.stringify(invocation, null, 2)}\n`, { mode: 0o600 });
} catch (error) {
  Object.assign(invocation, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    exitCode: 1,
    error: String(error?.message ?? error).slice(0, 1_200),
  });
  await writeFile(invocationPath, `${JSON.stringify(invocation, null, 2)}\n`, { mode: 0o600 });
  throw error;
} finally {
  if (portal && portal.exitCode == null) {
    portal.kill('SIGTERM');
    await Promise.race([once(portal, 'exit'), new Promise((resolveWait) => setTimeout(resolveWait, 12_000))]);
    if (portal.exitCode == null) portal.kill('SIGKILL');
  }
  serverLog.end();
  await rm(temporaryRoot, { recursive: true, force: true });
}

function pipe(stream, label) {
  stream?.on('data', (chunk) => {
    const value = chunk.toString();
    process.stdout.write(`[${label}] ${value}`);
    serverLog.write(`[${new Date().toISOString()}] [${label}] ${value}`);
  });
}

function log(event, detail) {
  const value = `${new Date().toISOString()} [PORTAL_E2E] ${event} ${JSON.stringify(detail)}\n`;
  process.stdout.write(value);
  serverLog.write(value);
}

async function availablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  const selected = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  if (!selected) throw new Error('Could not allocate a local portal test port.');
  return selected;
}

async function waitForHealth(url, child) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (child.exitCode != null) throw new Error(`Portal exited before health check (exit ${child.exitCode}).`);
    try {
      const response = await fetch(url);
      if (response.ok) {
        log('health-ready', { url, status: response.status });
        return;
      }
    } catch {
      // Startup races are expected until the local listener is ready.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Portal did not become healthy at ${url}.`);
}

async function readContainerResourceProfile() {
  let cpuCores = null;
  let memoryBytes = null;
  try {
    const [quota, period] = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(/\s+/);
    if (quota !== 'max') cpuCores = Number(quota) / Number(period);
  } catch { /* Host runs remain informational and cannot satisfy the canonical gate. */ }
  try {
    const value = (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim();
    if (value !== 'max') memoryBytes = Number(value);
  } catch { /* Host runs remain informational and cannot satisfy the canonical gate. */ }
  return { cpuCores, memoryBytes };
}
