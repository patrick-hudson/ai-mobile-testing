import {
  createGalleryWorkbench,
  createSingleSiteGalleryWorkbench,
} from './gallery-core.js';
import { createLiveGalleryDataSource } from './gallery-data-source.js';
import { parseConsoleUrlState, serializeConsoleUrlState } from '/console-contracts.mjs';
import { createRunInvalidationBus, publishRunInvalidation } from './console-invalidation.js';
import { createConsoleUrlState } from './console-url-state.js';
import {
  assertSharedWorkspaceProjection,
  createSharedControlBrowserClient,
  orderSharedRisksForReview,
  SharedControlBrowserError,
} from './shared-control-client.js';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$/;
const ITEM_ID = /^gitem_[a-f0-9]{16}$/;
const SINGLE_SITE_ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
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
const SHARED_REFRESH_MS = 5_000;
const TERMINAL_SHARED_EXECUTIONS = new Set(['completed_pass', 'completed_product_failure', 'incomplete', 'cancelled']);

const elements = Object.fromEntries([
  'gallery-back', 'gallery-connection', 'gallery-refresh', 'gallery-run-id', 'gallery-phase', 'gallery-counts',
  'gallery-revision', 'gallery-lifecycle', 'gallery-fatal', 'gallery-fatal-title', 'gallery-fatal-message',
  'gallery-retry', 'gallery-loading', 'gallery-workbench', 'gallery-activity', 'gallery-activity-count',
  'execution-drawer', 'execution-state', 'reload-execution', 'execution-log', 'raw-drawer', 'raw-state',
  'previous-raw', 'load-more-raw', 'raw-files', 'gallery-flag-dialog', 'gallery-flag-form', 'gallery-flag-close',
  'gallery-flag-cancel', 'gallery-reviewer', 'gallery-flag-action', 'gallery-flag-id-field', 'gallery-flag-id',
  'gallery-flag-copy', 'gallery-flag-note', 'gallery-flag-state', 'gallery-flag-submit', 'gallery-announcer',
  'baseline-dialog', 'baseline-form', 'baseline-dialog-title', 'baseline-close', 'baseline-cancel',
  'baseline-dialog-summary', 'baseline-identity', 'baseline-policy', 'baseline-reason', 'baseline-waiver-field',
  'baseline-waiver', 'baseline-confirmation-copy', 'baseline-confirmation', 'baseline-dialog-state', 'baseline-submit',
  'visual-review-dialog', 'visual-review-form', 'visual-review-dialog-title', 'visual-review-close',
  'visual-review-cancel', 'visual-review-identity', 'visual-review-disposition', 'visual-review-rationale',
  'visual-review-confirmation-copy', 'visual-review-confirmation', 'visual-review-dialog-state', 'visual-review-submit',
  'gallery-product-risk', 'gallery-product-risk-title', 'gallery-risk-status', 'gallery-shared-session',
  'gallery-shared-session-status', 'gallery-shared-login', 'gallery-shared-authority',
].map((id) => [id.replaceAll('-', '_'), document.querySelector(`#${id}`)]));

const sharedControl = createSharedControlBrowserClient();
const sharedCredential = elements.gallery_shared_login?.elements.namedItem('gallery-control-credential');

const galleryUrlState = createConsoleUrlState({
  window,
  routeId: 'gallery',
  parse: parseConsoleUrlState,
  serialize: serializeConsoleUrlState,
  onChange(next, { source }) {
    if (source === 'history' && state?.urlSearch !== next.search) window.location.reload();
  },
});
const parsed = parseReviewUrl(galleryUrlState.current);
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
  detailRequests: new Map(),
  acceptedRevisionKey: null,
  flags: null,
  flagAttempt: null,
  flagController: null,
  flagGeneration: 0,
  flagMutationController: null,
  flagMutationGeneration: 0,
  flagCloseTimer: null,
  deltaController: null,
  deltaGeneration: 0,
  flagItemId: null,
  flagOpener: null,
  destroyed: false,
  firstSequence: true,
  initialMemberRestored: false,
  singleSite: null,
  singleSiteEndpoints: null,
  singleSiteMutation: null,
  singleSiteMutationController: null,
  singleSiteReviewMutation: null,
  singleSiteReviewController: null,
  invalidation: null,
  purged: false,
  terminalGeneration: 0,
  urlSearch: galleryUrlState.current.search,
  sharedSessionReady: false,
  sharedWorkspace: null,
  sharedController: null,
  sharedRefreshTimer: null,
};

state.invalidation = createRunInvalidationBus({
  window,
  onInvalidate(detail) {
    if (detail.mode === parsed.runMode && detail.runId === state.runId) {
      terminatePurged('Another console tab permanently purged this run.', { publish: false });
    }
  },
});

init().catch((error) => showFatal(error));

