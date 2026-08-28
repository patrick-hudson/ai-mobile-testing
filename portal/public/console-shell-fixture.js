import {
  CONSOLE_ROUTE_CONTRACTS,
  assertClientMayWriteStateDomain,
  parseConsoleUrlState,
  serializeConsoleUrlState,
} from '/__e2e__/console-contracts.mjs';
import { createAsyncRegion } from './console-async.js';
import { createAsyncStateBlock, createConsoleDialog, createManualTabs } from './console-components.js';
import { createConsoleLiveState } from './console-live-state.js';
import { createConsoleShell, createConsoleSplitter, createFocusManager } from './console-shell.js';
import { createConsoleUrlState } from './console-url-state.js';
import { createSavedViewsStore } from './saved-views.js';

const root = document.querySelector('#console-shell-fixture');
const announcer = document.querySelector('#console-announcer');
const shell = createConsoleShell(root, {
  navigationItems: [
    { id: 'fixture', label: 'Shell fixture', href: '/console-shell-fixture.html' },
    { id: 'legacy', label: 'Legacy console', href: '/' },
    { id: 'report', label: 'Report entry', href: '/report.html?run=fixture-run' },
  ],
  activeNavigationId: 'fixture',
  title: 'Operations workspace',
  description: 'Shared shell behavior isolated from feature-page controllers.',
  inspectorLabel: 'Run context inspector',
});
const focus = createFocusManager(root);
focus.register('page-heading', shell.heading);

const connectionBlock = document.createElement('div');
connectionBlock.className = 'console-connection-block';
const connectionLabel = document.createElement('strong');
connectionLabel.id = 'fixture-connection';
connectionLabel.setAttribute('role', 'status');
connectionLabel.setAttribute('aria-live', 'polite');
const lastUpdate = document.createElement('span');
lastUpdate.id = 'fixture-last-update';
connectionBlock.append(connectionLabel, lastUpdate);
shell.headerActions.append(connectionBlock);

const toolbar = document.createElement('div');
toolbar.className = 'console-toolbar';
toolbar.setAttribute('aria-label', 'Fixture run selection');
const alphaButton = button('Select Alpha', 'fixture-alpha');
const betaButton = button('Select Beta', 'fixture-beta');
alphaButton.dataset.runId = 'fixture-alpha';
betaButton.dataset.runId = 'fixture-beta';
const refreshFailure = button('Refresh with one failure', 'fixture-refresh-failure');
const openDialogButton = button('Open confirmation', 'fixture-open-dialog');
toolbar.append(alphaButton, betaButton, refreshFailure, openDialogButton);
shell.main.append(toolbar);
focus.register('run-alpha', alphaButton);
focus.register('run-beta', betaButton);

const asyncBlock = createAsyncStateBlock(document, { id: 'fixture-results', title: 'Bounded run results' });
shell.main.append(asyncBlock.section);
focus.register('results-heading', asyncBlock.heading);
let failNext = false;
let abortedRequests = 0;
const asyncRegion = createAsyncRegion({
  root: asyncBlock.section,
  async load({ key, signal }) {
    const delay = key === 'fixture-alpha' ? 180 : 35;
    await abortableDelay(delay, signal);
    if (failNext) {
      failNext = false;
      throw new Error('Synthetic refresh failure.');
    }
    return { id: key, result: key === 'fixture-alpha' ? 'Needs review' : 'Ready', rows: 2 };
  },
  render(value, target) {
    target.replaceChildren();
    const tableScroll = document.createElement('div');
    tableScroll.className = 'console-table-scroll';
    const table = document.createElement('table');
    table.className = 'console-data-table';
    const caption = document.createElement('caption');
    caption.textContent = `Selected ${value.id}`;
    const body = document.createElement('tbody');
    body.append(tableRow('Run', value.id), tableRow('Authoritative result', value.result), tableRow('Bounded rows', String(value.rows)));
    table.append(caption, body);
    tableScroll.append(table);
    target.append(tableScroll);
  },
});

