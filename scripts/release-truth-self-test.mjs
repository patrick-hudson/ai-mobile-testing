import assert from 'node:assert/strict';
import { parseChecklistRelease, pipelineOnlyOutcome, releaseOutcome } from './lib/release-truth.mjs';
import {
  applyGalleryFlagTransition,
  galleryFlagRevision,
  projectGalleryFlags,
} from '../shared/gallery-contract.mjs';

const ready = parseChecklistRelease({
  schemaVersion: 1,
  release: {
    ready: true,
    decision: 'READY',
    reason: 'Candidate gates passed; production-only defects are baseline context.',
    decisionBasis: 'Candidate gates are authoritative; production-only defects are baseline context.',
    blockingFailures: 0,
    blockingIncomplete: 0,
    baselineIssues: 3,
    runIntegrityFailure: false,
  },
});
assert.equal(releaseOutcome('completed', ready).status, 'ready');
assert.equal(releaseOutcome('completed', ready).exitCode, 0);
assert.throws(() => parseChecklistRelease({
  schemaVersion: 1,
  mode: 'single-site',
  release: {
    ready: true,
    decision: 'READY',
    reason: 'This field must not grant promotion authority.',
    decisionBasis: 'Single-site health is advisory.',
    blockingFailures: 0,
    blockingIncomplete: 0,
    baselineIssues: 0,
    runIntegrityFailure: false,
  },
}), /cannot be parsed as comparative release truth/);

const notReady = parseChecklistRelease({
  schemaVersion: 1,
  release: {
    ready: false,
    decision: 'NOT_READY',
    reason: 'One candidate release gate failed.',
    decisionBasis: 'Candidate and explicit cross-environment gates block release.',
    blockingFailures: 1,
    blockingIncomplete: 0,
    baselineIssues: 0,
    runIntegrityFailure: false,
  },
});
assert.equal(releaseOutcome('completed', notReady).status, 'not-ready');
assert.equal(releaseOutcome('completed', notReady).exitCode, 1);
assert.equal(pipelineOnlyOutcome('completed', notReady).status, 'smoke-checks-failed');
assert.equal(pipelineOnlyOutcome('completed', notReady).exitCode, 1);
assert.equal(pipelineOnlyOutcome('failed', notReady).status, 'pipeline-failed');
assert.equal(pipelineOnlyOutcome('failed', notReady).exitCode, 1);
assert.equal(releaseOutcome('failed', ready).status, 'pipeline-failed');
assert.throws(() => parseChecklistRelease({
  schemaVersion: 1,
  release: {
    ready: false,
    decision: 'UNAVAILABLE',
    reason: 'Pipeline integrity failed; counts are diagnostic only.',
    decisionBasis: 'sharded-run.json remains authoritative.',
    blockingFailures: 0,
    blockingIncomplete: 0,
    baselineIssues: 0,
    runIntegrityFailure: true,
  },
}), /READY or NOT_READY/, 'a diagnostic checklist must never become authoritative release truth');

const incompleteSmoke = parseChecklistRelease({
  schemaVersion: 1,
  release: {
    ready: false,
    decision: 'NOT_READY',
    reason: 'No executed checks failed, but the release catalog is intentionally incomplete.',
    decisionBasis: 'Smoke validates executed gates without certifying the release.',
    blockingFailures: 0,
    blockingIncomplete: 20,
    baselineIssues: 2,
    runIntegrityFailure: false,
  },
});
assert.equal(pipelineOnlyOutcome('completed', incompleteSmoke).status, 'completed-not-ready');
assert.equal(pipelineOnlyOutcome('completed', incompleteSmoke).exitCode, 0);
assert.throws(() => parseChecklistRelease({
  schemaVersion: 1,
  release: {
    ready: false,
    decision: 'READY',
    reason: 'Contradiction.',
    decisionBasis: 'Test policy.',
    blockingFailures: 0,
    blockingIncomplete: 0,
    baselineIssues: 0,
    runIntegrityFailure: false,
  },
}), /contradicts/);
assert.throws(() => parseChecklistRelease({
  schemaVersion: 1,
  release: {
    ready: true,
    decision: 'READY',
    reason: '',
    decisionBasis: 'Test policy.',
    blockingFailures: 0,
    blockingIncomplete: 0,
    baselineIssues: 0,
    runIntegrityFailure: false,
  },
}), /reason/);
assert.throws(() => parseChecklistRelease({
  schemaVersion: 1,
  release: {
    ready: true,
    decision: 'READY',
    reason: 'Contradicts blocking count.',
    decisionBasis: 'Test policy.',
    blockingFailures: 1,
    blockingIncomplete: 0,
    baselineIssues: 0,
    runIntegrityFailure: false,
  },
}), /blocking or run-integrity/);