async function init() {
  if (!state.runId) throw new PortalGalleryError(400, 'INVALID_GALLERY_URL', 'Choose a valid run from the release audit console.');
  bindSharedAuthorityEvents();
  await initializeGalleryAuthority();
  if (parsed.runMode === 'single-site') return initSingleSiteGallery();
  const encodedRun = encodeURIComponent(state.runId);
  elements.gallery_run_id.textContent = state.runId;
  document.title = `Run ${state.runId} · Visual evidence gallery`;
  elements.gallery_back.href = state.from === 'report'
    ? `/report.html?mode=comparative&run=${encodedRun}`
    : `/run.html?mode=comparative&run=${encodedRun}&view=evidence`;
  elements.gallery_back.textContent = state.from === 'report' ? '← Run report' : '← Run workspace';
  elements.gallery_reviewer.value = loadReviewerLabel();
  bindPageEvents();

  const adapter = createPortalAdapter(createLiveGalleryDataSource({
    mode: 'comparative', runId: state.runId, requestJson: loggedJson,
  }));
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

function bindSharedAuthorityEvents() {
  elements.gallery_shared_login.addEventListener('submit', (event) => void authorizeSharedGallery(event));
}

async function initializeGalleryAuthority() {
  elements.gallery_product_risk.hidden = false;
  elements.gallery_shared_session.hidden = false;
  elements.gallery_shared_login.hidden = false;
  try {
    await sharedControl.restore();
    state.sharedSessionReady = true;
    elements.gallery_shared_login.hidden = true;
    elements.gallery_shared_session_status.textContent = 'Shared gallery session restored.';
    await loadSharedGalleryAuthority();
  } catch (error) {
    state.sharedSessionReady = false;
    if (sharedControlDisabled(error)) {
      elements.gallery_product_risk.hidden = true;
      elements.gallery_shared_session.hidden = true;
      return;
    }
    elements.gallery_shared_session_status.textContent = error instanceof SharedControlBrowserError && error.status === 401
      ? 'Enter a scoped credential to view shared release authority.'
      : `Shared gallery session unavailable: ${friendlyError(error)}`;
    renderSharedGalleryUnavailable(error);
  }
}

async function authorizeSharedGallery(event) {
  event.preventDefault();
  if (!elements.gallery_shared_login.reportValidity()) return;
  const button = elements.gallery_shared_login.querySelector('button');
  button.disabled = true;
  elements.gallery_shared_session_status.textContent = 'Authorizing gallery access…';
  try {
    await sharedControl.login(sharedCredential.value);
    sharedCredential.value = '';
    state.sharedSessionReady = true;
    elements.gallery_shared_login.hidden = true;
    elements.gallery_shared_session_status.textContent = 'Shared gallery session authorized. Credential discarded from the form.';
    await loadSharedGalleryAuthority({ focus: true });
    await retryGalleryEvidenceAfterAuthorization();
  } catch (error) {
    sharedCredential.value = '';
    elements.gallery_shared_session_status.textContent = `Authorization failed: ${friendlyError(error)}`;
    sharedCredential.focus();
  } finally {
    button.disabled = false;
  }
}

async function retryGalleryEvidenceAfterAuthorization() {
  if (parsed.runMode === 'single-site') {
    await state.singleSite?.load();
    return;
  }
  if (state.workbench) await refreshHead({ initial: !state.head });
}

function sharedControlDisabled(error) {
  return error instanceof SharedControlBrowserError
    && (error.status === 404
      || (error.status === 503 && error.message === 'Shared control API is not enabled.'));
}

async function loadSharedGalleryAuthority({ focus = false } = {}) {
  window.clearTimeout(state.sharedRefreshTimer);
  state.sharedController?.abort();
  const controller = new AbortController();
  state.sharedController = controller;
  elements.gallery_product_risk.hidden = false;
  elements.gallery_product_risk.dataset.riskAvailability = 'LOADING';
  elements.gallery_product_risk.setAttribute('aria-busy', 'true');
  elements.gallery_risk_status.textContent = 'LOADING · Reading one revision-bound publication, execution set, and bounded log view.';
  try {
    const workspace = assertSharedWorkspaceProjection(await sharedControl.readWorkspace(state.runId, {
      signal: controller.signal,
      logLimit: 200,
    }), { runId: state.runId, mode: parsed.runMode });
    if (controller.signal.aborted) return;
    state.sharedWorkspace = workspace;
    renderSharedGalleryAuthority(workspace);
    if (focus) elements.gallery_product_risk_title.focus();
    if (sharedGalleryNeedsRefresh(workspace)) {
      state.sharedRefreshTimer = window.setTimeout(() => void loadSharedGalleryAuthority(), SHARED_REFRESH_MS);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    state.sharedWorkspace = null;
    renderSharedGalleryUnavailable(error);
  } finally {
    if (state.sharedController === controller) state.sharedController = null;
  }
}

function sharedGalleryNeedsRefresh(workspace) {
  return ['LOADING', 'PROVISIONAL'].includes(workspace.riskAvailability)
    || workspace.executions.executions.some(({ state: executionState }) => !TERMINAL_SHARED_EXECUTIONS.has(executionState));
}

function renderSharedGalleryUnavailable(error) {
  const detail = friendlyError(error);
  elements.gallery_product_risk.dataset.riskAvailability = 'UNAVAILABLE';
  elements.gallery_product_risk.setAttribute('aria-busy', 'false');
  elements.gallery_risk_status.textContent = `UNAVAILABLE · ${detail} No no-risk or release-authority claim can be made.`;
  const card = document.createElement('section');
  card.className = 'gallery-authority-unavailable';
  card.append(
    textElement('h3', 'Shared release authority unavailable'),
    textElement('p', 'Historical gallery evidence may remain readable, but it cannot substitute for the current shared publication.'),
  );
  elements.gallery_shared_authority.replaceChildren(card);
  announce(`Shared release authority unavailable. ${detail}`);
}

function renderSharedGalleryAuthority(workspace) {
  const { publication, executions, logs } = workspace;
  const { decision, riskRegister } = publication;
  const availability = riskRegister.availability;
  elements.gallery_product_risk.dataset.riskAvailability = availability;
  elements.gallery_product_risk.setAttribute('aria-busy', String(availability === 'LOADING'));
  elements.gallery_risk_status.textContent = sharedRiskAvailabilityCopy(availability, riskRegister.risks.length);

  const decisionCard = document.createElement('section');
  decisionCard.className = 'gallery-authority-decision';
  const decisionTitle = textElement('h3', decision.label);
  const scope = textElement('p', scopeSummary(decision.certifiedScope));
  scope.id = 'gallery-certified-scope';
  const revisions = textElement('p', `Decision revision ${publication.decisionRevision} · Run revision ${publication.runRevision} · Risk revision ${publication.riskRevision}`);
  revisions.id = 'gallery-authority-revisions';
  decisionCard.append(
    textElement('p', 'Release Decision', 'gallery-authority-eyebrow'),
    decisionTitle,
    textElement('p', `${decision.code ?? decision.label.replaceAll(' ', '_')} · ${decision.grantedAuthority} authority`),
    scope,
    revisions,
    textElement('p', decision.superseded
      ? 'SUPERSEDED · This historical revision cannot authorize release.'
      : 'CURRENT · Bound to the displayed immutable release subject and certified scope.'),
  );

  const register = document.createElement('section');
  register.id = 'gallery-risk-register';
  register.className = 'gallery-risk-register';
  register.append(textElement('h3', 'Risk Register'));
  if (availability === 'EMPTY') {
    register.append(textElement('p', 'The complete register contains no active product risks.'));
  } else if (riskRegister.risks.length === 0) {
    register.append(textElement('p', `${availability} risk data contains no published rows. This is not a no-risk claim.`));
  } else {
    register.append(renderSharedRiskTable(orderSharedRisksForReview(riskRegister.risks)));
  }

  const operations = document.createElement('section');
  operations.className = 'gallery-operation-context';
  operations.append(textElement('h3', 'Live execution and recovery'));
  const active = executions.executions.filter(({ state: executionState }) => !TERMINAL_SHARED_EXECUTIONS.has(executionState));
  const incomplete = executions.executions.filter(({ state: executionState }) => executionState === 'incomplete');
  const executionState = textElement('p', `${active.length} active execution${active.length === 1 ? '' : 's'} · ${incomplete.length} incomplete`);
  executionState.id = 'gallery-execution-state';
  const recovery = textElement('p', incomplete.length > 0
    ? `${incomplete.slice(0, 20).map(({ id }) => id).join(', ')} · incomplete-only rekick available in the run workspace`
    : 'No incomplete executions require rekick.');
  recovery.id = 'gallery-recovery-state';
  const logSummary = textElement('p', `${logs.events.length} bounded operation event${logs.events.length === 1 ? '' : 's'} · ${logs.attemptLogs.length} bounded attempt log row${logs.attemptLogs.length === 1 ? '' : 's'}`);
  operations.append(executionState, recovery, logSummary);

  const actions = document.createElement('div');
  actions.className = 'gallery-authority-actions';
  const workspaceLink = document.createElement('a');
  workspaceLink.href = `/run.html?mode=${encodeURIComponent(parsed.runMode)}&run=${encodeURIComponent(state.runId)}&view=overview`;
  workspaceLink.textContent = 'Open recovery and review controls';
  workspaceLink.className = 'primary-button';
  actions.append(workspaceLink);
  elements.gallery_shared_authority.replaceChildren(decisionCard, register, operations, actions);
  announce(`${decision.label}. Risk Register ${availability}. Run revision ${publication.runRevision}.`);
}

function renderSharedRiskTable(risks) {
  const wrapper = document.createElement('div');
  wrapper.className = 'gallery-risk-table-wrap';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', 'Bounded Product Risk register');
  const table = document.createElement('table');
  table.className = 'gallery-risk-table';
  table.innerHTML = '<thead><tr><th>Risk</th><th>Severity</th><th>Scope</th><th>Review</th><th>Release effect</th><th>Recommended action</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const risk of risks.slice(0, 200)) {
    const row = document.createElement('tr');
    row.dataset.riskIdentity = risk.identity;
    const riskCell = document.createElement('td');
    riskCell.append(textElement('strong', humanize(risk.category)), textElement('span', risk.explanation));
    row.append(
      riskCell,
      textElement('td', String(risk.severity).toUpperCase()),
      textElement('td', scopeSummary(risk.affectedScope ?? risk.scope ?? `${risk.mode ?? parsed.runMode} · ${risk.source.id}`)),
      textElement('td', humanize(risk.reviewState)),
      textElement('td', `${risk.releaseEffect} · never changes the decision`),
      textElement('td', risk.recommendedAction),
    );
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  return wrapper;
}

function sharedRiskAvailabilityCopy(availability, count) {
  if (availability === 'EMPTY') return 'EMPTY · Register complete; no active product risks were published.';
  if (availability === 'AVAILABLE') return `AVAILABLE · ${count} published risk record${count === 1 ? '' : 's'}.`;
  if (availability === 'PROVISIONAL') return `PROVISIONAL · ${count} risk record${count === 1 ? '' : 's'} published; review may change as evidence arrives.`;
  if (availability === 'PARTIAL') return `PARTIAL · ${count} risk record${count === 1 ? '' : 's'} published; missing rows cannot be treated as no risk.`;
  if (availability === 'LOADING') return 'LOADING · The Risk Register is still being assembled; no no-risk claim can be made.';
  return 'UNAVAILABLE · The Risk Register could not be read; no no-risk claim can be made.';
}

function scopeSummary(value) {
  if (Array.isArray(value)) return value.join(', ') || 'No scope values published';
  if (!value || typeof value !== 'object') return String(value ?? 'No certified scope published');
  const values = [
    ...(value.features ?? []).map((entry) => `feature ${entry}`),
    ...(value.definitions ?? []).map((entry) => `definition ${entry}`),
    ...(value.targets ?? []).map((entry) => `target ${entry}`),
    ...(value.knownLimits ?? value.limitations ?? []).map((entry) => `limit ${entry}`),
  ];
  return values.join(' · ') || 'No scope values published';
}

function textElement(tag, value, className = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? '');
  return node;
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
      const workbenchState = state.workbench.getState();
      const headError = new Error(workbenchState.requests?.head?.error ?? 'The visual evidence descriptor is unavailable.');
      if (state.sharedWorkspace && !workbenchState.purged) showEvidenceUnavailable(headError);
      else if (!workbenchState.purged) showFatal(headError);
      else elements.gallery_connection.textContent = 'Run removed';
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
    if (error?.status === 410 || error?.code === 'GALLERY_RUN_PURGED') terminatePurged(friendlyError(error));
    else if (initial && state.sharedWorkspace && error?.status === 404) showEvidenceUnavailable(error);
    else if (initial) showFatal(error); else announce(`Gallery refresh failed. ${friendlyError(error)}`);
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
  if (state.acceptedRevisionKey && revisionKey !== state.acceptedRevisionKey) {
    state.detailCache.clear();
    clearDetailRequests();
  }
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
  const next = { mode: 'comparative', run: state.runId, from: state.from, view: gallery.mode };
  if (gallery.selection.itemId) next.item = gallery.selection.itemId;
  if (gallery.selection.memberId) next.member = gallery.selection.memberId;
  for (const [key, name] of Object.entries(QUERY_NAMES)) {
    if ((gallery.query[key] ?? []).length > 0) next[name] = gallery.query[key];
  }
  next.group = gallery.query.group;
  next.sort = gallery.query.sort;
  if (gallery.query.search) next.q = gallery.query.search;
  next.raw = elements.raw_drawer.open ? '1' : '0';
  const updated = galleryUrlState.replaceState(next);
  state.urlSearch = updated.search;
}

function createPortalAdapter(dataSource) {
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
      return dataSource.loadHead({ signal });
    },
    async loadItems({ query, contentRevision, orderRevision, flagRevision, cursor, limit, anchorItemId, signal }) {
      return dataSource.loadItems({
        query, contentRevision, orderRevision, flagRevision, cursor, limit, anchorItemId, signal,
      });
    },
    async loadItem({ itemId, contentRevision, signal }) {
      const accepted = state.workbench.getState().accepted;
      if (signal.aborted) throw abortError();
      const revision = { ...accepted, contentRevision };
      const key = detailCacheKey(itemId, revision);
      const cached = state.detailCache.get(key);
      if (cached) return cached;
      let pending = state.detailRequests.get(key);
      if (!pending) {
        const controller = new AbortController();
        pending = { controller, consumers: 0, promise: null };
        pending.promise = dataSource.loadItem({
          itemId,
          contentRevision,
          orderRevision: accepted.orderRevision,
          flagRevision: accepted.flagRevision,
          signal: controller.signal,
        }).then((detail) => {
          if (controller.signal.aborted) throw abortError();
          rememberDetail(itemId, detail, revision);
          return detail;
        }).finally(() => {
          if (state.detailRequests.get(key) === pending) state.detailRequests.delete(key);
        });
        state.detailRequests.set(key, pending);
      }
      return consumeDetailRequest(key, pending, signal);
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
    if (!response.ok) throw new PortalGalleryError(
      response.status,
      value?.code ?? value?.error?.code ?? 'GALLERY_REQUEST_FAILED',
      value?.error?.message ?? value?.error ?? value?.message ?? `Request failed with ${response.status}.`,
      value,
    );
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

function consumeDetailRequest(key, pending, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  pending.consumers += 1;
  return new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener('abort', onAbort);
      pending.consumers -= 1;
      if (pending.consumers === 0 && state.detailRequests.get(key) === pending) {
        state.detailRequests.delete(key);
        pending.controller.abort();
      }
    };
    const onAbort = () => {
      release();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.promise.then((detail) => {
      release();
      resolve(detail);
    }, (error) => {
      release();
      reject(error);
    });
  });
}

