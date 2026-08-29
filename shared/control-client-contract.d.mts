export declare const CONTROL_EXIT_CODES: Readonly<{
  SUCCESS: 0; REQUEST_FAILED: 1; USAGE: 2; AUTHORIZATION: 3; CONFLICT: 4;
  NOT_READY: 10; STALE: 11; IDENTITY_MISMATCH: 12; EVIDENCE_UNAVAILABLE: 13; TIMEOUT: 14;
}>;
export declare function controlExitCode(input?: { status?: number; code?: string }): number;
