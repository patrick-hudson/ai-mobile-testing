import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditCaseTag } from '../shared/audit-case-identity.mjs';
import { sealOracleResult, sealWorkItemResult } from '../shared/execution-contract.mjs';
import { sealWorkExecutionDescriptor } from '../shared/work-execution-descriptor.mjs';
import { createSharedWorkCommand, sharedWorkExecutorPath } from './lib/shared-work-dispatcher.mjs';
import {
  collectSharedPlaywrightArtifacts,
  readContainedPlaywrightAttachment,
  validateSharedPlaywrightRows,
} from './lib/shared-playwright-work-item.mjs';
import { buildSharedWorkerResultManifest } from './execute-shared-work-item.mjs';

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
const visualDescriptor = sealWorkExecutionDescriptor({
  ...Object.fromEntries(Object.entries(descriptor).filter(([key]) => !['schemaVersion', 'kind', 'digest'].includes(key))),
  workItemId: 'work-visual-content',
  definitionId: 'CONTENT-002',
  caseId: 'CONTENT-002:tests/visual-regression.spec.ts:candidate-projects',
  entrySpec: 'tests/visual-regression.spec.ts',
});
const productionDescriptor = sealWorkExecutionDescriptor({
  ...Object.fromEntries(Object.entries(descriptor).filter(([key]) => !['schemaVersion', 'kind', 'digest'].includes(key))),
  workItemId: 'work-comparative-a11y-production',
  targetId: 'production-mobile-chromium',
  targetRole: 'production',
});
const lease = {
  runId: 'run-dispatcher-test', workItemId: descriptor.workItemId, workerId: 'worker-a', attempt: 1,
  epoch: 3, token: 'lease-token', claimedAt: '2026-08-29T00:00:00.000Z', expiresAt: '2026-08-29T00:01:00.000Z',
  subjectCoreDigest: descriptor.subjectCoreDigest, runnerRevision: descriptor.runnerRevision,
  capability: descriptor.capability, resourceClass: descriptor.resourceClass, targetId: descriptor.targetId,
  specAffinity: descriptor.entrySpec, executionDescriptor: descriptor, executionDescriptorDigest: descriptor.digest,
};

const workerEnvironment = {
  PATH: '/usr/bin', NODE_EXTRA_CA_CERTS: '/work/certs/netskope.pem',
  AUDIT_RUNNER_REVISION: `image:${descriptor.runnerRevision}`,
  AUDIT_SHARED_WORKER_TOKEN_FILE: '/run/secrets/shared-worker/token',
  ANTHROPIC_API_KEY: 'must-not-cross-the-worker-boundary',
};
const command = createSharedWorkCommand(lease, '/tmp/shared-dispatcher-evidence', workerEnvironment);
assert.equal(command.executable, process.execPath);
assert.deepEqual(command.args, [sharedWorkExecutorPath]);
assert.equal(path.basename(command.args[0]), 'execute-shared-work-item.mjs');
assert.equal(command.environment.NODE_EXTRA_CA_CERTS, '/work/certs/netskope.pem');
assert.equal(command.environment.AUDIT_RUNNER_REVISION, `image:${descriptor.runnerRevision}`,
  'The executor must retain the immutable image revision while the lease remains bound to its canonical digest.');
assert(!('AUDIT_SHARED_WORKER_TOKEN_FILE' in command.environment));
assert(!('ANTHROPIC_API_KEY' in command.environment));
assert.equal(JSON.parse(command.environment.AUDIT_SHARED_RESULT_IDENTITY).executionDescriptorDigest, descriptor.digest);
assert.throws(() => createSharedWorkCommand({ ...lease, targetId: 'production-mobile-chromium' }, '/tmp/evidence', workerEnvironment),
  /does not match the active work lease/);
assert.throws(() => createSharedWorkCommand({ ...lease, executionDescriptor: null }, '/tmp/evidence', workerEnvironment),
  /lacks a compiler-issued execution descriptor/);