const tabs = createManualTabs(document, {
  id: 'fixture-details',
  label: 'Run detail views',
  tabs: [
    { id: 'summary', label: 'Summary', content: 'Summary is ready.' },
    { id: 'evidence', label: 'Evidence', content: 'Evidence has not been requested.' },
    { id: 'timeline', label: 'Timeline', content: 'Timeline has not been requested.' },
  ],
  async onActivate(tabId, panel) {
    panel.setAttribute('aria-busy', 'true');
    panel.textContent = `Loading ${tabId}…`;
    await abortableDelay(35);
    panel.textContent = `${capitalize(tabId)} loaded from a bounded fixture adapter.`;
    panel.setAttribute('aria-busy', 'false');
  },
});
shell.main.append(tabs.element);

const dialog = createConsoleDialog(document, {
  id: 'fixture-dialog',
  title: 'Confirm fixture action',
  description: 'This dialog performs no mutation. It exists to verify modal focus and Escape behavior.',
});
shell.main.append(dialog.element);
openDialogButton.addEventListener('click', () => dialog.show(openDialogButton));

const inspectorHeading = document.createElement('h2');
inspectorHeading.textContent = 'Run context';
inspectorHeading.tabIndex = -1;
const definitions = document.createElement('dl');
definitions.className = 'console-definition-list';
definitions.append(
  definition('Execution', 'Running', 'fixture-execution'),
  definition('Activity', 'Collecting evidence', 'fixture-activity'),
  definition('Connection', 'Connecting', 'fixture-connection-detail'),
  definition('Freshness', 'No server update', 'fixture-freshness'),
  definition('Aborted requests', '0', 'fixture-abort-count'),
);
const liveControls = document.createElement('div');
liveControls.className = 'console-inspector-controls';
const reconnectButton = button('Simulate reconnect', 'fixture-reconnect');
const offlineButton = button('Simulate offline', 'fixture-offline');
const connectedButton = button('Restore connection', 'fixture-connected');
const serverUpdateButton = button('Accept server update', 'fixture-server-update');
liveControls.append(reconnectButton, offlineButton, connectedButton, serverUpdateButton);

const savedHeading = document.createElement('h2');
savedHeading.textContent = 'Saved view';
const savedControls = document.createElement('div');
savedControls.className = 'console-inspector-controls';
const savedLabel = document.createElement('label');
savedLabel.textContent = 'View name';
const savedName = document.createElement('input');
savedName.id = 'fixture-saved-name';
savedName.value = 'My review view';
savedLabel.append(savedName);
const saveViewButton = button('Save current view', 'fixture-save-view');
const restoreViewButton = button('Restore saved view', 'fixture-restore-view');
const savedStatus = document.createElement('p');
savedStatus.id = 'fixture-storage-status';
savedStatus.className = 'console-storage-status';
savedStatus.setAttribute('role', 'status');
savedStatus.setAttribute('aria-live', 'polite');
savedControls.append(savedLabel, saveViewButton, restoreViewButton, savedStatus);
shell.inspector.append(inspectorHeading, definitions, liveControls, savedHeading, savedControls);

const savedViews = createSavedViewsStore({
  storageProvider: () => window.localStorage,
  parse: parseConsoleUrlState,
  serialize: serializeConsoleUrlState,
  allowedRouteIds: Object.keys(CONSOLE_ROUTE_CONTRACTS),
});
savedStatus.textContent = `${savedViews.list().length} valid saved views loaded.`;
let urlState;
const savedLayout = savedViews.get('fixture-layout')?.layout?.inspectorWidth;
const splitter = createConsoleSplitter({
  shell: root,
  separator: shell.separator,
  inspector: shell.inspector,
  initial: savedLayout ?? 320,
  onCommit(width) {
    saveLayout(width);
    announce(`Inspector width ${width} pixels.`);
  },
});

const liveState = createConsoleLiveState({
  initialDurable: { execution: 'Running', activity: 'Collecting evidence' },
  assertClientMayWriteStateDomain,
  render(state) {
    setText('fixture-execution', state.durable.execution);
    setText('fixture-activity', state.durable.activity);
    setText('fixture-connection-detail', state.connection);
    setText('fixture-freshness', state.stale ? 'Stale; durable values frozen' : `Current at ${state.lastServerUpdate}`);
    connectionLabel.textContent = `${capitalize(state.connection)}${state.stale ? ' · stale' : ''}`;
    lastUpdate.textContent = state.lastServerUpdate ? `Last server update ${state.lastServerUpdate}` : 'No server update received';
  },
});

