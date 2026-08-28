import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bracketedAuditIds, isCanonicalAuditId } from '../audit/audit-id.js';
import type { AuditDefinition, AuditEvidenceRecord } from '../audit/types.js';
import {
  GALLERY_CAPTURE_METADATA_CONTENT_TYPE,
  GALLERY_ARCHIVE_CHANNEL,
  GALLERY_DESCRIPTOR_MAX_BYTES,
  GALLERY_FLAG_HISTORY_MAX_BYTES,
  GALLERY_ITEM_DETAIL_MAX_BYTES,
  GALLERY_QUERY_CHUNK_MAX_BYTES,
  GALLERY_QUERY_CHUNK_MAX_ROWS,
  GALLERY_SCHEMA_VERSION,
  assertGalleryFlagHistory,
  assertGalleryArchiveDescriptor,
  assertGalleryCatalog,
  assertGalleryItemDetail,
  assertGalleryQueryRow,
  boundedGalleryText,
  compareGalleryAuditOrder,
  deriveGalleryItemId,
  deriveGalleryMemberId,
  deriveGalleryTestGroupId,
  galleryFlagRevision,
  galleryFlagSnapshot,
  normalizeGalleryRoute,
  primaryGalleryAuditAssociation,
  queryGalleryArchiveRows,
  stableGalleryKey,
  type GalleryAuditAssociation,
  type GalleryArchiveChunkReference,
  type GalleryArchiveDescriptor,
  type GalleryBlob,
  type GalleryCaptureContext,
  type GalleryCaptureMetadata,
  type GalleryCatalog,
  type GalleryItem,
  type GalleryItemDetail,
  type GalleryFlagEvent,
  type GalleryFlagProjection,
  type GalleryMediaKind,
  type GalleryMember,
  type GalleryMemberRole,
  type GalleryQueryIndexRow,
} from '../shared/gallery-contract.mjs';
import type {
  ReportArtifact,
  ReportAttachmentInput,
  ReportResultInput,
  ReportTestInput,
} from './report-model.js';
import {
  archiveBundleContract,
  ensureArchiveRuntimeBundle,
} from './archive-bundle.js';

export interface NormalizedGalleryAttachment {
  attachmentKey: string;
  artifact: ReportArtifact;
  metadata: GalleryCaptureMetadata | null;
  role: GalleryMemberRole;
  comparisonGroup: string | null;
  metadataProvenance: 'producer' | 'legacy-inferred' | 'missing';
  storageLocations: string[];
}

export interface NormalizedGalleryAttempt {
  ordinal: number;
  result: ReportResultInput;
  evidenceRecords: AuditEvidenceRecord[];
  artifacts: ReportArtifact[];
  media: NormalizedGalleryAttachment[];
}

export interface NormalizedGalleryTest {
  source: ReportTestInput;
  auditIds: string[];
  evidenceRecords: AuditEvidenceRecord[];
  attempts: NormalizedGalleryAttempt[];
}

export interface GalleryEvidenceModel {
  catalog: GalleryCatalog;
  tests: NormalizedGalleryTest[];
}

export interface BuildGalleryCatalogOptions {
  outputDir: string;
  tests: ReportTestInput[];
  definitionCatalog?: readonly AuditDefinition[];
  cwd?: string;
  warnings?: string[];
  /** Exact artifact root that attachment sources are permitted to occupy. */
  sourceRoot?: string;
}

export interface WriteGalleryArchiveOptions {
  outputDir: string;
  catalog: GalleryCatalog;
  exportedAt?: string;
  flagSnapshot?: {
    schemaVersion: 1;
    throughEvent: number;
    flagRevision?: string;
    flags: GalleryFlagProjection[] | unknown[];
    events?: GalleryFlagEvent[];
  };
  maxRowsPerChunk?: number;
  maxBytesPerChunk?: number;
  cwd?: string;
}

export interface PreparedGalleryArchive {
  outputDir: string;
  galleryRoot: string;
  stagingDir: string;
  finalDir: string;
  descriptor: GalleryArchiveDescriptor;
  expectedExportRevision: string | null;
  expectedFlagRevision: string;
  flagHistoryPath: string;
}

const execFileAsync = promisify(execFile);
const GALLERY_MATERIALIZATION_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.AUDIT_GALLERY_WORKERS ?? '4') || 4, 8),
);

interface LegacyComparison {
  group: string;
  role: GalleryMemberRole;
}

export interface AttachmentSourceBoundary {
  logicalRoot: string;
  realRoot: string;
}

export class AttachmentSourceContainmentError extends Error {
  override readonly name = 'AttachmentSourceContainmentError';
}

interface OpenedAttachmentSource {
  handle: FileHandle;
  path: string;
  size: number;
  sizeBigInt: bigint;
  modifiedAtNs: bigint;
  device: bigint;
  inode: bigint;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function hasTraversalSegment(value: string): boolean {
  return value.replaceAll('\\', '/').split('/').includes('..');
}

function containmentFailure(message: string): AttachmentSourceContainmentError {
  return new AttachmentSourceContainmentError(`Attachment source rejected: ${message}`);
}

export async function createAttachmentSourceBoundary(root: string): Promise<AttachmentSourceBoundary> {
  const logicalRoot = path.resolve(root);
  let realRoot: string;
  try {
    const logicalDetails = await lstat(logicalRoot);
    if (logicalDetails.isSymbolicLink()) {
      throw containmentFailure('the declared artifact root must not be a symbolic link.');
    }
    realRoot = await realpath(logicalRoot);
  } catch (error) {
    throw containmentFailure(`the run artifact root is unavailable (${error instanceof Error ? error.message : String(error)}).`);
  }
  const details = await lstat(realRoot);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw containmentFailure('the run artifact root must resolve to a real directory.');
  }
  return { logicalRoot, realRoot };
}

async function ensureContainedOutputDirectory(
  directory: string,
  outputBoundary: AttachmentSourceBoundary,
): Promise<void> {
  const resolved = path.resolve(directory);
  if (!isContainedPath(outputBoundary.realRoot, resolved)) {
    throw containmentFailure('the generated evidence destination is outside the report output root.');
  }
  const relative = path.relative(outputBoundary.realRoot, resolved);
  let current = outputBoundary.realRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o750 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw containmentFailure('the generated evidence destination contains a symbolic or non-directory component.');
    }
  }
}

