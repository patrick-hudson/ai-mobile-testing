#!/usr/bin/env node
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalDigest, canonicalJson } from '../shared/canonical-contract.mjs';
import { deriveRunnerRevision, runnerRevisionDigest } from '../shared/runner-revision.mjs';
import { validateSharedDockerResilienceProof } from './assert-shared-docker-resilience-proof.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  if (argv.length !== 6) {
    throw new TypeError('Usage: create-shared-build-compatibility-proof.mjs --resilience-proof <file> --target-build <identity> --output <file>');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--resilience-proof', '--target-build', '--output'].includes(flag)
      || values.has(flag) || typeof value !== 'string' || !value || value.startsWith('-')) {
      throw new TypeError('Usage: create-shared-build-compatibility-proof.mjs --resilience-proof <file> --target-build <identity> --output <file>');
    }
    values.set(flag, value);
  }
  return {
    resilienceProofFile: values.get('--resilience-proof'),
    targetBuildIdentity: values.get('--target-build'),
    outputFile: values.get('--output'),
  };
}

async function readBoundedJson(file, label, maximumBytes = 32 * 1_048_576) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > maximumBytes) {
      throw new TypeError(`${label} must be a bounded non-empty regular file.`);
    }
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle?.close();
  }
}

export function createSharedBuildCompatibilityProof({
  resilienceProof,
  targetBuildIdentity,
  expectedWorkspaceRevision,
  validate = validateSharedDockerResilienceProof,
} = {}) {
  if (typeof validate !== 'function') throw new TypeError('A resilience-proof validator is required.');
  const validated = validate(resilienceProof, { expectedWorkspaceRevision });
  const imageDigest = validated?.source?.imageId;
  const expectedTargetBuildIdentity = `build:${imageDigest}`;
  if (typeof targetBuildIdentity !== 'string' || targetBuildIdentity !== expectedTargetBuildIdentity) {
    throw new TypeError(`Target build identity must equal the validated immutable image identity ${expectedTargetBuildIdentity}.`);
  }
  const body = {
    schemaVersion: 1,
    kind: 'shared-build-compatibility-proof',
    targetBuildIdentity,
    runnerRevision: runnerRevisionDigest(validated.source.imageRevision),
    imageDigest,
    validationDigest: canonicalDigest(validated),
    generatedAt: validated.generatedAt,
  };
  return Object.freeze({ ...body, digest: canonicalDigest(body) });
}

async function writeImmutableJson(file, value) {
  const document = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await fs.open(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(document);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readBoundedJson(file, 'Existing compatibility proof', 256 * 1_024);
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error('Compatibility proof output already exists with different immutable content.');
    }
  }
}

export async function runSharedBuildCompatibilityProofCli(argv) {
  const input = parseArguments(argv);
  const resilienceProof = await readBoundedJson(input.resilienceProofFile, 'Shared Docker resilience proof');
  const proof = createSharedBuildCompatibilityProof({
    resilienceProof,
    targetBuildIdentity: input.targetBuildIdentity,
    expectedWorkspaceRevision: await deriveRunnerRevision(repositoryRoot),
  });
  await writeImmutableJson(input.outputFile, proof);
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSharedBuildCompatibilityProofCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[shared-build-compatibility] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
