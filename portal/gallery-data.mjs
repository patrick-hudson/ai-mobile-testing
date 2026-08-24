import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  GALLERY_DESCRIPTOR_MAX_BYTES,
  GALLERY_FLAG_HISTORY_MAX_BYTES,
  GALLERY_ITEM_DETAIL_MAX_BYTES,
  GALLERY_QUERY_CHUNK_MAX_BYTES,
  GALLERY_QUERY_CHUNK_MAX_ROWS,
  GALLERY_SCHEMA_VERSION,
  assertGalleryArchiveDescriptor,
  assertGalleryCatalog,
  assertGalleryItemDetail,
  assertGalleryQueryRow,
  boundedGalleryText,
  compareGalleryQueryRows,
  deriveGalleryTestGroupId,
  emptyGalleryFlagHistory,
  galleryFlagRevision,
  galleryFlagSnapshot,
  galleryQueryRowMatches,
  galleryItemHref,
  normalizeGalleryQuery,
  primaryGalleryAuditAssociation,
  stableGalleryKey,
} from '../shared/gallery-contract.mjs';
import { readGalleryFlagHistory } from '../scripts/gallery-flags.mjs';

const MAX_LIVE_REVISION_BYTES = 16 * 1024 * 1024;
const MAX_LIVE_AGGREGATE_BYTES = 64 * 1024 * 1024;
const MAX_LIVE_SOURCES = 64;
const MAX_SEALED_QUERY_BYTES = 64 * 1024 * 1024;
const MAX_SEALED_QUERY_CHUNKS = 1_024;
const MAX_SEALED_INTEGRITY_BYTES = 16 * 1024 * 1024;
const MAX_SEALED_INTEGRITY_RECORDS = 100_000;
const EMPTY_FLAG_REVISION = galleryFlagRevision(emptyGalleryFlagHistory());

export class GalleryHttpError extends Error {
  constructor(statusCode, message, detail = {}) {
    super(message);
    this.statusCode = statusCode;
    Object.assign(this, detail);
  }
}

export function galleryQueryFromUrl(requestUrl) {
  const list = (name) => requestUrl.searchParams.getAll(name)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return normalizeGalleryQuery({
    kinds: list('kind'),
    statuses: list('status'),
    environments: list('environment'),
    featureSuites: list('featureSuite'),
    technicalSuites: list('technicalSuite'),
    targets: list('target'),
    flagStates: list('flagState'),
    search: requestUrl.searchParams.get('q') ?? '',
    group: requestUrl.searchParams.get('group') ?? undefined,
    sort: requestUrl.searchParams.get('sort') ?? undefined,
  });
}

export async function loadGallerySnapshot(run, signal, options = {}) {
  assertActive(signal);
  const sealedHead = join(run.directory, 'checklist', 'gallery', 'current.json');
  const sealedAuthoritative = run.manifest?.stages?.reportRebuild?.status === 'completed'
    || run.manifest?.pipeline?.completed === true;
  if (sealedAuthoritative && await isFile(sealedHead)) {
    return await withReviewerFlags(
      await loadSealedSnapshot(run, sealedHead, signal, options.includeRows !== false),
      run,
      signal,
    );
  }
  const live = await loadLiveSnapshot(run, signal);
  if (live) return await withReviewerFlags(live, run, signal);
  if (await isFile(sealedHead)) {
    // Legacy completed runs may not have persisted per-stage state. Never use
    // an early sealed report while its evidence pipeline is still active.
    if (run.manifest?.finishedAt || run.manifest?.pipeline?.completed === true) {
      return await withReviewerFlags(
        await loadSealedSnapshot(run, sealedHead, signal, options.includeRows !== false),
        run,
        signal,
      );
    }
  }
  throw new GalleryHttpError(404, 'No finalized gallery evidence is available for this run yet.', {
    code: 'GALLERY_NOT_READY',
  });
}

export async function loadGalleryHead(run, signal) {
  const publication = await probeGalleryPublication(run, signal);
  if (!publication) {
    const flags = galleryFlagSnapshot(await readGalleryFlagHistory(run.directory));
    const contentRevision = `content_${stableGalleryKey({ runId: run.manifest.id, state: 'waiting' })}`;
    return {
      schemaVersion: GALLERY_SCHEMA_VERSION,
      phase: 'waiting',
      contentRevision,
      flagRevision: flags.flagRevision,
      orderRevision: `order_${stableGalleryKey({ contentRevision, flagRevision: flags.flagRevision, schemaVersion: 1 })}`,
      exportRevision: null,
      exportedAt: null,
      primaryCounts: { total: 0, images: 0, videos: 0 },
      facets: emptyFacets(),
      total: 0,
      lifecycle: galleryLifecycle(run.manifest),
    };
  }
  const flags = galleryFlagSnapshot(await readGalleryFlagHistory(run.directory));
  const publicationFacets = publication.facets ?? emptyFacets();
  return {
    ...publication,
    schemaVersion: GALLERY_SCHEMA_VERSION,
    exportRevision: publication.exportRevision ?? null,
    exportedAt: publication.exportedAt ?? null,
    facets: {
      ...publicationFacets,
      flagStates: unique([
        ...(publicationFacets.flagStates ?? []),
        ...flags.flags.map(({ state }) => state),
      ]),
    },
    total: publication.primaryCounts?.total ?? null,
    flagRevision: flags.flagRevision,
    orderRevision: `order_${stableGalleryKey({
      contentRevision: publication.contentRevision,
      flagRevision: flags.flagRevision,
      schemaVersion: 1,
    })}`,
    lifecycle: galleryLifecycle(run.manifest),
  };
}

