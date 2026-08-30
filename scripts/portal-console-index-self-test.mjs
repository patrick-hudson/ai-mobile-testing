import assert from 'node:assert/strict';
import {
  CONSOLE_INDEX_FIELD_NAMES,
  CONSOLE_INDEX_MAX_PAGE_SIZE,
  CONSOLE_INDEX_MAX_REPLACEMENT_BATCH_RECORDS,
  CONSOLE_INDEX_MAX_REPLACEMENT_RECORDS,
  CONSOLE_INDEX_RECORD_TYPES,
  CONSOLE_INDEX_SCHEMA_VERSION,
  DEFAULT_CONSOLE_INDEX_BUDGET,
  ConsoleIndexError,
  consumeConsoleReadWork,
  createConsoleIndex,
  createConsoleReadBudget,
  createConsoleReadWork,
  decodeConsoleIndexCursor,
} from '../portal/console-index.mjs';

const AT = '2026-08-26T12:00:00.000Z';
const later = (seconds) => new Date(Date.parse(AT) + seconds * 1_000).toISOString();

function record({
  mode = 'comparative',
  runId = 'run-1',
  recordId = 'run',
  recordType = 'run',
  scopeKey = 'scope:release',
  sourceId = mode === 'comparative' ? 'comparative-runs' : 'single-site-jobs',
  sourceRevision = 'revision-1',
  sourceUpdatedAt = AT,
  complete = true,
  sortKey = `${runId}:${recordId}`,
  fields = { title: runId, status: 'completed', terminal: true },
} = {}) {
  return {
    schemaVersion: 1,
    mode,
    runId,
    recordId,
    recordType,
    scopeKey,
    sourceId,
    sourceRevision,
    sourceUpdatedAt,
    complete,
    sortKey,
    fields,
  };
}

assert.equal(CONSOLE_INDEX_SCHEMA_VERSION, 1);
assert.equal(CONSOLE_INDEX_MAX_PAGE_SIZE, 100);
assert.equal(CONSOLE_INDEX_MAX_REPLACEMENT_BATCH_RECORDS, 100);
assert.equal(CONSOLE_INDEX_MAX_REPLACEMENT_RECORDS, 10_000);
assert.deepEqual(DEFAULT_CONSOLE_INDEX_BUDGET, {
  maxRecords: 100,
  maxSourceFiles: 32,
  maxSourceBytes: 2 * 1024 * 1024,
  maxElapsedMs: 100,
});
for (const value of [
  DEFAULT_CONSOLE_INDEX_BUDGET,
  CONSOLE_INDEX_RECORD_TYPES,
  CONSOLE_INDEX_FIELD_NAMES,
]) assert(Object.isFrozen(value));

const budget = createConsoleReadBudget();
let work = createConsoleReadWork();
let consumed = consumeConsoleReadWork(work, budget, {
  recordsRead: 100,
  sourceFilesRead: 31,
  sourceBytesRead: 2 * 1024 * 1024,
  elapsedMs: 99,
});
assert.equal(consumed.accepted, true);
work = consumed.work;
consumed = consumeConsoleReadWork(work, budget, { sourceFilesRead: 1, elapsedMs: 1 });
assert.equal(consumed.accepted, true, 'Exact budget boundaries must be allowed.');
consumed = consumeConsoleReadWork(consumed.work, budget, { sourceFilesRead: 1 });
assert.equal(consumed.accepted, false, 'Work beyond any bound must fail closed before accounting it as read.');
assert.equal(consumed.work.sourceFilesRead, 32);
assert.equal(consumed.work.budgetExhausted, true);
assert.throws(
  () => createConsoleReadBudget({ maxRecords: 101, unexpected: 1 }),
  (error) => error instanceof ConsoleIndexError && error.code === 'CONSOLE_INDEX_INVALID',
);

const index = createConsoleIndex({
  clock: () => Date.parse(AT),
  sources: [
    { sourceId: 'comparative-runs', revision: 'revision-0', updatedAt: AT, complete: false },
    { sourceId: 'single-site-jobs', revision: 'revision-0', updatedAt: AT, complete: false },
  ],
});
assert.equal(index.sourceVector().complete, false);
assert.equal(index.diagnostics().records, 0);
assert.equal(index.diagnostics().cacheEntries, 0, 'The ordered partition cache starts empty.');

