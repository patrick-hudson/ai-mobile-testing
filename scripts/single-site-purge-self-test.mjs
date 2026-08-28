import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalJson,
  claimJob,
  openJobQueue,
  settleJobAttempt,
  sha256,
  submitJob,
} from './lib/job-queue.mjs';
import {
  SingleSitePurgeError,
  purgeSingleSiteRun,
  recoverSingleSitePurges,
  singleSitePurgeConfirmation,
} from '../portal/single-site-purge.mjs';
import {
  openVisualBaselineStore,
  withVisualBaselineMutationLock,
} from '../portal/visual-baselines.mjs';

const terminalStates = new Set(['completed', 'failed', 'incomplete', 'cancelled']);
const noNestedMounts = async () => undefined;

function expectCode(code) {
  return (error) => error instanceof SingleSitePurgeError && error.code === code;
}

function submission(input, suffix) {
  const digest = (label) => sha256(`${label}-${suffix}`);
  return {
    idempotencyKey: `purge-${suffix}`,
    runMode: 'single-site',
    inputDocumentDigest: sha256(canonicalJson(input)),
    runContractDigest: digest('contract'),
    compiledManifestDigest: digest('manifest'),
    preflightDigest: digest('preflight'),
    identityFingerprint: digest('identity'),
    revisionFingerprint: digest('revision'),
    evidenceAuthority: { authoritative: true, reasons: [] },
    registryRevision: 'purge-test-registry-v1',
    targetSetRevision: 'purge-test-targets-v1',
    runnerRevision: 'purge-test-runner-v1',
    stageDeadlines: {
      browser: '2099-01-01T00:10:00.000Z',
      finalizer: '2099-01-01T00:20:00.000Z',
    },
  };
}

async function createJob(queue, suffix, { terminal = true } = {}) {
  const input = { schemaVersion: 1, fixture: `purge-${suffix}` };
  const submitted = await submitJob(queue, submission(input, suffix), { inputDocument: input });
  if (!terminal) return submitted.state;
  const claim = await claimJob(queue, submitted.state.jobId, `worker-${suffix}`);
  const state = await settleJobAttempt(queue, claim, { kind: 'failed', reason: 'Synthetic terminal purge fixture.' });
  assert(terminalStates.has(state.executionState));
  return state;
}