assert.throws(() => createSharedWorkCommand(lease, '/tmp/evidence', {
  ...workerEnvironment,
  AUDIT_RUNNER_REVISION: `image:${digest('c')}`,
}), /image revision does not match the active work lease/);
assert.throws(() => createSharedWorkCommand(lease, '/tmp/evidence', {
  ...workerEnvironment, AUDIT_SHARED_RESILIENCE_PROOF: 'yes',
}),
  /must be exactly 0 or 1/);
assert.throws(() => createSharedWorkCommand(lease, '/tmp/evidence', {
  ...workerEnvironment, AUDIT_SHARED_RESILIENCE_PROOF: '1',
}),
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
  AUDIT_RUNNER_REVISION: `image:${proofDescriptor.runnerRevision}`,
  AUDIT_SHARED_RESILIENCE_PROOF: '1',
}).environment.AUDIT_SHARED_RESILIENCE_PROOF, '1');
assert.throws(() => createSharedWorkCommand(proofLease, '/tmp/evidence', workerEnvironment),
  /proof fixture must be used together/);

function report(statuses, overrides = {}) {
  const activeDescriptor = overrides.descriptor ?? descriptor;
  const artifactRoot = overrides.artifactRoot ?? '/evidence';
  const policy = overrides.policy ?? { mode: 'static-screenshot', rationale: 'Capture the exact rendered accessibility state for review.' };
  const summary = (caseId = overrides.summaryCaseId ?? activeDescriptor.caseId) => Buffer.from(JSON.stringify({
    schemaVersion: 1,
    caseId,
    auditId: activeDescriptor.definitionId,
    coveredEnvironments: [activeDescriptor.targetRole],
    environment: activeDescriptor.targetRole,
    baseURL: activeDescriptor.targetRole === 'production'
      ? activeDescriptor.origins.production : activeDescriptor.origins.candidate,
    project: overrides.projectName ?? activeDescriptor.targetId,
    findings: overrides.findings ?? [],
    steps: [],
  })).toString('base64');
  return {
    suites: [{ title: 'fixture', file: activeDescriptor.entrySpec, specs: [{ title: 'fixture audit', file: 'fixtures/test.ts',
      tags: [auditCaseTag(overrides.caseId ?? activeDescriptor.caseId).slice(1)], tests: statuses.map((status, index) => ({
      title: `row ${index + 1}`, projectName: overrides.projectName ?? activeDescriptor.targetId,
      annotations: [
        { type: 'audit-case-id', description: overrides.caseId ?? activeDescriptor.caseId },
        { type: 'audit-evidence-policy', description: JSON.stringify(policy) },
      ],
      results: [{
        status,
        retry: overrides.retry ?? 0,
        errors: status === 'passed' ? [] : (overrides.resultErrors ?? []),
        attachments: [
          { name: 'audit-result', contentType: 'application/json', path: `${artifactRoot}/raw/row-${index + 1}/audit-result.json` },
          { name: 'audit-result-summary', contentType: 'application/json', body: summary() },
          ...(overrides.visualComparison === undefined ? [] : [{
            name: 'shared-visual-comparison-result', contentType: 'application/json',
            path: `${artifactRoot}/raw/row-${index + 1}/shared-visual-comparison-result.json`,
          }]),
          ...(overrides.missingMedia ? [] : [{ name: 'rendered-accessibility-state', contentType: 'image/png', path: `${artifactRoot}/raw/row-${index + 1}/state.png` }]),
        ],
      }],
    })) }], suites: [] }],
    errors: overrides.errors ?? [],
  };
}

