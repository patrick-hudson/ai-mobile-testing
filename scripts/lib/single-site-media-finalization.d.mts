export interface SingleSiteMediaStageManifest {
  schemaVersion: 1;
  kind: 'single-site-media-stage';
  mode: 'single-site';
  jobId: string;
  attemptId: string;
  finalizationDigest: string;
  generatedAt: string;
  revision: string;
  processorDigest: string;
  sourceResultsDigest: string;
  sourceResultsBytes: number;
  processedResultsDigest: string;
  processedResultsBytes: number;
  videoManifestDigest: string;
  qualityState: 'complete' | 'incomplete';
  integrityErrors: string[];
  mediaStageDigest: string;
  [key: string]: unknown;
}

export function runLoggedCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  logger?: { emit(event: string, detail?: Record<string, unknown>): void };
  label: string;
  maximumLogBytes?: number;
  signal?: AbortSignal;
  deadlineAt?: number | Date;
  terminationGraceMs?: number;
  killSettleMs?: number;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  spawnError: string | null;
  aborted: boolean;
  forceKilled: boolean;
  terminationReason: string | null;
  unresponsive: boolean;
}>;

export function publishSingleSiteMediaStage(options: {
  artifactRoot: string;
  sourceResults: unknown;
  sourceResultsBytes: Uint8Array;
  sourceResultsDigest: string;
  outputDir: string;
  jobId: string;
  attemptId: string;
  finalizationDigest: string;
  generatedAt: string;
  logger?: { emit(event: string, detail?: Record<string, unknown>): void };
  signal?: AbortSignal;
  deadlineAt?: number | Date;
  dependencies?: Record<string, unknown>;
}): Promise<{
  manifest: SingleSiteMediaStageManifest;
  results: unknown;
  resultsBytes: Uint8Array;
  artifactRoot: string;
  videoManifest: unknown;
  created: boolean;
}>;

export function publishUnavailableSingleSiteMediaStage(options: {
  outputDir: string;
  jobId: string;
  attemptId: string;
  finalizationDigest: string;
  generatedAt: string;
  reason: string;
  logger?: { emit(event: string, detail?: Record<string, unknown>): void };
}): Promise<{ manifest: SingleSiteMediaStageManifest; results: null; resultsBytes: null; artifactRoot: null; created: boolean }>;

export function readSingleSiteMediaStagePublication(options: {
  outputDir: string;
  jobId: string;
  attemptId: string;
  finalizationDigest: string;
  mediaStageDigest: string;
}): Promise<{
  manifest: SingleSiteMediaStageManifest;
  results: unknown | null;
  resultsBytes: Uint8Array | null;
  artifactRoot: string | null;
  videoManifest: unknown | null;
  pointer: Readonly<Record<string, unknown>>;
}>;
