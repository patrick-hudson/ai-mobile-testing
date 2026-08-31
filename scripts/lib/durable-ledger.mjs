import path from 'node:path';
import { canonicalDigest } from '../../shared/canonical-contract.mjs';
import { atomicWriteJson, ensureDirectory, pathExists, readBoundedJson } from './atomic-filesystem.mjs';

export const LEDGER_KINDS = Object.freeze(['decision', 'risk', 'mutation', 'operation']);
const MAX_STABLE_SNAPSHOT_ATTEMPTS = 8;
const MAX_LEDGER_EVENTS = 1_000_000;

export class DurableLedgerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DurableLedgerError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, details) {
  throw new DurableLedgerError('LEDGER_CORRUPT', message, details);
}

function eventPath(directory, sequence) {
  return path.join(directory, `${String(sequence).padStart(12, '0')}.json`);
}

function eventFingerprint(metadata, kind, sequence) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${kind} history event ${sequence} is not an immutable regular file.`);
  }
  return Object.freeze({
    device: String(metadata.dev),
    inode: String(metadata.ino),
    size: String(metadata.size),
    modified: String(metadata.mtimeMs),
    changed: String(metadata.ctimeMs),
  });
}

function directoryFingerprint(metadata, kind) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${kind} history must be a real directory.`);
  }
  return Object.freeze({
    device: String(metadata.dev),
    inode: String(metadata.ino),
    size: String(metadata.size),
    modified: String(metadata.mtimeMs),
    changed: String(metadata.ctimeMs),
  });
}

function fingerprintsMatch(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modified === right.modified
    && left.changed === right.changed;
}

function validFingerprint(value) {
  return typeof value === 'object' && value !== null
    && ['device', 'inode', 'size', 'modified', 'changed']
      .every((field) => typeof value[field] === 'string');
}

function fingerprintVectorsMatch(left, right) {
  return left.length === right.length
    && left.every((fingerprint, index) => fingerprintsMatch(fingerprint, right[index]));
}

async function eventFingerprintAt(storage, directory, kind, sequence) {
  try {
    return eventFingerprint(await storage.fs.lstat(eventPath(directory, sequence)), kind, sequence);
  } catch (error) {
    if (error instanceof DurableLedgerError) throw error;
    fail(`${kind} history event ${sequence} metadata is unreadable.`, { cause: error?.code ?? error?.message });
  }
}

async function ledgerNames(storage, directory, kind) {
  await ensureDirectory(storage.fs, directory);
  const names = (await storage.fs.readdir(directory)).filter((name) => /^\d{12}\.json$/.test(name)).sort();
  if (names.length > MAX_LEDGER_EVENTS) {
    fail(`${kind} history exceeds its ${MAX_LEDGER_EVENTS}-event recovery bound.`);
  }
  for (let index = 0; index < names.length; index += 1) {
    const expectedName = `${String(index + 1).padStart(12, '0')}.json`;
    if (names[index] !== expectedName) fail(`${kind} history has a missing or duplicate sequence.`);
  }
  return names;
}

async function ledgerSnapshot(storage, runDirectory, kind, checkpoint = null) {
  const directory = path.join(runDirectory, 'ledgers', kind);
  await ensureDirectory(storage.fs, directory);
  for (let attempt = 1; attempt <= MAX_STABLE_SNAPSHOT_ATTEMPTS; attempt += 1) {
    let directoryBefore;
    try {
      directoryBefore = directoryFingerprint(await storage.fs.lstat(directory), kind);
    } catch (error) {
      if (error instanceof DurableLedgerError) throw error;
      fail(`${kind} history directory metadata is unreadable.`, { cause: error?.code ?? error?.message });
    }
    const names = await ledgerNames(storage, directory, kind);
    if (checkpoint !== null && names.length < checkpoint.count) {
      fail(`${kind} history lost a previously validated event.`);
    }
    const prefixFingerprints = [];
    if (checkpoint !== null) {
      for (let index = 0; index < checkpoint.count; index += 1) {
        const observed = await eventFingerprintAt(storage, directory, kind, index + 1);
        if (!fingerprintsMatch(observed, checkpoint.prefixFingerprints[index])) {
          fail(`${kind} history cached prefix event ${index + 1} changed after validation.`);
        }
        prefixFingerprints.push(observed);
      }
    }
    let headFingerprint = prefixFingerprints.length === names.length
      ? prefixFingerprints.at(-1) ?? null
      : null;
    if (names.length > 0 && headFingerprint === null) {
      headFingerprint = await eventFingerprintAt(storage, directory, kind, names.length);
    }
    const directoryAfter = directoryFingerprint(await storage.fs.lstat(directory), kind);
    if (fingerprintsMatch(directoryBefore, directoryAfter)) {
      return Object.freeze({
        kind,
        directory,
        names: Object.freeze(names),
        count: names.length,
        headFingerprint,
        prefixFingerprints: Object.freeze(prefixFingerprints),
        directoryFingerprint: directoryAfter,
      });
    }
  }
  throw new DurableLedgerError(
    'LEDGER_SNAPSHOT_UNSTABLE',
    `${kind} history changed during ${MAX_STABLE_SNAPSHOT_ATTEMPTS} consecutive finite snapshots.`,
  );
}

