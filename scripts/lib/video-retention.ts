import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
  normalizations: VideoNormalizationResult[];
  errors: string[];
}

export interface VideoQualityMetrics {
  durationSeconds: number | null;
  sampledFrames: number;
  maxFrameDifference: number | null;
  changedFrames: number | null;
  postContentChangedFrames: number | null;
  blankFrameRatio: number | null;
  initialNonBlankRatio: number | null;
  finalNonBlankRatio: number | null;
  leadingBlankSeconds: number | null;
}

export interface VideoQualityAssessment extends VideoQualityMetrics {
  path: string;
  usable: boolean;
  reasons: string[];
  probeError?: string;
}

export interface VideoNormalizationResult {
  originalPath: string;
  normalizedPath: string;
  trimStartSeconds: number;
  originalDurationSeconds: number;
  normalizedDurationSeconds: number;
  originalAssessment: VideoQualityAssessment;
  assessment: VideoQualityAssessment;
}

export interface VideoProbeCommandEvent {
  event: 'Command started' | 'Command finished';
  command: string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export const MIN_ACTION_VIDEO_SECONDS = 2;
export const MIN_ACTION_FRAME_DIFFERENCE = 0.75;
export const MAX_BLANK_FRAME_RATIO = 0.5;
export const MIN_WINDOW_NONBLANK_RATIO = 0.5;
const PRIMARY_PROBE_FRAMES = 240;
const TAIL_PROBE_SECONDS = 15;
const TAIL_PROBE_FRAMES = TAIL_PROBE_SECONDS * 4;

interface SampledVideoFrame {
  timestampSeconds: number | null;
  averageLuma: number | null;
  lowLuma: number | null;
  highLuma: number | null;
  difference: number | null;
}

function finiteMetric(block: string, name: string): number | null {
  const match = block.match(new RegExp(`lavfi\\.signalstats\\.${name}=([0-9.eE+-]+)`));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function sampledFrames(output: string): SampledVideoFrame[] {
  return [...output.matchAll(/frame:\d+[\s\S]*?(?=frame:\d+|$)/g)].map(([block]) => ({
    timestampSeconds: (() => {
      const match = block.match(/pts_time:([0-9.eE+-]+)/);
      if (!match) return null;
      const value = Number(match[1]);
      return Number.isFinite(value) ? value : null;
    })(),
    averageLuma: finiteMetric(block, 'YAVG'),
    lowLuma: finiteMetric(block, 'YLOW') ?? finiteMetric(block, 'YMIN'),
    highLuma: finiteMetric(block, 'YHIGH') ?? finiteMetric(block, 'YMAX'),
    difference: finiteMetric(block, 'YDIF'),
  }));
}

function isBlankFrame(frame: SampledVideoFrame): boolean {
  // Assess the center crop, not Playwright's top-left/bottom-right overlays.
  // FFmpeg reports full-range white near 255 on some platforms/codecs and
  // studio-range white near 235 on others. Luma spread is range-independent:
  // a center crop whose 10th and 90th percentiles are nearly identical is a
  // low-information solid frame whether it is white, black, gray, or tinted.
  // Real page content, text, and controls create a materially wider spread.
  return frame.averageLuma !== null
    && frame.lowLuma !== null
    && frame.highLuma !== null
    && frame.highLuma - frame.lowLuma <= 6;
}

function ratio(values: boolean[]): number | null {
  if (values.length === 0) return null;
  return values.filter(Boolean).length / values.length;
}

function metricsFromProbeOutput(durationSeconds: number, output: string): VideoQualityMetrics {
  const frames = sampledFrames(output);
  const differences = frames.map(({ difference }) => difference).filter((value): value is number => value !== null);
  const nonBlank = frames.map((frame) => !isBlankFrame(frame));
  const windowSize = Math.max(1, Math.ceil(frames.length / 4));
  let leadingBlankSeconds: number | null = null;
  let firstSustainedContentIndex: number | null = null;
  const sustainedFrames = 3;
  for (let index = 0; index <= nonBlank.length - sustainedFrames; index += 1) {
    if (!nonBlank.slice(index, index + sustainedFrames).every(Boolean)) continue;
    firstSustainedContentIndex = index;
    leadingBlankSeconds = frames[index]?.timestampSeconds ?? index / 4;
    break;
  }
  const settledContentIndex = firstSustainedContentIndex === null
    ? null
    : firstSustainedContentIndex + sustainedFrames;
  const postContentChangedFrames = settledContentIndex === null
    ? null
    : frames.filter((frame, index) => (
        index >= settledContentIndex
        && nonBlank[index]
        && nonBlank[index - 1]
        && frame.difference !== null
        && frame.difference >= MIN_ACTION_FRAME_DIFFERENCE
      )).length;
  return {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    sampledFrames: frames.length,
    maxFrameDifference: differences.length > 0 ? Math.max(...differences) : null,
    changedFrames: differences.filter((value) => value >= MIN_ACTION_FRAME_DIFFERENCE).length,
    postContentChangedFrames,
    blankFrameRatio: ratio(nonBlank.map((value) => !value)),
    initialNonBlankRatio: ratio(nonBlank.slice(0, windowSize)),
    finalNonBlankRatio: ratio(nonBlank.slice(-windowSize)),
    leadingBlankSeconds,
  };
}

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
  if (metrics.changedFrames == null || !Number.isFinite(metrics.changedFrames)) {
    reasons.push('sustained frame changes could not be measured');
  } else if (metrics.changedFrames < 1) {
    reasons.push('no representative page-content transition was measured');
  }
  if (metrics.postContentChangedFrames == null || !Number.isFinite(metrics.postContentChangedFrames)) {
    reasons.push('visual change after settled page content could not be measured');
  } else if (metrics.postContentChangedFrames < 1) {
    reasons.push('no visual response was measured after the page content settled');
  }
  if (metrics.blankFrameRatio == null || !Number.isFinite(metrics.blankFrameRatio)) {
    reasons.push('blank-frame ratio could not be measured');
  } else if (metrics.blankFrameRatio > MAX_BLANK_FRAME_RATIO) {
    reasons.push(`blank-frame ratio ${metrics.blankFrameRatio.toFixed(3)} exceeds ${MAX_BLANK_FRAME_RATIO.toFixed(2)}`);
  }
  if (metrics.initialNonBlankRatio == null || metrics.initialNonBlankRatio < MIN_WINDOW_NONBLANK_RATIO) {
    reasons.push('the initial-state window does not contain sustained page content');
  }
  if (metrics.finalNonBlankRatio == null || metrics.finalNonBlankRatio < MIN_WINDOW_NONBLANK_RATIO) {
    reasons.push('the final-response window does not contain sustained page content');
  }
  return { usable: reasons.length === 0, reasons };
}

export function recommendedLeadingBlankTrimSeconds(assessment: VideoQualityAssessment): number | null {
  if (assessment.usable || assessment.probeError) return null;
  if (assessment.reasons.length !== 1
    || assessment.reasons[0] !== 'the initial-state window does not contain sustained page content') return null;
  if (assessment.durationSeconds === null
    || assessment.leadingBlankSeconds === null
    || assessment.blankFrameRatio === null
    || assessment.finalNonBlankRatio === null
    || assessment.maxFrameDifference === null
    || assessment.changedFrames === null
    || assessment.postContentChangedFrames === null) return null;
  if (assessment.blankFrameRatio > MAX_BLANK_FRAME_RATIO
    || assessment.finalNonBlankRatio < MIN_WINDOW_NONBLANK_RATIO
    || assessment.maxFrameDifference < MIN_ACTION_FRAME_DIFFERENCE
    || assessment.changedFrames < 1
    || assessment.postContentChangedFrames < 1) return null;
  const trimStartSeconds = Math.max(0, assessment.leadingBlankSeconds - 0.5);
  if (trimStartSeconds < 0.25
    || assessment.durationSeconds - trimStartSeconds < MIN_ACTION_VIDEO_SECONDS) return null;
  return Math.round(trimStartSeconds * 1_000) / 1_000;
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
    && assessment.changedFrames !== null
    && assessment.changedFrames >= 1
    && assessment.blankFrameRatio !== null
    && assessment.blankFrameRatio <= MAX_BLANK_FRAME_RATIO
    && assessment.initialNonBlankRatio !== null
    && assessment.initialNonBlankRatio >= MIN_WINDOW_NONBLANK_RATIO
    && assessment.finalNonBlankRatio !== null
    && assessment.finalNonBlankRatio >= MIN_WINDOW_NONBLANK_RATIO
    && !assessment.probeError
    && assessment.reasons.length === 1
    && assessment.reasons[0]?.startsWith('duration ') === true;
}

function frameProbeArgs(file: string, maximumFrames: number, seekSeconds: number | null = null): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats',
    ...(seekSeconds === null ? [] : ['-ss', seekSeconds.toFixed(3)]),
    '-i', file,
    '-vf', 'crop=iw*0.70:ih*0.70:iw*0.15:ih*0.15,fps=4,scale=160:-2,signalstats,metadata=print:file=-',
    '-frames:v', String(maximumFrames),
    '-f', 'null', '-',
  ];
}

