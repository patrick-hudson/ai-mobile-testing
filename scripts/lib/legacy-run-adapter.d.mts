export class LegacyRunAdapterError extends Error { code: string }
export interface LegacyRunView {
  schemaVersion: 1; kind: 'legacy-run-read-adapter'; sourcePath: string; legacyRunId: string | null;
  legacyStatus: string | null; authoritative: false; releaseDecision: null; availability: 'UNAVAILABLE';
  limitations: readonly string[]; source: any;
}
export function readLegacyRun(sourcePath: string, options?: { maximumBytes?: number }): Promise<LegacyRunView>;
