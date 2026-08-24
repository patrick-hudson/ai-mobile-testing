import {
  GALLERY_LIMITS,
  createGalleryWorkbench,
  decodeGalleryItemDetail,
  decodeGalleryQueryRow,
} from './gallery-core.js';

export const GALLERY_ARCHIVE_CHANNEL = 'quitting7oh-gallery-archive-v1';
const ITEM_ID = /^gitem_[a-f0-9]{16}$/;
const REVISION = /^(?:content|order|flags|export)_[a-f0-9]{16}$/;
const MEDIA_TYPES = Object.freeze({
  image: new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  video: new Set(['video/webm', 'video/mp4']),
});
const FILTER_NAMES = Object.freeze({
  kinds: 'kind', statuses: 'status', environments: 'environment', featureSuites: 'featureSuite',
  technicalSuites: 'technicalSuite', targets: 'target', flagStates: 'flagState',
});

function abortError() {
  return new DOMException('The archive request was cancelled.', 'AbortError');
}

function requireDescriptor(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || value.phase !== 'sealed') {
    throw new TypeError('The embedded gallery descriptor is invalid.');
  }
  for (const key of ['contentRevision', 'flagRevision', 'orderRevision', 'exportRevision']) {
    if (!REVISION.test(value[key] ?? '')) throw new TypeError(`The archive ${key} is invalid.`);
  }
  if (!Number.isInteger(value.query?.rows) || value.query.rows < 0 || !Array.isArray(value.query.chunks)) {
    throw new TypeError('The archive query index is invalid.');
  }
  if (!Number.isInteger(value.raw?.rows) || value.raw.rows < 0 || !Array.isArray(value.raw.chunks)) {
    throw new TypeError('The archive raw index is invalid.');
  }
  if (!value.itemDetails || value.itemDetails.maxBytes !== 512 * 1024 || typeof value.flags?.href !== 'string') {
    throw new TypeError('The archive detail contract is invalid.');
  }
  if (typeof value.exportedAt !== 'string' || Number.isNaN(Date.parse(value.exportedAt))) {
    throw new TypeError('The archive export time is invalid.');
  }
  return value;
}

function safeRelativePath(value, prefix) {
  if (
    typeof value !== 'string' || !value.startsWith(prefix) || value.startsWith('//')
    || value.includes('\\') || value.includes('?') || value.includes('#')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /[\u0000-\u001f\u007f]/.test(value)
  ) return false;
  return value.split('/').every((part) => {
    if (!part) return false;
    try {
      const decoded = decodeURIComponent(part);
      return decoded !== '.' && decoded !== '..' && !decoded.includes('/') && !decoded.includes('\\')
        && !/[\u0000-\u001f\u007f]/.test(decoded);
    } catch {
      return false;
    }
  });
}

export function validateArchiveMediaUrl(value, kind, declaredType = null) {
  const normalized = typeof value === 'string' && value.startsWith('./') ? value.slice(2) : value;
  if (!safeRelativePath(normalized, 'evidence/')) throw new TypeError('The archive media path is outside evidence/.');
  if (!MEDIA_TYPES[kind]?.has(declaredType) && declaredType !== null) throw new TypeError('The archive media type is not allowed.');
  const extension = normalized.split('.').at(-1)?.toLowerCase();
  const allowedExtension = kind === 'video' ? ['webm', 'mp4'].includes(extension) : ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension);
  if (!allowedExtension) throw new TypeError('The archive media extension is not allowed.');
  return normalized;
}

function validateWrapperHref(value, descriptor) {
  const prefix = `gallery/revisions/${descriptor.exportRevision}/`;
  if (!safeRelativePath(value, prefix) || !value.endsWith('.html')) throw new TypeError('The archive wrapper path is invalid.');
  return value;
}

