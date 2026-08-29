import {
  assertClientMayWriteStateDomain,
  parseConsoleUrlState,
  serializeConsoleUrlState,
} from '/console-contracts.mjs';
import { createConsoleLiveState } from './console-live-state.js';
import { CONSOLE_NAVIGATION_ITEMS, createConsoleShell, createConsoleSplitter, createFocusManager } from './console-shell.js';
import { createConsoleUrlState } from './console-url-state.js';
import { createConsoleLogViewer } from './console-log-viewer.js';
import { createRunActionController } from './run-actions.js';
import { createRunInvalidationBus, publishRunInvalidation } from './console-invalidation.js';
import {
  assertSharedWorkspaceProjection,
  createSharedControlBrowserClient,
  pageSharedRisksForReview,
} from './shared-control-client.js';

const ACTIVE_COMPARATIVE_STATES = new Set(['queued', 'starting', 'running', 'stopping']);
const ACTIVE_SINGLE_SITE_STATES = new Set(['queued', 'starting', 'running', 'finalizing']);
const SETTLED_FINALIZATION_STATES = new Set(['complete', 'incomplete', 'deadline-exceeded', 'invalid']);
const MAX_RENDERED_RECORDS = 200;
const VIEW_GROUPS = Object.freeze([
  { label: 'Workspace', views: [['overview', 'Overview']] },
  { label: 'Review', views: [['tests', 'Tests'], ['findings', 'Findings'], ['evidence', 'Evidence']] },
  { label: 'Diagnostics', views: [['timeline', 'Timeline'], ['logs', 'Logs']] },
  { label: 'Outcome', views: [['report', 'Report']] },
]);

function safeJson(event) {
  try { return JSON.parse(event.data); } catch { return null; }
}

