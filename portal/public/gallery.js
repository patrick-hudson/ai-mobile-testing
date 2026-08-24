import { createGalleryWorkbench } from './gallery-core.js';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$/;
const ITEM_ID = /^gitem_[a-f0-9]{16}$/;
const MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REVISION = /^(?:content|order|flags)_[a-f0-9]{16}$/;
const FILTERS = Object.freeze({
  kind: ['kinds', new Set(['image', 'video'])],
  status: ['statuses', null],
  environment: ['environments', null],
  featureSuite: ['featureSuites', null],
  technicalSuite: ['technicalSuites', null],
  target: ['targets', null],
  flagState: ['flagStates', new Set(['open', 'resolved', 'dismissed', 'unflagged'])],
});
const QUERY_NAMES = Object.freeze({
  kinds: 'kind', statuses: 'status', environments: 'environment', featureSuites: 'featureSuite',
  technicalSuites: 'technicalSuite', targets: 'target', flagStates: 'flagState',
});
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ALLOWED_VIDEO_TYPES = new Set(['video/webm', 'video/mp4']);
const ACTIVITY_ENTRY_LIMIT = 200;
const ACTIVITY_CHARACTER_LIMIT = 64 * 1024;
const DELTA_PAGE_LIMIT = 100;
const DELTA_ROW_LIMIT = 25_000;
const REVIEWER_KEY = 'quitting7oh.gallery.reviewer-label.v1';

const elements = Object.fromEntries([
  'gallery-back', 'gallery-connection', 'gallery-refresh', 'gallery-run-id', 'gallery-phase', 'gallery-counts',
  'gallery-revision', 'gallery-lifecycle', 'gallery-fatal', 'gallery-fatal-title', 'gallery-fatal-message',
  'gallery-retry', 'gallery-loading', 'gallery-workbench', 'gallery-activity', 'gallery-activity-count',
  'execution-drawer', 'execution-state', 'reload-execution', 'execution-log', 'raw-drawer', 'raw-state',
  'previous-raw', 'load-more-raw', 'raw-files', 'gallery-flag-dialog', 'gallery-flag-form', 'gallery-flag-close',
  'gallery-flag-cancel', 'gallery-reviewer', 'gallery-flag-action', 'gallery-flag-id-field', 'gallery-flag-id',
  'gallery-flag-copy', 'gallery-flag-note', 'gallery-flag-state', 'gallery-flag-submit', 'gallery-announcer',
].map((id) => [id.replaceAll('-', '_'), document.querySelector(`#${id}`)]));

const parsed = parseReviewUrl(new URL(window.location.href));
const state = {
  runId: parsed.runId,
  from: parsed.from,
  workbench: null,
  head: null,
  stream: null,
  eventSequence: 0,
  activity: [],
  activityCharacters: 0,
  rawOffset: 0,
  rawCurrentOffset: 0,
  rawHasMore: true,
  rawLoading: false,
  logStream: null,
  detailCache: new Map(),
  acceptedRevisionKey: null,
  flags: null,
  flagAttempt: null,
  flagController: null,
  flagGeneration: 0,
  deltaController: null,
  deltaGeneration: 0,
  flagItemId: null,
  flagOpener: null,
  destroyed: false,
  firstSequence: true,
  initialMemberRestored: false,
};

init().catch((error) => showFatal(error));

async function init() {
  if (!state.runId) throw new PortalGalleryError(400, 'INVALID_GALLERY_URL', 'Choose a valid run from the release audit console.');
  const encodedRun = encodeURIComponent(state.runId);
  elements.gallery_run_id.textContent = state.runId;
  document.title = `Run ${state.runId} · Visual evidence gallery`;
  elements.gallery_back.href = state.from === 'report' ? `/report.html?run=${encodedRun}` : '/';
  elements.gallery_back.textContent = state.from === 'report' ? '← Run report' : '← Release audit console';
  elements.gallery_reviewer.value = loadReviewerLabel();
  bindPageEvents();

  const adapter = createPortalAdapter();
  state.workbench = createGalleryWorkbench(elements.gallery_workbench, {
    adapter,
    initialState: { mode: parsed.mode, query: parsed.query },
    announce,
    onFirstUsable: () => performance.mark('gallery:first-usable'),
    onFlagIntent: (itemId) => void openFlagDialog(itemId),
    observerFactory: window.IntersectionObserver
      ? (callback) => new IntersectionObserver(callback, { rootMargin: '160px' })
      : null,
    fullscreen: {
      enter: (node) => node.requestFullscreen(),
      exit: () => document.exitFullscreen(),
      isActive: () => Boolean(document.fullscreenElement),
    },
  });
  state.workbench.subscribe(onGalleryState);
  const headReady = await refreshHead({ initial: true });
  if (!headReady) return;
  connectGalleryEvents();
  if (parsed.raw) elements.raw_drawer.open = true;
  if (elements.raw_drawer.open) await loadRawFiles();
}

