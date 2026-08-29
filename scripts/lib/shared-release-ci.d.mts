export interface SharedReleaseCiClient {
  launch(input: { requestId: string; intent: Record<string, unknown> }): Promise<unknown>;
  readLaunchOperation(input: { operationId: string; runId: string }): Promise<unknown>;
  readRun(input: { runId: string }): Promise<unknown>;
  readPublication(input: { runId: string }): Promise<unknown>;
  reprobeTargetIdentity(input: {
    runId: string;
    targets: readonly unknown[];
    expectedIdentity: unknown;
  }): Promise<unknown>;
}

export interface SharedReleaseCiResult {
  readonly schemaVersion: 1;
  readonly confirmed: true;
  readonly operationId: string;
  readonly runId: string;
  readonly run: Readonly<Record<string, unknown>>;
  readonly publication: Readonly<Record<string, unknown>>;
  readonly assertionExpected: Readonly<{
    subjectDigest: string;
    authority: string;
    executionSetDigest: string;
    runRevision: number;
    decisionRevision: number;
  }>;
}

export class SharedReleaseCiError extends Error {
  readonly code: string;
  constructor(code: string, message: string, cause?: unknown);
}

export function runSharedReleaseCi(options: {
  client: SharedReleaseCiClient;
  requestId: string;
  intent: Record<string, unknown>;
  maximumLaunchPolls?: number;
  maximumPublicationPolls?: number;
  pollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<SharedReleaseCiResult>;
