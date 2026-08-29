export interface LegacyAuthorityFenceDocument {
  schemaVersion: 1;
  kind: 'legacy-release-authority-fence';
  state: 'OPEN' | 'CLOSED' | 'FROZEN' | 'ACTIVATED';
  revision: number;
  cutoverId: string | null;
  activationEpoch: 0 | 1;
  previousDigest: string | null;
  updatedAt: string;
  digest: string;
}

export interface LegacyAuthorityFence {
  root: string;
  read(): Promise<LegacyAuthorityFenceDocument>;
  withAuthority<T>(capability: string, operation: (fence: LegacyAuthorityFenceDocument) => Promise<T> | T): Promise<T>;
  close(expectedDigest: string, cutoverId: string): Promise<LegacyAuthorityFenceDocument>;
  freeze(expectedDigest: string, cutoverId: string): Promise<LegacyAuthorityFenceDocument>;
  activate(expectedDigest: string, cutoverId: string, activationEpoch: 1): Promise<LegacyAuthorityFenceDocument>;
  reopenPreActivation(expectedDigest: string, cutoverId: string): Promise<LegacyAuthorityFenceDocument>;
}

export class LegacyAuthorityFenceError extends Error {
  code: string;
  details?: unknown;
  statusCode: number;
}

export function initializeLegacyAuthorityFence(options: {
  root: string; filesystem?: any; nonce?: () => string; verifyStorage?: boolean; clock?: () => number;
}): Promise<LegacyAuthorityFence>;

export function openLegacyAuthorityFence(options: {
  root: string; filesystem?: any; nonce?: () => string; verifyStorage?: boolean; clock?: () => number;
}): Promise<LegacyAuthorityFence>;

export function openLegacyAuthorityFenceFromEnvironment(
  environment?: Record<string, string | undefined>,
): Promise<LegacyAuthorityFence | null>;
