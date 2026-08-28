import type { ConsoleAuthorityRecord, ConsoleReadLimitationCode } from './console-read-ports.mjs';
import type { ConsoleContextId } from './console-contracts.mjs';

export type ConsoleAuditMode = 'comparative' | 'single-site';
export type ConsoleCompleteness = 'complete' | 'partial' | 'unknown' | 'unavailable';
export type ConsoleFreshness = 'current' | 'stale' | 'unknown';
export type ConsoleFieldAvailability = 'available' | 'unknown' | 'unavailable';

export interface ConsoleDisplayField<T = string | boolean> {
  raw: T | null;
  label: string;
  availability: ConsoleFieldAvailability;
}

export interface ConsoleRunIdentityModel {
  mode: ConsoleAuditMode;
  runId: string;
  key: string;
}

export interface ConsoleViewModelOptions {
  contextId?: ConsoleContextId;
  completeness?: ConsoleCompleteness;
  freshness?: ConsoleFreshness;
  limitations?: readonly (ConsoleReadLimitationCode | string)[];
}

export interface ConsoleViewLimitation {
  code: string;
  field: string;
}

export interface ConsoleNormalizedScope {
  deployment: {
    kind: 'origin-pair' | 'deployment-environment';
    productionOrigin: string | null;
    candidateOrigin: string | null;
    origin: string | null;
    role: ConsoleDisplayField;
  };
  profile: ConsoleDisplayField;
  qualifier: ConsoleDisplayField;
  filters: {
    pluginIds: readonly string[];
    auditIds: readonly string[];
    areas: readonly string[];
  };
  targetIds: readonly string[];
  comparability: {
    deploymentKey: string | null;
    profileKey: string | null;
    scopeKey: string;
    targetSetKey: string | null;
    complete: boolean;
  };
}

export interface ConsoleNormalizedRun {
  schemaVersion: 1;
  mode: ConsoleAuditMode;
  identity: ConsoleRunIdentityModel;
  context: {
    id: ConsoleContextId;
    runtime: 'live' | 'sealed-archive';
  };
  title: string;
  source: {
    type: string;
    identity: string;
    revision: string | null;
    updatedAt: string | null;
    completeness: ConsoleCompleteness;
    freshness: ConsoleFreshness;
  };
  lifecycle: {
    execution: ConsoleDisplayField;
    activity: ConsoleDisplayField;
    phase: ConsoleDisplayField;
    terminal: boolean | null;
  };
  authority: {
    outcome: ConsoleDisplayField;
    coverage: ConsoleDisplayField;
    evidence: ConsoleDisplayField;
    pipeline: ConsoleDisplayField;
    finalization: ConsoleDisplayField;
  };
  scope: ConsoleNormalizedScope;
  timestamps: {
    createdAt: string | null;
    startedAt: string | null;
    updatedAt: string | null;
    finishedAt: string | null;
  };
  progress: Readonly<Record<string, number | null>>;
  destinations: {
    workspace: string;
    report: string | null;
    gallery: string | null;
    checklist: string | null;
    sourceReport: string | null;
    artifacts: string | null;
  };
  limitations: readonly ConsoleViewLimitation[];
}

export function consoleRunIdentityKey(identity: { mode: ConsoleAuditMode; runId: string }): string;
export function normalizeConsoleAuthorityRecord(
  record: ConsoleAuthorityRecord,
  options?: ConsoleViewModelOptions,
): ConsoleNormalizedRun;
export function normalizeComparativeConsoleRecord(
  record: ConsoleAuthorityRecord & { mode: 'comparative' },
  options?: ConsoleViewModelOptions,
): ConsoleNormalizedRun & { mode: 'comparative' };
export function normalizeSingleSiteConsoleRecord(
  record: ConsoleAuthorityRecord & { mode: 'single-site' },
  options?: ConsoleViewModelOptions,
): ConsoleNormalizedRun & { mode: 'single-site' };