function tailProbeStart(durationSeconds: number): number | null {
  return Number.isFinite(durationSeconds) && durationSeconds > PRIMARY_PROBE_FRAMES / 4
    ? Math.max(0, durationSeconds - TAIL_PROBE_SECONDS)
    : null;
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
      changedFrames: null,
      postContentChangedFrames: null,
      blankFrameRatio: null,
      initialNonBlankRatio: null,
      finalNonBlankRatio: null,
      leadingBlankSeconds: null,
      usable: false,
      reasons: ['video metadata probe failed'],
      probeError,
    };
  }
  const durationSeconds = Number(durationProbe.stdout.trim());
  const frameArgs = frameProbeArgs(file, PRIMARY_PROBE_FRAMES);
  onCommand?.({ event: 'Command started', command: [ffmpeg, ...frameArgs] });
  const frameProbe = spawnSync(ffmpeg, frameArgs, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  onCommand?.({
    event: 'Command finished',
    command: [ffmpeg, ...frameArgs],
    exitCode: frameProbe.status,
    signal: frameProbe.signal,
  });
  const tailStart = tailProbeStart(durationSeconds);
  const tailArgs = tailStart === null ? null : frameProbeArgs(file, TAIL_PROBE_FRAMES, tailStart);
  let tailProbe: {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  } | null = null;
  if (tailArgs) {
    onCommand?.({ event: 'Command started', command: [ffmpeg, ...tailArgs] });
    tailProbe = spawnSync(ffmpeg, tailArgs, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    onCommand?.({
      event: 'Command finished',
      command: [ffmpeg, ...tailArgs],
      exitCode: tailProbe.status,
      signal: tailProbe.signal,
    });
  }
  const output = `${frameProbe.stdout}\n${frameProbe.stderr}\n${tailProbe?.stdout ?? ''}\n${tailProbe?.stderr ?? ''}`;
  const metrics = metricsFromProbeOutput(durationSeconds, output);
  const assessment = assessVideoMetrics(metrics);
  if (frameProbe.status !== 0 || (tailProbe && tailProbe.status !== 0)) {
    assessment.usable = false;
    assessment.reasons.push('representative frame decoding failed');
  }
  return {
    path: file,
    ...metrics,
    ...assessment,
    ...(frameProbe.status !== 0 || (tailProbe && tailProbe.status !== 0)
      ? { probeError: tailProbe?.stderr.trim() || frameProbe.stderr.trim() || `ffmpeg exited ${tailProbe?.status ?? frameProbe.status ?? 'without a status'}` }
      : {}),
  };
}

interface BufferedCommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function spawnBuffered(command: string, args: string[], timeoutMs = 60_000): Promise<BufferedCommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBytes = 8 * 1024 * 1024;
    let timedOut = false;
    let escalation: NodeJS.Timeout | null = null;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      resolveCommand({ status: null, signal: null, stdout: '', stderr: error.message, timedOut });
    });
    child.once('close', (status, signal) => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      resolveCommand({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    });
  });
}

