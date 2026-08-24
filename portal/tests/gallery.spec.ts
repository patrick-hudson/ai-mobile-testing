import { expect, test, type APIRequestContext } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ALL_AUDIT_CATALOG } from '../../audit/definitions.js';
import {
  applyGalleryFlagTransition,
  emptyGalleryFlagHistory,
  galleryFlagRevision,
} from '../../shared/gallery-contract.mjs';
import {
  publishLiveGalleryAttempt,
  type LiveGalleryAttemptInput,
} from '../../reporters/live-gallery-reporter.js';
import { buildGalleryCatalog, writeGalleryArchive } from '../../reporters/gallery-model.js';
import {
  GALLERY_SCALE,
  buildGalleryScaleCatalog,
  countGalleryScaleCorpusFiles,
  materializeGalleryScaleCorpus,
  type GalleryScaleMaterialization,
} from '../../scripts/gallery-scale-fixture.js';

test.describe.configure({ mode: 'serial' });
const execFileAsync = promisify(execFile);

function syntheticNotReadyRelease(reason: string, decisionBasis: string) {
  return {
    decision: 'NOT_READY',
    ready: false,
    reason,
    decisionBasis,
    blockingFailures: 1,
    blockingIncomplete: 0,
    baselineIssues: 0,
    runIntegrityFailure: false,
  };
}

function galleryAttempt(
  id: string,
  title: string,
  status: string,
  imageName: string,
  sourceShard: { ordinal: number; total: number },
  retry = 0,
): LiveGalleryAttemptInput['test'] {
  return {
    id,
    title,
    titlePath: ['gallery fixture', title],
    file: 'portal/tests/gallery.fixture.ts',
    line: 1,
    column: 1,
    projectName: 'candidate-mobile-chromium',
    projectMetadata: {
      environment: 'candidate',
      browserLabel: 'Chromium / Pixel 5',
      deviceClass: 'mobile',
      fullSweep: true,
      visual: true,
      tlsPolicy: 'strict',
    },
    sourceShard,
    annotations: [{ type: 'audit-id', description: 'NAV-001' }],
    tags: [],
    results: [{
      status,
      expectedStatus: 'passed',
      duration: 25,
      retry,
      startedAt: new Date().toISOString(),
      errors: [],
      stdout: [],
      stderr: [],
      attachments: [
        {
          name: imageName,
          contentType: 'image/png',
          body: Buffer.concat([
            Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/2pQmWQAAAABJRU5ErkJggg==', 'base64'),
            Buffer.from(`fixture:${id}:${retry}`),
          ]),
        },
        { name: 'unvalidated-interaction-video', contentType: 'video/webm', body: Buffer.from('not-yet-validated') },
      ],
    }],
  };
}

async function discoverExternalRun(root: string, id: string): Promise<string> {
  const directory = join(root, id);
  await mkdir(join(directory, 'logs'), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(directory, 'logs', 'coordinator.log'), [
    `${now} [COORDINATOR] sharded-release-started ${JSON.stringify({ runId: id, shardTotal: 2, startedAt: now })}`,
    `${now} [COORDINATOR] command-started ${JSON.stringify({ label: 'SHARD 1/2', command: ['playwright', 'test'] })}`,
    `${now} [COORDINATOR] command-started ${JSON.stringify({ label: 'SHARD 2/2', command: ['playwright', 'test'] })}`,
    '',
  ].join('\n'));
  return directory;
}

async function waitForRun(request: APIRequestContext, id: string): Promise<void> {
  await expect.poll(async () => (await request.get(`/api/runs/${encodeURIComponent(id)}`)).status(), {
    timeout: 10_000,
  }).toBe(200);
}

async function waitForGalleryPhase(request: APIRequestContext, id: string, phase: 'live' | 'sealed'): Promise<void> {
  await expect.poll(async () => {
    const response = await request.get(`/api/runs/${encodeURIComponent(id)}/gallery`);
    return response.ok() ? (await response.json()).phase : 'missing';
  }, { timeout: 30_000 }).toBe(phase);
}

async function captureNextGalleryEvent(runId: string, trigger: () => Promise<void>): Promise<string> {
  const baseURL = process.env.PORTAL_E2E_BASE_URL;
  if (!baseURL) throw new Error('PORTAL_E2E_BASE_URL is required.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${baseURL}/api/runs/${encodeURIComponent(runId)}/events`, {
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`SSE connection failed with ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('event: snapshot')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE connection ended before its initial snapshot.');
      received += decoder.decode(chunk.value, { stream: true });
    }
    received = '';
    await trigger();
    while (!received.includes('event: gallery')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    return received;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function captureInitialGalleryStream(runId: string): Promise<string> {
  const baseURL = process.env.PORTAL_E2E_BASE_URL;
  if (!baseURL) throw new Error('PORTAL_E2E_BASE_URL is required.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${baseURL}/api/runs/${encodeURIComponent(runId)}/gallery/events`, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Gallery SSE connection failed with ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('event: snapshot')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
      if (received.length > 70 * 1024) throw new Error('Gallery SSE replay exceeded its bounded envelope.');
    }
    return received;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function percentile95(samples: number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
}

function scaleFlagHistory(count: number) {
  const catalog = buildGalleryScaleCatalog();
  let history = emptyGalleryFlagHistory();
  for (const [index, item] of catalog.items.slice(0, count).entries()) {
    history = applyGalleryFlagTransition(history, {
      action: 'open',
      itemId: item.id,
      identity: {
        testId: item.test.id,
        title: item.test.title,
        project: item.project.name,
        attempt: item.attempt.ordinal,
        auditIds: item.auditAssociations.map(({ id }) => id),
      },
      reviewer: 'Scale reviewer',
      note: `Reference-scale visual issue ${index}.`,
      expectedFlagRevision: galleryFlagRevision(history),
      idempotencyKey: `scale-open-${String(index).padStart(4, '0')}`,
      eventId: `gfevent_${index.toString(16).padStart(16, '0')}`,
      flagId: `gflag_${index.toString(16).padStart(16, '0')}`,
      timestamp: new Date(Date.UTC(2026, 7, 24, 14, 0, index % 60)).toISOString(),
    }).history;
  }
  return history;
}

async function publishReferenceScaleRun(root: string, runId: string): Promise<{
  runDirectory: string;
  checklistRoot: string;
  materialization: GalleryScaleMaterialization;
}> {
  const runDirectory = await discoverExternalRun(root, runId);
  const checklistRoot = join(runDirectory, 'checklist');
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/2pQmWQAAAABJRU5ErkJggg==', 'base64');
  const generatedVideo = join(runDirectory, 'scale-action-response.webm');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12',
    '-t', '2', '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', generatedVideo,
  ]);
  const videoBytes = await readFile(generatedVideo);
  const catalog = buildGalleryScaleCatalog({ imageBytes: pixel, videoBytes });
  await writeGalleryArchive({ outputDir: checklistRoot, catalog, exportedAt: '2026-08-24T12:00:00.000Z' });
  const materialization = await materializeGalleryScaleCorpus({
    catalog,
    archiveRoot: checklistRoot,
    storageRoot: runDirectory,
    imageBytes: pixel,
    videoBytes,
  });
  await unlink(generatedVideo);
  const finishedAt = new Date().toISOString();
  await writeFile(join(runDirectory, 'sharded-run.json'), `${JSON.stringify({
    schemaVersion: 2, runId, startedAt: finishedAt, finishedAt, shardTotal: 4,
    pipeline: { status: 'completed', completed: true, reason: 'Canonical reference-scale gallery fixture.', finishedAt },
    release: syntheticNotReadyRelease('Reference-scale fixture.', 'Gallery performance acceptance.'),
    status: 'not-ready',
  })}\n`);
  return { runDirectory, checklistRoot, materialization };
}