function galleryLifecycle(manifest) {
  const terminal = Boolean(manifest?.finishedAt || manifest?.pipeline?.completed);
  return {
    status: typeof manifest?.status === 'string' ? manifest.status : 'unknown',
    phase: typeof manifest?.phase === 'string' ? manifest.phase : null,
    terminal,
    pipelineStatus: typeof manifest?.pipeline?.status === 'string' ? manifest.pipeline.status : null,
  };
}

export async function readGalleryFlags(run, signal) {
  assertActive(signal);
  const snapshot = galleryFlagSnapshot(await readGalleryFlagHistory(run.directory));
  assertActive(signal);
  return snapshot;
}

export async function probeGalleryPublication(run, signal) {
  const sealedHead = join(run.directory, 'checklist', 'gallery', 'current.json');
  const sealedAuthoritative = run.manifest?.stages?.reportRebuild?.status === 'completed'
    || run.manifest?.pipeline?.completed === true;
  if (sealedAuthoritative && await isFile(sealedHead)) {
    const descriptor = assertGalleryArchiveDescriptor(await readJsonBounded(
      sealedHead,
      GALLERY_DESCRIPTOR_MAX_BYTES,
      signal,
    ));
    await loadSealedIntegrity(join(run.directory, 'checklist'), descriptor, signal);
    return {
      phase: 'sealed',
      contentRevision: descriptor.contentRevision,
      flagRevision: descriptor.flagRevision,
      orderRevision: descriptor.orderRevision,
      exportRevision: descriptor.exportRevision,
      exportedAt: descriptor.exportedAt,
      primaryCounts: descriptor.primaryCounts,
      facets: descriptor.facets,
    };
  }
  const heads = [];
  for (const root of await liveRoots(run.directory, signal)) {
    const file = join(root, 'current.json');
    if (!await isFile(file)) continue;
    const head = await readJsonBounded(file, GALLERY_DESCRIPTOR_MAX_BYTES, signal);
    if (head?.schemaVersion !== GALLERY_SCHEMA_VERSION || head.phase !== 'live' || typeof head.contentRevision !== 'string') {
      continue;
    }
    heads.push({
      contentRevision: head.contentRevision,
      flagRevision: head.flagRevision,
      sourceShard: head.sourceShard ?? null,
      primaryCounts: head.primaryCounts,
      facets: head.facets,
    });
  }
  if (heads.length === 0) return null;
  const sourceRevisions = heads
    .map(({ contentRevision, sourceShard }) => ({ contentRevision, sourceShard }))
    .sort(compareLiveSourceRevision);
  const contentRevision = `content_${stableGalleryKey(sourceRevisions)}`;
  const flagRevision = heads.map(({ flagRevision }) => flagRevision).filter(Boolean).sort().at(-1) ?? EMPTY_FLAG_REVISION;
  return {
    phase: 'live',
    contentRevision,
    flagRevision,
    orderRevision: `order_${stableGalleryKey({ contentRevision, flagRevision, schemaVersion: 1 })}`,
    primaryCounts: heads.reduce((counts, head) => ({
      total: counts.total + (head.primaryCounts?.total ?? 0),
      images: counts.images + (head.primaryCounts?.images ?? 0),
      videos: counts.videos + (head.primaryCounts?.videos ?? 0),
    }), { total: 0, images: 0, videos: 0 }),
    facets: mergeFacets(heads.map(({ facets }) => facets)),
  };
}

export function publicGalleryHead(snapshot) {
  return snapshot.head;
}

export function gallerySnapshotFingerprints(snapshot) {
  return new Map(snapshot.rows.map((row) => [row.id, stableGalleryKey(row)]));
}

