const PAGE_SIZE = 25;
const LOG_PREVIEW_BYTES = 64 * 1024;
const REPORT_RETRY_MS = 5_000;
const TERMINAL_STATUSES = new Set(['passed', 'not-ready', 'review-required', 'failed', 'evidence-failed', 'stopped', 'spawn-failed']);
const STATUS_ORDER = ['FAIL', 'BLOCKED', 'FLAKY', 'REVIEW', 'MANUAL_REQUIRED', 'NOT_RUN', 'INTENDED_CHANGE', 'PASS'];

const state = {
  runId: null,
  run: null,
  report: null,
  artifacts: null,
  reportController: null,
  auditsController: null,
  detailController: null,
  logController: null,
  retryTimer: null,
  auditOffset: 0,
  auditRequest: 0,
  activeAuditId: null,
  queryTimer: null,
};

const elements = Object.fromEntries([
  'report-connection', 'refresh-report', 'report-loading', 'report-error', 'report-error-title', 'report-error-message',
  'retry-report', 'report-content', 'decision-hero', 'decision-title', 'decision-badge', 'decision-summary', 'decision-basis',
  'visual-gallery-link', 'full-checklist-link', 'manifest-download-link', 'context-run-id', 'context-profile', 'context-scope', 'context-started',
  'context-elapsed', 'context-pipeline', 'context-production', 'context-candidate', 'summary-generated', 'metric-grid',
  'status-total', 'status-bars', 'severity-bars', 'finding-total', 'top-findings', 'audit-result-count', 'audit-filters',
  'filter-query', 'filter-status', 'filter-severity', 'filter-area', 'filter-environment', 'filter-blocking', 'filter-manual',
  'clear-filters', 'audit-loading', 'audit-error', 'audit-list', 'audit-previous', 'audit-next', 'audit-page-label',
  'manual-summary', 'ai-summary', 'ai-review-link', 'artifact-count', 'report-links', 'load-log', 'log-state',
  'report-log', 'log-links', 'report-announcer',
].map((id) => [id.replaceAll('-', '_'), document.querySelector(`#${id}`)]));

init().catch((error) => showFatal('This report could not be loaded', friendlyError(error)));

async function init() {
  const requestedId = new URLSearchParams(window.location.search).get('run')?.trim() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$/.test(requestedId)) {
    return showFatal('Choose a valid run', 'This report link is missing a valid run ID. Return to the audit console and open a completed run.');
  }
  state.runId = requestedId;
  elements.visual_gallery_link.href = `/gallery.html?run=${encodeURIComponent(requestedId)}&from=report`;
  document.title = `Run ${requestedId} · Quitting 7-OH release report`;
  bindEvents();
  await loadReport();
}

function bindEvents() {
  elements.refresh_report.addEventListener('click', () => void loadReport());
  elements.retry_report.addEventListener('click', () => void loadReport());
  elements.audit_previous.addEventListener('click', () => {
    state.auditOffset = Math.max(0, state.auditOffset - PAGE_SIZE);
    void loadAudits();
  });
  elements.audit_next.addEventListener('click', () => {
    state.auditOffset += PAGE_SIZE;
    void loadAudits();
  });
  elements.audit_filters.addEventListener('change', (event) => {
    if (event.target === elements.filter_query) return;
    state.auditOffset = 0;
    void loadAudits();
  });
  elements.filter_query.addEventListener('input', () => {
    window.clearTimeout(state.queryTimer);
    state.queryTimer = window.setTimeout(() => {
      state.auditOffset = 0;
      void loadAudits();
    }, 280);
  });
  elements.clear_filters.addEventListener('click', () => {
    elements.audit_filters.reset();
    state.auditOffset = 0;
    void loadAudits();
  });
  elements.load_log.addEventListener('click', () => void loadLog());
  window.addEventListener('pagehide', abortRequests);
}

function abortRequests() {
  state.reportController?.abort();
  state.auditsController?.abort();
  state.detailController?.abort();
  state.logController?.abort();
  window.clearTimeout(state.retryTimer);
  window.clearTimeout(state.queryTimer);
}

async function loadReport() {
  window.clearTimeout(state.retryTimer);
  state.reportController?.abort();
  state.auditsController?.abort();
  state.detailController?.abort();
  const controller = new AbortController();
  state.reportController = controller;
  setMainState('loading');
  elements.report_connection.textContent = 'Loading report…';
  elements.refresh_report.disabled = true;
  announce('Loading the run report.');
  const encodedId = encodeURIComponent(state.runId);
  try {
    const [runResult, reportResult] = await Promise.allSettled([
      fetchJson(`/api/runs/${encodedId}`, { signal: controller.signal }),
      fetchJson(`/api/runs/${encodedId}/report`, { signal: controller.signal }),
    ]);
    if (controller.signal.aborted) return;
    if (runResult.status === 'rejected') throw runResult.reason;
    state.run = runResult.value;
    if (reportResult.status === 'rejected') {
      const active = !TERMINAL_STATUSES.has(state.run.status);
      showReportUnavailable(active, friendlyError(reportResult.reason));
      if (active) state.retryTimer = window.setTimeout(() => void loadReport(), REPORT_RETRY_MS);
      return;
    }
    state.report = reportResult.value;
    setMainState('content');
    renderReport();
    elements.report_connection.textContent = `Loaded ${formatDate(state.report.generatedAt)}`;
    announce(`Release report loaded. ${state.run.status === 'review-required' ? 'Release signoff is withheld for review.' : `Decision: ${state.report.release?.decision ?? 'not available'}.`}`);
    await Promise.allSettled([loadAudits(), loadArtifacts()]);
  } catch (error) {
    if (controller.signal.aborted) return;
    showFatal('This report could not be loaded', friendlyError(error));
  } finally {
    if (state.reportController === controller) state.reportController = null;
    elements.refresh_report.disabled = false;
  }
}

