import { parseConsoleUrlState, serializeConsoleUrlState } from '/console-contracts.mjs';
import { createAsyncRegion } from './console-async.js';
import { createConsoleSessionBanner } from './console-session-banner.js';
import { CONSOLE_NAVIGATION_ITEMS, createConsoleShell, createFocusManager } from './console-shell.js';
import { createConsoleUrlState } from './console-url-state.js';

const root = document.querySelector('#settings-console');
const announcer = document.querySelector('#global-announcer');
const template = document.querySelector('#settings-workspace-template');
const shell = createConsoleShell(root, {
  navigationItems: CONSOLE_NAVIGATION_ITEMS,
  activeNavigationId: 'settings',
  title: 'Settings',
  description: 'Inspect runtime-backed catalog, baseline, environment, target, and credential capabilities.',
  inspectorLabel: 'Configuration authority',
});
shell.main.append(template.content.cloneNode(true));

const connection = document.createElement('strong');
connection.id = 'system-status';
connection.setAttribute('role', 'status');
connection.setAttribute('aria-live', 'polite');
connection.textContent = 'Loading settings…';
shell.headerActions.append(connection);

const inspectorHeading = document.createElement('h2');
inspectorHeading.textContent = 'Configuration authority';
const inspectorCopy = document.createElement('p');
inspectorCopy.className = 'settings-muted';
inspectorCopy.textContent = 'Catalog and environment data are runtime-managed. Baseline inventory is read-only here; guarded lifecycle actions remain in evidence review.';
const inspectorList = document.createElement('dl');
inspectorList.className = 'console-definition-list';
appendInspectorDefinition('Credential secret', 'Never returned');
const credentialActor = appendInspectorDefinition('Credential actor', 'Checking browser session…');
appendInspectorDefinition('Baselines', 'Read-only inventory');
appendInspectorDefinition('Environment edits', 'Runtime-managed');
shell.inspector.append(inspectorHeading, inspectorCopy, inspectorList);

const sections = ['credentials', 'test-catalog', 'baselines', 'environments'];
const elements = {
  sectionButtons: new Map(sections.map((id) => [id, document.querySelector(`[data-settings-section="${id}"]`)])),
  sectionRegions: new Map(sections.map((id) => [id, document.querySelector(`#settings-${id}`)])),
  keyForm: document.querySelector('#anthropic-key-form'),
  keySettings: document.querySelector('#anthropic-key-settings'),
  keyState: document.querySelector('#anthropic-key-state'),
  keyInput: document.querySelector('#anthropic-key-input'),
  saveKey: document.querySelector('#save-anthropic-key'),
  deleteKey: document.querySelector('#delete-anthropic-key'),
  refreshKey: document.querySelector('#refresh-anthropic-key'),
  keyMessage: document.querySelector('#anthropic-key-message'),
};

const state = {
  pending: new Set(),
  config: null,
  configPromise: null,
  keyLoadController: null,
  keySettings: { known: false, configured: false, fingerprint: null, storageEnabled: false, unavailableReason: null },
  keyDeleteArmed: false,
  keyDeleteBinding: null,
  keyDeleteTimer: null,
  activeSection: null,
  urlState: null,
};

const focus = createFocusManager(root);
focus.register('page-heading', shell.heading);
for (const [id, button] of elements.sectionButtons) focus.register(`section-${id}`, button);

