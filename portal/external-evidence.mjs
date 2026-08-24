import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readChecklistRelease } from '../scripts/lib/release-truth.mjs';
import { validatePreferredMediaManifest } from './video-manifest.mjs';
import { validateCompleteReportPublication } from './report-publication.mjs';

const RELEASE_FIELDS = [
  'decision',
  'ready',
  'reason',
  'decisionBasis',
  'blockingFailures',
  'blockingIncomplete',
  'baselineIssues',
  'runIntegrityFailure',
];

export async function validateExternalTerminalEvidence({
  runDirectory: runDirectoryValue,
  expectedRunId,
  lifecycle,
  source,
  maximumShardTotal = 16,
  maximumVideoManifestBytes = 8 * 1024 * 1024,
  maximumPreferredMediaArtifacts = 120,
}) {
  const runDirectory = resolve(runDirectoryValue);
  const problems = validateLifecycleIdentity(lifecycle, expectedRunId, source, maximumShardTotal);
  const pipelineComplete = lifecycle?.pipeline?.status === 'completed' && lifecycle?.pipeline?.completed === true;
  if (!pipelineComplete) return { problems, checklistRelease: null };

  if (source === 'sharded-run.json') {
    validateCoordinatorCompletion(lifecycle, problems);
  } else if (source === 'merge-lifecycle.json') {
    validateMergeCompletion(lifecycle, problems);
  }

  for (const relativePath of [
    'results.json',
    'checklist/index.html',
    'checklist/manifest.json',
    'checklist/data/current.json',
    'video-manifest.json',
  ]) {
    const issue = await requiredRegularContainedFile(runDirectory, relativePath);
    if (issue) problems.push(`${relativePath} ${issue}`);
  }

  let checklistRelease = null;
  let checklistManifest = null;
  try {
    checklistRelease = await readChecklistRelease(join(runDirectory, 'checklist', 'manifest.json'));
    checklistManifest = JSON.parse(await fs.readFile(join(runDirectory, 'checklist', 'manifest.json'), 'utf8'));
  } catch (error) {
    problems.push(error.message);
  }
  const reportPublication = await validateCompleteReportPublication(runDirectory, {
    maximumPointerBytes: 1024 * 1024,
    maximumSummaryBytes: 2 * 1024 * 1024,
    maximumAuditIndexBytes: 16 * 1024 * 1024,
    maximumAuditDetailBytes: 1024 * 1024,
  });
  problems.push(...reportPublication.problems.map((problem) => `compact report publication: ${problem}`));
  if (checklistRelease) {
    const releaseDifferences = differingReleaseFields(lifecycle.release, checklistRelease);
    if (releaseDifferences.length > 0) {
      problems.push(`lifecycle release disagrees with checklist release fields: ${releaseDifferences.join(', ')}`);
    }
    if (reportPublication.summary) {
      const summaryDifferences = differingReleaseFields(reportPublication.summary.release, checklistRelease);
      if (summaryDifferences.length > 0) {
        problems.push(`report summary release disagrees with checklist release fields: ${summaryDifferences.join(', ')}`);
      }
    }
    if (checklistManifest?.generatedAt !== reportPublication.publication?.generatedAt) {
      problems.push('compact report publication generatedAt disagrees with checklist/manifest.json.');
    }
  }

  const media = await validatePreferredMediaManifest(runDirectory, {
    maximumBytes: maximumVideoManifestBytes,
    maximumArtifacts: maximumPreferredMediaArtifacts,
    // External discovery runs on the portal's short background refresh loop.
    // It validates every retained path, byte count, status, and manifest claim
    // here; preferred-media discovery performs SHA-256 before advertising it.
    verifyDigests: false,
  });
  if (media.schemaVersion !== 2) problems.push('video-manifest.json is not an authoritative schemaVersion 2 manifest.');
  problems.push(...media.errors.map((problem) => `video-manifest.json: ${problem}`));
  return { problems: unique(problems), checklistRelease };
}

