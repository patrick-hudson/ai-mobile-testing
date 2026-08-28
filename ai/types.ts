export type AiReviewStatus = 'completed' | 'dry-run' | 'skipped' | 'error';
export type AiReviewMode = 'comparative' | 'single-site';

export interface AiInputArtifact {
  name: string;
  kind: 'screenshot' | 'video-poster';
  relativePath: string;
  mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
  auditId: string;
  project: string;
}

export interface AiAdvisoryFinding {
  id: string;
  title: string;
  summary: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3' | 'info';
  confidence: number;
  relatedAuditIds: string[];
  evidence: string[];
  recommendation: string;
  requiresHumanVerification: true;
}

export interface AiReviewContent {
  executiveSummary: string;
  /** Always null for Single-site runs; AI never owns promotion or release decisions. */
  releaseRecommendation: string | null;
  findings: AiAdvisoryFinding[];
  coverageGaps: string[];
  questionsForHumanReviewer: string[];
}

export interface AiReviewDocument {
  schemaVersion: 1;
  advisory: true;
  gating: false;
  status: AiReviewStatus;
  generatedAt: string;
  model: string;
  source: {
    mode: AiReviewMode;
    runDirectory: string;
    checklistManifest: string | null;
    runId: string | null;
    releaseDecision: string | null;
    structuredInputBytes: number;
    selectedAuditCount: number;
    artifacts: AiInputArtifact[];
    payloadInventory: {
      path: 'payload-inventory.json';
      sha256: string;
      fieldCount: number;
      redactionCount: number;
    };
  };
  api: {
    status: 'not-attempted' | 'success' | 'error';
    attempted: boolean;
    httpStatus: number | null;
    latencyMs: number | null;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      cacheCreationInputTokens: number | null;
      cacheReadInputTokens: number | null;
      raw: Record<string, unknown>;
    } | null;
    cost: Record<string, unknown> | number | string | null;
  };
  review: AiReviewContent;
  notice: string;
  error: string | null;
}

export interface AiReviewLimits {
  maxAudits: number;
  /** Maximum visual inputs across screenshots and generated video posters. */
  maxScreenshots: number;
  maxImageBytes: number;
  maxTotalImageBytes: number;
}

export interface AiReviewOptions {
  runDir: string;
  outputDir?: string;
  /** Runtime-only secret supplied in memory; never serialized into review output. */
  apiKey?: string;
  dryRun: boolean;
  /** Required before a Single-site packet may leave the process. */
  optIn?: boolean;
  model: string;
  limits: AiReviewLimits;
  request?: {
    /** Overall wall-clock budget across every API attempt and retry delay. */
    deadlineMs: number;
    /** Total attempts, including the first request. */
    maxAttempts: number;
    /** Maximum server-directed or exponential delay between attempts. */
    maxRetryDelayMs: number;
  };
}
