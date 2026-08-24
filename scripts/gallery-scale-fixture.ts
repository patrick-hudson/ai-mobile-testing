import {
  GALLERY_SCHEMA_VERSION,
  assertGalleryCatalog,
  deriveGalleryItemId,
  deriveGalleryMemberId,
  type GalleryBlob,
  type GalleryCatalog,
  type GalleryItem,
} from '../shared/gallery-contract.mjs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

export const GALLERY_SCALE = Object.freeze({
  reportArtifacts: 5_659,
  logicalMedia: 1_241,
  validatedVideos: 110,
  storedFiles: 17_527,
});

export type GalleryScaleMaterialization = Readonly<{
  artifactHrefs: number;
  storageCopies: number;
  storedFiles: number;
  verifiedFiles: number;
  logicalBytes: number;
}>;

const DEFAULT_IMAGE_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/2pQmWQAAAABJRU5ErkJggg==', 'base64');
const DEFAULT_VIDEO_BYTES = Buffer.from('structural-video-fixture');

export function buildGalleryScaleCatalog(options: { imageBytes?: Uint8Array; videoBytes?: Uint8Array } = {}): GalleryCatalog {
  const blobs: GalleryBlob[] = Array.from({ length: GALLERY_SCALE.reportArtifacts }, (_, index) => {
    const referencedVideo = index >= GALLERY_SCALE.logicalMedia - GALLERY_SCALE.validatedVideos
      && index < GALLERY_SCALE.logicalMedia;
    const kind = referencedVideo ? 'video' : 'image';
    const extension = kind === 'video' ? 'webm' : 'png';
    const storageCopies = GALLERY_SCALE.storedFiles - GALLERY_SCALE.reportArtifacts;
    const baseCopies = Math.floor(storageCopies / GALLERY_SCALE.reportArtifacts);
    const extraCopies = storageCopies % GALLERY_SCALE.reportArtifacts;
    const copyCount = baseCopies + (index < extraCopies ? 1 : 0);
    const payload = galleryScalePayload(index, kind, options.imageBytes ?? DEFAULT_IMAGE_BYTES, options.videoBytes ?? DEFAULT_VIDEO_BYTES);
    return {
      id: `gblob_scale_${String(index).padStart(5, '0')}`,
      sha256: sha256(payload),
      sizeBytes: payload.byteLength,
      contentType: kind === 'video' ? 'video/webm' : 'image/png',
      kind,
      href: `evidence/scale/artifact-${String(index).padStart(5, '0')}.${extension}`,
      storageLocations: Array.from({ length: copyCount }, (_, copy) => (
        `raw/scale/copy-${copy + 1}/artifact-${String(index).padStart(5, '0')}.${extension}`
      )),
    };
  });

  const items: GalleryItem[] = Array.from({ length: GALLERY_SCALE.logicalMedia }, (_, index) => {
    const blob = blobs[index]!;
    const sourceTestId = `scale-test-${String(index).padStart(4, '0')}`;
    const attachmentKey = `scale-attachment-${index}`;
    const attachmentKeys = index === 0
      ? ['scale-baseline', 'scale-actual', 'scale-diff']
      : [attachmentKey];
    const id = deriveGalleryItemId({
      sourceTestId,
      project: 'candidate-desktop-chromium',
      attempt: 1,
      retry: 0,
      attachmentKey,
    });
    const suite = `suite-${String(index % 12).padStart(2, '0')}`;
    return {
      id,
      kind: blob.kind,
      test: {
        id: sourceTestId,
        title: `Reference evidence ${String(index).padStart(4, '0')}`,
        titlePath: ['reference scale', suite, `Reference evidence ${String(index).padStart(4, '0')}`],
        file: `tests/reference-scale/${suite}.spec.ts`,
        line: index + 1,
        column: 1,
        technicalSuite: `reference-scale/${suite}.spec.ts`,
      },
      attempt: {
        ordinal: 1,
        retry: 0,
        status: index % 17 === 0 ? 'failed' : 'passed',
        expectedStatus: 'passed',
        startedAt: new Date(Date.UTC(2026, 7, 24, 12, 0, index % 60)).toISOString(),
        durationMs: 1_000 + index,
      },
      project: {
        name: 'candidate-desktop-chromium',
        environment: 'candidate',
        browser: 'Chromium',
        deviceClass: 'desktop',
      },
      auditAssociations: [{
        id: `SCALE-${String(index % 81).padStart(3, '0')}`,
        title: `Reference audit ${index % 81}`,
        expected: blob.kind === 'video'
          ? 'A labeled user action produces and holds its visible response.'
          : 'The rendered visual state matches the reviewed placement and content contract.',
        featureSuite: suite,
        catalogOrdinal: index % 81,
      }],
      members: attachmentKeys.map((memberKey, memberIndex) => ({
        id: deriveGalleryMemberId(id, memberKey),
        attachmentKey: memberKey,
        name: index === 0 ? `${['baseline', 'actual', 'diff'][memberIndex]}.png`
          : blob.kind === 'video' ? 'validated-action-response.webm' : 'static-checkpoint.png',
        role: index === 0 ? (['baseline', 'actual', 'diff'] as const)[memberIndex]! : 'single',
        contentType: blob.contentType,
        blobId: blob.id,
        available: true,
        error: null,
        poster: null,
      })),
      comparison: index === 0 ? { key: 'scale-comparison', complete: true } : null,
      capture: {
        route: `/reference/${index}`,
        viewport: { width: 1280, height: 720 },
        capturedAt: new Date(Date.UTC(2026, 7, 24, 12, 0, index % 60)).toISOString(),
        observedState: blob.kind === 'video' ? 'The action response is visibly complete.' : 'The static checkpoint is rendered.',
        rationale: blob.kind === 'video'
          ? 'Validated interaction-only action and response evidence.'
          : 'Screenshot-only placement and content evidence.',
        provenance: 'test-policy',
      },
      provenance: { sourceShard: { ordinal: index % 4 + 1, total: 4 } },
    };
  });

  return assertGalleryCatalog({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    items,
    blobs,
    primaryCounts: {
      total: items.length,
      images: items.filter(({ kind }) => kind === 'image').length,
      videos: items.filter(({ kind }) => kind === 'video').length,
    },
  });
}

