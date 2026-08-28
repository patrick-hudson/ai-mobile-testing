import { createConsoleSplitter } from './console-shell.js';

const PAGE_SIZE = 25;
const LOG_PREVIEW_BYTES = 64 * 1024;
const REPORT_RETRY_MS = 5_000;
const TERMINAL_STATUSES = new Set(['passed', 'not-ready', 'review-required', 'failed', 'evidence-failed', 'stopped', 'spawn-failed']);
const STATUS_ORDER = ['FAIL', 'BLOCKED', 'FLAKY', 'REVIEW', 'MANUAL_REQUIRED', 'NOT_RUN', 'INTENDED_CHANGE', 'PASS'];

const state = {
  mode: 'comparative',
  runId: null,
  run: null,
  report: null,
  artifacts: null,
  reportController: null,
  auditsController: null,
  detailController: null,
  logController: null,
  aiController: null,
  aiRetryTimer: null,
  aiAdvisory: null,
  retryTimer: null,
  auditOffset: 0,
  auditRequest: 0,
  activeAuditId: null,
  queryTimer: null,
  splitter: null,
};

const elements = Object.fromEntries([
  'report-connection', 'refresh-report', 'report-loading', 'report-error', 'report-error-title', 'report-error-message',
  'retry-report', 'report-content', 'decision-hero', 'decision-title', 'decision-badge', 'decision-summary', 'decision-basis',
  'visual-gallery-link', 'full-checklist-link', 'manifest-download-link', 'context-run-id', 'context-profile', 'context-scope', 'context-started',
  'context-elapsed', 'context-pipeline', 'context-production', 'context-candidate', 'summary-generated', 'metric-grid',
  'status-total', 'status-bars', 'severity-bars', 'finding-total', 'top-findings', 'audit-result-count', 'audit-filters',
  'filter-query', 'filter-status', 'filter-severity', 'filter-area', 'filter-environment', 'filter-blocking', 'filter-manual',
  'clear-filters', 'audit-loading', 'audit-error', 'audit-list', 'audit-previous', 'audit-next', 'audit-page-label',
  'manual-summary', 'ai-card', 'ai-summary', 'ai-review-link', 'ai-review-retry', 'artifact-count', 'report-links', 'load-log', 'log-state',
  'report-log', 'log-links', 'report-announcer', 'manual-workspace-link', 'report-trust-facts',
].map((id) => [id.replaceAll('-', '_'), document.querySelector(`#${id}`)]));

const reportConsole = document.querySelector('#report-console');
const reportSeparator = document.querySelector('#report-separator');
const reportInspector = document.querySelector('#report-inspector');
if (reportConsole && reportSeparator && reportInspector) {
  state.splitter = createConsoleSplitter({
    shell: reportConsole,
    separator: reportSeparator,
    inspector: reportInspector,
  });
}

init().catch((error) => showFatal('This report could not be loaded', friendlyError(error)));

async function init() {
  const query = new URLSearchParams(window.location.search);
  const requestedId = query.get('run')?.trim() ?? '';
  state.mode = query.get('mode') === 'single-site' ? 'single-site' : 'comparative';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,159}$/.test(requestedId)) {
    return showFatal('Choose a valid run', 'This report link is missing a valid run ID. Return to the audit console and open a completed run.');
  }
  state.runId = requestedId;
  const workspaceUrl = `/run.html?mode=${encodeURIComponent(state.mode)}&run=${encodeURIComponent(requestedId)}&view=report`;
  document.querySelector('.report-back').href = workspaceUrl;
  elements.manual_workspace_link.href = workspaceUrl;
  if (state.mode === 'single-site') {
    elements.visual_gallery_link.hidden = false;
    elements.visual_gallery_link.href = `/gallery.html?mode=single-site&run=${encodeURIComponent(requestedId)}&from=report`;
    elements.visual_gallery_link.textContent = 'Visual evidence review';
    document.title = `Run ${requestedId} · Single-site health report`;
    document.querySelector('.report-back').textContent = 'Run workspace';
    document.querySelector('#report-loading p').textContent = 'Loading Site Health and the compact evidence index…';
    document.querySelector('.decision-copy .eyebrow').textContent = 'SINGLE-SITE HEALTH REPORT';
  } else {
    elements.visual_gallery_link.href = `/gallery.html?run=${encodeURIComponent(requestedId)}&from=report`;
    document.title = `Run ${requestedId} · Quitting 7-OH release report`;
  }
  bindEvents();
  await loadReport();
}

