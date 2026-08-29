import http from 'node:http';
import {
  acquireCoordinator,
  adoptAttemptEvidence,
  adoptWorkHeartbeat,
  appendAttemptLog,
  claimWorkItem,
  heartbeatCoordinator,
  heartbeatWorkItem,
  MAX_ATTEMPT_EVIDENCE_BYTES,
  openParentRunStore,
  publishAttemptEvidence,
  requeueExpiredWork,
  requestPerformanceDrain,
} from './lib/parent-run-store.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const boundedInteger = (name, fallback, minimum, maximum) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid.`);
  return value;
};
const json = (response, status, value) => {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
};

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > Math.ceil(MAX_ATTEMPT_EVIDENCE_BYTES * 4 / 3) + 262_144) {
      throw Object.assign(new Error('Request exceeds the bounded evidence upload size.'), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const runId = required('AUDIT_SHARED_RUN_ID');
const leaseMs = boundedInteger('AUDIT_SHARED_LEASE_MS', 30_000, 1_000, 3_600_000);
const coordinatorLeaseMs = boundedInteger('AUDIT_SHARED_COORDINATOR_LEASE_MS', 60_000, 5_000, 3_600_000);
const port = boundedInteger('AUDIT_SHARED_COORDINATOR_PORT', 4_180, 1_024, 65_535);
const store = await openParentRunStore({
  root: required('AUDIT_SHARED_STORE_ROOT'),
  deploymentIdentity: required('AUDIT_SHARED_DEPLOYMENT_IDENTITY'),
  volumeIdentity: required('AUDIT_SHARED_VOLUME_IDENTITY'),
});
let coordinator = await acquireCoordinator(store, runId, {
  ownerId: `coordinator-${process.pid}`,
  leaseMs: coordinatorLeaseMs,
});
let maintenance = Promise.resolve();
const maintain = () => {
  maintenance = maintenance.then(async () => {
    coordinator = await heartbeatCoordinator(store, coordinator, { leaseMs: coordinatorLeaseMs });
    const requeued = await requeueExpiredWork(store, runId, coordinator);
    if (requeued > 0) {
      process.stdout.write(`${JSON.stringify({ event: 'expired-work-requeued', runId, count: requeued })}\n`);
    }
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'coordinator-maintenance-failed', code: error?.code, message: error?.message })}\n`);
    process.exitCode = 1;
    clearInterval(heartbeat);
    server.close();
  });
  return maintenance;
};
const heartbeat = setInterval(() => {
  void maintain();
}, Math.max(1_000, Math.floor(Math.min(coordinatorLeaseMs, leaseMs) / 3)));
heartbeat.unref();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/healthz') return json(response, 200, { status: 'ok', runId, epoch: coordinator.epoch });
    if (request.method !== 'POST') return json(response, 404, { error: 'Not found.' });
    const body = await readJson(request);
    if (request.url === '/v1/performance-drain') {
      return json(response, 202, await requestPerformanceDrain(store, runId, coordinator, { workerId: body.workerId }));
    }
    if (request.url === '/v1/claim') {
      const lease = await claimWorkItem(store, runId, coordinator, {
        workerId: body.workerId,
        capabilities: body.capabilities,
        resourceClasses: body.resourceClasses,
        leaseMs,
      });
      return json(response, 200, lease);
    }
    if (request.url === '/v1/heartbeat') {
      const receipt = await heartbeatWorkItem(store, runId, body.lease, { leaseMs });
      return json(response, 202, await adoptWorkHeartbeat(store, runId, coordinator, receipt));
    }
    if (request.url === '/v1/result') {
      if (!['completed_pass', 'completed_product_failure'].includes(body?.result?.outcome)) {
        return json(response, 422, { error: 'Workers may publish only completed product outcomes; operational recovery requires coordinator-trusted evidence.' });
      }
      const inbox = await publishAttemptEvidence(store, runId, body.lease, body.result);
      const adopted = await adoptAttemptEvidence(store, runId, coordinator, inbox);
      return json(response, 202, { workItemId: adopted.id, state: adopted.state, canonicalResult: adopted.canonicalResult });
    }
    if (request.url === '/v1/log') {
      const receipt = await appendAttemptLog(store, runId, body.lease, {
        sequence: body.sequence,
        level: body.level,
        message: body.message,
      });
      return json(response, 202, receipt);
    }
    return json(response, 404, { error: 'Not found.' });
  } catch (error) {
    const unavailable = ['NO_WORK_AVAILABLE', 'NO_COMPATIBLE_WORK', 'PERFORMANCE_DRAIN_PENDING', 'PERFORMANCE_DRAIN_REQUIRED', 'PERFORMANCE_DRAINING'].includes(error?.code);
    json(response, error?.status ?? (unavailable ? 409 : 400), { code: error?.code ?? 'SHARED_COORDINATOR_REQUEST_INVALID', error: error?.message ?? 'Request failed.' });
  }
});
server.listen(port, '0.0.0.0', () => process.stdout.write(`${JSON.stringify({ event: 'shared-coordinator-listening', runId, port, epoch: coordinator.epoch })}\n`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(heartbeat);
    server.close(() => process.exit());
  });
}
