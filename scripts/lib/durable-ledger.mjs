import path from 'node:path';
import { canonicalDigest } from '../../shared/canonical-contract.mjs';
import { atomicWriteJson, ensureDirectory, pathExists, readBoundedJson } from './atomic-filesystem.mjs';

export const LEDGER_KINDS = Object.freeze(['decision', 'risk', 'mutation', 'operation']);

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
  if (!LEDGER_KINDS.includes(kind)) throw new DurableLedgerError('LEDGER_KIND_INVALID', `Unsupported ledger kind ${kind}.`);
  const directory = path.join(runDirectory, 'ledgers', kind);
  await ensureDirectory(storage.fs, directory);
  const names = (await storage.fs.readdir(directory)).filter((name) => /^\d{12}\.json$/.test(name)).sort();
  const events = [];
  let previousDigest = null;
  for (let index = 0; index < names.length; index += 1) {
    const expectedName = `${String(index + 1).padStart(12, '0')}.json`;
    if (names[index] !== expectedName) fail(`${kind} history has a missing or duplicate sequence.`);
    let event;
    try {
      event = await readBoundedJson(storage, path.join(directory, names[index]), { label: `${kind} history event` });
    } catch (error) {
      fail(`${kind} history event is unreadable.`, { cause: error?.code ?? error?.message });
    }
    const { digest, ...body } = event;
    if (event.schemaVersion !== 1 || event.kind !== `${kind}-history-event`
      || event.sequence !== index + 1 || event.previousDigest !== previousDigest
      || digest !== canonicalDigest(body)) {
      fail(`${kind} history failed digest-chain validation at sequence ${index + 1}.`);
    }
    previousDigest = digest;
    events.push(event);
  }
  return events;
}

export async function readAllLedgers(storage, runDirectory) {
  const output = {};
  for (const kind of LEDGER_KINDS) output[kind] = await readLedger(storage, runDirectory, kind);
  return output;
}

export async function ledgerEventExists(storage, runDirectory, kind, sequence) {
  return pathExists(storage.fs, eventPath(path.join(runDirectory, 'ledgers', kind), sequence));
}