export function validateLifecycleIdentity(lifecycle, expectedRunId, source, maximumShardTotal = 16) {
  const problems = [];
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) {
    return [`${source} must contain a JSON object.`];
  }
  if (lifecycle.schemaVersion !== 2) problems.push(`${source} schemaVersion must be 2.`);
  if (lifecycle.runId !== expectedRunId) problems.push(`${source} runId does not match the evidence directory.`);
  if (!Number.isSafeInteger(lifecycle.shardTotal)
    || lifecycle.shardTotal < 1
    || lifecycle.shardTotal > maximumShardTotal) {
    problems.push(`${source} shardTotal must be an integer from 1 to ${maximumShardTotal}.`);
  }
  return problems;
}

function validateCoordinatorCompletion(lifecycle, problems) {
  const shardTotal = lifecycle.shardTotal;
  if (!Array.isArray(lifecycle.shards) || lifecycle.shards.length !== shardTotal) {
    problems.push('sharded-run.json must contain exactly shardTotal shard command records.');
  } else {
    const indices = lifecycle.shards.map(({ index }) => index).sort((left, right) => left - right);
    const expected = Array.from({ length: shardTotal }, (_, offset) => offset + 1);
    if (JSON.stringify(indices) !== JSON.stringify(expected)) {
      problems.push('sharded-run.json shard indices must cover every selected shard exactly once.');
    }
    for (const [index, shard] of lifecycle.shards.entries()) {
      validateCommandResult(shard, `shards[${index}]`, problems, [0, 1]);
    }
  }
  validateCommandResult(lifecycle.build, 'build', problems, [0]);
  validateCommandResult(lifecycle.performance, 'performance', problems, [0, 1]);
  validateCommandResult(lifecycle.merge, 'merge', problems, [0, 1]);
  if (lifecycle.mergePipeline?.status !== 'completed' || lifecycle.mergePipeline?.completed !== true) {
    problems.push('sharded-run.json mergePipeline must confirm a completed merge evidence pipeline.');
  }
}

function validateMergeCompletion(lifecycle, problems) {
  if (lifecycle.blobPreflight?.passed !== true) problems.push('merge-lifecycle.json blob preflight did not pass.');
  if (!Array.isArray(lifecycle.expectedBlobs)
    || lifecycle.expectedBlobs.length !== lifecycle.shardTotal + 1) {
    problems.push('merge-lifecycle.json must identify every functional shard blob and the isolated performance blob.');
  }
  if (!Array.isArray(lifecycle.stages)) {
    problems.push('merge-lifecycle.json is missing stage results.');
    return;
  }
  const stages = new Map(lifecycle.stages.map((stage) => [stage?.name, stage]));
  validateCommandResult(stages.get('merge-reports'), 'stages.merge-reports', problems, [0, 1]);
  validateCommandResult(stages.get('process-media'), 'stages.process-media', problems, [0]);
  validateCommandResult(stages.get('rebuild-checklist'), 'stages.rebuild-checklist', problems, [0]);
}

function validateCommandResult(result, name, problems, allowedExitCodes) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    problems.push(`${name} is missing a command result.`);
    return;
  }
  if (!allowedExitCodes.includes(result.exitCode)) problems.push(`${name}.exitCode is not an allowed completed result.`);
  if (result.signal !== null) problems.push(`${name}.signal must be null.`);
  if (!Number.isFinite(Date.parse(String(result.finishedAt ?? '')))) problems.push(`${name}.finishedAt is invalid.`);
}

function differingReleaseFields(reported, authoritative) {
  if (!reported || typeof reported !== 'object' || Array.isArray(reported)) return ['release'];
  return RELEASE_FIELDS.filter((field) => reported[field] !== authoritative[field]);
}

async function requiredRegularContainedFile(runDirectory, relativePath) {
  const absolutePath = join(runDirectory, ...relativePath.split('/'));
  try {
    const linkStat = await fs.lstat(absolutePath);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) return 'must be a regular non-symbolic-link file.';
    const [realRoot, realPath] = await Promise.all([fs.realpath(runDirectory), fs.realpath(absolutePath)]);
    if (!inside(realRoot, realPath)) return 'resolves outside the run directory.';
    const stat = await fs.stat(realPath);
    if (!stat.isFile() || stat.size <= 0) return 'must be a non-empty regular file.';
    return null;
  } catch (error) {
    return `is unavailable: ${error?.code === 'ENOENT' ? 'file is missing' : error.message}.`;
  }
}

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function unique(values) {
  return [...new Set(values)];
}
