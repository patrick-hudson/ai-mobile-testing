import { parseConsoleUrlState, serializeConsoleUrlState } from '/console-contracts.mjs';
import { CONSOLE_NAVIGATION_ITEMS, createConsoleShell, createFocusManager } from './console-shell.js';
import { createConsoleUrlState } from './console-url-state.js';

const root = document.querySelector('#new-audit-console');
const announcer = document.querySelector('#global-announcer');
const template = document.querySelector('#new-audit-workspace-template');
const shell = createConsoleShell(root, {
  navigationItems: CONSOLE_NAVIGATION_ITEMS,
  activeNavigationId: 'new-audit',
  title: 'New Audit',
  description: 'Create comparative release evidence or a standalone site-health audit.',
  inspectorLabel: 'Launch contract summary',
});
shell.main.append(template.content.cloneNode(true));

const connection = document.createElement('strong');
connection.id = 'system-status';
connection.setAttribute('role', 'status');
connection.setAttribute('aria-live', 'polite');
connection.textContent = 'Loading configuration…';
shell.headerActions.append(connection);

const inspectorHeading = document.createElement('h2');
inspectorHeading.textContent = 'Launch contract';
const inspectorCopy = document.createElement('p');
inspectorCopy.className = 'audit-muted audit-small';
inspectorCopy.textContent = 'Only the selected audit contract is submitted. Credentials and saved-view state never enter this page URL.';
const inspectorDetails = document.createElement('dl');
inspectorDetails.className = 'console-definition-list';
shell.inspector.append(inspectorHeading, inspectorCopy, inspectorDetails);

const state = {
  config: null,
  selectedAuditIds: new Set(),
  singleSitePreview: null,
  singleSitePreviewContract: null,
  singleSiteLaunchAttempt: null,
  singleSitePreflightController: null,
  singleSitePreflightGeneration: 0,
  pending: new Set(),
  urlState: null,
};

const elements = {
  form: document.querySelector('#launch-form'),
  launchRun: document.querySelector('#launch-run'),
  catalogSummary: document.querySelector('#catalog-summary'),
  comparativeDepth: document.querySelector('#comparative-depth'),
  comparativeSites: document.querySelector('#comparative-sites'),
  productionUrl: document.querySelector('#production-url'),
  candidateUrl: document.querySelector('#candidate-url'),
  candidateIgnoreTls: document.querySelector('#candidate-ignore-tls'),
  singleSiteSettings: document.querySelector('#single-site-settings'),
  singleSiteUrl: document.querySelector('#single-site-url'),
  singleSiteRoleSuggestion: document.querySelector('#single-site-role-suggestion'),
  singleSiteRoleConfirmed: document.querySelector('#single-site-role-confirmed'),
  singleSiteBypass: document.querySelector('#single-site-bypass'),
  singleSiteBypassCard: document.querySelector('#single-site-bypass-card'),
  singleSiteCertificateOptions: document.querySelector('#single-site-certificate-options'),
  previewSingleSite: document.querySelector('#preview-single-site'),
  singleSitePreflightStatus: document.querySelector('#single-site-preflight-status'),
  singleSiteCoverage: document.querySelector('#single-site-coverage'),
  singleSiteCoverageTitle: document.querySelector('#single-site-coverage-title'),
  singleSiteCoverageBadge: document.querySelector('#single-site-coverage-badge'),
  singleSiteCoverageDetails: document.querySelector('#single-site-coverage-details'),
  singleSiteCoverageGaps: document.querySelector('#single-site-coverage-gaps'),
  advanced: document.querySelector('#advanced-audit-options'),
  projects: document.querySelector('#project-options'),
  targetControls: document.querySelector('#target-controls'),
  plugins: document.querySelector('#plugin-options'),
  areas: document.querySelector('#area-options'),
  audits: document.querySelector('#audit-options'),
  auditFilter: document.querySelector('#audit-filter'),
  selectedCount: document.querySelector('#selected-count'),
  clearAreas: document.querySelector('#clear-areas'),
  aiReview: document.querySelector('#ai-review'),
  aiReviewCard: document.querySelector('#ai-review-card'),
  aiReviewHelp: document.querySelector('#ai-review-help'),
  aiModel: document.querySelector('#ai-model'),
  formMessage: document.querySelector('#form-message'),
};