export async function probeVideoQualityAsync(
  file: string,
  ffmpeg: string,
  onCommand?: (event: VideoProbeCommandEvent) => void,
): Promise<VideoQualityAssessment> {
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
  const durationProbe = await spawnBuffered(ffprobe, durationArgs);
  onCommand?.({
    event: 'Command finished',
    command: [ffprobe, ...durationArgs],
    exitCode: durationProbe.status,
    signal: durationProbe.signal,
  });
  if (durationProbe.status !== 0 || durationProbe.timedOut) {
    return {
      path: file,
      durationSeconds: null,
      sampledFrames: 0,
      maxFrameDifference: null,
      changedFrames: null,
      postContentChangedFrames: null,
      blankFrameRatio: null,
      initialNonBlankRatio: null,
      finalNonBlankRatio: null,
      leadingBlankSeconds: null,
      usable: false,
      reasons: ['video metadata probe failed'],
      probeError: durationProbe.timedOut
        ? 'ffprobe exceeded its 60 second deadline'
        : durationProbe.stderr.trim() || `ffprobe exited ${durationProbe.status ?? 'without a status'}`,
    };
  }
  const durationSeconds = Number(durationProbe.stdout.trim());
  const frameArgs = frameProbeArgs(file, PRIMARY_PROBE_FRAMES);
  onCommand?.({ event: 'Command started', command: [ffmpeg, ...frameArgs] });
  const frameProbe = await spawnBuffered(ffmpeg, frameArgs);
  onCommand?.({
    event: 'Command finished',
    command: [ffmpeg, ...frameArgs],
    exitCode: frameProbe.status,
    signal: frameProbe.signal,
  });
  const tailStart = tailProbeStart(durationSeconds);
  const tailArgs = tailStart === null ? null : frameProbeArgs(file, TAIL_PROBE_FRAMES, tailStart);
  let tailProbe: BufferedCommandResult | null = null;
  if (tailArgs) {
    onCommand?.({ event: 'Command started', command: [ffmpeg, ...tailArgs] });
    tailProbe = await spawnBuffered(ffmpeg, tailArgs);
    onCommand?.({
      event: 'Command finished',
      command: [ffmpeg, ...tailArgs],
      exitCode: tailProbe.status,
      signal: tailProbe.signal,
    });
  }
  const metrics = metricsFromProbeOutput(
    durationSeconds,
    `${frameProbe.stdout}\n${frameProbe.stderr}\n${tailProbe?.stdout ?? ''}\n${tailProbe?.stderr ?? ''}`,
  );
  const assessment = assessVideoMetrics(metrics);
  const decodingFailed = frameProbe.status !== 0 || frameProbe.timedOut
    || Boolean(tailProbe && (tailProbe.status !== 0 || tailProbe.timedOut));
  if (decodingFailed) {
    assessment.usable = false;
    assessment.reasons.push('representative frame decoding failed');
  }
  return {
    path: file,
    ...metrics,
    ...assessment,
    ...(decodingFailed
      ? {
          probeError: frameProbe.timedOut || tailProbe?.timedOut
            ? 'ffmpeg exceeded its 60 second deadline'
            : tailProbe?.stderr.trim() || frameProbe.stderr.trim()
              || `ffmpeg exited ${tailProbe?.status ?? frameProbe.status ?? 'without a status'}`,
        }
      : {}),
  };
}

