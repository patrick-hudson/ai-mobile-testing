type HistoryRecord = Record<string, unknown>;

export interface VideoRetentionHistory {
  eligibleExecutions: number;
  rejectedExecutions: number;
  skippedExecutions: number;
  policyRejectedExecutions: number;
  qualityRejectedClips: number;
  normalizedLeadingBlankClips: number;
  diagnosticRetainedClips: number;
  removedVideoAttachments: number;
  eligibleHashes: number;
  retainedFiles: number;
  prunedFiles: number;
  prunedBytes: number;
  integrityErrors: string[];
  qualityAssessments: HistoryRecord[];
  normalizations: HistoryRecord[];
  pruned: HistoryRecord[];
}

const COUNT_KEYS = [
  'eligibleExecutions', 'rejectedExecutions', 'skippedExecutions', 'policyRejectedExecutions',
  'qualityRejectedClips', 'normalizedLeadingBlankClips', 'diagnosticRetainedClips',
  'removedVideoAttachments', 'eligibleHashes', 'retainedFiles', 'prunedFiles', 'prunedBytes',
] as const;

function record(value: unknown): HistoryRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as HistoryRecord : null;
}

function count(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function records(value: unknown): HistoryRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry): entry is HistoryRecord => entry !== null) : [];
}

function mergeRecords(
  current: HistoryRecord[],
  previous: HistoryRecord[],
  key: (entry: HistoryRecord) => string,
): HistoryRecord[] {
  const merged = new Map<string, HistoryRecord>();
  for (const entry of previous) merged.set(key(entry), entry);
  for (const entry of current) merged.set(key(entry), entry);
  return [...merged.values()];
}

export function mergeVideoRetentionHistory(current: VideoRetentionHistory, previousValue: unknown): VideoRetentionHistory {
  const previous = record(previousValue);
  if (!previous) return current;
  const output = { ...current };
  for (const key of COUNT_KEYS) output[key] = Math.max(current[key], count(previous[key]));
  output.integrityErrors = [...new Set([
    ...(Array.isArray(previous.integrityErrors)
      ? previous.integrityErrors.filter((value): value is string => typeof value === 'string')
      : []),
    ...current.integrityErrors,
  ])];
  output.qualityAssessments = mergeRecords(
    current.qualityAssessments,
    records(previous.qualityAssessments),
    (entry) => String(entry.video ?? JSON.stringify(entry)),
  );
  output.normalizations = mergeRecords(
    current.normalizations,
    records(previous.normalizations),
    (entry) => `${String(entry.originalVideo ?? '')}\u0000${String(entry.normalizedVideo ?? '')}`,
  );
  output.pruned = mergeRecords(
    current.pruned,
    records(previous.pruned),
    (entry) => `${String(entry.relativePath ?? '')}\u0000${String(entry.sha256 ?? '')}`,
  );
  output.normalizedLeadingBlankClips = Math.max(output.normalizedLeadingBlankClips, output.normalizations.length);
  output.prunedFiles = Math.max(output.prunedFiles, output.pruned.length);
  return output;
}
