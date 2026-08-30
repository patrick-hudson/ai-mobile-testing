import { parseConsoleUrlState, serializeConsoleUrlState } from '/console-contracts.mjs';
import { createAsyncRegion } from './console-async.js';
import { createAsyncStateBlock } from './console-components.js';
import { createRunInvalidationBus } from './console-invalidation.js';
import { createConsoleIndexClient, unsupportedConsoleQuery } from './console-index-client.js';
import { createConsoleIndexRefreshController } from './console-index-refresh.js';
import { createConsoleSessionBanner } from './console-session-banner.js';
import { CONSOLE_NAVIGATION_ITEMS, createConsoleShell, createConsoleSplitter } from './console-shell.js';
import { createConsoleUrlState } from './console-url-state.js';

export function mountConsoleIndexPage({
  window = globalThis.window,
  document = globalThis.document,
  client = createConsoleIndexClient(),
  rootId,
  routeId,
  title,
  description,
  filters = [],
  query,
  renderContent,
  renderInspector,
  selectionKey = null,
  selectedId = (record) => record.recordId,
  emptyText = 'No matching records.',
  unsupportedText,
  refreshIntervalFor = null,
}) {
  const root = document.getElementById(rootId);
  if (!root) throw new Error(`Missing #${rootId}.`);
  const announcer = document.getElementById('global-announcer');
  const shell = createConsoleShell(root, {
    navigationItems: CONSOLE_NAVIGATION_ITEMS,
    activeNavigationId: routeId,
    title,
    description,
    inspectorLabel: `${title} context inspector`,
  });
  const splitter = createConsoleSplitter({ shell: root, separator: shell.separator, inspector: shell.inspector });
  const toolbar = createToolbar(document, filters, (name, value) => commitFilter(name, value));
  const asyncBlock = createAsyncStateBlock(document, { id: `${routeId}-index`, title });
  asyncBlock.section.classList.add('console-index-region');
  shell.main.append(toolbar.element, asyncBlock.section);
  let lastResult = null;
  let requestKey = null;
  let pageNumber = 1;
  let cursor = null;
  let inspectorCleanup = null;
  let refreshController = null;
  const sessionBanner = createConsoleSessionBanner({
    document,
    shell,
    autoRestore: false,
    onAuthorized: () => {
      refreshController?.resume();
      return requestPage(null, 1);
    },
  });

  const region = createAsyncRegion({
    root: asyncBlock.section,
    load: async ({ key, signal }) => {
      if (key.blocked === true) return Object.freeze({ blocked: true });
      const page = await client[routeId](key.query, { cursor: key.cursor, signal });
      return Object.freeze({ page, pageNumber: key.pageNumber, queryKey: key.queryKey });
    },
    describeFreshness: (result, loadedAt) => describeIndexFreshness(result?.page, loadedAt),
    onError: (error, context) => {
      if (error?.status === 401 || error?.status === 403) {
        refreshController?.pause();
        sessionBanner.requireAuthentication(error);
      }
      if (error?.code === 'CONSOLE_CURSOR_STALE' && context.key?.cursor) {
        cursor = null;
        pageNumber = 1;
        queueMicrotask(() => requestPage(null, 1));
      }
    },
    render: (result, content) => {
      if (result.blocked === true) {
        content.replaceChildren();
        return;
      }
      lastResult = result;
      content.replaceChildren();
      renderCompleteness(document, content, result.page);
      if (result.page.items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'console-index-empty';
        empty.textContent = result.page.complete && !result.page.hasMore
          ? emptyText
          : 'No records are present in this bounded, incomplete page.';
        content.append(empty);
      } else {
        renderContent({ document, content, result, state: urlState.current.state, select: selectRecord });
      }
      appendContinuation(content, result);
      renderCurrentInspector();
    },
    isEmpty: (result) => result.blocked === true || result.page.items.length === 0,
  });

  if (refreshIntervalFor !== null) {
    if (typeof refreshIntervalFor !== 'function') throw new TypeError('Console index refresh cadence must be a function.');
    refreshController = createConsoleIndexRefreshController({
      document,
      refresh: () => requestPage(null, 1),
      intervalFor: (result) => refreshIntervalFor(result.page),
      setTimer: window.setTimeout.bind(window),
      clearTimer: window.clearTimeout.bind(window),
    });
  }

  const urlState = createConsoleUrlState({
    window,
    routeId,
    parse: parseConsoleUrlState,
    serialize: serializeConsoleUrlState,
    onChange: (parsed) => {
      toolbar.sync(parsed.state);
      const unsupported = unsupportedConsoleQuery(routeId, parsed.state);
      const nextQuery = query(parsed.state);
      const nextKey = JSON.stringify(nextQuery);
      if (unsupported.length > 0) {
        requestKey = null;
        lastResult = null;
        cursor = null;
        pageNumber = 1;
        asyncBlock.content.replaceChildren();
        const message = unsupportedText?.(unsupported, parsed.state)
          ?? `This bounded endpoint cannot apply: ${unsupported.join(', ')}.`;
        void region.request(Object.freeze({ blocked: true }), { refresh: false }).then((result) => {
          if (result?.blocked === true && unsupportedConsoleQuery(routeId, urlState.current.state).length > 0) {
            region.setState('unavailable', message);
            asyncBlock.retry.hidden = true;
          }
        });
        renderCurrentInspector();
        return;
      }
      if (nextKey !== requestKey) {
        requestKey = nextKey;
        cursor = null;
        pageNumber = 1;
        void requestPage(null, 1);
      } else {
        rerenderRetainedPage();
        renderCurrentInspector();
      }
    },
    onRestoreFocus: () => shell.heading.focus(),
  });
  const invalidation = createRunInvalidationBus({
    window,
    onInvalidate(detail) {
      const state = urlState.current.state;
      const affectedItems = lastResult?.page.items.filter((record) => record.mode === detail.mode && record.runId === detail.runId) ?? [];
      const selected = selectionKey && state[selectionKey]
        ? lastResult?.page.items.find((record) => selectedId(record) === state[selectionKey]) ?? null
        : null;
      const routeTargetsRun = (state.mode === detail.mode || state.mode === 'all') && state.run === detail.runId;
      if (affectedItems.length === 0 && !routeTargetsRun && !(selected?.mode === detail.mode && selected?.runId === detail.runId)) return;
      inspectorCleanup?.();
      inspectorCleanup = null;
      if (lastResult) {
        const retained = lastResult.page.items.filter((record) => record.mode !== detail.mode || record.runId !== detail.runId);
        lastResult = Object.freeze({ ...lastResult, page: Object.freeze({ ...lastResult.page, items: Object.freeze(retained) }) });
      }
      const nextState = { ...state, inspector: 'closed' };
      if (selectionKey) delete nextState[selectionKey];
      urlState.replaceState(nextState, { focusKey: `${routeId}-filters` });
      cursor = null;
      pageNumber = 1;
      announcer.textContent = `Purged ${detail.mode} run ${detail.runId}; cached records and selected media were removed.`;
      void requestPage(null, 1);
    },
  });

  function commitFilter(name, value) {
    const current = { ...urlState.current.state };
    if (value === '' || (Array.isArray(value) && value.length === 0)) delete current[name];
    else current[name] = value;
    try { urlState.setState(current, { focusKey: `${routeId}-filters` }); }
    catch {
      announcer.textContent = 'That filter value is invalid and was not applied.';
      toolbar.sync(urlState.current.state);
    }
  }

  function requestPage(nextCursor, nextPageNumber) {
    refreshController?.begin();
    cursor = nextCursor;
    pageNumber = nextPageNumber;
    const key = Object.freeze({ query: query(urlState.current.state), queryKey: requestKey, cursor, pageNumber });
    return region.request(key, { refresh: lastResult !== null }).then((result) => {
      if (result && (!result.page.complete || result.page.limitations.length > 0)) {
        region.setState('partial', limitationSummary(result.page));
      }
      refreshController?.accept(result);
      return result;
    });
  }

  function rerenderRetainedPage() {
    if (!lastResult) return;
    asyncBlock.content.replaceChildren();
    renderCompleteness(document, asyncBlock.content, lastResult.page);
    if (lastResult.page.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'console-index-empty';
      empty.textContent = emptyText;
      asyncBlock.content.append(empty);
    } else renderContent({ document, content: asyncBlock.content, result: lastResult, state: urlState.current.state, select: selectRecord });
    appendContinuation(asyncBlock.content, lastResult);
  }

  function appendContinuation(content, result) {
    if (!result.page.hasMore) return;
    const continuation = document.createElement('div');
    continuation.className = 'console-index-continuation';
    const label = document.createElement('span');
    label.textContent = `Bounded page ${result.pageNumber}; ${result.page.items.length} records shown.`;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'console-button console-button-secondary';
    next.textContent = 'Load next page';
    next.addEventListener('click', () => requestPage(result.page.nextCursor, result.pageNumber + 1));
    continuation.append(label, next);
    content.append(continuation);
  }

  function selectRecord(record, invoker) {
    if (!selectionKey) return;
    const id = selectedId(record);
    urlState.setState({ ...urlState.current.state, [selectionKey]: id, inspector: 'open' }, { focusKey: `${routeId}-selection` });
    invoker?.setAttribute('aria-expanded', 'true');
    shell.inspector.querySelector('h2')?.focus();
  }

  function renderCurrentInspector() {
    inspectorCleanup?.();
    inspectorCleanup = null;
    shell.inspector.replaceChildren();
    const state = urlState.current.state;
    if (!selectionKey || state.inspector !== 'open' || !state[selectionKey]) {
      renderInspectorPlaceholder(document, shell.inspector, selectionKey ? `Select a ${routeId === 'runs' ? 'run' : 'record'} to inspect its sourced facts.` : 'Choose a record for more context.');
      return;
    }
    const selected = lastResult?.page.items.find((record) => selectedId(record) === state[selectionKey]) ?? null;
    if (!selected) {
      const heading = inspectorHeading(document, shell.inspector, 'Selection outside this page');
      const copy = document.createElement('p');
      copy.textContent = 'The URL selection remains intact, but it is excluded by the current bounded page or filters. Change the filters or continue paging to reveal it.';
      shell.inspector.append(copy, inspectorCloseButton(document, () => closeInspector()));
      heading.focus();
      return;
    }
    const cleanup = renderInspector({ document, inspector: shell.inspector, record: selected, state, close: closeInspector });
    if (typeof cleanup === 'function') inspectorCleanup = cleanup;
  }

  function closeInspector() {
    urlState.setState({ ...urlState.current.state, inspector: 'closed' }, { focusKey: `${routeId}-selection` });
    shell.heading.focus();
  }

  return Object.freeze({
    shell,
    region,
    urlState,
    destroy() {
      inspectorCleanup?.();
      refreshController?.destroy();
      invalidation.destroy();
      sessionBanner.destroy();
      region.destroy();
      urlState.destroy();
      splitter.destroy();
      toolbar.destroy();
    },
  });
}

