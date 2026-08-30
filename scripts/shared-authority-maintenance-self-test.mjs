import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runSharedAuthorityMaintenance } from './run-shared-authority-maintenance.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'shared-authority-maintenance-'));
try {
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const proofDirectory = path.join(repositoryRoot, 'artifacts', 'self-tests', path.basename(root));
  const proofFile = path.join(proofDirectory, 'resilience-proof.json');
  const containerProofFile = `/work/artifacts/self-tests/${path.basename(root)}/resilience-proof.json`;
  await mkdir(proofDirectory, { recursive: true });
  await writeFile(proofFile, '{"kind":"shared-docker-resilience-proof"}\n');
  const configFile = path.join(root, 'operator-config.json');
  const configContents = `${JSON.stringify({
    schemaVersion: 1,
    handoff: { resilienceProofFile: containerProofFile },
  })}\n`;
  await writeFile(configFile, configContents, { mode: 0o600 });
  const calls = [];
  let stagedConfigFile;
  let stagedProofFile;
  await runSharedAuthorityMaintenance(['prequalify-handoff-target', '--config', configFile], {
    output: { write() {} },
    errorOutput: { write() {} },
    run: async (command, args) => {
      calls.push([command, args]);
      if (args[1] !== 'run') return;
      const mount = args.find((value) => value.endsWith(':/tmp/shared-authority-operator-config.json:ro'));
      assert(mount, 'the one-shot container must receive a staged operator config');
      stagedConfigFile = mount.slice(0, -':/tmp/shared-authority-operator-config.json:ro'.length);
      assert.notEqual(stagedConfigFile, configFile, 'the host-owned operator config must not be mounted directly');
      assert.equal(path.dirname(stagedConfigFile).startsWith(path.join(repositoryRoot, 'artifacts', '.shared-authority-maintenance-')), true,
        'staging must stay on the repository filesystem already shared with the Docker daemon');
      assert.equal((await stat(path.dirname(stagedConfigFile))).mode & 0o777, 0o700,
        'the staging directory must remain private to the host operator');
      assert.equal((await stat(stagedConfigFile)).mode & 0o777, 0o444,
        'the staged config must be readable by the unprivileged container UID');
      assert.equal(await readFile(stagedConfigFile, 'utf8'), configContents);
      const proofMount = args.find((value) => value.endsWith(`:${containerProofFile}:ro`));
      assert(proofMount, 'the one-shot container must receive a staged resilience proof');
      stagedProofFile = proofMount.slice(0, -`:${containerProofFile}:ro`.length);
      assert.notEqual(stagedProofFile, proofFile, 'the host-owned proof must not be mounted directly');
      assert.equal((await stat(stagedProofFile)).mode & 0o777, 0o444,
        'the staged proof must be readable by the unprivileged container UID');
      assert.equal(await readFile(stagedProofFile, 'utf8'), '{"kind":"shared-docker-resilience-proof"}\n');
    },
  });
  assert.deepEqual(calls.map(([, args]) => args.slice(0, 3)), [
    ['compose', 'stop', '--timeout'],
    ['compose', 'run', '--rm'],
    ['compose', 'up', '-d'],
    ['compose', 'ps', 'shared-coordinator'],
  ]);
  assert.deepEqual(calls[0][1], ['compose', 'stop', '--timeout', '300', 'shared-coordinator'],
    'maintenance must give the coordinator enough time to finish its bounded pass and release its lease');
  assert(calls[1][1].includes(`${stagedConfigFile}:/tmp/shared-authority-operator-config.json:ro`));
  assert(calls[1][1].includes(`${stagedProofFile}:${containerProofFile}:ro`),
    'the one-shot container must receive only the selected proof file read-only');
  assert(calls[2][1].includes('--wait'));
  assert.deepEqual(calls[2][1].slice(calls[2][1].indexOf('--wait-timeout'), calls[2][1].indexOf('--wait-timeout') + 2),
    ['--wait-timeout', '300'], 'large retained stores receive a bounded five-minute coordinator recovery window');
  await assert.rejects(access(stagedConfigFile), /ENOENT/u,
    'the container-readable staging copy must be removed after maintenance');
  await assert.rejects(access(stagedProofFile), /ENOENT/u,
    'the container-readable proof copy must be removed after maintenance');

  const failedCalls = [];
  let failedStagedFile;
  await assert.rejects(runSharedAuthorityMaintenance(
    ['prequalify-handoff-target', '--config', configFile],
    {
      output: { write() {} },
      errorOutput: { write() {} },
      run: async (command, args) => {
        failedCalls.push([command, args]);
        if (args[1] === 'run') {
          const mount = args.find((value) => value.endsWith(':/tmp/shared-authority-operator-config.json:ro'));
          failedStagedFile = mount.slice(0, -':/tmp/shared-authority-operator-config.json:ro'.length);
          throw new Error('synthetic one-shot failure');
        }
      },
    },
  ), /synthetic one-shot failure/u);
  assert.deepEqual(failedCalls.map(([, args]) => args.slice(0, 3)), [
    ['compose', 'stop', '--timeout'],
    ['compose', 'run', '--rm'],
    ['compose', 'up', '-d'],
    ['compose', 'ps', 'shared-coordinator'],
  ], 'the helper must restart and report the coordinator even when prequalification fails');
  await assert.rejects(access(failedStagedFile), /ENOENT/u,
    'staging must be cleaned after a failed one-shot mutation');

  const stopFailureCalls = [];
  await assert.rejects(runSharedAuthorityMaintenance(
    ['prequalify-handoff-target', '--config', configFile],
    {
      output: { write() {} },
      errorOutput: { write() {} },
      run: async (command, args) => {
        stopFailureCalls.push([command, args]);
        if (args[1] === 'stop') throw new Error('ambiguous stop failure');
      },
    },
  ), /ambiguous stop failure/u);
  assert.deepEqual(stopFailureCalls.map(([, args]) => args.slice(0, 3)), [
    ['compose', 'stop', '--timeout'],
    ['compose', 'up', '-d'],
    ['compose', 'ps', 'shared-coordinator'],
  ], 'an ambiguous stop failure must still attempt coordinator recovery');

  let dualFailureLog = '';
  await assert.rejects(runSharedAuthorityMaintenance(
    ['prequalify-handoff-target', '--config', configFile],
    {
      output: { write() {} },
      errorOutput: { write(chunk) { dualFailureLog += chunk; } },
      run: async (command, args) => {
        if (args[1] === 'run') throw new Error('primary prequalification failure');
        if (args[1] === 'up') throw new Error('secondary recovery failure');
      },
    },
  ), /primary prequalification failure/u,
  'a recovery failure must not replace the prequalification diagnosis');
  assert.match(dualFailureLog, /Coordinator recovery also failed: secondary recovery failure/u,
    'the secondary recovery failure must remain visible to the operator');

  await assert.rejects(runSharedAuthorityMaintenance(
    ['prequalify-handoff-target', '--config', configFile],
    {
      output: { write() {} },
      errorOutput: { write() {} },
      run: async (command, args) => {
        if (args[1] === 'up' && args.includes('--wait')) {
          throw new Error('coordinator failed its bounded readiness check');
        }
      },
    },
  ), /bounded readiness check/u,
  'maintenance must fail when the restarted coordinator does not become healthy');
} finally {
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  await rm(path.join(repositoryRoot, 'artifacts', 'self-tests', path.basename(root)), { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('Shared authority maintenance self-test passed: graceful stop, one-shot mutation, restart, and failure recovery remain ordered.\n');