const focus = createFocusManager(root);
focus.register('page-heading', shell.heading);
focus.register('mode-comparative', elements.form.querySelector('input[name="auditMode"][value="comparative"]'));
focus.register('mode-single-site', elements.form.querySelector('input[name="auditMode"][value="single-site"]'));

bindEvents();
init().catch((error) => {
  const message = friendlyError(error);
  connection.textContent = 'Configuration unavailable';
  elements.form.setAttribute('aria-busy', 'false');
  elements.launchRun.disabled = true;
  elements.previewSingleSite.disabled = true;
  showFormMessage(`Audit configuration could not be loaded. ${message}`, true);
  announce(`Audit configuration could not be loaded. ${message}`);
});

async function init() {
  state.config = await requestJson('/api/config');
  elements.productionUrl.value = state.config.defaults.productionUrl;
  elements.candidateUrl.value = state.config.defaults.candidateUrl;
  elements.singleSiteUrl.value = state.config.defaults.singleSiteUrl;
  elements.candidateIgnoreTls.checked = state.config.defaults.candidateIgnoreHTTPSErrors === true;
  elements.candidateIgnoreTls.disabled = true;
  elements.aiModel.value = state.config.aiReview.defaultModel;
  elements.catalogSummary.textContent = `${state.config.catalog.length} documented checks`;
  renderPlugins();
  renderAreas();
  renderAudits();
  updateAiAvailability();

  const parsed = parseConsoleUrlState('new-audit', window.location.href);
  const initialMode = parsed.state.mode ?? 'comparative';
  const modeInput = elements.form.querySelector(`input[name="auditMode"][value="${initialMode}"]`);
  if (modeInput) modeInput.checked = true;
  applySingleSiteRoleSuggestion();
  applyAuditMode({ announceChange: false });

  state.urlState = createConsoleUrlState({
    window,
    routeId: 'new-audit',
    parse: parseConsoleUrlState,
    serialize: serializeConsoleUrlState,
    onChange(next) {
      const input = elements.form.querySelector(`input[name="auditMode"][value="${next.state.mode ?? 'comparative'}"]`);
      if (input && !input.checked) input.checked = true;
      applyAuditMode({ announceChange: false });
    },
    onRestoreFocus(key) { focus.focus(key, shell.heading); },
  });
  elements.form.setAttribute('aria-busy', 'false');
  connection.textContent = state.config.operator?.authorized ? 'Operator ready' : 'Operator authorization required';
  renderInspector();
}

function bindEvents() {
  elements.form.addEventListener('submit', launchRun);
  elements.previewSingleSite.addEventListener('click', () => void previewSingleSite());
  elements.auditFilter.addEventListener('input', renderAudits);
  elements.clearAreas.addEventListener('click', () => {
    elements.areas.querySelectorAll('input').forEach((input) => { input.checked = false; });
    invalidateSingleSitePreview();
    updateSelectedCount();
  });
  elements.form.addEventListener('change', (event) => {
    if (event.target.name === 'auditMode') {
      const nextMode = event.target.value;
      if (state.urlState) state.urlState.setState({ mode: nextMode }, { focusKey: `mode-${nextMode}` });
      else applyAuditMode();
      return;
    }
    if (event.target.name === 'scope') {
      elements.targetControls.hidden = event.target.value === 'all';
      if (event.target.value === 'all') resetDefaultTargets();
    }
    if (event.target.name === 'profile' && event.target.value === 'release' && elements.form.elements.scope.value === 'all') {
      resetDefaultTargets();
    }
    if (isSingleSiteMode() && event.target.name === 'singleSiteRole') {
      elements.singleSiteRoleConfirmed.checked = false;
      renderSingleSiteRoleSuggestion();
    }
    if (isSingleSiteMode() && (event.target === elements.singleSiteRoleConfirmed || [
      'singleSiteRole', 'singleSiteCertificatePolicy', 'scope', 'targetId', 'pluginId', 'area', 'auditId',
    ].includes(event.target.name))) invalidateSingleSitePreview();
    if (['aiReview'].includes(event.target.id) || event.target === elements.aiModel) invalidateLaunchAttempt();
    updateSelectedCount();
    renderInspector();
  });
  elements.aiModel.addEventListener('input', invalidateLaunchAttempt);
  elements.productionUrl.addEventListener('input', () => elements.productionUrl.setCustomValidity(''));
  elements.candidateUrl.addEventListener('input', () => elements.candidateUrl.setCustomValidity(''));
  elements.singleSiteUrl.addEventListener('input', () => {
    elements.singleSiteUrl.setCustomValidity('');
    elements.singleSiteRoleConfirmed.checked = false;
    applySingleSiteRoleSuggestion();
    invalidateSingleSitePreview();
  });
  window.addEventListener('pagehide', () => {
    state.singleSitePreflightController?.abort();
    state.singleSitePreflightController = null;
    state.singleSitePreflightGeneration += 1;
    state.urlState?.destroy();
    focus.destroy();
  }, { once: true });
}