function showReportUnavailable(active, detail) {
  const title = active ? 'The evidence report is being prepared' : 'No reviewer report is available';
  const message = active
    ? `The run is ${humanize(state.run.status)}. This page will retry every five seconds until the compact evidence index is ready.`
    : `The run finished without a compact reviewer report. Its status is ${humanize(state.run.status)}. ${detail}`;
  showFatal(title, message);
  elements.report_connection.textContent = active ? 'Waiting for evidence pipeline…' : 'Report unavailable';
  elements.retry_report.textContent = active ? 'Check now' : 'Try again';
}

function showFatal(title, message) {
  setMainState('error');
  elements.report_error_title.textContent = title;
  elements.report_error_message.textContent = message;
  elements.report_connection.textContent = 'Needs attention';
  elements.refresh_report.disabled = false;
  announce(`${title}. ${message}`);
}

function setMainState(value) {
  elements.report_loading.hidden = value !== 'loading';
  elements.report_loading.setAttribute('aria-busy', value === 'loading' ? 'true' : 'false');
  elements.report_error.hidden = value !== 'error';
  elements.report_content.hidden = value !== 'content';
}

function renderReport() {
  renderDecision();
  renderMetrics();
  renderBars();
  renderTopFindings();
  renderFilters();
  renderManualSummary();
  renderAiSummary();
}

function renderDecision() {
  const { run, report } = state;
  const release = report.release ?? run.release;
  const decision = release?.decision ?? 'UNAVAILABLE';
  const active = !TERMINAL_STATUSES.has(run.status);
  const reviewRequired = run.status === 'review-required' || (decision === 'READY' && (run.reviewReasons?.length ?? 0) > 0);
  const tone = active ? 'running' : decision === 'NOT_READY' ? 'not-ready' : reviewRequired ? 'review' : decision === 'READY' ? 'ready' : 'review';
  elements.decision_hero.dataset.tone = tone;
  elements.decision_badge.dataset.tone = tone;
  elements.decision_badge.textContent = active ? 'In progress' : decision === 'NOT_READY' ? 'Do not release' : reviewRequired ? 'Review required' : decision === 'READY' ? 'Ready for release' : 'Decision unavailable';
  elements.decision_title.textContent = active
    ? 'This audit is still running'
    : decision === 'NOT_READY'
      ? 'The redesign is not ready yet'
      : reviewRequired && decision === 'READY'
      ? 'The checklist passed, but release signoff is withheld'
      : reviewRequired
        ? 'This run is evidence for review, not release authority'
        : decision === 'READY'
          ? 'The redesign is ready for release'
          : 'This run needs a release decision';
  const reviewCopy = (run.reviewReasons?.length ?? 0) > 0 ? ` Additional review requirements: ${run.reviewReasons.join('; ')}.` : '';
  elements.decision_summary.textContent = `${release?.reason ?? 'No authoritative release explanation is available.'}${reviewCopy}`;
  elements.decision_basis.textContent = reviewRequired
    ? 'The checklist result is preserved, but final release authority requires a new-ID sharded run with isolated performance provenance.'
    : release?.decisionBasis ?? 'Release decisions require completed, structured evidence for every blocking audit.';
  elements.context_run_id.textContent = run.id;
  elements.context_profile.textContent = humanize(run.options?.profile ?? report.run?.profile ?? 'unknown');
  const selected = run.options?.auditIds ?? [];
  elements.context_scope.textContent = selected.length
    ? `${selected.length} targeted check${selected.length === 1 ? '' : 's'}`
    : `All checks in the ${humanize(run.options?.profile ?? report.run?.profile ?? 'selected')} profile`;
  elements.context_started.textContent = formatDate(run.startedAt ?? report.run?.startedAt);
  elements.context_elapsed.textContent = elapsedLabel(run.startedAt ?? report.run?.startedAt, run.finishedAt ?? report.run?.finishedAt, report.run?.durationMs);
  elements.context_pipeline.textContent = run.pipeline
    ? `${humanize(run.pipeline.status)} · ${run.pipeline.reason}`
    : humanize(run.status);
  setExternalLink(elements.context_production, run.options?.productionUrl);
  setExternalLink(elements.context_candidate, run.options?.candidateUrl);
  elements.full_checklist_link.removeAttribute('target');
  elements.full_checklist_link.removeAttribute('rel');
  elements.full_checklist_link.href = '#audits-title';
  elements.manifest_download_link.href = artifactUrl('checklist/manifest.json');
  elements.manifest_download_link.setAttribute('download', `${run.id}-complete-checklist.json`);
  elements.manifest_download_link.textContent = 'Download raw checklist JSON (large)';
  elements.summary_generated.textContent = `Evidence index generated ${formatDate(report.generatedAt)}`;
}