async function canonicalContainerProfile(): Promise<{ cpuCores: number | null; memoryBytes: number | null }> {
  let cpuCores: number | null = null;
  let memoryBytes: number | null = null;
  try {
    const [quota, period] = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(/\s+/);
    if (quota !== 'max') cpuCores = Number(quota) / Number(period);
  } catch { /* Non-cgroup host runs are informational only. */ }
  try {
    const value = (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim();
    if (value !== 'max') memoryBytes = Number(value);
  } catch { /* Non-cgroup host runs are informational only. */ }
  return { cpuCores, memoryBytes };
}

test('live gallery API publishes closed-attempt images, merges shards, and recovers stale cursors', async ({ request }) => {
  const shardedRoot = process.env.PORTAL_E2E_SERVER_SHARDED_ARTIFACT_ROOT;
  expect(shardedRoot).toBeTruthy();
  const runId = `gallery-live-${Date.now()}`;
  const runDirectory = await discoverExternalRun(shardedRoot!, runId);
  const shardOne = join(runDirectory, 'shards', 'shard-1-of-2');
  const shardTwo = join(runDirectory, 'shards', 'shard-2-of-2');

  await publishLiveGalleryAttempt({
    outputDir: shardOne,
    test: galleryAttempt('gallery-test-a', 'Stable selected evidence', 'passed', 'stable.png', { ordinal: 1, total: 2 }),
  });
  await publishLiveGalleryAttempt({
    outputDir: shardTwo,
    test: galleryAttempt('gallery-test-b', 'New attention evidence', 'failed', 'attention.png', { ordinal: 2, total: 2 }),
  });
  await waitForRun(request, runId);

  const headResponse = await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery`);
  expect(headResponse.status(), await headResponse.text()).toBe(200);
  const head = await headResponse.json();
  expect(head).toMatchObject({ phase: 'live', primaryCounts: { total: 2, images: 2, videos: 0 } });
  expect(Number(headResponse.headers()['content-length'])).toBeLessThanOrEqual(256 * 1024);
  const initialGalleryStream = await captureInitialGalleryStream(runId);
  expect(initialGalleryStream).toContain('event: snapshot');
  expect(initialGalleryStream).not.toContain('event: log');
  expect(initialGalleryStream).not.toContain('productionUrl');

  const firstResponse = await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery/items?limit=1&sort=attention`);
  expect(firstResponse.status(), await firstResponse.text()).toBe(200);
  const first = await firstResponse.json();
  expect(first.contentRevision).toBe(head.contentRevision);
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({ status: 'failed', kind: 'image' });
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = await (await request.get(
    `/api/runs/${encodeURIComponent(runId)}/gallery/items?limit=1&sort=attention&cursor=${encodeURIComponent(first.nextCursor)}`,
  )).json();
  expect(second.items).toHaveLength(1);
  expect(new Set([first.items[0].id, second.items[0].id]).size).toBe(2);

  const selectedId = second.items[0].id as string;
  const selectedDetail = await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery/items/${encodeURIComponent(selectedId)}`);
  expect(selectedDetail.status(), await selectedDetail.text()).toBe(200);
  const selected = await selectedDetail.json();
  expect(selected.item.id).toBe(selectedId);
  expect(selected.media).toHaveLength(1);
  expect(selected.media[0].href).toMatch(/^\/artifacts\//);

  const flagCapability = await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery/flags`);
  expect(flagCapability.status(), await flagCapability.text()).toBe(200);
  const initialFlags = await flagCapability.json();
  expect(initialFlags).toMatchObject({
    throughEvent: 0,
    flags: [],
    capability: { mutable: true, identity: 'local-attribution', authenticated: false },
  });
  const sharedCapability = await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery/flags`, {
    headers: { Host: 'shared-review.example.test' },
  });
  expect(sharedCapability.status(), await sharedCapability.text()).toBe(200);
  expect(await sharedCapability.json()).toMatchObject({
    capability: { mutable: false, identity: 'read-only', authenticated: false },
  });
  const sharedMutation = await request.post(`/api/runs/${encodeURIComponent(runId)}/gallery/flags`, {
    headers: { Host: 'shared-review.example.test' },
    data: {
      itemId: selectedId,
      reviewer: 'Shared reviewer',
      note: 'This must not be accepted without authenticated identity.',
      expectedFlagRevision: initialFlags.flagRevision,
      idempotencyKey: `shared-${runId}`,
    },
  });
  expect(sharedMutation.status()).toBe(403);
  expect(await sharedMutation.json()).toMatchObject({ code: 'GALLERY_FLAG_READ_ONLY' });
  const oversizedMutation = await request.post(`/api/runs/${encodeURIComponent(runId)}/gallery/flags`, {
    data: {
      itemId: selectedId,
      reviewer: 'R'.repeat(121),
      note: 'Bounded reviewer metadata must fail without appending history.',
      expectedFlagRevision: initialFlags.flagRevision,
      idempotencyKey: `oversized-${runId}`,
    },
  });
  expect(oversizedMutation.status()).toBe(413);
  expect(await oversizedMutation.json()).toMatchObject({ code: 'GALLERY_FLAG_TOO_LARGE' });
  expect(await (await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery/flags`)).json()).toMatchObject({
    throughEvent: 0,
    flags: [],
  });
  const releaseBeforeFlag = await readFile(join(runDirectory, 'sharded-run.json'), 'utf8').catch(() => null);
  const openedResponse = await request.post(`/api/runs/${encodeURIComponent(runId)}/gallery/flags`, {
    data: {
      itemId: selectedId,
      reviewer: 'Portal reviewer',
      note: 'The selected evidence needs a closer visual review.',
      expectedFlagRevision: initialFlags.flagRevision,
      idempotencyKey: `open-${runId}`,
    },
  });
  expect(openedResponse.status(), await openedResponse.text()).toBe(201);
  const opened = await openedResponse.json();
  expect(opened).toMatchObject({ accepted: true, idempotent: false, event: { action: 'opened', sequence: 1 } });
  expect(await readFile(join(runDirectory, 'sharded-run.json'), 'utf8').catch(() => null)).toBe(releaseBeforeFlag);
  const flagOnlyDeltaResponse = await request.get(
    `/api/runs/${encodeURIComponent(runId)}/gallery/delta?fromContentRevision=${encodeURIComponent(head.contentRevision)}&fromOrderRevision=${encodeURIComponent(head.orderRevision)}&fromFlagRevision=${encodeURIComponent(head.flagRevision)}`,
  );
  expect(flagOnlyDeltaResponse.status(), await flagOnlyDeltaResponse.text()).toBe(200);
  const flagOnlyDelta = await flagOnlyDeltaResponse.json();
  expect(flagOnlyDelta.contentRevision).toBe(head.contentRevision);
  expect(flagOnlyDelta.flagRevision).toBe(opened.flagRevision);
  expect(flagOnlyDelta.changedIds).toContain(selectedId);

  const repeatedOpen = await request.post(`/api/runs/${encodeURIComponent(runId)}/gallery/flags`, {
    data: {
      itemId: selectedId,
      reviewer: 'Portal reviewer',
      note: 'The selected evidence needs a closer visual review.',
      expectedFlagRevision: initialFlags.flagRevision,
      idempotencyKey: `open-${runId}`,
    },
  });
  expect(repeatedOpen.status(), await repeatedOpen.text()).toBe(200);
  expect(await repeatedOpen.json()).toMatchObject({ accepted: true, idempotent: true, event: { eventId: opened.event.eventId } });

  const staleFlag = await request.post(`/api/runs/${encodeURIComponent(runId)}/gallery/flags/${encodeURIComponent(opened.event.flagId)}/transitions`, {
    data: {
      action: 'resolve',
      reviewer: 'Portal reviewer',
      justification: 'Checked against the intended redesign.',
      expectedFlagRevision: initialFlags.flagRevision,
      idempotencyKey: `stale-${runId}`,
    },
  });
  expect(staleFlag.status()).toBe(409);

  const resolvedResponse = await request.post(`/api/runs/${encodeURIComponent(runId)}/gallery/flags/${encodeURIComponent(opened.event.flagId)}/transitions`, {
    data: {
      action: 'resolve',
      reviewer: 'Portal reviewer',
      justification: 'Checked against the intended redesign.',
      expectedFlagRevision: opened.flagRevision,
      idempotencyKey: `resolve-${runId}`,
    },
  });
  expect(resolvedResponse.status(), await resolvedResponse.text()).toBe(200);
  const resolved = await resolvedResponse.json();
  expect(resolved).toMatchObject({ event: { action: 'resolved', previousEventId: opened.event.eventId } });
  const flagHistory = await (await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery/flags`)).json();
  expect(flagHistory).toMatchObject({ throughEvent: 2, flags: [{ flagId: opened.event.flagId, state: 'resolved' }] });
  expect(flagHistory.events).toHaveLength(2);

  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const galleryEvent = await captureNextGalleryEvent(runId, async () => {
    await publishLiveGalleryAttempt({
      outputDir: shardOne,
      test: galleryAttempt('gallery-test-c', 'Later failed evidence', 'failed', 'later.png', { ordinal: 1, total: 2 }),
    });
  });
  expect(galleryEvent).toContain('New finalized gallery evidence is available');
  const frozenResponse = await request.get(
    `/api/runs/${encodeURIComponent(runId)}/gallery/items?limit=1&sort=attention&cursor=${encodeURIComponent(first.nextCursor)}&contentRevision=${encodeURIComponent(head.contentRevision)}&orderRevision=${encodeURIComponent(head.orderRevision)}&flagRevision=${encodeURIComponent(head.flagRevision)}`,
  );
  expect(frozenResponse.status(), await frozenResponse.text()).toBe(200);
  expect((await frozenResponse.json()).items).toEqual(second.items);
  const staleResponse = await request.get(
    `/api/runs/${encodeURIComponent(runId)}/gallery/items?limit=1&sort=attention&cursor=${encodeURIComponent(first.nextCursor)}&anchor=${encodeURIComponent(selectedId)}`,
  );
  expect(staleResponse.status()).toBe(409);
  expect(await staleResponse.json()).toMatchObject({
    code: 'GALLERY_CURSOR_STALE',
    recovery: { anchorItemId: selectedId },
  });
  const freshAnchor = await request.get(
    `/api/runs/${encodeURIComponent(runId)}/gallery/items?limit=1&sort=attention&anchor=${encodeURIComponent(selectedId)}`,
  );
  expect(freshAnchor.status(), await freshAnchor.text()).toBe(200);
  expect((await freshAnchor.json()).items[0].id).toBe(selectedId);
  expect((await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery/items/${encodeURIComponent(selectedId)}`)).status()).toBe(200);

  const deltaResponse = await request.get(
    `/api/runs/${encodeURIComponent(runId)}/gallery/delta?fromContentRevision=${encodeURIComponent(head.contentRevision)}&fromOrderRevision=${encodeURIComponent(head.orderRevision)}&fromFlagRevision=${encodeURIComponent(head.flagRevision)}`,
  );
  expect(deltaResponse.status(), await deltaResponse.text()).toBe(200);
  const delta = await deltaResponse.json();
  expect(delta.addedIds).toHaveLength(1);
  expect(delta.changedIds).toEqual([selectedId]);
  expect(delta.tombstones).toEqual([]);
  expect(delta).toMatchObject({
    fromContentRevision: head.contentRevision,
    fromOrderRevision: head.orderRevision,
    fromFlagRevision: head.flagRevision,
  });
  const ambiguousDelta = await request.get(
    `/api/runs/${encodeURIComponent(runId)}/gallery/delta?from=${encodeURIComponent(head.contentRevision)}`,
  );
  expect(ambiguousDelta.status()).toBe(400);

  const liveHeadPath = join(shardOne, 'gallery-live', 'current.json');
  const liveHead = JSON.parse(await readFile(liveHeadPath, 'utf8'));
  const liveRevision = JSON.parse(await readFile(join(shardOne, 'gallery-live', liveHead.revisionHref), 'utf8'));
  const laterItem = liveRevision.catalog.items.find((item: { test: { id: string } }) => item.test.id === 'gallery-test-c');
  const laterBlob = liveRevision.catalog.blobs.find((blob: { id: string }) => blob.id === laterItem.members[0].blobId);
  await unlink(join(shardOne, laterBlob.href));
  expect(await access(join(shardOne, laterBlob.href)).then(() => true, () => false)).toBe(false);
  const unavailable = await (await request.get(
    `/api/runs/${encodeURIComponent(runId)}/gallery/items/${encodeURIComponent(laterItem.id)}/availability`,
  )).json();
  expect(unavailable).toMatchObject({ state: 'tombstone', retryable: true });

  const sealedTests = [
    galleryAttempt('gallery-test-a', 'Stable selected evidence', 'passed', 'stable.png', { ordinal: 1, total: 2 }),
    galleryAttempt('gallery-test-b', 'New attention evidence', 'failed', 'attention.png', { ordinal: 2, total: 2 }),
    galleryAttempt('gallery-test-c', 'Later failed evidence', 'failed', 'later.png', { ordinal: 1, total: 2 }),
  ].map((test, index) => ({
    ...test,
    results: test.results.map((result) => ({
      ...result,
      attachments: result.attachments.map((attachment) => attachment.contentType.startsWith('video/')
        ? { ...attachment, mediaValidation: index === 0 ? 'accepted' as const : 'rejected' as const }
        : attachment),
    })),
  }));
  const checklistRoot = join(runDirectory, 'checklist');
  const sealedCatalog = await buildGalleryCatalog({
    outputDir: checklistRoot,
    tests: sealedTests,
    definitionCatalog: ALL_AUDIT_CATALOG,
  });
  await writeGalleryArchive({ outputDir: checklistRoot, catalog: sealedCatalog });
  const finishedAt = new Date().toISOString();
  await writeFile(join(runDirectory, 'sharded-run.json'), `${JSON.stringify({
    schemaVersion: 2,
    runId,
    startedAt: finishedAt,
    finishedAt,
    shardTotal: 2,
    pipeline: { status: 'completed', completed: true, reason: 'Synthetic sealed gallery fixture.', finishedAt },
    release: syntheticNotReadyRelease('Synthetic fixture.', 'Gallery acceptance.'),
    status: 'not-ready',
  })}\n`);
  await expect.poll(async () => {
    const response = await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery`);
    return response.ok() ? (await response.json()).phase : 'missing';
  }, { timeout: 10_000 }).toBe('sealed');
  const sealedHead = await (await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery`)).json();
  expect(sealedHead.primaryCounts).toMatchObject({ total: 4, images: 3, videos: 1 });
  const sealedVideos = await (await request.get(
    `/api/runs/${encodeURIComponent(runId)}/gallery/items?kind=video`,
  )).json();
  expect(sealedVideos.total).toBe(1);
  expect(sealedVideos.items[0].title).toBe('Stable selected evidence');

  const sealedReleaseTruth = await readFile(join(runDirectory, 'sharded-run.json'), 'utf8');
  const archivedBeforeFlagRefresh = sealedHead.exportRevision as string;
  const reopenResponse = await request.post(
    `/api/runs/${encodeURIComponent(runId)}/gallery/flags/${encodeURIComponent(opened.event.flagId)}/transitions`,
    {
      data: {
        action: 'reopen',
        reviewer: 'Portal reviewer',
        note: 'A second review still sees the visual concern.',
        expectedFlagRevision: resolved.flagRevision,
        idempotencyKey: `reopen-${runId}`,
      },
    },
  );
  expect(reopenResponse.status(), await reopenResponse.text()).toBe(200);
  const reopened = await reopenResponse.json();
  expect(reopened).toMatchObject({ event: { action: 'reopened', previousEventId: resolved.event.eventId } });
  const dismissResponse = await request.post(
    `/api/runs/${encodeURIComponent(runId)}/gallery/flags/${encodeURIComponent(opened.event.flagId)}/transitions`,
    {
      data: {
        action: 'dismiss',
        reviewer: 'Portal reviewer',
        justification: 'The redesigned component intentionally uses this treatment.',
        expectedFlagRevision: reopened.flagRevision,
        idempotencyKey: `dismiss-${runId}`,
      },
    },
  );
  expect(dismissResponse.status(), await dismissResponse.text()).toBe(200);
  const dismissed = await dismissResponse.json();
  expect(dismissed).toMatchObject({ event: { action: 'dismissed', previousEventId: reopened.event.eventId } });
  expect(await readFile(join(runDirectory, 'sharded-run.json'), 'utf8')).toBe(sealedReleaseTruth);

  const refreshedHead = await (await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery`)).json();
  expect(refreshedHead.flagRevision).toBe(dismissed.flagRevision);
  expect(refreshedHead.exportRevision).not.toBe(archivedBeforeFlagRefresh);
  const dismissedPage = await (await request.get(
    `/api/runs/${encodeURIComponent(runId)}/gallery/items?flagState=dismissed`,
  )).json();
  expect(dismissedPage.items.map(({ id }: { id: string }) => id)).toContain(selectedId);
  const currentDescriptor = JSON.parse(await readFile(join(checklistRoot, 'gallery', 'current.json'), 'utf8'));
  const flagsWrapper = await readFile(join(checklistRoot, currentDescriptor.flags.href), 'utf8');
  const encodedFlags = flagsWrapper.match(/data-gallery-payload="([A-Za-z0-9+/=]+)"/)?.[1];
  expect(encodedFlags).toBeTruthy();
  const archivedFlags = JSON.parse(Buffer.from(encodedFlags!, 'base64').toString('utf8'));
  expect(archivedFlags).toMatchObject({
    throughEvent: 4,
    mutable: false,
    flags: [{ flagId: opened.event.flagId, state: 'dismissed' }],
  });
  expect(archivedFlags.events).toHaveLength(4);
  expect(await access(join(checklistRoot, 'gallery', 'revisions', archivedBeforeFlagRefresh)).then(() => true, () => false)).toBe(true);

  for (let attempt = 0; attempt < 23; attempt += 1) {
    const invalid = await request.post(
      `/api/runs/${encodeURIComponent(runId)}/gallery/flags/${encodeURIComponent(opened.event.flagId)}/transitions`,
      {
        data: {
          action: 'reopen',
          reviewer: 'Portal reviewer',
          expectedFlagRevision: dismissed.flagRevision,
          idempotencyKey: `bounded-invalid-${attempt}-${runId}`,
        },
      },
    );
    expect(invalid.status()).toBe(400);
  }
  const rateLimited = await request.post(
    `/api/runs/${encodeURIComponent(runId)}/gallery/flags/${encodeURIComponent(opened.event.flagId)}/transitions`,
    {
      data: {
        action: 'reopen',
        reviewer: 'Portal reviewer',
        note: 'This otherwise valid request is over the bounded per-run rate.',
        expectedFlagRevision: dismissed.flagRevision,
        idempotencyKey: `rate-limited-${runId}`,
      },
    },
  );
  expect(rateLimited.status()).toBe(429);
  expect(await rateLimited.json()).toMatchObject({ code: 'GALLERY_FLAG_RATE_LIMIT' });
  expect(await (await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery/flags`)).json()).toMatchObject({
    throughEvent: 4,
  });

  const aborted = new AbortController();
  const interrupted = fetch(`${process.env.PORTAL_E2E_BASE_URL}/api/runs/${encodeURIComponent(runId)}/gallery/items?limit=100`, {
    signal: aborted.signal,
  });
  aborted.abort();
  await expect(interrupted).rejects.toThrow(/abort/i);
  expect((await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery`)).status()).toBe(200);

  const purge = await request.delete(`/api/runs/${encodeURIComponent(runId)}`, {
    data: { confirmation: `PURGE ${runId}` },
  });
  expect(purge.status(), await purge.text()).toBe(200);
  const purgedGallery = await request.get(`/api/runs/${encodeURIComponent(runId)}/gallery`);
  expect(purgedGallery.status()).toBe(410);
  expect(await purgedGallery.json()).toMatchObject({ code: 'GALLERY_RUN_PURGED' });
});

test('live gallery records stay isolated by run and only publish after the reporter receives a closed attempt', async ({ request }) => {
  const shardedRoot = process.env.PORTAL_E2E_SERVER_SHARDED_ARTIFACT_ROOT;
  expect(shardedRoot).toBeTruthy();
  const leftId = `gallery-left-${Date.now()}`;
  const rightId = `gallery-right-${Date.now()}`;
  const left = await discoverExternalRun(shardedRoot!, leftId);
  const right = await discoverExternalRun(shardedRoot!, rightId);
  const pendingRoot = join(left, 'shards', 'shard-1-of-2');
  expect(await access(join(pendingRoot, 'gallery-live', 'current.json')).then(() => true, () => false)).toBe(false);

  await publishLiveGalleryAttempt({
    outputDir: pendingRoot,
    test: galleryAttempt('left-only', 'Left only evidence', 'passed', 'left.png', { ordinal: 1, total: 2 }, 1),
  });
  await publishLiveGalleryAttempt({
    outputDir: join(right, 'shards', 'shard-2-of-2'),
    test: galleryAttempt('right-only', 'Right only evidence', 'passed', 'right.png', { ordinal: 2, total: 2 }),
  });
  await Promise.all([waitForRun(request, leftId), waitForRun(request, rightId)]);

  const leftPage = await (await request.get(`/api/runs/${encodeURIComponent(leftId)}/gallery/items`)).json();
  const rightPage = await (await request.get(`/api/runs/${encodeURIComponent(rightId)}/gallery/items`)).json();
  expect(leftPage.items.map(({ title }: { title: string }) => title)).toEqual(['Left only evidence']);
  expect(rightPage.items.map(({ title }: { title: string }) => title)).toEqual(['Right only evidence']);
  const leftDetail = await (await request.get(
    `/api/runs/${encodeURIComponent(leftId)}/gallery/items/${encodeURIComponent(leftPage.items[0].id)}`,
  )).json();
  expect(leftDetail.item.attempt).toMatchObject({ ordinal: 2, retry: 1 });
});

test('portal gallery opens before evidence, progresses asynchronously, and keeps review surfaces bounded', async ({ page, request }) => {
  const shardedRoot = process.env.PORTAL_E2E_SERVER_SHARDED_ARTIFACT_ROOT;
  expect(shardedRoot).toBeTruthy();
  const runId = `gallery-ui-${Date.now()}`;
  const runDirectory = await discoverExternalRun(shardedRoot!, runId);
  const syntheticSecret = `sk-ant-${'S'.repeat(40)}`;
  const coordinatorLog = join(runDirectory, 'logs', 'coordinator.log');
  await writeFile(coordinatorLog, `${await readFile(coordinatorLog, 'utf8')}\ncredential=${syntheticSecret}\n`);
  await waitForRun(request, runId);

  await page.goto(`/gallery.html?run=${encodeURIComponent(runId)}&from=runs&q=secret-search-value&raw=0&cursor=must-be-ignored`);
  await expect(page.getByRole('heading', { name: 'Test-first visual review' })).toBeVisible();
  await expect(page.locator('#gallery-phase')).toHaveText('Waiting for evidence');
  await expect(page.locator('#gallery-workbench')).toContainText('Waiting for finalized visual evidence');
  expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);

  const unsafeTitle = '<img src=x onerror="window.galleryInjected=true"> Review title';
  await publishLiveGalleryAttempt({
    outputDir: join(runDirectory, 'shards', 'shard-1-of-2'),
    test: galleryAttempt('ui-one', unsafeTitle, 'failed', 'ui-one.png', { ordinal: 1, total: 2 }),
  });
  await publishLiveGalleryAttempt({
    outputDir: join(runDirectory, 'shards', 'shard-2-of-2'),
    test: galleryAttempt('ui-two', 'Second gallery item', 'passed', 'ui-two.png', { ordinal: 2, total: 2 }),
  });

  await expect(page.locator('#gallery-counts')).toContainText('2 logical items', { timeout: 15_000 });
  await expect(page.locator('.gallery-activity')).not.toContainText('secret-search-value');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.gallery-viewer h2')).toContainText('Review title');
  expect(await page.evaluate(() => (window as any).galleryInjected)).toBeUndefined();
  await expect(page.locator('.gallery-selected-image')).toHaveCount(1);
  await expect(page.locator('.gallery-selected-video')).toHaveCount(0);
  await page.getByRole('button', { name: 'Flag visual issue' }).click();
  await expect(page.getByRole('dialog', { name: 'Flag a visual issue' })).toBeVisible();
  await page.getByLabel('Local reviewer label').fill('Portal reviewer');
  await page.getByLabel('Detailed observation').fill('Review the responsive spacing.');
  await page.getByRole('button', { name: 'Open visual issue' }).click();
  await expect(page.locator('#gallery-flag-state')).toContainText('Reviewer event saved');
  await expect(page.getByRole('dialog', { name: 'Flag a visual issue' })).toBeHidden();
  await page.getByRole('button', { name: 'Apply updated order' }).click();
  await expect(page.locator('.gallery-review-state')).toContainText('Review the responsive spacing.');
  const liveFlagFilter = page.locator('select[data-query-key="flagStates"]');
  await expect(liveFlagFilter.locator('option[value="open"]')).toHaveCount(1);
  await liveFlagFilter.selectOption('open');
  await expect(page.locator('.gallery-review-state')).toContainText('Review the responsive spacing.');
  await expect(page.locator('.gallery-status')).toContainText('1 of 1');
  await liveFlagFilter.selectOption('');
  expect(await page.evaluate(() => localStorage.getItem('quitting7oh.gallery.reviewer-label.v1'))).toBe('Portal reviewer');
  await expect(page.locator('.gallery-activity')).toContainText('GET /api/runs/:run/gallery/items');

  await page.locator('#raw-drawer summary').click();
  await expect(page.locator('#raw-files .artifact-link').first()).toBeVisible();
  await expect(page.locator('#gallery-counts')).toContainText('2 logical items');
  await page.locator('#execution-drawer summary').click();
  await expect(page.locator('#execution-state')).not.toHaveText('Not loaded');
  await expect(page.locator('#execution-log')).toContainText('[REDACTED]');
  await expect(page.locator('#execution-log')).not.toContainText(syntheticSecret);

  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/item=gitem_[a-f0-9]{16}/);
  await page.keyboard.press('i');
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.gallery-page-skeleton span').first().evaluate((node) => getComputedStyle(node).animationName)).toBe('none');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const controls = page.locator('.gallery-controls button:visible');
  const controlSizes = await controls.evaluateAll((nodes) => nodes.slice(0, 6).map((node) => ({
    height: node.getBoundingClientRect().height,
    minHeight: getComputedStyle(node).minHeight,
  })));
  expect(controlSizes.length).toBeGreaterThan(0);
  expect(controlSizes.every(({ minHeight }) => minHeight === '44px'), JSON.stringify(controlSizes)).toBeTruthy();

  await page.goto('/');
  await expect(page.locator(`a.run-gallery-link[aria-label*="${runId}"]`)).toHaveAttribute('href', `/gallery.html?run=${runId}&from=runs`);
  await page.goto(`/report.html?run=${encodeURIComponent(runId)}`);
  await expect(page.locator('#visual-gallery-link')).toBeVisible();
  await expect(page.locator('#visual-gallery-link')).toHaveAttribute('href', `/gallery.html?run=${runId}&from=report`);
});

test('sealed archive gallery is the same bounded read-only workbench over HTTP and file URLs', async ({ page, request }) => {
  const shardedRoot = process.env.PORTAL_E2E_SERVER_SHARDED_ARTIFACT_ROOT;
  expect(shardedRoot).toBeTruthy();
  const runId = `gallery-archive-ui-${Date.now()}`;
  const runDirectory = await discoverExternalRun(shardedRoot!, runId);
  const checklistRoot = join(runDirectory, 'checklist');
  const tests = [
    galleryAttempt('archive-ui-a', 'Archive navigation failure', 'failed', 'archive-failed.png', { ordinal: 1, total: 1 }),
    galleryAttempt('archive-ui-b', 'Archive content success', 'passed', 'archive-passed.png', { ordinal: 1, total: 1 }),
  ].map((source) => ({
    ...source,
    results: source.results.map((result) => ({
      ...result,
      attachments: result.attachments.filter(({ contentType }) => !contentType.startsWith('video/')),
    })),
  }));
  const catalog = await buildGalleryCatalog({ outputDir: checklistRoot, tests, definitionCatalog: ALL_AUDIT_CATALOG });
  const flaggedItem = catalog.items[0];
  expect(flaggedItem).toBeTruthy();
  const descriptor = await writeGalleryArchive({
    outputDir: checklistRoot,
    catalog,
    exportedAt: '2026-08-24T18:00:00.000Z',
    maxRowsPerChunk: 1,
    flagSnapshot: {
      schemaVersion: 1,
      throughEvent: 1,
      flags: [{
        flagId: 'gflag_1111111111111111', itemId: flaggedItem!.id, testId: 'archive-ui-a', state: 'open',
        reviewer: '<unsafe reviewer>', note: 'Review the responsive spacing.', justification: null,
        updatedAt: '2026-08-24T18:00:00.000Z', eventId: 'gfevent_1111111111111111',
      }],
      events: [{
        schemaVersion: 1, sequence: 1, eventId: 'gfevent_1111111111111111', flagId: 'gflag_1111111111111111',
        previousEventId: null, action: 'opened', itemId: flaggedItem!.id,
        identity: { testId: 'archive-ui-a', title: '<unsafe flag title>' }, reviewer: '<unsafe reviewer>',
        note: 'Review the responsive spacing.', justification: null, timestamp: '2026-08-24T18:00:00.000Z',
        idempotencyKey: 'archive-ui-open', requestFingerprint: '1111111111111111', expectedFlagRevision: 'flags_0000000000000000',
      }],
    },
  });
  const finishedAt = new Date().toISOString();
  await writeFile(join(runDirectory, 'sharded-run.json'), `${JSON.stringify({
    schemaVersion: 2, runId, startedAt: finishedAt, finishedAt, shardTotal: 1,
    pipeline: { status: 'completed', completed: true, reason: 'Archive UI fixture.', finishedAt },
    release: syntheticNotReadyRelease('Fixture.', 'Archive acceptance.'),
    status: 'not-ready',
  })}\n`);
  await waitForRun(request, runId);
  await waitForGalleryPhase(request, runId, 'sealed');

  const requests = [] as string[];
  const consoleErrors = [] as string[];
  page.on('request', (event) => requests.push(new URL(event.url()).pathname));
  page.on('console', (event) => { if (event.type() === 'error') consoleErrors.push(event.text()); });
  await page.goto(`/artifacts/${encodeURIComponent(runId)}/checklist/gallery.html`);
  await expect(page.getByRole('heading', { name: 'Visual Evidence Gallery' })).toBeVisible();
  await expect(page.locator('.gallery-viewer h2')).toContainText('Archive navigation failure');
  await expect(page.locator('.gallery-selected-image')).toHaveCount(1);
  await expect(page.locator('.gallery-selected-video')).toHaveCount(0);
  await expect(page.locator('#gallery-export-revision')).toHaveText(descriptor.exportRevision.replace('export_', ''));
  await expect(page.locator('button', { hasText: /flag|issue/i })).toHaveCount(0);
  expect(requests.some((value) => value.endsWith('/manifest.json'))).toBe(false);
  expect(requests.filter((value) => /\/items\/.*\.html$/.test(value)).length).toBeLessThanOrEqual(10);

  await page.locator('#flag-drawer summary').click();
  await expect(page.locator('#flag-state')).toContainText('1 final flag projection');
  await expect(page.locator('#flag-history')).toContainText('<unsafe flag title>');
  expect(await page.evaluate(() => (window as any).unsafeReviewer)).toBeUndefined();
  await page.locator('#raw-drawer summary').click();
  await expect(page.locator('#raw-state')).toContainText('raw storage rows');
  await expect(page.locator('.gallery-status')).toContainText('1 of 2');
  expect(await page.locator('iframe').count()).toBe(0);

  const search = page.getByLabel('Search tests');
  await search.fill('content success');
  await search.press('Enter');
  await expect(page.locator('.gallery-viewer h2')).toContainText('Archive content success');
  expect(new URL(page.url()).searchParams.get('q')).toBe('content success');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/item=gitem_[a-f0-9]{16}/);

  consoleErrors.length = 0;
  await page.goto(pathToFileURL(join(checklistRoot, 'gallery.html')).href);
  await expect(page.getByRole('heading', { name: 'Visual Evidence Gallery' })).toBeVisible();
  await expect(page.locator('.gallery-viewer h2')).toContainText('Archive navigation failure');
  await expect(page.locator('.gallery-selected-image')).toHaveCount(1);
  await page.locator('#flag-drawer summary').click();
  await expect(page.locator('#flag-history')).toContainText('Final open');
  await expect(page.locator('#flag-history')).toContainText('Review the responsive spacing.');
  await page.locator('#raw-drawer summary').click();
  await expect(page.locator('#raw-state')).toContainText('raw storage rows');
  await page.getByLabel('Search tests').fill('content success');
  await page.getByLabel('Search tests').press('Enter');
  await expect(page.locator('.gallery-viewer h2')).toContainText('Archive content success');
  expect(await page.locator('iframe').count()).toBe(0);
  expect(consoleErrors).toEqual([]);
});

test('canonical reference-scale gallery satisfies KTD10, accessibility, and saved-evidence gates', async ({ playwright, request, baseURL }) => {
  test.skip(process.env.PORTAL_E2E_CANONICAL_PROFILE !== '1', 'Canonical measurements run only in the pinned 2 CPU / 4 GiB Docker service.');
  test.setTimeout(720_000);
  expect(baseURL).toBeTruthy();
  const canonicalBaseURL = baseURL!;
  const shardedRoot = process.env.PORTAL_E2E_SERVER_SHARDED_ARTIFACT_ROOT;
  const outputRoot = process.env.PORTAL_E2E_OUTPUT_DIR;
  expect(shardedRoot).toBeTruthy();
  expect(outputRoot).toBeTruthy();
  const browser = await playwright.chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
  const runId = `gallery-scale-${Date.now()}`;
  const { checklistRoot, runDirectory, materialization } = await publishReferenceScaleRun(shardedRoot!, runId);
  expect(materialization).toMatchObject({
    artifactHrefs: GALLERY_SCALE.reportArtifacts,
    storageCopies: GALLERY_SCALE.storedFiles - GALLERY_SCALE.reportArtifacts,
    storedFiles: GALLERY_SCALE.storedFiles,
    verifiedFiles: GALLERY_SCALE.storedFiles,
  });
  expect(await countGalleryScaleCorpusFiles({ archiveRoot: checklistRoot, storageRoot: runDirectory })).toEqual({
    artifactHrefs: GALLERY_SCALE.reportArtifacts,
    storageCopies: GALLERY_SCALE.storedFiles - GALLERY_SCALE.reportArtifacts,
    storedFiles: GALLERY_SCALE.storedFiles,
  });
  await waitForRun(request, runId);
  await waitForGalleryPhase(request, runId, 'sealed');
  console.log(`[GALLERY_SCALE] fixture-ready ${JSON.stringify({ runId, ...GALLERY_SCALE, materialization })}`);
  await mkdir(outputRoot!, { recursive: true });
  const route = `/gallery.html?run=${encodeURIComponent(runId)}&from=runs&kind=image`;
  const fastIteration = process.env.PORTAL_E2E_FAST_ITERATION === '1';
  const coldWarmups = fastIteration ? 0 : 5;
  const coldMeasureCount = fastIteration ? 1 : 30;
  const coldSamples: Array<{ durationMs: number; metadataRequests: number; metadataBytes: number }> = [];

  for (let sample = 0; sample < coldWarmups + coldMeasureCount; sample += 1) {
    const context = await browser.newContext({ baseURL: canonicalBaseURL });
    const page = await context.newPage();
    await page.goto(route);
    await page.waitForFunction(() => performance.getEntriesByName('gallery:first-usable').length === 1);
    await expect(page.locator('.gallery-viewer h2')).toBeVisible();
    await expect(page.locator('.gallery-queue [data-gallery-action="select-item"]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    const measurement = await page.evaluate(() => {
      const usable = performance.getEntriesByName('gallery:first-usable')[0]!;
      const navigation = performance.getEntriesByType('navigation')[0]!;
      const metadata = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).filter((entry) => {
        if (entry.startTime > usable.startTime) return false;
        const url = new URL(entry.name);
        return /\/api\/runs\/[^/]+\/gallery$/.test(url.pathname)
          || /\/api\/runs\/[^/]+\/gallery\/items$/.test(url.pathname)
          || /\/api\/runs\/[^/]+\/gallery\/items\/gitem_[a-f0-9]{16}$/.test(url.pathname);
      });
      return {
        durationMs: usable.startTime - navigation.startTime,
        metadataRequests: metadata.length,
        metadataBytes: metadata.reduce((total, entry) => total + (entry.encodedBodySize || entry.transferSize || 0), 0),
      };
    });
    if (sample >= coldWarmups) coldSamples.push(measurement);
    await context.close();
  }
  console.log(`[GALLERY_SCALE] cold-complete ${JSON.stringify({ samples: coldSamples.length, p95Ms: percentile95(coldSamples.map(({ durationMs }) => durationMs)) })}`);

  const videoDirectory = join(outputRoot!, 'visual-evidence-video');
  await mkdir(videoDirectory, { recursive: true });
  const context = await browser.newContext({
    baseURL: canonicalBaseURL,
    recordHar: { path: join(outputRoot!, 'gallery-scale-network.har.zip'), content: 'omit', mode: 'minimal' },
    recordVideo: { dir: videoDirectory, size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
  });
  await context.addInitScript(() => {
    (window as any).__archiveRequests = [];
    window.addEventListener('gallery:archive-request', (event) => {
      (window as any).__archiveRequests.push({ ...(event as CustomEvent).detail, at: performance.now() });
    });
  });
  const page = await context.newPage();
  await page.goto(route);
  await page.waitForFunction(() => performance.getEntriesByName('gallery:first-usable').length === 1);
  await expect(page.locator('.gallery-viewer h2')).toBeVisible();
  await page.screenshot({ path: join(outputRoot!, 'gallery-scale-workbench.png'), fullPage: true });

  const shell = page.locator('.gallery-shell');
  await shell.focus();
  const firstItemId = new URL(page.url()).searchParams.get('item');
  const defaultComparisonMember = new URL(page.url()).searchParams.get('member');
  await page.keyboard.press('ArrowLeft');
  expect(new URL(page.url()).searchParams.get('item')).toBe(firstItemId);
  await page.keyboard.press('Control+ArrowRight');
  expect(new URL(page.url()).searchParams.get('item')).toBe(firstItemId);
  await shell.evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, isComposing: true })));
  expect(new URL(page.url()).searchParams.get('item')).toBe(firstItemId);
  await page.keyboard.press(']');
  await expect.poll(() => new URL(page.url()).searchParams.get('member')).not.toBe(defaultComparisonMember);
  await page.keyboard.press('[');
  await expect.poll(() => new URL(page.url()).searchParams.get('member')).toBe(defaultComparisonMember);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => new URL(page.url()).searchParams.get('item')).not.toBe(firstItemId);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => new URL(page.url()).searchParams.get('item')).toBe(firstItemId);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => new URL(page.url()).searchParams.get('item')).not.toBe(firstItemId);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => new URL(page.url()).searchParams.get('item')).toBe(firstItemId);
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(page.getByRole('button', { name: 'Leave fullscreen' })).toBeVisible();
  await page.locator('.gallery-viewer').focus();
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  const contextToggle = page.locator('[data-focus-key="context-toggle"]');
  await expect(page.getByRole('heading', { name: 'Test context' })).toBeVisible();
  await contextToggle.focus();
  await expect(contextToggle).toBeFocused();
  console.log('[GALLERY_SCALE] keyboard-matrix-complete');
  await page.keyboard.press('i');
  await expect(page.getByRole('heading', { name: 'Test context' })).toHaveCount(0);
  await contextToggle.focus();
  await page.keyboard.press('i');
  await expect(page.getByRole('heading', { name: 'Test context' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Test context' })).toHaveCount(0);
  await expect(contextToggle).toBeFocused();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Gallery keyboard shortcuts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Gallery keyboard shortcuts' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(contextToggle).toBeFocused();

  const accessibility = await new AxeBuilder({ page }).include('#gallery-workbench').analyze();
  expect(accessibility.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')).toEqual([]);
  console.log(`[GALLERY_SCALE] accessibility-complete ${JSON.stringify({ violations: accessibility.violations.length })}`);
  await page.getByRole('button', { name: 'Shortcuts' }).click();
  await expect(page.getByRole('dialog', { name: 'Gallery keyboard shortcuts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Gallery keyboard shortcuts' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Shortcuts' })).toBeFocused();
  await page.locator('.gallery-shell').focus();
  await page.keyboard.press('i');
  await expect(page.getByRole('heading', { name: 'Test context' })).toBeVisible();
  await expect(page.locator('#gallery-announcer')).not.toHaveText('');
  const selectedBeforeEditableKey = new URL(page.url()).searchParams.get('item');
  await page.getByLabel('Search tests').focus();
  await page.keyboard.press('ArrowRight');
  expect(new URL(page.url()).searchParams.get('item')).toBe(selectedBeforeEditableKey);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.gallery-page-skeleton span').first().evaluate((node) => getComputedStyle(node).animationName)).toBe('none');

  await page.getByRole('button', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { name: 'Visual overview' })).toBeVisible();
  await page.screenshot({ path: join(outputRoot!, 'gallery-scale-overview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Workbench' }).click();
  if (await page.getByRole('heading', { name: 'Test context' }).count() === 0) {
    await page.getByRole('button', { name: 'Show context' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Test context' })).toBeVisible();

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const heapBeforeMetric = (await cdp.send('Performance.getMetrics')).metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value;
  if (typeof heapBeforeMetric !== 'number' || !Number.isFinite(heapBeforeMetric) || heapBeforeMetric <= 0) {
    throw new Error('CDP did not expose a real pre-traversal JSHeapUsedSize measurement.');
  }
  const heapBefore = heapBeforeMetric;
  const warmupTransitions = fastIteration ? 0 : 10;
  const warmMeasureCount = fastIteration ? 2 : 100;
  const warmSamples: number[] = [];
  let peakGalleryDomNodes = 0;
  let peakImages = 0;
  let peakVideos = 0;

  for (let index = 0; index < warmupTransitions + warmMeasureCount; index += 1) {
    const oldItemId = new URL(page.url()).searchParams.get('item');
    const oldTitle = await page.locator('.gallery-viewer h2').textContent();
    await page.evaluate(() => {
      performance.clearMarks('gallery:item-input');
      performance.mark('gallery:item-input');
      document.querySelector('.gallery-shell')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await expect.poll(() => new URL(page.url()).searchParams.get('item')).not.toBe(oldItemId);
    await expect(page.locator('.gallery-viewer h2')).not.toHaveText(oldTitle ?? '');
    await expect(page.locator('.gallery-selected-image')).toHaveCount(1);
    const elapsed = await page.evaluate(() => performance.now() - performance.getEntriesByName('gallery:item-input').at(-1)!.startTime);
    if (index >= warmupTransitions) warmSamples.push(elapsed);
    const counts = await page.locator('#gallery-workbench').evaluate((root) => ({
      dom: root.getElementsByTagName('*').length,
      images: root.querySelectorAll('img').length,
      videos: root.querySelectorAll('video').length,
    }));
    peakGalleryDomNodes = Math.max(peakGalleryDomNodes, counts.dom);
    peakImages = Math.max(peakImages, counts.images);
    peakVideos = Math.max(peakVideos, counts.videos);
  }

  await cdp.send('HeapProfiler.collectGarbage');
  const heapAfterMetric = (await cdp.send('Performance.getMetrics')).metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value;
  if (typeof heapAfterMetric !== 'number' || !Number.isFinite(heapAfterMetric) || heapAfterMetric <= 0) {
    throw new Error('CDP did not expose a real post-traversal JSHeapUsedSize measurement.');
  }
  const heapAfter = heapAfterMetric;
  const heapGrowthBytes = Math.max(0, heapAfter - heapBefore);
  console.log(`[GALLERY_SCALE] traversal-complete ${JSON.stringify({ samples: warmSamples.length, p95Ms: percentile95(warmSamples), peakGalleryDomNodes, heapGrowthBytes })}`);

  let delayedQueries = 0;
  await page.route('**/gallery/items?*', async (intercepted) => {
    delayedQueries += 1;
    await new Promise((resolve) => setTimeout(resolve, delayedQueries % 3 === 0 ? 45 : 10));
    await intercepted.continue().catch(() => {});
  });
  await page.evaluate(() => {
    const viewer = document.querySelector('.gallery-viewer');
    (window as any).__rapidSelectionTitles = [];
    (window as any).__rapidSelectionObserver = new MutationObserver(() => {
      (window as any).__rapidSelectionTitles.push(viewer?.querySelector('h2')?.textContent ?? '');
    });
    (window as any).__rapidSelectionObserver.observe(viewer!, { childList: true, subtree: true, characterData: true });
  });
  await page.getByLabel('Search tests').evaluate((input) => {
    for (let index = 0; index < 50; index += 1) {
      (input as HTMLInputElement).value = `reference evidence ${String(index).padStart(4, '0')}`;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await expect(page.locator('.gallery-viewer h2')).toContainText('Reference evidence 0049');
  await page.waitForTimeout(250);
  await expect(page.locator('.gallery-viewer h2')).toContainText('Reference evidence 0049');
  await expect(page.locator('.gallery-status')).toContainText('1 of 1');
  expect(new URL(page.url()).searchParams.get('q')).toBe('reference evidence 0049');
  const rapidSelectionTitles = await page.evaluate(() => {
    (window as any).__rapidSelectionObserver.disconnect();
    return (window as any).__rapidSelectionTitles as string[];
  });
  const finalCommit = rapidSelectionTitles.findIndex((title) => title.includes('Reference evidence 0049'));
  expect(finalCommit).toBeGreaterThanOrEqual(0);
  const staleCommits = rapidSelectionTitles.slice(finalCommit + 1)
    .filter((title) => !title.includes('Reference evidence 0049')).length;
  console.log(`[GALLERY_SCALE] stale-work-complete ${JSON.stringify({ rapidRequests: delayedQueries, observedCommits: rapidSelectionTitles.length, staleCommits })}`);

  const scaleFlags = scaleFlagHistory(150);
  await writeFile(join(runDirectory, 'visual-flags.json'), `${JSON.stringify(scaleFlags)}\n`);
  const triggerItem = buildGalleryScaleCatalog().items[150]!;
  const triggerResponse = await request.post(`/api/runs/${encodeURIComponent(runId)}/gallery/flags`, {
    data: {
      itemId: triggerItem.id,
      reviewer: 'Scale reviewer',
      note: 'Trigger the bounded multi-page delta notification.',
      expectedFlagRevision: galleryFlagRevision(scaleFlags),
      idempotencyKey: 'scale-open-trigger-0150',
    },
  });
  expect(triggerResponse.status(), await triggerResponse.text()).toBe(201);
  await expect(page.getByRole('button', { name: 'Apply updated order' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.gallery-revision-notice')).toContainText('151 new attention items available');
  await page.getByRole('button', { name: 'Apply updated order' }).click();
  const reviewerFlagFilter = page.locator('select[data-query-key="flagStates"]');
  await expect(reviewerFlagFilter.locator('option[value="open"]')).toHaveCount(1);
  await reviewerFlagFilter.selectOption('open');
  await expect(page.locator('.gallery-viewer h2')).toContainText('Reference evidence 0049');
  await expect(page.locator('.gallery-status')).toContainText('1 of 1');
  await reviewerFlagFilter.selectOption('');
  console.log('[GALLERY_SCALE] paginated-delta-complete {"changed":151,"pages":2,"flagFacet":"open"}');

  console.log('[GALLERY_SCALE] mobile-start');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await expect(page.getByLabel('Search tests')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  console.log('[GALLERY_SCALE] mobile-filters-cleared');
  const touchTargets = await page.locator('.gallery-controls button:visible').evaluateAll((nodes) => nodes.map((node) => ({
    width: node.getBoundingClientRect().width,
    height: node.getBoundingClientRect().height,
  })));
  expect(touchTargets.length).toBeGreaterThan(0);
  expect(touchTargets.every(({ width, height }) => width >= 44 && height >= 44)).toBeTruthy();
  console.log(`[GALLERY_SCALE] mobile-touch-targets ${JSON.stringify({ count: touchTargets.length })}`);
  await page.getByRole('button', { name: 'Close filters' }).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Search tests')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeFocused();
  console.log('[GALLERY_SCALE] mobile-filter-panel-closed');
  const mobileItem = new URL(page.url()).searchParams.get('item');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('item')).not.toBe(mobileItem);
  console.log('[GALLERY_SCALE] mobile-complete');

  await page.setViewportSize({ width: 1280, height: 720 });
  console.log('[GALLERY_SCALE] video-navigation-start');
  await page.goto(`/gallery.html?run=${encodeURIComponent(runId)}&from=runs&kind=video`);
  await page.waitForFunction(() => performance.getEntriesByName('gallery:first-usable').length === 1);
  console.log('[GALLERY_SCALE] video-first-usable');
  const selectedVideo = page.locator('.gallery-selected-video');
  await expect(selectedVideo).toHaveCount(1);
  await expect(page.locator('#gallery-workbench video')).toHaveCount(1);
  peakVideos = Math.max(peakVideos, await page.locator('#gallery-workbench video').count());
  await expect.poll(() => selectedVideo.evaluate((video: HTMLVideoElement) => video.duration)).toBeGreaterThan(0);
  console.log('[GALLERY_SCALE] video-metadata-ready');
  const videoRangeStatus = await selectedVideo.evaluate(async (video: HTMLVideoElement) => (
    await fetch(video.currentSrc || video.src, { headers: { Range: 'bytes=0-1023' } })
  ).status);
  expect(videoRangeStatus).toBe(206);
  console.log('[GALLERY_SCALE] video-range-ready');
  await page.locator('.gallery-viewer').focus();
  await page.keyboard.press('Space');
  await expect.poll(() => selectedVideo.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(() => selectedVideo.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await selectedVideo.evaluate((video: HTMLVideoElement) => { video.currentTime = Math.min(0.75, video.duration / 2); });
  await expect.poll(() => selectedVideo.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
  console.log(`[GALLERY_SCALE] video-complete ${JSON.stringify({ videoRangeStatus })}`);

  console.log('[GALLERY_SCALE] archive-navigation-start');
  await page.goto(pathToFileURL(join(checklistRoot, 'gallery.html')).href);
  await expect(page.getByRole('heading', { name: 'Visual Evidence Gallery' })).toBeVisible();
  await expect(page.locator('.gallery-viewer h2')).toBeVisible();
  await expect(page.getByText(/Read-only snapshot exported/)).toBeVisible();
  await page.screenshot({ path: join(outputRoot!, 'gallery-scale-archive-read-only.png'), fullPage: true });
  const archiveRequestRows = await page.evaluate(() => {
    const usable = performance.getEntriesByName('gallery:first-usable')[0]!;
    return ((window as any).__archiveRequests as Array<{ href: string; kind: string; at: number }>).filter(({ at }) => at <= usable.startTime);
  });
  const archiveCold = {
    wrapperRequests: archiveRequestRows.length,
    wrapperBytes: (await Promise.all(archiveRequestRows.map(({ href }) => stat(join(checklistRoot, ...href.split('/'))))))
      .reduce((sum, details) => sum + details.size, 0),
    requestKinds: archiveRequestRows.map((row) => row.kind),
  };
  expect(archiveCold.wrapperRequests).toBeLessThanOrEqual(3);
  expect(archiveCold.wrapperBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(await page.locator('iframe').count()).toBe(0);
  console.log(`[GALLERY_SCALE] archive-complete ${JSON.stringify(archiveCold)}`);

  const profile = await canonicalContainerProfile();
  const metrics = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    methodology: { coldWarmups, coldMeasures: coldMeasureCount, warmupTransitions, warmMeasures: warmMeasureCount },
    fixture: GALLERY_SCALE,
    materialization,
    container: profile,
    cold: { samples: coldSamples, p95Ms: percentile95(coldSamples.map(({ durationMs }) => durationMs)) },
    warm: { samplesMs: warmSamples, p95Ms: percentile95(warmSamples) },
    bounds: { peakGalleryDomNodes, peakImages, peakVideos, heapBefore, heapAfter, heapGrowthBytes, staleCommits },
    archiveCold,
  };
  await writeFile(join(outputRoot!, 'gallery-scale-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(`[GALLERY_SCALE] metrics-written ${JSON.stringify({ coldP95Ms: metrics.cold.p95Ms, warmP95Ms: metrics.warm.p95Ms, bounds: metrics.bounds })}`);
  console.log('[GALLERY_SCALE] evidence-finalization-start');
  const recordedVideo = page.video();
  await page.close();
  console.log('[GALLERY_SCALE] evidence-page-closed');
  if (recordedVideo) await recordedVideo.saveAs(join(outputRoot!, 'gallery-scale-navigation.webm'));
  console.log('[GALLERY_SCALE] evidence-video-saved');
  await context.close();
  console.log('[GALLERY_SCALE] evidence-context-closed');
  await browser.close();
  console.log('[GALLERY_SCALE] evidence-browser-closed');

  expect(profile.cpuCores).toBe(2);
  expect(profile.memoryBytes).toBe(4 * 1024 * 1024 * 1024);
  expect(coldSamples).toHaveLength(coldMeasureCount);
  expect(coldSamples.every(({ metadataRequests, metadataBytes }) => metadataRequests <= 3 && metadataBytes <= 1024 * 1024)).toBeTruthy();
  expect(metrics.cold.p95Ms).toBeLessThanOrEqual(2_000);
  expect(warmSamples).toHaveLength(warmMeasureCount);
  expect(metrics.warm.p95Ms).toBeLessThanOrEqual(200);
  expect(peakGalleryDomNodes).toBeLessThanOrEqual(500);
  expect(peakVideos).toBe(1);
  expect(heapGrowthBytes).toBeLessThanOrEqual(25 * 1024 * 1024);
  expect(staleCommits).toBe(0);
});