async function sampleLedgerVector(storage, runDirectory, checkpoints = null) {
  const entries = await Promise.all(LEDGER_KINDS.map(async (kind) => [
    kind,
    await ledgerSnapshot(storage, runDirectory, kind, checkpoints?.[kind] ?? null),
  ]));
  return Object.freeze(Object.fromEntries(entries));
}

async function readValidatedEvent(storage, file, kind, sequence, previousDigest) {
  let event;
  try {
    event = await readBoundedJson(storage, file, { label: `${kind} history event` });
  } catch (error) {
    fail(`${kind} history event is unreadable.`, { cause: error?.code ?? error?.message });
  }
  const { digest, ...body } = event;
  if (event.schemaVersion !== 1 || event.kind !== `${kind}-history-event`
    || event.sequence !== sequence || event.previousDigest !== previousDigest
    || digest !== canonicalDigest(body)) {
    fail(`${kind} history failed digest-chain validation at sequence ${sequence}.`);
  }
  return event;
}

function validateCheckpoint(checkpoint, kind) {
  if (checkpoint === null) return;
  if (checkpoint?.kind !== kind || !Number.isSafeInteger(checkpoint.count) || checkpoint.count < 0
    || checkpoint.count > MAX_LEDGER_EVENTS
    || (checkpoint.headDigest !== null && !/^sha256:[a-f0-9]{64}$/.test(checkpoint.headDigest))
    || (checkpoint.count === 0) !== (checkpoint.headDigest === null)
    || (checkpoint.count === 0) !== (checkpoint.headFingerprint === null)
    || !validFingerprint(checkpoint.directoryFingerprint)
    || !Array.isArray(checkpoint.prefixFingerprints)
    || checkpoint.prefixFingerprints.length !== checkpoint.count
    || !checkpoint.prefixFingerprints.every(validFingerprint)
    || (checkpoint.headFingerprint !== null && !validFingerprint(checkpoint.headFingerprint))
    || (checkpoint.count > 0
      && !fingerprintsMatch(checkpoint.headFingerprint, checkpoint.prefixFingerprints.at(-1)))) {
    fail(`${kind} history recovery checkpoint is invalid.`);
  }
}

function checkpointMatchesSnapshot(checkpoint, snapshot) {
  return checkpoint.count === snapshot.count
    && fingerprintsMatch(checkpoint.directoryFingerprint, snapshot.directoryFingerprint)
    && fingerprintVectorsMatch(checkpoint.prefixFingerprints, snapshot.prefixFingerprints)
    && (checkpoint.headFingerprint === null
      ? snapshot.headFingerprint === null
      : snapshot.headFingerprint !== null
        && fingerprintsMatch(checkpoint.headFingerprint, snapshot.headFingerprint));
}

function checkpointVectorMatchesSnapshots(checkpoints, snapshots) {
  return LEDGER_KINDS.every((kind) => checkpointMatchesSnapshot(checkpoints[kind], snapshots[kind]));
}

async function readLedgerIncrementFromSnapshot(storage, kind, checkpoint, snapshot) {
  const { directory, names } = snapshot;
  const priorCount = checkpoint?.count ?? 0;
  if (snapshot.count < priorCount) fail(`${kind} history lost a previously validated event.`);
  if (checkpoint !== null
    && !fingerprintVectorsMatch(checkpoint.prefixFingerprints, snapshot.prefixFingerprints)) {
    fail(`${kind} history cached prefix changed after validation.`);
  }

  const events = [];
  let previousDigest = checkpoint?.headDigest ?? null;
  const prefixFingerprints = [...(checkpoint?.prefixFingerprints ?? [])];
  for (let index = priorCount; index < snapshot.count; index += 1) {
    const sequence = index + 1;
    const file = path.join(directory, names[index]);
    const fingerprint = await eventFingerprintAt(storage, directory, kind, sequence);
    const event = await readValidatedEvent(storage, file, kind, sequence, previousDigest);
    previousDigest = event.digest;
    events.push(event);
    prefixFingerprints.push(fingerprint);
  }
  const finalDirectoryFingerprint = directoryFingerprint(await storage.fs.lstat(directory), kind);
  const headFingerprint = prefixFingerprints.at(-1) ?? null;
  return Object.freeze({
    events,
    checkpoint: Object.freeze({
      kind,
      count: snapshot.count,
      headDigest: previousDigest,
      headFingerprint,
      prefixFingerprints: Object.freeze(prefixFingerprints),
      directoryFingerprint: finalDirectoryFingerprint,
    }),
  });
}