function isSingleSiteMode() {
  return elements.form.elements.auditMode?.value === 'single-site';
}

function exactOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

function validatedOrigin(input, label) {
  const raw = input.value.trim();
  let url;
  try { url = new URL(raw); } catch { url = null; }
  const valid = url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash;
  if (!valid) {
    const message = `${label} must be a complete HTTP or HTTPS origin without credentials, a path, query, or fragment.`;
    input.setCustomValidity(message);
    input.reportValidity();
    throw focusError(message, input);
  }
  input.setCustomValidity('');
  return url.origin;
}

function suggestedSingleSiteRole() {
  const origin = exactOrigin(elements.singleSiteUrl.value);
  if (!origin) return null;
  const productionOrigin = exactOrigin(state.config.defaults.productionUrl);
  if (productionOrigin && origin === productionOrigin) {
    return { role: 'production', reason: 'this URL matches the reviewed production origin' };
  }
  const configuredPreviewOrigins = [state.config.defaults.candidateUrl, state.config.defaults.singleSiteUrl]
    .map(exactOrigin)
    .filter(Boolean);
  const hostname = new URL(origin).hostname.toLowerCase();
  const previewLikeHostname = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname.split('.').some((label) => /^(?:beta|preview|staging|stage|dev|test)(?:-|$)/.test(label));
  return configuredPreviewOrigins.includes(origin) || previewLikeHostname
    ? { role: 'preview', reason: 'this URL is a configured or preview-like environment' }
    : null;
}

function renderSingleSiteRoleSuggestion(suggestion = suggestedSingleSiteRole()) {
  const selectedRole = elements.form.elements.singleSiteRole.value;
  if (!suggestion) {
    elements.singleSiteRoleSuggestion.textContent = 'No role can be safely suggested from this URL. Select one and explicitly confirm it.';
    return;
  }
  const label = suggestion.role === 'production' ? 'Production' : 'Preview';
  const selectionNote = selectedRole === suggestion.role
    ? ''
    : ` The current selection is ${selectedRole === 'production' ? 'Production' : 'Preview'}.`;
  elements.singleSiteRoleSuggestion.textContent = `Suggested role: ${label} — ${suggestion.reason}.${selectionNote} Explicit confirmation is still required.`;
}

function applySingleSiteRoleSuggestion() {
  const suggestion = suggestedSingleSiteRole();
  if (suggestion) {
    const input = elements.form.querySelector(`input[name="singleSiteRole"][value="${suggestion.role}"]`);
    if (input) input.checked = true;
  }
  renderSingleSiteRoleSuggestion(suggestion);
}

function applyAuditMode({ announceChange = true } = {}) {
  if (!state.config) return;
  const singleSite = isSingleSiteMode();
  elements.comparativeDepth.hidden = singleSite;
  elements.comparativeSites.hidden = singleSite;
  elements.singleSiteSettings.hidden = !singleSite;
  elements.productionUrl.required = !singleSite;
  elements.candidateUrl.required = !singleSite;
  elements.singleSiteUrl.required = singleSite;
  invalidateSingleSitePreview({ announceChange: false });
  renderProjects();
  elements.launchRun.textContent = singleSite ? 'Launch single-site audit' : 'Launch comparative audit';
  updateLaunchAvailability();
  renderInspector();
  if (announceChange) announce(singleSite ? 'Single-site audit configuration selected.' : 'Comparative audit configuration selected.');
}

function invalidateLaunchAttempt() {
  state.singleSiteLaunchAttempt = null;
}

