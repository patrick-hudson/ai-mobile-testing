export type ConsoleRouteId =
  | 'overview'
  | 'runs'
  | 'run'
  | 'findings'
  | 'evidence'
  | 'new-audit'
  | 'settings'
  | 'report'
  | 'gallery'
  | 'archive-report'
  | 'archive-gallery';

export type ConsoleRuntime = 'live' | 'sealed-archive';
export type ConsoleContextId = 'comparative-live' | 'single-site-live' | 'sealed-archive';
export type ConsoleStateDomain = 'execution' | 'activity' | 'connection' | 'region';
export type ConsoleAsyncState =
  | 'initial-loading'
  | 'ready'
  | 'refreshing'
  | 'partial'
  | 'empty-success'
  | 'stale'
  | 'retryable-failure'
  | 'unavailable'
  | 'permission-denied'
  | 'reconnecting'
  | 'offline';
export type ConsoleConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'closed';

export interface ConsoleUrlFieldContract {
  type: 'identifier' | 'token' | 'text' | 'enum';
  values?: readonly string[];
  maximum?: number;
  maximumItems?: number;
  multiple?: boolean;
  required?: boolean;
  default?: string;
}

export interface ConsoleRouteContract {
  schemaVersion: 1;
  id: ConsoleRouteId;
  pathname: string;
  surface: string;
  runtime: ConsoleRuntime;
  group: 'operations' | 'creation' | 'configuration' | 'archive';
  compatibility?: 'existing-direct-entry';
  urlState: Readonly<Record<string, ConsoleUrlFieldContract>>;
}

export interface ConsoleCapabilityContract {
  schemaVersion: 1;
  id: ConsoleContextId;
  auditMode: 'comparative' | 'single-site' | 'source-defined';
  runtime: ConsoleRuntime;
  transport: Readonly<{
    kind: 'sse' | 'polling' | 'sealed';
    resume: 'sequence' | 'revision' | 'none';
    fallback: 'bounded-snapshot' | 'none';
  }>;
  actions: Readonly<{
    stop: boolean;
    cancel: boolean;
    purge: boolean;
    manualEvidence: boolean;
    rekick: boolean;
    riskAcknowledge: boolean;
    riskResolve: boolean;
    visualDisposition: boolean;
    baseline: boolean;
    aiReview: boolean;
    settings: boolean;
  }>;
  destinations: Readonly<{
    report: boolean;
    gallery: boolean;
    checklist: boolean;
    sourceReport: boolean;
    artifacts: boolean;
  }>;
  archiveMutability: 'not-applicable' | 'read-only';
}

export type ConsoleActionId = keyof ConsoleCapabilityContract['actions'];

export interface ConsoleActionPolicy {
  mutates: true;
  authorization: 'required';
  eligibility: 'source-defined' | 'incomplete-executions-only' | 'open-nonvisual-risk-only' | 'resolvable-nonvisual-risk-only';
  supported: boolean;
  unsupportedReason: string | null;
}

export interface ConsoleActionAvailability {
  contextId: ConsoleContextId;
  actionId: ConsoleActionId;
  supported: boolean;
  authorized: boolean | null;
  eligible: boolean | null;
  available: boolean;
  unavailableReason: string | null;
  runtime?: ConsoleRuntime;
}

export interface ConsoleUrlStateIssue {
  code: string;
  key: string | null;
}

export interface ParsedConsoleUrlState {
  schemaVersion: 1;
  routeId: ConsoleRouteId;
  valid: boolean;
  state: Readonly<Record<string, string | readonly string[]>>;
  rejected: readonly ConsoleUrlStateIssue[];
  errors: readonly ConsoleUrlStateIssue[];
  search: string;
}

export const CONSOLE_CONTRACT_SCHEMA_VERSION: 1;
export const CONSOLE_ROUTE_CONTRACTS: Readonly<Record<ConsoleRouteId, ConsoleRouteContract>>;
export const CONSOLE_SURFACE_IDS: readonly string[];
export const CONSOLE_ASYNC_STATES: readonly ConsoleAsyncState[];
export const CONSOLE_CONNECTION_STATES: readonly ConsoleConnectionState[];
export const CONSOLE_STATE_DOMAINS: Readonly<Record<ConsoleStateDomain, Readonly<{
  owner: 'audit-authority' | 'browser-transport' | 'browser-region';
  clientMutable: boolean;
  values: 'source-defined' | readonly string[];
}>>>;
export const CONSOLE_CONTEXT_CAPABILITIES: Readonly<Record<ConsoleContextId, ConsoleCapabilityContract>>;
export const CONSOLE_ACTION_POLICIES: Readonly<Record<ConsoleContextId, Readonly<Record<ConsoleActionId, ConsoleActionPolicy>>>>;
export const CONSOLE_CONTROLLER_OWNERSHIP: Readonly<Record<string, Readonly<{
  surface: string;
  concern: string;
  owner: string;
  handoffUnit: 'U4' | 'U5' | 'U6' | 'U7' | 'U8' | 'retained';
}>>>;

export function getConsoleRouteContract(routeId: ConsoleRouteId): ConsoleRouteContract;
export function resolveConsoleRouteId(pathname: string, options?: { runtime?: ConsoleRuntime }): ConsoleRouteId | null;
export function getConsoleCapabilities(contextId: ConsoleContextId): ConsoleCapabilityContract;
export function resolveConsoleActionAvailability(
  contextId: ConsoleContextId,
  actionId: ConsoleActionId,
  state?: {
    authorized?: boolean | null;
    eligible?: boolean | null;
    unavailableReason?: string | null;
  },
): ConsoleActionAvailability;
export function parseConsoleUrlState(
  routeId: ConsoleRouteId,
  input?: string | URL | URLSearchParams,
): ParsedConsoleUrlState;
export function serializeConsoleUrlState(
  routeId: ConsoleRouteId,
  state?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[] | null | undefined>>,
): string;
export function stateDomainOwner(domain: ConsoleStateDomain): 'audit-authority' | 'browser-transport' | 'browser-region';
export function assertClientMayWriteStateDomain(domain: ConsoleStateDomain): true;