assert.throws(() => parseChecklistRelease({ release: ready }), /schemaVersion/);
assert.throws(() => parseChecklistRelease({ schemaVersion: 2, release: ready }), /schemaVersion/);

const completeReadyRelease = {
  ready: true,
  decision: 'READY',
  reason: 'All release gates passed with authoritative evidence.',
  decisionBasis: 'The complete versioned checklist is authoritative.',
  blockingFailures: 0,
  blockingIncomplete: 0,
  baselineIssues: 0,
  runIntegrityFailure: false,
};
for (const requiredField of [
  'blockingFailures',
  'blockingIncomplete',
  'baselineIssues',
  'runIntegrityFailure',
  'decisionBasis',
]) {
  const incompleteRelease = { ...completeReadyRelease };
  delete incompleteRelease[requiredField];
  assert.throws(
    () => parseChecklistRelease({ schemaVersion: 1, release: incompleteRelease }),
    new RegExp(requiredField),
    `READY must not be accepted without ${requiredField}.`,
  );
  const nullRelease = { ...completeReadyRelease, [requiredField]: null };
  assert.throws(
    () => parseChecklistRelease({ schemaVersion: 1, release: nullRelease }),
    new RegExp(requiredField),
    `READY must not be accepted with null ${requiredField}.`,
  );
}

const releaseBeforeFlags = JSON.stringify(notReady);
const openedHistory = applyGalleryFlagTransition({
  schemaVersion: 1,
  throughEvent: 0,
  events: [],
}, {
  action: 'open',
  itemId: 'gitem_0123456789abcdef',
  identity: {
    testId: 'source-test-1',
    title: 'Candidate navigation remains usable',
    project: 'candidate-mobile-chromium',
    attempt: 1,
    auditIds: ['NAV-001'],
  },
  reviewer: 'Local reviewer',
  note: 'The focus indicator is clipped after navigation.',
  idempotencyKey: 'release-truth-open-1',
  expectedFlagRevision: galleryFlagRevision({ schemaVersion: 1, throughEvent: 0, events: [] }),
  timestamp: '2026-08-24T12:00:00.000Z',
  eventId: 'gfevent_0123456789abcdef',
  flagId: 'gflag_0123456789abcdef',
});
const resolvedHistory = applyGalleryFlagTransition(openedHistory.history, {
  action: 'resolve',
  flagId: openedHistory.event.flagId,
  reviewer: 'Local reviewer',
  justification: 'Verified after the candidate CSS correction.',
  idempotencyKey: 'release-truth-resolve-1',
  expectedFlagRevision: openedHistory.flagRevision,
  timestamp: '2026-08-24T12:05:00.000Z',
  eventId: 'gfevent_fedcba9876543210',
});
assert.equal(projectGalleryFlags(resolvedHistory.history.events)[0].state, 'resolved');
assert.equal(projectGalleryFlags(resolvedHistory.history.events, 1)[0].state, 'open');
assert.equal(JSON.stringify(notReady), releaseBeforeFlags, 'reviewer flags must not mutate release truth');

console.log('Release-truth self-test passed.');
