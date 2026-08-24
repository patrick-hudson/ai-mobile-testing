const state = {
  config: null,
  runs: [],
  activeRunId: null,
  selectedAuditIds: new Set(),
  events: null,
  poll: null,
  pending: new Set(),
  openingRunId: null,
  openController: null,
  openRequest: 0,
  overflowController: null,
  overflowGeneration: 0,
  liveLogBatch: { lines: [], characters: 0, dropped: 0, timer: null, runId: null, progress: null, phase: null },
  keySettings: { known: false, configured: false, fingerprint: null, storageEnabled: false, unavailableReason: null },
  keyDeleteArmed: false,
  keyDeleteTimer: null,
  artifactPage: { runId: null, nextOffset: 0, total: 0 },
};

const elements = {
  form: document.querySelector('#launch-form'),
  launchRun: document.querySelector('#launch-run'),
  systemStatus: document.querySelector('#system-status'),
  statusWrap: document.querySelector('.system-status'),
  catalogSummary: document.querySelector('#catalog-summary'),
  productionUrl: document.querySelector('#production-url'),
  candidateUrl: document.querySelector('#candidate-url'),
  candidateIgnoreTls: document.querySelector('#candidate-ignore-tls'),
  projects: document.querySelector('#project-options'),
  plugins: document.querySelector('#plugin-options'),
  targetControls: document.querySelector('#target-controls'),
  areas: document.querySelector('#area-options'),
  audits: document.querySelector('#audit-options'),
  auditFilter: document.querySelector('#audit-filter'),
  selectedCount: document.querySelector('#selected-count'),
  clearAreas: document.querySelector('#clear-areas'),
  aiReview: document.querySelector('#ai-review'),
  aiReviewCard: document.querySelector('#ai-review-card'),
  aiReviewHelp: document.querySelector('#ai-review-help'),
  aiModel: document.querySelector('#ai-model'),
  keySettings: document.querySelector('#anthropic-key-settings'),
  keyState: document.querySelector('#anthropic-key-state'),
  keyInput: document.querySelector('#anthropic-key-input'),
  saveKey: document.querySelector('#save-anthropic-key'),
  deleteKey: document.querySelector('#delete-anthropic-key'),
  keyMessage: document.querySelector('#anthropic-key-message'),
  formMessage: document.querySelector('#form-message'),
  runsPanel: document.querySelector('#runs-panel'),
  runsStatus: document.querySelector('#runs-status'),
  runList: document.querySelector('#run-list'),
  refreshRuns: document.querySelector('#refresh-runs'),
  runDialog: document.querySelector('#run-dialog'),
  dialogTitle: document.querySelector('#dialog-title'),
  dialogStatus: document.querySelector('#dialog-status'),
  progressTrack: document.querySelector('#progress-track'),
  progressBar: document.querySelector('#progress-bar'),
  runDetails: document.querySelector('#run-details'),
  detailScope: document.querySelector('#detail-scope'),
  detailProjects: document.querySelector('#detail-projects'),
  detailProduction: document.querySelector('#detail-production'),
  detailCandidate: document.querySelector('#detail-candidate'),
  detailTls: document.querySelector('#detail-tls'),
  detailStarted: document.querySelector('#detail-started'),
  detailElapsed: document.querySelector('#detail-elapsed'),
  detailExit: document.querySelector('#detail-exit'),
  detailPipeline: document.querySelector('#detail-pipeline'),
  detailRelease: document.querySelector('#detail-release'),
  detailCommand: document.querySelector('#detail-command'),
  stopRun: document.querySelector('#stop-run'),
  purgeRun: document.querySelector('#purge-run'),
  purgeConfirmation: document.querySelector('#purge-confirmation'),
  purgeExpected: document.querySelector('#purge-expected'),
  purgeConfirmationInput: document.querySelector('#purge-confirmation-input'),
  cancelPurge: document.querySelector('#cancel-purge'),
  confirmPurge: document.querySelector('#confirm-purge'),
  purgeMessage: document.querySelector('#purge-message'),
  openRunReport: document.querySelector('#open-run-report'),
  openRunGallery: document.querySelector('#open-run-gallery'),
  openChecklist: document.querySelector('#open-checklist'),
  openReport: document.querySelector('#open-report'),
  openAiReview: document.querySelector('#open-ai-review'),
  stageList: document.querySelector('#stage-list'),
  manualSection: document.querySelector('#manual-evidence-section'),
  manualLoadStatus: document.querySelector('#manual-load-status'),
  manualForm: document.querySelector('#manual-evidence-form'),
  manualAudit: document.querySelector('#manual-audit'),
  manualOutcome: document.querySelector('#manual-outcome'),
  manualReviewer: document.querySelector('#manual-reviewer'),
  manualDevice: document.querySelector('#manual-device'),
  manualNotes: document.querySelector('#manual-notes'),
  manualFiles: document.querySelector('#manual-files'),
  manualConfirm: document.querySelector('#manual-confirm'),
  manualMessage: document.querySelector('#manual-message'),
  saveManualEvidence: document.querySelector('#save-manual-evidence'),
  manualSummary: document.querySelector('#manual-evidence-summary'),
  closeDialog: document.querySelector('#close-dialog'),
  liveLog: document.querySelector('#live-log'),
  artifactStatus: document.querySelector('#artifact-status'),
  artifactList: document.querySelector('#artifact-list'),
  loadMoreArtifacts: document.querySelector('#load-more-artifacts'),
  runTemplate: document.querySelector('#run-card-template'),
  globalAnnouncer: document.querySelector('#global-announcer'),
};

init().catch((error) => {
  const message = friendlyError(error);
  setConnectionError(message);
  setRegionBusy(elements.runsPanel, false);
  setRegionBusy(elements.keySettings, false);
  elements.runList.innerHTML = `<p class="empty-state error-state">${escapeHtml(message)}</p>`;
  elements.runsStatus.textContent = 'Portal configuration failed to load.';
  elements.keyState.textContent = 'Status unavailable';
  elements.keyState.className = 'settings-state error';
  elements.keyMessage.classList.add('error');
  elements.keyMessage.textContent = 'Key settings are unavailable until the portal reconnects.';
  elements.launchRun.disabled = true;
  elements.saveKey.disabled = true;
  elements.deleteKey.disabled = true;
  announce(`Portal configuration failed to load. ${message}`);
});

async function init() {
  state.config = await fetchJson('/api/config');
  setConnectionReady();
  elements.productionUrl.value = state.config.defaults.productionUrl;
  elements.candidateUrl.value = state.config.defaults.candidateUrl;
  elements.candidateIgnoreTls.checked = state.config.defaults.candidateIgnoreHTTPSErrors;
  elements.aiModel.value = state.config.aiReview.defaultModel;
  updateAiAvailability();
  elements.catalogSummary.textContent = `${state.config.catalog.length} documented checks`;
  renderProjects();
  renderPlugins();
  renderAreas();
  renderAudits();
  renderManualAudits();
  bindEvents();
  await Promise.all([loadRuns({ initial: true }), loadAnthropicKeySettings()]);
  window.setInterval(refreshElapsedTime, 1_000);
}

