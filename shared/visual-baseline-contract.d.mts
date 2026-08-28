export type DeploymentRole = 'preview' | 'production';
export type VisualReviewStatus = 'UNCHANGED' | 'CHANGED' | 'REVIEWED' | 'absent' | 'incompatible' | 'unavailable';
export type VisualBaselineState = 'active' | 'replaced' | 'revoked' | 'deleted';

export interface VisualBaselineIdentity {
  schemaVersion: 1;
  mode: 'single-site';
  deploymentRole: DeploymentRole;
  route: string;
  targetId: string;
  viewport: { width: number; height: number };
  theme: string;
  auditId: string;
  auditDefinitionDigest: string;
  capturePoint: string;
  browser: { engine: 'chromium' | 'firefox' | 'webkit'; product: string; version: string; build: string };
  rendering: {
    devicePixelRatio: number;
    captureContractRevision: string;
    runnerImageDigest: string;
    fontPackDigest: string;
    fingerprint: string;
  };
}

export interface VisualBaselineEvidence {
  runId: string;
  artifactRelativePath: string;
  artifactSha256: string;
  artifactBytes: number;
  contentType: 'image/png';
  runStatus: 'completed';
  evidenceComplete: true;
  evidenceAuthority: { status: 'authoritative'; reasons: [] };
  findingStatus: 'clear' | 'unresolved';
  findingWaiver: null | { actorId: string; reason: string; at: string };
}

export interface VisualBaselineRecord {
  schemaVersion: 1;
  baselineId: string;
  slotKey: string;
  identityKey: string;
  identity: VisualBaselineIdentity;
  state: VisualBaselineState;
  source: VisualBaselineEvidence;
  media: { relativePath: string; sha256: string; bytes: number; available: boolean };
  approvedBy: string;
  approvedAt: string;
  replacedBy: string | null;
  revokedAt: string | null;
  deletedAt: string | null;
  deletionReason: string | null;
}

export const VISUAL_BASELINE_SCHEMA_VERSION: 1;
export const VISUAL_BASELINE_HISTORY_SCHEMA_VERSION: 1;
export const VISUAL_CAPTURE_METADATA_CONTENT_TYPE: 'application/vnd.quitting7oh.visual-baseline-capture+json';
export function visualBaselineCanonicalJson(value: unknown): string;
export function visualBaselineDigest(value: unknown): string;
export function normalizedRelativePath(value: unknown): string;
export function parseTimestamp(value: unknown, label?: string): string;
export function parseVisualBaselineIdentity(value: unknown): VisualBaselineIdentity;
export interface VisualCaptureMetadata {
  schemaVersion: 1;
  kind: 'single-site-visual-capture';
  attachmentName: string;
  attachmentOccurrence: number;
  identity: VisualBaselineIdentity;
  identityKey: string;
  slotKey: string;
}
export function parseVisualCaptureMetadata(value: unknown): VisualCaptureMetadata;
export function visualBaselineSlotKey(value: unknown): string;
export function visualBaselineIdentityKey(value: unknown): string;
export function compareVisualBaselineIdentity(baseline: unknown, current: unknown): {
  compatible: boolean;
  differences: string[];
  baselineSlotKey: string;
  currentSlotKey: string;
  baselineIdentityKey: string;
  currentIdentityKey: string;
  environmentChangeOnly: boolean;
};
export function parseVisualBaselineEvidence(value: unknown): VisualBaselineEvidence;
export function parseVisualReview(value: unknown): Readonly<Record<string, unknown>>;
export function assertVisualBaselineRecord(value: unknown): VisualBaselineRecord;
