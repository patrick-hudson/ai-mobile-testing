import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectSharedWorkerAttempt } from './lib/shared-worker-evidence.mjs';
import {
  maintainSharedWorkerLease,
  sharedWorkHeartbeatInterval,
} from './lib/shared-worker-heartbeat.mjs';
import { createSharedWorkCommand } from './lib/shared-work-dispatcher.mjs';
import { SHARED_DOCKER_RESILIENCE_ENV } from '../shared/shared-docker-resilience-contract.mjs';

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
const uploadTimeoutMs = Number(process.env.AUDIT_SHARED_UPLOAD_TIMEOUT_MS ?? 20 * 60_000);
if (!Number.isSafeInteger(uploadTimeoutMs) || uploadTimeoutMs < 30_000 || uploadTimeoutMs > 3_600_000) {
  throw new Error('AUDIT_SHARED_UPLOAD_TIMEOUT_MS is invalid.');
}
const sharedResilienceProof = process.env[SHARED_DOCKER_RESILIENCE_ENV] ?? '0';
if (!['0', '1'].includes(sharedResilienceProof)) {
  throw new Error(`${SHARED_DOCKER_RESILIENCE_ENV} must be exactly 0 or 1.`);
}

const post = async (pathname, body, signal = undefined, timeoutMs = 30_000) => {
  const response = await fetch(new URL(pathname, coordinatorUrl), {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${workerCredential}` }, body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  });
  const value = await response.json();
  return { response, value };
};
async function* artifactBytes(artifact) {
  let handle;
  try {
    handle = await fs.open(artifact.sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== artifact.sizeBytes) {
      throw new Error(`Evidence artifact ${artifact.name} changed before upload.`);
    }
    const chunk = Buffer.allocUnsafe(64 * 1_024);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      yield Buffer.from(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle?.close();
  }
}
const uploadArtifact = async (lease, intentDigest, artifact, ordinal, signal) => {
  const response = await fetch(new URL('/v1/result-artifact', coordinatorUrl), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${workerCredential}`,
      'content-type': artifact.mediaType,
      'content-length': String(artifact.sizeBytes),
      'x-audit-run-id': lease.runId,
      'x-audit-work-item-id': lease.workItemId,
      'x-audit-attempt': String(lease.attempt),
      'x-audit-lease-token': lease.token,
      'x-audit-intent-digest': intentDigest,
      'x-audit-artifact-ordinal': String(ordinal),
    },
    body: artifactBytes(artifact),
    duplex: 'half',
    signal: AbortSignal.any([AbortSignal.timeout(uploadTimeoutMs), signal]),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Coordinator rejected artifact ${artifact.name}: ${value.error ?? response.status}`);
  return { value, status: response.status };
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
    const attempt = await collectSharedWorkerAttempt(evidenceRoot, completion, lease);
    const { result } = attempt;
    const outcomeLog = await post('/v1/log', {
      lease, sequence: 2, level: result.outcome === 'completed_pass' ? 'info' : (attempt.retryable ? 'warn' : 'error'),
      message: attempt.logMessage,
    }, abortSignal);
    if (!outcomeLog.response.ok) throw new Error(`Coordinator rejected outcome log: ${outcomeLog.value.error ?? outcomeLog.response.status}`);
    if (result.outcome === 'operational_failure') {
      const recovered = await post('/v1/runtime-failure', { lease, signal: attempt.runtimeSignal }, abortSignal);
      if (!recovered.response.ok) throw new Error(`Coordinator rejected runtime recovery: ${recovered.value.error ?? recovered.response.status}`);
      return recovered.value;
    }
    const declaredResult = {
      ...result,
      artifacts: result.artifacts.map(({ sourcePath: _sourcePath, ...artifact }) => artifact),
    };
    const intent = await post('/v1/result-intent', { lease, result: declaredResult }, abortSignal);
    if (!intent.response.ok) throw new Error(`Coordinator rejected result intent: ${intent.value.error ?? intent.response.status}`);
    process.stdout.write(`${JSON.stringify({
      event: 'evidence-upload-intent-created', workItemId: lease.workItemId, attempt: lease.attempt,
      artifactCount: result.artifacts.length, responseStatus: intent.response.status,
    })}\n`);
    for (let index = 0; index < result.artifacts.length; index += 1) {
      const artifact = result.artifacts[index];
      process.stdout.write(`${JSON.stringify({
        event: 'evidence-artifact-upload-started', workItemId: lease.workItemId, attempt: lease.attempt,
        ordinal: index + 1, name: artifact.name, mediaType: artifact.mediaType, sizeBytes: artifact.sizeBytes,
      })}\n`);
      const uploaded = await uploadArtifact(lease, intent.value.intentDigest, artifact, index + 1, abortSignal);
      process.stdout.write(`${JSON.stringify({
        event: 'evidence-artifact-upload-completed', workItemId: lease.workItemId, attempt: lease.attempt,
        ordinal: index + 1, name: artifact.name, sizeBytes: artifact.sizeBytes,
        digest: artifact.digest, responseStatus: uploaded.status,
      })}\n`);
    }
    const finalized = await post('/v1/result-finalize', {
      lease,
      intentDigest: intent.value.intentDigest,
    }, abortSignal, uploadTimeoutMs);
    if (!finalized.response.ok) throw new Error(`Coordinator rejected result finalization: ${finalized.value.error ?? finalized.response.status}`);
    process.stdout.write(`${JSON.stringify({
      event: 'evidence-finalized', workItemId: lease.workItemId, attempt: lease.attempt,
      state: finalized.value.state, responseStatus: finalized.response.status,
    })}\n`);
    return finalized.value;
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
  const heartbeatIntervalMs = sharedWorkHeartbeatInterval(leaseDurationMs);
  let maintained;
  try {
    maintained = await maintainSharedWorkerLease({
      lease: claimed.value,
      intervalMs: heartbeatIntervalMs,
      heartbeat: async (lease, signal) => {
        const renewed = await post('/v1/heartbeat', { lease }, signal);
        if (!renewed.response.ok) {
          const error = new Error(`Coordinator rejected work heartbeat: ${renewed.value.error ?? renewed.response.status}`);
          error.code = renewed.value.code ?? 'SHARED_WORK_HEARTBEAT_REJECTED';
          throw error;
        }
        return renewed.value;
      },
      execute,
    });
  } catch (error) {
    if (error?.code !== 'SHARED_WORK_DESCRIPTOR_INVALID') throw error;
    const recoveryLog = await post('/v1/log', {
      lease: claimed.value,
      sequence: 2,
      level: 'warn',
      message: `operational-recovery: work-descriptor-invalid; ${error.message}`,
    }).catch(() => null);
    if (!recoveryLog?.response.ok) {
      process.stderr.write(`Could not publish descriptor recovery log for ${claimed.value.workItemId}.\n`);
    }
    process.stderr.write(`Rejected invalid work descriptor for ${claimed.value.workItemId}; lease will expire for bounded recovery.\n`);
    const leaseExpiryDelayMs = Math.max(0, Date.parse(claimed.value.expiresAt) - Date.now() + pollMs);
    await new Promise((resolve) => setTimeout(resolve, leaseExpiryDelayMs));
    continue;
  }
  const { value: published } = maintained;
  process.stdout.write(`${JSON.stringify({ event: 'work-item-published', workItemId: claimed.value.workItemId, state: published.state })}\n`);
}