function clearDetailRequests() {
  for (const pending of state.detailRequests.values()) pending.controller.abort();
  state.detailRequests.clear();
}

function connectGalleryEvents() {
  if (state.purged) return;
  state.stream?.close();
  const suffix = state.eventSequence ? `?after=${state.eventSequence}` : '';
  const stream = new EventSource(`/api/runs/${encodeURIComponent(state.runId)}/gallery/events${suffix}`);
  state.stream = stream;
  stream.onopen = () => activity('SSE', 'gallery stream connected');
  stream.onerror = () => activity('SSE', 'gallery stream reconnecting');
  for (const type of ['gallery', 'gallery-flag', 'snapshot', 'stage', 'status', 'overflow', 'purged']) {
    stream.addEventListener(type, (event) => void onGalleryEvent(type, event));
  }
}

async function onGalleryEvent(type, event) {
  if (state.purged) return;
  state.eventSequence = Math.max(state.eventSequence, Number(event.lastEventId) || 0);
  let data = {};
  try { data = JSON.parse(event.data); } catch { /* keep invalid stream payload out of the UI */ }
  if (type === 'purged') {
    terminatePurged(data?.message ?? 'The run and its evidence were permanently purged.');
    return;
  }
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
    if (error?.name !== 'AbortError' && (error.status === 410 || error.code === 'GALLERY_RUN_PURGED')) terminatePurged(friendlyError(error));
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
  const terminalGeneration = state.terminalGeneration;
  elements.reload_execution.disabled = true;
  elements.execution_state.textContent = 'Loading latest 64 KiB…';
  try {
    const value = await loggedJson(`/api/runs/${encodeURIComponent(state.runId)}/logs?maxBytes=65536`, { activityPath: '/api/runs/:run/logs' });
    if (state.purged || terminalGeneration !== state.terminalGeneration) return;
    elements.execution_log.textContent = String(value.log ?? 'No execution output yet.').slice(-65_536);
    elements.execution_state.textContent = `${formatBytes(elements.execution_log.textContent.length)} shown · sequence ${value.sequence ?? 0}`;
  } catch (error) {
    if (state.purged || terminalGeneration !== state.terminalGeneration) return;
    elements.execution_state.textContent = `Log unavailable: ${friendlyError(error)}`;
  } finally { elements.reload_execution.disabled = state.purged; }
}

