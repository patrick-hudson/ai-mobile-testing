export interface ConsoleOverviewOptions {
  now?: string | number | Date;
  riskLimit?: number;
  activeLimit?: number;
}

export interface ConsoleOverviewInput {
  mode?: 'all' | 'comparative' | 'single-site';
  scopeKey?: string;
  runs?: readonly unknown[];
  attention?: readonly unknown[];
  statistics?: readonly unknown[];
  sourceVectorRevision?: string | null;
  limitations?: readonly string[];
}

export const CONSOLE_OVERVIEW_LIMITS: Readonly<{
  maximumProductRisk: 50;
  maximumActiveRuns: 20;
  maximumStatistics: 6;
  maximumRunsPage: 100;
}>;
export function buildConsoleOverview(input?: ConsoleOverviewInput, options?: ConsoleOverviewOptions): Readonly<Record<string, unknown>>;
export function buildConsoleRunsPage(runs: readonly unknown[], options?: {
  mode?: 'all' | 'comparative' | 'single-site';
  scopeKey?: string;
  sort?: 'recent' | 'duration';
  limit?: number;
  offset?: number;
}): Readonly<Record<string, unknown>>;