function bindEvents() {
  elements.form.addEventListener('submit', launchRun);
  elements.refreshRuns.addEventListener('click', () => void loadRuns({ userInitiated: true }));
  elements.auditFilter.addEventListener('input', renderAudits);
  elements.clearAreas.addEventListener('click', () => {
    elements.areas.querySelectorAll('input').forEach((input) => { input.checked = false; });
    updateSelectedCount();
  });
  elements.form.addEventListener('change', (event) => {
    if (event.target.name === 'scope') {
      elements.targetControls.hidden = event.target.value === 'all';
      if (event.target.value === 'all') resetDefaultTargets();
    }
    if (event.target.name === 'profile' && event.target.value === 'release' && elements.form.elements.scope.value === 'all') {
      resetDefaultTargets();
    }
    updateSelectedCount();
  });
  elements.closeDialog.addEventListener('click', closeDialog);
  elements.runDialog.addEventListener('close', () => closeEventStream());
  elements.stopRun.addEventListener('click', stopActiveRun);
  elements.purgeRun.addEventListener('click', showPurgeConfirmation);
  elements.cancelPurge.addEventListener('click', clearPurgeConfirmation);
  elements.confirmPurge.addEventListener('click', purgeActiveRun);
  elements.purgeConfirmationInput.addEventListener('input', updatePurgeConfirmation);
  elements.manualForm.addEventListener('submit', saveManualEvidence);
  elements.saveKey.addEventListener('click', saveAnthropicKey);
  elements.deleteKey.addEventListener('click', deleteAnthropicKey);
  elements.loadMoreArtifacts.addEventListener('click', () => {
    if (state.activeRunId) void loadArtifacts(state.activeRunId, { append: true });
  });
  document.addEventListener('visibilitychange', () => {
    scheduleRunsPoll();
    if (document.visibilityState === 'visible') void loadRuns({ background: true });
  });
  elements.keyInput.addEventListener('input', () => {
    clearKeyDeleteConfirmation();
    elements.keyMessage.textContent = '';
    elements.keyMessage.classList.remove('error', 'success');
  });
}

function resetDefaultTargets() {
  elements.projects.querySelectorAll('input[name="targetId"]').forEach((input) => {
    input.checked = !input.disabled && input.dataset.defaultSelected === 'true';
  });
}

function renderManualAudits() {
  const manualAudits = state.config.catalog.filter(({ manual }) => manual);
  elements.manualAudit.replaceChildren();
  for (const audit of manualAudits) {
    const option = document.createElement('option');
    option.value = audit.id;
    option.textContent = `${audit.id} · ${audit.title}`;
    elements.manualAudit.append(option);
  }
}

