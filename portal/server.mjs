import { constants as fsConstants, createWriteStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { mergePortalCatalog, validatePortalPluginRegistryDocument } from './plugin-registry.mjs';
import { loadPortalTargetRegistry } from './target-registry.mjs';
import {
  resolvePortalAiWorkerIdentity,
  resolvePortalReportWorkerIdentity,
  resolvePortalRunnerIdentity,
  runnerSpawnIdentity,
  sanitizedChildEnvironment,
} from './runner-isolation.mjs';
import { publishCredentialEnvelope, removeCredentialEnvelope } from './credential-store.mjs';
import { ByteLruCache } from './byte-lru-cache.mjs';
import { readBoundedFileTail } from './bounded-file.mjs';
import { openContainedArtifactFile } from './safe-artifact-open.mjs';
import { createConsoleApi, handleConsoleApiRequest } from './console-api.mjs';
import { createSharedControlApi, createSharedRequestAuthorizer } from './shared-control-api.mjs';
import { rejectRetiredLegacyMutation } from './shared-legacy-mutation-policy.mjs';
import { openScopedCredentialAuthority } from './scoped-credential-authority.mjs';
import { assertPrincipalAuthorized, CONTROL_ACTIONS, validateMutationDeployment } from '../shared/control-plane-contract.mjs';
import { assertSharedListScope, classifySharedReadRequest } from './shared-read-policy.mjs';
import { openParentRunStore } from '../scripts/lib/parent-run-store.mjs';
import { createSharedControlService } from '../scripts/lib/shared-control-service.mjs';
import { openPromotionClaimStore } from '../scripts/lib/promotion-claim-store.mjs';
import {
  acceptSharedLaunchOperation,
  getSharedLaunchOperation,
  openSharedLaunchOperationStore,
} from '../scripts/lib/shared-launch-operation-store.mjs';
import {
  getConsoleCapabilities,
  resolveConsoleActionAvailability,
} from './console-contracts.mjs';
import {
  DEFAULT_CONSOLE_INDEX_BUDGET,
  consumeConsoleReadWork,
  createConsoleIndex,
  createConsoleReadWork,
} from './console-index.mjs';
import {
  normalizedRunToConsoleIndexRecord,
  timelineToConsoleIndexRecord,
} from './console-index-records.mjs';
import {
  projectComparativeTimeline,
  projectSingleSiteTimeline,
} from './console-run.mjs';
import {
  cancelConsoleReportProjectionTask,
  createConsoleReportProjectionTask,
  runConsoleReportProjectionTaskSlice,
} from './console-report-indexer.mjs';
import {
  normalizeComparativeConsoleRecord,
  normalizeSingleSiteConsoleRecord,
} from './console-view-model.mjs';
import { assertNoNestedMountPoints } from './mount-boundaries.mjs';
import {
  ownershipTransitionUnavailable,
  prepareRunnerArtifactDirectory,
  removeValidatedArtifactTree,
  withPortableArtifactWriteWindow,
} from './artifact-permissions.mjs';
import { validatePreferredMediaManifest } from './video-manifest.mjs';
import { validateExternalTerminalEvidence } from './external-evidence.mjs';
import {
  loadReportPublication,
  loadSingleSiteReportPublication,
  readPublishedReportJson,
} from './report-publication.mjs';
import {
  parseChecklistRelease,
  pendingRelease,
  readChecklistRelease,
  unavailableRelease,
} from '../scripts/lib/release-truth.mjs';
import {
  DEFAULT_RELEASE_SHARD_CONCURRENCY,
  DEFAULT_RELEASE_SHARD_TOTAL,
  DEFAULT_RELEASE_SHARD_WORKERS,
} from '../scripts/lib/sharded-defaults.mjs';
import {
  GalleryHttpError,
  galleryQueryFromUrl,
  gallerySnapshotFingerprints,
  loadGalleryHead,
  loadGallerySnapshot,
  pageGallerySnapshot,
  probeGalleryPublication,
  readGalleryAvailability,
  readGalleryFlags,
  readGalleryItem,
} from './gallery-data.mjs';
import { mutateGalleryFlag } from '../scripts/gallery-flags.mjs';
import {
  GALLERY_RETENTION_LIMITS,
  galleryRevisionEntryBytes,
  pruneGalleryRevisionCache,
} from './gallery-retention.mjs';
import {
  applyCompletedReleaseEligibility,
  canonicalExecutionProvenance,
  portalExecutionProvenance,
  releaseReviewReasons,
} from './release-eligibility.mjs';
import { createSingleSiteLaunchCoordinator, SingleSiteLaunchError } from './single-site-launch.mjs';
import { readSingleSiteFinalizationStatus } from './single-site-finalization.mjs';
import {
  openSingleSiteGallery,
  pageSingleSiteGalleryItems,
  readSingleSiteGalleryItem,
  reviewSingleSiteGalleryItem,
  resolveSingleSiteGalleryMedia,
  singleSiteGalleryHead,
} from './single-site-gallery.mjs';
import {
  SingleSiteAiReviewError,
  fenceSingleSiteAiReviewForPurge,
  openSingleSiteAiReviewSupervisor,
  readSingleSiteAiReview,
  readSingleSiteAiReviewResult,
  recoverSingleSiteAiReviews,
  requestSingleSiteAiReview,
  releaseSingleSiteAiReviewPurgeFence,
} from './single-site-ai-review.mjs';
import {
  SingleSitePurgeError,
  purgeSingleSiteRun,
  recoverSingleSitePurges,
  singleSitePurgeConfirmation,
} from './single-site-purge.mjs';
import {
  VisualBaselineStoreError,
  approveVisualBaseline,
  deleteVisualBaseline,
  isVisualBaselineMutationLocked,
  listVisualBaselineHistory,
  openVisualBaselineStore,
  readVisualBaselineStore,
  replaceVisualBaseline,
  revokeVisualBaseline,
} from './visual-baselines.mjs';
import {
  VisualReviewStoreError,
  openVisualReviewStore,
} from './visual-review-dispositions.mjs';
import { preflightQuitting7ohSite } from '../shared/site-preflight.mjs';
import { resolveRunnerRevision } from '../shared/runner-revision.mjs';
import {
  parseVisualBaselineEvidence,
  parseVisualBaselineIdentity,
  visualBaselineDigest,
  visualBaselineIdentityKey,
  visualBaselineSlotKey,
} from '../shared/visual-baseline-contract.mjs';
import { verifyPublishedVisualComparatorCalibration } from '../scripts/lib/visual-comparator-calibration.mjs';
import {
  JobQueueError,
  cancelJob as cancelSingleSiteJob,
  listJobs as listSingleSiteJobs,
  openJobQueue,
  readJob as readSingleSiteJob,
  readJobInput as readSingleSiteJobInput,
  sha256 as queueSha256,
  submitJob as submitSingleSiteJob,
} from '../scripts/lib/job-queue.mjs';

const PORTAL_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(PORTAL_DIR, '..');
const STATIC_ROOT = join(PORTAL_DIR, 'public');
const CONSOLE_SHELL_FIXTURE_FILES = new Map([
  ['/console-shell-fixture.html', join(STATIC_ROOT, 'console-shell-fixture.html')],
  ['/console-shell-fixture.js', join(STATIC_ROOT, 'console-shell-fixture.js')],
]);
const CONSOLE_SHELL_FIXTURE_RELATIVE_PATHS = new Set([
  'console-shell-fixture.html',
  'console-shell-fixture.js',
]);
const CONSOLE_CONTRACT_FIXTURE_PATH = '/__e2e__/console-contracts.mjs';
const RUN_WORKSPACE_DIAGNOSTICS_PATH = '/__e2e__/run-workspace-diagnostics';
const ARTIFACT_ROOT = resolve(
  process.env.PORTAL_ARTIFACT_ROOT ?? join(REPOSITORY_ROOT, 'artifacts', 'runs'),
);
const SHARDED_ARTIFACT_ROOT = resolve(
  process.env.PORTAL_SHARDED_ARTIFACT_ROOT ?? join(REPOSITORY_ROOT, 'artifacts', 'sharded'),
);
const SINGLE_SITE_QUEUE_ROOT = resolve(
  process.env.PORTAL_SINGLE_SITE_QUEUE_ROOT ?? join(dirname(ARTIFACT_ROOT), 'single-site-jobs'),
);
const SINGLE_SITE_FINALIZATION_ROOT = resolve(
  process.env.PORTAL_SINGLE_SITE_FINALIZATION_ROOT ?? join(dirname(ARTIFACT_ROOT), 'single-site-finalizations'),
);
const VISUAL_BASELINE_ROOT = resolve(
  process.env.PORTAL_VISUAL_BASELINE_ROOT ?? join(dirname(ARTIFACT_ROOT), 'visual-baselines'),
);
const VISUAL_REVIEW_ROOT = join(VISUAL_BASELINE_ROOT, 'review-dispositions');
const SINGLE_SITE_AI_REVIEW_ROOT = resolve(
  process.env.PORTAL_SINGLE_SITE_AI_REVIEW_ROOT ?? SINGLE_SITE_FINALIZATION_ROOT,
);
const SECRET_ROOT = resolve(process.env.PORTAL_SECRET_ROOT ?? join(REPOSITORY_ROOT, '.portal-secrets'));
const SECRET_MASTER_PATH = join(SECRET_ROOT, 'master.key');
const ANTHROPIC_CREDENTIAL_PATH = join(SECRET_ROOT, 'anthropic-key.json');
const PURGE_JOURNAL_ROOT = join(SECRET_ROOT, 'purge-journals');
const PURGE_QUARANTINE_NAME = '.portal-purge-quarantine';
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = parseInteger(process.env.PORT, 4173, 1, 65_535);
const MAX_CONCURRENT_RUNS = parseInteger(process.env.PORTAL_MAX_CONCURRENT_RUNS, 1, 1, 4);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MANUAL_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_LOG_EVENTS = 2_000;
const MAX_EVENT_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_SSE_REPLAY_BYTES = 512 * 1024;
const MAX_GALLERY_SSE_REPLAY_BYTES = 64 * 1024;
const MAX_SSE_CLIENTS_PER_RUN = parseInteger(process.env.PORTAL_MAX_SSE_CLIENTS_PER_RUN, 8, 1, 64);
const MAX_SSE_CLIENTS_TOTAL = parseInteger(process.env.PORTAL_MAX_SSE_CLIENTS_TOTAL, 64, 1, 512);
const SHARED_READ_REAUTH_MS = parseInteger(process.env.PORTAL_SHARED_READ_REAUTH_MS, 5_000, 250, 60_000);
const MAX_CONSOLE_TIMELINE_RECORDS_PER_RUN = 99;
const GALLERY_SSE_EVENT_TYPES = new Set(['gallery', 'gallery-flag', 'snapshot', 'stage', 'status']);
const sseCapacityDiagnostics = { refused: 0, peak: 0 };
const MAX_EXTERNAL_LOG_INGEST_BYTES = 512 * 1024;
const MAX_EXTERNAL_REFRESH_BYTES = parseInteger(
  process.env.PORTAL_EXTERNAL_REFRESH_BYTES,
  2 * 1024 * 1024,
  512 * 1024,
  64 * 1024 * 1024,
);
const MAX_EXTERNAL_REFRESH_MS = parseInteger(process.env.PORTAL_EXTERNAL_REFRESH_MS, 250, 50, 5_000);
const MAX_EXTERNAL_PARTIAL_LINE_CHARS = 64 * 1024;
const MAX_EXTERNAL_LIFECYCLE_JSON_BYTES = 256 * 1024;
const MAX_EXTERNAL_HEARTBEAT_JSON_BYTES = 64 * 1024;
const MAX_CHILD_PARTIAL_LINE_CHARS = 64 * 1024;
const DEFAULT_LOG_SNAPSHOT_BYTES = 256 * 1024;
const MIN_LOG_SNAPSHOT_BYTES = 16 * 1024;
const MAX_LOG_SNAPSHOT_BYTES = 1024 * 1024;
const DEFAULT_ARTIFACT_PAGE_SIZE = 150;
const MAX_ARTIFACT_PAGE_SIZE = 500;
const MAX_PREFERRED_MEDIA_ARTIFACTS = 120;
const MAX_VIDEO_MANIFEST_BYTES = 8 * 1024 * 1024;
const STOP_GRACE_MS = 8_000;
const PLAYWRIGHT_DEADLINE_MS = parseInteger(process.env.PORTAL_PLAYWRIGHT_DEADLINE_MS, 60 * 60_000, 1_000, 24 * 60 * 60_000);
const VIDEO_STAGE_DEADLINE_MS = parseInteger(process.env.PORTAL_VIDEO_STAGE_DEADLINE_MS, 15 * 60_000, 1_000, 24 * 60 * 60_000);
const AI_STAGE_DEADLINE_MS = parseInteger(process.env.PORTAL_AI_STAGE_DEADLINE_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000);
const REPORT_STAGE_DEADLINE_MS = parseInteger(process.env.PORTAL_REPORT_STAGE_DEADLINE_MS, 15 * 60_000, 1_000, 24 * 60 * 60_000);
const EXTERNAL_RUN_SYNC_MS = parseInteger(process.env.PORTAL_EXTERNAL_RUN_SYNC_MS, 1_000, 250, 30_000);
const SINGLE_SITE_AI_REVIEW_SYNC_MS = parseInteger(
  process.env.PORTAL_SINGLE_SITE_AI_REVIEW_SYNC_MS,
  2_000,
  500,
  60_000,
);
const EXTERNAL_TERMINAL_REFRESH_MS = parseInteger(process.env.PORTAL_EXTERNAL_TERMINAL_REFRESH_MS, 30_000, 1_000, 10 * 60_000);
const EXTERNAL_STALE_LEASE_MS = parseInteger(process.env.PORTAL_EXTERNAL_STALE_LEASE_MS, 90_000, 15_000, 60 * 60_000);
const MAX_REPORT_SUMMARY_BYTES = 256 * 1024;
const MAX_REPORT_AUDIT_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_AUDIT_DETAIL_BYTES = 512 * 1024;
const MAX_REPORT_CACHE_ENTRIES = 256;
const MAX_REPORT_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_BASELINE_PAGE_SIZE = 50;
const MAX_BASELINE_PAGE_SIZE = 200;
const MAX_BASELINE_ELIGIBILITY_BYTES = 32 * 1024 * 1024;
const MAX_BASELINE_ELIGIBILITY_ITEMS = 10_000;
const PORTAL_OPERATOR_ACTOR_ID = 'portal-operator';
const DEFAULT_AI_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';
const ANTHROPIC_KEY_PATTERN = /^sk-ant-[a-zA-Z0-9_-]{20,512}$/;
const DEFAULT_CANDIDATE_IGNORE_HTTPS_ERRORS = binaryEnvironmentFlag(
  'CANDIDATE_IGNORE_HTTPS_ERRORS',
  false,
);
const ALLOWED_PORTAL_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  ...String(process.env.PORTAL_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
]);
const RESTART_PROGRESS_TAIL_BYTES = 1024 * 1024;
const MEDIA_VALIDATION_TIMEOUT_MS = 20_000;
const MAX_MEDIA_VALIDATION_OUTPUT_BYTES = 64 * 1024;
const COMPARATIVE_CONSOLE_SOURCE_ID = 'comparative-runs';
const SINGLE_SITE_CONSOLE_SOURCE_ID = 'single-site-jobs';
const MAX_SINGLE_SITE_CONSOLE_STATE_BYTES = 1024 * 1024;
const MAX_SINGLE_SITE_CONSOLE_FINALIZATION_BYTES = 64 * 1024;
const MAX_COMPARATIVE_CONSOLE_MANIFEST_BYTES = 1024 * 1024;
const MAX_CONSOLE_KNOWN_SINGLE_SITE_JOBS = 10_000;

const targetRegistry = loadPortalTargetRegistry(join(REPOSITORY_ROOT, 'audit', 'targets.generated.json'));
const targetRegistryDocument = JSON.parse(
  await fs.readFile(join(REPOSITORY_ROOT, 'audit', 'targets.generated.json'), 'utf8'),
);
const PROJECTS = Object.freeze(targetRegistry.localTargets);
const PROJECT_IDS = new Set(PROJECTS.map(({ id }) => id));
const RUNNABLE_PROJECT_IDS = new Set(PROJECTS.filter(({ available }) => available).map(({ id }) => id));
const SINGLE_SITE_TARGET_IDS = new Set(targetRegistry.singleSiteTargets.map(({ id }) => id));
const RUNNABLE_SINGLE_SITE_TARGET_IDS = new Set(
  targetRegistry.singleSiteTargets.filter(({ available }) => available).map(({ id }) => id),
);
const PROVIDER_PROJECT_IDS = new Set(targetRegistry.providerTargets.map(({ id }) => id));
const DEFAULT_PROJECT_IDS = new Set(targetRegistry.defaultTargetIds);
const FULL_PROJECT_COUNT = targetRegistry.defaultTargetIds.length;
const RUNNER_IDENTITY = resolvePortalRunnerIdentity();
const AI_WORKER_IDENTITY = resolvePortalAiWorkerIdentity(
  process.env,
  process.platform,
  typeof process.getuid === 'function' ? process.getuid() : null,
  RUNNER_IDENTITY,
);
const REPORT_WORKER_IDENTITY = resolvePortalReportWorkerIdentity(
  process.env,
  process.platform,
  typeof process.getuid === 'function' ? process.getuid() : null,
  RUNNER_IDENTITY,
  AI_WORKER_IDENTITY,
);
const CREDENTIAL_ISOLATION_ACTIVE = RUNNER_IDENTITY.active
  && AI_WORKER_IDENTITY.active
  && REPORT_WORKER_IDENTITY.active;
const PROFILES = new Set(['smoke', 'release']);
const TERMINAL_STATUSES = new Set(['passed', 'not-ready', 'review-required', 'failed', 'evidence-failed', 'stopped', 'spawn-failed']);
const SINGLE_SITE_TERMINAL_STATES = new Set(['completed', 'failed', 'incomplete', 'cancelled']);
const PURGE_ELIGIBLE_STATUSES = new Set(TERMINAL_STATUSES);
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9-]{7,79}$/;
const SAFE_SINGLE_SITE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip',
});

// The generated registry is the same validated metadata boundary consumed by
// the test runner and reporters. Loading it directly prevents the portal from
// publishing a lossy regex projection of audit/catalog.ts.
const plugins = await loadPluginRegistry([]);
const pluginRegistryDocument = JSON.parse(
  await fs.readFile(join(REPOSITORY_ROOT, 'audit', 'plugins.generated.json'), 'utf8'),
);
const catalog = mergePortalCatalog([], plugins);
const AUDIT_IDS = new Set(catalog.map(({ id }) => id));
const AUDIT_AREAS = new Set(catalog.map(({ area }) => area));
const MANUAL_AUDIT_IDS = new Set(catalog.filter(({ manual }) => manual).map(({ id }) => id));
const PLUGIN_IDS = new Set(plugins.map(({ id }) => id));
const runs = new Map();
const sensitiveLogValues = new Set();
const artifactPathCache = new Map();
const preferredMediaValidationCache = new Map();
const reportDataCache = new ByteLruCache(MAX_REPORT_CACHE_ENTRIES, MAX_REPORT_CACHE_BYTES);
const galleryRevisionCache = new Map();
const observedGalleryPublications = new Map();
const observedSealedGalleryHeads = new Map();
const purgedGalleryRunIds = new Set();
const purgingRunIds = new Set();
const runTransferFences = new Set();
const activeRunTransfers = new Map();
const manualMutationRunIds = new Set();
const galleryMutationRunIds = new Set();
const launchReservations = new Set();
const galleryFlagRateWindows = new Map();
const consolePendingPurgeTokens = new Map();
const consoleIndexedStateSignatures = new Map();
const consoleKnownSingleSiteJobIds = [];
const consoleKnownSingleSiteJobSet = new Set();
const consoleKnownSingleSiteJobSlots = new Map();
const consoleKnownSingleSiteFreeSlots = [];
const consoleKnownSingleSiteRevisions = new Map();
const consoleKnownSingleSiteFinalizations = new Map();
const consoleKnownSingleSiteAiOptIn = new Map();

function runTransferKey(mode, runId) {
  return `${mode}:${runId}`;
}

async function withRunScopedTransfer(mode, runId, response, operation) {
  const key = runTransferKey(mode, runId);
  if (runTransferFences.has(key)) throw httpError(410, 'This run is being permanently purged.');
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const transfer = { response, done };
  let transfers = activeRunTransfers.get(key);
  if (!transfers) activeRunTransfers.set(key, transfers = new Set());
  transfers.add(transfer);
  if (runTransferFences.has(key)) {
    transfers.delete(transfer);
    resolveDone();
    throw httpError(410, 'This run is being permanently purged.');
  }
  try {
    return await operation();
  } finally {
    transfers.delete(transfer);
    if (transfers.size === 0) activeRunTransfers.delete(key);
    resolveDone();
  }
}

async function fenceAndDrainRunTransfers(mode, runId) {
  const key = runTransferKey(mode, runId);
  runTransferFences.add(key);
  const transfers = [...(activeRunTransfers.get(key) ?? [])];
  for (const transfer of transfers) transfer.response.destroy();
  await Promise.all(transfers.map(({ done }) => done));
}

function releaseRunTransferFence(mode, runId) {
  runTransferFences.delete(runTransferKey(mode, runId));
}
const consoleReportProjectionTasks = new Map();
const consoleReportProjectionLoads = new Map();
const consoleReportProjectionCompleted = new Map();
const consoleReportProjectionFailures = new Map();
let secretMasterKey;
let operatorCapabilityToken;
let operatorSessionToken;
let savedAnthropicCredential = null;
let externalRunSyncPromise = null;
let externalRunSyncDiagnostics = {
  status: 'idle',
  finishedAt: null,
  durationMs: null,
  bytesRead: 0,
  filesVisited: 0,
  skippedBytes: 0,
  budgetExhausted: false,
};
let credentialMutationPromise = Promise.resolve();
let singleSiteAiReviewSyncPromise = null;
let consoleIndex = null;
let consoleMaintenanceAbortController = null;
let consoleMaintenanceImmediate = null;
let consoleMaintenanceTimer = null;
let consoleComparativeBackfillIterator = null;
let consoleSingleSiteBackfillIterator = null;
let consoleSingleSitePendingEntry = null;
let consoleComparativeBackfillRevision = null;
let consoleSingleSiteBackfillRevision = null;
let consoleComparativeSourceRevision = 0;
let consoleSingleSiteSourceRevision = 0;
let consoleComparativeBackfillDone = false;
let consoleSingleSiteBackfillDone = false;
let consoleComparativeBackfillLimited = false;
let consoleSingleSiteBackfillLimited = false;
let consoleComparativeBackfillRecords = 0;
let consoleSingleSiteBackfillRecords = 0;
let consoleMaintenanceRunning = false;
let consoleKnownSingleSiteRefreshRunning = false;
let consoleKnownSingleSiteCursor = 0;
let consoleComparativeReportWatermark = 0;
let consoleSingleSiteReportWatermark = 0;
let sharedControlApi = null;
let sharedRequestAuthorizer = null;
let sharedProjectId = null;
let legacyOperatorEnabled = true;

const singleSiteRunnerRevision = await resolveRunnerRevision({ root: REPOSITORY_ROOT });
const previewTlsBypassOrigins = String(process.env.AUDIT_PREVIEW_TLS_BYPASS_ALLOWLIST ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const singleSiteQueue = await openJobQueue({ root: SINGLE_SITE_QUEUE_ROOT });
const visualBaselineStore = await openVisualBaselineStore({ root: VISUAL_BASELINE_ROOT });
const visualReviewStore = await openVisualReviewStore({ root: VISUAL_REVIEW_ROOT });
const singleSiteAiReview = await openSingleSiteAiReviewSupervisor({
  root: SINGLE_SITE_AI_REVIEW_ROOT,
  nestedJobSubdirectory: 'ai-review',
  aiWorkerIdentity: AI_WORKER_IDENTITY,
  timeoutMs: AI_STAGE_DEADLINE_MS,
  onEvent: (event) => {
    const jobId = typeof event.jobId === 'string' ? event.jobId : 'unknown';
    const state = typeof event.state === 'string' ? event.state : event.event;
    console.log(`Single-site AI advisory ${jobId}: ${state}.`);
    if (SAFE_SINGLE_SITE_JOB_ID.test(jobId)) {
      void refreshSingleSiteConsoleRun(jobId).catch((error) => {
        console.error(`[PORTAL_CONSOLE_INDEX_REJECTED] Single-site AI refresh ${jobId}: ${redactLogValue(error.message)}`);
      });
    }
  },
});
const singleSiteLaunch = createSingleSiteLaunchCoordinator({
  pluginRegistry: pluginRegistryDocument,
  targetRegistry: targetRegistryDocument,
  runnerRevision: singleSiteRunnerRevision,
  validateContract: validateSingleSitePortalContract,
  preflight: (input) => preflightQuitting7ohSite(input, {
    previewBypassOrigins: previewTlsBypassOrigins,
    tlsBypassRequestOptions: { rejectUnauthorized: false },
  }),
  createJob: createSingleSiteQueueJob,
});

await fs.mkdir(ARTIFACT_ROOT, { recursive: true });
await fs.mkdir(SINGLE_SITE_FINALIZATION_ROOT, { recursive: true, mode: 0o700 });
await initializeSecretVault();
if (process.env.PORTAL_SHARED_CONTROL === '1') {
  const publishedOrigin = process.env.PORTAL_PUBLISHED_ORIGIN ?? `http://${HOST}:${PORT}`;
  const deployment = validateMutationDeployment({
    bindHost: HOST,
    acceptedSocketHost: process.env.PORTAL_ACCEPTED_SOCKET_HOST ?? HOST,
    publishedOrigin,
    sessionSecure: process.env.PORTAL_SESSION_SECURE === '1',
  });
  legacyOperatorEnabled = deployment.local;
  const controlStore = await openParentRunStore({
    root: process.env.AUDIT_SHARED_STORE_ROOT,
    deploymentIdentity: process.env.AUDIT_SHARED_DEPLOYMENT_IDENTITY,
    volumeIdentity: process.env.AUDIT_SHARED_VOLUME_IDENTITY,
  });
  const credentialAuthority = await openScopedCredentialAuthority({
    root: process.env.PORTAL_SHARED_CREDENTIAL_ROOT ?? join(SECRET_ROOT, 'control-identities'),
  });
  const claimStore = await openPromotionClaimStore({ root: join(SECRET_ROOT, 'promotion-claims') });
  const launchOperationStore = await openSharedLaunchOperationStore({
    root: join(controlStore.root, 'launch-operations'),
  });
  sharedProjectId = process.env.AUDIT_SHARED_PROJECT_ID ?? 'default';
  sharedRequestAuthorizer = createSharedRequestAuthorizer({ authority: credentialAuthority });
  sharedControlApi = createSharedControlApi({
    authority: credentialAuthority,
    requestAuthorizer: sharedRequestAuthorizer,
    service: createSharedControlService({ store: controlStore, projectId: sharedProjectId }),
    claimStore,
    expectedOrigin: deployment.publishedOrigin,
    sessionCookiePath: '/',
    launch: (principal, request) => acceptSharedLaunchOperation(launchOperationStore, {
      principal,
      projectId: sharedProjectId,
      requestId: request.requestId,
      intent: request.intent,
    }),
    readLaunchOperation: async (principal, operationId) => {
      const operation = await getSharedLaunchOperation(launchOperationStore, operationId);
      assertPrincipalAuthorized(principal, CONTROL_ACTIONS.OPERATION_READ, { projectId: operation.projectId });
      return operation;
    },
  });
}
const recoveredSingleSiteAiReviews = await recoverSingleSiteAiReviews(singleSiteAiReview);
for (const recovery of recoveredSingleSiteAiReviews) {
  console.warn(`Recovered Single-site AI advisory ${recovery.jobId} as ${recovery.state}.`);
}
const recoveredSingleSitePurges = await recoverSingleSitePurges({
  queue: singleSiteQueue,
  finalizationRoot: SINGLE_SITE_FINALIZATION_ROOT,
  aiReviewRoot: SINGLE_SITE_AI_REVIEW_ROOT,
  baselineStore: visualBaselineStore,
}).catch((error) => {
  console.error(`Single-site purge recovery could not complete: ${error.message}`);
  return [];
});
for (const recovery of recoveredSingleSitePurges) {
  if (recovery.status === 'purged') {
    console.log(`Recovered interrupted Single-site purge ${recovery.jobId}; independent baseline bytes were preserved.`);
  } else {
    console.error(`Single-site purge ${recovery.jobId} still requires recovery: ${recovery.message}`);
  }
}
await loadPersistedRuns();
await syncExternalShardedRuns();
await loadPurgeQuarantines();
await refreshAllGalleryPublications(false);
consoleIndex = createConsoleIndex();
const consoleApi = createConsoleApi({
  index: consoleIndex,
  resolveCapabilities: resolveConsoleCapabilities,
});
consoleMaintenanceAbortController = new AbortController();
beginConsoleIndexBackfill();
await runConsoleIndexMaintenanceSlice();
scheduleConsoleIndexMaintenance();
consoleMaintenanceTimer = setInterval(() => {
  void refreshKnownSingleSiteConsoleIndexSlice().catch((error) => {
    console.error(`[PORTAL_CONSOLE_REFRESH_FAILED] ${redactLogValue(error.message)}`);
  });
}, SINGLE_SITE_AI_REVIEW_SYNC_MS);
consoleMaintenanceTimer.unref();
const externalRunSyncTimer = setInterval(() => {
  void (async () => {
    await syncExternalShardedRuns();
    await refreshAllGalleryPublications(true);
  })().catch((error) => {
    console.error(`Could not refresh externally launched runs or gallery heads: ${error.message}`);
  });
}, EXTERNAL_RUN_SYNC_MS);
externalRunSyncTimer.unref();
triggerSingleSiteAiReviewSync();
const singleSiteAiReviewSyncTimer = setInterval(
  triggerSingleSiteAiReviewSync,
  SINGLE_SITE_AI_REVIEW_SYNC_MS,
);
singleSiteAiReviewSyncTimer.unref();

const server = createServer(async (request, response) => {
  try {
    await routeRequest(request, response);
  } catch (error) {
    if (error?.name === 'AbortError' && error?.message === 'Gallery request disconnected.') return;
    if (response.destroyed || response.writableEnded) return;
    const queueStatus = error instanceof JobQueueError
      ? error.code === 'QUEUE_NOT_FOUND' ? 404
        : ['QUEUE_TERMINAL', 'QUEUE_STATE_CONFLICT', 'QUEUE_ALREADY_CLAIMED', 'QUEUE_IDEMPOTENCY_CONFLICT'].includes(error.code) ? 409
          : error.code === 'QUEUE_SCHEMA_INVALID' ? 400
            : 500
      : null;
    const baselineStatus = error instanceof VisualBaselineStoreError
      ? ['BASELINE_CAS_CONFLICT', 'BASELINE_IDEMPOTENCY_CONFLICT', 'BASELINE_ACTIVE_EXISTS',
        'BASELINE_ACTIVE_CONFLICT', 'BASELINE_STATE_CONFLICT', 'BASELINE_MUTATION_LOCKED'].includes(error.code) ? 409
        : ['BASELINE_INPUT_INVALID', 'BASELINE_SOURCE_MISMATCH', 'BASELINE_PATH_UNSAFE'].includes(error.code) ? 422
          : 500
      : null;
    const visualReviewStatus = error instanceof VisualReviewStoreError
      ? ['VISUAL_REVIEW_CAS_CONFLICT', 'VISUAL_REVIEW_IDEMPOTENCY_CONFLICT',
        'VISUAL_REVIEW_ALREADY_RECORDED', 'VISUAL_REVIEW_BASELINE_STALE'].includes(error.code) ? 409
        : ['VISUAL_REVIEW_INPUT_INVALID', 'VISUAL_REVIEW_PATH_UNSAFE'].includes(error.code) ? 422
          : error.code === 'VISUAL_REVIEW_HISTORY_LIMIT' ? 413
            : 500
      : null;
    const singleSitePurgeStatus = error instanceof SingleSitePurgeError
      ? ['SINGLE_SITE_PURGE_INVALID', 'SINGLE_SITE_PURGE_CONFIRMATION'].includes(error.code) ? 400
        : error.code === 'SINGLE_SITE_PURGE_LIMIT' ? 413
          : ['SINGLE_SITE_PURGE_NOT_TERMINAL', 'SINGLE_SITE_PURGE_FINALIZATION_PENDING',
            'SINGLE_SITE_PURGE_BASELINE_BUSY', 'SINGLE_SITE_PURGE_INCOMPLETE'].includes(error.code) ? 409
            : 422
      : null;
    const singleSiteAiReviewStatus = error instanceof SingleSiteAiReviewError
      ? ['AI_REVIEW_CAS_CONFLICT', 'AI_REVIEW_BUSY', 'AI_REVIEW_NOT_READY'].includes(error.code) ? 409
        : ['AI_REVIEW_INVALID', 'AI_REVIEW_PATH_UNSAFE'].includes(error.code) ? 400
          : ['AI_REVIEW_REPORT_BINDING', 'AI_REVIEW_INPUT_LIMIT', 'AI_REVIEW_OUTPUT_INVALID',
            'AI_REVIEW_OUTPUT_SECRET', 'AI_REVIEW_STATUS_INVALID'].includes(error.code) ? 422
            : 503
      : null;
    const status = Number.isInteger(error?.statusCode)
      ? error.statusCode
      : queueStatus ?? baselineStatus ?? visualReviewStatus ?? singleSitePurgeStatus ?? singleSiteAiReviewStatus ?? 500;
    if (status >= 500) console.error(error);
    const body = {
      error: Number.isInteger(error?.statusCode)
        || error instanceof JobQueueError
        || error instanceof VisualBaselineStoreError
        || error instanceof VisualReviewStoreError
        || error instanceof SingleSitePurgeError
        || error instanceof SingleSiteAiReviewError
        ? error.message
        : 'Internal server error.',
    };
    if (typeof error?.code === 'string' && /^(?:AI_REVIEW|AUTHENTICATION|AUTHORIZATION|BASELINE|GALLERY|READ_OBJECT|SHARED|SINGLE_SITE|VISUAL_REVIEW|QUEUE)_[A-Z0-9_]+$/.test(error.code)) {
      body.code = error.code;
    }
    if (error instanceof VisualBaselineStoreError && error.details) body.details = error.details;
    if (error instanceof VisualReviewStoreError && error.details) body.details = error.details;
    if (error instanceof SingleSitePurgeError && error.details) body.details = error.details;
    if (error?.name === 'SingleSiteLaunchError' && error.details) body.details = error.details;
    if (error instanceof GalleryHttpError) {
      if (error.head) body.head = error.head;
      if (error.recovery) body.recovery = error.recovery;
    }
    sendJson(response, status, body);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Audit portal listening on http://${HOST}:${PORT}`);
  console.log(`Run evidence will be stored in ${ARTIFACT_ROOT}`);
  console.log(`Externally launched sharded runs will be tracked from ${SHARDED_ARTIFACT_ROOT}`);
  console.log(`Single-site jobs use the verified ${singleSiteQueue.storage?.filesystemType ?? 'unknown'} queue at ${SINGLE_SITE_QUEUE_ROOT}`);
  console.log(`Single-site visual baselines use the independent persistent store at ${VISUAL_BASELINE_ROOT}`);
  if (legacyOperatorEnabled) console.log(`Operator unlock path (append to the published portal origin): /operator/bootstrap?token=${operatorCapabilityToken}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(externalRunSyncTimer);
    clearInterval(singleSiteAiReviewSyncTimer);
    if (consoleMaintenanceTimer) clearInterval(consoleMaintenanceTimer);
    if (consoleMaintenanceImmediate) clearImmediate(consoleMaintenanceImmediate);
    consoleMaintenanceAbortController?.abort();
    void closeConsoleIndexMaintenance().finally(() => {
      for (const run of runs.values()) {
        if (run.child && !TERMINAL_STATUSES.has(run.manifest.status)) stopChild(run, 'Portal shutting down');
      }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  });
}

function nextConsoleSourceRevision(mode) {
  if (mode === 'comparative') return `comparative-${++consoleComparativeSourceRevision}`;
  return `single-site-${++consoleSingleSiteSourceRevision}`;
}

function consoleSourceUpdatedAt(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : new Date().toISOString();
}

function comparativeConsoleIndexRecord(run, sourceRevision = nextConsoleSourceRevision('comparative')) {
  const manifest = run?.manifest;
  if (!manifest || typeof manifest.id !== 'string') throw new TypeError('Comparative console source is invalid.');
  const options = manifest.options ?? {};
  const qualifier = options.auditIds?.length || options.pluginIds?.length || options.areas?.length
    ? 'TARGETED'
    : 'FULL';
  const normalized = normalizeComparativeConsoleRecord({
    mode: 'comparative',
    sourceType: run.externalManaged ? 'external-sharded-manifest' : 'portal-run-manifest',
    sourceIdentity: manifest.id,
    sourceRevision,
    sourceUpdatedAt: consoleSourceUpdatedAt(
      manifest.updatedAt ?? manifest.finishedAt ?? manifest.startedAt ?? manifest.createdAt,
    ),
    document: {
      manifest,
      runContract: {
        productionUrl: options.productionUrl,
        candidateUrl: options.candidateUrl,
        targetIds: options.targetIds ?? options.projects,
        scope: {
          qualifier,
          pluginIds: options.pluginIds ?? [],
          auditIds: options.auditIds ?? [],
          areas: options.areas ?? [],
        },
      },
    },
  }, { completeness: 'partial', freshness: 'current' });
  return normalizedRunToConsoleIndexRecord(normalized, { sourceId: COMPARATIVE_CONSOLE_SOURCE_ID });
}

function comparativeConsoleTimelineRecords(run, indexRecord) {
  const stages = Object.entries(run?.manifest?.stages ?? {}).map(([stageId, stage]) => ({
    ...(stage && typeof stage === 'object' && !Array.isArray(stage) ? stage : {}),
    stageId,
  }));
  return projectComparativeTimeline(run.manifest.id, { stages }, {
    sourceRevision: indexRecord.sourceRevision,
  }).slice(-MAX_CONSOLE_TIMELINE_RECORDS_PER_RUN).map((timeline) => timelineToConsoleIndexRecord(timeline, {
    sourceId: COMPARATIVE_CONSOLE_SOURCE_ID,
    scopeKey: indexRecord.scopeKey,
    sourceUpdatedAt: indexRecord.sourceUpdatedAt,
    complete: indexRecord.complete,
  }));
}

async function authoritativeComparativeConsoleIndexRecord(run) {
  const id = run.manifest.id;
  if (run.externalManaged) {
    await refreshExternalRun(run, false, {
      remainingBytes: MAX_EXTERNAL_REFRESH_BYTES,
      deadline: performance.now() + MAX_EXTERNAL_REFRESH_MS,
      bytesRead: 0,
      filesVisited: 0,
      skippedBytes: 0,
    });
    const refreshed = runs.get(id);
    if (!refreshed || refreshed.purgeQuarantine) throw new Error('Comparative authority is unavailable.');
    return authoritativeComparativeConsoleRecord(refreshed);
  }
  const manifestPath = join(run.directory, 'run.json');
  const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2
    || stat.size > MAX_COMPARATIVE_CONSOLE_MANIFEST_BYTES) {
    throw new Error('Comparative authority manifest is unsafe or oversized.');
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest?.id !== id) throw new Error('Comparative authority manifest identity changed.');
  return authoritativeComparativeConsoleRecord(run, manifest);
}

function singleSiteConsoleIndexRecord(
  state,
  { input = null, finalization = null, sourceRevision = null } = {},
) {
  if (!state || typeof state.jobId !== 'string') throw new TypeError('Single-site console source is invalid.');
  const document = { state };
  if (input) document.input = input;
  if (finalization) document.finalization = finalization;
  const normalized = normalizeSingleSiteConsoleRecord({
    mode: 'single-site',
    sourceType: 'single-site-queue-state',
    sourceIdentity: state.jobId,
    sourceRevision: sourceRevision ?? `state-${state.sequence ?? 0}`,
    sourceUpdatedAt: consoleSourceUpdatedAt(state.updatedAt ?? state.submittedAt),
    document,
  }, { completeness: input ? 'complete' : 'partial', freshness: 'current' });
  return normalizedRunToConsoleIndexRecord(normalized, { sourceId: SINGLE_SITE_CONSOLE_SOURCE_ID });
}

function singleSiteConsoleTimelineRecords(state, indexRecord) {
  return projectSingleSiteTimeline(state.jobId, state, {
    sourceRevision: indexRecord.sourceRevision,
  }).slice(-MAX_CONSOLE_TIMELINE_RECORDS_PER_RUN).map((timeline) => timelineToConsoleIndexRecord(timeline, {
    sourceId: SINGLE_SITE_CONSOLE_SOURCE_ID,
    scopeKey: indexRecord.scopeKey,
    sourceUpdatedAt: indexRecord.sourceUpdatedAt,
    complete: indexRecord.complete,
  }));
}

function upsertConsoleRecordSet(indexRecord, timelineRecords, options = {}) {
  const signatureKey = `${indexRecord.mode}\u0000${indexRecord.runId}`;
  const signature = consoleRecordSetSignature(indexRecord, timelineRecords);
  if (consoleIndexedStateSignatures.get(signatureKey) === signature) {
    return Object.freeze({ committed: false, reason: 'unchanged', record: indexRecord });
  }
  const primary = consoleIndex.upsert(indexRecord, options);
  if (!primary.committed) return primary;
  for (const timelineRecord of timelineRecords) consoleIndex.upsert(timelineRecord, options);
  consoleIndexedStateSignatures.set(signatureKey, signature);
  return primary;
}

function consoleRecordSetSignature(indexRecord, timelineRecords) {
  return createHash('sha256').update(JSON.stringify([indexRecord, ...timelineRecords], (key, value) => (
    key === 'sourceRevision' ? null : value
  ))).digest('hex');
}

function authoritativeComparativeConsoleRecord(run, manifest = run.manifest) {
  const authorityRun = manifest === run.manifest ? run : { ...run, manifest };
  const signatureKey = `comparative\u0000${manifest.id}`;
  const probe = comparativeConsoleIndexRecord(
    authorityRun,
    run.consoleSourceRevision ?? 'comparative-content-probe',
  );
  const unchanged = typeof run.consoleSourceRevision === 'string'
    && consoleIndexedStateSignatures.get(signatureKey)
      === consoleRecordSetSignature(probe, comparativeConsoleTimelineRecords(authorityRun, probe));
  const record = comparativeConsoleIndexRecord(
    authorityRun,
    unchanged ? run.consoleSourceRevision : nextConsoleSourceRevision('comparative'),
  );
  const timeline = comparativeConsoleTimelineRecords(authorityRun, record);
  run.consoleSourceRevision = record.sourceRevision;
  consoleIndexedStateSignatures.set(signatureKey, consoleRecordSetSignature(record, timeline));
  return record;
}

function upsertComparativeConsoleRun(run) {
  if (!consoleIndex || run?.purgeQuarantine) return false;
  try {
    const probe = comparativeConsoleIndexRecord(run, run.consoleSourceRevision ?? 'comparative-content-probe');
    const probeTimeline = comparativeConsoleTimelineRecords(run, probe);
    if (consoleIndexedStateSignatures.get(`comparative\u0000${run.manifest.id}`)
      === consoleRecordSetSignature(probe, probeTimeline)) {
      return Object.freeze({ committed: false, reason: 'unchanged', record: probe });
    }
    const record = comparativeConsoleIndexRecord(run, nextConsoleSourceRevision('comparative'));
    const result = upsertConsoleRecordSet(record, comparativeConsoleTimelineRecords(run, record));
    if (result.committed) run.consoleSourceRevision = record.sourceRevision;
    if (result.committed) queueComparativeConsoleReportProjection(run, record.scopeKey);
    return result;
  } catch (error) {
    console.error(`[PORTAL_CONSOLE_INDEX_REJECTED] comparative ${run?.manifest?.id ?? 'unknown'}: ${redactLogValue(error.message)}`);
    return false;
  }
}

function upsertSingleSiteConsoleState(state, options = {}) {
  if (!consoleIndex) return false;
  try {
    rememberSingleSiteConsoleJob(state.jobId);
    if (options.finalization) consoleKnownSingleSiteFinalizations.set(state.jobId, options.finalization);
    if (options.input?.advisory?.aiReview) {
      consoleKnownSingleSiteAiOptIn.set(state.jobId, options.input.advisory.aiReview.optedIn === true);
    }
    const fresh = singleSiteConsoleIndexRecord(state, options);
    const current = consoleIndex.read({ mode: 'single-site', runId: state.jobId }).value;
    const record = current ? mergeSingleSiteConsoleIndexRecord(current, fresh) : fresh;
    const result = upsertConsoleRecordSet(record, singleSiteConsoleTimelineRecords(state, record));
    if (result.committed && options.finalization) {
      queueSingleSiteConsoleReportProjection(state, options.finalization, record.scopeKey);
    }
    return result;
  } catch (error) {
    console.error(`[PORTAL_CONSOLE_INDEX_REJECTED] single-site ${state?.jobId ?? 'unknown'}: ${redactLogValue(error.message)}`);
    return false;
  }
}

function consoleReportProjectionKey(identity) {
  return `${identity.mode}\u0000${identity.runId}`;
}

function consoleReportProjectionSignature(publication) {
  return `${publication.publicationRevision}:${publication.publicationDigest}`;
}

function updateConsoleReportSourceWatermark(mode) {
  if (!consoleIndex) return;
  const sourceId = `${mode}-report-publication`;
  const prefix = `${mode}\u0000`;
  const expectedKeys = new Set([
    ...[...consoleReportProjectionCompleted.keys()].filter((key) => key.startsWith(prefix)),
    ...[...consoleReportProjectionTasks.keys()].filter((key) => key.startsWith(prefix)),
    ...[...consoleReportProjectionLoads.keys()].filter((key) => key.startsWith(prefix)),
    ...[...consoleReportProjectionFailures.keys()].filter((key) => key.startsWith(prefix)),
  ]);
  const complete = expectedKeys.size > 0 && [...expectedKeys].every((key) => (
    !consoleReportProjectionLoads.has(key)
    && !consoleReportProjectionTasks.has(key)
    && !consoleReportProjectionFailures.has(key)
    && consoleReportProjectionCompleted.get(key)?.complete === true
  ));
  const sequence = mode === 'comparative'
    ? ++consoleComparativeReportWatermark
    : ++consoleSingleSiteReportWatermark;
  consoleIndex.setSourceWatermark(sourceId, {
    revision: `${mode}-report-index-${sequence}`,
    updatedAt: new Date().toISOString(),
    complete,
    limitation: complete ? null : expectedKeys.size > 0 ? 'incomplete-publication' : 'source-unavailable',
  });
}

function queueConsoleReportProjection(publication, identity, scopeKey) {
  if (!consoleIndex || consoleMaintenanceAbortController?.signal.aborted) return;
  const key = consoleReportProjectionKey(identity);
  const signature = consoleReportProjectionSignature(publication);
  if (consoleReportProjectionCompleted.get(key)?.signature === signature) return;
  const current = consoleReportProjectionTasks.get(key);
  if (current?.signature === signature && current.task.status === 'pending') return;
  if (current) cancelConsoleReportProjectionTask(current.task);
  const task = createConsoleReportProjectionTask({
    index: consoleIndex,
    publication,
    identity,
    scopeKey,
  });
  if (task.status !== 'pending') {
    consoleReportProjectionFailures.set(key, { reason: task.reason ?? 'projection-rejected' });
    updateConsoleReportSourceWatermark(identity.mode);
    return;
  }
  consoleReportProjectionFailures.delete(key);
  consoleReportProjectionTasks.set(key, { task, signature });
  updateConsoleReportSourceWatermark(identity.mode);
  scheduleConsoleIndexMaintenance();
}

function queueComparativeConsoleReportProjection(run, scopeKey) {
  if (!TERMINAL_STATUSES.has(run.manifest.status)
    || run.manifest.pipeline?.completed !== true
    || run.manifest.stages?.reportRebuild?.status !== 'completed') return;
  const identity = { mode: 'comparative', runId: run.manifest.id };
  const key = consoleReportProjectionKey(identity);
  if (consoleReportProjectionLoads.has(key)) return;
  consoleReportProjectionFailures.delete(key);
  const load = (async () => {
    const publication = await loadReportPublication(run.directory);
    if (publication.mode === 'single-site') throw new Error('Comparative run exposed a Single-site report publication.');
    const current = runs.get(identity.runId);
    if (!current || current.purgeQuarantine) return;
    queueConsoleReportProjection(publication, identity, scopeKey);
  })().catch((error) => {
    consoleReportProjectionFailures.set(key, { reason: 'load-failed' });
    updateConsoleReportSourceWatermark(identity.mode);
    console.error(`[PORTAL_CONSOLE_REPORT_REJECTED] comparative ${identity.runId}: ${redactLogValue(error.message)}`);
  }).finally(() => {
    if (consoleReportProjectionLoads.get(key) === load) {
      consoleReportProjectionLoads.delete(key);
      updateConsoleReportSourceWatermark(identity.mode);
    }
  });
  consoleReportProjectionLoads.set(key, load);
  updateConsoleReportSourceWatermark(identity.mode);
}

function queueSingleSiteConsoleReportProjection(state, finalization, scopeKey) {
  if (!['complete', 'incomplete'].includes(finalization.status)
    || typeof finalization.reportRevision !== 'string'
    || typeof finalization.reportPublicationDigest !== 'string') return;
  const identity = { mode: 'single-site', runId: state.jobId };
  const key = consoleReportProjectionKey(identity);
  if (consoleReportProjectionLoads.has(key)) return;
  consoleReportProjectionFailures.delete(key);
  const load = (async () => {
    const directory = resolve(SINGLE_SITE_FINALIZATION_ROOT, state.jobId, 'report');
    if (directory !== SINGLE_SITE_FINALIZATION_ROOT
      && !directory.startsWith(`${SINGLE_SITE_FINALIZATION_ROOT}${sep}`)) {
      throw new Error('Single-site report directory escaped its configured root.');
    }
    const publication = await loadSingleSiteReportPublication(directory, finalization.reportRevision);
    if (publication.publicationDigest !== finalization.reportPublicationDigest) {
      throw new Error('Single-site report publication disagrees with finalization authority.');
    }
    if (!consoleKnownSingleSiteJobSet.has(identity.runId)) return;
    queueConsoleReportProjection(publication, identity, scopeKey);
  })().catch((error) => {
    consoleReportProjectionFailures.set(key, { reason: 'load-failed' });
    updateConsoleReportSourceWatermark(identity.mode);
    console.error(`[PORTAL_CONSOLE_REPORT_REJECTED] single-site ${identity.runId}: ${redactLogValue(error.message)}`);
  }).finally(() => {
    if (consoleReportProjectionLoads.get(key) === load) {
      consoleReportProjectionLoads.delete(key);
      updateConsoleReportSourceWatermark(identity.mode);
    }
  });
  consoleReportProjectionLoads.set(key, load);
  updateConsoleReportSourceWatermark(identity.mode);
}

function forgetConsoleReportProjection(identity) {
  const key = consoleReportProjectionKey(identity);
  const current = consoleReportProjectionTasks.get(key);
  if (current) cancelConsoleReportProjectionTask(current.task);
  consoleReportProjectionTasks.delete(key);
  consoleReportProjectionLoads.delete(key);
  consoleReportProjectionFailures.delete(key);
  consoleReportProjectionCompleted.delete(key);
  updateConsoleReportSourceWatermark(identity.mode);
}

async function runConsoleReportProjectionSlice() {
  const entry = consoleReportProjectionTasks.entries().next().value;
  if (!entry) return;
  const [key, current] = entry;
  try {
    await runConsoleReportProjectionTaskSlice(current.task, {
      signal: consoleMaintenanceAbortController.signal,
      limit: 50,
      maximumDocuments: 2,
      maximumSourceBytes: 1024 * 1024,
      maximumDocumentBytes: 1024 * 1024,
    });
    if (current.task.status === 'pending') return;
    consoleReportProjectionTasks.delete(key);
    if (current.task.status === 'committed') {
      consoleReportProjectionFailures.delete(key);
      consoleReportProjectionCompleted.set(key, {
        signature: current.signature,
        complete: current.task.complete === true,
      });
      updateConsoleReportSourceWatermark(current.task.identity.mode);
      return;
    }
    if (current.task.reason === 'stale-capture') {
      queueConsoleReportProjection(
        current.task.publication,
        current.task.identity,
        current.task.scopeKey,
      );
      return;
    }
    consoleReportProjectionFailures.set(key, { reason: current.task.reason ?? 'projection-rejected' });
    updateConsoleReportSourceWatermark(current.task.identity.mode);
  } catch (error) {
    consoleReportProjectionTasks.delete(key);
    if (error?.name !== 'AbortError') {
      consoleReportProjectionFailures.set(key, { reason: 'projection-failed' });
      updateConsoleReportSourceWatermark(current.task.identity.mode);
      console.error(`[PORTAL_CONSOLE_REPORT_REJECTED] ${current.task.identity.mode} ${current.task.identity.runId}: ${redactLogValue(error.message)}`);
    }
  }
}

function mergeSingleSiteConsoleIndexRecord(current, fresh) {
  const fields = { ...current.fields, ...fresh.fields };
  for (const key of ['targetIds', 'pluginIds', 'auditIds', 'areas']) {
    if (Array.isArray(fresh.fields[key]) && fresh.fields[key].length === 0
      && Array.isArray(current.fields[key]) && current.fields[key].length > 0) {
      fields[key] = current.fields[key];
    }
  }
  for (const key of ['auditedOrigin', 'deploymentRole', 'qualifier', 'scopeLabel']) {
    if ((fresh.fields[key] === undefined || fresh.fields[key] === 'Single-site scope unavailable')
      && current.fields[key] !== undefined) fields[key] = current.fields[key];
  }
  return Object.freeze({
    ...fresh,
    scopeKey: fresh.scopeKey === 'unknown' ? current.scopeKey : fresh.scopeKey,
    complete: false,
    fields: Object.freeze(fields),
  });
}

function rememberSingleSiteConsoleJob(jobId) {
  if (!SAFE_SINGLE_SITE_JOB_ID.test(jobId) || consoleKnownSingleSiteJobSet.has(jobId)) return;
  if (consoleKnownSingleSiteJobSet.size >= MAX_CONSOLE_KNOWN_SINGLE_SITE_JOBS) {
    consoleSingleSiteBackfillLimited = true;
    return;
  }
  consoleKnownSingleSiteJobSet.add(jobId);
  const slot = consoleKnownSingleSiteFreeSlots.pop();
  if (slot === undefined) {
    consoleKnownSingleSiteJobSlots.set(jobId, consoleKnownSingleSiteJobIds.length);
    consoleKnownSingleSiteJobIds.push(jobId);
  } else {
    consoleKnownSingleSiteJobSlots.set(jobId, slot);
    consoleKnownSingleSiteJobIds[slot] = jobId;
  }
}

function forgetSingleSiteConsoleJob(jobId) {
  forgetConsoleReportProjection({ mode: 'single-site', runId: jobId });
  const slot = consoleKnownSingleSiteJobSlots.get(jobId);
  consoleKnownSingleSiteJobSet.delete(jobId);
  consoleKnownSingleSiteJobSlots.delete(jobId);
  consoleKnownSingleSiteRevisions.delete(jobId);
  consoleKnownSingleSiteFinalizations.delete(jobId);
  consoleKnownSingleSiteAiOptIn.delete(jobId);
  consoleIndexedStateSignatures.delete(`single-site\u0000${jobId}`);
  if (slot !== undefined) {
    consoleKnownSingleSiteJobIds[slot] = null;
    consoleKnownSingleSiteFreeSlots.push(slot);
  }
}

async function refreshSingleSiteConsoleRun(jobId) {
  const state = await readSingleSiteJob(singleSiteQueue, jobId);
  const finalization = await readSingleSiteFinalizationStatus(SINGLE_SITE_FINALIZATION_ROOT, jobId)
    .catch(() => null);
  upsertSingleSiteConsoleState(state, { finalization });
}

async function refreshSingleSiteConsoleRunBestEffort(jobId, reason) {
  try {
    await refreshSingleSiteConsoleRun(jobId);
  } catch (error) {
    console.error(`[PORTAL_CONSOLE_INDEX_REJECTED] Single-site ${reason} ${jobId}: ${redactLogValue(error.message)}`);
  }
}

function beginConsoleIndexBackfill() {
  const now = new Date().toISOString();
  consoleComparativeBackfillRevision = nextConsoleSourceRevision('comparative');
  consoleSingleSiteBackfillRevision = nextConsoleSourceRevision('single-site');
  consoleComparativeBackfillIterator = runs.values();
  consoleSingleSiteBackfillIterator = null;
  consoleSingleSitePendingEntry = null;
  consoleComparativeBackfillDone = false;
  consoleSingleSiteBackfillDone = false;
  consoleComparativeBackfillLimited = false;
  consoleSingleSiteBackfillLimited = false;
  consoleComparativeBackfillRecords = 0;
  consoleSingleSiteBackfillRecords = 0;
  consoleIndex.beginBackfill(COMPARATIVE_CONSOLE_SOURCE_ID, {
    revision: consoleComparativeBackfillRevision,
    updatedAt: now,
    cursor: null,
    budget: DEFAULT_CONSOLE_INDEX_BUDGET,
  });
  consoleIndex.beginBackfill(SINGLE_SITE_CONSOLE_SOURCE_ID, {
    revision: consoleSingleSiteBackfillRevision,
    updatedAt: now,
    cursor: null,
    budget: DEFAULT_CONSOLE_INDEX_BUDGET,
  });
}

function boundedConsoleBackfillWork(work, startedAt, budgetExhausted = false) {
  const elapsedMs = Math.max(0, Math.ceil(performance.now() - startedAt));
  return createConsoleReadWork({
    ...work,
    elapsedMs,
    budgetExhausted: budgetExhausted || elapsedMs >= DEFAULT_CONSOLE_INDEX_BUDGET.maxElapsedMs,
  });
}

async function backfillComparativeConsoleIndexSlice() {
  const startedAt = performance.now();
  let work = createConsoleReadWork();
  let budgetExhausted = false;
  while (!consoleComparativeBackfillDone) {
    if (work.recordsRead >= DEFAULT_CONSOLE_INDEX_BUDGET.maxRecords
      || performance.now() - startedAt >= DEFAULT_CONSOLE_INDEX_BUDGET.maxElapsedMs) {
      budgetExhausted = true;
      break;
    }
    const next = consoleComparativeBackfillIterator.next();
    if (next.done) {
      consoleComparativeBackfillDone = true;
      consoleComparativeBackfillIterator = null;
      break;
    }
    const consumed = consumeConsoleReadWork(work, DEFAULT_CONSOLE_INDEX_BUDGET, { recordsRead: 1 });
    if (!consumed.accepted) {
      budgetExhausted = true;
      break;
    }
    work = consumed.work;
    consoleComparativeBackfillRecords += 1;
    try {
      const record = comparativeConsoleIndexRecord(next.value);
      next.value.consoleSourceRevision = record.sourceRevision;
      const result = upsertConsoleRecordSet(record, comparativeConsoleTimelineRecords(next.value, record));
      if (result.committed) queueComparativeConsoleReportProjection(next.value, record.scopeKey);
    } catch (error) {
      consoleComparativeBackfillLimited = true;
      console.error(`[PORTAL_CONSOLE_BACKFILL_REJECTED] comparative record: ${redactLogValue(error.message)}`);
    }
  }
  const complete = consoleComparativeBackfillDone && !consoleComparativeBackfillLimited;
  consoleIndex.updateBackfill(COMPARATIVE_CONSOLE_SOURCE_ID, {
    revision: consoleComparativeBackfillRevision,
    updatedAt: new Date().toISOString(),
    cursor: complete ? null : `runs-${consoleComparativeBackfillRecords}`,
    complete,
    limitation: complete ? null : consoleComparativeBackfillDone ? 'source-malformed' : 'budget-exhausted',
    work: boundedConsoleBackfillWork(work, startedAt, budgetExhausted),
  });
}

async function backfillSingleSiteConsoleIndexSlice() {
  const startedAt = performance.now();
  let work = createConsoleReadWork();
  let budgetExhausted = false;
  if (!consoleSingleSiteBackfillIterator) {
    try {
      consoleSingleSiteBackfillIterator = await fs.opendir(join(singleSiteQueue.root, 'jobs'));
    } catch (error) {
      consoleSingleSiteBackfillDone = true;
      consoleSingleSiteBackfillLimited = true;
      console.error(`[PORTAL_CONSOLE_BACKFILL_UNAVAILABLE] Single-site queue: ${redactLogValue(error.message)}`);
    }
  }
  while (!consoleSingleSiteBackfillDone && consoleSingleSiteBackfillIterator) {
    if (work.recordsRead >= DEFAULT_CONSOLE_INDEX_BUDGET.maxRecords
      || work.sourceFilesRead >= DEFAULT_CONSOLE_INDEX_BUDGET.maxSourceFiles
      || performance.now() - startedAt >= DEFAULT_CONSOLE_INDEX_BUDGET.maxElapsedMs) {
      budgetExhausted = true;
      break;
    }
    const entry = consoleSingleSitePendingEntry ?? await consoleSingleSiteBackfillIterator.read();
    consoleSingleSitePendingEntry = null;
    if (!entry) {
      consoleSingleSiteBackfillDone = true;
      await consoleSingleSiteBackfillIterator.close().catch(() => {});
      consoleSingleSiteBackfillIterator = null;
      break;
    }
    const candidateWork = consumeConsoleReadWork(work, DEFAULT_CONSOLE_INDEX_BUDGET, {
      recordsRead: 1,
      sourceFilesRead: 1,
    });
    if (!candidateWork.accepted) {
      consoleSingleSitePendingEntry = entry;
      budgetExhausted = true;
      break;
    }
    work = candidateWork.work;
    consoleSingleSiteBackfillRecords += 1;
    if (!entry.isDirectory() || !SAFE_SINGLE_SITE_JOB_ID.test(entry.name)) continue;
    rememberSingleSiteConsoleJob(entry.name);
    const statePath = join(singleSiteQueue.root, 'jobs', entry.name, 'state.json');
    try {
      const stateStat = await fs.lstat(statePath);
      if (!stateStat.isFile() || stateStat.isSymbolicLink()
        || stateStat.size < 1 || stateStat.size > MAX_SINGLE_SITE_CONSOLE_STATE_BYTES) {
        consoleSingleSiteBackfillLimited = true;
        continue;
      }
      const byteWork = consumeConsoleReadWork(work, DEFAULT_CONSOLE_INDEX_BUDGET, {
        sourceBytesRead: stateStat.size,
      });
      if (!byteWork.accepted) {
        consoleSingleSitePendingEntry = entry;
        budgetExhausted = true;
        break;
      }
      work = byteWork.work;
      const state = await readSingleSiteJob(singleSiteQueue, entry.name);
      const record = singleSiteConsoleIndexRecord(state);
      upsertConsoleRecordSet(record, singleSiteConsoleTimelineRecords(state, record));
    } catch (error) {
      consoleSingleSiteBackfillLimited = true;
      console.error(`[PORTAL_CONSOLE_BACKFILL_REJECTED] Single-site ${entry.name}: ${redactLogValue(error.message)}`);
    }
  }
  const complete = consoleSingleSiteBackfillDone && !consoleSingleSiteBackfillLimited;
  consoleIndex.updateBackfill(SINGLE_SITE_CONSOLE_SOURCE_ID, {
    revision: consoleSingleSiteBackfillRevision,
    updatedAt: new Date().toISOString(),
    cursor: complete ? null : `jobs-${consoleSingleSiteBackfillRecords}`,
    complete,
    limitation: complete ? null : consoleSingleSiteBackfillDone ? 'source-malformed' : 'budget-exhausted',
    work: boundedConsoleBackfillWork(work, startedAt, budgetExhausted),
  });
}

async function runConsoleIndexMaintenanceSlice() {
  if (consoleMaintenanceRunning || consoleMaintenanceAbortController?.signal.aborted) return;
  consoleMaintenanceRunning = true;
  try {
    if (!consoleComparativeBackfillDone) await backfillComparativeConsoleIndexSlice();
    if (!consoleMaintenanceAbortController.signal.aborted && !consoleSingleSiteBackfillDone) {
      await backfillSingleSiteConsoleIndexSlice();
    }
    if (!consoleMaintenanceAbortController.signal.aborted && consoleReportProjectionTasks.size > 0) {
      await runConsoleReportProjectionSlice();
    }
  } finally {
    consoleMaintenanceRunning = false;
  }
}

async function refreshKnownSingleSiteConsoleIndexSlice() {
  if (consoleKnownSingleSiteRefreshRunning || !consoleSingleSiteBackfillDone
    || consoleMaintenanceAbortController?.signal.aborted || consoleKnownSingleSiteJobIds.length === 0) return;
  consoleKnownSingleSiteRefreshRunning = true;
  const startedAt = performance.now();
  let work = createConsoleReadWork();
  let visited = 0;
  try {
    while (visited < consoleKnownSingleSiteJobIds.length
      && work.recordsRead < DEFAULT_CONSOLE_INDEX_BUDGET.maxRecords
      && work.sourceFilesRead < DEFAULT_CONSOLE_INDEX_BUDGET.maxSourceFiles
      && performance.now() - startedAt < DEFAULT_CONSOLE_INDEX_BUDGET.maxElapsedMs) {
      const slot = consoleKnownSingleSiteCursor % consoleKnownSingleSiteJobIds.length;
      const jobId = consoleKnownSingleSiteJobIds[slot];
      consoleKnownSingleSiteCursor = (slot + 1) % consoleKnownSingleSiteJobIds.length;
      visited += 1;
      if (!consoleKnownSingleSiteJobSet.has(jobId)) continue;
      const candidate = consumeConsoleReadWork(work, DEFAULT_CONSOLE_INDEX_BUDGET, {
        recordsRead: 1,
        sourceFilesRead: 1,
      });
      if (!candidate.accepted) break;
      work = candidate.work;
      const statePath = join(singleSiteQueue.root, 'jobs', jobId, 'state.json');
      let stateStat;
      try {
        stateStat = await fs.lstat(statePath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          forgetSingleSiteConsoleJob(jobId);
          continue;
        }
        throw error;
      }
      if (!stateStat.isFile() || stateStat.isSymbolicLink()
        || stateStat.size < 1 || stateStat.size > MAX_SINGLE_SITE_CONSOLE_STATE_BYTES) continue;
      const stateBytes = consumeConsoleReadWork(work, DEFAULT_CONSOLE_INDEX_BUDGET, {
        sourceBytesRead: stateStat.size,
      });
      if (!stateBytes.accepted) {
        consoleKnownSingleSiteCursor = slot;
        break;
      }
      work = stateBytes.work;
      const state = await readSingleSiteJob(singleSiteQueue, jobId);
      let finalization = null;
      if (SINGLE_SITE_TERMINAL_STATES.has(state.executionState)) {
        const finalFile = consumeConsoleReadWork(work, DEFAULT_CONSOLE_INDEX_BUDGET, { sourceFilesRead: 1 });
        if (!finalFile.accepted) {
          consoleKnownSingleSiteCursor = slot;
          break;
        }
        work = finalFile.work;
        const finalizationPath = join(SINGLE_SITE_FINALIZATION_ROOT, jobId, 'status.json');
        const finalizationStat = await fs.lstat(finalizationPath).catch((error) => {
          if (error?.code === 'ENOENT') return null;
          throw error;
        });
        if (!finalizationStat) {
          finalization = { status: 'pending' };
        } else if (finalizationStat.isFile() && !finalizationStat.isSymbolicLink()
          && finalizationStat.size >= 2 && finalizationStat.size <= MAX_SINGLE_SITE_CONSOLE_FINALIZATION_BYTES) {
          const finalizationBytes = consumeConsoleReadWork(work, DEFAULT_CONSOLE_INDEX_BUDGET, {
            sourceBytesRead: finalizationStat.size,
          });
          if (!finalizationBytes.accepted) {
            consoleKnownSingleSiteCursor = slot;
            break;
          }
          work = finalizationBytes.work;
          finalization = await readSingleSiteFinalizationStatus(SINGLE_SITE_FINALIZATION_ROOT, jobId);
        } else {
          finalization = { status: 'invalid' };
        }
      }
      const revision = JSON.stringify([
        state.sequence ?? null,
        state.updatedAt ?? null,
        finalization?.status ?? null,
        finalization?.reportRevision ?? null,
        finalization?.galleryExportRevision ?? null,
      ]);
      if (consoleKnownSingleSiteRevisions.get(jobId) === revision) continue;
      upsertSingleSiteConsoleState(state, { finalization });
      consoleKnownSingleSiteRevisions.set(jobId, revision);
    }
  } finally {
    consoleKnownSingleSiteRefreshRunning = false;
  }
}

function scheduleConsoleIndexMaintenance() {
  if (consoleMaintenanceAbortController?.signal.aborted || consoleMaintenanceImmediate
    || (consoleComparativeBackfillDone && consoleSingleSiteBackfillDone
      && consoleReportProjectionTasks.size === 0)) return;
  consoleMaintenanceImmediate = setImmediate(() => {
    consoleMaintenanceImmediate = null;
    void runConsoleIndexMaintenanceSlice()
      .then(scheduleConsoleIndexMaintenance)
      .catch((error) => console.error(`[PORTAL_CONSOLE_BACKFILL_FAILED] ${redactLogValue(error.message)}`));
  });
  consoleMaintenanceImmediate.unref?.();
}

async function closeConsoleIndexMaintenance() {
  const iterator = consoleSingleSiteBackfillIterator;
  consoleSingleSiteBackfillIterator = null;
  consoleComparativeBackfillIterator = null;
  consoleSingleSitePendingEntry = null;
  if (iterator) await iterator.close().catch(() => {});
  consolePendingPurgeTokens.clear();
  consoleKnownSingleSiteJobSet.clear();
  consoleKnownSingleSiteJobSlots.clear();
  consoleKnownSingleSiteFreeSlots.length = 0;
  consoleKnownSingleSiteJobIds.length = 0;
  consoleKnownSingleSiteRevisions.clear();
  consoleKnownSingleSiteFinalizations.clear();
  consoleKnownSingleSiteAiOptIn.clear();
  for (const { task } of consoleReportProjectionTasks.values()) {
    cancelConsoleReportProjectionTask(task);
  }
  consoleReportProjectionTasks.clear();
  consoleReportProjectionLoads.clear();
  consoleReportProjectionFailures.clear();
  consoleReportProjectionCompleted.clear();
  consoleIndex?.clear();
}

async function resolveConsoleCapabilities({ identities, signal, authorization }) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Console request disconnected.', 'AbortError');
  const authorized = authorization?.authorized === true;
  const authorityRevision = consoleIndex.sourceVector().indexRevision;
  const baselineLocked = identities.some(({ mode }) => mode === 'single-site')
    ? await isVisualBaselineMutationLocked(visualBaselineStore)
    : false;
  return identities.map((identity) => {
    if (identity.mode === 'comparative') {
      const run = runs.get(identity.runId);
      const terminal = Boolean(run && TERMINAL_STATUSES.has(run.manifest.status));
      const active = Boolean(run && !run.externalManaged && !terminal && !run.purgeQuarantine);
      const purgeEligible = Boolean(run && (run.purgeQuarantine || (
        terminal && !purgingRunIds.has(identity.runId)
          && !manualMutationRunIds.has(identity.runId) && !galleryMutationRunIds.has(identity.runId)
      )));
      const manualEligible = Boolean(run && !run.externalManaged && terminal && !run.child
        && !['stopped', 'spawn-failed'].includes(run.manifest.status) && !run.purgeQuarantine
        && !purgingRunIds.has(identity.runId) && !manualMutationRunIds.has(identity.runId));
      const aiEligible = Boolean(run && !run.externalManaged && terminal && !run.purgeQuarantine
        && run.manifest.stages?.aiReview?.enabled === true
        && run.manifest.stages.aiReview.status === 'failed' && currentAnthropicApiKey());
      return {
        identity,
        contextId: 'comparative-live',
        authorityRevision,
        actions: consoleActionsForContext('comparative-live', authorized, {
          stop: [active, active ? null : run?.externalManaged ? 'External runs must be stopped by their launcher.' : 'The run is not active.'],
          purge: [purgeEligible, purgeEligible ? null : 'The run cannot be purged while active or mutation-locked.'],
          manualEvidence: [manualEligible, manualEligible ? null : 'Manual evidence requires a finished portal-managed run without a mutation lock.'],
          aiReview: [aiEligible, aiEligible ? null : 'A failed opted-in advisory with current credentials is required.'],
          settings: [true, null],
        }),
      };
    }
    const indexed = consoleIndex.read(identity).value;
    const terminal = indexed?.fields?.terminal === true;
    const executionState = indexed?.fields?.executionState;
    const finalization = consoleKnownSingleSiteFinalizations.get(identity.runId);
    const finalizationReady = Boolean(finalization && finalization.status !== 'pending');
    const finalizedEvidence = Boolean(finalization && ['complete', 'incomplete'].includes(finalization.status));
    const completed = executionState === 'completed';
    const purgeActive = consolePendingPurgeTokens.has(`single-site:${identity.runId}`);
    const visualEligible = Boolean(completed && finalizedEvidence
      && finalization.galleryExportRevision && finalization.galleryIndexDigest);
    const baselineEligible = Boolean(visualEligible && finalization.visualEligibilityManifestDigest && !baselineLocked);
    const aiEligible = Boolean(completed && finalizedEvidence
      && consoleKnownSingleSiteAiOptIn.get(identity.runId) === true && singleSiteAiRuntimeKey());
    return {
      identity,
      contextId: 'single-site-live',
      authorityRevision,
      actions: consoleActionsForContext('single-site-live', authorized, {
        cancel: [Boolean(indexed && !terminal && !purgeActive), terminal ? 'The run is terminal.' : 'The run is unavailable.'],
        purge: [Boolean(indexed && terminal && finalizationReady && !purgeActive),
          finalizationReady ? 'The run is unavailable or already being purged.' : 'Finalization must publish before purge.'],
        visualDisposition: [visualEligible, visualEligible ? null : 'A completed gallery publication is required.'],
        baseline: [baselineEligible, baselineLocked ? 'A baseline mutation is already active.' : 'Eligible finalized visual evidence is required.'],
        aiReview: [aiEligible, aiEligible ? null : 'An opted-in finalized advisory with current credentials is required.'],
        settings: [true, null],
      }),
    };
  });
}

function consoleActionsForContext(contextId, authorized, eligibility) {
  const context = getConsoleCapabilities(contextId);
  return Object.keys(context.actions).map((actionId) => {
    const supported = context.actions[actionId] === true;
    const [eligible, reason] = eligibility[actionId] ?? [null, null];
    const resolved = resolveConsoleActionAvailability(contextId, actionId, {
      authorized: supported ? authorized : null,
      eligible: supported ? eligible : null,
      unavailableReason: supported && authorized && eligible === false ? reason : null,
    });
    return {
      actionId,
      supported: resolved.supported,
      authorized: resolved.authorized,
      eligible: resolved.eligible,
      available: resolved.available,
      unavailableReason: resolved.unavailableReason,
    };
  });
}

async function routeRequest(request, response) {
  assertAllowedRequestHost(request);
  const requestUrl = new URL(request.url ?? '/', 'http://portal.local');
  const pathname = requestUrl.pathname;

  if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/console-contracts.mjs') {
    return sendFile(
      request,
      response,
      join(PORTAL_DIR, 'console-contracts.mjs'),
      "default-src 'self'; connect-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      { contentType: 'text/javascript; charset=utf-8' },
    );
  }

  if ((request.method === 'GET' || request.method === 'HEAD')
    && (CONSOLE_SHELL_FIXTURE_FILES.has(pathname) || pathname === CONSOLE_CONTRACT_FIXTURE_PATH)) {
    if (process.env.PORTAL_E2E_FAILURE_INJECTION !== '1') throw httpError(404, 'Not found.');
    const file = pathname === CONSOLE_CONTRACT_FIXTURE_PATH
      ? join(PORTAL_DIR, 'console-contracts.mjs')
      : CONSOLE_SHELL_FIXTURE_FILES.get(pathname);
    return sendFile(
      request,
      response,
      file,
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      pathname === CONSOLE_CONTRACT_FIXTURE_PATH ? { contentType: 'text/javascript; charset=utf-8' } : undefined,
    );
  }

  if (request.method === 'GET' && pathname === RUN_WORKSPACE_DIAGNOSTICS_PATH) {
    if (process.env.PORTAL_E2E_FAILURE_INJECTION !== '1') throw httpError(404, 'Not found.');
    return sendJson(response, 200, publicSseDiagnostics());
  }

  if (request.method === 'GET' && pathname === '/healthz') {
    return sendJson(response, 200, { ok: true });
  }
  if (pathname === '/api/control/v1' || pathname.startsWith('/api/control/v1/')) {
    if (!sharedControlApi) throw httpError(503, 'Shared control API is not enabled.');
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ? await readJsonBody(request) : null;
    const result = await sharedControlApi.handle({ method: request.method, url: request.url, headers: request.headers, body });
    if (!result.handled) throw httpError(404, 'Not found.');
    return sendJson(response, result.status, result.body, result.headers);
  }
  if (sharedRequestAuthorizer) rejectRetiredLegacyMutation({ method: request.method, pathname });
  await authorizeSharedLegacyRead(request, pathname);
  if (pathname === '/api/console/v1' || pathname.startsWith('/api/console/v1/')) {
    const result = await withConsoleRequest(request, response, (signal) => handleConsoleApiRequest(consoleApi, {
      method: request.method,
      url: request.url,
      signal,
      authorization: { authorized: operatorRequestAuthorized(request) },
    }));
    if (!result.handled) throw httpError(404, 'Not found.');
    return sendConsoleApiResult(request, response, result);
  }
  if (request.method === 'GET' && pathname === '/operator/bootstrap') {
    if (!legacyOperatorEnabled) throw httpError(404, 'Legacy operator unlock is unavailable in shared mutation mode.');
    if (!constantTimeTokenMatch(requestUrl.searchParams.get('token'), operatorCapabilityToken)) {
      throw httpError(403, 'The operator unlock link is invalid. Copy the current link from the portal service log.');
    }
    response.writeHead(303, {
      Location: '/',
      'Set-Cookie': operatorSessionCookie(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
    return response.end();
  }
  if (request.method === 'POST' && pathname === '/api/operator/session') {
    if (!legacyOperatorEnabled) throw httpError(404, 'Legacy operator unlock is unavailable in shared mutation mode.');
    assertOperatorSessionRequest(request);
    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.token !== 'string' || body.token.length === 0 || body.token.length > 4_096) {
      throw httpError(400, 'Provide the current operator unlock link or token.');
    }
    if (!constantTimeTokenMatch(body.token, operatorCapabilityToken)) {
      throw httpError(403, 'The operator unlock credential is invalid or expired. Copy the current link from the portal service log.');
    }
    return sendJson(response, 200, { authorized: true }, {
      'Set-Cookie': operatorSessionCookie(),
      'Referrer-Policy': 'no-referrer',
    });
  }
  if (request.method === 'GET' && pathname === '/api/settings/anthropic-key') {
    return sendJson(response, 200, anthropicCredentialState());
  }
  if (request.method === 'PUT' && pathname === '/api/settings/anthropic-key') {
    assertMutationRequest(request);
    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.apiKey !== 'string') {
      throw httpError(400, 'Provide an Anthropic API key.');
    }
    await serializeCredentialMutation(() => saveAnthropicCredential(body.apiKey));
    return sendJson(response, 200, anthropicCredentialState());
  }
  if (request.method === 'DELETE' && pathname === '/api/settings/anthropic-key') {
    assertMutationRequest(request);
    await serializeCredentialMutation(deleteAnthropicCredential);
    return sendJson(response, 200, anthropicCredentialState());
  }
  if (request.method === 'GET' && pathname === '/api/config') {
    return sendJson(response, 200, {
      catalog,
      plugins,
      projects: PROJECTS,
      targets: targetRegistry,
      defaults: {
        productionUrl: process.env.PRODUCTION_URL ?? 'https://quitting7oh.org',
        candidateUrl: process.env.CANDIDATE_URL ?? 'https://beta.quitting7oh-org.pages.dev',
        profile: 'smoke',
        candidateIgnoreHTTPSErrors: DEFAULT_CANDIDATE_IGNORE_HTTPS_ERRORS,
        releaseShardTotal: DEFAULT_RELEASE_SHARD_TOTAL,
        releaseShardWorkers: DEFAULT_RELEASE_SHARD_WORKERS,
        releaseShardConcurrency: DEFAULT_RELEASE_SHARD_CONCURRENCY,
        singleSiteUrl: process.env.SINGLE_SITE_URL
          ?? process.env.CANDIDATE_URL
          ?? 'https://beta.quitting7oh-org.pages.dev',
        singleSiteDeploymentRole: 'preview',
        singleSiteCertificatePolicy: 'strict',
      },
      modes: ['comparative', 'single-site'],
      singleSite: {
        runnerRevision: singleSiteRunnerRevision,
        previewTlsBypassConfigured: previewTlsBypassOrigins.length > 0,
        fullProfileTargetIds: targetRegistry.singleSiteFullProfileTargetIds,
        queue: {
          available: true,
          filesystemType: singleSiteQueue.storage?.filesystemType ?? 'unverified',
          heartbeatMs: singleSiteQueue.heartbeatMs,
          leaseMs: singleSiteQueue.leaseMs,
          maxInfrastructureRetries: singleSiteQueue.maxInfrastructureRetries,
        },
        visualBaselines: {
          available: true,
          mutationsAuthorized: operatorRequestAuthorized(request),
        },
      },
      limits: { maxConcurrentRuns: MAX_CONCURRENT_RUNS },
      externalSync: externalRunSyncDiagnostics,
      operator: { authorized: operatorRequestAuthorized(request) },
      aiReview: {
        available: Boolean(currentAnthropicApiKey()) || process.env.AI_REVIEW_DRY_RUN === '1',
        dryRun: process.env.AI_REVIEW_DRY_RUN === '1',
        defaultModel: DEFAULT_AI_MODEL,
      },
      runnerIsolation: {
        active: RUNNER_IDENTITY.active,
        runnerUid: RUNNER_IDENTITY.uid,
        runnerGid: RUNNER_IDENTITY.gid,
        reason: RUNNER_IDENTITY.reason,
        aiWorkerActive: AI_WORKER_IDENTITY.active,
        aiWorkerUid: AI_WORKER_IDENTITY.uid,
        aiWorkerGid: AI_WORKER_IDENTITY.gid,
        aiWorkerReason: AI_WORKER_IDENTITY.reason,
        reportWorkerActive: REPORT_WORKER_IDENTITY.active,
        reportWorkerUid: REPORT_WORKER_IDENTITY.uid,
        reportWorkerGid: REPORT_WORKER_IDENTITY.gid,
        reportWorkerReason: REPORT_WORKER_IDENTITY.reason,
        credentialStorageEnabled: CREDENTIAL_ISOLATION_ACTIVE,
      },
    });
  }
  if (request.method === 'GET' && pathname === '/api/runs') {
    triggerExternalShardedRunSync();
    return sendJson(response, 200, { runs: sortedRunSummaries() });
  }
  if (request.method === 'POST' && pathname === '/api/single-site/preflight') {
    assertMutationRequest(request);
    const preview = await singleSiteLaunch.preview(await readJsonBody(request));
    return sendJson(response, preview.accepted ? 200 : 422, preview);
  }
  if (request.method === 'GET' && pathname === '/api/single-site/runs') {
    const jobs = await listSingleSiteJobs(singleSiteQueue);
    return sendJson(response, 200, {
      schemaVersion: 1,
      jobs: await Promise.all(jobs.map(publicSingleSiteJobSummary)),
    });
  }
  if (request.method === 'POST' && pathname === '/api/single-site/runs') {
    assertMutationRequest(request);
    const result = await singleSiteLaunch.launch(await readJsonBody(request));
    const status = result.launched ? (result.idempotent ? 200 : 201) : result.reason === 'preview-stale' ? 409 : 422;
    return sendJson(response, status, result);
  }
  if (request.method === 'POST' && pathname === '/api/runs') {
    assertMutationRequest(request);
    return createRun(request, response);
  }

  if (request.method === 'GET' && pathname === '/api/single-site/visual-baselines') {
    return sendJson(response, 200, await publicVisualBaselineCollection(requestUrl, request));
  }

  if (request.method === 'GET' && pathname === '/api/single-site/visual-baselines/history') {
    return sendJson(response, 200, await publicVisualBaselineEventHistory(requestUrl));
  }

  if (request.method === 'POST' && pathname === '/api/single-site/visual-baselines/approve') {
    assertMutationRequest(request);
    const result = await mutateVisualBaselineApproval('approve', null, await readJsonBody(request));
    return sendJson(response, 201, result);
  }

  const visualBaselineMatch = pathname.match(/^\/api\/single-site\/visual-baselines\/([^/]+)$/);
  if (request.method === 'GET' && visualBaselineMatch) {
    return sendJson(response, 200, await publicVisualBaseline(decodeURIComponent(visualBaselineMatch[1]), request));
  }
  if (request.method === 'DELETE' && visualBaselineMatch) {
    assertMutationRequest(request);
    const baselineId = decodeURIComponent(visualBaselineMatch[1]);
    return sendJson(response, 200, await mutateVisualBaselineLifecycle('delete', baselineId, await readJsonBody(request)));
  }

  const visualBaselineMediaMatch = pathname.match(/^\/api\/single-site\/visual-baselines\/([^/]+)\/media$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && visualBaselineMediaMatch) {
    return serveVisualBaselineMedia(request, response, decodeURIComponent(visualBaselineMediaMatch[1]));
  }

  const visualBaselineReplaceMatch = pathname.match(/^\/api\/single-site\/visual-baselines\/([^/]+)\/replace$/);
  if (request.method === 'POST' && visualBaselineReplaceMatch) {
    assertMutationRequest(request);
    const baselineId = decodeURIComponent(visualBaselineReplaceMatch[1]);
    return sendJson(response, 200, await mutateVisualBaselineApproval('replace', baselineId, await readJsonBody(request)));
  }

  const visualBaselineRevokeMatch = pathname.match(/^\/api\/single-site\/visual-baselines\/([^/]+)\/revoke$/);
  if (request.method === 'POST' && visualBaselineRevokeMatch) {
    assertMutationRequest(request);
    const baselineId = decodeURIComponent(visualBaselineRevokeMatch[1]);
    return sendJson(response, 200, await mutateVisualBaselineLifecycle('revoke', baselineId, await readJsonBody(request)));
  }

  const singleSiteRunMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)$/);
  if (request.method === 'GET' && singleSiteRunMatch) {
    const jobId = decodeURIComponent(singleSiteRunMatch[1]);
    const state = await readSingleSiteJob(singleSiteQueue, jobId);
    const input = await readSingleSiteJobInput(singleSiteQueue, jobId);
    return sendJson(response, 200, await publicSingleSiteJobWithFinalization(state, input));
  }

  const singleSiteAiReviewMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/ai-review$/);
  if (request.method === 'GET' && singleSiteAiReviewMatch) {
    const jobId = decodeURIComponent(singleSiteAiReviewMatch[1]);
    const input = await readSingleSiteJobInput(singleSiteQueue, jobId);
    const optedIn = input.advisory?.aiReview?.optedIn === true;
    const status = await readSingleSiteAiReview(singleSiteAiReview, jobId);
    const finalization = await readSingleSiteFinalizationStatus(SINGLE_SITE_FINALIZATION_ROOT, jobId)
      .catch(() => null);
    const displayState = singleSiteAiReviewDisplayState(optedIn, status, finalization);
    return sendJson(response, 200, {
      schemaVersion: 1,
      mode: 'single-site',
      advisory: true,
      gating: false,
      optedIn,
      model: input.advisory?.aiReview?.model ?? null,
      state: displayState.state,
      unavailableReason: displayState.unavailableReason,
      status: publicSingleSiteAiReviewStatus(status),
      result: status?.state === 'completed'
        ? `/api/single-site/runs/${encodeURIComponent(jobId)}/ai-review/result`
        : null,
    });
  }
  if (request.method === 'POST' && singleSiteAiReviewMatch) {
    assertMutationRequest(request);
    const jobId = decodeURIComponent(singleSiteAiReviewMatch[1]);
    const body = assertVisualBaselineMutationBody(
      await readJsonBody(request),
      ['expectedStateRevision', 'confirmation'],
      ['expectedStateRevision', 'confirmation'],
    );
    if (body.confirmation !== `RETRY AI ${jobId}`) {
      throw httpError(400, `Type ${JSON.stringify(`RETRY AI ${jobId}`)} exactly to retry the AI advisory.`);
    }
    const current = await readSingleSiteAiReview(singleSiteAiReview, jobId);
    if (!current || !['failed', 'unavailable'].includes(current.state)) {
      throw httpError(409, 'Only a failed or unavailable Single-site AI advisory can be retried.');
    }
    if (!Number.isSafeInteger(body.expectedStateRevision) || body.expectedStateRevision < 1) {
      throw httpError(400, 'AI advisory retry requires the current non-negative state revision.');
    }
    const result = await scheduleSingleSiteAiReview(jobId, {
      force: true,
      expectedStateRevision: body.expectedStateRevision,
      requestId: `manual-${current.stateRevision}-${randomBytes(8).toString('hex')}`,
    });
    if (!result) throw httpError(409, 'AI advisory retry requires a finalized deterministic Single-site report.');
    return sendJson(response, 202, result);
  }

  const singleSiteAiReviewResultMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/ai-review\/result$/);
  if (request.method === 'GET' && singleSiteAiReviewResultMatch) {
    const jobId = decodeURIComponent(singleSiteAiReviewResultMatch[1]);
    const input = await readSingleSiteJobInput(singleSiteQueue, jobId);
    if (input.advisory?.aiReview?.optedIn !== true) {
      throw httpError(404, 'This run did not opt in to an AI advisory result.');
    }
    try {
      return sendJson(
        response,
        200,
        publicSingleSiteAiReviewResult(await readSingleSiteAiReviewResult(singleSiteAiReview, jobId)),
      );
    } catch (error) {
      if (error?.code === 'AI_REVIEW_NOT_READY') throw httpError(409, error.message);
      throw error;
    }
  }

  if (request.method === 'DELETE' && singleSiteRunMatch) {
    assertMutationRequest(request);
    const jobId = decodeURIComponent(singleSiteRunMatch[1]);
    const body = assertVisualBaselineMutationBody(
      await readJsonBody(request),
      ['confirmation'],
      ['confirmation'],
    );
    const expectedConfirmation = singleSitePurgeConfirmation(jobId);
    if (body.confirmation !== expectedConfirmation) {
      await purgeSingleSiteRun({
        queue: singleSiteQueue,
        finalizationRoot: SINGLE_SITE_FINALIZATION_ROOT,
        aiReviewRoot: SINGLE_SITE_AI_REVIEW_ROOT,
        baselineStore: visualBaselineStore,
        jobId,
        confirmation: body.confirmation,
      });
    }
    const purgeKey = `single-site:${jobId}`;
    let purgeToken = consolePendingPurgeTokens.get(purgeKey);
    if (!purgeToken) {
      const authoritativeState = await readSingleSiteJob(singleSiteQueue, jobId).catch((error) => {
        if (error?.code === 'QUEUE_NOT_FOUND' || error?.code === 'ENOENT') return null;
        throw error;
      });
      purgeToken = consoleIndex.beginPurge({ mode: 'single-site', runId: jobId }, {
        sourceId: SINGLE_SITE_CONSOLE_SOURCE_ID,
        sourceRevision: authoritativeState ? `state-${authoritativeState.sequence ?? 0}` : null,
        updatedAt: consoleSourceUpdatedAt(authoritativeState?.updatedAt),
      });
    }
    forgetConsoleReportProjection({ mode: 'single-site', runId: jobId });
    let transferFenced = false;
    let aiReviewFenced = false;
    let purgeInvoked = false;
    try {
      await fenceAndDrainRunTransfers('single-site', jobId);
      transferFenced = true;
      await fenceSingleSiteAiReviewForPurge(singleSiteAiReview, jobId);
      aiReviewFenced = true;
      purgeInvoked = true;
      const result = await purgeSingleSiteRun({
        queue: singleSiteQueue,
        finalizationRoot: SINGLE_SITE_FINALIZATION_ROOT,
        aiReviewRoot: SINGLE_SITE_AI_REVIEW_ROOT,
        baselineStore: visualBaselineStore,
        jobId,
        confirmation: body.confirmation,
      });
      evictSingleSiteIdentityCaches(jobId);
      forgetSingleSiteConsoleJob(jobId);
      consoleIndex.commitPurge(purgeToken, {
        sourceRevision: nextConsoleSourceRevision('single-site'),
        updatedAt: new Date().toISOString(),
      });
      consolePendingPurgeTokens.delete(purgeKey);
      return sendJson(response, 200, {
        ...result,
        message: 'Run evidence was permanently purged. Independently copied visual baseline media and tombstoned baseline provenance were preserved.',
      });
    } catch (error) {
      const preQuarantineFailure = !purgeInvoked || [
        'SINGLE_SITE_PURGE_CONFIRMATION',
        'SINGLE_SITE_PURGE_INVALID',
        'SINGLE_SITE_PURGE_NOT_TERMINAL',
        'SINGLE_SITE_PURGE_FINALIZATION_PENDING',
        'SINGLE_SITE_PURGE_LIMIT',
        'SINGLE_SITE_PURGE_BASELINE_BUSY',
      ].includes(error?.code);
      if (preQuarantineFailure) {
        if (transferFenced) releaseRunTransferFence('single-site', jobId);
        if (aiReviewFenced) releaseSingleSiteAiReviewPurgeFence(singleSiteAiReview, jobId);
        try {
          const reread = await readSingleSiteJob(singleSiteQueue, jobId);
          const record = singleSiteConsoleIndexRecord(reread);
          consoleIndex.abortPurge(
            purgeToken,
            [record, ...singleSiteConsoleTimelineRecords(reread, record)],
            { sourceComplete: consoleIndex.backfillState(SINGLE_SITE_CONSOLE_SOURCE_ID)?.complete === true },
          );
          consolePendingPurgeTokens.delete(purgeKey);
        } catch (rereadError) {
          consolePendingPurgeTokens.set(purgeKey, purgeToken);
          console.error(`[PORTAL_CONSOLE_PURGE_REVERIFY_FAILED] Single-site ${jobId} remains unavailable: ${redactLogValue(rereadError.message)}`);
        }
      } else {
        consolePendingPurgeTokens.set(purgeKey, purgeToken);
        console.error(`[PORTAL_CONSOLE_PURGE_FENCED] Single-site ${jobId} remains unavailable after ${error?.code ?? 'an unknown failure'}.`);
      }
      throw error;
    }
  }

  const singleSiteCancelMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && singleSiteCancelMatch) {
    assertMutationRequest(request);
    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 512) {
      throw httpError(400, 'Cancellation requires a reason from 3 through 512 characters.');
    }
    const state = await cancelSingleSiteJob(
      singleSiteQueue,
      decodeURIComponent(singleSiteCancelMatch[1]),
      body.reason.trim(),
    );
    const input = await readSingleSiteJobInput(singleSiteQueue, state.jobId);
    const result = await publicSingleSiteJobWithFinalization(state, input);
    upsertSingleSiteConsoleState(state, { input });
    return sendJson(response, 202, result);
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === 'GET' && runMatch) {
    const id = decodeURIComponent(runMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireRun(id);
    return sendJson(response, 200, publicManifest(run.manifest));
  }
  if (request.method === 'DELETE' && runMatch) {
    assertMutationRequest(request);
    await syncExternalShardedRuns();
    const id = decodeURIComponent(runMatch[1]);
    const run = requireRun(id);
    return purgeRun(run, await readJsonBody(request), response);
  }

  const stopMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
  if (request.method === 'POST' && stopMatch) {
    assertMutationRequest(request);
    const run = requireRun(decodeURIComponent(stopMatch[1]));
    if (run.externalManaged) {
      throw httpError(409, 'This run was launched outside the portal and must be stopped from its original terminal.');
    }
    if (TERMINAL_STATUSES.has(run.manifest.status)) {
      throw httpError(409, 'This run is not active.');
    }
    run.manifest.stopRequestedAt = new Date().toISOString();
    run.manifest.phase = 'Stopping active run stage';
    appendEvent(run, 'status', { status: 'stopping', message: 'Stop requested.' });
    if (run.child) stopChild(run, 'Stopped from the audit portal');
    await persistManifest(run);
    return sendJson(response, 202, publicManifest(run.manifest));
  }

  const eventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (request.method === 'GET' && eventsMatch) {
    const id = decodeURIComponent(eventsMatch[1]);
    await syncExternalShardedRunForRead(id);
    return streamRunEvents(request, response, requireRun(id));
  }

  const galleryEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/gallery\/events$/);
  if (request.method === 'GET' && galleryEventsMatch) {
    const id = decodeURIComponent(galleryEventsMatch[1]);
    await syncExternalShardedRunForRead(id);
    return streamGalleryEvents(request, response, requireGalleryRun(id));
  }

  const logsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/logs$/);
  if (request.method === 'GET' && logsMatch) {
    const id = decodeURIComponent(logsMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireRun(id);
    const maximumBytes = queryInteger(
      requestUrl.searchParams.get('maxBytes'),
      'maxBytes',
      DEFAULT_LOG_SNAPSHOT_BYTES,
      MIN_LOG_SNAPSHOT_BYTES,
      MAX_LOG_SNAPSHOT_BYTES,
    );
    if (run.externalManaged) {
      const snapshot = await readExternalLogSnapshot(run, maximumBytes);
      return sendJson(response, 200, {
        ...snapshot,
        sequence: run.sequence,
      });
    }
    const logPath = join(run.directory, 'logs', 'runner.log');
    const tail = await readBoundedFileTail(logPath, maximumBytes);
    const redactedLog = redactLogValue(tail.content);
    const redactedBytes = Buffer.byteLength(redactedLog);
    return sendJson(response, 200, {
      log: redactedLog,
      sequence: run.sequence,
      bytes: redactedBytes,
      maxBytes: maximumBytes,
      truncated: tail.truncated,
      sources: tail.size === 0 ? [] : [{
        path: 'logs/runner.log',
        size: tail.size,
        returnedBytes: redactedBytes,
        truncated: tail.truncated,
      }],
    });
  }

  const singleSiteLogsMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/logs$/);
  if (request.method === 'GET' && singleSiteLogsMatch) {
    const jobId = decodeURIComponent(singleSiteLogsMatch[1]);
    const state = await readSingleSiteJob(singleSiteQueue, jobId);
    const maximumBytes = queryInteger(
      requestUrl.searchParams.get('maxBytes'),
      'maxBytes',
      DEFAULT_LOG_SNAPSHOT_BYTES,
      MIN_LOG_SNAPSHOT_BYTES,
      MAX_LOG_SNAPSHOT_BYTES,
    );
    const attemptId = state.attemptId ?? [...state.publications]
      .sort((left, right) => right.attemptNumber - left.attemptNumber)[0]?.attemptId ?? null;
    if (attemptId === null) {
      return sendJson(response, 200, {
        log: '',
        sequence: state.sequence,
        bytes: 0,
        maxBytes: maximumBytes,
        truncated: false,
        sources: [],
      });
    }
    const logPath = join(SINGLE_SITE_QUEUE_ROOT, 'jobs', state.jobId, 'attempts', attemptId, 'work', 'logs', 'worker.ndjson');
    const tail = await readBoundedFileTail(logPath, maximumBytes);
    const redactedLog = redactLogValue(tail.content);
    const redactedBytes = Buffer.byteLength(redactedLog);
    return sendJson(response, 200, {
      log: redactedLog,
      sequence: state.sequence,
      bytes: redactedBytes,
      maxBytes: maximumBytes,
      truncated: tail.truncated,
      sources: tail.size === 0 ? [] : [{
        path: `attempts/${attemptId}/work/logs/worker.ndjson`,
        size: tail.size,
        returnedBytes: redactedBytes,
        truncated: tail.truncated,
      }],
    });
  }

  const manualEvidenceMatch = pathname.match(/^\/api\/runs\/([^/]+)\/manual-evidence$/);
  if (request.method === 'GET' && manualEvidenceMatch) {
    const run = requireRun(decodeURIComponent(manualEvidenceMatch[1]));
    return sendJson(response, 200, await readManualEvidence(run));
  }
  if (request.method === 'POST' && manualEvidenceMatch) {
    assertMutationRequest(request);
    const run = requireRun(decodeURIComponent(manualEvidenceMatch[1]));
    const evidence = await withManualMutation(run, async () => recordManualEvidence(run, await readJsonBody(request)));
    return sendJson(response, 201, evidence);
  }

  const manualUploadMatch = pathname.match(/^\/api\/runs\/([^/]+)\/manual-uploads$/);
  if (request.method === 'POST' && manualUploadMatch) {
    requireOperatorAuthorization(request);
    const run = requireRun(decodeURIComponent(manualUploadMatch[1]));
    const upload = await withManualMutation(run, () => receiveManualUpload(run, request, requestUrl));
    return sendJson(response, upload.replayed === true ? 200 : 201, upload);
  }

  const artifactListMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts$/);
  if (request.method === 'GET' && artifactListMatch) {
    const run = requireRun(decodeURIComponent(artifactListMatch[1]));
    const offset = queryInteger(requestUrl.searchParams.get('offset'), 'offset', 0, 0, 1_000_000);
    const limit = queryInteger(requestUrl.searchParams.get('limit'), 'limit', DEFAULT_ARTIFACT_PAGE_SIZE, 1, MAX_ARTIFACT_PAGE_SIZE);
    return sendJson(response, 200, await listArtifacts(run.directory, run.manifest.id, offset, limit, request));
  }

  const singleSiteArtifactListMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/artifacts$/);
  if (request.method === 'GET' && singleSiteArtifactListMatch) {
    const jobId = decodeURIComponent(singleSiteArtifactListMatch[1]);
    const state = await readSingleSiteJob(singleSiteQueue, jobId);
    const attemptRoot = singleSiteAttemptArtifactDirectory(state);
    const offset = queryInteger(requestUrl.searchParams.get('offset'), 'offset', 0, 0, 1_000_000);
    const limit = queryInteger(requestUrl.searchParams.get('limit'), 'limit', DEFAULT_ARTIFACT_PAGE_SIZE, 1, MAX_ARTIFACT_PAGE_SIZE);
    return sendJson(response, 200, await listArtifacts(
      attemptRoot,
      state.jobId,
      offset,
      limit,
      request,
      '/single-site-artifacts',
    ));
  }

  const reportMatch = pathname.match(/^\/api\/runs\/([^/]+)\/report$/);
  if (request.method === 'GET' && reportMatch) {
    const id = decodeURIComponent(reportMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireRun(id);
    const value = await readBoundedReportJson(run, 'summary.json', MAX_REPORT_SUMMARY_BYTES);
    return sendJson(response, 200, value);
  }

  const singleSiteReportMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/report$/);
  if (request.method === 'GET' && singleSiteReportMatch) {
    const reportRun = await singleSiteReportRun(decodeURIComponent(singleSiteReportMatch[1]));
    const value = await readBoundedReportJson(
      reportRun,
      'summary.json',
      MAX_REPORT_SUMMARY_BYTES,
      singleSiteRequestedReportRevision(reportRun, requestUrl),
    );
    if (value.mode !== 'single-site') throw httpError(422, 'Single-site report publication has the wrong mode.');
    return sendJson(response, 200, value);
  }

  const singleSiteReportAuditsMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/report\/audits$/);
  if (request.method === 'GET' && singleSiteReportAuditsMatch) {
    const jobId = decodeURIComponent(singleSiteReportAuditsMatch[1]);
    const reportRun = await singleSiteReportRun(jobId);
    const input = await readSingleSiteJobInput(singleSiteQueue, jobId);
    return sendJson(response, 200, await filterSingleSiteReportAudits(reportRun, input, requestUrl));
  }

  const singleSiteGalleryMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/gallery$/);
  if (request.method === 'GET' && singleSiteGalleryMatch) {
    const jobId = decodeURIComponent(singleSiteGalleryMatch[1]);
    return withGalleryRequest(request, response, async (signal) => {
      const snapshot = await loadPortalSingleSiteGallery(jobId, request, signal);
      return sendJson(response, 200, singleSiteGalleryHead(snapshot));
    });
  }

  const singleSiteGalleryItemsMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/gallery\/items$/);
  if (request.method === 'GET' && singleSiteGalleryItemsMatch) {
    const jobId = decodeURIComponent(singleSiteGalleryItemsMatch[1]);
    return withGalleryRequest(request, response, async (signal) => {
      const snapshot = await loadPortalSingleSiteGallery(jobId, request, signal);
      return sendJson(response, 200, await pageSingleSiteGalleryItems(snapshot, {
        offset: queryInteger(requestUrl.searchParams.get('offset'), 'offset', 0, 0, 10_000),
        limit: queryInteger(requestUrl.searchParams.get('limit'), 'limit', 50, 1, 100),
        revision: requestUrl.searchParams.get('revision') ?? undefined,
        baselineStoreRevision: requestUrl.searchParams.has('baselineStoreRevision')
          ? queryInteger(requestUrl.searchParams.get('baselineStoreRevision'), 'baselineStoreRevision', 0, 0, Number.MAX_SAFE_INTEGER)
          : undefined,
        reviewRevision: requestUrl.searchParams.has('reviewRevision')
          ? queryInteger(requestUrl.searchParams.get('reviewRevision'), 'reviewRevision', 0, 0, Number.MAX_SAFE_INTEGER)
          : undefined,
        anchorItemId: galleryAnchor(requestUrl.searchParams.get('anchor')),
        scope: requestUrl.searchParams.get('scope') ?? undefined,
        kind: requestUrl.searchParams.get('kind') ?? undefined,
        suite: requestUrl.searchParams.get('suite') ?? undefined,
        finding: requestUrl.searchParams.get('finding') ?? undefined,
        coverage: requestUrl.searchParams.get('coverage') ?? undefined,
        visual: requestUrl.searchParams.get('visual') ?? undefined,
        query: requestUrl.searchParams.get('q') ?? undefined,
        signal,
      }));
    });
  }

  const singleSiteGalleryItemMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/gallery\/items\/([^/]+)$/);
  if (request.method === 'GET' && singleSiteGalleryItemMatch) {
    const jobId = decodeURIComponent(singleSiteGalleryItemMatch[1]);
    const itemId = decodeURIComponent(singleSiteGalleryItemMatch[2]);
    return withGalleryRequest(request, response, async (signal) => {
      const snapshot = await loadPortalSingleSiteGallery(jobId, request, signal);
      return sendJson(response, 200, await readSingleSiteGalleryItem(snapshot, itemId, {
        revision: requestUrl.searchParams.get('revision') ?? undefined,
        baselineStoreRevision: requestUrl.searchParams.has('baselineStoreRevision')
          ? queryInteger(requestUrl.searchParams.get('baselineStoreRevision'), 'baselineStoreRevision', 0, 0, Number.MAX_SAFE_INTEGER)
          : undefined,
        reviewRevision: requestUrl.searchParams.has('reviewRevision')
          ? queryInteger(requestUrl.searchParams.get('reviewRevision'), 'reviewRevision', 0, 0, Number.MAX_SAFE_INTEGER)
          : undefined,
        signal,
      }));
    });
  }

  const singleSiteGalleryReviewMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/gallery\/items\/([^/]+)\/review$/);
  if (request.method === 'POST' && singleSiteGalleryReviewMatch) {
    assertMutationRequest(request);
    const jobId = decodeURIComponent(singleSiteGalleryReviewMatch[1]);
    const itemId = decodeURIComponent(singleSiteGalleryReviewMatch[2]);
    const snapshot = await loadPortalSingleSiteGallery(jobId, request);
    const result = await reviewSingleSiteGalleryItem(snapshot, itemId, await readJsonBody(request));
    await refreshSingleSiteConsoleRunBestEffort(jobId, 'visual review');
    console.log(`Single-site visual review ${jobId}/${itemId}: ${result.disposition} at revision ${result.reviewRevision}.`);
    return sendJson(response, result.idempotent ? 200 : 201, result);
  }

  const singleSiteGalleryMediaMatch = pathname.match(/^\/api\/single-site\/runs\/([^/]+)\/gallery\/items\/([^/]+)\/media\/(current|diff)$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && singleSiteGalleryMediaMatch) {
    const jobId = decodeURIComponent(singleSiteGalleryMediaMatch[1]);
    const itemId = decodeURIComponent(singleSiteGalleryMediaMatch[2]);
    const view = singleSiteGalleryMediaMatch[3];
    return withRunScopedTransfer('single-site', jobId, response, () =>
      withGalleryRequest(request, response, async (signal) => {
        const snapshot = await loadPortalSingleSiteGallery(jobId, request, signal);
        const media = await resolveSingleSiteGalleryMedia(snapshot, itemId, view, { signal });
        return sendFile(request, response, media.absolutePath, "default-src 'none'; frame-ancestors 'self'", {
          opened: media.opened,
          contentType: media.contentType,
          etag: media.etag,
        });
      }),
    );
  }

  const reportAuditsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/report\/audits$/);
  if (request.method === 'GET' && reportAuditsMatch) {
    const id = decodeURIComponent(reportAuditsMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireRun(id);
    return sendJson(response, 200, await filterReportAudits(run, requestUrl));
  }

  const reportAuditMatch = pathname.match(/^\/api\/runs\/([^/]+)\/report\/audits\/([^/]+)$/);
  if (request.method === 'GET' && reportAuditMatch) {
    const id = decodeURIComponent(reportAuditMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireRun(id);
    const auditId = decodeURIComponent(reportAuditMatch[2]);
    if (!/^[A-Z0-9-]{3,160}$/.test(auditId)) throw httpError(404, 'Audit detail not found.');
    const value = await readBoundedReportJson(
      run,
      join('audits', `${auditId}.json`),
      MAX_REPORT_AUDIT_DETAIL_BYTES,
      reportRevision(requestUrl),
    );
    return sendJson(response, 200, value);
  }

  const galleryMatch = pathname.match(/^\/api\/runs\/([^/]+)\/gallery$/);
  if (request.method === 'GET' && galleryMatch) {
    const id = decodeURIComponent(galleryMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireGalleryRun(id);
    return withGalleryRequest(request, response, async (signal) => {
      return sendJson(response, 200, {
        ...await loadGalleryHead(run, signal),
        flagCapability: galleryFlagCapability(request),
      });
    });
  }

  const galleryFlagsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/gallery\/flags$/);
  if (request.method === 'GET' && galleryFlagsMatch) {
    const id = decodeURIComponent(galleryFlagsMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireGalleryRun(id);
    return withGalleryRequest(request, response, async (signal) => {
      const snapshot = await readGalleryFlags(run, signal);
      const itemId = requestUrl.searchParams.get('itemId');
      if (itemId !== null && !/^gitem_[a-f0-9]{16}$/.test(itemId)) throw httpError(400, 'Gallery item ID is invalid.');
      const legacyOffset = requestUrl.searchParams.get('offset');
      const projectionOffset = queryInteger(requestUrl.searchParams.get('projectionOffset') ?? legacyOffset, 'projectionOffset', 0, 0, 10_000);
      const eventOffset = queryInteger(requestUrl.searchParams.get('eventOffset') ?? legacyOffset, 'eventOffset', 0, 0, 10_000);
      const limit = queryInteger(requestUrl.searchParams.get('limit'), 'limit', 50, 1, 50);
      const flags = snapshot.flags.filter((flag) => !itemId || flag.itemId === itemId);
      const events = snapshot.events.filter((event) => !itemId || event.itemId === itemId);
      return sendJson(response, 200, {
        schemaVersion: 1,
        throughEvent: snapshot.throughEvent,
        flagRevision: snapshot.flagRevision,
        flags: flags.slice(projectionOffset, projectionOffset + limit),
        flagTotal: flags.length,
        events: events.slice(eventOffset, eventOffset + limit),
        eventTotal: events.length,
        projectionOffset,
        eventOffset,
        limit,
        hasMoreFlags: projectionOffset + limit < flags.length,
        hasMoreEvents: eventOffset + limit < events.length,
        capability: galleryFlagCapability(request),
      });
    });
  }
  if (request.method === 'POST' && galleryFlagsMatch) {
    assertMutationRequest(request);
    await syncExternalShardedRuns();
    const run = requireGalleryRun(decodeURIComponent(galleryFlagsMatch[1]));
    assertGalleryFlagMutationAllowed(request);
    const body = await readJsonBody(request);
    consumeGalleryFlagRate(request, run.manifest.id);
    const result = await withGalleryMutationLock(run, async () => {
      const snapshot = await loadGallerySnapshot(run, undefined, { includeRows: false });
      const detail = await readGalleryItem(snapshot, run.manifest.id, body?.itemId);
      return mutateRunGalleryFlag(run, {
        action: 'open',
        itemId: detail.item.id,
        identity: galleryFlagIdentity(detail.item),
        reviewer: body?.reviewer,
        note: body?.note,
        idempotencyKey: body?.idempotencyKey,
        expectedFlagRevision: body?.expectedFlagRevision,
        timestamp: new Date().toISOString(),
        eventId: `gfevent_${randomBytes(16).toString('hex')}`,
        flagId: `gflag_${randomBytes(16).toString('hex')}`,
      });
    });
    logGalleryFlagMutation(run, result, 201);
    return sendJson(response, result.idempotent ? 200 : 201, result);
  }

  const galleryFlagTransitionMatch = pathname.match(/^\/api\/runs\/([^/]+)\/gallery\/flags\/([^/]+)\/transitions$/);
  if (request.method === 'POST' && galleryFlagTransitionMatch) {
    assertMutationRequest(request);
    await syncExternalShardedRuns();
    const run = requireGalleryRun(decodeURIComponent(galleryFlagTransitionMatch[1]));
    assertGalleryFlagMutationAllowed(request);
    const flagId = decodeURIComponent(galleryFlagTransitionMatch[2]);
    if (!/^gflag_[a-f0-9]{16,64}$/.test(flagId)) throw httpError(404, 'Reviewer flag was not found.');
    const body = await readJsonBody(request);
    consumeGalleryFlagRate(request, run.manifest.id);
    const result = await withGalleryMutationLock(run, () => mutateRunGalleryFlag(run, {
      action: body?.action,
      flagId,
      reviewer: body?.reviewer,
      note: body?.note,
      justification: body?.justification,
      idempotencyKey: body?.idempotencyKey,
      expectedFlagRevision: body?.expectedFlagRevision,
      timestamp: new Date().toISOString(),
      eventId: `gfevent_${randomBytes(16).toString('hex')}`,
    }));
    logGalleryFlagMutation(run, result, 200);
    return sendJson(response, 200, result);
  }

  const galleryItemsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/gallery\/items$/);
  if (request.method === 'GET' && galleryItemsMatch) {
    const id = decodeURIComponent(galleryItemsMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireGalleryRun(id);
    return withGalleryRequest(request, response, async (signal) => {
      const snapshot = await gallerySnapshotForRequest(run, requestUrl, signal);
      rememberGallerySnapshot(run, snapshot);
      let value;
      try {
        value = await pageGallerySnapshot(snapshot, galleryQueryFromUrl(requestUrl), {
          cursor: requestUrl.searchParams.get('cursor'),
          anchorItemId: galleryAnchor(requestUrl.searchParams.get('anchor')),
          limit: queryInteger(requestUrl.searchParams.get('limit'), 'limit', 50, 1, 100),
        }, signal);
      } catch (error) {
        if (error instanceof GalleryHttpError && error.code === 'GALLERY_CURSOR_STALE' && error.recovery) {
          error.recovery.href = `/api/runs/${encodeURIComponent(run.manifest.id)}/gallery`;
        }
        throw error;
      }
      if (value.nextCursor) {
        const next = new URL(requestUrl);
        next.searchParams.set('cursor', value.nextCursor);
        next.searchParams.delete('anchor');
        value.next = `${next.pathname}${next.search}`;
      }
      return sendJson(response, 200, value);
    });
  }

  const galleryAvailabilityMatch = pathname.match(/^\/api\/runs\/([^/]+)\/gallery\/items\/([^/]+)\/availability$/);
  if (request.method === 'GET' && galleryAvailabilityMatch) {
    const id = decodeURIComponent(galleryAvailabilityMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireGalleryRun(id);
    const itemId = decodeURIComponent(galleryAvailabilityMatch[2]);
    return withGalleryRequest(request, response, async (signal) => {
      const snapshot = await gallerySnapshotForRequest(run, requestUrl, signal, { includeRows: false });
      return sendJson(response, 200, await readGalleryAvailability(snapshot, run.manifest.id, itemId, signal));
    });
  }

  const galleryItemMatch = pathname.match(/^\/api\/runs\/([^/]+)\/gallery\/items\/([^/]+)$/);
  if (request.method === 'GET' && galleryItemMatch) {
    const id = decodeURIComponent(galleryItemMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireGalleryRun(id);
    const itemId = decodeURIComponent(galleryItemMatch[2]);
    return withGalleryRequest(request, response, async (signal) => {
      const snapshot = await gallerySnapshotForRequest(run, requestUrl, signal, { includeRows: false });
      return sendJson(response, 200, await readGalleryItem(snapshot, run.manifest.id, itemId, signal));
    });
  }

  const galleryDeltaMatch = pathname.match(/^\/api\/runs\/([^/]+)\/gallery\/delta$/);
  if (request.method === 'GET' && galleryDeltaMatch) {
    const id = decodeURIComponent(galleryDeltaMatch[1]);
    await syncExternalShardedRunForRead(id);
    const run = requireGalleryRun(id);
    return withGalleryRequest(request, response, async (signal) => {
      const from = galleryDeltaRevisions(requestUrl);
      const snapshot = await loadGallerySnapshot(run, signal);
      const current = rememberGallerySnapshot(run, snapshot);
      return sendJson(response, 200, galleryDeltaPage(run, from, current, requestUrl));
    });
  }

  const artifactMatch = pathname.match(/^\/artifacts\/([^/]+)(?:\/(.*))?$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && artifactMatch) {
    const runId = decodeURIComponent(artifactMatch[1]);
    return withRunScopedTransfer('comparative', runId, response, () => serveArtifact(
      request,
      response,
      runId,
      artifactMatch[2] ? decodeURIComponent(artifactMatch[2]) : '',
    ));
  }


  const singleSiteArtifactMatch = pathname.match(/^\/single-site-artifacts\/([^/]+)(?:\/(.*))?$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && singleSiteArtifactMatch) {
    const jobId = decodeURIComponent(singleSiteArtifactMatch[1]);
    return withRunScopedTransfer('single-site', jobId, response, async () => {
      const state = await readSingleSiteJob(singleSiteQueue, jobId);
      return serveArtifactFromDirectory(
        request,
        response,
        singleSiteAttemptArtifactDirectory(state),
        singleSiteArtifactMatch[2] ? decodeURIComponent(singleSiteArtifactMatch[2]) : '',
      );
    });
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    return servePortalAsset(request, response, pathname);
  }
  throw httpError(404, 'Not found.');
}

async function authorizeSharedLegacyRead(request, pathname) {
  if (!sharedRequestAuthorizer) return null;
  const policy = classifySharedReadRequest({ method: request.method, pathname });
  if (!policy) return null;
  const authentication = await sharedRequestAuthorizer.authorize(request, policy.action, {
    projectId: sharedProjectId,
    runId: policy.runId,
  });
  if (policy.aggregate) assertSharedListScope(authentication.principal);
  request.auditSharedReadGuard = () => sharedRequestAuthorizer.authorize(request, policy.action, {
    projectId: sharedProjectId,
    runId: policy.runId,
  }, { renew: false });
  return authentication;
}

async function withGalleryRequest(request, response, operation) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new DOMException('Gallery request disconnected.', 'AbortError'));
  };
  request.once('aborted', abort);
  response.once('close', () => {
    if (!response.writableEnded) abort();
  });
  try {
    return await operation(controller.signal);
  } finally {
    request.removeListener('aborted', abort);
  }
}

async function withConsoleRequest(request, response, operation) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('Console request disconnected.', 'AbortError'));
    }
  };
  const close = () => {
    if (!response.writableEnded) abort();
  };
  request.once('aborted', abort);
  response.once('close', close);
  try {
    return await operation(controller.signal);
  } finally {
    request.removeListener('aborted', abort);
    response.removeListener('close', close);
  }
}

function galleryAnchor(value) {
  if (value === null || value === '') return null;
  if (!/^gitem_[a-f0-9]{16}$/.test(value)) throw httpError(400, 'Gallery anchor is invalid.');
  return value;
}

function galleryDeltaRevisions(requestUrl) {
  const from = {
    contentRevision: requestUrl.searchParams.get('fromContentRevision'),
    orderRevision: requestUrl.searchParams.get('fromOrderRevision'),
    flagRevision: requestUrl.searchParams.get('fromFlagRevision'),
  };
  if (
    !/^content_[a-f0-9]{16}$/.test(from.contentRevision ?? '')
    || !/^order_[a-f0-9]{16}$/.test(from.orderRevision ?? '')
    || !/^flags_[a-f0-9]{16}$/.test(from.flagRevision ?? '')
  ) throw httpError(400, 'A complete content/order/flag from-revision triple is required.');
  return from;
}

function galleryFlagCapability(request) {
  const configuredLoopback = ['127.0.0.1', '::1', 'localhost'].includes(HOST)
    || process.env.PORTAL_LOOPBACK_PUBLISHED === '1';
  let requestHost = '';
  try {
    requestHost = new URL(`http://${String(request.headers.host ?? '')}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    // An invalid Host header cannot qualify for the loopback trust boundary.
  }
  const loopbackRequest = requestHost === '127.0.0.1' || requestHost === 'localhost' || requestHost === '::1';
  const mutable = configuredLoopback && loopbackRequest;
  return {
    mutable,
    identity: mutable ? 'local-attribution' : 'read-only',
    authenticated: false,
    trustBoundary: mutable
      ? 'Loopback-only single-operator attribution; reviewer labels are not authenticated identities.'
      : 'Shared access is read-only until authenticated server-side reviewer identity is configured.',
  };
}

function assertGalleryFlagMutationAllowed(request) {
  if (!galleryFlagCapability(request).mutable) {
    const error = httpError(403, 'Reviewer flag mutations are disabled outside the loopback-only portal.');
    error.code = 'GALLERY_FLAG_READ_ONLY';
    throw error;
  }
}

function consumeGalleryFlagRate(request, runId) {
  const now = Date.now();
  const client = request.socket.remoteAddress ?? 'unknown-client';
  const key = `${client}\u0000${runId}`;
  const recent = (galleryFlagRateWindows.get(key) ?? []).filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= 30) {
    const error = httpError(429, 'Reviewer flag mutation rate limit exceeded. Try again in one minute.');
    error.code = 'GALLERY_FLAG_RATE_LIMIT';
    throw error;
  }
  recent.push(now);
  galleryFlagRateWindows.set(key, recent);
  if (galleryFlagRateWindows.size > 1_024) {
    for (const [candidate, timestamps] of galleryFlagRateWindows) {
      if (timestamps.every((timestamp) => now - timestamp >= 60_000)) galleryFlagRateWindows.delete(candidate);
      if (galleryFlagRateWindows.size <= 1_024) break;
    }
  }
}

function galleryFlagIdentity(item) {
  return {
    testId: item.test.id,
    title: item.test.title,
    project: item.project.name,
    attempt: item.attempt.ordinal,
    auditIds: item.auditAssociations.map(({ id }) => id).sort(),
  };
}

function logGalleryFlagMutation(run, result, requestedStatus) {
  const status = result.idempotent ? 200 : requestedStatus;
  const record = {
    eventId: result.event.eventId,
    transition: result.event.action,
    flagState: result.event.action === 'opened' || result.event.action === 'reopened'
      ? 'open'
      : result.event.action,
    flagRevision: result.flagRevision,
    responseCode: status,
    historyBytes: result.historyBytes,
  };
  console.log(`[GALLERY_FLAG] ${JSON.stringify(record)}`);
  appendEvent(run, 'gallery-flag', record);
}

async function mutateRunGalleryFlag(run, transition) {
  const checklistRoot = join(run.directory, 'checklist');
  const galleryRoot = join(checklistRoot, 'gallery');
  const result = await withRunArtifactWriteWindow(
    run,
    () => mutateGalleryFlag(run.directory, transition),
    {
      writablePaths: [checklistRoot, galleryRoot, join(galleryRoot, 'revisions')],
      sealPaths: [
        galleryRoot,
        join(checklistRoot, 'gallery.html'),
        join(run.directory, 'visual-flags.json'),
      ],
    },
  );
  upsertComparativeConsoleRun(run);
  return result;
}

function galleryRevisionKey(head) {
  return `${head.contentRevision}\u0000${head.orderRevision}\u0000${head.flagRevision}`;
}

function requestedGalleryRevisions(requestUrl) {
  const values = {
    contentRevision: requestUrl.searchParams.get('contentRevision'),
    orderRevision: requestUrl.searchParams.get('orderRevision'),
    flagRevision: requestUrl.searchParams.get('flagRevision'),
  };
  if (Object.values(values).every((value) => value === null)) return null;
  if (
    !/^content_[a-f0-9]{16}$/.test(values.contentRevision ?? '')
    || !/^order_[a-f0-9]{16}$/.test(values.orderRevision ?? '')
    || !/^flags_[a-f0-9]{16}$/.test(values.flagRevision ?? '')
  ) throw httpError(400, 'Gallery revision parameters are invalid or incomplete.');
  return values;
}

async function gallerySnapshotForRequest(run, requestUrl, signal, options = {}) {
  const expected = requestedGalleryRevisions(requestUrl);
  if (expected) {
    const retained = galleryRevisionCache.get(run.manifest.id)?.get(galleryRevisionKey(expected))?.snapshot;
    if (retained) return retained;
  }
  const snapshot = await loadGallerySnapshot(run, signal, options);
  if (options.includeRows !== false) rememberGallerySnapshot(run, snapshot);
  if (!expected || galleryRevisionKey(snapshot.head) === galleryRevisionKey(expected)) return snapshot;
  throw new GalleryHttpError(409, 'The requested gallery snapshot is no longer retained. Apply the current revision and restore the selected item by ID.', {
    code: 'GALLERY_REVISION_STALE',
    head: snapshot.head,
    recovery: {
      href: `/api/runs/${encodeURIComponent(run.manifest.id)}/gallery`,
      anchorItemId: galleryAnchor(requestUrl.searchParams.get('anchor')),
    },
  });
}

function rememberGallerySnapshot(run, snapshot) {
  let revisions = galleryRevisionCache.get(run.manifest.id);
  if (!revisions) {
    revisions = new Map();
  }
  const revision = galleryRevisionKey(snapshot.head);
  const fingerprints = gallerySnapshotFingerprints(snapshot);
  const value = {
    fingerprints,
    snapshot,
  };
  revisions.delete(revision);
  if (galleryRevisionEntryBytes(value) <= GALLERY_RETENTION_LIMITS.maximumEntryBytes) revisions.set(revision, value);
  galleryRevisionCache.delete(run.manifest.id);
  if (revisions.size > 0) galleryRevisionCache.set(run.manifest.id, revisions);
  pruneGalleryRevisionCache(galleryRevisionCache);
  return value;
}

function galleryDeltaPage(run, from, current, requestUrl) {
  const revisions = galleryRevisionCache.get(run.manifest.id);
  const prior = revisions?.get(galleryRevisionKey(from));
  if (!prior) {
    throw new GalleryHttpError(409, 'The requested gallery revision is no longer retained. Resnapshot and restore the selected item by ID.', {
      code: 'GALLERY_DELTA_STALE',
      head: current.snapshot.head,
      recovery: {
        href: `/api/runs/${encodeURIComponent(run.manifest.id)}/gallery`,
        anchorItemId: galleryAnchor(requestUrl.searchParams.get('anchor')),
      },
    });
  }
  const changes = [];
  for (const [id, fingerprint] of current.fingerprints) {
    const previous = prior.fingerprints.get(id);
    if (previous === undefined) changes.push({ type: 'added', id });
    else if (previous !== fingerprint) changes.push({ type: 'changed', id });
  }
  for (const id of prior.fingerprints.keys()) {
    if (!current.fingerprints.has(id)) changes.push({ type: 'tombstone', id });
  }
  changes.sort((left, right) => left.id.localeCompare(right.id) || left.type.localeCompare(right.type));
  const offset = queryInteger(requestUrl.searchParams.get('offset'), 'offset', 0, 0, 1_000_000);
  const limit = queryInteger(requestUrl.searchParams.get('limit'), 'limit', 100, 1, 100);
  const page = changes.slice(offset, offset + limit);
  const ids = (type) => page.filter((entry) => entry.type === type).map(({ id }) => id);
  return {
    schemaVersion: 1,
    fromContentRevision: from.contentRevision,
    fromFlagRevision: from.flagRevision,
    fromOrderRevision: from.orderRevision,
    contentRevision: current.snapshot.head.contentRevision,
    flagRevision: current.snapshot.head.flagRevision,
    orderRevision: current.snapshot.head.orderRevision,
    addedIds: ids('added'),
    changedIds: ids('changed'),
    tombstones: ids('tombstone'),
    total: changes.length,
    offset,
    limit,
    hasMore: offset + page.length < changes.length,
    nextOffset: offset + page.length,
  };
}

async function refreshAllGalleryPublications(emit) {
  for (const run of runs.values()) {
    if (purgingRunIds.has(run.manifest.id)) continue;
    try {
      const beforeStamp = await sealedGalleryHeadStamp(run);
      if (beforeStamp && observedGalleryPublications.has(run.manifest.id)
        && observedSealedGalleryHeads.get(run.manifest.id) === beforeStamp) {
        // Sealed gallery reads authenticate a large integrity manifest. Once a
        // terminal pointer has been validated, an unchanged inode/stat stamp
        // cannot publish a new revision and does not need to consume the
        // interactive event loop on every one-second discovery tick. Request
        // paths still validate integrity independently and fail closed.
        continue;
      }
      const publication = await probeGalleryPublication(run);
      if (!publication) continue;
      const prior = observedGalleryPublications.get(run.manifest.id);
      const token = `${publication.phase}:${publication.contentRevision}:${publication.flagRevision}:${publication.orderRevision}`;
      observedGalleryPublications.set(run.manifest.id, token);
      const afterStamp = publication.phase === 'sealed' ? await sealedGalleryHeadStamp(run) : null;
      if (beforeStamp && beforeStamp === afterStamp) observedSealedGalleryHeads.set(run.manifest.id, afterStamp);
      else observedSealedGalleryHeads.delete(run.manifest.id);
      if (emit && prior !== token) {
        appendEvent(run, 'gallery', {
          schemaVersion: 1,
          phase: publication.phase,
          contentRevision: publication.contentRevision,
          flagRevision: publication.flagRevision,
          orderRevision: publication.orderRevision,
          primaryCounts: publication.primaryCounts,
          message: publication.phase === 'sealed'
            ? 'Validated gallery evidence is sealed and ready.'
            : 'New finalized gallery evidence is available. Your current selection will remain in place.',
        });
      }
    } catch (error) {
      observedSealedGalleryHeads.delete(run.manifest.id);
      if (error?.statusCode !== 404) {
        console.error(`Could not inspect gallery publication for ${run.manifest.id}: ${error.message}`);
      }
    }
  }
}

async function sealedGalleryHeadStamp(run) {
  const sealedReviewable = run.manifest?.stages?.reportRebuild?.status === 'completed'
    || run.manifest?.pipeline?.completed === true
    || Boolean(run.manifest?.finishedAt);
  if (!sealedReviewable) return null;
  const stat = await safeStat(join(run.directory, 'checklist', 'gallery', 'current.json'));
  if (!stat?.isFile()) return null;
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

async function createRun(request, response) {
  const options = validateRunRequest(await readJsonBody(request));
  const reservation = reserveLaunchSlot();
  const initializationFailpoint = process.env.PORTAL_E2E_FAILURE_INJECTION === '1'
    ? String(request.headers['x-portal-e2e-launch-failure'] ?? '')
    : '';

  const aiApiKey = options.aiReview ? currentAnthropicApiKey() : null;
  if (aiApiKey) sensitiveLogValues.add(aiApiKey);
  const id = makeRunId();
  const directory = join(ARTIFACT_ROOT, id);
  const logDirectory = join(directory, 'logs');
  let artifactPermissionMode;
  try {
    await fs.mkdir(logDirectory, { recursive: true });
    artifactPermissionMode = await prepareRunDirectoryForRunner(directory);
  } catch (error) {
    launchReservations.delete(reservation);
    throw error;
  }

  const args = ['test'];
  if (options.entrySpecs.length > 0) args.push(...options.entrySpecs);
  else if (options.profile === 'smoke') args.push('tests/smoke.spec.ts', 'tests/contracts.spec.ts');
  for (const project of options.projects) args.push(`--project=${project}`);
  if (options.auditIds.length > 0) {
    const pattern = `\\[(?:${options.auditIds.map(escapeRegex).join('|')})\\]`;
    args.push(`--grep=${pattern}`);
  }

  const executable = resolvePlaywrightExecutable();
  const now = new Date().toISOString();
  const playwrightCommand = ['playwright', ...args];
  const manifest = {
    schemaVersion: 1,
    id,
    status: 'starting',
    phase: 'Preparing test runner',
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    stopRequestedAt: null,
    exitCode: null,
    signal: null,
    options,
    command: playwrightCommand,
    artifactPath: relative(REPOSITORY_ROOT, directory),
    progress: { total: null, completed: 0, passed: null, failed: null, flaky: null, skipped: null },
    reviewReasons: [],
    executionProvenance: {
      ...portalExecutionProvenance(),
      artifactPermissionMode,
    },
    pipeline: {
      status: 'running',
      completed: false,
      reason: 'The browser and evidence pipeline is running.',
      finishedAt: null,
    },
    release: pendingRelease(),
    stages: {
      playwright: stageRecord('pending', playwrightCommand),
      videoProcessing: stageRecord('pending', ['tsx', 'scripts/process-videos.ts', directory]),
      aiReview: {
        ...stageRecord(options.aiReview ? 'pending' : 'skipped', ['tsx', 'scripts/analyze-run.ts', '--run-dir', directory]),
        enabled: options.aiReview,
        model: options.aiModel,
        summary: null,
      },
      reportRebuild: stageRecord('pending', [
        'tsx',
        'scripts/rebuild-report.ts',
        join(directory, 'results.json'),
        join(directory, 'checklist'),
      ]),
    },
  };
  const runBase = {
    directory,
    manifest,
    child: null,
    clients: new Set(),
    events: [],
    sequence: 0,
    lineBuffer: { stdout: '', stderr: '' },
    omittedLineCharacters: { stdout: 0, stderr: 0 },
    outputStreams: new Set(),
    killTimer: null,
    childDeadlineTimer: null,
    childTimeoutError: null,
    infrastructureFailure: null,
    aiApiKey,
    artifactPermissionsSealed: false,
  };
  let logStream = null;
  let lifecycleStream = null;
  try {
    const runnerLogPath = initializationFailpoint === 'stream'
      ? join(logDirectory, 'missing-parent', 'runner.log')
      : join(logDirectory, 'runner.log');
    logStream = await openAppendStream(runnerLogPath, `${id} runner log`);
    lifecycleStream = await openAppendStream(join(logDirectory, 'lifecycle.jsonl'), `${id} lifecycle log`);
  } catch (error) {
    await closeWritableStream(logStream);
    await closeWritableStream(lifecycleStream);
    const failedRun = { ...runBase, logStream: null, lifecycleStream: null };
    runs.set(id, failedRun);
    await rollbackRunInitialization(failedRun, null, error);
    launchReservations.delete(reservation);
    throw httpError(500, 'Audit run initialization failed before log storage could open. The capacity reservation was released and the failure was recorded when storage remained available.');
  }
  const run = { ...runBase, logStream, lifecycleStream };
  attachRunStreamFailureGuards(run);
  runs.set(id, run);
  let child = null;
  let earlySpawnError = null;
  let earlyClose = null;
  const captureEarlyError = (error) => { earlySpawnError = error; };
  const captureEarlyClose = (exitCode, signal) => { earlyClose = { exitCode, signal }; };
  try {
    if (initializationFailpoint === 'persist') throw new Error('Injected pre-start persistence failure.');
    await persistManifest(run);
    appendEvent(run, 'status', { status: 'starting', message: 'Preparing Playwright.' });

    if (run.manifest.stopRequestedAt) {
      const stage = run.manifest.stages.playwright;
      stage.status = 'skipped';
      stage.finishedAt = new Date().toISOString();
      stage.durationMs = 0;
      stage.error = 'Skipped because a reviewer stopped the run before Playwright launched.';
      await finishStoppedRun(run);
      return sendJson(response, 202, publicManifest(run.manifest));
    }

    if (initializationFailpoint === 'spawn') throw new Error('Injected synchronous spawn setup failure.');
    child = spawn(executable, args, {
      cwd: REPOSITORY_ROOT,
      detached: process.platform !== 'win32',
      ...runnerSpawnIdentity(RUNNER_IDENTITY),
      env: {
        ...sanitizedChildEnvironment(process.env, RUNNER_IDENTITY),
        AUDIT_PROFILE: options.profile,
        AUDIT_TARGET_IDS: options.projects.join(','),
        AUDIT_ARTIFACT_DIR: directory,
        AUDIT_OUTPUT_DIR: join(directory, 'checklist'),
        AUDIT_RUN_ID: id,
        AUDIT_IDS: options.auditIds.join(','),
        AUDIT_AREAS: options.areas.join(','),
        PRODUCTION_URL: options.productionUrl,
        CANDIDATE_URL: options.candidateUrl,
        PLAYWRIGHT_HTML_OPEN: 'never',
        AUDIT_VERBOSE: '1',
        CANDIDATE_IGNORE_HTTPS_ERRORS: options.candidateIgnoreHTTPSErrors ? '1' : '0',
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', captureEarlyError);
    child.once('close', captureEarlyClose);
    run.child = child;
    run.manifest.status = 'running';
    run.manifest.phase = 'Starting browser projects';
    run.manifest.startedAt = new Date().toISOString();
    run.manifest.stages.playwright.status = 'running';
    run.manifest.stages.playwright.startedAt = run.manifest.startedAt;
    run.manifest.stages.playwright.timeoutMs = PLAYWRIGHT_DEADLINE_MS;
    armRunChildDeadline(run, 'playwright', PLAYWRIGHT_DEADLINE_MS);
    await persistManifest(run);
    if (earlySpawnError) throw earlySpawnError;
    if (earlyClose) throw new Error(`Playwright exited during launch initialization (exit ${earlyClose.exitCode ?? 'null'}, signal ${earlyClose.signal ?? 'none'}).`);
  } catch (error) {
    if (child) {
      child.removeListener('error', captureEarlyError);
      child.removeListener('close', captureEarlyClose);
    }
    await rollbackRunInitialization(run, child, error);
    throw httpError(500, 'Audit run initialization failed before Playwright could start. The failed initialization was released and recorded when storage remained available.');
  } finally {
    launchReservations.delete(reservation);
  }
  child.removeListener('error', captureEarlyError);
  child.removeListener('close', captureEarlyClose);
  appendEvent(run, 'status', { status: 'running', message: 'Audit is running.' });
  appendEvent(run, 'stage', {
    name: 'playwright',
    status: 'running',
    label: 'Starting browser projects',
    stage: structuredClone(run.manifest.stages.playwright),
  });
  appendLog(run, 'stdout', `Command started: ${playwrightCommand.join(' ')}`, 'playwright');
  appendLog(
    run,
    'stdout',
    artifactPermissionMode === 'portable-bind'
      ? 'Artifact permissions: portable bind-mount mode; worker identities remain isolated from the credential vault and completed artifacts are sealed before reporting.'
      : 'Artifact permissions: owner/group isolation mode.',
    'playwright',
  );
  appendLog(run, 'stdout', `TLS policy: candidate certificate errors ${options.candidateIgnoreHTTPSErrors ? 'ignored for development' : 'enforced'}; production certificate errors enforced.`, 'playwright');

  consumeOutput(run, child.stdout, 'stdout', 'playwright');
  consumeOutput(run, child.stderr, 'stderr', 'playwright');

  child.once('error', (error) => {
    void runLifecycleCallback(run, 'Playwright spawn failure', async () => {
      clearRunChildDeadline(run);
      appendLog(run, 'stderr', `Unable to start Playwright: ${error.message}`, 'playwright');
      run.manifest.status = 'spawn-failed';
      run.manifest.phase = 'Could not start Playwright';
      run.manifest.finishedAt = new Date().toISOString();
      run.manifest.error = error.message;
      run.manifest.pipeline = {
        status: 'failed',
        completed: false,
        reason: `Playwright could not start: ${error.message}`,
        finishedAt: run.manifest.finishedAt,
      };
      run.manifest.release = unavailableRelease('No authoritative release decision exists because Playwright could not start.');
      completeStage(run.manifest.stages.playwright, 127, null, error.message);
      appendLog(run, 'stderr', 'Command finished: exit=127 signal=none', 'playwright');
      await finishRun(run);
    });
  });
  child.once('close', (code, signal) => {
    void runLifecycleCallback(run, 'Playwright close handler', async () => {
      if (TERMINAL_STATUSES.has(run.manifest.status)) return;
      clearRunChildDeadline(run);
      flushOutput(run, 'playwright');
      run.manifest.exitCode = code;
      run.manifest.signal = signal;
      completeStage(run.manifest.stages.playwright, code, signal, run.childTimeoutError);
      appendLog(
        run,
        code === 0 && !run.childTimeoutError ? 'stdout' : 'stderr',
        `Command finished: exit=${code ?? 'null'} signal=${signal ?? 'none'} duration=${run.manifest.stages.playwright.durationMs}ms${run.childTimeoutError ? ` error=${run.childTimeoutError}` : ''}`,
        'playwright',
      );
      appendEvent(run, 'stage', {
        name: 'playwright',
        status: run.manifest.stages.playwright.status,
        label: 'Browser checks finished',
        stage: structuredClone(run.manifest.stages.playwright),
      });
      if (process.platform !== 'win32') {
        signalChild(child, 'SIGKILL');
        appendLog(run, 'stdout', 'Residual Playwright process-group cleanup completed before evidence processing.', 'playwright');
      }
      run.child = null;
      if (run.manifest.stopRequestedAt) return finishStoppedRun(run);
      await runPostTestStages(run);
    });
  });

  return sendJson(response, 202, publicManifest(manifest));
}

async function rollbackRunInitialization(run, child, error) {
  clearRunChildDeadline(run);
  if (child?.pid) {
    try {
      signalChild(child, 'SIGKILL');
    } catch {
      // The process may already have exited; the terminal manifest below is the durable outcome.
    }
  }
  run.child = null;
  const finishedAt = new Date().toISOString();
  const detail = redactLogValue(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
  run.manifest.status = 'spawn-failed';
  run.manifest.phase = 'Run initialization failed before launch';
  run.manifest.finishedAt = finishedAt;
  run.manifest.error = detail;
  run.manifest.pipeline = {
    status: 'failed',
    completed: false,
    reason: `Run initialization failed: ${detail}`,
    finishedAt,
  };
  run.manifest.release = unavailableRelease('No authoritative release decision exists because run initialization failed.');
  completeStage(run.manifest.stages.playwright, 127, null, detail);
  appendLog(run, 'stderr', `Run initialization failed: ${detail}`, 'playwright');
  let persisted = false;
  try {
    await persistManifest(run);
    persisted = true;
  } catch (persistError) {
    console.error(`Could not persist failed initialization for ${run.manifest.id}: ${persistError.message}`);
  }
  await closeWritableStream(run.logStream);
  await closeWritableStream(run.lifecycleStream);
  run.logStream = null;
  run.lifecycleStream = null;
  run.aiApiKey = null;
  if (!persisted) runs.delete(run.manifest.id);
}

function reserveLaunchSlot() {
  const activeCount = [...runs.values()].filter(
    ({ manifest, externalManaged }) => !externalManaged && !TERMINAL_STATUSES.has(manifest.status),
  ).length;
  if (activeCount + launchReservations.size >= MAX_CONCURRENT_RUNS) {
    throw httpError(409, `Only ${MAX_CONCURRENT_RUNS} audit run(s) may be active at once.`);
  }
  const reservation = Symbol('portal-launch');
  launchReservations.add(reservation);
  return reservation;
}

function validateRunRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'Request body must be a JSON object.');
  }
  const profile = typeof body.profile === 'string' ? body.profile : '';
  if (!PROFILES.has(profile)) throw httpError(400, 'Profile must be smoke or release.');

  if (body.targetIds !== undefined && body.projects !== undefined
    && JSON.stringify(body.targetIds) !== JSON.stringify(body.projects)) {
    throw httpError(400, 'targetIds and legacy projects selections disagree.');
  }
  const rawProjects = body.targetIds ?? body.projects;
  const projects = uniqueStrings(rawProjects);
  if (projects.length === 0) throw httpError(400, 'Select at least one browser project.');
  if (Array.isArray(rawProjects) && new Set(rawProjects).size !== rawProjects.length) {
    throw httpError(400, 'Browser target selections cannot contain duplicates.');
  }
  if (projects.some((project) => PROVIDER_PROJECT_IDS.has(project))) {
    throw httpError(400, 'Provider-only real-device targets are unavailable until a device-lab adapter is installed.');
  }
  if (projects.length > PROJECTS.length || projects.some((project) => !PROJECT_IDS.has(project))) {
    throw httpError(400, 'One or more browser target IDs are unknown.');
  }
  const unavailableProjects = projects.filter((project) => !RUNNABLE_PROJECT_IDS.has(project));
  if (unavailableProjects.length > 0) {
    throw httpError(400, `These Docker-local targets are unavailable in this image: ${unavailableProjects.join(', ')}.`);
  }

  const requestedAreas = uniqueStrings(body.areas);
  if (requestedAreas.some((area) => !AUDIT_AREAS.has(area))) {
    throw httpError(400, 'One or more audit areas are not in the catalog.');
  }
  const requestedIds = uniqueStrings(body.auditIds);
  if (requestedIds.some((id) => !AUDIT_IDS.has(id))) {
    throw httpError(400, 'One or more audit IDs are not in the catalog.');
  }
  const expandedIds = catalog
    .filter(({ area }) => requestedAreas.includes(area))
    .map(({ id }) => id);
  const requestedPlugins = uniqueStrings(body.pluginIds);
  if (requestedPlugins.some((id) => !PLUGIN_IDS.has(id))) {
    throw httpError(400, 'One or more test suite plugins are not installed.');
  }
  const pluginAuditIds = plugins
    .filter(({ id }) => requestedPlugins.includes(id))
    .flatMap(({ auditDefinitions }) => auditDefinitions.map(({ id }) => id));
  const auditIds = [...new Set([...requestedIds, ...expandedIds, ...pluginAuditIds])].sort();
  if (auditIds.length > catalog.length) throw httpError(400, 'Too many audit IDs selected.');
  if (profile === 'release' && auditIds.length === 0
    && [...DEFAULT_PROJECT_IDS].some((project) => !projects.includes(project))) {
    throw httpError(400, 'A full release run requires the complete browser and device matrix. Use targeted scope for a narrower release-evidence run.');
  }
  const selectedPlugins = plugins.filter((plugin) =>
    requestedPlugins.includes(plugin.id)
      || plugin.auditDefinitions.some(({ id }) => auditIds.includes(id)));
  for (const plugin of selectedPlugins) {
    const unsupportedProjects = projects.filter((project) => !plugin.supportedProjects.includes(project));
    if (unsupportedProjects.length > 0) {
      throw httpError(400, `${plugin.name} does not support: ${unsupportedProjects.join(', ')}.`);
    }
  }
  for (const auditId of auditIds) {
    if (MANUAL_AUDIT_IDS.has(auditId)) continue;
    const cases = selectedPlugins.flatMap((plugin) =>
      plugin.auditCases.filter((auditCase) => auditCase.auditId === auditId));
    if (!cases.some((auditCase) => auditCase.supportedProjects.some((project) => projects.includes(project)))) {
      throw httpError(400, `${auditId} has no executable test case for the selected browser projects.`);
    }
  }
  const entrySpecs = [...new Set(selectedPlugins.flatMap(({ entrySpecs }) => entrySpecs))].sort();

  if (body.aiReview !== undefined && typeof body.aiReview !== 'boolean') {
    throw httpError(400, 'AI review must be enabled or disabled.');
  }
  const aiReview = body.aiReview === true;
  const candidateIgnoreHTTPSErrors = body.candidateIgnoreHTTPSErrors === true;
  if (aiReview && !currentAnthropicApiKey() && process.env.AI_REVIEW_DRY_RUN !== '1') {
    throw httpError(400, 'AI review is unavailable because the container has no runtime API key.');
  }
  const aiModel = body.aiModel === undefined ? DEFAULT_AI_MODEL : body.aiModel;
  if (typeof aiModel !== 'string' || !/^[a-zA-Z0-9._:-]{1,80}$/.test(aiModel)) {
    throw httpError(400, 'AI model contains unsupported characters.');
  }

  const productionUrl = validateTargetUrl(body.productionUrl, 'Production URL');
  const candidateUrl = validateTargetUrl(body.candidateUrl, 'Candidate URL');
  if (candidateIgnoreHTTPSErrors) {
    throw httpError(400, 'Candidate certificate bypass is unavailable because browsers cannot restrict it to one exact origin. Install the development/Netskope CA and keep TLS verification enabled.');
  }

  return {
    profile,
    projects,
    targetIds: [...projects],
    areas: requestedAreas.sort(),
    auditIds,
    pluginIds: requestedPlugins.sort(),
    entrySpecs,
    productionUrl,
    candidateUrl,
    aiReview,
    aiModel,
    candidateIgnoreHTTPSErrors,
  };
}

function validateSingleSitePortalContract(contract) {
  const unknownTargets = contract.targetIds.filter((id) => !SINGLE_SITE_TARGET_IDS.has(id));
  if (unknownTargets.length > 0) {
    throw httpError(400, `Unknown Single-site browser targets: ${unknownTargets.join(', ')}.`);
  }
  const unavailableTargets = contract.targetIds.filter((id) => !RUNNABLE_SINGLE_SITE_TARGET_IDS.has(id));
  if (unavailableTargets.length > 0) {
    throw httpError(400, `These Single-site Docker targets are unavailable: ${unavailableTargets.join(', ')}.`);
  }
}

function bareSha256Digest(value, label) {
  if (typeof value !== 'string') {
    throw new SingleSiteLaunchError(502, 'SINGLE_SITE_DIGEST_INVALID', `${label} is missing.`);
  }
  const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new SingleSiteLaunchError(502, 'SINGLE_SITE_DIGEST_INVALID', `${label} is not a SHA-256 digest.`);
  }
  return normalized;
}

function singleSiteEvidenceAuthority(preflight) {
  const reasons = Array.isArray(preflight?.evidenceAuthority?.reasons)
    ? [...preflight.evidenceAuthority.reasons]
    : [];
  return {
    authoritative: preflight?.evidenceAuthority?.status === 'authoritative',
    reasons,
  };
}

async function createSingleSiteQueueJob({ idempotencyKey, runContract, preflight, coverage, routeInventoryPlan, advisory }) {
  if (advisory.aiReview.optedIn && !currentAnthropicApiKey() && process.env.AI_REVIEW_DRY_RUN !== '1') {
    throw new SingleSiteLaunchError(
      400,
      'SINGLE_SITE_AI_UNAVAILABLE',
      'AI review was requested, but no Anthropic credential is available in the isolated portal vault.',
      { focusTarget: 'aiReview' },
    );
  }
  const runContractDigest = bareSha256Digest(coverage?.revisions?.runContract, 'Run contract digest');
  if (queueSha256(runContract) !== runContractDigest) {
    throw new SingleSiteLaunchError(
      502,
      'SINGLE_SITE_CONTRACT_BINDING_INVALID',
      'Compiled coverage is not bound to the launch contract.',
    );
  }
  const checkpoint = {
    preflightDigest: bareSha256Digest(preflight.preflightDigest, 'Preflight digest'),
    identityFingerprint: bareSha256Digest(preflight.identityFingerprint, 'Identity fingerprint'),
    revisionFingerprint: preflight.deploymentRevision?.fingerprint
      ? bareSha256Digest(preflight.deploymentRevision.fingerprint, 'Deployment revision fingerprint')
      : null,
    evidenceAuthority: singleSiteEvidenceAuthority(preflight),
  };
  const inputDocument = {
    schemaVersion: 1,
    kind: 'single-site-worker-input',
    runContract,
    coverageManifest: coverage,
    routeInventoryPlan,
    launchCheckpoint: checkpoint,
    advisory,
    runnerRevision: singleSiteRunnerRevision,
  };
  const now = Date.now();
  const submission = {
    idempotencyKey,
    runMode: 'single-site',
    inputDocumentDigest: queueSha256(inputDocument),
    runContractDigest,
    compiledManifestDigest: bareSha256Digest(coverage.manifestDigest, 'Coverage manifest digest'),
    preflightDigest: checkpoint.preflightDigest,
    identityFingerprint: checkpoint.identityFingerprint,
    revisionFingerprint: checkpoint.revisionFingerprint,
    evidenceAuthority: checkpoint.evidenceAuthority,
    registryRevision: coverage.revisions.pluginRegistry,
    targetSetRevision: coverage.revisions.targetRegistry,
    runnerRevision: coverage.revisions.runner,
    stageDeadlines: {
      inventory: new Date(now + Math.min(PLAYWRIGHT_DEADLINE_MS, 15 * 60_000)).toISOString(),
      browser: new Date(now + PLAYWRIGHT_DEADLINE_MS).toISOString(),
      finalizer: new Date(
        now + PLAYWRIGHT_DEADLINE_MS + VIDEO_STAGE_DEADLINE_MS + REPORT_STAGE_DEADLINE_MS,
      ).toISOString(),
    },
  };
  try {
    const submitted = await submitSingleSiteJob(singleSiteQueue, submission, { inputDocument });
    upsertSingleSiteConsoleState(submitted.state, { input: inputDocument });
    return publicSingleSiteJobWithFinalization(submitted.state, inputDocument, { includeEvents: false });
  } catch (error) {
    if (!(error instanceof JobQueueError)) throw error;
    const conflict = ['QUEUE_IDEMPOTENCY_CONFLICT', 'QUEUE_INPUT_MISMATCH'].includes(error.code);
    throw new SingleSiteLaunchError(
      conflict ? 409 : 503,
      conflict ? 'SINGLE_SITE_QUEUE_CONFLICT' : 'SINGLE_SITE_QUEUE_UNAVAILABLE',
      conflict ? error.message : 'The durable Single-site queue could not accept this launch.',
    );
  }
}

function publicSingleSiteJob(state, input, { includeEvents = true } = {}) {
  const coverage = input.coverageManifest;
  const contract = input.runContract;
  return {
    schemaVersion: 1,
    id: state.jobId,
    mode: 'single-site',
    revision: state.sequence,
    sourceRevision: `state-${state.sequence}`,
    status: state.executionState,
    activity: state.activityState,
    createdAt: state.submittedAt,
    updatedAt: state.updatedAt,
    url: contract.url,
    deploymentRole: contract.deploymentRole,
    certificatePolicy: contract.certificatePolicy,
    scope: {
      qualifier: coverage.scope.qualifier,
      requestedQualifier: coverage.scope.requestedQualifier,
      filters: coverage.scope.filters,
      selectedTargetIds: coverage.scope.selectedTargetIds,
      omissions: coverage.omissions,
    },
    coverage: {
      status: coverage.coverageStatus,
      counts: coverage.counts,
      gaps: coverage.coverageGaps,
      outsideModeCount: coverage.outsideMode.length,
    },
    evidenceAuthority: state.evidenceAuthority,
    advisory: structuredClone(input.advisory ?? { schemaVersion: 1, aiReview: { optedIn: false, model: null } }),
    attempt: {
      number: state.attemptNumber,
      id: state.attemptId,
      fencingToken: state.fencingToken,
      infrastructureRetriesUsed: state.infrastructureRetriesUsed,
      maxInfrastructureRetries: state.maxInfrastructureRetries,
    },
    lease: state.lease,
    result: state.result,
    cancellation: state.cancellation,
    finalization: null,
    stageDeadlines: state.stageDeadlines,
    events: includeEvents ? state.events : undefined,
    publications: includeEvents ? state.publications : undefined,
    links: {
      self: `/api/single-site/runs/${encodeURIComponent(state.jobId)}`,
      cancel: `/api/single-site/runs/${encodeURIComponent(state.jobId)}/cancel`,
      report: null,
    },
    purge: {
      eligible: SINGLE_SITE_TERMINAL_STATES.has(state.executionState),
      confirmation: singleSitePurgeConfirmation(state.jobId),
      baselineBytesPreserved: true,
    },
  };
}

async function publicSingleSiteJobWithFinalization(state, input, options = {}) {
  const job = publicSingleSiteJob(state, input, options);
  let finalizationIntegrityValid = true;
  try {
    job.finalization = await readSingleSiteFinalizationStatus(SINGLE_SITE_FINALIZATION_ROOT, state.jobId);
  } catch (error) {
    finalizationIntegrityValid = false;
    job.finalization = {
      schemaVersion: 1,
      jobId: state.jobId,
      status: 'invalid',
      deadlineExceeded: false,
      executionState: state.executionState,
      finalizationDigest: null,
      failureDigest: null,
      reportRevision: null,
      reportPublicationDigest: null,
      visualPublicationDigest: null,
      visualEligibilityManifestDigest: null,
      error: 'Finalization status is unavailable or failed integrity validation.',
    };
  }
  if ((job.finalization.status === 'complete' || job.finalization.status === 'incomplete')
    && job.finalization.reportRevision !== null) {
    job.links.report = `/report.html?mode=single-site&run=${encodeURIComponent(state.jobId)}`;
  }
  job.purge.eligible = job.purge.eligible
    && finalizationIntegrityValid
    && ['complete', 'incomplete', 'deadline-exceeded', 'invalid'].includes(job.finalization.status);
  const advisory = input.advisory?.aiReview ?? { optedIn: false, model: null };
  const aiStatus = await readSingleSiteAiReview(singleSiteAiReview, state.jobId).catch(() => null);
  const displayState = singleSiteAiReviewDisplayState(advisory.optedIn === true, aiStatus, job.finalization);
  job.aiReview = {
    schemaVersion: 1,
    mode: 'single-site',
    advisory: true,
    gating: false,
    optedIn: advisory.optedIn === true,
    model: advisory.model ?? null,
    state: displayState.state,
    unavailableReason: displayState.unavailableReason,
    status: publicSingleSiteAiReviewStatus(aiStatus),
  };
  job.links.aiReview = advisory.optedIn
    ? `/api/single-site/runs/${encodeURIComponent(state.jobId)}/ai-review`
    : null;
  return job;
}

function publicSingleSiteAiReviewStatus(status) {
  if (!status) return null;
  const output = status.output ? {
    publicationDigest: status.output.publicationDigest,
    reviewSha256: status.output.reviewSha256,
    reviewStatus: status.output.reviewStatus,
    findingCount: status.output.findingCount,
    advisory: true,
    gating: false,
  } : null;
  return { ...structuredClone(status), output };
}

function publicSingleSiteAiReviewResult(result) {
  const review = structuredClone(result.review);
  if (review?.source && typeof review.source === 'object') {
    review.source.runDirectory = null;
  }
  return {
    schemaVersion: 1,
    mode: 'single-site',
    advisory: true,
    gating: false,
    status: publicSingleSiteAiReviewStatus(result.status),
    publication: structuredClone(result.publication),
    review,
    inventory: structuredClone(result.inventory),
  };
}

function singleSiteAiReviewDisplayState(optedIn, status, finalization) {
  if (!optedIn) return { state: 'disabled', unavailableReason: null };
  if (status) return { state: status.state, unavailableReason: status.error?.message ?? null };
  if (finalization?.status === 'invalid' || finalization?.status === 'deadline-exceeded') {
    return {
      state: 'unavailable',
      unavailableReason: 'AI advisory requires a valid finalized deterministic report and cannot repair failed finalization.',
    };
  }
  return { state: 'waiting-for-finalization', unavailableReason: null };
}

async function publicSingleSiteJobSummary(state) {
  const input = await readSingleSiteJobInput(singleSiteQueue, state.jobId);
  return publicSingleSiteJobWithFinalization(state, input, { includeEvents: false });
}

function latestSingleSiteAttemptId(state) {
  return state.attemptId ?? [...state.publications]
    .sort((left, right) => right.attemptNumber - left.attemptNumber)[0]?.attemptId ?? null;
}

function singleSiteAiRuntimeKey() {
  return currentAnthropicApiKey()
    ?? (process.env.AI_REVIEW_DRY_RUN === '1' ? 'sk-ant-dry-run-no-provider-egress' : null);
}

async function scheduleSingleSiteAiReview(jobId, options = {}) {
  const [state, input] = await Promise.all([
    readSingleSiteJob(singleSiteQueue, jobId),
    readSingleSiteJobInput(singleSiteQueue, jobId),
  ]);
  upsertSingleSiteConsoleState(state, { input });
  const advisory = input.advisory?.aiReview;
  if (advisory?.optedIn !== true || typeof advisory.model !== 'string') return null;
  const finalization = await readSingleSiteFinalizationStatus(SINGLE_SITE_FINALIZATION_ROOT, jobId);
  upsertSingleSiteConsoleState(state, { input, finalization });
  if (!['complete', 'incomplete'].includes(finalization.status)) return null;
  const current = await readSingleSiteAiReview(singleSiteAiReview, jobId);
  if (!options.force) {
    if (current && ['pending', 'running', 'completed', 'failed'].includes(current.state)) return current;
    if (current?.state === 'unavailable') {
      const automaticallyRetryable = ['credential-unavailable', 'interrupted-requires-runtime-secret']
        .includes(current.error?.code);
      if (!automaticallyRetryable || !singleSiteAiRuntimeKey()) return current;
    }
  }
  const expectedStateRevision = options.expectedStateRevision ?? current?.stateRevision ?? 0;
  if (current && expectedStateRevision !== current.stateRevision) {
    throw httpError(409, `AI advisory state revision is ${current.stateRevision}, not ${expectedStateRevision}.`);
  }
  const requestId = options.requestId
    ?? `${current ? 'retry' : 'auto'}-${expectedStateRevision}-${finalization.reportRevision}`;
  return requestSingleSiteAiReview(singleSiteAiReview, {
    jobId: state.jobId,
    requestId,
    expectedStateRevision,
    optIn: true,
    model: advisory.model,
    apiKey: singleSiteAiRuntimeKey(),
    reportDirectory: resolve(SINGLE_SITE_FINALIZATION_ROOT, state.jobId, 'report'),
    reportRevision: finalization.reportRevision,
    reportPublicationDigest: finalization.reportPublicationDigest,
  });
}

async function syncSingleSiteAiReviews() {
  const jobs = await listSingleSiteJobs(singleSiteQueue);
  for (const state of jobs) {
    if (!SINGLE_SITE_TERMINAL_STATES.has(state.executionState)) continue;
    await scheduleSingleSiteAiReview(state.jobId).catch((error) => {
      console.error(`Could not schedule Single-site AI advisory ${state.jobId}: ${redactLogValue(error.message)}`);
    });
  }
}

function triggerSingleSiteAiReviewSync() {
  if (singleSiteAiReviewSyncPromise) return;
  singleSiteAiReviewSyncPromise = syncSingleSiteAiReviews()
    .catch((error) => console.error(`Could not refresh Single-site AI advisories: ${redactLogValue(error.message)}`))
    .finally(() => { singleSiteAiReviewSyncPromise = null; });
}

function singleSiteAttemptArtifactDirectory(state) {
  const attemptId = latestSingleSiteAttemptId(state);
  if (attemptId === null) throw httpError(404, 'This Single-site run has not created an attempt artifact directory yet.');
  const jobRoot = resolve(SINGLE_SITE_QUEUE_ROOT, 'jobs', state.jobId);
  const artifactRoot = resolve(jobRoot, 'attempts', attemptId, 'work', 'artifacts');
  if (artifactRoot !== jobRoot && !artifactRoot.startsWith(`${jobRoot}${sep}`)) {
    throw httpError(404, 'Single-site artifact directory is invalid.');
  }
  return artifactRoot;
}

const VISUAL_BASELINE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const VISUAL_BASELINE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const VISUAL_BASELINE_SECRET_TEXT = /(?:\bauthorization\s*:|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie)\s*[=:]\s*[^\s,;"}]{8,}|[?&](?:token|key|signature|auth)=[^&#\s"}]{8,})/i;

function visualBaselineId(value) {
  if (typeof value !== 'string' || !VISUAL_BASELINE_ID.test(value)) {
    throw httpError(404, 'Visual baseline not found.');
  }
  return value;
}

function assertVisualBaselineMutationBody(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'Visual baseline mutation body must be a JSON object.');
  }
  const forbidden = findClientActorIdentity(value);
  if (forbidden) {
    throw httpError(400, `Client-supplied actor identity is not allowed (${forbidden}). The portal attributes mutations from the authenticated operator session.`);
  }
  if (VISUAL_BASELINE_SECRET_TEXT.test(JSON.stringify(value))) {
    throw httpError(400, 'Visual baseline mutations cannot persist credential-bearing text or secret query values.');
  }
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedFields.has(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw httpError(400, `Visual baseline mutation has invalid fields${unknown.length ? `; unknown: ${unknown.sort().join(', ')}` : ''}${missing.length ? `; missing: ${missing.sort().join(', ')}` : ''}.`);
  }
  return value;
}

function findClientActorIdentity(value, path = 'body', depth = 0) {
  if (depth > 16 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findClientActorIdentity(value[index], `${path}[${index}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:actor|actorId|approvedBy|reviewer|reviewerId)$/i.test(key)) return `${path}.${key}`;
    const found = findClientActorIdentity(child, `${path}.${key}`, depth + 1);
    if (found) return found;
  }
  return null;
}

function visualBaselineConfirmation(operation, baselineId, evidenceId = null) {
  if (operation === 'approve') return `APPROVE ${evidenceId ?? ''}`;
  if (operation === 'replace') return `REPLACE ${baselineId} ${evidenceId ?? ''}`;
  if (operation === 'revoke') return `REVOKE ${baselineId}`;
  return `DELETE ${baselineId}`;
}

function assertVisualBaselineConfirmation(value, expected) {
  if (value !== expected) {
    throw httpError(400, `Confirm this exact visual baseline action with ${JSON.stringify(expected)}.`);
  }
}

function publicVisualBaselineRecord(record) {
  return {
    ...structuredClone(record),
    media: {
      sha256: record.media.sha256,
      bytes: record.media.bytes,
      available: record.media.available,
      url: record.media.available
        ? `/api/single-site/visual-baselines/${encodeURIComponent(record.baselineId)}/media`
        : null,
    },
  };
}

function publicVisualBaselineMutation(result, snapshot) {
  const record = snapshot.state.baselines[result.baselineId] ?? null;
  return {
    schemaVersion: 1,
    mode: 'single-site',
    result,
    storeRevision: snapshot.state.storeRevision,
    historyDigest: snapshot.state.historyDigest,
    baseline: record ? publicVisualBaselineRecord(record) : null,
  };
}

async function publicVisualBaselineCollection(requestUrl, request) {
  const snapshot = await readVisualBaselineStore(visualBaselineStore);
  const slotKey = requestUrl.searchParams.get('slotKey');
  if (slotKey !== null && !VISUAL_BASELINE_DIGEST.test(slotKey)) throw httpError(400, 'slotKey must be a visual-baseline SHA-256 digest.');
  const requestedState = requestUrl.searchParams.get('state');
  if (requestedState !== null && !['active', 'replaced', 'revoked', 'deleted'].includes(requestedState)) {
    throw httpError(400, 'state must be active, replaced, revoked, or deleted.');
  }
  const offset = queryInteger(requestUrl.searchParams.get('offset'), 'offset', 0, 0, 1_000_000);
  const limit = queryInteger(
    requestUrl.searchParams.get('limit'),
    'limit',
    DEFAULT_BASELINE_PAGE_SIZE,
    1,
    MAX_BASELINE_PAGE_SIZE,
  );
  const records = listVisualBaselineHistory(snapshot, slotKey)
    .filter((record) => requestedState === null || record.state === requestedState)
    .sort((left, right) => right.approvedAt.localeCompare(left.approvedAt) || left.baselineId.localeCompare(right.baselineId));
  const items = records.slice(offset, offset + limit).map(publicVisualBaselineRecord);
  return {
    schemaVersion: 1,
    mode: 'single-site',
    storeRevision: snapshot.state.storeRevision,
    historyDigest: snapshot.state.historyDigest,
    items,
    total: records.length,
    offset,
    limit,
    hasMore: offset + items.length < records.length,
    mutationCapability: { authorized: operatorRequestAuthorized(request), actorSource: 'server-session' },
  };
}

async function publicVisualBaselineEventHistory(requestUrl) {
  const snapshot = await readVisualBaselineStore(visualBaselineStore);
  const slotKey = requestUrl.searchParams.get('slotKey');
  if (slotKey !== null && !VISUAL_BASELINE_DIGEST.test(slotKey)) throw httpError(400, 'slotKey must be a visual-baseline SHA-256 digest.');
  const baselineId = requestUrl.searchParams.get('baselineId');
  if (baselineId !== null) visualBaselineId(baselineId);
  const offset = queryInteger(requestUrl.searchParams.get('offset'), 'offset', 0, 0, 1_000_000);
  const limit = queryInteger(
    requestUrl.searchParams.get('limit'),
    'limit',
    DEFAULT_BASELINE_PAGE_SIZE,
    1,
    MAX_BASELINE_PAGE_SIZE,
  );
  const events = snapshot.history.filter((event) => {
    const eventBaselineIds = [
      event.result?.baselineId,
      event.payload?.baselineId,
      event.payload?.replacedBaselineId,
      event.payload?.record?.baselineId,
    ].filter(Boolean);
    if (baselineId !== null && !eventBaselineIds.includes(baselineId)) return false;
    const eventSlotKey = event.result?.slotKey ?? event.payload?.record?.slotKey ?? null;
    return slotKey === null || eventSlotKey === slotKey;
  });
  const items = events.slice(offset, offset + limit).map((event) => ({
    schemaVersion: event.schemaVersion,
    sequence: event.sequence,
    eventId: event.eventId,
    type: event.type,
    at: event.at,
    actorId: event.actorId,
    reason: event.reason,
    previousDigest: event.previousDigest,
    eventDigest: event.eventDigest,
    result: structuredClone(event.result),
    affectedBaselineIds: [...new Set([
      event.result?.baselineId,
      event.payload?.baselineId,
      event.payload?.replacedBaselineId,
      event.payload?.record?.baselineId,
    ].filter(Boolean))],
  }));
  return {
    schemaVersion: 1,
    mode: 'single-site',
    storeRevision: snapshot.state.storeRevision,
    historyDigest: snapshot.state.historyDigest,
    items,
    total: events.length,
    offset,
    limit,
    hasMore: offset + items.length < events.length,
  };
}

async function publicVisualBaseline(baselineIdValue, request) {
  const baselineId = visualBaselineId(baselineIdValue);
  const snapshot = await readVisualBaselineStore(visualBaselineStore);
  const record = snapshot.state.baselines[baselineId];
  if (!record) throw httpError(404, 'Visual baseline not found.');
  const history = snapshot.history
    .filter((event) => [event.result?.baselineId, event.payload?.baselineId,
      event.payload?.replacedBaselineId, event.payload?.record?.baselineId].includes(baselineId))
    .map((event) => ({ eventId: event.eventId, sequence: event.sequence, type: event.type, at: event.at, actorId: event.actorId, reason: event.reason }));
  return {
    schemaVersion: 1,
    mode: 'single-site',
    storeRevision: snapshot.state.storeRevision,
    historyDigest: snapshot.state.historyDigest,
    baseline: publicVisualBaselineRecord(record),
    history,
    mutationCapability: { authorized: operatorRequestAuthorized(request), actorSource: 'server-session' },
  };
}

async function serveVisualBaselineMedia(request, response, baselineIdValue) {
  const baselineId = visualBaselineId(baselineIdValue);
  const snapshot = await readVisualBaselineStore(visualBaselineStore);
  const record = snapshot.state.baselines[baselineId];
  if (!record) throw httpError(404, 'Visual baseline not found.');
  if (!record.media.available) throw httpError(410, 'Visual baseline media was deleted; tombstoned provenance remains available.');
  let opened;
  try {
    opened = await openContainedArtifactFile(fs, visualBaselineStore.root, record.media.relativePath, {
      requireDescriptorContainment: false,
    });
    if (opened.relativePath !== record.media.relativePath || opened.stat.size !== record.media.bytes) {
      throw new Error('Visual baseline media metadata does not match the immutable record.');
    }
    const bytes = Buffer.alloc(record.media.bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await opened.handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error('Visual baseline media ended before its declared byte length.');
      offset += read.bytesRead;
    }
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== record.media.sha256) throw new Error('Visual baseline media digest validation failed.');
  } catch (error) {
    await opened?.handle?.close().catch(() => undefined);
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EINVAL', 'UNSAFE_ARTIFACT_PATH'].includes(error?.code)) {
      throw httpError(410, 'Visual baseline media is unavailable; tombstoned provenance remains available.');
    }
    if (Number.isInteger(error?.statusCode)) throw error;
    throw httpError(422, 'Visual baseline media failed immutable integrity validation.');
  }
  return sendFile(request, response, opened.path, "default-src 'none'; frame-ancestors 'self'", { opened });
}

function baselineEligibilityError(statusCode, code, message) {
  return Object.assign(httpError(statusCode, message), { code });
}

function exactEligibilityKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', `${label} must be an object.`);
  }
  const fields = Object.keys(value);
  const unknown = fields.filter((field) => !expected.includes(field));
  const missing = expected.filter((field) => !(field in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', `${label} has unsupported or missing fields.`);
  }
}

function canonicalEligibilityTimestamp(value) {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

async function readVisualBaselineEligibility(runIdValue, evidenceIdValue) {
  const runId = visualBaselineId(runIdValue);
  if (typeof evidenceIdValue !== 'string' || !VISUAL_BASELINE_DIGEST.test(evidenceIdValue)) {
    throw httpError(400, 'evidenceId must be a server-published visual evidence SHA-256 identity.');
  }
  const state = await readSingleSiteJob(singleSiteQueue, runId);
  const finalization = await readSingleSiteFinalizationStatus(SINGLE_SITE_FINALIZATION_ROOT, runId)
    .catch(() => null);
  if (state.executionState !== 'completed' || !['passed', 'findings'].includes(state.result?.kind)
    || finalization?.status !== 'complete') {
    throw baselineEligibilityError(
      409,
      'SINGLE_SITE_BASELINE_ELIGIBILITY_UNAVAILABLE',
      'Visual baseline approval requires a completed run with a valid complete finalization publication.',
    );
  }
  if (state.evidenceAuthority?.authoritative !== true || state.evidenceAuthority.reasons?.length !== 0) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_INELIGIBLE', 'Non-authoritative run evidence cannot become a visual baseline.');
  }
  const attemptId = latestSingleSiteAttemptId(state);
  if (!attemptId) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', 'Completed run state has no current fenced attempt identity.');
  }
  const visualRoot = resolve(SINGLE_SITE_FINALIZATION_ROOT, runId, 'visual');
  const eligibilityPath = resolve(visualRoot, 'eligibility.json');
  if (eligibilityPath !== join(visualRoot, 'eligibility.json')) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', 'Visual eligibility path is invalid.');
  }
  let stat;
  try { stat = await fs.lstat(eligibilityPath); } catch (error) {
    if (error?.code === 'ENOENT') {
      throw baselineEligibilityError(
        409,
        'SINGLE_SITE_BASELINE_ELIGIBILITY_UNAVAILABLE',
        'This run has not published its immutable visual baseline eligibility manifest yet.',
      );
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_BASELINE_ELIGIBILITY_BYTES) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', 'Visual baseline eligibility manifest is unsafe or exceeds its byte bound.');
  }
  const [realRoot, realFile] = await Promise.all([fs.realpath(visualRoot), fs.realpath(eligibilityPath)]);
  if (realFile !== join(realRoot, 'eligibility.json')) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', 'Visual baseline eligibility manifest escaped its immutable publication directory.');
  }
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(realFile, 'utf8')); } catch {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', 'Visual baseline eligibility manifest is not valid JSON.');
  }
  exactEligibilityKeys(manifest, [
    'schemaVersion', 'kind', 'mode', 'jobId', 'attemptId', 'finalizationDigest',
    'reportRevision', 'generatedAt', 'comparatorCalibration', 'items', 'manifestDigest',
  ], 'Visual baseline eligibility manifest');
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'single-site-visual-baseline-eligibility'
    || manifest.mode !== 'single-site' || manifest.jobId !== runId || manifest.attemptId !== attemptId
    || manifest.finalizationDigest !== finalization.finalizationDigest
    || manifest.reportRevision !== finalization.reportRevision
    || !canonicalEligibilityTimestamp(manifest.generatedAt)
    || !Array.isArray(manifest.items) || manifest.items.length > MAX_BASELINE_ELIGIBILITY_ITEMS) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', 'Visual baseline eligibility manifest is not bound to the current run, attempt, finalization, and report revision.');
  }
  try {
    await verifyPublishedVisualComparatorCalibration(manifest.comparatorCalibration);
  } catch {
    throw baselineEligibilityError(
      422,
      'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID',
      'Visual baseline eligibility manifest has an unsupported comparator calibration binding.',
    );
  }
  const { manifestDigest, ...manifestBody } = manifest;
  if (manifestDigest !== visualBaselineDigest(manifestBody)
    || manifestDigest !== finalization.visualEligibilityManifestDigest) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', 'Visual baseline eligibility manifest failed digest verification.');
  }
  const evidenceIds = new Set();
  let selected = null;
  for (const item of manifest.items) {
    exactEligibilityKeys(item, [
      'evidenceId', 'identity', 'identityKey', 'slotKey', 'evidence', 'requiresFindingWaiver',
      'eligible', 'ineligibilityReasons',
    ], 'Visual baseline eligibility item');
    if (typeof item.evidenceId !== 'string' || !VISUAL_BASELINE_DIGEST.test(item.evidenceId)
      || evidenceIds.has(item.evidenceId)) {
      throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', 'Visual baseline eligibility manifest has an invalid or duplicate evidence ID.');
    }
    evidenceIds.add(item.evidenceId);
    if (item.evidenceId === evidenceIdValue) selected = item;
  }
  if (!selected) throw httpError(404, 'Eligible visual evidence not found in this finalized run.');
  if (selected.eligible !== true || !Array.isArray(selected.ineligibilityReasons)
    || selected.ineligibilityReasons.length !== 0 || selected.evidence === null) {
    const reason = Array.isArray(selected.ineligibilityReasons) && selected.ineligibilityReasons.length > 0
      ? selected.ineligibilityReasons.join(' ')
      : 'The server-published evidence record is not eligible.';
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_INELIGIBLE', `Visual evidence cannot become a baseline. ${reason}`);
  }
  let identity;
  let evidence;
  try {
    identity = parseVisualBaselineIdentity(selected.identity);
    const unresolved = selected.evidence?.findingStatus === 'unresolved';
    evidence = parseVisualBaselineEvidence(unresolved ? {
      ...selected.evidence,
      findingWaiver: {
        actorId: PORTAL_OPERATOR_ACTOR_ID,
        reason: 'Eligibility validation placeholder; the approval action must supply the recorded waiver.',
        at: selected.generatedAt ?? manifest.generatedAt,
      },
    } : selected.evidence);
    if (unresolved) evidence = { ...evidence, findingWaiver: null };
  } catch (error) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', `Visual eligibility identity or evidence is invalid: ${error.message}`);
  }
  if (selected.identityKey !== visualBaselineIdentityKey(identity)
    || selected.slotKey !== visualBaselineSlotKey(identity)
    || evidence.runId !== runId || evidence.runStatus !== 'completed'
    || evidence.evidenceComplete !== true || evidence.evidenceAuthority.status !== 'authoritative'
    || !['clear', 'unresolved'].includes(evidence.findingStatus) || evidence.findingWaiver !== null
    || selected.requiresFindingWaiver !== (evidence.findingStatus === 'unresolved')) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', 'Eligible visual evidence contradicts its server-published identity, authority, completeness, or Finding state.');
  }
  const expectedEvidenceId = visualBaselineDigest({
    jobId: runId,
    attemptId,
    identityKey: selected.identityKey,
    artifactSha256: evidence.artifactSha256,
  });
  if (evidenceIdValue !== expectedEvidenceId) {
    throw baselineEligibilityError(422, 'SINGLE_SITE_BASELINE_ELIGIBILITY_INVALID', 'Visual evidence ID is not bound to its run, attempt, identity, and artifact digest.');
  }
  return {
    identity,
    evidence,
    runRoot: singleSiteAttemptArtifactDirectory(state),
    manifestDigest,
  };
}

async function mutateVisualBaselineApproval(operation, expectedActiveBaselineId, rawBody) {
  const body = assertVisualBaselineMutationBody(rawBody, [
    'expectedStoreRevision', 'runId', 'evidenceId', 'reason', 'findingWaiverReason',
    'idempotencyKey', 'confirmation',
  ], ['expectedStoreRevision', 'runId', 'evidenceId', 'reason', 'idempotencyKey', 'confirmation']);
  if (operation === 'replace') visualBaselineId(expectedActiveBaselineId);
  assertVisualBaselineConfirmation(
    body.confirmation,
    visualBaselineConfirmation(operation, expectedActiveBaselineId, body.evidenceId),
  );
  const source = await readVisualBaselineEligibility(body.runId, body.evidenceId);
  const requiresFindingWaiver = source.evidence.findingStatus === 'unresolved';
  if (requiresFindingWaiver) {
    if (typeof body.findingWaiverReason !== 'string'
      || body.findingWaiverReason.trim() !== body.findingWaiverReason
      || body.findingWaiverReason.length < 1
      || body.findingWaiverReason.length > 1_200) {
      throw baselineEligibilityError(
        422,
        'SINGLE_SITE_BASELINE_FINDING_WAIVER_REQUIRED',
        'This evidence has unresolved Findings. Record a Finding waiver rationale of 1 through 1200 characters.',
      );
    }
  } else if (body.findingWaiverReason !== undefined) {
    throw httpError(400, 'findingWaiverReason is allowed only when the selected evidence has unresolved Findings.');
  }
  const sourceImage = safeResolve(source.runRoot, source.evidence.artifactRelativePath);
  if (!sourceImage) throw httpError(422, 'Visual baseline source path is outside the source run artifact root.');
  await validateUploadedMedia(sourceImage, 'image/png');
  const mutation = {
    expectedStoreRevision: body.expectedStoreRevision,
    identity: source.identity,
    evidence: source.evidence,
    runArtifactRoot: source.runRoot,
    actorId: PORTAL_OPERATOR_ACTOR_ID,
    reason: body.reason,
    ...(requiresFindingWaiver
      ? { findingWaiverReason: body.findingWaiverReason }
      : {}),
    idempotencyKey: body.idempotencyKey,
    ...(operation === 'replace' ? { expectedActiveBaselineId } : {}),
  };
  const result = operation === 'approve'
    ? await approveVisualBaseline(visualBaselineStore, mutation)
    : await replaceVisualBaseline(visualBaselineStore, mutation);
  const snapshot = await readVisualBaselineStore(visualBaselineStore);
  await refreshSingleSiteConsoleRunBestEffort(body.runId, 'baseline mutation');
  return {
    ...publicVisualBaselineMutation(result, snapshot),
    eligibilityManifestDigest: source.manifestDigest,
  };
}

async function mutateVisualBaselineLifecycle(operation, baselineIdValue, rawBody) {
  const baselineId = visualBaselineId(baselineIdValue);
  const body = assertVisualBaselineMutationBody(rawBody,
    ['expectedStoreRevision', 'reason', 'idempotencyKey', 'confirmation'],
    ['expectedStoreRevision', 'reason', 'idempotencyKey', 'confirmation']);
  assertVisualBaselineConfirmation(body.confirmation, visualBaselineConfirmation(operation, baselineId));
  const mutation = {
    expectedStoreRevision: body.expectedStoreRevision,
    baselineId,
    actorId: PORTAL_OPERATOR_ACTOR_ID,
    reason: body.reason,
    idempotencyKey: body.idempotencyKey,
  };
  const result = operation === 'revoke'
    ? await revokeVisualBaseline(visualBaselineStore, mutation)
    : await deleteVisualBaseline(visualBaselineStore, mutation);
  const snapshot = await readVisualBaselineStore(visualBaselineStore);
  const sourceRunId = snapshot.state.baselines[result.baselineId]?.evidence?.runId;
  if (SAFE_SINGLE_SITE_JOB_ID.test(sourceRunId ?? '')) {
    await refreshSingleSiteConsoleRunBestEffort(sourceRunId, 'baseline lifecycle');
  }
  return publicVisualBaselineMutation(result, snapshot);
}

function validateTargetUrl(value, label) {
  if (typeof value !== 'string' || value.length > 2_048) throw httpError(400, `${label} is invalid.`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw httpError(400, `${label} must be a complete HTTP or HTTPS URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw httpError(400, `${label} must be an HTTP or HTTPS URL without credentials.`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw httpError(400, `${label} must be an origin without a path, query, or fragment.`);
  }
  return url.origin;
}

function consumeOutput(run, stream, channel, stage) {
  if (!stream) return;
  run.outputStreams?.add(stream);
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    run.lineBuffer[channel] += stripTerminalCodes(chunk);
    const lines = run.lineBuffer[channel].split(/\r?\n/);
    run.lineBuffer[channel] = lines.pop() ?? '';
    for (const [index, line] of lines.entries()) {
      const omitted = index === 0 ? run.omittedLineCharacters?.[channel] ?? 0 : 0;
      appendLog(run, channel, omitted > 0
        ? `[portal omitted ${omitted} oversized output characters] ${line}`
        : line, stage);
      if (index === 0 && run.omittedLineCharacters) run.omittedLineCharacters[channel] = 0;
    }
    if (run.lineBuffer[channel].length > MAX_CHILD_PARTIAL_LINE_CHARS) {
      const removed = run.lineBuffer[channel].length - MAX_CHILD_PARTIAL_LINE_CHARS;
      run.lineBuffer[channel] = run.lineBuffer[channel].slice(removed);
      run.omittedLineCharacters ??= { stdout: 0, stderr: 0 };
      run.omittedLineCharacters[channel] += removed;
    }
  });
  stream.once('error', (error) => {
    void failRunClosed(run, `Child ${stage}:${channel} output stream failed: ${error.message}`);
  });
  stream.once('close', () => run.outputStreams?.delete(stream));
}

function flushOutput(run, stage) {
  for (const channel of ['stdout', 'stderr']) {
    if (run.lineBuffer[channel]) {
      const omitted = run.omittedLineCharacters?.[channel] ?? 0;
      appendLog(run, channel, omitted > 0
        ? `[portal omitted ${omitted} oversized output characters] ${run.lineBuffer[channel]}`
        : run.lineBuffer[channel], stage);
    }
    run.lineBuffer[channel] = '';
    if (run.omittedLineCharacters) run.omittedLineCharacters[channel] = 0;
  }
}

function appendLog(run, channel, line, stage = 'system') {
  const cleanLine = redactLogValue(line.slice(0, 20_000));
  const timestamp = new Date().toISOString();
  const accepted = run.logStream?.write(`${timestamp} [${stage}:${channel}] ${cleanLine}\n`);
  if (accepted === false && !run.logDrainPending) {
    run.logDrainPending = true;
    for (const output of run.outputStreams ?? []) output.pause?.();
    run.logStream.once('drain', () => {
      run.logDrainPending = false;
      for (const output of run.outputStreams ?? []) output.resume?.();
    });
  }
  if (stage === 'playwright') {
    if (/Running\s+\d+\s+tests?/i.test(cleanLine)) run.manifest.phase = 'Executing browser checks';
    if (/Audit checklist:/i.test(cleanLine)) run.manifest.phase = 'Writing initial checklist';
    updateProgress(run.manifest.progress, cleanLine);
  }
  appendEvent(run, 'log', {
    channel,
    stage,
    line: cleanLine,
    timestamp,
    phase: run.manifest.phase,
    progress: run.manifest.progress,
  });
}

function updateProgress(progress, line) {
  const totalMatch = line.match(/Running\s+(\d+)\s+tests?/i);
  if (totalMatch) progress.total = Number(totalMatch[1]);
  const ordinalMatch = line.match(/\[\s*(\d+)\s*\/\s*(\d+)\s*\]/);
  if (ordinalMatch) {
    progress.completed = Math.max(progress.completed, Number(ordinalMatch[1]));
    progress.total = Number(ordinalMatch[2]);
  }
  const listOrdinalMatch = line.match(/[✓✘-]\s+(\d+)\s+\[/);
  if (listOrdinalMatch) progress.completed = Math.max(progress.completed, Number(listOrdinalMatch[1]));
  for (const key of ['passed', 'failed', 'flaky', 'skipped']) {
    const match = line.match(new RegExp(`(?:^|\\s)(\\d+)\\s+${key}(?:\\s|$)`, 'i'));
    if (match) progress[key] = Number(match[1]);
  }
  const completedFromSummary = ['passed', 'failed', 'flaky', 'skipped']
    .map((key) => progress[key] ?? 0)
    .reduce((sum, count) => sum + count, 0);
  if (completedFromSummary > 0) progress.completed = Math.max(progress.completed, completedFromSummary);
  if (progress.total !== null) progress.completed = Math.min(progress.completed, progress.total);
}

async function authoritativeReleaseForRun(run) {
  return readChecklistRelease(
    join(run.directory, 'checklist', 'manifest.json'),
    'checklist/manifest.json',
  );
}

function applyCompletedRelease(run, release, context = 'Evidence pipeline complete') {
  applyCompletedReleaseEligibility(run.manifest, release, context, FULL_PROJECT_COUNT);
}

function applyPipelineFailure(run, reason) {
  const finishedAt = new Date().toISOString();
  run.manifest.pipeline = {
    status: 'failed',
    completed: false,
    reason,
    finishedAt,
  };
  run.manifest.release = unavailableRelease(`No authoritative release decision is usable because ${reason.toLowerCase()}`);
  run.manifest.status = 'evidence-failed';
  run.manifest.phase = `Evidence pipeline failed · ${reason}`;
}

async function runPostTestStages(run) {
  await executeStage(
    run,
    'videoProcessing',
    'Processing and indexing video evidence',
    resolveToolExecutable('tsx'),
    ['scripts/process-videos.ts', run.directory],
    { AUDIT_ARTIFACT_DIR: run.directory },
  );
  if (run.manifest.stopRequestedAt) return finishStoppedRun(run);

  if (run.manifest.options.aiReview) {
    await executeStage(
      run,
      'aiReview',
      `AI evidence review · ${run.manifest.options.aiModel}`,
      resolveToolExecutable('tsx'),
      ['scripts/analyze-run.ts', '--run-dir', run.directory],
      {
        AUDIT_ARTIFACT_DIR: run.directory,
        ANTHROPIC_MODEL: run.manifest.options.aiModel,
        ...(run.aiApiKey ? { ANTHROPIC_KEY_STDIN: '1' } : {}),
        AI_REVIEW_DRY_RUN: process.env.AI_REVIEW_DRY_RUN,
      },
      { identity: AI_WORKER_IDENTITY, secretInput: run.aiApiKey },
    );
    run.manifest.stages.aiReview.summary = await readAiReviewSummary(run.directory);
    appendEvent(run, 'stage', {
      name: 'aiReview',
      status: run.manifest.stages.aiReview.status,
      label: `AI evidence review · ${run.manifest.options.aiModel}`,
      stage: structuredClone(run.manifest.stages.aiReview),
    });
    await persistManifest(run);
  }
  if (run.manifest.stopRequestedAt) return finishStoppedRun(run);

  await rebuildChecklistInPrivateStaging(
    run,
    'reportRebuild',
    'Rebuilding checklist with final evidence links',
  );
  if (run.manifest.stopRequestedAt) return finishStoppedRun(run);

  const failedStages = ['videoProcessing', 'reportRebuild']
    .filter((stageName) => run.manifest.stages[stageName].status !== 'completed');
  if (failedStages.length > 0) {
    applyPipelineFailure(run, `required stage failure: ${failedStages.join(', ')}`);
  } else {
    try {
      applyCompletedRelease(run, await authoritativeReleaseForRun(run));
    } catch (error) {
      applyPipelineFailure(run, error.message);
    }
  }
  run.manifest.finishedAt = new Date().toISOString();
  await finishRun(run);
}

async function executeStage(run, stageName, label, executable, args, extraEnv, execution = {}) {
  const stage = run.manifest.stages[stageName];
  if (run.manifest.stopRequestedAt) {
    stage.status = 'skipped';
    stage.finishedAt = new Date().toISOString();
    stage.durationMs = 0;
    stage.error = 'Skipped because a reviewer stopped the run.';
    await persistManifest(run);
    return;
  }
  const scriptPath = args[0] ? join(REPOSITORY_ROOT, args[0]) : null;
  if (scriptPath && !(await safeStat(scriptPath))) {
    stage.status = 'skipped';
    stage.startedAt = new Date().toISOString();
    stage.finishedAt = stage.startedAt;
    stage.durationMs = 0;
    stage.error = `Stage script is unavailable: ${args[0]}`;
    appendLog(run, 'stderr', stage.error, stageName);
    await persistManifest(run);
    return;
  }

  run.manifest.phase = label;
  stage.status = 'running';
  stage.startedAt = new Date().toISOString();
  const timeoutMs = stageDeadlineMs(stageName);
  stage.timeoutMs = timeoutMs;
  appendEvent(run, 'stage', { name: stageName, status: 'running', label, stage: structuredClone(stage) });
  appendLog(run, 'stdout', `Command started: ${stage.command.join(' ')}`, stageName);
  await persistManifest(run);
  // A stop request can arrive while the stage-start manifest is being
  // persisted. Recheck at the final await boundary; spawn and run.child
  // registration below are then synchronous, so an acknowledged stop either
  // prevents launch or observes the registered process and terminates it.
  if (run.manifest.stopRequestedAt) {
    stage.status = 'skipped';
    stage.finishedAt = new Date().toISOString();
    stage.durationMs = 0;
    stage.error = 'Skipped because a reviewer stopped the run before launch.';
    appendEvent(run, 'stage', { name: stageName, status: stage.status, label, stage: structuredClone(stage) });
    await persistManifest(run);
    return;
  }

  const started = performance.now();
  const result = await new Promise((resolveStage) => {
    let settled = false;
    let timeoutError = null;
    let escalationTimer = null;
    const identity = execution.identity ?? RUNNER_IDENTITY;
    const hasSecretInput = typeof execution.secretInput === 'string' && execution.secretInput.length > 0;
    appendLog(
      run,
      'stdout',
      `Execution identity: ${identity.active ? `${identity.user} (uid ${identity.uid}, gid ${identity.gid})` : 'portal process (no POSIX worker configured)'}.`,
      stageName,
    );
    const child = spawn(executable, args, {
      cwd: REPOSITORY_ROOT,
      detached: process.platform !== 'win32',
      ...runnerSpawnIdentity(identity),
      env: {
        ...sanitizedChildEnvironment(sanitizedProcessEnvironment(), identity),
        ...extraEnv,
        AUDIT_RUN_ID: run.manifest.id,
        AUDIT_PROFILE: run.manifest.options.profile,
      },
      shell: false,
      stdio: [hasSecretInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (hasSecretInput && child.stdin) {
      child.stdin.on('error', (error) => {
        appendLog(run, 'stderr', `The isolated secret-input pipe closed before delivery completed: ${error.message}`, stageName);
      });
      child.stdin.end(execution.secretInput, 'utf8');
    }
    run.child = child;
    consumeOutput(run, child.stdout, 'stdout', stageName);
    consumeOutput(run, child.stderr, 'stderr', stageName);
    const deadlineTimer = setTimeout(() => {
      timeoutError = `${label} exceeded its ${timeoutMs}ms deadline.`;
      appendLog(run, 'stderr', `${timeoutError} Sending SIGTERM to the process group.`, stageName);
      signalChild(child, 'SIGTERM');
      escalationTimer = setTimeout(() => {
        if (!settled) {
          appendLog(run, 'stderr', `${label} did not stop within ${STOP_GRACE_MS}ms; sending SIGKILL to the process group.`, stageName);
          signalChild(child, 'SIGKILL');
        }
      }, STOP_GRACE_MS);
      escalationTimer.unref();
    }, timeoutMs);
    deadlineTimer.unref();
    const finishStage = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      resolveStage({ ...value, error: value.error ?? timeoutError });
    };
    child.once('error', (error) => {
      finishStage({ code: 127, signal: null, error: error.message });
    });
    child.once('close', (code, signal) => {
      if (process.platform !== 'win32') signalChild(child, 'SIGKILL');
      finishStage({ code, signal, error: null });
    });
  });

  flushOutput(run, stageName);
  run.child = null;
  const elapsedMs = Math.round(performance.now() - started);
  completeStage(stage, result.code, result.signal, result.error, elapsedMs);
  appendLog(
    run,
    result.code === 0 && !result.error ? 'stdout' : 'stderr',
    `Command finished: exit=${result.code ?? 'null'} signal=${result.signal ?? 'none'} duration=${elapsedMs}ms`,
    stageName,
  );
  appendEvent(run, 'stage', {
    name: stageName,
    status: stage.status,
    label,
    stage: structuredClone(stage),
  });
  await persistManifest(run);
}

function stageRecord(status, command) {
  return {
    status,
    command,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    signal: null,
    error: null,
  };
}

function completeStage(stage, exitCode, signal, error = null, durationMs = null) {
  stage.status = exitCode === 0 && !error ? 'completed' : 'failed';
  stage.finishedAt = new Date().toISOString();
  stage.durationMs = durationMs ?? (stage.startedAt
    ? Math.max(0, new Date(stage.finishedAt).getTime() - new Date(stage.startedAt).getTime())
    : 0);
  stage.exitCode = exitCode;
  stage.signal = signal;
  stage.error = error;
}

async function readAiReviewSummary(runDirectory) {
  try {
    const review = JSON.parse(await fs.readFile(join(runDirectory, 'ai-review', 'review.json'), 'utf8'));
    const usage = review.request?.usage ?? review.usage ?? review.api?.usage ?? {};
    const inputTokens = numberOrNull(usage.inputTokens ?? usage.input_tokens);
    const outputTokens = numberOrNull(usage.outputTokens ?? usage.output_tokens);
    return {
      status: stringOrNull(review.status),
      model: stringOrNull(review.model),
      apiStatus: stringOrNull(review.api?.status),
      httpStatus: numberOrNull(review.request?.responseStatus ?? review.httpStatus ?? review.api?.httpStatus ?? review.api?.status),
      latencyMs: numberOrNull(review.request?.latencyMs ?? review.latencyMs ?? review.api?.latencyMs),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: numberOrNull(usage.totalTokens ?? usage.total_tokens)
          ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
      },
    };
  } catch {
    return { status: 'unavailable', model: null, apiStatus: null, httpStatus: null, latencyMs: null, usage: null };
  }
}

function finishStoppedRun(run) {
  run.manifest.status = 'stopped';
  run.manifest.phase = 'Stopped by reviewer';
  run.manifest.finishedAt = new Date().toISOString();
  run.manifest.pipeline = {
    status: 'stopped',
    completed: false,
    reason: 'The evidence pipeline was stopped by a reviewer.',
    finishedAt: run.manifest.finishedAt,
  };
  run.manifest.release = unavailableRelease('No authoritative release decision exists because the run was stopped.');
  return finishRun(run);
}

async function finishRun(run) {
  if (run.killTimer) clearTimeout(run.killTimer);
  clearRunChildDeadline(run);
  run.child = null;
  // Terminal truth must be durable before clients are told that the run is
  // finished or its lifecycle streams are sealed.
  await persistManifest(run);
  appendEvent(run, 'status', {
    status: run.manifest.status,
    message: terminalMessage(run.manifest),
    manifest: publicManifest(run.manifest),
  });
  const streams = [run.logStream, run.lifecycleStream].filter(Boolean);
  await Promise.all(streams.map(closeWritableStream));
  const streamFailure = streams.find((stream) => stream.auditWriteError)?.auditWriteError;
  run.logStream = null;
  run.lifecycleStream = null;
  run.aiApiKey = null;
  if (streamFailure) throw new Error(`Terminal evidence stream could not be sealed: ${streamFailure.message}`);
}

function stageDeadlineMs(stageName) {
  if (stageName === 'videoProcessing') return VIDEO_STAGE_DEADLINE_MS;
  if (stageName === 'aiReview') return AI_STAGE_DEADLINE_MS;
  return REPORT_STAGE_DEADLINE_MS;
}

function armRunChildDeadline(run, label, timeoutMs) {
  clearRunChildDeadline(run);
  run.childTimeoutError = null;
  run.childDeadlineTimer = setTimeout(() => {
    if (!run.child || TERMINAL_STATUSES.has(run.manifest.status)) return;
    run.childTimeoutError = `${label} exceeded its ${timeoutMs}ms deadline.`;
    appendLog(run, 'stderr', `${run.childTimeoutError} Stopping the process group.`, label);
    stopChild(run, run.childTimeoutError);
  }, timeoutMs);
  run.childDeadlineTimer.unref();
}

function clearRunChildDeadline(run) {
  if (run?.childDeadlineTimer) clearTimeout(run.childDeadlineTimer);
  if (run) run.childDeadlineTimer = null;
}

async function runLifecycleCallback(run, label, callback) {
  try {
    await callback();
  } catch (error) {
    await failRunClosed(run, `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function attachRunStreamFailureGuards(run) {
  for (const [streamName, stream] of [['runner log', run.logStream], ['lifecycle log', run.lifecycleStream]]) {
    stream?.on('error', (error) => {
      void failRunClosed(run, `${streamName} write failed: ${error.message}`);
    });
  }
}

async function failRunClosed(run, rawReason) {
  if (!run || run.infrastructureFailure) return;
  const reason = redactLogValue(rawReason).slice(0, 1_000);
  run.infrastructureFailure = reason;
  clearRunChildDeadline(run);
  if (run.child) {
    try {
      stopChild(run, 'Evidence infrastructure failed; stopping active work.');
    } catch (error) {
      console.error(`Could not stop ${run.manifest.id} after infrastructure failure: ${error.message}`);
    }
  }
  const finishedAt = new Date().toISOString();
  run.manifest.status = 'evidence-failed';
  run.manifest.phase = 'Evidence infrastructure failed';
  run.manifest.finishedAt = finishedAt;
  run.manifest.error = reason;
  run.manifest.pipeline = { status: 'failed', completed: false, reason, finishedAt };
  run.manifest.release = unavailableRelease(`No authoritative release decision exists because ${reason.toLowerCase()}`);
  for (const stage of Object.values(run.manifest.stages ?? {})) {
    if (stage?.status !== 'running') continue;
    completeStage(stage, 1, null, reason);
  }
  let persisted = Boolean(run.externalManaged);
  try {
    if (!run.externalManaged) {
      await persistManifest(run);
      persisted = true;
    }
  } catch (error) {
    console.error(`Could not persist fail-closed outcome for ${run.manifest.id}: ${error.message}`);
  }
  if (persisted) {
    const terminal = {
      id: ++run.sequence,
      type: 'status',
      data: {
        status: run.manifest.status,
        message: terminalMessage(run.manifest),
        manifest: publicManifest(run.manifest),
      },
    };
    for (const client of run.clients ?? []) writeSse(client, terminal);
    for (const client of run.galleryClients ?? []) writeSse(client, terminal);
  } else {
    // Do not announce a terminal state that cannot survive restart. Closing
    // streams forces clients to reconnect and prevents a false durable result.
    for (const client of [...(run.clients ?? []), ...(run.galleryClients ?? [])]) client.end();
  }
  await Promise.all([
    closeWritableStream(run.logStream),
    closeWritableStream(run.lifecycleStream),
  ]);
  run.logStream = null;
  run.lifecycleStream = null;
  run.aiApiKey = null;
}

function stopChild(run, reason) {
  const child = run.child;
  if (!child?.pid) return;
  appendLog(run, 'stderr', reason);
  signalChild(child, 'SIGTERM');
  run.killTimer = setTimeout(() => {
    if (run.child) signalChild(run.child, 'SIGKILL');
  }, STOP_GRACE_MS);
  run.killTimer.unref();
}

function signalChild(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function activeSseCount(run) {
  return (run.clients?.size ?? 0) + (run.galleryClients?.size ?? 0);
}

function totalActiveSseCount() {
  let total = 0;
  for (const run of runs.values()) total += activeSseCount(run);
  return total;
}

function publicSseDiagnostics() {
  let runStreams = 0;
  let galleryStreams = 0;
  let heartbeats = 0;
  for (const run of runs.values()) {
    runStreams += run.clients?.size ?? 0;
    galleryStreams += run.galleryClients?.size ?? 0;
    for (const client of [...(run.clients ?? []), ...(run.galleryClients ?? [])]) {
      if (client.auditHeartbeat) heartbeats += 1;
    }
  }
  return {
    schemaVersion: 1,
    runStreams,
    galleryStreams,
    heartbeats,
    totalStreams: runStreams + galleryStreams,
    capacity: { perRun: MAX_SSE_CLIENTS_PER_RUN, server: MAX_SSE_CLIENTS_TOTAL },
    refused: sseCapacityDiagnostics.refused,
    peak: sseCapacityDiagnostics.peak,
  };
}

function assertSseCapacity(run) {
  if (activeSseCount(run) >= MAX_SSE_CLIENTS_PER_RUN || totalActiveSseCount() >= MAX_SSE_CLIENTS_TOTAL) {
    sseCapacityDiagnostics.refused += 1;
    throw httpError(429, 'Live stream capacity is currently full. Use the bounded snapshot and retry later.');
  }
}

function observeSseCapacity() {
  sseCapacityDiagnostics.peak = Math.max(sseCapacityDiagnostics.peak, totalActiveSseCount());
}

function attachSseClient(request, response, clients) {
  let cleaned = false;
  let authorizationPending = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (response.auditHeartbeat) clearInterval(response.auditHeartbeat);
    if (response.auditAuthorizationHeartbeat) clearInterval(response.auditAuthorizationHeartbeat);
    response.auditHeartbeat = null;
    response.auditAuthorizationHeartbeat = null;
    clients.delete(response);
  };
  request.once('close', cleanup);
  response.once('close', cleanup);
  response.once('error', cleanup);
  if (request.destroyed || response.destroyed || response.writableEnded) {
    cleanup();
    return false;
  }
  response.auditHeartbeat = setInterval(() => {
    if (!response.writableNeedDrain && !response.writableEnded) response.write(': heartbeat\n\n');
  }, 15_000);
  if (request.auditSharedReadGuard) {
    response.auditAuthorizationHeartbeat = setInterval(() => {
      if (authorizationPending || response.writableEnded || response.destroyed) return;
      authorizationPending = true;
      void request.auditSharedReadGuard()
        .catch(() => response.destroy())
        .finally(() => { authorizationPending = false; });
    }, SHARED_READ_REAUTH_MS);
  }
  clients.add(response);
  if (request.destroyed || response.destroyed || response.writableEnded) {
    cleanup();
    return false;
  }
  return true;
}

async function streamRunEvents(request, response, run) {
  await request.auditSharedReadGuard?.();
  assertSseCapacity(run);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write('retry: 2000\n\n');
  configureSseClient(response, {
    overflowData: { reason: 'Client backpressure.', reloadLogs: true },
    snapshot: () => ({
      id: run.sequence,
      type: 'snapshot',
      data: { manifest: publicManifest(run.manifest) },
    }),
  });
  const streamUrl = new URL(request.url ?? '/', 'http://portal.local');
  const headerEventId = Number.parseInt(request.headers['last-event-id'] ?? '0', 10) || 0;
  const queryEventId = Number.parseInt(streamUrl.searchParams.get('after') ?? '0', 10) || 0;
  const lastEventId = Math.max(headerEventId, queryEventId);
  const candidates = run.events.filter((event) => event.id > lastEventId);
  const replay = [];
  let replayBytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const event = candidates[index];
    const bytes = sseEventBytes(event);
    if (replay.length > 0 && replayBytes + bytes > MAX_SSE_REPLAY_BYTES) break;
    replay.unshift(event);
    replayBytes += bytes;
  }
  const omitted = candidates.length - replay.length;
  if (omitted > 0) {
    writeSse(response, {
      id: replay[0]?.id ?? run.sequence,
      type: 'overflow',
      data: { dropped: omitted, reason: 'Replay is byte-bounded.', reloadLogs: true },
    });
  }
  for (const event of replay) writeSse(response, event);
  const snapshot = {
    id: ++run.sequence,
    type: 'snapshot',
    data: { manifest: publicManifest(run.manifest) },
  };
  writeSse(response, snapshot);
  if (attachSseClient(request, response, run.clients)) observeSseCapacity();
}

async function streamGalleryEvents(request, response, run) {
  await request.auditSharedReadGuard?.();
  assertSseCapacity(run);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write('retry: 2000\n\n');
  configureSseClient(response, {
    overflowData: { reason: 'Client backpressure.', reloadHead: true },
    snapshot: () => ({
      id: run.sequence,
      type: 'snapshot',
      data: { manifest: galleryStreamManifest(run.manifest), galleryOnly: true },
    }),
  });
  const streamUrl = new URL(request.url ?? '/', 'http://portal.local');
  const headerEventId = Number.parseInt(request.headers['last-event-id'] ?? '0', 10) || 0;
  const queryEventId = Number.parseInt(streamUrl.searchParams.get('after') ?? '0', 10) || 0;
  const lastEventId = Math.max(headerEventId, queryEventId);
  const candidates = run.events.filter((event) => event.id > lastEventId && GALLERY_SSE_EVENT_TYPES.has(event.type));
  const replay = [];
  let replayBytes = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const event = candidates[index];
    const bytes = sseEventBytes(event);
    if (bytes > MAX_GALLERY_SSE_REPLAY_BYTES) continue;
    if (replay.length > 0 && replayBytes + bytes > MAX_GALLERY_SSE_REPLAY_BYTES) break;
    replay.unshift(event);
    replayBytes += bytes;
  }
  const omitted = candidates.length - replay.length;
  if (omitted > 0) writeSse(response, {
    id: replay[0]?.id ?? run.sequence,
    type: 'overflow',
    data: { dropped: omitted, reason: 'Gallery replay is byte-bounded.', reloadHead: true },
  });
  for (const event of replay) writeSse(response, event);
  const snapshot = {
    id: ++run.sequence,
    type: 'snapshot',
    data: { manifest: galleryStreamManifest(run.manifest), galleryOnly: true },
  };
  writeSse(response, snapshot);
  run.galleryClients ??= new Set();
  if (attachSseClient(request, response, run.galleryClients)) observeSseCapacity();
}

function galleryStreamManifest(manifest) {
  return {
    id: manifest.id,
    status: manifest.status,
    phase: manifest.phase ?? null,
    startedAt: manifest.startedAt ?? null,
    finishedAt: manifest.finishedAt ?? null,
    progress: {
      completed: Number(manifest.progress?.completed ?? 0),
      total: Number(manifest.progress?.total ?? 0),
    },
    pipeline: manifest.pipeline ? {
      status: manifest.pipeline.status ?? null,
      completed: Boolean(manifest.pipeline.completed),
    } : null,
  };
}

function appendEvent(run, type, data) {
  const event = { id: ++run.sequence, type, data };
  run.events.push(event);
  run.eventBytes = (run.eventBytes ?? 0) + sseEventBytes(event);
  while (run.events.length > MAX_LOG_EVENTS || run.eventBytes > MAX_EVENT_BUFFER_BYTES) {
    const removed = run.events.shift();
    if (!removed) break;
    run.eventBytes = Math.max(0, run.eventBytes - sseEventBytes(removed));
  }
  if (type !== 'log') {
    run.lifecycleStream?.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
  }
  for (const client of run.clients) writeSse(client, event);
  if (GALLERY_SSE_EVENT_TYPES.has(type)) {
    for (const client of run.galleryClients ?? []) writeSse(client, event);
  }
}

function writeSse(response, event) {
  if (response.writableEnded || response.destroyed) return false;
  if (response.writableNeedDrain || response.auditBackpressured) {
    response.auditDroppedEvents = (response.auditDroppedEvents ?? 0) + 1;
    armSseDrain(response);
    return false;
  }
  const accepted = response.write(serializeSseEvent(event));
  if (!accepted) {
    // Node has accepted this event into its bounded socket buffer. Only later
    // events are collapsed; replaying this event on drain would duplicate it.
    response.auditBackpressured = true;
    armSseDrain(response);
  }
  return accepted;
}

function configureSseClient(response, { overflowData, snapshot }) {
  response.auditDroppedEvents = 0;
  response.auditBackpressured = false;
  response.auditDrainArmed = false;
  response.auditOverflowData = overflowData;
  response.auditSnapshot = snapshot;
}

function armSseDrain(response) {
  if (response.auditDrainArmed || response.writableEnded || response.destroyed) return;
  response.auditDrainArmed = true;
  response.once('drain', () => {
    response.auditDrainArmed = false;
    response.auditBackpressured = false;
    flushSseRecovery(response);
  });
}

function flushSseRecovery(response) {
  if (response.writableEnded || response.destroyed) return;
  const dropped = response.auditDroppedEvents ?? 0;
  if (dropped === 0) return;
  response.auditDroppedEvents = 0;
  const overflowAccepted = response.write(`event: overflow\ndata: ${JSON.stringify({
    dropped,
    ...(response.auditOverflowData ?? { reason: 'Client backpressure.' }),
  })}\n\n`);
  // The authoritative snapshot is deliberately enqueued even if the overflow
  // write fills the socket again. This bounded pair is the recovery contract:
  // omitted log/detail events are followed by the newest durable run state.
  const snapshot = response.auditSnapshot?.();
  const snapshotAccepted = snapshot ? response.write(serializeSseEvent(snapshot)) : true;
  if (!overflowAccepted || !snapshotAccepted) {
    response.auditBackpressured = true;
    armSseDrain(response);
  }
}

function serializeSseEvent(event) {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function sseEventBytes(event) {
  return Buffer.byteLength(serializeSseEvent(event));
}

async function servePortalAsset(request, response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (CONSOLE_SHELL_FIXTURE_RELATIVE_PATHS.has(relativePath)) throw httpError(404, 'Not found.');
  const file = safeResolve(STATIC_ROOT, relativePath);
  if (!file) throw httpError(404, 'Not found.');
  return sendFile(request, response, file, "default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

async function serveArtifact(request, response, runId, requestedPath) {
  const run = requireRun(runId);
  return serveArtifactFromDirectory(request, response, run.directory, requestedPath);
}

async function serveArtifactFromDirectory(request, response, artifactRoot, requestedPath) {
  // Persisted execution logs can contain arbitrary child-process output. They
  // are available only through the bounded, redacting logs API and must never
  // inherit the generic artifact download path.
  if (isRawLogArtifactPath(requestedPath)) throw httpError(404, 'Artifact not found.');
  const artifactOrigin = `http://${assertAllowedRequestHost(request)}`;
  let opened;
  try {
    opened = await openContainedArtifactFile(fs, artifactRoot, requestedPath, {
      requireDescriptorContainment: CREDENTIAL_ISOLATION_ACTIVE,
    });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EINVAL', 'UNSAFE_ARTIFACT_PATH'].includes(error?.code)) {
      throw httpError(404, 'Artifact not found.');
    }
    throw error;
  }
  try {
    const verifiedFile = opened.path;
    const relativeArtifactPath = opened.relativePath;
    // Revision-pinned archive wrappers are inert data envelopes loaded into a
    // second sandboxed opaque-origin iframe. They must accept that opaque parent;
    // every other artifact document retains frame-ancestors 'self'.
    const opaqueArchiveWrapper = /(?:^|\/)checklist\/gallery\/revisions\/export_[a-f0-9]{16}\/(?:flags\.html|(?:query|items|raw)\/.+\.html)$/.test(relativeArtifactPath);
    const opaqueArchiveSurface = /(?:^|\/)checklist\/gallery\.html$/.test(relativeArtifactPath);
    const sandboxSources = opaqueArchiveSurface
      ? `default-src 'self' data: blob:; connect-src 'self'; img-src 'self' data: blob: ${artifactOrigin}; media-src 'self' data: blob: ${artifactOrigin}; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-src 'self' blob: ${artifactOrigin}; font-src 'self' data:; base-uri 'none'`
      : "default-src 'self' data: blob:; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-src 'self' blob:; font-src 'self' data:; base-uri 'none'";
    const artifactExtension = extname(verifiedFile).toLowerCase();
    const downloadOnly = Boolean(sharedRequestAuthorizer)
      && new Set(['.htm', '.html', '.js', '.mjs', '.pdf', '.svg', '.xhtml', '.xml']).has(artifactExtension);
    const activeContentIsolation = downloadOnly
      ? "default-src 'none'; frame-ancestors 'none'; sandbox"
      : artifactExtension === '.html'
      ? `sandbox allow-scripts allow-forms allow-downloads allow-popups; ${sandboxSources}${opaqueArchiveWrapper ? '' : "; frame-ancestors 'self'"}`
      : "default-src 'none'; frame-ancestors 'self'";
    const opaqueArchiveModule = /(?:^|\/)checklist\/assets\/gallery-(?:archive|core)\.js$/.test(relativeArtifactPath);
    const transfer = sendFile(request, response, verifiedFile, activeContentIsolation, {
      opaqueArchiveModule: opaqueArchiveModule && !downloadOnly,
      downloadOnly,
      opened,
    });
    opened = null;
    return await transfer;
  } finally {
    await opened?.handle?.close().catch(() => undefined);
  }
}

async function sendFile(request, response, file, contentSecurityPolicy, {
  opaqueArchiveModule = false,
  downloadOnly = false,
  opened = null,
  contentType = null,
  etag = null,
} = {}) {
  let handle = opened?.handle;
  let stat = opened?.stat;
  if (!handle) {
    try {
      handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) throw httpError(404, 'File not found.');
      throw error;
    }
  }
  let stream = null;
  let closeStarted = false;
  let resolveClosed;
  const closed = new Promise((resolveClose) => { resolveClosed = resolveClose; });
  const closeOwnedHandle = () => {
    if (closeStarted) return closed;
    closeStarted = true;
    stream?.destroy();
    void handle.close().catch(() => undefined).finally(resolveClosed);
    return closed;
  };
  // Own the descriptor before any further await or response setup. Browser
  // media preload requests commonly disconnect after reading metadata; a late
  // `close` listener misses that event and leaves autoClose:false handles for GC.
  response.once('finish', closeOwnedHandle);
  response.once('close', closeOwnedHandle);
  try {
    if (response.destroyed || response.writableEnded) {
      await closeOwnedHandle();
      return;
    }
    stat ??= await handle.stat();
    if (response.destroyed || response.writableEnded) {
      await closeOwnedHandle();
      return;
    }
    if (!stat.isFile()) throw httpError(404, 'File not found.');
    const range = parseByteRange(request.headers.range, stat.size);
    const headers = {
      'Content-Type': contentType ?? MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': range ? range.end - range.start + 1 : stat.size,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': contentSecurityPolicy,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (downloadOnly) {
      const downloadName = basename(file).replace(/["\\\r\n]/gu, '_') || 'artifact.bin';
      headers['Content-Disposition'] = `attachment; filename="${downloadName}"`;
    }
    if (etag) headers.ETag = etag;
    if (opaqueArchiveModule) {
      // Archive HTML intentionally has an opaque origin so it cannot inherit
      // portal authority. Only these inert, generated module assets opt into
      // CORS; run data and mutation APIs remain unavailable to that origin.
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
    }
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    const injectedDelay = process.env.PORTAL_E2E_FAILURE_INJECTION === '1'
      ? Number(request.headers['x-portal-e2e-send-file-delay-ms'] ?? 0)
      : 0;
    if (Number.isInteger(injectedDelay) && injectedDelay > 0 && injectedDelay <= 1_000) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, injectedDelay));
    }
    if (response.destroyed || response.writableEnded) {
      await closeOwnedHandle();
      return;
    }
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === 'HEAD') {
      response.end();
      await closeOwnedHandle();
      return;
    }
    stream = handle.createReadStream({ ...(range ?? {}), autoClose: false });
    stream.once('error', () => {
      if (!response.destroyed) response.destroy();
      void closeOwnedHandle();
    });
    stream.once('end', closeOwnedHandle);
    stream.once('close', closeOwnedHandle);
    stream.pipe(response);
    await closed;
  } catch (error) {
    await closeOwnedHandle();
    if (response.destroyed || response.writableEnded) return;
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) throw httpError(404, 'File not found.');
    throw error;
  } finally {
    response.off('finish', closeOwnedHandle);
    response.off('close', closeOwnedHandle);
  }
}

async function listArtifacts(runDirectory, runId, offset, limit, request, artifactBase = '/artifacts') {
  const index = await artifactIndex(runDirectory, offset);
  await extendArtifactIndex(index, offset + limit + 1, request);
  const selectedPaths = index.paths.slice(offset, offset + limit);
  const files = [];
  for (const path of selectedPaths) {
    if (request.destroyed) throw httpError(499, 'Artifact request was cancelled.');
    const absolutePath = join(runDirectory, ...path.split('/'));
    const stat = await safeStat(absolutePath);
    // Playwright writes active recordings into hidden staging directories and
    // moves them into their final test directory when the attempt finishes.
    // A staging file can disappear between indexing and a reviewer click, so
    // never advertise it as durable evidence. Empty files are still being
    // written (or are unusable evidence) and are omitted for the same reason.
    if (!stat?.isFile() || stat.size === 0 || ignoredArtifactPath(path)) continue;
    const mediaRecord = index.validatedMediaRecords?.get(path);
    files.push({
      path,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      kind: artifactKind(path),
      url: `${artifactBase}/${encodeURIComponent(runId)}/${path.split('/').map(encodeURIComponent).join('/')}`,
      ...(mediaRecord ? { evidenceRole: mediaRecord.evidenceRole } : {}),
    });
  }
  const nextOffset = offset + selectedPaths.length;
  return {
    files,
    total: index.paths.length,
    knownTotal: index.paths.length,
    totalComplete: index.complete,
    offset,
    limit,
    nextOffset,
    hasMore: nextOffset < index.paths.length || !index.complete,
  };
}

async function artifactIndex(runDirectory, offset) {
  let index = artifactPathCache.get(runDirectory);
  const staleFirstPage = offset === 0 && index && Date.now() - index.createdAt > 2_000;
  if (!index || staleFirstPage) {
    index = {
      runDirectory,
      paths: [],
      seen: new Set(),
      validatedMediaPaths: new Set(),
      validatedMediaRecords: new Map(),
      videoManifestSchemaVersion: null,
      directories: [''],
      directoryOffset: 0,
      currentEntries: null,
      currentEntryOffset: 0,
      complete: false,
      createdAt: Date.now(),
    };
    for (const preferred of [
      'checklist/index.html',
      'playwright-html/index.html',
      'ai-review/index.html',
      'sharded-run.json',
      'merge-lifecycle.json',
      'video-manifest.json',
      'results.json',
      'run.json',
    ]) {
      if ((await safeStat(join(runDirectory, ...preferred.split('/'))))?.isFile()) {
        addArtifactPath(index, preferred);
      }
    }
    const preferredMedia = await preferredMediaArtifactPaths(runDirectory);
    index.videoManifestSchemaVersion = preferredMedia.schemaVersion;
    index.validatedMediaPaths = new Set(preferredMedia.paths);
    index.validatedMediaRecords = preferredMedia.records;
    for (const mediaPath of preferredMedia.paths) {
      addArtifactPath(index, mediaPath);
    }
    artifactPathCache.set(runDirectory, index);
  }
  return index;
}

async function preferredMediaArtifactPaths(runDirectory) {
  const manifestStat = await safeStat(join(runDirectory, 'video-manifest.json'));
  const cached = preferredMediaValidationCache.get(runDirectory);
  if (cached
    && manifestStat?.isFile()
    && cached.manifestMtimeMs === manifestStat.mtimeMs
    && cached.manifestBytes === manifestStat.size
    && await preferredMediaRecordsUnchanged(runDirectory, cached.result.records)) {
    return cached.result;
  }
  const result = await validatePreferredMediaManifest(runDirectory, {
    maximumBytes: MAX_VIDEO_MANIFEST_BYTES,
    maximumArtifacts: MAX_PREFERRED_MEDIA_ARTIFACTS,
  });
  if (manifestStat?.isFile() && result.errors.length === 0) {
    preferredMediaValidationCache.set(runDirectory, {
      manifestMtimeMs: manifestStat.mtimeMs,
      manifestBytes: manifestStat.size,
      result,
    });
  } else {
    preferredMediaValidationCache.delete(runDirectory);
  }
  return result;
}

async function preferredMediaRecordsUnchanged(runDirectory, records) {
  for (const record of records.values()) {
    const path = safeResolve(runDirectory, record.path);
    const stat = path ? await safeStat(path) : null;
    if (!stat?.isFile() || stat.size !== record.bytes || stat.mtimeMs !== record.mtimeMs) return false;
  }
  return true;
}

async function extendArtifactIndex(index, targetCount, request) {
  while (!index.complete && index.paths.length < targetCount) {
    if (request.destroyed) throw httpError(499, 'Artifact request was cancelled.');
    if (!index.currentEntries) {
      if (index.directoryOffset >= index.directories.length) {
        index.complete = true;
        break;
      }
      const directory = index.directories[index.directoryOffset++];
      const absoluteDirectory = directory
        ? join(index.runDirectory, ...directory.split('/'))
        : index.runDirectory;
      try {
        index.currentEntries = (await fs.readdir(absoluteDirectory, { withFileTypes: true }))
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
        index.currentEntries = [];
      }
      index.currentDirectory = directory;
      index.currentEntryOffset = 0;
    }
    if (index.currentEntryOffset >= index.currentEntries.length) {
      index.currentEntries = null;
      index.currentDirectory = null;
      continue;
    }
    const entry = index.currentEntries[index.currentEntryOffset++];
    if (entry.isSymbolicLink()) continue;
    const path = index.currentDirectory ? `${index.currentDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) index.directories.push(path);
    else if (entry.isFile()) addArtifactPath(index, path);
  }
}

function addArtifactPath(index, path) {
  // Files under Playwright's raw result tree are implementation artifacts
  // until the media processor has accepted them into video-manifest.json.
  // This prevents helper pages (for example axe's short about:blank page)
  // and incomplete attempt recordings from appearing as reviewer evidence.
  if (isUnvalidatedVideoArtifact(index, path)) return;
  if (index.seen.has(path) || ignoredArtifactPath(path)) return;
  index.seen.add(path);
  index.paths.push(path);
}

function isUnvalidatedVideoArtifact(index, value) {
  const normalized = String(value);
  const extension = extname(normalized).toLowerCase();
  if (extension !== '.webm' && extension !== '.mp4') return false;
  if (index.videoManifestSchemaVersion !== null) {
    return index.videoManifestSchemaVersion !== 2 || !index.validatedMediaPaths?.has(normalized);
  }
  if (!normalized.split('/').includes('raw')) return false;
  return !index.validatedMediaPaths?.has(normalized);
}

function ignoredArtifactPath(value) {
  const segments = String(value).split('/');
  return isRawLogArtifactPath(value) || segments.some((segment) =>
    segment === '.DS_Store'
    || segment === '.last-run.json'
    || segment.startsWith('.playwright-artifacts-')
    || segment.endsWith('.tmp')
    || segment.endsWith('.partial'));
}

function isRawLogArtifactPath(value) {
  const segments = String(value).replaceAll('\\', '/').split('/').filter(Boolean);
  return segments.includes('logs') || segments.some((segment) => segment.toLowerCase().endsWith('.log'));
}

function artifactKind(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.webm' || extension === '.mp4') return 'video';
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(extension)) return 'image';
  if (extension === '.zip') return 'trace';
  if (path.endsWith('checklist/index.html')) return 'checklist';
  if (path.endsWith('playwright-html/index.html')) return 'playwright-report';
  if (path.endsWith('ai-review/index.html')) return 'ai-review';
  if (extension === '.json') return 'data';
  if (extension === '.html') return 'report';
  return 'file';
}

async function readBoundedReportJson(run, relativePath, maximumBytes, requestedRevision = null) {
  const dataRoot = join(run.directory, 'checklist', 'data');
  const currentPointer = await safeStat(join(dataRoot, 'current.json'));
  if (currentPointer?.isFile() || requestedRevision !== null) {
    let publication;
    try {
      publication = await loadReportPublication(run.directory, requestedRevision, {
        maximumPointerBytes: 1024 * 1024,
      });
    } catch (error) {
      throw httpError(422, `Compact report publication is invalid: ${error.message}`);
    }
    const expected = publication.files[relativePath];
    const path = safeResolve(publication.revisionDirectory, relativePath);
    if (!expected || !path) throw httpError(404, 'Compact report data is not part of this publication.');
    const stat = await safeStat(path);
    if (!stat?.isFile()) throw httpError(422, 'Compact report publication data is missing.');
    const cached = reportDataCache.get(path);
    if (cached?.mtimeMs === stat.mtimeMs
      && cached.size === stat.size
      && cached.sha256 === expected.sha256) return structuredClone(cached.value);
    let published;
    try {
      published = await readPublishedReportJson(publication, relativePath, maximumBytes);
    } catch (error) {
      throw httpError(422, `Compact report publication is invalid: ${error.message}`);
    }
    reportDataCache.delete(path);
    reportDataCache.set(path, {
      mtimeMs: published.mtimeMs,
      size: published.bytes,
      sha256: published.sha256,
      value: published.document,
    }, published.bytes);
    return structuredClone(published.document);
  }

  // Compatibility only for historical runs created before revision-bound
  // publication. New terminal release evidence requires current.json.
  return readLegacyBoundedReportJson(run, relativePath, maximumBytes);
}

async function readLegacyBoundedReportJson(run, relativePath, maximumBytes) {
  const path = safeResolve(join(run.directory, 'checklist', 'data'), relativePath);
  if (!path) throw httpError(404, 'Compact report data not found.');
  const stat = await safeStat(path);
  if (!stat?.isFile()) throw httpError(404, 'Compact report data is not available for this run.');
  if (stat.size > maximumBytes) {
    throw httpError(413, `Compact report data exceeds its ${formatLogBytes(maximumBytes)} safety limit.`);
  }
  const verifiedPath = await resolveContainedRealPath(run.directory, path);
  if (!verifiedPath) throw httpError(404, 'Compact report data not found.');
  const cached = reportDataCache.get(verifiedPath);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return structuredClone(cached.value);
  let value;
  try {
    value = JSON.parse(await fs.readFile(verifiedPath, 'utf8'));
  } catch (error) {
    throw httpError(422, `Compact report data is invalid: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(422, 'Compact report data must be a JSON object.');
  }
  reportDataCache.delete(verifiedPath);
  reportDataCache.set(verifiedPath, { mtimeMs: stat.mtimeMs, size: stat.size, value }, stat.size);
  return structuredClone(value);
}

async function singleSiteReportRun(jobId) {
  const state = await readSingleSiteJob(singleSiteQueue, jobId);
  const finalization = await readSingleSiteFinalizationStatus(SINGLE_SITE_FINALIZATION_ROOT, jobId)
    .catch(() => null);
  if (!finalization || !['complete', 'incomplete'].includes(finalization.status)) {
    throw httpError(409, 'The deterministic Single-site report is still being finalized or failed integrity validation.');
  }
  const directory = resolve(SINGLE_SITE_FINALIZATION_ROOT, state.jobId, 'report');
  if (directory !== SINGLE_SITE_FINALIZATION_ROOT && !directory.startsWith(`${SINGLE_SITE_FINALIZATION_ROOT}${sep}`)) {
    throw httpError(404, 'Single-site report directory is invalid.');
  }
  let publication;
  try {
    publication = await loadSingleSiteReportPublication(directory, finalization.reportRevision);
  } catch (error) {
    throw httpError(422, `Single-site report publication is invalid: ${error.message}`);
  }
  if (publication.publicationRevision !== finalization.reportRevision
    || publication.publicationDigest !== finalization.reportPublicationDigest) {
    throw httpError(422, 'Single-site report publication does not match its digest-bound finalization status.');
  }
  return {
    directory,
    manifest: { id: state.jobId },
    reportRevision: finalization.reportRevision,
    reportPublicationDigest: finalization.reportPublicationDigest,
  };
}

async function loadPortalSingleSiteGallery(jobId, request, signal) {
  const state = await readSingleSiteJob(singleSiteQueue, jobId);
  const finalization = await readSingleSiteFinalizationStatus(SINGLE_SITE_FINALIZATION_ROOT, jobId);
  if (!['complete', 'incomplete'].includes(finalization.status)) {
    throw httpError(409, 'The Single-site gallery is still being finalized or is unavailable.');
  }
  if (typeof state.attemptId !== 'string' || state.attemptId.length < 1) {
    throw httpError(409, 'The finalized Single-site run has no authoritative attempt binding.');
  }
  return openSingleSiteGallery({
    finalizationRoot: SINGLE_SITE_FINALIZATION_ROOT,
    jobId,
    attemptId: state.attemptId,
    bindings: {
      ...finalization,
      attemptId: state.attemptId,
    },
    baselineStore: visualBaselineStore,
    reviewStore: visualReviewStore,
    auditCatalog: catalog,
    mutationAuthorized: operatorRequestAuthorized(request),
    signal,
  });
}

function singleSiteRequestedReportRevision(run, requestUrl) {
  const requested = reportRevision(requestUrl);
  if (requested !== null && requested !== run.reportRevision) {
    throw httpError(409, 'Requested Single-site report revision is not the revision bound to finalization status.');
  }
  return run.reportRevision;
}

async function filterSingleSiteReportAudits(run, input, requestUrl) {
  const revision = singleSiteRequestedReportRevision(run, requestUrl);
  const summary = await readBoundedReportJson(run, 'summary.json', MAX_REPORT_SUMMARY_BYTES, revision);
  if (summary.mode !== 'single-site' || !summary.auditPages || !Number.isSafeInteger(summary.auditPages.pageCount)
    || summary.auditPages.pageCount < 0 || summary.auditPages.pageCount > 1_000) {
    throw httpError(422, 'Single-site report audit page metadata is invalid.');
  }
  const definitions = new Map((input.coverageManifest?.selectedDefinitions ?? [])
    .map((definition) => [definition.auditId, definition]));
  const rows = [];
  for (let page = 1; page <= summary.auditPages.pageCount; page += 1) {
    const document = await readBoundedReportJson(
      run,
      `audits/page-${String(page).padStart(6, '0')}.json`,
      MAX_REPORT_AUDIT_INDEX_BYTES,
      revision,
    );
    if (document.mode !== 'single-site' || !Array.isArray(document.items)) {
      throw httpError(422, `Single-site audit report page ${page} is invalid.`);
    }
    for (const row of document.items) {
      const definition = definitions.get(row.id);
      rows.push({
        ...row,
        severity: definition?.severity ?? 'P3',
        userPromise: definition?.standaloneOracle?.expected ?? row.detail,
        reason: row.detail,
        releaseBlocking: false,
        evidenceCounts: {
          video: 0,
          screenshot: 0,
          total: row.artifactCount,
        },
      });
    }
  }
  if (rows.length !== summary.auditPages.total) {
    throw httpError(422, 'Single-site audit report pages disagree with the summary count.');
  }
  const offset = queryInteger(requestUrl.searchParams.get('offset'), 'offset', 0, 0, 1_000_000);
  const limit = queryInteger(requestUrl.searchParams.get('limit'), 'limit', 25, 1, 100);
  const status = reportFilter(requestUrl, 'status', 40)?.toUpperCase() ?? null;
  const severity = reportFilter(requestUrl, 'severity', 20)?.toUpperCase() ?? null;
  const area = reportFilter(requestUrl, 'area', 80)?.toLowerCase() ?? null;
  const query = reportFilter(requestUrl, 'q', 160)?.toLowerCase() ?? null;
  const manualRaw = requestUrl.searchParams.get('manual');
  if (manualRaw !== null && !['true', 'false'].includes(manualRaw)) throw httpError(400, 'manual must be true or false.');
  const manual = manualRaw === null ? null : manualRaw === 'true';
  const matches = rows.filter((row) => {
    if (status && row.status !== status) return false;
    if (severity && row.severity !== severity) return false;
    if (area && String(row.area).toLowerCase() !== area) return false;
    if (manual !== null && row.manual !== manual) return false;
    if (query && ![row.id, row.title, row.detail, row.userPromise].join(' ').toLowerCase().includes(query)) return false;
    return true;
  });
  const items = matches.slice(offset, offset + limit);
  return {
    schemaVersion: 1,
    mode: 'single-site',
    publicationRevision: summary.publicationRevision,
    items,
    total: matches.length,
    offset,
    limit,
    hasMore: offset + items.length < matches.length,
    filters: {
      statuses: [...new Set(rows.map(({ status: value }) => value))].sort(),
      severities: [...new Set(rows.map(({ severity: value }) => value))].sort(),
      areas: [...new Set(rows.map(({ area: value }) => value))].sort(),
    },
  };
}

async function filterReportAudits(run, requestUrl) {
  const document = await readBoundedReportJson(
    run,
    'audits.json',
    MAX_REPORT_AUDIT_INDEX_BYTES,
    reportRevision(requestUrl),
  );
  const rows = Array.isArray(document.items) ? document.items : [];
  if (rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw httpError(422, 'Compact report audit rows are invalid.');
  }
  const offset = queryInteger(requestUrl.searchParams.get('offset'), 'offset', 0, 0, 1_000_000);
  const limit = queryInteger(requestUrl.searchParams.get('limit'), 'limit', 25, 1, 100);
  const status = reportFilter(requestUrl, 'status', 40)?.toUpperCase() ?? null;
  const severity = reportFilter(requestUrl, 'severity', 20)?.toUpperCase() ?? null;
  const area = reportFilter(requestUrl, 'area', 80)?.toLowerCase() ?? null;
  const environment = reportFilter(requestUrl, 'environment', 80)?.toLowerCase() ?? null;
  const query = reportFilter(requestUrl, 'q', 160)?.toLowerCase() ?? null;
  const releaseBlockingRaw = requestUrl.searchParams.get('releaseBlocking');
  if (releaseBlockingRaw !== null && !['true', 'false'].includes(releaseBlockingRaw)) {
    throw httpError(400, 'releaseBlocking must be true or false.');
  }
  const releaseBlocking = releaseBlockingRaw === null ? null : releaseBlockingRaw === 'true';
  const manualRaw = requestUrl.searchParams.get('manual');
  if (manualRaw !== null && !['true', 'false'].includes(manualRaw)) {
    throw httpError(400, 'manual must be true or false.');
  }
  const manual = manualRaw === null ? null : manualRaw === 'true';
  const matches = rows.filter((row) => {
    if (status && String(row.status ?? '').toUpperCase() !== status) return false;
    if (severity && String(row.severity ?? row.definition?.severity ?? '').toUpperCase() !== severity) return false;
    if (area && String(row.area ?? row.definition?.area ?? '').toLowerCase() !== area) return false;
    if (releaseBlocking !== null && Boolean(row.releaseBlocking ?? row.definition?.releaseBlocking) !== releaseBlocking) return false;
    if (manual !== null && Boolean(row.manual ?? row.definition?.manual) !== manual) return false;
    if (environment) {
      const environments = Array.isArray(row.environments)
        ? row.environments
        : row.environmentStatus && typeof row.environmentStatus === 'object'
          ? Object.keys(row.environmentStatus)
          : [row.environment];
      if (!environments.some((value) => String(value ?? '').toLowerCase() === environment)) return false;
    }
    if (query) {
      const haystack = [
        row.id,
        row.title,
        row.reason,
        row.userPromise,
        row.expected,
        row.definition?.title,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
  const items = matches.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    schemaVersion: document.schemaVersion ?? 1,
    publicationRevision: document.publicationRevision ?? null,
    generatedAt: document.generatedAt ?? null,
    items,
    total: matches.length,
    offset,
    limit,
    nextOffset,
    hasMore: nextOffset < matches.length,
    filters: { status, severity, area, environment, releaseBlocking, manual, q: query },
  };
}

function reportRevision(requestUrl) {
  const value = requestUrl.searchParams.get('revision');
  if (value === null || value === '') return null;
  if (!/^[a-f0-9]{32}$/.test(value)) throw httpError(400, 'Report revision is invalid.');
  return value;
}

function reportFilter(requestUrl, name, maximumLength) {
  const value = requestUrl.searchParams.get(name);
  if (value === null || value.trim() === '') return null;
  const normalized = value.trim();
  if (normalized.length > maximumLength || /[\u0000-\u001f]/.test(normalized)) {
    throw httpError(400, `${name} filter is invalid.`);
  }
  return normalized;
}

async function loadPluginRegistry(coreDefinitions) {
  const registryPath = join(REPOSITORY_ROOT, 'audit', 'plugins.generated.json');
  let document;
  try {
    document = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`Installed test plugin registry is invalid: ${error.message}`);
  }
  return validatePortalPluginRegistryDocument(document, {
    coreDefinitions,
    projectIds: PROJECT_IDS,
    localTargets: PROJECTS,
    resolveEntrySpec: (spec) => Boolean(safeResolve(REPOSITORY_ROOT, spec)),
  });
}

async function syncExternalShardedRuns() {
  if (externalRunSyncPromise) return externalRunSyncPromise;
  externalRunSyncPromise = refreshExternalShardedRuns().finally(() => {
    externalRunSyncPromise = null;
  });
  return externalRunSyncPromise;
}

function triggerExternalShardedRunSync() {
  void syncExternalShardedRuns().catch((error) => {
    console.error(`Could not refresh externally launched runs: ${error.message}`);
  });
}

async function syncExternalShardedRunForRead(id) {
  const existing = runs.get(id);
  if (existing) {
    if (existing.externalManaged
      && Date.now() >= (existing.externalState.nextRefreshAt ?? 0)) {
      triggerExternalShardedRunSync();
    }
    return;
  }
  // Unknown IDs receive one authoritative discovery pass before returning a
  // 404. Known runs use their cached manifest immediately while SSE/background
  // refresh publishes the next snapshot.
  await syncExternalShardedRuns();
}

async function refreshExternalShardedRuns() {
  const startedAt = performance.now();
  const budget = {
    remainingBytes: MAX_EXTERNAL_REFRESH_BYTES,
    deadline: startedAt + MAX_EXTERNAL_REFRESH_MS,
    bytesRead: 0,
    filesVisited: 0,
    skippedBytes: 0,
  };
  externalRunSyncDiagnostics = { ...externalRunSyncDiagnostics, status: 'running' };
  try {
    let entries;
    try {
      entries = await fs.readdir(SHARDED_ARTIFACT_ROOT, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
      if (purgingRunIds.has(entry.name)) continue;
      const directory = join(SHARDED_ARTIFACT_ROOT, entry.name);
      const existing = runs.get(entry.name);
      if (existing?.purgeQuarantine) continue;
      if (existing && !existing.externalManaged) continue;
      // A known external run already proved its discovery markers when it was
      // admitted. Honor its refresh deadline before touching those files so
      // high-frequency gallery reads do not turn an immutable terminal run
      // into a background stat storm.
      if (existing && Date.now() < (existing.externalState.nextRefreshAt ?? 0)) continue;
      const discoverable = await Promise.all([
        safeStat(join(directory, 'logs', 'coordinator.log')),
        safeStat(join(directory, 'sharded-run.json')),
        safeStat(join(directory, 'merge-lifecycle.json')),
        safeStat(join(directory, 'sharded-heartbeat.json')),
      ]).then((stats) => stats.some((stat) => stat?.isFile()));
      if (!discoverable) continue;
      const run = existing ?? await createExternalRun(entry.name, directory);
      await refreshExternalRun(run, !existing, budget);
      run.externalState.nextRefreshAt = Date.now() + (
        TERMINAL_STATUSES.has(run.manifest.status) && !run.externalState.leaseFailed
          ? EXTERNAL_TERMINAL_REFRESH_MS
          : EXTERNAL_RUN_SYNC_MS
      );
      if (!existing) runs.set(entry.name, run);
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    }
  } finally {
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    externalRunSyncDiagnostics = {
      status: 'idle',
      finishedAt: new Date().toISOString(),
      durationMs,
      bytesRead: budget.bytesRead,
      filesVisited: budget.filesVisited,
      skippedBytes: budget.skippedBytes,
      budgetExhausted: budget.remainingBytes <= 0 || performance.now() >= budget.deadline,
    };
    if (durationMs > MAX_EXTERNAL_REFRESH_MS * 2) {
      console.warn(`[portal external sync] ${JSON.stringify(externalRunSyncDiagnostics)}`);
    }
  }
}

async function createExternalRun(id, directory) {
  const stat = await fs.stat(directory);
  const createdAt = stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : stat.mtime.toISOString();
  return {
    directory,
    externalManaged: true,
    manifest: {
      schemaVersion: 1,
      id,
      status: 'running',
      phase: 'Discovering externally launched sharded run',
      createdAt,
      startedAt: null,
      finishedAt: null,
      stopRequestedAt: null,
      exitCode: null,
      signal: null,
      externalManaged: true,
      source: 'external-sharded',
      options: {
        profile: 'release',
        projects: [...targetRegistry.defaultTargetIds],
        targetIds: [...targetRegistry.defaultTargetIds],
        pluginIds: plugins.map(({ id: pluginId }) => pluginId),
        areas: [],
        auditIds: [],
        productionUrl: process.env.PRODUCTION_URL ?? 'https://quitting7oh.org',
        candidateUrl: process.env.CANDIDATE_URL ?? 'https://beta.quitting7oh-org.pages.dev',
        candidateIgnoreHTTPSErrors: false,
        aiReview: false,
        aiModel: DEFAULT_AI_MODEL,
      },
      command: ['npm', 'run', 'audit:release:sharded'],
      artifactPath: relative(REPOSITORY_ROOT, directory),
      progress: { total: null, completed: 0, passed: null, failed: null, flaky: null, skipped: null },
      reviewReasons: [],
      executionProvenance: canonicalExecutionProvenance(),
      pipeline: {
        status: 'running',
        completed: false,
        reason: 'An externally launched sharded browser and evidence pipeline is running.',
        finishedAt: null,
      },
      release: pendingRelease(),
      stages: {},
    },
    child: null,
    clients: new Set(),
    events: [],
    sequence: 0,
    logStream: null,
    lifecycleStream: null,
    lineBuffer: { stdout: '', stderr: '' },
    killTimer: null,
    aiApiKey: null,
    externalState: {
      fileOffsets: new Map(),
      partialLines: new Map(),
      omittedLineCharacters: new Map(),
      decoders: new Map(),
      commands: new Map(),
      mergeStages: new Map(),
      shardProgress: new Map(),
      performanceExpectedExecutions: null,
      started: null,
      lifecycleCache: new Map(),
      lastActivityMs: stat.mtimeMs,
      nextRefreshAt: 0,
      leaseFailed: false,
    },
  };
}

async function refreshExternalRun(run, initial, budget) {
  const before = JSON.stringify({
    status: run.manifest.status,
    phase: run.manifest.phase,
    progress: run.manifest.progress,
    stages: run.manifest.stages,
    pipeline: run.manifest.pipeline,
    release: run.manifest.release,
  });
  const logFiles = await externalLogFiles(run.directory);
  const completedOnDiscovery = initial && Boolean(await safeStat(join(run.directory, 'sharded-run.json')));
  for (const logPath of logFiles) {
    if (budget.remainingBytes <= 0 || performance.now() >= budget.deadline) break;
    await consumeExternalLogFile(run, logPath, !initial, completedOnDiscovery, budget);
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  }
  await refreshExternalManifest(run);
  const after = JSON.stringify({
    status: run.manifest.status,
    phase: run.manifest.phase,
    progress: run.manifest.progress,
    stages: run.manifest.stages,
    pipeline: run.manifest.pipeline,
    release: run.manifest.release,
  });
  upsertComparativeConsoleRun(run);
  if (!initial && before !== after) {
    appendEvent(run, 'snapshot', { manifest: publicManifest(run.manifest) });
    if (TERMINAL_STATUSES.has(run.manifest.status)) {
      appendEvent(run, 'status', {
        status: run.manifest.status,
        message: terminalMessage(run.manifest),
        manifest: publicManifest(run.manifest),
      });
    }
  }
}

async function externalLogFiles(directory) {
  const logDirectory = join(directory, 'logs');
  let entries;
  try {
    entries = await fs.readdir(logDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const priority = (name) => name === 'coordinator.log' ? 0
    : name === 'build.log' ? 1
      : name.startsWith('shard-') ? 2
        : name === 'performance.log' ? 3
          : name === 'merge.log' ? 4 : 5;
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
    .map((entry) => join(logDirectory, entry.name))
    .sort((left, right) => priority(basename(left)) - priority(basename(right)) || left.localeCompare(right));
}

async function consumeExternalLogFile(run, path, emit, completedOnDiscovery = false, budget) {
  budget.filesVisited += 1;
  const stat = await safeStat(path);
  if (!stat?.isFile()) return;
  const state = run.externalState;
  state.lastActivityMs = Math.max(state.lastActivityMs ?? 0, stat.mtimeMs);
  // A restarted portal normally tails large logs to stay responsive. Seed the
  // immutable header first so totals, shard identity, and coordinator start
  // metadata survive that restart instead of reverting to an unknown total.
  if (!state.fileOffsets.has(path) && stat.size > MAX_EXTERNAL_LOG_INGEST_BYTES) {
    const headBytes = await seedExternalLogHead(
      run,
      path,
      Math.min(stat.size - MAX_EXTERNAL_LOG_INGEST_BYTES, 64 * 1024, budget.remainingBytes),
    );
    budget.bytesRead += headBytes;
    budget.remainingBytes -= headBytes;
  }
  let offset = state.fileOffsets.get(path) ?? (completedOnDiscovery
    ? Math.max(0, stat.size - (basename(path) === 'coordinator.log' ? 128 * 1024 : 384 * 1024))
    : 0);
  if (stat.size < offset) {
    offset = 0;
    state.partialLines.set(path, '');
    state.omittedLineCharacters.set(path, 0);
    state.decoders.set(path, new StringDecoder('utf8'));
  }
  if (stat.size - offset > MAX_EXTERNAL_LOG_INGEST_BYTES) {
    const skippedBytes = stat.size - offset - MAX_EXTERNAL_LOG_INGEST_BYTES;
    budget.skippedBytes += skippedBytes;
    offset = stat.size - MAX_EXTERNAL_LOG_INGEST_BYTES;
    state.partialLines.set(path, '');
    state.omittedLineCharacters.set(path, 0);
    state.decoders.set(path, new StringDecoder('utf8'));
    if (emit) {
      appendEvent(run, 'log', {
        channel: 'stdout',
        stage: externalLogMetadata(basename(path), '').stage,
        line: `[portal skipped ${skippedBytes} historical log bytes to keep live tracking responsive; use the bounded log-tail view for recent context]`,
        timestamp: new Date().toISOString(),
        phase: run.manifest.phase,
        progress: run.manifest.progress,
      });
    }
  }
  if (stat.size === offset || budget.remainingBytes <= 0 || performance.now() >= budget.deadline) return;
  const handle = await fs.open(path, 'r');
  try {
    let partial = state.partialLines.get(path) ?? '';
    let omitted = state.omittedLineCharacters.get(path) ?? 0;
    const decoder = state.decoders.get(path) ?? new StringDecoder('utf8');
    state.decoders.set(path, decoder);
    const buffer = Buffer.allocUnsafe(256 * 1024);
    const ingestEnd = Math.min(stat.size, offset + budget.remainingBytes);
    while (offset < ingestEnd && performance.now() < budget.deadline) {
      const length = Math.min(buffer.length, ingestEnd - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      budget.bytesRead += bytesRead;
      budget.remainingBytes -= bytesRead;
      const lines = `${partial}${decoder.write(buffer.subarray(0, bytesRead))}`.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const [index, line] of lines.entries()) {
        const value = index === 0 && omitted > 0
          ? `[portal omitted ${omitted} oversized log characters] ${line}`
          : line;
        consumeExternalLogLine(run, path, value, emit);
        if (index === 0) omitted = 0;
      }
      if (partial.length > MAX_EXTERNAL_PARTIAL_LINE_CHARS) {
        const remove = partial.length - MAX_EXTERNAL_PARTIAL_LINE_CHARS;
        partial = partial.slice(remove);
        omitted += remove;
      }
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    }
    state.partialLines.set(path, partial);
    state.omittedLineCharacters.set(path, omitted);
    state.fileOffsets.set(path, offset);
  } finally {
    await handle.close();
  }
}

async function seedExternalLogHead(run, path, length) {
  if (length <= 0) return 0;
  const handle = await fs.open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
    // The last item may be a line cut at the read boundary. The normal tail
    // ingestion will process its complete copy when it falls in retained data.
    lines.pop();
    for (const line of lines) consumeExternalLogLine(run, path, line, false);
    return bytesRead;
  } finally {
    await handle.close();
  }
}

function consumeExternalLogLine(run, path, line, emit) {
  const name = basename(path);
  const state = run.externalState;
  if (name === 'coordinator.log') {
    const match = line.match(/\[COORDINATOR\]\s+([a-z-]+)\s+(\{.*\})$/);
    if (match) {
      const detail = parseEmbeddedJson(match[2]);
      if (detail && match[1] === 'sharded-release-started') {
        state.started = { ...detail, startedAt: timestampFromLogLine(line) };
        if (Number.isInteger(detail.performanceExpectedExecutions)) {
          state.performanceExpectedExecutions = detail.performanceExpectedExecutions;
        }
      }
      if (detail && match[1] === 'performance-isolation-started'
        && Number.isInteger(detail.expectedExecutions)) {
        state.performanceExpectedExecutions = detail.expectedExecutions;
      }
      if (detail && match[1] === 'command-started') {
        state.commands.set(detail.label, { ...detail, startedAt: timestampFromLogLine(line) });
      }
      if (detail && match[1] === 'command-finished') {
        state.commands.set(detail.label, { ...(state.commands.get(detail.label) ?? {}), ...detail });
      }
    }
  }
  if (name === 'merge.log') {
    const marker = line.lastIndexOf('[MERGE] command-');
    const match = marker === -1
      ? null
      : line.slice(marker).match(/^\[MERGE\]\s+command-(started|finished)\s+(\{.*\})$/);
    if (match) {
      const detail = parseEmbeddedJson(match[2]);
      const stageName = detail?.stage ?? detail?.name;
      if (detail && stageName) {
        state.mergeStages.set(stageName, {
          ...(state.mergeStages.get(stageName) ?? {}),
          ...detail,
          ...(match[1] === 'started' ? { startedAt: timestampFromLogLine(line) } : {}),
        });
      }
    }
  }
  if (name.startsWith('shard-') || name === 'performance.log') {
    const isolatedPerformance = name === 'performance.log';
    const shard = state.shardProgress.get(name) ?? {
      total: null,
      completed: 0,
      auditFinishes: 0,
      passed: null,
      failed: null,
      flaky: null,
      skipped: null,
      finished: false,
    };
    const running = line.match(isolatedPerformance
      ? /Running\s+(\d+)\s+tests?/i
      : /Running\s+(\d+)\s+tests?.*shard\s+\d+\s+of\s+\d+/i);
    if (running) shard.total = Number(running[1]);
    if (line.includes('[AUDIT_TEST_FINISH]')) shard.auditFinishes += 1;
    for (const [pattern, key] of [
      [/\]\s+(\d+)\s+passed(?:\s|\()/i, 'passed'],
      [/\]\s+(\d+)\s+failed(?:\s|$)/i, 'failed'],
      [/\]\s+(\d+)\s+flaky(?:\s|$)/i, 'flaky'],
      [/\]\s+(\d+)\s+skipped(?:\s|$)/i, 'skipped'],
      [/\]\s+(\d+)\s+did not run(?:\s|$)/i, 'didNotRun'],
    ]) {
      const summary = line.match(pattern);
      if (summary) shard[key] = Number(summary[1]);
    }
    if (isolatedPerformance
      ? /\[PERFORMANCE\]\s+command-finished\s+\{/.test(line)
      : /\[SHARD\s+\d+\/\d+\]\s+command-finished\s+\{/.test(line)) shard.finished = true;
    shard.completed = shard.finished && shard.total !== null
      ? shard.total
      : Math.min(shard.total ?? Number.POSITIVE_INFINITY, shard.auditFinishes);
    state.shardProgress.set(name, shard);
  }
  if (!emit || line.length === 0) return;
  const metadata = externalLogMetadata(name, line);
  appendEvent(run, 'log', {
    channel: metadata.channel,
    stage: metadata.stage,
    line: redactLogValue(line.slice(0, 20_000)),
    timestamp: timestampFromLogLine(line),
    phase: run.manifest.phase,
    progress: run.manifest.progress,
  });
}

async function refreshExternalManifest(run) {
  const state = run.externalState;
  const lifecycle = await readCachedExternalJson(run, 'sharded-run.json');
  const mergeLifecycle = await readCachedExternalJson(run, 'merge-lifecycle.json');
  const heartbeat = await readCachedExternalJson(run, 'sharded-heartbeat.json');
  const heartbeatStat = await safeStat(join(run.directory, 'sharded-heartbeat.json'));
  if (heartbeatStat?.isFile()) state.lastActivityMs = Math.max(state.lastActivityMs ?? 0, heartbeatStat.mtimeMs);
  const invalidDocument = [lifecycle, mergeLifecycle, heartbeat]
    .find((value) => typeof value?.__portalExternalJsonError === 'string');
  if (invalidDocument) {
    state.leaseFailed = true;
    const finishedAt = new Date().toISOString();
    const reason = `External sharded lifecycle evidence is invalid: ${invalidDocument.__portalExternalJsonError}`;
    run.manifest.status = 'evidence-failed';
    run.manifest.phase = 'External sharded run published invalid lifecycle evidence';
    run.manifest.finishedAt = finishedAt;
    run.manifest.exitCode = null;
    run.manifest.pipeline = { status: 'failed', completed: false, reason, finishedAt };
    run.manifest.release = unavailableRelease(`No authoritative release decision exists because ${reason.toLowerCase()}`);
    return;
  }
  const startedAt = lifecycle?.startedAt ?? state.started?.startedAt ?? mergeLifecycle?.startedAt ?? run.manifest.createdAt;
  const shardTotal = lifecycle?.shardTotal ?? state.started?.shardTotal ?? mergeLifecycle?.shardTotal
    ?? state.shardProgress.size;
  run.manifest.startedAt = startedAt;
  run.manifest.createdAt = startedAt;
  run.manifest.options.productionUrl = lifecycle?.productionUrl ?? state.started?.productionUrl
    ?? run.manifest.options.productionUrl;
  run.manifest.options.candidateUrl = lifecycle?.candidateUrl ?? state.started?.candidateUrl
    ?? run.manifest.options.candidateUrl;
  run.manifest.options.candidateIgnoreHTTPSErrors = lifecycle?.candidateIgnoreHTTPSErrors
    ?? state.started?.tlsPolicy === 'candidate-development-bypass';
  const heartbeatIssue = !lifecycle && !mergeLifecycle && heartbeatStat?.isFile()
    ? malformedExternalHeartbeat(heartbeat, run.manifest.id)
    : null;
  if (!heartbeatIssue) applyExternalHeartbeatProgress(state, heartbeat);
  run.manifest.stages = externalStages(state, lifecycle, mergeLifecycle, shardTotal);
  run.manifest.progress = externalProgress(state);

  if (lifecycle) {
    state.leaseFailed = false;
    const pipeline = lifecycle.pipeline ?? {
      status: 'failed', completed: false, reason: 'The sharded lifecycle is missing pipeline truth.', finishedAt: lifecycle.finishedAt ?? null,
    };
    const release = lifecycle.release ?? unavailableRelease('The sharded lifecycle is missing release truth.');
    const terminalEvidence = await validateExternalTerminalEvidence({
      runDirectory: run.directory,
      expectedRunId: run.manifest.id,
      lifecycle,
      source: 'sharded-run.json',
      maximumShardTotal: 16,
      maximumVideoManifestBytes: MAX_VIDEO_MANIFEST_BYTES,
      maximumPreferredMediaArtifacts: MAX_PREFERRED_MEDIA_ARTIFACTS,
    });
    applyExternalFinalTruth(run, {
      pipeline,
      release,
      reportedStatus: lifecycle.status,
      finishedAt: lifecycle.finishedAt ?? null,
      source: 'sharded-run.json',
      evidenceProblems: terminalEvidence.problems,
    });
    return;
  }

  if (mergeLifecycle?.finishedAt) {
    state.leaseFailed = false;
    let release = mergeLifecycle.release ?? null;
    if (!release) {
      try {
        release = await readChecklistRelease(join(run.directory, 'checklist', 'manifest.json'));
      } catch (error) {
        release = unavailableRelease(error.message);
      }
    }
    const pipeline = mergeLifecycle.pipeline ?? {
      status: mergeLifecycle.status === 'passed' ? 'completed' : 'failed',
      completed: mergeLifecycle.status === 'passed',
      reason: mergeLifecycle.status === 'passed'
        ? 'Shard evidence was merged, media was processed, and the checklist was rebuilt.'
        : 'The externally launched merge pipeline did not complete successfully.',
      finishedAt: mergeLifecycle.finishedAt,
    };
    const terminalEvidence = await validateExternalTerminalEvidence({
      runDirectory: run.directory,
      expectedRunId: run.manifest.id,
      lifecycle: mergeLifecycle,
      source: 'merge-lifecycle.json',
      maximumShardTotal: 16,
      maximumVideoManifestBytes: MAX_VIDEO_MANIFEST_BYTES,
      maximumPreferredMediaArtifacts: MAX_PREFERRED_MEDIA_ARTIFACTS,
    });
    applyExternalFinalTruth(run, {
      pipeline,
      release,
      reportedStatus: mergeLifecycle.status,
      finishedAt: mergeLifecycle.finishedAt,
      source: 'merge-lifecycle.json',
      evidenceProblems: terminalEvidence.problems,
    });
    return;
  }

  if (heartbeatIssue) {
    state.leaseFailed = true;
    const finishedAt = new Date().toISOString();
    const reason = `External sharded coordinator heartbeat is malformed: ${heartbeatIssue}`;
    run.manifest.status = 'evidence-failed';
    run.manifest.phase = 'External sharded run published an invalid heartbeat';
    run.manifest.finishedAt = finishedAt;
    run.manifest.exitCode = null;
    run.manifest.pipeline = { status: 'failed', completed: false, reason, finishedAt };
    run.manifest.release = unavailableRelease(`No authoritative release decision exists because ${reason.toLowerCase()}`);
    return;
  }

  const leaseExpiresAt = Date.parse(String(heartbeat?.leaseExpiresAt ?? ''));
  const heartbeatExpired = Number.isFinite(leaseExpiresAt) && Date.now() > leaseExpiresAt;
  const legacyActivityExpired = !heartbeat && Date.now() - (state.lastActivityMs ?? Date.parse(startedAt)) > EXTERNAL_STALE_LEASE_MS;
  if (heartbeatExpired || legacyActivityExpired) {
    state.leaseFailed = true;
    const lastHeartbeat = heartbeat?.updatedAt ?? (state.lastActivityMs ? new Date(state.lastActivityMs).toISOString() : 'unknown');
    const reason = `External sharded coordinator lease expired; last activity ${lastHeartbeat}. No terminal lifecycle was published.`;
    const finishedAt = new Date().toISOString();
    run.manifest.status = 'evidence-failed';
    run.manifest.phase = 'External sharded run stopped reporting progress';
    run.manifest.finishedAt = finishedAt;
    run.manifest.exitCode = null;
    run.manifest.pipeline = { status: 'failed', completed: false, reason, finishedAt };
    run.manifest.release = unavailableRelease(`No authoritative release decision exists because ${reason.toLowerCase()}`);
    return;
  }

  state.leaseFailed = false;
  const externalStopping = heartbeat?.status === 'stopping';
  run.manifest.status = externalStopping ? 'stopping' : 'running';
  run.manifest.finishedAt = null;
  run.manifest.exitCode = null;
  run.manifest.pipeline = {
    status: 'running',
    completed: false,
    reason: externalStopping
      ? 'The externally launched sharded coordinator is stopping active work.'
      : 'An externally launched sharded browser and evidence pipeline is running.',
    finishedAt: null,
  };
  run.manifest.release = pendingRelease();
  const merge = state.commands.get('MERGE');
  const performance = state.commands.get('PERFORMANCE');
  const completedShards = [...state.shardProgress.values()].filter(({ finished }) => finished).length;
  const activeMergeStage = [...state.mergeStages.entries()].find(([, stage]) => !stage.finishedAt)?.[0];
  run.manifest.phase = externalStopping
    ? `Stopping external sharded work · ${heartbeat.activeCommands} command(s) still active`
    : activeMergeStage === 'process-media' ? 'Processing and indexing video evidence'
    : activeMergeStage === 'rebuild-checklist' ? 'Rebuilding checklist with final evidence links'
      : activeMergeStage === 'merge-reports' || (merge && !merge.finishedAt) ? 'Merging shard reports'
        : performance && !performance.finishedAt ? 'Executing isolated Lighthouse and performance checks · one worker'
          : completedShards < shardTotal ? `Executing browser checks · ${completedShards}/${shardTotal} functional shards complete`
            : performance?.finishedAt ? 'Preparing unified evidence merge'
              : 'Preparing isolated performance container';
}

function malformedExternalHeartbeat(heartbeat, expectedRunId) {
  if (!heartbeat || typeof heartbeat !== 'object' || Array.isArray(heartbeat)) return 'the file is not valid JSON object data.';
  if (heartbeat.schemaVersion !== 1) return 'schemaVersion must be 1.';
  if (heartbeat.runId !== expectedRunId) return 'runId does not match the evidence directory.';
  if (!['running', 'stopping'].includes(heartbeat.status)) return 'an active run heartbeat must report running or stopping.';
  const updatedAt = Date.parse(String(heartbeat.updatedAt ?? ''));
  const leaseExpiresAt = Date.parse(String(heartbeat.leaseExpiresAt ?? ''));
  if (!Number.isFinite(updatedAt) || !Number.isFinite(leaseExpiresAt)) return 'updatedAt and leaseExpiresAt must be valid timestamps.';
  if (leaseExpiresAt <= updatedAt || leaseExpiresAt - updatedAt > 15 * 60_000) return 'the lease interval is invalid or unbounded.';
  if (updatedAt > Date.now() + 5 * 60_000) return 'updatedAt is implausibly far in the future.';
  if (!Number.isSafeInteger(heartbeat.activeCommands) || heartbeat.activeCommands < 0 || heartbeat.activeCommands > 1_000) {
    return 'activeCommands must be a bounded non-negative integer.';
  }
  if (heartbeat.progress !== undefined) {
    if (!heartbeat.progress || typeof heartbeat.progress !== 'object' || Array.isArray(heartbeat.progress)) {
      return 'progress must be an object when supplied.';
    }
    const entries = Object.entries(heartbeat.progress);
    if (entries.length > 17) return 'progress contains too many command records.';
    for (const [name, value] of entries) {
      if (!/^(?:shard-\d+-of-\d+|performance)\.log$/.test(name)) return `progress key ${JSON.stringify(name)} is invalid.`;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `progress.${name} must be an object.`;
      if (!['shard', 'performance'].includes(value.kind)) return `progress.${name}.kind is invalid.`;
      if (value.kind === 'shard' && (!Number.isSafeInteger(value.index) || value.index < 1 || value.index > 16)) {
        return `progress.${name}.index is invalid.`;
      }
      if (value.kind === 'performance' && value.index !== null) return `progress.${name}.index must be null.`;
      for (const key of ['total', 'passed', 'failed', 'flaky', 'skipped', 'didNotRun']) {
        if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 100_000)) {
          return `progress.${name}.${key} is invalid.`;
        }
      }
      for (const key of ['completed', 'auditFinishes']) {
        if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 100_000) {
          return `progress.${name}.${key} is invalid.`;
        }
      }
      if (value.total !== null && value.completed > value.total) return `progress.${name}.completed exceeds total.`;
      if (typeof value.finished !== 'boolean') return `progress.${name}.finished must be boolean.`;
      if (!Number.isFinite(Date.parse(String(value.updatedAt ?? '')))) return `progress.${name}.updatedAt is invalid.`;
    }
  }
  return null;
}

function applyExternalHeartbeatProgress(state, heartbeat) {
  if (!heartbeat?.progress || typeof heartbeat.progress !== 'object' || Array.isArray(heartbeat.progress)) return;
  for (const [name, reported] of Object.entries(heartbeat.progress)) {
    const current = state.shardProgress.get(name) ?? {
      total: null,
      completed: 0,
      auditFinishes: 0,
      passed: null,
      failed: null,
      flaky: null,
      skipped: null,
      didNotRun: null,
      finished: false,
    };
    if (Number.isSafeInteger(reported.total)) current.total = reported.total;
    current.auditFinishes = Math.max(current.auditFinishes, reported.auditFinishes);
    current.completed = Math.max(current.completed, reported.completed);
    current.finished = current.finished || reported.finished;
    for (const key of ['passed', 'failed', 'flaky', 'skipped', 'didNotRun']) {
      if (Number.isSafeInteger(reported[key])) current[key] = reported[key];
    }
    if (current.total !== null) current.completed = Math.min(current.completed, current.total);
    state.shardProgress.set(name, current);
  }
}

function applyExternalFinalTruth(run, {
  pipeline,
  release,
  reportedStatus,
  finishedAt,
  source,
  evidenceProblems = [],
}) {
  if (evidenceProblems.length === 0
    && pipeline?.status === 'stopped'
    && pipeline?.completed === false
    && reportedStatus === 'stopped') {
    const terminalAt = finishedAt ?? pipeline.finishedAt ?? new Date().toISOString();
    delete run.manifest.lifecycleDiagnostics;
    run.manifest.finishedAt = terminalAt;
    run.manifest.pipeline = {
      status: 'stopped',
      completed: false,
      reason: pipeline.reason || 'The external sharded run was stopped.',
      finishedAt: terminalAt,
    };
    run.manifest.release = unavailableRelease(
      'No authoritative release decision exists because the external sharded run was stopped.',
      source,
    );
    run.manifest.reviewReasons = [];
    run.manifest.status = 'stopped';
    run.manifest.exitCode = 130;
    run.manifest.phase = 'External sharded run stopped';
    return;
  }
  const pipelineComplete = pipeline?.status === 'completed' && pipeline?.completed === true;
  let normalizedRelease = null;
  let releaseValidationError = null;
  try {
    normalizedRelease = {
      ...parseChecklistRelease({ schemaVersion: 1, release }, source),
      evaluatedAt: typeof release?.evaluatedAt === 'string' ? release.evaluatedAt : finishedAt,
    };
  } catch (error) {
    releaseValidationError = error.message;
  }
  const expectedStatus = pipelineComplete && normalizedRelease && evidenceProblems.length === 0
    ? normalizedRelease.decision === 'READY' ? 'ready' : 'not-ready'
    : 'pipeline-failed';
  const problems = [...evidenceProblems];
  if (!pipelineComplete) problems.push('pipeline.status must be completed and pipeline.completed must be true');
  if (releaseValidationError) problems.push(`release truth is invalid: ${releaseValidationError}`);
  if (reportedStatus !== expectedStatus) {
    problems.push(`reported lifecycle status ${JSON.stringify(reportedStatus)} contradicts derived status ${JSON.stringify(expectedStatus)}`);
  }

  run.manifest.finishedAt = finishedAt;
  run.manifest.release = evidenceProblems.length > 0
    ? {
        ...unavailableRelease(
          `External release evidence in ${source} is incomplete or inconsistent: ${evidenceProblems.join('; ')}`,
          source,
        ),
        evaluatedAt: finishedAt,
      }
    : normalizedRelease ?? {
    ...unavailableRelease(
      `External release truth in ${source} is invalid: ${releaseValidationError ?? 'unknown validation error'}`,
      source,
    ),
    evaluatedAt: finishedAt,
      };
  if (problems.length > 0) {
    const reason = `External release truth in ${source} is inconsistent: ${problems.join('; ')}.`;
    run.manifest.lifecycleDiagnostics = {
      source,
      reportedStatus: reportedStatus ?? null,
      reportedPipeline: structuredClone(pipeline ?? null),
      reportedReleaseDecision: release?.decision ?? null,
      reportedRelease: structuredClone(release ?? null),
      releaseValidationError,
      derivedStatus: expectedStatus,
      problems,
    };
    run.manifest.pipeline = {
      status: 'failed',
      completed: false,
      reason: `${reason} Reported pipeline: ${pipeline?.reason ?? 'no reason supplied'}`,
      finishedAt: finishedAt ?? pipeline?.finishedAt ?? new Date().toISOString(),
    };
    run.manifest.reviewReasons = [];
    run.manifest.status = 'evidence-failed';
    run.manifest.exitCode = 1;
    run.manifest.phase = `Sharded evidence pipeline failed · ${reason}`;
    return;
  }

  delete run.manifest.lifecycleDiagnostics;
  run.manifest.pipeline = pipeline;
  const reviews = releaseReviewReasons(run.manifest, FULL_PROJECT_COUNT);
  run.manifest.reviewReasons = reviews;
  run.manifest.status = normalizedRelease.decision === 'NOT_READY'
    ? 'not-ready'
    : reviews.length > 0
      ? 'review-required'
      : 'passed';
  run.manifest.exitCode = run.manifest.status === 'passed' ? 0 : 1;
  run.manifest.phase = reviews.length > 0 && normalizedRelease.decision === 'READY'
    ? `Sharded checklist READY · release signoff withheld: ${reviews.join('; ')}`
    : `Sharded evidence pipeline complete · release ${normalizedRelease.decision.replace('_', ' ')}`;
}

function externalStages(state, lifecycle, mergeLifecycle, shardTotal) {
  const stages = {};
  stages.build = externalCommandStage(state.commands.get('BUILD'), 'pending', { tolerateNonzero: false });
  const shardCommands = Array.from({ length: shardTotal }, (_, offset) => state.commands.get(`SHARD ${offset + 1}/${shardTotal}`));
  stages.browserShards = externalAggregateStage(shardCommands, ['docker', 'compose', 'run', `${shardTotal} parallel audit shards`]);
  for (const [offset, command] of shardCommands.entries()) {
    stages[`shard${offset + 1}`] = externalCommandStage(command, 'pending', { tolerateNonzero: true });
  }
  stages.performanceIsolation = externalCommandStage(state.commands.get('PERFORMANCE'), 'pending', { tolerateNonzero: true });
  stages.merge = externalCommandStage(state.commands.get('MERGE'), 'pending', { tolerateNonzero: false });
  const lifecycleStages = new Map((mergeLifecycle?.stages ?? []).map((stage) => [stage.name, stage]));
  const namedStage = (name) => state.mergeStages.get(name) ?? lifecycleStages.get(name);
  stages.mergeReports = externalCommandStage(namedStage('merge-reports'), 'pending', { tolerateNonzero: false });
  stages.videoProcessing = externalCommandStage(namedStage('process-media'), 'pending', { tolerateNonzero: false });
  stages.reportRebuild = externalCommandStage(namedStage('rebuild-checklist'), 'pending', { tolerateNonzero: false });
  stages.aiReview = { ...stageRecord('skipped', ['AI review is not enabled for this external sharded run']) };
  if (lifecycle?.build) stages.build = externalCommandStage(lifecycle.build, stages.build.status, { tolerateNonzero: false });
  if (Array.isArray(lifecycle?.shards)) {
    stages.browserShards = externalAggregateStage(lifecycle.shards, stages.browserShards.command);
    for (const shard of lifecycle.shards) {
      if (Number.isInteger(shard.index)) stages[`shard${shard.index}`] = externalCommandStage(shard, 'completed', { tolerateNonzero: true });
    }
  }
  if (lifecycle?.performance) {
    stages.performanceIsolation = externalCommandStage(lifecycle.performance, stages.performanceIsolation.status, { tolerateNonzero: true });
  } else if (lifecycle?.finishedAt) {
    stages.performanceIsolation = {
      ...stageRecord('skipped', ['legacy sharded run did not isolate performance']),
      error: 'This run predates dedicated performance isolation.',
    };
  }
  if (lifecycle?.merge) {
    stages.merge = externalCommandStage(lifecycle.merge, stages.merge.status, {
      tolerateNonzero: lifecycle.pipeline?.completed === true,
    });
    if (lifecycle.pipeline?.completed === true && stages.merge.exitCode !== 0) {
      stages.merge.error = 'The evidence pipeline completed; this nonzero exit records a NOT READY release decision.';
    }
  }
  return stages;
}

function externalCommandStage(command, fallbackStatus, { tolerateNonzero }) {
  if (!command) return stageRecord(fallbackStatus, []);
  const finishedAt = command.finishedAt ?? null;
  const startedAt = command.startedAt ?? null;
  const exitCode = Number.isInteger(command.exitCode) ? command.exitCode : null;
  const status = finishedAt
    ? exitCode === 0 || tolerateNonzero ? 'completed' : 'failed'
    : startedAt ? 'running' : fallbackStatus;
  return {
    status,
    command: Array.isArray(command.command) ? command.command : [],
    startedAt,
    finishedAt,
    durationMs: command.durationMs ?? (startedAt && finishedAt
      ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null),
    exitCode,
    signal: command.signal ?? null,
    error: command.error ?? (tolerateNonzero && exitCode ? 'Browser findings were recorded; evidence collection continued.' : null),
  };
}

function externalAggregateStage(commands, fallbackCommand) {
  const available = commands.filter(Boolean);
  if (available.length === 0) return stageRecord('pending', fallbackCommand);
  const startedAt = available.map(({ startedAt }) => startedAt).filter(Boolean).sort()[0] ?? null;
  const finished = available.filter(({ finishedAt }) => Boolean(finishedAt));
  const finishedAt = finished.length === commands.length
    ? finished.map(({ finishedAt: value }) => value).filter(Boolean).sort().at(-1) ?? null
    : null;
  return {
    status: finishedAt ? 'completed' : 'running',
    command: fallbackCommand,
    startedAt,
    finishedAt,
    durationMs: startedAt && finishedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null,
    exitCode: finishedAt ? Math.max(...finished.map(({ exitCode }) => Number(exitCode) || 0)) : null,
    signal: finished.find(({ signal }) => signal)?.signal ?? null,
    error: finishedAt && finished.some(({ exitCode }) => exitCode !== 0)
      ? 'One or more shards recorded browser findings; merge and release evaluation continued.' : null,
  };
}

function externalProgress(state) {
  const performance = state.shardProgress.get('performance.log');
  if (performance && performance.total === null && Number.isInteger(state.performanceExpectedExecutions)) {
    performance.total = state.performanceExpectedExecutions;
  }
  const shards = [...state.shardProgress.values()];
  const inferredShardTotal = (shard) => shard.total ?? (
    shard.finished
      ? ['passed', 'failed', 'flaky', 'skipped', 'didNotRun']
        .map((key) => shard[key] ?? 0)
        .reduce((sum, value) => sum + value, 0)
      : null
  );
  const totals = shards.map(inferredShardTotal).filter(Number.isInteger);
  const total = totals.length === shards.length && shards.length > 0
    ? totals.reduce((sum, value) => sum + value, 0) : null;
  const completed = shards.reduce((sum, shard) => sum + (
    shard.finished ? inferredShardTotal(shard) ?? shard.completed ?? 0 : shard.completed ?? 0
  ), 0);
  const summary = (key) => {
    const values = shards.map((shard) => shard[key]).filter(Number.isInteger);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const skipped = summary('skipped');
  const didNotRun = summary('didNotRun');
  return {
    total,
    completed: total === null ? completed : Math.min(completed, total),
    passed: summary('passed'),
    failed: summary('failed'),
    flaky: summary('flaky'),
    skipped: skipped === null && didNotRun === null ? null : (skipped ?? 0) + (didNotRun ?? 0),
  };
}

async function readCachedExternalJson(run, relativePath) {
  const path = join(run.directory, relativePath);
  const stat = await safeStat(path);
  if (!stat?.isFile()) return null;
  const cached = run.externalState.lifecycleCache.get(path);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  const maximumBytes = relativePath === 'sharded-heartbeat.json'
    ? MAX_EXTERNAL_HEARTBEAT_JSON_BYTES
    : MAX_EXTERNAL_LIFECYCLE_JSON_BYTES;
  if (stat.size > maximumBytes) {
    const value = {
      __portalExternalJsonError: `${relativePath} exceeds its ${maximumBytes}-byte safety limit.`,
    };
    run.externalState.lifecycleCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }
  try {
    const value = JSON.parse(await fs.readFile(path, 'utf8'));
    run.externalState.lifecycleCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    const value = { __portalExternalJsonError: `${relativePath} is not valid JSON.` };
    run.externalState.lifecycleCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }
}

async function readExternalLogSnapshot(run, maximumBytes) {
  const files = await externalLogFiles(run.directory);
  if (files.length === 0) {
    return {
      log: 'No external coordinator log output was captured for this sharded run.',
      bytes: 0,
      maxBytes: maximumBytes,
      truncated: false,
      sources: [],
    };
  }
  const contentBudget = Math.max(MIN_LOG_SNAPSHOT_BYTES, maximumBytes - 8 * 1024);
  const weights = files.map((path) => {
    const name = basename(path);
    return name === 'coordinator.log' ? 3
      : name === 'merge.log' ? 8
        : name === 'performance.log' ? 4
          : name.startsWith('shard-') ? 2 : 1;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const sections = [];
  const sources = [];
  for (const [index, path] of files.entries()) {
    const name = basename(path);
    const budget = Math.max(4 * 1024, Math.floor(contentBudget * (weights[index] / totalWeight)));
    const tail = await readBoundedFileTail(path, budget);
    if (!tail.content) continue;
    const redactedContent = redactLogValue(tail.content);
    const redactedBytes = Buffer.byteLength(redactedContent);
    sections.push(`===== ${name} · latest ${formatLogBytes(redactedBytes)} displayed of ${formatLogBytes(tail.size)} stored =====\n${redactedContent}`);
    sources.push({
      path: `logs/${name}`,
      size: tail.size,
      returnedBytes: redactedBytes,
      truncated: tail.truncated,
    });
  }
  let log = sections.join('\n\n');
  if (Buffer.byteLength(log) > maximumBytes) log = utf8Tail(log, maximumBytes);
  return {
    log,
    bytes: Buffer.byteLength(log),
    maxBytes: maximumBytes,
    truncated: sources.some(({ truncated }) => truncated),
    sources,
  };
}

function decodeUtf8Boundary(buffer) {
  let start = 0;
  while (start < Math.min(4, buffer.length) && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function utf8Tail(value, maximumBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maximumBytes) return value;
  return decodeUtf8Boundary(buffer.subarray(buffer.length - maximumBytes));
}

function externalLogMetadata(name, line) {
  return {
    channel: line.includes('[stderr]') ? 'stderr' : 'stdout',
    stage: name === 'coordinator.log' ? 'coordinator'
      : name === 'build.log' ? 'build'
        : name === 'merge.log' ? 'merge'
          : name === 'performance.log' ? 'performanceIsolation'
          : name.replace(/\.log$/, ''),
  };
}

function timestampFromLogLine(line) {
  const timestamp = line.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)?.[0];
  return timestamp ?? new Date().toISOString();
}

function parseEmbeddedJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatLogBytes(bytes) {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KiB` : `${bytes} bytes`;
}

async function loadPersistedRuns() {
  for (const entry of await fs.readdir(ARTIFACT_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
    const directory = join(ARTIFACT_ROOT, entry.name);
    try {
      const manifest = JSON.parse(await fs.readFile(join(directory, 'run.json'), 'utf8'));
      if (manifest.id !== entry.name) continue;
      manifest.executionProvenance ??= portalExecutionProvenance();
      const interrupted = !TERMINAL_STATUSES.has(manifest.status);
      if (interrupted) {
        manifest.status = 'failed';
        manifest.phase = 'Portal restarted before completion';
        manifest.finishedAt = new Date().toISOString();
        manifest.error = 'Portal restarted before the run completed.';
        manifest.pipeline = {
          status: 'failed',
          completed: false,
          reason: manifest.error,
          finishedAt: manifest.finishedAt,
        };
        manifest.release = unavailableRelease('No authoritative release decision exists because the portal restarted before the evidence pipeline completed.');
      }
      const replayedProgress = { total: null, completed: 0, passed: null, failed: null, flaky: null, skipped: null };
      const persistedLog = await readBoundedFileTail(join(directory, 'logs', 'runner.log'), RESTART_PROGRESS_TAIL_BYTES)
        .catch(() => ({ content: '', truncated: false }));
      for (const line of persistedLog.content.split('\n')) {
        if (line.includes('[playwright:')) updateProgress(replayedProgress, line);
      }
      if (replayedProgress.total !== null) {
        manifest.progress = replayedProgress;
      } else {
        manifest.progress = {
          total: manifest.progress?.total ?? null,
          completed: manifest.progress?.completed ?? 0,
          passed: manifest.progress?.passed ?? null,
          failed: manifest.progress?.failed ?? null,
          flaky: manifest.progress?.flaky ?? null,
          skipped: manifest.progress?.skipped ?? null,
        };
        if (manifest.progress.total !== null) {
          manifest.progress.completed = Math.min(manifest.progress.completed, manifest.progress.total);
        }
      }
      const requiredEvidenceCompleted = manifest.stages?.videoProcessing?.status === 'completed'
        && manifest.stages?.reportRebuild?.status === 'completed'
        && (!manifest.stages?.manualEvidenceRebuild
          || manifest.stages.manualEvidenceRebuild.status === 'completed');
      const mayReconcileRelease = !interrupted
        && !['stopped', 'spawn-failed'].includes(manifest.status)
        && requiredEvidenceCompleted;
      if (mayReconcileRelease) {
        try {
          applyCompletedRelease(
            { directory, manifest },
            await readChecklistRelease(join(directory, 'checklist', 'manifest.json')),
            'Persisted evidence pipeline complete',
          );
        } catch (error) {
          applyPipelineFailure({ manifest }, error.message);
        }
      } else if (!manifest.pipeline) {
        const reason = manifest.status === 'stopped'
          ? 'The evidence pipeline was stopped by a reviewer.'
          : manifest.status === 'spawn-failed'
            ? 'Playwright could not start.'
            : 'Required evidence stages did not complete.';
        manifest.pipeline = {
          status: manifest.status === 'stopped' ? 'stopped' : 'failed',
          completed: false,
          reason,
          finishedAt: manifest.finishedAt ?? new Date().toISOString(),
        };
        manifest.release = unavailableRelease(`No authoritative release decision is usable because ${reason.toLowerCase()}`);
      }
      if (!manifest.release) {
        manifest.release = unavailableRelease('No authoritative release decision was recorded for this legacy run.');
      }
      const recoveredRun = {
        directory,
        manifest,
        child: null,
        clients: new Set(),
        events: [],
        sequence: 0,
        logStream: null,
        lifecycleStream: null,
        lineBuffer: { stdout: '', stderr: '' },
        killTimer: null,
        aiApiKey: null,
        artifactPermissionsSealed: false,
      };
      if (REPORT_WORKER_IDENTITY.active) {
        const reportStageReachedSealing = ['running', 'completed', 'failed']
          .includes(manifest.stages?.reportRebuild?.status);
        if (!interrupted && reportStageReachedSealing) {
          const portable = manifest.executionProvenance?.artifactPermissionMode === 'portable-bind';
          await fs.chmod(directory, portable ? 0o550 : 0o750);
          recoveredRun.artifactPermissionsSealed = true;
        } else {
          await sealRunDirectoryForReporting(recoveredRun, 'recovery');
        }
      }
      await persistManifest(recoveredRun);
      runs.set(entry.name, recoveredRun);
    } catch (error) {
      // A directory without a valid run manifest is not portal-managed evidence.
      console.error(`[PORTAL_RUN_RECOVERY_REJECTED] ${entry.name}: ${redactLogValue(error instanceof Error ? error.message : String(error))}`);
    }
  }
}

async function loadPurgeQuarantines() {
  await fs.mkdir(PURGE_JOURNAL_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(PURGE_JOURNAL_ROOT, 0o700);
  const entries = await fs.readdir(PURGE_JOURNAL_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const journalPath = join(PURGE_JOURNAL_ROOT, entry.name);
    let record;
    try {
      record = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      if (!record || record.schemaVersion !== 1 || !SAFE_RUN_ID.test(record.id)
        || !['portal-managed', 'external-sharded'].includes(record.source)
        || !new RegExp(`^${escapeRegex(record.id)}-[a-f0-9]{16}$`).test(record.quarantineName)
        || !record.manifest || record.manifest.id !== record.id) {
        throw new Error('journal fields are invalid');
      }
      const externalManaged = record.source === 'external-sharded';
      const configuredRoot = externalManaged ? SHARDED_ARTIFACT_ROOT : ARTIFACT_ROOT;
      if (journalPath !== purgeJournalPath(configuredRoot, record.id)) {
        throw new Error('journal path does not match its configured artifact root');
      }
      const originalTarget = join(configuredRoot, record.id);
      const directory = join(configuredRoot, PURGE_QUARANTINE_NAME, record.quarantineName);
      const quarantineStat = await fs.lstat(directory).catch(() => null);
      if (!quarantineStat) {
        // A prepared rename never happened, or deletion finished before the
        // supervisor could unlink its journal. Neither case is a partial tree.
        await fs.unlink(journalPath);
        continue;
      }
      if (await safeStat(originalTarget)) {
        throw new Error('both original and quarantined evidence exist');
      }
      const quarantine = {
        configuredRoot,
        originalTarget,
        directory,
        journalPath,
        quarantineName: record.quarantineName,
        record,
      };
      await verifiedPurgeQuarantineTarget(configuredRoot, quarantine, record.id);
      const finishedAt = record.failedAt ?? new Date().toISOString();
      const manifest = structuredClone(record.manifest);
      manifest.status = 'evidence-failed';
      manifest.phase = 'Purge incomplete · remaining evidence quarantined';
      manifest.finishedAt = finishedAt;
      manifest.pipeline = {
        status: 'failed',
        completed: false,
        reason: record.error ?? 'Portal restarted while quarantined evidence was being deleted.',
        finishedAt,
      };
      manifest.release = unavailableRelease('No release decision is usable because the stored evidence may be partially purged.');
      manifest.purgeFailure = {
        occurredAt: finishedAt,
        reason: manifest.pipeline.reason,
        quarantined: true,
        retrySafe: true,
      };
      runs.set(record.id, {
        directory,
        externalManaged,
        manifest,
        child: null,
        clients: new Set(),
        galleryClients: new Set(),
        events: [],
        sequence: 0,
        logStream: null,
        lifecycleStream: null,
        lineBuffer: { stdout: '', stderr: '' },
        killTimer: null,
        aiApiKey: null,
        artifactPermissionsSealed: true,
        purgeQuarantine: quarantine,
      });
      console.error(`[PORTAL_PURGE_RECOVERED] ${record.id}: remaining evidence is quarantined and requires a purge retry.`);
    } catch (error) {
      throw new Error(`Purge quarantine journal ${entry.name} is invalid: ${error.message}`);
    }
  }
}

function sortedRunSummaries() {
  return [...runs.values()]
    .map(({ manifest }) => publicManifest(manifest))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function publicManifest(manifest) {
  const authorityRun = runs.get(manifest.id);
  return {
    ...structuredClone(manifest),
    revision: Number.isSafeInteger(authorityRun?.sequence) ? authorityRun.sequence : null,
    sourceRevision: typeof authorityRun?.consoleSourceRevision === 'string' ? authorityRun.consoleSourceRevision : null,
    purge: {
      eligible: PURGE_ELIGIBLE_STATUSES.has(manifest.status),
      confirmation: `PURGE ${manifest.id}`,
    },
  };
}

function requireRun(id) {
  if (!SAFE_RUN_ID.test(id)) throw httpError(404, 'Run not found.');
  const run = runs.get(id);
  if (!run) throw httpError(404, 'Run not found.');
  return run;
}

function requireGalleryRun(id) {
  if (!SAFE_RUN_ID.test(id)) throw new GalleryHttpError(404, 'Gallery run not found.', { code: 'GALLERY_RUN_NOT_FOUND' });
  const run = runs.get(id);
  if (run) return run;
  if (purgedGalleryRunIds.has(id)) {
    throw new GalleryHttpError(410, 'This run and its gallery evidence were permanently purged.', {
      code: 'GALLERY_RUN_PURGED',
    });
  }
  throw new GalleryHttpError(404, 'Gallery run not found.', { code: 'GALLERY_RUN_NOT_FOUND' });
}

async function purgeRun(run, body, response) {
  const id = run.manifest.id;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'Run purge confirmation is required.');
  }
  if (!PURGE_ELIGIBLE_STATUSES.has(run.manifest.status)) {
    throw httpError(409, 'Active runs cannot be purged. Stop the run and wait for it to finish first.');
  }
  if (body.confirmation !== `PURGE ${id}`) {
    throw httpError(400, `Type PURGE ${id} exactly to confirm permanent deletion.`);
  }
  if (purgingRunIds.has(id)) throw httpError(409, 'This run is already being purged.');
  if (manualMutationRunIds.has(id)) throw httpError(409, 'Manual evidence is being saved for this run. Wait for it to finish before purging.');
  if (galleryMutationRunIds.has(id)) throw httpError(409, 'A gallery review update is being saved for this run. Wait for it to finish before purging.');

  purgingRunIds.add(id);
  const consolePurgeKey = `comparative:${id}`;
  let consolePurgeToken = consolePendingPurgeTokens.get(consolePurgeKey) ?? null;
  try {
    if (!consolePurgeToken) {
      consolePurgeToken = consoleIndex.beginPurge({ mode: 'comparative', runId: id }, {
        sourceId: COMPARATIVE_CONSOLE_SOURCE_ID,
        sourceRevision: nextConsoleSourceRevision('comparative'),
        updatedAt: new Date().toISOString(),
      });
    }
    await fenceAndDrainRunTransfers('comparative', id);
    forgetConsoleReportProjection({ mode: 'comparative', runId: id });
    const configuredRoot = run.externalManaged ? SHARDED_ARTIFACT_ROOT : ARTIFACT_ROOT;
    const originalTarget = run.purgeQuarantine?.originalTarget
      ?? await verifiedPurgeTarget(configuredRoot, run.directory, id);
    if (!run.purgeQuarantine) {
      await assertPurgeHasNoNestedMounts(originalTarget);
    }
    const reclaimed = await measureRunEvidence(run.purgeQuarantine?.directory ?? originalTarget);
    if (!run.purgeQuarantine) {
      await moveRunToPurgeQuarantine(run, configuredRoot, originalTarget);
    }
    const target = await verifiedPurgeQuarantineTarget(configuredRoot, run.purgeQuarantine, id);
    await assertPurgeHasNoNestedMounts(target);
    try {
      await removeValidatedArtifactTree(fs, target);
    } catch (error) {
      if (await safeStat(target)) {
        await retainFailedPurge(run, error);
        throw error;
      }
      console.warn(`Purge removal for ${id} reported ${error.message}, but its quarantined directory is gone; treating deletion as complete.`);
    }
    await fs.unlink(run.purgeQuarantine.journalPath).catch((error) => {
      if (error?.code !== 'ENOENT') {
        // Evidence deletion is already complete. Keep the API/run state
        // truthful and let startup's missing-quarantine recovery remove this
        // root-only stale journal rather than reporting retained evidence.
        console.warn(`Purge journal cleanup for ${id} failed after evidence deletion completed: ${error.message}`);
      }
    });

    artifactPathCache.delete(originalTarget);
    artifactPathCache.delete(target);
    preferredMediaValidationCache.delete(originalTarget);
    preferredMediaValidationCache.delete(target);
    galleryRevisionCache.delete(id);
    consoleIndexedStateSignatures.delete(`comparative\u0000${id}`);
    observedGalleryPublications.delete(id);
    observedSealedGalleryHeads.delete(id);
    for (const key of galleryFlagRateWindows.keys()) {
      if (key.endsWith(`\u0000${id}`)) galleryFlagRateWindows.delete(key);
    }
    purgedGalleryRunIds.add(id);
    while (purgedGalleryRunIds.size > 256) purgedGalleryRunIds.delete(purgedGalleryRunIds.values().next().value);
    for (const cachedPath of reportDataCache.keys()) {
      if (isDirectlyContained(target, cachedPath) || isDirectlyContained(originalTarget, cachedPath)) reportDataCache.delete(cachedPath);
    }
    runs.delete(id);
    closePurgedRunStreams(run, id);
    consoleIndex.commitPurge(consolePurgeToken, {
      sourceRevision: nextConsoleSourceRevision('comparative'),
      updatedAt: new Date().toISOString(),
    });
    consolePendingPurgeTokens.delete(consolePurgeKey);
    console.log(`Purged ${run.externalManaged ? 'external sharded' : 'portal-managed'} run ${id}: ${reclaimed.files} file references and ${reclaimed.logicalBytes} logical bytes removed (hardlinks make physical reclaimed-byte claims unreliable).`);
    return sendJson(response, 200, {
      id,
      purged: true,
      source: run.externalManaged ? 'external-sharded' : 'portal-managed',
      filesRemoved: reclaimed.files,
      logicalBytesRemoved: reclaimed.logicalBytes,
    });
  } catch (error) {
    if (consolePurgeToken && !run.purgeQuarantine && runs.get(id) === run) {
      releaseRunTransferFence('comparative', id);
      try {
        const record = await authoritativeComparativeConsoleIndexRecord(run);
        consoleIndex.abortPurge(
          consolePurgeToken,
          [record, ...comparativeConsoleTimelineRecords(run, record)],
          { sourceComplete: consoleIndex.backfillState(COMPARATIVE_CONSOLE_SOURCE_ID)?.complete === true },
        );
        consolePendingPurgeTokens.delete(consolePurgeKey);
      } catch (rereadError) {
        console.error(`[PORTAL_CONSOLE_PURGE_REVERIFY_FAILED] comparative ${id} remains unavailable: ${redactLogValue(rereadError.message)}`);
      }
    } else if (consolePurgeToken && run.purgeQuarantine) {
      consolePendingPurgeTokens.set(consolePurgeKey, consolePurgeToken);
    }
    if (Number.isInteger(error?.statusCode)) throw error;
    console.error(`Run purge failed for ${id}:`, error);
    throw httpError(500, run.purgeQuarantine
      ? 'The run could not be completely purged. Its remaining evidence and durable portal record were quarantined for inspection or a safe retry.'
      : 'The run could not be purged and its original evidence record remains unchanged.');
  } finally {
    purgingRunIds.delete(id);
  }
}

async function withGalleryMutationLock(run, callback) {
  const id = run.manifest.id;
  if (run.purgeQuarantine) throw httpError(409, 'Quarantined partial evidence cannot accept gallery review updates.');
  if (purgingRunIds.has(id)) throw httpError(409, 'This run is being purged and cannot accept gallery review updates.');
  if (galleryMutationRunIds.has(id)) throw httpError(409, 'Another gallery review update is already being saved for this run.');
  galleryMutationRunIds.add(id);
  try {
    if (purgingRunIds.has(id) || runs.get(id) !== run) {
      throw httpError(409, 'This run is no longer available for gallery review updates.');
    }
    return await callback();
  } finally {
    galleryMutationRunIds.delete(id);
  }
}

function closePurgedRunStreams(run, id) {
  const clients = new Set([...(run.clients ?? []), ...(run.galleryClients ?? [])]);
  const event = {
    id: ++run.sequence,
    type: 'purged',
    data: { id, message: 'This run and its stored evidence were permanently deleted.' },
  };
  for (const client of clients) {
    if (client.auditHeartbeat) clearInterval(client.auditHeartbeat);
    client.auditHeartbeat = null;
    if (!client.writableEnded && !client.destroyed) {
      writeSse(client, event);
      client.end();
    }
  }
  run.clients?.clear();
  run.galleryClients?.clear();
}

async function verifiedPurgeTarget(configuredRoot, runDirectory, id) {
  const root = resolve(configuredRoot);
  const target = resolve(runDirectory);
  const expected = resolve(root, id);
  const relativeTarget = relative(root, target);
  const rootDepth = root.split(sep).filter(Boolean).length;
  if (root === resolve(sep) || rootDepth < 2 || target === root || target !== expected || relativeTarget !== id) {
    throw httpError(409, 'Purge refused because the run evidence path failed containment checks.');
  }

  const [rootStat, targetStat] = await Promise.all([
    fs.lstat(root).catch(() => null),
    fs.lstat(target).catch(() => null),
  ]);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw httpError(409, 'Purge refused because the configured artifact root is not a real directory.');
  }
  if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) {
    throw httpError(409, 'Purge refused because this run is missing or its evidence path is not a real directory.');
  }

  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (relative(realRoot, realTarget) !== id || dirname(realTarget) !== realRoot) {
    throw httpError(409, 'Purge refused because the run evidence resolves outside its configured artifact root.');
  }
  return target;
}

async function assertPurgeHasNoNestedMounts(target) {
  try {
    await assertNoNestedMountPoints(fs, target);
  } catch (error) {
    if (['NESTED_MOUNT_POINT', 'MOUNT_BOUNDARY_UNAVAILABLE'].includes(error?.code)) {
      throw httpError(409, error.message);
    }
    throw error;
  }
}

async function moveRunToPurgeQuarantine(run, configuredRoot, originalTarget) {
  const id = run.manifest.id;
  const source = run.externalManaged ? 'external-sharded' : 'portal-managed';
  const quarantineRoot = join(configuredRoot, PURGE_QUARANTINE_NAME);
  await fs.mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(quarantineRoot, 0o700);
  const quarantineRootStat = await fs.lstat(quarantineRoot);
  if (!quarantineRootStat.isDirectory() || quarantineRootStat.isSymbolicLink()) {
    throw httpError(409, 'Purge refused because its quarantine root is not a real directory.');
  }
  const quarantineName = `${id}-${randomBytes(8).toString('hex')}`;
  const directory = join(quarantineRoot, quarantineName);
  const journalPath = purgeJournalPath(configuredRoot, id);
  const record = {
    schemaVersion: 1,
    id,
    source,
    quarantineName,
    status: 'prepared',
    preparedAt: new Date().toISOString(),
    manifest: structuredClone(run.manifest),
  };
  await atomicWriteSecureJson(journalPath, record);
  try {
    await fs.rename(originalTarget, directory);
  } catch (error) {
    await fs.unlink(journalPath).catch(() => undefined);
    throw error;
  }
  record.status = 'deleting';
  record.quarantinedAt = new Date().toISOString();
  await atomicWriteSecureJson(journalPath, record);
  run.directory = directory;
  run.purgeQuarantine = { configuredRoot, originalTarget, directory, journalPath, quarantineName, record };
}

async function verifiedPurgeQuarantineTarget(configuredRoot, quarantine, id) {
  if (!quarantine || quarantine.configuredRoot !== configuredRoot) {
    throw httpError(409, 'Purge refused because its durable quarantine record is inconsistent.');
  }
  const quarantineRoot = resolve(configuredRoot, PURGE_QUARANTINE_NAME);
  const target = resolve(quarantine.directory);
  const expected = resolve(quarantineRoot, quarantine.quarantineName);
  if (target !== expected || dirname(target) !== quarantineRoot
    || !new RegExp(`^${escapeRegex(id)}-[a-f0-9]{16}$`).test(basename(target))) {
    throw httpError(409, 'Purge refused because its quarantine path failed containment checks.');
  }
  const [rootStat, targetStat] = await Promise.all([fs.lstat(quarantineRoot), fs.lstat(target)]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw httpError(409, 'Purge refused because quarantined evidence is not a real directory.');
  }
  const [realRoot, realTarget] = await Promise.all([fs.realpath(quarantineRoot), fs.realpath(target)]);
  if (dirname(realTarget) !== realRoot || basename(realTarget) !== quarantine.quarantineName) {
    throw httpError(409, 'Purge refused because quarantined evidence resolves outside its storage root.');
  }
  return target;
}

async function retainFailedPurge(run, error) {
  const finishedAt = new Date().toISOString();
  const reason = `Purge failed after evidence entered quarantine: ${redactLogValue(error instanceof Error ? error.message : String(error)).slice(0, 800)}`;
  run.manifest.status = 'evidence-failed';
  run.manifest.phase = 'Purge incomplete · remaining evidence quarantined';
  run.manifest.finishedAt = finishedAt;
  run.manifest.pipeline = { status: 'failed', completed: false, reason, finishedAt };
  run.manifest.release = unavailableRelease('No release decision is usable because the stored evidence was only partially purged.');
  run.manifest.purgeFailure = {
    occurredAt: finishedAt,
    reason,
    quarantined: true,
    retrySafe: true,
  };
  run.purgeQuarantine.record.status = 'failed';
  run.purgeQuarantine.record.failedAt = finishedAt;
  run.purgeQuarantine.record.error = reason;
  run.purgeQuarantine.record.manifest = structuredClone(run.manifest);
  await atomicWriteSecureJson(run.purgeQuarantine.journalPath, run.purgeQuarantine.record);
}

function purgeJournalPath(configuredRoot, id) {
  const rootKey = createHash('sha256').update(resolve(configuredRoot)).digest('hex').slice(0, 16);
  return join(PURGE_JOURNAL_ROOT, `${rootKey}-${id}.json`);
}

async function measureRunEvidence(root) {
  const pending = [root];
  let files = 0;
  let bytes = allocatedBytes(await fs.lstat(root));
  let logicalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw httpError(409, 'Run evidence changed while the purge was being prepared. Refresh the run list and retry.');
      }
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = await fs.lstat(path);
      bytes += allocatedBytes(stat);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        pending.push(path);
        continue;
      }
      files += 1;
      logicalBytes += stat.size;
    }
  }
  return { files, bytes, logicalBytes };
}

function allocatedBytes(stat) {
  return Number.isFinite(stat.blocks) && stat.blocks >= 0 ? stat.blocks * 512 : stat.size;
}

function isDirectlyContained(root, path) {
  const candidate = relative(root, path);
  return candidate !== '' && candidate !== '..' && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate);
}

function evictSingleSiteIdentityCaches(jobId) {
  const roots = [
    join(singleSiteQueue.root, 'jobs', jobId),
    join(SINGLE_SITE_FINALIZATION_ROOT, jobId),
  ];
  for (const cache of [artifactPathCache, preferredMediaValidationCache, reportDataCache]) {
    for (const cachedPath of cache.keys()) {
      if (roots.some((root) => cachedPath === root || isDirectlyContained(root, cachedPath))) {
        cache.delete(cachedPath);
      }
    }
  }
}

async function persistManifest(run) {
  if (run.externalManaged) {
    throw new Error('Externally launched sharded evidence is read-only in the portal.');
  }
  const manifestPath = join(run.directory, 'run.json');
  await withRunArtifactWriteWindow(
    run,
    () => atomicWriteJson(manifestPath, run.manifest),
    { sealPaths: [manifestPath] },
  );
  upsertComparativeConsoleRun(run);
}

function openAppendStream(path, label) {
  return new Promise((resolveStream, rejectStream) => {
    const stream = createWriteStream(path, { flags: 'a' });
    const onInitialError = (error) => {
      stream.removeListener('open', onOpen);
      rejectStream(error);
    };
    const onOpen = () => {
      stream.removeListener('error', onInitialError);
      stream.on('error', (error) => {
        stream.auditWriteError = error;
        console.error(`Write stream failed for ${label}: ${error.message}`);
      });
      resolveStream(stream);
    };
    stream.once('error', onInitialError);
    stream.once('open', onOpen);
  });
}

function closeWritableStream(stream) {
  if (!stream || stream.destroyed || stream.closed) return Promise.resolve();
  return new Promise((resolveClose) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveClose();
    };
    stream.once('close', finish);
    stream.end(finish);
  });
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o640 });
    await fs.rename(temporary, path);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

async function atomicWriteSecureJson(path, value) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, path);
    await fs.chmod(path, 0o600);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

function resolvePlaywrightExecutable() {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const executable = join(REPOSITORY_ROOT, 'node_modules', '.bin', `playwright${suffix}`);
  if (!isAbsolute(executable)) throw new Error('Playwright executable path is invalid.');
  return executable;
}

function resolveToolExecutable(name) {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return join(REPOSITORY_ROOT, 'node_modules', '.bin', `${name}${suffix}`);
}

async function prepareRunDirectoryForRunner(directory) {
  return prepareRunnerArtifactDirectory(fs, directory, RUNNER_IDENTITY);
}

async function sealRunDirectoryForReporting(run, stageName = 'reportRebuild') {
  if (!REPORT_WORKER_IDENTITY.active) return;
  return serializeRunArtifactPermissionMutation(
    run,
    () => sealRunDirectoryForReportingExclusive(run, stageName),
  );
}

async function sealRunDirectoryForReportingExclusive(run, stageName) {
  let portable = run.manifest.executionProvenance?.artifactPermissionMode === 'portable-bind';
  let removedSymlinks = 0;
  let files = 0;
  let directories = 0;
  async function transferOwnership(itemPath, uid) {
    if (portable) return;
    try {
      await fs.chown(itemPath, uid, RUNNER_IDENTITY.gid);
    } catch (error) {
      if (!ownershipTransitionUnavailable(error)) throw error;
      portable = true;
      run.manifest.executionProvenance.artifactPermissionMode = 'portable-bind';
    }
  }
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const itemPath = join(directory, entry.name);
      const details = await fs.lstat(itemPath);
      if (details.isSymbolicLink()) {
        await fs.unlink(itemPath);
        removedSymlinks += 1;
        continue;
      }
      if (details.isDirectory()) {
        await visit(itemPath);
        await transferOwnership(itemPath, 0);
        await fs.chmod(itemPath, portable ? 0o550 : 0o750);
        directories += 1;
        continue;
      }
      if (!details.isFile()) {
        throw new Error(`Run sealing rejected a non-regular artifact: ${relative(run.directory, itemPath)}`);
      }
      if (details.nlink > 1) {
        throw new Error(`Run sealing rejected a hard-linked artifact: ${relative(run.directory, itemPath)}`);
      }
      await transferOwnership(itemPath, 0);
      await fs.chmod(itemPath, portable ? 0o440 : 0o640);
      files += 1;
    }
  }
  await visit(run.directory);
  await transferOwnership(run.directory, 0);
  await fs.chmod(run.directory, portable ? 0o550 : 0o750);
  run.artifactPermissionsSealed = true;
  appendLog(
    run,
    'stdout',
    `Run evidence sealed for private report generation: ${files} regular files, ${directories} directories, ${removedSymlinks} symlinks removed; permission mode ${portable ? 'portable bind-mount (run root and existing artifacts read-only outside supervisor write windows)' : 'owner/group isolation'}.`,
    stageName,
  );
}

async function createPrivateReportStaging(run) {
  const staging = await withRunArtifactWriteWindow(
    run,
    () => fs.mkdtemp(join(run.directory, '.checklist-staging-')),
  );
  let portable = run.manifest.executionProvenance?.artifactPermissionMode === 'portable-bind';
  if (REPORT_WORKER_IDENTITY.active && !portable) {
    try {
      await fs.chown(staging, REPORT_WORKER_IDENTITY.uid, REPORT_WORKER_IDENTITY.gid);
    } catch (error) {
      if (!ownershipTransitionUnavailable(error)) throw error;
      portable = true;
      run.manifest.executionProvenance.artifactPermissionMode = 'portable-bind';
    }
  }
  if (portable) {
    const details = await fs.lstat(staging);
    if (details.uid !== REPORT_WORKER_IDENTITY.uid && details.gid !== REPORT_WORKER_IDENTITY.gid) {
      await withRunArtifactWriteWindow(run, () => fs.rm(staging, { recursive: true, force: true }));
      throw new Error(
        'Private report staging cannot be delegated safely: the bind mount does not use the isolated report worker group.',
      );
    }
    await fs.chmod(run.directory, 0o550);
  }
  await fs.chmod(staging, portable ? 0o770 : 0o750);
  return staging;
}

function portableArtifactPermissionsActive(run) {
  return run.artifactPermissionsSealed === true
    && run.manifest.executionProvenance?.artifactPermissionMode === 'portable-bind';
}

function withRunArtifactWriteWindow(run, operation, options = {}) {
  if (!portableArtifactPermissionsActive(run)) return operation();
  const execute = () => withPortableArtifactWriteWindow(
    fs,
    run.directory,
    {
      active: true,
      writablePaths: options.writablePaths ?? [],
      recursiveWritablePaths: options.recursiveWritablePaths ?? [],
      sealPaths: options.sealPaths ?? [],
      removeSealSymlinks: options.removeSealSymlinks ?? false,
    },
    operation,
  );
  return serializeRunArtifactPermissionMutation(run, execute);
}

function serializeRunArtifactPermissionMutation(run, operation) {
  const scheduled = (run.artifactPermissionMutationPromise ?? Promise.resolve()).then(operation, operation);
  run.artifactPermissionMutationPromise = scheduled.catch(() => undefined);
  return scheduled;
}

async function publishPrivateChecklist(run, staging, stageName) {
  const destination = join(run.directory, 'checklist');
  const backup = join(run.directory, `.checklist-backup-${randomBytes(6).toString('hex')}`);
  await withRunArtifactWriteWindow(run, async () => {
    let backedUp = false;
    try {
      await fs.rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      if (backedUp) await fs.rename(backup, destination).catch(() => undefined);
      throw error;
    }
    if (backedUp) await fs.rm(backup, { recursive: true, force: true });
  }, {
    recursiveWritablePaths: [destination, staging],
    sealPaths: [destination, backup],
    removeSealSymlinks: true,
  });
  await sealRunDirectoryForReporting(run, stageName);
}

async function rebuildChecklistInPrivateStaging(run, stageName, label) {
  await sealRunDirectoryForReporting(run, stageName);
  const staging = await createPrivateReportStaging(run);
  const args = [
    'scripts/rebuild-report.ts',
    join(run.directory, 'results.json'),
    staging,
  ];
  run.manifest.stages[stageName].command = ['tsx', ...args];
  try {
    await executeStage(
      run,
      stageName,
      label,
      resolveToolExecutable('tsx'),
      args,
      {
        AUDIT_ARTIFACT_DIR: run.directory,
        AUDIT_OUTPUT_DIR: staging,
      },
      { identity: REPORT_WORKER_IDENTITY },
    );
    if (run.manifest.stages[stageName].status === 'completed') {
      await publishPrivateChecklist(run, staging, stageName);
      appendLog(run, 'stdout', 'Privately staged checklist published atomically.', stageName);
    }
  } finally {
    await withRunArtifactWriteWindow(
      run,
      () => fs.rm(staging, { recursive: true, force: true }),
      { recursiveWritablePaths: [staging] },
    ).catch(() => undefined);
  }
}

async function initializeSecretVault() {
  await fs.mkdir(SECRET_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(SECRET_ROOT, 0o700);
  try {
    secretMasterKey = await fs.readFile(SECRET_MASTER_PATH);
    if (secretMasterKey.length !== 32) throw new Error('Portal secret master key has an invalid length.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    secretMasterKey = randomBytes(32);
    try {
      await fs.writeFile(SECRET_MASTER_PATH, secretMasterKey, { flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if (writeError?.code !== 'EEXIST') throw writeError;
      secretMasterKey = await fs.readFile(SECRET_MASTER_PATH);
    }
  }
  await fs.chmod(SECRET_MASTER_PATH, 0o600);

  const testOperatorToken = process.env.PORTAL_E2E_FAILURE_INJECTION === '1'
    ? process.env.PORTAL_E2E_OPERATOR_TOKEN
    : null;
  operatorCapabilityToken = testOperatorToken
    ?? createHmac('sha256', secretMasterKey).update('ai-mobile-testing:portal-operator:v1').digest('base64url');
  if (typeof operatorCapabilityToken !== 'string' || operatorCapabilityToken.length < 32) {
    throw new Error('Portal operator capability initialization failed.');
  }
  operatorSessionToken = randomBytes(32).toString('base64url');
  sensitiveLogValues.add(operatorCapabilityToken);
  sensitiveLogValues.add(operatorSessionToken);

  const environmentKey = process.env.ANTHROPIC_API_KEY;
  if (environmentKey) sensitiveLogValues.add(environmentKey);
  if (!CREDENTIAL_ISOLATION_ACTIVE) {
    if (environmentKey || await safeStat(ANTHROPIC_CREDENTIAL_PATH)) {
      console.warn('Anthropic credentials are disabled because the portal requires separate Playwright, AI, and report worker identities.');
    }
    return;
  }
  try {
    const envelope = JSON.parse(await fs.readFile(ANTHROPIC_CREDENTIAL_PATH, 'utf8'));
    const apiKey = decryptCredentialEnvelope(envelope);
    savedAnthropicCredential = {
      apiKey,
      updatedAt: typeof envelope.updatedAt === 'string' ? envelope.updatedAt : null,
      fingerprint: credentialFingerprint(apiKey),
    };
    sensitiveLogValues.add(apiKey);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Saved Anthropic credential could not be loaded: ${error.message}`);
    }
  }
}

function currentAnthropicApiKey() {
  if (!CREDENTIAL_ISOLATION_ACTIVE) return null;
  return savedAnthropicCredential?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
}

function anthropicCredentialState() {
  const apiKey = currentAnthropicApiKey();
  return {
    configured: Boolean(apiKey),
    fingerprint: apiKey ? credentialFingerprint(apiKey) : null,
    storageEnabled: CREDENTIAL_ISOLATION_ACTIVE,
    unavailableReason: CREDENTIAL_ISOLATION_ACTIVE
      ? null
      : 'Credential storage requires separate isolated Playwright, AI, and report worker identities.',
  };
}

async function saveAnthropicCredential(input) {
  if (!CREDENTIAL_ISOLATION_ACTIVE) {
    throw httpError(503, 'Anthropic credential storage is disabled until the portal has separate Playwright, AI, and report worker identities.');
  }
  const apiKey = input.trim();
  if (!ANTHROPIC_KEY_PATTERN.test(apiKey)) {
    throw httpError(400, 'The Anthropic API key format is invalid. Use a newly rotated sk-ant key.');
  }
  const updatedAt = new Date().toISOString();
  const envelope = encryptCredentialEnvelope(apiKey, updatedAt);
  const temporaryPath = `${ANTHROPIC_CREDENTIAL_PATH}.${randomBytes(4).toString('hex')}.tmp`;
  await publishCredentialEnvelope(
    fs,
    ANTHROPIC_CREDENTIAL_PATH,
    temporaryPath,
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  savedAnthropicCredential = { apiKey, updatedAt, fingerprint: credentialFingerprint(apiKey) };
  sensitiveLogValues.add(apiKey);
  console.log(`Anthropic credential saved in the portal vault (${savedAnthropicCredential.fingerprint}).`);
  triggerSingleSiteAiReviewSync();
}

async function deleteAnthropicCredential() {
  if (!savedAnthropicCredential && process.env.ANTHROPIC_API_KEY) {
    throw httpError(409, 'The configured Anthropic key is managed by the runtime environment and cannot be deleted in the portal. Restart the container without ANTHROPIC_API_KEY to remove it.');
  }
  // Delete durable state first. If unlink fails, the in-memory credential must
  // remain aligned with what a restart will load.
  await removeCredentialEnvelope(fs, ANTHROPIC_CREDENTIAL_PATH);
  if (savedAnthropicCredential?.apiKey) sensitiveLogValues.add(savedAnthropicCredential.apiKey);
  savedAnthropicCredential = null;
  console.log('Portal-saved Anthropic credential deleted.');
}

function serializeCredentialMutation(callback) {
  const operation = credentialMutationPromise.then(callback, callback);
  credentialMutationPromise = operation.catch(() => undefined);
  return operation;
}

function encryptCredentialEnvelope(apiKey, updatedAt) {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretMasterKey, initializationVector);
  cipher.setAAD(Buffer.from('ai-mobile-testing:anthropic-key:v1'));
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return {
    schemaVersion: 1,
    algorithm: 'aes-256-gcm',
    initializationVector: initializationVector.toString('base64'),
    authenticationTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    fingerprint: credentialFingerprint(apiKey),
    updatedAt,
  };
}

function decryptCredentialEnvelope(envelope) {
  if (!envelope || envelope.schemaVersion !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('Credential envelope version is unsupported.');
  }
  const initializationVector = Buffer.from(envelope.initializationVector ?? '', 'base64');
  const authenticationTag = Buffer.from(envelope.authenticationTag ?? '', 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext ?? '', 'base64');
  if (initializationVector.length !== 12 || authenticationTag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Credential envelope is incomplete.');
  }
  const decipher = createDecipheriv('aes-256-gcm', secretMasterKey, initializationVector);
  decipher.setAAD(Buffer.from('ai-mobile-testing:anthropic-key:v1'));
  decipher.setAuthTag(authenticationTag);
  const apiKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  if (!ANTHROPIC_KEY_PATTERN.test(apiKey)) throw new Error('Decrypted credential format is invalid.');
  return apiKey;
}

function credentialFingerprint(apiKey) {
  return `sha256:${createHash('sha256').update(apiKey).digest('hex').slice(0, 12)}`;
}

function sanitizedProcessEnvironment() {
  return sanitizedChildEnvironment(process.env);
}

function redactLogValue(value) {
  let redacted = value;
  for (const secret of sensitiveLogValues) redacted = redacted.split(secret).join('[REDACTED]');
  return redacted
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(authorization|x-api-key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

function safeResolve(root, requestedPath) {
  if (requestedPath.includes('\0')) return null;
  const destination = resolve(root, requestedPath);
  return destination === root || destination.startsWith(`${root}${sep}`) ? destination : null;
}

async function resolveContainedRealPath(root, requestedPath) {
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(requestedPath)]);
    return realFile === realRoot || realFile.startsWith(`${realRoot}${sep}`) ? realFile : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function safeStat(path) {
  try {
    return await fs.stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function assertManualRunReady(run) {
  if (run.purgeQuarantine) {
    throw httpError(409, 'This run has partially purged evidence in quarantine and accepts only a purge retry.');
  }
  if (run.externalManaged) {
    throw httpError(409, 'Manual evidence for an externally launched run must be managed from its original workflow.');
  }
  if (!TERMINAL_STATUSES.has(run.manifest.status) || run.child) {
    throw httpError(409, 'Manual evidence can be added only after the automated run and evidence pipeline finish.');
  }
  if (run.manifest.status === 'stopped' || run.manifest.status === 'spawn-failed') {
    throw httpError(409, 'Start a complete automated run before attaching manual acceptance evidence.');
  }
}

async function withManualMutation(run, operation) {
  const id = run.manifest.id;
  if (purgingRunIds.has(id)) {
    throw httpError(409, 'This run is being purged and cannot accept manual evidence updates.');
  }
  if (manualMutationRunIds.has(id)) {
    throw httpError(409, 'Another manual evidence upload or attestation rebuild is already running for this run.');
  }
  manualMutationRunIds.add(id);
  try {
    if (purgingRunIds.has(id) || runs.get(id) !== run) {
      throw httpError(409, 'This run is no longer available for manual evidence updates.');
    }
    return await operation();
  } finally {
    manualMutationRunIds.delete(id);
  }
}

async function readManualEvidence(run) {
  try {
    const document = JSON.parse(await fs.readFile(join(run.directory, 'manual-evidence.json'), 'utf8'));
    return document?.schemaVersion === 1 && Array.isArray(document.uploads) && Array.isArray(document.entries)
      ? document
      : { schemaVersion: 1, uploads: [], entries: [], updatedAt: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, uploads: [], entries: [], updatedAt: null };
    throw error;
  }
}

async function receiveManualUpload(run, request, requestUrl) {
  assertManualRunReady(run);
  const auditId = requestUrl.searchParams.get('auditId') ?? '';
  if (!MANUAL_AUDIT_IDS.has(auditId)) throw httpError(400, 'Choose a catalogued manual audit.');
  const idempotencyKey = requestUrl.searchParams.get('idempotencyKey') ?? '';
  if (!/^manual-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(idempotencyKey)) {
    throw httpError(400, 'Manual evidence uploads require a valid immutable idempotency key.');
  }
  const existing = (await readManualEvidence(run)).uploads.find((upload) => upload.auditId === auditId
    && upload.idempotencyKey === idempotencyKey);
  if (existing) return { ...existing, replayed: true };
  const manualRoot = join(run.directory, 'manual-evidence');
  const auditDirectory = join(manualRoot, auditId);
  const manualIndex = join(run.directory, 'manual-evidence.json');
  return withRunArtifactWriteWindow(
    run,
    () => receiveManualUploadWritable(run, request, requestUrl),
    {
      writablePaths: [manualRoot, auditDirectory],
      sealPaths: [manualRoot, manualIndex],
    },
  );
}

async function receiveManualUploadWritable(run, request, requestUrl) {
  assertManualRunReady(run);
  const auditId = requestUrl.searchParams.get('auditId') ?? '';
  if (!MANUAL_AUDIT_IDS.has(auditId)) throw httpError(400, 'Choose a catalogued manual audit.');
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0].toLowerCase();
  const allowedTypes = new Set(['video/webm', 'video/mp4', 'image/png', 'image/jpeg']);
  if (!allowedTypes.has(contentType)) throw httpError(415, 'Manual evidence must be WebM, MP4, PNG, or JPEG.');
  const declaredBytes = Number(request.headers['content-length'] ?? 0);
  if (declaredBytes > MAX_MANUAL_UPLOAD_BYTES) throw httpError(413, 'Manual evidence exceeds the 500 MB upload limit.');
  const suppliedName = basename(requestUrl.searchParams.get('filename') ?? 'manual-evidence')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 120);
  const extension = contentType === 'video/webm' ? '.webm'
    : contentType === 'video/mp4' ? '.mp4'
      : contentType === 'image/png' ? '.png' : '.jpg';
  const normalizedName = suppliedName.toLowerCase().endsWith(extension) ? suppliedName : `${suppliedName}${extension}`;
  const uploadId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const directory = join(run.directory, 'manual-evidence', auditId);
  const target = join(directory, `${uploadId}-${normalizedName}`);
  const temporary = `${target}.uploading`;
  await fs.mkdir(directory, { recursive: true });
  const handle = await fs.open(temporary, 'wx', 0o640);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_MANUAL_UPLOAD_BYTES) throw httpError(413, 'Manual evidence exceeds the 500 MB upload limit.');
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (bytesWritten < 1) throw new Error('Manual evidence upload stopped making write progress.');
        offset += bytesWritten;
      }
    }
  } catch (error) {
    await handle.close();
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  if (bytes === 0) {
    await fs.unlink(temporary).catch(() => undefined);
    throw httpError(400, 'Manual evidence upload is empty.');
  }
  let committed = false;
  try {
    const validation = await validateUploadedMedia(temporary, contentType);
    await fs.rename(temporary, target);
    committed = true;
    const document = await readManualEvidence(run);
    const upload = {
      id: uploadId,
      idempotencyKey: requestUrl.searchParams.get('idempotencyKey'),
      auditId,
      name: normalizedName,
      contentType,
      bytes,
      sha256: hash.digest('hex'),
      path: relative(run.directory, target).split(sep).join('/'),
      uploadedAt: new Date().toISOString(),
      validation,
    };
    document.uploads.push(upload);
    document.updatedAt = upload.uploadedAt;
    await atomicWriteJson(join(run.directory, 'manual-evidence.json'), document);
    return upload;
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    if (committed) await fs.unlink(target).catch(() => undefined);
    throw error;
  }
}

async function validateUploadedMedia(path, contentType) {
  const signatureHandle = await fs.open(path, 'r');
  const signature = Buffer.alloc(16);
  let signatureBytes = 0;
  try {
    ({ bytesRead: signatureBytes } = await signatureHandle.read(signature, 0, signature.length, 0));
  } finally {
    await signatureHandle.close();
  }
  if (!matchesMediaSignature(signature.subarray(0, signatureBytes), contentType)) {
    throw httpError(422, `The uploaded bytes do not match ${contentType}.`);
  }

  const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  const configuredProbe = process.env.FFPROBE_PATH;
  const ffprobe = configuredProbe ?? (basename(ffmpeg).startsWith('ffmpeg')
    ? join(dirname(ffmpeg), basename(ffmpeg).replace(/^ffmpeg/, 'ffprobe'))
    : 'ffprobe');
  const probe = await runBoundedMediaCommand(ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_type,codec_name,width,height',
    '-of', 'json',
    path,
  ]);
  if (probe.spawnError) throw httpError(503, 'Media validation is unavailable because ffprobe could not start.');
  if (probe.timedOut || probe.exitCode !== 0) {
    throw httpError(422, 'Manual evidence could not be decoded as the declared visual media type.');
  }
  let stream;
  try {
    stream = JSON.parse(probe.stdout)?.streams?.[0];
  } catch {
    // The uniform invalid-media error below keeps tool output out of responses.
  }
  if (stream?.codec_type !== 'video' || !Number.isInteger(stream.width) || stream.width < 1
    || !Number.isInteger(stream.height) || stream.height < 1) {
    throw httpError(422, 'Manual evidence must contain a decodable visual stream with valid dimensions.');
  }

  const decode = await runBoundedMediaCommand(ffmpeg, [
    '-v', 'error', '-xerror', '-i', path,
    '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-',
  ]);
  if (decode.spawnError) throw httpError(503, 'Media validation is unavailable because ffmpeg could not start.');
  if (decode.timedOut || decode.exitCode !== 0) {
    throw httpError(422, 'Manual evidence does not contain a decodable visual frame.');
  }
  return {
    valid: true,
    method: 'signature+ffprobe+ffmpeg-first-frame',
    codec: String(stream.codec_name ?? 'unknown').slice(0, 40),
    width: stream.width,
    height: stream.height,
    validatedAt: new Date().toISOString(),
  };
}

function matchesMediaSignature(bytes, contentType) {
  if (contentType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === 'video/webm') {
    return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  }
  if (contentType === 'video/mp4') {
    return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  return false;
}

function runBoundedMediaCommand(executable, args) {
  return new Promise((resolveCommand) => {
    const child = spawn(executable, args, { cwd: REPOSITORY_ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };
    let settled = false;
    let timedOut = false;
    const append = (key, chunk) => {
      const remaining = MAX_MEDIA_VALIDATION_OUTPUT_BYTES - Buffer.byteLength(output[key]);
      if (remaining > 0) output[key] += chunk.toString('utf8', 0, remaining);
    };
    child.stdout?.on('data', (chunk) => append('stdout', chunk));
    child.stderr?.on('data', (chunk) => append('stderr', chunk));
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCommand({ ...output, timedOut, ...result });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, MEDIA_VALIDATION_TIMEOUT_MS);
    timer.unref();
    child.once('error', (error) => finish({ exitCode: null, spawnError: error.message }));
    child.once('close', (exitCode, signal) => finish({ exitCode, signal, spawnError: null }));
  });
}

async function recordManualEvidence(run, body) {
  assertManualRunReady(run);
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirmed !== true) {
    throw httpError(400, 'Confirm the manual attestation before saving it.');
  }
  const auditId = typeof body.auditId === 'string' ? body.auditId : '';
  if (!MANUAL_AUDIT_IDS.has(auditId)) throw httpError(400, 'Choose a catalogued manual audit.');
  const outcome = typeof body.outcome === 'string' ? body.outcome : '';
  if (!['pass', 'fail', 'blocked'].includes(outcome)) throw httpError(400, 'Manual outcome must be pass, fail, or blocked.');
  const reviewer = typeof body.reviewer === 'string' ? body.reviewer.trim().slice(0, 120) : '';
  const device = typeof body.device === 'string' ? body.device.trim().slice(0, 200) : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 4_000) : '';
  if (reviewer.length < 2 || device.length < 2 || notes.length < 10) {
    throw httpError(400, 'Reviewer, device/browser, and detailed notes are required.');
  }
  const uploadIds = uniqueStrings(body.uploadIds);
  const document = await readManualEvidence(run);
  const attachments = document.uploads.filter((upload) => upload.auditId === auditId
    && uploadIds.includes(upload.id)
    && upload.validation?.valid === true);
  if (attachments.length !== uploadIds.length) {
    throw httpError(400, 'Every selected attachment must be a validated upload for this audit.');
  }
  if (outcome === 'pass' && !attachments.some(({ contentType }) => contentType.startsWith('video/'))) {
    throw httpError(400, 'A passing manual acceptance requires an attached video.');
  }
  const screenshotRequired = new Set(['A11Y-003', 'DEVICE-001', 'DEVICE-002', 'DEVICE-003']).has(auditId);
  if (outcome === 'pass' && screenshotRequired && !attachments.some(({ contentType }) => contentType.startsWith('image/'))) {
    throw httpError(400, 'This passing manual acceptance also requires a screenshot.');
  }
  const attestation = {
    auditId,
    outcome,
    reviewer,
    device,
    notes,
    attestedAt: new Date().toISOString(),
    attachments,
  };
  document.entries = document.entries.filter((entry) => entry.auditId !== auditId);
  document.entries.push(attestation);
  document.updatedAt = attestation.attestedAt;
  const manualIndex = join(run.directory, 'manual-evidence.json');
  await withRunArtifactWriteWindow(
    run,
    () => atomicWriteJson(manualIndex, document),
    { sealPaths: [manualIndex] },
  );
  await rebuildAfterManualEvidence(run, auditId);
  return attestation;
}

async function rebuildAfterManualEvidence(run, auditId) {
  const logDirectory = join(run.directory, 'logs');
  let logStream = null;
  let lifecycleStream = null;
  try {
    const runnerLogPath = join(logDirectory, 'runner.log');
    const lifecycleLogPath = join(logDirectory, 'lifecycle.jsonl');
    await withRunArtifactWriteWindow(run, async () => {
      logStream = await openAppendStream(runnerLogPath, `${run.manifest.id} manual rebuild runner log`);
      lifecycleStream = await openAppendStream(lifecycleLogPath, `${run.manifest.id} manual rebuild lifecycle log`);
    }, {
      writablePaths: [logDirectory, runnerLogPath, lifecycleLogPath],
      sealPaths: [runnerLogPath, lifecycleLogPath],
    });
  } catch (error) {
    await closeWritableStream(logStream);
    await closeWritableStream(lifecycleStream);
    applyPipelineFailure(run, `manual evidence rebuild log initialization failed: ${error.message}`);
    run.manifest.finishedAt = new Date().toISOString();
    await persistManifest(run);
    appendEvent(run, 'status', {
      status: run.manifest.status,
      message: terminalMessage(run.manifest),
      manifest: publicManifest(run.manifest),
    });
    throw httpError(500, 'Manual evidence was recorded, but its checklist rebuild could not open the required logs. The run is marked evidence-failed.');
  }
  run.logStream = logStream;
  run.lifecycleStream = lifecycleStream;
  attachRunStreamFailureGuards(run);
  run.manifest.stages.manualEvidenceRebuild = stageRecord('pending', [
    'tsx', 'scripts/rebuild-report.ts', '--run-dir', run.directory,
  ]);
  run.manifest.status = 'running';
  run.manifest.phase = `Rebuilding checklist after ${auditId} manual attestation`;
  run.manifest.pipeline = {
    status: 'running',
    completed: false,
    reason: `Recalculating release truth after ${auditId} manual evidence.`,
    finishedAt: null,
  };
  run.manifest.release = pendingRelease();
  await persistManifest(run);
  appendEvent(run, 'status', {
    status: run.manifest.status,
    message: run.manifest.phase,
    manifest: publicManifest(run.manifest),
  });
  let unexpectedError = null;
  try {
    await rebuildChecklistInPrivateStaging(
      run,
      'manualEvidenceRebuild',
      run.manifest.phase,
    );
    if (run.manifest.stages.manualEvidenceRebuild.status !== 'completed') {
      applyPipelineFailure(run, `manual evidence checklist rebuild failed for ${auditId}`);
    } else {
      try {
        applyCompletedRelease(
          run,
          await authoritativeReleaseForRun(run),
          `Manual evidence saved · checklist rebuilt for ${auditId}`,
        );
      } catch (error) {
        applyPipelineFailure(run, error.message);
      }
    }
    run.manifest.finishedAt = new Date().toISOString();
    await persistManifest(run);
    appendEvent(run, 'status', {
      status: run.manifest.status,
      message: terminalMessage(run.manifest),
      manifest: publicManifest(run.manifest),
    });
  } catch (error) {
    unexpectedError = error;
    applyPipelineFailure(run, `manual evidence rebuild crashed: ${error.message}`);
    run.manifest.finishedAt = new Date().toISOString();
    await persistManifest(run);
    appendEvent(run, 'status', {
      status: run.manifest.status,
      message: terminalMessage(run.manifest),
      manifest: publicManifest(run.manifest),
    });
  } finally {
    await closeWritableStream(run.logStream);
    await closeWritableStream(run.lifecycleStream);
    run.logStream = null;
    run.lifecycleStream = null;
  }
  if (unexpectedError) throw unexpectedError;
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw httpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Request body must contain valid JSON.');
  }
}

function sendJson(response, status, value, additionalHeaders = {}) {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    ...additionalHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendConsoleApiResult(request, response, result) {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    ...result.headers,
  };
  response.writeHead(result.status, headers);
  if (request.method === 'HEAD') return response.end();
  return response.end(JSON.stringify(result.body));
}

function uniqueStrings(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw httpError(400, 'Selections must be arrays of strings.');
  }
  return [...new Set(value)];
}

function queryInteger(value, name, defaultValue, minimum, maximum) {
  if (value === null || value === '') return defaultValue;
  if (!/^\d+$/.test(value)) throw httpError(400, `${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw httpError(400, `${name} must be from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function assertMutationRequest(request) {
  if (request.headers.origin === 'null') {
    throw httpError(403, 'Sandboxed artifact documents cannot call portal mutation APIs.');
  }
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw httpError(415, 'Mutation requests must use application/json.');
  }
  requireOperatorAuthorization(request);
}

function assertOperatorSessionRequest(request) {
  if (request.headers.origin === 'null') {
    throw httpError(403, 'Sandboxed artifact documents cannot establish an operator session.');
  }
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw httpError(415, 'Operator session requests must use application/json.');
  }
  assertSameOrigin(request);
}

function operatorSessionCookie() {
  return `portal_operator=${operatorSessionToken}; HttpOnly; SameSite=Strict; Path=/`;
}

function requireOperatorAuthorization(request) {
  if (request.headers.origin === 'null') {
    throw httpError(403, 'Sandboxed artifact documents cannot call portal mutation APIs.');
  }
  assertSameOrigin(request);
  if (!operatorRequestAuthorized(request)) {
    throw httpError(401, 'Operator authorization is required. Open the current operator unlock link from the portal service log.');
  }
}

function operatorRequestAuthorized(request) {
  if (!legacyOperatorEnabled) return false;
  const authorization = String(request.headers['x-portal-operator-token'] ?? '');
  if (constantTimeTokenMatch(authorization, operatorCapabilityToken)) return true;
  const cookie = String(request.headers.cookie ?? '')
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('portal_operator='))
    ?.slice('portal_operator='.length);
  return constantTimeTokenMatch(cookie, operatorSessionToken);
}

function constantTimeTokenMatch(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const provided = Buffer.from(value);
  const target = Buffer.from(expected);
  return provided.length === target.length && timingSafeEqual(provided, target);
}

function assertSameOrigin(request) {
  const authority = assertAllowedRequestHost(request);
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') {
    throw httpError(403, 'Cross-origin mutation requests are not allowed.');
  }
  const origin = request.headers.origin;
  // Browser mutations always carry Origin/Sec-Fetch-Site. Origin-less direct
  // API calls remain available only across the independently enforced local
  // socket + Host boundary above.
  if (!origin) return;
  const expectedOrigin = `http://${authority}`;
  if (origin !== expectedOrigin) throw httpError(403, 'Cross-origin mutation requests are not allowed.');
}

function assertAllowedRequestHost(request) {
  const rawHost = String(request.headers.host ?? '').trim();
  let parsed;
  try {
    parsed = new URL(`http://${rawHost}`);
  } catch {
    throw httpError(403, 'Portal requests require an allowed local Host.');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!rawHost || parsed.username || parsed.password || parsed.pathname !== '/'
    || parsed.search || parsed.hash || !ALLOWED_PORTAL_HOSTS.has(hostname)) {
    throw httpError(403, 'Portal requests require an allowed local Host.');
  }
  const remoteAddress = String(request.socket.remoteAddress ?? '').toLowerCase();
  const loopbackSocket = remoteAddress === '::1'
    || remoteAddress === '127.0.0.1'
    || remoteAddress.startsWith('::ffff:127.');
  if (!loopbackSocket && process.env.PORTAL_LOOPBACK_PUBLISHED !== '1') {
    throw httpError(403, 'Portal requests are available only through the loopback-published service.');
  }
  return parsed.host;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTerminalCodes(value) {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

function makeRunId() {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'z').replaceAll(':', '-').toLowerCase();
  return `${timestamp}-${randomBytes(3).toString('hex')}`;
}

function terminalMessage(manifest) {
  if (manifest.status === 'passed') {
    return `Evidence pipeline completed; checklist release decision: READY. ${manifest.release?.reason ?? ''}`.trim();
  }
  if (manifest.status === 'not-ready') {
    const reviews = Array.isArray(manifest.reviewReasons) && manifest.reviewReasons.length > 0
      ? ` Additional review requirements: ${manifest.reviewReasons.join('; ')}.`
      : '';
    return `Evidence pipeline completed; checklist release decision: NOT READY. ${manifest.release?.reason ?? ''}${reviews}`.replace(/\s+/g, ' ').trim();
  }
  if (manifest.status === 'review-required') {
    const reasons = Array.isArray(manifest.reviewReasons) && manifest.reviewReasons.length > 0
      ? manifest.reviewReasons.join('; ')
      : 'the run is not eligible for an automatic release decision';
    const checklistDecision = manifest.release?.decision?.replace('_', ' ') ?? 'UNAVAILABLE';
    return `Evidence pipeline completed; checklist decision: ${checklistDecision}. Release signoff is withheld. ${manifest.release?.reason ?? ''} Review requirements: ${reasons}.`.replace(/\s+/g, ' ').trim();
  }
  if (manifest.status === 'evidence-failed') {
    return `Evidence pipeline failed; no authoritative release decision is available. ${manifest.pipeline?.reason ?? ''}`.trim();
  }
  if (manifest.status === 'stopped') return 'Audit was stopped.';
  if (manifest.status === 'spawn-failed') return 'Playwright could not be started.';
  return `Evidence pipeline failed${manifest.exitCode === null ? '' : `; browser process exit code ${manifest.exitCode}`}.`;
}

function parseInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function stringOrNull(value) {
  return typeof value === 'string' ? value.slice(0, 200) : null;
}

function binaryEnvironmentFlag(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(`${name} must be exactly 0 or 1.`);
}

function numberOrNull(value) {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size === 0) throw httpError(416, 'Requested byte range is not satisfiable.');
  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) throw httpError(416, 'Requested byte range is not satisfiable.');
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    throw httpError(416, 'Requested byte range is not satisfiable.');
  }
  return { start, end: Math.min(end, size - 1) };
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