function tokenFromCrypto(cryptoObject) {
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function validateArchiveEnvelope(message, expected, descriptor) {
  if (!message || typeof message !== 'object' || message.channel !== GALLERY_ARCHIVE_CHANNEL) return null;
  const meta = message.meta;
  if (
    !meta || typeof meta !== 'object' || meta.schemaVersion !== 1 || meta.kind !== expected.kind
    || meta.contentRevision !== descriptor.contentRevision || meta.exportRevision !== descriptor.exportRevision
    || (expected.kind === 'flags' && meta.flagRevision !== descriptor.flagRevision)
  ) return null;
  const payload = message.payload;
  if (!payload || typeof payload !== 'object') return null;
  const embedded = payload.archiveDocument;
  if (!embedded || embedded.schemaVersion !== meta.schemaVersion || embedded.kind !== meta.kind
    || embedded.contentRevision !== meta.contentRevision || embedded.exportRevision !== meta.exportRevision
    || (expected.kind === 'flags' && embedded.flagRevision !== meta.flagRevision)) return null;
  if (expected.kind === 'query' || expected.kind === 'raw') {
    if (payload.schemaVersion !== 1 || payload.contentRevision !== descriptor.contentRevision
      || payload.ordinal !== expected.ordinal || !Array.isArray(payload.rows)) return null;
  } else if (expected.kind === 'detail') {
    if (payload.item?.id !== expected.itemId) return null;
    decodeGalleryItemDetail(payload);
  } else if (
    payload.schemaVersion !== 1 || payload.flagRevision !== descriptor.flagRevision
    || !Number.isInteger(payload.throughEvent) || !Array.isArray(payload.flags) || !Array.isArray(payload.events ?? [])
  ) return null;
  return payload;
}

export function createArchiveIframeTransport({
  descriptor: descriptorValue,
  windowObject = window,
  documentObject = document,
  timeoutMs = 15_000,
  tokenFactory = () => tokenFromCrypto(windowObject.crypto),
  schedule = (task) => queueMicrotask(task),
  onRequest = () => {},
} = {}) {
  const descriptor = requireDescriptor(descriptorValue);
  const active = new Set();

  function load(hrefValue, expected, signal) {
    const href = validateWrapperHref(hrefValue, descriptor);
    if (signal?.aborted) return Promise.reject(abortError());
    const token = tokenFactory();
    return new Promise((resolve, reject) => {
      const iframe = documentObject.createElement('iframe');
      iframe.hidden = true;
      iframe.tabIndex = -1;
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('sandbox', 'allow-scripts');
      let queuedPayload = null;
      let settled = false;
      const request = { iframe, token, cancel: () => finish(reject, abortError()) };
      active.add(request);
      const timer = windowObject.setTimeout(() => finish(reject, new Error('The archive wrapper timed out.')), timeoutMs);
      const cleanup = () => {
        if (settled) return;
        settled = true;
        queuedPayload = null;
        windowObject.clearTimeout(timer);
        windowObject.removeEventListener('message', onMessage);
        signal?.removeEventListener('abort', onAbort);
        iframe.removeEventListener?.('error', onFrameError);
        iframe.remove();
        active.delete(request);
      };
      const finish = (callback, value) => { cleanup(); callback(value); };
      const onAbort = () => finish(reject, abortError());
      const onFrameError = () => finish(reject, new TypeError('The archive wrapper could not be loaded.'));
      const onMessage = (event) => {
        if (event.source !== iframe.contentWindow || event.data?.token !== token) return;
        let payload;
        try { payload = validateArchiveEnvelope(event.data, expected, descriptor); } catch (error) {
          finish(reject, new TypeError(`The archive wrapper is invalid. ${error instanceof Error ? error.message : ''}`.trim()));
          return;
        }
        if (!payload) {
          finish(reject, new TypeError('The archive wrapper schema or pinned revision is invalid.'));
          return;
        }
        queuedPayload = payload;
        schedule(() => {
          if (settled || signal?.aborted || queuedPayload !== payload) return;
          finish(resolve, payload);
        });
      };
      windowObject.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      iframe.addEventListener?.('error', onFrameError, { once: true });
      iframe.src = `${href}#${encodeURIComponent(token)}`;
      documentObject.body.append(iframe);
      onRequest({ href, kind: expected.kind, ordinal: expected.ordinal ?? null, itemId: expected.itemId ?? null });
    });
  }

  return Object.freeze({
    load,
    get activeCount() { return active.size; },
    destroy() { for (const request of [...active]) request.cancel(); },
  });
}

function normalizedArchiveQuery(value = {}) {
  const list = (name) => [...new Set((Array.isArray(value[name]) ? value[name] : [])
    .filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()))].sort();
  return {
    kinds: list('kinds').filter((kind) => ['image', 'video'].includes(kind)), statuses: list('statuses'),
    environments: list('environments'), featureSuites: list('featureSuites'), technicalSuites: list('technicalSuites'),
    targets: list('targets'), flagStates: list('flagStates').filter((state) => ['open', 'resolved', 'dismissed', 'unflagged'].includes(state)),
    search: typeof value.search === 'string' ? value.search.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 1_200) : '',
    group: ['feature', 'technical', 'none'].includes(value.group) ? value.group : 'feature',
    sort: ['attention', 'feature', 'technical', 'audit', 'capture-time'].includes(value.sort) ? value.sort : 'attention',
  };
}

