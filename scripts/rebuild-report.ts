import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ALL_AUDIT_BY_ID } from '../audit/definitions.js';
import { AUDIT_EVIDENCE_POLICY_ANNOTATION, serializeEvidencePolicy } from '../audit/evidence-policy.js';
import type { AuditEvidenceRecord, AuditProjectMetadata } from '../audit/types.js';
import type { GalleryArchiveDescriptor } from '../shared/gallery-contract.mjs';
import {
  validatePipelineDiagnostics,
  type PipelineIntegrityFailure,
} from './lib/pipeline-diagnostics.mjs';
import {
  AttachmentSourceContainmentError,
  createAttachmentSourceBoundary,
  readContainedAttachmentSource,
  validateContainedAttachmentSource,
  type AttachmentSourceBoundary,
} from '../reporters/gallery-model.js';
import {
  resolveReportOutputDir,
  writeAuditReport,
  type ReportAttachmentInput,
  type ReportErrorInput,
  type ReportTestInput,
} from '../reporters/report-model.js';

interface JsonAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: string;
}

interface JsonResult {
  status: string;
  duration: number;
  retry: number;
  startTime?: string;
  error?: ReportErrorInput;
  errors?: ReportErrorInput[];
  stdout?: Array<{ text?: string; buffer?: string } | string>;
  stderr?: Array<{ text?: string; buffer?: string } | string>;
  attachments?: JsonAttachment[];
}

interface JsonTest {
  expectedStatus?: string;
  projectId?: string;
  projectName?: string;
  annotations?: Array<{ type: string; description?: string }>;
  results?: JsonResult[];
}

interface JsonSpec {
  title: string;
  id?: string;
  file?: string;
  line?: number;
  column?: number;
  tags?: string[];
  tests?: JsonTest[];
}

interface JsonSuite {
  title?: string;
  file?: string;
  suites?: JsonSuite[];
  specs?: JsonSpec[];
}

interface PlaywrightJsonReport {
  config?: {
    metadata?: Record<string, unknown>;
    projects?: Array<{ id?: string; name: string; metadata?: Partial<AuditProjectMetadata> }>;
    shard?: { current: number; total: number } | null;
  };
  suites?: JsonSuite[];
  errors?: ReportErrorInput[];
  stats?: { startTime?: string; duration?: number; expected?: number; unexpected?: number; flaky?: number; skipped?: number };
}

function decodeOutput(chunks: JsonResult['stdout']): string[] {
  return (chunks ?? []).map((chunk) => {
    if (typeof chunk === 'string') return chunk;
    if (chunk.text != null) return chunk.text;
    if (chunk.buffer != null) return Buffer.from(chunk.buffer, 'base64').toString('utf8');
    return '';
  });
}

async function attachment(
  value: JsonAttachment,
  sourceBoundary: AttachmentSourceBoundary,
): Promise<ReportAttachmentInput> {
  let sourcePath: string | undefined;
  if (value.path) {
    sourcePath = await validateContainedAttachmentSource(value.path, sourceBoundary);
  }
  return {
    name: value.name,
    contentType: value.contentType,
    ...(sourcePath ? { path: sourcePath } : {}),
    ...(value.body ? { body: Buffer.from(value.body, 'base64') } : {}),
  };
}