function renderMetrics() {
  const summary = state.report.summary ?? {};
  const release = state.report.release ?? {};
  const metrics = [
    ['Documented checks', number(summary.total), 'Every expected behavior stays visible'],
    ['Executed checks', `${number(summary.executed)} / ${number(summary.total)}`, percentCopy(summary.executed, summary.total)],
    ['Release blockers', number(release.blockingFailures) + number(release.blockingIncomplete), `${number(release.blockingFailures)} failed or need review · ${number(release.blockingIncomplete)} incomplete`],
    ['Evidence files', number(summary.artifacts), `${number(summary.videos)} videos · ${number(summary.posters)} poster previews`],
    ['Structured executions', number(summary.structuredExecutions), 'Observed steps and findings, not just pass/fail'],
    ['Baseline issues', number(summary.baselineIssues), 'Existing production defects kept as context'],
  ];
  elements.metric_grid.replaceChildren(...metrics.map(([label, value, note]) => {
    const card = document.createElement('article');
    card.className = 'metric-card';
    const name = document.createElement('span');
    name.textContent = label;
    const result = document.createElement('strong');
    result.textContent = String(value);
    const detail = document.createElement('small');
    detail.textContent = note;
    card.append(name, result, detail);
    return card;
  }));
}

function renderBars() {
  const summary = state.report.summary ?? {};
  const byStatus = summary.byStatus ?? {};
  const bySeverity = summary.bySeverity ?? {};
  elements.status_total.textContent = `${number(summary.total)} documented checks`;
  renderBarList(elements.status_bars, STATUS_ORDER.map((status) => [status, number(byStatus[status])]), number(summary.total), true);
  renderBarList(elements.severity_bars, ['P0', 'P1', 'P2', 'P3'].map((severity) => [severity, number(bySeverity[severity])]), number(summary.total));
}

function renderBarList(container, entries, total, humanizeLabels = false) {
  container.replaceChildren();
  const visible = entries.filter(([, value]) => value > 0);
  if (visible.length === 0) return appendEmpty(container, 'No coverage counts are available for this run.');
  for (const [label, value] of visible) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const copy = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = humanizeLabels ? humanize(label) : label;
    const count = document.createElement('strong');
    count.textContent = String(value);
    copy.append(name, count);
    const track = document.createElement('div');
    track.className = 'bar-track';
    const bar = document.createElement('span');
    bar.className = `bar-fill tone-${String(label).toLowerCase().replaceAll('_', '-')}`;
    bar.style.width = `${Math.max(2, Math.round((value / Math.max(1, total)) * 100))}%`;
    track.append(bar);
    row.append(copy, track);
    container.append(row);
  }
}

function renderTopFindings() {
  const findings = state.report.topFindings ?? [];
  const total = number(state.report.topFindingCount);
  elements.finding_total.textContent = total ? `${total} finding${total === 1 ? '' : 's'} recorded` : 'No findings recorded';
  elements.top_findings.replaceChildren();
  if (findings.length === 0) {
    return appendEmpty(elements.top_findings, 'No structured findings were recorded. Confirm that all required audits ran before treating this as release-ready.');
  }
  for (const finding of findings.slice(0, 8)) {
    const card = document.createElement('article');
    card.className = 'finding-card';
    card.dataset.blocking = finding.blocking ? 'true' : 'false';
    const meta = document.createElement('div');
    meta.className = 'finding-meta';
    meta.append(badge(finding.severity, `severity-${String(finding.severity).toLowerCase()}`), badge(finding.auditStatus, `status-${statusTone(finding.auditStatus)}`));
    const title = document.createElement('h3');
    title.textContent = finding.title;
    const detail = document.createElement('p');
    detail.textContent = finding.detail;
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'text-button';
    link.textContent = `${finding.auditId} · ${finding.auditTitle}`;
    link.addEventListener('click', () => {
      elements.filter_query.value = finding.auditId;
      state.auditOffset = 0;
      void loadAudits().then(() => document.querySelector('#audits-title')?.scrollIntoView({ behavior: 'smooth' }));
    });
    card.append(meta, title, detail, link);
    elements.top_findings.append(card);
  }
}

function renderFilters() {
  const filters = state.report.filters ?? {};
  fillSelect(elements.filter_status, filters.statuses ?? [], humanize);
  fillSelect(elements.filter_severity, filters.severities ?? [], (value) => value);
  fillSelect(elements.filter_area, filters.areas ?? [], humanize);
  fillSelect(elements.filter_environment, filters.environments ?? [], humanize);
}

