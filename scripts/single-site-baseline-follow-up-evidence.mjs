import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openJobQueue } from './lib/job-queue.mjs';
import { readBetaProofEvidenceBundle } from './run-beta-single-site-proof.mjs';
import { readSingleSiteVisualComparisonPublication } from './lib/single-site-visual-comparisons.mjs';
import { openVisualBaselineStore, readVisualBaselineStore } from '../portal/visual-baselines.mjs';
import { openVisualReviewStore, readVisualReviewStore } from '../portal/visual-review-dispositions.mjs';
import {
  parseVisualBaselineIdentity,
  visualBaselineCanonicalJson,
  visualBaselineDigest,
  visualBaselineIdentityKey,
  visualBaselineSlotKey,
} from '../shared/visual-baseline-contract.mjs';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ELIGIBILITY_BYTES = 32 * 1_048_576;
const MAX_OUTPUT_BYTES = 2 * 1_048_576;
const scriptPath = fileURLToPath(import.meta.url);

function usage() {
  return 'Usage: node scripts/single-site-baseline-follow-up-evidence.mjs --source-job <id> --follow-up-job <id> [--queue-root <path>] [--finalization-root <path>] [--baseline-root <path>] [--review-root <path>] [--output <file>]\n';
}

function parseArguments(argv, environment = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.length % 2 !== 0) throw new Error(usage().trim());
  const values = new Map();
  const allowed = new Set([
    '--source-job', '--follow-up-job', '--queue-root', '--finalization-root',
    '--baseline-root', '--review-root', '--output',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || values.has(flag)) throw new Error(usage().trim());
    values.set(flag, value);
  }
  const sourceJobId = values.get('--source-job');
  const followUpJobId = values.get('--follow-up-job');
  if (!JOB_ID.test(sourceJobId ?? '') || !JOB_ID.test(followUpJobId ?? '') || sourceJobId === followUpJobId) {
    throw new Error('Source and follow-up must be two different valid durable job IDs.');
  }
  const queueRoot = values.get('--queue-root')
    ?? environment.PORTAL_SINGLE_SITE_QUEUE_ROOT ?? environment.AUDIT_JOB_QUEUE_ROOT;
  const finalizationRoot = values.get('--finalization-root')
    ?? environment.PORTAL_SINGLE_SITE_FINALIZATION_ROOT ?? environment.AUDIT_FINALIZATION_OUTPUT_ROOT;
  const baselineRoot = values.get('--baseline-root')
    ?? environment.PORTAL_VISUAL_BASELINE_ROOT ?? environment.AUDIT_VISUAL_BASELINE_ROOT;
  if (!queueRoot || !finalizationRoot || !baselineRoot) {
    throw new Error('Queue, finalization, and visual baseline roots are required.');
  }
  const resolvedBaselineRoot = path.resolve(baselineRoot);
  return {
    help: false,
    sourceJobId,
    followUpJobId,
    queueRoot: path.resolve(queueRoot),
    finalizationRoot: path.resolve(finalizationRoot),
    baselineRoot: resolvedBaselineRoot,
    reviewRoot: path.resolve(
      values.get('--review-root') ?? environment.PORTAL_VISUAL_REVIEW_ROOT
      ?? path.join(resolvedBaselineRoot, 'review-dispositions'),
    ),
    reviewRequired: values.has('--review-root') || environment.PORTAL_VISUAL_REVIEW_ROOT !== undefined,
    output: values.has('--output') ? path.resolve(values.get('--output')) : null,
  };
}

