import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertJobEnvelope,
  assertSupportedFilesystemType,
  cancelJob,
  claimJob,
  heartbeatJob,
  listIndexedJobs,
  listJobs,
  openJobQueue,
  publishAttemptDocument,
  readJob,
  readJobInput,
  settleJobAttempt,
  sha256,
  submitJob,
  transitionJob,
  verifyQueueStorageSemantics,
  verifyJobCheckpoint,
} from './lib/job-queue.mjs';

function digest(label) {
  return sha256(`queue-self-test:${label}`);
}

function workerInput(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'single-site-worker-input',
    runContract: { mode: 'single-site', url: 'https://beta.example.test' },
    coverageManifest: { manifestDigest: digest('compiled-manifest'), caseIds: ['HOME-001'] },
    launchCheckpoint: {
      preflightDigest: digest('preflight'),
      identityFingerprint: digest('identity'),
      revisionFingerprint: digest('revision'),
      evidenceAuthority: { authoritative: true, reasons: [] },
    },
    runnerRevision: 'runner-v9',
    ...overrides,
  };
}

function submission(idempotencyKey, overrides = {}) {
  return {
    idempotencyKey,
    runMode: 'single-site',
    inputDocumentDigest: sha256(workerInput()),
    runContractDigest: digest('run-contract'),
    compiledManifestDigest: digest('compiled-manifest'),
    preflightDigest: digest('preflight'),
    identityFingerprint: digest('identity'),
    revisionFingerprint: digest('revision'),
    evidenceAuthority: { authoritative: true, reasons: [] },
    registryRevision: 'plugins-v7',
    targetSetRevision: 'targets-v4',
    runnerRevision: 'runner-v9',
    stageDeadlines: {
      browser: '2030-01-01T00:10:00.000Z',
      finalizer: '2030-01-01T00:20:00.000Z',
    },
    ...overrides,
  };
}

async function expectCode(promiseOrFunction, code) {
  await assert.rejects(
    typeof promiseOrFunction === 'function' ? promiseOrFunction : promiseOrFunction,
    (error) => error?.code === code,
    `Expected queue error ${code}`,
  );
}