async function openContainedOutputFile(
  destination: string,
  outputBoundary: AttachmentSourceBoundary,
): Promise<FileHandle> {
  const resolved = path.resolve(destination);
  if (!isContainedPath(outputBoundary.realRoot, resolved) || resolved === outputBoundary.realRoot) {
    throw containmentFailure('the generated evidence file is outside the report output root.');
  }
  await ensureContainedOutputDirectory(path.dirname(resolved), outputBoundary);
  try {
    const existing = await lstat(resolved);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw containmentFailure('the generated evidence file destination is symbolic or not a regular file.');
    }
    await rm(resolved, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const handle = await open(
    resolved,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o640,
  );
  try {
    await verifyOpenedOutputFile(handle, resolved, outputBoundary);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyOpenedOutputFile(
  handle: FileHandle,
  destination: string,
  outputBoundary: AttachmentSourceBoundary,
): Promise<void> {
  try {
    await assertNoSymlinkComponents(destination, outputBoundary);
    const [pathDetails, canonicalPath, handleDetails] = await Promise.all([
      lstat(destination),
      realpath(destination),
      handle.stat({ bigint: true }),
    ]);
    if (
      pathDetails.isSymbolicLink()
      || !pathDetails.isFile()
      || !handleDetails.isFile()
      || !isContainedPath(outputBoundary.realRoot, canonicalPath)
      || handleDetails.dev !== BigInt(pathDetails.dev)
      || handleDetails.ino !== BigInt(pathDetails.ino)
    ) {
      throw containmentFailure('the generated evidence file changed identity or escaped the report output root.');
    }
  } catch (error) {
    if (isContainmentError(error)) throw error;
    throw containmentFailure(`the generated evidence file could not be verified (${error instanceof Error ? error.message : String(error)}).`);
  }
}

async function writeContainedOutputFile(
  destination: string,
  body: Uint8Array,
  outputBoundary: AttachmentSourceBoundary,
): Promise<void> {
  const handle = await openContainedOutputFile(destination, outputBoundary);
  try {
    await handle.writeFile(body);
    await handle.sync();
    await verifyOpenedOutputFile(handle, destination, outputBoundary);
  } finally {
    await handle.close();
    // Do not clean up through a pathname whose ancestry may have changed.
    // A verified partial file is safer than following an attacker-swapped path.
  }
}

function resolveContainedAttachmentPath(sourcePath: string, boundary: AttachmentSourceBoundary): string {
  if (!sourcePath || sourcePath.includes('\0')) throw containmentFailure('the declared path is empty or malformed.');
  if (hasTraversalSegment(sourcePath)) throw containmentFailure('path traversal is not allowed.');

  let relative: string;
  if (path.isAbsolute(sourcePath)) {
    const absolute = path.resolve(sourcePath);
    if (isContainedPath(boundary.logicalRoot, absolute)) relative = path.relative(boundary.logicalRoot, absolute);
    else if (isContainedPath(boundary.realRoot, absolute)) relative = path.relative(boundary.realRoot, absolute);
    else throw containmentFailure('an absolute path is outside the run artifact root.');
  } else if (path.win32.isAbsolute(sourcePath)) {
    throw containmentFailure('an absolute path is outside the run artifact root.');
  } else {
    relative = sourcePath;
  }

  const candidate = path.resolve(boundary.realRoot, relative);
  if (candidate === boundary.realRoot || !isContainedPath(boundary.realRoot, candidate)) {
    throw containmentFailure('the declared path is outside the run artifact root.');
  }
  return candidate;
}

async function assertNoSymlinkComponents(candidate: string, boundary: AttachmentSourceBoundary): Promise<void> {
  const relative = path.relative(boundary.realRoot, candidate);
  let current = boundary.realRoot;
  const segments = relative.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const details = await lstat(current);
    if (details.isSymbolicLink()) {
      throw containmentFailure(`symbolic links are not allowed beneath the run artifact root (${relative}).`);
    }
    if (index < segments.length - 1 && !details.isDirectory()) {
      throw containmentFailure(`a non-directory path component was declared (${relative}).`);
    }
  }
}

async function verifyOpenedAttachmentSource(
  source: OpenedAttachmentSource,
  boundary: AttachmentSourceBoundary,
): Promise<void> {
  try {
    await assertNoSymlinkComponents(source.path, boundary);
    const [pathDetails, canonicalPath, handleDetails] = await Promise.all([
      lstat(source.path),
      realpath(source.path),
      source.handle.stat({ bigint: true }),
    ]);
    if (pathDetails.isSymbolicLink() || !pathDetails.isFile() || !handleDetails.isFile()) {
      throw containmentFailure('the declared attachment is not a regular, non-symbolic file.');
    }
    if (!isContainedPath(boundary.realRoot, canonicalPath)) {
      throw containmentFailure('the canonical attachment path is outside the run artifact root.');
    }
    if (handleDetails.dev !== BigInt(pathDetails.dev) || handleDetails.ino !== BigInt(pathDetails.ino)) {
      throw containmentFailure('the attachment path changed while it was being opened.');
    }
    if (handleDetails.dev !== source.device || handleDetails.ino !== source.inode) {
      throw containmentFailure('the opened attachment identity changed unexpectedly.');
    }
  } catch (error) {
    if (isContainmentError(error)) throw error;
    throw containmentFailure(`the opened attachment path could not be revalidated (${error instanceof Error ? error.message : String(error)}).`);
  }
}

async function openContainedAttachmentSource(
  sourcePath: string,
  boundary: AttachmentSourceBoundary,
): Promise<OpenedAttachmentSource> {
  const candidate = resolveContainedAttachmentPath(sourcePath, boundary);
  await assertNoSymlinkComponents(candidate, boundary);
  const canonicalPath = await realpath(candidate);
  if (!isContainedPath(boundary.realRoot, canonicalPath)) {
    throw containmentFailure('the canonical attachment path is outside the run artifact root.');
  }
  const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const details = await handle.stat({ bigint: true });
    if (!details.isFile()) throw containmentFailure('the declared attachment is not a regular file.');
    const source: OpenedAttachmentSource = {
      handle,
      path: candidate,
      size: Number(details.size),
      sizeBigInt: details.size,
      modifiedAtNs: details.mtimeNs,
      device: details.dev,
      inode: details.ino,
    };
    await verifyOpenedAttachmentSource(source, boundary);
    return source;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function validateContainedAttachmentSource(
  sourcePath: string,
  boundaryOrRoot: AttachmentSourceBoundary | string,
): Promise<string> {
  const boundary = typeof boundaryOrRoot === 'string'
    ? await createAttachmentSourceBoundary(boundaryOrRoot)
    : boundaryOrRoot;
  const source = await openContainedAttachmentSource(sourcePath, boundary);
  try {
    await verifyOpenedAttachmentSource(source, boundary);
    return source.path;
  } finally {
    await source.handle.close();
  }
}

function isContainmentError(error: unknown): error is AttachmentSourceContainmentError {
  return error instanceof AttachmentSourceContainmentError;
}

function isMissingSource(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
}

export async function readContainedAttachmentSource(
  sourcePath: string,
  boundaryOrRoot: AttachmentSourceBoundary | string,
  options: { maximumBytes?: number } = {},
): Promise<Buffer> {
  const boundary = typeof boundaryOrRoot === 'string'
    ? await createAttachmentSourceBoundary(boundaryOrRoot)
    : boundaryOrRoot;
  if (
    options.maximumBytes != null
    && (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 0)
  ) {
    throw new RangeError('maximumBytes must be a non-negative safe integer.');
  }
  const source = await openContainedAttachmentSource(sourcePath, boundary);
  try {
    if (options.maximumBytes != null && source.size > options.maximumBytes) {
      throw new Error(`Attachment source exceeds the ${options.maximumBytes}-byte read limit.`);
    }
    const body = await source.handle.readFile();
    if (options.maximumBytes != null && body.byteLength > options.maximumBytes) {
      throw new Error(`Attachment source exceeds the ${options.maximumBytes}-byte read limit.`);
    }
    await verifyOpenedAttachmentSource(source, boundary);
    const after = await source.handle.stat({ bigint: true });
    if (after.size !== source.sizeBigInt || after.mtimeNs !== source.modifiedAtNs) {
      throw containmentFailure('the attachment changed while it was being read.');
    }
    return body;
  } finally {
    await source.handle.close();
  }
}

export async function hashContainedAttachmentSource(
  sourcePath: string,
  boundaryOrRoot: AttachmentSourceBoundary | string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const boundary = typeof boundaryOrRoot === 'string'
    ? await createAttachmentSourceBoundary(boundaryOrRoot)
    : boundaryOrRoot;
  const source = await openContainedAttachmentSource(sourcePath, boundary);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < source.size) {
      const bytesToRead = Math.min(buffer.byteLength, source.size - position);
      const { bytesRead } = await source.handle.read(buffer, 0, bytesToRead, position);
      if (bytesRead === 0) throw containmentFailure('the attachment changed while it was being hashed.');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if ((await source.handle.read(buffer, 0, 1, source.size)).bytesRead !== 0) {
      throw containmentFailure('the attachment changed while it was being hashed.');
    }
    await verifyOpenedAttachmentSource(source, boundary);
    const after = await source.handle.stat({ bigint: true });
    if (after.size !== source.sizeBigInt || after.mtimeNs !== source.modifiedAtNs) {
      throw containmentFailure('the attachment changed while it was being hashed.');
    }
    return { sha256: hash.digest('hex'), sizeBytes: source.size };
  } finally {
    await source.handle.close();
  }
}

async function copyContainedAttachmentSource(
  sourcePath: string,
  destination: string,
  boundary: AttachmentSourceBoundary,
  outputBoundary: AttachmentSourceBoundary,
): Promise<void> {
  const source = await openContainedAttachmentSource(sourcePath, boundary);
  const destinationHandle = await openContainedOutputFile(destination, outputBoundary);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < source.size) {
      const bytesToRead = Math.min(buffer.byteLength, source.size - position);
      const { bytesRead } = await source.handle.read(buffer, 0, bytesToRead, position);
      if (bytesRead === 0) throw containmentFailure('the attachment changed while it was being copied.');
      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        const writeResult = await destinationHandle.write(
          buffer,
          bytesWritten,
          bytesRead - bytesWritten,
          position + bytesWritten,
        );
        if (writeResult.bytesWritten === 0) throw new Error('The gallery evidence destination stopped accepting bytes.');
        bytesWritten += writeResult.bytesWritten;
      }
      position += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await source.handle.read(extra, 0, 1, source.size)).bytesRead !== 0) {
      throw containmentFailure('the attachment changed while it was being copied.');
    }
    await verifyOpenedAttachmentSource(source, boundary);
    const after = await source.handle.stat({ bigint: true });
    if (after.size !== source.sizeBigInt || after.mtimeNs !== source.modifiedAtNs) {
      throw containmentFailure('the attachment changed while it was being copied.');
    }
    await destinationHandle.sync();
    await verifyOpenedOutputFile(destinationHandle, destination, outputBoundary);
  } finally {
    await Promise.allSettled([source.handle.close(), destinationHandle.close()]);
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  requestedConcurrency: number,
  task: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  const concurrency = Math.max(1, Math.min(values.length || 1, requestedConcurrency));
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) output[index] = await task(value, index);
    }
  }));
  const failure = workers.find((worker): worker is PromiseRejectedResult => worker.status === 'rejected');
  if (failure) throw failure.reason;
  return output;
}

function safeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return cleaned || 'item';
}

function attachmentKind(name: string, contentType: string): ReportArtifact['kind'] {
  const haystack = `${name} ${contentType}`.toLowerCase();
  if (contentType.startsWith('video/') || haystack.includes('video')) return 'video';
  if (contentType.startsWith('image/') || haystack.includes('screenshot')) return 'screenshot';
  if (haystack.includes('trace') || contentType === 'application/zip') return 'trace';
  if (haystack.includes('axe') || haystack.includes('accessibility')) return 'axe';
  if (haystack.includes('lighthouse')) return 'lighthouse';
  if (/network|\bhar\b|header|redirect|route-inventory|endpoint|sitemap|request|response|asset/.test(haystack)) return 'network';
  if (contentType.includes('json') || name.toLowerCase().endsWith('.json')) return 'json';
  return 'other';
}

function galleryMediaKind(attachment: ReportAttachmentInput): GalleryMediaKind | null {
  if (attachment.contentType.startsWith('image/')) return 'image';
  if (attachment.contentType.startsWith('video/')) return 'video';
  return null;
}

