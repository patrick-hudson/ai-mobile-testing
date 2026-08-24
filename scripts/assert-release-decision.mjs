import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pipelineOnlyOutcome, readChecklistRelease, releaseOutcome } from './lib/release-truth.mjs';

const options = parseArguments(process.argv.slice(2));
let pipelineStatus = 'completed';
if (options.pipelineManifest) {
  const lifecycle = JSON.parse(await readFile(options.pipelineManifest, 'utf8'));
  pipelineStatus = lifecycle.pipeline?.status ?? lifecycle.pipelineStatus ?? 'unavailable';
}
const release = await readChecklistRelease(options.manifest);
const outcome = options.pipelineOnly
  ? pipelineOnlyOutcome(pipelineStatus, release)
  : releaseOutcome(pipelineStatus, release);
console.log(JSON.stringify({
  policy: options.pipelineOnly ? 'PIPELINE_ONLY' : 'REQUIRE_READY',
  policyReason: options.pipelineOnly
    ? 'Pipeline-only validation requires complete evidence, no executed blocking failures, and no run-integrity failure; it does not certify release readiness.'
    : 'A completed evidence pipeline and authoritative READY decision are both required.',
  pipelineStatus,
  releaseDecision: release.decision,
  releaseReason: release.reason,
  outcome: outcome.status,
  manifest: options.manifest,
}));
if (outcome.exitCode !== 0) process.exitCode = outcome.exitCode;

function parseArguments(argv) {
  let manifest;
  let pipelineManifest;
  let pipelineOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest') manifest = argv[++index];
    else if (argument === '--pipeline-manifest') pipelineManifest = argv[++index];
    else if (argument === '--pipeline-only') pipelineOnly = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!manifest) throw new Error('--manifest is required.');
  return {
    manifest: resolve(manifest),
    pipelineManifest: pipelineManifest ? resolve(pipelineManifest) : null,
    pipelineOnly,
  };
}