const catalogRegion = createAsyncRegion({
  root: elements.sectionRegions.get('test-catalog'),
  load: ({ signal }) => loadConfig(signal),
  render: renderCatalog,
  isEmpty: (config) => config.catalog.length === 0,
});
const baselineRegion = createAsyncRegion({
  root: elements.sectionRegions.get('baselines'),
  load: ({ signal }) => requestJson('/api/single-site/visual-baselines?offset=0&limit=50', { signal }),
  render: renderBaselines,
  isEmpty: (value) => value.items.length === 0,
  onError: handleProtectedRegionError,
});
const environmentRegion = createAsyncRegion({
  root: elements.sectionRegions.get('environments'),
  load: ({ signal }) => loadConfig(signal),
  render: renderEnvironments,
  isEmpty: () => false,
});
const sessionBanner = createConsoleSessionBanner({
  document,
  shell,
  onAuthorized: reloadAfterAuthorization,
  onStateChange({ state: sessionState, session }) {
    if (sessionState === 'authorized') {
      connection.textContent = 'Shared session active';
      credentialActor.textContent = session?.principal?.id
        ? `Authenticated as ${bounded(session.principal.id, 120)}`
        : 'Authenticated shared session';
    } else if (sessionState === 'expired') {
      connection.textContent = 'Shared session expired';
      credentialActor.textContent = 'Expired — authorization required';
    } else if (sessionState === 'required') {
      connection.textContent = 'Shared authorization required';
      credentialActor.textContent = 'Not authenticated';
    } else if (sessionState === 'unavailable') {
      connection.textContent = 'Settings ready';
      credentialActor.textContent = 'Shared authorization is not enabled';
    }
  },
});

bindEvents();
const initial = parseConsoleUrlState('settings', window.location.href);
state.urlState = createConsoleUrlState({
  window,
  routeId: 'settings',
  parse: parseConsoleUrlState,
  serialize: serializeConsoleUrlState,
  onChange(parsed) { applySection(parsed.state.section ?? 'credentials'); },
  onRestoreFocus(key) { focus.focus(key, shell.heading); },
});
applySection(initial.state.section ?? 'credentials');

function bindEvents() {
  for (const [section, button] of elements.sectionButtons) {
    button.addEventListener('click', () => state.urlState?.setState({ section }, { focusKey: `section-${section}` }));
  }
  elements.keyForm.addEventListener('submit', saveAnthropicKey);
  elements.deleteKey.addEventListener('click', () => void deleteAnthropicKey());
  elements.refreshKey.addEventListener('click', () => void loadAnthropicKeySettings({ announceResult: true }));
  elements.keyInput.addEventListener('input', () => {
    clearKeyDeleteConfirmation();
    setKeyMessage('');
  });
  window.addEventListener('pagehide', () => {
    clearKeyDeleteConfirmation();
    state.keyLoadController?.abort();
    state.urlState?.destroy();
    catalogRegion.destroy();
    baselineRegion.destroy();
    environmentRegion.destroy();
    sessionBanner.destroy();
    focus.destroy();
  }, { once: true });
}

function applySection(section) {
  if (!sections.includes(section)) section = 'credentials';
  if (state.activeSection && state.activeSection !== section) clearKeyDeleteConfirmation();
  state.activeSection = section;
  for (const id of sections) {
    const selected = id === section;
    elements.sectionButtons.get(id).toggleAttribute('aria-current', selected);
    elements.sectionRegions.get(id).hidden = !selected;
  }
  if (section === 'credentials' && !state.keySettings.known && !state.keyLoadController) {
    void loadAnthropicKeySettings();
  }
  if (section === 'test-catalog' && catalogRegion.snapshot.value === null && catalogRegion.snapshot.key === null) void catalogRegion.request('config');
  if (section === 'baselines' && baselineRegion.snapshot.value === null && baselineRegion.snapshot.key === null) void baselineRegion.request('baselines');
  if (section === 'environments' && environmentRegion.snapshot.value === null && environmentRegion.snapshot.key === null) void environmentRegion.request('config');
}

async function loadConfig(signal) {
  if (state.config) return state.config;
  if (!state.configPromise) {
    state.configPromise = requestJson('/api/config', { signal }).then((config) => {
      state.config = config;
      state.configPromise = null;
      return config;
    }, (error) => {
      state.configPromise = null;
      if (error?.status === 401 || error?.status === 403) sessionBanner.requireAuthentication(error);
      throw error;
    });
  }
  return state.configPromise;
}

