import {
  CONSOLE_INDEX_MAX_REPLACEMENT_RECORDS,
} from './console-index.mjs';
import {
  CONSOLE_REPORT_PROJECTION_LIMITS,
  projectReportPublicationBatch,
} from './console-report-projection.mjs';

function abortError(signal) {
  return signal?.reason ?? new DOMException('Console report projection was cancelled.', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

export function createConsoleReportProjectionTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !input.index || !input.publication || !input.identity || typeof input.scopeKey !== 'string') {
    throw new TypeError('Console report projection task input is invalid.');
  }
  const maximumRecords = Number.isSafeInteger(input.maximumRecords) && input.maximumRecords > 0
    ? Math.min(input.maximumRecords, CONSOLE_INDEX_MAX_REPLACEMENT_RECORDS)
    : CONSOLE_INDEX_MAX_REPLACEMENT_RECORDS;
  const replacement = input.index.beginReplacement(input.identity, {
    sourceId: input.identity.mode === 'single-site'
      ? 'single-site-report-publication'
      : 'comparative-report-publication',
    sourceRevision: input.publication.publicationRevision,
    sourceUpdatedAt: input.publication.generatedAt,
    maximumRecords,
  });
  return {
    schemaVersion: 1,
    index: input.index,
    publication: input.publication,
    identity: Object.freeze({ ...input.identity }),
    scopeKey: input.scopeKey,
    token: replacement.token,
    cursor: null,
    limitations: new Set(),
    status: replacement.accepted ? 'pending' : 'rejected',
    reason: replacement.reason,
    batches: 0,
    recordsProjected: 0,
    complete: false,
  };
}

export async function runConsoleReportProjectionTaskSlice(task, options = {}) {
  if (!task || task.schemaVersion !== 1 || !task.index || !task.publication || !task.identity) {
    throw new TypeError('Console report projection task is invalid.');
  }
  if (task.status !== 'pending') return task;
  const signal = options.signal;
  try {
    throwIfAborted(signal);
    const batch = await projectReportPublicationBatch({
      publication: task.publication,
      identity: task.identity,
      scopeKey: task.scopeKey,
      cursor: task.cursor,
    }, {
      limit: Math.min(
        options.limit ?? 50,
        CONSOLE_REPORT_PROJECTION_LIMITS.maximumBatchRecords,
      ),
      maximumDocuments: Math.min(
        options.maximumDocuments ?? 2,
        CONSOLE_REPORT_PROJECTION_LIMITS.maximumDocumentsPerBatch,
      ),
      maximumSourceBytes: Math.min(
        options.maximumSourceBytes ?? 1024 * 1024,
        CONSOLE_REPORT_PROJECTION_LIMITS.maximumSourceBytesPerBatch,
      ),
      maximumDocumentBytes: Math.min(
        options.maximumDocumentBytes ?? 1024 * 1024,
        CONSOLE_REPORT_PROJECTION_LIMITS.maximumDocumentBytes,
      ),
    });
    throwIfAborted(signal);
    const staged = task.index.stageReplacement(task.token, batch.records);
    if (!staged.accepted) {
      task.status = 'rejected';
      task.reason = staged.reason;
      return task;
    }
    task.batches += 1;
    task.recordsProjected = staged.stagedRecords;
    task.cursor = batch.cursor;
    for (const limitation of batch.limitations) task.limitations.add(limitation);
    if (!batch.done) return task;
    const committed = task.index.commitReplacement(task.token, { complete: true });
    task.status = committed.committed ? 'committed' : 'rejected';
    task.reason = committed.reason;
    task.complete = committed.committed && batch.complete && task.limitations.size === 0;
    task.recordsProjected = committed.committed ? committed.records.length : task.recordsProjected;
    task.removedRecords = committed.committed ? committed.removed : 0;
    return task;
  } catch (error) {
    task.index.abortReplacement(task.token);
    task.status = error?.name === 'AbortError' ? 'cancelled' : 'failed';
    task.reason = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export function cancelConsoleReportProjectionTask(task) {
  if (!task || task.schemaVersion !== 1 || !task.index || !task.token) return false;
  const cancelled = task.index.abortReplacement(task.token);
  if (task.status === 'pending') {
    task.status = 'cancelled';
    task.reason = 'cancelled';
  }
  return cancelled;
}