async function collectFailureSignature({ activeDescriptor, message, findings = [], badResponses = [] }) {
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), 'shared-semantic-failure-'));
  try {
    const artifactRoot = path.join(evidenceRoot, 'playwright');
    const rowRoot = path.join(artifactRoot, 'raw', 'row-1');
    await mkdir(rowRoot, { recursive: true });
    const document = report(['failed'], {
      descriptor: activeDescriptor,
      artifactRoot,
      findings,
      resultErrors: [{
        message,
        location: { file: '/workspace/fixtures/test.ts', line: 967, column: 5 },
      }],
    });
    const row = validateSharedPlaywrightRows(document, activeDescriptor).rows[0];
    const summary = JSON.parse(Buffer.from(
      row.attachments.find(({ name }) => name === 'audit-result-summary').body, 'base64',
    ).toString('utf8'));
    await writeFile(path.join(rowRoot, 'audit-result.json'), `${JSON.stringify({
      ...summary,
      definition: { id: activeDescriptor.definitionId }, evidencePolicy: row.evidencePolicy,
      browser: 'Chromium', viewport: { width: 1440, height: 900 }, timezone: 'America/Chicago',
      startedAt: '2026-08-29T00:00:00.000Z', finishedAt: '2026-08-29T00:00:01.000Z',
      observations: [], pageInspections: [], consoleErrors: [], consoleWarnings: [], pageErrors: [],
      httpResponses: [], failedRequests: [], badResponses, runtimeExpectations: [], thirdPartyTelemetryDiagnostics: [],
    })}\n`);
    await writeFile(path.join(rowRoot, 'state.png'), Buffer.from('semantic-failure-state'));
    return (await collectSharedPlaywrightArtifacts({
      document, descriptor: activeDescriptor, artifactRoot, evidenceRoot,
    })).productFailureSignature;
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
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
  assert.equal(collected.visualRiskSource.status, 'NOT_APPLICABLE');
  assert.equal(collected.artifacts[0].path, 'playwright/raw/row-1/audit-result.json');
  assert.match(collected.artifacts[1].path, /^playwright\/inline\/row-1\/attachment-2-[a-f0-9]{16}\.json$/);
  assert.equal(collected.artifacts[2].path, 'playwright/raw/row-1/state.png');
  assert.equal(JSON.stringify(collected.rows).includes(artifactRoot), false);
  assert.equal(collected.rows[0].attachments.every(({ path: artifactPath }) => !artifactPath.startsWith('/')), true);

  const longDocument = structuredClone(document);
  const longResultDirectory = 'page-audit--PAGE-MEDICATIO-0073b--a-complete-usable-document-single-site-mobile-chromium';
  const longAttachmentName = `checkpoint-page-medications-supplements-cannabis-thc-in-recovery-rendered-middle-${'a'.repeat(40)}.png`;
  const longAttachmentPath = path.join(artifactRoot, 'raw', longResultDirectory, 'attachments', longAttachmentName);
  const longRelativePath = path.relative(evidenceRoot, longAttachmentPath).split(path.sep).join('/');
  assert.equal(longRelativePath.length, 241,
    'the regression fixture must retain the exact path-length boundary from the live page-audit result');
  await mkdir(path.dirname(longAttachmentPath), { recursive: true });
  await writeFile(longAttachmentPath, Buffer.from('long-playwright-screenshot'));
  longDocument.suites[0].specs[0].tests[0].results[0].attachments[2].path = longAttachmentPath;
  const longCollected = await collectSharedPlaywrightArtifacts({
    document: longDocument, descriptor, artifactRoot, evidenceRoot,
  });
  const boundedScreenshot = longCollected.artifacts.find(({ logicalName }) => logicalName === 'rendered-accessibility-state');
  assert.match(boundedScreenshot.path,
    /^playwright\/published\/row-1\/attachment-3-[a-f0-9]{16}\.png$/);
  assert(boundedScreenshot.path.length <= 240,
    'an overlong Playwright-owned source path must receive a bounded deterministic publication path');
  assert.equal(await readFile(path.join(evidenceRoot, ...boundedScreenshot.path.split('/')), 'utf8'),
    'long-playwright-screenshot');

  const raceDirectory = path.join(artifactRoot, 'raw', 'swap-race');
  const raceCandidate = path.join(raceDirectory, 'state.png');
  const openedFile = path.join(raceDirectory, 'state-opened.png');
  const outsideFile = path.join(evidenceRoot, 'outside-artifact-root.png');
  await mkdir(raceDirectory, { recursive: true });
  await writeFile(raceCandidate, Buffer.from('contained-open-file'));
  await writeFile(outsideFile, Buffer.from('outside-replacement-secret'));
  const raced = await readContainedPlaywrightAttachment(
    raceCandidate,
    await realpath(artifactRoot),
    { afterOpen: async () => {
      await rename(raceCandidate, openedFile);
      await symlink(outsideFile, raceCandidate);
    } },
  );
  assert.equal(raced.bytes.toString(), 'contained-open-file',
    'a pathname replaced after open must still yield bytes from the validated open file descriptor');
  assert.notEqual(raced.bytes.toString(), 'outside-replacement-secret',
    'a swap race must never import bytes from the replacement symlink target');
  assert.equal(raced.realCandidate, await realpath(openedFile));
  await assert.rejects(
    readContainedPlaywrightAttachment(raceCandidate, await realpath(artifactRoot)),
    /could not be opened safely/,
    'a symlink present before open must fail closed under O_NOFOLLOW',
  );

  const duplicateDocument = structuredClone(document);
  duplicateDocument.suites[0].specs[0].tests[0].results[0].attachments.push({
    ...duplicateDocument.suites[0].specs[0].tests[0].results[0].attachments[2],
  });
  const duplicateCollected = await collectSharedPlaywrightArtifacts({
    document: duplicateDocument, descriptor, artifactRoot, evidenceRoot,
  });
  assert.equal(duplicateCollected.artifacts.filter(({ logicalName }) => logicalName === 'rendered-accessibility-state').length, 1,
    'an exact repeated Playwright path, metadata, and content tuple must collapse to one evidence member');
  assert.equal(duplicateCollected.rows[0].attachments.filter(({ name }) => name === 'rendered-accessibility-state').length, 1);

  const conflictingDocument = structuredClone(document);
  conflictingDocument.suites[0].specs[0].tests[0].results[0].attachments.push({
    ...conflictingDocument.suites[0].specs[0].tests[0].results[0].attachments[2],
    name: 'conflicting-rendered-state',
  });
  await assert.rejects(
    collectSharedPlaywrightArtifacts({ document: conflictingDocument, descriptor, artifactRoot, evidenceRoot }),
    /reuses a canonical file with conflicting metadata or content/,
    'one canonical file cannot claim conflicting logical evidence identities',
  );
  const failureFinding = {
    severity: 'P1', title: 'Primary navigation is hidden',
    detail: 'Observed at https://candidate.example/path?run=123456.', blocking: true,
  };
  const failedDocument = report(['failed'], {
    artifactRoot,
    findings: [failureFinding],
    resultErrors: [{
      message: 'Error: expect(locator).toBeVisible() failed for https://candidate.example/path?run=123456',
      location: { file: '/workspace/tests/accessibility.spec.ts', line: 48, column: 7 },
    }],
  });
  const failedRow = validateSharedPlaywrightRows(failedDocument, descriptor).rows[0];
  const failedSummary = JSON.parse(Buffer.from(
    failedRow.attachments.find(({ name }) => name === 'audit-result-summary').body, 'base64',
  ).toString('utf8'));
  await writeFile(path.join(rowRoot, 'audit-result.json'), `${JSON.stringify({
    ...failedSummary,
    definition: { id: descriptor.definitionId }, evidencePolicy: failedRow.evidencePolicy,
    browser: 'Chromium', viewport: { width: 1440, height: 900 }, timezone: 'America/Chicago',
    startedAt: '2026-08-29T00:00:00.000Z', finishedAt: '2026-08-29T00:00:01.000Z',
    observations: [], pageInspections: [], consoleErrors: [], consoleWarnings: [], pageErrors: [],
    httpResponses: [], failedRequests: [], badResponses: [], runtimeExpectations: [], thirdPartyTelemetryDiagnostics: [],
  })}\n`);
  const failedCollected = await collectSharedPlaywrightArtifacts({
    document: failedDocument, descriptor, artifactRoot, evidenceRoot,
  });
  assert.match(failedCollected.productFailureSignature.assertionIdentities[0],
    new RegExp(`^case:${descriptor.caseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|location:tests/accessibility\\.spec\\.ts:48\\|matcher:tobevisible\\|semantic:sha256:[a-f0-9]{64}$`));
  assert(failedCollected.productFailureSignature.findingIdentities.some((identity) => identity.includes('primary-navigation-is-hidden')));
  assert.equal(JSON.stringify(failedCollected.productFailureSignature).includes('candidate.example'), false,
    'Failure signatures must strip target URLs and dynamic detail text.');
  const escaped = structuredClone(document);
  escaped.suites[0].specs[0].tests[0].results[0].attachments[0].path = '/tmp/outside-audit-result.json';
  await assert.rejects(
    collectSharedPlaywrightArtifacts({ document: escaped, descriptor, artifactRoot, evidenceRoot }),
    /escaped its attempt artifact root/,
  );
} finally {
  await rm(evidenceRoot, { recursive: true, force: true });
}

