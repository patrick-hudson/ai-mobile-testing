import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPublicationView, type PublicationView } from '../shared/release-projection.mjs';

export function projectArchiveReleasePublication(value: unknown): PublicationView {
  return projectPublicationView(value);
}

export const ARCHIVE_BUNDLE_VERSION = 3 as const;
export const ARCHIVE_RUNTIME_VERSION = 3 as const;
export const ARCHIVE_MINIMUM_READER_VERSION = 1 as const;
export const ARCHIVE_DATA_SCHEMA_VERSION = 1 as const;
export const ARCHIVE_ASSET_DIRECTORY = `archive-v${ARCHIVE_BUNDLE_VERSION}` as const;

export interface ArchiveBundleContract {
  schemaVersion: 1;
  bundleVersion: typeof ARCHIVE_BUNDLE_VERSION;
  runtimeVersion: typeof ARCHIVE_RUNTIME_VERSION;
  minimumReaderVersion: typeof ARCHIVE_MINIMUM_READER_VERSION;
  dataSchemaVersion: typeof ARCHIVE_DATA_SCHEMA_VERSION;
  assetBase: `assets/${typeof ARCHIVE_ASSET_DIRECTORY}`;
  manifestHref: `assets/${typeof ARCHIVE_ASSET_DIRECTORY}/bundle.json`;
}

export interface ArchiveBundleManifest extends ArchiveBundleContract {
  assets: Record<string, { bytes: number; sha256: string }>;
}

const REPORTERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(REPORTERS_DIR, '..');
const ASSET_SOURCES = Object.freeze([
  ['archive-runtime.js', path.join(REPORTERS_DIR, 'assets', 'archive-runtime.js')],
  ['report.css', path.join(REPORTERS_DIR, 'assets', 'report.css')],
  ['report.js', path.join(REPORTERS_DIR, 'assets', 'report.js')],
  ['release-authority.js', path.join(REPORTERS_DIR, 'assets', 'release-authority.js')],
  ['gallery-archive.css', path.join(REPORTERS_DIR, 'assets', 'gallery-archive.css')],
  ['gallery-archive.js', path.join(REPORTERS_DIR, 'assets', 'gallery-archive.js')],
  ['gallery-loader.js', path.join(REPORTERS_DIR, 'assets', 'gallery-loader.js')],
  ['gallery-core.js', path.join(REPOSITORY_ROOT, 'portal', 'public', 'gallery-core.js')],
  ['gallery.css', path.join(REPOSITORY_ROOT, 'portal', 'public', 'gallery.css')],
] as const);
const ARCHIVE_CORE_LIVE_BOUNDARY = '\nconst SINGLE_SITE_VISUAL_STATES = new Set([';

export interface ArchiveBundleAssetContent {
  name: string;
  source: string;
  bytes: Buffer;
}

export function archiveBundleContract(): ArchiveBundleContract {
  const assetBase = `assets/${ARCHIVE_ASSET_DIRECTORY}` as const;
  return Object.freeze({
    schemaVersion: 1,
    bundleVersion: ARCHIVE_BUNDLE_VERSION,
    runtimeVersion: ARCHIVE_RUNTIME_VERSION,
    minimumReaderVersion: ARCHIVE_MINIMUM_READER_VERSION,
    dataSchemaVersion: ARCHIVE_DATA_SCHEMA_VERSION,
    assetBase,
    manifestHref: `${assetBase}/bundle.json`,
  });
}

async function fileDigest(file: string): Promise<{ bytes: number; sha256: string }> {
  const [source, details] = await Promise.all([readFile(file), stat(file)]);
  return {
    bytes: details.size,
    sha256: createHash('sha256').update(source).digest('hex'),
  };
}