export async function pageGallerySnapshot(snapshot, query, options = {}, signal) {
  const normalized = normalizeGalleryQuery(query);
  const queryKey = stableGalleryKey(normalized);
  const decoded = options.cursor ? decodeCursor(options.cursor) : null;
  if (decoded && (
    decoded.contentRevision !== snapshot.head.contentRevision
    || decoded.orderRevision !== snapshot.head.orderRevision
    || decoded.flagRevision !== snapshot.head.flagRevision
    || decoded.queryKey !== queryKey
  )) {
    throw new GalleryHttpError(409, 'The gallery changed while this page sequence was open. Resnapshot and restore the selected item by ID.', {
      code: 'GALLERY_CURSOR_STALE',
      head: snapshot.head,
      recovery: {
        href: null,
        anchorItemId: options.anchorItemId ?? decoded.lastItemId ?? null,
      },
    });
  }
  const requestedLimit = Math.max(1, Math.min(options.limit ?? 50, GALLERY_QUERY_CHUNK_MAX_ROWS));
  const matches = await queryRowsCancellable(snapshot.rows, normalized, signal);
  const anchorIndex = !decoded && options.anchorItemId
    ? matches.findIndex(({ id }) => id === options.anchorItemId)
    : -1;
  const offset = decoded?.offset ?? (anchorIndex >= 0 ? Math.floor(anchorIndex / requestedLimit) * requestedLimit : 0);
  let selected = matches.slice(offset, offset + requestedLimit);
  let response;
  while (selected.length > 0) {
    const nextOffset = offset + selected.length;
    response = {
      schemaVersion: GALLERY_SCHEMA_VERSION,
      phase: snapshot.head.phase,
      contentRevision: snapshot.head.contentRevision,
      flagRevision: snapshot.head.flagRevision,
      orderRevision: snapshot.head.orderRevision,
      query: normalized,
      items: selected.map(publicRow),
      total: matches.length,
      offset,
      limit: requestedLimit,
      hasMore: nextOffset < matches.length,
      nextCursor: nextOffset < matches.length
        ? encodeCursor({
            schemaVersion: GALLERY_SCHEMA_VERSION,
            contentRevision: snapshot.head.contentRevision,
            orderRevision: snapshot.head.orderRevision,
            flagRevision: snapshot.head.flagRevision,
            queryKey,
            offset: nextOffset,
            lastItemId: selected.at(-1)?.id ?? null,
          })
        : null,
    };
    if (jsonBytes(response) <= GALLERY_QUERY_CHUNK_MAX_BYTES) return response;
    selected = selected.slice(0, -1);
  }
  if (offset >= matches.length) {
    return {
      schemaVersion: GALLERY_SCHEMA_VERSION,
      phase: snapshot.head.phase,
      contentRevision: snapshot.head.contentRevision,
      flagRevision: snapshot.head.flagRevision,
      orderRevision: snapshot.head.orderRevision,
      query: normalized,
      items: [],
      total: matches.length,
      offset,
      limit: requestedLimit,
      hasMore: false,
      nextCursor: null,
    };
  }
  throw new GalleryHttpError(413, 'A gallery index item exceeds the bounded response limit.');
}

export async function readGalleryItem(snapshot, runId, itemId, signal) {
  assertGalleryItemId(itemId);
  assertActive(signal);
  let detail;
  if (snapshot.kind === 'sealed') {
    const href = galleryItemHref(snapshot.descriptor, itemId);
    const file = contained(snapshot.outputRoot, href);
    if (!file) throw new GalleryHttpError(404, 'Gallery item not found.');
    const record = integrityRecordFor(snapshot.integrity, file);
    const source = await readIntegrityCheckedFile(file, record, GALLERY_ITEM_DETAIL_MAX_BYTES, signal);
    detail = decodeArchiveWrapper(source.toString('utf8'));
    detail = withResolvedMedia(detail, runId, snapshot.outputRoot, snapshot.runDirectory);
  } else {
    const item = snapshot.catalog.items.find(({ id }) => id === itemId);
    if (!item) throw new GalleryHttpError(404, 'Gallery item not found.');
    detail = await liveItemDetail(item, snapshot, runId, signal);
  }
  detail = await verifyDetailMediaAvailability(detail, snapshot.runDirectory, runId, signal);
  const flags = (snapshot.flagSnapshot?.flags ?? []).filter(({ itemId: target }) => target === itemId);
  detail = {
    ...detail,
    review: {
      flagRevision: snapshot.head.flagRevision,
      flags,
      historyHref: `/api/runs/${encodeURIComponent(runId)}/gallery/flags?itemId=${encodeURIComponent(itemId)}`,
    },
  };
  assertGalleryItemDetail(detail);
  if (jsonBytes(detail) > GALLERY_ITEM_DETAIL_MAX_BYTES) {
    throw new GalleryHttpError(413, 'Gallery item detail exceeds the bounded response limit.');
  }
  return detail;
}

export async function readGalleryAvailability(snapshot, runId, itemId, signal) {
  const detail = await readGalleryItem(snapshot, runId, itemId, signal);
  assertActive(signal);
  const media = [];
  for (const member of detail.media ?? []) {
    assertActive(signal);
    const file = artifactFileFromUrl(snapshot.runDirectory, runId, member.href);
    const available = Boolean(member.available && file && await isFile(file));
    media.push({
      memberId: member.memberId,
      available,
      href: available ? member.href : null,
    });
  }
  const available = media.some((member) => member.available);
  return {
    schemaVersion: GALLERY_SCHEMA_VERSION,
    contentRevision: snapshot.head.contentRevision,
    itemId,
    state: available ? 'available' : 'tombstone',
    retryable: true,
    message: available ? null : 'This evidence is no longer available. Its test context remains in the review sequence.',
    media,
  };
}

function assertGalleryItemId(itemId) {
  if (!/^gitem_[a-f0-9]{16}$/.test(itemId)) throw new GalleryHttpError(404, 'Gallery item not found.');
}