function invalidateSingleSitePreview({ announceChange = true } = {}) {
  const hadPreview = Boolean(state.singleSitePreview);
  state.singleSitePreflightController?.abort();
  state.singleSitePreflightController = null;
  state.singleSitePreflightGeneration += 1;
  state.pending.delete('single-site-preview');
  state.singleSitePreview = null;
  state.singleSitePreviewContract = null;
  invalidateLaunchAttempt();
  elements.singleSiteCoverage.hidden = true;
  elements.singleSiteCoverageDetails.replaceChildren();
  elements.singleSiteCoverageGaps.replaceChildren();
  elements.singleSitePreflightStatus.classList.remove('error', 'success');
  setButtonBusy(elements.previewSingleSite, false);
  setRegionBusy(elements.singleSiteSettings, false);
  setRegionBusy(elements.singleSiteCoverage, false);
  if (isSingleSiteMode() && state.config) {
    const role = elements.form.elements.singleSiteRole.value;
    if (role === 'production' && elements.singleSiteBypass.checked) {
      elements.form.elements.singleSiteCertificatePolicy.value = 'strict';
    }
    elements.singleSiteBypass.disabled = role !== 'preview' || !state.config.singleSite.previewTlsBypassConfigured;
    elements.singleSiteBypassCard.classList.toggle('unavailable-target', elements.singleSiteBypass.disabled);
    elements.singleSitePreflightStatus.textContent = hadPreview && announceChange
      ? 'Selections changed. Check the site again before launching.'
      : 'Check the site before launching. No run is created during this step.';
  }
  updateLaunchAvailability();
}

function updateLaunchAvailability() {
  if (state.pending.has('launch')) return;
  elements.launchRun.disabled = !state.config || (isSingleSiteMode() && !state.singleSitePreview?.accepted);
  elements.launchRun.setAttribute('aria-disabled', String(elements.launchRun.disabled));
}

function resetDefaultTargets() {
  elements.projects.querySelectorAll('input[name="targetId"]').forEach((input) => {
    input.checked = !input.disabled && input.dataset.defaultSelected === 'true';
  });
}

