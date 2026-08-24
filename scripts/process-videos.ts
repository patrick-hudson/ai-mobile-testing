import { constants, promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyVideoRetentionPlan,
  buildVideoRetentionPlan,
  probeVideoQuality,
  removeRejectedVideoAttachments,
  sha256File,
} from './lib/video-retention.js';

interface VideoEvidence {
  video: string;
  bytes: number;
  sha256: string;
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

function log(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${new Date().toISOString()} [MEDIA] ${event} ${JSON.stringify(detail)}\n`);
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
const requireExecutedInteractionVideo = auditProfile === 'release';
const ffmpeg = await locateFfmpeg();
let retentionPlan;
let results: Parameters<typeof buildVideoRetentionPlan>[0];
let removedVideoAttachments = 0;
try {
  results = JSON.parse(await fs.readFile(resultsPath, 'utf8')) as Parameters<typeof buildVideoRetentionPlan>[0];
  retentionPlan = await buildVideoRetentionPlan(results, artifactRoot, resultsPath, {
    requireExecutedInteractionVideo,
    ...(ffmpeg ? {
      probeVideo: (file) => probeVideoQuality(file, ffmpeg, ({ event, ...detail }) => log(event, detail)),
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
});

const evidence: VideoEvidence[] = [];
for (const video of videos) {
  const videoStat = await fs.stat(video);
  const poster = join(dirname(video), `${basename(video, '.webm')}-poster.jpg`);
  const base: Omit<VideoEvidence, 'processingStatus'> = {
    video: relative(artifactRoot, video),
    bytes: videoStat.size,
    sha256: await sha256File(video),
    poster: null,
    posterBytes: null,
    processor: ffmpeg,
  };

  if (!ffmpeg) {
    evidence.push({ ...base, processingStatus: 'ffmpeg-unavailable' });
    continue;
  }
  try {
    const existing = await fs.stat(poster).catch(() => null);
    if (existing) {
      evidence.push({
        ...base,
        poster: relative(artifactRoot, poster),
        posterBytes: existing.size,
        processingStatus: 'already-existed',
      });
      continue;
    }
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-y', '-ss', '0.5', '-i', video,
      '-frames:v', '1', '-update', '1', '-vf', 'scale=480:-1', poster,
    ];
    log('Command started', { command: [ffmpeg, ...args] });
    const started = performance.now();
    const result = spawnSync(ffmpeg, args, { encoding: 'utf8' });
    const elapsedMs = Math.round(performance.now() - started);
    log('Command finished', {
      command: ffmpeg,
      exitCode: result.status,
      signal: result.signal,
      elapsedMs,
      stderr: result.stderr.trim().slice(-2_000),
    });
    if (result.status !== 0) {
      evidence.push({ ...base, processingStatus: 'failed', error: result.stderr.trim().slice(-2_000) });
      continue;
    }
    const posterStat = await fs.stat(poster);
    evidence.push({
      ...base,
      poster: relative(artifactRoot, poster),
      posterBytes: posterStat.size,
      processingStatus: 'created',
    });
  } catch (error) {
    evidence.push({
      ...base,
      processingStatus: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const manifest = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  artifactRoot,
  ffmpeg,
  videoCount: evidence.length,
  processedCount: evidence.filter(({ processingStatus }) => processingStatus === 'created' || processingStatus === 'already-existed').length,
  failedCount: evidence.filter(({ processingStatus }) => processingStatus === 'failed').length,
  unavailableCount: evidence.filter(({ processingStatus }) => processingStatus === 'ffmpeg-unavailable').length,
  retention: {
    policy: 'Only usable videos attached to explicitly declared interaction-video attempts whose status is not skipped are retained as release media. Usable clips are at least 2 seconds long, decode representative frames, and show measurable visual change. A shorter decodable and visibly changing failed or timed-out interaction is retained only as diagnostic evidence and does not satisfy release integrity. Blank, static, corrupt, skipped, and non-interaction clips are pruned. Release-profile executed interactions must retain at least one usable clip.',
    auditProfile,
    requireExecutedInteractionVideo,
    eligibleExecutions: retentionPlan.eligibleExecutions,
    rejectedExecutions: retentionPlan.rejectedExecutions,
    skippedExecutions: retentionPlan.skippedExecutions,
    policyRejectedExecutions: retentionPlan.policyRejectedExecutions,
    qualityRejectedClips: retentionPlan.qualityRejectedClips,
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
      usable: assessment.usable,
      reasons: assessment.reasons,
      ...(assessment.probeError ? { probeError: assessment.probeError } : {}),
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
  diagnosticRetainedClips: manifest.retention.diagnosticRetainedClips,
  removedVideoAttachments: manifest.retention.removedVideoAttachments,
  integrityErrors: manifest.retention.integrityErrors,
});

if (manifest.failedCount > 0 || manifest.unavailableCount > 0 || manifest.retention.integrityErrors.length > 0) {
  process.exitCode = 1;
}
