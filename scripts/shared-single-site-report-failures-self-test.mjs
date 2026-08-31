import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertionFromErrorContext,
  readSharedSingleSiteFailurePage,
} from '../portal/shared-single-site-report-failures.mjs';
import { sealProductFailureSignature } from '../shared/execution-contract.mjs';
import { sealReleaseSubjectCore } from '../shared/release-subject.mjs';
import { sealWorkExecutionDescriptor } from '../shared/work-execution-descriptor.mjs';
import { sealWorkItemEvidenceMember } from '../shared/work-item-evidence-index.mjs';
import {
  acquireCoordinator,
  adoptAttemptEvidence,
  claimWorkItem,
  createParentRun,
  openAdoptedAttemptArtifact,
  openParentRunStore,
  publishAttemptEvidence,
  readParentRun,
} from './lib/parent-run-store.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const runId = 'shared-report-failure-proof';
const workItemId = 'work-performance-failure';
const root = await mkdtemp(path.join(tmpdir(), 'shared-report-failure-proof-'));

try {
  const subjectCore = sealReleaseSubjectCore({
    schemaVersion: 1,
    deploymentIdentity: { kind: 'build', value: 'shared-report-failure-proof' },
    targets: [{ role: 'audited', origin: 'https://beta.example.test' }],
    mode: 'single-site',
    requestedAuthority: {
      qualifier: 'FULL',
      scope: {
        features: ['performance'], definitions: ['PERF-001'],
        targets: ['candidate-mobile-chromium'], knownLimits: [],
      },
    },
    revisions: {
      runner: digest('1'), plugins: digest('2'), targets: digest('3'), configuration: digest('4'),
    },
    environmentIdentity: digest('5'),
    certificatePolicy: 'strict',
  });
  const descriptor = sealWorkExecutionDescriptor({
    workItemId,
    subjectCoreDigest: subjectCore.digest,
    runnerRevision: subjectCore.revisions.runner,
    mode: 'single-site',
    operation: 'playwright',
    definitionId: 'PERF-001',
    pluginId: 'platform-routes-content',
    caseId: 'PERF-001:case:%2Fslow-page',
    entrySpec: 'tests/performance.spec.ts',
    targetId: 'candidate-mobile-chromium',
    targetRole: 'audited',
    capability: 'browser:chromium',
    resourceClass: 'ordinary',
    origins: { candidate: 'https://beta.example.test', production: null },
    certificatePolicy: 'strict',
    route: null,
  });
  const store = await openParentRunStore({
    root,
    deploymentIdentity: 'shared-report-failure-self-test',
    volumeIdentity: 'named-volume:shared-report-failure-self-test',
    storeMarker: 'ab'.repeat(32),
    backupMarker: 'backup:shared-report-failure-self-test',
    verifyStorage: false,
  });
  await createParentRun(store, {
    runId,
    subjectCore,
    runnerRevision: subjectCore.revisions.runner,
    workItems: [{
      id: workItemId,
      maxAttempts: 1,
      capability: 'browser:chromium',
      resourceClass: 'ordinary',
      targetId: descriptor.targetId,
      specAffinity: descriptor.entrySpec,
      executionDescriptor: descriptor,
    }],
  });
  const coordinator = await acquireCoordinator(store, runId, {
    ownerId: 'shared-report-failure-coordinator', leaseMs: 60_000,
  });
  const lease = await claimWorkItem(store, runId, coordinator, {
    workerId: 'shared-report-failure-worker',
    capabilities: ['browser:chromium'],
    resourceClasses: ['ordinary'],
    leaseMs: 60_000,
  });
  const evidencePolicy = {
    mode: 'structured-data',
    rationale: 'Retain bounded browser timing evidence for the affected page.',
  };
  const rows = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: 'shared-work-item-rows',
    workItemId,
    executionDescriptorDigest: descriptor.digest,
    rows: [{
      row: 1,
      title: 'Browser resource budget',
      projectName: descriptor.targetId,
      caseId: descriptor.caseId,
      entrySpec: descriptor.entrySpec,
      status: 'failed',
      retry: 0,
      evidencePolicy,
      attachments: [],
    }],
  }));
  const summary = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    mode: 'single-site',
    caseId: descriptor.caseId,
    auditId: descriptor.definitionId,
    deploymentRole: descriptor.targetRole,
    baseURL: descriptor.origins.candidate,
    project: descriptor.targetId,
    findings: Array.from({ length: 15 }, (_, index) => ({
      severity: 'P1', title: `Request budget exceeded ${index + 1}`,
      detail: `${112 + index} requests exceeded the 90-request budget.`, blocking: true,
    })),
    steps: [{
      name: 'Measure first-party requests', expected: 'At most 90 requests',
      status: 'failed', detail: 'Observed 112 requests.',
    }],
  }));
  const errorContext = Buffer.from(`# Instructions\n\n# Error details\n\n\`\`\`\nError: Request count budget\n\nExpected: <= 90\nReceived: 112\n\`\`\`\n\n# Page snapshot\n`);
  const browserEvidence = Buffer.from('{"requestCount":112,"budget":90}');
  const rawLog = Buffer.from('large raw worker log that must never enter the report response');
  const artifacts = [
    indexedUpload('playwright/work-item-rows.json', 'work-item-rows', 'structured', 'application/json', rows, 1, descriptor.digest),
    indexedUpload('playwright/audit-result-summary.json', 'audit-result-summary', 'structured', 'application/json', summary, 2, descriptor.digest),
    indexedUpload('playwright/error-context.md', 'error-context', 'diagnostic', 'text/markdown', errorContext, 3, descriptor.digest),
    indexedUpload('playwright/browser-performance-evidence.json', 'browser-performance-evidence', 'structured', 'application/json', browserEvidence, 4, descriptor.digest),
    indexedUpload('playwright/stdout.txt', 'stdout', 'diagnostic', 'text/plain', rawLog, 5, descriptor.digest),
  ];
  const signature = sealProductFailureSignature({
    schemaVersion: 1,
    assertionIdentities: ['case:PERF-001|matcher:tobelessthanorequal'],
    findingIdentities: ['case:PERF-001|finding:request-budget-exceeded|severity:p1'],
  });
  const inbox = await publishAttemptEvidence(store, runId, lease, {
    outcome: 'completed_product_failure',
    reason: 'playwright-product-failure',
    executionDescriptorDigest: descriptor.digest,
    productFailureSignature: signature,
    artifacts,
  });
  await adoptAttemptEvidence(store, runId, coordinator, inbox);
  const stateRevision = (await readParentRun(store, runId)).runRevision;

  const page = await readSharedSingleSiteFailurePage({
    store,
    runId,
    auditCatalog: [{ id: 'PERF-001', title: 'Browser resource budget', severity: 'P1' }],
    offset: 0,
    limit: 20,
    expectedStateRevision: stateRevision,
  });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].auditId, 'PERF-001');
  assert.equal(page.items[0].caseId, descriptor.caseId);
  assert.equal(page.items[0].targetId, descriptor.targetId);
  assert.equal(page.items[0].url, 'https://beta.example.test/slow-page');
  assert.match(page.items[0].assertionMessage, /Request count budget[\s\S]*Received: 112/u);
  assert.equal(page.items[0].releaseEffect, 'blocking');
  assert.equal(page.items[0].findingCount, 15);
  assert.equal(page.items[0].findingsShown, 12);
  assert.equal(page.items[0].findingsOmitted, 3);
  assert.equal(page.items[0].findingsTruncated, true);
  assert.equal(page.items[0].evidencePolicy.mode, 'structured-data');
  assert(page.items[0].evidence.some(({ name }) => name === 'browser-performance-evidence'));
  assert.equal(page.items[0].evidence.some(({ name }) => name === 'stdout'), false,
    'raw logs must never enter the bounded failure response');
  assert.match(page.items[0].galleryUrl, /q=PERF-001/u);
  const errorEvidence = page.items[0].evidence.find(({ name }) => name === 'error-context');
  assert.ok(errorEvidence, 'the exact canonical assertion context must remain linked');
  const artifactKey = decodeURIComponent(new URL(errorEvidence.url, 'http://portal.test').pathname.split('/').at(-1));
  const opened = await openAdoptedAttemptArtifact(store, runId, { workItemId, artifactKey });
  await opened.opened.handle.close();
  await opened.opened.transferLease.release();
  assert.equal(
    assertionFromErrorContext(errorContext.toString()),
    'Error: Request count budget\n\nExpected: <= 90\nReceived: 112',
  );
  await assert.rejects(() => readSharedSingleSiteFailurePage({
    store,
    runId,
    expectedStateRevision: stateRevision - 1,
  }), (error) => error?.code === 'SINGLE_SITE_REPORT_REVISION_STALE' && error?.statusCode === 409);

  console.log('Shared Single-site failure report self-test passed: bounded canonical assertion detail and evidence links.');
} finally {
  await rm(root, { recursive: true, force: true });
}

function indexedUpload(name, logicalName, purpose, mediaType, bytes, ordinal, executionDescriptorDigest) {
  const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const member = sealWorkItemEvidenceMember({
    workItemId,
    executionDescriptorDigest,
    ordinal,
    logicalName,
    purpose,
    mediaType,
    sizeBytes: bytes.length,
    contentDigest,
    transportPath: name,
  });
  return {
    name,
    logicalName,
    purpose,
    mediaType,
    sizeBytes: bytes.length,
    digest: contentDigest,
    memberDigest: member.memberDigest,
    contentBase64: bytes.toString('base64'),
  };
}