async function allFiles(root) {
  const output = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else output.push(absolute);
    }
  }
  await visit(root);
  return output.sort();
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'single-site-queue-'));
try {
  let now = Date.parse('2026-08-25T12:00:00.000Z');
  let nonceSequence = 0;
  const nonce = () => `nonce-${String(++nonceSequence).padStart(4, '0')}`;

  const storage = await verifyQueueStorageSemantics({ root: temporaryRoot, nonce });
  assert.deepEqual(
    { atomicMkdir: storage.atomicMkdir, atomicRename: storage.atomicRename, fsync: storage.fsync },
    { atomicMkdir: true, atomicRename: true, fsync: true },
  );
  assert.match(storage.filesystemType, /^0x[0-9a-f]+$/);
  assert.throws(() => assertSupportedFilesystemType(0x6969n), (error) => error?.code === 'QUEUE_UNSUPPORTED_FILESYSTEM');
  assert.throws(() => assertSupportedFilesystemType(0xff534d42n), (error) => error?.code === 'QUEUE_UNSUPPORTED_FILESYSTEM');

  const symlinkTarget = path.join(temporaryRoot, 'real-root');
  const symlinkRoot = path.join(temporaryRoot, 'symlink-root');
  await fs.mkdir(symlinkTarget);
  await fs.symlink(symlinkTarget, symlinkRoot);
  await expectCode(() => verifyQueueStorageSemantics({ root: symlinkRoot, nonce }), 'QUEUE_UNSUPPORTED_FILESYSTEM');

  const queueRoot = path.join(temporaryRoot, 'queue');
  const queue = await openJobQueue({
    root: queueRoot,
    clock: () => now,
    nonce,
    heartbeatMs: 100,
    leaseMs: 500,
    lockStaleMs: 1_000,
  });
  assert.equal(queue.storage?.atomicMkdir, true);

  assert.throws(
    () => assertJobEnvelope({ schemaVersion: 1 }),
    (error) => error?.code === 'QUEUE_SCHEMA_INVALID',
  );
  await expectCode(
    () => submitJob(queue, { ...submission('secret-field'), anthropicApiKey: 'must-not-enter-envelope' }),
    'QUEUE_SCHEMA_INVALID',
  );
  await expectCode(
    () => submitJob(queue, submission('missing-revision', {
      revisionFingerprint: null,
      evidenceAuthority: { authoritative: true, reasons: [] },
    })),
    'QUEUE_SCHEMA_INVALID',
  );

  const concurrentSubmissions = await Promise.all([
    submitJob(queue, submission('launch-key-1'), { inputDocument: workerInput() }),
    submitJob(queue, submission('launch-key-1'), { inputDocument: workerInput() }),
  ]);
  assert.equal(concurrentSubmissions.filter((result) => result.created).length, 1, 'exactly one launch creates the job');
  assert.equal(concurrentSubmissions[0].state.jobId, concurrentSubmissions[1].state.jobId);
  const firstJobId = concurrentSubmissions[0].state.jobId;
  assert.deepEqual(await readJobInput(queue, firstJobId), workerInput());
  assert.equal(concurrentSubmissions[0].state.idempotencyKeyDigest, sha256('launch-key-1'));
  assert.doesNotMatch(JSON.stringify(concurrentSubmissions[0].state), /launch-key-1/);

  const duplicate = await submitJob(queue, submission('launch-key-1'), { inputDocument: workerInput() });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.state.submittedAt, concurrentSubmissions[0].state.submittedAt, 'duplicate returns original envelope');
  await expectCode(
    () => submitJob(queue, submission('launch-key-1', { runnerRevision: 'runner-v10' })),
    'QUEUE_IDEMPOTENCY_CONFLICT',
  );
  await expectCode(
    () => submitJob(queue, submission('input-digest-mismatch'), {
      inputDocument: workerInput({ runnerRevision: 'runner-v10' }),
    }),
    'QUEUE_INPUT_MISMATCH',
  );

  const idempotencyDigest = sha256('launch-key-1');
  const idempotencyBinding = path.join(queueRoot, 'idempotency', `${idempotencyDigest}.json`);
  const orphanedIdempotencyLock = path.join(queueRoot, 'idempotency', `${idempotencyDigest}.lock`);
  await fs.rm(idempotencyBinding);
  await fs.mkdir(orphanedIdempotencyLock);
  const staleIdempotencyLockTime = new Date(Date.now() - 5_000);
  await fs.utimes(orphanedIdempotencyLock, staleIdempotencyLockTime, staleIdempotencyLockTime);
  const repairedDuplicate = await submitJob(queue, submission('launch-key-1'));
  assert.equal(repairedDuplicate.created, false, 'restart repairs a missing binding without recreating its deterministic job');
  assert.equal(repairedDuplicate.state.jobId, firstJobId);
  assert.deepEqual((await listJobs(queue)).map((job) => job.jobId), [firstJobId]);

  const orphanedControlLock = path.join(queueRoot, 'jobs', firstJobId, 'control.lock');
  await fs.mkdir(orphanedControlLock);
  const staleLockTime = new Date(Date.now() - 5_000);
  await fs.utimes(orphanedControlLock, staleLockTime, staleLockTime);

  const claimRace = await Promise.allSettled([
    claimJob(queue, firstJobId, 'worker-a'),
    claimJob(queue, firstJobId, 'worker-b'),
  ]);
  const winningClaims = claimRace.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  const losingClaims = claimRace.filter((result) => result.status === 'rejected').map((result) => result.reason);
  assert.equal(winningClaims.length, 1, 'atomic mkdir admits one worker');
  assert.equal(losingClaims.length, 1);
  assert.ok(['QUEUE_ALREADY_CLAIMED', 'QUEUE_LOCK_BUSY'].includes(losingClaims[0].code));
  const firstClaim = winningClaims[0];
  assert.equal(firstClaim.attemptNumber, 1);
  assert.equal(firstClaim.fencingToken, 1);

  await transitionJob(queue, firstClaim, 'running');
  await verifyJobCheckpoint(queue, firstClaim, {
    identityFingerprint: digest('identity'),
    revisionFingerprint: digest('revision'),
    preflightDigest: digest('preflight'),
    compiledManifestDigest: digest('compiled-manifest'),
    registryRevision: 'plugins-v7',
    targetSetRevision: 'targets-v4',
    runnerRevision: 'runner-v9',
  });
  const beforeHeartbeat = await readJob(queue, firstJobId);
  now += 100;
  await heartbeatJob(queue, firstClaim, { activityState: 'stalled' });
  const afterHeartbeat = await readJob(queue, firstJobId);
  assert.equal(afterHeartbeat.executionState, 'running', 'activity does not overwrite durable execution state');
  assert.equal(afterHeartbeat.activityState, 'stalled');
  assert.ok(afterHeartbeat.lease.expiresAt > beforeHeartbeat.lease.expiresAt);

  const firstPublication = await publishAttemptDocument(queue, firstClaim, {
    publicationId: 'browser-result',
    relativePath: 'browser/result.json',
    document: { exitCode: 0, freshEvidence: true },
  });
  assert.equal(firstPublication.fencingToken, firstClaim.fencingToken);
  const blankLogPublication = await publishAttemptDocument(queue, firstClaim, {
    publicationId: 'blank-log-line',
    relativePath: 'browser/blank-log-line.json',
    document: { event: { stream: 'stdout', line: '' } },
  });
  assert.equal(blankLogPublication.fencingToken, firstClaim.fencingToken, 'legitimate empty log lines remain publishable');
  await expectCode(
    () => publishAttemptDocument(queue, firstClaim, {
      publicationId: 'secret-log-line',
      relativePath: 'browser/secret.json',
      document: { authorization: 'Bearer never-persist-this-token' },
    }),
    'QUEUE_SECRET_REJECTED',
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(
      queueRoot,
      'jobs',
      firstJobId,
      'attempts',
      firstClaim.attemptId,
      'published',
      'browser',
      'result.json',
    ), 'utf8')).freshEvidence,
    true,
  );
  const duplicatePublication = await publishAttemptDocument(queue, firstClaim, {
    publicationId: 'browser-result',
    relativePath: 'browser/result.json',
    document: { exitCode: 0, freshEvidence: true },
  });
  assert.deepEqual(duplicatePublication, firstPublication, 'same fenced publication is idempotent');
  await expectCode(
    () => publishAttemptDocument(queue, firstClaim, {
      publicationId: 'browser-result',
      relativePath: 'browser/result.json',
      document: { exitCode: 1, freshEvidence: false },
    }),
    'QUEUE_PUBLICATION_CONFLICT',
  );

  now = Date.parse(afterHeartbeat.lease.expiresAt) + 1;
  await expectCode(
    () => publishAttemptDocument(queue, firstClaim, {
      publicationId: 'late-before-recovery',
      relativePath: 'browser/late.json',
      document: { stale: true },
    }),
    'QUEUE_LEASE_EXPIRED',
  );

  const recoveryClaim = await claimJob(queue, firstJobId, 'worker-recovery');
  assert.equal(recoveryClaim.attemptNumber, 2);
  assert.ok(recoveryClaim.fencingToken > firstClaim.fencingToken);
  let recoveredState = await readJob(queue, firstJobId);
  assert.equal(recoveredState.infrastructureRetriesUsed, 1);
  assert.equal(recoveredState.activityState, 'recovering');
  await expectCode(
    () => publishAttemptDocument(queue, firstClaim, {
      publicationId: 'late-after-recovery',
      relativePath: 'browser/late-recovered.json',
      document: { stale: true },
    }),
    'QUEUE_STALE_FENCE',
  );
  await transitionJob(queue, recoveryClaim, 'running');
  recoveredState = await settleJobAttempt(queue, recoveryClaim, {
    kind: 'infrastructure-failure',
    reason: 'Container exited via SIGKILL.',
  });
  assert.equal(recoveredState.executionState, 'incomplete');
  assert.equal(recoveredState.infrastructureRetriesUsed, 1);
  assert.ok(recoveredState.fencingToken > recoveryClaim.fencingToken);
  await expectCode(() => claimJob(queue, firstJobId, 'worker-third-attempt'), 'QUEUE_TERMINAL');
  await expectCode(
    () => publishAttemptDocument(queue, recoveryClaim, {
      publicationId: 'late-after-exhaustion',
      relativePath: 'browser/late-exhausted.json',
      document: { stale: true },
    }),
    'QUEUE_STALE_FENCE',
  );

  const assertionJob = await submitJob(queue, submission('assertion-findings'));
  const assertionClaim = await claimJob(queue, assertionJob.state.jobId, 'worker-assertion');
  await transitionJob(queue, assertionClaim, 'running');
  await publishAttemptDocument(queue, assertionClaim, {
    publicationId: 'fresh-findings',
    relativePath: 'results/findings.json',
    document: { exitCode: 1, findings: [{ auditId: 'NAV-001' }] },
  });
  const findingsState = await settleJobAttempt(queue, assertionClaim, {
    kind: 'assertion-failure',
    reason: 'Playwright exit 1 with fresh structured evidence.',
  });
  assert.equal(findingsState.executionState, 'completed');
  assert.equal(findingsState.result.kind, 'findings');
  assert.equal(findingsState.infrastructureRetriesUsed, 0, 'assertion findings never consume infrastructure retry');

  const missingEvidenceJob = await submitJob(queue, submission('missing-current-evidence'));
  const missingEvidenceClaim = await claimJob(queue, missingEvidenceJob.state.jobId, 'worker-no-evidence');
  await expectCode(
    () => settleJobAttempt(queue, missingEvidenceClaim, { kind: 'assertion-failure' }),
    'QUEUE_EVIDENCE_REQUIRED',
  );
  await cancelJob(queue, missingEvidenceJob.state.jobId, 'Self-test cleanup after missing-evidence rejection.');

  const changedDeploymentJob = await submitJob(queue, submission('changed-deployment'));
  const changedDeploymentClaim = await claimJob(queue, changedDeploymentJob.state.jobId, 'worker-checkpoint');
  await expectCode(
    () => verifyJobCheckpoint(queue, changedDeploymentClaim, {
      identityFingerprint: digest('identity'),
      revisionFingerprint: digest('different-revision'),
      preflightDigest: digest('preflight'),
      compiledManifestDigest: digest('compiled-manifest'),
      registryRevision: 'plugins-v7',
      targetSetRevision: 'targets-v4',
      runnerRevision: 'runner-v9',
    }),
    'QUEUE_CHECKPOINT_CHANGED',
  );
  const changedDeploymentState = await readJob(queue, changedDeploymentJob.state.jobId);
  assert.equal(changedDeploymentState.executionState, 'incomplete');
  assert.ok(changedDeploymentState.fencingToken > changedDeploymentClaim.fencingToken);
  await expectCode(
    () => publishAttemptDocument(queue, changedDeploymentClaim, {
      publicationId: 'mixed-revision-output',
      relativePath: 'browser/mixed-revision.json',
      document: { revision: 'different' },
    }),
    'QUEUE_STALE_FENCE',
  );

  const cancellationJob = await submitJob(queue, submission('operator-cancellation'));
  const cancellationClaim = await claimJob(queue, cancellationJob.state.jobId, 'worker-cancelled');
  await transitionJob(queue, cancellationClaim, 'running');
  const cancelled = await cancelJob(queue, cancellationJob.state.jobId, 'Operator stopped the audit.');
  assert.equal(cancelled.executionState, 'cancelled');
  assert.equal(cancelled.result.kind, 'incomplete');
  assert.ok(cancelled.fencingToken > cancellationClaim.fencingToken);
  assert.equal((await cancelJob(queue, cancellationJob.state.jobId, 'Operator stopped the audit.')).sequence, cancelled.sequence);
  await expectCode(
    () => publishAttemptDocument(queue, cancellationClaim, {
      publicationId: 'post-cancel-output',
      relativePath: 'browser/post-cancel.json',
      document: { mustNotPublish: true },
    }),
    'QUEUE_STALE_FENCE',
  );

  const nonAuthoritativeJob = await submitJob(queue, submission('no-revision-signal', {
    revisionFingerprint: null,
    evidenceAuthority: { authoritative: false, reasons: ['missing-deployment-revision'] },
  }));
  assert.equal(nonAuthoritativeJob.state.evidenceAuthority.authoritative, false);
  assert.equal(nonAuthoritativeJob.state.revisionFingerprint, null);

  const tampered = structuredClone(nonAuthoritativeJob.state);
  tampered.untrusted = true;
  assert.throws(() => assertJobEnvelope(tampered), (error) => error?.code === 'QUEUE_SCHEMA_INVALID');
  const immutableTamper = structuredClone(nonAuthoritativeJob.state);
  immutableTamper.runnerRevision = 'runner-tampered';
  assert.throws(() => assertJobEnvelope(immutableTamper), (error) => error?.code === 'QUEUE_SCHEMA_INVALID');

  const retainedHistoryCount = 300;
  await Promise.all(Array.from({ length: retainedHistoryCount }, (_value, index) =>
    submitJob(queue, submission(`retained-history-${String(index).padStart(4, '0')}`))));
  let readyCursor = null;
  const indexedReady = new Set();
  for (let pageNumber = 0; pageNumber < 512 && indexedReady.size < retainedHistoryCount + 1; pageNumber += 1) {
    const page = await listIndexedJobs(queue, { category: 'ready', cursor: readyCursor, limit: 37 });
    assert(page.jobs.length <= 37, 'ready index pages stay within their durable scan bound');
    assert(page.scannedMarkers <= 148, 'stale marker cleanup is bounded per page');
    page.jobs.forEach(({ jobId }) => indexedReady.add(jobId));
    readyCursor = page.cursor;
  }
  assert(indexedReady.size >= retainedHistoryCount + 1, 'cursorable ready shards reach all retained queued work');
  const terminalPage = await listIndexedJobs(queue, { category: 'terminal', limit: 3 });
  assert(terminalPage.jobs.length <= 3, 'terminal history is also consumed in bounded pages');

  const files = await allFiles(queueRoot);
  assert.equal(files.some((file) => file.endsWith('.tmp')), false, 'atomic publisher leaves no temporary state files');
  const serializedQueue = (await Promise.all(files.map(async (file) => {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return '';
    }
  }))).join('\n');
  assert.doesNotMatch(serializedQueue, /must-not-enter-envelope|anthropicApiKey/);

  console.log('single-site queue self-test passed');
  console.log(`  jobs exercised: ${(await listJobs(queue)).length}`);
  console.log('  atomic claim race: exactly one winner');
  console.log('  stale publication: rejected before and after recovery');
  console.log('  infrastructure retries: capped at one');
  console.log('  assertion findings: completed evidence, no retry');
  console.log('  cancellation: fenced active worker');
  console.log('  deployment checkpoint change: fenced INCOMPLETE');
  console.log('  restart recovery: stale locks and interrupted idempotency binding repaired');
  console.log('  retained-history scale: sharded ready/terminal index pages remain bounded and cursor-complete');
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