function fillSelect(select, values, label) {
  const existing = new Set([...select.options].map(({ value }) => value));
  for (const value of values) {
    if (existing.has(value)) continue;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label(value);
    select.append(option);
  }
}

async function loadAudits() {
  if (!state.report || !state.runId) return;
  state.auditsController?.abort();
  state.detailController?.abort();
  state.activeAuditId = null;
  const controller = new AbortController();
  const requestId = ++state.auditRequest;
  state.auditsController = controller;
  elements.audit_loading.hidden = false;
  elements.audit_error.hidden = true;
  elements.audit_list.setAttribute('aria-busy', 'true');
  elements.audit_previous.disabled = true;
  elements.audit_next.disabled = true;
  const query = new URLSearchParams({ offset: String(state.auditOffset), limit: String(PAGE_SIZE) });
  for (const [name, input] of [
    ['q', elements.filter_query], ['status', elements.filter_status], ['severity', elements.filter_severity],
    ['area', elements.filter_area], ['environment', elements.filter_environment], ['releaseBlocking', elements.filter_blocking],
  ]) {
    if (input.value) query.set(name, input.value);
  }
  if (elements.filter_manual.checked) query.set('manual', 'true');
  try {
    const page = await fetchJson(`/api/runs/${encodeURIComponent(state.runId)}/report/audits?${query}`, { signal: controller.signal });
    if (controller.signal.aborted || requestId !== state.auditRequest) return;
    renderAuditPage(page);
  } catch (error) {
    if (controller.signal.aborted) return;
    elements.audit_list.replaceChildren();
    elements.audit_error.hidden = false;
    elements.audit_error.textContent = `Audit results could not be loaded. ${friendlyError(error)}`;
    elements.audit_result_count.textContent = 'Load failed';
    announce(`Audit results failed to load. ${friendlyError(error)}`);
  } finally {
    if (requestId === state.auditRequest) {
      elements.audit_loading.hidden = true;
      elements.audit_list.setAttribute('aria-busy', 'false');
      state.auditsController = null;
    }
  }
}

function renderAuditPage(page) {
  const items = page.items ?? [];
  elements.audit_list.replaceChildren();
  if (items.length === 0) {
    appendEmpty(elements.audit_list, 'No checks match these filters. Clear one or more filters to broaden the report.');
  } else {
    for (const audit of items) elements.audit_list.append(auditCard(audit));
  }
  const start = page.total === 0 ? 0 : page.offset + 1;
  const end = page.offset + items.length;
  elements.audit_result_count.textContent = `${start}–${end} of ${page.total} matching checks`;
  elements.audit_page_label.textContent = page.total ? `Page ${Math.floor(page.offset / page.limit) + 1} of ${Math.ceil(page.total / page.limit)}` : 'No matching pages';
  elements.audit_previous.disabled = page.offset <= 0;
  elements.audit_next.disabled = !page.hasMore;
  state.auditOffset = page.offset;
  announce(`${items.length} audit results loaded, ${page.total} total matches.`);
}

function auditCard(audit) {
  const card = document.createElement('article');
  card.className = 'report-audit-card';
  card.dataset.status = statusTone(audit.status);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'audit-summary-button';
  button.setAttribute('aria-expanded', 'false');
  const heading = document.createElement('span');
  heading.className = 'audit-heading';
  const badges = document.createElement('span');
  badges.className = 'audit-badges';
  badges.append(badge(audit.status, `status-${statusTone(audit.status)}`), badge(audit.severity, `severity-${String(audit.severity).toLowerCase()}`));
  if (audit.releaseBlocking) badges.append(badge('Release blocker', 'blocking'));
  if (audit.manual) badges.append(badge('Manual', 'manual'));
  if (number(audit.evidenceCounts?.video)) badges.append(badge(`${audit.evidenceCounts.video} interaction video${audit.evidenceCounts.video === 1 ? '' : 's'}`, 'evidence-video'));
  if (number(audit.evidenceCounts?.screenshot)) badges.append(badge(`${audit.evidenceCounts.screenshot} static screenshot${audit.evidenceCounts.screenshot === 1 ? '' : 's'}`, 'evidence-screenshot'));
  const title = document.createElement('strong');
  title.textContent = `${audit.id} · ${audit.title}`;
  const promise = document.createElement('small');
  promise.textContent = audit.userPromise;
  heading.append(badges, title, promise);
  const outcome = document.createElement('span');
  outcome.className = 'audit-outcome-copy';
  const env = document.createElement('span');
  env.textContent = `Candidate ${humanize(audit.environmentStatus?.candidate)} · Current ${humanize(audit.environmentStatus?.production)}`;
  const reason = document.createElement('small');
  reason.textContent = audit.reason;
  outcome.append(env, reason);
  button.append(heading, outcome);
  const detail = document.createElement('div');
  detail.className = 'audit-detail';
  detail.hidden = true;
  button.addEventListener('click', () => void toggleAuditDetail(audit.id, button, detail));
  card.append(button, detail);
  return card;
}