async function loadRawFiles({ offset = state.rawOffset } = {}) {
  if (state.rawLoading || (offset === state.rawOffset && !state.rawHasMore)) return;
  const terminalGeneration = state.terminalGeneration;
  state.rawLoading = true;
  elements.load_more_raw.disabled = true;
  elements.raw_state.textContent = 'Loading a bounded raw-file page…';
  try {
    const page = await loggedJson(`/api/runs/${encodeURIComponent(state.runId)}/artifacts?offset=${offset}&limit=100`, {
      activityPath: '/api/runs/:run/artifacts', rowCount: (value) => value.files?.length,
    });
    if (state.purged || terminalGeneration !== state.terminalGeneration) return;
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
    if (state.purged || terminalGeneration !== state.terminalGeneration) return;
    elements.raw_state.textContent = `Raw files unavailable: ${friendlyError(error)}`;
  } finally {
    state.rawLoading = false;
    elements.load_more_raw.disabled = state.purged || !state.rawHasMore;
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
  cancelFlagMutation();
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
  state.flagMutationController?.abort();
  if (state.flagCloseTimer) clearTimeout(state.flagCloseTimer);
  state.flagCloseTimer = null;
  const controller = new AbortController();
  const generation = ++state.flagMutationGeneration;
  const itemId = state.flagItemId;
  state.flagMutationController = controller;
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
      signal: controller.signal,
    });
    if (controller.signal.aborted || generation !== state.flagMutationGeneration
      || state.flagItemId !== itemId || !elements.gallery_flag_dialog.open) return;
    if (!result) throw new Error('The reviewer event was not accepted.');
    await discoverRevision();
    if (controller.signal.aborted || generation !== state.flagMutationGeneration
      || state.flagItemId !== itemId || !elements.gallery_flag_dialog.open) return;
    elements.gallery_flag_state.textContent = result.idempotent ? 'The earlier save was confirmed without creating a duplicate.' : 'Reviewer event saved. Apply the updated order when you are ready.';
    state.flagAttempt = null;
    state.flagCloseTimer = setTimeout(() => {
      state.flagCloseTimer = null;
      if (generation === state.flagMutationGeneration && state.flagItemId === itemId
        && elements.gallery_flag_dialog.open) closeFlagDialog();
    }, 650);
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted || generation !== state.flagMutationGeneration) return;
    if (error.status === 409) {
      elements.gallery_flag_state.textContent = 'The flag history changed. Your text is retained; reload the current issue state, then retry.';
      try { await reloadFlagsKeepingText(); } catch (reloadError) {
        if (reloadError?.name !== 'AbortError') elements.gallery_flag_state.textContent = `Flag conflict reload failed: ${friendlyError(reloadError)} Your text is still retained.`;
      }
    } else elements.gallery_flag_state.textContent = `${friendlyError(error)} You can retry the exact save without creating a duplicate.`;
  } finally {
    if (state.flagMutationController === controller) state.flagMutationController = null;
    if (generation === state.flagMutationGeneration && state.flagItemId === itemId) {
      elements.gallery_flag_submit.disabled = !state.flags?.capability?.mutable;
    }
  }
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
  cancelFlagMutation();
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

