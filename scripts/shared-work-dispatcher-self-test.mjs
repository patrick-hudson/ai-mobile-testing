import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditCaseTag } from '../shared/audit-case-identity.mjs';
import { sealWorkExecutionDescriptor } from '../shared/work-execution-descriptor.mjs';
import { createSharedWorkCommand, sharedWorkExecutorPath } from './lib/shared-work-dispatcher.mjs';
import { collectSharedPlaywrightArtifacts, validateSharedPlaywrightRows } from './lib/shared-playwright-work-item.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const descriptor = sealWorkExecutionDescriptor({
  workItemId: 'work-comparative-a11y', subjectCoreDigest: digest('a'), runnerRevision: digest('b'),
  mode: 'comparative', operation: 'playwright', definitionId: 'A11Y-001',
  pluginId: 'accessibility-responsive-performance-reliability',
  caseId: 'A11Y-001:tests/accessibility.spec.ts:candidate-chromium-projects',
  entrySpec: 'tests/accessibility.spec.ts', targetId: 'candidate-mobile-chromium', targetRole: 'candidate',
  capability: 'browser:chromium', resourceClass: 'ordinary',
  origins: { candidate: 'https://candidate.example.test', production: 'https://production.example.test' },
  certificatePolicy: 'strict', route: null,
});
const lease = {
  runId: 'run-dispatcher-test', workItemId: descriptor.workItemId, workerId: 'worker-a', attempt: 1,
  epoch: 3, token: 'lease-token', claimedAt: '2026-08-29T00:00:00.000Z', expiresAt: '2026-08-29T00:01:00.000Z',
  subjectCoreDigest: descriptor.subjectCoreDigest, runnerRevision: descriptor.runnerRevision,
  capability: descriptor.capability, resourceClass: descriptor.resourceClass, targetId: descriptor.targetId,
  specAffinity: descriptor.entrySpec, executionDescriptor: descriptor, executionDescriptorDigest: descriptor.digest,
};

const command = createSharedWorkCommand(lease, '/tmp/shared-dispatcher-evidence', {
  PATH: '/usr/bin', NODE_EXTRA_CA_CERTS: '/work/certs/netskope.pem',
  AUDIT_SHARED_WORKER_TOKEN_FILE: '/run/secrets/shared-worker/token',
  ANTHROPIC_API_KEY: 'must-not-cross-the-worker-boundary',
});
assert.equal(command.executable, process.execPath);
assert.deepEqual(command.args, [sharedWorkExecutorPath]);
assert.equal(path.basename(command.args[0]), 'execute-shared-work-item.mjs');
assert.equal(command.environment.NODE_EXTRA_CA_CERTS, '/work/certs/netskope.pem');
assert(!('AUDIT_SHARED_WORKER_TOKEN_FILE' in command.environment));
assert(!('ANTHROPIC_API_KEY' in command.environment));
assert.equal(JSON.parse(command.environment.AUDIT_SHARED_RESULT_IDENTITY).executionDescriptorDigest, descriptor.digest);
assert.throws(() => createSharedWorkCommand({ ...lease, targetId: 'production-mobile-chromium' }, '/tmp/evidence'),
  /does not match the active work lease/);
assert.throws(() => createSharedWorkCommand({ ...lease, executionDescriptor: null }, '/tmp/evidence'),
  /lacks a compiler-issued execution descriptor/);
assert.throws(() => createSharedWorkCommand(lease, '/tmp/evidence', { AUDIT_SHARED_RESILIENCE_PROOF: 'yes' }),
  /must be exactly 0 or 1/);
assert.throws(() => createSharedWorkCommand(lease, '/tmp/evidence', { AUDIT_SHARED_RESILIENCE_PROOF: '1' }),
  /proof fixture must be used together/);
