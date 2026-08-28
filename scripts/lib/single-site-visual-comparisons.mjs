import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  VISUAL_CAPTURE_METADATA_CONTENT_TYPE,
  normalizedRelativePath,
  parseVisualCaptureMetadata,
  visualBaselineCanonicalJson,
  visualBaselineDigest,
} from '../../shared/visual-baseline-contract.mjs';
import { resolveVisualBaseline } from '../../portal/visual-baselines.mjs';
import { visualComparisonUnavailable } from '../../audit/visual-policy.ts';
import { compareVisualBaselineFiles } from '../compare-visual-baselines.ts';
import {
  verifyVisualComparatorCalibration,
  verifyPublishedVisualComparatorCalibration,
  verifiedVisualComparisonDependencies,
  visualComparatorCalibrationEqual,
} from './visual-comparator-calibration.mjs';

const MAX_RESULTS = 10_000;
const MAX_ATTACHMENTS = 2_000;
const MAX_METADATA_BYTES = 2 * 1_048_576;
const MAX_IMAGE_BYTES = 100 * 1_048_576;
const STATUS_PRIORITY = new Map([
  ['CHANGED', 5], ['unavailable', 4], ['incompatible', 3], ['UNCHANGED', 2], ['absent', 1],
]);

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || new Date(value).toISOString() !== value) fail('generatedAt must be a canonical ISO timestamp.');
  return value;
}

function safeRunId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) fail('runId is invalid.');
  return value;
}

function inlineAttachmentJson(attachment) {
  if (!isRecord(attachment) || attachment.contentType !== VISUAL_CAPTURE_METADATA_CONTENT_TYPE
    || typeof attachment.body !== 'string' || attachment.body.length < 4
    || attachment.body.length > Math.ceil(MAX_METADATA_BYTES * 4 / 3) + 8
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.body)) return null;
  const bytes = Buffer.from(attachment.body, 'base64');
  if (bytes.length < 2 || bytes.length > MAX_METADATA_BYTES) return null;
  try { return parseVisualCaptureMetadata(JSON.parse(bytes.toString('utf8'))); } catch { return null; }
}

function flattenTests(document) {
  if (!isRecord(document) || !Array.isArray(document.suites)) fail('Playwright results must contain suites.');
  const output = [];
  const visit = (suites, depth = 0) => {
    if (depth > 32 || !Array.isArray(suites)) fail('Playwright result suite nesting is invalid.');
    for (const suite of suites) {
      if (!isRecord(suite)) fail('Playwright result suite is invalid.');
      for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
        if (!isRecord(spec) || !Array.isArray(spec.tests)) fail('Playwright result spec is invalid.');
        for (const test of spec.tests) {
          if (!isRecord(test) || output.length >= MAX_RESULTS) fail('Playwright result tests are invalid or exceed their bound.');
          output.push(test);
        }
      }
      visit(suite.suites ?? [], depth + 1);
    }
  };
  visit(document.suites);
  return output;
}

function caseId(test) {
  const values = (Array.isArray(test.annotations) ? test.annotations : [])
    .filter((annotation) => isRecord(annotation) && annotation.type === 'audit-case-id')
    .map(({ description }) => description)
    .filter((value) => typeof value === 'string' && value.trim());
  return values.length === 1 ? values[0] : null;
}

function decodeInlineJsonAttachment(attachment, maximumBytes = MAX_METADATA_BYTES) {
  if (!isRecord(attachment) || typeof attachment.body !== 'string' || attachment.body.length < 4
    || attachment.body.length > Math.ceil(maximumBytes * 4 / 3) + 8
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.body)) return null;
  const bytes = Buffer.from(attachment.body, 'base64');
  if (bytes.length < 2 || bytes.length > maximumBytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
}

