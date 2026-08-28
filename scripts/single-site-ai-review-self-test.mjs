import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SingleSiteAiReviewError,
  fenceSingleSiteAiReviewForPurge,
  openSingleSiteAiReviewSupervisor,
  readSingleSiteAiReview,
  readSingleSiteAiReviewResult,
  recoverSingleSiteAiReviews,
  requestSingleSiteAiReview,
  waitForSingleSiteAiReview,
} from '../portal/single-site-ai-review.mjs';
import { loadSingleSiteReportPublication } from '../portal/report-publication.mjs';
import { writeSingleSiteReportPublication } from './lib/single-site-report-writer.mjs';

const root = await fs.mkdtemp(join(tmpdir(), 'single-site-ai-review-'));
const secret = 'sk-ant-api03-single-site-ai-supervisor-self-test-secret';
try {
  const reportDirectory = join(root, 'final-report');
  const revision = '1234567890abcdef1234567890abcdef';
  await writeSingleSiteReportPublication({
    outputDir: join(reportDirectory, 'checklist'),
    publicationRevision: revision,
    input: reportInput(),
  });
  const publication = await loadSingleSiteReportPublication(reportDirectory, revision);
  const fakeReviewer = join(root, 'fake-reviewer.mjs');
  await fs.writeFile(fakeReviewer, `
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const runDir = value('--run-dir');
const outputDir = value('--output-dir');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const key = Buffer.concat(chunks).toString('utf8').trim();
if (!key.startsWith('sk-ant-') || process.env.ANTHROPIC_API_KEY || args.some((arg) => arg.includes(key))) process.exit(41);
const pointer = JSON.parse(await fs.readFile(join(runDir, 'checklist', 'data', 'current.json'), 'utf8'));
if (pointer.mode !== 'single-site') process.exit(42);
await fs.mkdir(outputDir, { recursive: true });
const inventory = {
  schemaVersion: 1,
  mode: 'single-site',
  capabilities: ['interpret-health-evidence'],
  prohibitedMutations: ['release-or-promotion-decision', 'baseline-approval-or-revocation'],
};
const review = {
  schemaVersion: 1,
  advisory: true,
  gating: false,
  status: process.env.ANTHROPIC_MODEL === 'provider-error-model' ? 'error' : 'completed',
  generatedAt: '2026-08-25T22:00:00.000Z',
  model: process.env.ANTHROPIC_MODEL,
  source: { mode: 'single-site', runId: process.env.AUDIT_RUN_ID },
  api: { status: 'success', attempted: true },
  review: {
    executiveSummary: 'Advisory interpretation only.',
    releaseRecommendation: null,
    findings: [],
    coverageGaps: [],
    questionsForHumanReviewer: [],
  },
  notice: 'Human verification is required.',
  error: process.env.ANTHROPIC_MODEL === 'provider-error-model' ? 'Synthetic provider failure.' : null,
};
await fs.writeFile(join(outputDir, 'payload-inventory.json'), JSON.stringify(inventory) + '\\n');
await fs.writeFile(join(outputDir, 'review.json'), JSON.stringify(review) + '\\n');
await fs.writeFile(join(outputDir, 'secret-transport-check.json'), JSON.stringify({ stdin: true, env: false, args: false }) + '\\n');
`, { mode: 0o700 });

  const events = [];
  const advisoryRoot = join(root, 'finalizations');
  const supervisor = await openSingleSiteAiReviewSupervisor({
    root: advisoryRoot,
    nestedJobSubdirectory: 'ai-review',
    aiWorkerIdentity: {
      active: true,
      uid: process.getuid(),
      gid: process.getgid(),
      user: 'ai-review-self-test',
      home: root,
    },
    reviewerExecutable: process.execPath,
    reviewerArgsPrefix: [fakeReviewer],
    onEvent: (event) => events.push(event),
  });
  const base = {
    jobId: 'single-site-ai-review-job',
    model: 'claude-opus-test',
    reportDirectory,
    reportRevision: revision,
    reportPublicationDigest: publication.publicationDigest,
  };

  const fencedJobId = 'single-site-ai-purge-fence';
  let resolveActive;
  const active = new Promise((resolve) => { resolveActive = resolve; });
  const signals = [];
  const child = {
    exitCode: null,
    kill(signal) {
      signals.push(signal);
      this.exitCode = 0;
      supervisor.children.delete(fencedJobId);
      resolveActive();
      return true;
    },
  };
  supervisor.children.set(fencedJobId, child);
  supervisor.active.set(fencedJobId, active);
  const fenced = await fenceSingleSiteAiReviewForPurge(supervisor, fencedJobId);
  assert.equal(fenced.activeDrained, true);
  assert.deepEqual(signals, ['SIGTERM']);
  await assert.rejects(
    requestSingleSiteAiReview(supervisor, { ...base, jobId: fencedJobId, requestId: 'request-after-purge', expectedStateRevision: 0, optIn: false, apiKey: null }),
    (error) => error instanceof SingleSiteAiReviewError && error.code === 'AI_REVIEW_PURGED',
  );
  await assert.rejects(() => fs.access(join(advisoryRoot, fencedJobId)), /ENOENT/);

  const optedOut = await requestSingleSiteAiReview(supervisor, {
    ...base,
    requestId: 'request-opted-out',
    expectedStateRevision: 0,
    optIn: false,
    apiKey: secret,
  });
  assert.equal(optedOut.state, 'unavailable');
  assert.equal(optedOut.error.code, 'opt-in-required');

  const noCredential = await requestSingleSiteAiReview(supervisor, {
    ...base,
    requestId: 'request-no-credential',
    expectedStateRevision: optedOut.stateRevision,
    optIn: true,
    apiKey: null,
  });
  assert.equal(noCredential.state, 'unavailable');
  assert.equal(noCredential.error.code, 'credential-unavailable');

  const pending = await requestSingleSiteAiReview(supervisor, {
    ...base,
    requestId: 'request-successful-review',
    expectedStateRevision: noCredential.stateRevision,
    optIn: true,
    apiKey: secret,
  });
  assert.equal(pending.state, 'pending');
  const completed = await waitForSingleSiteAiReview(supervisor, base.jobId);
  assert.equal(completed.state, 'completed', completed.error?.message);
  assert.equal(completed.output.advisory, true);
  assert.equal(completed.output.gating, false);
  assert.equal(completed.output.findingCount, 0);
  assert.equal(completed.attempt, 3);
  const completedResult = await readSingleSiteAiReviewResult(supervisor, base.jobId);
  assert.equal(completedResult.review.source.mode, 'single-site');
  assert.equal(completedResult.review.review.releaseRecommendation, null);
  assert.equal(completedResult.gating, false);

  const retry = await requestSingleSiteAiReview(supervisor, {
    ...base,
    requestId: 'request-successful-review',
    expectedStateRevision: noCredential.stateRevision,
    optIn: true,
    apiKey: secret,
  });
  assert.equal(retry.statusDigest, completed.statusDigest, 'same request ID must be idempotent');

  await assert.rejects(
    requestSingleSiteAiReview(supervisor, {
      ...base,
      requestId: 'request-stale-revision',
      expectedStateRevision: noCredential.stateRevision,
      optIn: true,
      apiKey: secret,
    }),
    (error) => error instanceof SingleSiteAiReviewError && error.code === 'AI_REVIEW_CAS_CONFLICT',
  );

  const providerPending = await requestSingleSiteAiReview(supervisor, {
    ...base,
    requestId: 'request-provider-failure',
    expectedStateRevision: completed.stateRevision,
    optIn: true,
    model: 'provider-error-model',
    apiKey: secret,
  });
  assert.equal(providerPending.state, 'pending');
  const providerFailed = await waitForSingleSiteAiReview(supervisor, base.jobId);
  assert.equal(providerFailed.state, 'failed');
  assert.equal(providerFailed.error.code, 'AI_REVIEW_PROVIDER_FAILED');
  assert.equal(providerFailed.retryable, true);
  await assert.rejects(
    fs.access(join(advisoryRoot, base.jobId, 'ai-review', 'publications', 'request-provider-failure')),
    /ENOENT/,
  );

  const interruptedJobId = 'single-site-ai-interrupted-job';
  const interruptedBody = {
    schemaVersion: 1,
    kind: 'single-site-ai-advisory-status',
    jobId: interruptedJobId,
    state: 'running',
    stateRevision: 2,
    requestId: 'request-interrupted-review',
    attempt: 1,
    optIn: true,
    model: 'claude-opus-test',
    requestedAt: '2026-08-25T21:30:00.000Z',
    startedAt: '2026-08-25T21:30:01.000Z',
    finishedAt: null,
    reportRevision: revision,
    reportPublicationDigest: publication.publicationDigest,
    inputDigest: 'a'.repeat(64),
    output: null,
    error: null,
    retryable: false,
  };
  const interruptedDirectory = join(advisoryRoot, interruptedJobId, 'ai-review');
  await fs.mkdir(interruptedDirectory, { recursive: true });
  await fs.writeFile(join(interruptedDirectory, 'status.json'), `${JSON.stringify({
    ...interruptedBody,
    statusDigest: digestStatus(interruptedBody),
  })}\n`);
  const recovery = await recoverSingleSiteAiReviews(supervisor);
  assert(recovery.some((item) => item.jobId === interruptedJobId && item.state === 'unavailable'));
  const recovered = await readSingleSiteAiReview(supervisor, interruptedJobId);
  assert.equal(recovered.error.code, 'interrupted-requires-runtime-secret');
  assert.equal(recovered.retryable, true);

  const stored = await fs.readFile(join(advisoryRoot, base.jobId, 'ai-review', 'status.json'), 'utf8');
  const publicationFiles = await fs.readdir(join(
    advisoryRoot, base.jobId, 'ai-review', 'publications', 'request-successful-review',
  ));
  assert(!stored.includes(secret));
  assert.deepEqual(publicationFiles.sort(), ['payload-inventory.json', 'publication.json', 'review.json']);
  const allStored = await readTree(advisoryRoot);
  assert(!allStored.includes(secret), 'runtime credential must not be persisted anywhere below advisory storage');
  assert(events.some((event) => event.state === 'running'));
  assert(events.some((event) => event.state === 'completed'));
  assert(!JSON.stringify(events).includes(secret));

  const statusFile = join(advisoryRoot, base.jobId, 'ai-review', 'status.json');
  const validStatus = await fs.readFile(statusFile, 'utf8');
  const tampered = JSON.parse(validStatus);
  tampered.state = 'completed';
  await fs.writeFile(statusFile, `${JSON.stringify(tampered)}\n`);
  await assert.rejects(
    readSingleSiteAiReview(supervisor, base.jobId),
    (error) => error instanceof SingleSiteAiReviewError && error.code === 'AI_REVIEW_STATUS_INVALID',
  );

  process.stdout.write('Single-site AI review supervisor self-test passed: opt-in, stdin-only credentials, isolated execution, immutable report binding, advisory-only output, idempotency, CAS, redaction, and digest validation are enforced.\n');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function readTree(directory) {
  let output = '';
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) output += await readTree(child);
    else if (entry.isFile()) output += await fs.readFile(child, 'utf8').catch(() => '');
  }
  return output;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digestStatus(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function reportInput() {
  return {
    schemaVersion: 1,
    mode: 'single-site',
    generatedAt: '2026-08-25T21:00:00.000Z',
    pageSize: 25,
    health: {
      schemaVersion: 1,
      mode: 'single-site',
      url: 'https://beta.quitting7oh-org.pages.dev/',
      deploymentRole: 'preview',
      scope: { qualifier: 'FULL', selectedCoverage: ['AUDIT-0001'], omittedCoverage: [] },
      coverage: { finalized: true, manifestIntegrity: true, gaps: [], limitations: [] },
      pipeline: {
        executionStatus: 'completed', integrityComplete: true, requiredEvidenceComplete: true,
        reason: 'Deterministic finalization completed before optional AI review.',
      },
      evidenceAuthority: { status: 'authoritative', reasons: [] },
      findings: [],
      manual: { required: 0, complete: 0, failedOrBlocked: 0 },
      visualReview: { items: [{ status: 'UNCHANGED' }] },
    },
    audits: [{
      id: 'AUDIT-0001', title: 'Standalone fixture', area: 'Navigation', status: 'PASS',
      findingCount: 0, evidenceStatus: 'complete', artifactCount: 1, manual: false,
      visualStatus: 'UNCHANGED', detail: 'Deterministic Product Oracle passed.',
    }],
    outsideMode: [],
  };
}
