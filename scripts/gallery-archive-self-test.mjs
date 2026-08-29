import assert from 'node:assert/strict';
import {
  GALLERY_ARCHIVE_CHANNEL,
  createArchiveGalleryAdapter,
  createArchiveIframeTransport,
  validateArchiveMediaUrl,
} from '../reporters/assets/gallery-archive.js';
import { createGalleryWorkbench as archiveCreateGalleryWorkbench } from '../reporters/assets/gallery-core.js';
import { createGalleryWorkbench as portalCreateGalleryWorkbench } from '../portal/public/gallery-core.js';
await import('../reporters/assets/archive-runtime.js');

const archiveRuntime = globalThis.Quitting7ohArchiveRuntime;
assert.equal(archiveRuntime.CURRENT_RUNTIME_VERSION, 3);
assert.equal(archiveRuntime.validateBundleContract(null, null, 1).bundleVersion, 1,
  'Runtime N must retain legacy bundle N-1 support when metadata is absent.');
const currentBundle = {
  schemaVersion: 1,
  bundleVersion: 3,
  runtimeVersion: 3,
  minimumReaderVersion: 1,
  dataSchemaVersion: 1,
  assetBase: 'assets/archive-v3',
  manifestHref: 'assets/archive-v3/bundle.json',
};
assert.equal(
  archiveRuntime.validateBundleContract(currentBundle, currentBundle, 1).bundleVersion,
  3,
  'Runtime N must accept the current generated bundle.',
);
assert.throws(
  () => archiveRuntime.validateBundleContract(
    currentBundle,
    { ...currentBundle, runtimeVersion: 1 },
    1,
  ),
  /does not match/i,
  'Embedded and descriptor bundle mismatch must fail closed.',
);
assert.throws(
  () => archiveRuntime.validateBundleContract(
    { ...currentBundle, bundleVersion: 4, runtimeVersion: 4, assetBase: 'assets/archive-v4', manifestHref: 'assets/archive-v4/bundle.json' },
    { ...currentBundle, bundleVersion: 4, runtimeVersion: 4, assetBase: 'assets/archive-v4', manifestHref: 'assets/archive-v4/bundle.json' },
    1,
  ),
  /not compatible/i,
  'A future bundle must not be interpreted by an older runtime.',
);

assert.strictEqual(
  archiveCreateGalleryWorkbench,
  portalCreateGalleryWorkbench,
  'The reporter bridge must re-export the canonical portal gallery controller.',
);

function descriptor(overrides = {}) {
  return {
    schemaVersion: 1,
    phase: 'sealed',
    contentRevision: 'content_1111111111111111',
    flagRevision: 'flags_2222222222222222',
    orderRevision: 'order_3333333333333333',
    exportRevision: 'export_4444444444444444',
    exportedAt: '2026-08-24T12:00:00.000Z',
    primaryCounts: { total: 2, images: 2, videos: 0 },
    facets: {},
    query: {
      rows: 2,
      maxRowsPerChunk: 1,
      maxBytesPerChunk: 256 * 1024,
      chunks: [
        { href: 'gallery/revisions/export_4444444444444444/query/chunk-0001.html', rows: 1, bytes: 100 },
        { href: 'gallery/revisions/export_4444444444444444/query/chunk-0002.html', rows: 1, bytes: 100 },
      ],
    },
    itemDetails: {
      count: 2,
      hrefPrefix: 'gallery/revisions/export_4444444444444444/items/',
      hrefSuffix: '.html',
      maxBytes: 512 * 1024,
    },
    raw: { rows: 0, maxRowsPerChunk: 1, maxBytesPerChunk: 256 * 1024, chunks: [] },
    flags: { href: 'gallery/revisions/export_4444444444444444/flags.html', throughEvent: 0 },
    integrity: { href: 'gallery/revisions/export_4444444444444444/integrity.json', documentCount: 4 },
    ...overrides,
  };
}

