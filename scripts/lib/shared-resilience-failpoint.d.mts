export const SHARED_RESILIENCE_CRASH_BOUNDARIES: readonly [
  'inventory-seal',
  'work-item-adoption',
  'oracle-seal',
  'envelope-fsync',
  'head-swap',
  'mutation-acceptance',
];

export type SharedResilienceCrashBoundary = typeof SHARED_RESILIENCE_CRASH_BOUNDARIES[number];

export class SharedResilienceFailpointError extends Error {
  code: 'SHARED_RESILIENCE_FAILPOINT_DISABLED' | 'SHARED_RESILIENCE_FAILPOINT_INVALID' | 'SHARED_RESILIENCE_FAILPOINT_CORRUPT' | 'SHARED_RESILIENCE_FAILPOINT_MISSING';
}

export interface SharedResilienceCrashSentinel {
  readonly schemaVersion: 1;
  readonly kind: 'shared-resilience-crash-sentinel';
  readonly boundary: SharedResilienceCrashBoundary;
  readonly pid: number;
  readonly armedAt: string;
  readonly digest: string;
}

export function readSharedResilienceCrashSentinel(
  boundary: SharedResilienceCrashBoundary,
  options: { root: string; filesystem?: typeof import('node:fs/promises') },
): Promise<Readonly<SharedResilienceCrashSentinel>>;

export function maybeCrashAtSharedResilienceBoundary(
  boundary: SharedResilienceCrashBoundary,
  options?: {
    environment?: NodeJS.ProcessEnv;
    filesystem?: typeof import('node:fs/promises');
    killProcess?: (pid: number, signal: NodeJS.Signals) => unknown;
    pid?: number;
    clock?: () => number;
  },
): Promise<Readonly<
  | { triggered: false; reason: 'not-configured' | 'different-boundary' }
  | { triggered: false; reason: 'already-triggered'; sentinel: Readonly<Record<string, unknown>> }
  | { triggered: true; sentinel: Readonly<Record<string, unknown>> }
>>;