/**
 * Validate the complete digest chain on a cold read. A warm read authenticates
 * every cached prefix event by metadata without rereading historical bodies,
 * snapshots one finite contiguous name vector, and validates every appended
 * suffix body. Reopening or evicting the process cache forces complete body
 * validation; durable authority always remains the event chain.
 */
export async function readLedgerIncrement(storage, runDirectory, kind, checkpoint = null) {
  if (!LEDGER_KINDS.includes(kind)) throw new DurableLedgerError('LEDGER_KIND_INVALID', `Unsupported ledger kind ${kind}.`);
  validateCheckpoint(checkpoint, kind);
  for (let attempt = 1; attempt <= MAX_STABLE_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await ledgerSnapshot(storage, runDirectory, kind, checkpoint);
    const result = await readLedgerIncrementFromSnapshot(storage, kind, checkpoint, before);
    const after = await ledgerSnapshot(storage, runDirectory, kind, result.checkpoint);
    if (checkpointMatchesSnapshot(result.checkpoint, after)) return result;
  }
  throw new DurableLedgerError(
    'LEDGER_SNAPSHOT_UNSTABLE',
    `${kind} history changed during ${MAX_STABLE_SNAPSHOT_ATTEMPTS} consecutive recovery snapshots.`,
  );
}

export async function readAllLedgerIncrements(storage, runDirectory, checkpoints = null) {
  for (const kind of LEDGER_KINDS) validateCheckpoint(checkpoints?.[kind] ?? null, kind);
  for (let attempt = 1; attempt <= MAX_STABLE_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await sampleLedgerVector(storage, runDirectory, checkpoints);
    const entries = await Promise.all(LEDGER_KINDS.map(async (kind) => [
      kind,
      await readLedgerIncrementFromSnapshot(storage, kind, checkpoints?.[kind] ?? null, before[kind]),
    ]));
    const resultCheckpoints = Object.fromEntries(entries.map(([kind, result]) => [kind, result.checkpoint]));
    const after = await sampleLedgerVector(storage, runDirectory, resultCheckpoints);
    if (!checkpointVectorMatchesSnapshots(resultCheckpoints, after)) continue;
    const confirmedAfter = await sampleLedgerVector(storage, runDirectory, resultCheckpoints);
    if (checkpointVectorMatchesSnapshots(resultCheckpoints, confirmedAfter)) {
      return Object.freeze({
        ledgers: Object.fromEntries(entries.map(([kind, result]) => [kind, result.events])),
        checkpoints: resultCheckpoints,
      });
    }
  }
  throw new DurableLedgerError(
    'LEDGER_SNAPSHOT_UNSTABLE',
    `Ledger histories changed during ${MAX_STABLE_SNAPSHOT_ATTEMPTS} consecutive recovery snapshots.`,
  );
}

export async function initializeLedgers(storage, runDirectory) {
  for (const kind of LEDGER_KINDS) await ensureDirectory(storage.fs, path.join(runDirectory, 'ledgers', kind));
}

export async function appendLedgerEvent(storage, runDirectory, kind, value) {
  if (!LEDGER_KINDS.includes(kind)) throw new DurableLedgerError('LEDGER_KIND_INVALID', `Unsupported ledger kind ${kind}.`);
  if (!Number.isSafeInteger(value?.sequence) || value.sequence < 1
    || !Number.isSafeInteger(value.runRevision) || value.runRevision < 1
    || (value.previousDigest !== null && !/^sha256:[a-f0-9]{64}$/.test(value.previousDigest))
    || typeof value.type !== 'string' || value.type.length === 0
    || typeof value.occurredAt !== 'string' || new Date(value.occurredAt).toISOString() !== value.occurredAt
    || value.stateSnapshot?.runRevision !== value.runRevision) {
    throw new DurableLedgerError('LEDGER_EVENT_INVALID', `Invalid ${kind} history event.`);
  }
  const body = {
    schemaVersion: 1,
    kind: `${kind}-history-event`,
    sequence: value.sequence,
    runRevision: value.runRevision,
    previousDigest: value.previousDigest,
    occurredAt: value.occurredAt,
    type: value.type,
    actor: value.actor ?? null,
    data: value.data ?? null,
    stateSnapshot: value.stateSnapshot,
  };
  const event = { ...body, digest: canonicalDigest(body) };
  await atomicWriteJson(storage, eventPath(path.join(runDirectory, 'ledgers', kind), value.sequence), event, { exclusive: true });
  return event;
}

export async function readLedger(storage, runDirectory, kind) {
  return (await readLedgerIncrement(storage, runDirectory, kind)).events;
}

export async function readAllLedgers(storage, runDirectory) {
  return (await readAllLedgerIncrements(storage, runDirectory)).ledgers;
}

export async function ledgerEventExists(storage, runDirectory, kind, sequence) {
  return pathExists(storage.fs, eventPath(path.join(runDirectory, 'ledgers', kind), sequence));
}