async function publishFinalization(root, jobId) {
  const directory = path.join(root, jobId);
  await fs.mkdir(path.join(directory, 'report', 'checklist', 'data'), { recursive: true });
  await fs.mkdir(path.join(directory, 'ai-review'), { recursive: true });
  await fs.writeFile(path.join(directory, 'ai-review', 'status.json'), '{"fixture":"default-ai-root"}\n');
  await fs.writeFile(path.join(directory, 'report', 'checklist', 'data', 'report.json'), '{"fixture":true}\n');
  await fs.writeFile(path.join(directory, 'status.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'single-site-finalization-status',
    jobId,
    status: 'incomplete',
    deadlineExceeded: false,
    executionState: 'failed',
  })}\n`);
  return directory;
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-purge-'));
try {
  const queue = await openJobQueue({ root: path.join(root, 'queue'), verifyStorage: false });
  const finalizationRoot = path.join(root, 'finalizations');
  const aiReviewRoot = path.join(root, 'separate-ai-reviews');
  const baselineRoot = path.join(root, 'baselines');
  await Promise.all([fs.mkdir(finalizationRoot, { recursive: true }), fs.mkdir(aiReviewRoot, { recursive: true })]);
  const baselineStore = await openVisualBaselineStore({
    root: baselineRoot,
    lockRetries: 0,
    nonce: () => 'purgetestnonce',
  });
  const baselineMedia = path.join(baselineStore.mediaDirectory, 'independent-baseline.png');
  await fs.writeFile(baselineMedia, 'independent immutable baseline bytes');

  const active = await createJob(queue, 'active', { terminal: false });
  await assert.rejects(
    purgeSingleSiteRun({
      queue, finalizationRoot, baselineStore, jobId: active.jobId,
      confirmation: singleSitePurgeConfirmation(active.jobId),
      dependencies: { assertNoNestedMounts: noNestedMounts },
    }),
    expectCode('SINGLE_SITE_PURGE_NOT_TERMINAL'),
  );

  const state = await createJob(queue, 'recoverable');
  const finalizationDirectory = await publishFinalization(finalizationRoot, state.jobId);
  const outside = path.join(root, 'outside-must-survive.txt');
  await fs.writeFile(outside, 'retained outside data');
  await fs.symlink(outside, path.join(queue.root, 'jobs', state.jobId, 'outside-link'));
  await fs.writeFile(path.join(queue.root, 'jobs', state.jobId, 'large-evidence.log'), 'visible evidence bytes');
  await fs.mkdir(path.join(aiReviewRoot, state.jobId, 'ai-review'), { recursive: true });
  await fs.writeFile(path.join(aiReviewRoot, state.jobId, 'ai-review', 'status.json'), '{"fixture":"separate-ai-root"}\n');

  await assert.rejects(
    purgeSingleSiteRun({
      queue, finalizationRoot, baselineStore, jobId: state.jobId, confirmation: `purge ${state.jobId}`,
      dependencies: { assertNoNestedMounts: noNestedMounts },
    }),
    expectCode('SINGLE_SITE_PURGE_CONFIRMATION'),
  );
  assert.equal((await fs.lstat(path.join(queue.root, 'jobs', state.jobId))).isDirectory(), true);

  let releaseBaselineLock;
  const baselineLocked = withVisualBaselineMutationLock(baselineStore, async () => new Promise((resolve) => {
    releaseBaselineLock = resolve;
  }));
  while (!releaseBaselineLock) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    purgeSingleSiteRun({
      queue, finalizationRoot, aiReviewRoot, baselineStore, jobId: state.jobId,
      confirmation: singleSitePurgeConfirmation(state.jobId),
      dependencies: { assertNoNestedMounts: noNestedMounts },
    }),
    expectCode('SINGLE_SITE_PURGE_BASELINE_BUSY'),
  );
  releaseBaselineLock();
  await baselineLocked;

  await assert.rejects(
    purgeSingleSiteRun({
      queue, finalizationRoot, aiReviewRoot, baselineStore, jobId: state.jobId,
      confirmation: singleSitePurgeConfirmation(state.jobId),
      dependencies: {
        assertNoNestedMounts: noNestedMounts,
        hooks: { afterQuarantine: async () => { throw new Error('synthetic crash after quarantine'); } },
      },
    }),
    expectCode('SINGLE_SITE_PURGE_INCOMPLETE'),
  );
  await assert.rejects(() => fs.lstat(path.join(queue.root, 'jobs', state.jobId)), { code: 'ENOENT' });
  await assert.rejects(() => fs.lstat(finalizationDirectory), { code: 'ENOENT' });
  const journals = await fs.readdir(path.join(queue.root, '.single-site-purge-journals'));
  assert.deepEqual(journals, [`${state.jobId}.json`], 'an interrupted purge must retain one exact recovery journal');

  const recovered = await recoverSingleSitePurges({
    queue,
    finalizationRoot,
    aiReviewRoot,
    baselineStore,
    dependencies: { assertNoNestedMounts: noNestedMounts },
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, 'purged');
  assert.equal(recovered[0].result.recovered, true);
  assert.equal(recovered[0].result.baselineBytesPreserved, true);
  assert(recovered[0].result.logicalBytesRemoved > 0);
  assert.equal(recovered[0].result.physicalBytesRemoved, null, 'hardlinks make a physical reclaimed-byte claim unsafe');
  assert.equal(await fs.readFile(outside, 'utf8'), 'retained outside data', 'purge must unlink, not follow, a contained symlink');
  assert.equal(await fs.readFile(baselineMedia, 'utf8'), 'independent immutable baseline bytes');
  await assert.rejects(() => fs.lstat(path.join(aiReviewRoot, state.jobId)), { code: 'ENOENT' });
  await assert.rejects(
    () => fs.lstat(path.join(queue.root, 'idempotency', `${state.idempotencyKeyDigest}.json`)),
    { code: 'ENOENT' },
  );
  assert.deepEqual(await fs.readdir(path.join(queue.root, '.single-site-purge-journals')), []);
  const relaunchedInput = { schemaVersion: 1, fixture: 'purge-recoverable' };
  const relaunched = await submitJob(queue, submission(relaunchedInput, 'recoverable'), { inputDocument: relaunchedInput });
  assert.equal(relaunched.created, true, 'purge must remove the exact idempotency binding so a deliberate relaunch is usable');
  assert.equal(relaunched.state.jobId, state.jobId, 'the deterministic run identity can be safely recreated after complete purge');

  const pendingFinalization = await createJob(queue, 'pending-finalization');
  await assert.rejects(
    purgeSingleSiteRun({
      queue, finalizationRoot, baselineStore, jobId: pendingFinalization.jobId,
      confirmation: singleSitePurgeConfirmation(pendingFinalization.jobId),
      dependencies: { assertNoNestedMounts: noNestedMounts },
    }),
    expectCode('SINGLE_SITE_PURGE_FINALIZATION_PENDING'),
  );
  assert.equal((await fs.lstat(path.join(queue.root, 'jobs', pendingFinalization.jobId))).isDirectory(), true);

  const bounded = await createJob(queue, 'bounded');
  await publishFinalization(finalizationRoot, bounded.jobId);
  await fs.writeFile(path.join(queue.root, 'jobs', bounded.jobId, 'extra-one'), 'one');
  await fs.writeFile(path.join(queue.root, 'jobs', bounded.jobId, 'extra-two'), 'two');
  await assert.rejects(
    purgeSingleSiteRun({
      queue, finalizationRoot, baselineStore, jobId: bounded.jobId,
      confirmation: singleSitePurgeConfirmation(bounded.jobId),
      limits: { maxEntries: 2 },
      dependencies: { assertNoNestedMounts: noNestedMounts },
    }),
    expectCode('SINGLE_SITE_PURGE_LIMIT'),
  );
  assert.equal((await fs.lstat(path.join(queue.root, 'jobs', bounded.jobId))).isDirectory(), true,
    'inspection limit failures must happen before quarantine begins');

  const defaultAi = await createJob(queue, 'default-ai-root');
  const defaultAiFinalization = await publishFinalization(finalizationRoot, defaultAi.jobId);
  await purgeSingleSiteRun({
    queue, finalizationRoot, baselineStore, jobId: defaultAi.jobId,
    confirmation: singleSitePurgeConfirmation(defaultAi.jobId),
    dependencies: { assertNoNestedMounts: noNestedMounts },
  });
  await assert.rejects(() => fs.lstat(defaultAiFinalization), { code: 'ENOENT' });

  console.log('Single-site purge self-test passed: exact confirmation, terminal/finalization guards, baseline fencing, bounded accounting, symlink-safe deletion, independent baseline retention, and journal recovery are enforced.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