const production500Signature = await collectFailureSignature({
  activeDescriptor: productionDescriptor,
  message: 'Error: expect(received).toEqual(expected)\nExpected: []\nReceived: [{"url":"https://production.example.test/api/content","status":500}]\nObserved at 2026-08-29T01:02:03.000Z',
  badResponses: [{ url: 'https://production.example.test/api/content', status: 500 }],
});
const candidate404Signature = await collectFailureSignature({
  activeDescriptor: descriptor,
  message: 'Error: expect(received).toEqual(expected)\nExpected: []\nReceived: [{"url":"https://candidate.example.test/api/content","status":404}]\nObserved at 2026-08-29T01:03:04.000Z',
  badResponses: [{ url: 'https://candidate.example.test/api/content', status: 404 }],
});
const candidate500Signature = await collectFailureSignature({
  activeDescriptor: descriptor,
  message: 'Error: expect(received).toEqual(expected)\nExpected: []\nReceived: [{"url":"https://candidate.example.test/api/content","status":500}]\nObserved at 2026-08-29T09:08:07.000Z',
  badResponses: [{ url: 'https://candidate.example.test/api/content', status: 500 }],
});
const candidate500OtherPathSignature = await collectFailureSignature({
  activeDescriptor: descriptor,
  message: 'Error: expect(received).toEqual(expected)\nExpected: []\nReceived: [{"url":"https://candidate.example.test/api/search","status":500}]\nObserved at 2026-08-29T09:08:07.000Z',
  badResponses: [{ url: 'https://candidate.example.test/api/search', status: 500 }],
});
assert.notEqual(candidate404Signature.digest, production500Signature.digest,
  'Different HTTP failure semantics at one assertion locus must not collide.');