function bindPageEvents() {
  elements.gallery_refresh.addEventListener('click', () => void refreshHead());
  elements.gallery_retry.addEventListener('click', () => void refreshHead());
  elements.execution_drawer.addEventListener('toggle', () => {
    if (elements.execution_drawer.open && elements.execution_state.textContent === 'Not loaded') void loadExecutionLog();
  });
  elements.reload_execution.addEventListener('click', () => void loadExecutionLog());
  elements.raw_drawer.addEventListener('toggle', () => {
    updateUrl();
    if (elements.raw_drawer.open && state.rawOffset === 0) void loadRawFiles();
  });
  elements.load_more_raw.addEventListener('click', () => void loadRawFiles());
  elements.previous_raw?.addEventListener('click', () => void loadRawFiles({ offset: Math.max(0, state.rawCurrentOffset - 100) }));
  elements.gallery_flag_close.addEventListener('click', closeFlagDialog);
  elements.gallery_flag_cancel.addEventListener('click', closeFlagDialog);
  elements.gallery_flag_action.addEventListener('change', renderFlagFormMode);
  elements.gallery_flag_form.addEventListener('input', () => { state.flagAttempt = null; });
  elements.gallery_flag_form.addEventListener('submit', submitFlag);
  elements.gallery_flag_dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeFlagDialog(); });
  window.addEventListener('pagehide', destroy);
  document.addEventListener('fullscreenchange', () => state.workbench?.dispatch({
    type: 'FULLSCREEN_CHANGED', active: Boolean(document.fullscreenElement),
  }));
}

async function refreshHead({ initial = false } = {}) {
  try {
    elements.gallery_refresh.disabled = true;
    const head = await state.workbench.loadHead();
    if (!head) {
      elements.gallery_loading.hidden = true;
      elements.gallery_loading.setAttribute('aria-busy', 'false');
      elements.gallery_connection.textContent = state.workbench.getState().purged ? 'Run removed' : 'Gallery needs attention';
      return false;
    }
    state.head = head;
    renderHead(head);
    state.workbench.dispatch({ type: 'SET_CAPABILITY', capability: { flagsMutable: Boolean(head.flagCapability?.mutable) } });
    if (initial && head.phase !== 'waiting') {
      await state.workbench.loadSequence({
        revision: head.contentRevision,
        orderRevision: head.orderRevision,
        flagRevision: head.flagRevision,
        preferredItemId: parsed.itemId,
      });
      await restoreInitialMember();
    }
    elements.gallery_loading.hidden = true;
    elements.gallery_loading.setAttribute('aria-busy', 'false');
    elements.gallery_fatal.hidden = true;
    elements.gallery_connection.textContent = head.phase === 'waiting' ? 'Watching active run…' : 'Gallery connected';
    if (!initial && !state.stream) connectGalleryEvents();
    return true;
  } catch (error) {
    if (initial) showFatal(error); else announce(`Gallery refresh failed. ${friendlyError(error)}`);
    return false;
  } finally {
    elements.gallery_refresh.disabled = false;
  }
}

function renderHead(head) {
  elements.gallery_phase.textContent = head.phase === 'waiting' ? 'Waiting for evidence' : `${humanize(head.phase)} catalog`;
  const counts = head.primaryCounts ?? {};
  elements.gallery_counts.textContent = `${counts.total ?? 0} logical items · ${counts.images ?? 0} photos · ${counts.videos ?? 0} videos`;
  elements.gallery_revision.textContent = shortRevision(head.contentRevision);
  const lifecycle = head.lifecycle ?? {};
  elements.gallery_lifecycle.textContent = head.phase === 'waiting'
    ? lifecycle.terminal
      ? `The run is ${humanize(lifecycle.status)} and has not published eligible visual evidence.`
      : `The run is ${humanize(lifecycle.status)}. This page is watching for finalized screenshots and validated videos.`
    : `${humanize(lifecycle.status ?? head.phase)} · ${counts.total ?? head.total ?? 0} logical evidence item${(counts.total ?? head.total) === 1 ? '' : 's'} at a frozen review revision.`;
}

function onGalleryState(gallery, action) {
  const accepted = gallery.accepted;
  const revisionKey = `${accepted.contentRevision ?? ''}\u0000${accepted.orderRevision ?? ''}\u0000${accepted.flagRevision ?? ''}`;
  if (state.acceptedRevisionKey && revisionKey !== state.acceptedRevisionKey) state.detailCache.clear();
  state.acceptedRevisionKey = revisionKey;
  if (accepted.contentRevision) elements.gallery_revision.textContent = shortRevision(accepted.contentRevision);
  if (action.type === 'QUERY_SUCCEEDED' && state.firstSequence) {
    state.firstSequence = false;
    if (accepted.total > 0) announce(`Visual evidence ready. ${accepted.total} logical item${accepted.total === 1 ? '' : 's'}.`);
  }
  if (action.type === 'FLAG_SUCCEEDED' && action.result?.flagRevision) {
    state.head = { ...state.head, flagRevision: action.result.flagRevision };
  }
  updateUrl(gallery);
}

function updateUrl(gallery = state.workbench?.getState()) {
  if (!state.runId || !gallery) return;
  const params = new URLSearchParams();
  params.set('run', state.runId);
  if (state.from !== 'runs') params.set('from', state.from);
  if (gallery.mode !== 'workbench') params.set('mode', gallery.mode);
  if (gallery.selection.itemId) params.set('item', gallery.selection.itemId);
  if (gallery.selection.memberId) params.set('member', gallery.selection.memberId);
  for (const [key, name] of Object.entries(QUERY_NAMES)) {
    for (const value of gallery.query[key] ?? []) params.append(name, value);
  }
  if (gallery.query.group !== 'feature') params.set('group', gallery.query.group);
  if (gallery.query.sort !== 'attention') params.set('sort', gallery.query.sort);
  if (gallery.query.search) params.set('q', gallery.query.search);
  if (elements.raw_drawer.open) params.set('raw', '1');
  history.replaceState(null, '', `/gallery.html?${params}`);
}

