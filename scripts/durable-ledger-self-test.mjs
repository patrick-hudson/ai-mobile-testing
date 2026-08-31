import assert from 'node:assert/strict';
import * as nativeFilesystem from 'node:fs/promises';
import { mkdtemp, readFile, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { openAtomicStorage } from './lib/atomic-filesystem.mjs';
import {
  appendLedgerEvent,
  LEDGER_KINDS,
  initializeLedgers,
  readAllLedgerIncrements,
} from './lib/durable-ledger.mjs';

function eventValue({ kind, sequence, runRevision, previousDigest }) {
  return {
    sequence,
    runRevision,
    previousDigest,
    occurredAt: new Date(Date.parse('2026-08-30T12:00:00.000Z') + runRevision).toISOString(),
    type: `test-${kind}-${sequence}`,
    stateSnapshot: { runRevision },
  };
}

const raceRoot = await mkdtemp(join(tmpdir(), 'durable-ledger-stable-snapshot-'));
try {
  const writer = await openAtomicStorage({ root: raceRoot, verify: false });
  const runDirectory = join(raceRoot, 'run-race');
  await initializeLedgers(writer, runDirectory);
  await appendLedgerEvent(writer, runDirectory, 'mutation', eventValue({
    kind: 'mutation', sequence: 1, runRevision: 1, previousDigest: null,
  }));

  let injected = false;
  const racingFilesystem = new Proxy(nativeFilesystem, {
    get(target, property) {
      if (property !== 'readFile') return Reflect.get(target, property);
      return async (candidate, ...args) => {
        if (!injected && String(candidate).endsWith(`${sep}mutation${sep}000000000001.json`)) {
          injected = true;
          await appendLedgerEvent(writer, runDirectory, 'operation', eventValue({
            kind: 'operation', sequence: 1, runRevision: 2, previousDigest: null,
          }));
        }
        return nativeFilesystem.readFile(candidate, ...args);
      };
    },
  });
  const reader = await openAtomicStorage({ root: raceRoot, filesystem: racingFilesystem, verify: false });
  const recovered = await readAllLedgerIncrements(reader, runDirectory);
  assert.equal(injected, true, 'fixture must append while the unlocked ledger snapshot is being sampled');
  assert.deepEqual(
    Object.values(recovered.ledgers).flat().map(({ runRevision }) => runRevision).sort((a, b) => a - b),
    [1, 2],
    'a concurrent valid append must be included after retry rather than exposing a torn revision vector',
  );
} finally {
  await rm(raceRoot, { recursive: true, force: true });
}

const afterVectorRoot = await mkdtemp(join(tmpdir(), 'durable-ledger-after-vector-'));
try {
  const writer = await openAtomicStorage({ root: afterVectorRoot, verify: false });
  const runDirectory = join(afterVectorRoot, 'run-after-vector');
  await initializeLedgers(writer, runDirectory);
  await appendLedgerEvent(writer, runDirectory, 'mutation', eventValue({
    kind: 'mutation', sequence: 1, runRevision: 1, previousDigest: null,
  }));
  const cold = await readAllLedgerIncrements(writer, runDirectory);

  let releaseRiskSample;
  const riskMayContinue = new Promise((resolve) => { releaseRiskSample = resolve; });
  let decisionDirectorySamples = 0;
  let riskDirectorySamples = 0;
  let injected = false;
  const racingFilesystem = new Proxy(nativeFilesystem, {
    get(target, property) {
      if (property !== 'lstat') return Reflect.get(target, property);
      return async (candidate, ...args) => {
        const candidateText = String(candidate);
        if (!injected && candidateText.endsWith(`${sep}ledgers${sep}risk`)) {
          riskDirectorySamples += 1;
          if (riskDirectorySamples === 5) await riskMayContinue;
        }
        const metadata = await nativeFilesystem.lstat(candidate, ...args);
        if (!injected && candidateText.endsWith(`${sep}ledgers${sep}decision`)) {
          decisionDirectorySamples += 1;
          if (decisionDirectorySamples === 5) {
            await appendLedgerEvent(writer, runDirectory, 'decision', eventValue({
              kind: 'decision', sequence: 1, runRevision: 2, previousDigest: null,
            }));
            injected = true;
            releaseRiskSample();
          }
        }
        return metadata;
      };
    },
  });
  const reader = await openAtomicStorage({ root: afterVectorRoot, filesystem: racingFilesystem, verify: false });
  const recovered = await readAllLedgerIncrements(reader, runDirectory, cold.checkpoints);
  assert.equal(injected, true, 'fixture must append between two members of the unlocked after vector');
  assert.deepEqual(
    Object.values(recovered.ledgers).flat().map(({ runRevision }) => runRevision).sort((a, b) => a - b),
    [2],
    'a cross-ledger after vector must be confirmed after every first-pass member has settled',
  );
} finally {
  await rm(afterVectorRoot, { recursive: true, force: true });
}

const warmRoot = await mkdtemp(join(tmpdir(), 'durable-ledger-warm-head-'));
try {
  const writer = await openAtomicStorage({ root: warmRoot, verify: false });
  const runDirectory = join(warmRoot, 'run-warm');
  await initializeLedgers(writer, runDirectory);
  let previousDigest = null;
  const eventCount = 32;
  for (let sequence = 1; sequence <= eventCount; sequence += 1) {
    const event = await appendLedgerEvent(writer, runDirectory, 'mutation', eventValue({
      kind: 'mutation', sequence, runRevision: sequence, previousDigest,
    }));
    previousDigest = event.digest;
  }
  const cold = await readAllLedgerIncrements(writer, runDirectory);
  assert.equal(cold.ledgers.mutation.length, eventCount, 'cold recovery must validate the complete ledger');

  let historicalEventStats = 0;
  let ledgerDirectoryReads = 0;
  let ledgerDirectoryEntriesRead = 0;
  const countingFilesystem = new Proxy(nativeFilesystem, {
    get(target, property) {
      if (property === 'readdir') {
        return async (candidate, ...args) => {
          const entries = await nativeFilesystem.readdir(candidate, ...args);
          if (String(candidate).includes(`${sep}ledgers${sep}`)) {
            ledgerDirectoryReads += 1;
            ledgerDirectoryEntriesRead += entries.length;
          }
          return entries;
        };
      }
      if (property !== 'lstat') return Reflect.get(target, property);
      return async (candidate, ...args) => {
        if (String(candidate).includes(`${sep}ledgers${sep}`) && /\d{12}\.json$/u.test(String(candidate))) {
          historicalEventStats += 1;
        }
        return nativeFilesystem.lstat(candidate, ...args);
      };
    },
  });
  const reader = await openAtomicStorage({ root: warmRoot, filesystem: countingFilesystem, verify: false });
  const warm = await readAllLedgerIncrements(reader, runDirectory, cold.checkpoints);
  assert.equal(Object.values(warm.ledgers).flat().length, 0, 'unchanged warm recovery has no suffix');
  assert.equal(
    historicalEventStats,
    eventCount * 3,
    'unchanged warm recovery must authenticate every cached event across the three stable vectors',
  );
  assert.equal(ledgerDirectoryReads, LEDGER_KINDS.length * 3, 'warm recovery samples three finite ledger vectors');
  assert.equal(
    ledgerDirectoryEntriesRead,
    eventCount * 3,
    'warm recovery enumerates each finite prefix name vector while avoiding historical body reads',
  );

  await appendLedgerEvent(writer, runDirectory, 'mutation', eventValue({
    kind: 'mutation', sequence: eventCount + 1, runRevision: eventCount + 1, previousDigest,
  }));
  historicalEventStats = 0;
  ledgerDirectoryReads = 0;
  ledgerDirectoryEntriesRead = 0;
  const suffix = await readAllLedgerIncrements(reader, runDirectory, cold.checkpoints);
  assert.equal(suffix.ledgers.mutation.length, 1, 'warm recovery must validate a newly appended suffix');
  assert.equal(suffix.checkpoints.mutation.count, eventCount + 1);
  assert.equal(ledgerDirectoryReads, LEDGER_KINDS.length * 3, 'suffix recovery samples three finite ledger vectors');
  assert.equal(historicalEventStats, (eventCount * 3) + 5, 'suffix recovery authenticates the prefix plus one new event');
  assert.equal(ledgerDirectoryEntriesRead, (eventCount + 1) * 3, 'suffix recovery uses a finite complete name vector');

  const headPath = join(runDirectory, 'ledgers', 'mutation', '000000000033.json');
  await writeFile(headPath, '{}\n');
  await assert.rejects(
    () => readAllLedgerIncrements(reader, runDirectory, suffix.checkpoints),
    ({ code }) => code === 'LEDGER_CORRUPT',
    'a replaced warm checkpoint head must fail closed',
  );
} finally {
  await rm(warmRoot, { recursive: true, force: true });
}
const prefixRoot = await mkdtemp(join(tmpdir(), 'durable-ledger-prefix-integrity-'));
try {
  const storage = await openAtomicStorage({ root: prefixRoot, verify: false });
  const runDirectory = join(prefixRoot, 'run-prefix');
  await initializeLedgers(storage, runDirectory);
  let previousDigest = null;
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    const event = await appendLedgerEvent(storage, runDirectory, 'mutation', eventValue({
      kind: 'mutation', sequence, runRevision: sequence, previousDigest,
    }));
    previousDigest = event.digest;
  }
  const checkpoint = await readAllLedgerIncrements(storage, runDirectory);
  const firstPath = join(runDirectory, 'ledgers', 'mutation', '000000000001.json');
  const headPath = join(runDirectory, 'ledgers', 'mutation', '000000000003.json');
  const originalFirst = await readFile(firstPath, 'utf8');
  const originalHead = await readFile(headPath, 'utf8');
  const tamperedFirst = originalFirst.replace('test-mutation-1', 'bad!-mutation-1');
  assert.equal(tamperedFirst.length, originalFirst.length, 'fixture mutates event 1 in place without changing its size');
  await writeFile(firstPath, tamperedFirst);
  const changedAt = new Date(Date.parse('2026-08-30T13:00:00.000Z'));
  await utimes(firstPath, changedAt, changedAt);
  assert.equal(await readFile(headPath, 'utf8'), originalHead, 'fixture must leave the cached ledger head intact');
  await assert.rejects(
    () => readAllLedgerIncrements(storage, runDirectory, checkpoint.checkpoints),
    ({ code }) => code === 'LEDGER_CORRUPT',
    'warm recovery must authenticate every cached prefix event, not only its head',
  );
} finally {
  await rm(prefixRoot, { recursive: true, force: true });
}


