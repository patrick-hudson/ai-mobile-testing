import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// The portal server is intentionally runtime JavaScript; this regression
// exercises that exact module rather than a typed reimplementation.
// @ts-expect-error portal/gallery-data.mjs has no TypeScript declaration.
import { loadGallerySnapshot } from '../portal/gallery-data.mjs';
import { writeGalleryArchive } from '../reporters/gallery-model.js';
import {
  GALLERY_SCHEMA_VERSION,
  assertGalleryCatalog,
  deriveGalleryItemId,
  deriveGalleryMemberId,
} from '../shared/gallery-contract.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'portal-gallery-integrity-self-test-'));
try {
  const runDirectory = path.join(root, 'integrity-run');
  const outputDir = path.join(runDirectory, 'checklist');
  const sourceTestId = 'portal-integrity-test';
  const itemId = deriveGalleryItemId({
    sourceTestId,
    project: 'candidate-mobile-chromium',
    attempt: 1,
    retry: 0,
    attachmentKey: 'actual',
  });
  const blobId = 'gblob_portal_integrity';
  const catalog = assertGalleryCatalog({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    items: [{
      id: itemId,
      kind: 'image',
      test: {
        id: sourceTestId,
        title: 'Portal integrity checkpoint',
        titlePath: ['portal integrity', 'Portal integrity checkpoint'],
        file: 'tests/portal-integrity.spec.ts',
        line: 1,
        column: 1,
        technicalSuite: 'portal-integrity.spec.ts',
      },
      attempt: {
        ordinal: 1,
        retry: 0,
        status: 'passed',
        expectedStatus: 'passed',
        startedAt: '2026-08-24T12:00:00.000Z',
        durationMs: 100,
      },
      project: {
        name: 'candidate-mobile-chromium',
        environment: 'candidate',
        browser: 'Chromium',
        deviceClass: 'mobile',
      },
      auditAssociations: [{
        id: 'VISUAL-001',
        title: 'Visual state',
        expected: 'The visual state is inspectable.',
        featureSuite: 'visual',
        catalogOrdinal: 0,
      }],
      members: [{
        id: deriveGalleryMemberId(itemId, 'actual'),
        attachmentKey: 'actual',
        name: 'checkpoint.png',
        role: 'single',
        contentType: 'image/png',
        blobId,
        available: true,
        error: null,
        poster: null,
      }],
      comparison: null,
      capture: {
        route: '/integrity',
        viewport: { width: 390, height: 844 },
        capturedAt: '2026-08-24T12:00:00.000Z',
        observedState: 'The checkpoint is visible.',
        rationale: 'Screenshot-only portal integrity fixture.',
        provenance: 'test-policy',
      },
      provenance: { sourceShard: null },
    }],
    blobs: [{
      id: blobId,
      sha256: '0'.repeat(64),
      sizeBytes: 1,
      contentType: 'image/png',
      kind: 'image',
      href: 'evidence/checkpoint.png',
      storageLocations: [],
    }],
    primaryCounts: { total: 1, images: 1, videos: 0 },
  });
  const descriptor = await writeGalleryArchive({
    outputDir,
    catalog,
    exportedAt: '2026-08-24T12:00:00.000Z',
    maxRowsPerChunk: 1,
  });
  const run = {
    directory: runDirectory,
    manifest: {
      id: 'integrity-run',
      status: 'passed',
      finishedAt: '2026-08-24T12:01:00.000Z',
      pipeline: { status: 'completed', completed: true },
      stages: { reportRebuild: { status: 'completed' } },
    },
  };
  const snapshot = await loadGallerySnapshot(run);
  assert.equal(snapshot.rows.length, 1);

  const queryFile = path.join(outputDir, ...descriptor.query.chunks[0]!.href.split('/'));
  const originalQuery = await readFile(queryFile);
  const corruptedQuery = Buffer.from(originalQuery);
  const payloadOffset = corruptedQuery.indexOf('data-gallery-payload="') + 'data-gallery-payload="'.length;
  assert(payloadOffset > 'data-gallery-payload="'.length);
  corruptedQuery[payloadOffset] = corruptedQuery[payloadOffset] === 65 ? 66 : 65;
  await writeFile(queryFile, corruptedQuery);
  await assert.rejects(() => loadGallerySnapshot(run), /content hash verification/i);
  await writeFile(queryFile, originalQuery);

  const currentFile = path.join(outputDir, 'gallery', 'current.json');
  const revisionRoot = path.join(outputDir, 'gallery', 'revisions', descriptor.exportRevision);
  const descriptorFile = path.join(revisionRoot, 'descriptor.json');
  const integrityFile = path.join(revisionRoot, 'integrity.json');
  const rawReference = descriptor.raw.chunks[0]!;
  assert(rawReference, 'The one-blob fixture must publish a raw metadata chunk.');
  const rawFile = path.join(outputDir, ...rawReference.href.split('/'));
  const rawPayload = decodeArchive(await readFile(rawFile, 'utf8'));
  rawPayload.rows.push(structuredClone(rawPayload.rows[0]));
  const changedRaw = archiveWrapper(rawPayload);
  await writeFile(rawFile, changedRaw);

  const changedDescriptor = structuredClone(descriptor);
  changedDescriptor.raw.chunks[0]!.bytes = Buffer.byteLength(changedRaw);
  const descriptorSource = `${JSON.stringify(changedDescriptor)}\n`;
  await writeFile(currentFile, descriptorSource);
  await writeFile(descriptorFile, descriptorSource);

  const integrity = JSON.parse(await readFile(integrityFile, 'utf8'));
  updateIntegrityRecord(integrity, 'descriptor.json', Buffer.from(descriptorSource));
  updateIntegrityRecord(integrity, path.relative(revisionRoot, rawFile).split(path.sep).join('/'), Buffer.from(changedRaw));
  await writeFile(integrityFile, `${JSON.stringify(integrity)}\n`);
  await assert.rejects(() => loadGallerySnapshot(run), /raw index does not match|actual row total/i);

  console.log('Portal gallery integrity self-test passed: sealed descriptors, content hashes, actual chunk bytes, and decoded row counts fail closed under mutation.');
} finally {
  await rm(root, { recursive: true, force: true });
}

function archiveWrapper(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `<!doctype html><meta charset="utf-8"><body data-gallery-payload="${encoded}"><script>(()=>{})()</script></body>`;
}

function decodeArchive(source: string): any {
  const encoded = source.match(/data-gallery-payload="([A-Za-z0-9+/=]+)"/)?.[1];
  assert(encoded);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function updateIntegrityRecord(document: any, relativePath: string, bytes: Buffer): void {
  const record = document.files.find(({ path: candidate }: { path: string }) => candidate === relativePath);
  assert(record, `Missing integrity record for ${relativePath}.`);
  record.sizeBytes = bytes.length;
  record.sha256 = createHash('sha256').update(bytes).digest('hex');
}
