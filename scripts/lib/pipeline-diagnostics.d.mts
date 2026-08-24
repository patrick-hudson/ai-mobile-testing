export interface PipelineIntegrityFailure {
  stage: string;
  reason: string;
  exitCode: number | null;
  signal: string | null;
  logPath: string | null;
}

export interface PipelineDiagnosticsDocument {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  source: 'coordinator' | 'merge';
  authority: {
    classification: 'integrity-input';
    authoritativeReleaseSource: 'sharded-run.json';
    diagnosticCountsAuthoritative: false;
  };
  failures: PipelineIntegrityFailure[];
}

export const PIPELINE_DIAGNOSTICS_FILENAME: 'pipeline-diagnostics.json';

export function commandIntegrityFailures(results: unknown[]): PipelineIntegrityFailure[];

export function pipelineDiagnosticsDocument(options: {
  runId: string;
  failures: PipelineIntegrityFailure[];
  generatedAt?: string;
  source: 'coordinator' | 'merge';
}): PipelineDiagnosticsDocument;

export function readPipelineDiagnostics(
  path: string,
  expectedRunId: string,
): Promise<PipelineDiagnosticsDocument>;

export function validatePipelineDiagnostics(
  document: unknown,
  expectedRunId: string,
): PipelineDiagnosticsDocument;