function encodeArchiveCursor(descriptor, query, offset) {
  const bytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    contentRevision: descriptor.contentRevision,
    orderRevision: descriptor.orderRevision,
    flagRevision: descriptor.flagRevision,
    query,
    offset,
  }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `archive.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

function decodeArchiveCursor(value, descriptor, query, maximum) {
  if (typeof value !== 'string' || !value.startsWith('archive.')) throw new TypeError('The archive cursor is invalid.');
  const encoded = value.slice('archive.'.length).replaceAll('-', '+').replaceAll('_', '/');
  let document;
  try {
    const binary = atob(`${encoded}${'='.repeat((4 - encoded.length % 4) % 4)}`);
    document = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
  } catch {
    throw new TypeError('The archive cursor is invalid.');
  }
  if (
    document?.schemaVersion !== 1
    || document.contentRevision !== descriptor.contentRevision
    || document.orderRevision !== descriptor.orderRevision
    || document.flagRevision !== descriptor.flagRevision
    || JSON.stringify(document.query) !== JSON.stringify(query)
    || !Number.isSafeInteger(document.offset) || document.offset < 0 || document.offset > maximum
  ) throw new TypeError('The archive cursor does not belong to this query and pinned revision.');
  return document.offset;
}

function rowMatches(row, query) {
  const any = (actual, expected) => expected.length === 0 || expected.some((value) => actual.includes(value));
  return (!query.kinds.length || query.kinds.includes(row.kind))
    && (!query.statuses.length || query.statuses.includes(row.status))
    && (!query.environments.length || query.environments.includes(row.environment))
    && any(row.featureSuites ?? [], query.featureSuites)
    && (!query.technicalSuites.length || query.technicalSuites.includes(row.technicalSuite))
    && (!query.targets.length || query.targets.some((target) => row.targets?.includes(target)))
    && (!query.flagStates.length || query.flagStates.includes(row.flagState))
    && (!query.search || String(row.searchText ?? '').includes(query.search));
}

function compareText(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return String(left).localeCompare(String(right));
}

function compareRows(left, right, query) {
  if (query.sort === 'attention') {
    const flag = Number(left.flagState !== 'open') - Number(right.flagState !== 'open');
    if (flag) return flag;
    const rank = (status) => ['failed', 'blocked', 'fail', 'timedout', 'timed-out', 'interrupted'].includes(String(status).toLowerCase()) ? 1
      : ['flaky', 'review'].includes(String(status).toLowerCase()) ? 2 : 3;
    const status = rank(left.status) - rank(right.status);
    if (status) return status;
    const warning = Number(Boolean(right.visualWarning || !right.available)) - Number(Boolean(left.visualWarning || !left.available));
    if (warning) return warning;
  }
  if (query.sort === 'feature' || (query.sort === 'attention' && query.group === 'feature')) {
    const result = compareText(left.primaryFeatureSuite, right.primaryFeatureSuite);
    if (result) return result;
  }
  if (query.sort === 'technical' || (query.sort === 'attention' && query.group === 'technical')) {
    const result = compareText(left.technicalSuite, right.technicalSuite);
    if (result) return result;
  }
  if (query.sort === 'audit') {
    const ordinal = (left.auditAssociations?.[0]?.catalogOrdinal ?? Number.MAX_SAFE_INTEGER)
      - (right.auditAssociations?.[0]?.catalogOrdinal ?? Number.MAX_SAFE_INTEGER);
    if (ordinal) return ordinal;
    const associations = (left.auditAssociations ?? []).map(({ id }) => id).sort().join('\0')
      .localeCompare((right.auditAssociations ?? []).map(({ id }) => id).sort().join('\0'));
    if (associations) return associations;
  }
  if (query.sort === 'capture-time') {
    const capture = compareText(left.captureTime, right.captureTime);
    if (capture) return capture;
  }
  return String(left.title ?? '').localeCompare(String(right.title ?? '')) || String(left.id).localeCompare(String(right.id));
}

function boundedCacheSet(cache, key, value, limit) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

export function createArchiveGalleryAdapter({ descriptor: descriptorValue, transport }) {
  const descriptor = requireDescriptor(descriptorValue);
  const queryChunks = new Map();
  const details = new Map();
  let flags = null;

  async function loadChunk(reference, ordinal, kind, signal) {
    const cache = kind === 'query' ? queryChunks : null;
    if (cache?.has(ordinal)) return cache.get(ordinal);
    const payload = await transport.load(reference.href, { kind, ordinal }, signal);
    if (payload.rows.length !== reference.rows) throw new TypeError('The archive chunk row count does not match its descriptor.');
    if (kind === 'query') {
      for (const row of payload.rows) decodeGalleryQueryRow(row);
      cache.set(ordinal, payload.rows);
    }
    return payload.rows;
  }

  async function allQueryRows(signal) {
    const rows = [];
    for (const [index, reference] of descriptor.query.chunks.entries()) {
      if (signal?.aborted) throw abortError();
      rows.push(...await loadChunk(reference, index + 1, 'query', signal));
    }
    if (rows.length !== descriptor.query.rows || new Set(rows.map(({ id }) => id)).size !== rows.length) {
      throw new TypeError('The archive query index is incomplete or contains duplicate items.');
    }
    return rows;
  }

  function isPublishedAttentionQuery(query) {
    return query.sort === 'attention' && query.group === 'feature' && query.search === ''
      && Object.keys(FILTER_NAMES).every((name) => query[name].length === 0);
  }

  async function publishedAttentionPage(offset, limit, signal) {
    const rows = [];
    const pageEnd = Math.min(descriptor.query.rows, offset + limit);
    let chunkStart = 0;
    for (const [index, reference] of descriptor.query.chunks.entries()) {
      const chunkEnd = chunkStart + reference.rows;
      if (chunkEnd > offset && chunkStart < pageEnd) {
        const chunk = await loadChunk(reference, index + 1, 'query', signal);
        rows.push(...chunk.slice(Math.max(0, offset - chunkStart), Math.min(chunk.length, pageEnd - chunkStart)));
      }
      chunkStart = chunkEnd;
      if (chunkStart >= pageEnd) break;
    }
    if (rows.length !== pageEnd - offset) throw new TypeError('The archive query page is incomplete.');
    return rows;
  }

  async function detailFor(itemId, signal) {
    if (!ITEM_ID.test(itemId)) throw new TypeError('The archive item ID is invalid.');
    if (details.has(itemId)) return details.get(itemId);
    const href = `${descriptor.itemDetails.hrefPrefix}${encodeURIComponent(itemId)}${descriptor.itemDetails.hrefSuffix}`;
    const payload = await transport.load(href, { kind: 'detail', itemId }, signal);
    decodeGalleryItemDetail(payload);
    boundedCacheSet(details, itemId, payload, GALLERY_LIMITS.retainedThumbnails);
    return payload;
  }

  async function flagSnapshot(signal) {
    if (!flags) {
      flags = await transport.load(descriptor.flags.href, { kind: 'flags' }, signal);
      if (flags.throughEvent !== descriptor.flags.throughEvent) throw new TypeError('The flag snapshot event boundary does not match the descriptor.');
    }
    return flags;
  }

  return Object.freeze({
    async loadHead({ signal }) {
      if (signal?.aborted) throw abortError();
      return { ...descriptor, total: descriptor.query.rows, flagCapability: { mutable: false, identity: 'archive-snapshot', authenticated: false } };
    },
    async loadItems({ query, cursor, limit, anchorItemId, signal }) {
      const normalized = normalizedArchiveQuery(query);
      const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, GALLERY_LIMITS.pageRows));
      const usesPublishedOrder = isPublishedAttentionQuery(normalized) && !ITEM_ID.test(anchorItemId ?? '');
      if (usesPublishedOrder) {
        const offset = cursor ? decodeArchiveCursor(cursor, descriptor, normalized, descriptor.query.rows) : 0;
        const items = await publishedAttentionPage(offset, boundedLimit, signal);
        const nextOffset = offset + items.length;
        return {
          phase: 'sealed', items, total: descriptor.query.rows, offset,
          nextCursor: nextOffset < descriptor.query.rows ? encodeArchiveCursor(descriptor, normalized, nextOffset) : null,
          contentRevision: descriptor.contentRevision, orderRevision: descriptor.orderRevision, flagRevision: descriptor.flagRevision,
        };
      }
      const ordered = (await allQueryRows(signal)).filter((row) => rowMatches(row, normalized)).sort((left, right) => compareRows(left, right, normalized));
      let offset = cursor ? decodeArchiveCursor(cursor, descriptor, normalized, ordered.length) : 0;
      if (!cursor && ITEM_ID.test(anchorItemId ?? '')) {
        const anchor = ordered.findIndex(({ id }) => id === anchorItemId);
        if (anchor >= 0) offset = Math.floor(anchor / boundedLimit) * boundedLimit;
      }
      const items = ordered.slice(offset, offset + boundedLimit);
      const nextOffset = offset + items.length;
      return {
        phase: 'sealed', items, total: ordered.length, offset,
        nextCursor: nextOffset < ordered.length ? encodeArchiveCursor(descriptor, normalized, nextOffset) : null,
        contentRevision: descriptor.contentRevision, orderRevision: descriptor.orderRevision, flagRevision: descriptor.flagRevision,
      };
    },
    async loadItem({ itemId, signal }) {
      const [detail, snapshot] = await Promise.all([detailFor(itemId, signal), flagSnapshot(signal)]);
      const itemFlags = snapshot.flags.filter((flag) => flag.itemId === itemId).slice(0, 100);
      return { ...detail, review: { flagRevision: descriptor.flagRevision, flags: itemFlags } };
    },
    async loadAvailability({ itemId, signal }) { return (await detailFor(itemId, signal)).availability; },
    async resolveMedia({ item, member, mediaReference, posterReference, signal }) {
      if (signal?.aborted) throw abortError();
      const url = validateArchiveMediaUrl(mediaReference?.href, item.kind, member?.contentType ?? null);
      const posterUrl = posterReference?.href ? validateArchiveMediaUrl(posterReference.href, 'image', null) : null;
      return { validatedByAdapter: true, url, posterUrl };
    },
    async resolveThumbnail({ row, signal }) {
      const detail = await detailFor(row.id, signal);
      const media = detail.media.find(({ available, contentType }) => available && MEDIA_TYPES.image.has(contentType));
      return media ? { validatedByAdapter: true, url: validateArchiveMediaUrl(media.href, 'image', media.contentType) } : null;
    },
    async loadFlags({ signal } = {}) {
      return flagSnapshot(signal);
    },
    async loadRawPage({ ordinal, signal }) {
      const reference = descriptor.raw.chunks[ordinal - 1];
      if (!reference) return { ordinal, rows: [], total: descriptor.raw.rows, pages: descriptor.raw.chunks.length };
      const rows = await loadChunk(reference, ordinal, 'raw', signal);
      return { ordinal, rows, total: descriptor.raw.rows, pages: descriptor.raw.chunks.length };
    },
    destroy() { transport.destroy(); queryChunks.clear(); details.clear(); flags = null; },
  });
}

function parseArchiveUrl(url) {
  const params = url.searchParams;
  const list = (name, allowed = null) => params.getAll(name).filter((value) => value.length <= 1_200 && (!allowed || allowed.has(value))).slice(0, 20);
  return {
    mode: params.get('mode') === 'overview' ? 'overview' : 'workbench',
    itemId: ITEM_ID.test(params.get('item') ?? '') ? params.get('item') : null,
    memberId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(params.get('member') ?? '') ? params.get('member') : null,
    raw: params.get('raw') === '1',
    query: {
      kinds: list('kind', new Set(['image', 'video'])), statuses: list('status'), environments: list('environment'),
      featureSuites: list('featureSuite'), technicalSuites: list('technicalSuite'), targets: list('target'),
      flagStates: list('flagState', new Set(['open', 'resolved', 'dismissed', 'unflagged'])),
      search: (params.get('q') ?? '').slice(0, 1_200),
      group: ['feature', 'technical', 'none'].includes(params.get('group')) ? params.get('group') : 'feature',
      sort: ['attention', 'feature', 'technical', 'audit', 'capture-time'].includes(params.get('sort')) ? params.get('sort') : 'attention',
    },
  };
}

function appendTextRow(list, copy) {
  const row = document.createElement('li');
  row.textContent = String(copy).replace(/\s+/g, ' ').trim().slice(0, 1_200);
  list.append(row);
}

export async function bootstrapArchiveGallery(documentObject = document, windowObject = window) {
  const headNode = documentObject.querySelector('#gallery-archive-head');
  const descriptor = requireDescriptor(JSON.parse(headNode?.textContent ?? 'null'));
  const parsed = parseArchiveUrl(new URL(windowObject.location.href));
  const transport = createArchiveIframeTransport({
    descriptor,
    documentObject,
    windowObject,
    onRequest: (detail) => windowObject.dispatchEvent(new CustomEvent('gallery:archive-request', { detail })),
  });
  const adapter = createArchiveGalleryAdapter({ descriptor, transport });
  const root = documentObject.querySelector('#gallery-workbench');
  const announcer = documentObject.querySelector('#gallery-announcer');
  documentObject.querySelector('#gallery-exported-at').textContent = new Date(descriptor.exportedAt).toLocaleString();
  documentObject.querySelector('#gallery-exported-at').dateTime = descriptor.exportedAt;
  documentObject.querySelector('#gallery-export-revision').textContent = descriptor.exportRevision.replace('export_', '');
  documentObject.querySelector('#gallery-primary-counts').textContent = `${descriptor.primaryCounts.total} logical · ${descriptor.primaryCounts.images} photos · ${descriptor.primaryCounts.videos} videos`;
  const workbench = createGalleryWorkbench(root, {
    adapter,
    initialState: { mode: parsed.mode, query: parsed.query },
    announce: (copy) => { announcer.textContent = copy; },
    onFirstUsable: () => windowObject.performance?.mark?.('gallery:first-usable'),
    observerFactory: windowObject.IntersectionObserver ? (callback) => new windowObject.IntersectionObserver(callback, { rootMargin: '160px' }) : null,
    fullscreen: {
      enter: (node) => node.requestFullscreen(), exit: () => documentObject.exitFullscreen(),
      isActive: () => Boolean(documentObject.fullscreenElement),
    },
  });
  const updateUrl = (state) => {
    const url = new URL(windowObject.location.href);
    url.search = '';
    if (state.mode !== 'workbench') url.searchParams.set('mode', state.mode);
    if (state.selection.itemId) url.searchParams.set('item', state.selection.itemId);
    if (state.selection.memberId) url.searchParams.set('member', state.selection.memberId);
    for (const [key, name] of Object.entries(FILTER_NAMES)) for (const value of state.query[key] ?? []) url.searchParams.append(name, value);
    if (state.query.group !== 'feature') url.searchParams.set('group', state.query.group);
    if (state.query.sort !== 'attention') url.searchParams.set('sort', state.query.sort);
    if (state.query.search) url.searchParams.set('q', state.query.search);
    if (documentObject.querySelector('#raw-drawer').open) url.searchParams.set('raw', '1');
    windowObject.history.replaceState(null, '', url);
  };
  workbench.subscribe(updateUrl);
  documentObject.addEventListener('fullscreenchange', () => workbench.dispatch({ type: 'FULLSCREEN_CHANGED', active: Boolean(documentObject.fullscreenElement) }));

  const flagDrawer = documentObject.querySelector('#flag-drawer');
  flagDrawer.addEventListener('toggle', () => {
    if (!flagDrawer.open || flagDrawer.dataset.loaded) return;
    flagDrawer.dataset.loaded = 'loading';
    const controller = new AbortController();
    adapter.loadFlags({ signal: controller.signal }).then((snapshot) => {
      flagDrawer.dataset.loaded = 'true';
      documentObject.querySelector('#gallery-flag-count').textContent = `${snapshot.flags.length} at event ${snapshot.throughEvent}`;
      documentObject.querySelector('#flag-state').textContent = `${snapshot.flags.length} final flag projection${snapshot.flags.length === 1 ? '' : 's'} · ${snapshot.events.length} immutable history event${snapshot.events.length === 1 ? '' : 's'}.`;
      const list = documentObject.querySelector('#flag-history');
      list.replaceChildren();
      for (const flag of snapshot.flags.slice(0, 500)) appendTextRow(
        list,
        `Final ${flag.state} · ${flag.title ?? flag.testId ?? flag.itemId} · ${flag.reviewer} · ${flag.note ?? flag.justification ?? 'No review note'} · ${flag.updatedAt ?? 'time unavailable'}`,
      );
      for (const event of snapshot.events.slice(-500)) appendTextRow(
        list,
        `History ${event.sequence}. ${event.action} · ${event.identity?.title ?? event.itemId} · ${event.reviewer} · ${event.note ?? event.justification ?? 'No review note'} · ${event.timestamp}`,
      );
      if (!snapshot.events.length) appendTextRow(list, 'No reviewer flag events were present in this snapshot.');
    }).catch((error) => { flagDrawer.dataset.loaded = ''; documentObject.querySelector('#flag-state').textContent = error.message; });
    flagDrawer.addEventListener('toggle', () => { if (!flagDrawer.open) controller.abort(); }, { once: true });
  });

  let rawOrdinal = 1;
  let rawController = null;
  const renderRaw = async (ordinal) => {
    rawController?.abort();
    rawController = new AbortController();
    const stateNode = documentObject.querySelector('#raw-state');
    stateNode.textContent = 'Loading a bounded raw index page…';
    try {
      const page = await adapter.loadRawPage({ ordinal, signal: rawController.signal });
      rawOrdinal = Math.max(1, Math.min(ordinal, Math.max(1, page.pages)));
      const list = documentObject.querySelector('#raw-files');
      list.replaceChildren();
      for (const row of page.rows) appendTextRow(list, `${row.kind} · ${row.contentType} · ${row.sizeBytes} bytes · ${row.storageCopyCount} stored cop${row.storageCopyCount === 1 ? 'y' : 'ies'} · ${row.href ?? 'unavailable'}`);
      stateNode.textContent = `Raw page ${rawOrdinal} of ${Math.max(1, page.pages)} · ${page.total} raw storage rows (not logical evidence).`;
      documentObject.querySelector('#previous-raw').disabled = rawOrdinal <= 1;
      documentObject.querySelector('#next-raw').disabled = rawOrdinal >= page.pages;
    } catch (error) { if (error.name !== 'AbortError') stateNode.textContent = error.message; }
  };
  const rawDrawer = documentObject.querySelector('#raw-drawer');
  rawDrawer.open = parsed.raw;
  rawDrawer.addEventListener('toggle', () => { updateUrl(workbench.getState()); if (rawDrawer.open) void renderRaw(rawOrdinal); else rawController?.abort(); });
  documentObject.querySelector('#previous-raw').addEventListener('click', () => void renderRaw(rawOrdinal - 1));
  documentObject.querySelector('#next-raw').addEventListener('click', () => void renderRaw(rawOrdinal + 1));

  const loading = documentObject.querySelector('#gallery-loading');
  try {
    const head = await workbench.loadHead();
    await workbench.loadSequence({
      revision: head.contentRevision, orderRevision: head.orderRevision, flagRevision: head.flagRevision,
      preferredItemId: parsed.itemId,
    });
    if (parsed.memberId && workbench.getState().detail?.item?.members.some(({ id }) => id === parsed.memberId)) {
      workbench.dispatch({ type: 'SET_MEMBER', memberId: parsed.memberId });
      await workbench.resolveSelectedMedia();
    }
    loading.hidden = true;
    if (parsed.raw) await renderRaw(1);
  } catch (error) {
    loading.hidden = true;
    const fatal = documentObject.querySelector('#gallery-fatal');
    fatal.hidden = false;
    documentObject.querySelector('#gallery-fatal-message').textContent = error.message;
  }
  const destroy = () => { rawController?.abort(); workbench.destroy(); adapter.destroy(); };
  documentObject.querySelector('#gallery-retry').addEventListener('click', () => windowObject.location.reload());
  windowObject.addEventListener('pagehide', destroy, { once: true });
  return { descriptor, workbench, adapter, transport, destroy };
}

if ((typeof location === 'undefined' || location.protocol !== 'file:') && typeof document !== 'undefined' && document.querySelector('#gallery-archive-head')) {
  bootstrapArchiveGallery().catch((error) => {
    const loading = document.querySelector('#gallery-loading');
    const fatal = document.querySelector('#gallery-fatal');
    if (loading) loading.hidden = true;
    if (fatal) fatal.hidden = false;
    const message = document.querySelector('#gallery-fatal-message');
    if (message) message.textContent = error instanceof Error ? error.message : 'The gallery archive could not open.';
  });
}