const comparativeRun = record({
  runId: 'run-1',
  fields: {
    title: 'Comparative release run',
    status: 'passed',
    productionOrigin: 'https://quitting7oh.org',
    candidateOrigin: 'https://beta.quitting7oh.org',
    targetIds: ['candidate-desktop-chromium', 'production-desktop-chromium'],
    findingCount: 2,
  },
});
assert.equal(index.upsert(comparativeRun).committed, true);
assert.equal(index.read({ mode: 'comparative', runId: 'run-1' }).value.fields.status, 'passed');
assert.equal(index.read({ mode: 'single-site', runId: 'run-1' }).value, null, 'Modes must be physically partitioned.');

const singleSiteRun = record({
  mode: 'single-site',
  runId: 'run-1',
  sourceRevision: 'single-revision-1',
  scopeKey: 'scope:single-site',
  fields: { title: 'Single-site run', executionState: 'completed', terminal: true },
});
assert.equal(index.upsert(singleSiteRun).committed, true);
assert.equal(index.read({ mode: 'single-site', runId: 'run-1' }).value.fields.executionState, 'completed');
assert.equal(index.diagnostics().recordsByMode.comparative, 1);
assert.equal(index.diagnostics().recordsByMode['single-site'], 1);

const partialIndex = createConsoleIndex({
  sources: [{ sourceId: 'shared-parent-runs', revision: 'shared-1', updatedAt: AT, complete: true }],
});
partialIndex.upsert(record({
  runId: 'run-active-shared',
  sourceId: 'shared-parent-runs',
  complete: false,
  fields: { title: 'Active shared run', status: 'running', terminal: false },
}));
const partialRead = partialIndex.read({ mode: 'comparative', runId: 'run-active-shared' });
assert.equal(partialRead.complete, false);
assert.equal(partialRead.freshness, 'current',
  'A current partial publication must not be mislabeled as stale.');
assert(partialRead.limitations.some(({ code }) => code === 'incomplete-publication'));
assert.equal(partialIndex.page({
  mode: 'comparative', scopeKey: 'scope:release', normalizedFilterKey: 'active', cursor: null,
  limit: 10, recordTypes: ['run'],
}).freshness, 'current', 'A page of current partial records must not be mislabeled as stale.');

const authorityIndex = createConsoleIndex();
authorityIndex.upsert(record({ runId: 'run-authority', sourceId: 'comparative-runs' }), { authorityRank: 0 });
authorityIndex.upsert(record({
  runId: 'run-authority',
  sourceId: 'shared-parent-runs',
  sourceRevision: 'shared-1',
  fields: { title: 'Durable shared authority', status: 'running', terminal: false },
}), { authorityRank: 100 });
const rejectedLegacyOverwrite = authorityIndex.upsert(record({
  runId: 'run-authority',
  sourceId: 'comparative-runs',
  sourceRevision: 'legacy-late',
  fields: { title: 'Late legacy projection', status: 'running', terminal: false },
}), { authorityRank: 0 });
assert.equal(rejectedLegacyOverwrite.committed, false);
assert.equal(rejectedLegacyOverwrite.reason, 'lower-authority');
assert.equal(
  authorityIndex.read({ mode: 'comparative', runId: 'run-authority' }).value.sourceId,
  'shared-parent-runs',
  'A legacy projection must not replace the durable shared-run authority.',
);

