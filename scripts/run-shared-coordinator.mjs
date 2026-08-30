import http from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  adoptAttemptEvidence,
  adoptWorkHeartbeat,
  appendAttemptLog,
  createAttemptEvidenceUploadIntent,
  finalizeAttemptEvidenceUpload,
  heartbeatWorkItem,
  MAX_ATTEMPT_ARTIFACT_BYTES,
  openParentRunStore,
  publishAttemptEvidence,
  readParentRun,
  uploadAttemptEvidenceArtifact,
} from './lib/parent-run-store.mjs';
import { createSharedControlService } from './lib/shared-control-service.mjs';
import { createSharedCoordinatorSupervisor } from './lib/shared-coordinator-supervisor.mjs';
import { openScopedCredentialAuthority } from '../portal/scoped-credential-authority.mjs';
import { assertPrincipalAuthorized, CONTROL_ACTIONS } from '../shared/control-plane-contract.mjs';
import {
  probeTargetPreflightSet,
  targetPreflightInputsForSubject,
} from '../shared/target-preflight-set.mjs';
import {
  openSharedRuntimeAuthorityFloor,
  readTrustedStoreMarker,
  sharedStoreBuildIdentity,
  sharedStoreGeneration,
  sharedStoreRollbackBuilds,
} from './lib/shared-store-runtime.mjs';
import { maybeCrashAtSharedResilienceBoundary } from './lib/shared-resilience-failpoint.mjs';
import { openLegacyAuthorityFenceFromEnvironment } from './lib/legacy-authority-fence.mjs';

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
    if (bytes > 262_144) {
      throw Object.assign(new Error('JSON request exceeds its metadata byte bound.'), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415 });
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const leaseMs = boundedInteger('AUDIT_SHARED_LEASE_MS', 30_000, 1_000, 3_600_000);
const coordinatorLeaseMs = boundedInteger('AUDIT_SHARED_COORDINATOR_LEASE_MS', 60_000, 5_000, 3_600_000);
const uploadTimeoutMs = boundedInteger('AUDIT_SHARED_UPLOAD_TIMEOUT_MS', 20 * 60_000, 30_000, 3_600_000);
const WORKER_SUPERVISOR_RUNTIME_SIGNALS = new Set([
  'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGKILL', 'SIGPIPE', 'SIGSEGV', 'SIGTERM', 'SIGTRAP', 'SIGUSR2',
]);
const port = boundedInteger('AUDIT_SHARED_COORDINATOR_PORT', 4_180, 1_024, 65_535);
const storeMarker = await readTrustedStoreMarker(required('AUDIT_SHARED_STORE_MARKER_FILE'));
const backupMarker = await readTrustedStoreMarker(required('AUDIT_SHARED_BACKUP_MARKER_FILE'), 'shared backup marker');
const buildIdentity = sharedStoreBuildIdentity();
const authorityFloor = await openSharedRuntimeAuthorityFloor(process.env);
const legacyAuthorityFence = await openLegacyAuthorityFenceFromEnvironment(process.env, { authorityFloor });
const store = await openParentRunStore({
  root: required('AUDIT_SHARED_STORE_ROOT'),
  deploymentIdentity: required('AUDIT_SHARED_DEPLOYMENT_IDENTITY'),
  volumeIdentity: required('AUDIT_SHARED_VOLUME_IDENTITY'),
  storeMarker,
  storeGeneration: sharedStoreGeneration(),
  expectedStoreGeneration: sharedStoreGeneration(),
  buildIdentity,
  backupMarker,
  prequalifiedRollbackBuilds: sharedStoreRollbackBuilds(process.env, buildIdentity),
  authorityFloor,
  legacyAuthorityFence,
});
const controlService = createSharedControlService({
  store,
  projectId: process.env.AUDIT_SHARED_PROJECT_ID ?? 'default',
  reprobeTargetIdentity: async ({ subjectCore }) => {
    const inputs = targetPreflightInputsForSubject({
      mode: subjectCore.mode,
      targets: subjectCore.targets,
      certificatePolicy: subjectCore.certificatePolicy,
      singleSiteDeploymentRole: subjectCore.mode === 'single-site' ? subjectCore.targets[0].role : null,
    });
    const preflightOptions = subjectCore.mode === 'single-site'
      && subjectCore.certificatePolicy === 'preview-bypass'
      ? {
        previewBypassOrigins: [subjectCore.targets[0].origin],
        tlsBypassRequestOptions: { rejectUnauthorized: false },
      }
      : {};
    return (await probeTargetPreflightSet(inputs, { preflightOptions })).identity;
  },
  afterOracleSeal: () => maybeCrashAtSharedResilienceBoundary('oracle-seal'),
  publicationHooks: {
    afterEnvelopePersist: () => maybeCrashAtSharedResilienceBoundary('envelope-fsync'),
    afterDecisionPersist: () => maybeCrashAtSharedResilienceBoundary('head-swap'),
  },
});
const credentialAuthority = await openScopedCredentialAuthority({ root: required('AUDIT_SHARED_CREDENTIAL_ROOT') });
const projectId = process.env.AUDIT_SHARED_PROJECT_ID ?? 'default';
const [pluginRegistry, targetRegistry] = await Promise.all([
  readFile(new URL('../audit/plugins.generated.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../audit/targets.generated.json', import.meta.url), 'utf8').then(JSON.parse),
]);
const supervisor = createSharedCoordinatorSupervisor({
  store,
  controlService,
  projectId,
  ownerId: `coordinator-${process.pid}`,
  coordinatorLeaseMs,
  workLeaseMs: leaseMs,
  pluginRegistry,
  targetRegistry,
  afterInventorySeal: () => maybeCrashAtSharedResilienceBoundary('inventory-seal'),
  onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
});
let maintenance = Promise.resolve();
const maintain = () => {
  maintenance = maintenance.then(() => supervisor.maintain()).catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'coordinator-maintenance-failed', code: error?.code, message: error?.message })}\n`);
    return supervisor.status();
  });
  return maintenance;
};
const heartbeat = setInterval(() => {
  void maintain();
}, Math.max(1_000, Math.floor(Math.min(coordinatorLeaseMs, leaseMs) / 3)));
heartbeat.unref();

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', 'http://shared-coordinator.invalid');
    if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
      const status = supervisor.status();
      return json(response, status.state === 'ready' ? 200 : 503, status);
    }
    const authorization = String(request.headers.authorization ?? '');
    if (!authorization.startsWith('Bearer ')) throw Object.assign(new Error('Worker authentication is required.'), { status: 401 });
    const principal = await credentialAuthority.authenticateCredential(authorization.slice(7));
    if (request.method === 'PUT' && requestUrl.pathname === '/v1/result-artifact') {
      const runId = String(request.headers['x-audit-run-id'] ?? '');
      assertPrincipalAuthorized(principal, CONTROL_ACTIONS.WORK_PUBLISH, { projectId, runId });
      const contentLength = Number(request.headers['content-length']);
      if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > MAX_ATTEMPT_ARTIFACT_BYTES) {
        throw Object.assign(new Error('Artifact upload requires an exact bounded Content-Length.'), { status: 411 });
      }
      if (request.headers['content-encoding'] !== undefined) {
        throw Object.assign(new Error('Artifact upload Content-Encoding is not supported.'), { status: 415 });
      }
      const receipt = await uploadAttemptEvidenceArtifact(store, runId, {
        workItemId: String(request.headers['x-audit-work-item-id'] ?? ''),
        workerId: principal.id,
        attempt: Number(request.headers['x-audit-attempt']),
        leaseToken: String(request.headers['x-audit-lease-token'] ?? ''),
        intentDigest: String(request.headers['x-audit-intent-digest'] ?? ''),
        ordinal: Number(request.headers['x-audit-artifact-ordinal']),
        contentLength,
        mediaType: String(request.headers['content-type'] ?? ''),
      }, request);
      if (receipt.sizeBytes !== contentLength) {
        throw Object.assign(new Error('Artifact upload Content-Length disagrees with its sealed declaration.'), { status: 400 });
      }
      return json(response, 201, receipt);
    }
    if (request.method !== 'POST') return json(response, 404, { error: 'Not found.' });
    const action = ['/v1/performance-drain', '/v1/claim'].includes(requestUrl.pathname) ? CONTROL_ACTIONS.WORK_CLAIM : CONTROL_ACTIONS.WORK_PUBLISH;
    const body = await readJson(request);
    const leaseRunId = body?.lease?.runId;
    assertPrincipalAuthorized(principal, action, {
      projectId,
      ...(['/v1/performance-drain', '/v1/claim'].includes(requestUrl.pathname) ? {} : { runId: leaseRunId }),
    });
    if (requestUrl.pathname === '/v1/performance-drain') {
      return json(response, 202, await supervisor.requestPerformanceDrain(principal, body));
    }
    if (requestUrl.pathname === '/v1/claim') {
      const lease = await supervisor.claim(principal, body);
      return json(response, 200, lease);
    }
    if (typeof leaseRunId !== 'string' || !leaseRunId) {
      return json(response, 400, { code: 'WORK_RESULT_BINDING_MISMATCH', error: 'Worker request lacks its server-issued run binding.' });
    }
    const coordinator = supervisor.coordinator();
    if (coordinator === null) return json(response, 503, { code: 'COORDINATOR_UNAVAILABLE', error: 'No active coordinator lease.' });
    if (requestUrl.pathname === '/v1/heartbeat') {
      if (body.lease?.workerId !== principal.id) throw Object.assign(new Error('Worker lease belongs to another principal.'), { status: 403 });
      try {
        const receipt = await heartbeatWorkItem(store, leaseRunId, body.lease, { leaseMs });
        return json(response, 202, await adoptWorkHeartbeat(store, leaseRunId, coordinator, receipt));
      } catch (error) {
        if (error?.code !== 'STALE_WORK_LEASE') throw error;
        const state = await readParentRun(store, leaseRunId);
        const item = state.workItems?.[body.lease?.workItemId];
        const diagnostic = body.lease?.diagnosticExecutionId === undefined ? null
          : item?.diagnosticExecutions?.find(
            ({ diagnosticExecutionId }) => diagnosticExecutionId === body.lease.diagnosticExecutionId);
        const lineage = diagnostic?.attempts ?? item?.attempts;
        const adoptedAttempt = lineage?.find((attempt) => attempt.attempt === body.lease?.attempt
          && attempt.workerId === principal.id && attempt.leaseToken === body.lease?.token && attempt.inboxDigest);
        const terminalState = diagnostic?.state ?? item?.state;
        const attemptIsTerminal = ['completed_pass', 'completed_product_failure'].includes(terminalState)
          || (adoptedAttempt?.outcome === 'operational_failure' && ['queued', 'incomplete'].includes(terminalState));
        if (!adoptedAttempt || !attemptIsTerminal) throw error;
        return json(response, 202, { ...body.lease, terminal: true });
      }
    }
    if (requestUrl.pathname === '/v1/result-intent') {
      if (body.lease?.workerId !== principal.id) throw Object.assign(new Error('Worker lease belongs to another principal.'), { status: 403 });
      if (!['completed_pass', 'completed_product_failure'].includes(body?.result?.outcome)) {
        return json(response, 422, { error: 'Workers may publish only completed product outcomes; operational recovery requires coordinator-trusted evidence.' });
      }
      return json(response, 201, await createAttemptEvidenceUploadIntent(store, leaseRunId, body.lease, body.result));
    }
    if (requestUrl.pathname === '/v1/runtime-failure') {
      if (body.lease?.workerId !== principal.id) throw Object.assign(new Error('Worker lease belongs to another principal.'), { status: 403 });
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 2 || !('lease' in body) || !WORKER_SUPERVISOR_RUNTIME_SIGNALS.has(body.signal)) {
        return json(response, 422, { error: 'Runtime failure must contain only a server-issued lease and an allowlisted OS signal.' });
      }
      const inbox = await publishAttemptEvidence(store, leaseRunId, body.lease, {
        outcome: 'operational_failure',
        reason: body.signal === 'SIGUSR2' ? 'browser_process_crash' : 'worker_process_terminated',
        executionDescriptorDigest: body.lease.executionDescriptorDigest ?? null,
        artifacts: [],
      });
      const adopted = await adoptAttemptEvidence(store, leaseRunId, coordinator, inbox);
      await maybeCrashAtSharedResilienceBoundary('work-item-adoption');
      return json(response, 202, { workItemId: adopted.id, state: adopted.state, canonicalResult: adopted.canonicalResult });
    }
    if (requestUrl.pathname === '/v1/result-finalize') {
      if (body.lease?.workerId !== principal.id) throw Object.assign(new Error('Worker lease belongs to another principal.'), { status: 403 });
      const inbox = await finalizeAttemptEvidenceUpload(store, leaseRunId, {
        workItemId: body.lease.workItemId,
        workerId: principal.id,
        attempt: body.lease.attempt,
        leaseToken: body.lease.token,
        intentDigest: body.intentDigest,
      });
      const adopted = await adoptAttemptEvidence(store, leaseRunId, coordinator, inbox);
      await maybeCrashAtSharedResilienceBoundary('work-item-adoption');
      return json(response, 202, { workItemId: adopted.id, state: adopted.state, canonicalResult: adopted.canonicalResult });
    }
    if (requestUrl.pathname === '/v1/log') {
      if (body.lease?.workerId !== principal.id) throw Object.assign(new Error('Worker lease belongs to another principal.'), { status: 403 });
      const receipt = await appendAttemptLog(store, leaseRunId, body.lease, {
        sequence: body.sequence,
        level: body.level,
        message: body.message,
      });
      return json(response, 202, receipt);
    }
    return json(response, 404, { error: 'Not found.' });
  } catch (error) {
    const unavailable = [
      'NO_WORK_AVAILABLE', 'NO_COMPATIBLE_WORK', 'NO_PERFORMANCE_WORK',
      'PERFORMANCE_DRAIN_PENDING', 'PERFORMANCE_DRAIN_REQUIRED', 'PERFORMANCE_DRAINING',
      'PERFORMANCE_DRAIN_HELD', 'PERFORMANCE_LEASE_HELD', 'PERFORMANCE_RECOVERY_PENDING',
    ].includes(error?.code);
    const conflict = unavailable || error?.code === 'ATTEMPT_UPLOAD_CONFLICT';
    json(response, error?.status ?? (conflict ? 409 : 400), { code: error?.code ?? 'SHARED_COORDINATOR_REQUEST_INVALID', error: error?.message ?? 'Request failed.' });
  }
});
server.requestTimeout = uploadTimeoutMs + 30_000;
server.headersTimeout = 60_000;
server.maxHeadersCount = 64;
await maintain();
server.listen(port, '0.0.0.0', () => process.stdout.write(`${JSON.stringify({
  event: 'shared-coordinator-listening', port, state: supervisor.status().state, epoch: supervisor.status().epoch,
})}\n`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(heartbeat);
    server.close(() => process.exit());
  });
}
