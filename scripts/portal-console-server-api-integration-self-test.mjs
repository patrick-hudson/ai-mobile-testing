import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalJson,
  claimJob,
  openJobQueue,
  settleJobAttempt,
  sha256,
  submitJob,
} from './lib/job-queue.mjs';
import { buildSingleSiteReportDocuments } from './lib/site-health-report.mjs';
import {
  loadComparativeReportPublication,
  loadSingleSiteReportPublication,
} from '../portal/report-publication.mjs';

const generatedAt = '2026-08-26T15:00:00.000Z';
const temporary = await fs.mkdtemp(path.join(tmpdir(), 'portal-console-server-api-'));
let child;

try {
  const runRoot = path.join(temporary, 'runs');
  const shardedRoot = path.join(temporary, 'sharded');
  const queueRoot = path.join(temporary, 'queue');
  const finalizationRoot = path.join(temporary, 'finalizations');
  const comparativeId = 'comparative-console-fixture';
  const comparativeRoot = path.join(runRoot, comparativeId);
  await Promise.all([runRoot, shardedRoot, finalizationRoot].map((directory) => fs.mkdir(directory, { recursive: true })));

  const comparativeRevision = '1'.repeat(32);
  await writePublication(comparativeRoot, comparativeRevision, 'comparative', comparativeDocuments(comparativeRevision));
  await fs.mkdir(path.join(comparativeRoot, 'logs'), { recursive: true });
  await fs.writeFile(path.join(comparativeRoot, 'large-evidence.bin'), Buffer.alloc(8 * 1024 * 1024, 0x5a));
  await fs.writeFile(path.join(comparativeRoot, 'run.json'), `${JSON.stringify({
    id: comparativeId,
    status: 'failed',
    phase: 'Report published',
    createdAt: generatedAt,
    startedAt: generatedAt,
    finishedAt: '2026-08-26T15:01:00.000Z',
    options: {
      productionUrl: 'https://production.example',
      candidateUrl: 'https://candidate.example',
      targetIds: ['candidate-desktop-chromium'],
      profile: 'release',
    },
    progress: { total: 1, completed: 1, passed: 0, failed: 1, flaky: 0, skipped: 0 },
    stages: {
      videoProcessing: { status: 'failed' },
      reportRebuild: { status: 'completed' },
    },
    pipeline: { status: 'completed', completed: true, finishedAt: '2026-08-26T15:01:00.000Z' },
  })}\n`);

  const queue = await openJobQueue({ root: queueRoot, verifyStorage: false });
  const input = { schemaVersion: 1, fixture: 'console-server-api' };
  const submitted = await submitJob(queue, queueSubmission(input), { inputDocument: input });
  const claim = await claimJob(queue, submitted.state.jobId, 'console-server-api-worker');
  const state = await settleJobAttempt(queue, claim, {
    kind: 'failed', reason: 'Synthetic terminal state for console publication integration.',
  });
  const finalizationDigest = '2'.repeat(64);
  const singleRevision = finalizationDigest.slice(0, 32);
  const singleReportRoot = path.join(finalizationRoot, state.jobId, 'report');
  await writePublication(
    singleReportRoot,
    singleRevision,
    'single-site',
    buildSingleSiteReportDocuments(singleSiteInput(), { publicationRevision: singleRevision }).documents,
  );
  const singlePublication = await loadSingleSiteReportPublication(singleReportRoot, singleRevision);
  const statusBody = {
    schemaVersion: 1,
    kind: 'single-site-finalization-status',
    jobId: state.jobId,
    status: 'complete',
    deadlineExceeded: false,
    executionState: 'failed',
    finalizationDigest,
    failureDigest: null,
    reportRevision: singleRevision,
    reportPublicationDigest: singlePublication.publicationDigest,
    visualPublicationDigest: `sha256:${'3'.repeat(64)}`,
    visualEligibilityManifestDigest: `sha256:${'4'.repeat(64)}`,
  };
  await fs.writeFile(path.join(finalizationRoot, state.jobId, 'status.json'), `${JSON.stringify({
    ...statusBody,
    statusDigest: digestCanonical(statusBody),
  })}\n`);

  // Prove the Comparative fixture is descriptor-valid before exercising the server path.
  await loadComparativeReportPublication(comparativeRoot, comparativeRevision);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const operatorToken = 'portal-console-integration-operator-token-0000000000000001';
  child = spawn(process.execPath, ['portal/server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PORTAL_ARTIFACT_ROOT: runRoot,
      PORTAL_SHARDED_ARTIFACT_ROOT: shardedRoot,
      PORTAL_SINGLE_SITE_QUEUE_ROOT: queueRoot,
      PORTAL_SINGLE_SITE_FINALIZATION_ROOT: finalizationRoot,
      PORTAL_VISUAL_BASELINE_ROOT: path.join(temporary, 'baselines'),
      PORTAL_SECRET_ROOT: path.join(temporary, 'secrets'),
      PORTAL_E2E_FAILURE_INJECTION: '1',
      PORTAL_E2E_OPERATOR_TOKEN: operatorToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  await waitForHealth(baseUrl, child, () => stderr);

  const endpoints = ['overview', 'runs', 'attention', 'evidence'];
  let publicationsVisible = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const responses = await Promise.all(endpoints.map(async (endpoint) => {
      const response = await fetch(`${baseUrl}/api/console/v1/${endpoint}?mode=all&scope=all&limit=100`);
      assert.equal(response.status, 200, `${endpoint} must be served by the real console API.`);
      return response.json();
    }));
    const [overview, runs, attention, evidence] = responses;
    const allItems = responses.flatMap((body) => body.data.items);
    const modes = new Set(allItems.map(({ mode }) => mode));
    publicationsVisible = modes.has('comparative') && modes.has('single-site')
      && runs.data.items.some(({ runId }) => runId === comparativeId)
      && runs.data.items.some(({ runId }) => runId === state.jobId)
      && attention.data.items.some(({ mode }) => mode === 'comparative')
      && attention.data.items.some(({ mode }) => mode === 'single-site')
      && evidence.data.items.some(({ mode }) => mode === 'comparative')
      && evidence.data.items.some(({ mode }) => mode === 'single-site')
      && overview.data.overview.latestTerminalRun !== null;
    if (publicationsVisible) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(publicationsVisible, true,
    `Seeded Comparative and Single-site publications did not flow through every console endpoint. ${stderr}`);

  const stableBefore = await fetch(`${baseUrl}/api/console/v1/runs?mode=all&scope=all&limit=100`).then((response) => response.json());
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  const stableAfter = await fetch(`${baseUrl}/api/console/v1/runs?mode=all&scope=all&limit=100`).then((response) => response.json());
  assert.equal(stableAfter.sourceVector.vectorRevision, stableBefore.sourceVector.vectorRevision,
    'Idle authoritative refreshes must not bump the console source vector when indexed content is unchanged.');
  assert.equal(stableAfter.sourceVector.indexRevision, stableBefore.sourceVector.indexRevision,
    'Idle authoritative refreshes must keep existing cursors/cache bindings stable.');

  let transferSettled = false;
  const slowTransfer = fetch(`${baseUrl}/artifacts/${comparativeId}/large-evidence.bin`, {
    headers: {
      range: 'bytes=0-8388607',
      'x-portal-e2e-send-file-delay-ms': '1000',
    },
  }).then(async (response) => {
    await response.arrayBuffer();
    return 'completed';
  }, () => 'closed').finally(() => { transferSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const purgeResponse = await fetch(`${baseUrl}/api/runs/${comparativeId}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      'x-portal-operator-token': operatorToken,
    },
    body: JSON.stringify({ confirmation: `PURGE ${comparativeId}` }),
  });
  assert.equal(purgeResponse.status, 200, await purgeResponse.text());
  assert.equal(transferSettled, true, 'DELETE must await closure of an already-open ranged evidence transfer');
  assert.equal(await slowTransfer, 'closed', 'purge must terminate the ranged evidence transfer before acknowledging deletion');
  const afterPurge = await fetch(`${baseUrl}/artifacts/${comparativeId}/large-evidence.bin`);
  assert([404, 410].includes(afterPurge.status), 'purged evidence must be unreadable after DELETE resolves');
  process.stdout.write('Portal console server API integration self-test passed.\n');
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await fs.rm(temporary, { recursive: true, force: true });
}

async function writePublication(root, revision, mode, documents) {
  const directory = path.join(root, 'checklist', 'data', 'revisions', revision);
  await fs.mkdir(directory, { recursive: true });
  const sources = new Map([...documents].map(([relativePath, document]) => [relativePath, `${JSON.stringify(document)}\n`]));
  for (const [relativePath, source] of sources) {
    const destination = path.join(directory, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, source);
  }
  const publication = {
    schemaVersion: 1,
    ...(mode === 'single-site' ? { kind: 'single-site-report-publication', mode } : {}),
    publicationRevision: revision,
    generatedAt,
    files: Object.fromEntries([...sources].map(([relativePath, source]) => [relativePath, {
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
    }])),
  };
  const pointer = `${JSON.stringify(publication)}\n`;
  await fs.writeFile(path.join(directory, 'publication.json'), pointer);
  await fs.mkdir(path.join(root, 'checklist', 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'checklist', 'data', 'current.json'), pointer);
}

function comparativeDocuments(revision) {
  const finding = {
    auditId: 'NAV-001', auditTitle: 'Navigation', area: 'navigation', severity: 'P0', blocking: true,
    releaseBlocking: true, title: 'Navigation failed', detail: 'Back navigation lost state.',
    environment: 'candidate', coveredEnvironments: ['candidate'],
  };
  const audit = {
    id: 'NAV-001', area: 'navigation', title: 'Navigation', severity: 'P0', releaseBlocking: true,
    status: 'FAIL', reason: 'Navigation failed.', manual: false,
    baseline: { hasIssues: false, issueCount: 0, note: 'No baseline issue.' },
    evidenceCounts: { video: 1, screenshot: 0, trace: 0, axe: 0, network: 0, lighthouse: 0, json: 0, other: 0 },
    findingCount: 1, findingPreview: [finding], executionCount: 1,
  };
  return new Map([
    ['summary.json', {
      schemaVersion: 1, publicationRevision: revision, generatedAt,
      run: { status: 'failed', durationMs: 60_000 },
      release: { decision: 'NOT_READY', reason: 'Finding.', decisionBasis: 'Published authority.', runIntegrityFailure: false, authoritativeReleaseSource: 'checklist/manifest.json' },
      summary: { total: 1, artifacts: 1, baselineIssues: 0, byStatus: { FLAKY: 0 } },
      manualEvidence: { required: 0, complete: 0, outstanding: 0, failedOrBlocked: 0 },
      topFindings: [finding], topFindingCount: 1, topAttention: [], topAttentionCount: 0, warnings: [],
    }],
    ['audits.json', { schemaVersion: 1, publicationRevision: revision, generatedAt, items: [audit] }],
    ['audits/NAV-001.json', {
      schemaVersion: 1, publicationRevision: revision, generatedAt, ...audit,
      executionReturned: 1, executionsTruncated: false, findings: [finding], findingsTruncated: false,
      executions: [{
        id: 'nav-1', title: 'Navigation execution', project: 'candidate-desktop-chromium', status: 'FAIL', rawStatus: 'failed',
        evidenceAuthority: 'authoritative', reasonCodes: ['assertion-failure'], retry: 0, durationMs: 1_000,
        startedAt: generatedAt, attemptHistory: [{ attempt: 1, retry: 0, status: 'failed' }],
        artifacts: [{ name: 'interaction.webm', kind: 'video', href: 'attachments/interaction.webm', available: true }],
        evidence: { steps: [{ name: 'Use Back', expected: 'State remains.', status: 'failed', detail: 'State was lost.' }] },
      }],
    }],
  ]);
}

function singleSiteInput() {
  return {
    schemaVersion: 1, mode: 'single-site', generatedAt, pageSize: 10,
    health: {
      schemaVersion: 1, mode: 'single-site', url: 'https://preview.example', deploymentRole: 'preview',
      scope: { qualifier: 'TARGETED', selectedCoverage: ['NAV-001'], omittedCoverage: [] },
      coverage: { finalized: true, manifestIntegrity: true, gaps: ['NAV-001 requires review.'], limitations: [] },
      pipeline: { executionStatus: 'completed', integrityComplete: true, requiredEvidenceComplete: true, reason: 'Complete.', cancellationReason: null },
      evidenceAuthority: { status: 'authoritative', reasons: [] },
      findings: [{ id: 'single-finding', severity: 'P1' }],
      manual: { required: 0, complete: 0, failedOrBlocked: 0 },
      visualReview: { items: [{ status: 'CHANGED' }] },
    },
    audits: [{
      id: 'NAV-001', title: 'Navigation', area: 'navigation', status: 'FAIL', findingCount: 1,
      evidenceStatus: 'complete', artifactCount: 1, manual: false, visualStatus: 'CHANGED', detail: 'Finding published.',
    }],
    outsideMode: [],
  };
}

function queueSubmission(input) {
  const value = (label) => sha256(`console-server-api-${label}`);
  return {
    idempotencyKey: 'console-server-api', runMode: 'single-site', inputDocumentDigest: sha256(canonicalJson(input)),
    runContractDigest: value('contract'), compiledManifestDigest: value('manifest'), preflightDigest: value('preflight'),
    identityFingerprint: value('identity'), revisionFingerprint: value('revision'),
    evidenceAuthority: { authoritative: true, reasons: [] }, registryRevision: 'registry-v1',
    targetSetRevision: 'targets-v1', runnerRevision: 'runner-v1',
    stageDeadlines: { browser: '2099-01-01T00:10:00.000Z', finalizer: '2099-01-01T00:20:00.000Z' },
  };
}

function digestCanonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForHealth(baseUrl, processHandle, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Portal exited before health check: ${stderr()}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Portal did not become healthy: ${stderr()}`);
}