function eventSequence(event) {
  const value = Number.parseInt(event.lastEventId ?? '', 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function createComparativeRunTransport({
  window,
  document,
  runId,
  initialSequence = 0,
  initialTerminal = false,
  EventSourceImpl = window.EventSource,
  onConnection,
  onSnapshot,
  onEvent,
  onLog,
  onPurged,
  recover,
} = {}) {
  let source = null;
  let retryTimer = null;
  let recovery = null;
  let destroyed = false;
  let terminal = initialTerminal === true;
  let sequence = Number.isSafeInteger(initialSequence) ? initialSequence : 0;
  let retryAttempt = 0;
  let reconnects = 0;

  function clearRetry() {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function closeSource() {
    const closing = source;
    source = null;
    closing?.close();
  }

  function scheduleReconnect() {
    if (destroyed || terminal || document.hidden || retryTimer !== null) return;
    const ceiling = Math.min(15_000, 1_000 * (2 ** Math.min(retryAttempt, 4)));
    const jitter = Math.floor(ceiling * 0.2 * Math.random());
    retryAttempt += 1;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void recoverAndConnect('reconnect');
    }, ceiling + jitter);
  }

  async function recoverAndConnect(reason) {
    if (destroyed || terminal || document.hidden || recovery) return;
    onConnection?.('reconnecting', reason);
    recovery = Promise.resolve(recover?.({ reason, sequence })).then((nextSequence) => {
      if (Number.isSafeInteger(nextSequence) && nextSequence >= sequence) sequence = nextSequence;
    }).catch(() => undefined).finally(() => {
      recovery = null;
    });
    await recovery;
    if (!destroyed && !terminal && !document.hidden) connect();
  }

  function accept(current, event, callback) {
    if (destroyed || terminal || source !== current || current.readyState === current.CLOSED) return;
    const next = eventSequence(event);
    if (next !== null && next <= sequence) return;
    if (next !== null) sequence = next;
    callback(safeJson(event), next);
  }

  function connect() {
    if (destroyed || terminal || document.hidden || source) return;
    clearRetry();
    onConnection?.('connecting', 'Opening the comparative event stream.');
    const current = new EventSourceImpl(`/api/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(sequence)}`);
    source = current;
    current.addEventListener('open', () => {
      if (source !== current) return;
      retryAttempt = 0;
      onConnection?.('connected', 'Comparative event stream connected.');
    });
    current.addEventListener('snapshot', (event) => accept(current, event, (data, next) => data?.manifest && onSnapshot?.(data.manifest, next)));
    for (const type of ['stage', 'status']) {
      current.addEventListener(type, (event) => accept(current, event, (data, next) => onEvent?.(type, data, next)));
    }
    current.addEventListener('log', (event) => accept(current, event, (data, next) => data && onLog?.(data, next)));
    current.addEventListener('overflow', () => {
      if (source !== current) return;
      closeSource();
      void recoverAndConnect('overflow');
    });
    current.addEventListener('purged', (event) => accept(current, event, (data) => {
      terminal = true;
      closeSource();
      clearRetry();
      onConnection?.('closed', 'Run evidence was purged.');
      onPurged?.(data);
    }));
    current.addEventListener('error', () => {
      if (source !== current || destroyed || terminal) return;
      closeSource();
      reconnects += 1;
      onConnection?.(window.navigator.onLine === false ? 'offline' : 'reconnecting', 'The comparative stream disconnected; durable state is frozen.');
      scheduleReconnect();
    });
  }

  function onVisibilityChange() {
    if (document.hidden) {
      closeSource();
      clearRetry();
      onConnection?.('closed', 'Live transport is paused while this document is hidden.');
    } else if (!terminal) {
      void recoverAndConnect('visible');
    }
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  connect();
  return Object.freeze({
    setTerminal(value) {
      terminal = value === true;
      if (terminal) {
        closeSource();
        clearRetry();
        onConnection?.('closed', 'Terminal run state retained; live stream closed.');
      } else connect();
    },
    get sequence() { return sequence; },
    get diagnostics() { return Object.freeze({ eventSources: source ? 1 : 0, retryTimers: retryTimer === null ? 0 : 1, recovering: Boolean(recovery), reconnects }); },
    destroy() {
      destroyed = true;
      closeSource();
      clearRetry();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      onConnection?.('closed', 'Comparative event stream closed.');
    },
  });
}

export function createSingleSiteRunPoller({
  window,
  document,
  poll,
  onConnection,
  initialSettled = false,
  initialSlow = false,
  activeIntervalMs = 2_000,
  settledIntervalMs = 30_000,
} = {}) {
  let timer = null;
  let controller = null;
  let destroyed = false;
  let settled = initialSettled === true;
  let slow = initialSlow === true;
  let polls = 0;

  function clearTimer() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    clearTimer();
    if (destroyed || document.hidden || settled) return;
    timer = window.setTimeout(() => {
      timer = null;
      void refresh();
    }, slow ? settledIntervalMs : activeIntervalMs);
  }

  async function refresh() {
    if (destroyed || document.hidden || controller) return null;
    controller = new AbortController();
    const current = controller;
    polls += 1;
    onConnection?.('connecting', 'Refreshing the Single-site queue revision.');
    try {
      const result = await poll({ signal: current.signal });
      if (destroyed || current.signal.aborted || controller !== current) return null;
      onConnection?.('connected', 'Single-site polling is current.');
      return result;
    } catch (error) {
      if (!current.signal.aborted && !destroyed) {
        onConnection?.(window.navigator.onLine === false ? 'offline' : 'reconnecting', 'Single-site polling failed; durable state is frozen.');
      }
      return null;
    } finally {
      if (controller === current) controller = null;
      schedule();
    }
  }

  function onVisibilityChange() {
    if (document.hidden) {
      clearTimer();
      controller?.abort();
      controller = null;
      onConnection?.('closed', 'Single-site polling is paused while this document is hidden.');
    } else if (!settled) void refresh();
  }

  document.addEventListener('visibilitychange', onVisibilityChange);
  if (!settled) void refresh();
  return Object.freeze({
    refresh,
    setSettled(value, { pendingFinalization = false } = {}) {
      settled = value === true;
      slow = !settled && pendingFinalization === true;
      if (settled) {
        clearTimer();
        controller?.abort();
        controller = null;
        onConnection?.('closed', 'Single-site execution and finalization are settled.');
      } else schedule();
    },
    get diagnostics() { return Object.freeze({ eventSources: 0, pollTimers: timer === null ? 0 : 1, inFlightPolls: controller ? 1 : 0, polls, cadence: slow ? 'bounded-backoff' : settled ? 'stopped' : 'active' }); },
    destroy() {
      destroyed = true;
      clearTimer();
      controller?.abort();
      controller = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      onConnection?.('closed', 'Single-site polling closed.');
    },
  });
}

function textElement(document, tagName, text, attributes = {}) {
  const element = document.createElement(tagName);
  element.textContent = text;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function definition(document, label, id) {
  const wrapper = document.createElement('div');
  const term = textElement(document, 'dt', label);
  const value = textElement(document, 'dd', 'Unavailable', { id });
  wrapper.append(term, value);
  return wrapper;
}

function trimRenderedWindow(list, maximum = MAX_RENDERED_RECORDS) {
  let omitted = Number.parseInt(list.dataset.windowOmitted ?? '0', 10) || 0;
  while (list.children.length > maximum) {
    list.firstElementChild?.remove();
    omitted += 1;
  }
  list.dataset.windowOmitted = String(omitted);
  list.setAttribute('aria-label', omitted > 0 ? `${maximum} newest records; ${omitted} older records omitted from the rendered window` : 'Bounded record window');
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value === null || value === undefined || value === '' ? 'Unavailable' : String(value);
}

function humanize(value) {
  return typeof value === 'string' && value ? value.replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/gu, (letter) => letter.toUpperCase()) : 'Unavailable';
}

function sameOriginHref(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && !url.username && !url.password ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch { return null; }
}

async function fetchJson(path, { signal, ...options } = {}) {
  const response = await fetch(path, { ...options, signal, headers: { Accept: 'application/json', ...(options.headers ?? {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = new Error(typeof body?.error === 'string' ? body.error : body?.error?.message ?? `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = typeof body?.error?.code === 'string' ? body.error.code : typeof body?.code === 'string' ? body.code : null;
    error.body = body;
    throw error;
  }
  return response.json();
}

const root = document.querySelector('#run-workspace');
if (root) initializeRunWorkspace(root);

function initializeRunWorkspace(root) {
  const announcer = document.querySelector('#global-announcer');
  const announce = (message) => { if (announcer) announcer.textContent = String(message); };
  const shell = createConsoleShell(root, {
    navigationItems: CONSOLE_NAVIGATION_ITEMS,
    activeNavigationId: 'runs',
    title: 'Run workspace',
    description: 'Live authority, review destinations, diagnostics, and run controls.',
    inspectorLabel: 'Run context inspector',
  });
  const focus = createFocusManager(root);
  focus.register('page-heading', shell.heading);
  const splitter = createConsoleSplitter({ shell: root, separator: shell.separator, inspector: shell.inspector, initial: 320 });

  const identity = document.createElement('div');
  identity.className = 'run-identity';
  identity.append(
    textElement(document, 'strong', 'Mode unavailable', { id: 'run-mode' }),
    textElement(document, 'code', 'Run unavailable', { id: 'run-id' }),
    textElement(document, 'span', 'Not loaded', { id: 'run-freshness', class: 'run-freshness' }),
  );
  const stateGrid = document.createElement('dl');
  stateGrid.className = 'run-state-grid';
  stateGrid.append(
    definition(document, 'Execution state', 'run-execution-state'),
    definition(document, 'Activity state', 'run-activity-state'),
    definition(document, 'Connection state', 'run-connection-state'),
    definition(document, 'Current phase', 'run-phase'),
    definition(document, 'Progress', 'run-progress'),
    definition(document, 'Last server update', 'run-last-update'),
  );
  const trustGrid = document.createElement('dl');
  trustGrid.className = 'run-trust-grid';
  trustGrid.id = 'run-trust';
  trustGrid.append(
    definition(document, 'Outcome', 'run-outcome'),
    definition(document, 'Finalization', 'run-finalization'),
    definition(document, 'Coverage', 'run-coverage'),
    definition(document, 'Evidence authority', 'run-evidence-authority'),
    definition(document, 'Pipeline integrity', 'run-pipeline-integrity'),
    definition(document, 'Scope', 'run-scope'),
  );
  const actionArea = document.createElement('div');
  actionArea.id = 'run-actions';
  actionArea.className = 'run-actions';
  const destinations = document.createElement('div');
  destinations.id = 'run-destinations';
  destinations.className = 'run-destinations';
  const navigation = document.createElement('nav');
  navigation.id = 'run-view-navigation';
  navigation.className = 'run-view-navigation';
  navigation.setAttribute('aria-label', 'Run workspace');
  const viewFocusTargets = [];
  for (const group of VIEW_GROUPS) {
    const wrapper = document.createElement('div');
    wrapper.className = 'run-view-group';
    wrapper.append(textElement(document, 'span', group.label));
    for (const [view, label] of group.views) {
      const link = textElement(document, 'a', label, { href: '#', 'data-run-view-link': view, 'data-focus-key': `view-${view}` });
      viewFocusTargets.push([`view-${view}`, link]);
      wrapper.append(link);
    }
    navigation.append(wrapper);
  }
  const viewRegion = document.createElement('section');
  viewRegion.id = 'run-view-region';
  viewRegion.className = 'run-region';
  viewRegion.dataset.asyncState = 'initial-loading';
  viewRegion.setAttribute('aria-live', 'polite');
  const productRisk = document.createElement('section');
  productRisk.id = 'run-product-risk';
  productRisk.className = 'run-product-risk';
  productRisk.dataset.riskAvailability = 'LOADING';
  productRisk.setAttribute('aria-labelledby', 'run-product-risk-title');
  productRisk.setAttribute('aria-busy', 'true');
  const productRiskTitle = textElement(document, 'h2', 'Product Risk', { id: 'run-product-risk-title' });
  const productRiskStatus = textElement(document, 'p', 'Loading shared release authority…', { id: 'run-product-risk-status', role: 'status', 'aria-live': 'polite' });
  const productRiskBody = document.createElement('div');
  productRiskBody.id = 'run-product-risk-body';
  productRisk.append(productRiskTitle, productRiskStatus, productRiskBody);
  shell.main.append(identity, stateGrid, trustGrid, productRisk, actionArea, destinations, navigation, viewRegion);
  for (const [key, target] of viewFocusTargets) focus.register(key, target);

  const inspectorHeading = textElement(document, 'h2', 'Run context', { tabindex: '-1' });
  const inspectorList = document.createElement('dl');
  inspectorList.className = 'run-inspector-list';
  inspectorList.append(
    definition(document, 'Selected record', 'run-inspector-record'),
    definition(document, 'Source revision', 'run-inspector-source-revision'),
    definition(document, 'Capability revision', 'run-inspector-capability-revision'),
    definition(document, 'Completeness', 'run-inspector-completeness'),
    definition(document, 'Limitations', 'run-inspector-limitations'),
  );
  shell.inspector.append(inspectorHeading, inspectorList);

  const sharedSession = document.createElement('section');
  sharedSession.className = 'run-shared-session';
  sharedSession.append(textElement(document, 'h3', 'Shared control session'));
  const sharedSessionStatus = textElement(document, 'p', 'Checking current browser authorization…', { id: 'run-shared-session-status', role: 'status', 'aria-live': 'polite' });
  const sharedLogin = document.createElement('form');
  const sharedCredentialLabel = textElement(document, 'label', 'Scoped control credential');
  const sharedCredential = document.createElement('input');
  sharedCredential.type = 'password';
  sharedCredential.required = true;
  sharedCredential.autocomplete = 'off';
  sharedCredential.maxLength = 4_096;
  sharedCredential.name = 'control-credential';
  sharedCredentialLabel.append(sharedCredential);
  const sharedLoginButton = textElement(document, 'button', 'Authorize this browser session', { type: 'submit' });
  sharedLogin.append(sharedCredentialLabel, sharedLoginButton);
  sharedSession.append(sharedSessionStatus, sharedLogin);
  shell.inspector.append(sharedSession);

  let routeState = null;
  let urlState = null;
  let workspaceGeneration = 0;
  let summaryBody = null;
  let detail = null;
  let transport = null;
  let currentMode = null;
  let currentRunId = null;
  let viewController = null;
  let artifactCursor = 0;
  let destroyed = false;
  let purged = false;
  let authorityPartial = false;
  let authorityRefreshRevision = 0;
  let sharedWorkspace = null;
  let sharedSessionReady = false;
  let sharedAuthorityActive = false;
  let sharedOperationInFlight = null;
  const authorityControllers = new Set();
  const sharedControl = createSharedControlBrowserClient();

  const logRoot = document.createElement('section');
  const logViewer = createConsoleLogViewer({
    root: logRoot,
    mode: 'comparative',
    announce,
    onFiltersChange(filters, controlId) {
      if (!routeState?.valid || !urlState) return;
      const next = { ...routeState.state };
      for (const key of ['source', 'stage', 'shard']) next[key] = filters[key] === 'all' ? undefined : filters[key];
      next.search = filters.search || undefined;
      urlState.setState(next, { focusKey: controlId });
    },
  });

  function captureWorkspaceIdentity() {
    return Object.freeze({ generation: workspaceGeneration, mode: currentMode, runId: currentRunId });
  }

  function assertCurrentWorkspace(capture, signal) {
    if (signal?.aborted || destroyed || capture.generation !== workspaceGeneration
      || capture.mode !== currentMode || capture.runId !== currentRunId) {
      throw new DOMException('Workspace changed.', 'AbortError');
    }
  }

  function beginAuthorityRefresh(parentSignal) {
    const controller = new AbortController();
    const revision = ++authorityRefreshRevision;
    const abort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    authorityControllers.add(controller);
    return {
      signal: controller.signal,
      revision,
      release() {
        authorityControllers.delete(controller);
        parentSignal?.removeEventListener('abort', abort);
      },
    };
  }

  function abortAuthorityRefreshes() {
    for (const controller of authorityControllers) controller.abort();
    authorityControllers.clear();
  }

  function assertLatestAuthorityRefresh(refresh, capture) {
    assertCurrentWorkspace(capture, refresh.signal);
    if (refresh.revision !== authorityRefreshRevision) throw new DOMException('A newer authority refresh superseded this response.', 'AbortError');
  }

  function assertCoherentAuthority(summaryValue, detailValue, tail = null) {
    const record = summaryValue?.data?.record;
    const sourceComparable = typeof record?.sourceRevision === 'string' && typeof detailValue?.sourceRevision === 'string';
    const sequenceComparable = Number.isSafeInteger(detailValue?.revision) && Number.isSafeInteger(tail?.sequence);
    if (sourceComparable && record.sourceRevision !== detailValue.sourceRevision) {
      throw new Error('Summary and detail authority revisions did not match; retained the prior generation.');
    }
    if (sequenceComparable && detailValue.revision !== tail.sequence) {
      throw new Error('Detail and log authority revisions did not match; retained the prior generation.');
    }
    if (!sourceComparable && tail && !sequenceComparable) {
      throw new Error('Authority sources did not expose a comparable revision; retained the prior generation as partial.');
    }
  }

  const liveState = createConsoleLiveState({
    initialDurable: {},
    assertClientMayWriteStateDomain,
    render(snapshot) {
      setText('run-connection-state', humanize(snapshot.connection));
      const freshness = snapshot.stale
        ? `Stale; durable values frozen${snapshot.lastServerUpdate ? ` at ${snapshot.lastServerUpdate}` : ''}`
        : `Current at ${snapshot.lastServerUpdate ?? 'unknown time'}`;
      setText('run-freshness', freshness);
    },
  });

  function currentActionSnapshot() {
    const record = summaryBody?.data?.record;
    const capability = summaryBody?.capabilities?.items?.find((entry) => entry.identity?.mode === currentMode && entry.identity?.runId === currentRunId);
    return Object.freeze({
      mode: currentMode,
      runId: currentRunId,
      sourceRevision: record?.sourceRevision ?? null,
      authorityRevision: capability?.authorityRevision ?? null,
      actions: capability?.actions ?? [],
    });
  }

  const actionController = createRunActionController({
    document,
    host: document.body,
    getSnapshot: currentActionSnapshot,
    async validate(binding) {
      await refreshAuthority({ includeLogs: currentMode === 'single-site', force: true });
      const snapshot = currentActionSnapshot();
      const action = snapshot.actions.find((entry) => entry.actionId === binding.actionId);
      return binding.mode === snapshot.mode && binding.runId === snapshot.runId
        && binding.sourceRevision === snapshot.sourceRevision && binding.authorityRevision === snapshot.authorityRevision
        && action?.available === true && action?.authorized === true && action?.eligible === true;
    },
    async execute(binding) {
      if (binding.actionId === 'manualEvidence') return executeManualEvidence(binding);
      return fetch(binding.endpoint, {
        method: binding.method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(binding.body ?? {}),
      });
    },
    reconcile: reconcileAction,
    async onAccepted(binding) {
      if (binding.actionId === 'purge') {
        markPurged('The server accepted permanent deletion. No cached run evidence or actions remain in this workspace.');
        return;
      }
      await refreshAuthority({ includeLogs: currentMode === 'single-site' });
    },
    resolveFocus(binding) {
      return (binding?.actionId ? actionArea.querySelector(`[data-run-action="${binding.actionId}"]`) : null) ?? shell.heading;
    },
    announce,
  });

  function scopeSummary(scope) {
    if (!scope || typeof scope !== 'object') return 'Scope unavailable';
    const values = ['features', 'definitions', 'targets', 'knownLimits']
      .flatMap((key) => Array.isArray(scope[key]) ? scope[key] : []);
    return values.length ? values.slice(0, 12).join(', ') : 'Declared scope is bound to the release subject.';
  }

  function sharedActionButton(label, action, body) {
    const button = textElement(document, 'button', label, { type: 'button', 'data-shared-action': action });
    button.addEventListener('click', () => void executeSharedAction(action, body, button));
    return button;
  }

  function applySharedWorkspaceAuthority() {
    const publication = sharedWorkspace.publication;
    const executions = sharedWorkspace.executions.executions;
    const completedStates = new Set(['completed_pass', 'completed_product_failure', 'incomplete', 'cancelled']);
    const terminal = executions.every(({ state }) => completedStates.has(state));
    const completed = executions.filter(({ state }) => completedStates.has(state)).length;
    const sourceRevision = `shared-${publication.runRevision}`;
    const authorityComplete = ['AVAILABLE', 'EMPTY'].includes(sharedWorkspace.riskAvailability);
    summaryBody = {
      complete: authorityComplete,
      limitations: authorityComplete ? [] : [{ code: `risk-register-${sharedWorkspace.riskAvailability.toLowerCase()}` }],
      capabilities: { items: [] },
      data: { record: {
        mode: currentMode, runId: currentRunId, sourceRevision, sourceUpdatedAt: null,
        fields: {
          terminal, executionState: terminal ? 'completed' : 'running', activityState: terminal ? 'idle' : 'normal',
          phase: terminal ? 'release-published' : 'shared-execution', progressTotal: executions.length,
          progressCompleted: completed, outcome: publication.decision.label,
          coverageStatus: publication.decision.grantedAuthority, evidenceAuthorityStatus: 'revision-bound',
          pipelineIntegrityStatus: sharedWorkspace.logs?.truncated ? 'partial' : 'available',
          finalizationStatus: 'shared publication', scopeLabel: scopeSummary(publication.decision.certifiedScope), destinations: [],
        },
      } },
    };
    detail = {
      id: currentRunId, mode: currentMode, sourceRevision, status: terminal ? 'completed' : 'running',
      activity: terminal ? 'idle' : 'normal', phase: terminal ? 'release-published' : 'shared-execution',
      progress: { total: executions.length, completed }, release: publication.decision,
      pipeline: { status: sharedWorkspace.logs?.truncated ? 'partial' : 'available', reason: 'Bounded shared operation and attempt logs.' },
      scope: { qualifier: publication.decision.grantedAuthority }, finalization: { status: 'complete' },
    };
    sharedAuthorityActive = true;
    transport?.destroy();
    transport = null;
    applyAuthority(summaryBody, detail);
    renderView();
  }

  function renderSharedWorkspace() {
    const publication = sharedWorkspace?.publication;
    const decision = publication?.decision;
    const register = publication?.riskRegister;
    const availability = register?.availability ?? 'UNAVAILABLE';
    productRisk.dataset.riskAvailability = availability;
    productRisk.setAttribute('aria-busy', String(availability === 'LOADING'));
    productRiskStatus.textContent = availability === 'EMPTY'
      ? 'Risk Register is complete. No active product risks were published.'
      : availability === 'AVAILABLE' ? `${register.risks.length} published risk record${register.risks.length === 1 ? '' : 's'}.`
        : availability === 'PROVISIONAL' ? 'Risk Register is provisional; review may change as evidence arrives.'
          : availability === 'PARTIAL' ? 'Risk Register is partial. Published risks are visible, but absence is not a no-risk claim.'
            : availability === 'LOADING' ? 'Risk Register is still loading.'
              : 'Risk Register is unavailable. No no-risk claim can be made.';
    const decisionCard = document.createElement('article');
    decisionCard.className = 'run-release-decision';
    decisionCard.append(
      textElement(document, 'p', 'Release Decision'),
      textElement(document, 'h3', decision?.label ?? 'Release decision unavailable'),
      textElement(document, 'p', `Authority: ${decision?.grantedAuthority ?? 'unavailable'} · Decision revision ${publication?.decisionRevision ?? 'unavailable'} · Run revision ${publication?.runRevision ?? 'unavailable'}`),
      textElement(document, 'p', `Certified scope: ${scopeSummary(decision?.certifiedScope)}`),
      textElement(document, 'p', 'Site Health remains a separate diagnostic truth. Non-blocking risks never change this decision.'),
    );
    const riskList = document.createElement('section');
    riskList.className = 'run-risk-register';
    riskList.setAttribute('aria-label', 'Paged Product Risk register');
    const oracleExecutionIds = new Set((sharedWorkspace?.executions?.oracleExecutions ?? []).map(({ id }) => id));
    let riskOffset = 0;
    const renderRiskPage = () => {
      const page = pageSharedRisksForReview(register?.risks, { offset: riskOffset });
      riskOffset = page.offset;
      const list = document.createElement('ol');
      list.className = 'run-risk-list';
      for (const risk of page.items) {
        const item = document.createElement('li');
        item.dataset.riskIdentity = risk.identity;
        item.append(
          textElement(document, 'strong', `${risk.severity.toUpperCase()} · ${humanize(risk.category)}`),
          textElement(document, 'span', ` ${risk.reviewState} · non-blocking`),
          textElement(document, 'p', risk.explanation),
          textElement(document, 'p', `Scope: ${scopeSummary(risk.scope)}`),
          textElement(document, 'p', `Source ${risk.source.kind}:${risk.source.id} · actor ${risk.actor.kind}:${risk.actor.id}`),
          textElement(document, 'p', `Observed ${risk.observedAt} · updated ${risk.updatedAt}`),
          textElement(document, 'p', `Recommended action: ${risk.recommendedAction}`),
        );
        const controls = document.createElement('div');
        controls.className = 'run-risk-actions';
        const bound = { expectedSubjectDigest: publication.finalSubjectDigest, riskIdentity: risk.identity };
        if (risk.category === 'unreviewed-visual-change' && risk.reviewState === 'PENDING_REVIEW'
          && oracleExecutionIds.has(risk.source.id)) {
          const rationaleLabel = textElement(document, 'label', 'Review rationale');
          const rationale = document.createElement('textarea');
          rationale.required = true;
          rationale.maxLength = 2_048;
          rationale.rows = 2;
          rationaleLabel.append(rationale);
          controls.append(rationaleLabel);
          for (const [label, disposition] of [['Accept visual change', 'ACCEPTED'], ['Confirm visual defect', 'DEFECT_CONFIRMED']]) {
            const button = textElement(document, 'button', label, { type: 'button', 'data-shared-action': 'visualDisposition' });
            button.addEventListener('click', () => {
              const explanation = rationale.value.trim();
              if (!explanation) {
                rationale.setCustomValidity('Explain the visual review decision.');
                rationale.reportValidity();
                return;
              }
              rationale.setCustomValidity('');
              void executeSharedAction('visualDisposition', {
                ...bound, executionId: risk.source.id, disposition, rationale: explanation,
              }, button);
            });
            controls.append(button);
          }
        } else if (risk.reviewState === 'OPEN') {
          controls.append(sharedActionButton('Acknowledge risk', 'riskAcknowledge', bound));
          if (!['certificate-bypass', 'coverage-gap', 'evidence-pipeline-limitation'].includes(risk.category)) {
            controls.append(sharedActionButton('Resolve risk', 'riskResolve', bound));
          }
        } else if (risk.reviewState === 'ACKNOWLEDGED' && !['certificate-bypass', 'coverage-gap', 'evidence-pipeline-limitation'].includes(risk.category)) {
          controls.append(sharedActionButton('Resolve risk', 'riskResolve', bound));
        }
        item.append(controls);
        list.append(item);
      }
      const controls = document.createElement('nav');
      controls.className = 'run-risk-pagination';
      controls.setAttribute('aria-label', 'Risk Register pages');
      const previous = textElement(document, 'button', 'Previous risks', { type: 'button' });
      previous.disabled = !page.hasPrevious;
      previous.addEventListener('click', () => { riskOffset -= page.limit; renderRiskPage(); riskList.focus(); });
      const next = textElement(document, 'button', 'Next risks', { type: 'button' });
      next.disabled = !page.hasNext;
      next.addEventListener('click', () => { riskOffset += page.limit; renderRiskPage(); riskList.focus(); });
      controls.append(previous, textElement(document, 'p', page.showing), next);
      riskList.replaceChildren(controls, list);
    };
    riskList.tabIndex = -1;
    renderRiskPage();
    const recovery = document.createElement('section');
    recovery.className = 'run-recovery';
    recovery.append(textElement(document, 'h3', 'Active recovery'));
    const incomplete = (sharedWorkspace?.executions?.executions ?? []).filter(({ state }) => state === 'incomplete');
    if (incomplete.length === 0) recovery.append(textElement(document, 'p', 'No incomplete execution is eligible for rekick.'));
    for (const execution of incomplete.slice(0, 100)) {
      const row = document.createElement('div');
      row.dataset.executionId = execution.id;
      row.append(
        textElement(document, 'code', execution.id),
        sharedActionButton('Rekick incomplete execution', 'rekick', {
          expectedSubjectDigest: publication.finalSubjectDigest,
          workItemIds: [execution.id],
        }),
      );
      recovery.append(row);
    }
    const pipeline = document.createElement('aside');
    pipeline.className = 'run-pipeline-integrity';
    pipeline.append(
      textElement(document, 'h3', 'Pipeline Integrity'),
      textElement(document, 'p', `${sharedWorkspace?.logs?.truncated ? 'Partial' : 'Available'} · ${sharedWorkspace?.logs?.events?.length ?? 0} bounded operation events and ${sharedWorkspace?.logs?.attemptLogs?.length ?? 0} attempt log records loaded.`),
    );
    productRiskBody.replaceChildren(decisionCard, riskList, recovery, pipeline);
  }

  async function loadSharedWorkspace({ announceResult = false } = {}) {
    if (!sharedSessionReady || !currentRunId) return;
    productRisk.dataset.riskAvailability = 'LOADING';
    productRisk.setAttribute('aria-busy', 'true');
    productRiskStatus.textContent = 'Loading current revision-bound release authority…';
    try {
      const capture = captureWorkspaceIdentity();
      const next = assertSharedWorkspaceProjection(await sharedControl.readWorkspace(capture.runId), {
        runId: capture.runId,
        mode: capture.mode,
      });
      assertCurrentWorkspace(capture);
      sharedWorkspace = next;
      renderSharedWorkspace();
      applySharedWorkspaceAuthority();
      if (announceResult) announce(`Shared release revision ${next.publication.runRevision} loaded.`);
      if (routeState?.state?.operation && routeState.state.operation !== sharedOperationInFlight) {
        void resumeSharedOperation(routeState.state.operation);
      }
    } catch (error) {
      productRisk.dataset.riskAvailability = 'UNAVAILABLE';
      productRisk.setAttribute('aria-busy', 'false');
      productRiskStatus.textContent = `Shared Product Risk unavailable: ${error.message}`;
    }
  }

  async function executeSharedAction(kind, body, button) {
    if (!sharedWorkspace?.publication) return;
    button.disabled = true;
    const focusIdentity = button.closest('[data-risk-identity]')?.dataset.riskIdentity ?? null;
    const focusExecution = button.closest('[data-execution-id]')?.dataset.executionId ?? null;
    const requestId = `${kind}-${crypto.randomUUID()}`;
    productRiskStatus.textContent = 'Submitting a durable shared operation…';
    try {
      const accepted = await sharedControl.mutate(currentRunId, kind, {
        expectedRunRevision: sharedWorkspace.publication.runRevision, body, requestId,
      });
      if (accepted.statusUrl) {
        const operationId = accepted.operationId ?? accepted.statusUrl.split('/').at(-1);
        sharedOperationInFlight = operationId;
        urlState.setState({ ...routeState.state, operation: operationId }, { replace: true });
        productRiskStatus.textContent = `Operation accepted (${operationId}). Waiting for durable completion…`;
        const completed = await sharedControl.waitForOperation(accepted.statusUrl, { runId: currentRunId });
        productRiskStatus.textContent = completed.outcome?.status === 'succeeded'
          ? 'Operation completed. Loading the newly published revision…'
          : `Operation finished: ${completed.outcome?.status ?? completed.state}.`;
        urlState.setState({ ...routeState.state, operation: undefined }, { replace: true });
        await loadSharedWorkspace({ announceResult: true });
        const returnTarget = focusIdentity
          ? productRiskBody.querySelector(`[data-risk-identity="${CSS.escape(focusIdentity)}"]`)
          : focusExecution ? productRiskBody.querySelector(`[data-execution-id="${CSS.escape(focusExecution)}"]`) : null;
        (returnTarget ?? productRiskTitle).tabIndex = -1;
        (returnTarget ?? productRiskTitle).focus({ preventScroll: true });
        sharedOperationInFlight = null;
      }
    } catch (error) {
      sharedOperationInFlight = null;
      productRiskStatus.textContent = `Operation failed: ${error.message}`;
      button.disabled = false;
      button.focus({ preventScroll: true });
    }
  }

  async function resumeSharedOperation(operationId) {
    try {
      sharedOperationInFlight = operationId;
      productRiskStatus.textContent = `Restoring durable operation ${operationId}…`;
      await sharedControl.waitForOperation(`/api/control/v1/runs/${encodeURIComponent(currentRunId)}/operations/${encodeURIComponent(operationId)}`, { runId: currentRunId });
      urlState.setState({ ...routeState.state, operation: undefined }, { replace: true });
      await loadSharedWorkspace();
    } catch (error) {
      productRiskStatus.textContent = `Operation status unavailable: ${error.message}`;
    } finally {
      sharedOperationInFlight = null;
    }
  }

  sharedLogin.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!sharedLogin.reportValidity()) return;
    sharedLoginButton.disabled = true;
    sharedSessionStatus.textContent = 'Authorizing this browser session…';
    try {
      await sharedControl.login(sharedCredential.value);
      sharedCredential.value = '';
      sharedSessionReady = true;
      sharedSessionStatus.textContent = 'Shared control session authorized. Credential discarded from the form.';
      sharedLogin.hidden = true;
      await loadSharedWorkspace({ announceResult: true });
    } catch (error) {
      sharedCredential.value = '';
      sharedSessionStatus.textContent = `Authorization failed: ${error.message}`;
      sharedCredential.focus();
    } finally {
      sharedLoginButton.disabled = false;
    }
  });

  void sharedControl.restore().then(() => {
    sharedSessionReady = true;
    sharedLogin.hidden = true;
    sharedSessionStatus.textContent = 'Shared control session restored.';
    return loadSharedWorkspace();
  }).catch((error) => {
    if (error?.status === 404
      || (error?.status === 503 && error?.message === 'Shared control API is not enabled.')) {
      sharedSession.hidden = true;
      productRisk.hidden = true;
      return;
    }
    sharedSessionStatus.textContent = 'Enter a scoped credential to view shared release authority and authorized actions.';
    productRisk.dataset.riskAvailability = 'UNAVAILABLE';
    productRisk.setAttribute('aria-busy', 'false');
    productRiskStatus.textContent = 'Shared Product Risk is unavailable until this browser session is authorized.';
  });

  async function reconcileAction(binding) {
    try {
      await refreshAuthority({ includeLogs: currentMode === 'single-site', force: true });
    } catch (error) {
      if (binding.actionId === 'purge' && [404, 410].includes(error?.status)) return 'accepted';
      return 'unknown';
    }
    if (binding.actionId === 'purge') return 'not-accepted';
    if (binding.actionId === 'stop') return detail?.stopRequestedAt || !ACTIVE_COMPARATIVE_STATES.has(detail?.status) ? 'accepted' : 'not-accepted';
    if (binding.actionId === 'cancel') return detail?.cancellation || !ACTIVE_SINGLE_SITE_STATES.has(detail?.status) ? 'accepted' : 'not-accepted';
    if (binding.actionId === 'manualEvidence') {
      const evidence = await fetchJson(`/api/runs/${encodeURIComponent(binding.runId)}/manual-evidence`);
      const match = evidence.entries?.some((entry) => entry.auditId === binding.body?.form?.auditId
        && entry.notes === binding.body?.form?.notes && entry.reviewer === binding.body?.form?.reviewer);
      return match ? 'accepted' : 'unknown';
    }
    return 'unknown';
  }

  function markPurged(message = null, { publish = true } = {}) {
    if (purged) return;
    purged = true;
    workspaceGeneration += 1;
    abortAuthorityRefreshes();
    transport?.destroy();
    transport = null;
    viewController?.abort();
    viewController = null;
    actionController.invalidate('Run evidence was purged.');
    logViewer.destroy();
    actionArea.replaceChildren();
    destinations.replaceChildren();
    viewRegion.dataset.asyncState = 'unavailable';
    viewRegion.replaceChildren(
      textElement(document, 'h2', 'Run evidence purged'),
      ...(message ? [textElement(document, 'p', message)] : []),
    );
    if (publish) publishRunInvalidation({ window, mode: currentMode, runId: currentRunId, reason: 'purged' });
  }

  const invalidation = createRunInvalidationBus({
    window,
    onInvalidate(detail) {
      if (detail.mode !== currentMode || detail.runId !== currentRunId) return;
      markPurged('Another console tab permanently purged this run. No cached evidence or actions remain.', { publish: false });
    },
  });

  async function executeManualEvidence(binding) {
    const uploadIds = [];
    for (const uploadBinding of binding.body.files) {
      const { file, idempotencyKey } = uploadBinding;
      const query = new URLSearchParams({ auditId: binding.body.form.auditId, filename: file.name, idempotencyKey });
      const url = `/api/runs/${encodeURIComponent(binding.runId)}/manual-uploads?${query}`;
      let response;
      try {
        response = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      } catch (error) {
        const evidence = await fetchJson(`/api/runs/${encodeURIComponent(binding.runId)}/manual-evidence`);
        const recovered = evidence.uploads?.find((entry) => entry.idempotencyKey === idempotencyKey
          && entry.auditId === binding.body.form.auditId && entry.name === file.name);
        if (recovered?.id) {
          uploadIds.push(recovered.id);
          continue;
        }
        throw error;
      }
      if (!response.ok) return response;
      const upload = await response.json();
      uploadIds.push(upload.id);
    }
    return fetch(`/api/runs/${encodeURIComponent(binding.runId)}/manual-evidence`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...binding.body.form, uploadIds }),
    });
  }

  function setConnection(connection, message) {
    liveState.setConnection(connection);
    const current = document.getElementById('run-connection-state');
    if (current && message) current.title = message;
  }

  function invalidateActionForRevision() {
    const binding = actionController.snapshot.binding;
    if (!binding) return;
    const snapshot = currentActionSnapshot();
    if (binding.mode !== snapshot.mode || binding.runId !== snapshot.runId
      || binding.sourceRevision !== snapshot.sourceRevision || binding.authorityRevision !== snapshot.authorityRevision) {
      actionController.invalidate();
    }
  }

  function resolveTerminalState(summaryValue = summaryBody, detailValue = detail) {
    const authoritative = summaryValue?.data?.record?.fields?.terminal;
    if (typeof authoritative === 'boolean') return authoritative;
    if (typeof detailValue?.status !== 'string' || !detailValue.status) return false;
    return currentMode === 'comparative'
      ? !ACTIVE_COMPARATIVE_STATES.has(detailValue.status)
      : !ACTIVE_SINGLE_SITE_STATES.has(detailValue.status);
  }

  function applyAuthority(nextSummary, nextDetail) {
    if (nextSummary) summaryBody = nextSummary;
    if (nextDetail) detail = nextDetail;
    const record = summaryBody?.data?.record;
    const summaryMatchesDetail = !(typeof record?.sourceRevision === 'string' && typeof detail?.sourceRevision === 'string')
      || record.sourceRevision === detail.sourceRevision;
    const fields = summaryMatchesDetail ? (record?.fields ?? {}) : {};
    const limitations = Array.isArray(summaryBody?.limitations) ? [...summaryBody.limitations] : [];
    if (!summaryMatchesDetail) limitations.push({ code: 'authority-revision-mismatch' });
    authorityPartial = summaryBody?.complete !== true || !summaryMatchesDetail;
    const execution = fields.executionState ?? detail?.status;
    const activity = fields.activityState ?? detail?.activity;
    const phase = fields.phase ?? detail?.phase;
    const finalization = fields.finalizationStatus ?? detail?.finalization?.status;
    const progressTotal = fields.progressTotal ?? detail?.progress?.total;
    const progressComplete = fields.progressCompleted ?? detail?.progress?.completed;
    const update = (summaryMatchesDetail ? record?.sourceUpdatedAt : null)
      ?? detail?.updatedAt ?? detail?.finishedAt ?? detail?.startedAt ?? detail?.createdAt ?? null;
    setText('run-mode', humanize(currentMode));
    setText('run-id', currentRunId);
    setText('run-execution-state', humanize(execution));
    setText('run-activity-state', humanize(activity));
    setText('run-phase', humanize(phase));
    setText('run-progress', Number.isFinite(progressTotal) && Number.isFinite(progressComplete) ? `${progressComplete} of ${progressTotal}` : 'Unavailable');
    setText('run-last-update', update);
    setText('run-outcome', humanize(fields.outcome ?? detail?.release?.decision ?? detail?.result?.kind));
    setText('run-finalization', currentMode === 'comparative' ? 'Not applicable' : humanize(finalization));
    setText('run-coverage', humanize(fields.coverageStatus ?? detail?.coverage?.status));
    setText('run-evidence-authority', humanize(fields.evidenceAuthorityStatus ?? detail?.evidenceAuthority?.status));
    setText('run-pipeline-integrity', humanize(fields.pipelineIntegrityStatus ?? detail?.pipeline?.status));
    setText('run-scope', fields.scopeLabel ?? detail?.scope?.qualifier ?? detail?.options?.profile);
    setText('run-inspector-record', routeState?.state?.record ?? 'No record selected');
    setText('run-inspector-source-revision', record?.sourceRevision);
    setText('run-inspector-capability-revision', currentActionSnapshot().authorityRevision);
    setText('run-inspector-completeness', summaryBody?.complete === true ? 'Complete' : 'Partial');
    setText('run-inspector-limitations', limitations.length ? limitations.map((entry) => entry.code).join(', ') : 'None reported');
    liveState.acceptAuthoritativeSnapshot({ execution, activity, phase }, { updatedAt: update });
    invalidateActionForRevision();
    renderActions();
    renderDestinations();
    const terminal = resolveTerminalState();
    if (currentMode === 'comparative') transport?.setTerminal(terminal);
    else {
      const fullySettled = terminal && SETTLED_FINALIZATION_STATES.has(detail?.finalization?.status);
      transport?.setSettled(fullySettled, { pendingFinalization: terminal && !fullySettled });
    }
  }

  function renderActions() {
    actionArea.replaceChildren();
    const snapshot = currentActionSnapshot();
    for (const action of snapshot.actions) {
      if (!['stop', 'cancel', 'purge', 'manualEvidence'].includes(action.actionId) || action.supported !== true) continue;
      const button = textElement(document, 'button', humanize(action.actionId === 'manualEvidence' ? 'manual evidence' : action.actionId), {
        type: 'button', 'data-run-action': action.actionId,
      });
      button.setAttribute('aria-disabled', String(action.available !== true));
      button.title = action.unavailableReason ?? '';
      button.addEventListener('click', (event) => {
        if (action.available !== true) {
          event.preventDefault();
          return;
        }
        void openAction(action.actionId, button);
      });
      actionArea.append(button);
    }
  }

  async function openAction(actionId, button) {
    const encoded = encodeURIComponent(currentRunId);
    if (actionId === 'manualEvidence') {
      const linkState = { ...routeState.state, view: 'evidence' };
      urlState.setState(linkState, { focusKey: 'view-evidence' });
      return;
    }
    const capture = captureWorkspaceIdentity();
    button.disabled = true;
    announce('Refreshing current action eligibility…');
    try {
      await refreshAuthority({ includeLogs: currentMode === 'single-site' });
      assertCurrentWorkspace(capture);
    } catch (error) {
      if (error?.name !== 'AbortError' && capture.generation === workspaceGeneration) {
        announce(`Action controls could not be refreshed. ${error.message}`);
      }
      if (button.isConnected) button.disabled = false;
      return;
    }
    const specifications = {
      stop: { label: 'Stop comparative run', endpoint: `/api/runs/${encoded}/stop`, method: 'POST', body: {}, consequence: 'Active browser work will be asked to exit safely. The server decides whether the run remains eligible.' },
      cancel: { label: 'Cancel Single-site audit', endpoint: `/api/single-site/runs/${encoded}/cancel`, method: 'POST', body: { reason: 'Cancelled by the portal operator.' }, consequence: 'Queued or active Single-site work will receive a durable cancellation request.' },
      purge: { label: 'Permanently purge run evidence', endpoint: currentMode === 'single-site' ? `/api/single-site/runs/${encoded}` : `/api/runs/${encoded}`, method: 'DELETE', body: { confirmation: detail?.purge?.confirmation ?? `PURGE ${currentRunId}` }, confirmation: detail?.purge?.confirmation ?? `PURGE ${currentRunId}`, consequence: 'Reports, screenshots, videos, traces, and logs owned by this run are permanently deleted. Preserved baseline consequences remain mode-specific.', submitLabel: 'Delete run evidence' },
    };
    const currentButton = actionArea.querySelector(`[data-run-action="${actionId}"]`);
    actionController.open({ actionId, ...specifications[actionId] }, currentButton ?? button);
  }

  function resolvedDestinations() {
    const result = {};
    const encoded = encodeURIComponent(currentRunId);
    result.report = currentMode === 'single-site' ? sameOriginHref(detail?.links?.report) : `/report.html?run=${encoded}`;
    result.gallery = `/gallery.html?mode=${encodeURIComponent(currentMode)}&run=${encoded}&from=runs`;
    for (const href of summaryBody?.data?.record?.fields?.destinations ?? []) {
      const safe = sameOriginHref(href);
      if (!safe) continue;
      if (safe.startsWith('/report')) result.report ??= safe;
      else if (safe.startsWith('/gallery')) result.gallery ??= safe;
      else if (safe.includes('checklist')) result.checklist ??= safe;
      else if (safe.includes('playwright') || safe.includes('source-report')) result.sourceReport ??= safe;
    }
    return result;
  }

  function renderDestinations() {
    destinations.replaceChildren();
    for (const [name, href] of Object.entries(resolvedDestinations())) {
      if (!href) continue;
      const link = textElement(document, 'a', humanize(name), { href, 'data-run-destination': name });
      destinations.append(link);
    }
  }

  async function loadSummaryAndDetail(signal, capture) {
    const encoded = encodeURIComponent(capture.runId);
    const summaryPath = `/api/console/v1/runs/${encodeURIComponent(capture.mode)}/${encoded}`;
    const detailPath = capture.mode === 'single-site' ? `/api/single-site/runs/${encoded}` : `/api/runs/${encoded}`;
    const [nextSummary, nextDetail] = await Promise.all([fetchJson(summaryPath, { signal }), fetchJson(detailPath, { signal })]);
    assertCurrentWorkspace(capture, signal);
    if (nextSummary?.data?.record?.mode !== capture.mode || nextSummary?.data?.record?.runId !== capture.runId
      || nextDetail?.id !== capture.runId) throw new Error('Run authority identity changed during refresh.');
    return { summary: nextSummary, detail: nextDetail };
  }

  async function fetchLogTail(signal, capture, maximum = 262_144) {
    const encoded = encodeURIComponent(capture.runId);
    const prefix = capture.mode === 'single-site' ? '/api/single-site/runs' : '/api/runs';
    return fetchJson(`${prefix}/${encoded}/logs?maxBytes=${maximum}`, { signal });
  }

  async function refreshAuthority({ includeLogs = false, signal: parentSignal } = {}) {
    if (currentMode === 'single-site' && includeLogs) {
      return refreshSingleSiteGeneration(parentSignal);
    }
    const capture = captureWorkspaceIdentity();
    const refresh = beginAuthorityRefresh(parentSignal);
    try {
      const next = await loadSummaryAndDetail(refresh.signal, capture);
      const tail = includeLogs ? await fetchLogTail(refresh.signal, capture, 65_536) : null;
      assertCoherentAuthority(next.summary, next.detail, tail);
      assertLatestAuthorityRefresh(refresh, capture);
      applyAuthority(next.summary, next.detail);
      if (tail) logViewer.replaceTail(tail.log ?? '', tail);
      return tail?.sequence ?? null;
    } finally {
      refresh.release();
    }
  }

  async function initialLoad() {
    const capture = captureWorkspaceIdentity();
    const refresh = beginAuthorityRefresh();
    viewRegion.dataset.asyncState = 'initial-loading';
    try {
      const [nextSummary, nextDetail, tail] = await Promise.all([
        fetchJson(`/api/console/v1/runs/${encodeURIComponent(capture.mode)}/${encodeURIComponent(capture.runId)}`, { signal: refresh.signal }),
        fetchJson(`${capture.mode === 'single-site' ? '/api/single-site/runs' : '/api/runs'}/${encodeURIComponent(capture.runId)}`, { signal: refresh.signal }),
        fetchJson(`${capture.mode === 'single-site' ? '/api/single-site/runs' : '/api/runs'}/${encodeURIComponent(capture.runId)}/logs?maxBytes=262144`, { signal: refresh.signal }),
      ]);
      assertLatestAuthorityRefresh(refresh, capture);
      if (sharedAuthorityActive) return;
      if (nextSummary?.data?.record?.mode !== capture.mode || nextSummary?.data?.record?.runId !== capture.runId
        || nextDetail?.id !== capture.runId) throw new Error('Run authority identity changed during initial load.');
      assertCoherentAuthority(nextSummary, nextDetail, tail);
      summaryBody = nextSummary;
      detail = nextDetail;
      logViewer.replaceTail(tail.log ?? '', tail);
      applyAuthority(nextSummary, nextDetail);
      startTransport(tail.sequence ?? 0);
      renderView();
    } catch (error) {
      if (capture.generation !== workspaceGeneration || error?.name === 'AbortError') return;
      if (sharedAuthorityActive) return;
      viewRegion.dataset.asyncState = error?.status === 403 ? 'permission-denied' : error?.status === 404 || error?.status === 410 ? 'unavailable' : 'retryable-failure';
      viewRegion.replaceChildren(textElement(document, 'h2', 'Run unavailable'), textElement(document, 'p', error.message), retryButton());
    } finally {
      refresh.release();
    }
  }

  function startTransport(sequence) {
    transport?.destroy();
    if (currentMode === 'comparative') {
      const terminal = resolveTerminalState();
      transport = createComparativeRunTransport({
        window, document, runId: currentRunId, initialSequence: sequence, initialTerminal: terminal,
        onConnection: setConnection,
        onSnapshot(manifest) { detail = manifest; applyAuthority(null, manifest); },
        onEvent(type, data) {
          if (data?.manifest) { detail = data.manifest; applyAuthority(null, data.manifest); }
          if (type === 'status') void refreshAuthority({ includeLogs: false }).catch(() => undefined);
        },
        onLog(data, next) { logViewer.append({ ...data, sequence: next, source: data.channel, message: data.line }); },
        onPurged() {
          markPurged();
        },
        recover: () => refreshAuthority({ includeLogs: true }),
      });
      transport.setTerminal(terminal);
    } else {
      const terminalExecution = resolveTerminalState();
      const settled = terminalExecution && SETTLED_FINALIZATION_STATES.has(detail?.finalization?.status);
      transport = createSingleSiteRunPoller({
        window, document,
        poll: ({ signal }) => refreshSingleSiteGeneration(signal),
        onConnection: setConnection,
        initialSettled: settled,
        initialSlow: terminalExecution && !settled,
      });
      transport.setSettled(settled, { pendingFinalization: terminalExecution && !settled });
    }
  }

  async function refreshSingleSiteGeneration(parentSignal) {
    const capture = captureWorkspaceIdentity();
    const refresh = beginAuthorityRefresh(parentSignal);
    const encoded = encodeURIComponent(capture.runId);
    try {
      const [nextSummary, nextDetail, tail] = await Promise.all([
        fetchJson(`/api/console/v1/runs/single-site/${encoded}`, { signal: refresh.signal }),
        fetchJson(`/api/single-site/runs/${encoded}`, { signal: refresh.signal }),
        fetchJson(`/api/single-site/runs/${encoded}/logs?maxBytes=262144`, { signal: refresh.signal }),
      ]);
      assertLatestAuthorityRefresh(refresh, capture);
      if (nextSummary?.data?.record?.mode !== capture.mode || nextSummary?.data?.record?.runId !== capture.runId
        || nextDetail?.id !== capture.runId) throw new Error('Single-site authority identity changed during refresh.');
      assertCoherentAuthority(nextSummary, nextDetail, tail);
      summaryBody = nextSummary;
      detail = nextDetail;
      logViewer.replaceTail(tail.log ?? '', tail);
      applyAuthority(nextSummary, nextDetail);
      return nextDetail.revision;
    } finally {
      refresh.release();
    }
  }

  function retryButton() {
    const button = textElement(document, 'button', 'Retry this region', { type: 'button' });
    button.addEventListener('click', () => void initialLoad());
    return button;
  }

  function renderView() {
    if (!routeState?.valid || !summaryBody || purged) return;
    const view = routeState.state.view ?? 'overview';
    for (const link of navigation.querySelectorAll('[data-run-view-link]')) {
      const selected = link.dataset.runViewLink === view;
      if (selected) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
      link.href = `/run.html?${serializeConsoleUrlState('run', { ...routeState.state, view: link.dataset.runViewLink })}`;
    }
    viewController?.abort();
    viewController = new AbortController();
    viewRegion.dataset.asyncState = authorityPartial ? 'partial' : 'ready';
    if (view === 'overview') renderOverview();
    else if (view === 'logs') {
      viewRegion.replaceChildren(textElement(document, 'h2', 'Logs'), logRoot);
    } else if (view === 'timeline') void renderTimeline(viewController.signal);
    else if (view === 'evidence') void renderEvidence(viewController.signal);
    else if (view === 'report') renderReport();
    else renderReviewDestination(view);
  }

  function renderOverview() {
    const heading = textElement(document, 'h2', 'Run overview');
    const copy = textElement(document, 'p', sharedAuthorityActive
      ? 'Current release authority is revision- and subject-bound. Product Risk remains primary; Pipeline Integrity is adjacent operational context.'
      : currentMode === 'comparative'
      ? 'Comparative release authority remains separate from connection state and diagnostic exit information.'
      : 'Single-site execution, worker activity, deterministic finalization, and advisory outcome remain separate authorities.');
    const pre = textElement(document, 'pre', '', { class: 'run-authority-detail' });
    if (sharedAuthorityActive) {
      const newestCompleted = [...(sharedWorkspace?.executions?.executions ?? [])]
        .filter(({ state }) => ['completed_pass', 'completed_product_failure'].includes(state))
        .at(-1);
      pre.textContent = `Release Decision: ${sharedWorkspace.publication.decision.label}\nCertified authority: ${sharedWorkspace.publication.decision.grantedAuthority}\nDecision revision: ${sharedWorkspace.publication.decisionRevision}\nRun revision: ${sharedWorkspace.publication.runRevision}\nActive tests: ${(sharedWorkspace.executions.executions ?? []).filter(({ state }) => !['completed_pass', 'completed_product_failure', 'incomplete', 'cancelled'].includes(state)).length}\nNewest completion: ${newestCompleted?.id ?? 'none available'}`;
    } else if (currentMode === 'comparative') {
      pre.textContent = `Profile: ${detail?.options?.profile ?? 'unavailable'}\nTargets: ${(detail?.options?.projects ?? []).join(', ') || 'unavailable'}\nPipeline: ${detail?.pipeline?.status ?? 'unavailable'}\nRelease: ${detail?.release?.decision ?? 'unavailable'}\nCommand: ${(detail?.command ?? []).join(' ') || 'unavailable'}`;
    } else {
      pre.textContent = `Deployment role: ${detail?.deploymentRole ?? 'unavailable'}\nTargets: ${(detail?.scope?.selectedTargetIds ?? []).join(', ') || 'unavailable'}\nAttempt: ${detail?.attempt?.number ?? 'unavailable'}\nFinalization: ${detail?.finalization?.status ?? 'unavailable'}\nAdvisory only: yes`;
    }
    viewRegion.replaceChildren(heading, copy, pre);
  }

  function renderReviewDestination(view) {
    const links = document.createElement('div');
    links.className = 'run-destinations';
    for (const [name, href] of Object.entries(resolvedDestinations())) {
      if (href) links.append(textElement(document, 'a', humanize(name), { href, 'data-run-destination': name }));
    }
    viewRegion.replaceChildren(
      textElement(document, 'h2', humanize(view)),
      textElement(document, 'p', `${humanize(view)} records remain source-owned. Use the bounded report or gallery destination; unavailable records are not inferred in this workspace.`),
      links,
    );
  }

  async function renderTimeline(signal, cursor = null, append = false) {
    if (!append) {
      viewRegion.dataset.asyncState = 'initial-loading';
      viewRegion.replaceChildren(textElement(document, 'h2', 'Timeline'), textElement(document, 'p', 'Loading bounded authoritative timeline records…'));
    }
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (routeState.state.stage) query.set('stage', routeState.state.stage);
      if (routeState.state.shard) query.set('shard', routeState.state.shard);
      if (cursor) query.set('cursor', cursor);
      const page = await fetchJson(`/api/console/v1/runs/${encodeURIComponent(currentMode)}/${encodeURIComponent(currentRunId)}/timeline?${query}`, { signal });
      let list = append ? viewRegion.querySelector('.run-timeline-list') : null;
      if (!list) {
        list = document.createElement('ol');
        list.className = 'run-timeline-list';
        viewRegion.replaceChildren(textElement(document, 'h2', 'Timeline'), list);
      }
      for (const record of page.data?.items ?? []) {
        const item = document.createElement('li');
        item.dataset.timelineRecord = record.recordId;
        item.textContent = [
          record.fields?.startedAt ?? record.fields?.sourceTimestamp ?? 'time unknown',
          record.fields?.sourceKind,
          record.fields?.stageId ? `stage ${record.fields.stageId}` : null,
          record.fields?.shardId ? `shard ${record.fields.shardId}` : null,
          Number.isFinite(record.fields?.attemptNumber) ? `attempt ${record.fields.attemptNumber}` : null,
          Number.isFinite(record.fields?.retryNumber) ? `retry ${record.fields.retryNumber}` : null,
          record.fields?.status,
          Number.isFinite(record.fields?.durationMs) ? `${record.fields.durationMs} ms` : null,
        ].filter(Boolean).join(' · ');
        list.append(item);
      }
      trimRenderedWindow(list);
      viewRegion.querySelector('[data-timeline-more]')?.remove();
      if (page.data?.nextCursor) {
        const more = textElement(document, 'button', 'Load more timeline', { type: 'button', 'data-timeline-more': '' });
        more.addEventListener('click', () => void renderTimeline(signal, page.data.nextCursor, true), { once: true });
        viewRegion.append(more);
      }
      viewRegion.dataset.asyncState = page.complete === false ? 'partial' : (page.data?.items?.length ? 'ready' : 'empty-success');
    } catch (error) {
      if (signal.aborted) return;
      if (error?.code === 'CONSOLE_CURSOR_STALE' && cursor) {
        await renderTimeline(signal, null, false);
        return;
      }
      viewRegion.dataset.asyncState = 'retryable-failure';
      viewRegion.append(textElement(document, 'p', `Timeline unavailable: ${error.message}`, { class: 'error-text' }));
    }
  }

  async function renderEvidence(signal) {
    artifactCursor = 0;
    viewRegion.dataset.asyncState = 'initial-loading';
    viewRegion.replaceChildren(textElement(document, 'h2', 'Evidence'), textElement(document, 'p', 'Loading the first bounded artifact page…'));
    try {
      const list = document.createElement('ul');
      list.className = 'run-artifact-list';
      viewRegion.replaceChildren(textElement(document, 'h2', 'Evidence'), list);
      await loadArtifactPage(signal, list);
      const manualAction = currentActionSnapshot().actions.find((action) => action.actionId === 'manualEvidence');
      if (manualAction?.supported === true && manualAction.available === true
        && manualAction.authorized === true && manualAction.eligible === true) {
        viewRegion.append(await createManualEvidenceForm(signal));
      } else if (manualAction?.supported === true) {
        viewRegion.append(textElement(document, 'p', manualAction.unavailableReason ?? 'Manual evidence is not currently eligible for this run.', { class: 'run-region-status' }));
      }
    } catch (error) {
      if (signal.aborted) return;
      viewRegion.dataset.asyncState = 'retryable-failure';
      viewRegion.append(textElement(document, 'p', `Evidence unavailable: ${error.message}`, { class: 'error-text' }));
    }
  }

  async function loadArtifactPage(signal, list) {
    const endpoint = currentMode === 'single-site' ? '/api/single-site/runs' : '/api/runs';
    const page = await fetchJson(`${endpoint}/${encodeURIComponent(currentRunId)}/artifacts?offset=${artifactCursor}&limit=100`, { signal });
    for (const file of page.files ?? []) {
      const href = sameOriginHref(file.url);
      if (!href) continue;
      const item = document.createElement('li');
      const link = textElement(document, 'a', `${file.kind ?? 'file'} · ${file.path ?? 'unnamed'}`, { href, target: '_blank', rel: 'noopener noreferrer' });
      item.append(link);
      list.append(item);
    }
    trimRenderedWindow(list);
    artifactCursor = Number.isSafeInteger(page.nextOffset) ? page.nextOffset : artifactCursor + (page.files?.length ?? 0);
    viewRegion.querySelector('[data-artifact-more]')?.remove();
    if (page.hasMore === true) {
      const more = textElement(document, 'button', 'Load more evidence', { type: 'button', 'data-artifact-more': '' });
      more.addEventListener('click', async () => {
        more.disabled = true;
        try { await loadArtifactPage(signal, list); } catch (error) {
          if (!signal.aborted) viewRegion.append(textElement(document, 'p', `More evidence is unavailable: ${error.message}`, { class: 'error-text' }));
        }
      }, { once: true });
      viewRegion.append(more);
    }
    viewRegion.dataset.asyncState = page.totalComplete === false || page.hasMore === true ? 'partial' : (list.children.length ? 'ready' : 'empty-success');
  }

  async function createManualEvidenceForm(signal) {
    const section = document.createElement('section');
    section.id = 'run-manual-evidence';
    section.append(textElement(document, 'h3', 'Manual evidence'));
    const [configuration, evidence] = await Promise.all([
      fetchJson('/api/config', { signal }),
      fetchJson(`/api/runs/${encodeURIComponent(currentRunId)}/manual-evidence`, { signal }),
    ]);
    section.append(textElement(document, 'p', `${evidence.entries?.length ?? 0} signed entr${evidence.entries?.length === 1 ? 'y' : 'ies'} currently recorded.`));
    const form = document.createElement('form');
    form.className = 'run-manual-form';
    const audit = document.createElement('select');
    for (const entry of configuration.catalog?.filter((item) => item.manual) ?? []) audit.append(textElement(document, 'option', `${entry.id} · ${entry.title}`, { value: entry.id }));
    const outcome = document.createElement('select');
    for (const value of ['pass', 'fail', 'blocked']) outcome.append(textElement(document, 'option', humanize(value), { value }));
    const reviewer = document.createElement('input');
    reviewer.required = true;
    reviewer.minLength = 2;
    const device = document.createElement('input');
    device.required = true;
    device.minLength = 2;
    const notes = document.createElement('textarea');
    notes.required = true;
    notes.minLength = 10;
    const files = document.createElement('input');
    files.type = 'file';
    files.multiple = true;
    files.accept = 'video/webm,video/mp4,image/png,image/jpeg';
    const consent = document.createElement('input');
    consent.type = 'checkbox';
    consent.required = true;
    const consentLabel = textElement(document, 'label', 'I performed this check on the named device and attest that the result, notes, and selected evidence are accurate.');
    consentLabel.className = 'run-manual-consent';
    consentLabel.prepend(consent);
    const submit = textElement(document, 'button', 'Review manual attestation', { type: 'submit' });
    for (const [label, control] of [['Manual audit', audit], ['Outcome', outcome], ['Reviewer', reviewer], ['Device and browser', device], ['Detailed observations', notes], ['Evidence files', files]]) {
      const wrapper = textElement(document, 'label', label);
      wrapper.append(control);
      form.append(wrapper);
    }
    form.append(consentLabel);
    form.append(submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const body = Object.freeze({
        form: Object.freeze({ auditId: audit.value, outcome: outcome.value, reviewer: reviewer.value.trim(), device: device.value.trim(), notes: notes.value.trim(), confirmed: consent.checked }),
        files: Object.freeze([...files.files].map((file) => Object.freeze({ file, idempotencyKey: `manual-${crypto.randomUUID()}` }))),
      });
      actionController.open({
        actionId: 'manualEvidence', label: 'Confirm manual evidence attestation',
        endpoint: `/api/runs/${encodeURIComponent(currentRunId)}/manual-evidence`, method: 'POST', body,
        consequence: `This records the captured ${audit.value} result and rebuilds the checklist. Selected prose and files remain bound to this run only.`,
        submitLabel: 'Upload and record attestation',
      }, submit);
    });
    section.append(form);
    return section;
  }

  function renderReport() {
    const links = resolvedDestinations();
    viewRegion.replaceChildren(textElement(document, 'h2', 'Report'));
    if (links.report) viewRegion.append(textElement(document, 'a', 'Open authoritative report', { href: links.report, 'data-run-destination': 'report' }));
    else {
      viewRegion.dataset.asyncState = 'unavailable';
      viewRegion.append(textElement(document, 'p', 'A report is not available for the current finalization state.'));
    }
  }

  function showInvalidRoute(parsed) {
    transport?.destroy();
    transport = null;
    actionArea.replaceChildren();
    destinations.replaceChildren();
    viewRegion.dataset.asyncState = 'unavailable';
    const details = parsed.errors.map((entry) => entry.key).filter(Boolean).join(', ');
    viewRegion.replaceChildren(
      textElement(document, 'h2', 'Choose a valid run'),
      textElement(document, 'p', `This direct link is missing a valid ${details || 'mode or run identity'}.`),
      textElement(document, 'a', 'Return to Overview', { href: '/' }),
    );
  }

  function switchIdentity(parsed) {
    workspaceGeneration += 1;
    abortAuthorityRefreshes();
    transport?.destroy();
    transport = null;
    viewController?.abort();
    viewController = null;
    actionController.invalidate('The run identity changed. The previous action target is no longer valid.');
    summaryBody = null;
    detail = null;
    purged = false;
    currentMode = parsed.state.mode;
    currentRunId = parsed.state.run;
    sharedWorkspace = null;
    sharedAuthorityActive = false;
    sharedOperationInFlight = null;
    logViewer.setMode(currentMode);
    setText('run-mode', humanize(currentMode));
    setText('run-id', currentRunId);
    void initialLoad();
    if (sharedSessionReady) void loadSharedWorkspace();
  }

  urlState = createConsoleUrlState({
    window,
    routeId: 'run',
    parse: parseConsoleUrlState,
    serialize: serializeConsoleUrlState,
    maximumPushes: 40,
    onRestoreFocus(key) {
      const direct = typeof key === 'string' ? document.getElementById(key) : null;
      if (direct && root.contains(direct)) direct.focus({ preventScroll: true });
      else focus.focus(key, shell.heading);
    },
    onChange(parsed, { source }) {
      const previous = routeState;
      routeState = parsed;
      if (!parsed.valid) return showInvalidRoute(parsed);
      if (previous && source !== 'initial' && previous.search !== parsed.search) {
        actionController.invalidate('URL state changed. Review the action against the current workspace state.');
      }
      logViewer.setFilters({
        search: parsed.state.search,
        source: parsed.state.source,
        stage: parsed.state.stage,
        shard: parsed.state.shard,
      });
      if (parsed.state.mode !== currentMode || parsed.state.run !== currentRunId) switchIdentity(parsed);
      else renderView();
    },
  });

  function handleNavigation(event) {
    const link = event.target.closest('[data-run-view-link]');
    if (!link || !navigation.contains(link) || !routeState?.valid) return;
    event.preventDefault();
    window.history.replaceState({ ...(window.history.state ?? {}), consoleFocusKey: `view-${link.dataset.runViewLink}` }, '', window.location.href);
    urlState.setState({ ...routeState.state, view: link.dataset.runViewLink }, { focusKey: `view-${link.dataset.runViewLink}` });
  }

  navigation.addEventListener('click', handleNavigation);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    workspaceGeneration += 1;
    abortAuthorityRefreshes();
    transport?.destroy();
    viewController?.abort();
    actionController.destroy();
    invalidation.destroy();
    logViewer.destroy();
    urlState.destroy();
    focus.destroy();
    splitter.destroy();
    navigation.removeEventListener('click', handleNavigation);
  }

  window.addEventListener('pagehide', destroy, { once: true });
  window.addEventListener('beforeunload', destroy, { once: true });
  Object.defineProperty(window, '__runWorkspaceDiagnostics', {
    configurable: true,
    get() {
      const log = logViewer.snapshot;
      const action = actionController.snapshot;
      return Object.freeze({
        transport: transport?.diagnostics ?? { eventSources: 0, pollTimers: 0 },
        action: {
          pending: action.pending,
          invalidated: action.invalidated,
          open: action.open,
          bindingFrozen: action.binding ? Object.isFrozen(action.binding) : null,
          bodyFrozen: action.binding ? Object.isFrozen(action.binding.body) : null,
          binding: action.binding ? {
            actionId: action.binding.actionId,
            mode: action.binding.mode,
            runId: action.binding.runId,
            sourceRevision: action.binding.sourceRevision,
            authorityRevision: action.binding.authorityRevision,
          } : null,
        },
        log: { records: log.records.length, bytes: log.bytes, dropped: log.dropped, paused: log.paused, pendingRecords: log.pendingRecords, pendingBytes: log.pendingBytes, pendingDropped: log.pendingDropped },
        identity: currentMode && currentRunId ? `${currentMode}:${currentRunId}` : null,
      });
    },
  });
}
