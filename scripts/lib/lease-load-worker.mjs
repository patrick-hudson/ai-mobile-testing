import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';

if (!parentPort || !workerData || !['worker', 'shard', 'media'].includes(workerData.kind)) {
  throw new Error('Lease load worker requires a parent port and a known bounded lane kind.');
}

const control = new Int32Array(workerData.control);
const bytes = Buffer.alloc(64 * 1024, workerData.lane % 251);
let file = null;
let iterations = 0;
let writes = 0;
let digest = Buffer.alloc(32, workerData.lane % 251);

try {
  if (workerData.kind === 'media') file = openSync(workerData.scratchPath, 'w', 0o600);
  parentPort.postMessage({ event: 'ready', kind: workerData.kind, lane: workerData.lane });
  Atomics.wait(control, 0, 0);
  const started = performance.now();
  const deadline = started + workerData.durationMs;
  while (performance.now() < deadline) {
    const hash = createHash('sha256');
    hash.update(bytes);
    hash.update(digest);
    digest = hash.digest();
    iterations += 1;
    if (file !== null && iterations % 128 === 0) {
      writeSync(file, bytes, 0, bytes.length, 0);
      writes += 1;
      if (writes % 32 === 0) fsyncSync(file);
    }
  }
  if (file !== null) fsyncSync(file);
  parentPort.postMessage({
    event: 'done',
    kind: workerData.kind,
    lane: workerData.lane,
    elapsedMs: performance.now() - started,
    iterations,
    writes,
    digest: digest.toString('hex'),
  });
} finally {
  if (file !== null) closeSync(file);
}