for (const [name, hostile] of [
  ['unknown top-level field', { ...record(), credential: 'not-allowed' }],
  ['unknown fields member', record({ fields: { title: 'safe', credentialAvailable: true } })],
  ['nested payload', record({ fields: { title: { nested: true } } })],
  ['secret-like text', record({ fields: { detail: 'Authorization: Bearer abcdefghijklmnop' } })],
  ['credential-bearing origin', record({ fields: { auditedOrigin: 'https://user:pass@example.com' } })],
  ['unchecked URL', record({ fields: { detail: 'https://example.com/?access_token=abcdefghi' } })],
  ['overlong text', record({ fields: { title: 'x'.repeat(1_201) } })],
  ['oversized list', record({ fields: { auditIds: Array.from({ length: 65 }, (_, index) => `AUDIT-${index}`) } })],
]) {
  assert.throws(
    () => index.upsert(hostile),
    (error) => error instanceof ConsoleIndexError
      && ['CONSOLE_INDEX_INVALID', 'CONSOLE_INDEX_HOSTILE_VALUE'].includes(error.code),
    name,
  );
}
assert.equal(JSON.stringify(index.read({ mode: 'comparative', runId: 'run-1' })).includes('credential'), false);

const initialBackfill = index.beginBackfill('comparative-report', {
  revision: 'publication-1',
  updatedAt: AT,
  cursor: 'page-1',
});
assert.equal(initialBackfill.complete, false);
assert.equal(initialBackfill.limitation, 'incomplete-publication');
assert.equal(index.sourceVector().complete, false);
assert(index.page({
  mode: 'comparative',
  scopeKey: 'scope:release',
  normalizedFilterKey: 'all',
  cursor: null,
  limit: 10,
  recordTypes: ['run'],
}).limitations.some(({ sourceId }) => sourceId === 'comparative-report'));

const exhaustedWork = consumeConsoleReadWork(createConsoleReadWork(), DEFAULT_CONSOLE_INDEX_BUDGET, {
  recordsRead: 100,
  sourceFilesRead: 32,
  sourceBytesRead: 2 * 1024 * 1024,
  elapsedMs: 100,
}).work;
const exhausted = consumeConsoleReadWork(exhaustedWork, DEFAULT_CONSOLE_INDEX_BUDGET, { recordsRead: 1 }).work;
const partialBackfill = index.updateBackfill('comparative-report', {
  revision: 'publication-1',
  updatedAt: AT,
  cursor: 'page-2',
  complete: false,
  limitation: 'budget-exhausted',
  work: exhausted,
});
assert.equal(partialBackfill.work.budgetExhausted, true);
assert.equal(partialBackfill.limitation, 'budget-exhausted');
assert.throws(() => index.updateBackfill('comparative-report', {
  revision: 'publication-1',
  updatedAt: AT,
  cursor: 'page-3',
  complete: false,
  limitation: 'budget-exhausted',
  work: { ...createConsoleReadWork(), sourceBytesRead: DEFAULT_CONSOLE_INDEX_BUDGET.maxSourceBytes + 1 },
}), /beyond its configured budget/i);
index.updateBackfill('comparative-report', {
  revision: 'publication-1',
  updatedAt: later(1),
  cursor: null,
  complete: true,
  limitation: null,
  work: createConsoleReadWork({ recordsRead: 12, sourceFilesRead: 2, sourceBytesRead: 512, elapsedMs: 3 }),
});
assert.equal(index.backfillState('comparative-report').complete, true);

index.beginBackfill('comparative-runs', {
  revision: 'revision-1',
  updatedAt: later(1),
  cursor: null,
});
index.updateBackfill('comparative-runs', {
  revision: 'revision-1',
  updatedAt: later(1),
  cursor: null,
  complete: true,
  limitation: null,
  work: createConsoleReadWork({ recordsRead: 1 }),
});
index.beginBackfill('single-site-jobs', {
  revision: 'single-revision-1',
  updatedAt: later(1),
  cursor: null,
});
index.updateBackfill('single-site-jobs', {
  revision: 'single-revision-1',
  updatedAt: later(1),
  cursor: null,
  complete: true,
  limitation: null,
  work: createConsoleReadWork({ recordsRead: 1 }),
});
assert.equal(index.sourceVector().complete, true);