const { schemaVersion: _schemaVersion, kind: _kind, digest: _descriptorDigest, ...descriptorInput } = descriptor;
assert.throws(() => sealWorkExecutionDescriptor({ ...descriptorInput, entrySpec: '../outside.spec.ts' }), /repository-owned spec/);
const genericDescriptorInput = {
  ...descriptorInput,
  workItemId: 'generic-route-work',
  mode: 'single-site',
  definitionId: 'ENV-002',
  caseId: 'GENERIC-ROUTE-AAAAAAAAAAAAAAAAAAAAAAAA',
  entrySpec: 'tests/single-site-generic-route.spec.ts',
  targetId: 'single-site-mobile-chromium',
  targetRole: 'preview',
  origins: { candidate: 'https://beta.example.test', production: null },
  route: {
    inventoryDigest: digest('e'),
    url: 'https://beta.example.test/discovered',
    path: '/discovered',
    sources: [{ source: 'sitemap', from: 'https://beta.example.test/sitemap.xml', depth: 0 }],
    productOracleVariant: 'generic-page-inspection-v1',
  },
};
const genericDescriptor = sealWorkExecutionDescriptor(genericDescriptorInput);
assert.equal(genericDescriptor.route.sources[0].source, 'sitemap');
assert.throws(() => sealWorkExecutionDescriptor({
  ...genericDescriptorInput,
  route: { ...genericDescriptorInput.route, url: 'https://other.example.test/discovered' },
}), /URL and path bindings disagree/);
assert.throws(() => sealWorkExecutionDescriptor({
  ...genericDescriptorInput,
  route: { ...genericDescriptorInput.route, sources: [] },
}), /discovery provenance/);
const proofDescriptor = sealWorkExecutionDescriptor({
  ...descriptorInput,
  workItemId: 'proof-001',
  mode: 'single-site',
  definitionId: 'U4P-001',
  pluginId: null,
  caseId: 'U4P-001:shared-docker-resilience',
  entrySpec: 'tests/fixtures/shared-docker-resilience.spec.ts',
  targetId: 'single-site-mobile-chromium',
  targetRole: 'preview',
  origins: { candidate: 'https://proof.invalid', production: null },
});
const proofLease = {
  ...lease,
  workItemId: proofDescriptor.workItemId,
  subjectCoreDigest: proofDescriptor.subjectCoreDigest,
  runnerRevision: proofDescriptor.runnerRevision,
  targetId: proofDescriptor.targetId,
  specAffinity: proofDescriptor.entrySpec,
  executionDescriptor: proofDescriptor,
  executionDescriptorDigest: proofDescriptor.digest,
};
assert.equal(createSharedWorkCommand(proofLease, '/tmp/evidence', {
  AUDIT_SHARED_RESILIENCE_PROOF: '1',
}).environment.AUDIT_SHARED_RESILIENCE_PROOF, '1');
assert.throws(() => createSharedWorkCommand(proofLease, '/tmp/evidence'), /proof fixture must be used together/);

function report(statuses, overrides = {}) {
  const artifactRoot = overrides.artifactRoot ?? '/evidence';
  const policy = overrides.policy ?? { mode: 'static-screenshot', rationale: 'Capture the exact rendered accessibility state for review.' };
  const summary = (caseId = overrides.summaryCaseId ?? descriptor.caseId) => Buffer.from(JSON.stringify({
    schemaVersion: 1,
    caseId,
    auditId: descriptor.definitionId,
    coveredEnvironments: ['candidate'],
    environment: 'candidate',
    baseURL: descriptor.origins.candidate,
    project: overrides.projectName ?? descriptor.targetId,
    findings: [],
    steps: [],
  })).toString('base64');
  return {
    suites: [{ title: 'fixture', file: descriptor.entrySpec, specs: [{ title: 'fixture audit', file: 'fixtures/test.ts',
      tags: [auditCaseTag(overrides.caseId ?? descriptor.caseId).slice(1)], tests: statuses.map((status, index) => ({
      title: `row ${index + 1}`, projectName: overrides.projectName ?? descriptor.targetId,
      annotations: [
        { type: 'audit-case-id', description: overrides.caseId ?? descriptor.caseId },
        { type: 'audit-evidence-policy', description: JSON.stringify(policy) },
      ],
      results: [{
        status,
        retry: overrides.retry ?? 0,
        attachments: [
          { name: 'audit-result', contentType: 'application/json', path: `${artifactRoot}/raw/row-${index + 1}/audit-result.json` },
          { name: 'audit-result-summary', contentType: 'application/json', body: summary() },
          ...(overrides.missingMedia ? [] : [{ name: 'rendered-accessibility-state', contentType: 'image/png', path: `${artifactRoot}/raw/row-${index + 1}/state.png` }]),
        ],
      }],
    })) }], suites: [] }],
    errors: overrides.errors ?? [],
  };
}

