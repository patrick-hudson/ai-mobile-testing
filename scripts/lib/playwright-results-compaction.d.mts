export interface PlaywrightResultsCompactionLimits {
  maxSourceBytes: number;
  maxCompactBytes: number;
  maxDecodedAttachmentBytes: number;
  maxStructuredSidecarBytes: number;
  maxStructuredSidecarTotalBytes: number;
  maxInlineAttachmentBytes: number;
  maxTests: number;
  maxAttachments: number;
  maxNodes: number;
  maxJsonDepth: number;
}
export const PLAYWRIGHT_RESULTS_COMPACTION_LIMITS: Readonly<PlaywrightResultsCompactionLimits>;
export class PlaywrightResultsCompactionError extends Error { code: string }
export function compactPlaywrightResults(input: {
  artifactRoot: string;
  resultsPath: string;
  limits?: Partial<PlaywrightResultsCompactionLimits>;
}): Promise<Record<string, unknown>>;
export function verifyStructuredEvidenceManifest(value: unknown): boolean;
export function verifyStructuredEvidencePublication(input: {
  artifactRoot: string;
  resultsBytes: Uint8Array | string;
  binding: Record<string, unknown>;
  limits?: Partial<PlaywrightResultsCompactionLimits>;
}): Promise<Record<string, unknown>>;
