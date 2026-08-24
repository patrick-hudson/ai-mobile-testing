import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AUDIT_EVIDENCE_POLICY_ANNOTATION,
  parseEvidencePolicyAnnotation,
} from '../../audit/evidence-policy.js';

export interface VideoRetentionFile {
  path: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  disposition: 'retained' | 'pruned';
  reason: string;
}

export interface VideoRetentionPlan {
  eligibleHashes: Set<string>;
  eligiblePaths: Set<string>;
  diagnosticHashes: Set<string>;
  diagnosticPaths: Set<string>;
  rejectedHashes: Set<string>;
  rejectedPaths: Set<string>;
  eligibleExecutions: number;
  rejectedExecutions: number;
  skippedExecutions: number;
  policyRejectedExecutions: number;
  qualityRejectedClips: number;
  diagnosticRetainedClips: number;
  qualityAssessments: VideoQualityAssessment[];
  errors: string[];
}

export interface VideoQualityMetrics {
  durationSeconds: number | null;
  sampledFrames: number;
  maxFrameDifference: number | null;
}

export interface VideoQualityAssessment extends VideoQualityMetrics {
  path: string;
  usable: boolean;
  reasons: string[];
  probeError?: string;
}

export interface VideoProbeCommandEvent {
  event: 'Command started' | 'Command finished';
  command: string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export const MIN_ACTION_VIDEO_SECONDS = 2;
export const MIN_ACTION_FRAME_DIFFERENCE = 0.75;

export function assessVideoMetrics(metrics: VideoQualityMetrics): Pick<VideoQualityAssessment, 'usable' | 'reasons'> {
  const reasons: string[] = [];
  if (metrics.durationSeconds == null || !Number.isFinite(metrics.durationSeconds)) {
    reasons.push('duration could not be measured');
  } else if (metrics.durationSeconds < MIN_ACTION_VIDEO_SECONDS) {
    reasons.push(`duration ${metrics.durationSeconds.toFixed(3)}s is below ${MIN_ACTION_VIDEO_SECONDS.toFixed(1)}s`);
  }
  if (metrics.sampledFrames < 2) reasons.push('fewer than two representative frames were decoded');
  if (metrics.maxFrameDifference == null || !Number.isFinite(metrics.maxFrameDifference)) {
    reasons.push('frame-to-frame visual change could not be measured');
  } else if (metrics.maxFrameDifference < MIN_ACTION_FRAME_DIFFERENCE) {
    reasons.push(
      `maximum frame change ${metrics.maxFrameDifference.toFixed(3)} is below ${MIN_ACTION_FRAME_DIFFERENCE.toFixed(2)}`,
    );
  }
  return { usable: reasons.length === 0, reasons };
}

function isShortDynamicFailure(status: string | undefined, assessment: VideoQualityAssessment): boolean {
  return ['failed', 'timedOut'].includes(status ?? '')
    && assessment.durationSeconds !== null
    && Number.isFinite(assessment.durationSeconds)
    && assessment.durationSeconds > 0
    && assessment.durationSeconds < MIN_ACTION_VIDEO_SECONDS
    && assessment.sampledFrames >= 2
    && assessment.maxFrameDifference !== null
    && Number.isFinite(assessment.maxFrameDifference)
    && assessment.maxFrameDifference >= MIN_ACTION_FRAME_DIFFERENCE
    && !assessment.probeError
    && assessment.reasons.length === 1
    && assessment.reasons[0]?.startsWith('duration ') === true;
}

export function probeVideoQuality(
  file: string,
  ffmpeg: string,
  onCommand?: (event: VideoProbeCommandEvent) => void,
): VideoQualityAssessment {
  const ffprobe = path.basename(ffmpeg).startsWith('ffmpeg')
    ? path.join(path.dirname(ffmpeg), path.basename(ffmpeg).replace(/^ffmpeg/, 'ffprobe'))
    : 'ffprobe';
  const durationArgs = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ];
  onCommand?.({ event: 'Command started', command: [ffprobe, ...durationArgs] });
  const durationProbe = spawnSync(ffprobe, durationArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 });
  onCommand?.({
    event: 'Command finished',
    command: [ffprobe, ...durationArgs],
    exitCode: durationProbe.status,
    signal: durationProbe.signal,
  });
  if (durationProbe.status !== 0) {
    const probeError = durationProbe.stderr.trim() || `ffprobe exited ${durationProbe.status ?? 'without a status'}`;
    return {
      path: file,
      durationSeconds: null,
      sampledFrames: 0,
      maxFrameDifference: null,
      usable: false,
      reasons: ['video metadata probe failed'],
      probeError,
    };
  }
  const durationSeconds = Number(durationProbe.stdout.trim());
  const frameArgs = [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    '-i', file,
    '-vf', 'fps=2,scale=160:-2,signalstats,metadata=print:file=-',
    '-frames:v', '120',
    '-f', 'null', '-',
  ];
  onCommand?.({ event: 'Command started', command: [ffmpeg, ...frameArgs] });
  const frameProbe = spawnSync(ffmpeg, frameArgs, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  onCommand?.({
    event: 'Command finished',
    command: [ffmpeg, ...frameArgs],
    exitCode: frameProbe.status,
    signal: frameProbe.signal,
  });
  const output = `${frameProbe.stdout}\n${frameProbe.stderr}`;
  const frameDifferences = [...output.matchAll(/lavfi\.signalstats\.YDIF=([0-9.eE+-]+)/g)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const metrics: VideoQualityMetrics = {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    sampledFrames: frameDifferences.length,
    maxFrameDifference: frameDifferences.length > 0 ? Math.max(...frameDifferences) : null,
  };
  const assessment = assessVideoMetrics(metrics);
  if (frameProbe.status !== 0) {
    assessment.usable = false;
    assessment.reasons.push('representative frame decoding failed');
  }
  return {
    path: file,
    ...metrics,
    ...assessment,
    ...(frameProbe.status !== 0
      ? { probeError: frameProbe.stderr.trim() || `ffmpeg exited ${frameProbe.status ?? 'without a status'}` }
      : {}),
  };
}

interface JsonAttachment {
  name?: string;
  contentType?: string;
  path?: string;
}

interface JsonResult {
  status?: string;
  attachments?: JsonAttachment[];
}

interface JsonTest {
  annotations?: Array<{ type: string; description?: string }>;
  results?: JsonResult[];
}

interface JsonSpec {
  title?: string;
  tests?: JsonTest[];
}

interface JsonSuite {
  suites?: JsonSuite[];
  specs?: JsonSpec[];
}

interface PlaywrightJsonReport {
  suites?: JsonSuite[];
}

function isVideo(attachment: JsonAttachment): boolean {
  return attachment.contentType?.startsWith('video/') === true
    || attachment.name?.toLowerCase() === 'video'
    || attachment.path?.toLowerCase().endsWith('.webm') === true;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function protectedManualPath(artifactRoot: string, candidate: string): boolean {
  if (isInside(path.join(artifactRoot, 'manual-evidence'), candidate)) return true;
  const checklistRoot = path.join(artifactRoot, 'checklist', 'evidence');
  if (!isInside(checklistRoot, candidate)) return false;
  return path.relative(checklistRoot, candidate)
    .split(path.sep)
    .some((segment) => segment.toLowerCase().startsWith('manual-'));
}

function resolveAttachmentPath(
  value: string,
  artifactRoot: string,
  resultsDirectory: string,
): string | null {
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(resultsDirectory, value);
  if (!isInside(artifactRoot, candidate) || protectedManualPath(artifactRoot, candidate)) return null;
  return candidate;
}

export async function sha256File(file: string): Promise<string> {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolveHash(hash.digest('hex')));
  });
}