function createPortalAdapter() {
  const encodedRun = encodeURIComponent(state.runId);
  const revisions = (params, source = state.workbench?.getState().accepted) => {
    if (REVISION.test(source?.contentRevision ?? '') && REVISION.test(source?.orderRevision ?? '') && REVISION.test(source?.flagRevision ?? '')) {
      params.set('contentRevision', source.contentRevision);
      params.set('orderRevision', source.orderRevision);
      params.set('flagRevision', source.flagRevision);
    }
  };
  return {
    async loadHead({ signal }) {
      return loggedJson(`/api/runs/${encodedRun}/gallery`, { signal, activityPath: '/api/runs/:run/gallery' });
    },
    async loadItems({ query, contentRevision, orderRevision, flagRevision, cursor, limit, anchorItemId, signal }) {
      const params = new URLSearchParams({ limit: String(limit), group: query.group, sort: query.sort });
      if (cursor) params.set('cursor', cursor);
      else if (anchorItemId && ITEM_ID.test(anchorItemId)) params.set('anchor', anchorItemId);
      revisions(params, { contentRevision, orderRevision, flagRevision });
      for (const [key, name] of Object.entries(QUERY_NAMES)) for (const value of query[key] ?? []) params.append(name, value);
      if (query.search) params.set('q', query.search);
      const page = await loggedJson(`/api/runs/${encodedRun}/gallery/items?${params}`, {
        signal, activityPath: '/api/runs/:run/gallery/items', rowCount: (value) => value.items?.length,
      });
      return page;
    },
    async loadItem({ itemId, contentRevision, signal }) {
      const params = new URLSearchParams();
      const accepted = state.workbench.getState().accepted;
      revisions(params, { ...accepted, contentRevision });
      const detail = await loggedJson(`/api/runs/${encodedRun}/gallery/items/${encodeURIComponent(itemId)}?${params}`, {
        signal, activityPath: '/api/runs/:run/gallery/items/:item',
      });
      rememberDetail(itemId, detail, accepted);
      return detail;
    },
    async loadAvailability({ itemId, signal }) {
      const params = new URLSearchParams();
      revisions(params);
      return loggedJson(`/api/runs/${encodedRun}/gallery/items/${encodeURIComponent(itemId)}/availability?${params}`, {
        signal, activityPath: '/api/runs/:run/gallery/items/:item/availability',
      });
    },
    async resolveMedia({ item, member, mediaReference, posterReference, signal }) {
      if (signal.aborted) throw abortError();
      const url = validateArtifactMedia(mediaReference?.href, item.kind, member?.contentType);
      const posterUrl = posterReference?.href ? validateArtifactMedia(posterReference.href, 'image', null) : null;
      activity('MEDIA', `validated ${item.kind} member path${posterUrl ? ' with poster' : ''}`);
      return { validatedByAdapter: true, url, posterUrl };
    },
    async resolveThumbnail({ row, signal }) {
      const accepted = state.workbench.getState().accepted;
      let detail = state.detailCache.get(detailCacheKey(row.id, accepted));
      if (!detail) detail = await this.loadItem({ itemId: row.id, contentRevision: state.workbench.getState().accepted.contentRevision, signal });
      const first = detail.media.find(({ available, contentType }) => available && ALLOWED_IMAGE_TYPES.has(contentType));
      if (!first) return null;
      return { validatedByAdapter: true, url: validateArtifactMedia(first.href, 'image', first.contentType) };
    },
    async mutateFlag(transition) {
      return mutateFlagRequest(transition);
    },
    async loadDelta({ from, signal }) {
      const accepted = state.workbench.getState().accepted;
      return loadCompleteDelta({
        fromContentRevision: from ?? accepted.contentRevision,
        fromOrderRevision: accepted.orderRevision,
        fromFlagRevision: accepted.flagRevision,
        signal,
      });
    },
  };
}