async function toggleAuditDetail(auditId, button, detail) {
  if (state.activeAuditId === auditId && !detail.hidden) {
    state.detailController?.abort();
    state.activeAuditId = null;
    detail.hidden = true;
    detail.replaceChildren();
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  state.detailController?.abort();
  document.querySelectorAll('.audit-summary-button[aria-expanded="true"]').forEach((openButton) => openButton.setAttribute('aria-expanded', 'false'));
  document.querySelectorAll('.audit-detail:not([hidden])').forEach((openDetail) => {
    openDetail.hidden = true;
    openDetail.replaceChildren();
  });
  const controller = new AbortController();
  state.detailController = controller;
  state.activeAuditId = auditId;
  button.setAttribute('aria-expanded', 'true');
  detail.hidden = false;
  detail.append(statusMessage('Loading observations, findings, and linked evidence…', 'loading'));
  try {
    const value = await fetchJson(`/api/runs/${encodeURIComponent(state.runId)}/report/audits/${encodeURIComponent(auditId)}`, { signal: controller.signal });
    if (controller.signal.aborted || state.activeAuditId !== auditId) return;
    renderAuditDetail(detail, value);
    announce(`${auditId} evidence context loaded.`);
  } catch (error) {
    if (controller.signal.aborted) return;
    detail.replaceChildren(statusMessage(`Evidence context could not be loaded. ${friendlyError(error)}`, 'error'));
  } finally {
    if (state.detailController === controller) state.detailController = null;
  }
}

function renderAuditDetail(container, detail) {
  container.replaceChildren();
  const intro = document.createElement('div');
  intro.className = 'audit-detail-intro';
  intro.append(
    detailBlock('Expected behavior', detail.expected),
    detailBlock('Observed outcome', detail.reason),
    detailBlock('Evidence policy', evidencePolicyCopy(detail)),
  );
  if (detail.baseline?.note) intro.append(detailBlock('Production context', detail.baseline.note));
  container.append(intro);

  if ((detail.findings ?? []).length) {
    const section = document.createElement('section');
    section.className = 'detail-section';
    const title = document.createElement('h3');
    title.textContent = `Findings (${detail.findingCount})`;
    const list = document.createElement('div');
    list.className = 'detail-finding-list';
    for (const finding of detail.findings) {
      const item = document.createElement('article');
      item.append(badge(finding.severity, `severity-${String(finding.severity).toLowerCase()}`));
      const strong = document.createElement('strong');
      strong.textContent = finding.title;
      const copy = document.createElement('p');
      copy.textContent = finding.detail;
      item.append(strong, copy);
      list.append(item);
    }
    section.append(title, list);
    container.append(section);
  }

  const executions = detail.executions ?? [];
  const executionSection = document.createElement('section');
  executionSection.className = 'detail-section';
  const executionHeading = document.createElement('div');
  executionHeading.className = 'card-heading';
  const executionTitle = document.createElement('h3');
  executionTitle.textContent = `Browser and device evidence (${detail.executionCount})`;
  const truncation = document.createElement('span');
  truncation.className = 'muted';
  truncation.textContent = detail.executionsTruncated ? `${detail.executionReturned} bounded records available here` : 'All execution records indexed';
  executionHeading.append(executionTitle, truncation);
  const page = document.createElement('div');
  page.className = 'execution-page';
  const controls = document.createElement('div');
  controls.className = 'execution-pagination';
  let offset = 0;
  const render = () => {
    page.replaceChildren(...executions.slice(offset, offset + 6).map(executionCard));
    controls.replaceChildren();
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'secondary-button';
    previous.textContent = 'Previous evidence';
    previous.disabled = offset === 0;
    previous.addEventListener('click', () => { offset = Math.max(0, offset - 6); render(); });
    const label = document.createElement('span');
    label.className = 'muted';
    label.textContent = executions.length ? `${offset + 1}–${Math.min(offset + 6, executions.length)} of ${executions.length}` : 'No executions';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'secondary-button';
    next.textContent = 'Next evidence';
    next.disabled = offset + 6 >= executions.length;
    next.addEventListener('click', () => { offset += 6; render(); });
    controls.append(previous, label, next);
  };
  render();
  executionSection.append(executionHeading, page, controls);
  if (!executions.length) appendEmpty(page, detail.manual ? 'This manual check does not have signed evidence yet.' : 'No browser execution was recorded for this check.');
  container.append(executionSection);
}

function executionCard(execution) {
  const card = document.createElement('details');
  card.className = 'execution-card';
  const summary = document.createElement('summary');
  const copy = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = `${humanize(execution.environment)} · ${execution.project}`;
  const meta = document.createElement('small');
  meta.textContent = `${execution.browser} · ${humanize(execution.deviceClass)} · ${formatDuration(execution.durationMs)} · ${execution.artifactCount} evidence file${execution.artifactCount === 1 ? '' : 's'}`;
  copy.append(title, meta);
  summary.append(badge(execution.status, `status-${statusTone(execution.status)}`), copy);
  card.append(summary);
  const body = document.createElement('div');
  body.className = 'execution-body';
  const evidence = execution.evidence;
  if (!evidence) {
    body.append(statusMessage('Structured observations were not attached to this execution. Review its errors and source evidence.', 'review'));
  } else {
    const context = document.createElement('div');
    context.className = 'evidence-context-grid';
    context.append(
      detailBlock('Evidence window', `${formatDate(evidence.startedAt)} to ${formatDate(evidence.finishedAt)}`),
      detailBlock('Page', evidence.baseURL),
      detailBlock('HTTP responses', httpSummary(evidence)),
      detailBlock('Runtime signals', `${number(evidence.totals?.consoleErrors)} console errors · ${number(evidence.totals?.pageErrors)} page errors · ${number(evidence.totals?.failedRequests)} failed requests`),
    );
    body.append(context);
    appendEvidenceList(body, 'Performed steps', evidence.steps, (step) => `${humanize(step.status)} · ${step.name}${step.detail ? ` — ${step.detail}` : ''}`);
    appendEvidenceList(body, 'Observed values', evidence.observations, (observation) => `${observation.label}: ${observation.value}`);
    appendEvidenceList(body, 'Network problems', [...(evidence.http?.badResponses ?? []), ...(evidence.http?.failedRequests ?? [])], (item) => `${item.status ?? item.reason} · ${item.url}`);
    appendEvidenceList(body, 'Runtime errors', [...(evidence.consoleErrors ?? []), ...(evidence.pageErrors ?? [])], (item) => item);
  }
  if ((execution.errors ?? []).length) appendEvidenceList(body, 'Test errors', execution.errors, (error) => error.message ?? error.snippet ?? error.value ?? 'Unknown test error');
  renderExecutionArtifacts(body, execution.artifacts ?? [], execution.annotations ?? [], evidence?.evidencePolicy);
  card.append(body);
  return card;
}

function appendEvidenceList(container, title, items, format) {
  if (!items?.length) return;
  const section = document.createElement('section');
  section.className = 'evidence-list';
  const heading = document.createElement('h4');
  heading.textContent = title;
  const list = document.createElement('ul');
  for (const item of items.slice(0, 16)) {
    const entry = document.createElement('li');
    entry.textContent = format(item);
    list.append(entry);
  }
  section.append(heading, list);
  container.append(section);
}

function renderExecutionArtifacts(container, artifacts, annotations, evidencePolicy) {
  const available = artifacts.filter(({ available, href }) => available && href);
  if (!available.length) return;
  const section = document.createElement('section');
  section.className = 'execution-artifacts';
  const heading = document.createElement('h4');
  heading.textContent = `Linked evidence (${available.length})`;
  const media = document.createElement('div');
  media.className = 'evidence-media-grid';
  const links = document.createElement('div');
  links.className = 'evidence-link-list';
  for (const artifact of available) {
    const href = checklistArtifactUrl(artifact.href);
    if (artifact.kind === 'video') {
      const figure = document.createElement('figure');
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = href;
      if (artifact.poster?.href) video.poster = checklistArtifactUrl(artifact.poster.href);
      const caption = document.createElement('figcaption');
      const rationale = document.createElement('span');
      rationale.className = 'evidence-rationale';
      rationale.textContent = `Interaction video · ${artifactRationale(artifact, evidencePolicy, annotations, 'Action and response sequence')}`;
      const link = evidenceLink(href, artifact.name, formatBytes(artifact.sizeBytes));
      caption.append(rationale, document.createElement('br'));
      caption.append(link);
      if (artifact.poster?.href) caption.append(' · ', evidenceLink(checklistArtifactUrl(artifact.poster.href), 'Open poster', formatBytes(artifact.poster.sizeBytes)));
      figure.append(video, caption);
      media.append(figure);
    } else if (artifact.kind === 'screenshot') {
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      image.src = href;
      image.alt = `Screenshot evidence: ${artifact.name}`;
      image.loading = 'lazy';
      const caption = document.createElement('figcaption');
      const rationale = document.createElement('span');
      rationale.className = 'evidence-rationale';
      rationale.textContent = `Static screenshot · ${artifactRationale(artifact, evidencePolicy, annotations, 'Visual checkpoint')}`;
      caption.append(rationale, document.createElement('br'));
      caption.append(evidenceLink(href, artifact.name, formatBytes(artifact.sizeBytes)));
      figure.append(image, caption);
      media.append(figure);
    } else {
      links.append(evidenceLink(href, `${humanize(artifact.kind)} · ${artifact.name}`, formatBytes(artifact.sizeBytes)));
    }
  }
  section.append(heading);
  if (media.children.length) section.append(media);
  if (links.children.length) section.append(links);
  container.append(section);
}

function evidenceLink(href, label, size) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = size ? `${label} · ${size}` : label;
  return link;
}