async function loadAnthropicKeySettings({ announceResult = false, force = false } = {}) {
  if (state.keyLoadController && !force) return;
  state.keyLoadController?.abort();
  const controller = new AbortController();
  state.keyLoadController = controller;
  setRegionBusy(elements.keySettings, true);
  elements.keyState.textContent = 'Checking…';
  elements.keyState.className = 'settings-state loading';
  try {
    const value = await requestJson('/api/settings/anthropic-key', { signal: controller.signal });
    if (state.keyLoadController !== controller) return;
    if (state.keyDeleteArmed && credentialBinding(value) !== state.keyDeleteBinding) {
      clearKeyDeleteConfirmation();
      setKeyMessage('Credential capability changed. Review the current state before deleting.', true);
    }
    applyKeySettings(value);
    if (announceResult) announce('Anthropic API key settings refreshed.');
  } catch (error) {
    if (state.keyLoadController !== controller || error?.name === 'AbortError') return;
    if (error?.status === 401 || error?.status === 403) sessionBanner.requireAuthentication(error);
    const message = friendlyError(error);
    state.keySettings.known = false;
    elements.keyState.textContent = 'Status unavailable';
    elements.keyState.className = 'settings-state error';
    setKeyMessage(`Could not check the saved key: ${message}`, true);
    elements.deleteKey.disabled = true;
    if (announceResult) announce(`API key settings could not be loaded. ${message}`);
  } finally {
    if (state.keyLoadController === controller) {
      state.keyLoadController = null;
      setRegionBusy(elements.keySettings, false);
      renderKeySettings();
    }
  }
}

async function saveAnthropicKey(event) {
  event.preventDefault();
  if (!beginOperation('key-save')) return;
  clearKeyDeleteConfirmation();
  let apiKey = elements.keyInput.value.trim();
  if (apiKey.length < 10) {
    setKeyMessage('Enter a complete Anthropic API key before saving.', true);
    announce('A complete Anthropic API key is required.');
    endOperation('key-save');
    elements.keyInput.focus();
    return;
  }
  const request = requestJson('/api/settings/anthropic-key', {
    method: 'PUT',
    body: JSON.stringify({ apiKey }),
    timeoutMs: 30_000,
  });
  elements.keyInput.value = '';
  apiKey = '';
  setRegionBusy(elements.keySettings, true);
  setButtonBusy(elements.saveKey, true, state.keySettings.configured ? 'Replacing…' : 'Saving…');
  elements.deleteKey.disabled = true;
  setKeyMessage('Sending the key to the portal service…');
  announce('Saving the Anthropic API key.');
  try {
    const value = await request;
    applyKeySettings(value);
    setKeyMessage('API key saved. The browser has discarded the submitted value.', false, true);
    announce('Anthropic API key saved.');
  } catch (error) {
    if (!Number.isInteger(error?.status)) {
      await reconcileCredentialMutation('save', error);
    } else {
      const message = `Portal rejected the credential update (HTTP ${error.status}).`;
      setKeyMessage(`The key was not saved. ${message}`, true);
      announce(`Anthropic API key was not saved. ${message}`);
    }
  } finally {
    setButtonBusy(elements.saveKey, false);
    setRegionBusy(elements.keySettings, false);
    endOperation('key-save');
    renderKeySettings();
  }
}