function isGeneratedPosterAttachment(
  attachment: ReportAttachmentInput,
  allAttachments: ReportAttachmentInput[],
): boolean {
  if (!attachment.contentType.startsWith('image/') || !attachment.path) return false;
  const imagePath = path.resolve(attachment.path);
  return allAttachments.some((candidate) => {
    if (!candidate.contentType.startsWith('video/') || !candidate.path) return false;
    const videoPath = path.resolve(candidate.path);
    const extension = path.extname(videoPath);
    return imagePath === path.join(path.dirname(videoPath), `${path.basename(videoPath, extension)}-poster.jpg`);
  });
}

function extensionFor(attachment: ReportAttachmentInput): string {
  if (attachment.path) {
    const extension = path.extname(attachment.path);
    if (extension) return extension;
  }
  const contentType = attachment.contentType.split(';')[0]?.trim();
  const extensions: Record<string, string> = {
    'application/json': '.json',
    'application/zip': '.zip',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'text/html': '.html',
    'text/plain': '.txt',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
  };
  return extensions[contentType ?? ''] ?? '';
}

async function sha256File(file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readAttachment(
  attachment: ReportAttachmentInput,
  sourceBoundary: AttachmentSourceBoundary,
  maximumBytes: number,
): Promise<Buffer | null> {
  if (attachment.body) {
    if (attachment.body.byteLength > maximumBytes) {
      throw new Error(`Attachment ${attachment.name} exceeds the ${maximumBytes}-byte structured read limit.`);
    }
    return attachment.body;
  }
  if (!attachment.path) return null;
  try {
    return await readContainedAttachmentSource(attachment.path, sourceBoundary, { maximumBytes });
  } catch (error) {
    if (isContainmentError(error) || !isMissingSource(error)) throw error;
    return null;
  }
}

async function attachmentDigest(
  attachment: ReportAttachmentInput,
  sourceBoundary: AttachmentSourceBoundary,
): Promise<string | null> {
  if (attachment.body) return createHash('sha256').update(attachment.body).digest('hex');
  if (!attachment.path) return null;
  try {
    return (await hashContainedAttachmentSource(attachment.path, sourceBoundary)).sha256;
  } catch (error) {
    if (isContainmentError(error) || !isMissingSource(error)) throw error;
    return null;
  }
}

function isEvidenceRecord(value: unknown): value is AuditEvidenceRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<AuditEvidenceRecord>;
  return (
    record.schemaVersion === 1
    && typeof record.auditId === 'string'
    && (record.environment === 'production' || record.environment === 'candidate')
    && Array.isArray(record.steps)
    && Array.isArray(record.observations)
    && Array.isArray(record.findings)
  );
}

async function evidenceRecords(
  attachments: ReportAttachmentInput[],
  sourceBoundary: AttachmentSourceBoundary,
): Promise<AuditEvidenceRecord[]> {
  const records: AuditEvidenceRecord[] = [];
  for (const attachment of attachments) {
    if (!attachment.contentType.includes('json') && !attachment.name.toLowerCase().includes('audit-result')) continue;
    if (attachment.contentType === GALLERY_CAPTURE_METADATA_CONTENT_TYPE) continue;
    const buffer = await readAttachment(attachment, sourceBoundary, 16 * 1024 * 1024);
    if (!buffer) continue;
    try {
      const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
      if (isEvidenceRecord(parsed)) records.push(parsed);
      if (Array.isArray(parsed)) records.push(...parsed.filter(isEvidenceRecord));
    } catch {
      // Malformed structured evidence is handled by the existing audit status path.
    }
  }
  return records;
}

function annotationAuditIds(test: ReportTestInput): string[] {
  const ids = new Set<string>();
  for (const annotation of test.annotations ?? []) {
    if (['audit', 'audit-id', 'auditId'].includes(annotation.type) && annotation.description) {
      const description = annotation.description.trim();
      if (isCanonicalAuditId(description)) ids.add(description);
      for (const auditId of bracketedAuditIds(description)) ids.add(auditId);
    }
  }
  for (const source of [test.title, ...test.titlePath, ...(test.tags ?? [])]) {
    for (const auditId of bracketedAuditIds(source)) ids.add(auditId);
  }
  return [...ids];
}

function normalizeCaptureMetadata(value: unknown): GalleryCaptureMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<GalleryCaptureMetadata>;
  if (
    candidate.schemaVersion !== GALLERY_SCHEMA_VERSION
    || typeof candidate.attachmentName !== 'string'
    || !Number.isInteger(candidate.attachmentOccurrence)
    || (candidate.attachmentOccurrence ?? -1) < 0
  ) return null;
  const metadata: GalleryCaptureMetadata = {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    attachmentName: candidate.attachmentName,
    attachmentOccurrence: candidate.attachmentOccurrence!,
  };
  const attachmentKey = boundedGalleryText(candidate.attachmentKey, 300);
  const comparisonGroup = boundedGalleryText(candidate.comparisonGroup, 300);
  const capturedAt = typeof candidate.capturedAt === 'string' && !Number.isNaN(Date.parse(candidate.capturedAt))
    ? new Date(candidate.capturedAt).toISOString()
    : null;
  const route = normalizeGalleryRoute(candidate.route);
  const observedState = boundedGalleryText(candidate.observedState);
  const rationale = boundedGalleryText(candidate.rationale);
  const derivativeOf = boundedGalleryText(candidate.derivativeOf, 300);
  if (attachmentKey) metadata.attachmentKey = attachmentKey;
  if (comparisonGroup) metadata.comparisonGroup = comparisonGroup;
  if (candidate.memberRole && ['baseline', 'actual', 'diff', 'other'].includes(candidate.memberRole)) {
    metadata.memberRole = candidate.memberRole;
  }
  if (capturedAt) metadata.capturedAt = capturedAt;
  if (route) metadata.route = route;
  if (observedState) metadata.observedState = observedState;
  if (rationale) metadata.rationale = rationale;
  if (
    candidate.viewport
    && Number.isFinite(candidate.viewport.width)
    && Number.isFinite(candidate.viewport.height)
    && candidate.viewport.width > 0
    && candidate.viewport.height > 0
  ) metadata.viewport = { width: candidate.viewport.width, height: candidate.viewport.height };
  if (derivativeOf) metadata.derivativeOf = derivativeOf;
  return metadata;
}

async function captureMetadataIndex(
  attachments: ReportAttachmentInput[],
  sourceBoundary: AttachmentSourceBoundary,
): Promise<Map<string, GalleryCaptureMetadata>> {
  const metadata = new Map<string, GalleryCaptureMetadata>();
  for (const attachment of attachments) {
    if (attachment.contentType !== GALLERY_CAPTURE_METADATA_CONTENT_TYPE) continue;
    const buffer = await readAttachment(attachment, sourceBoundary, 1024 * 1024);
    if (!buffer) continue;
    try {
      const parsed = normalizeCaptureMetadata(JSON.parse(buffer.toString('utf8')) as unknown);
      if (parsed) metadata.set(`${parsed.attachmentName}\u0000${parsed.attachmentOccurrence}`, parsed);
    } catch {
      // Invalid capture metadata never grants an attachment gallery authority.
    }
  }
  return metadata;
}

function inferLegacyComparison(name: string): LegacyComparison | null {
  const normalized = name.toLowerCase().replace(/\.(?:png|jpe?g|webp)$/i, '');
  const playwright = normalized.match(/^(.*?)(?:[-_.](expected|baseline|actual|diff))$/);
  if (playwright?.[1] && playwright[2]) {
    return {
      group: playwright[1],
      role: playwright[2] === 'expected' ? 'baseline' : playwright[2] as GalleryMemberRole,
    };
  }
  if (/^paired-production-light$/.test(normalized)) return { group: 'paired-light', role: 'baseline' };
  if (/^paired-candidate-light$/.test(normalized)) return { group: 'paired-light', role: 'actual' };
  if (/^paired-difference-overlay$/.test(normalized)) return { group: 'paired-light', role: 'diff' };
  if (/^paired-production-vs-candidate$/.test(normalized)) return { group: 'paired-light', role: 'other' };
  return null;
}