assert.equal(validateSharedPlaywrightRows(report(['passed']), descriptor).outcome, 'completed_pass');
assert.equal(validateSharedPlaywrightRows(report(['failed']), descriptor).outcome, 'completed_product_failure');
assert.throws(() => validateSharedPlaywrightRows(report(['passed', 'passed']), descriptor), /exactly one canonical/);
assert.throws(() => validateSharedPlaywrightRows(report([]), descriptor), /published no row/);
assert.throws(() => validateSharedPlaywrightRows(report(['passed'], { projectName: 'production-mobile-chromium' }), descriptor), /escaped its compiler-issued/);
assert.throws(() => validateSharedPlaywrightRows(report(['passed'], { caseId: 'OTHER-001' }), descriptor), /escaped its compiler-issued/);
assert.throws(() => validateSharedPlaywrightRows(report(['passed'], { retry: 1 }), descriptor), /zero-retry/);
assert.throws(() => validateSharedPlaywrightRows(report(['skipped']), descriptor), /terminal product outcome/);
assert.throws(() => validateSharedPlaywrightRows(report(['passed'], { errors: [{ message: 'global failure' }] }), descriptor), /reported errors outside/);
assert.throws(() => validateSharedPlaywrightRows(report(['passed'], { missingMedia: true }), descriptor), /required static screenshot/);
assert.throws(() => validateSharedPlaywrightRows(report(['passed'], { summaryCaseId: 'OTHER-001' }), descriptor), /summary.*identity/i);

const evidenceRoot = await mkdtemp(path.join(tmpdir(), 'shared-playwright-artifacts-'));
try {
  const artifactRoot = path.join(evidenceRoot, 'playwright');
  const rowRoot = path.join(artifactRoot, 'raw', 'row-1');
  await mkdir(rowRoot, { recursive: true });
  const document = report(['passed'], { artifactRoot });
  const row = validateSharedPlaywrightRows(document, descriptor).rows[0];
  const summary = JSON.parse(Buffer.from(row.attachments.find(({ name }) => name === 'audit-result-summary').body, 'base64').toString('utf8'));
  await writeFile(path.join(rowRoot, 'audit-result.json'), `${JSON.stringify({
    ...summary,
    definition: { id: descriptor.definitionId },
    evidencePolicy: row.evidencePolicy,
    browser: 'Chromium', viewport: { width: 1440, height: 900 }, timezone: 'America/Chicago',
    startedAt: '2026-08-29T00:00:00.000Z', finishedAt: '2026-08-29T00:00:01.000Z',
    observations: [], pageInspections: [], consoleErrors: [], consoleWarnings: [], pageErrors: [],
    httpResponses: [], failedRequests: [], badResponses: [], runtimeExpectations: [], thirdPartyTelemetryDiagnostics: [],
  })}\n`);
  await writeFile(path.join(rowRoot, 'state.png'), Buffer.from('purposeful-static-image'));
  const collected = await collectSharedPlaywrightArtifacts({ document, descriptor, artifactRoot, evidenceRoot });
  assert.equal(collected.artifacts[0].path, 'playwright/raw/row-1/audit-result.json');
  assert.match(collected.artifacts[1].path, /^playwright\/inline\/row-1\/attachment-2-[a-f0-9]{16}\.json$/);
  assert.equal(collected.artifacts[2].path, 'playwright/raw/row-1/state.png');
  assert.equal(JSON.stringify(collected.rows).includes(artifactRoot), false);
  assert.equal(collected.rows[0].attachments.every(({ path: artifactPath }) => !artifactPath.startsWith('/')), true);
  const escaped = structuredClone(document);
  escaped.suites[0].specs[0].tests[0].results[0].attachments[0].path = '/tmp/outside-audit-result.json';
  await assert.rejects(
    collectSharedPlaywrightArtifacts({ document: escaped, descriptor, artifactRoot, evidenceRoot }),
    /escaped its attempt artifact root/,
  );
} finally {
  await rm(evidenceRoot, { recursive: true, force: true });
}

