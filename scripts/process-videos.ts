import { constants, promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  applyVideoRetentionPlan,
  buildVideoRetentionPlan,
  normalizeLeadingBlankVideoAsync,
  probeVideoQualityAsync,
  recommendedLeadingBlankTrimSeconds,
  removeRejectedVideoAttachments,
  sha256File,
} from './lib/video-retention.js';

interface VideoEvidence {
  video: string;
  bytes: number;
  sha256: string;
  evidenceRole: 'usable-interaction' | 'diagnostic' | 'unclassified';
  poster: string | null;
  posterBytes: number | null;
  processor: string | null;
  processingStatus: 'created' | 'already-existed' | 'ffmpeg-unavailable' | 'failed';
  error?: string;
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const artifactRoot = resolve(
  argumentValue('--run-dir')
  ?? process.argv.slice(2).find((value) => !value.startsWith('--'))
  ?? process.env.AUDIT_ARTIFACT_DIR
  ?? './artifacts',
);
const manifestPath = join(artifactRoot, 'video-manifest.json');
const requestedMediaWorkers = Number(process.env.AUDIT_MEDIA_WORKERS ?? '2');
const mediaWorkers = Number.isInteger(requestedMediaWorkers)
  ? Math.max(1, Math.min(requestedMediaWorkers, 8))
  : 2;

function log(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${new Date().toISOString()} [MEDIA] ${event} ${JSON.stringify(detail)}\n`);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  requestedConcurrency: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  const concurrency = Math.max(1, Math.min(values.length || 1, requestedConcurrency));
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) output[index] = await task(value, index);
    }
  }));
  return output;
}

async function runBuffered(
  command: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stderr: string; timedOut: boolean }> {
  return await new Promise((resolveCommand) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let timedOut = false;
    let escalation: NodeJS.Timeout | null = null;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 2 * 1024 * 1024) stderr.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      resolveCommand({ status: null, signal: null, stderr: error.message, timedOut });
    });
    child.once('close', (status, signal) => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      resolveCommand({ status, signal, stderr: Buffer.concat(stderr).toString('utf8'), timedOut });
    });
  });
}

async function filesUnder(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else output.push(path);
    }
  }
  try {
    await visit(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return output;
}

async function executable(path: string): Promise<boolean> {
  try {
    await fs.access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function locateFfmpeg(): Promise<string | null> {
  if (process.env.FFMPEG_PATH && await executable(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const fromPath = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (fromPath.status === 0) return 'ffmpeg';
  try {
    const roots = await fs.readdir('/ms-playwright', { withFileTypes: true });
    for (const entry of roots) {
      if (!entry.isDirectory() || !entry.name.startsWith('ffmpeg-')) continue;
      const candidate = join('/ms-playwright', entry.name, 'ffmpeg-linux');
      if (await executable(candidate)) return candidate;
    }
  } catch {
    // The host runner does not have Playwright's Linux image layout.
  }
  return null;
}

await fs.mkdir(artifactRoot, { recursive: true });
const resultsPath = join(artifactRoot, 'results.json');
const auditProfile = process.env.AUDIT_PROFILE ?? 'release';
// Evidence semantics do not weaken in smoke mode: if an interaction executes,
// it must leave a reviewable action-and-response clip in every profile.
const requireExecutedInteractionVideo = true;
const ffmpeg = await locateFfmpeg();
let retentionPlan;
let results: Parameters<typeof buildVideoRetentionPlan>[0];
let removedVideoAttachments = 0;
try {
  results = JSON.parse(await fs.readFile(resultsPath, 'utf8')) as Parameters<typeof buildVideoRetentionPlan>[0];
  retentionPlan = await buildVideoRetentionPlan(results, artifactRoot, resultsPath, {
    ...(ffmpeg ? {
      probeVideo: (file) => probeVideoQualityAsync(file, ffmpeg, ({ event, ...detail }) => log(event, detail)),
      normalizeVideo: async (file, assessment) => {
        const trimStartSeconds = recommendedLeadingBlankTrimSeconds(assessment);
        if (trimStartSeconds === null) return null;
        log('Leading-blank normalization started', {
          video: relative(artifactRoot, file),
          durationSeconds: assessment.durationSeconds,
          leadingBlankSeconds: assessment.leadingBlankSeconds,
          trimStartSeconds,
          reasons: assessment.reasons,
        });
        const normalized = await normalizeLeadingBlankVideoAsync(
          file,
          assessment,
          artifactRoot,
          ffmpeg,
          ({ event, ...detail }) => log(event, detail),
        );
        log(normalized ? 'Leading-blank normalization finished' : 'Leading-blank normalization rejected', {
          video: relative(artifactRoot, file),
          trimStartSeconds,
          ...(normalized ? {
            normalizedVideo: relative(artifactRoot, normalized.normalizedPath),
            normalizedDurationSeconds: normalized.normalizedDurationSeconds,
          } : {
            reason: 'The trimmed clip did not pass the complete action-video quality gate.',
          }),
        });
        return normalized;
      },
      probeConcurrency: mediaWorkers,
    } : {}),
  });
  removedVideoAttachments = await removeRejectedVideoAttachments(results, retentionPlan, artifactRoot, resultsPath);
  const temporaryResultsPath = `${resultsPath}.video-retention.tmp`;
  await fs.writeFile(temporaryResultsPath, `${JSON.stringify(results, null, 2)}\n`);
  await fs.rename(temporaryResultsPath, resultsPath);
} catch (error) {
  log('Video retention policy failed', {
    resultsPath,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  throw error;
}
const retention = await applyVideoRetentionPlan(retentionPlan, artifactRoot);
log('Video retention policy applied', {
  eligibleExecutions: retentionPlan.eligibleExecutions,
  rejectedExecutions: retentionPlan.rejectedExecutions,
  skippedExecutions: retentionPlan.skippedExecutions,
  policyRejectedExecutions: retentionPlan.policyRejectedExecutions,
  auditProfile,
  requireExecutedInteractionVideo,
  qualityRejectedClips: retentionPlan.qualityRejectedClips,
  normalizedLeadingBlankClips: retentionPlan.normalizations.length,
  diagnosticRetainedClips: retentionPlan.diagnosticRetainedClips,
  removedVideoAttachments,
  retainedFiles: retention.retained.length,
  prunedFiles: retention.pruned.length,
  prunedBytes: retention.prunedBytes,
  integrityErrors: retentionPlan.errors,
});
const rawRoot = join(artifactRoot, 'raw');
const rawExists = await fs.stat(rawRoot).then((value) => value.isDirectory()).catch(() => false);
const shardRoot = join(artifactRoot, 'shards');
const shardRawRoots = rawExists ? [] : await fs.readdir(shardRoot, { withFileTypes: true })
  .then(async (entries) => {
    const candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => join(shardRoot, entry.name, 'raw'));
    const checks = await Promise.all(candidates.map(async (candidate) => ({
      candidate,
      exists: await fs.stat(candidate).then((value) => value.isDirectory()).catch(() => false),
    })));
    return checks.filter(({ exists }) => exists).map(({ candidate }) => candidate);
  })
  .catch(() => [] as string[]);
const videoRoots = rawExists ? [rawRoot] : shardRawRoots.length > 0 ? shardRawRoots : [artifactRoot];
const videos = (await Promise.all(videoRoots.map(filesUnder))).flat().filter((path) => path.endsWith('.webm')).sort();
log('Video evidence processing started', {
  artifactRoot,
  videoRoots,
  videoCount: videos.length,
  ffmpeg: ffmpeg ?? 'unavailable',
  mediaWorkers,
});

const evidence = await mapWithConcurrency(videos, mediaWorkers, async (video): Promise<VideoEvidence> => {
  const videoStat = await fs.stat(video);
  const poster = join(dirname(video), `${basename(video, '.webm')}-poster.jpg`);
  const sha256 = await sha256File(video);
  const evidenceRole = retentionPlan.eligiblePaths.has(resolve(video)) || retentionPlan.eligibleHashes.has(sha256)
    ? 'usable-interaction'
    : retentionPlan.diagnosticPaths.has(resolve(video)) || retentionPlan.diagnosticHashes.has(sha256)
      ? 'diagnostic'
      : 'unclassified';
  if (evidenceRole === 'unclassified') {
    retentionPlan.errors.push(`Retained video ${relative(artifactRoot, video)} has no usable-interaction or diagnostic provenance.`);
  }
  const base: Omit<VideoEvidence, 'processingStatus'> = {
    video: relative(artifactRoot, video),
    bytes: videoStat.size,
    sha256,
    evidenceRole,
    poster: null,
    posterBytes: null,
    processor: ffmpeg,
  };

  if (!ffmpeg) {
    return { ...base, processingStatus: 'ffmpeg-unavailable' };
  }
  try {
    const existing = await fs.stat(poster).catch(() => null);
    if (existing) {
      return {
        ...base,
        poster: relative(artifactRoot, poster),
        posterBytes: existing.size,
        processingStatus: 'already-existed',
      };
    }
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-y', '-ss', '0.5', '-i', video,
      '-frames:v', '1', '-update', '1', '-vf', 'scale=480:-1', poster,
    ];
    log('Command started', { command: [ffmpeg, ...args] });
    const started = performance.now();
    const result = await runBuffered(ffmpeg, args);
    const elapsedMs = Math.round(performance.now() - started);
    log('Command finished', {
      command: ffmpeg,
      exitCode: result.status,
      signal: result.signal,
      elapsedMs,
      timedOut: result.timedOut,
      stderr: result.stderr.trim().slice(-2_000),
    });
    if (result.status !== 0 || result.timedOut) {
      return {
        ...base,
        processingStatus: 'failed',
        error: result.timedOut ? 'poster generation exceeded its 60 second deadline' : result.stderr.trim().slice(-2_000),
      };
    }
    const posterStat = await fs.stat(poster);
    return {
      ...base,
      poster: relative(artifactRoot, poster),
      posterBytes: posterStat.size,
      processingStatus: 'created',
    };
  } catch (error) {
    return {
      ...base,
      processingStatus: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

const manifest = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  artifactRoot,
  ffmpeg,
  videoCount: evidence.length,
  usableInteractionVideoCount: evidence.filter(({ evidenceRole }) => evidenceRole === 'usable-interaction').length,
  diagnosticVideoCount: evidence.filter(({ evidenceRole }) => evidenceRole === 'diagnostic').length,
  processedCount: evidence.filter(({ processingStatus }) => processingStatus === 'created' || processingStatus === 'already-existed').length,
  failedCount: evidence.filter(({ processingStatus }) => processingStatus === 'failed').length,
  unavailableCount: evidence.filter(({ processingStatus }) => processingStatus === 'ffmpeg-unavailable').length,
  retention: {
    policy: 'Only usable videos attached to explicitly declared interaction-video attempts whose status is not skipped are retained as release media. A leading blank browser-capture prefix may be trimmed only when the original clip has a sustained final page state, stays within the overall blank-frame limit, contains a measurable action, and the normalized result independently passes the complete quality gate. Usable clips are at least 2 seconds long, decode representative center-crop frames, contain sustained non-blank initial and final states, remain below the blank-frame limit, and show measurable page-content change. A shorter decodable and visibly changing failed or timed-out interaction is retained only as diagnostic evidence and does not satisfy release integrity. Entirely blank, blank-ending, transient-overlay-only, static, corrupt, skipped, and non-interaction clips are pruned. Every executed interaction in every profile must retain at least one usable clip.',
    auditProfile,
    requireExecutedInteractionVideo,
    eligibleExecutions: retentionPlan.eligibleExecutions,
    rejectedExecutions: retentionPlan.rejectedExecutions,
    skippedExecutions: retentionPlan.skippedExecutions,
    policyRejectedExecutions: retentionPlan.policyRejectedExecutions,
    qualityRejectedClips: retentionPlan.qualityRejectedClips,
    normalizedLeadingBlankClips: retentionPlan.normalizations.length,
    diagnosticRetainedClips: retentionPlan.diagnosticRetainedClips,
    removedVideoAttachments,
    eligibleHashes: retentionPlan.eligibleHashes.size,
    retainedFiles: retention.retained.length,
    prunedFiles: retention.pruned.length,
    prunedBytes: retention.prunedBytes,
    integrityErrors: retentionPlan.errors,
    qualityAssessments: retentionPlan.qualityAssessments.map((assessment) => ({
      video: relative(artifactRoot, assessment.path),
      durationSeconds: assessment.durationSeconds,
      sampledFrames: assessment.sampledFrames,
      maxFrameDifference: assessment.maxFrameDifference,
      changedFrames: assessment.changedFrames,
      postContentChangedFrames: assessment.postContentChangedFrames,
      blankFrameRatio: assessment.blankFrameRatio,
      initialNonBlankRatio: assessment.initialNonBlankRatio,
      finalNonBlankRatio: assessment.finalNonBlankRatio,
      leadingBlankSeconds: assessment.leadingBlankSeconds,
      usable: assessment.usable,
      reasons: assessment.reasons,
      ...(assessment.probeError ? { probeError: assessment.probeError } : {}),
    })),
    normalizations: retentionPlan.normalizations.map((normalization) => ({
      originalVideo: relative(artifactRoot, normalization.originalPath),
      normalizedVideo: relative(artifactRoot, normalization.normalizedPath),
      trimStartSeconds: normalization.trimStartSeconds,
      originalDurationSeconds: normalization.originalDurationSeconds,
      normalizedDurationSeconds: normalization.normalizedDurationSeconds,
      originalLeadingBlankSeconds: normalization.originalAssessment.leadingBlankSeconds,
      originalPostContentChangedFrames: normalization.originalAssessment.postContentChangedFrames,
      originalBlankFrameRatio: normalization.originalAssessment.blankFrameRatio,
      originalInitialNonBlankRatio: normalization.originalAssessment.initialNonBlankRatio,
      originalFinalNonBlankRatio: normalization.originalAssessment.finalNonBlankRatio,
      originalReasons: normalization.originalAssessment.reasons,
    })),
    pruned: retention.pruned.map(({ relativePath, bytes, sha256, reason }) => ({ relativePath, bytes, sha256, reason })),
  },
  videos: evidence,
};
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
log('Video evidence processing finished', {
  manifestPath,
  videoCount: manifest.videoCount,
  processedCount: manifest.processedCount,
  failedCount: manifest.failedCount,
  unavailableCount: manifest.unavailableCount,
  retainedFiles: manifest.retention.retainedFiles,
  prunedFiles: manifest.retention.prunedFiles,
  prunedBytes: manifest.retention.prunedBytes,
  qualityRejectedClips: manifest.retention.qualityRejectedClips,
  normalizedLeadingBlankClips: manifest.retention.normalizedLeadingBlankClips,
  diagnosticRetainedClips: manifest.retention.diagnosticRetainedClips,
  removedVideoAttachments: manifest.retention.removedVideoAttachments,
  integrityErrors: manifest.retention.integrityErrors,
});

if (manifest.failedCount > 0 || manifest.unavailableCount > 0 || manifest.retention.integrityErrors.length > 0) {
  process.exitCode = 1;
}