async function deleteAnthropicKey() {
  if (!state.keySettings.configured || state.pending.has('key-delete')) return;
  if (!state.keyDeleteArmed) {
    state.keyDeleteArmed = true;
    state.keyDeleteBinding = credentialBinding(state.keySettings);
    elements.deleteKey.textContent = 'Confirm delete';
    elements.deleteKey.setAttribute('aria-label', 'Confirm deletion of the saved Anthropic API key');
    setKeyMessage('Select “Confirm delete” within 8 seconds to remove the saved key.');
    announce('Confirm deletion of the saved Anthropic API key.');
    state.keyDeleteTimer = window.setTimeout(clearKeyDeleteConfirmation, 8_000);
    return;
  }
  if (!beginOperation('key-delete')) return;
  const expectedBinding = state.keyDeleteBinding;
  clearKeyDeleteConfirmation();
  setRegionBusy(elements.keySettings, true);
  setButtonBusy(elements.deleteKey, true, 'Checking current state…');
  elements.saveKey.disabled = true;
  elements.keyInput.disabled = true;
  try {
    const current = await requestJson('/api/settings/anthropic-key');
    if (credentialBinding(current) !== expectedBinding) {
      applyKeySettings(current);
      setKeyMessage('Credential capability changed. No deletion was sent; review the current state and confirm again.', true);
      announce('Credential state changed before deletion. No deletion was sent.');
      return;
    }
    setButtonBusy(elements.deleteKey, true, 'Deleting…');
    setKeyMessage('Deleting the saved key…');
    announce('Deleting the saved Anthropic API key.');
    try {
      const value = await requestJson('/api/settings/anthropic-key', { method: 'DELETE', timeoutMs: 30_000 });
      applyKeySettings(value);
      const message = value.configured
        ? 'Portal-saved key deleted. A runtime-provided key remains configured.'
        : 'Saved API key deleted. AI review is now off unless dry-run mode is enabled.';
      setKeyMessage(message, false, true);
      announce(message);
    } catch (error) {
      if (!Number.isInteger(error?.status)) await reconcileCredentialMutation('delete', error);
      else {
        const message = friendlyError(error);
        setKeyMessage(`The key was not deleted. ${message}`, true);
        announce(`Anthropic API key was not deleted. ${message}`);
      }
    }
  } catch (error) {
    const message = friendlyError(error);
    setKeyMessage(`Current credential state could not be verified. No deletion was sent. ${message}`, true);
    announce('Credential state could not be verified. No deletion was sent.');
  } finally {
    setButtonBusy(elements.deleteKey, false);
    elements.saveKey.disabled = false;
    elements.keyInput.disabled = false;
    setRegionBusy(elements.keySettings, false);
    endOperation('key-delete');
    renderKeySettings();
  }
}

async function reconcileCredentialMutation(operation, originalError) {
  try {
    const value = await requestJson('/api/settings/anthropic-key');
    applyKeySettings(value);
    const stateLabel = value.configured ? 'configured' : 'not configured';
    setKeyMessage(`The ${operation} response was lost. The portal now reports ${stateLabel}; the prior result was reconciled without repeating the mutation.`, true);
    announce(`Credential ${operation} response was lost. Current authoritative state is ${stateLabel}.`);
  } catch (reconcileError) {
    setKeyMessage(`The ${operation} result is unknown and was not repeated. Current state could not be reconciled. ${friendlyError(originalError)} ${friendlyError(reconcileError)}`, true);
    announce(`Credential ${operation} result is unknown. The mutation was not repeated.`);
  }
}

function applyKeySettings(value) {
  state.keySettings = {
    known: true,
    configured: Boolean(value?.configured),
    fingerprint: typeof value?.fingerprint === 'string' ? value.fingerprint.slice(0, 80) : null,
    storageEnabled: value?.storageEnabled === true,
    unavailableReason: typeof value?.unavailableReason === 'string' ? value.unavailableReason.slice(0, 300) : null,
  };
  renderKeySettings();
}

function renderKeySettings() {
  if (!state.keySettings.known) return;
  const { configured, fingerprint, storageEnabled, unavailableReason } = state.keySettings;
  elements.keyState.className = `settings-state ${configured ? 'configured' : 'unconfigured'}`;
  elements.keyState.textContent = !storageEnabled ? 'Isolation required' : configured
    ? `Configured${fingerprint ? ` · ${fingerprint}` : ''}`
    : 'Not configured';
  elements.keyInput.disabled = !storageEnabled || state.pending.has('key-delete');
  elements.saveKey.disabled = !storageEnabled || state.pending.has('key-save') || state.pending.has('key-delete');
  elements.deleteKey.disabled = !configured || state.pending.has('key-delete') || state.pending.has('key-save');
  if (!storageEnabled && unavailableReason) setKeyMessage(unavailableReason, true);
}

function credentialBinding(value) {
  return JSON.stringify({
    configured: Boolean(value?.configured),
    fingerprint: typeof value?.fingerprint === 'string' ? value.fingerprint.slice(0, 80) : null,
    storageEnabled: value?.storageEnabled === true,
  });
}