urlState = createConsoleUrlState({
  window,
  routeId: 'runs',
  parse: parseConsoleUrlState,
  serialize: serializeConsoleUrlState,
  onChange(parsed) {
    const runId = parsed.state.run ?? 'fixture-alpha';
    alphaButton.setAttribute('aria-pressed', runId === 'fixture-alpha' ? 'true' : 'false');
    betaButton.setAttribute('aria-pressed', runId === 'fixture-beta' ? 'true' : 'false');
    void asyncRegion.request(runId);
  },
  onRestoreFocus(key) { focus.focus(key, shell.heading); },
  maximumPushes: 8,
});

alphaButton.addEventListener('click', () => selectRun('fixture-alpha', 'run-alpha'));
betaButton.addEventListener('click', () => selectRun('fixture-beta', 'run-beta'));
refreshFailure.addEventListener('click', () => {
  failNext = true;
  void asyncRegion.request(urlState.current.state.run ?? 'fixture-alpha', { refresh: true });
});
reconnectButton.addEventListener('click', () => liveState.setConnection('reconnecting'));
offlineButton.addEventListener('click', () => liveState.setConnection('offline'));
connectedButton.addEventListener('click', () => liveState.setConnection('connected'));
serverUpdateButton.addEventListener('click', () => liveState.acceptAuthoritativeSnapshot({ execution: 'Completed', activity: 'Awaiting review' }));
saveViewButton.addEventListener('click', saveCurrentView);
restoreViewButton.addEventListener('click', restoreSavedView);

function selectRun(runId, focusKey) {
  urlState.setState({ ...urlState.current.state, run: runId, inspector: 'open' }, { focusKey });
}

function saveCurrentView() {
  try {
    savedViews.save({
      id: 'fixture-saved',
      name: savedName.value,
      routeId: 'runs',
      parameters: urlState.current.state,
      layout: { inspectorWidth: splitter.value },
    });
    savedStatus.textContent = savedViews.storageAvailable ? 'Saved in this browser.' : 'Browser storage unavailable; saved in memory for this session.';
  } catch {
    savedStatus.textContent = 'The view was not saved because it was invalid.';
  }
}

function restoreSavedView() {
  const entry = savedViews.get('fixture-saved');
  if (!entry) {
    savedStatus.textContent = 'No valid saved view is available.';
    return;
  }
  splitter.setValue(entry.layout.inspectorWidth ?? splitter.value);
  urlState.setState(entry.parameters, { focusKey: 'page-heading' });
  savedStatus.textContent = 'Saved view restored.';
}

function saveLayout(width) {
  try {
    savedViews.save({
      id: 'fixture-layout',
      name: 'Layout preference',
      routeId: 'runs',
      parameters: urlState?.current?.state ?? parseConsoleUrlState('runs', '').state,
      layout: { inspectorWidth: width },
    });
  } catch { /* Resizing remains available when persistence is denied. */ }
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    if (!signal) return;
    const abort = () => {
      clearTimeout(timeout);
      abortedRequests += 1;
      const count = document.querySelector('#fixture-abort-count');
      if (count) count.textContent = String(abortedRequests);
      reject(new DOMException('Superseded fixture request.', 'AbortError'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function button(label, id) {
  const value = document.createElement('button');
  value.type = 'button';
  value.id = id;
  value.textContent = label;
  return value;
}

function definition(term, value, id) {
  const fragment = document.createDocumentFragment();
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.id = id;
  dd.textContent = value;
  fragment.append(dt, dd);
  return fragment;
}

function tableRow(label, value) {
  const row = document.createElement('tr');
  const heading = document.createElement('th');
  heading.scope = 'row';
  heading.textContent = label;
  const cell = document.createElement('td');
  cell.textContent = value;
  row.append(heading, cell);
  return row;
}

function setText(id, value) { document.querySelector(`#${id}`).textContent = String(value); }
function capitalize(value) { return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`; }
function announce(message) { announcer.textContent = message; }
