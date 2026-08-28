import type { JobQueue, JobExecutionState } from '../scripts/lib/job-queue.mjs';
import type { VisualBaselineStore } from './visual-baselines.mjs';

export class SingleSitePurgeError extends Error {
  code: string;
  details?: unknown;
}

export interface SingleSitePurgeLimits {
  maxEntries?: number;
  maxDirectories?: number;
  maxLogicalBytes?: number;
  maxDepth?: number;
  maxJournalBytes?: number;
  maxRecoveryJournals?: number;
}

export interface SingleSitePurgeResult {
  jobId: string;
  purged: true;
  terminalState: JobExecutionState;
  filesRemoved: number;
  directoriesRemoved: number;
  logicalBytesRemoved: number;
  physicalBytesRemoved: null;
  baselineBytesPreserved: true;
  recovered: boolean;
}

export interface SingleSitePurgeDependencies {
  filesystem?: typeof import('node:fs/promises');
  assertNoNestedMounts?: (filesystem: typeof import('node:fs/promises'), root: string) => Promise<void>;
  removeTree?: (filesystem: typeof import('node:fs/promises'), target: unknown, limits: Required<SingleSitePurgeLimits>) => Promise<void>;
  now?: () => number | Date;
  nonce?: () => string;
  hooks?: { afterQuarantine?: (journal: Readonly<Record<string, unknown>>) => Promise<void> };
}

export interface SingleSitePurgeOptions {
  queue: JobQueue;
  finalizationRoot: string;
  aiReviewRoot?: string;
  baselineStore: VisualBaselineStore;
  jobId: string;
  confirmation: string;
  lockStaleMilliseconds?: number;
  limits?: SingleSitePurgeLimits;
  dependencies?: SingleSitePurgeDependencies;
}

export function singleSitePurgeConfirmation(jobId: string): string;
export function purgeSingleSiteRun(options: SingleSitePurgeOptions): Promise<SingleSitePurgeResult>;
export function recoverSingleSitePurges(options: Omit<SingleSitePurgeOptions, 'jobId' | 'confirmation'>): Promise<readonly Readonly<{
  jobId: string;
  status: 'purged' | 'failed';
  result?: SingleSitePurgeResult;
  code?: string;
  message?: string;
}>[]>;