function clearKeyDeleteConfirmation() {
  if (state.keyDeleteTimer) window.clearTimeout(state.keyDeleteTimer);
  state.keyDeleteTimer = null;
  state.keyDeleteArmed = false;
  state.keyDeleteBinding = null;
  elements.deleteKey.textContent = 'Delete key';
  elements.deleteKey.removeAttribute('aria-label');
}

function renderCatalog(config, target) {
  target.replaceChildren();
  const summary = definitionList([
    ['Documented checks', config.catalog.length],
    ['Installed suites', config.plugins.length],
    ['Audit areas', new Set(config.catalog.map(({ area }) => area)).size],
  ]);
  const note = document.createElement('p');
  note.className = 'settings-capability-note';
  note.textContent = `Runtime-managed catalog. Showing the first ${Math.min(50, config.catalog.length)} of ${config.catalog.length} definitions; launch filtering remains available in New Audit.`;
  const rows = config.catalog.slice(0, 50).map((audit) => [
    audit.id,
    audit.title,
    humanize(audit.area),
    audit.severity ?? 'Unknown',
    audit.releaseBlocking ? 'Release blocking' : audit.manual ? 'Manual' : 'Non-blocking',
  ]);
  target.append(summary, note, table(['ID', 'Check', 'Area', 'Severity', 'Authority'], rows));
}

function renderBaselines(value, target) {
  target.replaceChildren();
  const summary = definitionList([
    ['Records', value.total],
    ['Store revision', value.storeRevision],
    ['Page', `${value.items.length} of ${value.total}`],
  ]);
  const note = document.createElement('p');
  note.className = 'settings-capability-note';
  note.textContent = value.items.length === 0
    ? 'No visual baseline records are stored. Approvals and lifecycle actions remain in Single-site evidence review.'
    : `Read-only inventory at history ${bounded(value.historyDigest, 80)}. Approve, replace, revoke, and delete remain guarded evidence-review actions.`;
  const rows = value.items.slice(0, 50).map((record) => {
    const link = safeGalleryLink(record.source?.runId);
    return [
      record.baselineId,
      humanize(record.state),
      `${humanize(record.identity?.deploymentRole)} · ${record.identity?.route ?? 'Unknown route'}`,
      record.identity?.targetId ?? 'Unknown target',
      record.approvedAt ?? 'Unknown',
      link,
      record.media?.available ? `${formatBytes(record.media.bytes)} available` : 'Media unavailable',
    ];
  });
  target.append(summary, note, table(['Baseline', 'State', 'Identity', 'Target', 'Approved', 'Source run', 'Media'], rows));
}

function renderEnvironments(config, target) {
  target.replaceChildren();
  const allTargets = [
    ...config.targets.localTargets.map((entry) => ({ ...entry, mode: 'Comparative' })),
    ...config.targets.singleSiteTargets.map((entry) => ({ ...entry, mode: 'Single-site' })),
    ...config.targets.providerTargets.map((entry) => ({ ...entry, mode: 'Provider' })),
  ].slice(0, 100);
  const summary = definitionList([
    ['Production origin', config.defaults.productionUrl],
    ['Candidate origin', config.defaults.candidateUrl],
    ['Single-site origin', config.defaults.singleSiteUrl],
    ['Concurrent runs', config.limits?.maxConcurrentRuns ?? 'Unavailable'],
    ['Single-site queue', config.singleSite?.queue?.available ? 'Available' : 'Unavailable'],
    ['Preview TLS bypass', config.singleSite?.previewTlsBypassConfigured ? 'Configured' : 'Unavailable'],
  ]);
  const note = document.createElement('p');
  note.className = 'settings-capability-note';
  note.textContent = 'Origins, runner identities, targets, and certificate capabilities are runtime-managed. Unavailable targets retain their source-backed reason.';
  const rows = allTargets.map((targetEntry) => [
    targetEntry.id,
    targetEntry.mode,
    targetEntry.label,
    targetEntry.available ? 'Available' : `Unavailable · ${targetEntry.unavailableReason ?? targetEntry.qualification}`,
    targetEntry.defaultSelected ? 'Default' : 'Optional',
  ]);
  target.append(summary, note, table(['Target ID', 'Mode', 'Target', 'Capability', 'Selection'], rows));
}

