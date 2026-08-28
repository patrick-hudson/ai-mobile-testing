import { createRecordTable, createRecordLinks, field, formatTime, mountConsoleIndexPage } from './console-index-page.js';

if (document.getElementById('evidence-console')) mountConsoleIndexPage({
  rootId: 'evidence-console', routeId: 'evidence', title: 'Evidence',
  description: 'Bounded evidence metadata. Media is never prefetched by the global index surface.',
  filters: [
    { name: 'mode', label: 'Audit mode', type: 'select', options: modeOptions() },
    { name: 'scope', label: 'Scope key', type: 'search', placeholder: 'all', maximum: 160 },
    { name: 'q', label: 'Search', type: 'search', placeholder: 'Evidence, audit, owner…', maximum: 300 },
    { name: 'run', label: 'Run ID', type: 'search', placeholder: 'Any run', maximum: 160 },
    { name: 'kind', label: 'Kind', type: 'select', multiple: true, options: [
      { value: '', label: 'Any kind' }, { value: 'image', label: 'Image' }, { value: 'video', label: 'Video' }, { value: 'trace', label: 'Trace' },
      { value: 'json', label: 'JSON' }, { value: 'network', label: 'Network' }, { value: 'axe', label: 'Axe' }, { value: 'lighthouse', label: 'Lighthouse' },
    ] },
    { name: 'status', label: 'Status', type: 'select', multiple: true, options: [
      { value: '', label: 'Any status' }, { value: 'attention', label: 'Attention' }, { value: 'available', label: 'Available' }, { value: 'missing', label: 'Missing' },
    ] },
    { name: 'suite', label: 'Suite / area', type: 'search', placeholder: 'Any suite or area', maximum: 160 },
    { name: 'sort', label: 'Sort', type: 'select', options: [
      { value: 'attention', label: 'Attention' }, { value: 'capture-time', label: 'Capture time' }, { value: 'suite', label: 'Suite' },
    ] },
  ],
  query: (state) => ({ mode: state.mode, scope: state.scope ?? 'all', q: state.q, sort: state.sort, limit: 50, run: state.run, kind: state.kind, status: state.status, suite: state.suite }),
  selectionKey: 'item',
  renderContent: ({ document, content, result, state, select }) => content.append(createRecordTable({
    document, records: result.page.items, state, selectionKey: 'item', select,
    columns: [
      { label: 'Evidence', value: (record) => field(record, 'title', record.recordId) },
      { label: 'Kind', value: (record) => field(record, 'sourceKind', record.recordType) },
      { label: 'Run', value: (record) => record.runId },
      { label: 'Stage / shard', value: (record) => [field(record, 'stageId', null), field(record, 'shardId', null)].filter(Boolean).join(' / ') || 'Unavailable' },
      { label: 'Attempt', value: (record) => field(record, 'attemptNumber') },
      { label: 'Status', value: (record) => field(record, 'status', field(record, 'mediaQualityState')) },
      { label: 'Captured', value: (record) => formatTime(field(record, 'sourceTimestamp', record.sourceUpdatedAt)) },
    ],
  })),
  renderInspector: renderEvidenceInspector,
  emptyText: 'No indexed evidence metadata matches these filters.',
});

function renderEvidenceInspector({ document, inspector, record, close }) {
  const heading = document.createElement('h2'); heading.tabIndex = -1; heading.textContent = field(record, 'title', record.recordId);
  const preview = document.createElement('section'); preview.className = 'evidence-selected-media'; preview.setAttribute('aria-labelledby', 'selected-media-title');
  const previewHeading = document.createElement('h3'); previewHeading.id = 'selected-media-title'; previewHeading.textContent = 'Selected media';
  const mediaKind = field(record, 'sourceKind', 'other');
  const mediaDestination = selectedMediaDestination(record);
  let media = null;
  if (mediaDestination && ['image', 'screenshot'].includes(mediaKind)) {
    media = document.createElement('img');
    media.alt = field(record, 'title', 'Selected screenshot evidence');
    media.decoding = 'async';
    media.src = mediaDestination;
  } else if (mediaDestination && mediaKind === 'video') {
    media = document.createElement('video');
    media.controls = true;
    media.preload = 'metadata';
    media.src = mediaDestination;
    media.setAttribute('aria-label', field(record, 'title', 'Selected interaction video evidence'));
  }
  if (media) {
    media.className = 'evidence-selected-media-element';
    preview.append(previewHeading, media);
  } else {
    const previewCopy = document.createElement('p');
    previewCopy.textContent = ['image', 'screenshot', 'video'].includes(mediaKind)
      ? 'Selected media is unavailable or has no contained, verified artifact destination. Test context remains available below.'
      : 'This evidence kind has no inline preview. Use its contained evidence destination below.';
    preview.append(previewHeading, previewCopy);
  }
  const definition = document.createElement('dl'); definition.className = 'console-definition-list';
  for (const [label, value] of [
    ['Mode', record.mode], ['Run ID', record.runId], ['Evidence ID', field(record, 'evidenceId', record.recordId)], ['Audit ID', field(record, 'auditId')],
    ['Kind', field(record, 'sourceKind', record.recordType)], ['Stage', field(record, 'stageId')], ['Shard', field(record, 'shardId')], ['Target', field(record, 'targetId')],
    ['Attempt', field(record, 'attemptNumber')], ['Retry', field(record, 'retryNumber')], ['Media quality', field(record, 'mediaQualityState')],
    ['Source', record.sourceId], ['Source revision', record.sourceRevision], ['Captured', formatTime(field(record, 'sourceTimestamp', record.sourceUpdatedAt))],
    ['Index record complete', record.complete],
  ]) {
    const term = document.createElement('dt'); term.textContent = label;
    const detail = document.createElement('dd'); detail.textContent = String(value);
    definition.append(term, detail);
  }
  const links = createRecordLinks(document, record);
  const button = document.createElement('button'); button.type = 'button'; button.className = 'console-button console-button-secondary'; button.textContent = 'Close inspector'; button.addEventListener('click', close);
  inspector.append(heading, preview, definition, links, button); heading.focus();
  return () => {
    if (!media) return;
    if (media instanceof HTMLVideoElement) media.pause();
    media.removeAttribute('src');
    if (media instanceof HTMLVideoElement) media.load();
  };
}

function selectedMediaDestination(record) {
  if (!Array.isArray(record.fields.destinations)) return null;
  const expectedPrefix = record.mode === 'comparative'
    ? `/artifacts/${encodeURIComponent(record.runId)}/`
    : `/single-site-artifacts/${encodeURIComponent(record.runId)}/`;
  for (const candidate of record.fields.destinations) {
    if (typeof candidate !== 'string' || !candidate.startsWith(expectedPrefix) || candidate.includes('\\')) continue;
    try {
      const url = new URL(candidate, document.baseURI);
      if (url.origin === location.origin && url.pathname.startsWith(expectedPrefix) && !url.search && !url.hash) return `${url.pathname}`;
    } catch { /* Invalid projected destinations remain unavailable. */ }
  }
  return null;
}

function modeOptions() { return [{ value: 'all', label: 'All modes' }, { value: 'comparative', label: 'Comparative' }, { value: 'single-site', label: 'Single-site' }]; }