async function sourceAssetBytes(name: string, source: string): Promise<Buffer> {
  const bytes = await readFile(source);
  if (name !== 'gallery-core.js') return bytes;
  const text = bytes.toString('utf8');
  const boundary = text.indexOf(ARCHIVE_CORE_LIVE_BOUNDARY);
  if (boundary < 1) {
    throw new Error('The canonical gallery core no longer exposes the pinned archive/live boundary.');
  }
  const archiveCore = `${text.slice(0, boundary).trimEnd()}\n`;
  if (/\/api\/|EventSource|localStorage|sessionStorage/.test(archiveCore)) {
    throw new Error('The generated archive gallery core contains a live-only dependency.');
  }
  return Buffer.from(archiveCore, 'utf8');
}

export async function archiveBundleAssetContents(): Promise<readonly ArchiveBundleAssetContent[]> {
  return Promise.all(ASSET_SOURCES.map(async ([name, source]) => Object.freeze({
    name,
    source,
    bytes: await sourceAssetBytes(name, source),
  })));
}

async function expectedManifest(assets: readonly ArchiveBundleAssetContent[]): Promise<ArchiveBundleManifest> {
  return {
    ...archiveBundleContract(),
    assets: Object.fromEntries(assets.map(({ name, bytes }) => [name, {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }])),
  };
}

async function verifyPublishedBundle(directory: string, expected: ArchiveBundleManifest): Promise<void> {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('Archive runtime bundle destination is not a real directory.');
  }
  const expectedEntries = [...Object.keys(expected.assets), 'bundle.json'].sort();
  const actualEntries = (await readdir(directory)).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`Archive runtime bundle ${ARCHIVE_BUNDLE_VERSION} contains an unexpected or missing asset.`);
  }
  const manifestPath = path.join(directory, 'bundle.json');
  const manifestDetails = await lstat(manifestPath);
  if (!manifestDetails.isFile() || manifestDetails.isSymbolicLink()) {
    throw new Error(`Archive runtime bundle ${ARCHIVE_BUNDLE_VERSION} manifest is not a real file.`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ArchiveBundleManifest;
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error(`Archive runtime bundle ${ARCHIVE_BUNDLE_VERSION} already exists with different bytes or metadata.`);
  }
  for (const [name, digest] of Object.entries(expected.assets)) {
    const assetPath = path.join(directory, name);
    const assetDetails = await lstat(assetPath);
    if (!assetDetails.isFile() || assetDetails.isSymbolicLink()) {
      throw new Error(`Archive runtime bundle ${ARCHIVE_BUNDLE_VERSION} asset ${name} is not a real file.`);
    }
    const actual = await fileDigest(assetPath);
    if (actual.bytes !== digest.bytes || actual.sha256 !== digest.sha256) {
      throw new Error(`Archive runtime bundle ${ARCHIVE_BUNDLE_VERSION} asset ${name} failed immutable verification.`);
    }
  }
}

export async function ensureArchiveRuntimeBundle(outputDirValue: string): Promise<ArchiveBundleContract> {
  const outputDir = path.resolve(outputDirValue);
  const assetsRoot = path.join(outputDir, 'assets');
  const finalDirectory = path.join(assetsRoot, ARCHIVE_ASSET_DIRECTORY);
  const assets = await archiveBundleAssetContents();
  const expected = await expectedManifest(assets);
  await mkdir(assetsRoot, { recursive: true });
  try {
    await verifyPublishedBundle(finalDirectory, expected);
    return archiveBundleContract();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const stagingDirectory = path.join(
    assetsRoot,
    `.${ARCHIVE_ASSET_DIRECTORY}-${randomUUID()}.staging`,
  );
  await mkdir(stagingDirectory, { recursive: false });
  try {
    await Promise.all(assets.map(({ name, bytes }) => writeFile(path.join(stagingDirectory, name), bytes)));
    await writeFile(path.join(stagingDirectory, 'bundle.json'), `${JSON.stringify(expected)}\n`, 'utf8');
    try {
      await rename(stagingDirectory, finalDirectory);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await verifyPublishedBundle(finalDirectory, expected);
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
  await verifyPublishedBundle(finalDirectory, expected);
  return archiveBundleContract();
}
