export class ContractError extends TypeError {
  readonly code: string;
  constructor(code: string, message: string);
}
export const SHA256_PATTERN: RegExp;
export function failContract(code: string, message: string): never;
export function isRecord(value: unknown): value is Record<string, unknown>;
export function canonicalJson(value: unknown): string;
export function canonicalDigest(value: unknown): string;
export function assertSchemaVersion(value: unknown, label: string): void;
export function assertDigest(value: unknown, label: string): string;
export function nonEmptyString(value: unknown, label: string): string;
export function uniqueStrings(value: unknown, label: string, options?: { nonEmpty?: boolean }): string[];
export function exactKeys(value: unknown, allowed: string[], label: string): void;
export function freezeContract<T>(value: T): Readonly<T>;