export function createRecordTable({ document, records, columns, state, selectionKey, selectedId = (record) => record.recordId, select }) {
  const scroll = document.createElement('div');
  scroll.className = 'console-table-scroll';
  const table = document.createElement('table');
  table.className = 'console-data-table console-index-table';
  const caption = document.createElement('caption');
  caption.className = 'console-visually-hidden';
  caption.textContent = 'Bounded console index records';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column.label;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const record of records) {
    const row = document.createElement('tr');
    const id = selectedId(record);
    if (selectionKey && state[selectionKey] === id) row.dataset.selected = 'true';
    for (const [index, column] of columns.entries()) {
      const cell = document.createElement('td');
      const value = column.value(record);
      if (index === 0 && selectionKey) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'console-index-select';
        button.textContent = display(value);
        button.setAttribute('aria-expanded', state.inspector === 'open' && state[selectionKey] === id ? 'true' : 'false');
        button.setAttribute('aria-controls', 'console-inspector');
        button.addEventListener('click', () => select(record, button));
        cell.append(button);
      } else cell.textContent = display(value);
      row.append(cell);
    }
    body.append(row);
  }
  table.append(caption, head, body);
  scroll.append(table);
  return scroll;
}

export function renderRecordInspector({ document, inspector, record, title, facts, close }) {
  const heading = inspectorHeading(document, inspector, title);
  const definition = document.createElement('dl');
  definition.className = 'console-definition-list';
  for (const [label, value] of facts) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = display(value);
    definition.append(term, detail);
  }
  const links = createRecordLinks(document, record);
  inspector.append(definition);
  if (links.childElementCount > 0) inspector.append(links);
  inspector.append(inspectorCloseButton(document, close));
  heading.focus();
}