const sequenceRoot = await mkdtemp(join(tmpdir(), 'durable-ledger-sequence-integrity-'));
try {
  const storage = await openAtomicStorage({ root: sequenceRoot, verify: false });
  const runDirectory = join(sequenceRoot, 'run-sequence');
  await initializeLedgers(storage, runDirectory);
  const first = await appendLedgerEvent(storage, runDirectory, 'risk', eventValue({
    kind: 'risk', sequence: 1, runRevision: 1, previousDigest: null,
  }));
  const cold = await readAllLedgerIncrements(storage, runDirectory);
  const firstPath = join(runDirectory, 'ledgers', 'risk', '000000000001.json');
  const savedPath = join(sequenceRoot, 'saved-first-event.json');
  await rename(firstPath, savedPath);
  await assert.rejects(
    () => readAllLedgerIncrements(storage, runDirectory, cold.checkpoints),
    ({ code }) => code === 'LEDGER_CORRUPT',
    'warm recovery must reject truncation below a verified count',
  );
  await rename(savedPath, firstPath);
  const second = await appendLedgerEvent(storage, runDirectory, 'risk', eventValue({
    kind: 'risk', sequence: 2, runRevision: 2, previousDigest: first.digest,
  }));
  await appendLedgerEvent(storage, runDirectory, 'risk', eventValue({
    kind: 'risk', sequence: 4, runRevision: 3, previousDigest: second.digest,
  }));
  await assert.rejects(
    () => readAllLedgerIncrements(storage, runDirectory, cold.checkpoints),
    ({ code }) => code === 'LEDGER_CORRUPT',
    'warm recovery must reject a finite suffix vector containing 2 and 4 with 3 missing',
  );
  await unlink(join(runDirectory, 'ledgers', 'risk', '000000000002.json'));
  await unlink(join(runDirectory, 'ledgers', 'risk', '000000000004.json'));
} finally {
  await rm(sequenceRoot, { recursive: true, force: true });
}

