import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GALLERY_KEYS,
  GALLERY_LIMITS,
  createGalleryWorkbench,
  createInitialGalleryState,
  decodeGalleryItemDetail,
  decodeGalleryQueryRow,
  galleryReducer,
  selectAsyncState,
  selectLocalFilmstrip,
  selectNavigationTarget,
  selectSelectedMember,
  shouldSuppressGalleryShortcut,
} from '../portal/public/gallery-core.js';

function row(number, overrides = {}) {
  const id = number.toString(16).padStart(16, '0');
  const groupNumber = overrides.groupNumber ?? number;
  return {
    id: `gitem_${id}`,
    testGroupId: `gtest_${groupNumber.toString(16).padStart(16, '0')}`,
    kind: 'image',
    title: `Visual test ${number}`,
    testLabel: `Visual test ${number} · candidate-mobile · attempt 1`,
    testTitlePath: ['fixture', `Visual test ${number}`],
    projectName: 'candidate-mobile',
    status: 'passed',
    environment: 'candidate',
    featureSuites: ['content'],
    primaryFeatureSuite: 'content',
    primaryAuditCatalogOrdinal: 3,
    technicalSuite: 'fixture',
    targets: ['Chromium', 'mobile'],
    flagState: 'unflagged',
    attempt: { ordinal: 1, retry: 0 },
    captureTime: '2026-08-24T12:00:00.000Z',
    available: true,
    visualWarning: false,
    auditAssociations: [{ id: 'VISUAL-001', title: 'Visual intent', catalogOrdinal: 3 }],
    ...overrides,
  };
}

function detail(sourceRow, overrides = {}) {
  const members = overrides.members ?? [{
    id: `gmember_${sourceRow.id.slice(-16)}`,
    name: 'actual.png',
    role: 'actual',
    contentType: sourceRow.kind === 'video' ? 'video/webm' : 'image/png',
    available: true,
    error: null,
  }];
  return {
    schemaVersion: 1,
    item: {
      id: sourceRow.id,
      kind: sourceRow.kind,
      test: {
        id: `test-${sourceRow.id}`,
        title: sourceRow.title,
        titlePath: sourceRow.testTitlePath,
        file: 'fixture.spec.ts',
        technicalSuite: sourceRow.technicalSuite,
      },
      attempt: {
        ordinal: 1,
        retry: 0,
        status: sourceRow.status,
        expectedStatus: 'passed',
        startedAt: '2026-08-24T12:00:00.000Z',
        durationMs: 50,
      },
      project: {
        name: sourceRow.projectName,
        environment: sourceRow.environment,
        browser: 'Chromium',
        deviceClass: 'mobile',
      },
      auditAssociations: [{
        id: 'VISUAL-001',
        title: 'Visual intent',
        expected: 'The redesign is clear and usable.',
        featureSuite: 'content',
        catalogOrdinal: 3,
      }],
      members,
      comparison: members.length > 1 ? { key: 'comparison', complete: true } : null,
      capture: {
        route: '/path?lang',
        observedState: 'The selected state is visible.',
        rationale: 'Verify the selected visual state.',
        capturedAt: '2026-08-24T12:00:00.000Z',
        viewport: { width: 390, height: 844 },
      },
    },
    media: members.map((member) => ({
      memberId: member.id,
      href: overrides.href ?? `evidence/${member.name}`,
      contentType: member.contentType,
      available: member.available,
    })),
    availability: overrides.availability ?? { state: 'available', retryable: true, message: null },
    review: { flagRevision: 'flags_0000000000000000', flags: overrides.flags ?? [] },
  };
}

function begin(state, slot, generation, semanticKey) {
  return galleryReducer(state, { type: 'REQUEST_STARTED', slot, generation, semanticKey });
}

function acceptRows(state, rows, options = {}) {
  const generation = options.generation ?? 1;
  const semanticKey = options.semanticKey ?? `query-${generation}`;
  const started = begin(state, 'query', generation, semanticKey);
  return galleryReducer(started, {
    type: 'QUERY_SUCCEEDED',
    slot: 'query',
    generation,
    semanticKey,
    rows,
    total: options.total ?? rows.length,
    contentRevision: options.contentRevision ?? 'content_a',
    orderRevision: options.orderRevision ?? 'order_a',
    flagRevision: options.flagRevision ?? 'flags_a',
    phase: options.phase ?? 'sealed',
    restoreAnchor: options.restoreAnchor,
    acceptPending: options.acceptPending,
  });
}