async function loadSealedSnapshot(run, headFile, signal, includeRows) {
  const outputRoot = join(run.directory, 'checklist');
  const descriptor = assertGalleryArchiveDescriptor(await readJsonBounded(
    headFile,
    GALLERY_DESCRIPTOR_MAX_BYTES,
    signal,
  ));
  const integrity = await loadSealedIntegrity(outputRoot, descriptor, signal);
  const rows = [];
  const queryBytes = descriptor.query.chunks.reduce((total, chunk) => total + chunk.bytes, 0);
  if (descriptor.query.chunks.length > MAX_SEALED_QUERY_CHUNKS || queryBytes > MAX_SEALED_QUERY_BYTES) {
    throw new GalleryHttpError(413, 'The sealed gallery query index exceeds the bounded aggregate read limit.');
  }
  let actualQueryBytes = 0;
  for (const [index, chunk] of (includeRows ? descriptor.query.chunks : []).entries()) {
    assertActive(signal);
    const file = contained(outputRoot, chunk.href);
    if (!file) throw new GalleryHttpError(500, 'The sealed gallery query index escapes its run directory.');
    const record = integrityRecordFor(integrity, file);
    const source = await readIntegrityCheckedFile(
      file,
      record,
      Math.min(GALLERY_QUERY_CHUNK_MAX_BYTES, descriptor.query.maxBytesPerChunk),
      signal,
    );
    actualQueryBytes += source.length;
    if (actualQueryBytes > MAX_SEALED_QUERY_BYTES || source.length !== chunk.bytes) {
      throw new GalleryHttpError(500, 'The sealed gallery query index has invalid actual byte totals.');
    }
    const payload = decodeArchiveWrapper(source.toString('utf8'));
    if (payload.contentRevision !== descriptor.contentRevision || !Array.isArray(payload.rows)
      || payload.rows.length !== chunk.rows || payload.rows.length > descriptor.query.maxRowsPerChunk
      || payload.ordinal !== index + 1
      || payload.archiveDocument?.kind !== 'query'
      || payload.archiveDocument?.contentRevision !== descriptor.contentRevision
      || payload.archiveDocument?.exportRevision !== descriptor.exportRevision) {
      throw new GalleryHttpError(500, 'The sealed gallery query index does not match its publication head.');
    }
    rows.push(...payload.rows.map(assertGalleryQueryRow));
  }
  if (includeRows && rows.length !== descriptor.query.rows) {
    throw new GalleryHttpError(500, 'The sealed gallery query index actual row total does not match its publication head.');
  }
  if (new Set(rows.map(({ id }) => id)).size !== rows.length) {
    throw new GalleryHttpError(500, 'The sealed gallery query index contains duplicate item identities.');
  }
  if (includeRows) {
    await verifySealedRawChunks(outputRoot, descriptor, integrity, signal);
    await verifySealedFlagDocument(outputRoot, descriptor, integrity, signal);
  }
  return {
    kind: 'sealed',
    runDirectory: run.directory,
    outputRoot,
    descriptor,
    integrity,
    rows,
    head: {
      schemaVersion: GALLERY_SCHEMA_VERSION,
      phase: 'sealed',
      contentRevision: descriptor.contentRevision,
      flagRevision: descriptor.flagRevision,
      orderRevision: descriptor.orderRevision,
      exportRevision: descriptor.exportRevision,
      exportedAt: descriptor.exportedAt,
      primaryCounts: descriptor.primaryCounts,
      facets: descriptor.facets,
      total: descriptor.query.rows,
    },
  };
}

async function liveRoots(runDirectory, signal) {
  const rootPublication = join(runDirectory, 'gallery-live');
  const roots = [];
  const shardRoot = join(runDirectory, 'shards');
  let entries = [];
  try {
    entries = await fs.readdir(shardRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  assertActive(signal);
  const shardDirectories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  if (shardDirectories.length > MAX_LIVE_SOURCES) {
    throw new GalleryHttpError(413, 'This run exposes more live gallery sources than the bounded shard limit.');
  }
  for (const entry of shardDirectories) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) roots.push(join(shardRoot, entry.name, 'gallery-live'));
  }
  return (roots.length > 0 ? roots : [rootPublication]).sort();
}

async function loadLiveSnapshot(run, signal) {
  const sources = [];
  let aggregateBytes = 0;
  for (const root of await liveRoots(run.directory, signal)) {
    const headFile = join(root, 'current.json');
    if (!await isFile(headFile)) continue;
    const head = await readJsonBounded(headFile, GALLERY_DESCRIPTOR_MAX_BYTES, signal);
    if (
      head?.schemaVersion !== GALLERY_SCHEMA_VERSION
      || head.phase !== 'live'
      || typeof head.contentRevision !== 'string'
      || !safeRelative(head.revisionHref)
    ) throw new GalleryHttpError(500, 'A live gallery publication head is invalid.');
    const revisionFile = contained(root, head.revisionHref);
    if (!revisionFile) throw new GalleryHttpError(500, 'A live gallery revision escapes its shard directory.');
    aggregateBytes += await fileSize(revisionFile);
    if (aggregateBytes > MAX_LIVE_AGGREGATE_BYTES) {
      throw new GalleryHttpError(413, 'Live gallery revisions exceed the bounded aggregate read limit.');
    }
    const revision = await readJsonBounded(revisionFile, MAX_LIVE_REVISION_BYTES, signal);
    if (revision?.contentRevision !== head.contentRevision || revision?.phase !== 'live') {
      throw new GalleryHttpError(500, 'A live gallery revision does not match its publication head.');
    }
    sources.push({ root, head, catalog: assertGalleryCatalog(revision.catalog) });
  }
  if (sources.length === 0) return null;

  const items = new Map();
  const blobs = new Map();
  const blobOrigins = new Map();
  for (const source of sources) {
    const sourceBase = resolve(source.root, '..');
    for (const item of source.catalog.items) items.set(item.id, item);
    for (const blob of source.catalog.blobs) {
      const existing = blobs.get(blob.id);
      blobs.set(blob.id, existing ? {
        ...blob,
        storageLocations: [...new Set([...existing.storageLocations, ...blob.storageLocations])].sort(),
      } : blob);
      const candidates = blobOrigins.get(blob.id) ?? [];
      const file = contained(sourceBase, blob.href);
      if (file) candidates.push({ sourceBase, file, href: relative(run.directory, file).split(sep).join('/') });
      blobOrigins.set(blob.id, candidates);
    }
  }
  const orderedItems = [...items.values()].sort((left, right) => left.id.localeCompare(right.id));
  const catalog = assertGalleryCatalog({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    items: orderedItems,
    blobs: [...blobs.values()].sort((left, right) => left.id.localeCompare(right.id)),
    primaryCounts: {
      total: orderedItems.length,
      images: orderedItems.filter(({ kind }) => kind === 'image').length,
      videos: orderedItems.filter(({ kind }) => kind === 'video').length,
    },
  });
  const rows = catalog.items.map((item) => queryRowFromItem(item));
  const sourceRevisions = sources.map(({ head }) => ({
    contentRevision: head.contentRevision,
    sourceShard: head.sourceShard ?? null,
  })).sort(compareLiveSourceRevision);
  const contentRevision = `content_${stableGalleryKey(sourceRevisions)}`;
  const flagRevision = sources.map(({ head }) => head.flagRevision).sort().at(-1) ?? EMPTY_FLAG_REVISION;
  const orderRevision = `order_${stableGalleryKey({ contentRevision, flagRevision, schemaVersion: 1 })}`;
  return {
    kind: 'live',
    runDirectory: run.directory,
    catalog,
    blobOrigins,
    rows,
    head: {
      schemaVersion: GALLERY_SCHEMA_VERSION,
      phase: 'live',
      contentRevision,
      flagRevision,
      orderRevision,
      exportRevision: null,
      exportedAt: null,
      primaryCounts: catalog.primaryCounts,
      facets: facets(rows),
      total: rows.length,
      sourceRevisions,
    },
  };
}