function renderManualSummary() {
  const manual = state.report.manualEvidence ?? {};
  elements.manual_summary.replaceChildren();
  if (!number(manual.required)) {
    appendEmpty(elements.manual_summary, 'This run did not include any catalogued physical-device or assistive-technology checks.');
    return;
  }
  const headline = document.createElement('p');
  headline.className = 'large-summary';
  headline.textContent = `${number(manual.complete)} of ${number(manual.required)} manual checks have a recorded outcome.`;
  const detail = document.createElement('p');
  detail.className = 'muted';
  detail.textContent = `${number(manual.outstanding)} still need signed evidence. ${number(manual.failedOrBlocked)} failed or are blocked.`;
  const statuses = document.createElement('div');
  statuses.className = 'compact-badges';
  for (const [status, count] of Object.entries(manual.byStatus ?? {})) statuses.append(badge(`${humanize(status)} ${count}`, `status-${statusTone(status)}`));
  elements.manual_summary.append(headline, detail, statuses);
}

function renderAiSummary() {
  const review = state.report.aiReview;
  elements.ai_summary.replaceChildren();
  elements.ai_review_link.hidden = true;
  if (!review) {
    appendEmpty(elements.ai_summary, 'AI evidence review was not enabled for this run. Deterministic browser evidence remains authoritative.');
    return;
  }
  const notice = document.createElement('p');
  notice.className = 'advisory-notice';
  notice.textContent = 'Advisory only — AI cannot change the release decision.';
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = `${humanize(review.status)} · ${review.model || 'Model not recorded'}${review.api?.httpStatus ? ` · HTTP ${review.api.httpStatus}` : ''}${review.api?.latencyMs ? ` · ${review.api.latencyMs} ms` : ''}`;
  const summary = document.createElement('p');
  summary.textContent = review.executiveSummary || review.reason || 'No AI summary was produced.';
  const recommendation = document.createElement('p');
  recommendation.className = 'ai-recommendation';
  recommendation.textContent = review.releaseRecommendation || 'No advisory recommendation was produced.';
  elements.ai_summary.append(notice, meta, summary, recommendation);
  if ((review.findings ?? []).length) {
    const list = document.createElement('ul');
    list.className = 'ai-finding-list';
    for (const finding of review.findings.slice(0, 5)) {
      const item = document.createElement('li');
      item.textContent = `${finding.severity} · ${finding.title}: ${finding.summary}`;
      list.append(item);
    }
    elements.ai_summary.append(list);
  }
  elements.ai_review_link.href = artifactUrl('ai-review/index.html');
  elements.ai_review_link.hidden = false;
}

