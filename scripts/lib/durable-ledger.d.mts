import type { AtomicStorage } from './atomic-filesystem.mjs';
export const LEDGER_KINDS: readonly ['decision', 'risk', 'mutation', 'operation'];
export class DurableLedgerError extends Error { code: string; details?: unknown }
export interface DurableLedgerEvent {
  schemaVersion: 1; kind: string; sequence: number; runRevision: number; previousDigest: string | null;
  occurredAt: string; type: string; actor: unknown; data: unknown; stateSnapshot: any; digest: string;
}
export interface DurableLedgerFingerprint {
  device: string; inode: string; size: string; modified: string; changed: string;
}
export interface DurableLedgerCheckpoint {
  kind: string; count: number; headDigest: string | null;
  headFingerprint: DurableLedgerFingerprint | null;
  prefixFingerprints: readonly DurableLedgerFingerprint[];
  directoryFingerprint: DurableLedgerFingerprint;
}
export function initializeLedgers(storage: AtomicStorage, runDirectory: string): Promise<void>;
export function appendLedgerEvent(storage: AtomicStorage, runDirectory: string, kind: string, value: any): Promise<DurableLedgerEvent>;
export function readLedgerIncrement(storage: AtomicStorage, runDirectory: string, kind: string, checkpoint?: DurableLedgerCheckpoint | null): Promise<{ events: DurableLedgerEvent[]; checkpoint: DurableLedgerCheckpoint }>;
export function readAllLedgerIncrements(storage: AtomicStorage, runDirectory: string, checkpoints?: Record<string, DurableLedgerCheckpoint> | null): Promise<{ ledgers: Record<string, DurableLedgerEvent[]>; checkpoints: Record<string, DurableLedgerCheckpoint> }>;
export function readLedger(storage: AtomicStorage, runDirectory: string, kind: string): Promise<DurableLedgerEvent[]>;
export function readAllLedgers(storage: AtomicStorage, runDirectory: string): Promise<Record<string, DurableLedgerEvent[]>>;
