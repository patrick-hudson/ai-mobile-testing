import assert from 'node:assert/strict';
import path from 'node:path';
import { auditCaseTag } from '../shared/audit-case-identity.mjs';
import { sealWorkExecutionDescriptor } from '../shared/work-execution-descriptor.mjs';
import { createSharedWorkCommand, sharedWorkExecutorPath } from './lib/shared-work-dispatcher.mjs';
import { validateSharedPlaywrightRows } from './lib/shared-playwright-work-item.mjs';

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
  return {
    suites: [{ title: 'fixture', file: descriptor.entrySpec, specs: [{ title: 'fixture audit', file: 'fixtures/test.ts',
      tags: [auditCaseTag(overrides.caseId ?? descriptor.caseId).slice(1)], tests: statuses.map((status, index) => ({
      title: `row ${index + 1}`, projectName: overrides.projectName ?? descriptor.targetId,
      annotations: [{ type: 'audit-case-id', description: overrides.caseId ?? descriptor.caseId }],
      results: [{ status, retry: overrides.retry ?? 0 }],
    })) }], suites: [] }],
    errors: overrides.errors ?? [],
  };
}

assert.equal(validateSharedPlaywrightRows(report(['passed', 'passed']), descriptor).outcome, 'completed_pass');
assert.equal(validateSharedPlaywrightRows(report(['passed', 'failed']), descriptor).outcome, 'completed_product_failure');
assert.throws(() => validateSharedPlaywrightRows(report([]), descriptor), /published no row/);
assert.throws(() => validateSharedPlaywrightRows(report(['passed'], { projectName: 'production-mobile-chromium' }), descriptor), /escaped its compiler-issued/);
assert.throws(() => validateSharedPlaywrightRows(report(['passed'], { caseId: 'OTHER-001' }), descriptor), /escaped its compiler-issued/);
assert.throws(() => validateSharedPlaywrightRows(report(['passed'], { retry: 1 }), descriptor), /zero-retry/);
assert.throws(() => validateSharedPlaywrightRows(report(['skipped']), descriptor), /terminal product outcome/);
assert.throws(() => validateSharedPlaywrightRows(report(['passed'], { errors: [{ message: 'global failure' }] }), descriptor), /reported errors outside/);

process.stdout.write('Shared work dispatcher self-test passed: fixed repository command, secret-free child environment, descriptor fencing, and exact Playwright row validation are enforced.\n');