export async function normalizeLeadingBlankVideoAsync(
  file: string,
  assessment: VideoQualityAssessment,
  artifactRootValue: string,
  ffmpeg: string,
  onCommand?: (event: VideoProbeCommandEvent) => void,
): Promise<VideoNormalizationResult | null> {
  const trimStartSeconds = recommendedLeadingBlankTrimSeconds(assessment);
  if (trimStartSeconds === null || assessment.durationSeconds === null) return null;
  const artifactRoot = path.resolve(artifactRootValue);
  const source = path.resolve(file);
  if (!isInside(artifactRoot, source)) throw new Error('Leading-blank normalization source is outside the artifact root.');
  const sourceDetails = await fs.lstat(source);
  if (!sourceDetails.isFile() || sourceDetails.isSymbolicLink()) {
    throw new Error('Leading-blank normalization requires a regular, non-symbolic-link source video.');
  }
  const normalizedRoot = path.join(artifactRoot, 'normalized-videos');
  await fs.mkdir(normalizedRoot, { recursive: true });
  const normalizedRootDetails = await fs.lstat(normalizedRoot);
  if (!normalizedRootDetails.isDirectory() || normalizedRootDetails.isSymbolicLink()) {
    throw new Error('Leading-blank normalization output must be a regular directory.');
  }
  const [realArtifactRoot, realNormalizedRoot] = await Promise.all([
    fs.realpath(artifactRoot),
    fs.realpath(normalizedRoot),
  ]);
  if (!isInside(realArtifactRoot, realNormalizedRoot)) {
    throw new Error('Leading-blank normalization output resolves outside the artifact root.');
  }
  const temporary = path.join(normalizedRoot, `.normalizing-${randomUUID()}.webm`);
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-ss', trimStartSeconds.toFixed(3), '-i', source,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '5',
    '-crf', '10', '-b:v', '1M', '-pix_fmt', 'yuv420p',
    '-f', 'webm', temporary,
  ];
  onCommand?.({ event: 'Command started', command: [ffmpeg, ...args] });
  try {
    const encoded = await spawnBuffered(ffmpeg, args, 120_000);
    onCommand?.({
      event: 'Command finished',
      command: [ffmpeg, ...args],
      exitCode: encoded.status,
      signal: encoded.signal,
    });
    if (encoded.status !== 0 || encoded.timedOut) return null;
    const normalizedAssessment = await probeVideoQualityAsync(temporary, ffmpeg, onCommand);
    if (!normalizedAssessment.usable
      || normalizedAssessment.durationSeconds === null
      || normalizedAssessment.postContentChangedFrames === null
      || normalizedAssessment.postContentChangedFrames < 1) return null;
    const hash = await sha256File(temporary);
    const normalizedPath = path.join(normalizedRoot, `${hash}.webm`);
    // Replace atomically even if another worker produced the same named
    // derivative. Reusing an unverified pre-existing path would let stale or
    // hostile run content masquerade as the bytes assessed above.
    await fs.rename(temporary, normalizedPath);
    return {
      originalPath: source,
      normalizedPath,
      trimStartSeconds,
      originalDurationSeconds: assessment.durationSeconds,
      normalizedDurationSeconds: normalizedAssessment.durationSeconds,
      originalAssessment: { ...assessment, path: source },
      assessment: { ...normalizedAssessment, path: normalizedPath },
    };
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
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
    probeVideo?: (file: string) => VideoQualityAssessment | Promise<VideoQualityAssessment>;
    normalizeVideo?: (
      file: string,
      assessment: VideoQualityAssessment,
    ) => VideoNormalizationResult | null | Promise<VideoNormalizationResult | null>;
    probeConcurrency?: number;
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
    normalizations: [],
    errors: [],
  };

  const boundedForEach = async <T>(values: readonly T[], requestedConcurrency: number, task: (value: T) => Promise<void>): Promise<void> => {
    const concurrency = Math.max(1, Math.min(values.length || 1, Math.floor(requestedConcurrency)));
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < values.length) {
        const value = values[next];
        next += 1;
        if (value !== undefined) await task(value);
      }
    }));
  };

  const tests: Array<{ spec: JsonSpec; test: JsonTest }> = [];
  const visit = (suite: JsonSuite): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) tests.push({ spec, test });
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);

  // Decode each unique eligible clip once. The main reconciliation pass stays
  // deterministic, while FFmpeg work runs through a small CPU-aware pool.
  const qualityBySource = new Map<string, VideoQualityAssessment>();
  const normalizedBySource = new Map<string, string>();
  if (options.probeVideo) {
    const sources = new Set<string>();
    for (const { test } of tests) {
      const policy = parseEvidencePolicyAnnotation(test.annotations);
      for (const result of test.results ?? []) {
        if (result.status === 'skipped' || policy?.mode !== 'interaction-video') continue;
        for (const attachment of (result.attachments ?? []).filter(isVideo)) {
          if (!attachment.path) continue;
          const source = resolveAttachmentPath(attachment.path, artifactRoot, resultsDirectory);
          if (source) sources.add(source);
        }
      }
    }
    await boundedForEach([...sources].sort(), options.probeConcurrency ?? 2, async (source) => {
      try {
        qualityBySource.set(source, await options.probeVideo!(source));
      } catch (error) {
        qualityBySource.set(source, {
          path: source,
          durationSeconds: null,
          sampledFrames: 0,
          maxFrameDifference: null,
          changedFrames: null,
          postContentChangedFrames: null,
          blankFrameRatio: null,
          initialNonBlankRatio: null,
          finalNonBlankRatio: null,
          leadingBlankSeconds: null,
          usable: false,
          reasons: ['video quality probe failed'],
          probeError: error instanceof Error ? error.message : String(error),
        });
      }
    });
    if (options.normalizeVideo) {
      await boundedForEach([...sources].sort(), options.probeConcurrency ?? 2, async (source) => {
        const assessment = qualityBySource.get(source);
        if (!assessment || assessment.usable) return;
        try {
          const normalization = await options.normalizeVideo!(source, assessment);
          if (!normalization?.assessment.usable) return;
          const normalizedPath = path.resolve(normalization.normalizedPath);
          if (!isInside(artifactRoot, normalizedPath)) {
            throw new Error('normalized video is outside the generated artifact roots');
          }
          normalizedBySource.set(source, normalizedPath);
          qualityBySource.set(normalizedPath, { ...normalization.assessment, path: normalizedPath });
          plan.normalizations.push({
            ...normalization,
            originalPath: source,
            normalizedPath,
            assessment: { ...normalization.assessment, path: normalizedPath },
          });
        } catch (error) {
          qualityBySource.set(source, {
            ...assessment,
            reasons: [...assessment.reasons, 'leading-blank normalization failed'],
            probeError: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
  }
  const hashBySource = new Map<string, Promise<string>>();

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
        const originalSource = resolveAttachmentPath(attachment.path, artifactRoot, resultsDirectory);
        const source = originalSource ? normalizedBySource.get(originalSource) ?? originalSource : null;
        if (source && source !== originalSource) attachment.path = path.relative(resultsDirectory, source);
        if (!source) {
          if (eligible) plan.errors.push(`${label}: its video attachment is outside the generated artifact roots.`);
          continue;
        }
        if (!eligible) plan.rejectedPaths.add(source);
        let hash: string;
        try {
          let pendingHash = hashBySource.get(source);
          if (!pendingHash) {
            pendingHash = sha256File(source);
            hashBySource.set(source, pendingHash);
          }
          hash = await pendingHash;
        } catch (error) {
          if (eligible) {
            plan.rejectedPaths.add(source);
            plan.errors.push(`${label}: its video attachment is unavailable (${error instanceof Error ? error.message : String(error)}).`);
          }
          continue;
        }
        if (eligible) {
          const quality = options.probeVideo
            ? qualityBySource.get(source) ?? {
                path: source,
                durationSeconds: null,
                sampledFrames: 0,
                maxFrameDifference: null,
                changedFrames: null,
                postContentChangedFrames: null,
                blankFrameRatio: null,
                initialNonBlankRatio: null,
                finalNonBlankRatio: null,
                leadingBlankSeconds: null,
                usable: false,
                reasons: ['video quality probe was not completed'],
                probeError: 'eligible clip was absent from the bounded probe inventory',
              }
            : {
                path: source,
                durationSeconds: null,
                sampledFrames: 0,
                maxFrameDifference: null,
                changedFrames: null,
                postContentChangedFrames: null,
                blankFrameRatio: null,
                initialNonBlankRatio: null,
                finalNonBlankRatio: null,
                leadingBlankSeconds: null,
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
      if (eligible && usableVideoCount === 0) {
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
    { root: path.join(artifactRoot, 'normalized-videos'), pruneUnknown: true, sharedContentAddressed: false },
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
