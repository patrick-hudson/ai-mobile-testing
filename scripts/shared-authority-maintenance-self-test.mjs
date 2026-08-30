import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(configFile, `${JSON.stringify({
    schemaVersion: 1,
    handoff: { resilienceProofFile: containerProofFile },
  })}\n`);
  const calls = [];
  await runSharedAuthorityMaintenance(['prequalify-handoff-target', '--config', configFile], {
    output: { write() {} },
    errorOutput: { write() {} },
    run: async (command, args) => { calls.push([command, args]); },
  });
  assert.deepEqual(calls.map(([, args]) => args.slice(0, 3)), [
    ['compose', 'stop', 'shared-coordinator'],
    ['compose', 'run', '--rm'],
    ['compose', 'up', '-d'],
    ['compose', 'ps', 'shared-coordinator'],
  ]);
  assert(calls[1][1].includes(`${configFile}:/tmp/shared-authority-operator-config.json:ro`));
  assert(calls[1][1].includes(`${proofFile}:${containerProofFile}:ro`),
    'the one-shot container must receive only the selected proof file read-only');
  assert(calls[2][1].includes('--wait'));
  assert(calls[2][1].includes('--wait-timeout'));

  const failedCalls = [];
  await assert.rejects(runSharedAuthorityMaintenance(
    ['prequalify-handoff-target', '--config', configFile],
    {
      output: { write() {} },
      errorOutput: { write() {} },
      run: async (command, args) => {
        failedCalls.push([command, args]);
        if (args[1] === 'run') throw new Error('synthetic one-shot failure');
      },
    },
  ), /synthetic one-shot failure/u);
  assert.deepEqual(failedCalls.map(([, args]) => args.slice(0, 3)), [
    ['compose', 'stop', 'shared-coordinator'],
    ['compose', 'run', '--rm'],
    ['compose', 'up', '-d'],
    ['compose', 'ps', 'shared-coordinator'],
  ], 'the helper must restart and report the coordinator even when prequalification fails');

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