async function withReviewerFlags(snapshot, run, signal) {
  assertActive(signal);
  const flagSnapshot = galleryFlagSnapshot(await readGalleryFlagHistory(run.directory));
  assertActive(signal);
  const byItem = new Map();
  const priority = { open: 0, resolved: 1, dismissed: 2, unflagged: 3 };
  for (const flag of flagSnapshot.flags) {
    const current = byItem.get(flag.itemId) ?? 'unflagged';
    if (priority[flag.state] < priority[current]) byItem.set(flag.itemId, flag.state);
  }
  const rows = snapshot.rows.map((row) => ({
    ...row,
    flagState: byItem.get(row.id) ?? 'unflagged',
  }));
  const flagRevision = flagSnapshot.flagRevision;
  return {
    ...snapshot,
    rows,
    flagSnapshot,
    head: {
      ...snapshot.head,
      flagRevision,
      orderRevision: `order_${stableGalleryKey({
        contentRevision: snapshot.head.contentRevision,
        flagRevision,
        schemaVersion: 1,
      })}`,
      facets: facets(rows),
    },
  };
}

function queryRowFromItem(item) {
  const featureSuites = unique(item.auditAssociations.map(({ featureSuite }) => featureSuite));
  const primaryAudit = primaryGalleryAuditAssociation(item.auditAssociations);
  const title = boundedGalleryText(item.test.title) ?? 'Untitled test';
  const projectName = boundedGalleryText(item.project.name, 300) ?? 'unknown-project';
  const targets = unique([
    item.project.name,
    item.project.browser,
    item.project.deviceClass,
    `${item.project.browser} · ${item.project.deviceClass}`,
  ]);
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
    flagState: 'unflagged',
    searchText: unique([
      item.test.id,
      item.test.title,
      ...item.test.titlePath,
      item.test.file,
      item.test.technicalSuite,
      item.project.name,
      item.project.browser,
      item.project.deviceClass,
      item.project.environment,
      item.capture.route,
      item.capture.observedState,
      item.capture.rationale,
      ...item.auditAssociations.flatMap(({ id, title, expected, featureSuite }) => [id, title, expected, featureSuite]),
    ]).join(' ').toLowerCase().slice(0, 20_000),
    attempt: { ordinal: item.attempt.ordinal, retry: item.attempt.retry },
    captureTime: item.capture.capturedAt,
    available: item.members.some(({ available, blobId }) => available && blobId !== null),
    visualWarning: Boolean(item.comparison?.complete && item.members.some(({ role }) => role === 'diff')),
    auditAssociations: item.auditAssociations.map(({ id, title, catalogOrdinal }) => ({ id, title, catalogOrdinal })),
  });
}

async function liveItemDetail(item, snapshot, runId, signal) {
  const blobs = new Map(snapshot.catalog.blobs.map((blob) => [blob.id, blob]));
  const media = [];
  for (const member of item.members) {
    assertActive(signal);
    const blob = member.blobId ? blobs.get(member.blobId) : null;
    const candidates = member.blobId ? snapshot.blobOrigins.get(member.blobId) ?? [] : [];
    let origin = candidates[0] ?? null;
    for (const candidate of candidates) {
      if (await isFile(candidate.file)) {
        origin = candidate;
        break;
      }
    }
    media.push({
      memberId: member.id,
      blobId: member.blobId,
      href: origin ? artifactUrl(runId, origin.href) : null,
      contentType: member.contentType,
      sizeBytes: blob?.sizeBytes ?? null,
      sha256: blob?.sha256 ?? null,
      available: member.available && Boolean(origin),
      poster: null,
    });
  }
  const available = media.some((entry) => entry.available);
  return assertGalleryItemDetail({
    schemaVersion: GALLERY_SCHEMA_VERSION,
    item: { ...item, test: { ...item.test, file: item.test.file.split(/[\\/]/).at(-1) ?? item.test.file } },
    media,
    availability: {
      state: available ? 'available' : 'tombstone',
      retryable: true,
      message: available ? null : 'This evidence is no longer available. Its test context remains in the review sequence.',
    },
  });
}

