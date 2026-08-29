export interface InventoryCompilationFailure {
  schemaVersion: 1;
  kind: 'inventory-compilation-failure';
  subjectCoreDigest: string;
  workItemId: string;
  terminalResultDigest: string;
  reason: string;
  attemptCount: number;
  failedAt: string;
  digest: string;
}
export function sealInventoryCompilationFailure(value: unknown): InventoryCompilationFailure;
export function parseInventoryCompilationFailure(value: unknown): InventoryCompilationFailure;
