import type { AtomicStorage } from './atomic-filesystem.mjs';
export const LEDGER_KINDS: readonly ['decision', 'risk', 'mutation', 'operation'];
export class DurableLedgerError extends Error { code: string; details?: unknown }
export interface DurableLedgerEvent {
  schemaVersion: 1; kind: string; sequence: number; runRevision: number; previousDigest: string | null;
  occurredAt: string; type: string; actor: unknown; data: unknown; stateSnapshot: any; digest: string;
}
export function initializeLedgers(storage: AtomicStorage, runDirectory: string): Promise<void>;
export function appendLedgerEvent(storage: AtomicStorage, runDirectory: string, kind: string, value: any): Promise<DurableLedgerEvent>;
export function readLedger(storage: AtomicStorage, runDirectory: string, kind: string): Promise<DurableLedgerEvent[]>;
export function readAllLedgers(storage: AtomicStorage, runDirectory: string): Promise<Record<string, DurableLedgerEvent[]>>;