class FakeWindow {
  listeners = new Set();
  crypto = { randomUUID: () => 'one-time-token' };
  addEventListener(type, listener) { if (type === 'message') this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === 'message') this.listeners.delete(listener); }
  setTimeout(callback) { this.timer = callback; return 1; }
  clearTimeout() { this.timer = null; }
  post(source, data) { for (const listener of [...this.listeners]) listener({ source, data }); }
}

class FakeDocument {
  frames = [];
  body = { append: (frame) => { this.frames.push(frame); frame.isConnected = true; } };
  createElement(name) {
    assert.equal(name, 'iframe');
    const frame = {
      contentWindow: {},
      isConnected: false,
      setAttribute() {},
      remove() { frame.isConnected = false; },
    };
    return frame;
  }
}

const windowObject = new FakeWindow();
const documentObject = new FakeDocument();
const queued = [];
const transport = createArchiveIframeTransport({
  descriptor: descriptor(),
  windowObject,
  documentObject,
  schedule: (task) => queued.push(task),
});
const request = transport.load(descriptor().query.chunks[0].href, { kind: 'query', ordinal: 1 });
const iframe = documentObject.frames.at(-1);
const token = decodeURIComponent(iframe.src.split('#')[1]);
const meta = {
  schemaVersion: 1,
  kind: 'query',
  contentRevision: descriptor().contentRevision,
  exportRevision: descriptor().exportRevision,
};
const payload = { schemaVersion: 1, contentRevision: descriptor().contentRevision, ordinal: 1, rows: [], archiveDocument: { ...meta } };
let settled = false;
request.then(() => { settled = true; });
windowObject.post({}, { channel: GALLERY_ARCHIVE_CHANNEL, token, meta, payload });
windowObject.post(iframe.contentWindow, { channel: GALLERY_ARCHIVE_CHANNEL, token: 'wrong-token', meta, payload });
await Promise.resolve();
assert.equal(settled, false, 'Wrong iframe sources and tokens must be ignored.');
windowObject.post(iframe.contentWindow, { channel: GALLERY_ARCHIVE_CHANNEL, token, meta, payload });
assert.equal(queued.length, 1);
queued.shift()();
assert.equal(await request, payload);
assert.equal(transport.activeCount, 0);
assert.equal(iframe.isConnected, false);

const malformed = transport.load(descriptor().query.chunks[0].href, { kind: 'query', ordinal: 1 });
const malformedFrame = documentObject.frames.at(-1);
const malformedToken = decodeURIComponent(malformedFrame.src.split('#')[1]);
windowObject.post(malformedFrame.contentWindow, {
  channel: GALLERY_ARCHIVE_CHANNEL,
  token: malformedToken,
  meta: { ...meta, exportRevision: 'export_ffffffffffffffff' },
  payload,
});
await assert.rejects(malformed, /schema|revision/i);
assert.equal(malformedFrame.isConnected, false, 'A matching source/token with malformed metadata must fail immediately and clean up.');

const cancelController = new AbortController();
const cancelled = transport.load(descriptor().query.chunks[0].href, { kind: 'query', ordinal: 1 }, cancelController.signal);
const cancelledFrame = documentObject.frames.at(-1);
const cancelledToken = decodeURIComponent(cancelledFrame.src.split('#')[1]);
windowObject.post(cancelledFrame.contentWindow, { channel: GALLERY_ARCHIVE_CHANNEL, token: cancelledToken, meta, payload });
assert.equal(queued.length, 1, 'The valid decoded payload should wait for the injected scheduler.');
cancelController.abort();
queued.shift()();
await assert.rejects(cancelled, { name: 'AbortError' });
assert.equal(cancelledFrame.isConnected, false, 'Cancellation must remove its iframe.');
assert.equal(transport.activeCount, 0, 'Cancellation must invalidate the request token and release the iframe.');
windowObject.post(cancelledFrame.contentWindow, { channel: GALLERY_ARCHIVE_CHANNEL, token: cancelledToken, meta, payload });
assert.equal(windowObject.listeners.size, 0, 'Late messages must not retain listeners or revive cancelled work.');

