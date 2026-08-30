#!/usr/bin/env node
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(repositoryRoot, 'artifacts');
const ACTION = 'prequalify-handoff-target';

function parseArguments(argv) {
  if (argv.length !== 3 || argv[0] !== ACTION || argv[1] !== '--config'
    || typeof argv[2] !== 'string' || !argv[2] || argv[2].startsWith('-')) {
    throw new TypeError(`Usage: run-shared-authority-maintenance.mjs ${ACTION} --config <operator-config.json>`);
  }
  return { action: argv[0], configFile: path.resolve(argv[2]) };
}

async function validateConfigFile(file) {
  let handle;
  let resilienceProofFile;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 4 * 1_048_576) {
      throw new TypeError('Operator config must be a bounded non-empty regular file.');
    }
    const config = JSON.parse(await handle.readFile('utf8'));
    if (config?.schemaVersion !== 1 || typeof config?.handoff?.resilienceProofFile !== 'string'
      || !config.handoff.resilienceProofFile.startsWith('/work/artifacts/')) {
      throw new TypeError('Operator config must use schemaVersion 1 and reference its resilience proof below /work/artifacts/.');
    }
    resilienceProofFile = config.handoff.resilienceProofFile;
  } finally {
    await handle?.close();
  }

  const relativeProofFile = resilienceProofFile.slice('/work/artifacts/'.length);
  const hostProofFile = path.resolve(artifactRoot, relativeProofFile);
  if (!relativeProofFile || hostProofFile === artifactRoot
    || !hostProofFile.startsWith(`${artifactRoot}${path.sep}`)) {
    throw new TypeError('Resilience proof must resolve to a file below the repository artifact root.');
  }
  let proofHandle;
  try {
    proofHandle = await fs.open(hostProofFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await proofHandle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 4 * 1_048_576) {
      throw new TypeError('Resilience proof must be a bounded non-empty regular file.');
    }
  } finally {
    await proofHandle?.close();
  }
  return { hostProofFile, resilienceProofFile };
}

function renderCommand(command, args) {
  return [command, ...args].map((value) => /[^A-Za-z0-9_./:=+-]/u.test(value) ? JSON.stringify(value) : value).join(' ');
}

function execute(command, args, { cwd, output = process.stdout, errorOutput = process.stderr } = {}) {
  output.write(`[shared-authority-maintenance] $ ${renderCommand(command, args)}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => output.write(chunk));
    child.stderr.on('data', (chunk) => errorOutput.write(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
  });
}

export async function runSharedAuthorityMaintenance(argv, {
  run = execute,
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  const { action, configFile } = parseArguments(argv);
  const { hostProofFile, resilienceProofFile } = await validateConfigFile(configFile);
  const mountedConfig = '/tmp/shared-authority-operator-config.json';
  let coordinatorStopped = false;
  try {
    await run('docker', ['compose', 'stop', 'shared-coordinator'], {
      cwd: repositoryRoot, output, errorOutput,
    });
    coordinatorStopped = true;
    await run('docker', [
      'compose', 'run', '--rm', '--no-deps',
      '--volume', `${configFile}:${mountedConfig}:ro`,
      '--volume', `${hostProofFile}:${resilienceProofFile}:ro`,
      'shared-coordinator',
      'node', 'scripts/run-shared-authority-cutover.mjs', action, '--config', mountedConfig,
    ], { cwd: repositoryRoot, output, errorOutput });
  } finally {
    if (coordinatorStopped) {
      await run('docker', [
        'compose', 'up', '-d', '--wait', '--wait-timeout', '60', 'shared-coordinator',
      ], {
        cwd: repositoryRoot, output, errorOutput,
      });
      await run('docker', ['compose', 'ps', 'shared-coordinator'], {
        cwd: repositoryRoot, output, errorOutput,
      });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSharedAuthorityMaintenance(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[shared-authority-maintenance] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
