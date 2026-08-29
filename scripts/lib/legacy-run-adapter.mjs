import path from 'node:path';
import * as fs from 'node:fs/promises';

export class LegacyRunAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LegacyRunAdapterError';
    this.code = code;
  }
}

export async function readLegacyRun(sourcePathValue, { maximumBytes = 4 * 1_048_576 } = {}) {
  const sourcePath = path.resolve(sourcePathValue);
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new LegacyRunAdapterError('LEGACY_SOURCE_INVALID', 'Legacy run source must be a bounded regular file.');
  }
  let source;
  try { source = JSON.parse(await fs.readFile(sourcePath, 'utf8')); } catch {
    throw new LegacyRunAdapterError('LEGACY_SOURCE_INVALID', 'Legacy run source is not valid JSON.');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'legacy-run-read-adapter',
    sourcePath,
    legacyRunId: typeof source.auditId === 'string' ? source.auditId : null,
    legacyStatus: typeof source.status === 'string' ? source.status : null,
    authoritative: false,
    releaseDecision: null,
    availability: 'UNAVAILABLE',
    limitations: Object.freeze([
      'Legacy artifacts do not contain a sealed shared release subject.',
      'Legacy pass-like status cannot be promoted to an authoritative Release Decision.',
    ]),
    source,
  });
}