function cancelFlagMutation() {
  state.flagMutationController?.abort();
  state.flagMutationController = null;
  state.flagMutationGeneration += 1;
  if (state.flagCloseTimer) clearTimeout(state.flagCloseTimer);
  state.flagCloseTimer = null;
}

async function initSingleSiteGallery() {
  const dataSource = createLiveGalleryDataSource({
    mode: 'single-site', runId: state.runId, requestJson: loggedJson,
  });
  const endpoints = dataSource.endpoints;
  const encodedRun = encodeURIComponent(state.runId);
  document.body.dataset.galleryMode = 'single-site';
  document.title = `Run ${state.runId} · Single-site evidence review`;
  elements.gallery_run_id.textContent = state.runId;
  elements.gallery_back.href = parsed.from === 'report'
    ? `/report.html?mode=single-site&run=${encodedRun}`
    : `/run.html?mode=single-site&run=${encodedRun}&view=evidence`;
  elements.gallery_back.textContent = parsed.from === 'report' ? '← Site Health report' : '← Run workspace';
  elements.gallery_phase.textContent = 'Loading';
  elements.gallery_counts.textContent = 'Loading a bounded evidence index';
  elements.gallery_revision.textContent = 'Not loaded';
  elements.gallery_lifecycle.textContent = 'Loading visual evidence without downloading media bytes…';
  elements.execution_drawer.hidden = true;
  elements.raw_drawer.hidden = true;
  elements.gallery_flag_dialog.hidden = true;

  state.singleSiteEndpoints = endpoints;
  bindSingleSiteMutationDialogs();
  const controller = createSingleSiteGalleryWorkbench(elements.gallery_workbench, {
    dataSource,
    initialState: {
      selectedId: parsed.itemId,
      filters: parsed.singleSiteFilters,
    },
    announce,
    onHead: renderSingleSiteHead,
    onStateChange: updateSingleSiteUrl,
    onStatus({ status, message }) {
      const loading = status === 'loading';
      elements.gallery_refresh.disabled = loading;
      elements.gallery_loading.hidden = !loading;
      elements.gallery_loading.setAttribute('aria-busy', loading ? 'true' : 'false');
      elements.gallery_connection.textContent = message;
      if (status !== 'error') elements.gallery_fatal.hidden = true;
    },
    onFatal(error) {
      if (error?.status === 410 || error?.code === 'GALLERY_RUN_PURGED') terminatePurged(friendlyError(error));
      else if (state.sharedWorkspace) showEvidenceUnavailable(error);
      else showFatal(error);
    },
    resolveMediaUrl: ({ value, item, view }) => safeSingleSiteMediaUrl(value, item, view, endpoints),
    isInteractionBlocked: () => Boolean(elements.baseline_dialog.open || elements.visual_review_dialog.open),
    fullscreen: {
      enter: (node) => node.requestFullscreen(),
      exit: () => document.exitFullscreen(),
      isActive: () => Boolean(document.fullscreenElement),
    },
    onBaselineIntent: ({ operation, item, opener }) => openSingleSiteBaselineDialog(operation, item, opener),
    onVisualReviewIntent: ({ item, opener }) => {
      if (state.sharedSessionReady) {
        announce('Release-changing visual dispositions are available in the revision-bound run workspace.');
        elements.gallery_shared_authority.querySelector('a')?.focus();
        return;
      }
      openSingleSiteVisualReviewDialog(item, opener);
    },
  });
  state.singleSite = controller;
  elements.gallery_refresh.addEventListener('click', () => void controller.load());
  elements.gallery_retry.addEventListener('click', () => void controller.load());
  window.addEventListener('pagehide', destroy);
  await controller.load();
}

function renderSingleSiteHead(head) {
  const counts = head.primaryCounts ?? head.summary ?? {};
  elements.gallery_phase.textContent = humanize(head.phase ?? 'finalized');
  elements.gallery_counts.textContent = `${numberOr(0, counts.total)} logical items · ${numberOr(0, counts.images)} photos · ${numberOr(0, counts.videos)} videos`;
  elements.gallery_revision.textContent = shortRevision(head.publicationRevision ?? head.contentRevision ?? head.publicationDigest);
  elements.gallery_lifecycle.textContent = `${humanize(head.lifecycle?.status ?? head.status ?? 'finalized')} · Visual review is separate from deterministic Findings, Site Health, and promotion authority.`;
}

function updateSingleSiteUrl(gallery = state.singleSite?.getState?.()) {
  if (!gallery) return;
  const next = {
    mode: 'single-site', run: state.runId, from: parsed.from, view: 'workbench',
    review: gallery.filters.scope, finding: gallery.filters.finding,
    coverage: gallery.filters.coverage, visual: gallery.filters.visual,
  };
  if (gallery.selectedId) next.item = gallery.selectedId;
  for (const [key, value] of Object.entries(gallery.filters)) {
    if (['scope', 'query'].includes(key) || !value || value === 'all') continue;
    next[key] = key === 'kind' || key === 'suite' ? [value] : value;
  }
  if (gallery.filters.query) next.q = gallery.filters.query;
  const updated = galleryUrlState.replaceState(next);
  state.urlSearch = updated.search;
}

function bindSingleSiteMutationDialogs() {
  elements.baseline_close.addEventListener('click', closeSingleSiteBaselineDialog);
  elements.baseline_cancel.addEventListener('click', closeSingleSiteBaselineDialog);
  elements.baseline_dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeSingleSiteBaselineDialog();
  });
  elements.baseline_form.addEventListener('input', () => {
    if (state.singleSiteMutation) state.singleSiteMutation.idempotencyKey = null;
  });
  elements.baseline_form.addEventListener('submit', submitSingleSiteBaselineMutation);
  elements.visual_review_close.addEventListener('click', closeSingleSiteVisualReviewDialog);
  elements.visual_review_cancel.addEventListener('click', closeSingleSiteVisualReviewDialog);
  elements.visual_review_dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeSingleSiteVisualReviewDialog();
  });
  elements.visual_review_form.addEventListener('input', () => {
    if (state.singleSiteReviewMutation) state.singleSiteReviewMutation.idempotencyKey = null;
  });
  elements.visual_review_form.addEventListener('submit', submitSingleSiteVisualReview);
}