async function collectTests(
  report: PlaywrightJsonReport,
  sourceBoundary: AttachmentSourceBoundary,
): Promise<ReportTestInput[]> {
  const sourceShard = report.config?.shard
    ? { ordinal: report.config.shard.current, total: report.config.shard.total }
    : null;
  const projects = new Map(
    (report.config?.projects ?? []).flatMap((project) => {
      const entries: Array<[string, { name: string; metadata?: Partial<AuditProjectMetadata> }]> = [];
      const details = { name: project.name, ...(project.metadata ? { metadata: project.metadata } : {}) };
      entries.push([project.name, details]);
      if (project.id) entries.push([project.id, details]);
      return entries;
    }),
  );
  const output: ReportTestInput[] = [];

  async function visit(suite: JsonSuite, parents: string[]): Promise<void> {
    const currentParents = suite.title ? [...parents, suite.title] : parents;
    for (const spec of suite.specs ?? []) {
      for (const [index, test] of (spec.tests ?? []).entries()) {
        const project = projects.get(test.projectId ?? '') ?? projects.get(test.projectName ?? '');
        const projectName = test.projectName ?? project?.name ?? test.projectId ?? 'unknown-project';
        const results = await Promise.all((test.results ?? []).map(async (result) => ({
          status: result.status,
          ...(test.expectedStatus ? { expectedStatus: test.expectedStatus } : {}),
          duration: result.duration,
          retry: result.retry,
          ...(result.startTime ? { startedAt: result.startTime } : {}),
          errors: result.errors ?? (result.error ? [result.error] : []),
          attachments: await Promise.all((result.attachments ?? []).map((value) => attachment(value, sourceBoundary))),
          stdout: decodeOutput(result.stdout),
          stderr: decodeOutput(result.stderr),
        })));
        output.push({
          id: spec.id ?? `${spec.file ?? suite.file ?? 'unknown'}:${spec.line ?? 0}:${projectName}:${index}`,
          title: spec.title,
          titlePath: [...currentParents, spec.title],
          file: spec.file ?? suite.file ?? 'unknown',
          ...(spec.line != null ? { line: spec.line } : {}),
          ...(spec.column != null ? { column: spec.column } : {}),
          projectName,
          ...(project?.metadata ? { projectMetadata: project.metadata } : {}),
          ...(sourceShard ? { sourceShard } : {}),
          tags: spec.tags ?? [],
          annotations: test.annotations ?? [],
          results,
        });
      }
    }
    for (const child of suite.suites ?? []) await visit(child, currentParents);
  }

  for (const suite of report.suites ?? []) await visit(suite, []);
  return output;
}

interface ManualEvidenceDocument {
  entries?: Array<{
    auditId?: string;
    outcome?: 'pass' | 'fail' | 'blocked';
    reviewer?: string;
    device?: string;
    notes?: string;
    attestedAt?: string;
    attachments?: Array<{ path?: string; name?: string; contentType?: string }>;
  }>;
}