async function loadArtifacts() {
  try {
    const page = await fetchJson(`/api/runs/${encodeURIComponent(state.runId)}/artifacts?offset=0&limit=80`, { signal: state.reportController?.signal });
    state.artifacts = page;
    renderArtifactLinks(page);
  } catch (error) {
    elements.artifact_count.textContent = 'Evidence index unavailable';
    elements.report_links.replaceChildren(statusMessage(`Evidence links could not be loaded. ${friendlyError(error)}`, 'error'));
  }
}

function renderArtifactLinks(page) {
  elements.report_links.replaceChildren();
  const totalCopy = page.totalComplete === false ? `${page.knownTotal ?? page.total}+ indexed files` : `${page.total} evidence files`;
  elements.artifact_count.textContent = totalCopy;
  const allowedKinds = new Set(['checklist', 'playwright-report', 'ai-review', 'video', 'image', 'trace', 'data']);
  const files = (page.files ?? []).filter(({ kind, path }) => allowedKinds.has(kind) && !['checklist/manifest.json', 'checklist/index.html'].includes(path)).slice(0, 16);
  if (!files.length) return appendEmpty(elements.report_links, 'No linked evidence files are available yet.');
  for (const file of files) {
    const link = document.createElement('a');
    link.className = 'quick-link';
    link.href = file.url;
    link.target = '_blank';
    link.rel = 'noopener';
    const kind = document.createElement('small');
    kind.textContent = humanize(file.kind);
    const path = document.createElement('strong');
    path.textContent = file.path;
    const size = document.createElement('span');
    size.textContent = formatBytes(file.bytes);
    link.append(kind, path, size);
    elements.report_links.append(link);
  }
}