export function createRecordLinks(document, record) {
  const list = document.createElement('div');
  list.className = 'console-inspector-links';
  const workspace = document.createElement('a');
  workspace.className = 'console-button console-button-secondary';
  workspace.href = runHref(record, 'overview');
  workspace.textContent = 'Open run workspace';
  list.append(workspace);
  for (const destination of safeDestinations(record.fields.destinations).slice(0, 3)) {
    const link = document.createElement('a');
    link.className = 'console-button console-button-secondary';
    link.href = destination;
    link.textContent = destinationLabel(destination);
    list.append(link);
  }
  return list;
}

export function runHref(record, view = 'overview', selection = null) {
  const parameters = new URLSearchParams({ mode: record.mode, run: record.runId, view });
  if (selection) parameters.set('record', selection);
  return `/run.html?${parameters.toString()}`;
}

export function field(record, name, fallback = 'Unavailable') {
  return record.fields[name] ?? fallback;
}

export function display(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'None';
  return String(value);
}

export function formatTime(value) {
  if (typeof value !== 'string') return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  return `${Math.round(value / 60_000)}m`;
}

function createToolbar(document, filters, onCommit) {
  const element = document.createElement('form');
  element.className = 'console-toolbar console-index-toolbar';
  element.setAttribute('aria-label', 'Index filters');
  element.addEventListener('submit', (event) => event.preventDefault());
  const controls = new Map();
  for (const spec of filters) {
    const label = document.createElement('label');
    label.className = 'console-index-filter';
    const text = document.createElement('span');
    text.textContent = spec.label;
    const control = spec.type === 'search' ? document.createElement('input') : document.createElement('select');
    control.name = spec.name;
    if (spec.type === 'search') {
      control.type = 'search';
      control.placeholder = spec.placeholder ?? '';
      control.maxLength = spec.maximum ?? 300;
    } else {
      for (const option of spec.options) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        node.disabled = option.disabled === true;
        control.append(node);
      }
    }
    if (spec.disabled) {
      control.disabled = true;
      if (spec.reason) control.setAttribute('aria-describedby', `${spec.name}-filter-reason`);
    }
    control.addEventListener('change', () => onCommit(spec.name, spec.multiple && control.value ? [control.value] : control.value));
    label.append(text, control);
    if (spec.reason) {
      const reason = document.createElement('small');
      reason.id = `${spec.name}-filter-reason`;
      reason.textContent = spec.reason;
      label.append(reason);
    }
    controls.set(spec.name, { control, spec });
    element.append(label);
  }
  return {
    element,
    sync(state) {
      for (const [name, { control, spec }] of controls) {
        const value = state[name];
        control.value = spec.multiple ? (Array.isArray(value) ? value[0] ?? '' : '') : value ?? '';
      }
    },
    destroy() { element.replaceChildren(); },
  };
}