function openSingleSiteVisualReviewDialog(item, opener) {
  if (item.visualStatus !== 'CHANGED') return;
  state.singleSiteReviewController?.abort();
  state.singleSiteReviewMutation = { item, opener, idempotencyKey: null };
  elements.visual_review_identity.replaceChildren();
  for (const [label, value] of [
    ['Source run', state.runId], ['Evidence item', item.itemId], ['Audit', item.auditId], ['Case', item.caseId],
    ['Route', item.route], ['Target', item.targetId], ['Capture point', item.capturePoint],
    ['Active baseline', item.baseline?.baselineId ?? 'Not recorded'],
  ]) appendDefinition(elements.visual_review_identity, label, value);
  elements.visual_review_disposition.value = 'accepted-change';
  elements.visual_review_rationale.value = '';
  elements.visual_review_confirmation.value = '';
  elements.visual_review_confirmation_copy.textContent = `REVIEW ${item.itemId}`;
  elements.visual_review_dialog_state.textContent = 'Choose a disposition, explain the review, then type the exact confirmation.';
  elements.visual_review_submit.disabled = false;
  elements.visual_review_dialog.removeAttribute('aria-busy');
  if (!elements.visual_review_dialog.open) elements.visual_review_dialog.showModal();
  elements.visual_review_disposition.focus();
}

async function submitSingleSiteVisualReview(event) {
  event.preventDefault();
  const mutation = state.singleSiteReviewMutation;
  if (!mutation || !elements.visual_review_form.reportValidity()) return;
  const confirmation = `REVIEW ${mutation.item.itemId}`;
  if (elements.visual_review_confirmation.value !== confirmation) {
    elements.visual_review_confirmation.setCustomValidity(`Type ${confirmation} exactly.`);
    elements.visual_review_confirmation.reportValidity();
    elements.visual_review_confirmation.setCustomValidity('');
    return;
  }
  const gallery = state.singleSite?.getState();
  if (!Number.isInteger(gallery?.reviewRevision) || !Number.isInteger(gallery?.storeRevision)) {
    elements.visual_review_dialog_state.textContent = 'Current review or baseline revision is unavailable. Refresh the gallery and try again.';
    announce('Visual disposition could not start because current revisions are unavailable.');
    return;
  }
  if (!mutation.idempotencyKey) mutation.idempotencyKey = crypto.randomUUID();
  const body = {
    expectedReviewRevision: gallery.reviewRevision,
    expectedBaselineStoreRevision: gallery.storeRevision,
    disposition: elements.visual_review_disposition.value,
    rationale: elements.visual_review_rationale.value.trim(),
    idempotencyKey: mutation.idempotencyKey,
    confirmation,
  };
  state.singleSiteReviewController?.abort();
  const controller = new AbortController();
  state.singleSiteReviewController = controller;
  elements.visual_review_dialog.setAttribute('aria-busy', 'true');
  elements.visual_review_submit.disabled = true;
  elements.visual_review_dialog_state.textContent = 'Saving one guarded, idempotent visual review event…';
  announce('Saving visual disposition.');
  try {
    await loggedJson(state.singleSiteEndpoints.review(mutation.item.itemId), {
      method: 'POST', body, signal: controller.signal,
      activityPath: '/api/single-site/runs/:run/gallery/items/:item/review',
    });
    if (controller.signal.aborted || state.singleSiteReviewMutation !== mutation) return;
    elements.visual_review_dialog_state.textContent = 'Disposition recorded. Reloading visual review state…';
    announce('Visual disposition recorded. Findings and Site Health are unchanged.');
    closeSingleSiteVisualReviewDialog({ restoreFocus: false });
    await state.singleSite.load({ preferredItemId: mutation.item.itemId, focus: true });
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error.status === 409) {
      mutation.idempotencyKey = null;
      elements.visual_review_dialog_state.textContent = 'Review or baseline history changed. Reloading current evidence before retry…';
      announce('Visual review history changed. Reloading current evidence.');
      const loaded = await state.singleSite.load({ preferredItemId: mutation.item.itemId });
      elements.visual_review_dialog_state.textContent = loaded
        ? 'Current revisions reloaded. Recheck the exact identity and submit again.'
        : 'Current revisions could not be reloaded. Use Refresh and retry.';
    } else {
      elements.visual_review_dialog_state.textContent = `${friendlyError(error)} Your disposition, rationale, and confirmation remain available for retry.`;
      announce(`Visual disposition failed. ${friendlyError(error)}`);
    }
  } finally {
    if (state.singleSiteReviewController === controller) state.singleSiteReviewController = null;
    elements.visual_review_dialog.removeAttribute('aria-busy');
    if (state.singleSiteReviewMutation === mutation) elements.visual_review_submit.disabled = false;
  }
}

function closeSingleSiteVisualReviewDialog({ restoreFocus = true } = {}) {
  state.singleSiteReviewController?.abort();
  state.singleSiteReviewController = null;
  const opener = state.singleSiteReviewMutation?.opener;
  state.singleSiteReviewMutation = null;
  elements.visual_review_dialog.removeAttribute('aria-busy');
  elements.visual_review_dialog_state.textContent = '';
  elements.visual_review_form.reset();
  if (elements.visual_review_dialog.open) elements.visual_review_dialog.close();
  if (restoreFocus) opener?.focus?.();
}