function canonicalTimestamp(value, label) {
  try {
    if (typeof value !== 'string' || new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw new Error(`${label} is not a canonical timestamp.`);
  }
  return value;
}

function assertHistorySnapshot(snapshot, revisionField, label) {
  const revision = snapshot?.state?.[revisionField];
  const historyDigest = snapshot?.state?.historyDigest;
  const history = snapshot?.history;
  const zero = `sha256:${'0'.repeat(64)}`;
  if (!Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(history)
    || history.length !== revision || !/^sha256:[a-f0-9]{64}$/.test(historyDigest ?? '')
    || (revision === 0 ? historyDigest !== zero : history.at(-1)?.eventDigest !== historyDigest)) {
    throw new Error(`${label} revision and history digest are inconsistent.`);
  }
}

function exactOne(values, label) {
  if (values.length !== 1) throw new Error(`${label} must resolve to exactly one record; found ${values.length}.`);
  return values[0];
}

function identityEqual(left, right) {
  return visualBaselineCanonicalJson(parseVisualBaselineIdentity(left))
    === visualBaselineCanonicalJson(parseVisualBaselineIdentity(right));
}

function sourceEvidenceMatches(record, item, eligibility) {
  return record.source.runId === eligibility.evidence.runId
    && record.source.artifactSha256 === eligibility.evidence.artifactSha256
    && record.source.artifactBytes === eligibility.evidence.artifactBytes
    && record.source.contentType === eligibility.evidence.contentType
    && record.identityKey === eligibility.identityKey
    && record.slotKey === eligibility.slotKey
    && item.current?.sha256 === record.source.artifactSha256
    && item.identityKey === record.identityKey
    && item.slotKey === record.slotKey
    && identityEqual(record.identity, eligibility.identity)
    && identityEqual(record.identity, item.identity);
}

function reviewForItem(reviewSnapshot, followUpReceipt, followUpItem, baseline) {
  if (!reviewSnapshot) return null;
  const expectedComparisonDigest = visualBaselineDigest(followUpItem.comparison);
  const related = Object.values(reviewSnapshot.state.reviews).filter(({ binding }) => (
    binding.jobId === followUpReceipt.run.jobId
    && binding.visualComparisonItemId === followUpItem.itemId
  ));
  const matches = related.filter(({ binding }) => (
    binding.jobId === followUpReceipt.run.jobId
    && binding.reportRevision === followUpReceipt.report.revision
    && binding.galleryExportRevision === followUpReceipt.gallery.exportRevision
    && binding.visualPublicationDigest === followUpReceipt.visual.publicationDigest
    && binding.visualComparisonItemId === followUpItem.itemId
    && binding.identityKey === baseline.identityKey
    && binding.slotKey === baseline.slotKey
    && binding.comparisonDigest === expectedComparisonDigest
    && binding.baselineId === baseline.baselineId
    && binding.baselineMediaSha256 === baseline.media.sha256
    && binding.currentMediaSha256 === followUpItem.current.sha256
    && binding.diffSha256 === followUpItem.diff?.sha256
  ));
  if (related.length > 0 && matches.length === 0) {
    throw new Error('Follow-up REVIEWED disposition disagrees with the visual comparison or active baseline evidence.');
  }
  if (matches.length > 1) throw new Error('Follow-up visual comparison has duplicate REVIEWED dispositions.');
  if (matches.length === 0) return null;
  const review = matches[0];
  const event = exactOne(
    reviewSnapshot.history.filter(({ eventId }) => eventId === review.eventId),
    'Visual review approval event',
  );
  return { review, event };
}

export function buildSingleSiteBaselineFollowUpEvidence({
  generatedAt,
  sourceReceipt,
  followUpReceipt,
  sourceVisual,
  sourceEligibility,
  followUpVisual,
  baselineSnapshot,
  reviewSnapshot = null,
  verifiedBaselineMedia,
}) {
  canonicalTimestamp(generatedAt, 'generatedAt');
  if (!['smoke', 'targeted', 'full'].includes(sourceReceipt?.scenario)
    || followUpReceipt?.scenario !== 'baseline-follow-up'
    || sourceReceipt.run?.jobId === followUpReceipt.run?.jobId
    || sourceReceipt.run?.origin !== followUpReceipt.run?.origin
    || sourceReceipt.run?.deploymentRole !== followUpReceipt.run?.deploymentRole
    || sourceReceipt.run?.certificatePolicy !== followUpReceipt.run?.certificatePolicy
    || sourceReceipt.revisions?.runnerRevision !== followUpReceipt.revisions?.runnerRevision
    || sourceReceipt.finalization?.status !== 'complete' || followUpReceipt.finalization?.status !== 'complete') {
    throw new Error('Source and follow-up receipts do not form the named compatible baseline proof.');
  }
  if (sourceVisual?.publicationDigest !== sourceReceipt.visual.publicationDigest
    || sourceEligibility?.manifestDigest !== sourceReceipt.visual.eligibilityManifestDigest
    || followUpVisual?.publicationDigest !== followUpReceipt.visual.publicationDigest
    || !Array.isArray(sourceVisual.items) || !Array.isArray(sourceEligibility.items)
    || !Array.isArray(followUpVisual.items)) {
    throw new Error('Visual publications do not match their durable receipts.');
  }
  assertHistorySnapshot(baselineSnapshot, 'storeRevision', 'Visual baseline store');
  if (reviewSnapshot) assertHistorySnapshot(reviewSnapshot, 'reviewRevision', 'Visual review store');
  const referencedBaselineIds = new Set(followUpVisual.items
    .map((item) => item.baseline?.baselineId)
    .filter((baselineId) => typeof baselineId === 'string'));
  const candidates = Object.values(baselineSnapshot.state.baselines).filter((record) => (
    record.source?.runId === sourceReceipt.run.jobId && record.media?.available === true
    && referencedBaselineIds.has(record.baselineId)
  ));
  const proofs = [];
  for (const baseline of candidates) {
    if (baseline.identityKey !== visualBaselineIdentityKey(baseline.identity)
      || baseline.slotKey !== visualBaselineSlotKey(baseline.identity)) {
      throw new Error(`Baseline ${baseline.baselineId} identity keys are invalid.`);
    }
    const sourceItem = exactOne(sourceVisual.items.filter((item) => (
      item.identityKey === baseline.identityKey && item.current?.sha256 === baseline.source.artifactSha256
    )), `Source visual item for baseline ${baseline.baselineId}`);
    const eligibility = exactOne(sourceEligibility.items.filter((item) => (
      item.identityKey === baseline.identityKey && item.evidence?.artifactSha256 === baseline.source.artifactSha256
    )), `Source eligibility item for baseline ${baseline.baselineId}`);
    if (eligibility.eligible !== true || !sourceEvidenceMatches(baseline, sourceItem, eligibility)) {
      throw new Error(`Baseline ${baseline.baselineId} does not match eligible source evidence.`);
    }
    const approvalEvent = exactOne(baselineSnapshot.history.filter((event) => (
      ['approved', 'replaced'].includes(event.type) && event.payload?.record?.baselineId === baseline.baselineId
    )), `Approval event for baseline ${baseline.baselineId}`);
    if (approvalEvent.eventId !== baselineSnapshot.history[approvalEvent.sequence - 1]?.eventId
      || approvalEvent.payload.record.identityKey !== baseline.identityKey
      || approvalEvent.payload.record.media.sha256 !== baseline.media.sha256
      || approvalEvent.payload.record.source.artifactSha256 !== baseline.source.artifactSha256) {
      throw new Error(`Baseline ${baseline.baselineId} approval event disagrees with the reconstructed store.`);
    }
    const verified = verifiedBaselineMedia?.[baseline.baselineId];
    if (!verified || verified.sha256 !== baseline.media.sha256 || verified.bytes !== baseline.media.bytes) {
      throw new Error(`Baseline ${baseline.baselineId} media bytes were not independently verified.`);
    }
    const followUpItem = exactOne(followUpVisual.items.filter((item) => (
      item.baseline?.baselineId === baseline.baselineId && item.identityKey === baseline.identityKey
    )), `Follow-up visual item for baseline ${baseline.baselineId}`);
    if (!['UNCHANGED', 'CHANGED'].includes(followUpItem.comparison?.status)
      || followUpItem.baseline.mediaSha256 !== baseline.media.sha256
      || followUpItem.slotKey !== baseline.slotKey || !identityEqual(followUpItem.identity, baseline.identity)
      || !followUpItem.current?.sha256
      || (followUpItem.comparison.status === 'CHANGED' && !followUpItem.diff?.sha256)
      || (followUpItem.diff !== null && !followUpItem.diff?.sha256)) {
      throw new Error(`Follow-up visual item for baseline ${baseline.baselineId} is not a compatible comparison.`);
    }
    const reviewed = reviewForItem(reviewSnapshot, followUpReceipt, followUpItem, baseline);
    proofs.push({
      evidenceId: eligibility.evidenceId,
      baseline: {
        storeRevision: baselineSnapshot.state.storeRevision,
        historyDigest: baselineSnapshot.state.historyDigest,
        record: baseline,
        recordDigest: visualBaselineDigest(baseline),
        baselineId: baseline.baselineId,
        state: baseline.state,
        identityKey: baseline.identityKey,
        slotKey: baseline.slotKey,
        identity: baseline.identity,
        media: { sha256: baseline.media.sha256, bytes: baseline.media.bytes, verified: true },
        source: baseline.source,
        approvedBy: baseline.approvedBy,
        approvedAt: baseline.approvedAt,
        approvalEvent,
      },
      followUp: {
        itemId: followUpItem.itemId,
        identityKey: followUpItem.identityKey,
        slotKey: followUpItem.slotKey,
        identity: followUpItem.identity,
        currentSha256: followUpItem.current.sha256,
        baselineSha256: followUpItem.baseline.mediaSha256,
        diffSha256: followUpItem.diff?.sha256 ?? null,
        comparisonDigest: visualBaselineDigest(followUpItem.comparison),
        rawStatus: followUpItem.comparison.status,
        status: reviewed ? 'REVIEWED' : followUpItem.comparison.status,
      },
      review: reviewed ? {
        reviewRevision: reviewSnapshot.state.reviewRevision,
        historyDigest: reviewSnapshot.state.historyDigest,
        reviewKey: reviewed.review.reviewKey,
        disposition: reviewed.review.disposition,
        rationale: reviewed.review.rationale,
        actorId: reviewed.review.actorId,
        reviewedAt: reviewed.review.reviewedAt,
        event: reviewed.event,
      } : null,
    });
  }
  if (proofs.length === 0) throw new Error('No retained baseline from the source run has a compatible follow-up comparison.');
  proofs.sort((left, right) => left.baseline.identityKey.localeCompare(right.baseline.identityKey));
  const body = {
    schemaVersion: 1,
    kind: 'single-site-baseline-follow-up-evidence',
    generatedAt,
    source: { jobId: sourceReceipt.run.jobId, receiptDigest: sourceReceipt.receiptDigest },
    followUp: { jobId: followUpReceipt.run.jobId, receiptDigest: followUpReceipt.receiptDigest },
    baselineStore: {
      storeRevision: baselineSnapshot.state.storeRevision,
      historyDigest: baselineSnapshot.state.historyDigest,
    },
    reviewStore: reviewSnapshot ? {
      reviewRevision: reviewSnapshot.state.reviewRevision,
      historyDigest: reviewSnapshot.state.historyDigest,
    } : null,
    proofs,
    policyEffects: { deterministicFindings: 'none', siteHealth: 'none', coverage: 'none', promotion: 'none' },
  };
  const document = { ...body, baselineFollowUpEvidenceDigest: visualBaselineDigest(body) };
  if (Buffer.byteLength(visualBaselineCanonicalJson(document)) > MAX_OUTPUT_BYTES) {
    throw new Error('Baseline follow-up evidence exceeds its bounded output size.');
  }
  return Object.freeze(document);
}

export function validateSingleSiteBaselineFollowUpEvidence(value) {
  const keys = [
    'schemaVersion', 'kind', 'generatedAt', 'source', 'followUp', 'baselineStore',
    'reviewStore', 'proofs', 'policyEffects', 'baselineFollowUpEvidenceDigest',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== keys.sort().join('\0')
    || value.schemaVersion !== 1 || value.kind !== 'single-site-baseline-follow-up-evidence'
    || !Array.isArray(value.proofs) || value.proofs.length < 1
    || !/^sha256:[a-f0-9]{64}$/.test(value.baselineFollowUpEvidenceDigest ?? '')) {
    throw new Error('Single-site baseline follow-up evidence is malformed.');
  }
  canonicalTimestamp(value.generatedAt, 'generatedAt');
  const { baselineFollowUpEvidenceDigest, ...body } = value;
  if (visualBaselineDigest(body) !== baselineFollowUpEvidenceDigest) {
    throw new Error('Single-site baseline follow-up evidence digest is invalid.');
  }
  if (visualBaselineCanonicalJson(value.policyEffects) !== visualBaselineCanonicalJson({
    deterministicFindings: 'none', siteHealth: 'none', coverage: 'none', promotion: 'none',
  })) {
    throw new Error('Single-site baseline follow-up evidence has invalid policy effects.');
  }
  return value;
}

async function readEligibility(finalizationRoot, jobId, receipt) {
  const root = path.resolve(finalizationRoot, jobId, 'visual');
  const file = path.join(root, 'eligibility.json');
  const [rootReal, stat] = await Promise.all([fs.realpath(root), fs.lstat(file)]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_ELIGIBILITY_BYTES) {
    throw new Error(`Source eligibility publication for ${jobId} is unsafe or oversized.`);
  }
  const real = await fs.realpath(file);
  if (real !== path.join(rootReal, 'eligibility.json')) throw new Error(`Source eligibility publication for ${jobId} escaped its root.`);
  const handle = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let document;
  try { document = JSON.parse((await handle.readFile()).toString('utf8')); } finally { await handle.close(); }
  const { manifestDigest, ...body } = document;
  if (manifestDigest !== receipt.visual.eligibilityManifestDigest
    || manifestDigest !== visualBaselineDigest(body) || document.jobId !== jobId) {
    throw new Error(`Source eligibility publication for ${jobId} failed digest verification.`);
  }
  return document;
}

async function verifyBaselineMedia(store, snapshot, baselineIds) {
  const result = {};
  const rootReal = await fs.realpath(store.root);
  for (const baselineId of baselineIds) {
    const record = snapshot.state.baselines[baselineId];
    const file = path.resolve(store.root, record.media.relativePath);
    const stat = await fs.lstat(file);
    const real = await fs.realpath(file);
    if (!stat.isFile() || stat.isSymbolicLink() || real !== file
      || !(real === rootReal || real.startsWith(`${rootReal}${path.sep}`)) || stat.size !== record.media.bytes) {
      throw new Error(`Baseline ${baselineId} media is missing or unsafe.`);
    }
    const handle = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let bytes;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== record.media.sha256) throw new Error(`Baseline ${baselineId} media digest is invalid.`);
    result[baselineId] = { sha256: digest, bytes: bytes.length };
  }
  return result;
}