export async function materializeGalleryScaleCorpus(options: {
  catalog: GalleryCatalog;
  archiveRoot: string;
  storageRoot: string;
  imageBytes: Uint8Array;
  videoBytes: Uint8Array;
}): Promise<GalleryScaleMaterialization> {
  const destinations = options.catalog.blobs.flatMap((blob) => [
    { root: options.archiveRoot, relative: blob.href, blob },
    ...blob.storageLocations.map((relative) => ({
      root: options.storageRoot,
      relative,
      blob,
    })),
  ]);
  const uniquePaths = new Set(destinations.map(({ root, relative }) => containedScalePath(root, relative)));
  if (uniquePaths.size !== destinations.length) throw new Error('Reference-scale materialization paths must be unique.');

  let logicalBytes = 0;
  for (let offset = 0; offset < destinations.length; offset += 100) {
    await Promise.all(destinations.slice(offset, offset + 100).map(async ({ root, relative, blob }) => {
      const destination = containedScalePath(root, relative);
      const index = Number(blob.id.slice(-5));
      const bytes = galleryScalePayload(index, blob.kind, options.imageBytes, options.videoBytes);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      logicalBytes += bytes.byteLength;
    }));
  }

  const actual = await countGalleryScaleCorpusFiles({ archiveRoot: options.archiveRoot, storageRoot: options.storageRoot });
  if (actual.storedFiles !== destinations.length) {
    throw new Error(`Reference-scale materialization wrote ${actual.storedFiles} files; expected ${destinations.length}.`);
  }
  let verifiedFiles = 0;
  for (let offset = 0; offset < destinations.length; offset += 100) {
    await Promise.all(destinations.slice(offset, offset + 100).map(async ({ root, relative, blob }) => {
      const bytes = await readFile(containedScalePath(root, relative));
      if (bytes.byteLength !== blob.sizeBytes || sha256(bytes) !== blob.sha256) {
        throw new Error(`Reference-scale file does not match catalog metadata: ${relative}`);
      }
      verifiedFiles += 1;
    }));
  }
  return Object.freeze({ ...actual, verifiedFiles, logicalBytes });
}

export async function countGalleryScaleCorpusFiles(options: {
  archiveRoot: string;
  storageRoot: string;
}): Promise<Omit<GalleryScaleMaterialization, 'logicalBytes' | 'verifiedFiles'>> {
  const artifactHrefs = await countRegularFiles(join(options.archiveRoot, 'evidence', 'scale'));
  const storageCopies = await countRegularFiles(join(options.storageRoot, 'raw', 'scale'));
  return Object.freeze({ artifactHrefs, storageCopies, storedFiles: artifactHrefs + storageCopies });
}

function galleryScalePayload(index: number, kind: string, imageBytes: Uint8Array, videoBytes: Uint8Array): Buffer {
  const base = kind === 'video' ? videoBytes : imageBytes;
  return Buffer.concat([Buffer.from(base), Buffer.from(`\nscale-artifact:${String(index).padStart(5, '0')}\n`)]);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function containedScalePath(root: string, relative: string): string {
  if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\\') || relative.includes('?') || relative.includes('#')) {
    throw new Error(`Unsafe reference-scale materialization path: ${relative}`);
  }
  const segments = relative.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe reference-scale materialization path: ${relative}`);
  }
  return join(root, ...segments);
}

async function countRegularFiles(root: string): Promise<number> {
  const pending = [root];
  let files = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
      else if (entry.isFile()) files += 1;
      else throw new Error(`Reference-scale corpus contains a non-regular entry: ${join(directory, entry.name)}`);
    }
  }
  return files;
}
