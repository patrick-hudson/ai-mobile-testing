export class SharedStoreBackupRehearsalError extends Error {
  code: string;
  details?: unknown;
}

export interface SharedStoreBackupLimits {
  maximumEntries?: number;
  maximumFileBytes?: number;
  maximumTotalBytes?: number;
}

export interface SharedStoreBackupExpectedStore {
  deploymentIdentity: string;
  volumeIdentity: string;
  storeMarkerDigest: string;
  storeGeneration: number;
  schemaVersion: number;
  schemaFloor: number;
  currentWriterProtocol: string;
  minimumWriterProtocol: string;
  backupMarker: string;
}

export interface SharedStoreSnapshotReceipt {
  rootMode: number;
  rootUid: number;
  rootGid: number;
  entryCount: number;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  entriesDigest: string;
  digest: string;
}

export interface SharedStoreBackupRehearsalReceipt {
  schemaVersion: 1;
  kind: 'shared-store-backup-rehearsal-receipt';
  rehearsalId: string;
  startedAt: string;
  completedAt: string;
  buildIdentity: string;
  configurationDigest: string;
  expectedStoreDigest: string;
  manifestDigest: string;
  selectorDigest: string;
  storeMarkerDigest: string;
  backupMarkerDigest: string;
  storeGeneration: number;
  storeSchemaVersion: number;
  schemaFloor: number;
  writerProtocol: string;
  minimumWriterProtocol: string;
  activationEpoch: 0 | 1;
  activationRevision: number | null;
  cutoverRevision: number;
  sourceSnapshot: SharedStoreSnapshotReceipt;
  backupSnapshot: SharedStoreSnapshotReceipt;
  restoreSnapshot: SharedStoreSnapshotReceipt;
  verification: {
    copyMode: 'quiesced-byte-for-byte';
    sourceQuiesced: true;
    backupMatchesSource: true;
    restoreMatchesSource: true;
    unsupportedEntriesRejected: true;
    isolatedPaths: true;
  };
  digest: string;
}

export interface SharedStoreBackupReceiptExpectations {
  expectedStore?: SharedStoreBackupExpectedStore;
  buildIdentity?: string;
  configurationDigest?: string;
  backupMarker?: string;
  manifestDigest?: string;
  selectorDigest?: string;
  notBefore?: string;
  maximumAgeMs?: number;
  now?: number;
}

export function parseSharedStoreBackupRehearsalReceipt(
  value: unknown,
  expected?: SharedStoreBackupReceiptExpectations,
): SharedStoreBackupRehearsalReceipt;

export function rehearseSharedStoreBackup(options: {
  rehearsalId: string;
  sourceRoot: string;
  backupRoot: string;
  restoreRoot: string;
  receiptPath: string;
  storeMarker: string;
  backupMarker: string;
  buildIdentity: string;
  configurationDigest: string;
  expectedStore: SharedStoreBackupExpectedStore;
  clock?: () => number;
  limits?: SharedStoreBackupLimits;
}): Promise<SharedStoreBackupRehearsalReceipt>;

export function verifySharedStoreBackupRehearsal(options: {
  receipt: unknown;
  backupRoot: string;
  restoreRoot: string;
  limits?: SharedStoreBackupLimits;
} & SharedStoreBackupReceiptExpectations): Promise<SharedStoreBackupRehearsalReceipt>;