async function atomicWrite(file, document) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${visualBaselineCanonicalJson(document)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv, environment);
  if (options.help) { process.stdout.write(usage()); return null; }
  const queue = await openJobQueue({ root: options.queueRoot });
  const [sourceBundle, followUpBundle] = await Promise.all([
    readBetaProofEvidenceBundle(options.finalizationRoot, options.sourceJobId, { queue }),
    readBetaProofEvidenceBundle(options.finalizationRoot, options.followUpJobId, { queue }),
  ]);
  if (!sourceBundle || !followUpBundle) throw new Error('Both jobs require durable beta proof receipts.');
  const sourceReceipt = sourceBundle.receipt;
  const followUpReceipt = followUpBundle.receipt;
  const sourceAttemptId = sourceReceipt.publications.attemptId ?? sourceReceipt.terminal.attemptId;
  const followUpAttemptId = followUpReceipt.publications.attemptId ?? followUpReceipt.terminal.attemptId;
  const [sourceVisual, sourceEligibility, followUpVisual, baselineStore] = await Promise.all([
    readSingleSiteVisualComparisonPublication({
      outputDir: path.join(options.finalizationRoot, options.sourceJobId, 'visual'),
      jobId: options.sourceJobId, attemptId: sourceAttemptId,
      finalizationDigest: sourceReceipt.finalization.finalizationDigest, reportRevision: sourceReceipt.report.revision,
    }),
    readEligibility(options.finalizationRoot, options.sourceJobId, sourceReceipt),
    readSingleSiteVisualComparisonPublication({
      outputDir: path.join(options.finalizationRoot, options.followUpJobId, 'visual'),
      jobId: options.followUpJobId, attemptId: followUpAttemptId,
      finalizationDigest: followUpReceipt.finalization.finalizationDigest, reportRevision: followUpReceipt.report.revision,
    }),
    openVisualBaselineStore({ root: options.baselineRoot }),
  ]);
  const baselineSnapshot = await readVisualBaselineStore(baselineStore);
  let reviewSnapshot = null;
  try {
    const stat = await fs.lstat(options.reviewRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Visual review root is unsafe.');
    reviewSnapshot = await readVisualReviewStore(await openVisualReviewStore({ root: options.reviewRoot }));
  } catch (error) {
    if (error?.code !== 'ENOENT' || options.reviewRequired) throw error;
  }
  const followUpBaselineIds = new Set(followUpVisual.items
    .map((item) => item.baseline?.baselineId)
    .filter((baselineId) => typeof baselineId === 'string'));
  const baselineIds = Object.values(baselineSnapshot.state.baselines)
    .filter((record) => record.source.runId === options.sourceJobId && record.media.available
      && followUpBaselineIds.has(record.baselineId))
    .map(({ baselineId }) => baselineId);
  const verifiedBaselineMedia = await verifyBaselineMedia(baselineStore, baselineSnapshot, baselineIds);
  const document = buildSingleSiteBaselineFollowUpEvidence({
    generatedAt: new Date().toISOString(), sourceReceipt, followUpReceipt, sourceVisual, sourceEligibility,
    followUpVisual, baselineSnapshot, reviewSnapshot, verifiedBaselineMedia,
  });
  if (options.output) await atomicWrite(options.output, document);
  process.stdout.write(`${visualBaselineCanonicalJson(document)}\n`);
  return document;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'single-site-baseline-follow-up-evidence-failed', message: error.message })}\n`);
    process.exitCode = 1;
  });
}
