import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ALL_AUDIT_CATALOG } from '../audit/definitions.js';
import type { AuditProjectMetadata } from '../audit/types.js';
import {
  GALLERY_CAPTURE_METADATA_CONTENT_TYPE,
  GALLERY_SCHEMA_VERSION,
  assertGalleryCatalog,
  type GalleryCatalog,
} from '../shared/gallery-contract.mjs';
import { buildGalleryCatalog } from './gallery-model.js';
import type {
  ReportAttachmentInput,
  ReportErrorInput,
  ReportResultInput,
  ReportTestInput,
} from './report-model.js';

interface LiveGalleryReporterOptions {
  outputDir?: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

export interface LiveGalleryAttemptInput {
  outputDir: string;
  test: ReportTestInput;
}

interface LiveGalleryHead {
  schemaVersion: 1;
  phase: 'live';
  contentRevision: string;
  flagRevision: string;
  orderRevision: string;
  producedAt: string;
  primaryCounts: GalleryCatalog['primaryCounts'];
  facets: {
    kinds: string[];
    statuses: string[];
    environments: string[];
    featureSuites: string[];
    technicalSuites: string[];
    targets: string[];
    flagStates: string[];
  };
  sourceShard: { ordinal: number; total: number } | null;
  revisionHref: string;
}

const publicationQueues = new Map<string, Promise<void>>();
const execFileAsync = promisify(execFile);

function errors(result: TestResult): ReportErrorInput[] {
  return result.errors.map((error) => ({
    ...(error.message ? { message: error.message } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.snippet ? { snippet: error.snippet } : {}),
    ...(error.value ? { value: error.value } : {}),
  }));
}

function attachments(result: TestResult): ReportAttachmentInput[] {
  return result.attachments.filter((attachment) => (
    attachment.contentType.startsWith('image/')
    || attachment.contentType === GALLERY_CAPTURE_METADATA_CONTENT_TYPE
    || attachment.name.toLowerCase().includes('audit-result')
  )).map((attachment) => ({
    name: attachment.name,
    contentType: attachment.contentType,
    ...(attachment.path ? { path: attachment.path } : {}),
    ...(attachment.body ? { body: attachment.body } : {}),
  }));
}

function outputLines(chunks: Array<string | Buffer>): string[] {
  return chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
}

function reportTest(test: TestCase, result: TestResult, sourceShard: ReportTestInput['sourceShard']): ReportTestInput {
  const project = test.parent.project();
  return {
    id: test.id,
    title: test.title,
    titlePath: test.titlePath(),
    file: test.location.file,
    line: test.location.line,
    column: test.location.column,
    projectName: project?.name ?? test.parent.title,
    projectMetadata: (project?.metadata ?? {}) as Partial<AuditProjectMetadata>,
    ...(sourceShard ? { sourceShard } : {}),
    tags: test.tags,
    annotations: test.annotations.map((annotation) => ({
      type: annotation.type,
      ...(annotation.description ? { description: annotation.description } : {}),
    })),
    results: [{
      status: result.status,
      expectedStatus: test.expectedStatus,
      duration: result.duration,
      retry: result.retry,
      startedAt: result.startTime.toISOString(),
      errors: errors(result),
      attachments: attachments(result),
      stdout: outputLines(result.stdout),
      stderr: outputLines(result.stderr),
    }],
  };
}

function closedAttemptTest(test: ReportTestInput): ReportTestInput {
  const current = test.results.at(-1);
  if (!current) throw new Error('A live gallery publication requires one closed attempt result.');
  const placeholders: ReportResultInput[] = Array.from({ length: current.retry }, (_, retry) => ({
    status: 'skipped',
    ...(current.expectedStatus ? { expectedStatus: current.expectedStatus } : {}),
    duration: 0,
    retry,
    errors: [],
    attachments: [],
    stdout: [],
    stderr: [],
  }));
  return { ...test, results: [...placeholders, current] };
}

function imageOnlyCatalog(catalog: GalleryCatalog): GalleryCatalog {
  const items = catalog.items.filter(({ kind }) => kind === 'image');
  const blobIds = new Set(items.flatMap(({ members }) => members.flatMap(({ blobId }) => blobId ? [blobId] : [])));
  return assertGalleryCatalog({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    items,
    blobs: catalog.blobs.filter(({ id }) => blobIds.has(id)),
    primaryCounts: { total: items.length, images: items.length, videos: 0 },
  });
}

function hasPublishableImage(test: ReportTestInput): boolean {
  return test.results.some((result) => result.attachments.some((attachment) => attachment.contentType.startsWith('image/')));
}

async function publishAttempts(inputs: readonly LiveGalleryAttemptInput[]): Promise<LiveGalleryHead | null> {
  const publishable = inputs.filter(({ test }) => hasPublishableImage(test));
  if (publishable.length === 0) return null;
  const outputDir = path.resolve(publishable[0]!.outputDir);
  if (publishable.some((input) => path.resolve(input.outputDir) !== outputDir)) {
    throw new Error('A live gallery publication batch cannot span output directories.');
  }
  const liveRoot = path.join(outputDir, 'gallery-live');
  const revisionRoot = path.join(liveRoot, 'revisions');
  await mkdir(revisionRoot, { recursive: true });
  const incoming = imageOnlyCatalog(await buildGalleryCatalog({
    outputDir,
    tests: publishable.map(({ test }) => closedAttemptTest(test)),
    definitionCatalog: ALL_AUDIT_CATALOG,
  }));
  const sourceShard = publishable[0]!.test.sourceShard ?? null;
  const requestPath = path.join(liveRoot, `.publish-${process.pid}-${randomUUID()}.json`);
  await writeFile(requestPath, `${JSON.stringify({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    operation: 'publish-live-attempt',
    galleryRoot: liveRoot,
    sourceShard,
    incoming,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'live-gallery-publish.mjs');
  try {
    const { stdout } = await execFileAsync(process.execPath, [helper, '--request', requestPath], {
      cwd: outputDir,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '') as LiveGalleryHead;
  } catch (error) {
    const detail = error as Error & { stderr?: string };
    throw new Error(`Live gallery publication failed: ${detail.stderr?.trim() || detail.message}`, { cause: error });
  }
}

export async function publishLiveGalleryAttempt(input: LiveGalleryAttemptInput): Promise<void> {
  const key = path.resolve(input.outputDir);
  const prior = publicationQueues.get(key) ?? Promise.resolve();
  const current = prior.then(async () => {
    const head = await publishAttempts([input]);
    if (!head) return;
    process.stdout.write(`[GALLERY_LIVE] ${JSON.stringify({
      event: 'attempt-published',
      contentRevision: head.contentRevision,
      items: head.primaryCounts.total,
      sourceShard: head.sourceShard,
      testId: input.test.id,
      retry: input.test.results.at(-1)?.retry ?? null,
    })}\n`);
  });
  publicationQueues.set(key, current.catch(() => undefined));
  await current;
}

async function publishLiveGalleryBatch(inputs: readonly LiveGalleryAttemptInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const key = path.resolve(inputs[0]!.outputDir);
  const prior = publicationQueues.get(key) ?? Promise.resolve();
  const current = prior.then(async () => {
    const head = await publishAttempts(inputs);
    if (!head) return;
    process.stdout.write(`[GALLERY_LIVE] ${JSON.stringify({
      event: 'attempt-batch-published',
      contentRevision: head.contentRevision,
      items: head.primaryCounts.total,
      sourceShard: head.sourceShard,
      attemptCount: inputs.length,
    })}\n`);
  });
  publicationQueues.set(key, current.catch(() => undefined));
  await current;
}

export default class LiveGalleryReporter implements Reporter {
  private readonly configuredOutputDir: string | undefined;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private sourceShard: ReportTestInput['sourceShard'];
  private pending: LiveGalleryAttemptInput[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private publicationFailure: Error | null = null;

  constructor(options: LiveGalleryReporterOptions = {}) {
    this.configuredOutputDir = options.outputDir;
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 12, 50));
    this.flushIntervalMs = Math.max(100, Math.min(options.flushIntervalMs ?? 750, 5_000));
  }

  onBegin(config: FullConfig): void {
    this.sourceShard = config.shard
      ? { ordinal: config.shard.current, total: config.shard.total }
      : undefined;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const input = {
      outputDir: this.configuredOutputDir ?? process.env.AUDIT_ARTIFACT_DIR ?? './artifacts',
      test: reportTest(test, result, this.sourceShard),
    };
    if (!hasPublishableImage(input.test)) return;
    this.pending.push(input);
    this.scheduleFlush(this.pending.length >= this.batchSize ? 0 : this.flushIntervalMs);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) {
      if (delayMs !== 0) return;
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.pending.splice(0, this.batchSize);
      if (batch.length === 0) return;
      this.flushChain = this.flushChain.then(async () => {
        try {
          await publishLiveGalleryBatch(batch);
        } catch (error) {
          this.publicationFailure = error instanceof Error ? error : new Error(String(error));
          process.stderr.write(`[GALLERY_LIVE] ${JSON.stringify({
            event: 'publication-failed',
            attemptCount: batch.length,
            error: this.publicationFailure.message,
          })}\n`);
        }
      });
      if (this.pending.length > 0) this.scheduleFlush(0);
    }, delayMs);
  }

  async onEnd(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.batchSize);
      this.flushChain = this.flushChain.then(async () => {
        try {
          await publishLiveGalleryBatch(batch);
        } catch (error) {
          this.publicationFailure = error instanceof Error ? error : new Error(String(error));
        }
      });
    }
    await this.flushChain;
    if (this.publicationFailure) throw this.publicationFailure;
  }

  printsToStdio(): boolean {
    return false;
  }
}
