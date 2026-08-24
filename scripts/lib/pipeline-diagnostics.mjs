import { promises as fs } from 'node:fs';

export const PIPELINE_DIAGNOSTICS_FILENAME = 'pipeline-diagnostics.json';
const MAX_PIPELINE_DIAGNOSTICS_BYTES = 256 * 1024;
const MAX_INTEGRITY_FAILURES = 64;

export function commandIntegrityFailures(results) {
  return results.flatMap((result) => {
    if (!result || !Array.isArray(result.command) || result.command.length === 0) return [];
    const abnormalExit = Number.isInteger(result.exitCode) && ![0, 1].includes(result.exitCode);
    if (!result.error && !result.signal && !abnormalExit) return [];
    const reason = result.error
      ?? (result.signal ? `${result.label} was terminated by ${result.signal}.` : `${result.label} exited abnormally with code ${result.exitCode}.`);
    return [{
      stage: String(result.label ?? 'UNKNOWN').slice(0, 160),
      reason: String(reason).slice(0, 2_000),
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
      signal: typeof result.signal === 'string' ? result.signal.slice(0, 40) : null,
      logPath: typeof result.logPath === 'string' ? result.logPath.slice(0, 500) : null,
    }];
  });
}

export function pipelineDiagnosticsDocument({ runId, failures, generatedAt = new Date().toISOString(), source }) {
  return validatePipelineDiagnostics({
    schemaVersion: 1,
    runId,
    generatedAt,
    source,
    authority: {
      classification: 'integrity-input',
      authoritativeReleaseSource: 'sharded-run.json',
      diagnosticCountsAuthoritative: false,
    },
    failures,
  }, runId);
}

export async function readPipelineDiagnostics(path, expectedRunId) {
  const stat = await fs.stat(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_PIPELINE_DIAGNOSTICS_BYTES) {
    throw new Error(`Pipeline diagnostics must be a non-empty file no larger than ${MAX_PIPELINE_DIAGNOSTICS_BYTES} bytes.`);
  }
  return validatePipelineDiagnostics(JSON.parse(await fs.readFile(path, 'utf8')), expectedRunId);
}

export function validatePipelineDiagnostics(document, expectedRunId) {
  if (!document || typeof document !== 'object' || Array.isArray(document) || document.schemaVersion !== 1) {
    throw new Error('Pipeline diagnostics must be a schemaVersion 1 object.');
  }
  if (document.runId !== expectedRunId) throw new Error('Pipeline diagnostics runId does not match this run.');
  if (!Number.isFinite(Date.parse(String(document.generatedAt ?? '')))) {
    throw new Error('Pipeline diagnostics generatedAt must be a valid timestamp.');
  }
  if (!['coordinator', 'merge'].includes(document.source)) {
    throw new Error('Pipeline diagnostics source must be coordinator or merge.');
  }
  if (document.authority?.classification !== 'integrity-input'
    || document.authority?.authoritativeReleaseSource !== 'sharded-run.json'
    || document.authority?.diagnosticCountsAuthoritative !== false) {
    throw new Error('Pipeline diagnostics must identify sharded-run.json as authoritative and diagnostic counts as non-authoritative.');
  }
  if (!Array.isArray(document.failures) || document.failures.length > MAX_INTEGRITY_FAILURES) {
    throw new Error(`Pipeline diagnostics failures must be an array of at most ${MAX_INTEGRITY_FAILURES} entries.`);
  }
  const failures = document.failures.map((failure) => {
    if (!failure || typeof failure !== 'object' || Array.isArray(failure)
      || typeof failure.stage !== 'string' || failure.stage.length < 1 || failure.stage.length > 160
      || typeof failure.reason !== 'string' || failure.reason.length < 1 || failure.reason.length > 2_000
      || !(failure.exitCode === null || Number.isInteger(failure.exitCode))
      || !(failure.signal === null || (typeof failure.signal === 'string' && failure.signal.length <= 40))
      || !(failure.logPath === null || (typeof failure.logPath === 'string' && failure.logPath.length <= 500))) {
      throw new Error('Pipeline diagnostics contains an invalid integrity failure.');
    }
    return {
      stage: failure.stage,
      reason: failure.reason,
      exitCode: failure.exitCode,
      signal: failure.signal,
      logPath: failure.logPath,
    };
  });
  return {
    schemaVersion: 1,
    runId: document.runId,
    generatedAt: document.generatedAt,
    source: document.source,
    authority: {
      classification: 'integrity-input',
      authoritativeReleaseSource: 'sharded-run.json',
      diagnosticCountsAuthoritative: false,
    },
    failures,
  };
}
