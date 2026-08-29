import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
const { schemaVersion: _schemaVersion, kind: _kind, digest: _descriptorDigest, ...descriptorInput } = descriptor;
assert.throws(() => sealWorkExecutionDescriptor({ ...descriptorInput, entrySpec: '../outside.spec.ts' }), /repository-owned spec/);

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

process.stdout.write('Shared work dispatcher self-test passed: fixed repository command, secret-free child environment, descriptor fencing, and exact Playwright row validation are enforced.\n');