function renderCompleteness(document, content, page) {
  if (page.complete && page.limitations.length === 0) return;
  const note = document.createElement('p');
  note.className = 'console-index-limitation';
  note.textContent = limitationSummary(page);
  content.append(note);
}

function limitationSummary(page) {
  const details = page.limitations.slice(0, 4).map(({ sourceId, code }) => `${sourceId}: ${code}`).join('; ');
  return details ? `This is a partial bounded view. ${details}` : 'This is a partial bounded view; source backfill is incomplete.';
}

function describeIndexFreshness(page, loadedAt) {
  if (!page) return loadedAt ? `Fetched ${loadedAt.toISOString()}; source freshness unavailable` : 'Source freshness unavailable';
  const updates = page.sourceVector?.sources?.map(({ updatedAt }) => updatedAt).filter(Boolean).sort() ?? [];
  const sourceUpdate = updates.at(-1);
  const completeness = page.complete ? 'complete' : 'partial';
  const source = sourceUpdate ? `source ${page.freshness} at ${sourceUpdate}` : `source ${page.freshness}`;
  return `${source}; ${completeness}; fetched ${loadedAt.toISOString()}`;
}

function renderInspectorPlaceholder(document, inspector, text) {
  inspectorHeading(document, inspector, 'Context inspector');
  const copy = document.createElement('p');
  copy.textContent = text;
  inspector.append(copy);
}

function inspectorHeading(document, inspector, text) {
  const heading = document.createElement('h2');
  heading.tabIndex = -1;
  heading.textContent = text;
  inspector.append(heading);
  return heading;
}

function inspectorCloseButton(document, close) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'console-button console-button-secondary';
  button.textContent = 'Close inspector';
  button.addEventListener('click', close);
  return button;
}

function safeDestinations(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => {
    if (typeof entry !== 'string' || !entry.startsWith('/') || entry.startsWith('//') || entry.includes('\\')) return false;
    try { return new URL(entry, 'http://console.local').origin === 'http://console.local'; } catch { return false; }
  });
}

function destinationLabel(destination) {
  if (destination.startsWith('/report')) return 'Open report';
  if (destination.startsWith('/gallery')) return 'Open gallery';
  if (destination.includes('checklist')) return 'Open checklist';
  return 'Open evidence destination';
}