function openSingleSiteBaselineDialog(operation, item, opener) {
  state.singleSiteMutationController?.abort();
  const baselineId = item.baseline?.baselineId ?? null;
  if (['replace', 'revoke', 'delete'].includes(operation) && !baselineId) return;
  state.singleSiteMutation = { operation, item, baselineId, opener, idempotencyKey: null, storeRevision: null };
  elements.baseline_dialog_title.textContent = `${humanize(operation)} visual baseline`;
  elements.baseline_dialog_summary.textContent = baselineMutationSummary(operation);
  elements.baseline_identity.replaceChildren();
  for (const [label, value] of exactIdentityPairs(item)) appendDefinition(elements.baseline_identity, label, value);
  elements.baseline_policy.textContent = operation === 'delete'
    ? 'This deletes retained baseline media but preserves tombstoned provenance, digests, and history. It does not delete the source run.'
    : operation === 'revoke'
      ? 'The baseline stops matching future runs. Its immutable history remains reviewable.'
      : 'The portal records the server-authenticated actor, action time, source run, rationale, and supersession history.';
  const confirmation = baselineConfirmation(operation, item);
  elements.baseline_confirmation_copy.textContent = confirmation;
  elements.baseline_confirmation.value = '';
  elements.baseline_reason.value = '';
  elements.baseline_waiver.value = '';
  const findingWaiver = ['approve', 'replace'].includes(operation) && item.findingCount > 0;
  elements.baseline_waiver_field.hidden = !findingWaiver;
  elements.baseline_waiver.required = findingWaiver;
  elements.baseline_dialog_state.textContent = item.eligible || !['approve', 'replace'].includes(operation)
    ? 'Review the exact identity, provide rationale, then type the confirmation.'
    : `This evidence is not eligible: ${item.ineligibilityReasons.join('; ') || 'eligibility was not established.'}`;
  elements.baseline_submit.disabled = ['approve', 'replace'].includes(operation) && !item.eligible;
  elements.baseline_submit.textContent = `${humanize(operation)} baseline`;
  if (!elements.baseline_dialog.open) elements.baseline_dialog.showModal();
  elements.baseline_reason.focus();
}

async function submitSingleSiteBaselineMutation(event) {
  event.preventDefault();
  const mutation = state.singleSiteMutation;
  if (!mutation || !elements.baseline_form.reportValidity()) return;
  const expected = baselineConfirmation(mutation.operation, mutation.item);
  if (elements.baseline_confirmation.value !== expected) {
    elements.baseline_confirmation.setCustomValidity(`Type ${expected} exactly.`);
    elements.baseline_confirmation.reportValidity();
    elements.baseline_confirmation.setCustomValidity('');
    return;
  }
  let storeRevision = mutation.storeRevision ?? state.singleSite?.getState()?.storeRevision;
  if (!Number.isInteger(storeRevision)) {
    try {
      const result = await refreshSingleSiteBaselineStore(mutation.item);
      storeRevision = integerOrNull(result.storeRevision);
      mutation.storeRevision = storeRevision;
    } catch (error) {
      elements.baseline_dialog_state.textContent = `Could not load the current baseline revision. ${friendlyError(error)}`;
      return;
    }
  }
  if (!mutation.idempotencyKey) mutation.idempotencyKey = crypto.randomUUID();
  const body = {
    expectedStoreRevision: storeRevision,
    reason: elements.baseline_reason.value.trim(),
    idempotencyKey: mutation.idempotencyKey,
    confirmation: expected,
    ...(['approve', 'replace'].includes(mutation.operation) ? {
      runId: state.runId,
      evidenceId: mutation.item.evidenceId,
      ...(mutation.item.findingCount > 0 ? { findingWaiverReason: elements.baseline_waiver.value.trim() } : {}),
    } : {}),
  };
  const endpoints = state.singleSiteEndpoints;
  const url = mutation.operation === 'approve' ? endpoints.approve()
    : mutation.operation === 'replace' ? endpoints.replace(mutation.baselineId)
      : mutation.operation === 'revoke' ? endpoints.revoke(mutation.baselineId)
        : endpoints.delete(mutation.baselineId);
  const method = mutation.operation === 'delete' ? 'DELETE' : 'POST';
  state.singleSiteMutationController?.abort();
  const controller = new AbortController();
  state.singleSiteMutationController = controller;
  elements.baseline_submit.disabled = true;
  elements.baseline_dialog_state.textContent = 'Saving one guarded, idempotent baseline event…';
  try {
    await loggedJson(url, { method, body, signal: controller.signal, activityPath: `/api/single-site/visual-baselines/${mutation.operation}` });
    if (controller.signal.aborted || state.singleSiteMutation !== mutation) return;
    elements.baseline_dialog_state.textContent = `${humanize(mutation.operation)} recorded. Refreshing the exact item state…`;
    announce(`${humanize(mutation.operation)} baseline action recorded.`);
    closeSingleSiteBaselineDialog({ restoreFocus: false });
    await state.singleSite.load({ preferredItemId: mutation.item.itemId, focus: true });
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error.status === 409) {
      mutation.idempotencyKey = null;
      try {
        const result = await refreshSingleSiteBaselineStore(mutation.item);
        mutation.storeRevision = integerOrNull(result.storeRevision);
      } catch { /* Preserve the form and authoritative mutation error. */ }
      elements.baseline_dialog_state.textContent = `Baseline history changed or eligibility was rejected. Current revision reloaded; review the identity and retry. ${friendlyError(error)}`;
    } else elements.baseline_dialog_state.textContent = `${friendlyError(error)} Your rationale and confirmation remain available for retry.`;
    announce(`Baseline action failed. ${friendlyError(error)}`);
  } finally {
    if (state.singleSiteMutationController === controller) state.singleSiteMutationController = null;
    if (state.singleSiteMutation === mutation) elements.baseline_submit.disabled = ['approve', 'replace'].includes(mutation.operation) && !mutation.item.eligible;
  }
}

function refreshSingleSiteBaselineStore(item) {
  const query = new URLSearchParams({ limit: '20' });
  if (item.slotKey) query.set('slotKey', item.slotKey);
  return loggedJson(state.singleSiteEndpoints.baselineCollection(query), {
    activityPath: '/api/single-site/visual-baselines', rowCount: (value) => value.items?.length,
  });
}

function closeSingleSiteBaselineDialog({ restoreFocus = true } = {}) {
  state.singleSiteMutationController?.abort();
  state.singleSiteMutationController = null;
  const opener = state.singleSiteMutation?.opener;
  state.singleSiteMutation = null;
  elements.baseline_dialog_state.textContent = '';
  elements.baseline_form.reset();
  if (elements.baseline_dialog.open) elements.baseline_dialog.close();
  if (restoreFocus) opener?.focus?.();
}

function appendDefinition(list, label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = String(value ?? 'Not recorded');
  list.append(term, description);
}

function exactIdentityPairs(item) {
  const rendering = item.identity.rendering && typeof item.identity.rendering === 'object' ? item.identity.rendering : {};
  const viewport = item.identity.viewport && typeof item.identity.viewport === 'object' ? item.identity.viewport : {};
  return [
    ['Source run', state.runId], ['Evidence ID', item.evidenceId ?? 'Not eligible'], ['Audit definition', item.auditId],
    ['Route', item.route], ['Browser target', item.targetId],
    ['Viewport', viewport.width && viewport.height ? `${viewport.width} × ${viewport.height}` : 'Not recorded'],
    ['Theme', item.theme], ['Capture point', item.capturePoint],
    ['Rendering fingerprint', rendering.fingerprint ?? item.identity.renderingFingerprint ?? 'Not recorded'],
    ['Current media digest', item.current?.sha256 ?? item.evidence?.artifactSha256 ?? 'Not recorded'],
    ['Active baseline', item.baseline?.baselineId ?? 'None'],
  ];
}