async function verifyDetailMediaAvailability(detail, runDirectory, runId, signal) {
  if (!detail || typeof detail !== 'object' || !Array.isArray(detail.media)) return detail;
  const media = [];
  for (const member of detail.media) {
    assertActive(signal);
    const file = artifactFileFromUrl(runDirectory, runId, member.href);
    const available = Boolean(member.available && file && await isFile(file));
    media.push({ ...member, href: available ? member.href : null, available });
  }
  const available = media.some((member) => member.available);
  return {
    ...detail,
    media,
    availability: {
      state: available ? 'available' : 'tombstone',
      retryable: true,
      message: available ? null : 'This evidence is no longer available. Its test context remains in the review sequence.',
    },
  };
}

function withResolvedMedia(detail, runId, outputRoot, runDirectory) {
  if (!detail || typeof detail !== 'object' || !Array.isArray(detail.media)) return detail;
  return {
    ...detail,
    media: detail.media.map((member) => {
      const file = typeof member.href === 'string' ? contained(outputRoot, member.href) : null;
      const posterFile = typeof member.poster?.href === 'string' ? contained(outputRoot, member.poster.href) : null;
      return {
        ...member,
        href: file ? artifactUrl(runId, relative(runDirectory, file).split(sep).join('/')) : null,
        available: Boolean(member.available && file),
        poster: member.poster ? {
          ...member.poster,
          href: posterFile ? artifactUrl(runId, relative(runDirectory, posterFile).split(sep).join('/')) : null,
        } : null,
      };
    }),
  };
}

function publicRow({ searchText: _searchText, ...row }) {
  return row;
}

function facets(rows) {
  return {
    kinds: unique(rows.map(({ kind }) => kind)),
    statuses: unique(rows.map(({ status }) => status)),
    environments: unique(rows.map(({ environment }) => environment)),
    featureSuites: unique(rows.flatMap(({ featureSuites }) => featureSuites)),
    technicalSuites: unique(rows.map(({ technicalSuite }) => technicalSuite)),
    targets: unique(rows.flatMap(({ targets }) => targets)),
    flagStates: unique(rows.map(({ flagState }) => flagState)),
  };
}

function emptyFacets() {
  return {
    kinds: [], statuses: [], environments: [], featureSuites: [], technicalSuites: [], targets: [], flagStates: [],
  };
}

function mergeFacets(values) {
  const merged = emptyFacets();
  for (const value of values) {
    for (const key of Object.keys(merged)) merged[key].push(...(Array.isArray(value?.[key]) ? value[key] : []));
  }
  for (const key of Object.keys(merged)) merged[key] = unique(merged[key]);
  return merged;
}

async function queryRowsCancellable(rows, query, signal) {
  const chunks = [];
  for (let offset = 0; offset < rows.length; offset += 256) {
    assertActive(signal);
    const chunk = rows.slice(offset, offset + 256)
      .filter((row) => galleryQueryRowMatches(row, query))
      .sort((left, right) => compareGalleryQueryRows(left, right, query));
    if (chunk.length > 0) chunks.push(chunk);
    await new Promise((resolveYield) => setImmediate(resolveYield));
  }
  while (chunks.length > 1) {
    const merged = [];
    for (let index = 0; index < chunks.length; index += 2) {
      assertActive(signal);
      const left = chunks[index];
      const right = chunks[index + 1];
      merged.push(right ? mergeSortedRows(left, right, query, signal) : left);
    }
    chunks.splice(0, chunks.length, ...merged);
    await new Promise((resolveYield) => setImmediate(resolveYield));
  }
  return chunks[0] ?? [];
}

function mergeSortedRows(left, right, query, signal) {
  const merged = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if ((merged.length & 255) === 0) assertActive(signal);
    if (compareGalleryQueryRows(left[leftIndex], right[rightIndex], query) <= 0) merged.push(left[leftIndex++]);
    else merged.push(right[rightIndex++]);
  }
  return merged.concat(left.slice(leftIndex), right.slice(rightIndex));
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))].sort();
}

function compareLiveSourceRevision(left, right) {
  const leftOrdinal = Number.isSafeInteger(left.sourceShard?.ordinal) ? left.sourceShard.ordinal : 0;
  const rightOrdinal = Number.isSafeInteger(right.sourceShard?.ordinal) ? right.sourceShard.ordinal : 0;
  if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
  const leftTotal = Number.isSafeInteger(left.sourceShard?.total) ? left.sourceShard.total : 0;
  const rightTotal = Number.isSafeInteger(right.sourceShard?.total) ? right.sourceShard.total : 0;
  if (leftTotal !== rightTotal) return leftTotal - rightTotal;
  return left.contentRevision.localeCompare(right.contentRevision);
}