async function collectManualTests(
  runDirectory: string,
  sourceBoundary: AttachmentSourceBoundary,
): Promise<ReportTestInput[]> {
  let document: ManualEvidenceDocument;
  try {
    document = JSON.parse((await readContainedAttachmentSource(
      path.join(runDirectory, 'manual-evidence.json'),
      sourceBoundary,
      { maximumBytes: 16 * 1024 * 1024 },
    )).toString('utf8')) as ManualEvidenceDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const manualRoot = path.join(sourceBoundary.realRoot, 'manual-evidence');
  const tests: ReportTestInput[] = [];
  for (const [index, entry] of (document.entries ?? []).entries()) {
    const definition = entry.auditId ? ALL_AUDIT_BY_ID.get(entry.auditId) : undefined;
    if (!definition?.manual || !entry.outcome || !entry.attestedAt || !entry.reviewer || !entry.device) continue;
    const findings = entry.outcome === 'pass' ? [] : [{
      severity: definition.severity,
      title: entry.outcome === 'blocked' ? 'Manual acceptance is blocked' : 'Manual acceptance failed',
      detail: entry.notes || 'The reviewer did not record additional detail.',
      blocking: definition.releaseBlocking,
    }];
    const record: AuditEvidenceRecord = {
      schemaVersion: 1,
      auditId: definition.id,
      definition,
      evidencePolicy: definition.evidencePolicy,
      environment: 'candidate',
      baseURL: process.env.CANDIDATE_URL ?? 'https://beta.quitting7oh-org.pages.dev',
      project: `manual-${entry.device}`,
      browser: entry.device,
      viewport: null,
      timezone: 'reviewer device',
      startedAt: entry.attestedAt,
      finishedAt: entry.attestedAt,
      steps: [{
        name: 'Perform physical-device acceptance and attest the outcome',
        expected: definition.expected,
        startedAt: entry.attestedAt,
        finishedAt: entry.attestedAt,
        status: entry.outcome === 'pass' ? 'passed' : 'failed',
        ...(entry.outcome === 'pass' ? {} : { detail: entry.notes || entry.outcome }),
      }],
      observations: [
        { label: 'Reviewer', value: entry.reviewer, timestamp: entry.attestedAt },
        { label: 'Device and browser', value: entry.device, timestamp: entry.attestedAt },
        { label: 'Attested outcome', value: entry.outcome, timestamp: entry.attestedAt },
        { label: 'Reviewer notes', value: entry.notes || '', timestamp: entry.attestedAt },
      ],
      findings,
      pageInspections: [],
      consoleErrors: [],
      consoleWarnings: [],
      pageErrors: [],
      httpResponses: [],
      failedRequests: [],
      badResponses: [],
    };
    const attachments: ReportAttachmentInput[] = [
      { name: 'audit-result', contentType: 'application/json', body: Buffer.from(JSON.stringify(record, null, 2)) },
      { name: 'manual-attestation', contentType: 'application/json', body: Buffer.from(JSON.stringify(entry, null, 2)) },
    ];
    for (const attachment of entry.attachments ?? []) {
      if (!attachment.path || !attachment.contentType) continue;
      if (path.isAbsolute(attachment.path) || attachment.path.replaceAll('\\', '/').split('/').includes('..')) {
        throw new AttachmentSourceContainmentError('Manual attachment source rejected: paths must be relative and traversal-free.');
      }
      let absolute: string;
      try {
        absolute = await validateContainedAttachmentSource(attachment.path, sourceBoundary);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      if (absolute !== manualRoot && !absolute.startsWith(`${manualRoot}${path.sep}`)) {
        throw new AttachmentSourceContainmentError('Manual attachment source rejected: the file is outside manual-evidence.');
      }
      attachments.push({
        name: `manual-${attachment.name ?? path.basename(absolute)}`,
        contentType: attachment.contentType,
        path: absolute,
      });
    }
    tests.push({
      id: `manual-${definition.id}-${index}`,
      title: `[${definition.id}] manual acceptance by ${entry.reviewer}`,
      titlePath: ['manual evidence', definition.title],
      file: 'manual-evidence.json',
      projectName: `manual · ${entry.device}`,
      projectMetadata: { environment: 'candidate', browserLabel: entry.device, deviceClass: 'mobile', fullSweep: false, visual: true },
      annotations: [
        {
          type: AUDIT_EVIDENCE_POLICY_ANNOTATION,
          description: serializeEvidencePolicy(definition.evidencePolicy),
        },
        ...(entry.outcome === 'blocked' ? [{ type: 'audit-status', description: 'BLOCKED' }] : []),
      ],
      results: [{
        status: entry.outcome === 'fail' ? 'failed' : 'passed',
        expectedStatus: 'passed',
        duration: 0,
        retry: 0,
        startedAt: entry.attestedAt,
        errors: entry.outcome === 'fail' ? [{ message: entry.notes || 'Manual acceptance failed.' }] : [],
        attachments,
        stdout: [`Manual evidence recorded by ${entry.reviewer} for ${entry.device}.`],
        stderr: [],
      }],
    });
  }
  return tests;
}

interface RebuildArguments {
  resultsFile: string;
  outputDir: string;
  pipelineDiagnosticsFile?: string;
}

function rebuildArguments(argv: string[]): RebuildArguments {
  let runDir: string | undefined;
  let resultsFile: string | undefined;
  let outputDir: string | undefined;
  let pipelineDiagnosticsFile: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--run-dir') runDir = argv[++index];
    else if (argument === '--results-file') resultsFile = argv[++index];
    else if (argument === '--output-dir') outputDir = argv[++index];
    else if (argument === '--pipeline-diagnostics-file') pipelineDiagnosticsFile = argv[++index];
    else if (argument?.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    else if (argument) positional.push(argument);
  }
  if (runDir) {
    const absoluteRunDir = path.resolve(runDir);
    resultsFile ??= path.join(absoluteRunDir, 'results.json');
    outputDir ??= path.join(absoluteRunDir, 'checklist');
  }
  resultsFile ??= positional[0] ?? process.env.AUDIT_RESULTS_FILE ?? './artifacts/results.json';
  outputDir ??= positional[1] ?? resolveReportOutputDir();
  return {
    resultsFile: path.resolve(resultsFile),
    outputDir: path.resolve(outputDir),
    ...(pipelineDiagnosticsFile ? { pipelineDiagnosticsFile: path.resolve(pipelineDiagnosticsFile) } : {}),
  };
}

const rebuild = rebuildArguments(process.argv.slice(2));
const resultsFile = rebuild.resultsFile;
const outputDir = rebuild.outputDir;
const runDirectory = path.dirname(resultsFile);
const sourceBoundary = await createAttachmentSourceBoundary(runDirectory);
const report = JSON.parse((await readContainedAttachmentSource(
  resultsFile,
  sourceBoundary,
  { maximumBytes: 512 * 1024 * 1024 },
)).toString('utf8')) as PlaywrightJsonReport;
let integrityFailures: PipelineIntegrityFailure[] = [];
if (rebuild.pipelineDiagnosticsFile) {
  const expectedRunId = process.env.AUDIT_SHARDED_RUN_ID;
  if (!expectedRunId) throw new Error('AUDIT_SHARDED_RUN_ID is required with --pipeline-diagnostics-file.');
  const diagnostics = validatePipelineDiagnostics(JSON.parse((await readContainedAttachmentSource(
    rebuild.pipelineDiagnosticsFile,
    sourceBoundary,
    { maximumBytes: 256 * 1024 },
  )).toString('utf8')), expectedRunId);
  integrityFailures = diagnostics.failures;
}
const tests = [
  ...await collectTests(report, sourceBoundary),
  ...await collectManualTests(runDirectory, sourceBoundary),
];
const unexpected = report.stats?.unexpected ?? 0;
const pipelineErrors = integrityFailures.map(({ stage, reason }) => ({
  message: `Pipeline integrity failure in ${stage}: ${reason}`,
}));
const reportOptions = {
  outputDir,
  tests,
  run: {
    status: unexpected > 0 || integrityFailures.length > 0 ? 'failed' as const : 'passed' as const,
    ...(report.stats?.startTime ? { startedAt: report.stats.startTime } : {}),
    ...(report.stats?.duration != null ? { durationMs: report.stats.duration } : {}),
    source: 'playwright-json' as const,
    profile: process.env.AUDIT_PROFILE ?? 'release',
    errors: [...(report.errors ?? []), ...pipelineErrors],
    integrityFailures,
  },
  // GenerateReportOptions is intentionally narrower, but buildAuditModels
  // forwards this runtime property to the gallery boundary.
  sourceRoot: runDirectory,
};
const manifest = await writeAuditReport(reportOptions);

console.log(`Rebuilt ${path.resolve(outputDir, 'index.html')}`);
const galleryDescriptor = JSON.parse(
  await readFile(path.join(outputDir, 'gallery', 'current.json'), 'utf8'),
) as GalleryArchiveDescriptor;
console.log(
  `Gallery archive ${galleryDescriptor.exportRevision}: ${galleryDescriptor.primaryCounts.total} logical media item${galleryDescriptor.primaryCounts.total === 1 ? '' : 's'} in ${galleryDescriptor.query.chunks.length} bounded query chunk${galleryDescriptor.query.chunks.length === 1 ? '' : 's'}.`,
);
console.log(`${manifest.summary.executed}/${manifest.summary.total} checks executed; release decision: ${manifest.release.decision}`);
