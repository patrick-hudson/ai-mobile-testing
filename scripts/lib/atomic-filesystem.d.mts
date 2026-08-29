export interface AtomicStorage {
  root: string;
  fs: typeof import('node:fs/promises');
  nonce(): string;
  semantics: null | { filesystemType: string; atomicMkdir: true; atomicRename: true; fsync: true };
}
export class AtomicFilesystemError extends Error { code: string; details?: unknown }
export function containedPath(root: string, ...parts: string[]): string;
export function pathExists(filesystem: AtomicStorage['fs'], candidate: string): Promise<boolean>;
export function fsyncDirectory(filesystem: AtomicStorage['fs'], directory: string): Promise<void>;
export function ensureDirectory(filesystem: AtomicStorage['fs'], directory: string, options?: { mode?: number }): Promise<void>;
export function atomicWriteJson(storage: AtomicStorage, file: string, value: unknown, options?: { exclusive?: boolean; mode?: number }): Promise<void>;
export function readBoundedJson(storage: AtomicStorage, file: string, options?: { label?: string; maximumBytes?: number }): Promise<any>;
export function withDirectoryLock<T>(storage: AtomicStorage, lockPath: string, operation: () => Promise<T>, options?: { retries?: number; retryMs?: number }): Promise<T>;
export function verifyLocalAtomicStorage(storage: AtomicStorage): Promise<NonNullable<AtomicStorage['semantics']>>;
export function openAtomicStorage(options: { root: string; filesystem?: AtomicStorage['fs']; nonce?: () => string; verify?: boolean }): Promise<AtomicStorage>;