async function loadLog() {
  state.logController?.abort();
  const controller = new AbortController();
  state.logController = controller;
  elements.load_log.disabled = true;
  elements.load_log.textContent = 'Loading excerpt…';
  elements.log_state.textContent = 'Loading the most recent 64 KB from the persisted run logs…';
  try {
    const snapshot = await fetchJson(`/api/runs/${encodeURIComponent(state.runId)}/logs?maxBytes=${LOG_PREVIEW_BYTES}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    const log = String(snapshot.log ?? '').slice(-LOG_PREVIEW_BYTES);
    elements.report_log.textContent = log || 'No log output has been recorded.';
    elements.report_log.hidden = false;
    elements.log_state.textContent = snapshot.truncated
      ? `Showing the newest ${formatBytes(snapshot.bytes)}. Earlier output is preserved in the complete source logs below.`
      : `Showing ${formatBytes(snapshot.bytes)} of persisted output.`;
    elements.log_links.replaceChildren();
    for (const source of snapshot.sources ?? []) {
      elements.log_links.append(evidenceLink(artifactUrl(source.path), `Complete log · ${source.path}`, formatBytes(source.size)));
    }
    announce('Recent execution log loaded.');
  } catch (error) {
    if (controller.signal.aborted) return;
    elements.log_state.textContent = `The log excerpt could not be loaded. ${friendlyError(error)}`;
    elements.report_log.hidden = true;
  } finally {
    if (state.logController === controller) state.logController = null;
    elements.load_log.disabled = false;
    elements.load_log.textContent = 'Refresh recent log excerpt';
  }
}

function detailBlock(label, value) {
  const block = document.createElement('div');
  const title = document.createElement('small');
  title.textContent = label;
  const copy = document.createElement('p');
  copy.textContent = value || 'Not recorded';
  block.append(title, copy);
  return block;
}

function statusMessage(message, tone) {
  const copy = document.createElement('p');
  copy.className = `inline-state ${tone}`;
  copy.textContent = message;
  return copy;
}

function appendEmpty(container, message) {
  const empty = document.createElement('p');
  empty.className = 'report-empty';
  empty.textContent = message;
  container.append(empty);
}

function badge(label, className) {
  const value = document.createElement('span');
  value.className = `report-badge ${className}`;
  value.textContent = humanize(label);
  return value;
}

function setExternalLink(element, url) {
  if (!url) {
    element.removeAttribute('href');
    element.textContent = 'Not recorded';
    return;
  }
  element.href = url;
  element.textContent = url;
}

function artifactUrl(relativePath) {
  return `/artifacts/${encodeURIComponent(state.runId)}/${String(relativePath).split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
}

function checklistArtifactUrl(relativePath) {
  return artifactUrl(`checklist/${String(relativePath).replace(/^\.?\//, '')}`);
}

function httpSummary(evidence) {
  const counts = Object.entries(evidence.http?.statusCounts ?? {}).sort(([left], [right]) => Number(left) - Number(right));
  if (!counts.length) return 'No response codes recorded';
  return counts.map(([status, count]) => `HTTP ${status}: ${count}`).join(' · ');
}

function evidencePolicyCopy(audit) {
  const required = audit.requiredEvidence ?? [];
  const actual = audit.evidenceCounts ?? {};
  const requiredCopy = required.length ? required.map(humanize).join(', ') : 'No media type explicitly required';
  const policy = audit.evidencePolicy?.rationale ? `${audit.evidencePolicy.rationale} ` : '';
  return `${policy}Required: ${requiredCopy}. Available: ${number(actual.video)} interaction video${number(actual.video) === 1 ? '' : 's'} and ${number(actual.screenshot)} static screenshot${number(actual.screenshot) === 1 ? '' : 's'}.`;
}

function artifactRationale(artifact, evidencePolicy, annotations, fallback) {
  if (artifact.rationale) return artifact.rationale;
  if (evidencePolicy?.rationale) return evidencePolicy.rationale;
  const matching = annotations.find(({ type, description }) => description && /evidence[-_ ]?(rationale|policy)|video[-_ ]?rationale|screenshot[-_ ]?rationale/i.test(type));
  return matching?.description ?? fallback;
}

async function fetchJson(url, { signal, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error ?? `Request failed with HTTP ${response.status}.`);
    return value;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function friendlyError(error) {
  if (error?.name === 'AbortError') return 'The request was cancelled.';
  if (error?.name === 'TimeoutError') return 'The request took too long. Try again.';
  if (error instanceof TypeError) return 'The portal could not be reached. Confirm the Docker portal is running.';
  return error instanceof Error ? error.message : String(error);
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function humanize(value) {
  if (value == null || value === '') return 'Unknown';
  return String(value).replaceAll('_', ' ').replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(status) {
  const normalized = String(status ?? '').toUpperCase();
  if (normalized === 'PASS') return 'pass';
  if (['FAIL', 'BLOCKED'].includes(normalized)) return 'fail';
  if (['FLAKY', 'REVIEW', 'INTENDED_CHANGE'].includes(normalized)) return 'review';
  return 'incomplete';
}

function formatDate(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function elapsedLabel(startedAt, finishedAt, durationMs) {
  if (Number.isFinite(Number(durationMs))) return formatDuration(Number(durationMs));
  if (!startedAt) return 'Not started';
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  return Number.isFinite(start) && Number.isFinite(end) ? formatDuration(Math.max(0, end - start)) : 'Not recorded';
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(number(milliseconds) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatBytes(bytes) {
  const value = number(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function percentCopy(part, total) {
  const denominator = number(total);
  return denominator ? `${Math.round((number(part) / denominator) * 100)}% of the documented checklist` : 'No documented coverage';
}

function announce(message) {
  elements.report_announcer.textContent = '';
  window.setTimeout(() => { elements.report_announcer.textContent = message; }, 20);
}