export async function buildVideoRetentionPlan(
  report: PlaywrightJsonReport,
  artifactRootValue: string,
  resultsFileValue: string,
  options: {
    requireExecutedInteractionVideo?: boolean;
    probeVideo?: (file: string) => VideoQualityAssessment | Promise<VideoQualityAssessment>;
  } = {},
): Promise<VideoRetentionPlan> {
  const artifactRoot = path.resolve(artifactRootValue);
  const resultsDirectory = path.dirname(path.resolve(resultsFileValue));
  const plan: VideoRetentionPlan = {
    eligibleHashes: new Set(),
    eligiblePaths: new Set(),
    diagnosticHashes: new Set(),
    diagnosticPaths: new Set(),
    rejectedHashes: new Set(),
    rejectedPaths: new Set(),
    eligibleExecutions: 0,
    rejectedExecutions: 0,
    skippedExecutions: 0,
    policyRejectedExecutions: 0,
    qualityRejectedClips: 0,
    diagnosticRetainedClips: 0,
    qualityAssessments: [],
    errors: [],
  };

  const tests: Array<{ spec: JsonSpec; test: JsonTest }> = [];
  const visit = (suite: JsonSuite): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) tests.push({ spec, test });
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);

  for (const { spec, test } of tests) {
    const policy = parseEvidencePolicyAnnotation(test.annotations);
    for (const [attemptIndex, result] of (test.results ?? []).entries()) {
      const videoAttachments = (result.attachments ?? []).filter(isVideo);
      const skipped = result.status === 'skipped';
      const eligible = !skipped && policy?.mode === 'interaction-video';
      const label = `${spec.title ?? 'untitled test'} attempt ${attemptIndex + 1} (${result.status ?? 'unknown'})`;
      let usableVideoCount = 0;

      if (eligible) {
        plan.eligibleExecutions += 1;
      } else if (videoAttachments.length > 0) {
        plan.rejectedExecutions += 1;
        if (skipped) plan.skippedExecutions += 1;
        else plan.policyRejectedExecutions += 1;
      }

      for (const attachment of videoAttachments) {
        if (!attachment.path) {
          if (eligible) plan.errors.push(`${label}: its video attachment has no filesystem path.`);
          continue;
        }
        const source = resolveAttachmentPath(attachment.path, artifactRoot, resultsDirectory);
        if (!source) {
          if (eligible) plan.errors.push(`${label}: its video attachment is outside the generated artifact roots.`);
          continue;
        }
        if (!eligible) plan.rejectedPaths.add(source);
        let hash: string;
        try {
          hash = await sha256File(source);
        } catch (error) {
          if (eligible) {
            plan.rejectedPaths.add(source);
            plan.errors.push(`${label}: its video attachment is unavailable (${error instanceof Error ? error.message : String(error)}).`);
          }
          continue;
        }
        if (eligible) {
          const quality = options.probeVideo
            ? await options.probeVideo(source)
            : {
                path: source,
                durationSeconds: null,
                sampledFrames: 0,
                maxFrameDifference: null,
                usable: true,
                reasons: ['quality probe was not requested'],
              };
          plan.qualityAssessments.push(quality);
          if (quality.usable) {
            usableVideoCount += 1;
            plan.eligiblePaths.add(source);
            plan.eligibleHashes.add(hash);
          } else if (isShortDynamicFailure(result.status, quality)) {
            // An immediate failed response can finish before the action-video
            // duration floor. Preserve that visibly changing, decodable clip as
            // diagnostic evidence, but do not count it as usable release media;
            // the attempt-level integrity error below keeps the pipeline non-green.
            plan.diagnosticRetainedClips += 1;
            plan.diagnosticPaths.add(source);
            plan.diagnosticHashes.add(hash);
          } else {
            plan.qualityRejectedClips += 1;
            plan.rejectedPaths.add(source);
            plan.rejectedHashes.add(hash);
            if (quality.probeError) {
              plan.errors.push(`${label}: video quality probe failed for ${path.basename(source)} (${quality.probeError}).`);
            }
          }
        } else {
          plan.rejectedPaths.add(source);
          plan.rejectedHashes.add(hash);
        }
      }
      if (eligible && usableVideoCount === 0 && (options.requireExecutedInteractionVideo ?? true)) {
        const diagnosticCount = videoAttachments.filter((attachment) => {
          if (!attachment.path) return false;
          const source = resolveAttachmentPath(attachment.path, artifactRoot, resultsDirectory);
          return source !== null && plan.diagnosticPaths.has(source);
        }).length;
        const suffix = videoAttachments.length === 0
          ? 'no video attachment was produced'
          : 'every attached video was blank, too short, non-action, corrupt, or unavailable';
        const diagnosticSuffix = diagnosticCount > 0
          ? ` ${diagnosticCount} short dynamic failure clip${diagnosticCount === 1 ? ' was' : 's were'} retained only as diagnostic evidence.`
          : '';
        plan.errors.push(`${label}: ${suffix}; no usable interaction video remains.${diagnosticSuffix}`);
      }
    }
  }

  return plan;
}