function renderProjects() {
  elements.projects.replaceChildren();
  const singleSite = isSingleSiteMode();
  const addHeading = (copy) => {
    const heading = document.createElement('p');
    heading.className = 'audit-target-group-heading';
    heading.textContent = copy;
    elements.projects.append(heading);
  };
  const renderTarget = (project, providerOnly = false) => {
    const label = document.createElement('label');
    label.className = `audit-choice${project.available ? '' : ' unavailable-target'}`;
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
  addHeading(singleSite
    ? 'Docker-local browser and device targets · one neutral deployment'
    : 'Docker-local browser and device-emulation targets');
  (singleSite ? state.config.targets.singleSiteTargets : state.config.targets.localTargets).forEach((target) => renderTarget(target));
  addHeading('Real-device provider targets · planning only');
  state.config.targets.providerTargets.forEach((target) => renderTarget(target, true));
  updateSelectedCount();
}

function renderPlugins() {
  elements.plugins.replaceChildren();
  for (const plugin of state.config.plugins) {
    const label = document.createElement('label');
    label.className = 'audit-choice';
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

function renderAreas() {
  elements.areas.replaceChildren();
  const areas = [...new Set(state.config.catalog.map(({ area }) => area))].sort();
  for (const area of areas) {
    const label = document.createElement('label');
    label.className = 'audit-pill';
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

function renderAudits() {
  if (!state.config) return;
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
      if (isSingleSiteMode()) invalidateSingleSitePreview();
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

function currentSingleSiteContract() {
  const targeted = elements.form.elements.scope.value === 'targeted';
  const url = validatedOrigin(elements.singleSiteUrl, 'Site URL');
  if (!elements.singleSiteRoleConfirmed.checked) {
    throw focusError('Confirm the intended Preview or Production role before checking the site.', elements.singleSiteRoleConfirmed);
  }
  const targetIds = checkedValues('targetId');
  if (targetIds.length === 0) {
    elements.advanced.open = true;
    throw focusError('Choose at least one Docker browser or device target.', firstTargetControl());
  }
  const scope = {
    qualifier: targeted ? 'TARGETED' : 'FULL',
    pluginIds: targeted ? checkedValues('pluginId') : [],
    auditIds: targeted ? [...state.selectedAuditIds].sort() : [],
    areas: targeted ? checkedValues('area') : [],
  };
  if (targeted && scope.pluginIds.length === 0 && scope.auditIds.length === 0 && scope.areas.length === 0) {
    elements.advanced.open = true;
    throw focusError('Choose at least one installed suite, audit area, or individual check.', elements.plugins.querySelector('input'));
  }
  return {
    schemaVersion: 1,
    mode: 'single-site',
    url,
    deploymentRole: elements.form.elements.singleSiteRole.value,
    certificatePolicy: elements.form.elements.singleSiteCertificatePolicy.value,
    targetIds,
    scope,
  };
}

async function previewSingleSite() {
  if (!isSingleSiteMode() || !beginOperation('single-site-preview')) return;
  let contract;
  try {
    contract = currentSingleSiteContract();
  } catch (error) {
    endOperation('single-site-preview');
    renderPreflightError(error);
    return;
  }
  const controller = new AbortController();
  const generation = ++state.singleSitePreflightGeneration;
  const contractIdentity = JSON.stringify(contract);
  state.singleSitePreflightController = controller;
  setRegionBusy(elements.singleSiteSettings, true);
  setRegionBusy(elements.singleSiteCoverage, true);
  setButtonBusy(elements.previewSingleSite, true, 'Checking identity and coverage…');
  elements.singleSitePreflightStatus.classList.remove('error', 'success');
  elements.singleSitePreflightStatus.textContent = 'Fetching reviewed identity markers, deployment revision, and executable coverage. No run has been created.';
  announce('Checking the site and compiling standalone coverage.');
  try {
    const response = await fetchWithTimeout('/api/single-site/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contract),
      signal: controller.signal,
    }, 60_000);
    const value = await response.json().catch(() => ({ error: `Preflight failed (${response.status})` }));
    if (!isCurrentSingleSitePreflight(controller, generation, contractIdentity)) return;
    if (!response.ok && !value?.preflight) throw httpError(response.status, value);
    if (value?.accepted === true && JSON.stringify(value.runContract) !== contractIdentity) {
      throw new Error('The preflight response did not match the submitted launch contract. Check the site again.');
    }
    if (!value.accepted) {
      state.singleSitePreview = null;
      state.singleSitePreviewContract = null;
      invalidateLaunchAttempt();
      renderSingleSiteRejection(value);
      return;
    }
    acceptSingleSitePreview(value);
    elements.singleSitePreflightStatus.classList.add('success');
    elements.singleSitePreflightStatus.textContent = 'Identity accepted and coverage frozen for launch. Launch will recheck the site atomically.';
    announce(`Site accepted. ${value.coverage.counts.plannedExecutions} standalone executions are ready to launch.`);
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || generation !== state.singleSitePreflightGeneration) return;
    state.singleSitePreview = null;
    state.singleSitePreviewContract = null;
    invalidateLaunchAttempt();
    elements.singleSiteCoverage.hidden = true;
    renderPreflightError(error, 'Site check failed');
  } finally {
    if (state.singleSitePreflightController !== controller || generation !== state.singleSitePreflightGeneration) return;
    state.singleSitePreflightController = null;
    setButtonBusy(elements.previewSingleSite, false);
    setRegionBusy(elements.singleSiteSettings, false);
    setRegionBusy(elements.singleSiteCoverage, false);
    endOperation('single-site-preview');
    updateLaunchAvailability();
    renderInspector();
  }
}

function isCurrentSingleSitePreflight(controller, generation, contractIdentity) {
  if (controller.signal.aborted || state.singleSitePreflightController !== controller
    || generation !== state.singleSitePreflightGeneration || !isSingleSiteMode()) return false;
  try { return JSON.stringify(currentSingleSiteContract()) === contractIdentity; }
  catch { return false; }
}

function acceptSingleSitePreview(value) {
  state.singleSitePreview = value;
  state.singleSitePreviewContract = JSON.stringify(value.runContract);
  invalidateLaunchAttempt();
  renderSingleSiteCoverage(value);
}

function renderPreflightError(error, prefix = '') {
  const message = friendlyError(error);
  elements.singleSitePreflightStatus.classList.add('error');
  elements.singleSitePreflightStatus.textContent = prefix ? `${prefix}: ${message}` : message;
  focusNamedTarget(error?.body?.details?.focusTarget, error?.focusElement);
  announce(prefix ? `${prefix}. ${message}` : message);
}

function renderSingleSiteRejection(value) {
  elements.singleSiteCoverage.hidden = false;
  elements.singleSiteCoverageBadge.textContent = 'Rejected';
  elements.singleSiteCoverageBadge.className = 'audit-state error';
  elements.singleSiteCoverageDetails.replaceChildren();
  elements.singleSiteCoverageGaps.replaceChildren();
  const issues = value.preflight?.issues ?? [];
  const message = issues.map(({ message: issue }) => issue).filter(Boolean).join(' ')
    || 'The fetched application did not satisfy the reviewed quitting7oh identity contract.';
  const paragraph = document.createElement('p');
  paragraph.className = 'audit-error';
  paragraph.textContent = message;
  elements.singleSiteCoverageGaps.append(paragraph);
  elements.singleSitePreflightStatus.classList.add('error');
  elements.singleSitePreflightStatus.textContent = 'The site was rejected before a run was created. Correct the URL or confirmed role, then retry.';
  focusNamedTarget(issues.find(({ focusTarget }) => focusTarget)?.focusTarget);
  announce(`Site rejected before launch. ${message}`);
}

function renderSingleSiteCoverage(value) {
  const { coverage } = value;
  elements.singleSiteCoverage.hidden = false;
  elements.singleSiteCoverageBadge.textContent = `${coverage.scope.qualifier} · ${coverage.coverageStatus}`;
  elements.singleSiteCoverageBadge.className = `audit-state ${coverage.coverageStatus === 'COMPLETE' ? 'success' : 'error'}`;
  elements.singleSiteCoverageDetails.replaceChildren();
  const rows = [
    ['Standalone definitions', coverage.counts.selectedDefinitions],
    ['Executable cases', coverage.counts.executableCases],
    ['Browser/device executions', coverage.counts.plannedExecutions],
    ['Coverage gaps', coverage.counts.coverageGaps],
    ['Outside this mode', coverage.counts.outsideModeDefinitions],
    ['Evidence authority', humanize(value.preflight.evidenceAuthority.status)],
  ];
  for (const [label, content] of rows) appendDefinition(elements.singleSiteCoverageDetails, label, content);
  elements.singleSiteCoverageGaps.replaceChildren();
  if (coverage.coverageGaps.length > 0) {
    const heading = document.createElement('h4');
    heading.textContent = 'Known coverage gaps';
    const list = document.createElement('ul');
    for (const gap of coverage.coverageGaps) {
      const item = document.createElement('li');
      item.textContent = `${gap.auditId ?? gap.definitionId ?? 'Coverage'} · ${gap.reason ?? gap.code}`;
      list.append(item);
    }
    elements.singleSiteCoverageGaps.append(heading, list);
  }
}

async function launchRun(event) {
  event.preventDefault();
  if (!state.config || state.pending.has('launch')) return;
  if (isSingleSiteMode()) return launchSingleSiteRun();
  if (!elements.form.reportValidity() || !beginOperation('launch')) return;
  let body;
  try {
    const targeted = elements.form.elements.scope.value === 'targeted';
    const targetIds = checkedValues('targetId');
    if (targetIds.length === 0) {
      elements.advanced.open = true;
      throw focusError('Choose at least one Docker browser or device target.', firstTargetControl());
    }
    body = {
      profile: elements.form.elements.profile.value,
      targetIds,
      pluginIds: targeted ? checkedValues('pluginId') : [],
      areas: targeted ? checkedValues('area') : [],
      auditIds: targeted ? [...state.selectedAuditIds].sort() : [],
      productionUrl: validatedOrigin(elements.productionUrl, 'Production URL'),
      candidateUrl: validatedOrigin(elements.candidateUrl, 'Candidate URL'),
      candidateIgnoreHTTPSErrors: elements.candidateIgnoreTls.checked,
      aiReview: elements.aiReview.checked,
      aiModel: elements.aiModel.value,
    };
    if (body.productionUrl === body.candidateUrl) {
      throw focusError('Production and candidate must be different origins.', elements.candidateUrl);
    }
    if (targeted && body.pluginIds.length === 0 && body.areas.length === 0 && body.auditIds.length === 0) {
      elements.advanced.open = true;
      throw focusError('Choose at least one installed suite, audit area, or individual check.', elements.plugins.querySelector('input'));
    }
  } catch (error) {
    endOperation('launch');
    showFormMessage(friendlyError(error), true);
    error.focusElement?.focus();
    announce(friendlyError(error));
    return;
  }
  setRegionBusy(elements.form, true);
  setButtonBusy(elements.launchRun, true, 'Launching…');
  showFormMessage('Starting the audit and preparing its evidence directory…');
  announce('Starting the audit.');
  try {
    const run = await requestJson('/api/runs', { method: 'POST', body: JSON.stringify(body), timeoutMs: 45_000 });
    navigateToRun('comparative', run.id);
  } catch (error) {
    const message = friendlyError(error);
    showFormMessage(message, true);
    focusComparativeError(message);
    announce(`Audit could not start. ${message}`);
  } finally {
    setButtonBusy(elements.launchRun, false);
    setRegionBusy(elements.form, false);
    endOperation('launch');
    updateLaunchAvailability();
  }
}

async function launchSingleSiteRun() {
  if (!beginOperation('launch')) return;
  let contract;
  try {
    contract = currentSingleSiteContract();
    if (!state.singleSitePreview?.accepted || state.singleSitePreviewContract !== JSON.stringify(contract)) {
      throw focusError('Selections changed after the coverage preview. Check the site again before launching.', elements.previewSingleSite);
    }
  } catch (error) {
    endOperation('launch');
    showFormMessage(friendlyError(error), true);
    error.focusElement?.focus();
    announce(friendlyError(error));
    updateLaunchAvailability();
    return;
  }
  const advisory = elements.aiReview.checked
    ? { schemaVersion: 1, aiReview: { optedIn: true, model: elements.aiModel.value } }
    : { schemaVersion: 1, aiReview: { optedIn: false, model: null } };
  const requestIdentity = JSON.stringify({ contract, previewDigest: state.singleSitePreview.previewDigest, advisory });
  if (!state.singleSiteLaunchAttempt || state.singleSiteLaunchAttempt.identity !== requestIdentity) {
    state.singleSiteLaunchAttempt = { identity: requestIdentity, idempotencyKey: `portal-${crypto.randomUUID()}` };
  }
  const attempt = state.singleSiteLaunchAttempt;
  setRegionBusy(elements.form, true);
  setButtonBusy(elements.launchRun, true, 'Rechecking and queueing…');
  showFormMessage('Rechecking deployment identity and revision, then atomically queueing the Docker audit…');
  announce('Rechecking the site and queueing the standalone audit.');
  try {
    const response = await fetchWithTimeout('/api/single-site/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: attempt.idempotencyKey,
        previewDigest: state.singleSitePreview.previewDigest,
        runContract: contract,
        advisory,
      }),
    }, 90_000);
    const value = await response.json().catch(() => ({ error: `Launch failed (${response.status})` }));
    if (!response.ok && !value?.refreshedPreview) throw httpError(response.status, value);
    if (!value.launched) {
      state.singleSiteLaunchAttempt = null;
      if (value.refreshedPreview?.accepted) {
        acceptSingleSitePreview(value.refreshedPreview);
      } else if (value.refreshedPreview) {
        state.singleSitePreview = null;
        state.singleSitePreviewContract = null;
        renderSingleSiteRejection(value.refreshedPreview);
      }
      const message = value.reason === 'preview-stale'
        ? 'The deployment or test registry changed after preview. The refreshed coverage is shown; review it and launch again.'
        : 'The deployment no longer passes preflight. No run was created.';
      showFormMessage(message, true);
      if (value.refreshedPreview?.accepted) elements.singleSiteCoverageTitle.focus();
      announce(message);
      return;
    }
    state.singleSiteLaunchAttempt = null;
    navigateToRun('single-site', value.job.id);
  } catch (error) {
    if (Number.isInteger(error?.status)) state.singleSiteLaunchAttempt = null;
    const message = friendlyError(error);
    showFormMessage(message, true);
    focusNamedTarget(error?.body?.details?.focusTarget);
    announce(`Single-site audit could not start. ${message}`);
  } finally {
    setButtonBusy(elements.launchRun, false);
    setRegionBusy(elements.form, false);
    endOperation('launch');
    updateLaunchAvailability();
    renderInspector();
  }
}

function navigateToRun(mode, runId) {
  const search = serializeConsoleUrlState('run', { mode, run: runId, view: 'overview' });
  window.location.assign(`/run.html?${search}`);
}

function focusNamedTarget(name, fallback = null) {
  let target = fallback;
  if (name === 'mode') target = elements.form.querySelector('input[name="auditMode"]:checked');
  if (name === 'deploymentRole') target = elements.form.querySelector('input[name="singleSiteRole"]:checked') ?? elements.singleSiteRoleConfirmed;
  if (name === 'url' || name === 'runContract') target = elements.singleSiteUrl;
  if (name === 'scope') {
    elements.advanced.open = true;
    target = elements.form.querySelector('input[name="scope"]:checked');
  }
  if (name === 'aiReview') {
    elements.advanced.open = true;
    target = elements.aiReview;
  }
  target?.focus?.();
}

function focusComparativeError(message) {
  const lower = message.toLowerCase();
  let target = null;
  if (lower.includes('production url')) target = elements.productionUrl;
  else if (lower.includes('candidate url') || lower.includes('certificate')) target = elements.candidateUrl;
  else if (lower.includes('browser') || lower.includes('target') || lower.includes('project')) {
    elements.advanced.open = true;
    target = firstTargetControl();
  } else if (lower.includes('plugin') || lower.includes('suite')) {
    elements.advanced.open = true;
    target = elements.plugins.querySelector('input');
  } else if (lower.includes('audit') || lower.includes('area') || lower.includes('scope')) {
    elements.advanced.open = true;
    target = elements.form.querySelector('input[name="scope"]:checked');
  } else if (lower.includes('ai review') || lower.includes('model')) {
    elements.advanced.open = true;
    target = elements.aiReview;
  }
  target?.focus();
}

function firstTargetControl() {
  return elements.projects.querySelector('input:not(:disabled)');
}

function updateAiAvailability() {
  const available = state.config.aiReview.available === true;
  elements.aiReview.disabled = !available;
  elements.aiModel.disabled = !available;
  if (!available) {
    elements.aiReview.checked = false;
    elements.aiReviewHelp.textContent = 'Unavailable until an API key is saved with the portal service.';
    elements.aiReviewCard.title = 'No runtime API key is configured.';
  } else if (state.config.aiReview.dryRun) {
    elements.aiReviewHelp.textContent = 'Dry-run mode is active. Evidence selection and reports will run without an API request.';
    elements.aiReviewCard.title = '';
  } else {
    elements.aiReviewHelp.textContent = 'Analyze screenshots, findings, and video metadata. Advisory only; browser results remain authoritative.';
    elements.aiReviewCard.title = '';
  }
}

function checkedValues(name) {
  return [...elements.form.querySelectorAll(`input[name="${name}"]:checked`)].map(({ value }) => value);
}

function updateSelectedCount() {
  if (!state.config) return;
  const areas = checkedValues('area');
  const ids = new Set(state.selectedAuditIds);
  state.config.catalog.filter(({ area }) => areas.includes(area)).forEach(({ id }) => ids.add(id));
  const selectedPlugins = checkedValues('pluginId');
  state.config.plugins
    .filter(({ id }) => selectedPlugins.includes(id))
    .flatMap(({ auditDefinitions }) => auditDefinitions)
    .forEach(({ id }) => ids.add(id));
  elements.selectedCount.textContent = `${ids.size} selected`;
}

function renderInspector() {
  inspectorDetails.replaceChildren();
  const mode = isSingleSiteMode() ? 'Single-site' : 'Comparative';
  appendDefinition(inspectorDetails, 'Mode', mode);
  appendDefinition(inspectorDetails, 'Scope', elements.form.elements.scope?.value === 'targeted' ? 'Targeted' : 'Full profile');
  appendDefinition(inspectorDetails, 'Targets', checkedValues('targetId').length || 'Not loaded');
  appendDefinition(inspectorDetails, 'Preflight', isSingleSiteMode()
    ? state.singleSitePreview?.accepted ? 'Accepted and frozen' : 'Required'
    : 'Not required');
  appendDefinition(inspectorDetails, 'AI review', elements.aiReview.checked ? 'Opted in' : 'Off');
}

function appendDefinition(list, label, value) {
  const row = document.createElement('div');
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = String(value);
  row.append(term, detail);
  list.append(row);
}

function showFormMessage(message, error = false) {
  elements.formMessage.textContent = message;
  elements.formMessage.classList.toggle('error', error);
  elements.formMessage.classList.toggle('success', !error && Boolean(message));
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
  if (!response.ok) throw httpError(response.status, value);
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

function httpError(status, body) {
  const error = new Error(body?.error ?? `Request failed (${status})`);
  error.status = status;
  error.body = body;
  return error;
}

function focusError(message, focusElement) {
  const error = new Error(message);
  error.focusElement = focusElement;
  return error;
}

function friendlyError(error) {
  const original = error instanceof Error ? error.message : String(error ?? 'Unexpected error');
  if (error?.name === 'AbortError') return 'The request was cancelled.';
  return original
    .replace(/sk-ant-[A-Za-z0-9_-]+/gi, '[redacted API key]')
    .replace(/(x-api-key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .slice(0, 1_200);
}

function humanize(value) {
  return String(value ?? 'unknown').replaceAll('-', ' ').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