function renderProjects() {
  elements.projects.replaceChildren();
  const addHeading = (copy) => {
    const heading = document.createElement('p');
    heading.className = 'target-group-heading muted';
    heading.textContent = copy;
    elements.projects.append(heading);
  };
  const renderTarget = (project, providerOnly = false) => {
    const label = document.createElement('label');
    label.className = `choice-card${project.available ? '' : ' unavailable-target'}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'targetId';
    input.value = project.id;
    input.checked = project.available && project.defaultSelected;
    input.disabled = !project.available;
    input.dataset.defaultSelected = String(project.defaultSelected === true);
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = project.label;
    const detail = document.createElement('small');
    detail.textContent = project.available
      ? `${humanize(project.fidelity)} · ${project.qualification}`
      : `Unavailable${providerOnly ? ' · provider adapter required' : ''} · ${project.unavailableReason ?? project.qualification}`;
    copy.append(title, detail);
    label.append(input, copy);
    elements.projects.append(label);
  };
  addHeading('Docker-local browser and device-emulation targets');
  state.config.targets.localTargets.forEach((target) => renderTarget(target));
  addHeading('Real-device provider targets · shown for planning only');
  state.config.targets.providerTargets.forEach((target) => renderTarget(target, true));
}

function renderAreas() {
  const areas = [...new Set(state.config.catalog.map(({ area }) => area))].sort();
  for (const area of areas) {
    const label = document.createElement('label');
    label.className = 'pill';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'area';
    input.value = area;
    const copy = document.createElement('span');
    copy.textContent = humanize(area);
    label.append(input, copy);
    elements.areas.append(label);
  }
}

function renderPlugins() {
  for (const plugin of state.config.plugins) {
    const label = document.createElement('label');
    label.className = 'choice-card';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'pluginId';
    input.value = plugin.id;
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = plugin.name;
    const detail = document.createElement('small');
    detail.textContent = `${plugin.auditDefinitions.length} checks · ${plugin.description}`;
    copy.append(title, detail);
    label.append(input, copy);
    elements.plugins.append(label);
  }
}

function renderAudits() {
  const query = elements.auditFilter.value.trim().toLowerCase();
  elements.audits.replaceChildren();
  const matches = state.config.catalog.filter(({ id, area, title }) =>
    !query || `${id} ${area} ${title}`.toLowerCase().includes(query));
  for (const audit of matches) {
    const label = document.createElement('label');
    label.className = 'audit-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'auditId';
    input.value = audit.id;
    input.checked = state.selectedAuditIds.has(audit.id);
    input.addEventListener('change', () => {
      if (input.checked) state.selectedAuditIds.add(audit.id);
      else state.selectedAuditIds.delete(audit.id);
      updateSelectedCount();
    });
    const id = document.createElement('code');
    id.textContent = audit.id;
    const title = document.createElement('span');
    title.textContent = audit.title;
    label.append(input, id, title);
    elements.audits.append(label);
  }
  updateSelectedCount();
}

async function launchRun(event) {
  event.preventDefault();
  if (!beginOperation('launch')) return;
  const targeted = elements.form.elements.scope.value === 'targeted';
  const body = {
    profile: elements.form.elements.profile.value,
    targetIds: checkedValues('targetId'),
    pluginIds: targeted ? checkedValues('pluginId') : [],
    areas: targeted ? checkedValues('area') : [],
    auditIds: targeted ? [...state.selectedAuditIds] : [],
    productionUrl: elements.productionUrl.value,
    candidateUrl: elements.candidateUrl.value,
    candidateIgnoreHTTPSErrors: elements.candidateIgnoreTls.checked,
    aiReview: elements.aiReview.checked,
    aiModel: elements.aiModel.value,
  };
  if (targeted && body.pluginIds.length === 0 && body.areas.length === 0 && body.auditIds.length === 0) {
    endOperation('launch');
    return showFormMessage('Choose at least one installed suite, audit area, or individual check.', true);
  }
  setRegionBusy(elements.form, true);
  setButtonBusy(elements.launchRun, true, 'Launching…');
  showFormMessage('Starting the audit and preparing its evidence directory…');
  announce('Starting the audit.');
  try {
    const run = await fetchJson('/api/runs', { method: 'POST', body: JSON.stringify(body), timeoutMs: 45_000 });
    showFormMessage(`Run ${run.id} started.`);
    announce(`Audit run ${run.id} started.`);
    await loadRuns({ background: true });
    void openRun(run.id);
  } catch (error) {
    const message = friendlyError(error);
    showFormMessage(message, true);
    announce(`Audit could not start. ${message}`);
  } finally {
    setButtonBusy(elements.launchRun, false);
    setRegionBusy(elements.form, false);
    endOperation('launch');
  }
}

async function loadRuns({ initial = false, userInitiated = false, background = false } = {}) {
  if (!beginOperation('runs')) {
    if (userInitiated) {
      elements.runsStatus.textContent = 'A refresh is already in progress.';
      announce('Run list refresh is already in progress.');
    }
    // A timer can fire while a user refresh is in flight. Keep exactly one
    // future poll armed instead of letting that harmless overlap stop polling.
    scheduleRunsPoll();
    return;
  }
  setRegionBusy(elements.runsPanel, true);
  if (initial || state.runs.length === 0) renderRunSkeleton();
  if (initial) elements.runsStatus.textContent = 'Loading runs…';
  if (userInitiated) {
    elements.runsStatus.textContent = 'Refreshing…';
    setButtonBusy(elements.refreshRuns, true, 'Refreshing…');
  }
  try {
    state.runs = (await fetchJson('/api/runs')).runs;
    renderRuns();
    setConnectionReady();
    if (!background || userInitiated) {
      elements.runsStatus.textContent = `${state.runs.length} run${state.runs.length === 1 ? '' : 's'} loaded.`;
    }
    if (userInitiated) announce('Run list refreshed.');
    if (state.activeRunId) {
      const run = state.runs.find(({ id }) => id === state.activeRunId);
      if (run) updateRunDialog(run);
    }
  } catch (error) {
    const message = friendlyError(error);
    setConnectionError(message);
    elements.runsStatus.textContent = `Refresh failed: ${message}`;
    elements.runsStatus.classList.add('error-text');
    if (initial) elements.runList.innerHTML = `<p class="empty-state error-state">Could not load runs. ${escapeHtml(message)}</p>`;
    if (userInitiated) announce(`Run list refresh failed. ${message}`);
  } finally {
    setRegionBusy(elements.runsPanel, false);
    if (userInitiated) setButtonBusy(elements.refreshRuns, false);
    endOperation('runs');
    scheduleRunsPoll();
  }
}

function scheduleRunsPoll() {
  if (state.poll) window.clearTimeout(state.poll);
  const hasActiveRun = state.runs.some(({ status }) => ['starting', 'running'].includes(status));
  const delay = document.visibilityState === 'visible' && hasActiveRun ? 2_000 : 30_000;
  state.poll = window.setTimeout(() => {
    state.poll = null;
    void loadRuns({ background: true });
  }, delay);
}

function renderRunSkeleton() {
  elements.runList.innerHTML = '<div class="skeleton-list" aria-hidden="true"><span></span><span></span><span></span></div>';
}

function renderRuns() {
  elements.runList.replaceChildren();
  if (state.runs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No audit runs yet.';
    return elements.runList.append(empty);
  }
  for (const run of state.runs) {
    const card = elements.runTemplate.content.cloneNode(true);
    card.querySelector('.run-state').classList.add(run.status);
    const sourceLabel = run.externalManaged ? 'External sharded release' : humanize(run.options.profile);
    card.querySelector('.run-title').textContent = `${sourceLabel} · ${run.options.projects.length} project${run.options.projects.length === 1 ? '' : 's'}`;
    card.querySelector('.run-meta').textContent = `${formatDate(run.createdAt)} · ${run.options.auditIds.length ? `${run.options.auditIds.length} targeted checks` : 'all checks'}`;
    const status = humanize(run.status);
    const result = runResult(run);
    card.querySelector('.run-result').textContent = result === status ? status : `${status} · ${result}`;
    const button = card.querySelector('button');
    const isOpening = state.openingRunId === run.id;
    button.disabled = isOpening;
    button.classList.toggle('is-loading', isOpening);
    button.setAttribute('aria-label', `${isOpening ? 'Loading' : 'Open'} ${humanize(run.options.profile)} audit from ${formatDate(run.createdAt)}; status ${status}`);
    button.addEventListener('click', () => void openRun(run.id));
    const gallery = card.querySelector('.run-gallery-link');
    gallery.href = `/gallery.html?run=${encodeURIComponent(run.id)}&from=runs`;
    gallery.setAttribute('aria-label', `Open visual evidence gallery for run ${run.id}`);
    elements.runList.append(card);
  }
}

async function openRun(id) {
  if (state.openingRunId === id || state.pending.has(`open:${id}`)) {
    announce('Those run details are already loading.');
    return;
  }
  state.openController?.abort();
  closeEventStream({ clearActive: false });
  const controller = new AbortController();
  const requestId = ++state.openRequest;
  state.openController = controller;
  state.openingRunId = id;
  state.activeRunId = id;
  beginOperation(`open:${id}`);
  renderRuns();
  prepareRunDialog();
  if (!elements.runDialog.open) elements.runDialog.showModal();
  announce('Loading run details and evidence.');
  try {
    const encodedId = encodeURIComponent(id);
    const [run, history] = await Promise.all([
      fetchJson(`/api/runs/${encodedId}`, { signal: controller.signal }),
      fetchJson(`/api/runs/${encodedId}/logs?maxBytes=262144`, { signal: controller.signal }),
    ]);
    if (controller.signal.aborted || requestId !== state.openRequest || state.activeRunId !== id) return;
    resetLiveLog(history.log || 'No log output yet.', id);
    elements.liveLog.scrollTop = elements.liveLog.scrollHeight;
    updateRunDialog(run);
    connectEventStream(id, history.sequence);
    await Promise.all([loadArtifacts(id), loadManualEvidence(id)]);
    if (state.activeRunId === id) announce(`Run ${id} details and evidence loaded.`);
  } catch (error) {
    if (controller.signal.aborted) return;
    const message = friendlyError(error);
    elements.dialogTitle.textContent = 'Run unavailable';
    elements.dialogStatus.textContent = `Could not load this run. ${message}`;
    elements.dialogStatus.classList.add('error-text');
    elements.liveLog.textContent = `Run details could not be loaded: ${message}`;
    elements.artifactList.innerHTML = `<p class="error-state">Evidence unavailable: ${escapeHtml(message)}</p>`;
    elements.artifactStatus.textContent = 'Load failed';
    announce(`Run details failed to load. ${message}`);
  } finally {
    if (requestId === state.openRequest) {
      setRegionBusy(elements.runDialog, false);
      setRegionBusy(elements.runDetails, false);
      state.openController = null;
      state.openingRunId = null;
      renderRuns();
    }
    endOperation(`open:${id}`);
  }
}

function prepareRunDialog() {
  setRegionBusy(elements.runDialog, true);
  setRegionBusy(elements.runDetails, true);
  elements.dialogTitle.textContent = 'Loading audit run';
  elements.dialogStatus.classList.remove('error-text');
  elements.dialogStatus.textContent = 'Loading run details, output, and evidence…';
  elements.progressTrack.classList.add('indeterminate');
  elements.progressTrack.removeAttribute('aria-valuenow');
  elements.progressTrack.setAttribute('aria-valuetext', 'Loading run progress');
  elements.progressBar.style.width = '36%';
  [elements.detailScope, elements.detailProjects, elements.detailTls, elements.detailStarted, elements.detailElapsed, elements.detailExit, elements.detailPipeline, elements.detailRelease, elements.detailCommand]
    .forEach((element) => { element.textContent = 'Loading…'; });
  clearTargetLink(elements.detailProduction);
  clearTargetLink(elements.detailCandidate);
  elements.stopRun.hidden = true;
  elements.purgeRun.hidden = true;
  clearPurgeConfirmation();
  elements.openRunReport.hidden = true;
  elements.openRunGallery.href = `/gallery.html?run=${encodeURIComponent(state.activeRunId)}&from=runs`;
  elements.openRunGallery.hidden = false;
  clearReportLink(elements.openChecklist);
  clearReportLink(elements.openReport);
  clearReportLink(elements.openAiReview);
  elements.stageList.innerHTML = '<div class="skeleton-lines" aria-hidden="true"><span></span><span></span></div>';
  elements.liveLog.textContent = 'Loading run output…';
  elements.artifactStatus.textContent = 'Loading evidence…';
  elements.loadMoreArtifacts.hidden = true;
  state.artifactPage = { runId: state.activeRunId, nextOffset: 0, total: 0 };
  renderArtifactSkeleton();
  elements.manualSection.hidden = true;
}

function updateRunDialog(run) {
  if (run.id && state.activeRunId && run.id !== state.activeRunId) return;
  elements.dialogTitle.textContent = run.externalManaged ? 'External sharded release audit' : `${humanize(run.options.profile)} audit`;
  elements.dialogStatus.classList.remove('error-text');
  elements.dialogStatus.textContent = `${run.phase ?? humanize(run.status)} · ${runResult(run)} · ${run.id}`;
  const { total, completed } = run.progress;
  if (total) {
    const percent = Math.min(100, Math.round((completed / total) * 100));
    elements.progressTrack.classList.remove('indeterminate');
    elements.progressTrack.setAttribute('aria-valuenow', String(percent));
    elements.progressTrack.setAttribute('aria-valuetext', `${completed} of ${total} tests complete`);
    elements.progressBar.style.width = `${percent}%`;
  } else if (['starting', 'running'].includes(run.status)) {
    elements.progressTrack.classList.add('indeterminate');
    elements.progressTrack.removeAttribute('aria-valuenow');
    elements.progressTrack.setAttribute('aria-valuetext', 'Preparing tests');
  } else {
    elements.progressTrack.classList.remove('indeterminate');
    elements.progressTrack.setAttribute('aria-valuenow', '0');
    elements.progressTrack.setAttribute('aria-valuetext', 'No browser tests were counted');
    elements.progressBar.style.width = '0%';
  }
  elements.detailScope.textContent = run.options.auditIds.length
    ? `${run.options.auditIds.length} checks${run.options.pluginIds?.length ? ` from ${run.options.pluginIds.join(', ')}` : ''}: ${run.options.auditIds.join(', ')}`
    : `Every check in the ${run.options.profile} profile`;
  elements.detailProjects.textContent = run.options.projects.join(', ');
  setTargetLink(elements.detailProduction, run.options.productionUrl);
  setTargetLink(elements.detailCandidate, run.options.candidateUrl);
  elements.detailTls.textContent = run.options.candidateIgnoreHTTPSErrors
    ? 'Production strict · candidate certificate errors ignored for development'
    : 'Strict certificate validation for production and candidate';
  elements.detailStarted.textContent = run.startedAt ? formatDate(run.startedAt) : 'Not started';
  elements.detailElapsed.dataset.startedAt = run.startedAt ?? '';
  elements.detailElapsed.dataset.finishedAt = run.finishedAt ?? '';
  elements.detailElapsed.textContent = elapsedLabel(run.startedAt, run.finishedAt);
  elements.detailExit.textContent = run.exitCode === null
    ? run.signal ?? (['starting', 'running'].includes(run.status) ? 'Still running' : humanize(run.status))
    : `Code ${run.exitCode}${run.signal ? ` · ${run.signal}` : ''}`;
  elements.detailPipeline.textContent = run.pipeline
    ? `${humanize(run.pipeline.status)} · ${run.pipeline.reason}`
    : 'No pipeline record is available';
  elements.detailRelease.textContent = run.release
    ? `${run.release.decision.replace('_', ' ')} · ${run.release.reason}${run.reviewReasons?.length ? ` · Signoff withheld: ${run.reviewReasons.join('; ')}` : ''}`
    : 'No release decision is available';
  elements.detailCommand.textContent = run.command.join(' ');
  renderStages(run.stages ?? {});
  const active = ['starting', 'running'].includes(run.status) && !run.stopRequestedAt;
  elements.stopRun.hidden = !active || run.externalManaged;
  elements.stopRun.disabled = !active || state.pending.has('stop');
  const purgeEligible = Boolean(run.purge?.eligible) && !active;
  elements.purgeRun.hidden = !purgeEligible;
  elements.purgeRun.disabled = !purgeEligible || state.pending.has('purge');
  elements.purgeRun.dataset.confirmation = run.purge?.confirmation ?? `PURGE ${run.id}`;
  if (!purgeEligible) clearPurgeConfirmation();
  elements.openRunReport.href = `/report.html?run=${encodeURIComponent(run.id)}`;
  elements.openRunReport.hidden = false;
  elements.openRunGallery.href = `/gallery.html?run=${encodeURIComponent(run.id)}&from=runs`;
  elements.openRunGallery.hidden = false;
  elements.manualSection.hidden = active || run.externalManaged || state.config.catalog.every(({ manual }) => !manual);
}

async function loadManualEvidence(id) {
  const key = `manual-load:${id}`;
  if (!beginOperation(key)) return;
  if (state.activeRunId === id) {
    setRegionBusy(elements.manualSection, true);
    setRegionBusy(elements.manualSummary, true);
    elements.manualSummary.classList.remove('error-state');
    elements.manualLoadStatus.textContent = 'Loading signed evidence…';
    elements.manualSummary.innerHTML = '<div class="skeleton-lines" aria-hidden="true"><span></span><span></span></div>';
  }
  try {
    const evidence = await fetchJson(`/api/runs/${encodeURIComponent(id)}/manual-evidence`);
    if (state.activeRunId !== id) return;
    elements.manualSummary.replaceChildren();
    for (const entry of evidence.entries ?? []) {
      const item = document.createElement('p');
      item.textContent = `${entry.auditId} · ${humanize(entry.outcome)} · ${entry.reviewer} · ${entry.device} · ${entry.attachments.length} file${entry.attachments.length === 1 ? '' : 's'} · ${formatDate(entry.attestedAt)}`;
      elements.manualSummary.append(item);
    }
    const count = (evidence.entries ?? []).length;
    if (count === 0) elements.manualSummary.textContent = 'No manual evidence has been signed for this run.';
    elements.manualLoadStatus.textContent = count ? `${count} signed entr${count === 1 ? 'y' : 'ies'}` : 'No signed evidence yet';
  } catch (error) {
    if (state.activeRunId !== id) return;
    const message = friendlyError(error);
    elements.manualSummary.textContent = `Manual evidence unavailable: ${message}`;
    elements.manualSummary.classList.add('error-state');
    elements.manualLoadStatus.textContent = 'Load failed';
  } finally {
    if (state.activeRunId === id) {
      setRegionBusy(elements.manualSection, false);
      setRegionBusy(elements.manualSummary, false);
    }
    endOperation(key);
  }
}

async function saveManualEvidence(event) {
  event.preventDefault();
  const runId = state.activeRunId;
  if (!runId || !beginOperation('manual-save')) return;
  setRegionBusy(elements.manualSection, true);
  setRegionBusy(elements.manualForm, true);
  setButtonBusy(elements.saveManualEvidence, true, 'Saving…');
  elements.manualMessage.classList.remove('error', 'success');
  elements.manualMessage.textContent = 'Preparing evidence upload…';
  announce('Saving manual evidence.');
  try {
    const uploadIds = [];
    const files = [...elements.manualFiles.files];
    for (const [index, file] of files.entries()) {
      elements.manualMessage.textContent = `Uploading ${index + 1}/${files.length}: ${file.name} (${formatBytes(file.size)})…`;
      const url = `/api/runs/${encodeURIComponent(runId)}/manual-uploads?auditId=${encodeURIComponent(elements.manualAudit.value)}&filename=${encodeURIComponent(file.name)}`;
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      }, 10 * 60_000);
      const value = await response.json().catch(() => ({ error: `Upload failed (${response.status})` }));
      if (!response.ok) throw new Error(value.error ?? `Upload failed (${response.status})`);
      uploadIds.push(value.id);
    }
    elements.manualMessage.textContent = 'Recording the signed result and rebuilding the checklist…';
    await fetchJson(`/api/runs/${encodeURIComponent(runId)}/manual-evidence`, {
      method: 'POST',
      body: JSON.stringify({
        auditId: elements.manualAudit.value,
        outcome: elements.manualOutcome.value,
        reviewer: elements.manualReviewer.value,
        device: elements.manualDevice.value,
        notes: elements.manualNotes.value,
        uploadIds,
        confirmed: elements.manualConfirm.checked,
      }),
      timeoutMs: 120_000,
    });
    elements.manualMessage.classList.add('success');
    elements.manualMessage.textContent = 'Manual evidence saved and the checklist was rebuilt.';
    elements.manualFiles.value = '';
    elements.manualConfirm.checked = false;
    announce('Manual evidence saved and checklist rebuilt.');
    await Promise.all([
      loadManualEvidence(runId),
      loadArtifacts(runId),
      loadRuns({ background: true }),
    ]);
  } catch (error) {
    const message = friendlyError(error);
    elements.manualMessage.classList.add('error');
    elements.manualMessage.textContent = message;
    announce(`Manual evidence could not be saved. ${message}`);
  } finally {
    setButtonBusy(elements.saveManualEvidence, false);
    setRegionBusy(elements.manualForm, false);
    setRegionBusy(elements.manualSection, false);
    endOperation('manual-save');
  }
}

function connectEventStream(id, afterSequence = 0) {
  state.events = new EventSource(`/api/runs/${encodeURIComponent(id)}/events?after=${encodeURIComponent(afterSequence)}`);
  state.events.addEventListener('log', (event) => {
    if (state.activeRunId !== id) return;
    const item = JSON.parse(event.data);
    queueLiveLogLine(
      id,
      `${item.timestamp} [${item.stage}:${item.channel}] ${item.channel === 'stderr' ? '⚠ ' : ''}${item.line}\n`,
      item.progress,
      item.phase,
    );
  });
  state.events.addEventListener('snapshot', (event) => {
    if (state.activeRunId === id) updateRunDialog(JSON.parse(event.data).manifest);
  });
  state.events.addEventListener('stage', (event) => {
    if (state.activeRunId !== id) return;
    const item = JSON.parse(event.data);
    const run = state.runs.find(({ id: runId }) => runId === id);
    if (!run) return;
    run.stages ??= {};
    run.stages[item.name] = item.stage;
    run.phase = item.label;
    updateRunDialog(run);
    if (item.status !== 'running') void loadArtifacts(id, { background: true });
  });
  state.events.addEventListener('overflow', async (event) => {
    if (state.activeRunId !== id) return;
    const item = JSON.parse(event.data);
    queueLiveLogLine(id, `\n[portal] ${item.dropped ?? 'Some'} live log events were omitted to keep the stream responsive. Loading a bounded recent tail…\n`);
    flushLiveLog();
    state.overflowController?.abort();
    const controller = new AbortController();
    const generation = ++state.overflowGeneration;
    state.overflowController = controller;
    const beforeRecovery = elements.liveLog.textContent;
    try {
      const history = await fetchJson(`/api/runs/${encodeURIComponent(id)}/logs?maxBytes=65536`, { signal: controller.signal });
      if (controller.signal.aborted || generation !== state.overflowGeneration || state.activeRunId !== id) return;
      flushLiveLog();
      const current = elements.liveLog.textContent;
      if (current.startsWith(beforeRecovery)) {
        const newerLines = current.slice(beforeRecovery.length);
        resetLiveLog(`[portal] Live stream caught up from a bounded recent tail.\n${history.log}${newerLines}`, id);
      } else if (current === beforeRecovery) {
        resetLiveLog(`[portal] Live stream caught up from a bounded recent tail.\n${history.log}`, id);
      } else {
        queueLiveLogLine(id, '[portal] A recent tail was loaded, but newer live lines were retained instead of being overwritten.\n');
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      // The EventSource retry and normal run-list polling provide the next recovery opportunity.
    } finally {
      if (state.overflowController === controller) state.overflowController = null;
    }
  });
  state.events.addEventListener('status', async (event) => {
    if (state.activeRunId !== id) return;
    const item = JSON.parse(event.data);
    if (item.manifest) updateRunDialog(item.manifest);
    await loadRuns({ background: true });
    await loadArtifacts(id, { background: true });
  });
  state.events.addEventListener('error', () => {
    if (state.activeRunId === id && state.events?.readyState !== EventSource.CLOSED) {
      elements.dialogStatus.textContent = 'Live updates reconnecting…';
    }
  });
}

function queueLiveLogLine(runId, line, progress = null, phase = null) {
  const batch = state.liveLogBatch;
  if (batch.runId !== runId) resetLiveLog('', runId);
  batch.lines.push(line);
  batch.characters += line.length;
  batch.progress = progress ?? batch.progress;
  batch.phase = phase ?? batch.phase;
  while (batch.lines.length > 500 || batch.characters > 128_000) {
    const removed = batch.lines.shift();
    batch.characters -= removed?.length ?? 0;
    batch.dropped += 1;
  }
  if (!batch.timer) batch.timer = window.setTimeout(flushLiveLog, 100);
}

function flushLiveLog() {
  const batch = state.liveLogBatch;
  batch.timer = null;
  if (!batch.lines.length && batch.dropped === 0) return;
  const notice = batch.dropped > 0
    ? `[portal] ${batch.dropped} queued log lines were dropped while this tab was busy.\n`
    : '';
  let value = `${elements.liveLog.textContent}${notice}${batch.lines.join('')}`;
  if (value.length > 150_000) {
    value = value.slice(-120_000);
    const newline = value.indexOf('\n');
    if (newline >= 0) value = value.slice(newline + 1);
  }
  elements.liveLog.textContent = value;
  elements.liveLog.scrollTop = elements.liveLog.scrollHeight;
  const run = state.runs.find(({ id }) => id === batch.runId);
  if (run && state.activeRunId === batch.runId) {
    if (batch.progress) run.progress = batch.progress;
    if (batch.phase) run.phase = batch.phase;
    updateRunDialog(run);
  }
  batch.lines = [];
  batch.characters = 0;
  batch.dropped = 0;
  batch.progress = null;
  batch.phase = null;
}

function resetLiveLog(value, runId = state.activeRunId) {
  const batch = state.liveLogBatch;
  if (batch.timer) window.clearTimeout(batch.timer);
  batch.lines = [];
  batch.characters = 0;
  batch.dropped = 0;
  batch.timer = null;
  batch.runId = runId;
  batch.progress = null;
  batch.phase = null;
  elements.liveLog.textContent = value;
  elements.liveLog.scrollTop = elements.liveLog.scrollHeight;
}

async function loadArtifacts(id, { background = false, append = false } = {}) {
  const key = `artifacts:${id}`;
  if (!beginOperation(key)) return;
  if (state.activeRunId === id) {
    setRegionBusy(elements.artifactList, true);
    elements.loadMoreArtifacts.disabled = true;
    elements.artifactStatus.textContent = background ? 'Refreshing evidence…' : 'Loading evidence…';
    if (!elements.artifactList.querySelector('.artifact-link')) renderArtifactSkeleton();
  }
  try {
    const offset = append && state.artifactPage.runId === id ? state.artifactPage.nextOffset : 0;
    const page = await fetchJson(`/api/runs/${encodeURIComponent(id)}/artifacts?offset=${offset}&limit=150`);
    const files = page.files;
    if (state.activeRunId !== id) return;
    if (!append) elements.artifactList.replaceChildren();
    elements.artifactList.classList.remove('error-state');
    if (!append) {
      clearReportLink(elements.openChecklist);
      clearReportLink(elements.openReport);
      clearReportLink(elements.openAiReview);
    }
    if (files.length === 0 && !append) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'Evidence appears as the run progresses.';
      elements.artifactList.append(empty);
    } else {
      for (const file of files) {
        if (file.path === 'checklist/manifest.json') {
          configureReportLink(elements.openChecklist, file.url);
          elements.openChecklist.removeAttribute('target');
          elements.openChecklist.removeAttribute('rel');
          elements.openChecklist.setAttribute('download', `${id}-complete-checklist.json`);
        }
        if (file.kind === 'playwright-report') configureReportLink(elements.openReport, file.url);
        if (file.kind === 'ai-review') configureReportLink(elements.openAiReview, file.url);
        if (!['video', 'image', 'trace', 'checklist', 'playwright-report', 'ai-review', 'data', 'file'].includes(file.kind)) continue;
        const link = document.createElement('a');
        link.className = 'artifact-link';
        link.href = file.url;
        link.target = '_blank';
        link.rel = 'noopener';
        const kind = document.createElement('small');
        kind.textContent = file.kind.replace('-', ' ');
        const path = document.createElement('span');
        path.textContent = `${file.path} · ${formatBytes(file.bytes)}`;
        link.append(kind, path);
        elements.artifactList.append(link);
      }
    }
    state.artifactPage = { runId: id, nextOffset: page.nextOffset, total: page.total, totalComplete: page.totalComplete };
    const displayed = elements.artifactList.querySelectorAll('.artifact-link').length;
    elements.loadMoreArtifacts.hidden = !page.hasMore;
    elements.artifactStatus.textContent = page.totalComplete
      ? `${displayed} of ${page.total} file${page.total === 1 ? '' : 's'}`
      : `${displayed} shown · at least ${page.knownTotal ?? page.total} files indexed`;
  } catch (error) {
    if (state.activeRunId !== id) return;
    const message = friendlyError(error);
    elements.artifactList.textContent = `Evidence unavailable: ${message}`;
    elements.artifactList.classList.add('error-state');
    elements.artifactStatus.textContent = 'Load failed';
    elements.loadMoreArtifacts.hidden = true;
  } finally {
    if (state.activeRunId === id) {
      setRegionBusy(elements.artifactList, false);
      elements.loadMoreArtifacts.disabled = false;
    }
    endOperation(key);
  }
}

function renderArtifactSkeleton() {
  elements.artifactList.innerHTML = '<div class="skeleton-lines" aria-hidden="true"><span></span><span></span><span></span><span></span></div>';
}

function configureReportLink(element, url) {
  element.href = url;
  element.target = '_blank';
  element.rel = 'noopener';
  element.hidden = false;
}

function clearReportLink(element) {
  element.hidden = true;
  element.removeAttribute('href');
  element.removeAttribute('target');
  element.removeAttribute('rel');
  element.removeAttribute('download');
}

function setTargetLink(element, url) {
  element.href = url;
  element.textContent = url;
}

function clearTargetLink(element) {
  element.removeAttribute('href');
  element.textContent = 'Loading…';
}

function renderStages(stages) {
  elements.stageList.replaceChildren();
  const labels = {
    build: 'Docker image build',
    browserShards: 'Parallel browser shards',
    performanceIsolation: 'Isolated Lighthouse + performance',
    merge: 'Docker merge coordinator',
    mergeReports: 'Shard report merge',
    playwright: 'Browser checks',
    videoProcessing: 'Video processing',
    aiReview: 'AI review',
    reportRebuild: 'Checklist rebuild',
  };
  const entries = Object.entries(stages);
  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Stages have not started yet.';
    elements.stageList.append(empty);
    return;
  }
  for (const [name, stage] of entries) {
    const card = document.createElement('div');
    card.className = 'stage-card';
    const status = document.createElement('div');
    status.className = 'stage-status';
    status.textContent = stage.status;
    const title = document.createElement('strong');
    const shard = name.match(/^shard(\d+)$/);
    title.textContent = labels[name] ?? (shard ? `Browser shard ${shard[1]}` : humanize(name));
    const timing = document.createElement('small');
    const duration = stage.durationMs === null ? 'Waiting' : `${(stage.durationMs / 1000).toFixed(1)}s`;
    const exit = stage.exitCode === null ? '' : ` · exit ${stage.exitCode}`;
    timing.textContent = `${duration}${exit}`;
    const command = document.createElement('code');
    command.textContent = stage.command?.join(' ') ?? '';
    command.title = command.textContent;
    card.append(status, title, timing, command);
    if (name === 'aiReview' && stage.summary) {
      const summary = document.createElement('small');
      const usage = stage.summary.usage;
      summary.textContent = [
        stage.summary.status,
        stage.summary.model,
        stage.summary.apiStatus,
        stage.summary.httpStatus ? `HTTP ${stage.summary.httpStatus}` : null,
        stage.summary.latencyMs ? `${stage.summary.latencyMs}ms` : null,
        usage?.totalTokens ? `${usage.totalTokens} tokens` : null,
      ].filter(Boolean).join(' · ') || stage.summary.status;
      card.append(summary);
    }
    elements.stageList.append(card);
  }
}

async function stopActiveRun() {
  const runId = state.activeRunId;
  if (!runId || !beginOperation('stop')) return;
  setButtonBusy(elements.stopRun, true, 'Stopping…');
  elements.dialogStatus.textContent = 'Sending a safe stop request…';
  announce('Stopping the active run.');
  try {
    await fetchJson(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', body: '{}', timeoutMs: 45_000 });
    if (state.activeRunId === runId) elements.dialogStatus.textContent = 'Stop requested. Waiting for active browser work to exit safely…';
    announce('Stop requested. Waiting for the run to exit safely.');
    await loadRuns({ background: true });
  } catch (error) {
    const message = friendlyError(error);
    if (state.activeRunId === runId) {
      elements.dialogStatus.textContent = `Could not stop this run. ${message}`;
      elements.dialogStatus.classList.add('error-text');
    }
    announce(`Run could not be stopped. ${message}`);
  } finally {
    setButtonBusy(elements.stopRun, false);
    endOperation('stop');
    const run = state.runs.find(({ id }) => id === runId);
    if (run && state.activeRunId === runId) updateRunDialog(run);
  }
}

function showPurgeConfirmation() {
  const runId = state.activeRunId;
  if (!runId || elements.purgeRun.hidden || state.pending.has('purge')) return;
  const expected = elements.purgeRun.dataset.confirmation ?? `PURGE ${runId}`;
  elements.purgeExpected.textContent = expected;
  elements.purgeConfirmationInput.value = '';
  elements.purgeConfirmationInput.dataset.expected = expected;
  elements.confirmPurge.disabled = true;
  elements.purgeMessage.textContent = '';
  elements.purgeMessage.classList.remove('error', 'success');
  elements.purgeConfirmation.hidden = false;
  elements.purgeConfirmationInput.focus();
  announce(`Permanent deletion confirmation opened for run ${runId}.`);
}

function updatePurgeConfirmation() {
  const matches = elements.purgeConfirmationInput.value === elements.purgeConfirmationInput.dataset.expected;
  elements.confirmPurge.disabled = !matches || state.pending.has('purge');
  elements.purgeMessage.textContent = matches ? 'Confirmation matches. Deletion is now available.' : '';
  elements.purgeMessage.classList.remove('error', 'success');
}

function clearPurgeConfirmation() {
  elements.purgeConfirmation.hidden = true;
  elements.purgeConfirmationInput.value = '';
  delete elements.purgeConfirmationInput.dataset.expected;
  elements.purgeExpected.textContent = '';
  elements.confirmPurge.disabled = true;
  elements.purgeMessage.textContent = '';
  elements.purgeMessage.classList.remove('error', 'success');
  setRegionBusy(elements.purgeConfirmation, false);
}

async function purgeActiveRun() {
  const runId = state.activeRunId;
  const confirmation = elements.purgeConfirmationInput.value;
  const expected = elements.purgeConfirmationInput.dataset.expected;
  if (!runId || confirmation !== expected || !beginOperation('purge')) return;

  setRegionBusy(elements.purgeConfirmation, true);
  setButtonBusy(elements.confirmPurge, true, 'Deleting stored evidence…');
  elements.cancelPurge.disabled = true;
  elements.purgeConfirmationInput.disabled = true;
  elements.purgeMessage.textContent = 'Counting files and safely removing this run…';
  elements.purgeMessage.classList.remove('error', 'success');
  announce(`Purging run ${runId} and its stored evidence.`);
  try {
    const result = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmation }),
      timeoutMs: 10 * 60_000,
    });
    const logicalBytesRemoved = Number.isFinite(result.logicalBytesRemoved) ? result.logicalBytesRemoved : 0;
    const filesRemoved = Number.isFinite(result.filesRemoved) ? result.filesRemoved : 0;
    const removed = `${formatBytes(logicalBytesRemoved)} of logical references across ${filesRemoved.toLocaleString()} file${filesRemoved === 1 ? '' : 's'}`;
    closeEventStream();
    if (elements.runDialog.open) elements.runDialog.close();
    state.runs = state.runs.filter(({ id }) => id !== runId);
    renderRuns();
    elements.runsStatus.textContent = `Run deleted · removed ${removed}. Physical disk reclamation can differ when evidence is hard-linked.`;
    announce(`Run ${runId} deleted. Removed ${removed}.`);
    void loadRuns({ background: true });
  } catch (error) {
    const message = friendlyError(error);
    elements.purgeMessage.textContent = `Purge did not complete: ${message}`;
    elements.purgeMessage.classList.add('error');
    announce(`Run could not be purged. ${message}`);
  } finally {
    setButtonBusy(elements.confirmPurge, false);
    elements.cancelPurge.disabled = false;
    elements.purgeConfirmationInput.disabled = false;
    setRegionBusy(elements.purgeConfirmation, false);
    endOperation('purge');
    if (!elements.purgeConfirmation.hidden) updatePurgeConfirmation();
  }
}

async function loadAnthropicKeySettings({ announceResult = false } = {}) {
  if (!beginOperation('key-load')) return;
  setRegionBusy(elements.keySettings, true);
  elements.keyState.textContent = 'Checking…';
  elements.keyState.className = 'settings-state loading';
  try {
    const value = await fetchJson('/api/settings/anthropic-key');
    applyKeySettings(value);
    elements.keyMessage.classList.remove('error');
    if (announceResult) announce('Anthropic API key settings refreshed.');
  } catch (error) {
    const message = friendlyError(error);
    state.keySettings.known = false;
    elements.keyState.textContent = 'Status unavailable';
    elements.keyState.className = 'settings-state error';
    elements.keyMessage.classList.add('error');
    elements.keyMessage.textContent = `Could not check the saved key: ${message}`;
    elements.deleteKey.disabled = true;
    if (announceResult) announce(`API key settings could not be loaded. ${message}`);
  } finally {
    setRegionBusy(elements.keySettings, false);
    endOperation('key-load');
  }
}

async function saveAnthropicKey() {
  if (!beginOperation('key-save')) return;
  clearKeyDeleteConfirmation();
  const apiKey = elements.keyInput.value.trim();
  if (apiKey.length < 10) {
    elements.keyMessage.classList.add('error');
    elements.keyMessage.textContent = 'Enter a complete Anthropic API key before saving.';
    announce('A complete Anthropic API key is required.');
    endOperation('key-save');
    return;
  }
  const requestBody = JSON.stringify({ apiKey });
  elements.keyInput.value = '';
  setRegionBusy(elements.keySettings, true);
  setButtonBusy(elements.saveKey, true, state.keySettings.configured ? 'Replacing…' : 'Saving…');
  elements.deleteKey.disabled = true;
  elements.keyMessage.classList.remove('error', 'success');
  elements.keyMessage.textContent = 'Sending the key to the portal service…';
  announce('Saving the Anthropic API key.');
  try {
    const value = await fetchJson('/api/settings/anthropic-key', {
      method: 'PUT',
      body: requestBody,
      timeoutMs: 30_000,
    });
    applyKeySettings(value);
    elements.keyMessage.classList.add('success');
    elements.keyMessage.textContent = 'API key saved. The browser has discarded the submitted value.';
    announce('Anthropic API key saved.');
  } catch (error) {
    const message = friendlyError(error);
    elements.keyMessage.classList.add('error');
    elements.keyMessage.textContent = `The key was not saved. ${message}`;
    announce(`Anthropic API key was not saved. ${message}`);
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
    elements.deleteKey.textContent = 'Confirm delete';
    elements.deleteKey.setAttribute('aria-label', 'Confirm deletion of the saved Anthropic API key');
    elements.keyMessage.classList.remove('error', 'success');
    elements.keyMessage.textContent = 'Select “Confirm delete” within 8 seconds to remove the saved key.';
    announce('Confirm deletion of the saved Anthropic API key.');
    state.keyDeleteTimer = window.setTimeout(clearKeyDeleteConfirmation, 8_000);
    return;
  }
  clearKeyDeleteConfirmation();
  if (!beginOperation('key-delete')) return;
  setRegionBusy(elements.keySettings, true);
  setButtonBusy(elements.deleteKey, true, 'Deleting…');
  elements.saveKey.disabled = true;
  elements.keyInput.disabled = true;
  elements.keyMessage.classList.remove('error', 'success');
  elements.keyMessage.textContent = 'Deleting the saved key…';
  announce('Deleting the saved Anthropic API key.');
  try {
    const value = await fetchJson('/api/settings/anthropic-key', { method: 'DELETE', timeoutMs: 30_000 });
    applyKeySettings(value);
    elements.keyMessage.classList.add('success');
    elements.keyMessage.textContent = value.configured
      ? 'Portal-saved key deleted. A runtime-provided key remains configured.'
      : 'Saved API key deleted. AI review is now off unless dry-run mode is enabled.';
    announce(value.configured
      ? 'Portal-saved key deleted. A runtime-provided key remains configured.'
      : 'Saved Anthropic API key deleted.');
  } catch (error) {
    const message = friendlyError(error);
    elements.keyMessage.classList.add('error');
    elements.keyMessage.textContent = `The key was not deleted. ${message}`;
    announce(`Anthropic API key was not deleted. ${message}`);
  } finally {
    setButtonBusy(elements.deleteKey, false);
    elements.saveKey.disabled = false;
    elements.keyInput.disabled = false;
    setRegionBusy(elements.keySettings, false);
    endOperation('key-delete');
    renderKeySettings();
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
  updateAiAvailability();
}

function renderKeySettings() {
  if (!state.keySettings.known) return;
  const { configured, fingerprint, storageEnabled, unavailableReason } = state.keySettings;
  elements.keyState.className = `settings-state ${configured ? 'configured' : 'unconfigured'}`;
  elements.keyState.textContent = !storageEnabled ? 'Isolation required' : configured
    ? `Configured${fingerprint ? ` · ${fingerprint}` : ''}`
    : 'Not configured';
  elements.keyInput.disabled = !storageEnabled;
  elements.saveKey.disabled = !storageEnabled || state.pending.has('key-save');
  elements.deleteKey.disabled = !configured || state.pending.has('key-delete') || state.pending.has('key-save');
  if (!storageEnabled && unavailableReason) elements.keyMessage.textContent = unavailableReason;
}

function updateAiAvailability() {
  if (!state.config) return;
  const available = state.keySettings.known
    ? state.keySettings.configured || state.config.aiReview.dryRun
    : state.config.aiReview.available;
  elements.aiReview.disabled = !available;
  elements.aiModel.disabled = !available;
  if (!available) {
    elements.aiReview.checked = false;
    elements.aiReviewHelp.textContent = state.keySettings.unavailableReason ?? 'Unavailable until an API key is saved with the portal service.';
    elements.aiReviewCard.title = 'No runtime API key is configured.';
  } else if (state.config.aiReview.dryRun) {
    elements.aiReviewHelp.textContent = 'Dry-run mode is active. Evidence selection and reports will run without an API request.';
    elements.aiReviewCard.title = '';
  } else {
    elements.aiReviewHelp.textContent = 'Analyze screenshots, findings, and video metadata after testing. Advisory only; browser results remain authoritative.';
    elements.aiReviewCard.title = '';
  }
}

function clearKeyDeleteConfirmation() {
  if (state.keyDeleteTimer) window.clearTimeout(state.keyDeleteTimer);
  state.keyDeleteTimer = null;
  state.keyDeleteArmed = false;
  elements.deleteKey.textContent = 'Delete key';
  elements.deleteKey.removeAttribute('aria-label');
}

function closeDialog() {
  if (elements.runDialog.open) elements.runDialog.close();
}

function closeEventStream({ clearActive = true } = {}) {
  state.events?.close();
  state.events = null;
  state.overflowController?.abort();
  state.overflowController = null;
  state.overflowGeneration += 1;
  if (state.liveLogBatch.timer) window.clearTimeout(state.liveLogBatch.timer);
  state.liveLogBatch = { lines: [], characters: 0, dropped: 0, timer: null, runId: null, progress: null, phase: null };
  state.openController?.abort();
  state.openController = null;
  if (clearActive) {
    state.activeRunId = null;
    state.openingRunId = null;
  }
}

function checkedValues(name) {
  return [...elements.form.querySelectorAll(`input[name="${name}"]:checked`)].map(({ value }) => value);
}

function updateSelectedCount() {
  const areas = checkedValues('area');
  const ids = new Set(state.selectedAuditIds);
  state.config?.catalog.filter(({ area }) => areas.includes(area)).forEach(({ id }) => ids.add(id));
  const selectedPlugins = checkedValues('pluginId');
  state.config?.plugins
    .filter(({ id }) => selectedPlugins.includes(id))
    .flatMap(({ auditDefinitions }) => auditDefinitions)
    .forEach(({ id }) => ids.add(id));
  elements.selectedCount.textContent = `${ids.size} selected`;
}

function showFormMessage(message, error = false) {
  elements.formMessage.textContent = message;
  elements.formMessage.classList.toggle('error', error);
  elements.formMessage.classList.toggle('success', !error && Boolean(message));
}

function setConnectionReady() {
  const wasOffline = !elements.statusWrap.classList.contains('online');
  elements.statusWrap.classList.add('online');
  elements.systemStatus.textContent = 'Portal ready';
  elements.runsStatus.classList.remove('error-text');
  if (wasOffline && state.config) announce('Portal connected.');
}

function setConnectionError(message) {
  elements.statusWrap.classList.remove('online');
  elements.systemStatus.textContent = `Unavailable · ${friendlyError(message)}`;
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
  element.classList.toggle('is-busy', busy);
}

function setButtonBusy(button, busy, label = '') {
  if (busy) {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    button.classList.add('is-loading');
    button.setAttribute('aria-disabled', 'true');
    if (label) button.textContent = label;
    return;
  }
  if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
  delete button.dataset.idleLabel;
  button.disabled = false;
  button.classList.remove('is-loading');
  button.removeAttribute('aria-disabled');
}

function announce(message) {
  elements.globalAnnouncer.textContent = '';
  window.requestAnimationFrame(() => { elements.globalAnnouncer.textContent = message; });
}

async function fetchJson(url, options = {}) {
  const { timeoutMs = 30_000, ...fetchOptions } = options;
  const response = await fetchWithTimeout(url, {
    ...fetchOptions,
    headers: { 'Content-Type': 'application/json', ...(fetchOptions.headers ?? {}) },
  }, timeoutMs);
  const value = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
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
    if (controller.signal.reason?.name === 'TimeoutError') {
      throw new Error('The portal took too long to respond. Try again or check the run service.');
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

function friendlyError(error) {
  const original = error instanceof Error ? error.message : String(error ?? 'Unexpected error');
  if (error?.name === 'AbortError') return 'The request was cancelled.';
  return original
    .replace(/sk-ant-[A-Za-z0-9_-]+/gi, '[redacted API key]')
    .replace(/(x-api-key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function runResult(run) {
  const bits = [];
  if (run.progress.total !== null) bits.push(`${run.progress.completed}/${run.progress.total}`);
  if (run.progress.passed !== null) bits.push(`${run.progress.passed} passed`);
  if (run.progress.failed) bits.push(`${run.progress.failed} failed`);
  if (run.progress.flaky) bits.push(`${run.progress.flaky} flaky`);
  if (run.progress.skipped) bits.push(`${run.progress.skipped} skipped`);
  return bits.join(' · ') || humanize(run.status);
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value < 1024 ** 4) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${(value / 1024 ** 4).toFixed(1)} TB`;
}

function humanize(value) {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function refreshElapsedTime() {
  if (!elements.runDialog.open) return;
  elements.detailElapsed.textContent = elapsedLabel(
    elements.detailElapsed.dataset.startedAt,
    elements.detailElapsed.dataset.finishedAt,
  );
}

function elapsedLabel(startedAt, finishedAt) {
  if (!startedAt) return 'Not started';
  const milliseconds = Math.max(0, new Date(finishedAt || Date.now()).getTime() - new Date(startedAt).getTime());
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
    : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
