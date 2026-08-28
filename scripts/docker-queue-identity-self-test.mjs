import assert from 'node:assert/strict';
import {
  claimJob,
  listJobs,
  openJobQueue,
  readJob,
  sha256,
  submitJob,
  transitionJob,
} from './lib/job-queue.mjs';

const action = process.argv[2];
const root = process.env.AUDIT_JOB_QUEUE_ROOT;
if (!root || !['submit', 'claim', 'verify'].includes(action)) {
  throw new Error('Usage: AUDIT_JOB_QUEUE_ROOT=<path> node scripts/docker-queue-identity-self-test.mjs <submit|claim|verify>');
}

const digest = (label) => sha256(`docker-queue-identity:${label}`);
const inputDocument = {
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
  runnerRevision: 'runner-cross-identity-v1',
};
const submission = {
  idempotencyKey: 'docker-cross-identity-proof',
  runMode: 'single-site',
  inputDocumentDigest: sha256(inputDocument),
  runContractDigest: digest('run-contract'),
  compiledManifestDigest: digest('compiled-manifest'),
  preflightDigest: digest('preflight'),
  identityFingerprint: digest('identity'),
  revisionFingerprint: digest('revision'),
  evidenceAuthority: { authoritative: true, reasons: [] },
  registryRevision: 'plugins-cross-identity-v1',
  targetSetRevision: 'targets-cross-identity-v1',
  runnerRevision: 'runner-cross-identity-v1',
  stageDeadlines: {
    browser: '2030-01-01T00:10:00.000Z',
    finalizer: '2030-01-01T00:20:00.000Z',
  },
};

const queue = await openJobQueue({ root, verifyStorage: false });

if (action === 'submit') {
  const result = await submitJob(queue, submission, { inputDocument });
  assert.equal(result.created, true);
  assert.equal(result.state.executionState, 'queued');
  console.log(`Cross-identity queue submit passed as uid=${process.getuid?.()} gid=${process.getgid?.()}.`);
} else if (action === 'claim') {
  const [job] = await listJobs(queue);
  assert(job, 'The non-root worker must be able to list the root-created job.');
  const claim = await claimJob(queue, job.jobId, 'docker-cross-identity-worker');
  const running = await transitionJob(queue, claim, 'running', {
    message: 'Cross-identity worker proved shared queue read/write access.',
  });
  assert.equal(running.executionState, 'running');
  console.log(`Cross-identity queue claim passed as uid=${process.getuid?.()} gid=${process.getgid?.()}.`);
} else {
  const [job] = await listJobs(queue);
  assert(job, 'The root verifier must be able to read the worker-updated job.');
  const state = await readJob(queue, job.jobId);
  assert.equal(state.executionState, 'running');
  assert.equal(state.lease?.workerId, 'docker-cross-identity-worker');
  console.log(`Cross-identity queue verification passed as uid=${process.getuid?.()} gid=${process.getgid?.()}.`);
}