for (let value = 2; value <= 4; value += 1) {
  index.upsert(record({
    runId: `run-${value}`,
    sourceRevision: `revision-${value}`,
    sortKey: `000${value}`,
    fields: { title: `Run ${value}`, status: 'passed' },
  }));
}
const firstPage = index.page({
  mode: 'comparative',
  scopeKey: 'scope:release',
  normalizedFilterKey: 'status=all',
  cursor: null,
  limit: 2,
  recordTypes: ['run'],
});
assert.equal(firstPage.items.length, 2);
assert.equal(firstPage.hasMore, true);
assert.equal(firstPage.work.recordsRead, 2);
assert.equal(firstPage.work.sourceFilesRead, 0);
assert.equal(firstPage.work.sourceBytesRead, 0, 'Page reads must never fan out to authority files.');
const cursorDocument = decodeConsoleIndexCursor(firstPage.nextCursor);
assert.equal(cursorDocument.mode, 'comparative');
assert.equal(cursorDocument.scopeKey, 'scope:release');
assert.equal(cursorDocument.normalizedFilterKey, 'status=all');
assert.equal(cursorDocument.vectorRevision, firstPage.sourceVector.vectorRevision);
const secondPage = index.page({
  mode: 'comparative',
  scopeKey: 'scope:release',
  normalizedFilterKey: 'status=all',
  cursor: firstPage.nextCursor,
  limit: 2,
  recordTypes: ['run'],
});
assert.equal(secondPage.items.length, 2);
assert.equal(new Set([...firstPage.items, ...secondPage.items].map(({ runId }) => runId)).size, 4);
assert.equal(index.diagnostics().lastPageRecordsExamined, 0,
  'A cursor page on an unchanged revision must reuse the ordered partition instead of rescanning records.');
const scopeIndex = createConsoleIndex();
scopeIndex.upsert(record({ runId: 'run-release-scope', scopeKey: 'scope:release' }));
scopeIndex.upsert(record({ runId: 'run-other-scope', scopeKey: 'scope:targeted' }));
const allScopesPage = scopeIndex.page({
  mode: 'comparative', scopeKey: 'all', normalizedFilterKey: 'status=all', cursor: null,
  limit: 100, recordTypes: ['run'],
});
assert.equal(allScopesPage.items.length, 2, 'The explicit all-scopes query must span scope partitions without duplicating records.');
assert.equal(scopeIndex.page({
  mode: 'comparative', scopeKey: 'scope:release', normalizedFilterKey: 'status=all', cursor: null,
  limit: 100, recordTypes: ['run'],
}).items.length, 1, 'A specific scope must remain isolated.');
assert.equal(scopeIndex.diagnostics().lastPageRecordsExamined, 1,
  'A scope page must examine only that scope partition, not unrelated retained records.');

const scaleIndex = createConsoleIndex();
for (let value = 0; value < 5_000; value += 1) {
  scaleIndex.upsert(record({
    runId: `scale-${value}`,
    scopeKey: value === 4_999 ? 'scope:target' : `scope:unrelated-${value % 100}`,
    sortKey: String(value).padStart(8, '0'),
  }));
}
const targetScalePage = scaleIndex.page({
  mode: 'comparative', scopeKey: 'scope:target', normalizedFilterKey: 'scale', cursor: null,
  limit: 10, recordTypes: ['run'], orderBy: 'recent',
});
assert.equal(targetScalePage.items.length, 1);
assert.equal(scaleIndex.diagnostics().lastPageRecordsExamined, 1,
  'Page work must remain proportional to the selected partition at retained-record scale.');
const scaleSorts = scaleIndex.diagnostics().pageSorts;
scaleIndex.page({
  mode: 'comparative', scopeKey: 'scope:target', normalizedFilterKey: 'scale-again', cursor: null,
  limit: 10, recordTypes: ['run'], orderBy: 'recent',
});
assert.equal(scaleIndex.diagnostics().pageSorts, scaleSorts,
  'Normalized filter text must not duplicate an otherwise identical ordered source partition.');
assert.throws(() => index.page({
  mode: 'comparative',
  scopeKey: 'scope:release',
  normalizedFilterKey: 'status=changed',
  cursor: firstPage.nextCursor,
  limit: 2,
  recordTypes: ['run'],
}), (error) => error.code === 'CONSOLE_INDEX_CURSOR_STALE' && error.statusCode === 409);
assert.throws(() => index.page({
  mode: 'comparative', scopeKey: 'scope:release', normalizedFilterKey: 'all', cursor: null,
  limit: CONSOLE_INDEX_MAX_PAGE_SIZE + 1, recordTypes: ['run'],
}), /limit must be an integer/i);