async function loadCompleteDelta({ fromContentRevision, fromOrderRevision, fromFlagRevision, signal }) {
  const expectedFrom = { fromContentRevision, fromOrderRevision, fromFlagRevision };
  if (!Object.values(expectedFrom).every((revision) => REVISION.test(revision ?? ''))) {
    throw new PortalGalleryError(400, 'INVALID_GALLERY_REVISION', 'A complete retained gallery revision is required for delta discovery.');
  }
  const aggregate = { addedIds: [], changedIds: [], tombstones: [] };
  let offset = 0;
  let total = null;
  let targetRevision = null;
  for (let pageNumber = 0; pageNumber < Math.ceil(DELTA_ROW_LIMIT / DELTA_PAGE_LIMIT); pageNumber += 1) {
    if (signal?.aborted) throw abortError();
    const params = new URLSearchParams({ ...expectedFrom, offset: String(offset), limit: String(DELTA_PAGE_LIMIT) });
    const page = await loggedJson(`/api/runs/${encodeURIComponent(state.runId)}/gallery/delta?${params}`, {
      signal,
      activityPath: '/api/runs/:run/gallery/delta',
      rowCount: (value) => Number(value?.addedIds?.length ?? 0) + Number(value?.changedIds?.length ?? 0) + Number(value?.tombstones?.length ?? 0),
    });
    const pageIds = [...(page.addedIds ?? []), ...(page.changedIds ?? []), ...(page.tombstones ?? [])];
    if (
      page.offset !== offset
      || !Number.isInteger(page.total)
      || page.total < 0
      || page.total > DELTA_ROW_LIMIT
      || pageIds.length > DELTA_PAGE_LIMIT
      || pageIds.some((id) => !ITEM_ID.test(id))
      || page.fromContentRevision !== fromContentRevision
      || page.fromOrderRevision !== fromOrderRevision
      || page.fromFlagRevision !== fromFlagRevision
    ) throw new PortalGalleryError(502, 'INVALID_GALLERY_DELTA', 'The portal returned an inconsistent gallery delta page.');
    const nextTarget = `${page.contentRevision}\u0000${page.orderRevision}\u0000${page.flagRevision}`;
    if (![page.contentRevision, page.orderRevision, page.flagRevision].every((revision) => REVISION.test(revision ?? ''))
      || (targetRevision !== null && targetRevision !== nextTarget)
      || (total !== null && total !== page.total)) {
      throw new PortalGalleryError(409, 'GALLERY_DELTA_CHANGED', 'The gallery changed while its delta pages were loading. Retry from the current revision.');
    }
    targetRevision = nextTarget;
    total = page.total;
    aggregate.addedIds.push(...(page.addedIds ?? []));
    aggregate.changedIds.push(...(page.changedIds ?? []));
    aggregate.tombstones.push(...(page.tombstones ?? []));
    if (!page.hasMore) {
      if (page.nextOffset !== page.total || pageIds.length + offset !== page.total) {
        throw new PortalGalleryError(502, 'INVALID_GALLERY_DELTA', 'The final gallery delta page did not match its declared total.');
      }
      return {
        schemaVersion: 1,
        ...expectedFrom,
        contentRevision: page.contentRevision,
        orderRevision: page.orderRevision,
        flagRevision: page.flagRevision,
        ...aggregate,
        total: page.total,
        offset: 0,
        limit: DELTA_PAGE_LIMIT,
        hasMore: false,
        nextOffset: page.total,
      };
    }
    if (!Number.isInteger(page.nextOffset) || page.nextOffset !== offset + pageIds.length || page.nextOffset <= offset) {
      throw new PortalGalleryError(502, 'INVALID_GALLERY_DELTA', 'The gallery delta cursor did not advance safely.');
    }
    offset = page.nextOffset;
  }
  throw new PortalGalleryError(413, 'GALLERY_DELTA_TOO_LARGE', `Gallery delta exceeded ${DELTA_ROW_LIMIT} bounded rows.`);
}