export async function removeRejectedVideoAttachments(
  report: PlaywrightJsonReport,
  plan: VideoRetentionPlan,
  artifactRootValue: string,
  resultsFileValue: string,
): Promise<number> {
  const artifactRoot = path.resolve(artifactRootValue);
  const resultsDirectory = path.dirname(path.resolve(resultsFileValue));
  let removed = 0;
  const visit = (suite: JsonSuite): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const policy = parseEvidencePolicyAnnotation(test.annotations);
        for (const result of test.results ?? []) {
          result.attachments = (result.attachments ?? []).filter((attachment) => {
            if (!isVideo(attachment)) return true;
            const eligibleAttempt = result.status !== 'skipped' && policy?.mode === 'interaction-video';
            if (!attachment.path) {
              removed += 1;
              return false;
            }
            const source = resolveAttachmentPath(attachment.path, artifactRoot, resultsDirectory);
            if (eligibleAttempt && source && !plan.rejectedPaths.has(source)) return true;
            removed += 1;
            return false;
          });
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return removed;
}

async function filesUnder(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else output.push(candidate);
    }
  }
  try {
    await visit(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return output;
}

function generatedVideoRoots(artifactRoot: string): Array<{
  root: string;
  pruneUnknown: boolean;
  sharedContentAddressed: boolean;
}> {
  return [
    { root: path.join(artifactRoot, 'raw'), pruneUnknown: true, sharedContentAddressed: false },
    { root: path.join(artifactRoot, 'shards'), pruneUnknown: true, sharedContentAddressed: false },
    { root: path.join(artifactRoot, 'blob-reports', 'resources'), pruneUnknown: true, sharedContentAddressed: true },
    { root: path.join(artifactRoot, 'playwright-html', 'data'), pruneUnknown: true, sharedContentAddressed: true },
    // Checklist evidence can contain reviewer-supplied videos. Explicitly rejected
    // paths and unambiguously rejected Playwright hashes are pruned there; unknown
    // media is deliberately preserved.
    { root: path.join(artifactRoot, 'checklist', 'evidence'), pruneUnknown: false, sharedContentAddressed: false },
  ];
}

async function removeGeneratedVideo(video: string): Promise<{
  bytes: number;
  poster: { path: string; bytes: number; sha256: string } | null;
}> {
  const details = await fs.stat(video).catch(() => null);
  if (!details?.isFile()) return { bytes: 0, poster: null };
  const extension = path.extname(video);
  const poster = path.join(path.dirname(video), `${path.basename(video, extension)}-poster.jpg`);
  const posterDetails = await fs.stat(poster).catch(() => null);
  const posterRecord = posterDetails?.isFile()
    ? { path: poster, bytes: posterDetails.size, sha256: await sha256File(poster) }
    : null;
  await fs.unlink(video);
  await fs.unlink(poster).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  return { bytes: details.size + (posterRecord?.bytes ?? 0), poster: posterRecord };
}

export async function applyVideoRetentionPlan(
  plan: VideoRetentionPlan,
  artifactRootValue: string,
): Promise<{ retained: VideoRetentionFile[]; pruned: VideoRetentionFile[]; prunedBytes: number }> {
  const artifactRoot = path.resolve(artifactRootValue);
  const retained: VideoRetentionFile[] = [];
  const pruned: VideoRetentionFile[] = [];
  const seen = new Set<string>();
  let prunedBytes = 0;

  for (const { root, pruneUnknown, sharedContentAddressed } of generatedVideoRoots(artifactRoot)) {
    for (const candidate of await filesUnder(root)) {
      if (!candidate.toLowerCase().endsWith('.webm')) continue;
      const absolute = path.resolve(candidate);
      if (seen.has(absolute) || protectedManualPath(artifactRoot, absolute)) continue;
      seen.add(absolute);
      const details = await fs.stat(absolute);
      const hash = await sha256File(absolute);
      const relativePath = path.relative(artifactRoot, absolute);
      const eligibleHash = plan.eligibleHashes.has(hash);
      const diagnosticHash = plan.diagnosticHashes.has(hash);
      const rejectedPath = plan.rejectedPaths.has(absolute);
      const rejectedHash = plan.rejectedHashes.has(hash);
      // Raw recordings and checklist evidence describe a specific execution, so
      // an explicit path rejection must win even when another valid interaction
      // produced byte-identical video. Content-addressed report resources are
      // shared by hash and must survive while any eligible interaction needs the
      // same bytes, including when a rejected execution referenced that blob too.
      const keepEligible = eligibleHash && (!rejectedPath || sharedContentAddressed);
      const keepDiagnostic = diagnosticHash && (!rejectedPath || sharedContentAddressed);
      const keepProtectedUnknown = !pruneUnknown && !rejectedPath && !rejectedHash;
      if (keepEligible || keepDiagnostic || keepProtectedUnknown) {
        retained.push({
          path: absolute,
          relativePath,
          bytes: details.size,
          sha256: hash,
          disposition: 'retained',
          reason: keepEligible
            ? rejectedPath
              ? 'shared content-addressed evidence required by an eligible interaction'
              : 'non-skipped interaction execution'
            : keepDiagnostic
              ? 'short dynamic failed interaction retained as diagnostic evidence; release integrity remains non-green'
            : 'protected unknown or manual checklist evidence',
        });
        continue;
      }
      const explicitlyRejected = rejectedPath || rejectedHash;
      const removed = await removeGeneratedVideo(absolute);
      prunedBytes += removed.bytes;
      pruned.push({
        path: absolute,
        relativePath,
        bytes: details.size,
        sha256: hash,
        disposition: 'pruned',
        reason: explicitlyRejected ? 'skipped or non-interaction execution' : 'orphan generated video with no eligible execution',
      });
      if (removed.poster) {
        pruned.push({
          path: removed.poster.path,
          relativePath: path.relative(artifactRoot, removed.poster.path),
          bytes: removed.poster.bytes,
          sha256: removed.poster.sha256,
          disposition: 'pruned',
          reason: 'generated poster for a pruned video',
        });
      }
    }
  }

  // Posters are derivatives, not independent evidence. Remove a generated
  // poster when its source clip was pruned or is otherwise absent.
  for (const { root } of generatedVideoRoots(artifactRoot)) {
    for (const candidate of await filesUnder(root)) {
      if (!candidate.toLowerCase().endsWith('-poster.jpg')) continue;
      const absolute = path.resolve(candidate);
      if (seen.has(absolute) || protectedManualPath(artifactRoot, absolute)) continue;
      seen.add(absolute);
      const sourceVideo = absolute.slice(0, -'-poster.jpg'.length) + '.webm';
      const sourceExists = await fs.stat(sourceVideo).then((details) => details.isFile()).catch(() => false);
      if (sourceExists) continue;
      const details = await fs.stat(absolute);
      const hash = await sha256File(absolute);
      await fs.unlink(absolute);
      prunedBytes += details.size;
      pruned.push({
        path: absolute,
        relativePath: path.relative(artifactRoot, absolute),
        bytes: details.size,
        sha256: hash,
        disposition: 'pruned',
        reason: 'orphan generated poster whose source video was pruned or absent',
      });
    }
  }
  return { retained, pruned, prunedBytes };
}

export function reportableAttachments<T extends { name: string; contentType: string }>(
  attachments: T[],
  status: string,
  annotations: Array<{ type: string; description?: string }> | undefined,
): T[] {
  const policy = parseEvidencePolicyAnnotation(annotations);
  return attachments.filter((attachment) => {
    if (!isVideo(attachment)) return true;
    return status !== 'skipped' && policy?.mode === 'interaction-video';
  });
}

export function hasExplicitEvidencePolicy(
  annotations: Array<{ type: string; description?: string }> | undefined,
): boolean {
  return annotations?.some(({ type }) => type === AUDIT_EVIDENCE_POLICY_ANNOTATION) ?? false;
}