function acceptDetail(state, value, generation = 1) {
  const semanticKey = `detail-${generation}`;
  const started = begin(state, 'detail', generation, semanticKey);
  return galleryReducer(started, {
    type: 'DETAIL_SUCCEEDED',
    slot: 'detail',
    generation,
    semanticKey,
    itemId: state.selection.itemId,
    contentRevision: state.accepted.contentRevision,
    detail: value,
  });
}

class FakeElement {
  constructor(ownerDocument, tagName) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this._textContent = '';
    this.hidden = false;
    this.isContentEditable = false;
    this.paused = true;
    this.currentTime = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
  }

  set textContent(value) {
    this._textContent = String(value ?? '');
    this.children = [];
  }

  get textContent() {
    return `${this._textContent}${this.children.map((child) => child.textContent).join('')}`;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node == null) continue;
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._textContent = '';
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((candidate) => candidate !== listener));
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }

  contains(target) {
    return target === this || this.children.some((child) => child.contains?.(target));
  }

  closest(selector) {
    if (selector.includes('dialog') && (this.tagName === 'DIALOG' || this.getAttribute('role') === 'dialog')) return this;
    return this.parentElement?.closest?.(selector) ?? null;
  }

  matchesData(selector) {
    if (selector === '[data-gallery-help]') return this.dataset.galleryHelp !== undefined;
    const focus = selector.match(/^\[data-focus-key="([^"]+)"\]$/)?.[1];
    return focus ? this.dataset.focusKey === focus : false;
  }

  querySelector(selector) {
    if (this.matchesData(selector)) return this;
    for (const child of this.children) {
      const found = child.querySelector?.(selector);
      if (found) return found;
    }
    return null;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  focus() { this.ownerDocument.activeElement = this; }
  pause() { this.pauseCalls += 1; this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() { this.loadCalls += 1; }
}

class FakeDocument {
  constructor() {
    this.defaultView = { innerWidth: 1_280 };
    this.activeElement = null;
  }

  createElement(tag) { return new FakeElement(this, tag); }
}

function walk(node) {
  return [node, ...node.children.flatMap(walk)];
}

function immediate(task) { task(); }

// Decoded rows preserve untrusted text as text, strip unknown fields, and rely
// on stable test-group identity rather than duplicate titles.
const malicious = row(1, {
  title: '</b><img src=x onerror=alert(1)>\u202E',
  testLabel: '<script>throw new Error()</script>',
  extraExecutableField: 'must be stripped',
});
const decodedMalicious = decodeGalleryQueryRow(malicious);
assert.equal(decodedMalicious.title, malicious.title);
assert.equal('extraExecutableField' in decodedMalicious, false);
assert.throws(() => decodeGalleryQueryRow({ ...malicious, available: 'yes' }), /availability/i);
assert.throws(() => decodeGalleryQueryRow({ ...malicious, testGroupId: malicious.title }), /test-group/i);

const unsafeDetail = decodeGalleryItemDetail(detail(malicious, { href: 'javascript:alert(1)' }));
assert.equal(unsafeDetail.media[0].adapterReference.href, 'javascript:alert(1)');
assert.equal('href' in unsafeDetail.media[0], false);
const posterInput = detail(row(8, { kind: 'video' }));
posterInput.item.members[0].poster = { href: 'evidence/video-poster.jpg' };
posterInput.media[0].poster = { href: 'evidence/video-poster.jpg' };
const decodedPoster = decodeGalleryItemDetail(posterInput);
assert.equal(decodedPoster.media[0].adapterPosterReference.href, 'evidence/video-poster.jpg');

const duplicateRows = [
  row(1, { title: 'Duplicate title', testLabel: 'Duplicate title · first test', groupNumber: 10 }),
  row(2, { title: 'Duplicate title', testLabel: 'Duplicate title · first test', groupNumber: 10 }),
  row(3, { title: 'Duplicate title', testLabel: 'Duplicate title · second test', groupNumber: 11 }),
  row(4, { title: 'Duplicate title', testLabel: 'Duplicate title · second test', groupNumber: 11 }),
];
let state = acceptRows(createInitialGalleryState(), duplicateRows);
state = galleryReducer(state, { type: 'SELECT_ITEM', itemId: duplicateRows[1].id });
assert.equal(selectNavigationTarget(state, 1, true), duplicateRows[3].id, 'Down preserves the closest local media ordinal.');
assert.equal(selectNavigationTarget(state, -1, true), null, 'Test-group navigation does not wrap.');
assert.equal(selectNavigationTarget(state, 1, false), duplicateRows[2].id);

// A new live revision is announced without changing the frozen sequence or selection.
const frozenItems = state.accepted.items;
state = galleryReducer(state, {
  type: 'REVISION_AVAILABLE',
  contentRevision: 'content_b',
  orderRevision: 'order_b',
  flagRevision: 'flags_b',
  attentionCount: 2,
});
assert.equal(state.accepted.contentRevision, 'content_a');
assert.equal(state.accepted.items, frozenItems);
assert.equal(state.selection.itemId, duplicateRows[1].id);
state = galleryReducer(state, { type: 'APPLY_PENDING_REVISION' });
assert.equal(state.accepted.contentRevision, 'content_a', 'Old rows remain pinned until the replacement query succeeds.');
assert.equal(state.pendingRevision.applying, true);
assert.equal(state.selection.itemId, duplicateRows[1].id);
state = acceptRows(state, duplicateRows, {
  generation: 2, contentRevision: 'content_b', orderRevision: 'order_b', flagRevision: 'flags_b', acceptPending: true,
});
assert.equal(state.accepted.contentRevision, 'content_b');
assert.equal(state.pendingRevision, null);

state = galleryReducer(state, {
  type: 'REVISION_AVAILABLE', contentRevision: 'content_b', orderRevision: 'order_c', flagRevision: 'flags_b', attentionCount: 1,
});
assert.equal(state.pendingRevision.orderRevision, 'order_c', 'Order-only revisions remain explicit and frozen.');
state = { ...state, pendingRevision: null };

// Filtering retains a hidden anchor, selects the nearest visible item, then
// restores the exact stable item when filters clear.
state = acceptRows(state, [duplicateRows[0], duplicateRows[2]], { generation: 3, contentRevision: 'content_b' });
assert.equal(state.selection.outOfFilterAnchor, duplicateRows[1].id);
assert([duplicateRows[0].id, duplicateRows[2].id].includes(state.selection.itemId));
state = acceptRows(state, duplicateRows, { generation: 4, contentRevision: 'content_b' });
assert.equal(state.selection.itemId, duplicateRows[1].id);
assert.equal(state.selection.outOfFilterAnchor, null);

// Comparison defaults to actual, keeps playback and selection across modes,
// and member changes clear the old resolved media intent.
const comparisonMembers = [
  { id: 'member-baseline', name: 'baseline.png', role: 'baseline', contentType: 'image/png', available: true, error: null },
  { id: 'member-actual', name: 'actual.png', role: 'actual', contentType: 'image/png', available: true, error: null },
  { id: 'member-diff', name: 'diff.png', role: 'diff', contentType: 'image/png', available: true, error: null },
];
state = acceptDetail(state, detail(duplicateRows[1], { members: comparisonMembers }));
assert.equal(selectSelectedMember(state).id, 'member-actual');
state = galleryReducer(state, { type: 'SET_PLAYBACK', memberId: 'member-actual', time: 12.5, paused: true });
state = galleryReducer(state, { type: 'SET_MODE', mode: 'overview' });
state = galleryReducer(state, { type: 'SET_MODE', mode: 'workbench' });
assert.equal(state.selection.itemId, duplicateRows[1].id);
assert.equal(state.selection.memberId, 'member-actual');
assert.equal(state.playback['member-actual'].time, 12.5);
state = galleryReducer(state, { type: 'SET_MEMBER', delta: 1 });
assert.equal(state.selection.memberId, 'member-diff');
assert.equal(state.media.source, null);

// Fifty queued stale completions can only commit the latest generation.
let rapid = createInitialGalleryState();
for (let generation = 1; generation <= 50; generation += 1) rapid = begin(rapid, 'query', generation, `rapid-${generation}`);
for (let generation = 49; generation >= 1; generation -= 1) {
  rapid = galleryReducer(rapid, {
    type: 'QUERY_SUCCEEDED', slot: 'query', generation, semanticKey: `rapid-${generation}`,
    rows: [row(generation)], total: 1, contentRevision: `content_${generation}`, orderRevision: `order_${generation}`,
  });
}
assert.equal(rapid.accepted.items.length, 0);
rapid = galleryReducer(rapid, {
  type: 'QUERY_SUCCEEDED', slot: 'query', generation: 50, semanticKey: 'rapid-50',
  rows: [row(50)], total: 1, contentRevision: 'content_50', orderRevision: 'order_50',
});
assert.equal(rapid.accepted.items[0].id, row(50).id);
rapid = begin(rapid, 'thumbnail', 51, 'thumbnail-non-selected');
rapid = galleryReducer(rapid, {
  type: 'THUMBNAIL_SUCCEEDED', slot: 'thumbnail', generation: 51, semanticKey: 'thumbnail-non-selected',
  itemId: row(999).id, contentRevision: rapid.accepted.contentRevision,
  source: { validatedByAdapter: true, url: 'evidence/non-selected.png' },
});
assert.equal(rapid.thumbnails[row(999).id], 'evidence/non-selected.png');

// Every Escape press unwinds exactly one layer in the documented order.
let layered = { ...state, mode: 'overview', layers: {
  fullscreen: true, help: true, context: true, responsivePanel: 'queue', focusHistory: ['a', 'b', 'c'],
} };
layered = galleryReducer(layered, { type: 'ESCAPE_LAYER' });
assert.equal(layered.layers.fullscreen, false);
assert.equal(layered.layers.help, true);
layered = galleryReducer(layered, { type: 'ESCAPE_LAYER' });
assert.equal(layered.layers.help, false);
assert.equal(layered.layers.responsivePanel, 'queue');
layered = galleryReducer(layered, { type: 'ESCAPE_LAYER' });
assert.equal(layered.layers.responsivePanel, null);
assert.equal(layered.layers.context, true);
layered = galleryReducer(layered, { type: 'ESCAPE_LAYER' });
assert.equal(layered.layers.context, false);
layered = galleryReducer(layered, { type: 'ESCAPE_LAYER' });
assert.equal(layered.mode, 'workbench');

assert.deepEqual(GALLERY_KEYS, {
  previousItem: 'ArrowLeft', nextItem: 'ArrowRight', previousTest: 'ArrowUp', nextTest: 'ArrowDown',
  previousMember: '[', nextMember: ']', playPause: ' ', context: 'i', fullscreen: 'f', escape: 'Escape', help: '?',
});
const plainTarget = new FakeElement(new FakeDocument(), 'div');
const suppressedTargets = ['input', 'textarea', 'select', 'video', 'audio'].map((tag) => new FakeElement(new FakeDocument(), tag));
for (const target of suppressedTargets) assert.equal(shouldSuppressGalleryShortcut({ key: 'ArrowRight', target }), true);
assert.equal(shouldSuppressGalleryShortcut({ key: 'ArrowRight', target: plainTarget, isComposing: true }), true);
assert.equal(shouldSuppressGalleryShortcut({ key: 'ArrowRight', target: plainTarget, ctrlKey: true }), true);
assert.equal(shouldSuppressGalleryShortcut({ key: 'ArrowRight', target: plainTarget }), false);
plainTarget.setAttribute('role', 'textbox');
assert.equal(shouldSuppressGalleryShortcut({ key: 'ArrowRight', target: plainTarget }), true);

// Async meanings are distinct and keep a single documented recovery.
assert.equal(selectAsyncState(createInitialGalleryState()).key, 'loading');
assert.equal(selectAsyncState({ ...createInitialGalleryState(), phase: 'live', requests: {
  ...createInitialGalleryState().requests, query: { generation: 1, semanticKey: 'q', status: 'success', error: null },
} }).key, 'active-run-waiting');
assert.equal(selectAsyncState({ ...createInitialGalleryState(), phase: 'sealed', descriptor: { primaryCounts: { total: 0 } } }).key, 'sealed-empty');
assert.equal(selectAsyncState({ ...state, availability: { state: 'tombstone', retryable: true, message: 'Gone' } }).key, 'selected-blob-unavailable');
assert.equal(selectAsyncState({ ...state, purged: true }).key, 'purged-run');

// Controller cancellation is adapter-owned and reducer generations are the
// second line of defense. Every superseded filter call receives an abort.
const controllerDocument = new FakeDocument();
const controllerRoot = controllerDocument.createElement('div');
const pendingLoads = [];
const controllerWorkbench = createGalleryWorkbench(controllerRoot, {
  scheduler: immediate,
  adapter: {
    loadItems({ signal }) {
      return new Promise((resolve) => pendingLoads.push({ signal, resolve }));
    },
  },
});
const calls = [];
for (let index = 0; index < 50; index += 1) calls.push(controllerWorkbench.setQuery({ search: `query ${index}` }));
assert.equal(pendingLoads.filter(({ signal }) => signal.aborted).length, 49);
for (let index = 0; index < pendingLoads.length; index += 1) pendingLoads[index].resolve({
  items: [row(index + 100)], total: 1, contentRevision: 'content_controller', orderRevision: 'order_controller', phase: 'sealed',
});
await Promise.all(calls);
assert.equal(controllerWorkbench.getState().accepted.items[0].id, row(149).id);
controllerWorkbench.destroy();

// Renderer bounds: a 1,000-row sequence still retains no more than 500 nodes,
// a nine-item filmstrip, and never creates adjacent video elements.
const renderDocument = new FakeDocument();
const renderRoot = renderDocument.createElement('div');
const observedOverviewImages = [];
const videoRow = row(1_500, { kind: 'video', title: malicious.title, testLabel: malicious.testLabel });
const largeRows = [videoRow, ...Array.from({ length: 999 }, (_, index) => row(index + 2_000))];
const renderWorkbench = createGalleryWorkbench(renderRoot, {
  scheduler: immediate,
  observerFactory() {
    return {
      observe(target) { observedOverviewImages.push(target); },
      unobserve() {},
      disconnect() {},
    };
  },
  adapter: {
    async loadItem({ itemId }) { return detail(largeRows.find(({ id }) => id === itemId)); },
    async resolveMedia() { return { validatedByAdapter: true, url: '/artifacts/run/video.webm' }; },
  },
});
renderWorkbench.dispatch({ type: 'REQUEST_STARTED', slot: 'query', generation: 1, semanticKey: 'large' });
renderWorkbench.dispatch({
  type: 'QUERY_SUCCEEDED', slot: 'query', generation: 1, semanticKey: 'large', rows: largeRows,
  total: largeRows.length, contentRevision: 'content_large', orderRevision: 'order_large', phase: 'sealed',
});
await renderWorkbench.loadSelected();
const nodes = walk(renderRoot);
assert(nodes.length <= GALLERY_LIMITS.galleryDomNodes, `Expected <= ${GALLERY_LIMITS.galleryDomNodes} nodes, got ${nodes.length}.`);
assert(walk(renderRoot).filter(({ tagName }) => tagName === 'VIDEO').length <= 1);
assert(selectLocalFilmstrip(renderWorkbench.getState()).length <= 9);
assert(renderRoot.textContent.includes(malicious.title));
assert.equal(renderRoot.querySelector('[data-gallery-help]'), null);
const selectedVideo = walk(renderRoot).find(({ tagName }) => tagName === 'VIDEO');
assert(selectedVideo);
assert.equal(selectedVideo.preload, 'metadata');
assert.equal(selectedVideo.autoplay, undefined);
selectedVideo.dispatchEvent({ type: 'error', target: selectedVideo, preventDefault() {}, stopPropagation() {} });
assert.equal(renderWorkbench.getState().media.status, 'error');
assert.equal(renderWorkbench.getState().availability.state, 'tombstone');
await renderWorkbench.loadSelected();
await renderWorkbench.selectItem(largeRows[1].id);
assert(selectedVideo.pauseCalls >= 1);
assert(selectedVideo.loadCalls >= 1);
assert.equal(selectedVideo.src, '');
renderWorkbench.dispatch({ type: 'OPEN_LAYER', layer: 'help', focusKey: 'gallery-root' });
const help = renderRoot.querySelector('[data-gallery-help]');
assert(help);
help.dispatchEvent({ type: 'keydown', key: 'Escape', target: help, preventDefault() {}, stopPropagation() {} });
assert.equal(renderWorkbench.getState().layers.help, false);
const facets = Array.from({ length: GALLERY_LIMITS.facetOptions }, (_, index) => `facet-${index}`);
renderWorkbench.dispatch({ type: 'REQUEST_STARTED', slot: 'head', generation: 1, semanticKey: 'head' });
renderWorkbench.dispatch({
  type: 'HEAD_SUCCEEDED', slot: 'head', generation: 1, semanticKey: 'head',
  head: {
    phase: 'sealed', contentRevision: 'content_large', orderRevision: 'order_large',
    primaryCounts: { total: 1_000, images: 999, videos: 1 },
    facets: {
      kinds: ['image', 'video'], statuses: facets, environments: facets, featureSuites: facets,
      technicalSuites: facets, targets: facets, flagStates: ['open', 'resolved', 'dismissed', 'unflagged'],
    },
  },
});
renderWorkbench.dispatch({ type: 'SET_MODE', mode: 'overview' });
assert(walk(renderRoot).length <= GALLERY_LIMITS.galleryDomNodes);
assert(observedOverviewImages.length > 0, 'Overview photos are observed before a source is resolved.');
assert(walk(renderRoot).filter(({ tagName }) => tagName === 'VIDEO').length === 0, 'Overview never preloads videos.');
renderWorkbench.destroy();

// Unsafe resolved URLs cannot reach a URL-bearing DOM property, even when a
// faulty adapter claims they were validated.
let mediaState = acceptRows(createInitialGalleryState(), [row(9_000, { kind: 'image' })]);
mediaState = acceptDetail(mediaState, detail(row(9_000, { kind: 'image' })));
const memberId = mediaState.selection.memberId;
mediaState = begin(mediaState, 'media', 1, 'unsafe');
mediaState = galleryReducer(mediaState, {
  type: 'MEDIA_SUCCEEDED', slot: 'media', generation: 1, semanticKey: 'unsafe',
  itemId: mediaState.selection.itemId, memberId, contentRevision: mediaState.accepted.contentRevision,
  source: { validatedByAdapter: true, url: 'javascript:alert(1)' },
});
assert.equal(mediaState.media.status, 'error');
assert.equal(mediaState.media.source, null);
for (const unsafeUrl of ['../outside.png', 'https://example.test/image.png', '/artifacts/run/image.png?token=secret', '//example.test/x.png']) {
  let unsafeState = begin({ ...mediaState, media: { ...mediaState.media, status: 'idle' } }, 'media', 2, unsafeUrl);
  unsafeState = galleryReducer(unsafeState, {
    type: 'MEDIA_SUCCEEDED', slot: 'media', generation: 2, semanticKey: unsafeUrl,
    itemId: unsafeState.selection.itemId, memberId, contentRevision: unsafeState.accepted.contentRevision,
    source: { validatedByAdapter: true, url: unsafeUrl },
  });
  assert.equal(unsafeState.media.status, 'error', `${unsafeUrl} must not be trusted by the core.`);
}

// A successful media element must settle exactly once. Re-rendering a ready
// image would otherwise create a load/dispatch/render loop that continually
// replaces controls and steals responsive focus.
let settledMedia = acceptRows(createInitialGalleryState(), [row(9_100, { kind: 'image' })]);
settledMedia = acceptDetail(settledMedia, detail(row(9_100, { kind: 'image' })));
settledMedia = begin(settledMedia, 'media', 1, 'settled');
settledMedia = galleryReducer(settledMedia, {
  type: 'MEDIA_SUCCEEDED', slot: 'media', generation: 1, semanticKey: 'settled',
  itemId: settledMedia.selection.itemId, memberId: settledMedia.selection.memberId,
  contentRevision: settledMedia.accepted.contentRevision,
  source: { validatedByAdapter: true, url: '/artifacts/run/image.png' },
});
const firstSettled = galleryReducer(settledMedia, {
  type: 'MEDIA_ELEMENT_LOADED', itemId: settledMedia.selection.itemId, memberId: settledMedia.selection.memberId,
});
const duplicateSettled = galleryReducer(firstSettled, {
  type: 'MEDIA_ELEMENT_LOADED', itemId: firstSettled.selection.itemId, memberId: firstSettled.selection.memberId,
});
assert.equal(firstSettled.media.status, 'ready');
assert.equal(duplicateSettled, firstSettled, 'Duplicate media load completion must be a reducer no-op.');

const coreSource = await readFile(new URL('../portal/public/gallery-core.js', import.meta.url), 'utf8');
const cssSource = await readFile(new URL('../portal/public/gallery.css', import.meta.url), 'utf8');
assert.doesNotMatch(coreSource, /\.innerHTML\s*=|insertAdjacentHTML|\bfetch\s*\(|createElement\(['"]iframe['"]\)|localStorage|sessionStorage/);
assert.match(cssSource, /@media \(min-width: 768px\) and \(max-width: 1023px\)/);
assert.match(cssSource, /@media \(max-width: 767px\)/);
assert.match(cssSource, /min-height: 44px/);
assert.match(cssSource, /prefers-reduced-motion: reduce/);
assert.match(cssSource, /animation-duration: 0\.001ms/);

console.log('Gallery state self-test passed.');
