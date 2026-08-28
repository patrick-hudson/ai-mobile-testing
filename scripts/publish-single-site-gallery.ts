import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_AUDIT_CATALOG } from '../audit/definitions.js';
import {
  buildGalleryCatalog,
  createAttachmentSourceBoundary,
  writeGalleryArchive,
} from '../reporters/gallery-model.js';
import { collectTests } from './rebuild-report.js';

const MAX_RESULTS_BYTES = 64 * 1_048_576;
const GALLERY_CASE_INDEX_PAGE_ROWS = 100;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publishSingleSiteIndex(
  outputDir: string,
  generatedAt: string,
  descriptor: Record<string, unknown>,
  catalog: Awaited<ReturnType<typeof buildGalleryCatalog>>,
  tests: Awaited<ReturnType<typeof collectTests>>,
): Promise<Record<string, unknown>> {
  const caseByTestId = new Map(tests.map((test) => {
    const values = (test.annotations ?? [])
      .filter(({ type, description }) => type === 'audit-case-id' && typeof description === 'string' && description.trim())
      .map(({ description }) => description as string);
    return [test.id, values.length === 1 ? values[0] : null];
  }));
  const entries = catalog.items.map((item) => ({
    itemId: item.id,
    auditCaseId: caseByTestId.get(item.test.id) ?? null,
    auditIds: item.auditAssociations.map(({ id }) => id).sort(),
    sourceTestId: item.test.id,
    projectName: item.project.name,
    kind: item.kind,
    status: item.attempt.status,
  })).sort((left, right) => left.itemId.localeCompare(right.itemId));
  const pageDocuments: Array<{
    document: Record<string, unknown>;
    reference: {
      ordinal: number;
      itemCount: number;
      firstItemId: string | null;
      lastItemId: string | null;
      pageDigest: string;
      relativePath: string;
    };
  }> = [];
  for (let offset = 0; offset < entries.length; offset += GALLERY_CASE_INDEX_PAGE_ROWS) {
    const pageEntries = entries.slice(offset, offset + GALLERY_CASE_INDEX_PAGE_ROWS);
    const pageBody = {
      schemaVersion: 2,
      kind: 'single-site-gallery-index-page',
      mode: 'single-site',
      exportRevision: descriptor.exportRevision,
      ordinal: pageDocuments.length + 1,
      entries: pageEntries,
    };
    const pageDigest = digest(pageBody);
    pageDocuments.push({
      document: { ...pageBody, pageDigest },
      reference: {
        ordinal: pageBody.ordinal,
        itemCount: pageEntries.length,
        firstItemId: pageEntries[0]?.itemId ?? null,
        lastItemId: pageEntries.at(-1)?.itemId ?? null,
        pageDigest,
        relativePath: `pages/page-${String(pageBody.ordinal).padStart(6, '0')}-${pageDigest}.json`,
      },
    });
  }
  const body = {
    schemaVersion: 2,
    kind: 'single-site-gallery-index',
    mode: 'single-site',
    generatedAt,
    exportRevision: descriptor.exportRevision,
    itemCount: entries.length,
    knownCaseCount: entries.filter(({ auditCaseId }) => auditCaseId !== null).length,
    pages: pageDocuments.map(({ reference }) => reference),
  };
  const document = { ...body, indexDigest: digest(body) };
  const root = path.join(outputDir, 'single-site-gallery-index');
  const revisions = path.join(root, 'revisions');
  await fs.mkdir(revisions, { recursive: true, mode: 0o700 });
  const revisionDirectory = path.join(revisions, document.indexDigest);
  const pagesDirectory = path.join(revisionDirectory, 'pages');
  await fs.mkdir(pagesDirectory, { recursive: true, mode: 0o700 });
  for (const page of pageDocuments) {
    const pageFile = path.join(revisionDirectory, ...page.reference.relativePath.split('/'));
    const pageSource = `${JSON.stringify(page.document)}\n`;
    try {
      const handle = await fs.open(pageFile, 'wx', 0o600);
      try { await handle.writeFile(pageSource); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await fs.readFile(pageFile, 'utf8') !== pageSource) throw new Error('Immutable Single-site gallery index page conflicts with its digest path.');
    }
  }
  await fsyncDirectory(pagesDirectory);
  const revisionFile = path.join(revisionDirectory, 'index.json');
  const source = `${JSON.stringify(document)}\n`;
  try {
    const handle = await fs.open(revisionFile, 'wx', 0o600);
    try { await handle.writeFile(source); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await fs.readFile(revisionFile, 'utf8') !== source) throw new Error('Immutable Single-site gallery index conflicts with its digest path.');
  }
  const pointer = {
    schemaVersion: 2,
    kind: 'single-site-gallery-index-pointer',
    indexDigest: document.indexDigest,
    exportRevision: document.exportRevision,
    relativePath: path.relative(outputDir, revisionFile).split(path.sep).join('/'),
    itemCount: document.itemCount,
  };
  const pointerSource = `${JSON.stringify(pointer)}\n`;
  const temporary = path.join(root, `.current.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const pointerHandle = await fs.open(temporary, 'wx', 0o600);
  try { await pointerHandle.writeFile(pointerSource); await pointerHandle.sync(); } finally { await pointerHandle.close(); }
  await fs.rename(temporary, path.join(root, 'current.json'));
  await fsyncDirectory(root);
  return pointer;
}

function canonicalTimestamp(value: string): string {
  if (new Date(value).toISOString() !== value) throw new TypeError('generatedAt must be a canonical ISO timestamp.');
  return value;
}

async function readResults(artifactRoot: string): Promise<Record<string, unknown>> {
  const resultsPath = path.join(artifactRoot, 'results.json');
  const stat = await fs.lstat(resultsPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RESULTS_BYTES) {
    throw new TypeError('Processed Single-site results must be a bounded regular JSON file.');
  }
  return JSON.parse(await fs.readFile(resultsPath, 'utf8')) as Record<string, unknown>;
}

export async function publishSingleSiteGallery(input: {
  artifactRoot: string;
  outputDir: string;
  generatedAt: string;
}): Promise<Record<string, unknown>> {
  const artifactRoot = path.resolve(input.artifactRoot);
  const outputDir = path.resolve(input.outputDir);
  const generatedAt = canonicalTimestamp(input.generatedAt);
  const sourceBoundary = await createAttachmentSourceBoundary(artifactRoot);
  const results = await readResults(sourceBoundary.realRoot);
  const tests = await collectTests(results as Parameters<typeof collectTests>[0], sourceBoundary);
  const warnings: string[] = [];
  const catalog = await buildGalleryCatalog({
    outputDir,
    tests,
    definitionCatalog: ALL_AUDIT_CATALOG,
    sourceRoot: sourceBoundary.realRoot,
    warnings,
  });
  const descriptor = await writeGalleryArchive({ outputDir, catalog, exportedAt: generatedAt });
  const index = await publishSingleSiteIndex(
    outputDir,
    generatedAt,
    descriptor as unknown as Record<string, unknown>,
    catalog,
    tests,
  );
  return {
    schemaVersion: 1,
    kind: 'single-site-gallery-publication',
    mode: 'single-site',
    generatedAt,
    source: {
      processedArtifactRoot: sourceBoundary.realRoot,
      testCount: tests.length,
    },
    descriptor,
    index,
    warnings,
  };
}

function option(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const artifactRoot = option(argv, '--artifact-root');
  const outputDir = option(argv, '--output-dir');
  const generatedAt = option(argv, '--generated-at');
  if (!artifactRoot || !outputDir || !generatedAt) {
    throw new Error('Usage: publish-single-site-gallery.ts --artifact-root <processed-root> --output-dir <report-checklist-dir> --generated-at <ISO timestamp>');
  }
  const publication = await publishSingleSiteGallery({ artifactRoot, outputDir, generatedAt });
  process.stdout.write(`${JSON.stringify(publication)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