const discoveryRoot = await mkdtemp(path.join(tmpdir(), 'shared-proof-discovery-'));
const listTests = async (name, environment) => {
  const outputPath = path.join(discoveryRoot, `${name}.json`);
  const result = spawnSync(process.execPath, [
    './node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter=json',
  ], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...environment, PLAYWRIGHT_JSON_OUTPUT_FILE: outputPath },
    encoding: 'utf8',
    maxBuffer: 16 * 1_048_576,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(await readFile(outputPath, 'utf8'));
};
const discoveredFiles = (suites) => suites.flatMap((suite) => [suite.file, ...discoveredFiles(suite.suites ?? [])]);
const ordinaryList = await listTests('ordinary', {
  AUDIT_RUN_MODE: 'comparative',
  AUDIT_SHARED_RESILIENCE_PROOF: '0',
  CANDIDATE_IGNORE_HTTPS_ERRORS: '0',
});
assert(!discoveredFiles(ordinaryList.suites).includes('tests/fixtures/shared-docker-resilience.spec.ts'),
  'ordinary Comparative discovery must exclude the isolated Docker proof fixture');
const proofList = await listTests('proof', {
  AUDIT_RUN_MODE: 'single-site',
  AUDIT_SHARED_RESILIENCE_PROOF: '1',
  AUDIT_TARGET_IDS: 'single-site-mobile-chromium',
  AUDIT_SINGLE_SITE_URL: 'https://proof.invalid',
  AUDIT_SINGLE_SITE_ROLE: 'preview',
  AUDIT_SINGLE_SITE_CERTIFICATE_POLICY: 'strict',
  AUDIT_SINGLE_SITE_EGRESS_PROXY: 'http://127.0.0.1:1',
  CANDIDATE_IGNORE_HTTPS_ERRORS: '0',
});
assert(discoveredFiles(proofList.suites).includes('tests/fixtures/shared-docker-resilience.spec.ts'),
  'proof mode must retain the isolated Docker fixture');
await rm(discoveryRoot, { recursive: true, force: true });

const processRoot = await mkdtemp(path.join(tmpdir(), 'shared-worker-process-'));
const credentialPath = path.join(processRoot, 'worker-token');
await writeFile(credentialPath, `amt.test.${'a'.repeat(40)}\n`, { mode: 0o600 });
let claimCount = 0;
const receivedLogs = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1/claim' && claimCount++ === 0) {
    response.statusCode = 200;
    response.end(`${JSON.stringify({
      runId: 'run-worker-process', workItemId: 'work-invalid-binding', workerId: 'worker-process', attempt: 1,
      epoch: 1, token: 'lease-invalid-binding', claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1_000).toISOString(), subjectCoreDigest: digest('a'), runnerRevision: digest('b'),
      capability: 'browser:chromium', resourceClass: 'ordinary', targetId: 'candidate-mobile-chromium',
      specAffinity: 'tests/accessibility.spec.ts', executionDescriptor: null, executionDescriptorDigest: null,
    })}\n`);
    return;
  }
  if (request.url === '/v1/log') {
    receivedLogs.push(body);
    response.statusCode = 202;
    response.end('{}\n');
    return;
  }
  response.statusCode = 409;
  response.end('{"code":"NO_WORK_AVAILABLE","error":"no work"}\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const worker = spawn(process.execPath, ['scripts/run-shared-worker.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    AUDIT_SHARED_COORDINATOR_URL: `http://127.0.0.1:${address.port}`,
    AUDIT_SHARED_WORKER_TOKEN_FILE: credentialPath,
    AUDIT_SHARED_RESOURCE_CLASS: 'ordinary',
    AUDIT_SHARED_WORKER_CAPABILITIES: 'browser:chromium',
    AUDIT_SHARED_POLL_MS: '100',
    AUDIT_SHARED_RESILIENCE_PROOF: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let workerStderr = '';
worker.stderr.setEncoding('utf8');
worker.stderr.on('data', (chunk) => { workerStderr += chunk; });
try {
  const deadline = Date.now() + 5_000;
  while (receivedLogs.length < 2 && worker.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(worker.exitCode, null, `descriptor binding error terminated the worker: ${workerStderr}`);
  assert.deepEqual(receivedLogs.map(({ sequence, level }) => ({ sequence, level })), [
    { sequence: 1, level: 'info' },
    { sequence: 2, level: 'warn' },
  ]);
  assert.match(receivedLogs[1].message, /operational-recovery: work-descriptor-invalid/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(claimCount, 1, 'the worker must not claim another item before the rejected lease expires');
} finally {
  worker.kill('SIGTERM');
  await new Promise((resolve) => worker.once('close', resolve));
  await new Promise((resolve) => server.close(resolve));
  await rm(processRoot, { recursive: true, force: true });
}

process.stdout.write('Shared work dispatcher self-test passed: fixed repository command, secret-free child environment, descriptor fencing, and exact Playwright row validation are enforced.\n');