function baselineConfirmation(operation, item) {
  if (operation === 'approve') return `APPROVE ${item.evidenceId}`;
  if (operation === 'replace') return `REPLACE ${item.baseline.baselineId} ${item.evidenceId}`;
  if (operation === 'revoke') return `REVOKE ${item.baseline.baselineId}`;
  return `DELETE ${item.baseline.baselineId}`;
}

function baselineMutationSummary(operation) {
  if (operation === 'approve') return 'Approve this exact completed-run image as the first active baseline for its complete visual identity.';
  if (operation === 'replace') return 'Replace the active baseline with this exact completed-run image. The previous record remains in supersession history.';
  if (operation === 'revoke') return 'Revoke this baseline so it no longer matches future captures. Historical provenance remains.';
  return 'Delete retained baseline media while preserving tombstoned provenance and immutable digests.';
}

function safeSingleSiteMediaUrl(value, item, view, endpoints) {
  const fallback = view === 'current' && item.current ? endpoints.currentMedia(item.itemId)
    : view === 'diff' && item.diff ? endpoints.diffMedia(item.itemId)
      : view === 'baseline' && item.baseline?.baselineId ? endpoints.baselineMedia(item.baseline.baselineId)
        : null;
  const candidate = typeof value === 'string' && value ? value : fallback;
  if (!candidate || candidate.includes('\\')) return null;
  let parsedUrl;
  try { parsedUrl = new URL(candidate, location.origin); } catch { return null; }
  if (parsedUrl.origin !== location.origin || parsedUrl.username || parsedUrl.password || parsedUrl.hash) return null;
  if (!parsedUrl.pathname.startsWith('/api/single-site/')) return null;
  return `${parsedUrl.pathname}${parsedUrl.search}`;
}

function integerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function numberOr(fallback, value) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
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

function parseReviewUrl(parsedUrl) {
  const route = parsedUrl?.state ?? {};
  const run = route.run?.trim() ?? '';
  const runMode = route.mode === 'single-site' ? 'single-site' : 'comparative';
  const query = {};
  for (const [name, [key, allowlist]] of Object.entries(FILTERS)) {
    const values = Array.isArray(route[name]) ? route[name] : route[name] ? [route[name]] : [];
    query[key] = [...new Set(values.filter((value) => validUrlValue(value, allowlist)))].slice(0, 20);
  }
  const search = route.q?.replace(/\s+/g, ' ').trim() ?? '';
  query.search = search.length <= 1_200 ? search : '';
  query.group = ['feature', 'technical', 'none'].includes(route.group) ? route.group : 'feature';
  query.sort = ['attention', 'feature', 'technical', 'audit', 'capture-time'].includes(route.sort) ? route.sort : 'attention';
  const member = route.member;
  return {
    runId: RUN_ID.test(run) ? run : null,
    runMode,
    from: ['runs', 'report'].includes(route.from) ? route.from : 'runs',
    mode: route.mode === 'overview' || route.view === 'overview' ? 'overview' : 'workbench',
    itemId: (runMode === 'single-site' ? SINGLE_SITE_ITEM_ID : ITEM_ID).test(route.item ?? '') ? route.item : null,
    memberId: MEMBER_ID.test(member ?? '') ? member : null,
    query,
    singleSiteFilters: {
      scope: route.review === 'all' ? 'all' : 'attention',
      kind: route.kind?.[0] ?? '', suite: route.suite?.[0] ?? '', finding: route.finding ?? 'all',
      coverage: route.coverage ?? 'all', visual: route.visual ?? 'all', query: search,
    },
    raw: route.raw === '1',
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

function showEvidenceUnavailable(error) {
  elements.gallery_loading.hidden = true;
  elements.gallery_fatal.hidden = true;
  elements.gallery_connection.textContent = 'Evidence unavailable';
  elements.gallery_lifecycle.textContent = `The current shared release authority is available, but legacy visual evidence is not: ${friendlyError(error)}`;
  announce(`Product Risk remains available. Visual evidence is unavailable. ${friendlyError(error)}`);
}

function terminatePurged(message, { publish = true } = {}) {
  if (state.purged) return;
  state.purged = true;
  state.terminalGeneration += 1;
  state.deltaGeneration += 1;
  state.flagGeneration += 1;
  state.flagMutationGeneration += 1;
  state.singleSiteMutationController?.abort();
  state.singleSiteReviewController?.abort();
  state.flagController?.abort();
  state.flagMutationController?.abort();
  state.deltaController?.abort();
  state.stream?.close();
  state.stream = null;
  state.logStream?.close();
  state.logStream = null;
  state.singleSite?.destroy?.();
  state.singleSite = null;
  state.workbench?.destroy?.();
  state.workbench = null;
  clearDetailRequests();
  state.detailCache.clear();
  elements.gallery_workbench.replaceChildren();
  elements.execution_log.replaceChildren();
  elements.raw_files.replaceChildren();
  elements.gallery_refresh.disabled = true;
  elements.reload_execution.disabled = true;
  elements.load_more_raw.disabled = true;
  elements.gallery_retry.hidden = true;
  for (const dialog of [elements.gallery_flag_dialog, elements.baseline_dialog, elements.visual_review_dialog]) {
    if (dialog?.open) dialog.close();
  }
  showFatal(new PortalGalleryError(410, 'GALLERY_RUN_PURGED', message || 'The run and its evidence were permanently purged.'));
  if (publish) publishRunInvalidation({ window, mode: parsed.runMode, runId: state.runId, reason: 'purged' });
}

function destroy() {
  state.destroyed = true;
  state.terminalGeneration += 1;
  state.singleSiteMutationController?.abort();
  state.singleSiteReviewController?.abort();
  state.sharedController?.abort();
  window.clearTimeout(state.sharedRefreshTimer);
  state.singleSite?.destroy?.();
  cancelFlagMutation();
  state.flagController?.abort();
  state.deltaController?.abort();
  state.stream?.close();
  state.logStream?.close();
  state.workbench?.destroy();
  clearDetailRequests();
  state.invalidation?.destroy();
  galleryUrlState.destroy();
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