function artifactUrl(runId, path) {
  return `/artifacts/${encodeURIComponent(runId)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function artifactFileFromUrl(runDirectory, runId, href) {
  if (typeof href !== 'string') return null;
  const prefix = `/artifacts/${encodeURIComponent(runId)}/`;
  if (!href.startsWith(prefix)) return null;
  let decoded;
  try {
    decoded = href.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  return contained(runDirectory, decoded);
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new GalleryHttpError(400, 'Gallery cursor is invalid.');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      parsed?.schemaVersion !== GALLERY_SCHEMA_VERSION
      || typeof parsed.contentRevision !== 'string'
      || typeof parsed.orderRevision !== 'string'
      || typeof parsed.flagRevision !== 'string'
      || typeof parsed.queryKey !== 'string'
      || !Number.isSafeInteger(parsed.offset)
      || parsed.offset < 0
      || (parsed.lastItemId !== null && typeof parsed.lastItemId !== 'string')
    ) throw new Error('invalid');
    return parsed;
  } catch {
    throw new GalleryHttpError(400, 'Gallery cursor is invalid.');
  }
}

function decodeArchiveWrapper(source) {
  const encoded = source.match(/data-gallery-payload="([A-Za-z0-9+/=]+)"/)?.[1];
  if (!encoded) throw new GalleryHttpError(500, 'Gallery archive document is malformed.');
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new GalleryHttpError(500, 'Gallery archive payload is malformed.');
  }
}

async function readArchiveWrapper(file, maximumBytes, signal) {
  return decodeArchiveWrapper(await readTextBounded(file, maximumBytes, signal));
}

async function loadSealedIntegrity(outputRoot, descriptor, signal) {
  const integrityFile = contained(outputRoot, descriptor.integrity.href);
  if (!integrityFile) throw new GalleryHttpError(500, 'The sealed gallery integrity document escapes its run directory.');
  const document = await readJsonBounded(integrityFile, MAX_SEALED_INTEGRITY_BYTES, signal);
  if (document?.schemaVersion !== GALLERY_SCHEMA_VERSION
    || document.exportRevision !== descriptor.exportRevision
    || !Array.isArray(document.files)
    || document.files.length !== descriptor.integrity.documentCount
    || document.files.length > MAX_SEALED_INTEGRITY_RECORDS) {
    throw new GalleryHttpError(500, 'The sealed gallery integrity document does not match its publication head.');
  }
  const root = resolve(integrityFile, '..');
  const records = new Map();
  for (const record of document.files) {
    if (!record || typeof record !== 'object' || !safeRelative(record.path)
      || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 1
      || record.sizeBytes > MAX_SEALED_INTEGRITY_BYTES
      || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)
      || records.has(record.path)) {
      throw new GalleryHttpError(500, 'The sealed gallery integrity document contains an invalid file record.');
    }
    records.set(record.path, record);
  }
  const expectedDocumentCount = 2
    + descriptor.query.chunks.length
    + descriptor.raw.chunks.length
    + descriptor.itemDetails.count;
  if (records.size !== expectedDocumentCount) {
    throw new GalleryHttpError(500, 'The sealed gallery integrity index has an impossible document count.');
  }
  const referencedPaths = new Set(['descriptor.json']);
  for (const href of [
    ...descriptor.query.chunks.map(({ href }) => href),
    ...descriptor.raw.chunks.map(({ href }) => href),
    descriptor.flags.href,
  ]) {
    const file = contained(outputRoot, href);
    if (!file) throw new GalleryHttpError(500, 'A sealed gallery descriptor reference escapes its run directory.');
    referencedPaths.add(integrityRelativePath(root, file));
  }
  const itemDirectory = contained(outputRoot, descriptor.itemDetails.hrefPrefix);
  if (!itemDirectory) throw new GalleryHttpError(500, 'The sealed gallery item index escapes its run directory.');
  const itemPrefix = `${integrityRelativePath(root, itemDirectory).replace(/\/+$/, '')}/`;
  const itemRecords = [...records.keys()].filter((path) => (
    path.startsWith(itemPrefix)
    && path.endsWith(descriptor.itemDetails.hrefSuffix)
    && path.length > itemPrefix.length + descriptor.itemDetails.hrefSuffix.length
  ));
  const itemRecordPaths = new Set(itemRecords);
  if (itemRecords.length !== descriptor.itemDetails.count
    || [...records.keys()].some((path) => !referencedPaths.has(path) && !itemRecordPaths.has(path))) {
    throw new GalleryHttpError(500, 'The sealed gallery integrity index does not match the descriptor document set.');
  }
  for (const path of itemRecords) {
    if (records.get(path).sizeBytes > descriptor.itemDetails.maxBytes) {
      throw new GalleryHttpError(500, 'A sealed gallery item detail exceeds its indexed byte limit.');
    }
  }
  const descriptorFile = resolve(root, 'descriptor.json');
  const descriptorRecord = integrityRecordFor({ root, records }, descriptorFile);
  const descriptorSource = await readIntegrityCheckedFile(descriptorFile, descriptorRecord, GALLERY_DESCRIPTOR_MAX_BYTES, signal);
  let installedDescriptor;
  try {
    installedDescriptor = JSON.parse(descriptorSource.toString('utf8'));
  } catch {
    throw new GalleryHttpError(500, 'The sealed gallery immutable descriptor is malformed.');
  }
  if (JSON.stringify(installedDescriptor) !== JSON.stringify(descriptor)) {
    throw new GalleryHttpError(500, 'The sealed gallery head does not match its integrity-checked immutable descriptor.');
  }
  return { root, records };
}

async function verifySealedRawChunks(outputRoot, descriptor, integrity, signal) {
  if (descriptor.raw.chunks.length > MAX_SEALED_QUERY_CHUNKS) {
    throw new GalleryHttpError(413, 'The sealed gallery raw index exceeds the bounded chunk limit.');
  }
  let actualBytes = 0;
  let actualRows = 0;
  for (const [index, chunk] of descriptor.raw.chunks.entries()) {
    assertActive(signal);
    const file = contained(outputRoot, chunk.href);
    if (!file) throw new GalleryHttpError(500, 'The sealed gallery raw index escapes its run directory.');
    const source = await readIntegrityCheckedFile(
      file,
      integrityRecordFor(integrity, file),
      Math.min(GALLERY_QUERY_CHUNK_MAX_BYTES, descriptor.raw.maxBytesPerChunk),
      signal,
    );
    actualBytes += source.length;
    if (actualBytes > MAX_SEALED_QUERY_BYTES || source.length !== chunk.bytes) {
      throw new GalleryHttpError(500, 'The sealed gallery raw index has invalid actual byte totals.');
    }
    const payload = decodeArchiveWrapper(source.toString('utf8'));
    if (!Array.isArray(payload.rows) || payload.rows.length !== chunk.rows
      || payload.rows.length > descriptor.raw.maxRowsPerChunk
      || payload.ordinal !== index + 1
      || payload.advancedRawOnly !== true
      || payload.contentRevision !== descriptor.contentRevision
      || payload.archiveDocument?.kind !== 'raw'
      || payload.archiveDocument?.contentRevision !== descriptor.contentRevision
      || payload.archiveDocument?.exportRevision !== descriptor.exportRevision) {
      throw new GalleryHttpError(500, 'The sealed gallery raw index does not match its publication head.');
    }
    actualRows += payload.rows.length;
  }
  if (actualRows !== descriptor.raw.rows) {
    throw new GalleryHttpError(500, 'The sealed gallery raw index actual row total does not match its publication head.');
  }
}

async function verifySealedFlagDocument(outputRoot, descriptor, integrity, signal) {
  const file = contained(outputRoot, descriptor.flags.href);
  if (!file) throw new GalleryHttpError(500, 'The sealed gallery flag document escapes its run directory.');
  const source = await readIntegrityCheckedFile(
    file,
    integrityRecordFor(integrity, file),
    GALLERY_FLAG_HISTORY_MAX_BYTES,
    signal,
  );
  const payload = decodeArchiveWrapper(source.toString('utf8'));
  if (payload.throughEvent !== descriptor.flags.throughEvent
    || payload.flagRevision !== descriptor.flagRevision
    || payload.archiveDocument?.kind !== 'flags'
    || payload.archiveDocument?.contentRevision !== descriptor.contentRevision
    || payload.archiveDocument?.exportRevision !== descriptor.exportRevision
    || payload.archiveDocument?.flagRevision !== descriptor.flagRevision) {
    throw new GalleryHttpError(500, 'The sealed gallery flag document does not match its publication head.');
  }
}

function integrityRelativePath(root, file) {
  const relativePath = relative(root, file).split(sep).join('/');
  if (!safeRelative(relativePath)) throw new GalleryHttpError(500, 'A sealed gallery document escapes its immutable revision.');
  return relativePath;
}

function integrityRecordFor(integrity, file) {
  const relativePath = integrityRelativePath(integrity.root, file);
  const record = integrity.records.get(relativePath);
  if (!record) throw new GalleryHttpError(500, 'A sealed gallery document is missing from its integrity index.');
  return record;
}

async function readIntegrityCheckedFile(file, record, maximumBytes, signal) {
  assertActive(signal);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new GalleryHttpError(500, 'An integrity-indexed gallery document is missing.');
    throw error;
  }
  if (!stat.isFile() || stat.size !== record.sizeBytes || stat.size > maximumBytes) {
    throw new GalleryHttpError(500, 'A sealed gallery document violates its actual byte or integrity limits.');
  }
  const buffer = await fs.readFile(file, { signal });
  assertActive(signal);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (buffer.length !== record.sizeBytes || sha256 !== record.sha256) {
    throw new GalleryHttpError(500, 'A sealed gallery document failed content hash verification.');
  }
  return buffer;
}

async function readJsonBounded(file, maximumBytes, signal) {
  const source = await readTextBounded(file, maximumBytes, signal);
  try {
    return JSON.parse(source);
  } catch {
    throw new GalleryHttpError(500, 'Gallery data is malformed.');
  }
}

async function readTextBounded(file, maximumBytes, signal) {
  assertActive(signal);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new GalleryHttpError(404, 'Gallery data not found.');
    throw error;
  }
  if (!stat.isFile()) throw new GalleryHttpError(404, 'Gallery data not found.');
  if (stat.size > maximumBytes) throw new GalleryHttpError(413, 'Gallery data exceeds its bounded read limit.');
  const buffer = await fs.readFile(file, { signal });
  assertActive(signal);
  return buffer.toString('utf8');
}

function safeRelative(value) {
  return typeof value === 'string'
    && value !== ''
    && !isAbsolute(value)
    && value !== '..'
    && !value.startsWith('../')
    && !value.includes('/../')
    && !value.includes('\\');
}

function contained(root, requested) {
  if (!safeRelative(requested)) return null;
  const base = resolve(root);
  const target = resolve(base, requested);
  return target === base || target.startsWith(`${base}${sep}`) ? target : null;
}

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function fileSize(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function assertActive(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The request was aborted.', 'AbortError');
}