async function loggedJson(url, options = {}) {
  const started = performance.now();
  const method = options.method ?? 'GET';
  const activityPath = options.activityPath ?? new URL(url, location.origin).pathname;
  try {
    const response = await fetch(url, {
      method,
      signal: options.signal,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { /* handled as a structured response error below */ }
    activity('HTTP', `${method} ${activityPath} · ${response.status} · ${Math.round(performance.now() - started)} ms · ${text.length} bytes${options.rowCount ? ` · ${Number(options.rowCount(value) ?? 0)} rows` : ''}`);
    if (!response.ok) throw new PortalGalleryError(response.status, value?.code ?? 'GALLERY_REQUEST_FAILED', value?.error ?? value?.message ?? `Request failed with ${response.status}.`, value);
    if (value === null) throw new PortalGalleryError(502, 'INVALID_GALLERY_RESPONSE', 'The portal returned an invalid JSON response.');
    return value;
  } catch (error) {
    if (error?.name === 'AbortError') {
      activity('CANCEL', `${method} ${activityPath} · cancelled after ${Math.round(performance.now() - started)} ms`);
      throw error;
    }
    if (!(error instanceof PortalGalleryError)) activity('ERROR', `${method} ${activityPath} · network failure after ${Math.round(performance.now() - started)} ms`);
    throw error;
  }
}

function validateArtifactMedia(value, kind, declaredType) {
  if (typeof value !== 'string' || value === '' || value.includes('?') || value.includes('#') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PortalGalleryError(422, 'UNSAFE_MEDIA_URL', 'The evidence URL was rejected by the portal adapter.');
  }
  let parsedUrl;
  try { parsedUrl = new URL(value, location.origin); } catch { throw new PortalGalleryError(422, 'UNSAFE_MEDIA_URL', 'The evidence URL is invalid.'); }
  const prefix = `/artifacts/${encodeURIComponent(state.runId)}/`;
  if (parsedUrl.origin !== location.origin || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || !parsedUrl.pathname.startsWith(prefix)) {
    throw new PortalGalleryError(422, 'UNSAFE_MEDIA_URL', 'The evidence URL is outside this run.');
  }
  const relative = parsedUrl.pathname.slice(prefix.length);
  if (!relative || relative.split('/').some((encoded) => {
    if (!encoded) return true;
    try {
      const segment = decodeURIComponent(encoded);
      return segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || /[\u0000-\u001f\u007f]/.test(segment);
    } catch { return true; }
  })) throw new PortalGalleryError(422, 'UNSAFE_MEDIA_URL', 'The evidence URL contains an unsafe path segment.');
  const expected = kind === 'video' ? ALLOWED_VIDEO_TYPES : ALLOWED_IMAGE_TYPES;
  if (declaredType && !expected.has(declaredType)) throw new PortalGalleryError(422, 'UNSAFE_MEDIA_TYPE', 'The evidence content type does not match its logical media kind.');
  const extension = parsedUrl.pathname.split('.').at(-1)?.toLowerCase();
  const extensionAllowed = kind === 'video' ? ['webm', 'mp4'].includes(extension) : ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension);
  if (!extensionAllowed) throw new PortalGalleryError(422, 'UNSAFE_MEDIA_TYPE', 'The evidence file extension is not allowed for this media kind.');
  return parsedUrl.pathname;
}

function detailCacheKey(itemId, revision = state.workbench?.getState().accepted) {
  return `${revision?.contentRevision ?? ''}\u0000${revision?.orderRevision ?? ''}\u0000${revision?.flagRevision ?? ''}\u0000${itemId}`;
}

function rememberDetail(itemId, detail, revision) {
  const key = detailCacheKey(itemId, revision);
  state.detailCache.delete(key);
  state.detailCache.set(key, detail);
  while (state.detailCache.size > 72) state.detailCache.delete(state.detailCache.keys().next().value);
}

function connectGalleryEvents() {
  state.stream?.close();
  const suffix = state.eventSequence ? `?after=${state.eventSequence}` : '';
  const stream = new EventSource(`/api/runs/${encodeURIComponent(state.runId)}/gallery/events${suffix}`);
  state.stream = stream;
  stream.onopen = () => activity('SSE', 'gallery stream connected');
  stream.onerror = () => activity('SSE', 'gallery stream reconnecting');
  for (const type of ['gallery', 'gallery-flag', 'snapshot', 'stage', 'status', 'overflow']) {
    stream.addEventListener(type, (event) => void onGalleryEvent(type, event));
  }
}

async function onGalleryEvent(type, event) {
  state.eventSequence = Math.max(state.eventSequence, Number(event.lastEventId) || 0);
  let data = {};
  try { data = JSON.parse(event.data); } catch { /* keep invalid stream payload out of the UI */ }
  if (type === 'snapshot') {
    const manifest = data.manifest ?? {};
    activity('SSE', `snapshot · ${humanize(manifest.status ?? 'unknown')} · ${manifest.progress?.completed ?? 0}/${manifest.progress?.total ?? 0}`);
    return;
  }
  if (type === 'status' || type === 'stage') {
    activity('SSE', `${type} · ${humanize(data.status ?? data.stage ?? data.message ?? 'updated')}`);
    return;
  }
  if (type === 'overflow') activity('SSE', `bounded replay omitted ${Number(data.dropped ?? 0)} older events`);
  else if (type === 'gallery-flag') activity('FLAG', `${humanize(data.transition ?? 'updated')} · flag revision ${shortRevision(data.flagRevision)}`);
  else activity('SSE', 'new finalized gallery evidence announced');
  await discoverRevision();
}

async function discoverRevision() {
  state.deltaController?.abort();
  const controller = new AbortController();
  const generation = ++state.deltaGeneration;
  state.deltaController = controller;
  try {
    const head = await loggedJson(`/api/runs/${encodeURIComponent(state.runId)}/gallery`, {
      signal: controller.signal,
      activityPath: '/api/runs/:run/gallery',
    });
    if (controller.signal.aborted || generation !== state.deltaGeneration) return;
    state.head = head;
    renderHead(head);
    const current = state.workbench.getState().accepted;
    if (head.phase === 'waiting' || !current.contentRevision) {
      if (head.phase !== 'waiting') {
        await state.workbench.loadHead();
        await state.workbench.loadSequence({
          revision: head.contentRevision, orderRevision: head.orderRevision, flagRevision: head.flagRevision,
          preferredItemId: parsed.itemId,
        });
        await restoreInitialMember();
        announce(`The first finalized visual evidence is ready. ${head.primaryCounts?.total ?? 0} logical items are available.`);
      }
      return;
    }
    if (head.contentRevision === current.contentRevision && head.orderRevision === current.orderRevision && head.flagRevision === current.flagRevision) return;
    let attentionCount = 0;
    try {
      const delta = await loadCompleteDelta({
        fromContentRevision: current.contentRevision,
        fromOrderRevision: current.orderRevision,
        fromFlagRevision: current.flagRevision,
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== state.deltaGeneration) return;
      attentionCount = Number(delta.addedIds?.length ?? 0) + Number(delta.changedIds?.length ?? 0);
      activity('DELTA', `${delta.addedIds?.length ?? 0} added · ${delta.changedIds?.length ?? 0} changed · ${delta.tombstones?.length ?? 0} unavailable · ${delta.total ?? 0} total`);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      activity('DELTA', `fresh revision available; bounded delta unavailable (${error.status ?? 'network'})`);
    }
    if (controller.signal.aborted || generation !== state.deltaGeneration) return;
    state.workbench.dispatch({
      type: 'REVISION_AVAILABLE', contentRevision: head.contentRevision, orderRevision: head.orderRevision,
      flagRevision: head.flagRevision, head, attentionCount,
    });
    announce(`${attentionCount} new or changed attention item${attentionCount === 1 ? '' : 's'} available. Apply the updated order when ready.`);
  } catch (error) {
    if (error?.name !== 'AbortError' && error.status === 410) state.workbench.dispatch({ type: 'PURGED' });
  } finally {
    if (state.deltaController === controller) state.deltaController = null;
  }
}

async function restoreInitialMember() {
  if (state.initialMemberRestored || !parsed.memberId) return;
  const current = state.workbench.getState();
  const index = current.detail?.item.members.findIndex(({ id }) => id === parsed.memberId) ?? -1;
  const selected = current.detail?.item.members.findIndex(({ id }) => id === current.selection.memberId) ?? -1;
  if (index < 0) return;
  state.initialMemberRestored = true;
  if (index !== selected) await state.workbench.selectMember(index - selected);
}

async function loadExecutionLog() {
  elements.reload_execution.disabled = true;
  elements.execution_state.textContent = 'Loading latest 64 KiB…';
  try {
    const value = await loggedJson(`/api/runs/${encodeURIComponent(state.runId)}/logs?maxBytes=65536`, { activityPath: '/api/runs/:run/logs' });
    elements.execution_log.textContent = String(value.log ?? 'No execution output yet.').slice(-65_536);
    elements.execution_state.textContent = `${formatBytes(elements.execution_log.textContent.length)} shown · sequence ${value.sequence ?? 0}`;
  } catch (error) {
    elements.execution_state.textContent = `Log unavailable: ${friendlyError(error)}`;
  } finally { elements.reload_execution.disabled = false; }
}

async function loadRawFiles({ offset = state.rawOffset } = {}) {
  if (state.rawLoading || (offset === state.rawOffset && !state.rawHasMore)) return;
  state.rawLoading = true;
  elements.load_more_raw.disabled = true;
  elements.raw_state.textContent = 'Loading a bounded raw-file page…';
  try {
    const page = await loggedJson(`/api/runs/${encodeURIComponent(state.runId)}/artifacts?offset=${offset}&limit=100`, {
      activityPath: '/api/runs/:run/artifacts', rowCount: (value) => value.files?.length,
    });
    elements.raw_files.replaceChildren();
    for (const file of page.files ?? []) {
      const url = validateRawArtifactUrl(file.url);
      const link = document.createElement('a');
      link.className = 'artifact-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      const kind = document.createElement('small'); kind.textContent = String(file.kind ?? 'file').slice(0, 80);
      const path = document.createElement('span'); path.dir = 'auto'; path.textContent = `${String(file.path ?? '').slice(0, 1200)} · ${formatBytes(file.bytes)}`;
      link.append(kind, path); elements.raw_files.append(link);
    }
    state.rawCurrentOffset = Number(page.offset ?? offset);
    state.rawOffset = Number(page.nextOffset ?? state.rawCurrentOffset + (page.files?.length ?? 0));
    state.rawHasMore = Boolean(page.hasMore);
    const shownStart = (page.files?.length ?? 0) > 0 ? state.rawCurrentOffset + 1 : 0;
    elements.raw_state.textContent = `${shownStart}–${state.rawOffset} of ${page.totalComplete ? page.total : `${page.knownTotal ?? state.rawOffset}+`} storage paths`;
    elements.previous_raw.disabled = state.rawCurrentOffset === 0;
    elements.load_more_raw.textContent = state.rawHasMore ? 'Next page' : 'All known files loaded';
  } catch (error) {
    elements.raw_state.textContent = `Raw files unavailable: ${friendlyError(error)}`;
  } finally {
    state.rawLoading = false;
    elements.load_more_raw.disabled = !state.rawHasMore;
  }
}

function validateRawArtifactUrl(value) {
  if (typeof value !== 'string' || value.includes('?') || value.includes('#') || value.includes('\\')) throw new Error('Unsafe raw artifact URL.');
  const expected = `/artifacts/${encodeURIComponent(state.runId)}/`;
  if (!value.startsWith(expected) || value.slice(expected.length).split('/').some((part) => !part || ['.', '..'].includes(decodeURIComponent(part)))) throw new Error('Unsafe raw artifact URL.');
  return value;
}

async function openFlagDialog(itemId) {
  if (!ITEM_ID.test(itemId ?? '')) return;
  state.flagController?.abort();
  const controller = new AbortController();
  const generation = ++state.flagGeneration;
  state.flagController = controller;
  state.flagItemId = itemId;
  state.flagOpener = document.activeElement;
  state.flags = null;
  state.flagAttempt = null;
  elements.gallery_flag_submit.disabled = true;
  elements.gallery_flag_id.replaceChildren();
  elements.gallery_flag_state.textContent = 'Loading reviewer flags…';
  if (!elements.gallery_flag_dialog.open) elements.gallery_flag_dialog.showModal();
  try {
    const flags = await loggedJson(`/api/runs/${encodeURIComponent(state.runId)}/gallery/flags?itemId=${encodeURIComponent(itemId)}&projectionOffset=0&eventOffset=0&limit=50`, {
      signal: controller.signal, activityPath: '/api/runs/:run/gallery/flags', rowCount: (value) => value.flags?.length,
    });
    if (controller.signal.aborted || generation !== state.flagGeneration || state.flagItemId !== itemId || !elements.gallery_flag_dialog.open) return;
    state.flags = flags;
    renderFlagChoices();
    elements.gallery_reviewer.focus();
  } catch (error) {
    if (error?.name !== 'AbortError' && generation === state.flagGeneration) elements.gallery_flag_state.textContent = friendlyError(error);
  } finally {
    if (state.flagController === controller) state.flagController = null;
  }
}

function renderFlagChoices({ preserveAction = false } = {}) {
  const priorAction = elements.gallery_flag_action.value;
  const priorFlagId = elements.gallery_flag_id.value;
  elements.gallery_flag_id.replaceChildren();
  for (const flag of state.flags?.flags ?? []) {
    const option = document.createElement('option');
    option.value = flag.flagId;
    option.textContent = `${humanize(flag.state)} · ${String(flag.reviewer ?? 'Reviewer').slice(0, 120)}`;
    elements.gallery_flag_id.append(option);
  }
  if (priorFlagId && [...elements.gallery_flag_id.options].some(({ value }) => value === priorFlagId)) elements.gallery_flag_id.value = priorFlagId;
  const hasFlags = (state.flags?.flags ?? []).length > 0;
  const fallback = (state.flags?.flags ?? []).some(({ state: value }) => value === 'open')
    ? 'resolved'
    : hasFlags ? 'reopened' : 'open';
  elements.gallery_flag_action.value = preserveAction && (priorAction === 'open' || hasFlags) ? priorAction : fallback;
  if (!hasFlags && elements.gallery_flag_action.value !== 'open') elements.gallery_flag_action.value = 'open';
  elements.gallery_flag_state.textContent = state.flags?.capability?.mutable
    ? 'Ready. Reviewer identity is local attribution only.'
    : 'Read-only: this portal is outside the loopback trust boundary.';
  elements.gallery_flag_submit.disabled = !state.flags?.capability?.mutable;
  renderFlagFormMode();
}

function renderFlagFormMode() {
  const action = elements.gallery_flag_action.value;
  const transition = action !== 'open';
  const selectedFlagId = elements.gallery_flag_id.value;
  const eligible = (state.flags?.flags ?? []).filter(({ state: flagState }) => (
    ['resolved', 'dismissed'].includes(action) ? flagState === 'open'
      : action === 'reopened' ? ['resolved', 'dismissed'].includes(flagState)
        : false
  ));
  if (transition) {
    elements.gallery_flag_id.replaceChildren(...eligible.map((flag) => {
      const option = document.createElement('option');
      option.value = flag.flagId;
      option.textContent = `${humanize(flag.state)} · ${String(flag.reviewer ?? 'Reviewer').slice(0, 120)}`;
      return option;
    }));
    if (eligible.some(({ flagId }) => flagId === selectedFlagId)) elements.gallery_flag_id.value = selectedFlagId;
  }
  elements.gallery_flag_id_field.hidden = !transition;
  elements.gallery_flag_copy.textContent = ['resolved', 'dismissed'].includes(action) ? 'Required justification' : 'Detailed observation';
  elements.gallery_flag_submit.textContent = action === 'open' ? 'Open visual issue' : `${humanize(action)} issue`;
  elements.gallery_flag_submit.disabled = !state.flags?.capability?.mutable || (transition && eligible.length === 0);
}

async function submitFlag(event) {
  event.preventDefault();
  if (!elements.gallery_flag_form.reportValidity()) return;
  const reviewer = elements.gallery_reviewer.value.replace(/\s+/g, ' ').trim().slice(0, 120);
  const text = elements.gallery_flag_note.value.trim();
  if (reviewer.length < 2 || text.length < 3) return;
  saveReviewerLabel(reviewer);
  const action = elements.gallery_flag_action.value;
  if (!state.flags || !ITEM_ID.test(state.flagItemId ?? '')) return;
  const fingerprint = JSON.stringify([state.flagItemId, action, elements.gallery_flag_id.value, reviewer, text]);
  if (!state.flagAttempt || state.flagAttempt.fingerprint !== fingerprint) {
    state.flagAttempt = { fingerprint, idempotencyKey: crypto.randomUUID() };
  }
  elements.gallery_flag_submit.disabled = true;
  elements.gallery_flag_state.textContent = 'Saving one idempotent reviewer event…';
  try {
    const result = await mutateFlagRequest({
      action,
      itemId: state.flagItemId,
      flagId: transitionFlagId(action),
      reviewer,
      note: ['open', 'reopened'].includes(action) ? text : undefined,
      justification: ['resolved', 'dismissed'].includes(action) ? text : undefined,
      expectedFlagRevision: state.flags.flagRevision,
      idempotencyKey: state.flagAttempt.idempotencyKey,
    });
    if (!result) throw new Error('The reviewer event was not accepted.');
    await discoverRevision();
    elements.gallery_flag_state.textContent = result.idempotent ? 'The earlier save was confirmed without creating a duplicate.' : 'Reviewer event saved. Apply the updated order when you are ready.';
    state.flagAttempt = null;
    setTimeout(closeFlagDialog, 650);
  } catch (error) {
    if (error.status === 409) {
      elements.gallery_flag_state.textContent = 'The flag history changed. Your text is retained; reload the current issue state, then retry.';
      try { await reloadFlagsKeepingText(); } catch (reloadError) {
        if (reloadError?.name !== 'AbortError') elements.gallery_flag_state.textContent = `Flag conflict reload failed: ${friendlyError(reloadError)} Your text is still retained.`;
      }
    } else elements.gallery_flag_state.textContent = `${friendlyError(error)} You can retry the exact save without creating a duplicate.`;
  } finally { elements.gallery_flag_submit.disabled = !state.flags?.capability?.mutable; }
}

function transitionFlagId(action) {
  if (action === 'open') return null;
  return elements.gallery_flag_id.value;
}

async function mutateFlagRequest(transition) {
  const opening = transition.action === 'open';
  const body = {
    reviewer: transition.reviewer,
    expectedFlagRevision: transition.expectedFlagRevision,
    idempotencyKey: transition.idempotencyKey,
    ...(opening ? { itemId: transition.itemId, note: transition.note } : {
      action: { resolved: 'resolve', dismissed: 'dismiss', reopened: 'reopen' }[transition.action],
      note: transition.note,
      justification: transition.justification,
    }),
  };
  const suffix = opening ? '' : `/${encodeURIComponent(transition.flagId)}/transitions`;
  return loggedJson(`/api/runs/${encodeURIComponent(state.runId)}/gallery/flags${suffix}`, {
    method: 'POST', body, signal: transition.signal, activityPath: opening ? '/api/runs/:run/gallery/flags' : '/api/runs/:run/gallery/flags/:flag/transitions',
  });
}

async function reloadFlagsKeepingText() {
  const itemId = state.flagItemId;
  if (!ITEM_ID.test(itemId ?? '')) return;
  state.flagController?.abort();
  const controller = new AbortController();
  const generation = ++state.flagGeneration;
  state.flagController = controller;
  const flags = await loggedJson(`/api/runs/${encodeURIComponent(state.runId)}/gallery/flags?itemId=${encodeURIComponent(itemId)}&projectionOffset=0&eventOffset=0&limit=50`, {
    signal: controller.signal, activityPath: '/api/runs/:run/gallery/flags', rowCount: (value) => value.flags?.length,
  });
  if (controller.signal.aborted || generation !== state.flagGeneration || state.flagItemId !== itemId) return;
  state.flags = flags;
  renderFlagChoices({ preserveAction: true });
  if (state.flagController === controller) state.flagController = null;
}

function closeFlagDialog() {
  state.flagController?.abort();
  state.flagController = null;
  state.flagGeneration += 1;
  const opener = state.flagOpener;
  state.flagAttempt = null;
  state.flagItemId = null;
  state.flagOpener = null;
  state.flags = null;
  elements.gallery_flag_note.value = '';
  elements.gallery_flag_state.textContent = '';
  if (elements.gallery_flag_dialog.open) elements.gallery_flag_dialog.close();
  opener?.focus?.();
}

function activity(kind, message) {
  const bounded = `${new Date().toLocaleTimeString()} · ${kind} · ${String(message).replace(/[\r\n]+/g, ' ').slice(0, 1000)}`;
  state.activity.push(bounded);
  state.activityCharacters += bounded.length;
  while (state.activity.length > ACTIVITY_ENTRY_LIMIT || state.activityCharacters > ACTIVITY_CHARACTER_LIMIT) {
    state.activityCharacters -= state.activity.shift()?.length ?? 0;
  }
  elements.gallery_activity.replaceChildren(...state.activity.map((entry) => {
    const item = document.createElement('li'); item.textContent = entry; return item;
  }));
  elements.gallery_activity_count.textContent = `${state.activity.length} event${state.activity.length === 1 ? '' : 's'} · ${formatBytes(state.activityCharacters)}`;
}

function parseReviewUrl(url) {
  const run = url.searchParams.get('run')?.trim() ?? '';
  const query = {};
  for (const [name, [key, allowlist]] of Object.entries(FILTERS)) {
    query[key] = [...new Set(url.searchParams.getAll(name).filter((value) => validUrlValue(value, allowlist)))].slice(0, 20);
  }
  const search = url.searchParams.get('q')?.replace(/\s+/g, ' ').trim() ?? '';
  query.search = search.length <= 1_200 ? search : '';
  const group = url.searchParams.get('group'); query.group = ['feature', 'technical', 'none'].includes(group) ? group : 'feature';
  const sort = url.searchParams.get('sort'); query.sort = ['attention', 'feature', 'technical', 'audit', 'capture-time'].includes(sort) ? sort : 'attention';
  const member = url.searchParams.get('member');
  return {
    runId: RUN_ID.test(run) ? run : null,
    from: ['runs', 'report'].includes(url.searchParams.get('from')) ? url.searchParams.get('from') : 'runs',
    mode: url.searchParams.get('mode') === 'overview' ? 'overview' : 'workbench',
    itemId: ITEM_ID.test(url.searchParams.get('item') ?? '') ? url.searchParams.get('item') : null,
    memberId: MEMBER_ID.test(member ?? '') ? member : null,
    query,
    raw: url.searchParams.get('raw') === '1',
  };
}

function validUrlValue(value, allowlist) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 1_200 && !/[\u0000-\u001f\u007f]/.test(value) && (!allowlist || allowlist.has(value));
}

function showFatal(error) {
  elements.gallery_loading.hidden = true;
  elements.gallery_fatal.hidden = false;
  elements.gallery_fatal_title.textContent = error.status === 410 ? 'This run was purged' : 'This gallery could not be loaded';
  elements.gallery_fatal_message.textContent = friendlyError(error);
  elements.gallery_connection.textContent = error.status === 410 ? 'Run removed' : 'Needs attention';
  announce(`${elements.gallery_fatal_title.textContent}. ${elements.gallery_fatal_message.textContent}`);
}

function destroy() {
  state.destroyed = true;
  state.flagController?.abort();
  state.deltaController?.abort();
  state.stream?.close();
  state.logStream?.close();
  state.workbench?.destroy();
}

function announce(value) { elements.gallery_announcer.textContent = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 320); }
function loadReviewerLabel() { try { return String(localStorage.getItem(REVIEWER_KEY) ?? '').slice(0, 120); } catch { return ''; } }
function saveReviewerLabel(value) { try { localStorage.setItem(REVIEWER_KEY, value.slice(0, 120)); } catch { /* Review remains usable without storage. */ } }
function humanize(value) { return String(value ?? '').replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function shortRevision(value) { return typeof value === 'string' ? value.replace(/_[a-f0-9]{10}([a-f0-9]{6})$/, (_, tail) => `…${tail}`) : 'not published'; }
function formatBytes(value) { const bytes = Number(value) || 0; return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`; }
function friendlyError(error) { return String(error?.message ?? error ?? 'Unknown gallery error.').slice(0, 4000); }
function abortError() { return new DOMException('Aborted', 'AbortError'); }

class PortalGalleryError extends Error {
  constructor(status, code, message, detail = null) { super(message); this.name = 'PortalGalleryError'; this.status = status; this.code = code; this.detail = detail; }
}