const staleCursor = firstPage.nextCursor;
index.upsert(record({
  runId: 'run-5', sourceRevision: 'revision-5', sortKey: '0005', fields: { title: 'Run 5' },
}));
assert.throws(() => index.page({
  mode: 'comparative', scopeKey: 'scope:release', normalizedFilterKey: 'status=all',
  cursor: staleCursor, limit: 2, recordTypes: ['run'],
}), (error) => error.code === 'CONSOLE_INDEX_CURSOR_STALE');

const asyncRun = record({
  runId: 'run-async',
  sourceId: 'comparative-report',
  sourceRevision: 'publication-1',
  recordId: 'risk:finding-1',
  recordType: 'risk',
  fields: { title: 'Late finding', severity: 'P0', blocking: true },
});
const successfulAsyncToken = index.capture(
  { mode: asyncRun.mode, runId: asyncRun.runId },
  asyncRun.sourceId,
  asyncRun.sourceRevision,
);
assert.equal(index.commitAsync(successfulAsyncToken, asyncRun).committed, true);
index.invalidate({ mode: asyncRun.mode, runId: asyncRun.runId }, asyncRun.recordId);
const asyncToken = index.capture(
  { mode: asyncRun.mode, runId: asyncRun.runId },
  asyncRun.sourceId,
  asyncRun.sourceRevision,
);
const purgeToken = index.beginPurge(
  { mode: asyncRun.mode, runId: asyncRun.runId },
  { sourceId: asyncRun.sourceId, sourceRevision: asyncRun.sourceRevision, updatedAt: AT },
);
assert.equal(index.commitAsync(asyncToken, asyncRun).committed, false, 'A late async commit cannot cross a purge generation.');
assert.equal(index.upsert(asyncRun).committed, false, 'Direct lifecycle upserts cannot cross a purge barrier.');
assert.equal(index.invalidate({ mode: asyncRun.mode, runId: asyncRun.runId }, asyncRun.recordId), false,
  'Lifecycle invalidation must be ignored while the stronger purge barrier owns the identity.');
assert.equal(index.read({ mode: asyncRun.mode, runId: asyncRun.runId }, asyncRun.recordId).limitations[0].code, 'purged');
const committedPurge = index.commitPurge(purgeToken, { updatedAt: later(2) });
assert.equal(committedPurge.status, 'committed');
assert.equal(index.diagnostics().tombstones, 1);
assert.throws(() => index.abortPurge(purgeToken, [asyncRun]), (error) => error.code === 'CONSOLE_INDEX_PURGE_STALE');

const beforePurgePage = index.page({
  mode: 'comparative', scopeKey: 'scope:release', normalizedFilterKey: 'purge-race',
  cursor: null, limit: 1, recordTypes: ['run'],
});
assert(beforePurgePage.nextCursor);
index.beginPurge(
  { mode: 'comparative', runId: 'run-2' },
  { sourceId: 'comparative-runs', sourceRevision: 'revision-2', updatedAt: AT },
);
assert.throws(() => index.page({
  mode: 'comparative', scopeKey: 'scope:release', normalizedFilterKey: 'purge-race',
  cursor: beforePurgePage.nextCursor, limit: 1, recordTypes: ['run'],
}), (error) => error.code === 'CONSOLE_INDEX_CURSOR_STALE', 'Purge must invalidate existing cursors before authority deletion finishes.');