function apiPath(suffix = '') {
  const encodedId = encodeURIComponent(state.runId);
  return state.mode === 'single-site'
    ? `/api/single-site/runs/${encodedId}${suffix}`
    : `/api/runs/${encodedId}${suffix}`;
}

function runIsActive(run) {
  if (state.mode === 'single-site') {
    const executionTerminal = ['completed', 'failed', 'incomplete', 'cancelled'].includes(run.status);
    const finalizationTerminal = ['complete', 'incomplete', 'deadline-exceeded', 'invalid'].includes(run.finalization?.status);
    return !executionTerminal || !finalizationTerminal;
  }
  return !TERMINAL_STATUSES.has(run.status);
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
  elements.ai_review_retry.addEventListener('click', () => void retrySingleSiteAiReview());
  window.addEventListener('pagehide', abortRequests);
}

function abortRequests() {
  state.reportController?.abort();
  state.auditsController?.abort();
  state.detailController?.abort();
  state.logController?.abort();
  state.aiController?.abort();
  window.clearTimeout(state.aiRetryTimer);
  window.clearTimeout(state.retryTimer);
  window.clearTimeout(state.queryTimer);
}

window.addEventListener('pagehide', () => state.splitter?.destroy(), { once: true });

async function loadReport() {
  const hasKnownContent = state.run !== null && state.report !== null;
  window.clearTimeout(state.retryTimer);
  state.reportController?.abort();
  state.auditsController?.abort();
  state.detailController?.abort();
  state.aiController?.abort();
  const controller = new AbortController();
  state.reportController = controller;
  if (hasKnownContent) {
    elements.report_content.hidden = false;
    elements.report_content.setAttribute('aria-busy', 'true');
    elements.report_loading.hidden = true;
    elements.report_error.hidden = true;
    elements.report_connection.textContent = 'Refreshing while current report remains visible…';
  } else {
    setMainState('loading');
    elements.report_connection.textContent = 'Loading report…';
  }
  elements.refresh_report.disabled = true;
  announce(hasKnownContent ? 'Refreshing the run report while current data remains available.' : 'Loading the run report.');
  try {
    const [runResult, reportResult] = await Promise.allSettled([
      fetchJson(apiPath(), { signal: controller.signal }),
      fetchJson(apiPath('/report'), { signal: controller.signal }),
    ]);
    if (controller.signal.aborted) return;
    if (runResult.status === 'rejected') throw runResult.reason;
    if (reportResult.status === 'rejected') {
      const active = runIsActive(runResult.value);
      if (hasKnownContent) {
        showRefreshFailure(reportResult.reason, { retry: active });
        return;
      }
      state.run = runResult.value;
      showReportUnavailable(active, friendlyError(reportResult.reason));
      if (active) state.retryTimer = window.setTimeout(() => void loadReport(), REPORT_RETRY_MS);
      return;
    }
    state.run = runResult.value;
    state.report = reportResult.value;
    setMainState('content');
    renderReport();
    elements.report_connection.textContent = `Loaded ${formatDate(state.report.generatedAt)}`;
    announce(state.mode === 'single-site'
      ? `Site Health report loaded. ${state.report.siteHealth?.displayLabel ?? 'Health verdict unavailable'}.`
      : `Release report loaded. ${state.run.status === 'review-required' ? 'Release signoff is withheld for review.' : `Decision: ${state.run.release?.decision ?? state.report.release?.decision ?? 'not available'}.`}`);
    await Promise.allSettled([
      loadAudits(),
      loadArtifacts(),
      ...(state.mode === 'single-site' ? [loadSingleSiteAiReview()] : []),
    ]);
    if (runIsActive(state.run)) {
      state.retryTimer = window.setTimeout(() => void loadReport(), REPORT_RETRY_MS);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    if (hasKnownContent) showRefreshFailure(error);
    else showFatal('This report could not be loaded', friendlyError(error));
  } finally {
    if (state.reportController === controller) state.reportController = null;
    elements.report_content.setAttribute('aria-busy', 'false');
    elements.refresh_report.disabled = false;
  }
}

function showRefreshFailure(error, { retry = false } = {}) {
  const detail = friendlyError(error);
  elements.report_loading.hidden = true;
  elements.report_error.hidden = true;
  elements.report_content.hidden = false;
  elements.report_connection.textContent = 'Refresh failed · showing last known report';
  announce(`Report refresh failed. The last known sourced report remains visible. ${detail}`);
  if (retry) state.retryTimer = window.setTimeout(() => void loadReport(), REPORT_RETRY_MS);
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
  if (state.mode === 'single-site') {
    renderSingleSiteReport();
    return;
  }
  renderDecision();
  renderMetrics();
  renderBars();
  renderTopFindings();
  renderFilters();
  renderManualSummary();
  renderAiSummary();
}

function renderSingleSiteReport() {
  const { run, report } = state;
  const verdict = report.siteHealth?.verdict ?? 'INCOMPLETE';
  const active = runIsActive(run);
  const tone = active ? 'running' : verdict === 'HEALTHY' ? 'ready' : verdict === 'FINDINGS' ? 'review' : 'not-ready';
  elements.decision_hero.dataset.tone = tone;
  elements.decision_badge.dataset.tone = tone;
  elements.decision_badge.textContent = active ? 'Finalizing' : report.siteHealth?.displayLabel ?? verdict;
  elements.decision_title.textContent = active
    ? 'This site audit is still being finalized'
    : verdict === 'HEALTHY'
      ? 'No deterministic findings in the completed scope'
      : verdict === 'FINDINGS'
        ? 'Deterministic findings need review'
        : 'This audit is incomplete';
  elements.decision_summary.textContent = report.siteHealth?.reason ?? 'Site Health is unavailable.';
  elements.decision_basis.textContent = `${report.promotion?.statement ?? 'Site Health is advisory and has no promotion authority.'} Coverage ${humanize(report.coverage?.status)}; evidence ${humanize(report.evidenceCompletion?.status)}; authority ${humanize(report.evidenceAuthority?.status)}.`;
  elements.context_run_id.textContent = run.id;
  elements.context_profile.textContent = 'Single-site audit';
  elements.context_scope.textContent = `${report.scope?.qualifier ?? run.scope?.qualifier ?? 'TARGETED'} · ${reportedCount(report.scope?.selected?.total)} selected · ${reportedCount(report.scope?.omitted?.total)} omitted`;
  elements.context_started.textContent = formatDate(run.createdAt);
  elements.context_elapsed.textContent = elapsedLabel(run.createdAt, run.updatedAt);
  elements.context_pipeline.textContent = `${humanize(run.status)} · finalization ${humanize(run.finalization?.status ?? 'pending')} · ${humanize(report.pipelineIntegrity?.status ?? 'unknown')}`;
  setExternalLink(elements.context_production, report.auditedUrl ?? run.url);
  elements.context_production.closest('.context-wide').querySelector('dt').textContent = 'Audited site';
  elements.context_candidate.closest('.context-wide').hidden = true;
  elements.full_checklist_link.removeAttribute('target');
  elements.full_checklist_link.removeAttribute('rel');
  elements.full_checklist_link.href = '#audits-title';
  elements.full_checklist_link.textContent = 'Review every audited feature';
  elements.manifest_download_link.href = `${apiPath('/report')}?revision=${encodeURIComponent(report.publicationRevision)}`;
  elements.manifest_download_link.setAttribute('download', `${run.id}-site-health-summary.json`);
  elements.manifest_download_link.textContent = 'Download compact Site Health summary';
  elements.summary_generated.textContent = `Immutable evidence index generated ${formatDate(report.generatedAt)}`;
  renderTrustFacts([
    ['Site Health verdict', report.siteHealth?.displayLabel ?? verdict, report.siteHealth?.reason ?? 'No verdict explanation is available.'],
    ['Coverage', report.coverage?.status ?? 'Unavailable', `${reportedCount(report.coverage?.gapCount)} gaps · ${reportedCount(report.coverage?.limitationCount)} limitations`],
    ['Evidence Authority', report.evidenceAuthority?.status ?? 'Unavailable', 'Determines whether captured evidence can support a conclusion.'],
    ['Evidence completion', report.evidenceCompletion?.status ?? 'Unavailable', 'Evidence availability is independent of the product verdict.'],
    ['Pipeline Integrity', report.pipelineIntegrity?.status ?? 'Unavailable', 'Reporter and finalization integrity remain independent of findings.'],
    ['Manual acceptance', report.manual?.status ?? 'Unavailable', `${reportedCount(report.manual?.outstanding)} outstanding · ${reportedCount(report.manual?.failedOrBlocked)} failed or blocked`],
    ['Publication', report.publicationRevision ? 'Finalized' : 'Unavailable', report.publicationRevision ? `Revision ${report.publicationRevision}` : 'No immutable publication revision is available.'],
  ]);

  const metrics = [
    ['Site Health', report.siteHealth?.displayLabel ?? verdict, report.siteHealth?.reason ?? 'No health explanation'],
    ['Audited definitions', reportedCount(report.auditPages?.total), `${reportedCount(report.scope?.outsideMode?.total)} comparison-only definitions kept outside this mode`],
    ['Deterministic findings', reportedCount(report.findings?.count), 'Assertion outcomes, never AI-generated verdicts'],
    ['Coverage', report.coverage?.status ?? 'Unavailable', `${reportedCount(report.coverage?.gapCount)} gaps · ${reportedCount(report.coverage?.limitationCount)} limitations`],
    ['Manual acceptance', humanize(report.manual?.status ?? 'Unavailable'), `${reportedCount(report.manual?.outstanding)} outstanding · ${reportedCount(report.manual?.failedOrBlocked)} failed or blocked`],
    ['Visual review', reportedCount(report.visualReview?.attentionRequired), `${reportedCount(report.visualReview?.total)} comparable visual states · changed items need human review`],
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
  elements.status_total.textContent = `${number(report.auditPages?.total)} audited definitions`;
  elements.status_bars.replaceChildren(statusMessage('Outcome totals stay paged with the audit rows below so this page never loads one giant evidence file.', 'review'));
  elements.severity_bars.replaceChildren(statusMessage(`${number(report.coverage?.gapCount)} coverage gaps · ${number(report.scope?.omitted?.total)} operator omissions · ${number(report.scope?.outsideMode?.total)} comparison-only exclusions`, report.coverage?.status === 'COMPLETE' ? 'success' : 'review'));
  elements.finding_total.textContent = `${number(report.findings?.count)} deterministic finding${number(report.findings?.count) === 1 ? '' : 's'}`;
  elements.top_findings.replaceChildren();
  appendEmpty(
    elements.top_findings,
    number(report.findings?.count)
      ? 'Filter the paged checklist to FAIL, FLAKY, BLOCKED, or REVIEW to inspect each finding with its exact audit context.'
      : 'No deterministic findings were recorded in the completed scope. Coverage, manual work, visual review, and evidence authority remain separate dimensions.',
  );
  const visualActions = document.createElement('div');
  visualActions.className = 'report-state-actions';
  const attention = document.createElement('a');
  attention.className = 'primary-button';
  attention.href = `/gallery.html?mode=single-site&run=${encodeURIComponent(run.id)}&from=report`;
  attention.textContent = `Review ${number(report.visualReview?.attentionRequired)} visual attention item${number(report.visualReview?.attentionRequired) === 1 ? '' : 's'}`;
  const browse = document.createElement('a');
  browse.className = 'secondary-button';
  browse.href = `/gallery.html?mode=single-site&run=${encodeURIComponent(run.id)}&from=report&review=all`;
  browse.textContent = 'Browse all visual evidence';
  visualActions.append(attention, browse);
  elements.top_findings.append(visualActions);
  elements.filter_environment.closest('label').hidden = true;
  elements.filter_blocking.closest('label').hidden = true;
  fillSelect(elements.filter_status, STATUS_ORDER, humanize);
  fillSelect(elements.filter_severity, ['P0', 'P1', 'P2', 'P3'], (value) => value);
  elements.manual_summary.replaceChildren();
  const manualHeadline = document.createElement('p');
  manualHeadline.className = 'large-summary';
  manualHeadline.textContent = `${number(report.manual?.complete)} of ${number(report.manual?.required)} required manual checks are complete.`;
  const manualDetail = document.createElement('p');
  manualDetail.className = 'muted';
  manualDetail.textContent = `${number(report.manual?.outstanding)} outstanding · ${number(report.manual?.failedOrBlocked)} failed or blocked. Manual status does not rewrite deterministic browser findings.`;
  elements.manual_summary.append(manualHeadline, manualDetail);
  elements.ai_summary.replaceChildren();
  renderSingleSiteAiStatus(run.aiReview);
}

function renderSingleSiteAiStatus(aiReview, result = null) {
  const previousState = state.aiAdvisory?.state ?? null;
  state.aiAdvisory = aiReview;
  elements.ai_card.setAttribute('aria-busy', String(['pending', 'running', 'waiting-for-finalization'].includes(aiReview?.state)));
  elements.ai_summary.replaceChildren();
  elements.ai_review_link.hidden = true;
  elements.ai_review_retry.hidden = true;
  const stateLabel = aiReview?.state ?? 'disabled';
  const headline = document.createElement('p');
  headline.className = 'large-summary';
  headline.textContent = stateLabel === 'completed' ? 'Advisory review complete'
    : stateLabel === 'running' ? 'AI is reviewing the finalized evidence'
      : stateLabel === 'pending' ? 'AI review is queued'
        : stateLabel === 'waiting-for-finalization' ? 'Waiting for deterministic finalization'
          : stateLabel === 'disabled' ? 'Not requested for this run'
            : `AI review ${humanize(stateLabel)}`;
  const detail = document.createElement('p');
  detail.className = 'muted';
  detail.textContent = result?.review?.review?.executiveSummary
    ?? aiReview?.status?.error?.message
    ?? aiReview?.unavailableReason
    ?? 'Optional AI interpretation is advisory only and cannot change deterministic Findings, Site Health, Coverage, promotion, baselines, or human decisions.';
  const guardrail = document.createElement('p');
  guardrail.className = 'advisory-notice';
  guardrail.textContent = 'Advisory only: AI cannot change deterministic Findings, Site Health, Coverage, promotion, baselines, or human decisions.';
  elements.ai_summary.append(headline, detail, guardrail);
  if (result) {
    const findings = Array.isArray(result.review?.review?.findings) ? result.review.review.findings : [];
    const meta = document.createElement('p');
    meta.className = 'advisory-notice';
    meta.textContent = `${findings.length} advisory observation${findings.length === 1 ? '' : 's'} · model ${result.status?.model ?? aiReview?.model ?? 'unknown'} · gating disabled`;
    elements.ai_summary.append(meta);
  }
  if (aiReview?.status?.state === 'completed') {
    elements.ai_review_link.href = apiPath('/ai-review/result');
    elements.ai_review_link.textContent = 'Open complete advisory JSON';
    elements.ai_review_link.hidden = false;
  }
  if (aiReview?.optedIn === true && aiReview?.status?.retryable === true
    && ['failed', 'unavailable'].includes(aiReview?.status?.state)) {
    elements.ai_review_retry.hidden = false;
  }
  if (previousState && previousState !== aiReview?.state) {
    announce(`AI advisory state changed from ${humanize(previousState)} to ${humanize(aiReview?.state)}.`);
  }
}

async function loadSingleSiteAiReview() {
  state.aiController?.abort();
  const controller = new AbortController();
  state.aiController = controller;
  try {
    const advisory = await fetchJson(apiPath('/ai-review'), { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (advisory.state !== 'completed' || !advisory.result) {
      renderSingleSiteAiStatus({ ...state.run.aiReview, ...advisory });
      if (['pending', 'running', 'waiting-for-finalization'].includes(advisory.state)) {
        window.clearTimeout(state.aiRetryTimer);
        state.aiRetryTimer = window.setTimeout(() => void loadSingleSiteAiReview(), 2_000);
      }
      return;
    }
    const result = await fetchJson(advisory.result, { signal: controller.signal });
    if (controller.signal.aborted) return;
    renderSingleSiteAiStatus({ ...state.run.aiReview, ...advisory }, result);
  } catch (error) {
    if (controller.signal.aborted) return;
    renderSingleSiteAiStatus({
      ...state.run.aiReview,
      state: 'unavailable',
      status: { error: { message: friendlyError(error) } },
    });
  } finally {
    if (state.aiController === controller) state.aiController = null;
  }
}

async function retrySingleSiteAiReview() {
  const status = state.aiAdvisory?.status;
  if (!status || !Number.isSafeInteger(status.stateRevision)
    || !['failed', 'unavailable'].includes(status.state)) return;
  if (!window.confirm('Retry this optional AI advisory? Deterministic Site Health and Findings will remain unchanged.')) return;
  elements.ai_review_retry.disabled = true;
  elements.ai_review_retry.classList.add('is-loading');
  elements.ai_review_retry.setAttribute('aria-busy', 'true');
  elements.ai_review_retry.textContent = 'Retrying advisory…';
  announce('Retrying the optional AI advisory review.');
  try {
    const next = await fetchJson(apiPath('/ai-review'), {
      method: 'POST',
      body: JSON.stringify({
        expectedStateRevision: status.stateRevision,
        confirmation: `RETRY AI ${state.runId}`,
      }),
    });
    renderSingleSiteAiStatus({ ...state.aiAdvisory, state: next.state, status: next });
    announce(next.state === 'pending'
      ? 'AI advisory retry is queued.'
      : `AI advisory retry is ${humanize(next.state)}.`);
    window.clearTimeout(state.aiRetryTimer);
    state.aiRetryTimer = window.setTimeout(() => void loadSingleSiteAiReview(), 1_000);
  } catch (error) {
    renderSingleSiteAiStatus({
      ...state.aiAdvisory,
      state: 'unavailable',
      unavailableReason: friendlyError(error),
    });
    announce(`AI advisory retry failed. ${friendlyError(error)}`);
  } finally {
    elements.ai_review_retry.disabled = false;
    elements.ai_review_retry.classList.remove('is-loading');
    elements.ai_review_retry.removeAttribute('aria-busy');
    elements.ai_review_retry.textContent = 'Retry advisory review';
  }
}

function renderDecision() {
  const { run, report } = state;
  const active = !TERMINAL_STATUSES.has(run.status);
  // The run lifecycle is the current authority. A compact report can be a
  // successful but provisional snapshot produced before a later stage failed.
  const release = { ...(report.release ?? {}), ...(run.release ?? {}) };
  const decision = release?.decision ?? 'UNAVAILABLE';
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
  const evidenceAuthority = release?.diagnosticCountsAuthoritative === true
    ? 'Authoritative'
    : release?.diagnosticCountsAuthoritative === false
      ? 'Withheld'
      : 'Unavailable';
  const executed = reportedNumber(report.summary?.executed);
  const documented = reportedNumber(report.summary?.total);
  const manualOutstanding = reportedNumber(report.manualEvidence?.outstanding);
  const manualFailed = reportedNumber(report.manualEvidence?.failedOrBlocked);
  renderTrustFacts([
    ['Release decision', reviewRequired ? 'Review required' : release?.decision ?? 'Unavailable', release?.reason ?? 'No release explanation is available.'],
    ['Coverage', executed === null || documented === null ? 'Unavailable' : `${executed} / ${documented} executed`, executed === null || documented === null ? 'Coverage counts were not published.' : `${Math.max(0, documented - executed)} documented checks were not executed.`],
    ['Evidence Authority', evidenceAuthority, evidenceAuthority === 'Withheld' ? 'Diagnostic counts remain visible but cannot support release authority.' : 'Derived from the published report integrity contract.'],
    ['Pipeline Integrity', run.pipeline?.status ?? (release?.runIntegrityFailure === true ? 'Failed' : 'Unavailable'), run.pipeline?.reason ?? 'No pipeline explanation is available.'],
    ['Manual acceptance', manualOutstanding === null ? 'Unavailable' : manualOutstanding > 0 ? 'Outstanding' : 'Complete', `${manualOutstanding ?? 'Unavailable'} outstanding · ${manualFailed ?? 'Unavailable'} failed or blocked`],
    ['Publication', report.publicationRevision ? 'Finalized' : 'Unavailable', report.publicationRevision ? `Revision ${report.publicationRevision}` : 'No immutable publication revision is available.'],
  ]);
}

function renderTrustFacts(entries) {
  elements.report_trust_facts.replaceChildren();
  for (const [label, value, detail] of entries) {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    const status = document.createElement('strong');
    status.textContent = humanize(value);
    const explanation = document.createElement('span');
    explanation.textContent = detail;
    description.append(status, explanation);
    group.append(term, description);
    elements.report_trust_facts.append(group);
  }
}

function renderMetrics() {
  const summary = state.report.summary ?? {};
  const release = { ...(state.report.release ?? {}), ...(state.run.release ?? {}) };
  const metrics = [
    ['Documented checks', reportedCount(summary.total), 'Every expected behavior stays visible'],
    ['Executed checks', reportedRatio(summary.executed, summary.total), reportedNumber(summary.total) === null ? 'Coverage counts were not published' : percentCopy(summary.executed, summary.total)],
    ['Release blockers', reportedSum(release.blockingFailures, release.blockingIncomplete), `${reportedCount(release.blockingFailures)} failed or need review · ${reportedCount(release.blockingIncomplete)} incomplete`],
    ['Evidence files', reportedCount(summary.artifacts), `${reportedCount(summary.usableInteractionVideos ?? summary.videos)} usable interaction videos · ${reportedCount(summary.diagnosticVideos)} diagnostic videos · ${reportedCount(summary.posters)} poster previews`],
    ['Structured executions', reportedCount(summary.structuredExecutions), 'Observed steps and findings, not just pass/fail'],
    ['Baseline issues', reportedCount(summary.baselineIssues), 'Existing production defects kept as context'],
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
  const attention = state.report.topAttention ?? [];
  const attentionTotal = number(state.report.topAttentionCount);
  elements.finding_total.textContent = total && attentionTotal
    ? `${total} structured finding${total === 1 ? '' : 's'} · ${attentionTotal} other attention outcome${attentionTotal === 1 ? '' : 's'}`
    : total
      ? `${total} finding${total === 1 ? '' : 's'} recorded`
      : attentionTotal
        ? `${attentionTotal} attention outcome${attentionTotal === 1 ? '' : 's'}`
        : 'No findings or attention outcomes recorded';
  elements.top_findings.replaceChildren();
  if (findings.length === 0 && attention.length === 0) {
    return appendEmpty(elements.top_findings, 'No structured findings were recorded. Confirm that all required audits ran before treating this as release-ready.');
  }
  const focusAudit = (auditId) => {
    elements.filter_query.value = auditId;
    state.auditOffset = 0;
    void loadAudits().then(() => document.querySelector('#audits-title')?.scrollIntoView({ behavior: 'smooth' }));
  };
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
    const executionContext = document.createElement('p');
    executionContext.className = 'muted';
    const target = finding.sourceProject || finding.environment;
    const gate = finding.baselineNonGating
      ? 'non-gating production baseline'
      : finding.scope === 'cross-environment'
        ? 'cross-environment release gate'
        : finding.releaseBlocking
          ? 'release-blocking execution'
          : 'advisory execution';
    executionContext.textContent = target
      ? `Observed on ${humanize(target)} · ${gate}`
      : `Observed in a ${gate}`;
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'text-button';
    link.textContent = `${finding.auditId} · ${finding.auditTitle}`;
    link.addEventListener('click', () => focusAudit(finding.auditId));
    card.append(meta, title, detail, executionContext, link);
    elements.top_findings.append(card);
  }
  if (attention.length > 0) {
    const explanation = document.createElement('p');
    explanation.className = 'muted';
    explanation.textContent = 'These additional audits need action even though their test code did not attach a structured finding. Assertion failures, evidence-integrity review states, missing executions, and outstanding manual acceptance are shown separately from production-only baseline context.';
    elements.top_findings.append(explanation);
  }
  for (const item of attention.slice(0, 20)) {
    const card = document.createElement('article');
    card.className = 'finding-card';
    card.dataset.blocking = item.releaseBlocking ? 'true' : 'false';
    const meta = document.createElement('div');
    meta.className = 'finding-meta';
    const scope = item.scope === 'cross-environment'
      ? 'Cross-environment gate'
      : item.scope === 'candidate'
        ? 'Candidate gate'
        : 'Unclassified gate';
    meta.append(
      badge(item.severity, `severity-${String(item.severity).toLowerCase()}`),
      badge(item.auditStatus, `status-${statusTone(item.auditStatus)}`),
      badge(scope, 'status-review'),
    );
    const title = document.createElement('h3');
    title.textContent = item.auditTitle;
    const detail = document.createElement('p');
    detail.textContent = item.detail;
    card.append(meta, title, detail);
    if (item.errorContext) {
      const assertion = document.createElement('p');
      const label = document.createElement('strong');
      label.textContent = 'Assertion: ';
      assertion.append(label, item.errorContext);
      card.append(assertion);
    }
    if (item.reasonCodes?.length) {
      const integrity = document.createElement('p');
      integrity.className = 'muted';
      integrity.textContent = `Evidence context: ${item.reasonCodes.map(humanize).join(', ')}`;
      card.append(integrity);
    }
    if (item.baselineNonGating) {
      const baseline = document.createElement('p');
      baseline.className = 'muted';
      baseline.textContent = `Production baseline (comparison only; not part of this candidate gate): ${item.baselineNote}`;
      card.append(baseline);
    }
    if (item.evidence?.length) {
      const links = document.createElement('div');
      links.className = 'evidence-link-list';
      for (const artifact of item.evidence) {
        const evidenceContext = artifact.context === 'final-primary'
          ? `Final attempt ${artifact.attempt} · primary`
          : `Final attempt ${artifact.attempt} · diagnostic`;
        links.append(evidenceLink(
          checklistArtifactUrl(artifact.href),
          `${evidenceContext} · ${humanize(artifact.kind)} · ${artifact.name}`,
          formatBytes(artifact.sizeBytes),
        ));
      }
      card.append(links);
    }
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'text-button';
    link.textContent = `${item.auditId} · Open full audit context`;
    link.addEventListener('click', () => focusAudit(item.auditId));
    card.append(link);
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
    ['area', elements.filter_area],
    ...(state.mode === 'single-site' ? [] : [['environment', elements.filter_environment], ['releaseBlocking', elements.filter_blocking]]),
  ]) {
    if (input.value) query.set(name, input.value);
  }
  if (elements.filter_manual.checked) query.set('manual', 'true');
  if (state.report.publicationRevision) query.set('revision', state.report.publicationRevision);
  try {
    const page = await fetchJson(`${apiPath('/report/audits')}?${query}`, { signal: controller.signal });
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
  if (state.mode === 'single-site' && page.filters) {
    fillSelect(elements.filter_status, page.filters.statuses ?? [], humanize);
    fillSelect(elements.filter_severity, page.filters.severities ?? [], (value) => value);
    fillSelect(elements.filter_area, page.filters.areas ?? [], humanize);
  }
  announce(`${items.length} audit results loaded, ${page.total} total matches.`);
}

function auditCard(audit) {
  if (state.mode === 'single-site') return singleSiteAuditCard(audit);
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

function singleSiteAuditCard(audit) {
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
  badges.append(
    badge(audit.status, `status-${statusTone(audit.status)}`),
    badge(audit.severity, `severity-${String(audit.severity).toLowerCase()}`),
    badge(humanize(audit.area), 'manual'),
  );
  if (audit.manual) badges.append(badge('Manual', 'manual'));
  if (audit.visualStatus && audit.visualStatus !== 'not-applicable') badges.append(badge(`Visual ${humanize(audit.visualStatus)}`, 'evidence-screenshot'));
  const title = document.createElement('strong');
  title.textContent = `${audit.id} · ${audit.title}`;
  const promise = document.createElement('small');
  promise.textContent = audit.userPromise;
  heading.append(badges, title, promise);
  const outcome = document.createElement('span');
  outcome.className = 'audit-outcome-copy';
  const evidence = document.createElement('span');
  evidence.textContent = `${audit.findingCount} finding${audit.findingCount === 1 ? '' : 's'} · ${audit.artifactCount} artifact${audit.artifactCount === 1 ? '' : 's'} · evidence ${humanize(audit.evidenceStatus)}`;
  const reason = document.createElement('small');
  reason.textContent = audit.detail;
  outcome.append(evidence, reason);
  const detail = document.createElement('div');
  detail.className = 'audit-detail';
  detail.hidden = true;
  button.addEventListener('click', () => {
    const opening = detail.hidden;
    detail.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
    if (opening && detail.childElementCount === 0) {
      const intro = document.createElement('div');
      intro.className = 'audit-detail-intro';
      intro.append(
        detailBlock('Reviewed Product Oracle', audit.userPromise),
        detailBlock('Observed outcome', audit.detail),
        detailBlock('Evidence state', `${humanize(audit.evidenceStatus)} · visual ${humanize(audit.visualStatus)} · ${audit.artifactCount} linked artifact${audit.artifactCount === 1 ? '' : 's'}`),
      );
      detail.append(intro);
    }
  });
  button.append(heading, outcome);
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
    const revision = state.report?.publicationRevision
      ? `?revision=${encodeURIComponent(state.report.publicationRevision)}`
      : '';
    const value = await fetchJson(`/api/runs/${encodeURIComponent(state.runId)}/report/audits/${encodeURIComponent(auditId)}${revision}`, { signal: controller.signal });
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
    const page = await fetchJson(`${apiPath('/artifacts')}?offset=0&limit=80`, { signal: state.reportController?.signal });
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
    const snapshot = await fetchJson(`${apiPath('/logs')}?maxBytes=${LOG_PREVIEW_BYTES}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    const log = String(snapshot.log ?? '').slice(-LOG_PREVIEW_BYTES);
    elements.report_log.textContent = log || 'No log output has been recorded.';
    elements.report_log.hidden = false;
    elements.log_state.textContent = snapshot.truncated
      ? `Showing the newest ${formatBytes(snapshot.bytes)} through the bounded, redacting log API.`
      : `Showing ${formatBytes(snapshot.bytes)} of persisted output through the bounded, redacting log API.`;
    elements.log_links.replaceChildren();
    for (const source of snapshot.sources ?? []) {
      const item = document.createElement('p');
      item.className = 'muted';
      item.textContent = `Redacted source · ${source.path} · ${formatBytes(source.size)} stored`;
      elements.log_links.append(item);
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

async function fetchJson(url, { signal, timeoutMs = 30_000, ...requestOptions } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetch(url, {
      ...requestOptions,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
        ...(requestOptions.headers ?? {}),
      },
    });
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

function reportedNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function reportedCount(value) {
  return reportedNumber(value) ?? 'Unavailable';
}

function reportedRatio(part, total) {
  const numerator = reportedNumber(part);
  const denominator = reportedNumber(total);
  return numerator === null || denominator === null ? 'Unavailable' : `${numerator} / ${denominator}`;
}

function reportedSum(left, right) {
  const a = reportedNumber(left);
  const b = reportedNumber(right);
  return a === null || b === null ? 'Unavailable' : a + b;
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