function row(id, title, status, feature, ordinal) {
  return {
    id,
    testGroupId: `gtest_${id.slice(-16)}`,
    kind: 'image',
    title,
    testLabel: `${title} · candidate-mobile · attempt 1`,
    testTitlePath: ['archive', title],
    projectName: 'candidate-mobile',
    status,
    environment: 'candidate',
    featureSuites: [feature],
    primaryFeatureSuite: feature,
    primaryAuditCatalogOrdinal: ordinal,
    technicalSuite: 'archive.spec.ts',
    targets: ['mobile'],
    flagState: 'unflagged',
    searchText: `${title} ${feature}`.toLowerCase(),
    attempt: { ordinal: 1, retry: 0 },
    captureTime: '2026-08-24T12:00:00.000Z',
    available: true,
    visualWarning: false,
    auditAssociations: [{ id: `NAV-00${ordinal + 1}`, title: feature, catalogOrdinal: ordinal }],
  };
}

const firstRow = row('gitem_0000000000000001', 'Duplicate title', 'passed', 'content', 1);
const secondRow = row('gitem_0000000000000002', 'Duplicate title', 'failed', 'navigation', 0);
const adapterLoads = [];
const adapter = createArchiveGalleryAdapter({
  descriptor: descriptor(),
  transport: {
    async load(href, expected) {
      adapterLoads.push({ href, expected });
      return {
        schemaVersion: 1,
        contentRevision: descriptor().contentRevision,
        ordinal: expected.ordinal,
        rows: expected.ordinal === 1 ? [secondRow] : [firstRow],
      };
    },
    destroy() {},
  },
});
const firstPublishedPage = await adapter.loadItems({ query: { sort: 'attention' }, limit: 1 });
assert.deepEqual(firstPublishedPage.items.map(({ id }) => id), [secondRow.id]);
assert.equal(firstPublishedPage.total, 2);
assert.equal(adapterLoads.length, 1, 'Default archive first usable reads only the intersecting published query chunk.');
const attention = await adapter.loadItems({ query: { sort: 'attention' }, limit: 100 });
assert.deepEqual(attention.items.map(({ id }) => id), [secondRow.id, firstRow.id]);
assert.equal(attention.total, 2);
assert.equal(adapterLoads.length, 2, 'Exact cross-chunk ordering may index rows but must not read details or media.');
const searched = await adapter.loadItems({ query: { search: 'content', sort: 'audit' }, limit: 100 });
assert.deepEqual(searched.items.map(({ id }) => id), [firstRow.id]);
assert.equal(adapterLoads.length, 2, 'Successful bounded query chunks should be reused.');
const anchored = await adapter.loadItems({ query: { sort: 'attention' }, limit: 1, anchorItemId: firstRow.id });
assert.equal(anchored.items[0].id, firstRow.id, 'Fresh anchor reads must return a page containing the selected item.');
const firstPage = await adapter.loadItems({ query: { sort: 'attention' }, limit: 1 });
assert(firstPage.nextCursor);
await assert.rejects(
  adapter.loadItems({ query: { sort: 'audit' }, limit: 1, cursor: firstPage.nextCursor }),
  /does not belong to this query/i,
  'Archive cursors must bind the normalized query and pinned revisions.',
);
assert.equal('mutateFlag' in adapter, false, 'Archive adapters must expose no mutation capability.');

assert.equal(validateArchiveMediaUrl('evidence/blobs/capture.webp', 'image', 'image/webp'), 'evidence/blobs/capture.webp');
for (const unsafe of [
  '/evidence/blobs/capture.webp', 'https://example.test/evidence/capture.webp', 'evidence/../capture.webp',
  'evidence/%2foutside.webp', 'evidence/capture.webp?download=1', 'evidence\\capture.webp',
]) assert.throws(() => validateArchiveMediaUrl(unsafe, 'image', 'image/webp'));

transport.destroy();
console.log('Gallery archive self-test passed: source/token/revision validation, cancellation, exact chunk queries, anchor reads, and media containment are enforced.');