async function processedPosterIndex(
  sourceBoundary: AttachmentSourceBoundary,
  warnings: string[],
): Promise<Map<string, string>> {
  const candidates = new Set([path.join(sourceBoundary.realRoot, 'video-manifest.json')]);
  const posters = new Map<string, string>();
  for (const manifestPath of candidates) {
    let document: unknown;
    try {
      document = JSON.parse((await readContainedAttachmentSource(
        manifestPath,
        sourceBoundary,
        { maximumBytes: 32 * 1024 * 1024 },
      )).toString('utf8')) as unknown;
    } catch (error) {
      if (isContainmentError(error)) throw error;
      if (!isMissingSource(error)) {
        warnings.push(`Could not read processed video manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    if (!document || typeof document !== 'object' || !Array.isArray((document as { videos?: unknown }).videos)) {
      warnings.push(`Processed video manifest ${manifestPath} does not contain a videos array.`);
      continue;
    }
    for (const entry of (document as { videos: unknown[] }).videos) {
      if (!entry || typeof entry !== 'object') continue;
      const { sha256, poster } = entry as { sha256?: unknown; poster?: unknown };
      if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256) || typeof poster !== 'string') continue;
      const sourcePoster = resolveContainedAttachmentPath(poster, sourceBoundary);
      if (!posters.has(sha256)) posters.set(sha256, sourcePoster);
    }
  }
  return posters;
}

async function materializeVideoPoster(
  attachment: ReportAttachmentInput,
  videoDestination: string,
  outputDir: string,
  videoSha256: string,
  postersByVideoHash: ReadonlyMap<string, string>,
  sourceBoundary: AttachmentSourceBoundary,
  outputBoundary: AttachmentSourceBoundary,
): Promise<Pick<ReportArtifact, 'poster' | 'posterError'>> {
  if (!attachment.path) return {};
  const sourceExtension = path.extname(attachment.path);
  const sourcePoster = path.join(path.dirname(attachment.path), `${path.basename(attachment.path, sourceExtension)}-poster.jpg`);
  let sourcePosterPath: string | undefined;
  try {
    sourcePosterPath = await validateContainedAttachmentSource(sourcePoster, sourceBoundary);
  } catch (error) {
    if (isContainmentError(error)) throw error;
    if (!isMissingSource(error)) throw error;
    // A sibling is optional; merged blob reports can resolve by video checksum.
  }
  sourcePosterPath ??= postersByVideoHash.get(videoSha256);
  if (!sourcePosterPath) return {};
  const destinationExtension = path.extname(videoDestination);
  const destinationPoster = path.join(path.dirname(videoDestination), `${path.basename(videoDestination, destinationExtension)}-poster.jpg`);
  try {
    await copyContainedAttachmentSource(sourcePosterPath, destinationPoster, sourceBoundary, outputBoundary);
    const details = await hashContainedAttachmentSource(destinationPoster, outputBoundary);
    return {
      poster: {
        name: `${attachment.name} poster`,
        contentType: 'image/jpeg',
        href: path.relative(outputDir, destinationPoster).split(path.sep).join('/'),
        sourcePath: path.relative(sourceBoundary.realRoot, sourcePosterPath).split(path.sep).join('/'),
        sizeBytes: details.sizeBytes,
        sha256: details.sha256,
      },
    };
  } catch (error) {
    if (isContainmentError(error)) throw error;
    return { posterError: error instanceof Error ? error.message : String(error) };
  }
}

async function materializeAttachment(
  attachment: ReportAttachmentInput,
  outputDir: string,
  destinationDir: string,
  index: number,
  postersByVideoHash: ReadonlyMap<string, string>,
  sourceBoundary: AttachmentSourceBoundary,
  outputBoundary: AttachmentSourceBoundary,
): Promise<ReportArtifact> {
  const kind = attachmentKind(attachment.name, attachment.contentType);
  const extension = extensionFor(attachment);
  const originalName = attachment.path ? path.basename(attachment.path, path.extname(attachment.path)) : attachment.name;
  const filename = `${String(index + 1).padStart(2, '0')}-${safeSegment(originalName)}${extension}`;
  const destination = path.join(destinationDir, filename);
  const href = path.relative(outputDir, destination).split(path.sep).join('/');
  const base = {
    name: attachment.name,
    kind,
    contentType: attachment.contentType,
    href,
    sourcePath: attachment.path
      ? path.relative(
          sourceBoundary.realRoot,
          resolveContainedAttachmentPath(attachment.path, sourceBoundary),
        ).split(path.sep).join('/')
      : null,
  } satisfies Omit<ReportArtifact, 'available' | 'sizeBytes' | 'sha256'>;
  try {
    await ensureContainedOutputDirectory(destinationDir, outputBoundary);
    if (attachment.body) await writeContainedOutputFile(destination, attachment.body, outputBoundary);
    else if (attachment.path) {
      await copyContainedAttachmentSource(attachment.path, destination, sourceBoundary, outputBoundary);
    } else throw new Error('Attachment has neither a path nor a body.');
    const details = await hashContainedAttachmentSource(destination, outputBoundary);
    const sha256 = details.sha256;
    const poster = kind === 'video' && attachment.path
      ? await materializeVideoPoster(
          attachment,
          destination,
          outputDir,
          sha256,
          postersByVideoHash,
          sourceBoundary,
          outputBoundary,
        )
      : {};
    return { ...base, available: true, sizeBytes: details.sizeBytes, sha256, ...poster };
  } catch (error) {
    if (isContainmentError(error)) throw error;
    return {
      ...base,
      href: null,
      available: false,
      sizeBytes: null,
      sha256: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function mediaStorageLocations(
  attachments: ReportAttachmentInput[],
  artifact: ReportArtifact,
  sourceBoundary: AttachmentSourceBoundary,
): string[] {
  return [...new Set([
    ...attachments.flatMap((attachment) => attachment.path ? [
      path.relative(
        sourceBoundary.realRoot,
        resolveContainedAttachmentPath(attachment.path, sourceBoundary),
      ).split(path.sep).join('/'),
    ] : []),
    ...(artifact.href ? [artifact.href] : []),
  ])].sort();
}

async function normalizeAttempt(
  test: ReportTestInput,
  result: ReportResultInput,
  ordinal: number,
  outputDir: string,
  postersByVideoHash: ReadonlyMap<string, string>,
  sourceBoundary: AttachmentSourceBoundary,
  outputBoundary: AttachmentSourceBoundary,
): Promise<NormalizedGalleryAttempt> {
  const metadataByOccurrence = await captureMetadataIndex(result.attachments, sourceBoundary);
  const nameOccurrences = new Map<string, number>();
  const logicalAttachments = new Map<string, {
    attachmentKey: string;
    attachment: ReportAttachmentInput;
    metadata: GalleryCaptureMetadata | null;
    role: GalleryMemberRole;
    comparisonGroup: string | null;
    metadataProvenance: NormalizedGalleryAttachment['metadataProvenance'];
    copies: ReportAttachmentInput[];
  }>();
  const reportable = result.attachments.filter((attachment) => {
    if (attachment.contentType === GALLERY_CAPTURE_METADATA_CONTENT_TYPE) return false;
    if (isGeneratedPosterAttachment(attachment, result.attachments)) return false;
    if (attachment.contentType.startsWith('video/') && result.status === 'skipped') return false;
    if (
      attachment.contentType.startsWith('video/')
      && (attachment.mediaValidation === 'rejected' || attachment.mediaValidation === 'pending')
    ) return false;
    return true;
  });
  for (const attachment of reportable) {
    const occurrence = nameOccurrences.get(attachment.name) ?? 0;
    nameOccurrences.set(attachment.name, occurrence + 1);
    const metadata = metadataByOccurrence.get(`${attachment.name}\u0000${occurrence}`) ?? null;
    if (metadata?.derivativeOf) continue;
    const legacy = metadata ? null : inferLegacyComparison(attachment.name);
    let attachmentKey = metadata?.attachmentKey ?? `${attachment.name}#${occurrence}`;
    let key = `${attachmentKind(attachment.name, attachment.contentType)}\u0000${attachmentKey}`;
    const existing = logicalAttachments.get(key);
    if (existing) {
      const [existingDigest, candidateDigest] = await Promise.all([
        attachmentDigest(existing.attachment, sourceBoundary),
        attachmentDigest(attachment, sourceBoundary),
      ]);
      if (existingDigest && existingDigest === candidateDigest) {
        existing.copies.push(attachment);
        continue;
      }
      attachmentKey = `${attachmentKey}#conflict-${occurrence}`;
      key = `${attachmentKind(attachment.name, attachment.contentType)}\u0000${attachmentKey}`;
    }
    logicalAttachments.set(key, {
      attachmentKey,
      attachment,
      metadata,
      role: metadata?.memberRole ?? legacy?.role ?? (galleryMediaKind(attachment) ? 'single' : 'unknown'),
      comparisonGroup: metadata?.comparisonGroup ?? legacy?.group ?? null,
      metadataProvenance: metadata ? 'producer' : legacy ? 'legacy-inferred' : 'missing',
      copies: [attachment],
    });
  }
  const destinationDir = path.join(
    outputDir,
    'evidence',
    'source',
    safeSegment(test.projectName || 'unknown-project'),
    `${safeSegment(test.id)}-${stableGalleryKey({ sourceTestId: test.id, project: test.projectName }).slice(0, 10)}`,
    `attempt-${result.retry + 1}`,
  );
  const normalized: NormalizedGalleryAttachment[] = [];
  const artifacts: ReportArtifact[] = [];
  let materializedIndex = 0;
  for (const entry of logicalAttachments.values()) {
    const artifact = await materializeAttachment(
      entry.attachment,
      outputDir,
      destinationDir,
      materializedIndex,
      postersByVideoHash,
      sourceBoundary,
      outputBoundary,
    );
    materializedIndex += 1;
    artifacts.push(artifact);
    if (!galleryMediaKind(entry.attachment)) continue;
    normalized.push({
      attachmentKey: entry.attachmentKey,
      artifact,
      metadata: entry.metadata,
      role: entry.role,
      comparisonGroup: entry.comparisonGroup,
      metadataProvenance: entry.metadataProvenance,
      storageLocations: mediaStorageLocations(entry.copies, artifact, sourceBoundary),
    });
  }
  return {
    ordinal,
    result,
    evidenceRecords: await evidenceRecords(result.attachments, sourceBoundary),
    artifacts,
    media: normalized,
  };
}

function auditAssociations(
  auditIds: string[],
  definitionCatalog: readonly AuditDefinition[],
  records: AuditEvidenceRecord[],
): GalleryAuditAssociation[] {
  const catalogOrdinal = new Map(definitionCatalog.map((definition, index) => [definition.id, index]));
  const definitions = new Map(definitionCatalog.map((definition) => [definition.id, definition]));
  for (const record of records) {
    if (record.definition && !definitions.has(record.auditId)) definitions.set(record.auditId, record.definition);
  }
  return auditIds.map((id) => {
    const definition = definitions.get(id);
    return {
      id,
      title: definition?.title ?? id,
      expected: definition?.expected ?? 'Review the originating test expectation.',
      featureSuite: definition?.area ?? 'unmapped',
      catalogOrdinal: catalogOrdinal.get(id) ?? null,
    };
  }).sort((left, right) => {
    const ordinal = (left.catalogOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.catalogOrdinal ?? Number.MAX_SAFE_INTEGER);
    return ordinal === 0 ? left.id.localeCompare(right.id) : ordinal;
  });
}

function captureContext(
  attachments: NormalizedGalleryAttachment[],
  test: ReportTestInput,
): GalleryCaptureContext {
  const explicit = (
    attachments.find(({ metadata, role }) => metadata !== null && role === 'actual')
    ?? attachments.find(({ metadata }) => metadata !== null)
  )?.metadata ?? null;
  if (explicit) {
    return {
      route: normalizeGalleryRoute(explicit.route),
      viewport: explicit.viewport ?? null,
      capturedAt: explicit.capturedAt ?? null,
      observedState: boundedGalleryText(explicit.observedState),
      rationale: boundedGalleryText(explicit.rationale),
      provenance: 'producer',
    };
  }
  if (attachments.some(({ metadataProvenance }) => metadataProvenance === 'legacy-inferred')) {
    return {
      route: null,
      viewport: null,
      capturedAt: null,
      observedState: null,
      rationale: null,
      provenance: 'legacy-inferred',
    };
  }
  const policy = test.annotations?.find(({ type }) => type === 'audit-evidence-policy')?.description;
  if (policy) {
    try {
      const parsed = JSON.parse(policy) as { rationale?: unknown };
      const rationale = boundedGalleryText(parsed.rationale);
      if (rationale) {
        return {
          route: null,
          viewport: null,
          capturedAt: null,
          observedState: null,
          rationale,
          provenance: 'test-policy',
        };
      }
    } catch {
      // Invalid evidence policy is already a REVIEW condition in the audit model.
    }
  }
  return {
    route: null,
    viewport: null,
    capturedAt: null,
    observedState: null,
    rationale: null,
    provenance: 'missing',
  };
}

function memberFromAttachment(
  itemId: string,
  attachment: NormalizedGalleryAttachment,
  blobId: string | null,
): GalleryMember {
  return {
    id: deriveGalleryMemberId(itemId, attachment.attachmentKey),
    attachmentKey: attachment.attachmentKey,
    name: attachment.artifact.name,
    role: attachment.role,
    contentType: attachment.artifact.contentType,
    blobId,
    available: attachment.artifact.available,
    error: attachment.artifact.error ?? null,
    poster: attachment.artifact.poster ? {
      name: attachment.artifact.poster.name,
      href: attachment.artifact.poster.href,
      contentType: attachment.artifact.poster.contentType,
      sizeBytes: attachment.artifact.poster.sizeBytes,
      sha256: attachment.artifact.poster.sha256,
    } : null,
  };
}

function itemBase(
  test: NormalizedGalleryTest,
  attempt: NormalizedGalleryAttempt,
  definitionCatalog: readonly AuditDefinition[],
): Omit<GalleryItem, 'id' | 'kind' | 'members' | 'comparison' | 'capture'> {
  const firstRecord = attempt.evidenceRecords[0] ?? test.evidenceRecords[0] ?? null;
  const projectEnvironment = test.source.projectMetadata && 'environment' in test.source.projectMetadata
    ? test.source.projectMetadata.environment
    : undefined;
  return {
    test: {
      id: test.source.id,
      title: test.source.title,
      titlePath: test.source.titlePath,
      file: test.source.file,
      line: test.source.line ?? null,
      column: test.source.column ?? null,
      technicalSuite: test.source.titlePath.slice(0, -1).join(' › ') || test.source.file,
    },
    attempt: {
      ordinal: attempt.ordinal,
      retry: attempt.result.retry,
      status: attempt.result.status,
      expectedStatus: attempt.result.expectedStatus ?? null,
      startedAt: attempt.result.startedAt ?? null,
      durationMs: attempt.result.duration,
    },
    project: {
      name: test.source.projectName,
      environment: firstRecord?.environment ?? projectEnvironment ?? 'unknown',
      browser: firstRecord?.browser ?? test.source.projectMetadata?.browserLabel ?? test.source.projectName,
      deviceClass: test.source.projectMetadata?.deviceClass ?? 'unknown',
    },
    auditAssociations: auditAssociations(test.auditIds, definitionCatalog, test.evidenceRecords),
    provenance: { sourceShard: test.source.sourceShard ?? null },
  };
}

function addBlob(
  blobs: Map<string, GalleryBlob>,
  attachment: NormalizedGalleryAttachment,
  kind: GalleryMediaKind,
): string | null {
  const artifact = attachment.artifact;
  if (!artifact.available || !artifact.sha256 || !artifact.href || artifact.sizeBytes === null) return null;
  const blobId = `gblob_${artifact.sha256}`;
  const existing = blobs.get(blobId);
  if (existing) {
    existing.storageLocations = [...new Set([...existing.storageLocations, ...attachment.storageLocations])].sort();
    return blobId;
  }
  blobs.set(blobId, {
    id: blobId,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    contentType: artifact.contentType,
    kind,
    href: artifact.href,
    storageLocations: [...attachment.storageLocations],
  });
  return blobId;
}

function catalogFromNormalized(
  tests: NormalizedGalleryTest[],
  definitionCatalog: readonly AuditDefinition[],
): GalleryCatalog {
  const blobs = new Map<string, GalleryBlob>();
  const items: GalleryItem[] = [];
  for (const test of tests) {
    for (const attempt of test.attempts) {
      const base = itemBase(test, attempt, definitionCatalog);
      const comparisonGroups = new Map<string, NormalizedGalleryAttachment[]>();
      const singles: NormalizedGalleryAttachment[] = [];
      for (const attachment of attempt.media) {
        if (!attachment.comparisonGroup || !attachment.artifact.contentType.startsWith('image/')) {
          singles.push(attachment);
          continue;
        }
        const group = comparisonGroups.get(attachment.comparisonGroup) ?? [];
        group.push(attachment);
        comparisonGroups.set(attachment.comparisonGroup, group);
      }
      for (const [groupKey, members] of comparisonGroups) {
        const memberOrder: Record<GalleryMemberRole, number> = {
          baseline: 0,
          actual: 1,
          diff: 2,
          other: 3,
          single: 4,
          unknown: 5,
        };
        members.sort((left, right) => memberOrder[left.role] - memberOrder[right.role]
          || left.attachmentKey.localeCompare(right.attachmentKey));
        const roles = members.map(({ role }) => role);
        const ambiguous = roles.some((role, index) => role !== 'other' && roles.indexOf(role) !== index);
        if (ambiguous || members.length < 2) {
          singles.push(...members);
          continue;
        }
        const itemKey = `comparison:${groupKey}`;
        const itemId = deriveGalleryItemId({
          sourceTestId: test.source.id,
          project: test.source.projectName,
          attempt: attempt.ordinal,
          retry: attempt.result.retry,
          attachmentKey: itemKey,
        });
        items.push({
          ...base,
          id: itemId,
          kind: 'image',
          members: members.map((attachment) => memberFromAttachment(itemId, attachment, addBlob(blobs, attachment, 'image'))),
          comparison: {
            key: groupKey,
            complete: ['baseline', 'actual', 'diff'].every((role) => roles.includes(role as GalleryMemberRole)),
          },
          capture: captureContext(members, test.source),
        });
      }
      for (const attachment of singles) {
        const kind = attachment.artifact.contentType.startsWith('video/') ? 'video' : 'image';
        const itemId = deriveGalleryItemId({
          sourceTestId: test.source.id,
          project: test.source.projectName,
          attempt: attempt.ordinal,
          retry: attempt.result.retry,
          attachmentKey: attachment.attachmentKey,
        });
        items.push({
          ...base,
          id: itemId,
          kind,
          members: [memberFromAttachment(itemId, attachment, addBlob(blobs, attachment, kind))],
          comparison: null,
          capture: captureContext([attachment], test.source),
        });
      }
    }
  }
  items.sort(compareGalleryAuditOrder);
  const catalog: GalleryCatalog = {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    items,
    blobs: [...blobs.values()].sort((left, right) => left.id.localeCompare(right.id)),
    primaryCounts: {
      total: items.length,
      images: items.filter(({ kind }) => kind === 'image').length,
      videos: items.filter(({ kind }) => kind === 'video').length,
    },
  };
  return assertGalleryCatalog(catalog);
}

function defaultAttachmentSourceRoot(outputDir: string, cwd: string): string {
  const configuredRoot = process.env.AUDIT_ARTIFACT_DIR?.trim();
  if (configuredRoot) return path.resolve(cwd, configuredRoot);
  return /checklist/i.test(path.basename(outputDir)) ? path.dirname(outputDir) : outputDir;
}

async function preflightAttachmentSources(
  tests: readonly ReportTestInput[],
  sourceBoundary: AttachmentSourceBoundary,
): Promise<void> {
  const paths = [...new Set(tests.flatMap(({ results }) => results.flatMap(({ attachments }) => (
    attachments.flatMap((attachment) => attachment.path ? [attachment.path] : [])
  ))))];
  await mapWithConcurrency(paths, GALLERY_MATERIALIZATION_CONCURRENCY, async (sourcePath) => {
    try {
      await validateContainedAttachmentSource(sourcePath, sourceBoundary);
    } catch (error) {
      if (!isMissingSource(error)) throw error;
      // Missing evidence remains visible as an unavailable artifact. Unsafe
      // evidence aborts publication instead of being downgraded to unavailable.
    }
  });
}

export async function buildGalleryEvidenceModel(options: BuildGalleryCatalogOptions): Promise<GalleryEvidenceModel> {
  const cwd = options.cwd ?? process.cwd();
  const requestedOutputDir = path.resolve(cwd, options.outputDir);
  await mkdir(requestedOutputDir, { recursive: true });
  const outputBoundary = await createAttachmentSourceBoundary(requestedOutputDir);
  const outputDir = outputBoundary.realRoot;
  const sourceRoot = path.resolve(cwd, options.sourceRoot ?? defaultAttachmentSourceRoot(requestedOutputDir, cwd));
  const sourceBoundary = await createAttachmentSourceBoundary(sourceRoot);
  await preflightAttachmentSources(options.tests, sourceBoundary);
  const warnings = options.warnings ?? [];
  const definitionCatalog = options.definitionCatalog ?? [];
  const postersByVideoHash = await processedPosterIndex(sourceBoundary, warnings);
  const tests = await mapWithConcurrency(options.tests, GALLERY_MATERIALIZATION_CONCURRENCY, async (source): Promise<NormalizedGalleryTest> => {
    const attempts: NormalizedGalleryAttempt[] = [];
    for (const [index, attempt] of source.results.entries()) {
      attempts.push(await normalizeAttempt(
        source,
        attempt,
        index + 1,
        outputDir,
        postersByVideoHash,
        sourceBoundary,
        outputBoundary,
      ));
    }
    const evidence = attempts.flatMap((attempt) => attempt.evidenceRecords);
    return {
      source,
      auditIds: [...new Set([...evidence.map(({ auditId }) => auditId), ...annotationAuditIds(source)])],
      evidenceRecords: evidence,
      attempts,
    };
  });
  return { tests, catalog: catalogFromNormalized(tests, definitionCatalog) };
}

export async function buildGalleryCatalog(options: BuildGalleryCatalogOptions): Promise<GalleryCatalog> {
  return (await buildGalleryEvidenceModel(options)).catalog;
}

function archiveUtf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function archiveWrapper(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `<!doctype html><meta charset="utf-8"><body data-gallery-payload="${encoded}"><script>(()=>{const token=decodeURIComponent(location.hash.slice(1));if(!token)return;const e=document.body.dataset.galleryPayload;const b=Uint8Array.from(atob(e),c=>c.charCodeAt(0));const payload=JSON.parse(new TextDecoder().decode(b));parent.postMessage({channel:${JSON.stringify(GALLERY_ARCHIVE_CHANNEL)},token,meta:payload.archiveDocument,payload},'*')})()</script></body>`;
}

function archiveDocument(
  kind: 'query' | 'detail' | 'flags' | 'raw',
  contentRevision: string,
  exportRevision: string,
  flagRevision?: string,
): Record<string, unknown> {
  return {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    kind,
    contentRevision,
    exportRevision,
    ...(flagRevision ? { flagRevision } : {}),
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value !== ''))].sort();
}

function safeArchiveHref(value: string | null): string | null {
  if (!value || path.isAbsolute(value)) return null;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null;
  return normalized;
}

function archiveSourceLabel(value: string): string {
  if (path.isAbsolute(value) || value === '..' || value.startsWith('../') || value.includes('/../')) {
    return path.basename(value);
  }
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function archiveFlagState(flagSnapshot: WriteGalleryArchiveOptions['flagSnapshot']): Map<string, GalleryQueryIndexRow['flagState']> {
  const states = new Map<string, GalleryQueryIndexRow['flagState']>();
  const priority: Record<GalleryQueryIndexRow['flagState'], number> = {
    open: 0,
    resolved: 1,
    dismissed: 2,
    unflagged: 3,
  };
  for (const value of flagSnapshot?.flags ?? []) {
    if (!value || typeof value !== 'object') continue;
    const flag = value as { itemId?: unknown; state?: unknown };
    if (typeof flag.itemId !== 'string' || !['open', 'resolved', 'dismissed'].includes(String(flag.state))) continue;
    const next = flag.state as GalleryQueryIndexRow['flagState'];
    const current = states.get(flag.itemId);
    if (!current || priority[next] < priority[current]) states.set(flag.itemId, next);
  }
  return states;
}

function queryRowFromItem(
  item: GalleryItem,
  flagStates: ReadonlyMap<string, GalleryQueryIndexRow['flagState']>,
): GalleryQueryIndexRow {
  const featureSuites = uniqueStrings(item.auditAssociations.map(({ featureSuite }) => featureSuite));
  const primaryAudit = primaryGalleryAuditAssociation(item.auditAssociations);
  const title = boundedGalleryText(item.test.title) ?? 'Untitled test';
  const projectName = boundedGalleryText(item.project.name, 300) ?? 'unknown-project';
  const targets = uniqueStrings([
    item.project.name,
    item.project.browser,
    item.project.deviceClass,
    `${item.project.browser} · ${item.project.deviceClass}`,
  ]);
  const searchText = uniqueStrings([
    item.test.id,
    item.test.title,
    ...item.test.titlePath,
    archiveSourceLabel(item.test.file),
    item.test.technicalSuite,
    item.project.name,
    item.project.browser,
    item.project.deviceClass,
    item.project.environment,
    item.capture.route,
    item.capture.observedState,
    item.capture.rationale,
    ...item.auditAssociations.flatMap(({ id, title, expected, featureSuite }) => [id, title, expected, featureSuite]),
  ]).join(' ').toLowerCase().slice(0, 20_000);
  return assertGalleryQueryRow({
    id: item.id,
    testGroupId: deriveGalleryTestGroupId({
      sourceTestId: item.test.id,
      project: item.project.name,
      attempt: item.attempt.ordinal,
      retry: item.attempt.retry,
    }),
    kind: item.kind,
    title,
    testLabel: boundedGalleryText(`${title} · ${projectName} · attempt ${item.attempt.ordinal}${item.attempt.retry > 0 ? ` retry ${item.attempt.retry}` : ''}`) ?? title,
    testTitlePath: item.test.titlePath.map((part) => boundedGalleryText(part) ?? '').filter(Boolean).slice(0, 50),
    projectName,
    status: item.attempt.status,
    environment: item.project.environment,
    featureSuites,
    primaryFeatureSuite: primaryAudit?.featureSuite ?? null,
    primaryAuditCatalogOrdinal: primaryAudit?.catalogOrdinal ?? null,
    technicalSuite: boundedGalleryText(item.test.technicalSuite) ?? '',
    targets,
    flagState: flagStates.get(item.id) ?? 'unflagged',
    searchText,
    attempt: { ordinal: item.attempt.ordinal, retry: item.attempt.retry },
    captureTime: item.capture.capturedAt,
    available: item.members.some(({ available, blobId }) => available && blobId !== null),
    visualWarning: Boolean(item.comparison?.complete && item.members.some(({ role }) => role === 'diff')),
    auditAssociations: item.auditAssociations.map(({ id, title, catalogOrdinal }) => ({ id, title, catalogOrdinal })),
  });
}

function archiveItemDetail(item: GalleryItem, blobs: ReadonlyMap<string, GalleryBlob>): GalleryItemDetail {
  const safeItem: GalleryItem = {
    ...item,
    test: { ...item.test, file: archiveSourceLabel(item.test.file) },
    members: item.members.map((member) => ({
      ...member,
      error: member.available ? null : 'Media file is unavailable.',
      poster: member.poster ? { ...member.poster, href: safeArchiveHref(member.poster.href) ?? '' } : null,
    })),
  };
  const media = safeItem.members.map((member) => {
    const blob = member.blobId ? blobs.get(member.blobId) : null;
    return {
      memberId: member.id,
      blobId: member.blobId,
      href: blob ? safeArchiveHref(blob.href) : null,
      contentType: member.contentType,
      sizeBytes: blob?.sizeBytes ?? null,
      sha256: blob?.sha256 ?? null,
      available: member.available && Boolean(blob && safeArchiveHref(blob.href)),
      poster: member.poster,
    };
  });
  return assertGalleryItemDetail({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    item: safeItem,
    media,
    availability: {
      state: media.some(({ available }) => available) ? 'available' : 'tombstone',
      retryable: true,
      message: media.some(({ available }) => available)
        ? null
        : 'This evidence is no longer available. Its test context remains in the review sequence.',
    },
  });
}

function archiveRawRows(catalog: GalleryCatalog): Array<Record<string, unknown>> {
  return catalog.blobs.map((blob) => {
    const bundleCopies = uniqueStrings(blob.storageLocations.map((location) => safeArchiveHref(location)));
    return {
      id: blob.id,
      kind: blob.kind,
      contentType: blob.contentType,
      sizeBytes: blob.sizeBytes,
      sha256: blob.sha256,
      href: safeArchiveHref(blob.href),
      storageCopyCount: blob.storageLocations.length,
      bundleCopies,
    };
  });
}

function partitionArchiveRows<T>(
  rows: readonly T[],
  maxRows: number,
  maxBytes: number,
  payload: (chunkRows: T[], ordinal: number) => unknown,
): Array<{ source: string; rows: number }> {
  const chunks: Array<{ source: string; rows: number }> = [];
  let pending: T[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    const source = archiveWrapper(payload(pending, chunks.length + 1));
    if (archiveUtf8Bytes(source) > maxBytes) throw new Error(`Gallery archive chunk exceeds ${maxBytes} bytes.`);
    chunks.push({ source, rows: pending.length });
    pending = [];
  };
  for (const row of rows) {
    const candidate = [...pending, row];
    const source = archiveWrapper(payload(candidate, chunks.length + 1));
    if (candidate.length > maxRows || archiveUtf8Bytes(source) > maxBytes) {
      if (pending.length === 0) throw new Error('A single gallery archive row exceeds the configured chunk cap.');
      flush();
      pending = [row];
      if (archiveUtf8Bytes(archiveWrapper(payload(pending, chunks.length + 1))) > maxBytes) {
        throw new Error('A single gallery archive row exceeds the configured chunk cap.');
      }
    } else pending = candidate;
  }
  flush();
  return chunks;
}

async function archiveFileDigest(file: string): Promise<{ sizeBytes: number; sha256: string }> {
  const details = await stat(file);
  return { sizeBytes: details.size, sha256: await sha256File(file) };
}

async function readCurrentGalleryDescriptor(galleryRoot: string): Promise<GalleryArchiveDescriptor | null> {
  try {
    return JSON.parse(await readFile(path.join(galleryRoot, 'current.json'), 'utf8')) as GalleryArchiveDescriptor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readFlagSidecarSnapshot(
  outputDir: string,
): Promise<NonNullable<WriteGalleryArchiveOptions['flagSnapshot']> | null> {
  const sidecar = path.resolve(outputDir, '..', 'visual-flags.json');
  try {
    const details = await lstat(sidecar);
    if (!details.isFile() || details.isSymbolicLink() || details.size > GALLERY_FLAG_HISTORY_MAX_BYTES) {
      throw new Error('Reviewer flag history exceeds its bounded rebuild limit.');
    }
    const history = assertGalleryFlagHistory(JSON.parse(await readFile(sidecar, 'utf8')));
    return galleryFlagSnapshot(history);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readArchiveFlagSnapshot(
  outputDir: string,
  descriptor: GalleryArchiveDescriptor,
): Promise<NonNullable<WriteGalleryArchiveOptions['flagSnapshot']>> {
  const href = safeArchiveHref(descriptor.flags.href);
  if (!href) throw new Error('Current gallery flag snapshot has an unsafe archive path.');
  const source = await readFile(path.join(outputDir, ...href.split('/')), 'utf8');
  const encoded = source.match(/data-gallery-payload="([A-Za-z0-9+/=]+)"/)?.[1];
  if (!encoded) throw new Error('Current gallery flag snapshot is not a valid archive wrapper.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
    schemaVersion?: unknown;
    throughEvent?: unknown;
    flags?: unknown;
    events?: unknown;
  };
  if (payload.schemaVersion !== GALLERY_SCHEMA_VERSION || !Number.isInteger(payload.throughEvent) || !Array.isArray(payload.flags)) {
    throw new Error('Current gallery flag snapshot has an unsupported schema.');
  }
  return {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    throughEvent: payload.throughEvent as number,
    flags: payload.flags,
    ...(Array.isArray(payload.events) ? { events: payload.events as GalleryFlagEvent[] } : {}),
  };
}

export async function prepareGalleryArchive(options: WriteGalleryArchiveOptions): Promise<PreparedGalleryArchive> {
  assertGalleryCatalog(options.catalog);
  const outputDir = path.resolve(options.cwd ?? process.cwd(), options.outputDir);
  const galleryRoot = path.join(outputDir, 'gallery');
  await mkdir(path.join(galleryRoot, 'revisions'), { recursive: true });
  const current = await readCurrentGalleryDescriptor(galleryRoot);
  const flagHistoryPath = path.resolve(outputDir, '..', 'visual-flags.json');
  const flagSnapshot = options.flagSnapshot
    ?? await readFlagSidecarSnapshot(outputDir)
    ?? (current ? await readArchiveFlagSnapshot(outputDir, current) : { schemaVersion: 1, throughEvent: 0, flags: [], events: [] });
  const flagStates = archiveFlagState(flagSnapshot);
  const contentRows = options.catalog.items.map((item) => queryRowFromItem(item, flagStates));
  const queryRows = queryGalleryArchiveRows(
    contentRows,
    { sort: 'attention' },
  );
  const blobById = new Map(options.catalog.blobs.map((blob) => [blob.id, blob]));
  const itemDetails = new Map(options.catalog.items.map((item) => [item.id, archiveItemDetail(item, blobById)]));
  const rawRows = archiveRawRows(options.catalog);
  const contentRevision = `content_${stableGalleryKey({
    rows: contentRows.map(({ flagState: _flagState, ...row }) => row),
    details: [...itemDetails.values()],
    blobs: options.catalog.blobs.map(({ id, sha256, sizeBytes, contentType, kind, href }) => ({
      id,
      sha256,
      sizeBytes,
      contentType,
      kind,
      href: safeArchiveHref(href),
    })),
  })}`;
  const flagRevision = typeof flagSnapshot.flagRevision === 'string'
    ? flagSnapshot.flagRevision
    : Array.isArray(flagSnapshot.events)
      ? galleryFlagRevision(assertGalleryFlagHistory({
          schemaVersion: GALLERY_SCHEMA_VERSION,
          throughEvent: flagSnapshot.throughEvent,
          events: flagSnapshot.events,
        }))
      : `flags_${stableGalleryKey(flagSnapshot)}`;
  const orderRevision = `order_${stableGalleryKey({ contentRevision, flagRevision, schemaVersion: 1 })}`;
  const exportedAt = options.exportedAt && !Number.isNaN(Date.parse(options.exportedAt))
    ? new Date(options.exportedAt).toISOString()
    : new Date().toISOString();
  const archiveBundle = archiveBundleContract();
  const exportRevision = `export_${stableGalleryKey({
    contentRevision,
    flagRevision,
    orderRevision,
    exportedAt,
    archiveBundle,
  })}`;
  const revisionHref = `gallery/revisions/${exportRevision}`;
  const finalDir = path.join(galleryRoot, 'revisions', exportRevision);
  const stagingDir = await mkdtemp(path.join(galleryRoot, `.staging-${exportRevision}-`));
  const maxRows = Math.max(1, Math.min(options.maxRowsPerChunk ?? GALLERY_QUERY_CHUNK_MAX_ROWS, GALLERY_QUERY_CHUNK_MAX_ROWS));
  const maxBytes = Math.max(2_048, Math.min(options.maxBytesPerChunk ?? GALLERY_QUERY_CHUNK_MAX_BYTES, GALLERY_QUERY_CHUNK_MAX_BYTES));

  const queryChunks = partitionArchiveRows(queryRows, maxRows, maxBytes, (rows, ordinal) => ({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    contentRevision,
    ordinal,
    rows,
    archiveDocument: archiveDocument('query', contentRevision, exportRevision),
  }));
  const rawChunks = partitionArchiveRows(rawRows, maxRows, maxBytes, (rows, ordinal) => ({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    contentRevision,
    ordinal,
    advancedRawOnly: true,
    rows,
    archiveDocument: archiveDocument('raw', contentRevision, exportRevision),
  }));
  const queryReferences: GalleryArchiveChunkReference[] = [];
  const rawReferences: GalleryArchiveChunkReference[] = [];
  const writtenFiles: string[] = [];
  await mkdir(path.join(stagingDir, 'query'), { recursive: true });
  await mkdir(path.join(stagingDir, 'items'), { recursive: true });
  await mkdir(path.join(stagingDir, 'raw'), { recursive: true });

  for (const [index, chunk] of queryChunks.entries()) {
    const filename = `chunk-${String(index + 1).padStart(4, '0')}.html`;
    const file = path.join(stagingDir, 'query', filename);
    await writeFile(file, chunk.source, 'utf8');
    writtenFiles.push(path.relative(stagingDir, file));
    queryReferences.push({ href: `${revisionHref}/query/${filename}`, rows: chunk.rows, bytes: archiveUtf8Bytes(chunk.source) });
  }
  for (const [index, chunk] of rawChunks.entries()) {
    const filename = `chunk-${String(index + 1).padStart(4, '0')}.html`;
    const file = path.join(stagingDir, 'raw', filename);
    await writeFile(file, chunk.source, 'utf8');
    writtenFiles.push(path.relative(stagingDir, file));
    rawReferences.push({ href: `${revisionHref}/raw/${filename}`, rows: chunk.rows, bytes: archiveUtf8Bytes(chunk.source) });
  }
  for (const [itemId, detail] of itemDetails) {
    const source = archiveWrapper({
      ...detail,
      archiveDocument: archiveDocument('detail', contentRevision, exportRevision),
    });
    if (archiveUtf8Bytes(source) > GALLERY_ITEM_DETAIL_MAX_BYTES) {
      throw new Error(`Gallery item detail ${itemId} exceeds ${GALLERY_ITEM_DETAIL_MAX_BYTES} bytes.`);
    }
    const file = path.join(stagingDir, 'items', `${encodeURIComponent(itemId)}.html`);
    await writeFile(file, source, 'utf8');
    writtenFiles.push(path.relative(stagingDir, file));
  }
  const flagsFile = path.join(stagingDir, 'flags.html');
  await writeFile(flagsFile, archiveWrapper({
    ...flagSnapshot,
    flagRevision,
    archiveDocument: archiveDocument('flags', contentRevision, exportRevision, flagRevision),
  }), 'utf8');
  writtenFiles.push(path.relative(stagingDir, flagsFile));

  const facet = (values: string[]): string[] => uniqueStrings(values);
  const documentCount = writtenFiles.length + 1;
  const descriptor: GalleryArchiveDescriptor = {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    phase: 'sealed',
    contentRevision,
    flagRevision,
    orderRevision,
    exportRevision,
    exportedAt,
    archiveBundle,
    primaryCounts: options.catalog.primaryCounts,
    facets: {
      kinds: facet(queryRows.map(({ kind }) => kind)),
      statuses: facet(queryRows.map(({ status }) => status)),
      environments: facet(queryRows.map(({ environment }) => environment)),
      featureSuites: facet(queryRows.flatMap(({ featureSuites }) => featureSuites)),
      technicalSuites: facet(queryRows.map(({ technicalSuite }) => technicalSuite)),
      targets: facet(queryRows.flatMap(({ targets }) => targets)),
      flagStates: facet(queryRows.map(({ flagState }) => flagState)),
    },
    query: { rows: queryRows.length, maxRowsPerChunk: maxRows, maxBytesPerChunk: maxBytes, chunks: queryReferences },
    itemDetails: {
      count: itemDetails.size,
      hrefPrefix: `${revisionHref}/items/`,
      hrefSuffix: '.html',
      maxBytes: GALLERY_ITEM_DETAIL_MAX_BYTES,
    },
    raw: { rows: rawRows.length, maxRowsPerChunk: maxRows, maxBytesPerChunk: maxBytes, chunks: rawReferences },
    flags: { href: `${revisionHref}/flags.html`, throughEvent: flagSnapshot.throughEvent },
    integrity: { href: `${revisionHref}/integrity.json`, documentCount },
  };
  assertGalleryArchiveDescriptor(descriptor);
  const descriptorSource = `${JSON.stringify(descriptor)}\n`;
  if (archiveUtf8Bytes(descriptorSource) > GALLERY_DESCRIPTOR_MAX_BYTES) {
    throw new Error(`Gallery descriptor exceeds ${GALLERY_DESCRIPTOR_MAX_BYTES} bytes.`);
  }
  const descriptorFile = path.join(stagingDir, 'descriptor.json');
  await writeFile(descriptorFile, descriptorSource, 'utf8');
  writtenFiles.push(path.relative(stagingDir, descriptorFile));
  const integrityFiles = await Promise.all(writtenFiles.sort().map(async (relative) => ({
    path: relative.split(path.sep).join('/'),
    ...await archiveFileDigest(path.join(stagingDir, relative)),
  })));
  await writeFile(path.join(stagingDir, 'integrity.json'), `${JSON.stringify({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    exportRevision,
    files: integrityFiles,
  })}\n`, 'utf8');
  return {
    outputDir,
    galleryRoot,
    stagingDir,
    finalDir,
    descriptor,
    expectedExportRevision: current?.exportRevision ?? null,
    expectedFlagRevision: flagRevision,
    flagHistoryPath,
  };
}

export async function publishPreparedGalleryArchive(prepared: PreparedGalleryArchive): Promise<GalleryArchiveDescriptor> {
  const requestPath = path.join(prepared.galleryRoot, `.publish-${prepared.descriptor.exportRevision}-${randomUUID()}.json`);
  const surfacePagePath = await stageGalleryArchiveSurface(prepared.outputDir, prepared.galleryRoot, prepared.descriptor);
  const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'gallery-publish.mjs');
  try {
    await writeFile(requestPath, `${JSON.stringify({
      schemaVersion: GALLERY_SCHEMA_VERSION,
      galleryRoot: prepared.galleryRoot,
      stagingDir: prepared.stagingDir,
      finalDir: prepared.finalDir,
      descriptor: prepared.descriptor,
      expectedExportRevision: prepared.expectedExportRevision,
      expectedFlagRevision: prepared.expectedFlagRevision,
      flagHistoryPath: prepared.flagHistoryPath,
      surfacePagePath,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    await execFileAsync(process.execPath, [helper, '--request', requestPath], {
      cwd: prepared.outputDir,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const details = error as Error & { stderr?: string; stdout?: string };
    const message = details.stderr?.trim() || details.stdout?.trim() || details.message;
    throw new Error(`Gallery archive publication failed: ${message}`, { cause: error });
  } finally {
    await rm(surfacePagePath, { force: true });
  }
  return prepared.descriptor;
}

export async function writeGalleryArchive(options: WriteGalleryArchiveOptions): Promise<GalleryArchiveDescriptor> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const prepared = await prepareGalleryArchive(options);
    try {
      return await publishPreparedGalleryArchive(prepared);
    } catch (error) {
      lastError = error;
      await rm(prepared.stagingDir, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      if (!/GALLERY_(?:FLAG|HEAD)_CONFLICT/.test(message)) throw error;
    }
  }
  throw lastError;
}

function inlineArchiveJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function galleryArchiveHtml(descriptor: GalleryArchiveDescriptor, inlineModule: string): string {
  const bundle = descriptor.archiveBundle ?? archiveBundleContract();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Visual Evidence Gallery · Long Build Checklist</title>
  <link rel="stylesheet" href="${bundle.assetBase}/gallery.css">
  <link rel="stylesheet" href="${bundle.assetBase}/gallery-archive.css">
</head>
<body>
  <a class="gallery-archive-skip" href="#gallery-workbench">Skip to visual evidence</a>
  <header class="gallery-archive-header">
    <div>
      <a class="gallery-archive-back" href="index.html">← Long Build Checklist</a>
      <p class="gallery-archive-eyebrow">Portable release evidence</p>
      <h1>Visual Evidence Gallery</h1>
      <p>Read-only snapshot exported <time id="gallery-exported-at"></time>. It matches the portal only as of this export.</p>
    </div>
    <dl class="gallery-archive-summary">
      <div><dt>Snapshot</dt><dd id="gallery-export-revision"></dd></div>
      <div><dt>Evidence</dt><dd id="gallery-primary-counts"></dd></div>
      <div><dt>Flags</dt><dd id="gallery-flag-count">Load to review</dd></div>
    </dl>
  </header>
  <main class="gallery-archive-main">
    <div id="gallery-loading" class="gallery-archive-loading" role="status" aria-live="polite">Opening the pinned evidence index…</div>
    <section id="gallery-fatal" class="gallery-archive-error" hidden aria-labelledby="gallery-fatal-title">
      <h2 id="gallery-fatal-title">The archive gallery could not open</h2>
      <p id="gallery-fatal-message"></p>
      <button id="gallery-retry" type="button">Retry</button>
    </section>
    <div id="gallery-workbench"></div>
    <section class="gallery-archive-drawers" aria-label="Archive details">
      <details id="flag-drawer">
        <summary>Reviewer flag snapshot and history</summary>
        <p class="gallery-archive-readonly">Read-only. These flags are frozen at this archive’s export revision.</p>
        <p id="flag-state">Not loaded</p>
        <ol id="flag-history" class="gallery-archive-list"></ol>
      </details>
      <details id="raw-drawer">
        <summary>Advanced raw artifact index</summary>
        <p class="gallery-archive-readonly">Raw storage rows are separate from logical gallery totals.</p>
        <p id="raw-state">Not loaded</p>
        <div class="gallery-archive-pager">
          <button id="previous-raw" type="button" disabled>Previous</button>
          <button id="next-raw" type="button">Next</button>
        </div>
        <ul id="raw-files" class="gallery-archive-list"></ul>
      </details>
    </section>
  </main>
  <p id="gallery-announcer" class="gallery-archive-visually-hidden" role="status" aria-live="polite" aria-atomic="true"></p>
  <script id="archive-bundle" type="application/json">${inlineArchiveJson(bundle)}</script>
  <script id="gallery-archive-head" type="application/json">${inlineArchiveJson(descriptor)}</script>
  <script src="${bundle.assetBase}/archive-runtime.js"></script>
  <script src="${bundle.assetBase}/gallery-loader.js"></script>
  <script type="module">${inlineModule}</script>
</body>
</html>`;
}

function archiveInlineModule(coreSource: string, adapterSource: string): string {
  const bundledAdapter = adapterSource.replace(
    /^import\s*\{[\s\S]*?\}\s*from '\.\/gallery-core\.js';\s*/,
    '',
  ).replace(
    "if ((typeof location === 'undefined' || location.protocol !== 'file:') && typeof document !== 'undefined' && document.querySelector('#gallery-archive-head')) {",
    "if (typeof document !== 'undefined' && document.querySelector('#gallery-archive-head')) {",
  );
  if (bundledAdapter === adapterSource || !bundledAdapter.includes("typeof document !== 'undefined'")) {
    throw new Error('Could not build the self-contained archive gallery module.');
  }
  const source = `${coreSource}\n${bundledAdapter}`;
  return source.replace(/<\/script/gi, '<\\/script');
}

async function stageGalleryArchiveSurface(
  outputDir: string,
  galleryRoot: string,
  descriptor: GalleryArchiveDescriptor,
): Promise<string> {
  const bundle = await ensureArchiveRuntimeBundle(outputDir);
  if (JSON.stringify(descriptor.archiveBundle) !== JSON.stringify(bundle)) {
    throw new Error('Gallery descriptor and staged archive runtime bundle do not match.');
  }
  const bundleAssets = path.join(outputDir, ...bundle.assetBase.split('/'));
  const [coreSource, adapterSource] = await Promise.all([
    readFile(path.join(bundleAssets, 'gallery-core.js'), 'utf8'),
    readFile(path.join(bundleAssets, 'gallery-archive.js'), 'utf8'),
  ]);
  const surfacePagePath = path.join(galleryRoot, `.surface-${descriptor.exportRevision}-${randomUUID()}.html`);
  await writeFile(
    surfacePagePath,
    galleryArchiveHtml(descriptor, archiveInlineModule(coreSource, adapterSource)),
    'utf8',
  );
  return surfacePagePath;
}
