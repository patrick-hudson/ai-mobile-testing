import { createRecordTable, field, formatTime, mountConsoleIndexPage, renderRecordInspector } from './console-index-page.js';

if (document.getElementById('findings-console')) mountConsoleIndexPage({
  rootId: 'findings-console', routeId: 'findings', title: 'Findings',
  description: 'Product-risk attention ordered by sourced severity, blocking state, novelty, scope, and time.',
  filters: [
    { name: 'mode', label: 'Audit mode', type: 'select', options: modeOptions() },
    { name: 'scope', label: 'Scope key', type: 'search', placeholder: 'all', maximum: 160 },
    { name: 'q', label: 'Search', type: 'search', placeholder: 'Finding, audit, detail…', maximum: 300 },
    { name: 'kind', label: 'Kind', type: 'select', multiple: true, options: [
      { value: '', label: 'Any kind' }, { value: 'finding', label: 'Finding' }, { value: 'visual-review', label: 'Visual review' },
      { value: 'manual', label: 'Manual obligation' }, { value: 'infrastructure', label: 'Infrastructure' }, { value: 'flaky', label: 'Flaky' },
      { value: 'failed-audit', label: 'Audit failure' },
    ] },
    { name: 'severity', label: 'Severity', type: 'select', multiple: true, options: [
      { value: '', label: 'Any severity' }, { value: 'P0', label: 'P0' }, { value: 'P1', label: 'P1' }, { value: 'P2', label: 'P2' }, { value: 'P3', label: 'P3' },
    ] },
    { name: 'suite', label: 'Suite / area', type: 'search', placeholder: 'Any suite or area', maximum: 160 },
    { name: 'sort', label: 'Sort', type: 'select', options: [
      { value: 'risk', label: 'Product risk' }, { value: 'newest', label: 'Newest' }, { value: 'oldest', label: 'Oldest' },
    ] },
  ],
  query: (state) => ({
    mode: state.mode, scope: state.scope ?? 'all', q: state.q, sort: state.sort, limit: 50,
    run: state.run, kind: state.kind, severity: state.severity, suite: state.suite,
  }),
  selectionKey: 'record',
  renderContent: ({ document, content, result, state, select }) => content.append(createRecordTable({
    document, records: result.page.items, state, selectionKey: 'record', select,
    columns: [
      { label: 'Finding', value: (record) => field(record, 'title', record.recordId) },
      { label: 'Severity', value: (record) => field(record, 'severity') },
      { label: 'Blocking', value: (record) => field(record, 'blocking') },
      { label: 'Kind', value: (record) => field(record, 'attentionKind', field(record, 'sourceKind', record.recordType)) },
      { label: 'Affected scope', value: (record) => field(record, 'affectedScope') },
      { label: 'Unresolved since', value: (record) => formatTime(field(record, 'unresolvedAt', record.sourceUpdatedAt)) },
    ],
  })),
  renderInspector: ({ document, inspector, record, close }) => renderRecordInspector({
    document, inspector, record, close, title: field(record, 'title', record.recordId), facts: [
      ['Severity', field(record, 'severity')], ['Blocking', field(record, 'blocking')], ['Kind', field(record, 'attentionKind', field(record, 'sourceKind', record.recordType))],
      ['Novelty', field(record, 'novelty')], ['Affected scope', field(record, 'affectedScope')], ['Unresolved since', formatTime(field(record, 'unresolvedAt', null))],
      ['Mode', record.mode], ['Run ID', record.runId], ['Source', record.sourceId], ['Source record', field(record, 'sourceRecordId', record.recordId)],
      ['Source timestamp', formatTime(field(record, 'sourceTimestamp', record.sourceUpdatedAt))], ['Index record complete', record.complete],
    ],
  }),
  emptyText: 'No indexed attention records match these filters. This is not a pass verdict.',
});

function modeOptions() { return [{ value: 'all', label: 'All modes' }, { value: 'comparative', label: 'Comparative' }, { value: 'single-site', label: 'Single-site' }]; }
