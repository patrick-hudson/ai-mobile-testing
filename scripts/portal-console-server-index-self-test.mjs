import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'portal', 'server.mjs'), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `Missing server seam: ${start}`);
  assert.notEqual(to, -1, `Missing server seam after ${start}: ${end}`);
  return source.slice(from, to);
}

assert.equal(
  [...source.matchAll(/\bcreateConsoleIndex\s*\(/gu)].length,
  1,
  'The server must instantiate exactly one disposable console index.',
);
const recovery = source.indexOf('await refreshAllGalleryPublications(false);');
const indexCreation = source.indexOf('consoleIndex = createConsoleIndex();');
const listen = source.indexOf('server.listen(PORT, HOST');
assert.ok(recovery < indexCreation && indexCreation < listen, 'Index creation must follow authority recovery and precede listen.');

const backfill = section(
  'async function backfillSingleSiteConsoleIndexSlice()',
  'async function runConsoleIndexMaintenanceSlice()',
);
assert.match(backfill, /fs\.opendir\(join\(singleSiteQueue\.root, 'jobs'\)\)/u);
assert.match(backfill, /fs\.lstat\(statePath\)/u);
assert.match(backfill, /MAX_SINGLE_SITE_CONSOLE_STATE_BYTES/u);
assert.match(backfill, /consumeConsoleReadWork/u);
assert.doesNotMatch(backfill, /readSingleSiteJobInput|input\.json/u, 'Global backfill must never open job input.');
assert.match(backfill, /singleSiteConsoleIndexRecord\(state\)/u);
assert.doesNotMatch(
  backfill,
  /singleSiteConsoleIndexRecord\(state,\s*\{[^}]*sourceRevision:\s*consoleSingleSiteBackfillRevision/su,
  'Single-site backfill records must retain each job state revision.',
);

const comparativeBackfill = section(
  'async function backfillComparativeConsoleIndexSlice()',
  'async function backfillSingleSiteConsoleIndexSlice()',
);
assert.match(comparativeBackfill, /comparativeConsoleIndexRecord\(next\.value\)/u);
assert.match(
  comparativeBackfill,
  /next\.value\.consoleSourceRevision = record\.sourceRevision/u,
  'Comparative backfill must expose the same per-run source revision on public detail.',
);
assert.doesNotMatch(
  comparativeBackfill,
  /comparativeConsoleIndexRecord\(next\.value,\s*consoleComparativeBackfillRevision\)/u,
  'Comparative backfill records must not reuse the aggregate source-vector revision.',
);

const refresh = section(
  'async function refreshKnownSingleSiteConsoleIndexSlice()',
  'function scheduleConsoleIndexMaintenance()',
);
assert.match(refresh, /consoleKnownSingleSiteCursor/u);
assert.match(refresh, /DEFAULT_CONSOLE_INDEX_BUDGET\.maxRecords/u);
assert.match(refresh, /MAX_SINGLE_SITE_CONSOLE_FINALIZATION_BYTES/u);
assert.match(refresh, /readSingleSiteFinalizationStatus/u);
assert.doesNotMatch(refresh, /listSingleSiteJobs|readSingleSiteJobInput|input\.json/u);

assert.match(source, /normalizedRunToConsoleIndexRecord\(normalized/u);
assert.match(source, /normalizeComparativeConsoleRecord/u);
assert.match(source, /normalizeSingleSiteConsoleRecord/u);
assert.match(source, /await persistManifest\(run\);[\s\S]{0,200}upsertComparativeConsoleRun|persistManifest[\s\S]*upsertComparativeConsoleRun/u);
assert.match(source, /upsertSingleSiteConsoleState\(submitted\.state, \{ input: inputDocument \}\)/u);
assert.match(source, /timelineToConsoleIndexRecord/u);
assert.match(source, /comparativeConsoleTimelineRecords/u);
assert.match(source, /singleSiteConsoleTimelineRecords/u);
assert.match(source, /revision: state\.sequence/u, 'Single-site detail authority must expose the log generation revision.');

const reportProjection = section(
  'function updateConsoleReportSourceWatermark(',
  'function rememberSingleSiteConsoleJob(',
);
assert.match(reportProjection, /createConsoleReportProjectionTask/u);
assert.match(reportProjection, /runConsoleReportProjectionTaskSlice/u);
assert.match(reportProjection, /loadReportPublication\(run\.directory\)/u);
assert.match(reportProjection, /loadSingleSiteReportPublication\(directory, finalization\.reportRevision\)/u);
assert.match(reportProjection, /publication\.publicationDigest !== finalization\.reportPublicationDigest/u);
assert.match(reportProjection, /pipeline\?\.completed !== true/u);
assert.match(reportProjection, /reportRebuild\?\.status !== 'completed'/u);
assert.match(reportProjection, /limit: 50/u);
assert.match(reportProjection, /maximumDocuments: 2/u);
assert.match(reportProjection, /maximumSourceBytes: 1024 \* 1024/u);
assert.match(reportProjection, /signal: consoleMaintenanceAbortController\.signal/u);
assert.match(reportProjection, /setSourceWatermark/u);
assert.match(reportProjection, /consoleReportProjectionLoads\.has\(key\)/u);
assert.match(reportProjection, /consoleReportProjectionTasks\.has\(key\)/u);
assert.match(reportProjection, /consoleReportProjectionFailures\.has\(key\)/u,
  'Loading, pending, and failed expected publications must keep the aggregate report watermark incomplete.');
assert.match(reportProjection, /consoleReportProjectionCompleted\.get\(key\)\?\.complete === true/u,
  'Only an explicitly complete publication may satisfy an expected projection.');
assert.match(reportProjection, /complete: current\.task\.complete === true/u,
  'A completed projection task must preserve its actual completeness instead of forcing a green watermark.');
assert.match(reportProjection, /forgetConsoleReportProjection/u);
assert.doesNotMatch(
  reportProjection,
  /\/api\/reports|fetch\(|readPublishedReportJson/u,
  'Server maintenance must project descriptor-pinned reports without client-side report fanout.',
);

const maintenance = section(
  'async function runConsoleIndexMaintenanceSlice()',
  'async function refreshKnownSingleSiteConsoleIndexSlice()',
);
assert.match(maintenance, /runConsoleReportProjectionSlice/u);

const streamCleanup = section('function attachSseClient(', 'function streamRunEvents(');
assert.match(streamCleanup, /request\.once\('close', cleanup\)/u);
assert.match(streamCleanup, /response\.once\('close', cleanup\)/u);
assert.match(streamCleanup, /response\.once\('error', cleanup\)/u);
assert.ok(
  streamCleanup.indexOf("request.once('close', cleanup)") < streamCleanup.indexOf('clients.add(response)'),
  'SSE cleanup listeners must be attached before the client is exposed in the capacity set.',
);
assert.match(streamCleanup, /request\.destroyed \|\| response\.destroyed \|\| response\.writableEnded/u);
assert.match(source, /MAX_SSE_CLIENTS_PER_RUN/u);
assert.match(source, /MAX_SSE_CLIENTS_TOTAL/u);
assert.match(source, /RUN_WORKSPACE_DIAGNOSTICS_PATH/u);

const manualUploadRoute = section("const manualUploadMatch = pathname.match", "const artifactListMatch");
assert.ok(
  manualUploadRoute.indexOf('requireOperatorAuthorization(request)') < manualUploadRoute.indexOf('requireRun('),
  'Manual upload authorization must fail before run lookup or any artifact write.',
);
const manualUploadWriter = section('async function receiveManualUpload(', 'async function validateUploadedMedia(');
assert.match(manualUploadWriter, /idempotencyKey/u);
assert.ok(manualUploadWriter.indexOf('idempotencyKey') < manualUploadWriter.indexOf('fs.mkdir'),
  'Upload idempotency reconciliation must happen before creating files.');

const consoleRoute = section(
  "if (pathname === '/api/console/v1' || pathname.startsWith('/api/console/v1/'))",
  "if (request.method === 'GET' && pathname === '/operator/bootstrap')",
);
assert.match(consoleRoute, /withConsoleRequest/u);
assert.match(consoleRoute, /handleConsoleApiRequest\(consoleApi/u);
assert.match(consoleRoute, /authorization: \{ authorized: operatorRequestAuthorized\(request\) \}/u);
assert.match(consoleRoute, /sendConsoleApiResult/u);
assert.doesNotMatch(consoleRoute, /sendJson/u, 'Console API framing must not append the legacy JSON newline.');

const consoleSender = section('function sendConsoleApiResult(', 'function uniqueStrings(');
assert.match(consoleSender, /response\.end\(JSON\.stringify\(result\.body\)\)/u);
assert.match(consoleSender, /request\.method === 'HEAD'/u);

const comparativePurge = section('async function purgeRun(', 'async function withGalleryMutationLock(');
assert.ok(
  comparativePurge.indexOf('beginPurge') < comparativePurge.indexOf('moveRunToPurgeQuarantine'),
  'Comparative generation barrier must precede quarantine.',
);
assert.ok(
  comparativePurge.indexOf('commitPurge') < comparativePurge.indexOf('return sendJson'),
  'Comparative purge commit must precede the success response.',
);
assert.match(comparativePurge, /abortPurge/u);
assert.match(comparativePurge, /forgetConsoleReportProjection/u);

const singleSiteDelete = section(
  "if (request.method === 'DELETE' && singleSiteRunMatch)",
  'const singleSiteCancelMatch',
);
assert.ok(singleSiteDelete.indexOf('beginPurge') < singleSiteDelete.lastIndexOf('purgeSingleSiteRun'));
assert.ok(singleSiteDelete.indexOf('commitPurge') < singleSiteDelete.indexOf('return sendJson'));
assert.match(singleSiteDelete, /preQuarantineFailure/u);
assert.match(singleSiteDelete, /SINGLE_SITE_PURGE_INCOMPLETE|unknown failure/u);
assert.match(singleSiteDelete, /forgetConsoleReportProjection/u);

assert.match(source, /pathname === '\/console-contracts\.mjs'/u);
assert.match(source, /consoleMaintenanceAbortController\?\.abort\(\)/u);
assert.match(source, /clearInterval\(consoleMaintenanceTimer\)/u);
assert.match(source, /await iterator\.close\(\)/u);
assert.match(source, /consoleIndex\?\.clear\(\)/u);

console.log('Portal console server/index source integration self-test passed.');
await import('./portal-console-server-api-integration-self-test.mjs');
