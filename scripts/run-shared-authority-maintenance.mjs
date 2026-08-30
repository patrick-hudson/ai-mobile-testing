#!/usr/bin/env node
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(repositoryRoot, 'artifacts');
const ACTION = 'prequalify-handoff-target';
const COORDINATOR_WAIT_TIMEOUT_SECONDS = '300';

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
  let configBytes;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 4 * 1_048_576) {
      throw new TypeError('Operator config must be a bounded non-empty regular file.');
    }
    configBytes = await handle.readFile();
    const config = JSON.parse(configBytes.toString('utf8'));
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
  let proofBytes;
  try {
    proofHandle = await fs.open(hostProofFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await proofHandle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 4 * 1_048_576) {
      throw new TypeError('Resilience proof must be a bounded non-empty regular file.');
    }
    proofBytes = await proofHandle.readFile();
  } finally {
    await proofHandle?.close();
  }
  return { configBytes, proofBytes, resilienceProofFile };
}

async function stageContainerReadableInputs(configBytes, proofBytes) {
  const directory = await fs.mkdtemp(path.join(artifactRoot, '.shared-authority-maintenance-'));
  const stagedConfigFile = path.join(directory, 'operator-config.json');
  const stagedProofFile = path.join(directory, 'resilience-proof.json');
  try {
    await Promise.all([
      fs.writeFile(stagedConfigFile, configBytes, { flag: 'wx', mode: 0o444 }),
      fs.writeFile(stagedProofFile, proofBytes, { flag: 'wx', mode: 0o444 }),
    ]);
    await Promise.all([fs.chmod(stagedConfigFile, 0o444), fs.chmod(stagedProofFile, 0o444)]);
    return Object.freeze({
      configFile: stagedConfigFile,
      proofFile: stagedProofFile,
      cleanup: () => fs.rm(directory, { recursive: true, force: true }),
    });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
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
  const { configBytes, proofBytes, resilienceProofFile } = await validateConfigFile(configFile);
  const staged = await stageContainerReadableInputs(configBytes, proofBytes);
  const mountedConfig = '/tmp/shared-authority-operator-config.json';
  let primaryError = null;
  let recoveryError = null;
  let cleanupError = null;
  try {
    try {
      await run('docker', ['compose', 'stop', '--timeout', COORDINATOR_WAIT_TIMEOUT_SECONDS, 'shared-coordinator'], {
        cwd: repositoryRoot, output, errorOutput,
      });
      await run('docker', [
        'compose', 'run', '--rm', '--no-deps',
        '--volume', `${staged.configFile}:${mountedConfig}:ro`,
        '--volume', `${staged.proofFile}:${resilienceProofFile}:ro`,
        'shared-coordinator',
        'node', 'scripts/run-shared-authority-cutover.mjs', action, '--config', mountedConfig,
      ], { cwd: repositoryRoot, output, errorOutput });
    } catch (error) {
      primaryError = error;
    }
    try {
      await run('docker', [
        'compose', 'up', '-d', '--wait', '--wait-timeout', COORDINATOR_WAIT_TIMEOUT_SECONDS, 'shared-coordinator',
      ], {
        cwd: repositoryRoot, output, errorOutput,
      });
      await run('docker', ['compose', 'ps', 'shared-coordinator'], {
        cwd: repositoryRoot, output, errorOutput,
      });
    } catch (error) {
      recoveryError = error;
    }
  } finally {
    try {
      await staged.cleanup();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError) {
    if (recoveryError) errorOutput.write(`[shared-authority-maintenance] Coordinator recovery also failed: ${recoveryError.message}\n`);
    if (cleanupError) errorOutput.write(`[shared-authority-maintenance] Staging cleanup also failed: ${cleanupError.message}\n`);
    throw primaryError;
  }
  if (recoveryError) {
    if (cleanupError) errorOutput.write(`[shared-authority-maintenance] Staging cleanup also failed: ${cleanupError.message}\n`);
    throw recoveryError;
  }
  if (cleanupError) throw cleanupError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSharedAuthorityMaintenance(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[shared-authority-maintenance] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