assert.equal(candidate500Signature.digest, production500Signature.digest,
  'Equivalent failures must ignore only target origins and volatile timestamps.');
assert.notEqual(candidate500OtherPathSignature.digest, production500Signature.digest,
  'Different failing paths at one assertion locus must not collide.');

const finding500Signature = await collectFailureSignature({
  activeDescriptor: productionDescriptor,
  message: 'Error: expect(locator).toBeVisible() failed because the error panel remained visible.',
  findings: [{
    severity: 'P1', title: 'Content endpoint failed',
    detail: 'GET https://production.example.test/api/content returned 500; observed at 2026-08-29T01:02:03.000Z.',
    blocking: true,
  }],
});
const finding404Signature = await collectFailureSignature({
  activeDescriptor: descriptor,
  message: 'Error: expect(locator).toBeVisible() failed because the error panel remained visible.',
  findings: [{
    severity: 'P1', title: 'Content endpoint failed',
    detail: 'GET https://candidate.example.test/api/content returned 404; observed at 2026-08-29T01:03:04.000Z.',
    blocking: true,
  }],
});
const finding500CandidateSignature = await collectFailureSignature({
  activeDescriptor: descriptor,
  message: 'Error: expect(locator).toBeVisible() failed because the error panel remained visible.',
  findings: [{
    severity: 'P1', title: 'Content endpoint failed',
    detail: 'GET https://candidate.example.test/api/content returned 500; observed at 2026-08-29T09:08:07.000Z.',
    blocking: true,
  }],
});
const nonblockingFinding500Signature = await collectFailureSignature({
  activeDescriptor: descriptor,
  message: 'Error: expect(locator).toBeVisible() failed because the error panel remained visible.',
  findings: [{
    severity: 'P1', title: 'Content endpoint failed',
    detail: 'GET https://candidate.example.test/api/content returned 500; observed at 2026-08-29T09:08:07.000Z.',
    blocking: false,
  }],
});
assert.notEqual(finding404Signature.digest, finding500Signature.digest,
  'Same-title findings with materially different detail must not collide.');
