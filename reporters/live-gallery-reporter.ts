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

async function publishAttempt(input: LiveGalleryAttemptInput): Promise<LiveGalleryHead> {
  const outputDir = path.resolve(input.outputDir);
  const liveRoot = path.join(outputDir, 'gallery-live');
  const revisionRoot = path.join(liveRoot, 'revisions');
  await mkdir(revisionRoot, { recursive: true });
  const incoming = imageOnlyCatalog(await buildGalleryCatalog({
    outputDir,
    tests: [closedAttemptTest(input.test)],
    definitionCatalog: ALL_AUDIT_CATALOG,
  }));
  const sourceShard = input.test.sourceShard ?? null;
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
    const head = await publishAttempt(input);
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

export default class LiveGalleryReporter implements Reporter {
  private readonly configuredOutputDir: string | undefined;
  private sourceShard: ReportTestInput['sourceShard'];

  constructor(options: LiveGalleryReporterOptions = {}) {
    this.configuredOutputDir = options.outputDir;
  }

  onBegin(config: FullConfig): void {
    this.sourceShard = config.shard
      ? { ordinal: config.shard.current, total: config.shard.total }
      : undefined;
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    await publishLiveGalleryAttempt({
      outputDir: this.configuredOutputDir ?? process.env.AUDIT_ARTIFACT_DIR ?? './artifacts',
      test: reportTest(test, result, this.sourceShard),
    });
  }

  printsToStdio(): boolean {
    return false;
  }
}
