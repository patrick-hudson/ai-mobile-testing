import { createRecordTable, field, formatDuration, formatTime, mountConsoleIndexPage, renderRecordInspector } from './console-index-page.js';
import { runListRefreshInterval } from './console-index-refresh.js';

if (document.getElementById('runs-console')) mountConsoleIndexPage({
  rootId: 'runs-console', routeId: 'runs', title: 'Runs',
  description: 'A bounded, mode-neutral list of indexed audit lifecycle records.',
  filters: [
    { name: 'mode', label: 'Audit mode', type: 'select', options: modeOptions() },
    { name: 'scope', label: 'Scope key', type: 'search', placeholder: 'all', maximum: 160 },
    { name: 'q', label: 'Search', type: 'search', placeholder: 'Run, origin, profile…', maximum: 300 },
    { name: 'state', label: 'State', type: 'select', multiple: true, options: [
      { value: '', label: 'Any state' }, { value: 'queued', label: 'Queued' }, { value: 'running', label: 'Running' },
      { value: 'finalizing', label: 'Finalizing' }, { value: 'completed', label: 'Completed' }, { value: 'failed', label: 'Failed' },
    ] },
    { name: 'sort', label: 'Sort', type: 'select', options: [
      { value: 'recent', label: 'Most recent' }, { value: 'duration', label: 'Longest duration' }, { value: 'risk', label: 'Product risk' },
    ] },
  ],
  query: (state) => ({ mode: state.mode, scope: state.scope ?? 'all', q: state.q, state: state.state, sort: state.sort, limit: 50 }),
  refreshIntervalFor: runListRefreshInterval,
  selectionKey: 'run', selectedId: (record) => record.runId,
  renderContent: ({ document, content, result, state, select }) => content.append(createRecordTable({
    document, records: result.page.items, state, selectionKey: 'run', selectedId: (record) => record.runId, select,
    columns: [
      { label: 'Run', value: (record) => field(record, 'title', record.runId) },
      { label: 'Mode', value: (record) => record.mode },
      { label: 'Execution', value: (record) => field(record, 'executionState') },
      { label: 'Phase', value: (record) => field(record, 'phase') },
      { label: 'Outcome', value: (record) => field(record, 'outcome') },
      { label: 'Updated', value: (record) => formatTime(field(record, 'updatedAt', record.sourceUpdatedAt)) },
    ],
  })),
  renderInspector: ({ document, inspector, record, close }) => renderRecordInspector({
    document, inspector, record, close, title: field(record, 'title', record.runId), facts: [
      ['Mode', record.mode], ['Run ID', record.runId], ['Execution', field(record, 'executionState')], ['Activity', field(record, 'activityState')],
      ['Phase', field(record, 'phase')], ['Outcome', field(record, 'outcome')], ['Duration', formatDuration(field(record, 'durationMs', null))],
      ['Coverage', field(record, 'coverageStatus')], ['Evidence authority', field(record, 'evidenceAuthorityStatus')],
      ['Pipeline integrity', field(record, 'pipelineIntegrityStatus')], ['Finalization', field(record, 'finalizationStatus')],
      ['Source', record.sourceId], ['Source revision', record.sourceRevision], ['Index record complete', record.complete],
    ],
  }),
  emptyText: 'No indexed runs match these filters.',
});

function modeOptions() { return [{ value: 'all', label: 'All modes' }, { value: 'comparative', label: 'Comparative' }, { value: 'single-site', label: 'Single-site' }]; }