const restoredRun = record({ runId: 'run-restore', sourceRevision: 'restore-1' });
index.upsert(restoredRun);
index.upsert(record({
  runId: restoredRun.runId,
  recordId: 'timeline:1',
  recordType: 'timeline',
  sourceRevision: restoredRun.sourceRevision,
  fields: { stageId: 'playwright', sequence: 1 },
}));
const restoreToken = index.beginPurge(
  { mode: restoredRun.mode, runId: restoredRun.runId },
  { sourceId: restoredRun.sourceId, sourceRevision: restoredRun.sourceRevision, updatedAt: AT },
);
assert.equal(index.read({ mode: restoredRun.mode, runId: restoredRun.runId }).value, null);
assert.equal(index.diagnostics().records, 5, 'beginPurge must evict every record with the run identity prefix.');
assert.throws(
  () => index.abortPurge(restoreToken, []),
  (error) => error.code === 'CONSOLE_INDEX_PURGE_REVERIFY_REQUIRED',
);
const reread = record({ ...restoredRun, sourceRevision: 'restore-verified' });
const restored = index.abortPurge(restoreToken, [reread], { sourceComplete: true });
assert.equal(restored.restored, true);
assert.equal(index.read({ mode: reread.mode, runId: reread.runId }).value.sourceRevision, 'restore-verified');

const revisionRace = record({
  runId: 'run-race',
  sourceId: 'comparative-report',
  sourceRevision: 'publication-1',
  recordId: 'risk:finding-race',
  recordType: 'risk',
  fields: { title: 'Captured risk', severity: 'P1' },
});
const revisionToken = index.capture(
  { mode: revisionRace.mode, runId: revisionRace.runId },
  revisionRace.sourceId,
  revisionRace.sourceRevision,
);
index.beginBackfill('comparative-report', { revision: 'publication-2', updatedAt: later(3), cursor: null });
assert.equal(index.commitAsync(revisionToken, revisionRace).committed, false, 'Source revision changes must fence async commits.');

index.beginBackfill('slow-source', { revision: 'slow-1', updatedAt: AT, cursor: 'resume' });
const slowWork = consumeConsoleReadWork(createConsoleReadWork(), DEFAULT_CONSOLE_INDEX_BUDGET, {
  elapsedMs: DEFAULT_CONSOLE_INDEX_BUDGET.maxElapsedMs + 1,
}).work;
assert.equal(slowWork.budgetExhausted, true);
assert.equal(index.updateBackfill('slow-source', {
  revision: 'slow-1',
  updatedAt: AT,
  cursor: 'resume',
  complete: false,
  limitation: 'budget-exhausted',
  work: slowWork,
}).work.elapsedMs, 101, 'Unavoidable elapsed-time overrun must be reported truthfully while the slice remains incomplete.');

const beforeInvalidate = index.sourceVector().vectorRevision;
assert.equal(index.invalidate({ mode: 'comparative', runId: 'run-5' }), true);
assert.equal(index.read({ mode: 'comparative', runId: 'run-5' }).value, null);
assert.notEqual(index.sourceVector().vectorRevision, beforeInvalidate);