const unstableRoot = await mkdtemp(join(tmpdir(), 'durable-ledger-bounded-retry-'));
try {
  const writer = await openAtomicStorage({ root: unstableRoot, verify: false });
  const runDirectory = join(unstableRoot, 'run-unstable');
  await initializeLedgers(writer, runDirectory);
  await appendLedgerEvent(writer, runDirectory, 'decision', eventValue({
    kind: 'decision', sequence: 1, runRevision: 1, previousDigest: null,
  }));
  let sample = 0;
  const unstableFilesystem = new Proxy(nativeFilesystem, {
    get(target, property) {
      if (property !== 'lstat') return Reflect.get(target, property);
      return async (candidate, ...args) => {
        const metadata = await nativeFilesystem.lstat(candidate, ...args);
        if (!String(candidate).endsWith(join('ledgers', 'decision'))) return metadata;
        sample += 1;
        return new Proxy(metadata, {
          get(stat, field) {
            if (field === 'mtimeMs') return stat.mtimeMs + sample;
            const value = Reflect.get(stat, field);
            return typeof value === 'function' ? value.bind(stat) : value;
          },
        });
      };
    },
  });
  const reader = await openAtomicStorage({ root: unstableRoot, filesystem: unstableFilesystem, verify: false });
  await assert.rejects(
    () => readAllLedgerIncrements(reader, runDirectory),
    ({ code }) => code === 'LEDGER_SNAPSHOT_UNSTABLE',
    'continuously changing directory samples must stop after the bounded retry budget',
  );
  assert.equal(sample, 25, 'bounded snapshot retry must not spin indefinitely');
} finally {
  await rm(unstableRoot, { recursive: true, force: true });
}

console.log('durable ledger self-test passed');