function deterministicFindingCounts(findings) {
  if (!Array.isArray(findings) || findings.length > MAX_RESULTS) {
    fail('Deterministic findings must be a bounded array.');
  }
  const counts = new Map();
  for (const finding of findings) {
    if (!isRecord(finding) || typeof finding.auditId !== 'string' || !finding.auditId.trim()) {
      fail('Deterministic finding metadata is invalid.');
    }
    if (finding.executionId === undefined) continue;
    if (typeof finding.executionId !== 'string' || !finding.executionId.trim()) {
      fail('Deterministic finding execution identity is invalid.');
    }
    const key = `${finding.auditId}\0${finding.executionId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function evidenceAssessment(
  test,
  attachments,
  captureMetadata,
  plannedCaseId,
  projectName,
  executionId,
  associatedFindingCount,
) {
  const reasons = [];
  const finalResult = Array.isArray(test.results) ? test.results.at(-1) : null;
  const summaries = attachments.filter((attachment) => isRecord(attachment)
    && attachment.name === 'audit-result-summary' && attachment.contentType === 'application/json');
  const legacy = attachments.filter((attachment) => isRecord(attachment)
    && attachment.name === 'audit-result' && attachment.contentType === 'application/json'
    && typeof attachment.body === 'string');
  const records = summaries.length === 1 ? summaries : legacy;
  if (records.length !== 1 || summaries.length > 1) reasons.push('The final attempt did not publish exactly one audit-result decision summary.');
  const record = records.length === 1 ? decodeInlineJsonAttachment(records[0], 4 * 1_048_576) : null;
  if (!isRecord(record) || record.schemaVersion !== 1 || record.mode !== 'single-site'
    || record.caseId !== plannedCaseId || record.auditId !== captureMetadata.identity.auditId
    || record.project !== projectName || !isRecord(record.evidenceAuthority)
    || !Array.isArray(record.findings)) {
    reasons.push('The checkpoint audit-result summary is missing, malformed, or does not match its compiled execution.');
  }
  const structuredFindingCount = Array.isArray(record?.findings) ? record.findings.length : null;
  const settledPass = test.status === 'expected'
    && test.expectedStatus === 'passed'
    && finalResult?.status === 'passed'
    && structuredFindingCount !== null
    && associatedFindingCount === structuredFindingCount;
  const settledAssertionFinding = test.status === 'unexpected'
    && test.expectedStatus === 'passed'
    && finalResult?.status === 'failed'
    && structuredFindingCount !== null
    && associatedFindingCount === structuredFindingCount + 1;
  if (!settledPass && !settledAssertionFinding) {
    reasons.push(
      `The checkpoint did not come from a settled passing or deterministic-finding final Playwright attempt (${executionId}).`,
    );
  }
  return {
    valid: reasons.length === 0,
    reasons,
    evidenceAuthority: isRecord(record?.evidenceAuthority) ? record.evidenceAuthority : null,
    findingCount: structuredFindingCount === null ? null : associatedFindingCount,
  };
}

function currentAttemptAttachments(test) {
  if (!Array.isArray(test.results) || test.results.length === 0) return [];
  const result = test.results.at(-1);
  if (!isRecord(result) || !Array.isArray(result.attachments) || result.attachments.length > MAX_ATTACHMENTS) return [];
  return result.attachments;
}

export function collectSingleSiteVisualCaptures(playwrightResults, deterministicFindings = []) {
  const findingCounts = deterministicFindingCounts(deterministicFindings);
  const captures = [];
  for (const test of flattenTests(playwrightResults)) {
    const plannedCaseId = caseId(test);
    const projectName = typeof test.projectName === 'string' ? test.projectName : null;
    if (!plannedCaseId || !projectName) continue;
    const attachments = currentAttemptAttachments(test);
    const imagesByName = new Map();
    for (const attachment of attachments) {
      if (!isRecord(attachment) || attachment.contentType !== 'image/png' || typeof attachment.name !== 'string') continue;
      const occurrences = imagesByName.get(attachment.name) ?? [];
      occurrences.push(attachment);
      imagesByName.set(attachment.name, occurrences);
    }
    for (const attachment of attachments) {
      const metadata = inlineAttachmentJson(attachment);
      if (!metadata) continue;
      if (metadata.identity.targetId !== projectName) fail('Visual capture target does not match its Playwright project.');
      const image = imagesByName.get(metadata.attachmentName)?.[metadata.attachmentOccurrence] ?? null;
      const executionId = `${plannedCaseId}@${projectName}`;
      captures.push(Object.freeze({
        executionId,
        caseId: plannedCaseId,
        auditId: metadata.identity.auditId,
        targetId: projectName,
        metadata,
        image,
        evidenceAssessment: evidenceAssessment(
          test,
          attachments,
          metadata,
          plannedCaseId,
          projectName,
          executionId,
          findingCounts.get(`${metadata.identity.auditId}\0${executionId}`) ?? 0,
        ),
      }));
    }
  }
  captures.sort((left, right) => (
    left.executionId.localeCompare(right.executionId)
    || left.metadata.identityKey.localeCompare(right.metadata.identityKey)
    || left.metadata.attachmentOccurrence - right.metadata.attachmentOccurrence
  ));
  return Object.freeze(captures);
}

async function boundedArtifact(root, attachment) {
  if (!isRecord(attachment) || typeof attachment.path !== 'string' || !attachment.path) {
    return { status: 'unavailable', reason: 'The checkpoint PNG has no filesystem path in the final Playwright attempt.' };
  }
  const candidate = path.resolve(path.isAbsolute(attachment.path) ? attachment.path : path.join(root.absolute, attachment.path));
  if (!contained(root.absolute, candidate)) return { status: 'unavailable', reason: 'The checkpoint PNG path escapes its fenced attempt artifact root.' };
  try {
    const [stat, real] = await Promise.all([fs.lstat(candidate), fs.realpath(candidate)]);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES || !contained(root.real, real)) {
      return { status: 'unavailable', reason: 'The checkpoint PNG is not a bounded regular file inside its fenced attempt artifact root.' };
    }
    const handle = await fs.open(candidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const bytes = await handle.readFile();
      return {
        status: 'available',
        path: candidate,
        relativePath: normalizedRelativePath(path.relative(root.absolute, candidate).split(path.sep).join('/')),
        bytes: bytes.length,
        sha256: visualBaselineDigest(bytes),
      };
    } finally { await handle.close(); }
  } catch {
    return { status: 'unavailable', reason: 'The checkpoint PNG is missing, unreadable, or unsafe.' };
  }
}

function publicBaseline(resolution) {
  if (!resolution.baseline) return null;
  return {
    baselineId: resolution.baseline.baselineId,
    identityKey: resolution.baseline.identityKey,
    slotKey: resolution.baseline.slotKey,
    approvedAt: resolution.baseline.approvedAt,
    mediaSha256: resolution.baseline.media.sha256,
  };
}

async function writeExclusive(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

function summarize(items) {
  const byStatus = Object.fromEntries(['UNCHANGED', 'CHANGED', 'absent', 'incompatible', 'unavailable'].map((status) => [status, 0]));
  for (const item of items) byStatus[item.comparison.status] += 1;
  return { total: items.length, attentionRequired: byStatus.CHANGED, byStatus };
}

function digestHex(value, label, length = 64) {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) fail(`${label} is invalid.`);
  return value;
}

function evidenceAuthority(value) {
  if (!isRecord(value) || !['authoritative', 'non-authoritative'].includes(value.status)
    || !Array.isArray(value.reasons) || value.reasons.some((reason) => typeof reason !== 'string' || !reason.trim())) {
    fail('evidenceAuthority is invalid.');
  }
  return { status: value.status, reasons: [...value.reasons].sort() };
}

async function verifyExistingPublication(outputDir, document, eligibility) {
  const existing = JSON.parse(await fs.readFile(path.join(outputDir, 'visual-comparisons.json'), 'utf8'));
  if (visualBaselineCanonicalJson(existing) !== visualBaselineCanonicalJson(document)) {
    throw new Error('Immutable visual comparison publication already exists with different content.');
  }
  const existingEligibility = JSON.parse(await fs.readFile(path.join(outputDir, 'eligibility.json'), 'utf8'));
  if (visualBaselineCanonicalJson(existingEligibility) !== visualBaselineCanonicalJson(eligibility)) {
    throw new Error('Immutable visual baseline eligibility manifest already exists with different content.');
  }
  for (const item of document.items) {
    if (!item.diff) continue;
    const bytes = await fs.readFile(path.join(outputDir, ...item.diff.relativePath.split('/')));
    if (bytes.length !== item.diff.bytes || visualBaselineDigest(bytes) !== item.diff.sha256) {
      throw new Error(`Immutable visual diff ${item.diff.relativePath} is missing or corrupt.`);
    }
  }
}

async function boundedJson(file, maximumBytes = 32 * 1_048_576) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximumBytes) {
    throw new Error(`Visual publication document is empty, unsafe, or oversized: ${path.basename(file)}.`);
  }
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function readSingleSiteVisualComparisonPublication(options) {
  return readSingleSiteVisualComparisonPublicationInternal(options);
}

export async function __testOnlyReadSingleSiteVisualComparisonPublication(options, currentCalibrationRevision) {
  return readSingleSiteVisualComparisonPublicationInternal(options, { currentRevision: currentCalibrationRevision });
}

async function readSingleSiteVisualComparisonPublicationInternal({
  outputDir,
  jobId,
  attemptId,
  finalizationDigest,
  reportRevision,
}, calibrationOptions = {}) {
  safeRunId(jobId);
  safeRunId(attemptId);
  digestHex(finalizationDigest, 'finalizationDigest');
  digestHex(reportRevision, 'reportRevision', 32);
  const directory = path.resolve(outputDir);
  const [document, eligibility] = await Promise.all([
    boundedJson(path.join(directory, 'visual-comparisons.json')),
    boundedJson(path.join(directory, 'eligibility.json')),
  ]);
  if (!isRecord(document) || document.schemaVersion !== 1
    || document.kind !== 'single-site-visual-comparison-publication' || document.mode !== 'single-site'
    || document.runId !== jobId || !Array.isArray(document.items) || document.items.length > MAX_RESULTS
    || !isRecord(document.eligibility) || document.eligibility.relativePath !== 'eligibility.json') {
    throw new Error('Immutable visual comparison publication has an invalid binding or shape.');
  }
  const comparatorCalibration = await verifyPublishedVisualComparatorCalibration(
    document.comparatorCalibration,
    calibrationOptions,
  );
  const { publicationDigest, ...publicationBody } = document;
  if (publicationDigest !== visualBaselineDigest(publicationBody)) {
    throw new Error('Immutable visual comparison publication digest is invalid.');
  }
  if (!isRecord(eligibility) || eligibility.schemaVersion !== 1
    || eligibility.kind !== 'single-site-visual-baseline-eligibility' || eligibility.mode !== 'single-site'
    || eligibility.jobId !== jobId || eligibility.attemptId !== attemptId
    || eligibility.finalizationDigest !== finalizationDigest || eligibility.reportRevision !== reportRevision
    || !Array.isArray(eligibility.items) || eligibility.items.length > MAX_RESULTS
    || !visualComparatorCalibrationEqual(eligibility.comparatorCalibration, comparatorCalibration)) {
    throw new Error('Immutable visual baseline eligibility manifest has an invalid binding or shape.');
  }
  const { manifestDigest, ...eligibilityBody } = eligibility;
  if (manifestDigest !== visualBaselineDigest(eligibilityBody)
    || document.eligibility.manifestDigest !== manifestDigest) {
    throw new Error('Immutable visual baseline eligibility manifest digest is invalid.');
  }
  await verifyExistingPublication(directory, document, eligibility);
  return Object.freeze(document);
}

export async function publishSingleSiteVisualComparisons(options) {
  if (isRecord(options) && Object.hasOwn(options, 'dependencies')) {
    fail('Production visual publication does not permit dependency injection.');
  }
  return publishSingleSiteVisualComparisonsInternal(options);
}

export async function __testOnlyPublishSingleSiteVisualComparisons(options, dependencies) {
  return publishSingleSiteVisualComparisonsInternal(options, dependencies);
}

async function publishSingleSiteVisualComparisonsInternal({
  playwrightResults,
  deterministicFindings = [],
  artifactRoot,
  baselineStore,
  outputDir,
  jobId,
  attemptId,
  finalizationDigest,
  reportRevision,
  generatedAt,
  runStatus,
  evidenceComplete,
  evidenceAuthority: rawEvidenceAuthority,
}, testDependencies = undefined) {
  safeRunId(jobId);
  safeRunId(attemptId);
  digestHex(finalizationDigest, 'finalizationDigest');
  digestHex(reportRevision, 'reportRevision', 32);
  canonicalTimestamp(generatedAt);
  if (!['completed', 'failed', 'incomplete', 'cancelled'].includes(runStatus)) fail('runStatus is invalid.');
  if (typeof evidenceComplete !== 'boolean') fail('evidenceComplete must be boolean.');
  const authority = evidenceAuthority(rawEvidenceAuthority);
  const comparatorCalibration = await verifyVisualComparatorCalibration();
  const comparisonDependencies = testDependencies
    ?? verifiedVisualComparisonDependencies(comparatorCalibration);
  const rootAbsolute = path.resolve(artifactRoot);
  const rootStat = await fs.lstat(rootAbsolute);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('artifactRoot must be a real directory.');
  const root = { absolute: rootAbsolute, real: await fs.realpath(rootAbsolute) };
  const destination = path.resolve(outputDir);
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    const items = [];
    const eligibilityItems = [];
    const seen = new Set();
    for (const capture of collectSingleSiteVisualCaptures(playwrightResults, deterministicFindings)) {
      const itemId = visualBaselineDigest([
        capture.executionId, capture.metadata.identityKey, capture.metadata.attachmentOccurrence,
      ]).slice('sha256:'.length, 'sha256:'.length + 32);
      if (seen.has(itemId)) fail(`Duplicate visual capture identity ${itemId}.`);
      seen.add(itemId);
      const current = await boundedArtifact(root, capture.image);
      let resolution = null;
      let comparison;
      let diff = null;
      if (current.status !== 'available') {
        comparison = visualComparisonUnavailable('unavailable', current.reason);
      } else {
        resolution = await resolveVisualBaseline(baselineStore, capture.metadata.identity);
        if (resolution.status !== 'compatible') {
          comparison = visualComparisonUnavailable(resolution.status, resolution.reason);
        } else {
          const compared = await compareVisualBaselineFiles({
            baselinePath: resolution.mediaPath,
            currentPath: current.path,
            dependencies: comparisonDependencies,
          });
          comparison = compared.comparison;
          if ('diffPng' in compared) {
            const relativePath = `diffs/${itemId}.png`;
            const bytes = Buffer.from(compared.diffPng);
            await fs.mkdir(path.join(temporary, 'diffs'), { recursive: true });
            await writeExclusive(path.join(temporary, ...relativePath.split('/')), bytes);
            diff = { relativePath, bytes: bytes.length, sha256: visualBaselineDigest(bytes) };
          }
        }
      }
      items.push({
        schemaVersion: 1,
        itemId,
        executionId: capture.executionId,
        caseId: capture.caseId,
        auditId: capture.auditId,
        targetId: capture.targetId,
        identity: capture.metadata.identity,
        identityKey: capture.metadata.identityKey,
        slotKey: capture.metadata.slotKey,
        current: current.status === 'available' ? {
          relativePath: current.relativePath, bytes: current.bytes, sha256: current.sha256,
        } : null,
        baseline: publicBaseline(resolution ?? {}),
        compatibility: resolution?.compatibility ?? null,
        comparison,
        diff,
      });
      const eligibilityReasons = [...capture.evidenceAssessment.reasons];
      if (runStatus !== 'completed') eligibilityReasons.push(`The run ended ${runStatus}, not completed.`);
      if (!evidenceComplete) eligibilityReasons.push('The finalized report did not establish complete required evidence.');
      if (authority.status !== 'authoritative') eligibilityReasons.push('The run evidence is non-authoritative.');
      if (visualBaselineCanonicalJson(capture.evidenceAssessment.evidenceAuthority) !== visualBaselineCanonicalJson(authority)) {
        eligibilityReasons.push('The checkpoint evidence authority does not match the finalized run authority.');
      }
      if (capture.evidenceAssessment.findingCount === null) {
        eligibilityReasons.push('The checkpoint has no trustworthy deterministic Finding state.');
      }
      if (current.status !== 'available') eligibilityReasons.push(current.reason);
      const evidenceId = visualBaselineDigest({
        jobId,
        attemptId,
        identityKey: capture.metadata.identityKey,
        artifactSha256: current.status === 'available' ? current.sha256 : null,
      });
      eligibilityItems.push({
        evidenceId,
        identity: capture.metadata.identity,
        identityKey: capture.metadata.identityKey,
        slotKey: capture.metadata.slotKey,
        evidence: current.status === 'available' ? {
          runId: jobId,
          artifactRelativePath: current.relativePath,
          artifactSha256: current.sha256,
          artifactBytes: current.bytes,
          contentType: 'image/png',
          runStatus,
          evidenceComplete,
          evidenceAuthority: authority,
          findingStatus: capture.evidenceAssessment.findingCount === 0 ? 'clear' : 'unresolved',
          findingWaiver: null,
        } : null,
        requiresFindingWaiver: capture.evidenceAssessment.findingCount !== null
          && capture.evidenceAssessment.findingCount > 0,
        eligible: eligibilityReasons.length === 0,
        ineligibilityReasons: [...new Set(eligibilityReasons)].sort(),
      });
    }
    const eligibilityBody = {
      schemaVersion: 1,
      kind: 'single-site-visual-baseline-eligibility',
      mode: 'single-site',
      jobId,
      attemptId,
      finalizationDigest,
      reportRevision,
      generatedAt,
      comparatorCalibration,
      items: eligibilityItems,
    };
    const eligibility = { ...eligibilityBody, manifestDigest: visualBaselineDigest(eligibilityBody) };
    await writeExclusive(path.join(temporary, 'eligibility.json'), `${visualBaselineCanonicalJson(eligibility)}\n`);
    const body = {
      schemaVersion: 1,
      kind: 'single-site-visual-comparison-publication',
      mode: 'single-site',
      runId: jobId,
      generatedAt,
      comparatorCalibration,
      eligibility: { relativePath: 'eligibility.json', manifestDigest: eligibility.manifestDigest },
      policyEffects: { deterministicHealth: 'none', deterministicFindings: 'none', promotion: 'none' },
      summary: summarize(items),
      items,
    };
    const document = { ...body, publicationDigest: visualBaselineDigest(body) };
    await writeExclusive(path.join(temporary, 'visual-comparisons.json'), `${visualBaselineCanonicalJson(document)}\n`);
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      await verifyExistingPublication(destination, document, eligibility);
    }
    return Object.freeze(document);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export function applyVisualComparisonsToSingleSiteReportInput(reportInput, publication) {
  if (!isRecord(reportInput) || reportInput.schemaVersion !== 1 || reportInput.mode !== 'single-site'
    || !Array.isArray(reportInput.audits) || !isRecord(reportInput.health)
    || !isRecord(publication) || publication.kind !== 'single-site-visual-comparison-publication'
    || !Array.isArray(publication.items)) fail('Visual comparison report enrichment input is invalid.');
  const byAudit = new Map();
  for (const item of publication.items) {
    const status = item?.comparison?.status;
    if (!STATUS_PRIORITY.has(status) || typeof item.auditId !== 'string') fail('Visual comparison publication item is invalid.');
    const current = byAudit.get(item.auditId) ?? 'absent';
    if (STATUS_PRIORITY.get(status) > STATUS_PRIORITY.get(current)) byAudit.set(item.auditId, status);
  }
  const audits = reportInput.audits.map((audit) => ({ ...audit, visualStatus: byAudit.get(audit.id) ?? audit.visualStatus }));
  return Object.freeze({
    ...reportInput,
    health: { ...reportInput.health, visualReview: { items: audits.map(({ visualStatus }) => ({ status: visualStatus })) } },
    audits,
  });
}