const reportSourceId = 'comparative-report-publication';
index.setSourceWatermark(reportSourceId, {
  revision: 'aggregate-watermark-1',
  updatedAt: later(4),
  complete: true,
  limitation: null,
});
const generationIdentity = { mode: 'comparative', runId: 'run-generation' };
index.upsert(record({
  ...generationIdentity,
  sourceRevision: 'lifecycle-1',
  fields: { title: 'Lifecycle row survives report replacement', terminal: true },
}));
const firstGeneration = index.beginReplacement(generationIdentity, {
  sourceId: reportSourceId,
  sourceRevision: 'publication-generation-1',
  sourceUpdatedAt: later(4),
  maximumRecords: 10,
});
assert.equal(firstGeneration.accepted, true);
assert.equal(index.stageReplacement(firstGeneration.token, [
  record({
    ...generationIdentity,
    recordId: 'risk:generation',
    recordType: 'risk',
    sourceId: reportSourceId,
    sourceRevision: 'publication-generation-1',
    sourceUpdatedAt: later(4),
    fields: { title: 'Generation one risk', severity: 'P0', blocking: true },
  }),
  record({
    ...generationIdentity,
    recordId: 'evidence:stale',
    recordType: 'evidence',
    sourceId: reportSourceId,
    sourceRevision: 'publication-generation-1',
    sourceUpdatedAt: later(4),
    fields: { title: 'Stale evidence', status: 'available' },
  }),
]).accepted, true);
assert.throws(
  () => index.commitReplacement(firstGeneration.token, { complete: false }),
  (error) => error.code === 'CONSOLE_INDEX_REPLACEMENT_INCOMPLETE',
  'A caller must explicitly attest that the bounded staged generation is complete before publication.',
);
assert.equal(index.commitReplacement(firstGeneration.token, { complete: true }).committed, true);
const secondGeneration = index.beginReplacement(generationIdentity, {
  sourceId: reportSourceId,
  sourceRevision: 'publication-generation-2',
  sourceUpdatedAt: later(5),
  maximumRecords: 10,
});
index.stageReplacement(secondGeneration.token, [record({
  ...generationIdentity,
  recordId: 'risk:generation',
  recordType: 'risk',
  sourceId: reportSourceId,
  sourceRevision: 'publication-generation-2',
  sourceUpdatedAt: later(5),
  fields: { title: 'Generation two risk', severity: 'P1', blocking: false },
})]);
const secondCommit = index.commitReplacement(secondGeneration.token, { complete: true });
assert.equal(secondCommit.committed, true);
assert.equal(secondCommit.removed, 2, 'The old report generation must leave no stale report-owned rows.');
assert.equal(index.read(generationIdentity).value.fields.title, 'Lifecycle row survives report replacement');
assert.equal(index.read(generationIdentity, 'evidence:stale').value, null);
assert.equal(index.read(generationIdentity, 'risk:generation').value.sourceRevision, 'publication-generation-2');
assert.equal(
  index.sourceVector().sources.find(({ sourceId }) => sourceId === reportSourceId)?.revision,
  'aggregate-watermark-1',
  'Per-run report revisions must not overwrite the aggregate source watermark.',
);

const mixedIdentity = { mode: 'comparative', runId: 'run-mixed-revision' };
const mixedGeneration = index.beginReplacement(mixedIdentity, {
  sourceId: reportSourceId,
  sourceRevision: 'different-run-publication',
  sourceUpdatedAt: later(6),
  maximumRecords: 2,
});
index.stageReplacement(mixedGeneration.token, [record({
  ...mixedIdentity,
  recordId: 'trust:mixed',
  recordType: 'trust',
  sourceId: reportSourceId,
  sourceRevision: 'different-run-publication',
  sourceUpdatedAt: later(6),
  fields: { title: 'Mixed publication trust', status: 'complete' },
})]);
assert.equal(index.commitReplacement(mixedGeneration.token, { complete: true }).committed, true);
assert.equal(
  index.sourceVector().sources.find(({ sourceId }) => sourceId === reportSourceId)?.revision,
  'aggregate-watermark-1',
  'A second run publication must not corrupt shared source state.',
);

const lateIdentity = { mode: 'comparative', runId: 'run-late-publication' };
const lateGeneration = index.beginReplacement(lateIdentity, {
  sourceId: reportSourceId,
  sourceRevision: 'late-publication',
  sourceUpdatedAt: later(7),
  maximumRecords: 2,
});
index.stageReplacement(lateGeneration.token, [record({
  ...lateIdentity,
  recordId: 'risk:late',
  recordType: 'risk',
  sourceId: reportSourceId,
  sourceRevision: 'late-publication',
  sourceUpdatedAt: later(7),
  fields: { title: 'Late risk', severity: 'P0', blocking: true },
})]);
index.beginPurge(lateIdentity, {
  sourceId: reportSourceId,
  sourceRevision: 'late-publication',
  updatedAt: later(7),
});
assert.equal(index.commitReplacement(lateGeneration.token, { complete: true }).committed, false,
  'A publication staged before purge must not become visible after the purge barrier.');
assert.equal(index.read(lateIdentity, 'risk:late').value, null);

index.clear();
assert.equal(index.diagnostics().records, 0);
assert.equal(index.diagnostics().sources, 0);
assert.equal(index.diagnostics().tombstones, 0);
assert.equal(index.sourceVector().complete, false, 'An unconfigured empty index must not claim complete source authority.');

console.log('Portal console index self-test passed.');
