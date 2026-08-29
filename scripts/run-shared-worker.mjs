import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectSharedWorkerEvidence } from './lib/shared-worker-evidence.mjs';
import { maintainSharedWorkerLease } from './lib/shared-worker-heartbeat.mjs';
import { createSharedWorkCommand } from './lib/shared-work-dispatcher.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const coordinatorUrl = new URL(required('AUDIT_SHARED_COORDINATOR_URL'));
const workerCredentialPath = path.resolve(required('AUDIT_SHARED_WORKER_TOKEN_FILE'));
const workerCredentialStat = await fs.lstat(workerCredentialPath);
if (!workerCredentialStat.isFile() || workerCredentialStat.isSymbolicLink() || workerCredentialStat.size < 40 || workerCredentialStat.size > 4_096
  || (workerCredentialStat.mode & 0o077) !== 0) throw new Error('Worker credential file must be a bounded, regular mode-0600 file.');
const workerCredential = (await fs.readFile(workerCredentialPath, 'utf8')).trim();
if (!/^amt\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,}$/.test(workerCredential)) throw new Error('Worker credential file is invalid.');
if (coordinatorUrl.protocol !== 'http:' || coordinatorUrl.username || coordinatorUrl.password || coordinatorUrl.pathname !== '/') {
  throw new Error('AUDIT_SHARED_COORDINATOR_URL must be an exact credential-free HTTP origin on the private Compose network.');
}
const resourceClass = required('AUDIT_SHARED_RESOURCE_CLASS');
if (!['ordinary', 'performance'].includes(resourceClass)) throw new Error('AUDIT_SHARED_RESOURCE_CLASS is invalid.');
const capabilities = required('AUDIT_SHARED_WORKER_CAPABILITIES').split(',').map((value) => value.trim()).filter(Boolean);
const pollMs = Number(process.env.AUDIT_SHARED_POLL_MS ?? 1_000);
if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('AUDIT_SHARED_POLL_MS is invalid.');

const post = async (pathname, body) => {
  const response = await fetch(new URL(pathname, coordinatorUrl), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${workerCredential}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json();
  return { response, value };
};
const wait = () => new Promise((resolve) => setTimeout(resolve, pollMs));
const execute = async ({ lease, signal: abortSignal }) => {
  const evidenceRoot = await fs.mkdtemp(path.join(tmpdir(), 'audit-shared-evidence-'));
  try {
    const command = createSharedWorkCommand(lease, evidenceRoot);
    const completion = await new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        detached: true,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: command.environment,
      });
      let escalation;
      const terminate = () => {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') reject(error); }
        escalation = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') process.stderr.write(`${error.message}\n`); }
        }, 5_000);
        escalation.unref();
      };
      const aborted = () => terminate();
      abortSignal.addEventListener('abort', aborted, { once: true });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        clearTimeout(escalation);
        abortSignal.removeEventListener('abort', aborted);
        if (abortSignal.aborted) reject(abortSignal.reason);
        else resolve({ code, signal });
      });
      child.stdin.on('error', reject);
      child.stdin.end(`${JSON.stringify(lease)}\n`);
    });
    return await collectSharedWorkerEvidence(evidenceRoot, completion, lease);
  } finally {
    await fs.rm(evidenceRoot, { recursive: true, force: true });
  }
};

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
while (!stopping) {
  if (resourceClass === 'performance') {
    const drain = await post('/v1/performance-drain', {}).catch(() => null);
    if (!drain || !drain.response.ok) { await wait(); continue; }
  }
  const claimed = await post('/v1/claim', { capabilities, resourceClasses: [resourceClass] }).catch(() => null);
  if (!claimed || !claimed.response.ok) { await wait(); continue; }
  process.stdout.write(`${JSON.stringify({ event: 'work-item-claimed', workItemId: claimed.value.workItemId, attempt: claimed.value.attempt })}\n`);
  const commandLog = await post('/v1/log', {
    lease: claimed.value, sequence: 1, level: 'info',
    message: `command-started: ${claimed.value.capability} ${claimed.value.targetId}`,
  });
  if (!commandLog.response.ok) throw new Error(`Coordinator rejected command log: ${commandLog.value.error ?? commandLog.response.status}`);
  const leaseDurationMs = Date.parse(claimed.value.expiresAt) - Date.parse(claimed.value.claimedAt);
  const heartbeatIntervalMs = Math.max(100, Math.floor(leaseDurationMs / 3));
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 300 || heartbeatIntervalMs >= leaseDurationMs) {
    throw new Error('Coordinator returned a work lease that is too short for safe heartbeat maintenance.');
  }
  const maintained = await maintainSharedWorkerLease({
    lease: claimed.value,
    intervalMs: heartbeatIntervalMs,
    heartbeat: async (lease) => {
      const renewed = await post('/v1/heartbeat', { lease });
      if (!renewed.response.ok) {
        const error = new Error(`Coordinator rejected work heartbeat: ${renewed.value.error ?? renewed.response.status}`);
        error.code = renewed.value.code ?? 'SHARED_WORK_HEARTBEAT_REJECTED';
        throw error;
      }
      return renewed.value;
    },
    execute,
  });
  const { value: result, lease: activeLease } = maintained;
  const outcomeLog = await post('/v1/log', {
    lease: activeLease, sequence: 2, level: result.outcome === 'completed_pass' ? 'info' : 'error',
    message: result.outcome === 'completed_pass' ? 'command-completed' : `product-failure: ${result.reason}`,
  });
  if (!outcomeLog.response.ok) throw new Error(`Coordinator rejected outcome log: ${outcomeLog.value.error ?? outcomeLog.response.status}`);
  const published = await post('/v1/result', { lease: activeLease, result });
  if (!published.response.ok) throw new Error(`Coordinator rejected result: ${published.value.error ?? published.response.status}`);
  process.stdout.write(`${JSON.stringify({ event: 'work-item-published', workItemId: claimed.value.workItemId, state: published.value.state })}\n`);
}