assert.equal(finding500CandidateSignature.digest, finding500Signature.digest,
  'Equivalent finding semantics must ignore only target origins and volatile timestamps.');
assert.notEqual(nonblockingFinding500Signature.digest, finding500Signature.digest,
  'A finding blocking-state change must remain material to the signature.');
assert.equal(await collectFailureSignature({
  activeDescriptor: descriptor,
  message: 'Error: expect(received).toEqual(expected)',
}), null, 'A failure without a semantic expected/actual payload must remain unsigned and fail closed.');
assert.equal(await collectFailureSignature({
  activeDescriptor: descriptor,
  message: `Error: expect(received).toEqual(expected) Expected: [] Received: ${'x'.repeat(70 * 1024)}`,
}), null, 'An unbounded failure payload must remain unsigned and fail closed.');

function comparativeOracle(candidateSignature, productionSignature) {
  const result = (workItemId, productFailureSignature) => sealWorkItemResult({
    schemaVersion: 1, workItemId, subjectCoreDigest: digest('a'), attempt: 1, authoritative: true,
    outcome: 'completed_product_failure', evidenceDigests: [], productFailureSignature,
  });
  return sealOracleResult({
    schemaVersion: 1,
    oracleExecution: {
      id: 'oracle-semantic-collision', definitionId: descriptor.definitionId,
      productOracleVariant: 'A11Y-001:semantic-collision',
      baselinePolicy: 'context-unless-candidate-regression-proven',
      requiredWorkItemIds: [descriptor.workItemId, productionDescriptor.workItemId],
      workItemBindings: [
        { workItemId: descriptor.workItemId, targetRole: 'candidate', comparisonKey: 'mobile-chromium' },
        { workItemId: productionDescriptor.workItemId, targetRole: 'production', comparisonKey: 'mobile-chromium' },
      ],
    },
    finalSubjectDigest: digest('f'),
    workItemResults: [
      result(descriptor.workItemId, candidateSignature),
      result(productionDescriptor.workItemId, productionSignature),
    ],
  });
}
assert.equal(comparativeOracle(candidate404Signature, production500Signature).comparisonResults[0].classification,
  'candidate-worsened');
assert.equal(comparativeOracle(candidate500Signature, production500Signature).comparisonResults[0].classification,
  'reproduced-unchanged');

