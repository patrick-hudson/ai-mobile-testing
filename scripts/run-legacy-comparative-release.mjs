#!/usr/bin/env node

import { spawn } from 'node:child_process';

import { openLegacyAuthorityFenceFromEnvironment } from './lib/legacy-authority-fence.mjs';

const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

function runPlaywright() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], {
      cwd: process.cwd(),
      env: { ...process.env, AUDIT_PROFILE: 'release' },
      stdio: 'inherit',
      shell: false,
    });
    const forwardInterrupt = () => child.kill('SIGINT');
    const forwardTermination = () => child.kill('SIGTERM');
    process.once('SIGINT', forwardInterrupt);
    process.once('SIGTERM', forwardTermination);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', forwardInterrupt);
      process.removeListener('SIGTERM', forwardTermination);
      resolve(code ?? SIGNAL_EXIT_CODES[signal] ?? 1);
    });
  });
}

const fence = await openLegacyAuthorityFenceFromEnvironment(process.env);
const exitCode = await fence.withAuthority('comparative-launch', runPlaywright);
process.exitCode = exitCode;
