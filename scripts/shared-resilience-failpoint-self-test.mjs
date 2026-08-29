import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  maybeCrashAtSharedResilienceBoundary,
  readSharedResilienceCrashSentinel,
  SHARED_RESILIENCE_CRASH_BOUNDARIES,
} from './lib/shared-resilience-failpoint.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'shared-resilience-failpoint-'));
const sentinelRoot = path.join(temporary, '.shared-resilience-failpoints');
const calls = [];
const killProcess = (pid, signal) => calls.push({ pid, signal });
const environment = {
  AUDIT_SHARED_RESILIENCE_PROOF: '1',
  AUDIT_SHARED_CRASH_BOUNDARY: 'work-item-adoption',
  AUDIT_SHARED_CRASH_SENTINEL_ROOT: sentinelRoot,
};

try {
  assert.deepEqual(SHARED_RESILIENCE_CRASH_BOUNDARIES, [
    'inventory-seal', 'work-item-adoption', 'oracle-seal',
    'envelope-fsync', 'head-swap', 'mutation-acceptance',
  ]);
  assert.deepEqual(await maybeCrashAtSharedResilienceBoundary('work-item-adoption', {
    environment: {}, killProcess,
  }), { triggered: false, reason: 'not-configured' });
  await assert.rejects(
    maybeCrashAtSharedResilienceBoundary('work-item-adoption', {
      environment: { ...environment, AUDIT_SHARED_RESILIENCE_PROOF: '0' }, killProcess,
    }),
    (error) => error?.code === 'SHARED_RESILIENCE_FAILPOINT_DISABLED',
  );
  await assert.rejects(
    maybeCrashAtSharedResilienceBoundary('work-item-adoption', {
      environment: { ...environment, AUDIT_SHARED_CRASH_BOUNDARY: 'typo-boundary' }, killProcess,
    }),
    (error) => error?.code === 'SHARED_RESILIENCE_FAILPOINT_INVALID',
  );
  await assert.rejects(
    maybeCrashAtSharedResilienceBoundary('work-item-adoption', {
      environment: { ...environment, AUDIT_SHARED_CRASH_SENTINEL_ROOT: temporary }, killProcess,
    }),
    (error) => error?.code === 'SHARED_RESILIENCE_FAILPOINT_INVALID',
  );
  assert.deepEqual(await maybeCrashAtSharedResilienceBoundary('inventory-seal', {
    environment, killProcess,
  }), { triggered: false, reason: 'different-boundary' });

  const first = await maybeCrashAtSharedResilienceBoundary('work-item-adoption', {
    environment, killProcess, pid: 4242, clock: () => Date.parse('2026-08-29T23:30:00.000Z'),
  });
  assert.equal(first.triggered, true);
  assert.deepEqual(calls, [{ pid: 4242, signal: 'SIGKILL' }]);
  const sentinel = JSON.parse(await readFile(path.join(sentinelRoot, 'work-item-adoption.json'), 'utf8'));
  assert.equal(sentinel.boundary, 'work-item-adoption');
  assert.equal(sentinel.pid, 4242);
  assert.equal(sentinel.armedAt, '2026-08-29T23:30:00.000Z');
  assert.deepEqual(await readSharedResilienceCrashSentinel('work-item-adoption', { root: sentinelRoot }), sentinel);
  await assert.rejects(
    readSharedResilienceCrashSentinel('oracle-seal', { root: sentinelRoot }),
    (error) => error?.code === 'SHARED_RESILIENCE_FAILPOINT_MISSING',
  );

  assert.deepEqual(await maybeCrashAtSharedResilienceBoundary('work-item-adoption', {
    environment, killProcess,
  }), { triggered: false, reason: 'already-triggered', sentinel });
  assert.equal(calls.length, 1, 'a durable sentinel must make the crash injection one-shot');

  const concurrentEnvironment = { ...environment, AUDIT_SHARED_CRASH_BOUNDARY: 'head-swap' };
  const concurrent = await Promise.all([
    maybeCrashAtSharedResilienceBoundary('head-swap', { environment: concurrentEnvironment, killProcess, pid: 5001 }),
    maybeCrashAtSharedResilienceBoundary('head-swap', { environment: concurrentEnvironment, killProcess, pid: 5002 }),
  ]);
  assert.equal(concurrent.filter(({ triggered }) => triggered).length, 1,
    'concurrent boundary calls must elect one durable crash injector');
  assert.equal(concurrent.filter(({ reason }) => reason === 'already-triggered').length, 1);
  assert.equal(calls.length, 2, 'only one concurrent caller may issue SIGKILL');

  await writeFile(path.join(sentinelRoot, 'work-item-adoption.json'), '{}\n');
  await assert.rejects(
    maybeCrashAtSharedResilienceBoundary('work-item-adoption', { environment, killProcess }),
    (error) => error?.code === 'SHARED_RESILIENCE_FAILPOINT_CORRUPT',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write('Shared resilience failpoint self-test passed.\n');