function safeGalleryLink(runId) {
  if (typeof runId !== 'string') return 'Unknown source';
  try {
    const search = serializeConsoleUrlState('gallery', { mode: 'single-site', run: runId, from: 'runs', review: 'all' });
    const link = document.createElement('a');
    link.href = `/gallery.html?${search}`;
    link.textContent = runId;
    return link;
  } catch {
    return bounded(runId, 160);
  }
}

function table(headings, rows) {
  const scroll = document.createElement('div');
  scroll.className = 'settings-table-scroll';
  const result = document.createElement('table');
  result.className = 'settings-table';
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const heading of headings) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = heading;
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tableRow = document.createElement('tr');
    for (const value of row) {
      const cell = document.createElement('td');
      if (value instanceof Node) cell.append(value);
      else cell.textContent = bounded(value, 600);
      tableRow.append(cell);
    }
    body.append(tableRow);
  }
  result.append(head, body);
  scroll.append(result);
  return scroll;
}

function definitionList(entries) {
  const list = document.createElement('dl');
  list.className = 'settings-summary-list';
  for (const [label, value] of entries) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = bounded(value, 300);
    row.append(term, detail);
    list.append(row);
  }
  return list;
}

function appendInspectorDefinition(label, value) {
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  inspectorList.append(term, detail);
  return detail;
}

async function reloadAfterAuthorization() {
  state.config = null;
  state.configPromise = null;
  state.keySettings.known = false;
  if (state.activeSection === 'credentials') await loadAnthropicKeySettings({ announceResult: true, force: true });
  else if (state.activeSection === 'test-catalog') await catalogRegion.request('config', { refresh: true });
  else if (state.activeSection === 'baselines') await baselineRegion.request('baselines', { refresh: true });
  else if (state.activeSection === 'environments') await environmentRegion.request('config', { refresh: true });
}

function handleProtectedRegionError(error) {
  if (error?.status === 401 || error?.status === 403) sessionBanner.requireAuthentication(error);
}

function setKeyMessage(message, error = false, success = false) {
  elements.keyMessage.textContent = message;
  elements.keyMessage.classList.toggle('error', error);
  elements.keyMessage.classList.toggle('success', success);
}

function beginOperation(key) {
  if (state.pending.has(key)) return false;
  state.pending.add(key);
  return true;
}

function endOperation(key) {
  state.pending.delete(key);
}

function setRegionBusy(element, busy) {
  element.setAttribute('aria-busy', String(busy));
}

function setButtonBusy(button, busy, label = '') {
  if (busy) {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    if (label) button.textContent = label;
    return;
  }
  if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
  delete button.dataset.idleLabel;
  button.disabled = false;
  button.removeAttribute('aria-disabled');
}

function announce(message) {
  announcer.textContent = '';
  window.requestAnimationFrame(() => { announcer.textContent = message; });
}

async function requestJson(url, options = {}) {
  const { timeoutMs = 30_000, ...fetchOptions } = options;
  const response = await fetchWithTimeout(url, {
    ...fetchOptions,
    headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers ?? {}) },
  }, timeoutMs);
  const value = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok) {
    const message = typeof value.error === 'string' ? value.error : value.error?.message;
    const error = new Error(message ?? `Request failed (${response.status})`);
    error.status = response.status;
    error.code = value.error?.code ?? value.code;
    error.body = value;
    throw error;
  }
  return value;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const { signal: externalSignal, ...fetchOptions } = options;
  const abortFromExternal = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timer = window.setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } catch (error) {
    if (controller.signal.reason?.name === 'TimeoutError') throw new Error('The portal took too long to respond.');
    throw error;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

function friendlyError(error) {
  return String(error?.message ?? error ?? 'Unexpected error')
    .replace(/sk-ant-[A-Za-z0-9_-]+/gi, '[redacted API key]')
    .replace(/(x-api-key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .slice(0, 1_200);
}

function bounded(value, maximum) {
  const text = String(value ?? 'Unknown').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function humanize(value) {
  return bounded(value, 160).replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
