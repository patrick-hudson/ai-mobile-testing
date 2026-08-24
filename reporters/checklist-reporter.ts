import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter';
import type { AuditProjectMetadata } from '../audit/types.js';
import {
  resolveReportOutputDir,
  writeAuditReport,
  type ReportAttachmentInput,
  type ReportErrorInput,
  type ReportTestInput,
} from './report-model.js';

interface ChecklistReporterOptions {
  outputDir?: string;
}

function errors(result: TestResult): ReportErrorInput[] {
  return result.errors.map((error) => ({
    ...(error.message ? { message: error.message } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.snippet ? { snippet: error.snippet } : {}),
    ...(error.value ? { value: error.value } : {}),
  }));
}

function attachments(result: TestResult): ReportAttachmentInput[] {
  return result.attachments.map((attachment) => ({
    name: attachment.name,
    contentType: attachment.contentType,
    ...(attachment.path ? { path: attachment.path } : {}),
    ...(attachment.body ? { body: attachment.body } : {}),
  }));
}

function outputLines(chunks: Array<string | Buffer>): string[] {
  return chunks.map((chunk) => (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk));
}

function toReportTest(test: TestCase, sourceShard: ReportTestInput['sourceShard']): ReportTestInput {
  const project = test.parent.project();
  const location = test.location;
  return {
    id: test.id,
    title: test.title,
    titlePath: test.titlePath(),
    file: location.file,
    line: location.line,
    column: location.column,
    projectName: project?.name ?? test.parent.title,
    projectMetadata: (project?.metadata ?? {}) as Partial<AuditProjectMetadata>,
    ...(sourceShard ? { sourceShard } : {}),
    tags: test.tags,
    annotations: test.annotations.map((annotation) => ({
      type: annotation.type,
      ...(annotation.description ? { description: annotation.description } : {}),
    })),
    results: test.results.map((result) => ({
      status: result.status,
      expectedStatus: test.expectedStatus,
      duration: result.duration,
      retry: result.retry,
      startedAt: result.startTime.toISOString(),
      errors: errors(result),
      attachments: attachments(result),
      stdout: outputLines(result.stdout),
      stderr: outputLines(result.stderr),
    })),
  };
}

export default class ChecklistReporter implements Reporter {
  private readonly configuredOutputDir: string | undefined;
  private suite: Suite | null = null;
  private startedAt: Date | null = null;
  private config: FullConfig | null = null;
  private readonly runErrors: ReportErrorInput[] = [];

  constructor(options: ChecklistReporterOptions = {}) {
    this.configuredOutputDir = options.outputDir;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.suite = suite;
    this.startedAt = new Date();
  }

  onError(error: TestError): void {
    this.runErrors.push({
      ...(error.message ? { message: error.message } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(error.snippet ? { snippet: error.snippet } : {}),
      ...(error.value ? { value: error.value } : {}),
    });
  }

  async onEnd(result: FullResult): Promise<void> {
    const outputDir = resolveReportOutputDir(this.configuredOutputDir);
    const sourceShard = this.config?.shard
      ? { ordinal: this.config.shard.current, total: this.config.shard.total }
      : undefined;
    const tests = this.suite?.allTests().map((test) => toReportTest(test, sourceShard)) ?? [];
    const manifest = await writeAuditReport({
      outputDir,
      tests,
      selectedProjects: (this.config?.projects ?? []).map((project) => ({
        name: project.name,
        metadata: (project.metadata ?? {}) as Partial<AuditProjectMetadata>,
      })),
      run: {
        status: result.status,
        ...(this.startedAt ? { startedAt: this.startedAt.toISOString() } : {}),
        durationMs: result.duration,
        source: 'playwright-reporter',
        profile: process.env.AUDIT_PROFILE ?? 'release',
        errors: this.config?.rootDir
          ? this.runErrors
          : [...this.runErrors, { message: 'Playwright did not provide a configured root directory.' }],
      },
    });

    const relative = outputDir.replace(`${process.cwd()}/`, '');
    console.log(
      `\nAudit checklist: ${relative}/index.html (${manifest.release.decision}; ${manifest.summary.executed}/${manifest.summary.total} checks executed)`,
    );
  }

  printsToStdio(): boolean {
    return true;
  }
}