const visualEvidenceRoot = await mkdtemp(path.join(tmpdir(), 'shared-visual-risk-artifacts-'));
try {
  const artifactRoot = path.join(visualEvidenceRoot, 'playwright');
  const rowRoot = path.join(artifactRoot, 'raw', 'row-1');
  await mkdir(rowRoot, { recursive: true });
  const visualComparison = {
    schemaVersion: 1,
    kind: 'shared-visual-comparison-result',
    caseId: visualDescriptor.caseId,
    targetId: visualDescriptor.targetId,
    observedAt: '2026-08-29T00:00:01.000Z',
    items: [{
      id: 'home-light',
      comparison: {
        schemaVersion: 1,
        policyRevision: 'pixelmatch-css-ratio-0.0025-v1',
        status: 'CHANGED', comparisonStatus: 'CHANGED', differingPixels: 400,
        totalPixels: 10000, differingPixelRatio: 0.04,
        reason: 'Pixel difference ratio 0.04 exceeds the reviewed tolerance.',
        review: null,
        effects: { deterministicHealth: 'none', deterministicFindings: 'none', promotion: 'none' },
      },
    }],
  };
  const document = report(['passed'], { descriptor: visualDescriptor, artifactRoot, visualComparison });
  const row = validateSharedPlaywrightRows(document, visualDescriptor).rows[0];
  const summary = JSON.parse(Buffer.from(row.attachments.find(({ name }) => name === 'audit-result-summary').body, 'base64').toString('utf8'));
  await writeFile(path.join(rowRoot, 'audit-result.json'), `${JSON.stringify({
    ...summary,
    definition: { id: visualDescriptor.definitionId }, evidencePolicy: row.evidencePolicy,
    browser: 'Chromium', viewport: { width: 1440, height: 900 }, timezone: 'America/Chicago',
    startedAt: '2026-08-29T00:00:00.000Z', finishedAt: '2026-08-29T00:00:01.000Z',
    observations: [], pageInspections: [], consoleErrors: [], consoleWarnings: [], pageErrors: [],
    httpResponses: [], failedRequests: [], badResponses: [], runtimeExpectations: [], thirdPartyTelemetryDiagnostics: [],
  })}\n`);
  await writeFile(path.join(rowRoot, 'state.png'), Buffer.from('purposeful-visual-state'));
  await writeFile(path.join(rowRoot, 'shared-visual-comparison-result.json'), `${JSON.stringify(visualComparison)}\n`);
  const collected = await collectSharedPlaywrightArtifacts({
    document, descriptor: visualDescriptor, artifactRoot, evidenceRoot: visualEvidenceRoot,
  });
  assert.equal(collected.visualRiskSource.status, 'COMPLETE');
  assert.deepEqual(collected.visualRiskSource.changedItems.map(({ id }) => id), ['home-light']);
  const failedManifest = buildSharedWorkerResultManifest({
    descriptor: visualDescriptor,
    identity: {
      runId: 'run-visual-failure', workItemId: visualDescriptor.workItemId, attempt: 1,
      subjectCoreDigest: visualDescriptor.subjectCoreDigest, runnerRevision: visualDescriptor.runnerRevision,
      executionDescriptorDigest: visualDescriptor.digest,
    },
    result: { ...collected, outcome: 'completed_product_failure', reason: 'playwright-product-failure' },
  });
  assert.equal(failedManifest.outcome, 'completed_product_failure',
    'Visual risk publication must not weaken a failed visual assertion into a non-blocking outcome.');
  const unavailableManifest = buildSharedWorkerResultManifest({
    descriptor: visualDescriptor,
    identity: {
      runId: 'run-visual-unavailable', workItemId: visualDescriptor.workItemId, attempt: 1,
      subjectCoreDigest: visualDescriptor.subjectCoreDigest, runnerRevision: visualDescriptor.runnerRevision,
      executionDescriptorDigest: visualDescriptor.digest,
    },
    result: { outcome: 'completed_pass', reason: null, artifacts: [] },
  });
  assert.equal(unavailableManifest.riskSourceOutput.producerStates.find(({ producer }) => producer === 'visual').status,
    'UNAVAILABLE', 'An in-scope visual execution without collector output must disclose producer failure.');

  const absentComparison = structuredClone(visualComparison);
  absentComparison.items[0].comparison = {
    ...absentComparison.items[0].comparison,
    status: 'absent', comparisonStatus: null, differingPixels: null, totalPixels: null,
    differingPixelRatio: null, reason: 'No compatible production counterpart was available.',
  };
  await writeFile(path.join(rowRoot, 'shared-visual-comparison-result.json'), `${JSON.stringify(absentComparison)}\n`);
  const unavailable = await collectSharedPlaywrightArtifacts({
    document, descriptor: visualDescriptor, artifactRoot, evidenceRoot: visualEvidenceRoot,
  });
  assert.equal(unavailable.visualRiskSource.status, 'UNAVAILABLE',
    'An in-scope candidate visual without an in-worker reference must disclose producer unavailability.');

  const missingDocument = report(['passed'], { descriptor: visualDescriptor, artifactRoot });
  const missing = await collectSharedPlaywrightArtifacts({
    document: missingDocument, descriptor: visualDescriptor, artifactRoot, evidenceRoot: visualEvidenceRoot,
  });
  assert.equal(missing.visualRiskSource.status, 'UNAVAILABLE');
} finally {
  await rm(visualEvidenceRoot, { recursive: true, force: true });
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
const invalidEvidenceDescriptor = sealWorkExecutionDescriptor({
  ...descriptorInput,
  workItemId: 'work-invalid-executor-evidence',
  caseId: 'A11Y-001:tests/missing-regression.spec.ts:candidate-chromium-projects',
  entrySpec: 'tests/missing-regression.spec.ts',
});
let claimCount = 0;
const receivedLogs = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1/claim') {
    const claimIndex = claimCount++;
    if (claimIndex === 0) {
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
    if (claimIndex === 1) {
      response.statusCode = 200;
      response.end(`${JSON.stringify({
        runId: 'run-worker-process', workItemId: invalidEvidenceDescriptor.workItemId,
        workerId: 'worker-process', attempt: 1, epoch: 1, token: 'lease-invalid-evidence',
        claimedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10_000).toISOString(),
        subjectCoreDigest: invalidEvidenceDescriptor.subjectCoreDigest,
        runnerRevision: invalidEvidenceDescriptor.runnerRevision,
        capability: invalidEvidenceDescriptor.capability, resourceClass: invalidEvidenceDescriptor.resourceClass,
        targetId: invalidEvidenceDescriptor.targetId, specAffinity: invalidEvidenceDescriptor.entrySpec,
        executionDescriptor: invalidEvidenceDescriptor, executionDescriptorDigest: invalidEvidenceDescriptor.digest,
      })}\n`);
      return;
    }
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
    AUDIT_RUNNER_REVISION: `image:${digest('b')}`,
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
  const evidenceDeadline = Date.now() + 10_000;
  while (receivedLogs.length < 4 && worker.exitCode === null && Date.now() < evidenceDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(worker.exitCode, null, `invalid executor evidence terminated the worker: ${workerStderr}`);
  assert.deepEqual(receivedLogs.slice(2).map(({ sequence, level }) => ({ sequence, level })), [
    { sequence: 1, level: 'info' },
    { sequence: 2, level: 'warn' },
  ]);
  assert.match(receivedLogs[3].message, /operational-recovery: executor-evidence-invalid/);
  assert.match(workerStderr, /lease will expire for bounded recovery/);
} finally {
  if (worker.exitCode === null && worker.signalCode === null) {
    const closed = new Promise((resolve) => worker.once('close', resolve));
    worker.kill('SIGTERM');
    await closed;
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(processRoot, { recursive: true, force: true });
}

process.stdout.write('Shared work dispatcher self-test passed: fixed repository command, secret-free child environment, descriptor fencing, and exact Playwright row validation are enforced.\n');
